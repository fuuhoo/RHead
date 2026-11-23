// Request timeout (seconds) shared by the query pages.
//
// The value is sent to the Rust `es_request` command, which applies it to the
// reqwest client - so it is a real wall-clock limit on the ES request, not
// just an ES-side "timeout" body parameter.

export const DEFAULT_TIMEOUT_SEC = 15;
export const MIN_TIMEOUT_SEC = 1;
export const MAX_TIMEOUT_SEC = 600;

const TIMEOUT_LS_KEY = "rhead-timeout-sec";

/** Keep the timeout inside the range the Rust side accepts (1-600). */
export function clampTimeout(raw: string | number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, n));
}

/** Read the persisted timeout (defaults to 15s). */
export function loadTimeout(): number {
  try {
    const raw = localStorage.getItem(TIMEOUT_LS_KEY);
    if (raw != null && raw !== "") return clampTimeout(raw);
  } catch {}
  return DEFAULT_TIMEOUT_SEC;
}

/** Persist the timeout so it survives a restart. */
export function saveTimeout(sec: number) {
  try {
    localStorage.setItem(TIMEOUT_LS_KEY, String(clampTimeout(sec)));
  } catch {}
}
