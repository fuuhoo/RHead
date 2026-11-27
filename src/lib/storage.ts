import { Connection, esGet } from "./es";

// Storage accounting for the cluster.
//
// Three different numbers are often confused with each other, so they are
// kept apart here:
//
//   1. 索引数据量 (index bytes) - how much the index data itself takes.
//      _cat/indices reports the primary data size (replicas not counted);
//      _nodes/stats/indices reports what each node actually holds, which
//      includes the replica copies.
//   2. 磁盘已用 (disk used) - how much of the node's filesystem is taken.
//      This includes everything on that disk, not just Elasticsearch.
//   3. 磁盘总量 (disk total) - the size of the data path's filesystem.
//
// The two index numbers differ by roughly the replication factor.

export interface NodeStorage {
  id: string;
  name: string;
  /** how many shard copies live on this node */
  shards: number;
  /** primary shards on this node */
  primaries: number;
  /** how many bytes of index data this node holds (replicas included) */
  indexBytes: number;
  /** how many documents this node holds */
  docs: number;
  /** the filesystem of the data path */
  diskTotal: number;
  diskUsed: number;
  diskFree: number;
  diskPercent: number;
  /** the data path directory */
  dataPath?: string;
  /** the mount point of the data path */
  mount?: string;
  /** the shard ids on this node */
  shardIds: string[];
}

export interface ClusterStorage {
  nodes: NodeStorage[];
  /** shard copies that are not assigned to any node */
  unassignedShards: number;
  /** the sum of the node filesystems */
  diskTotal: number;
  diskUsed: number;
  diskFree: number;
  diskPercent: number;
  /** the index data on all nodes (replica copies included) */
  indexBytes: number;
  /** the index data without the replica copies - the logical size */
  primaryIndexBytes: number;
  docs: number;
  /** the number of indices */
  indexCount: number;
}

/**
 * Collect the storage numbers of the cluster.
 *
 * Everything comes from three calls:
 *   _cat/allocation          - the shard distribution and ES's own disk view
 *   _nodes/stats/fs,indices  - the filesystem and the index data per node
 *   _cat/indices             - the logical index sizes (primaries only)
 */
export async function fetchStorage(conn: Connection): Promise<ClusterStorage> {
  const [allocRes, statsRes, idxRes] = await Promise.all([
    esGet(conn, "_cat/allocation?format=json&bytes=b&h=shards,node,prirep,disk.used,disk.avail,disk.total,disk.percent"),
    esGet(conn, "_nodes/stats/fs,indices"),
    esGet(conn, "_cat/indices?format=json&bytes=b&h=index,pri,rep,store.size,docs.count"),
  ]);

  // ---- per node: the allocation view -------------------------------------
  interface Alloc {
    shards: number;
    primaries: number;
    diskTotal: number;
    diskUsed: number;
    diskPercent: number;
  }
  const alloc = new Map<string, Alloc>();
  let unassigned = 0;
  if (allocRes.status < 400) {
    for (const row of (allocRes.json ?? []) as any[]) {
      const name = String(row?.node ?? "");
      if (!name || name === "UNASSIGNED") {
        unassigned += Number(row?.shards ?? 0);
        continue;
      }
      const cur = alloc.get(name) ?? { shards: 0, primaries: 0, diskTotal: 0, diskUsed: 0, diskPercent: 0 };
      cur.shards += Number(row?.shards ?? 0);
      if (row?.prirep === "p") cur.primaries += Number(row?.shards ?? 0);
      // the cat API reports the same disk for every row of a node
      cur.diskTotal = Number(row?.["disk.total"] ?? 0) || cur.diskTotal;
      cur.diskUsed = Number(row?.["disk.used"] ?? 0) || cur.diskUsed;
      cur.diskPercent = Number(row?.["disk.percent"] ?? 0) || cur.diskPercent;
      alloc.set(name, cur);
    }
  }

  // ---- per node: the filesystem and the index data ------------------------
  const nodes: NodeStorage[] = [];
  if (statsRes.status < 400) {
    const stats = (statsRes.json as any)?.nodes ?? {};
    for (const [id, n] of Object.entries(stats) as [string, any][]) {
      const name = n?.name ?? id;
      const a = alloc.get(name) ?? { shards: 0, primaries: 0, diskTotal: 0, diskUsed: 0, diskPercent: 0 };

      // the data path filesystem is the one that matters for the indices.
      // A node can have several data paths - they are summed up.
      const paths = (n?.fs?.data ?? []) as any[];
      const fsTotal = paths.length
        ? paths.reduce((sum, p) => sum + (p?.total_in_bytes ?? 0), 0)
        : n?.fs?.total?.total_in_bytes ?? 0;
      const fsFree = paths.length
        ? paths.reduce((sum, p) => sum + (p?.available_in_bytes ?? p?.free_in_bytes ?? 0), 0)
        : n?.fs?.total?.available_in_bytes ?? n?.fs?.total?.free_in_bytes ?? 0;
      const fsUsed = paths.length
        ? paths.reduce((sum, p) => sum + (p?.total_in_bytes ?? 0) - (p?.free_in_bytes ?? 0), 0)
        : (n?.fs?.total?.total_in_bytes ?? 0) - (n?.fs?.total?.free_in_bytes ?? 0);
      const fsPercent =
        paths.length && fsTotal > 0
          ? (fsUsed / fsTotal) * 100
          : n?.fs?.total?.used_percent ?? a.diskPercent;

      nodes.push({
        id,
        name,
        shards: a.shards,
        primaries: a.primaries,
        indexBytes: n?.indices?.store?.size_in_bytes ?? 0,
        docs: n?.indices?.docs?.count ?? 0,
        diskTotal: fsTotal || a.diskTotal,
        diskUsed: fsUsed,
        diskFree: fsFree,
        diskPercent: fsPercent ?? 0,
        dataPath: paths.length === 1 ? paths[0]?.path : paths.map((p) => p?.path).filter(Boolean).join(", "),
        mount: paths.length === 1 ? paths[0]?.mount : undefined,
        shardIds: [],
      });
    }
  }

  // ---- the cluster totals -------------------------------------------------
  let primaryIndexBytes = 0;
  let indexCount = 0;
  if (idxRes.status < 400) {
    for (const row of (idxRes.json ?? []) as any[]) {
      indexCount += 1;
      primaryIndexBytes += Number(row?.["store.size"] ?? 0);
    }
  }

  const diskTotal = nodes.reduce((n, x) => n + x.diskTotal, 0);
  const diskUsed = nodes.reduce((n, x) => n + x.diskUsed, 0);
  const diskFree = nodes.reduce((n, x) => n + x.diskFree, 0);

  return {
    nodes: nodes.sort((a, b) => b.diskUsed - a.diskUsed || a.name.localeCompare(b.name)),
    unassignedShards: unassigned,
    diskTotal,
    diskUsed,
    diskFree,
    diskPercent: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
    indexBytes: nodes.reduce((n, x) => n + x.indexBytes, 0),
    primaryIndexBytes,
    docs: nodes.reduce((n, x) => n + x.docs, 0),
    indexCount,
  };
}

/** The storage numbers of a single node, for the node detail drawer. */
export async function fetchNodeStorage(conn: Connection, nodeId: string): Promise<NodeStorage | null> {
  const all = await fetchStorage(conn);
  return all.nodes.find((n) => n.id === nodeId || n.name === nodeId) ?? null;
}
