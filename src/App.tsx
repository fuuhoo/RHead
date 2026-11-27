import { useEffect, useMemo, useRef, useState } from "react";
import {
  Connection,
  SavedConnection,
  esGet,
  friendlyError,
  hostOf,
  loadConnection,
  loadConnections,
  saveConnection,
  saveConnections,
} from "./lib/es";
import { useCluster } from "./lib/useCluster";
import { healthColor, healthFraction } from "./lib/format";
import { probeSecurityEnabled } from "./lib/security";
import Overview from "./pages/Overview";
import StructuredQuery from "./pages/StructuredQuery";
import AnyRequest from "./pages/AnyRequest";
import Security from "./pages/Security";
import Modal from "./components/Modal";

type Page = "overview" | "structured" | "any" | "security";

const NAV: { id: Page; label: string; icon: string; badge?: string }[] = [
  { id: "overview", label: "概览", icon: "◈" },
  { id: "structured", label: "结构化查询", icon: "⌗", badge: "+" },
  { id: "any", label: "复合查询", icon: "⚡", badge: "+" },
  { id: "security", label: "权限管理", icon: "🔑" },
];

type ConnPhase = "idle" | "connecting" | "ok" | "error";
interface ConnStatus {
  phase: ConnPhase;
  text: string;
  latency?: number;
}

