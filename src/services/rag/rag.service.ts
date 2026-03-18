// src/services/rag/rag.service.ts
// Retrieval-Augmented Generation 服務
// 使用 Claude 產生 embedding（text-embedding-3-small 替代方案）
// 目前用 cosine similarity on JSON arrays（不依賴 pgvector）
import { prisma } from "@/db/client";
import { KBDocStatus } from "@prisma/client";

// ── Chunking 設定 ─────────────────────────────────────────────
const CHUNK_SIZE    = 400;   // tokens 估算
const CHUNK_OVERLAP = 80;

// ── 取得 OpenAI compatible embedding ─────────────────────────
// 使用 Voyage AI（Anthropic 推薦）或 OpenAI text-embedding-3-small
async function embed(texts: string[], workspaceId: string): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY ?? process.env.OPENAI_API_KEY ?? "";

  if (!apiKey) {
    // Fallback: simple TF-IDF-like mock (no real embedding)
    // In production, configure VOYAGE_API_KEY
    return texts.map(t => mockEmbed(t));
  }

  if (process.env.VOYAGE_API_KEY) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body:    JSON.stringify({ model: "voyage-3-lite", input: texts }),
    });
    const data = await res.json() as { data: { embedding: number[] }[] };
    return data.data.map(d => d.embedding);
  }

  // OpenAI fallback
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body:    JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  const data = await res.json() as { data: { embedding: number[] }[] };
  return data.data.map(d => d.embedding);
}

// ── Mock embedding (no API key) ───────────────────────────────
function mockEmbed(text: string): number[] {
  // Simple character frequency as a 128-dim vector
  const vec = new Array(128).fill(0);
  for (const ch of text.toLowerCase()) {
    const idx = ch.charCodeAt(0) % 128;
    vec[idx] += 1;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / mag);
}

// ── Cosine similarity ─────────────────────────────────────────
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

// ── Chunk text into overlapping segments ─────────────────────
export function chunkText(text: string): string[] {
  const words  = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];

  // Also split by paragraph boundaries first
  const paragraphs = text.split(/\n{2,}/);
  let current = "";
  let wordCount = 0;

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).filter(Boolean);
    if (wordCount + paraWords.length > CHUNK_SIZE && current) {
      chunks.push(current.trim());
      // Overlap: take last CHUNK_OVERLAP words
      const overlapWords = current.split(/\s+/).slice(-CHUNK_OVERLAP);
      current    = overlapWords.join(" ") + "\n\n" + para;
      wordCount  = overlapWords.length + paraWords.length;
    } else {
      current   += (current ? "\n\n" : "") + para;
      wordCount += paraWords.length;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Handle very long single paragraphs
  const result: string[] = [];
  for (const chunk of chunks) {
    const cWords = chunk.split(/\s+/);
    if (cWords.length <= CHUNK_SIZE * 1.2) {
      result.push(chunk);
    } else {
      for (let i = 0; i < cWords.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        result.push(cWords.slice(i, i + CHUNK_SIZE).join(" "));
      }
    }
  }
  return result.filter(c => c.length > 50);
}

// ─────────────────────────────────────────────────────────────
// Process a document: chunk → embed → store
// ─────────────────────────────────────────────────────────────
export async function processDocument(docId: string): Promise<void> {
  const doc = await prisma.kBDocument.findUnique({
    where: { id: docId }, include: { kb: true },
  });
  if (!doc) throw new Error(`Document ${docId} not found`);

  await prisma.kBDocument.update({
    where: { id: docId }, data: { status: "PROCESSING" },
  });

  try {
    const chunks    = chunkText(doc.rawContent);
    const embeddings= await embed(chunks, doc.kb.workspaceId);

    // Delete existing chunks
    await prisma.kBChunk.deleteMany({ where: { docId } });

    // Create new chunks with embeddings
    await prisma.kBChunk.createMany({
      data: chunks.map((content, i) => ({
        docId,
        chunkIndex:    i,
        content,
        embeddingJson: embeddings[i],
        tokenCount:    Math.ceil(content.length / 4),
      })),
    });

    // Update document status and KB counts
    await prisma.kBDocument.update({
      where: { id: docId },
      data:  { status: "READY", processedAt: new Date(),
               wordCount: doc.rawContent.split(/\s+/).length },
    });

    await prisma.knowledgeBase.update({
      where: { id: doc.kbId },
      data:  { chunkCount: { increment: chunks.length } },
    });

  } catch (err) {
    await prisma.kBDocument.update({
      where: { id: docId },
      data:  { status: "FAILED", errorMessage: (err as Error).message },
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Semantic search: find top-K relevant chunks
// ─────────────────────────────────────────────────────────────
export async function searchKnowledge(
  kbIds:   string[],
  query:   string,
  topK =   5
): Promise<{ content: string; score: number; docTitle: string }[]> {
  if (!kbIds.length) return [];

  // Get query embedding (single text)
  const [queryEmb] = await embed([query], "");

  // Load all chunks for these KBs
  const chunks = await prisma.kBChunk.findMany({
    where: { document: { kbId: { in: kbIds }, status: "READY" } },
    include: { document: { select: { title: true } } },
    take:  2000,   // limit for performance
  });

  if (!chunks.length) return [];

  // Score chunks
  const scored = chunks
    .filter(c => c.embeddingJson !== null)
    .map(c => ({
      content:  c.content,
      docTitle: c.document.title,
      score:    cosineSim(queryEmb, c.embeddingJson as number[]),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(c => c.score > 0.3);   // minimum relevance threshold

  return scored;
}

// ─────────────────────────────────────────────────────────────
// Build RAG context string for injection into system prompt
// ─────────────────────────────────────────────────────────────
export async function buildRagContext(
  kbIds:   string[],
  query:   string
): Promise<string> {
  const results = await searchKnowledge(kbIds, query, 4);
  if (!results.length) return "";

  const sections = results.map((r, i) =>
    `[${i+1}] ${r.docTitle}\n${r.content}`
  ).join("\n\n---\n\n");

  return `\n\n===相關知識庫資料===\n${sections}\n===資料結束===\n\n請優先參考以上知識庫資料回答，若資料中無相關資訊再依一般知識作答。`;
}
