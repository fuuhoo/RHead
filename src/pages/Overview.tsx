import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, errorText, esGet, esPut, friendlyError } from "../lib/es";
import { byteSize, count, healthColor, healthFraction } from "../lib/format";
import { buildIndices, buildNodes, buildShardMatrix, ClusterSnapshot, fetchIndexStats, IndexStat } from "../lib/cluster";
import { ClusterStorage, fetchStorage } from "../lib/storage";
import JsonView from "../components/JsonView";
import Drawer from "../components/Drawer";
import Modal from "../components/Modal";
import ShardMatrix from "../components/ShardMatrix";

interface Props {
  conn: Connection;
  snap: ClusterSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
  /** open an index in the structured query page (shard chip / index name click) */
  onOpenIndex?: (index: string) => void;
}

// Cluster Overview — ports ui/ClusterOverview: health summary, node grid,
// index list with per-index actions (open/close/refresh/flush/alias).

const QUICK: { label: string; path: string }[] = [
  { label: "集群信息", path: "" },
  { label: "集群状态 _stats", path: "_stats" },
  { label: "节点统计 _nodes/stats", path: "_nodes/stats" },
  { label: "集群节点 _nodes", path: "_nodes" },
  { label: "插件 _nodes/plugins", path: "_nodes/plugins" },
  { label: "Cluster State", path: "_cluster/state" },
  { label: "Cluster Health", path: "_cluster/health" },
  { label: "模板 _template", path: "_template" },
];

