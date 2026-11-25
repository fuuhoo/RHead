// Cluster state aggregation — ports ClusterState service:
// parallel GET _cluster/state + _stats + _nodes/stats + _nodes + _cluster/health,
// with _all fallback when _cluster/state is unavailable (old ES versions).

import { Connection, EsError, esGet, friendlyError } from "./es";

export interface ClusterSnapshot {
  clusterState: any;
  status: any;
  nodeStats: any;
  clusterNodes: any;
  clusterHealth: any;
  version: string | null;
  connected: boolean;
  error: string | null;
  /** rows of GET _cat/shards — fallback source for shard placement */
  catShards: any;
  /** true when clusterState.routing_table came from the real ES cluster state */
  hasRealRouting: boolean;
}

export async function fetchSnapshot(conn: Connection): Promise<ClusterSnapshot> {
  const snap: ClusterSnapshot = {
    clusterState: null,
    status: null,
    nodeStats: null,
    clusterNodes: null,
    clusterHealth: null,
    version: null,
    connected: false,
    error: null,
    catShards: null,
    hasRealRouting: false,
  };
  const [root, state, stats, nodeStats, nodes, health] = await Promise.allSettled([
    esGet(conn, ""),
    esGet(conn, "_cluster/state"),
    esGet(conn, "_stats"),
    esGet(conn, "_nodes/stats"),
    esGet(conn, "_nodes"),
    esGet(conn, "_cluster/health"),
  ]);
  if (root.status === "fulfilled" && root.value.json?.version?.number) {
    snap.version = root.value.json.version.number;
    snap.connected = true;
  }
  if (state.status === "fulfilled" && state.value.json?.routing_table) {
    snap.clusterState = state.value.json;
    snap.hasRealRouting = !!state.value.json.routing_table?.indices;
  } else if (stats.status === "fulfilled" && stats.value.json?.indices) {
    snap.clusterState = await fallbackFromAll(conn);
  }
  if (stats.status === "fulfilled") snap.status = stats.value.json;
  if (nodeStats.status === "fulfilled") snap.nodeStats = nodeStats.value.json;
  if (nodes.status === "fulfilled") snap.clusterNodes = nodes.value.json;
  if (health.status === "fulfilled") snap.clusterHealth = health.value.json;
  // Some ES versions (or restricted clusters) omit the routing table from
  // _cluster/state — fall back to _cat/shards for the shard placement.
  if (!snap.hasRealRouting) {
    const cat = await esGet(conn, "_cat/shards?format=json&h=index,shard,prirep,state,node").catch(() => null);
    if (Array.isArray(cat?.json)) snap.catShards = cat.json;
  }
  if (!snap.connected) {
    const first = [root, state, stats].find((r) => r.status === "rejected") as any;
    const fulfilledBad = [root, state, stats].find(
      (r) => r.status === "fulfilled" && typeof (r as any).value?.status === "number" && (r as any).value.status >= 400
    ) as any;
    if (first) {
      // Transport failure: surface a friendly, actionable message.
      snap.error = friendlyError(first.reason, conn);
    } else if (fulfilledBad) {
      // ES answered but with an error status (e.g. 401/403).
      const r = fulfilledBad.value;
      snap.error =
        r.status === 401
          ? friendlyError(new EsError("unauthorized", "", 401), conn)
          : `ES 返回 HTTP ${r.status}：${(r.raw ?? "").slice(0, 200) || friendlyError(first?.reason, conn)}`;
    } else {
      snap.error = "未能从 ES 获取集群信息，请检查连接";
    }
  }
  return snap;
}

async function fallbackFromAll(conn: Connection): Promise<any> {
  // Old-ES fallback in original: GET _all gives mappings/aliases/settings per index
  const all = await esGet(conn, "_all").catch(() => null);
  const routing: any = { indices: {} };
  const metadata: any = { indices: {} };
  if (all?.json) {
    for (const [k, v] of Object.entries(all.json) as [string, any][]) {
      // no fake shard entries here: real placement comes from _cat/shards
      routing.indices[k] = { shards: {} };
      metadata.indices[k] = {
        mappings: v.mappings,
        aliases: Object.keys(v.aliases ?? {}),
        settings: v.settings,
      };
    }
  }
  return { routing_table: routing, metadata, master_node: null };
}

