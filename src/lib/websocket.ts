// src/lib/websocket.ts
// WebSocket 即時 Log 推送
// 客戶端連線後可訂閱 workspaceId filter
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";

interface Client {
  ws:          WebSocket;
  userId:      string;
  workspaces:  Set<string>;   // 訂閱的 workspace ids，空 = 全部
}

const clients = new Map<string, Client>();  // connectionId → Client

export interface LogEvent {
  type:        "log";
  id:          string;
  workspaceId: string;
  logType:     string;
  message:     string;
  createdAt:   string;
}

// ── Push log to all subscribed clients ───────────────────────
export function broadcastLog(event: LogEvent) {
  for (const client of clients.values()) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    const subscribed =
      client.workspaces.size === 0 ||
      client.workspaces.has(event.workspaceId);
    if (!subscribed) continue;
    try {
      client.ws.send(JSON.stringify(event));
    } catch { /* ignore */ }
  }
}

// ── Attach WebSocket server to HTTP server ───────────────────
export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws/logs" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Auth: token in query string ?token=...
    const url      = new URL(req.url ?? "", "http://localhost");
    const token    = url.searchParams.get("token") ?? "";
    const connId   = Math.random().toString(36).slice(2);

    let userId = "";
    try {
      const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
      userId = payload.sub;
    } catch {
      ws.close(4001, "Unauthorized");
      return;
    }

    clients.set(connId, { ws, userId, workspaces: new Set() });
    console.log(`[WS] Client connected: ${connId} (user: ${userId})`);

    // Heartbeat
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const client = clients.get(connId);
        if (!client) return;

        // Subscribe to workspaces: { type: "subscribe", workspaceIds: ["ws-a","ws-b"] }
        if (msg.type === "subscribe" && Array.isArray(msg.workspaceIds)) {
          client.workspaces = new Set(msg.workspaceIds);
          ws.send(JSON.stringify({ type: "subscribed", workspaceIds: msg.workspaceIds }));
        }

        // Subscribe all: { type: "subscribe_all" }
        if (msg.type === "subscribe_all") {
          client.workspaces = new Set();
          ws.send(JSON.stringify({ type: "subscribed", workspaceIds: "all" }));
        }
      } catch { /* ignore bad JSON */ }
    });

    ws.on("close", () => {
      clearInterval(ping);
      clients.delete(connId);
      console.log(`[WS] Client disconnected: ${connId}`);
    });

    ws.on("error", (err) => {
      console.error(`[WS] Error ${connId}:`, err.message);
    });

    ws.send(JSON.stringify({ type: "connected", connId }));
  });

  console.log("[WS] WebSocket server attached at /ws/logs");
  return wss;
}
