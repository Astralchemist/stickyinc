import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = join(homedir(), ".stickyinc");
const CREDS_PATH = join(DATA_DIR, "google.json");

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export interface GoogleConfig {
  client_id: string;
  client_secret: string;
  refresh_token?: string;
  access_token?: string;
  expires_at?: string;
  calendar_id?: string;
}

mkdirSync(DATA_DIR, { recursive: true });

export function hasGoogleCreds(): boolean {
  if (!existsSync(CREDS_PATH)) return false;
  try {
    const cfg = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
    return !!(cfg.client_id && cfg.client_secret);
  } catch {
    return false;
  }
}

export function isGoogleAuthorized(): boolean {
  if (!existsSync(CREDS_PATH)) return false;
  try {
    const cfg = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
    return !!(cfg.client_id && cfg.client_secret && cfg.refresh_token);
  } catch {
    return false;
  }
}

export function loadGoogleConfig(): GoogleConfig {
  if (!existsSync(CREDS_PATH)) {
    throw new Error(
      `Google credentials not found at ${CREDS_PATH}. See README "Google Calendar setup".`
    );
  }
  return JSON.parse(readFileSync(CREDS_PATH, "utf8"));
}

export function saveGoogleConfig(cfg: GoogleConfig): void {
  writeFileSync(CREDS_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function buildAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CALENDAR_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `${OAUTH_AUTH}?${params.toString()}`;
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<{ refresh_token: string; access_token: string; expires_in: number }> {
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as never;
}

async function refreshAccessToken(cfg: GoogleConfig): Promise<string> {
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  const next: GoogleConfig = {
    ...cfg,
    access_token: data.access_token,
    expires_at: new Date(Date.now() + (data.expires_in - 60) * 1000).toISOString(),
  };
  saveGoogleConfig(next);
  return data.access_token;
}

async function getAccessToken(): Promise<string> {
  const cfg = loadGoogleConfig();
  if (!cfg.refresh_token) {
    throw new Error(
      "Google Calendar not authorized. Run: `pnpm stickyinc-auth` (or `node dist/auth-cli.js`)."
    );
  }
  if (cfg.access_token && cfg.expires_at && new Date(cfg.expires_at) > new Date()) {
    return cfg.access_token;
  }
  return await refreshAccessToken(cfg);
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  start: string;
  end?: string;
}

export interface CalendarEvent {
  id: string;
  htmlLink: string;
  summary: string;
}

export async function createCalendarEvent(
  input: CalendarEventInput
): Promise<CalendarEvent> {
  const token = await getAccessToken();
  const cfg = loadGoogleConfig();
  const calendarId = cfg.calendar_id ?? "primary";

  const start = new Date(input.start);
  const end = input.end ? new Date(input.end) : new Date(start.getTime() + 30 * 60 * 1000);

  const body = {
    summary: input.summary,
    description: input.description,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };

  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Calendar API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as CalendarEvent;
  return data;
}

export { CREDS_PATH };
