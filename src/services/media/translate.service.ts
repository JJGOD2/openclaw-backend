// src/services/media/translate.service.ts
// 多語言翻譯（Claude）+ 語音轉文字（OpenAI Whisper / Groq）
import { prisma } from "@/db/client";

// ── Supported languages ───────────────────────────────────────
export const SUPPORTED_LANGS: Record<string, string> = {
  "zh-TW": "繁體中文",
  "zh-CN": "簡體中文",
  "en":    "English",
  "ja":    "日本語",
  "ko":    "한국어",
  "th":    "ภาษาไทย",
  "vi":    "Tiếng Việt",
  "id":    "Bahasa Indonesia",
  "ms":    "Bahasa Melayu",
  "es":    "Español",
  "fr":    "Français",
  "de":    "Deutsch",
};

// ─────────────────────────────────────────────────────────────
// Detect language using Claude
// ─────────────────────────────────────────────────────────────
export async function detectLanguage(text: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey || text.length < 3) return "zh-TW";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{
        role:    "user",
        content: `Detect the language of this text and reply with ONLY the BCP-47 code (e.g. zh-TW, en, ja, ko). Text: "${text.slice(0, 200)}"`,
      }],
    }),
  });

  const data = await res.json();
  const code = data.content?.[0]?.text?.trim() ?? "zh-TW";
  return SUPPORTED_LANGS[code] ? code : "zh-TW";
}

// ─────────────────────────────────────────────────────────────
// Translate text using Claude
// ─────────────────────────────────────────────────────────────
export async function translateText(
  text:       string,
  targetLang: string,
  sourceLang?: string
): Promise<string> {
  if (!text.trim()) return text;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) return text;

  const targetName = SUPPORTED_LANGS[targetLang] ?? targetLang;
  const sourceHint = sourceLang ? ` (source: ${SUPPORTED_LANGS[sourceLang] ?? sourceLang})` : "";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{
        role:    "user",
        content: `Translate the following text to ${targetName}${sourceHint}. Output ONLY the translated text, no explanation:\n\n${text}`,
      }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json();
  return data.content?.[0]?.text?.trim() ?? text;
}

// ─────────────────────────────────────────────────────────────
// Speech-to-Text using OpenAI Whisper (or Groq as fallback)
// ─────────────────────────────────────────────────────────────
export async function transcribeAudio(
  audioUrl:    string,
  workspaceId: string,
  sessionId?:  string
): Promise<{ jobId: string; transcript?: string; language?: string }> {
  // Create media job record
  const job = await prisma.mediaJob.create({
    data: {
      workspaceId,
      sessionId,
      type:      "AUDIO",
      status:    "PROCESSING",
      sourceUrl: audioUrl,
    },
  });

  // Process async
  processAudioJob(job.id, audioUrl).catch(err =>
    console.error("[Whisper] Error:", err.message)
  );

  return { jobId: job.id };
}

async function processAudioJob(jobId: string, audioUrl: string): Promise<void> {
  try {
    // Download audio
    const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(30_000) });
    if (!audioRes.ok) throw new Error(`Failed to fetch audio: ${audioRes.status}`);

    const audioBuffer = await audioRes.arrayBuffer();
    const audioBlob   = new Blob([audioBuffer]);

    // Try OpenAI Whisper
    const openaiKey = process.env.OPENAI_API_KEY ?? "";
    const groqKey   = process.env.GROQ_API_KEY   ?? "";

    let transcript = "";
    let language   = "";

    if (openaiKey) {
      const form = new FormData();
      form.append("file",  audioBlob, "audio.ogg");
      form.append("model", "whisper-1");
      form.append("response_format", "json");

      const res  = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method:  "POST",
        headers: { Authorization: `Bearer ${openaiKey}` },
        body:    form,
        signal:  AbortSignal.timeout(60_000),
      });
      const data = await res.json();
      transcript = data.text     ?? "";
      language   = data.language ?? "";
    } else if (groqKey) {
      // Groq is faster and cheaper for Whisper
      const form = new FormData();
      form.append("file",  audioBlob, "audio.ogg");
      form.append("model", "whisper-large-v3-turbo");
      form.append("response_format", "json");

      const res  = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method:  "POST",
        headers: { Authorization: `Bearer ${groqKey}` },
        body:    form,
        signal:  AbortSignal.timeout(30_000),
      });
      const data = await res.json();
      transcript = data.text     ?? "";
      language   = data.language ?? "";
    } else {
      throw new Error("No Whisper API key configured (OPENAI_API_KEY or GROQ_API_KEY)");
    }

    await prisma.mediaJob.update({
      where: { id: jobId },
      data:  { status: "DONE", transcript, language },
    });

  } catch (err) {
    await prisma.mediaJob.update({
      where: { id: jobId },
      data:  { status: "FAILED", errorMsg: (err as Error).message },
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Auto-translate incoming message if not in target language
// ─────────────────────────────────────────────────────────────
export async function autoTranslateIfNeeded(
  text:       string,
  targetLang: string   // workspace default language
): Promise<{ original: string; translated: string; sourceLang: string; didTranslate: boolean }> {
  const sourceLang = await detectLanguage(text);

  if (sourceLang === targetLang || sourceLang.split("-")[0] === targetLang.split("-")[0]) {
    return { original: text, translated: text, sourceLang, didTranslate: false };
  }

  const translated = await translateText(text, targetLang, sourceLang);
  return { original: text, translated, sourceLang, didTranslate: true };
}
