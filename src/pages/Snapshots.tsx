import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, esGet, friendlyError } from "../lib/es";
import { byteSize } from "../lib/format";
import {
  CreateSnapshotOptions,
  EsRepo,
  EsSlmPolicy,
  EsSnapshot,
  REPO_TYPES,
  SlmPolicyPayload,
  cleanupSnapshots,
  createSnapshot,
  deleteRepository,
  deleteSlmPolicy,
  deleteSnapshot,
  fetchRepositories,
  fetchSlmPolicies,
  fetchSlmStatus,
  fetchSnapshotDetail,
  putRepository,
  putSlmPolicy,
  repoLocation,
  repoPathKey,
  repoSettingsFor,
  snapshotErrorText,
  startSlm,
  stopSlm,
  translateSnapshotError,
  verifySnapshot,
} from "../lib/snapshot";
import Drawer from "../components/Drawer";
import Modal from "../components/Modal";

type Tab = "repos" | "snaps" | "slm";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "repos", label: "仓库", icon: "🗄" },
  { id: "snaps", label: "快照", icon: "📸" },
  { id: "slm", label: "生命周期策略", icon: "⏰" },
];

/** One row of the snapshot table - a snapshot plus the repository it lives in. */
interface SnapRow {
  repo: string;
  snap: EsSnapshot;
}

