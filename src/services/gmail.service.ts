// src/services/gmail.service.ts  (v2 — OAuth auto-refresh)
import { getValidAccessToken, OAuthNotConfiguredError } from "@/services/oauth/token.service";
import { GOOGLE_SCOPES } from "@/services/oauth/google.oauth";

const SCOPE = GOOGLE_SCOPES.gmail;

async function loadToken(workspaceId: string): Promise<string> {
  try { return await getValidAccessToken(workspaceId, "GOOGLE", SCOPE); }
  catch(e) {
    if (e instanceof OAuthNotConfiguredError)
      throw new Error("Gmail OAuth 尚未授權，請前往 Integrations → Gmail 完成授權流程");
    throw e;
  }
}

async function gmailFetch(token: string, path: string, method = "GET", body?: object) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    method, headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(`Gmail ${res.status}: ${JSON.stringify(e)}`); }
  if (res.status === 204) return null;
  return res.json();
}

function encodeEmail(o: { to:string; subject:string; body:string; from?:string }) {
  return Buffer.from([`To: ${o.to}`,`Subject: ${o.subject}`,o.from?`From: ${o.from}`:"","Content-Type: text/plain; charset=utf-8","MIME-Version: 1.0","",o.body].filter(Boolean).join("\r\n")).toString("base64url");
}

export async function gmailListInbox(workspaceId: string, maxResults=10, query="in:inbox") {
  const token = await loadToken(workspaceId);
  const list  = await gmailFetch(token,`/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`) as {messages?:{id:string;threadId:string}[]};
  if (!list?.messages?.length) return [];
  return Promise.all(list.messages.map(async m => {
    const d = await gmailFetch(token,`/users/me/messages/${m.id}?format=metadata&metadataHeaders=From,Subject,Date`) as {id:string;threadId:string;snippet:string;payload?:{headers?:{name:string;value:string}[]}};
    const g = (n:string) => d.payload?.headers?.find(h=>h.name===n)?.value;
    return {id:d.id,threadId:d.threadId,snippet:d.snippet,from:g("From"),subject:g("Subject"),date:g("Date")};
  }));
}

export async function gmailCreateDraft(workspaceId: string, opts:{to:string;subject:string;body:string;from?:string}) {
  const token = await loadToken(workspaceId);
  const d = await gmailFetch(token,"/users/me/drafts","POST",{message:{raw:encodeEmail(opts)}}) as {id:string;message:{threadId:string}};
  return {draftId:d.id, threadId:d.message.threadId};
}

export async function gmailSend(workspaceId: string, opts:{to:string;subject:string;body:string;from?:string}) {
  const token = await loadToken(workspaceId);
  const s = await gmailFetch(token,"/users/me/messages/send","POST",{raw:encodeEmail(opts)}) as {id:string;threadId:string};
  return {messageId:s.id, threadId:s.threadId};
}

export async function gmailSendDraft(workspaceId: string, draftId: string) {
  const token = await loadToken(workspaceId);
  const s = await gmailFetch(token,"/users/me/drafts/send","POST",{id:draftId}) as {id:string};
  return {messageId:s.id};
}

export async function gmailUnreadCount(workspaceId: string) {
  const token = await loadToken(workspaceId);
  const r = await gmailFetch(token,"/users/me/messages?maxResults=1&q=is:unread in:inbox") as {resultSizeEstimate?:number};
  return r?.resultSizeEstimate ?? 0;
}
