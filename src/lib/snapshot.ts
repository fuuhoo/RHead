// Elasticsearch snapshot & restore API wrappers.
//
// The snapshot API is split in two halves:
//   * repositories - where the snapshots are stored (a shared filesystem, an
//     S3 bucket, ...). Registered with PUT /_snapshot/<repo>.
//   * snapshots    - the actual backups, created inside a repository.
//
// A third piece is the snapshot lifecycle management (SLM) which schedules
// snapshot creation and cleanup.

import { Connection, EsResult, esDelete, esGet, esPost, esPut, errorText } from "./es";

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One snapshot inside a repository. */
export interface EsSnapshot {
  snapshot: string;
  uuid?: string;
  version?: string;
  version_id?: number;
  indices?: string[];
  data_streams?: string[];
  include_global_state?: boolean;
  /** SUCCESS | PARTIAL | FAILED | IN_PROGRESS */
  state?: string;
  start_time?: string;
  start_time_in_millis?: number;
  end_time?: string;
  end_time_in_millis?: number;
  duration_in_millis?: number;
  failures?: any[];
  shards?: { total?: number; failed?: number; successful?: number };
  repository?: string;
  /** set when the snapshot was restored from another cluster */
  restore_source?: any;
}

/** A registered snapshot repository. */
export interface EsRepo {
  type: string;
  settings?: Record<string, any>;
  /** only present when the repository holds snapshots */
  snapshots?: EsSnapshot[];
}

/** A snapshot lifecycle management policy. */
export interface EsSlmPolicy {
  version?: number;
  modified_date?: number;
  policy?: {
    name?: string;
    schedule?: string;
    repository?: string;
    config?: {
      indices?: string[];
      include_global_state?: boolean;
      ignore_unavailable?: boolean;
      partial?: boolean;
      [k: string]: any;
    };
    retention?: {
      expire_after?: string;
      min_count?: number;
      max_count?: number;
      max_age?: string;
      [k: string]: any;
    };
    [k: string]: any;
  };
  /** present on older clusters that keep the fields at the top level */
  name?: string;
  schedule?: string;
  repository?: string;
  config?: Record<string, any>;
  retention?: Record<string, any>;
}

/** The repository types ES knows about. */
export const REPO_TYPES = [
  {
    key: "fs",
    label: "文件系统 (fs)",
    hint: "所有节点都能访问的共享目录，需要在 elasticsearch.yml 里配置 path.repo",
  },
  {
    key: "url",
    label: "URL (只读)",
    hint: "通过 HTTP 读取已有的快照，只能恢复不能创建",
  },
  {
    key: "s3",
    label: "S3 / 对象存储",
    hint: "需要插件或 elasticsearch-repository-s3，7.17 起已内置",
  },
  {
    key: "gcs",
    label: "Google Cloud Storage",
    hint: "需要 repository-gcs 插件",
  },
  {
    key: "azure",
    label: "Azure Blob Storage",
    hint: "需要 repository-azure 插件",
  },
] as const;

export type RepoType = (typeof REPO_TYPES)[number]["key"];

