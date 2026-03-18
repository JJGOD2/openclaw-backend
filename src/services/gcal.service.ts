// src/services/gcal.service.ts  (v2 — OAuth auto-refresh)
import { getValidAccessToken, OAuthNotConfiguredError } from "@/services/oauth/token.service";
import { GOOGLE_SCOPES } from "@/services/oauth/google.oauth";

const SCOPE = GOOGLE_SCOPES.calendar;

async function loadToken(workspaceId: string): Promise<string> {
  try { return await getValidAccessToken(workspaceId, "GOOGLE", SCOPE); }
  catch(e) {
    if (e instanceof OAuthNotConfiguredError)
      throw new Error("Google Calendar OAuth 尚未授權，請前往 Integrations 完成授權流程");
    throw e;
  }
}

async function calFetch(token: string, path: string, method="GET", body?: object) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method, headers: {Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    ...(body ? {body:JSON.stringify(body)} : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Calendar ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

export interface CalEvent {
  id:string; summary:string; start:string; end:string;
  location?:string; description?:string; attendees?:string[]; meetLink?:string;
}

interface GCE {
  id:string; summary:string;
  start?:{dateTime?:string;date?:string}; end?:{dateTime?:string;date?:string};
  location?:string; description?:string;
  attendees?:{email:string}[];
  conferenceData?:{entryPoints?:{uri:string;entryPointType:string}[]};
}

function norm(e:GCE): CalEvent {
  return { id:e.id, summary:e.summary??"(No title)",
    start:e.start?.dateTime??e.start?.date??"", end:e.end?.dateTime??e.end?.date??"",
    location:e.location, description:e.description,
    attendees:e.attendees?.map(a=>a.email),
    meetLink:e.conferenceData?.entryPoints?.find(ep=>ep.entryPointType==="video")?.uri };
}

export async function calListEvents(workspaceId:string, calendarId="primary", maxResults=10): Promise<CalEvent[]> {
  const token = await loadToken(workspaceId);
  const data  = await calFetch(token,`/calendars/${encodeURIComponent(calendarId)}/events?maxResults=${maxResults}&orderBy=startTime&singleEvents=true&timeMin=${new Date().toISOString()}`) as {items:GCE[]};
  return (data.items??[]).map(norm);
}

export async function calCreateEvent(workspaceId:string, opts:{summary:string;description?:string;location?:string;startTime:string;endTime:string;attendees?:string[];calendarId?:string}): Promise<CalEvent> {
  const token = await loadToken(workspaceId);
  const e = await calFetch(token,`/calendars/${encodeURIComponent(opts.calendarId??"primary")}/events`,"POST",{
    summary:opts.summary, description:opts.description, location:opts.location,
    start:{dateTime:opts.startTime,timeZone:"Asia/Taipei"},
    end:{dateTime:opts.endTime,timeZone:"Asia/Taipei"},
    attendees:opts.attendees?.map(email=>({email})),
  }) as GCE;
  return norm(e);
}

export async function calQuickBook(workspaceId:string, title:string, startIso:string, attendees:string[]=[]) {
  const end = new Date(new Date(startIso).getTime() + 3600_000);
  return calCreateEvent(workspaceId, {summary:title,startTime:startIso,endTime:end.toISOString(),attendees});
}