export default function App() {
  const [conn, setConn] = useState<Connection | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [structuredIndex, setStructuredIndex] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<Connection>(() => loadConnection());
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState<ConnStatus>({ phase: "idle", text: "" });
  const [saved, setSaved] = useState<SavedConnection[]>(() => loadConnections());
  const [mgrOpen, setMgrOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fName, setFName] = useState("");
  const [fUrl, setFUrl] = useState("");
  const [fUser, setFUser] = useState("");
  const [fPass, setFPass] = useState("");
  const booted = useRef(false);
  const { snap, loading, error: snapError, refresh } = useCluster(conn);
  /**
   * Whether the cluster runs with xpack.security enabled. `null` means it is
   * not known yet (or the cluster cannot be asked) - the permission page then
   * finds out on its own.
   */
  const [securityEnabled, setSecurityEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!conn) {
      setSecurityEnabled(null);
      return;
    }
    let alive = true;
    probeSecurityEnabled(conn).then((v) => {
      if (alive) setSecurityEnabled(v);
    });
    return () => {
      alive = false;
    };
  }, [conn]);

  // auto-connect to last session's connection on startup (guarded for StrictMode)
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const last = loadConnection();
    if (last.baseUrl) connect(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(override?: Connection) {
    const target = override ?? { ...draft, baseUrl: draft.baseUrl.trim() };
    if (override) setDraft(override);
    setConnecting(true);
    const t0 = performance.now();
    setStatus({ phase: "connecting", text: `正在连接 ${target.baseUrl} …` });
    try {
      const r = await esGet(target, "");
      setStatus({ phase: "connecting", text: `已建立连接，正在校验 ES 响应（HTTP ${r.status}）…` });
      if (r.json?.version?.number) {
        saveConnection(target);
        const latency = Math.round(performance.now() - t0);
        setConn(target);
        setStatus({
          phase: "ok",
          latency,
          text: `已连接 · ES ${r.json.version.number} · ${r.json.cluster_name ?? ""} · ${latency}ms`,
        });
      } else {
        setConn(null);
        setStatus({
          phase: "error",
          text: `连接失败：ES 返回了非预期响应（HTTP ${r.status}）${r.raw ? `：${r.raw.slice(0, 200)}` : ""}`,
        });
      }
    } catch (e: any) {
      setConn(null);
      setStatus({ phase: "error", text: friendlyError(e, target) });
    } finally {
      setConnecting(false);
    }
  }

  function disconnect() {
    setConn(null);
    setStatus({ phase: "idle", text: "已断开连接" });
  }

  function openManager() {
    // prefill from the current draft so "save current" is one keystroke away
    setEditingId(null);
    setFName("");
    setFUrl(draft.baseUrl);
    setFUser(draft.username);
    setFPass(draft.password);
    setMgrOpen(true);
  }

  /** Load a saved connection into the form for editing. */
  function startEdit(item: SavedConnection) {
    setEditingId(item.id);
    setFName(item.name);
    setFUrl(item.baseUrl);
    setFUser(item.username);
    setFPass(item.password);
    setStatus({ phase: "idle", text: `正在编辑连接「${item.name}」` });
  }

  function cancelEdit() {
    setEditingId(null);
    setFName("");
    setFUrl(draft.baseUrl);
    setFUser(draft.username);
    setFPass(draft.password);
    setStatus({ phase: "idle", text: "已取消编辑" });
  }

  function saveForm(andConnect: boolean) {
    const base = fUrl.trim();
    if (!/^https?:\/\//i.test(base)) {
      setStatus({ phase: "error", text: "地址需以 http:// 或 https:// 开头，无法保存" });
      return;
    }
    const name = fName.trim() || hostOf(base);
    const user = fUser.trim();

    if (editingId) {
      // Editing an existing entry: update that exact record, never merge into
      // another one — but refuse if the new name/address collides with a
      // different saved connection.
      const target = saved.find((s) => s.id === editingId);
      if (!target) {
        setEditingId(null);
        setStatus({ phase: "error", text: "要编辑的连接已不存在，请重新选择" });
        return;
      }
      const clash = saved.find(
        (s) => s.id !== editingId && (s.name === name || (s.baseUrl === base && s.username === user))
      );
      if (clash) {
        setStatus({
          phase: "error",
          text:
            clash.name === name
              ? `连接名「${name}」已被另一条连接占用`
              : `地址与账号组合已存在于连接「${clash.name}」`,
        });
        return;
      }
      const item: SavedConnection = {
        ...target,
        name,
        baseUrl: base,
        username: user,
        password: fPass,
        savedAt: Date.now(),
      };
      const next = saved.map((s) => (s.id === editingId ? item : s));
      setSaved(next);
      saveConnections(next);
      setEditingId(null);
      setFName("");
      setDraft({ baseUrl: base, username: user, password: fPass });
      setStatus({ phase: "idle", text: `已更新连接「${name}」` });
      if (andConnect) {
        setMgrOpen(false);
        connect(item);
      }
      return;
    }

    const existing =
      saved.find((s) => s.name === name) ??
      saved.find((s) => s.baseUrl === base && s.username === user);
    const item: SavedConnection = existing
      ? { ...existing, name, baseUrl: base, username: user, password: fPass }
      : {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name,
          baseUrl: base,
          username: user,
          password: fPass,
          savedAt: Date.now(),
        };
    const next = existing ? saved.map((s) => (s.id === existing.id ? item : s)) : [...saved, item];
    setSaved(next);
    saveConnections(next);
    setFName("");
    setDraft({ baseUrl: base, username: user, password: fPass });
    setStatus((s) => ({ ...s, phase: "idle", text: `已保存连接「${name}」` }));
    if (andConnect) {
      setMgrOpen(false);
      connect(item);
    }
  }

  function removeSaved(id: string) {
    const next = saved.filter((s) => s.id !== id);
    setSaved(next);
    saveConnections(next);
    if (editingId === id) cancelEdit();
  }

  const health = snap?.clusterHealth;
  const color = healthColor(health?.status);
  const frac = healthFraction(health);
  const mgrActive = (s: SavedConnection) =>
    !!conn && s.baseUrl === conn.baseUrl && s.username === conn.username;

  // display name of the active connection: saved name if known, else its host
  const connName = useMemo(() => {
    if (!conn) return null;
    const match = saved.find((s) => s.baseUrl === conn.baseUrl && s.username === conn.username);
    return match?.name ?? hostOf(conn.baseUrl);
  }, [conn, saved]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <div className="brand">
            <span className="brand-logo">R</span>
            <span className="brand-name">RHead</span>
            <span className="brand-sub">Elasticsearch</span>
          </div>

          <div className="conn-current" title={conn?.baseUrl}>
            <span className="conn-current-label">当前连接</span>
            {status.phase === "connecting" ? (
              <>
                <span className="spinner spinner-dark spinner-sm" />
                <span className="conn-current-name muted">连接中…</span>
              </>
            ) : connName ? (
              <span className="conn-current-name">{connName}</span>
            ) : (
              <span className="conn-current-name conn-current-empty">未连接</span>
            )}
          </div>

          <div className="conn-tools">
            <button
              className="btn"
              onClick={disconnect}
              disabled={!conn || connecting}
              title="断开当前连接"
            >
              断开
            </button>
            <button
              className="btn"
              onClick={openManager}
              title="连接管理：新增 / 连接 / 删除连接"
            >
              管理 <span className="caret">▾</span>
            </button>
          </div>

          <div
            className="cluster-badge"
            title={`ES ${snap?.version ?? "-"} · 数据节点 ${snap?.clusterHealth?.number_of_data_nodes ?? "-"} · 集群 ${snap?.clusterState?.cluster_name ?? "-"}`}
          >
            {status.phase === "connecting" ? (
              <>
                <span className="spinner spinner-dark spinner-sm" />
                <span>{loading ? "连接成功，获取集群信息…" : "连接中…"}</span>
              </>
            ) : conn ? (
              <>
                <span className="dot" style={{ background: color }} />
                <span>{snap?.clusterState?.cluster_name ?? "…"}</span>
                <span className="muted">
                  {loading
                    ? "获取集群信息…"
                    : health
                      ? `${health.status}${frac ? ` (${frac.text})` : ""} · ${health.number_of_data_nodes} 节点 · ${status.latency ?? "-"}ms`
                      : status.text}
                </span>
              </>
            ) : (
              <>
                <span className="dot dot-off" />
                <span>{status.text || "未连接"}</span>
              </>
            )}
          </div>
        </div>

        <nav className="topnav" aria-label="主导航">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-tab ${page === n.id ? "nav-tab-on" : ""}`}
              onClick={() => setPage(n.id)}
              aria-current={page === n.id ? "page" : undefined}
              title={
                n.id === "security" && securityEnabled === false
                  ? "该集群未启用安全功能，用户/角色不可用"
                  : undefined
              }
            >
              <span className="nav-tab-icon">{n.icon}</span>
              <span>{n.label}</span>
              {n.badge && <span className="nav-tab-badge">{n.badge}</span>}
              {n.id === "security" && securityEnabled === false && (
                <span className="nav-tab-warn" aria-label="未启用安全功能">
                  !
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      {status.phase === "connecting" && (
        <div className="alert alert-info conn-alert" role="status">
          <span className="spinner spinner-dark" />
          <span>{status.text}</span>
        </div>
      )}
      {(status.phase === "error" || snapError) && (
        <div className="alert alert-error conn-alert" role="alert">
          <span>{status.phase === "error" ? status.text : snapError}</span>
          <button className="btn btn-xs" onClick={() => (conn ? refresh() : connect())}>
            重试
          </button>
        </div>
      )}

      <div className="shell">
        <main className="content">
          {!conn ? (
            <NotConnected saved={saved} connecting={connecting} onPick={(c) => connect(c)} />
          ) : (
            <>
              {page === "overview" && (
                <Overview
                  conn={conn}
                  snap={snap}
                  loading={loading}
                  onRefresh={refresh}
                  onOpenIndex={(idx) => {
                    setStructuredIndex(idx);
                    setPage("structured");
                  }}
                />
              )}
              {page === "structured" && (
                <StructuredQuery key={structuredIndex ?? "all"} conn={conn} initialIndex={structuredIndex} />
              )}
              {page === "any" && <AnyRequest conn={conn} />}
              {page === "security" && <Security conn={conn} />}
            </>
          )}
        </main>
      </div>

      {mgrOpen && (
        <Modal title={`连接管理（${saved.length} 个）`} onClose={() => setMgrOpen(false)} width={430}>
          <div className="conn-list">
            {saved.map((s) => (
              <div
                key={s.id}
                className={`conn-item ${mgrActive(s) ? "conn-item-active" : ""} ${
                  editingId === s.id ? "conn-item-editing" : ""
                }`}
              >
                <button
                  className="conn-item-main"
                  title={`${s.baseUrl}${s.username ? ` · ${s.username}` : ""}`}
                  onClick={() => {
                    setMgrOpen(false);
                    connect(s);
                  }}
                >
                  <span className="conn-item-name">
                    {s.name} {mgrActive(s) && <span className="badge badge-open">当前</span>}
                    {editingId === s.id && <span className="badge conn-badge-edit">编辑中</span>}
                  </span>
                </button>
                <button
                  className={`conn-item-edit ${editingId === s.id ? "conn-item-edit-on" : ""}`}
                  title={`编辑 ${s.name}`}
                  onClick={() => (editingId === s.id ? cancelEdit() : startEdit(s))}
                >
                  {editingId === s.id ? "✕" : "✎"}
                </button>
                <button
                  className="conn-item-del"
                  title={`删除 ${s.name}`}
                  onClick={() => removeSaved(s.id)}
                >
                  ✕
                </button>
              </div>
            ))}
            {!saved.length && <div className="conn-empty">暂无保存的连接，在下方新增一个</div>}
          </div>
          <div className="conn-form">
            <div className="conn-form-title">
              {editingId ? "编辑连接" : "新增连接"}
              {editingId && (
                <button className="btn btn-xs btn-ghost conn-form-cancel" onClick={cancelEdit}>
                  取消编辑
                </button>
              )}
            </div>
            <input
              className="input"
              placeholder="连接名称（可选，默认用地址）"
              value={fName}
              onChange={(e) => setFName(e.target.value)}
            />
            <input
              className="input"
              placeholder="地址，如 http://172.17.4.28:9200"
              value={fUrl}
              onChange={(e) => setFUrl(e.target.value)}
            />
            <div className="conn-form-row">
              <input
                className="input"
                placeholder="用户名（可选）"
                value={fUser}
                onChange={(e) => setFUser(e.target.value)}
              />
              <input
                className="input"
                type="password"
                placeholder="密码（可选）"
                value={fPass}
                onChange={(e) => setFPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveForm(true)}
              />
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => saveForm(true)} disabled={connecting}>
                {editingId ? "保存修改并连接" : "保存并连接"}
              </button>
              <button className="btn" onClick={() => saveForm(false)} disabled={connecting}>
                {editingId ? "保存修改" : "保存"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NotConnected({
  saved,
  connecting,
  onPick,
}: {
  saved: SavedConnection[];
  connecting: boolean;
  onPick: (c: Connection) => void;
}) {
  return (
    <div className="page">
      <div className="connect-hero">
        <div className="hero-glyph">◌</div>
        <h2>未连接到 Elasticsearch</h2>
        <p>通过右上角「管理 ▾」新增连接，或点击下方已保存的连接。</p>
        {saved.length > 0 && (
          <div className="hero-saved">
            {saved.map((s) => (
              <button
                key={s.id}
                className="chip"
                disabled={connecting}
                onClick={() => onPick(s)}
                title={s.baseUrl}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
