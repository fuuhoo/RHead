// ES client: talks to the Rust `es_request` command (no CORS, no node proxy).
// Falls back to plain fetch so the web UI can run in a browser (vite dev).

import { invoke } from "@tauri-apps/api/core";

export interface Connection {
  baseUrl: string;
  username: string;
  password: string;
}

export type EsErrorKind =
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "es_error"
  | "invalid_config";

export class EsError extends Error {
  kind: EsErrorKind;
  status?: number;
  constructor(kind: EsErrorKind, message: string, status?: number) {
    super(message);
    this.name = "EsError";
    this.kind = kind;
    this.status = status;
  }
}

export interface EsResult {
  status: number;
  json: any;
  raw: string;
}

/** Pull the "N 秒" part out of a timeout message, e.g. "请求超时（30 秒内无响应）". */
function timeoutHint(msg: string): string {
  const m = /(\d+)\s*秒/.exec(msg);
  return m ? `${m[1]} 秒` : "15 秒";
}

/** Friendly, actionable error text for the UI. */
export function friendlyError(err: unknown, conn?: Connection): string {
  const target = conn?.baseUrl ? `（${conn.baseUrl}）` : "";
  if (err instanceof EsError) {
    switch (err.kind) {
      case "unreachable":
        return `无法连接到 Elasticsearch${target}。请确认 ES 已启动、地址/端口正确，且防火墙未拦截。详情：${err.message}`;
      case "timeout":
        return `请求超时（${timeoutHint(err.message)}内无响应）${conn?.baseUrl ? " · " + conn.baseUrl : ""}。ES 可能繁忙或网络不通，可在查询页调大「超时」设置。`;
      case "unauthorized":
        return `认证失败${target}（401）。请检查用户名/密码，或确认该账号有权限。`;
      case "invalid_config":
        return err.message;
      default:
        return err.message;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /unreachable|connect|refused|empty reply|reset by peer/i.test(msg)
    ? `无法连接到 Elasticsearch${target}。请确认 ES 已启动、地址/端口正确。详情：${msg}`
    : msg;
}

const LS_KEY = "rhead-connection";
export const DEFAULT_CONNECTION: Connection = {
  baseUrl: "http://localhost:9200",
  username: "",
  password: "",
};

export function loadConnection(): Connection {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULT_CONNECTION, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_CONNECTION };
}

export function saveConnection(c: Connection) {
  localStorage.setItem(LS_KEY, JSON.stringify(c));
}

// ---- connection manager (multiple named connections) ----

export interface SavedConnection extends Connection {
  id: string;
  name: string;
  savedAt: number;
}

const CONN_LIST_KEY = "rhead-connections";

export function loadConnections(): SavedConnection[] {
  try {
    const raw = localStorage.getItem(CONN_LIST_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    }
  } catch {}
  return [];
}

export function saveConnections(list: SavedConnection[]) {
  localStorage.setItem(CONN_LIST_KEY, JSON.stringify(list));
}

/** Extract "host:port" from a base URL for auto-naming; falls back to the raw string. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function rawRequest(
  conn: Connection,
  method: string,
  path: string,
  body?: string,
  timeoutSec?: number
): Promise<EsResult> {
  const base = (conn.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new EsError("invalid_config", "地址需以 http:// 或 https:// 开头，例如 http://localhost:9200");
  }
  const cleanPath = path.replace(/^\/+/, "");
  if (isTauri()) {
    let res: { status: number; body: string; error?: string };
    try {
      res = await invoke("es_request", {
        baseUrl: base,
        method,
        path: cleanPath,
        body: body ?? null,
        username: conn.username || null,
        password: conn.password || null,
        timeoutSecs: timeoutSec ?? null,
      });
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message ?? String(e);
      // Rust side prefixes transport failures; keep them as EsError so the
      // UI can show a friendly, actionable message instead of a stack.
      // The Rust message is Chinese ("请求超时（N 秒内无响应）"), so match the
      // Chinese word as well - the English "timeout" only shows up in some
      // reqwest error chains.
      if (/timeout|超时/i.test(msg)) throw new EsError("timeout", msg);
      throw new EsError("unreachable", msg);
    }
    if (res.error) {
      // e.g. ES returned a JSON error body that reqwest flagged; still a result
      return toResult(res.status, res.body || res.error);
    }
    const out = toResult(res.status, res.body);
    if (res.status === 401) {
      throw new EsError("unauthorized", errorText(out), 401);
    }
    return out;
  }
  // Browser fallback (dev only; ES must allow CORS for this to work)
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (conn.username) {
    headers["Authorization"] = "Basic " + btoa(`${conn.username}:${conn.password}`);
  }
  let r: Response;
  try {
    const ac = new AbortController();
    const ms = timeoutSec ? timeoutSec * 1000 : 15000;
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      r = await fetch(`${base}/${cleanPath}`, {
        method,
        headers,
        body: body && method !== "GET" ? body : undefined,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new EsError("timeout", `请求超时（${timeoutSec ?? 15} 秒内无响应）`);
    }
    throw new EsError("unreachable", e?.message ?? "fetch failed");
  }
  const out = toResult(r.status, await r.text());
  if (r.status === 401) {
    throw new EsError("unauthorized", errorText(out), 401);
  }
  return out;
}

function toResult(status: number, raw: string): EsResult {
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {}
  return { status, json, raw };
}

export async function esRequest(
  conn: Connection,
  method: string,
  path: string,
  body?: any,
  timeoutSec?: number
): Promise<EsResult> {
  const payload = body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return rawRequest(conn, method, path, payload, timeoutSec);
}

export const esGet = (c: Connection, p: string, t?: number) => esRequest(c, "GET", p, undefined, t);
export const esPost = (c: Connection, p: string, b?: any, t?: number) => esRequest(c, "POST", p, b, t);
export const esPut = (c: Connection, p: string, b?: any, t?: number) => esRequest(c, "PUT", p, b, t);
export const esDelete = (c: Connection, p: string, b?: any, t?: number) => esRequest(c, "DELETE", p, b, t);
export const esHead = (c: Connection, p: string, t?: number) => esRequest(c, "HEAD", p, undefined, t);

export function errorText(r: EsResult): string {
  const e = r.json?.error;
  if (typeof e === "string") return e;
  if (e?.reason) return `${e.type ?? ""}${e.type ? ": " : ""}${e.reason}`;
  if (r.json?.message) return String(r.json.message);
  if (r.raw) return r.raw.slice(0, 600);
  return `HTTP ${r.status}`;
}