export default function Snapshots({ conn }: { conn: Connection }) {
  const [tab, setTab] = useState<Tab>("repos");
  const [repos, setRepos] = useState<Record<string, EsRepo>>({});
  const [policies, setPolicies] = useState<Record<string, EsSlmPolicy>>({});
  const [slmMode, setSlmMode] = useState<string | null>(null);
  const [esMajor, setEsMajor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [r, p, mode] = await Promise.all([
        fetchRepositories(conn),
        fetchSlmPolicies(conn),
        fetchSlmStatus(conn),
      ]);
      setRepos(r);
      setPolicies(p);
      setSlmMode(mode);
    } catch (e: any) {
      setError(friendlyError(e, conn));
    } finally {
      setLoading(false);
    }
  }, [conn]);

  useEffect(() => {
    reload();
  }, [reload]);

  // the fs repository setting was renamed between ES 7 and 8
  useEffect(() => {
    let alive = true;
    esGet(conn, "/").then((r) => {
      const num = r.json?.version?.number;
      const major = typeof num === "string" ? parseInt(num.split(".")[0], 10) : NaN;
      if (alive && !Number.isNaN(major)) setEsMajor(major);
    });
    return () => {
      alive = false;
    };
  }, [conn]);

  const repoList = useMemo(() => Object.keys(repos).sort(), [repos]);

  const snapRows = useMemo<SnapRow[]>(() => {
    const rows: SnapRow[] = [];
    for (const [repo, r] of Object.entries(repos)) {
      for (const s of r.snapshots ?? []) rows.push({ repo, snap: s });
    }
    rows.sort((a, b) => (b.snap.start_time_in_millis ?? 0) - (a.snap.start_time_in_millis ?? 0));
    return rows;
  }, [repos]);

  async function toggleSlm(pause: boolean) {
    setError("");
    try {
      const r = pause ? await stopSlm(conn) : await startSlm(conn);
      if (r.status < 300) {
        setMsg(pause ? "SLM 调度已暂停" : "SLM 调度已启动");
        reload();
      } else {
        setError(translateSnapshotError(snapshotErrorText(r)));
      }
    } catch (e: any) {
      setError(friendlyError(e, conn));
    }
  }

  return (
    <div className="page">
      <div className="page-toolbar">
        <h2>快照管理</h2>
        <div className="toolbar-actions">
          {slmMode && (
            <span className="muted" title="快照生命周期管理的调度器状态">
              SLM <b>{slmMode === "RUNNING" ? "运行中" : slmMode === "STOPPED" ? "已停止" : slmMode}</b>
            </span>
          )}
          <button className="btn" onClick={reload} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error snap-error">{error}</div>}
      {msg && <div className="alert alert-ok">{msg}</div>}

      <div className="mode-seg sec-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} role="tab">
            {t.label}
            <span className="sec-tab-count">
              {t.id === "repos" ? repoList.length : t.id === "snaps" ? snapRows.length : Object.keys(policies).length}
            </span>
          </button>
        ))}
      </div>

      {tab === "repos" && (
        <ReposTab
          conn={conn}
          repos={repos}
          esMajor={esMajor}
          reload={reload}
          setMsg={setMsg}
          setError={setError}
        />
      )}
      {tab === "snaps" && (
        <SnapshotsTab
          conn={conn}
          repos={repos}
          rows={snapRows}
          reload={reload}
          setMsg={setMsg}
          setError={setError}
        />
      )}
      {tab === "slm" && (
        <SlmTab
          conn={conn}
          policies={policies}
          repos={repos}
          slmMode={slmMode}
          onToggle={toggleSlm}
          reload={reload}
          setMsg={setMsg}
          setError={setError}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

function ReposTab({
  conn,
  repos,
  esMajor,
  reload,
  setMsg,
  setError,
}: {
  conn: Connection;
  repos: Record<string, EsRepo>;
  esMajor: number | null;
  reload: () => Promise<void>;
  setMsg: (s: string) => void;
  setError: (s: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useMemo(() => Object.keys(repos).sort(), [repos]);

  async function remove(name: string) {
    if (!window.confirm(`确定注销仓库「${name}」？\n\n仓库里的快照文件不会被删除，但 ES 将不再知道它们的位置。`)) return;
    setError("");
    try {
      const r = await deleteRepository(conn, name);
      if (r.status < 300) {
        setMsg(`仓库 ${name} 已注销`);
        reload();
      } else {
        setError(translateSnapshotError(snapshotErrorText(r)));
      }
    } catch (e: any) {
      setError(friendlyError(e, conn));
    }
  }

  return (
    <>
      <div className="h3-row">
        <h3>快照仓库 ({list.length})</h3>
        <button className="btn btn-xs" onClick={() => setCreating(true)}>＋ 新建仓库</button>
      </div>
      <div className="field-hint" style={{ marginBottom: 8 }}>
        仓库是快照的存放位置。文件系统仓库需要集群在 <code>path.repo</code> 里声明共享目录，
        快照会写到所有主分片所在节点。
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>位置</th>
              <th>快照数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((name) => {
              const r = repos[name];
              return (
                <tr key={name}>
                  <td><b>{name}</b></td>
                  <td><span className="tag">{r.type}</span></td>
                  <td className="sec-rules">
                    <code>{repoLocation(r) || "—"}</code>
                  </td>
                  <td>{(r.snapshots ?? []).length}</td>
                  <td className="sec-actions">
                    <button className="btn btn-xs" onClick={() => setEditing(name)}>编辑</button>
                    <button className="btn btn-xs btn-danger" onClick={() => remove(name)}>注销</button>
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: "center", padding: 20 }}>
                  还没有仓库。点「新建仓库」创建第一个。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <RepoForm
          conn={conn}
          esMajor={esMajor}
          existing={editing ? repos[editing] : null}
          name={editing ?? ""}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={(text) => {
            setCreating(false);
            setEditing(null);
            setMsg(text);
            reload();
          }}
          onError={setError}
        />
      )}
    </>
  );
}

function RepoForm({
  conn,
  esMajor,
  existing,
  name,
  onClose,
  onDone,
  onError,
}: {
  conn: Connection;
  esMajor: number | null;
  existing: EsRepo | null;
  name: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (s: string) => void;
}) {
  const editing = !!existing;
  const [repoName, setRepoName] = useState(name);
  const [type, setType] = useState<string>(existing?.type ?? "fs");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const [k, val] of Object.entries(existing?.settings ?? {})) {
      v[k] = val == null ? "" : String(val);
    }
    return v;
  });
  const [busy, setBusy] = useState(false);

  const spec = REPO_TYPES.find((t) => t.key === type);
  const pathKey = repoPathKey(type, esMajor);
  const settingKeys = repoSettingsFor(type, pathKey);

  // when the type changes, keep only the settings that still apply
  function changeType(next: string) {
    const nextPathKey = repoPathKey(next, esMajor);
    const nextKeys = repoSettingsFor(next, nextPathKey);
    const keep: Record<string, string> = {};
    for (const k of nextKeys) {
      if (values[k] !== undefined) keep[k] = values[k];
    }
    setType(next);
    setValues(keep);
  }

  async function save() {
    setBusy(true);
    onError("");
    try {
      const r = await putRepository(conn, repoName.trim(), type, values);
      setBusy(false);
      if (r.status < 300) {
        onDone(editing ? `仓库 ${repoName} 已更新` : `仓库 ${repoName} 已创建`);
      } else {
        onError(translateSnapshotError(snapshotErrorText(r)));
      }
    } catch (e: any) {
      setBusy(false);
      onError(friendlyError(e, conn));
    }
  }

  const nameInvalid = !repoName.trim();

  return (
    <Modal title={editing ? `编辑仓库 ${name}` : "新建快照仓库"} onClose={onClose} width={620}>
      <label>
        仓库名称
        <input
          className="input"
          autoFocus
          value={repoName}
          disabled={editing}
          onChange={(e) => setRepoName(e.target.value)}
          placeholder="如 backup"
        />
      </label>

      <label>
        类型
        <select className="input" value={type} onChange={(e) => changeType(e.target.value)} disabled={editing}>
          {REPO_TYPES.map((t) => (
            <option key={t.key} value={t.key}>{t.label}</option>
          ))}
        </select>
        {spec && <span className="field-hint">{spec.hint}</span>}
      </label>

      <div className="sec-field">
        <div className="sec-field-head"><span>配置</span></div>
        {(settingKeys).map((key) => {
          const label = settingLabel(key);
          const isSecret = key === "secret_key" || key === "client_secret";
          return (
            <label key={key}>
              {label}
              <input
                className="input"
                type={isSecret ? "password" : "text"}
                value={values[key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                placeholder={settingPlaceholder(key, type, pathKey)}
              />
            </label>
          );
        })}
        {type === "fs" && (
          <div className="field-hint">
            目录必须是<b>所有节点</b>都能访问的同一份共享存储。目录需要在
            <code> elasticsearch.yml</code> 的 <code>path.repo</code> 中声明并重启节点，
            否则创建仓库会失败。
          </div>
        )}
      </div>

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || nameInvalid}>
          {busy ? "保存中…" : editing ? "保存" : "创建"}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}

function settingLabel(key: string): string {
  const map: Record<string, string> = {
    location: "目录 (location)",
    path: "目录 (path)",
    url: "URL",
    compress: "压缩 (true/false)",
    chunk_size: "分块大小",
    max_restore_bytes_per_sec: "恢复限速",
    max_snapshot_bytes_per_sec: "快照限速",
    bucket: "桶 (bucket)",
    container: "容器 (container)",
    region: "区域 (region)",
    base_path: "基础路径",
    endpoint: "接入点 (endpoint)",
    protocol: "协议 (http/https)",
    access_key: "Access Key",
    secret_key: "Secret Key",
    client_id: "Client ID",
    client_secret: "Client Secret",
  };
  return map[key] ?? key;
}

function settingPlaceholder(key: string, type: string, pathKey: string): string {
  if (key === pathKey) return type === "url" ? "http://host/snapshots/" : "/data/es-backup";
  if (key === "compress") return "true";
  if (key === "chunk_size") return "1gb";
  if (key === "bucket") return "my-backups";
  if (key === "region") return "us-east-1";
  return "";
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function SnapshotsTab({
  conn,
  repos,
  rows,
  reload,
  setMsg,
  setError,
}: {
  conn: Connection;
  repos: Record<string, EsRepo>;
  rows: SnapRow[];
  reload: () => Promise<void>;
  setMsg: (s: string) => void;
  setError: (s: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<SnapRow | null>(null);
  const [cleanupFor, setCleanupFor] = useState<{ repo: string; count: number } | null>(null);
  const repoList = useMemo(() => Object.keys(repos).sort(), [repos]);

  const repoCount = (repo: string) => (repos[repo]?.snapshots ?? []).length;

  async function remove(repo: string, snap: string) {
    if (!window.confirm(`确定删除快照「${snap}」？\n\n仓库里的数据文件会被一并删除，无法恢复。`)) return;
    setError("");
    try {
      const r = await deleteSnapshot(conn, repo, snap);
      if (r.status < 300) {
        setMsg(`快照 ${snap} 已删除`);
        reload();
      } else {
        setError(translateSnapshotError(snapshotErrorText(r)));
      }
    } catch (e: any) {
      setError(friendlyError(e, conn));
    }
  }

  async function verify(repo: string, snap: string) {
    setError("");
    setMsg("");
    try {
      const r = await verifySnapshot(conn, repo, snap);
      if (r.status < 300) {
        if (r.wholeRepo) {
          // older clusters cannot verify a single snapshot - the whole
          // repository was checked instead
          const nodes = Object.keys(r.json?.nodes ?? {}).length;
          setMsg(`快照 ${snap} 校验通过（该集群版本只支持整仓库校验，${nodes} 个节点参与）`);
        } else {
          const list = r.json?.snapshots ?? [];
          const idx = (list[0]?.indices ?? {}) as Record<string, any>;
          const shards = Object.values(idx).reduce((n: number, v: any) => n + (v?.shard_count ?? 0), 0);
          setMsg(`快照 ${snap} 校验通过：${Object.keys(idx).length} 个索引，${shards} 个分片`);
        }
      } else {
        setError(translateSnapshotError(snapshotErrorText(r)));
      }
    } catch (e: any) {
      setError(friendlyError(e, conn));
    }
  }

  async function cleanup(repo: string, opts: { keep?: number; deleteOlderThan?: string }) {
    setError("");
    try {
      const r = await cleanupSnapshots(conn, repo, opts);
      if (r.status < 300) {
        const results = r.json?.results ?? [];
        const deleted = results.reduce((n: number, x: any) => n + (x?.deleted?.length ?? 0), 0);
        setMsg(`清理完成，删除了 ${deleted} 个快照`);
        reload();
      } else {
        setError(translateSnapshotError(snapshotErrorText(r)));
      }
    } catch (e: any) {
      setError(friendlyError(e, conn));
    }
  }

  return (
    <>
      <div className="h3-row">
        <h3>快照 ({rows.length})</h3>
        <button className="btn btn-xs" onClick={() => setCreating(true)} disabled={!repoList.length}>
          ＋ 新建快照
        </button>
      </div>
      {!repoList.length && (
        <div className="alert alert-info">
          还没有可用的仓库。请先到「仓库」页创建一个。
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>快照名</th>
              <th>仓库</th>
              <th>状态</th>
              <th>索引</th>
              <th>分片</th>
              <th>开始时间</th>
              <th>耗时</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ repo, snap }) => (
              <tr key={`${repo}/${snap.snapshot}`}>
                <td>
                  <b>{snap.snapshot}</b>
                </td>
                <td><span className="tag">{repo}</span></td>
                <td>
                  <span className={`tag ${snap.state === "SUCCESS" ? "tag-ok" : snap.state === "PARTIAL" ? "tag-warn" : "tag-off"}`}>
                    {snap.state ?? "—"}
                  </span>
                </td>
                <td>{(snap.indices ?? []).length}</td>
                <td>
                  {snap.shards?.successful ?? "—"}
                  {snap.shards?.failed ? ` / ${snap.shards.total}` : ""}
                </td>
                <td>{snap.start_time ? new Date(snap.start_time).toLocaleString("zh-CN") : "—"}</td>
                <td>{snap.duration_in_millis ? `${(snap.duration_in_millis / 1000).toFixed(1)}s` : "—"}</td>
                <td className="sec-actions">
                  <button className="btn btn-xs" onClick={() => setDetail({ repo, snap })}>详情</button>
                  <button className="btn btn-xs" onClick={() => verify(repo, snap.snapshot)}>校验</button>
                  <button
                    className="btn btn-xs"
                    onClick={() => setCleanupFor({ repo, count: repoCount(repo) })}
                    title="按保留规则清理这个仓库里的旧快照"
                  >
                    清理
                  </button>
                  <button className="btn btn-xs btn-danger" onClick={() => remove(repo, snap.snapshot)}>删除</button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: "center", padding: 20 }}>
                  {repoList.length ? "还没有快照。点「新建快照」创建第一个。" : "—"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <CreateSnapshotForm
          conn={conn}
          repos={repoList}
          onClose={() => setCreating(false)}
          onDone={(text) => {
            setCreating(false);
            setMsg(text);
            reload();
          }}
          onError={setError}
        />
      )}

      {detail && (
        <SnapshotDetail
          conn={conn}
          repo={detail.repo}
          name={detail.snap.snapshot}
          fallback={detail.snap}
          onClose={() => setDetail(null)}
        />
      )}

      {cleanupFor && (
        <CleanupDialog
          repo={cleanupFor.repo}
          count={cleanupFor.count}
          onClose={() => setCleanupFor(null)}
          onRun={(opts) => {
            setCleanupFor(null);
            cleanup(cleanupFor.repo, opts);
          }}
        />
      )}
    </>
  );
}

/**
 * Delete the snapshots that fall out of a retention rule.
 *
 * The number to keep is asked for instead of being hard coded - a cluster
 * with dozens of daily snapshots would lose all of them to a stray click.
 */
function CleanupDialog({
  repo,
  count,
  onClose,
  onRun,
}: {
  repo: string;
  count: number;
  onClose: () => void;
  onRun: (opts: { keep?: number; deleteOlderThan?: string }) => void;
}) {
  const [keep, setKeep] = useState("5");
  const [olderThan, setOlderThan] = useState("");

  const keepN = keep.trim() ? Number(keep) : 0;
  const willDelete = Math.max(0, count - keepN);

  return (
    <Modal title={`清理仓库 ${repo} 的快照`} onClose={onClose} width={520}>
      <div className="alert alert-warn">
        该仓库现在有 <b>{count}</b> 个快照。清理会<b>永久删除</b>数据文件，无法恢复。
      </div>

      <label>
        只保留最新的 N 个
        <input
          className="input"
          autoFocus
          value={keep}
          onChange={(e) => setKeep(e.target.value)}
          placeholder="如 5"
        />
      </label>

      <label>
        或者删除早于某个时间的快照
        <input
          className="input"
          value={olderThan}
          onChange={(e) => setOlderThan(e.target.value)}
          placeholder="如 30d / 12h（留空则不按时间清理）"
        />
      </label>

      <div className="field-hint">
        {keepN > 0 && willDelete > 0 && (
          <>
            将保留最新 {keepN} 个，<b>删除 {willDelete} 个</b>较旧的快照。
          </>
        )}
        {keepN > 0 && willDelete === 0 && count > 0 && <>当前数量已经满足保留 {keepN} 个的要求。</>}
        {olderThan.trim() && <>另外会删除 {olderThan.trim()} 之前的快照。</>}
      </div>

      <div className="modal-actions">
        <button
          className="btn btn-danger"
          disabled={keepN <= 0 && !olderThan.trim()}
          onClick={() => {
            const opts: { keep?: number; deleteOlderThan?: string } = {};
            if (keepN > 0) opts.keep = keepN;
            if (olderThan.trim()) opts.deleteOlderThan = olderThan.trim();
            onRun(opts);
          }}
        >
          确认清理
        </button>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}

function CreateSnapshotForm({
  conn,
  repos,
  onClose,
  onDone,
  onError,
}: {
  conn: Connection;
  repos: string[];
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (s: string) => void;
}) {
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [name, setName] = useState(defaultSnapshotName());
  const [indices, setIndices] = useState("*");
  const [includeGlobalState, setIncludeGlobalState] = useState(true);
  const [ignoreUnavailable, setIgnoreUnavailable] = useState(true);
  const [partial, setPartial] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    onError("");
    const opts: CreateSnapshotOptions = {
      indices,
      includeGlobalState,
      ignoreUnavailable,
      partial,
    };
    try {
      const r = await createSnapshot(conn, repo, name.trim(), opts);
      setBusy(false);
      if (r.status < 300) {
        onDone(`快照 ${name} 已开始创建，完成后刷新列表`);
      } else {
        onError(translateSnapshotError(snapshotErrorText(r)));
      }
    } catch (e: any) {
      setBusy(false);
      onError(friendlyError(e, conn));
    }
  }

  return (
    <Modal title="新建快照" onClose={onClose} width={600}>
      <label>
        仓库
        <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)}>
          {repos.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </label>

      <label>
        快照名
        <input
          className="input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如 daily-20261127"
        />
        <span className="field-hint">名字在同一个仓库里必须唯一。</span>
      </label>

      <label>
        索引范围
        <textarea
          className="input code-editor"
          rows={3}
          value={indices}
          onChange={(e) => setIndices(e.target.value)}
          placeholder="* 或 logs-*,metrics-*"
        />
        <span className="field-hint">
          逗号或换行分隔，支持通配符。留空表示全部索引。
        </span>
      </label>

      <label className="builder-toggle" style={{ marginLeft: 0 }}>
        <input type="checkbox" checked={includeGlobalState} onChange={(e) => setIncludeGlobalState(e.target.checked)} />
        包含全局状态（集群设置、索引模板等）
      </label>
      <label className="builder-toggle" style={{ marginLeft: 0 }}>
        <input type="checkbox" checked={ignoreUnavailable} onChange={(e) => setIgnoreUnavailable(e.target.checked)} />
        忽略不可用索引
      </label>
      <label className="builder-toggle" style={{ marginLeft: 0 }}>
        <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
        允许部分成功（partial）
      </label>

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim() || !repo}>
          {busy ? "提交中…" : "创建"}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}

function defaultSnapshotName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `snap-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function SnapshotDetail({
  conn,
  repo,
  name,
  fallback,
  onClose,
}: {
  conn: Connection;
  repo: string;
  name: string;
  fallback: EsSnapshot;
  onClose: () => void;
}) {
  const [snap, setSnap] = useState<EsSnapshot>(fallback);

  useEffect(() => {
    let alive = true;
    fetchSnapshotDetail(conn, repo, name).then((s) => {
      if (alive && s) setSnap(s);
    });
    return () => {
      alive = false;
    };
  }, [conn, repo, name]);

  const size = (snap as any)?.size_in_bytes;

  return (
    <Drawer title={`快照 ${name}`} onClose={onClose} width={680}>
      <div className="kv-list">
        <div className="kv"><span>仓库</span><b>{repo}</b></div>
        <div className="kv"><span>状态</span><b>{snap.state ?? "—"}</b></div>
        <div className="kv"><span>UUID</span><b className="snap-uuid">{snap.uuid ?? "—"}</b></div>
        <div className="kv"><span>ES 版本</span><b>{snap.version ?? "—"}</b></div>
        <div className="kv"><span>开始时间</span><b>{snap.start_time ? new Date(snap.start_time).toLocaleString("zh-CN") : "—"}</b></div>
        <div className="kv"><span>结束时间</span><b>{snap.end_time ? new Date(snap.end_time).toLocaleString("zh-CN") : "—"}</b></div>
        <div className="kv"><span>耗时</span><b>{snap.duration_in_millis ? `${(snap.duration_in_millis / 1000).toFixed(1)} 秒` : "—"}</b></div>
        <div className="kv"><span>分片</span><b>{snap.shards?.successful ?? "—"}/{snap.shards?.total ?? "—"}</b></div>
        {size != null && <div className="kv"><span>大小</span><b>{byteSize(size)}</b></div>}
        <div className="kv"><span>包含全局状态</span><b>{snap.include_global_state ? "是" : "否"}</b></div>
      </div>

      <div className="sec-priv-list">
        <h4>索引 ({snap.indices?.length ?? 0})</h4>
        <div className="sec-role-picker">
          {(snap.indices ?? []).map((i) => (
            <span className="tag" key={i}>{i}</span>
          ))}
          {!snap.indices?.length && <span className="muted">—</span>}
        </div>
      </div>

      {!!snap.failures?.length && (
        <div className="sec-priv-list">
          <h4>失败 ({snap.failures.length})</h4>
          <pre className="code-editor">{JSON.stringify(snap.failures, null, 2)}</pre>
        </div>
      )}

      <div className="sec-priv-list">
        <h4>原始信息</h4>
        <pre className="code-editor">{JSON.stringify(snap, null, 2)}</pre>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Snapshot lifecycle management
// ---------------------------------------------------------------------------

function SlmTab({
  conn,
  policies,
  repos,
  slmMode,
  onToggle,
  reload,
  setMsg,
  setError,
}: {
  conn: Connection;
  policies: Record<string, EsSlmPolicy>;
  repos: Record<string, EsRepo>;
  slmMode: string | null;
  onToggle: (pause: boolean) => void;
  reload: () => Promise<void>;
  setMsg: (s: string) => void;
  setError: (s: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useMemo(() => Object.keys(policies).sort(), [policies]);
  const repoList = useMemo(() => Object.keys(repos).sort(), [repos]);

  async function remove(id: string) {
    if (!window.confirm(`确定删除策略「${id}」？已创建的快照不会被删除。`)) return;
    setError("");
    try {
      const r = await deleteSlmPolicy(conn, id);
      if (r.status < 300) {
        setMsg(`策略 ${id} 已删除`);
        reload();
      } else {
        setError(translateSnapshotError(snapshotErrorText(r)));
      }
    } catch (e: any) {
      setError(friendlyError(e, conn));
    }
  }

  return (
    <>
      <div className="h3-row">
        <h3>生命周期策略 ({list.length})</h3>
        <button className="btn btn-xs" onClick={() => setCreating(true)} disabled={!repoList.length}>
          ＋ 新建策略
        </button>
        {slmMode && (
          <button
            className="btn btn-xs"
            onClick={() => onToggle(slmMode === "RUNNING")}
            title={slmMode === "RUNNING" ? "暂停后不再自动执行快照" : "恢复自动快照"}
          >
            {slmMode === "RUNNING" ? "暂停调度" : "启动调度"}
          </button>
        )}
      </div>
      <div className="field-hint" style={{ marginBottom: 8 }}>
        策略让 ES 按 cron 表达式自动创建快照，并按保留规则清理旧的。
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>策略 ID</th>
              <th>名称</th>
              <th>仓库</th>
              <th>调度</th>
              <th>保留</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((id) => {
              const p = policies[id];
              const body = p.policy ?? p;
              const ret = body.retention ?? {};
              return (
                <tr key={id}>
                  <td><b>{id}</b></td>
                  <td>{body.name ?? "—"}</td>
                  <td><span className="tag">{body.repository ?? "—"}</span></td>
                  <td className="sec-rules"><code>{body.schedule ?? "—"}</code></td>
                  <td>
                    {ret.expire_after ? `保留 ${ret.expire_after}` : ""}
                    {ret.max_count ? ` 最多 ${ret.max_count} 个` : ""}
                    {ret.min_count ? ` 最少 ${ret.min_count} 个` : ""}
                    {!ret.expire_after && !ret.max_count && !ret.min_count ? "—" : ""}
                  </td>
                  <td className="sec-actions">
                    <button className="btn btn-xs" onClick={() => setEditing(id)}>编辑</button>
                    <button className="btn btn-xs btn-danger" onClick={() => remove(id)}>删除</button>
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: "center", padding: 20 }}>
                  还没有策略
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <SlmForm
          conn={conn}
          repos={repoList}
          existing={editing ? policies[editing] : null}
          id={editing ?? ""}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={(text) => {
            setCreating(false);
            setEditing(null);
            setMsg(text);
            reload();
          }}
          onError={setError}
        />
      )}
    </>
  );
}

function SlmForm({
  conn,
  repos,
  existing,
  id,
  onClose,
  onDone,
  onError,
}: {
  conn: Connection;
  repos: string[];
  existing: EsSlmPolicy | null;
  id: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (s: string) => void;
}) {
  const editing = !!existing;
  const body = existing?.policy ?? existing ?? {};
  const cfg = (body as any).config ?? {};
  const ret = (body as any).retention ?? {};

  const [policyId, setPolicyId] = useState(id);
  const [name, setName] = useState((body as any).name ?? "");
  const [repository, setRepository] = useState((body as any).repository ?? repos[0] ?? "");
  const [schedule, setSchedule] = useState((body as any).schedule ?? "0 30 1 * * ?");
  const [indices, setIndices] = useState(Array.isArray(cfg.indices) ? cfg.indices.join(",") : (cfg.indices ?? "*"));
  const [includeGlobalState, setIncludeGlobalState] = useState(cfg.include_global_state ?? true);
  const [ignoreUnavailable, setIgnoreUnavailable] = useState(cfg.ignore_unavailable ?? true);
  const [partial, setPartial] = useState(cfg.partial ?? false);
  const [expireAfter, setExpireAfter] = useState(ret.expire_after ?? "");
  const [minCount, setMinCount] = useState(ret.min_count != null ? String(ret.min_count) : "");
  const [maxCount, setMaxCount] = useState(ret.max_count != null ? String(ret.max_count) : "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    onError("");
    const payload: SlmPolicyPayload = {
      name,
      repository,
      schedule,
      indices,
      includeGlobalState,
      ignoreUnavailable,
      partial,
      expireAfter,
      minCount: minCount.trim() ? Number(minCount) : undefined,
      maxCount: maxCount.trim() ? Number(maxCount) : undefined,
    };
    try {
      const r = await putSlmPolicy(conn, policyId.trim(), payload);
      setBusy(false);
      if (r.status < 300) {
        onDone(editing ? `策略 ${policyId} 已更新` : `策略 ${policyId} 已创建`);
      } else {
        onError(translateSnapshotError(snapshotErrorText(r)));
      }
    } catch (e: any) {
      setBusy(false);
      onError(friendlyError(e, conn));
    }
  }

  return (
    <Modal title={editing ? `编辑策略 ${id}` : "新建生命周期策略"} onClose={onClose} width={620}>
      <label>
        策略 ID
        <input
          className="input"
          autoFocus
          value={policyId}
          disabled={editing}
          onChange={(e) => setPolicyId(e.target.value)}
          placeholder="如 daily-backup"
        />
      </label>

      <label>
        名称
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 每日全量备份" />
      </label>

      <label>
        仓库
        <select className="input" value={repository} onChange={(e) => setRepository(e.target.value)}>
          {repos.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </label>

      <label>
        调度 (cron)
        <input className="input code-editor" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
        <span className="field-hint">
          Quartz 风格 6 位表达式：秒 分 时 日 月 周。默认每天凌晨 1:30。
        </span>
      </label>

      <label>
        索引范围
        <input
          className="input"
          value={indices}
          onChange={(e) => setIndices(e.target.value)}
          placeholder="* 或 logs-*,metrics-*"
        />
      </label>

      <div className="sec-field">
        <div className="sec-field-head"><span>保留规则</span></div>
        <label>
          保留时长
          <input className="input" value={expireAfter} onChange={(e) => setExpireAfter(e.target.value)} placeholder="如 7d / 30d / 12h" />
        </label>
        <label>
          最少保留个数
          <input className="input" value={minCount} onChange={(e) => setMinCount(e.target.value)} placeholder="如 1" />
        </label>
        <label>
          最多保留个数
          <input className="input" value={maxCount} onChange={(e) => setMaxCount(e.target.value)} placeholder="如 20" />
        </label>
      </div>

      <label className="builder-toggle" style={{ marginLeft: 0 }}>
        <input type="checkbox" checked={includeGlobalState} onChange={(e) => setIncludeGlobalState(e.target.checked)} />
        包含全局状态
      </label>
      <label className="builder-toggle" style={{ marginLeft: 0 }}>
        <input type="checkbox" checked={ignoreUnavailable} onChange={(e) => setIgnoreUnavailable(e.target.checked)} />
        忽略不可用索引
      </label>
      <label className="builder-toggle" style={{ marginLeft: 0 }}>
        <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
        允许部分成功
      </label>

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || !policyId.trim() || !repository}>
          {busy ? "保存中…" : editing ? "保存" : "创建"}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}
