import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

// Bulk export bridge.
//
// The export itself runs in Rust (see src-tauri/src/lib.rs): pages are pulled
// from ES and appended to the file as they arrive, so memory stays constant
// regardless of the result size. This module is only the IPC surface.

export type ExportFormat = "ndjson" | "csv" | "json";

export interface ExportProgress {
  id: string;
  rows: number;
  bytes: number;
  phase: "running" | "done" | "cancelled" | string;
}

export interface ExportSummary {
  path: string;
  format: string;
  rows: number;
  bytes: number;
  /** paging strategy that was used: PIT | Scroll | from */
  strategy: string;
  /** false when the export stopped early (canceled or row limit hit) */
  complete: boolean;
}

export interface ExportOptions {
  id: string;
  baseUrl: string;
  username: string;
  password: string;
  /** comma separated index list */
  indices: string;
  /** query body (the UI's DSL; paging/sort/aggs are stripped by Rust) */
  body: any;
  format: ExportFormat;
  /** only these fields, null/empty = all */
  fields?: string[] | null;
  includeMeta: boolean;
  /** column list for CSV (from the index mapping) */
  csvColumns?: string[] | null;
  outPath: string;
  maxRows?: number | null;
  chunkSize?: number;
}

/** The export needs the Rust side, so it only works inside the desktop app. */
export function exportSupported(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Open the native save dialog; returns null when the user cancels. */
export async function pickExportPath(defaultName: string, ext: string): Promise<string | null> {
  return invoke<string | null>("export_pick_path", { defaultName, ext });
}

export async function runExport(opts: ExportOptions): Promise<ExportSummary> {
  return invoke<ExportSummary>("export_docs", {
    id: opts.id,
    baseUrl: opts.baseUrl,
    username: opts.username || null,
    password: opts.password || null,
    indices: opts.indices,
    body: JSON.stringify(opts.body ?? {}),
    format: opts.format,
    fields: opts.fields && opts.fields.length ? opts.fields : null,
    includeMeta: opts.includeMeta,
    csvColumns: opts.csvColumns && opts.csvColumns.length ? opts.csvColumns : null,
    outPath: opts.outPath,
    maxRows: opts.maxRows ?? null,
    chunkSize: opts.chunkSize ?? 1000,
  });
}

export async function cancelExport(id: string): Promise<void> {
  return invoke<void>("export_cancel", { id });
}

export function onExportProgress(cb: (p: ExportProgress) => void): Promise<UnlistenFn> {
  return listen<ExportProgress>("rhead://export-progress", (e) => cb(e.payload));
}
