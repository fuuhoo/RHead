// Persisted column visibility for the result tables.
//
// Which columns are shown is a per-index preference: the fields of one index
// have nothing to do with another one. The hidden-column list is stored per
// storage key (the index name plus the connection it came from) so switching
// between indexes keeps each one's layout.
//
// The pinned columns (_index / _id / _score) are never stored - they always
// stay visible.

const LS_PREFIX = "rhead-cols-hidden:";

/**
 * Build the storage key for a table.
 *
 * The connection part keeps two clusters apart: the same index name on two
 * different clusters can have completely different fields.
 */
export function columnStoreKey(baseUrl: string, username: string, index: string): string {
  return `${LS_PREFIX}${baseUrl}|${username}|${index}`;
}

/**
 * Read the hidden columns for a key.
 * Returns an empty set when nothing was stored or the stored value is broken.
 */
export function loadHiddenColumns(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

/** Persist the hidden columns for a key. */
export function saveHiddenColumns(key: string, hidden: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...hidden]));
  } catch {}
}

/** Drop the stored preference for a key. */
export function clearHiddenColumns(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
