// src/services/notion.service.ts
// Notion API 整合：讀取 / 新增 / 搜尋 Database
import { prisma } from "@/db/client";
import { decryptSecret } from "@/lib/crypto";

// ── Load Notion token for workspace ──────────────────────────
async function loadToken(workspaceId: string): Promise<string> {
  const row = await prisma.secret.findUnique({
    where: { workspaceId_name: { workspaceId, name: "NOTION_API_TOKEN" } },
  });
  if (!row) throw new Error("NOTION_API_TOKEN not configured for workspace");
  return row.encryptedValue.startsWith("PLACEHOLDER")
    ? (process.env.NOTION_API_TOKEN ?? "")
    : decryptSecret(row.encryptedValue);
}

async function notionFetch(
  token:   string,
  path:    string,
  method = "GET",
  body?:   object
): Promise<unknown> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      "Authorization":     `Bearer ${token}`,
      "Content-Type":      "application/json",
      "Notion-Version":    "2022-06-28",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion API error: ${JSON.stringify(data)}`);
  return data;
}

// ── Search databases / pages ──────────────────────────────────
export async function notionSearch(
  workspaceId: string,
  query:       string,
  filter?:     "page" | "database"
): Promise<{ id: string; title: string; type: string; url: string }[]> {
  const token = await loadToken(workspaceId);
  const data  = await notionFetch(token, "/search", "POST", {
    query,
    ...(filter ? { filter: { property: "object", value: filter } } : {}),
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 10,
  }) as { results: NotionResult[] };

  return data.results.map(extractTitle);
}

interface NotionResult {
  id:         string;
  object:     string;
  url:        string;
  properties?: Record<string, { title?: { plain_text: string }[] }>;
  title?:      { plain_text: string }[];
}

function extractTitle(r: NotionResult): { id: string; title: string; type: string; url: string } {
  let title = "(Untitled)";
  if (r.object === "page" && r.properties) {
    const titleProp = Object.values(r.properties).find((p) => p.title);
    title = titleProp?.title?.[0]?.plain_text ?? "(Untitled)";
  } else if (r.object === "database" && r.title) {
    title = r.title[0]?.plain_text ?? "(Untitled)";
  }
  return { id: r.id, title, type: r.object, url: r.url };
}

// ── Read database rows ────────────────────────────────────────
export async function notionQueryDatabase(
  workspaceId:  string,
  databaseId:   string,
  filter?:      object,
  pageSize = 20
): Promise<{ id: string; properties: Record<string, unknown> }[]> {
  const token = await loadToken(workspaceId);
  const data  = await notionFetch(token, `/databases/${databaseId}/query`, "POST", {
    ...(filter ? { filter } : {}),
    page_size: pageSize,
  }) as { results: { id: string; properties: Record<string, unknown> }[] };

  return data.results;
}

// ── Create page in database ───────────────────────────────────
export async function notionCreatePage(
  workspaceId: string,
  databaseId:  string,
  properties:  Record<string, unknown>,
  children?:   unknown[]
): Promise<{ id: string; url: string }> {
  const token = await loadToken(workspaceId);
  const data  = await notionFetch(token, "/pages", "POST", {
    parent: { database_id: databaseId },
    properties,
    ...(children ? { children } : {}),
  }) as { id: string; url: string };

  return { id: data.id, url: data.url };
}

// ── Append blocks to a page ───────────────────────────────────
export async function notionAppendBlocks(
  workspaceId: string,
  pageId:      string,
  blocks:      unknown[]
): Promise<void> {
  const token = await loadToken(workspaceId);
  await notionFetch(token, `/blocks/${pageId}/children`, "PATCH", { children: blocks });
}

// ── Helper: build a simple paragraph block ───────────────────
export function notionParagraph(text: string) {
  return {
    object: "block",
    type:   "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  };
}

// ── Log conversation turn to Notion database ─────────────────
export async function logConversationToNotion(
  workspaceId:  string,
  databaseId:   string,
  entry: {
    platform:   string;
    userId:     string;
    agentName:  string;
    userMsg:    string;
    agentReply: string;
    status:     string;
  }
): Promise<{ id: string; url: string }> {
  return notionCreatePage(workspaceId, databaseId, {
    Name:       { title:   [{ text: { content: entry.userMsg.slice(0, 100) } }] },
    Platform:   { select:  { name: entry.platform } },
    Agent:      { rich_text:[{ text: { content: entry.agentName } }] },
    User:       { rich_text:[{ text: { content: entry.userId } }] },
    Status:     { select:  { name: entry.status } },
    UserMsg:    { rich_text:[{ text: { content: entry.userMsg } }] },
    AgentReply: { rich_text:[{ text: { content: entry.agentReply } }] },
    CreatedAt:  { date: { start: new Date().toISOString() } },
  });
}