export default function Overview({ conn, snap, loading, onRefresh, onOpenIndex }: Props) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<"name" | "address" | "type">("name");
  const [quickData, setQuickData] = useState<{ title: string; data: any } | null>(null);
  const [aliasFor, setAliasFor] = useState<string | null>(null);
  const [aliasName, setAliasName] = useState("");
  const [msg, setMsg] = useState("");
  const [showSystem, setShowSystem] = useState(true);
  const [quickOpen, setQuickOpen] = useState(false);
  const quickRef = useRef<HTMLDivElement>(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newShards, setNewShards] = useState("5");
  const [newReplicas, setNewReplicas] = useState("1");
  const [indexSort, setIndexSort] = useState<{ field: "name" | "docs" | "size"; order: "asc" | "desc" }>({
    field: "name",
    order: "asc",
  });
  // live document counts fetched on demand (the snapshot may be stale)
  const [liveStats, setLiveStats] = useState<Map<string, IndexStat> | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState("");
  const [statsAt, setStatsAt] = useState<Date | null>(null);

  // close the quick-menu popover on outside click / Esc
  useEffect(() => {
    if (!quickOpen) return;
    const onDown = (e: MouseEvent) => {
      if (quickRef.current && !quickRef.current.contains(e.target as Node)) setQuickOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setQuickOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [quickOpen]);

  const nodes = useMemo(() => {
    if (!snap) return [];
    const rows = buildNodes(snap);
    const by: Record<string, (a: any, b: any) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      address: (a, b) => (a.transport ?? "").localeCompare(b.transport ?? ""),
      type: (a, b) => Number(b.master) - Number(a.master) || a.name.localeCompare(b.name),
    };
    return rows.sort(by[sort]);
  }, [snap, sort]);

  const indices = useMemo(() => {
    if (!snap) return [];
    const q = filter.trim().toLowerCase();
    const list = buildIndices(snap, { showSystem }).filter((i) => !q || i.name.toLowerCase().includes(q));
    // the live numbers win over the snapshot - they were fetched later
    const merged = liveStats
      ? list.map((i) => {
          const s = liveStats.get(i.name);
          return s ? { ...i, docs: s.docs, sizeBytes: s.sizeBytes } : i;
        })
      : list;
    const dir = indexSort.order === "asc" ? 1 : -1;
    return [...merged].sort((a, b) => {
      if (indexSort.field === "docs") return dir * (a.docs - b.docs);
      if (indexSort.field === "size") return dir * (a.sizeBytes - b.sizeBytes);
      return dir * a.name.localeCompare(b.name);
    });
  }, [snap, filter, showSystem, indexSort, liveStats]);

  // index × node shard grid, using the same index list (filtered + sorted)
  const matrix = useMemo(
    () => (snap ? buildShardMatrix(snap, nodes, indices.map((i) => i.name)) : null),
    [snap, nodes, indices]
  );

  const toggleIndexSort = (field: "name" | "docs" | "size") =>
    setIndexSort((s) =>
      s.field === field ? { field, order: s.order === "asc" ? "desc" : "asc" } : { field, order: "asc" }
    );
  const sortMark = (field: "name" | "docs" | "size") =>
    indexSort.field === field ? (
      <span className="sort-arrow">{indexSort.order === "asc" ? "▲" : "▼"}</span>
    ) : null;

  const health = snap?.clusterHealth;
  const color = healthColor(health?.status);
  const frac = healthFraction(health);

  /**
   * Re-read the index statistics only.
   *
   * The snapshot on top of the page pulls the cluster state and the node
   * statistics as well, which is slow on a big cluster; the index table only
   * needs the document counts and the sizes.
   */
  async function refreshIndexStats() {
    setStatsLoading(true);
    setStatsError("");
    try {
      const stats = await fetchIndexStats(conn);
      setLiveStats(stats);
      setStatsAt(new Date());
    } catch (e: any) {
      setStatsError(friendlyError(e, conn));
    } finally {
      setStatsLoading(false);
    }
  }

  async function openIndex(name: string) {
    setMsg("");
    try {
      const r = await esPut(conn, `/${encodeURIComponent(name)}/_open`);
      setMsg(r.status < 300 ? `${name} 已开启` : errorText(r));
      onRefresh();
    } catch (e: any) {
      setMsg(friendlyError(e, conn));
    }
  }

  async function createAlias() {
    if (!aliasFor || !aliasName.trim()) return;
    const r = await esPut(conn, `/_alias/${encodeURIComponent(aliasName.trim())}`, {
      indices: [aliasFor],
    });
    setMsg(r.status < 300 ? `别名 ${aliasName} 已创建` : errorText(r));
    setAliasFor(null);
    setAliasName("");
    onRefresh();
  }

  async function createIndex() {
    const name = newName.trim();
    if (!name) return;
    let r;
    try {
      r = await esPut(conn, `/${encodeURIComponent(name)}`, {
        settings: { index: { number_of_shards: +newShards, number_of_replicas: +newReplicas } },
      });
    } catch (e: any) {
      setMsg(friendlyError(e, conn));
      return;
    }
    setMsg(r.status < 300 ? `索引 ${name} 已创建` : errorText(r));
    if (r.status < 300) {
      setShowNew(false);
      setNewName("");
      onRefresh();
    }
  }

  async function showInfo(idx: string, kind: "status" | "info" | "mapping") {
    const path =
      kind === "status"
        ? `/${encodeURIComponent(idx)}/_status`
        : kind === "info"
          ? `/${encodeURIComponent(idx)}/_settings`
          : `/${encodeURIComponent(idx)}/_mapping`;
    try {
      const r = await esGet(conn, path);
      setQuickData({ title: `${idx} · ${kind === "info" ? "settings" : kind}`, data: r.json ?? r.raw });
    } catch (e: any) {
      setMsg(friendlyError(e, conn));
    }
  }

  return (
    <div className="page">
      <div className="page-toolbar">
        <h2>集群概览</h2>
        <div className="toolbar-actions">
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as any)}>
            <option value="name">按名称排序</option>
            <option value="address">按地址排序</option>
            <option value="type">按类型排序</option>
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
            <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
            显示系统索引
          </label>
          <button className="btn" onClick={onRefresh} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <div className="quick-menu" ref={quickRef}>
            <button className="btn" onClick={() => setQuickOpen((o) => !o)} aria-expanded={quickOpen}>
              快捷接口 <span className="caret">▾</span>
            </button>
            {quickOpen && (
              <div className="quick-pop" role="menu">
                {QUICK.map((q) => (
                  <button
                    key={q.path}
                    className="quick-item"
                    role="menuitem"
                    onClick={async () => {
                      setQuickOpen(false);
                      try {
                        const r = await esGet(conn, q.path);
                        setQuickData({ title: q.label, data: r.json ?? r.raw });
                      } catch (e: any) {
                        setMsg(friendlyError(e, conn));
                      }
                    }}
                  >
                    <span>{q.label}</span>
                    <span className="quick-path">/{q.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {snap?.error && <div className="alert alert-error">{snap.error}</div>}
      {msg && (
        <div className="alert">
          <span>{msg}</span>
          <button className="alert-close" onClick={() => setMsg("")} title="关闭">✕</button>
        </div>
      )}

      <section className="cards">
        <div className="card">
          <span className="card-label">健康状态</span>
          <span className="card-value" style={{ color }}>
            {health?.status ?? "未知"}
            {frac && <em className="card-frac">({frac.text})</em>}
          </span>
          <span className="card-sub">
            {frac
              ? `分片 ${frac.active} / ${frac.total} 已分配 · ${frac.percent}%`
              : `分片 ${health?.number_of_data_nodes ?? "-"} 节点 · ${health?.active_shards_percent ?? "-"}% active`}
            {frac?.unassigned ? ` · ${frac.unassigned} 未分配` : ""}
          </span>
        </div>
        <div className="card">
          <span className="card-label">集群名</span>
          <span className="card-value">{snap?.clusterState?.cluster_name ?? "-"}</span>
          <span className="card-sub">ES {snap?.version ?? "-"}</span>
        </div>
        <div className="card">
          <span className="card-label">节点数</span>
          <span className="card-value">{nodes.length}</span>
          <span className="card-sub">主节点 {nodes.filter((n) => n.master).length} 个</span>
        </div>
        <div className="card">
          <span className="card-label">索引数</span>
          <span className="card-value">{indices.length}</span>
          <span className="card-sub">总文档 {count(indices.reduce((a, i) => a + i.docs, 0))}</span>
        </div>
      </section>

      <StorageSection conn={conn} />

      <h3>节点 ({nodes.length})</h3>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>角色</th>              <th>HTTP 地址</th>
              <th>堆内存</th>
              <th>磁盘</th>
              <th>CPU</th>
              <th>Load(1m)</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td>
                  {n.name} {n.master && <span className="badge badge-master">master</span>}
                  {n.data && <span className="badge">data</span>}
                </td>
                <td>{n.master ? "Master" : n.data ? "Data" : "Client"}</td>
                <td>{n.httpAddress ?? "-"}</td>
                <td>
                  {n.heapUsedPct != null ? (
                    <span className="meter">
                      <span style={{ width: `${n.heapUsedPct}%`, background: meterColor(n.heapUsedPct) }} />
                      <em>{n.heapUsedPct}%{n.heapUsedBytes ? ` · ${byteSize(n.heapUsedBytes)}` : ""}</em>
                    </span>
                  ) : "-"}
                </td>
                <td>{n.diskUsedPct != null ? `${n.diskUsedPct}%` : "-"}</td>
                <td>{n.cpuPct != null ? `${n.cpuPct}%` : "-"}</td>
                <td>{n.load1 ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="h3-row">
        <h3>分片分布</h3>
        {matrix && (
          <span className="shard-summary">
            {matrix.totals.indices} 个索引 · {matrix.totals.primaries} 个主分片 · {matrix.totals.replicas} 个副本
            {matrix.totals.unassigned > 0 && ` · ${matrix.totals.unassigned} 个未分配`}
          </span>
        )}
        <div className="shard-legend">
          <span className="shard-legend-item">
            <span className="shard-chip shard-chip-primary">0</span> 主分片
          </span>
          <span className="shard-legend-item">
            <span className="shard-chip shard-chip-replica">0</span> 副本
          </span>
          <span className="shard-legend-item">
            <span className="shard-chip shard-chip-relocating">0</span> 迁移中
          </span>
          <span className="shard-legend-item">
            <span className="shard-chip shard-chip-unassigned">0</span> 未分配
          </span>
        </div>
      </div>
      {matrix && <ShardMatrix matrix={matrix} onOpenIndex={onOpenIndex} />}

      <div className="h3-row">
        <h3>索引 ({indices.length})</h3>
        <input
          className="input input-sm index-search"
          placeholder="搜索索引…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="btn btn-xs idx-refresh"
          onClick={refreshIndexStats}
          disabled={statsLoading}
          title="重新读取各索引的文档数与大小（仅请求 _stats，不刷新整个集群）"
        >
          {statsLoading ? <span className="spinner" /> : "↻"} 刷新
        </button>
        <button className="btn btn-xs" onClick={() => setShowNew(true)}>＋ 新建索引</button>
      </div>
      {statsError && <div className="alert alert-error idx-refresh-error">{statsError}</div>}
      {statsAt && !statsError && (
        <div className="idx-refresh-note">
          文档数已于 {statsAt.toLocaleTimeString("zh-CN", { hour12: false })} 刷新
        </div>
      )}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggleIndexSort("name")}>
                索引 {sortMark("name")}
              </th>
              <th>状态</th>
              <th className="sortable" onClick={() => toggleIndexSort("docs")}>
                文档数 {sortMark("docs")}
              </th>
              <th className="sortable" onClick={() => toggleIndexSort("size")}>
                大小 {sortMark("size")}
              </th>
              <th>分片</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {indices.map((i) => (
              <tr key={i.name}>
                <td>{i.name}</td>
                <td>
                  <span className={`badge ${i.state === "open" ? "badge-open" : "badge-close"}`}>
                    {i.state}
                  </span>
                </td>
                <td>{count(i.docs)}</td>
                <td>{byteSize(i.sizeBytes)}</td>
                <td
                  title={
                    i.configuredShards != null
                      ? `配置：${i.configuredShards} 个分片 · 每分片 ${i.configuredReplicas ?? 0} 个副本`
                      : undefined
                  }
                >
                  {i.primaries}主 / {i.replicas}副本
                </td>
                <td className="row-actions">
                  <button className="btn btn-xs" onClick={() => showInfo(i.name, "status")}>状态</button>
                  <button className="btn btn-xs" onClick={() => showInfo(i.name, "info")}>信息</button>
                  <button className="btn btn-xs" onClick={() => showInfo(i.name, "mapping")}>Mapping</button>
                  {i.state !== "open" && (
                    <button className="btn btn-xs" onClick={() => openIndex(i.name)}>开启</button>
                  )}
                  <button className="btn btn-xs" onClick={() => setAliasFor(i.name)}>别名…</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {aliasFor && (
        <Modal title={`为 ${aliasFor} 创建别名`} onClose={() => setAliasFor(null)}>
          <input className="input" autoFocus value={aliasName} onChange={(e) => setAliasName(e.target.value)} placeholder="别名名称" />
          <div className="modal-actions">
            <button className="btn" onClick={createAlias}>创建</button>
            <button className="btn btn-ghost" onClick={() => setAliasFor(null)}>取消</button>
          </div>
        </Modal>
      )}
      {quickData && (
        <Drawer title={quickData.title} onClose={() => setQuickData(null)} width={640}>
          <JsonView title={quickData.title} data={quickData.data} />
        </Drawer>
      )}
      {showNew && (
        <Modal title="新建索引" onClose={() => setShowNew(false)}>
          <label>
            索引名称
            <input className="input" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <label>
            分片数
            <input className="input" type="number" min={1} value={newShards} onChange={(e) => setNewShards(e.target.value)} />
          </label>
          <label>
            副本数
            <input className="input" type="number" min={0} value={newReplicas} onChange={(e) => setNewReplicas(e.target.value)} />
          </label>
          <div className="modal-actions">
            <button className="btn" onClick={createIndex}>创建</button>
            <button className="btn btn-ghost" onClick={() => setShowNew(false)}>取消</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function meterColor(pct: number): string {
  if (pct >= 85) return "#ef4444";
  if (pct >= 70) return "#eab308";
  return "#22c55e";
}

/**
 * The storage section of the overview.
 *
 * Shows how much room the cluster has in total and how it is spread over
 * the nodes. Three numbers are kept apart, because they differ a lot and
 * mixing them up is a common source of confusion:
 *
 *   索引数据量 - what the index data itself takes
 *   磁盘已用   - how full the node's filesystem is (includes everything)
 *   磁盘总量   - the size of the filesystem
 */
function StorageSection({ conn }: { conn: Connection }) {
  const [data, setData] = useState<ClusterStorage | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      setData(await fetchStorage(conn));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [conn]);

  useEffect(() => {
    load();
  }, [load]);

  if (err) {
    return (
      <section className="storage-section">
        <div className="h3-row">
          <h3>存储空间</h3>
        </div>
        <div className="alert alert-error">读取存储信息失败：{err}</div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="storage-section">
        <div className="h3-row">
          <h3>存储空间</h3>
        </div>
        <div className="muted">读取中…</div>
      </section>
    );
  }

  const { nodes } = data;
  // the replica factor explains why the disk holds more than the index data
  const ratio = data.primaryIndexBytes > 0 ? data.indexBytes / data.primaryIndexBytes : 1;

  return (
    <section className="storage-section">
      <div className="h3-row">
        <h3>存储空间</h3>
        <button className="btn btn-xs btn-ghost" onClick={load} disabled={loading}>
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      <section className="cards">
        <div className="card">
          <span className="card-label">索引数据量</span>
          <span className="card-value">{byteSize(data.primaryIndexBytes)}</span>
          <span className="card-sub">
            {data.indexCount} 个索引 · {count(data.docs)} 文档
            {ratio > 1.05 && ` · 含副本共 ${byteSize(data.indexBytes)}`}
          </span>
        </div>
        <div className="card">
          <span className="card-label">磁盘已用</span>
          <span className="card-value" style={{ color: meterColor(data.diskPercent) }}>
            {byteSize(data.diskUsed)}
          </span>
          <span className="card-sub">占总量 {data.diskPercent.toFixed(1)}%</span>
        </div>
        <div className="card">
          <span className="card-label">磁盘可用</span>
          <span className="card-value">{byteSize(data.diskFree)}</span>
          <span className="card-sub">共 {byteSize(data.diskTotal)}</span>
        </div>
        <div className="card">
          <span className="card-label">节点</span>
          <span className="card-value">{nodes.length}</span>
          <span className="card-sub">
            {nodes.reduce((a, n) => a + n.shards, 0)} 个分片副本
            {data.unassignedShards > 0 && ` · ${data.unassignedShards} 个未分配`}
          </span>
        </div>
      </section>

      {data.unassignedShards > 0 && (
        <div className="alert alert-warn">
          有 <b>{data.unassignedShards} 个分片副本</b>没有分配到任何节点
          —— 它们不占磁盘，但也不在备份里。集群缺节点时这个数字会变。
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>节点</th>
              <th>分片</th>
              <th>索引数据</th>
              <th>文档数</th>
              <th>磁盘已用</th>
              <th>磁盘总量</th>
              <th>可用</th>
              <th>使用率</th>
              <th>数据路径</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td>{n.name}</td>
                <td>
                  {n.shards}
                  {n.primaries > 0 && <span className="muted"> ({n.primaries} 主)</span>}
                </td>
                <td>{byteSize(n.indexBytes)}</td>
                <td>{count(n.docs)}</td>
                <td>{byteSize(n.diskUsed)}</td>
                <td>{byteSize(n.diskTotal)}</td>
                <td>{byteSize(n.diskFree)}</td>
                <td>
                  <span className="meter">
                    <span
                      style={{ width: `${Math.min(100, n.diskPercent)}%`, background: meterColor(n.diskPercent) }}
                    />
                    <em>{n.diskPercent.toFixed(1)}%</em>
                  </span>
                </td>
                <td className="mono-small" title={n.dataPath}>
                  {n.dataPath ?? "-"}
                </td>
              </tr>
            ))}
            {data.unassignedShards > 0 && (
              <tr className="storage-unassigned">
                <td>未分配</td>
                <td>{data.unassignedShards}</td>
                <td>-</td>
                <td>-</td>
                <td>-</td>
                <td>-</td>
                <td>-</td>
                <td>-</td>
                <td>-</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>合计</td>
              <td>{nodes.reduce((a, n) => a + n.shards, 0) + data.unassignedShards}</td>
              <td>{byteSize(data.indexBytes)}</td>
              <td>{count(data.docs)}</td>
              <td>{byteSize(data.diskUsed)}</td>
              <td>{byteSize(data.diskTotal)}</td>
              <td>{byteSize(data.diskFree)}</td>
              <td>{data.diskPercent.toFixed(1)}%</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="storage-note">
        「索引数据量」是索引本身的大小（不含副本）；「磁盘已用」是这个节点整个
        数据目录所在磁盘的使用量 —— 里面还有日志、其它程序的文件，所以比索引数据大。
      </div>
    </section>
  );
}