/** The settings a repository type accepts. */
export function repoSettingsFor(type: string, pathKey: string): string[] {
  switch (type) {
    case "fs":
      return [pathKey, "compress", "chunk_size", "max_restore_bytes_per_sec", "max_snapshot_bytes_per_sec"];
    case "url":
      return ["url"];
    case "s3":
      return ["bucket", "region", "base_path", "endpoint", "protocol", "access_key", "secret_key", "compress"];
    case "gcs":
      return ["bucket", "client_id", "client_secret", "base_path", "compress"];
    case "azure":
      return ["container", "client_id", "client_secret", "base_path", "compress"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * The most specific error text ES can give.
 *
 * ES wraps the real cause: `error.reason` is often a generic "failed to
 * create repository" while `error.root_cause[0].reason` names the actual
 * problem (which path is missing, which setting is wrong, ...).
 */
export function snapshotErrorText(r: EsResult): string {
  const e = r.json?.error;
  if (e && typeof e === "object") {
    const root = e.root_cause?.[0]?.reason;
    if (typeof root === "string" && root) return root;
    const caused = e.caused_by?.reason;
    if (typeof caused === "string" && caused) return caused;
  }
  return errorText(r);
}

/**
 * ES reports snapshot problems in English and they are not always obvious.
 * The two most common ones are about `path.repo` not being configured.
 */
export function translateSnapshotError(text: string): string {
  if (/doesn't match any of the locations specified by path\.repo because this setting is empty/i.test(text)) {
    return (
      "集群没有配置 path.repo，无法使用文件系统仓库。\n" +
      "请在每个节点的 elasticsearch.yml 中加入：\n" +
      "  path.repo: /data/es-backup\n" +
      "然后重启节点。"
    );
  }
  if (/doesn't match any of the locations specified by path\.repo or repositories\.url\.allowed_urls/i.test(text)) {
    return (
      "该路径不在允许列表里。\n" +
      "文件路径需要加入 elasticsearch.yml 的 path.repo；\n" +
      "URL 需要加入 repositories.url.allowed_urls。\n" +
      "改完要重启节点。"
    );
  }
  if (/cannot create snapshot in a readonly repository/i.test(text)) {
    return "url 类型的仓库是只读的，不能在里面创建快照。请改用 fs 类型的仓库。";
  }
  if (/repository_exception.*failed to create repository/i.test(text)) {
    return "仓库创建失败：" + text;
  }
  if (/no such repository/i.test(text)) {
    return "仓库不存在（可能已被删除）。";
  }
  if (/snapshot .* is already in progress/i.test(text)) {
    return "该仓库里已有快照正在执行，请等它完成。";
  }
  if (/cluster_block_exception/i.test(text)) {
    return "集群状态不允许执行该操作（有分片不可用）。检查集群健康状态后重试。";
  }
  return text;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/**
 * GET /_snapshot/_all -> { repo: EsRepo }
 *
 * The repository list does NOT contain the snapshots - ES 7.x answers with
 * the repository type and settings only. The snapshots have to be read
 * per repository with GET /_snapshot/<repo>/_all.
 */
export async function fetchRepositories(conn: Connection): Promise<Record<string, EsRepo>> {
  const r = await esGet(conn, "_snapshot/_all");
  if (r.status >= 400) throw new Error(translateSnapshotError(errorText(r)));
  const raw = (r.json ?? {}) as Record<string, EsRepo>;

  const names = Object.keys(raw);
  const lists = await Promise.all(names.map((n) => fetchRepositorySnapshots(conn, n)));

  const out: Record<string, EsRepo> = {};
  names.forEach((name, i) => {
    const repo = raw[name];
    out[name] = {
      type: repo.type,
      settings: repo.settings ?? {},
      // ES 8 answers with the snapshots inline - keep them if they are there
      snapshots: repo.snapshots ?? lists[i] ?? [],
    };
  });
  return out;
}

/** GET /_snapshot/<repo>/_all -> the snapshots of one repository. */
export async function fetchRepositorySnapshots(conn: Connection, repo: string): Promise<EsSnapshot[]> {
  const r = await esGet(conn, `_snapshot/${enc(repo)}/_all`);
  if (r.status >= 400) return [];
  const list = r.json?.snapshots;
  return Array.isArray(list) ? list : [];
}

/** PUT /_snapshot/<repo> - creates or replaces a repository. */
export async function putRepository(
  conn: Connection,
  name: string,
  type: string,
  settings: Record<string, any>
): Promise<EsResult> {
  // drop the empty values - ES rejects an empty string setting
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (v === "" || v === null || v === undefined) continue;
    clean[k] = v;
  }
  return esPut(conn, `_snapshot/${enc(name)}`, { type, settings: clean });
}

/** DELETE /_snapshot/<repo> - unregisters the repository (the data stays). */
export async function deleteRepository(conn: Connection, name: string): Promise<EsResult> {
  return esDelete(conn, `_snapshot/${enc(name)}`);
}

/** GET /_snapshot/<repo>/_status - the snapshots currently running. */
export async function fetchRepoStatus(conn: Connection, repo: string): Promise<any[]> {
  const r = await esGet(conn, `_snapshot/${enc(repo)}/_status`);
  if (r.status >= 400) return [];
  return r.json?.snapshots ?? [];
}

/**
 * GET /_cat/shards -> { index: primaryShardCount }
 *
 * Only the PRIMARY shards are counted. A snapshot stores one copy of every
 * primary shard - the replicas are irrelevant for the backup, and they are
 * often unassigned (e.g. on a single node cluster, where a replica cannot
 * live next to its primary). Counting them would wrongly report every
 * snapshot as incomplete.
 */
export async function fetchShardCounts(conn: Connection): Promise<Record<string, number>> {
  const r = await esGet(conn, "_cat/shards?format=json&h=index,shard,prirep,state");
  if (r.status >= 400) return {};
  const out: Record<string, number> = {};
  for (const row of (r.json ?? []) as any[]) {
    if (!row?.index) continue;
    // prirep is "p" (primary) or "r" (replica)
    if (row.prirep !== "p") continue;
    out[row.index] = (out[row.index] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface CreateSnapshotOptions {
  indices?: string;
  includeGlobalState?: boolean;
  ignoreUnavailable?: boolean;
  partial?: boolean;
}

/** PUT /_snapshot/<repo>/<snap> - starts a snapshot. */
export async function createSnapshot(
  conn: Connection,
  repo: string,
  name: string,
  opts: CreateSnapshotOptions
): Promise<EsResult> {
  const body: Record<string, any> = {
    include_global_state: opts.includeGlobalState ?? true,
    ignore_unavailable: opts.ignoreUnavailable ?? true,
    partial: opts.partial ?? false,
  };
  if (opts.indices?.trim()) body.indices = opts.indices.trim();
  return esPut(conn, `_snapshot/${enc(repo)}/${enc(name)}`, body);
}

/** GET /_snapshot/<repo>/<snap> - the details of one snapshot. */
export async function fetchSnapshotDetail(
  conn: Connection,
  repo: string,
  snap: string
): Promise<EsSnapshot | null> {
  const r = await esGet(conn, `_snapshot/${enc(repo)}/${enc(snap)}`);
  if (r.status >= 400) return null;
  const list = r.json?.snapshots;
  if (Array.isArray(list)) return list[0] ?? null;
  // some versions answer with the snapshot object directly
  return r.json?.snapshot ? (r.json as EsSnapshot) : null;
}

/** DELETE /_snapshot/<repo>/<snap> */
export async function deleteSnapshot(conn: Connection, repo: string, snap: string): Promise<EsResult> {
  return esDelete(conn, `_snapshot/${enc(repo)}/${enc(snap)}`);
}

/**
 * POST /_snapshot/<repo>/<snap>/_verify - checks that the files are readable.
 *
 * The single snapshot endpoint only exists from ES 7.9 on. Older clusters
 * answer "no handler found for uri", so fall back to verifying the whole
 * repository (POST /_snapshot/<repo>/_verify).
 */
export async function verifySnapshot(
  conn: Connection,
  repo: string,
  snap: string
): Promise<EsResult & { wholeRepo?: boolean }> {
  const one = await esPost(conn, `_snapshot/${enc(repo)}/${enc(snap)}/_verify`);
  if (one.status < 400) return { ...one, wholeRepo: false };
  const text = errorText(one);
  if (!/no handler found/i.test(text)) return { ...one, wholeRepo: false };

  const all = await esPost(conn, `_snapshot/${enc(repo)}/_verify`);
  return { ...all, wholeRepo: true };
}

/** POST /_snapshot/<repo>/_cleanup - removes the snapshots that fall out of the retention. */
export async function cleanupSnapshots(
  conn: Connection,
  repo: string,
  opts: { keep?: number; deleteOlderThan?: string }
): Promise<EsResult> {
  const body: Record<string, any> = {};
  if (opts.keep != null && opts.keep > 0) body.keep = opts.keep;
  if (opts.deleteOlderThan?.trim()) body.delete_older_than = opts.deleteOlderThan.trim();
  if (!Object.keys(body).length) body.keep = 1;
  return esPost(conn, `_snapshot/${enc(repo)}/_cleanup`, body);
}

// ---------------------------------------------------------------------------
// Snapshot lifecycle management
// ---------------------------------------------------------------------------

/** GET /_slm/status -> { operation_mode } */
export async function fetchSlmStatus(conn: Connection): Promise<string | null> {
  const r = await esGet(conn, "_slm/status");
  if (r.status >= 400) return null;
  return r.json?.operation_mode ?? null;
}

/** GET /_slm/policy -> { id: EsSlmPolicy } */
export async function fetchSlmPolicies(conn: Connection): Promise<Record<string, EsSlmPolicy>> {
  const r = await esGet(conn, "_slm/policy");
  if (r.status >= 400) return {};
  const out: Record<string, EsSlmPolicy> = {};
  for (const [id, p] of Object.entries((r.json ?? {}) as Record<string, EsSlmPolicy>)) {
    out[id] = p;
  }
  return out;
}

export interface SlmPolicyPayload {
  name?: string;
  repository: string;
  schedule: string;
  indices?: string;
  includeGlobalState?: boolean;
  ignoreUnavailable?: boolean;
  partial?: boolean;
  expireAfter?: string;
  minCount?: number;
  maxCount?: number;
  enabled?: boolean;
}

/** PUT /_slm/policy/<id> */
export async function putSlmPolicy(conn: Connection, id: string, payload: SlmPolicyPayload): Promise<EsResult> {
  const config: Record<string, any> = {
    include_global_state: payload.includeGlobalState ?? true,
    ignore_unavailable: payload.ignoreUnavailable ?? true,
    partial: payload.partial ?? false,
  };
  if (payload.indices?.trim()) config.indices = payload.indices.trim().split(/[,\s]+/).filter(Boolean);

  const retention: Record<string, any> = {};
  if (payload.expireAfter?.trim()) retention.expire_after = payload.expireAfter.trim();
  if (payload.minCount != null) retention.min_count = payload.minCount;
  if (payload.maxCount != null) retention.max_count = payload.maxCount;

  const body: Record<string, any> = {
    schedule: payload.schedule,
    name: payload.name?.trim() || payload.schedule,
    repository: payload.repository,
    config,
  };
  if (Object.keys(retention).length) body.retention = retention;

  return esPut(conn, `_slm/policy/${enc(id)}`, body);
}

/** DELETE /_slm/policy/<id> */
export async function deleteSlmPolicy(conn: Connection, id: string): Promise<EsResult> {
  return esDelete(conn, `_slm/policy/${enc(id)}`);
}

/** POST /_slm/_start - resumes the SLM scheduler. */
export async function startSlm(conn: Connection): Promise<EsResult> {
  return esPost(conn, "_slm/_start");
}

/** POST /_slm/_stop - pauses the SLM scheduler. */
export async function stopSlm(conn: Connection): Promise<EsResult> {
  return esPost(conn, "_slm/_stop");
}

/**
 * GET /_cat/indices -> { index: bytes }
 *
 * The snapshot API does not report how big a snapshot is, so the size of the
 * indices it contains is used as the approximation. It matches the size of a
 * full snapshot; incremental snapshots are smaller.
 */
export async function fetchIndexSizes(conn: Connection): Promise<Record<string, number>> {
  const r = await esGet(conn, "_cat/indices?format=json&h=index,store.size&bytes=b");
  if (r.status >= 400) return {};
  const out: Record<string, number> = {};
  for (const row of (r.json ?? []) as any[]) {
    const n = Number(row?.["store.size"]);
    if (row?.index && Number.isFinite(n)) out[row.index] = n;
  }
  return out;
}

/** The relevant part of the cluster health. */
export interface EsClusterHealth {
  status?: string;
  numberOfNodes?: number;
  activeShards?: number;
  unassignedShards?: number;
  totalShards?: number;
}

/** GET /_cluster/health */
export async function fetchClusterHealth(conn: Connection): Promise<EsClusterHealth> {
  const r = await esGet(
    conn,
    "_cluster/health?filter_path=status,number_of_nodes,active_shards,unassigned_shards,initializing_shards,relocating_shards"
  );
  if (r.status >= 400) return {};
  const j = r.json ?? {};
  const active = j.active_shards ?? 0;
  const unassigned = j.unassigned_shards ?? 0;
  const initializing = j.initializing_shards ?? 0;
  const relocating = j.relocating_shards ?? 0;
  return {
    status: j.status,
    numberOfNodes: j.number_of_nodes,
    activeShards: active,
    unassignedShards: unassigned,
    // the health API has no total - it is the sum of all shard states
    totalShards: active + unassigned + initializing + relocating,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The readable location of a repository, whatever type it is. */
export function repoLocation(repo: EsRepo): string {
  const s = repo.settings ?? {};
  return (
    s.location ||
    s.path ||
    s.url ||
    s.bucket ||
    s.container ||
    s.blob_container ||
    ""
  );
}

/** The primary key of a repository's settings, by type. */
export function repoPathKey(type: string, esMajor: number | null): string {
  // the fs repository setting was called "path" up to ES 6.x and "location"
  // from ES 7.0 on
  if (type === "fs") return esMajor != null && esMajor < 7 ? "path" : "location";
  if (type === "url") return "url";
  if (type === "s3" || type === "gcs") return "bucket";
  if (type === "azure") return "container";
  return "";
}