export interface NodeRow {
  id: string;
  name: string;
  master: boolean;
  data: boolean;
  httpAddress?: string;
  transport?: string;
  heapUsedPct?: number;
  heapUsedBytes?: number;
  heapMaxBytes?: number;
  diskUsedPct?: number;
  cpuPct?: number;
  load1?: number;
  jvmUptime?: string;
}

/** Build node rows from _nodes + _nodes/stats (used by Cluster Overview). */
export function buildNodes(snap: ClusterSnapshot): NodeRow[] {
  const nodes = snap.clusterNodes?.nodes ?? {};
  const stats = snap.nodeStats?.nodes ?? {};
  const masterId = snap.clusterState?.master_node;
  return Object.entries(nodes).map(([id, n]: [string, any]) => {
    const s = stats[id] ?? {};
    const heap = s.jvm?.mem?.heap_used_percent;
    return {
      id,
      name: n.name ?? id,
      master: id === masterId,
      data: n.attributes?.data !== "false",
      httpAddress: n.http?.publish_address,
      transport: n.transport_address,
      heapUsedPct: heap,
      heapUsedBytes: s.jvm?.mem?.heap_used_in_bytes,
      heapMaxBytes: s.jvm?.mem?.heap_max_in_bytes,
      diskUsedPct: s.fs?.total?.used_percent ?? s.fs?.data?.[0]?.used_percent,
      cpuPct: s.os?.cpu?.percent,
      load1: s.os?.cpu?.load_average?.["1m"],
      jvmUptime: s.jvm?.uptime,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- shard matrix (index × node) ----

/** One shard copy: a primary or a replica living on a node. */
export interface ShardEntry {
  index: string;
  shard: number;
  primary: boolean;
  state: string;
  nodeId: string | null;
  nodeName: string;
  relocating: boolean;
  unassigned: boolean;
}

export interface ShardIndexColumn {
  name: string;
  sizeBytes: number;
  docs: number;
  primaries: number;
  replicas: number;
  copies: number;
  health?: string;
}

export interface ShardNodeRow {
  id: string;
  name: string;
  master: boolean;
  /** index name -> shard copies hosted by this node */
  cells: Record<string, ShardEntry[]>;
}

export interface ShardMatrix {
  /** false when the cluster state carried no routing table (nothing to draw) */
  available: boolean;
  columns: ShardIndexColumn[];
  rows: ShardNodeRow[];
  /** index name -> shard copies that are not assigned to any node */
  unassigned: Record<string, ShardEntry[]>;
  totals: { indices: number; primaries: number; replicas: number; unassigned: number };
}

// node ids ES uses as a placeholder for "no node"
const NO_NODE = new Set(["", "null", "unknown", "none", "_na_"]);

/**
 * Every shard copy of every index, keyed by index name.
 * Source: the cluster-state routing table, or _cat/shards when the cluster
 * state does not carry a routing table.
 */
export function collectShardCopies(
  snap: ClusterSnapshot,
  nameById?: Map<string, string>
): Map<string, ShardEntry[]> {
  const copies = new Map<string, ShardEntry[]>();
  const push = (index: string, e: ShardEntry) => {
    const list = copies.get(index);
    if (list) list.push(e);
    else copies.set(index, [e]);
  };

  const routing: any = snap.clusterState?.routing_table?.indices ?? {};
  if (snap.hasRealRouting) {
    // `shards` is an object keyed by shard number (ES 5+) or an array (ES 2.x);
    // the shard number itself is always carried by the entry.
    for (const [index, info] of Object.entries(routing) as [string, any][]) {
      for (const [shardKey, raw] of Object.entries(info?.shards ?? {}) as [string, any][]) {
        const arr = Array.isArray(raw) ? raw : [raw];
        for (const e of arr) {
          if (!e) continue;
          const key = Number(shardKey);
          const shard = typeof e.shard === "number" ? e.shard : Number.isFinite(key) ? key : -1;
          const nodeId = e.node == null ? "" : String(e.node);
          const unassigned = !nodeId || NO_NODE.has(nodeId) || e.state === "UNASSIGNED";
          push(index, {
            index,
            shard,
            primary: !!e.primary,
            state: e.state ?? "UNKNOWN",
            nodeId: unassigned ? null : nodeId,
            nodeName: unassigned ? "" : (nameById?.get(nodeId) ?? nodeId),
            relocating: e.state === "RELOCATING" || !!e.relocating_node,
            unassigned,
          });
        }
      }
    }
    return copies;
  }

  // Fallback: _cat/shards rows. `node` holds the node name on some versions
  // and the node id on others — resolve against both.
  const idByName = new Map<string, string>();
  for (const [id, name] of nameById ?? []) idByName.set(name, id);
  const rows = Array.isArray(snap.catShards) ? snap.catShards : [];
  for (const row of rows) {
    const index = String(row?.index ?? "");
    if (!index) continue;
    const shard = Number(row.shard);
    const raw = row.node == null ? "" : String(row.node);
    let nodeId: string | null = null;
    if (raw && !NO_NODE.has(raw)) {
      if (nameById?.has(raw)) nodeId = raw;
      else if (idByName.has(raw)) nodeId = idByName.get(raw)!;
    }
    const unassigned = nodeId == null || row.state === "UNASSIGNED";
    push(index, {
      index,
      shard: Number.isFinite(shard) ? shard : -1,
      primary: row.prirep === "p",
      state: row.state ?? "UNKNOWN",
      nodeId: unassigned ? null : nodeId,
      nodeName: unassigned ? "" : (nameById?.get(nodeId!) ?? raw),
      relocating: row.state === "RELOCATING",
      unassigned,
    });
  }
  return copies;
}

/**
 * Build the index × node shard grid from the cluster-state routing table.
 * Columns are the given index names (in the given order), rows are the given
 * nodes (in the given order) plus any node that only shows up in the routing
 * table. Shards without a node are collected separately.
 */
export function buildShardMatrix(
  snap: ClusterSnapshot,
  nodes: NodeRow[],
  columnNames: string[]
): ShardMatrix {
  const available = snap.hasRealRouting || Array.isArray(snap.catShards);
  const stats: any = snap.status?.indices ?? {};

  // node id -> display name
  const nameById = new Map<string, string>();
  for (const n of nodes) nameById.set(n.id, n.name);
  for (const [id, n] of Object.entries(snap.clusterState?.nodes ?? {}) as [string, any][]) {
    if (!nameById.has(id) && n?.name) nameById.set(id, n.name);
  }

  const copies = collectShardCopies(snap, nameById);

  const columns: ShardIndexColumn[] = columnNames.map((name) => {
    const list = copies.get(name) ?? [];
    const st = stats[name];
    return {
      name,
      sizeBytes: st?.total?.store?.size_in_bytes ?? 0,
      docs: st?.primaries?.docs?.count ?? 0,
      primaries: list.filter((e) => e.primary).length,
      replicas: list.filter((e) => !e.primary).length,
      copies: list.length,
      health: st?.health,
    };
  });

  // rows: the given nodes (already ordered) + nodes only seen in the routing table
  const known = new Set(nodes.map((n) => n.id));
  const extra = new Map<string, string>();
  for (const list of copies.values()) {
    for (const e of list) {
      if (e.nodeId && !known.has(e.nodeId)) extra.set(e.nodeId, e.nodeName);
    }
  }
  const rows: ShardNodeRow[] = [
    ...nodes.map((n) => ({ id: n.id, name: n.name, master: n.master, cells: {} as Record<string, ShardEntry[]> })),
    ...[...extra.entries()].map(([id, name]) => ({
      id,
      name,
      master: false,
      cells: {} as Record<string, ShardEntry[]>,
    })),
  ];
  for (const row of rows) {
    for (const col of columns) {
      const list = (copies.get(col.name) ?? []).filter((e) => e.nodeId === row.id);
      list.sort((a, b) => a.shard - b.shard || Number(b.primary) - Number(a.primary));
      row.cells[col.name] = list;
    }
  }

  const unassigned: Record<string, ShardEntry[]> = {};
  for (const col of columns) {
    const list = (copies.get(col.name) ?? []).filter((e) => e.unassigned);
    if (list.length) {
      unassigned[col.name] = list.sort((a, b) => a.shard - b.shard || Number(b.primary) - Number(a.primary));
    }
  }

  return {
    available,
    columns,
    rows,
    unassigned,
    totals: {
      indices: columns.length,
      primaries: columns.reduce((a, c) => a + c.primaries, 0),
      replicas: columns.reduce((a, c) => a + c.replicas, 0),
      unassigned: Object.values(unassigned).reduce((a, l) => a + l.length, 0),
    },
  };
}

export interface IndexRow {
  name: string;
  state: string;
  docs: number;
  sizeBytes: number;
  primaries: number;
  replicas: number;
  health?: string;
  /** configured shard layout: shards per index and replicas per shard */
  configuredShards?: number;
  configuredReplicas?: number;
}

/** The live numbers of one index: document count and store size. */
export interface IndexStat {
  name: string;
  docs: number;
  sizeBytes: number;
}

/**
 * Fetch only the index statistics (document count and size).
 *
 * A full snapshot also pulls the cluster state and the node statistics, which
 * are far heavier; this is a single light request for the numbers the index
 * table shows.
 *
 * The semantics match `buildIndices`: the document count comes from the
 * primary shards (no replica double counting) and the size from all copies.
 */
export async function fetchIndexStats(conn: Connection): Promise<Map<string, IndexStat>> {
  const r = await esGet(conn, "_stats");
  const out = new Map<string, IndexStat>();
  const indices = r?.json?.indices ?? {};
  for (const [name, st] of Object.entries(indices) as [string, any][]) {
    out.set(name, {
      name,
      docs: st?.primaries?.docs?.count ?? 0,
      sizeBytes: st?.total?.store?.size_in_bytes ?? 0,
    });
  }
  return out;
}

/**
 * Read an index setting from the cluster state.
 * ES 7/8 nests them under settings.index.*, ES 5/6 uses flat index.* keys.
 */
function indexSetting(meta: any, key: string): number | undefined {
  const s = meta?.settings;
  if (!s) return undefined;
  const flat = s[key] ?? s[`index.${key}`];
  const nested = s.index && typeof s.index === "object" ? s.index[key] : undefined;
  const raw = nested ?? flat;
  if (raw == null) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function buildIndices(snap: ClusterSnapshot, opts?: { showSystem?: boolean }): IndexRow[] {
  const showSystem = opts?.showSystem ?? true;
  const statusIndices = snap.status?.indices ?? {};
  const metaIndices = snap.clusterState?.metadata?.indices ?? {};
  const names = new Set([...Object.keys(statusIndices), ...Object.keys(metaIndices)]);
  // actual shard copies per index (from the routing table / _cat/shards)
  const copies = collectShardCopies(snap);
  return [...names]
    .filter((n) => showSystem || !n.startsWith("."))
    .map((name) => {
      const st = statusIndices[name];
      const meta = metaIndices[name];
      const list = copies.get(name) ?? [];
      const actualPrimaries = list.filter((e) => e.primary).length;
      const actualReplicas = list.filter((e) => !e.primary).length;
      const cfgShards = indexSetting(meta, "number_of_shards");
      const cfgReplicas = indexSetting(meta, "number_of_replicas");
      // Prefer the real distribution; fall back to the configured layout for
      // closed indices (no routing entry) or when the routing table is absent.
      const primaries = actualPrimaries || cfgShards || 0;
      const replicas =
        actualReplicas ||
        (cfgShards != null && cfgReplicas != null ? cfgShards * cfgReplicas : cfgReplicas || 0);
      return {
        name,
        state: meta?.state ?? (st ? "open" : "close"),
        docs: st?.primaries?.docs?.count ?? 0,
        sizeBytes: st?.total?.store?.size_in_bytes ?? 0,
        primaries,
        replicas,
        health: st?.health,
        configuredShards: cfgShards,
        configuredReplicas: cfgReplicas,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
