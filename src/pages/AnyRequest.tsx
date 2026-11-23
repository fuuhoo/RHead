import { useEffect, useMemo, useRef, useState } from "react";
import { Connection, esRequest, friendlyError } from "../lib/es";
import { clampTimeout, loadTimeout, saveTimeout } from "../lib/timeout";
import QueryEditor from "../components/QueryEditor";
import QueryVisualizer from "../components/QueryVisualizer";
import ResultsTable from "../components/ResultsTable";
import JsonView from "../components/JsonView";

// Any Request — ports ui/AnyRequest: raw method+path+body, history,
// transformer fn(root, prev), cron repeat, JSON/table display.

interface HistoryItem {
  method: string;
  path: string;
  body: string;
  transform: string;
}

const LS = "rhead-anyrequest-history";

const COMMON_PATHS = [
  "_search",
  "_cat/indices?v",
  "_cluster/health",
  "_cluster/state",
  "_cluster/stats",
  "_nodes",
  "_nodes/stats",
  "_mapping",
  "_stats",
  "_alias",
  "_settings",
  "_tasks?detailed=true&actions=*search",
];

const METHOD_CLASS: Record<string, string> = {
  GET: "m-get",
  POST: "m-post",
  PUT: "m-put",
  DELETE: "m-delete",
  HEAD: "m-head",
};

function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(LS) ?? "[]");
  } catch {
    return [];
  }
}

export default function AnyRequest({ conn }: { conn: Connection }) {
  const [method, setMethod] = useState("POST");
  const [path, setPath] = useState("_search");
  const [body, setBody] = useState(JSON.stringify({ query: { match_all: {} } }, null, 2));
  const [transform, setTransform] = useState("return root;");
  const [pretty, setPretty] = useState(true);
  const [asJson, setAsJson] = useState(true);
  const [asTable, setAsTable] = useState(false);
  const [cron, setCron] = useState(0);
  const [out, setOut] = useState<any>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);
  const [timeoutSec, setTimeoutSec] = useState<number>(() => loadTimeout());
  const timer = useRef<number | null>(null);
  const prevData = useRef<any>(null);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  // remember the timeout across sessions
  useEffect(() => {
    saveTimeout(timeoutSec);
  }, [timeoutSec]);

  const [cronActive, setCronActive] = useState(false);

  function validate(): boolean {
    try {
      const j = JSON.parse(body.trim() || "{}");
      if (pretty) setBody(JSON.stringify(j, null, 2));
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    }
  }

  async function send(fromCron = false) {
    if (!validate()) return;
    if (!fromCron) {
      if (timer.current) window.clearTimeout(timer.current);
      setCronActive(false);
      prevData.current = null;
      const item = { method, path, body, transform };
      setHistory((h) => {
        const next = [...h.filter((x) => JSON.stringify(x) !== JSON.stringify(item)), item].slice(-250);
        localStorage.setItem(LS, JSON.stringify(next));
        return next;
      });
    }
    setError("");
    setSending(true);
    let r;
    try {
      r = await esRequest(conn, method, path, method === "GET" ? undefined : body, timeoutSec);
    } catch (e: any) {
      setSending(false);
      setError(friendlyError(e, conn));
      return;
    }
    setSending(false);
    let data = r.json ?? r.raw;
    try {
      data = new Function("root", "prev", transform)(data, prevData.current);
    } catch (e: any) {
      setError("Transformer error: " + e.message);
      return;
    }
    setOut(data);
    prevData.current = data;
    if (cron > 0) {
      timer.current = window.setTimeout(() => send(true), cron);
      setCronActive(true);
    }
  }

  function stopCron() {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setCronActive(false);
  }

  function removeHistory(i: number) {
    setHistory((h) => {
      const next = h.filter((_, idx) => idx !== i);
      localStorage.setItem(LS, JSON.stringify(next));
      return next;
    });
  }

  const hits = asTable && out?.hits?.hits ? out.hits.hits : null;

  // Visualize the body when it is a search-shaped request
  const vizBody = useMemo(() => {
    try {
      const j = JSON.parse(body);
      if (j && typeof j === "object" && !Array.isArray(j) && (j.query || j.aggs || j.sort)) return j;
      return null;
    } catch {
      return null;
    }
  }, [body]);

  const stats = out?.hits
    ? [
        { label: "命中", value: String(out.hits.total?.value ?? out.hits.total ?? "-") },
        { label: "耗时", value: `${out.took ?? "-"}ms` },
        { label: "分片", value: `${out._shards?.successful ?? "-"}/${out._shards?.total ?? "-"}` },
      ]
    : [];

  return (
    <div className="any-layout page-fill">
      <aside className="any-side">
        <div className="filter-section">
          <div className="section-head">
            <h4>历史记录</h4>
            {history.length > 0 && (
              <button
                className="btn btn-xs btn-ghost"
                onClick={() => {
                  localStorage.removeItem(LS);
                  setHistory([]);
                }}
              >
                清空
              </button>
            )}
          </div>
          <ul className="history-list">
            {history.map((h, i) => (
              <li key={i} className="history-item" onClick={() => {
                setMethod(h.method);
                setPath(h.path);
                setBody(h.body);
                setTransform(h.transform);
              }} title={`${h.method} ${h.path}`}>
                <span className={`method-badge ${METHOD_CLASS[h.method] ?? ""}`}>{h.method}</span>
                <span className="history-path">{h.path}</span>
                <button
                  className="history-del"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeHistory(i);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
            {!history.length && <li className="history-empty">暂无历史</li>}
          </ul>
        </div>
        <div className="filter-section">
          <h4>显示选项</h4>
          <label><input type="checkbox" checked={asJson} onChange={(e) => setAsJson(e.target.checked)} /> 原始 JSON</label>
          <label><input type="checkbox" checked={asTable} onChange={(e) => setAsTable(e.target.checked)} /> 表格视图</label>
          <h4 style={{ marginTop: 12 }}>重复请求</h4>
          <div className="cron-row">
            <select className="input" value={cron} onChange={(e) => setCron(+e.target.value)}>
              <option value={0}>不重复</option>
              <option value={1000}>每秒</option>
              <option value={2000}>每 2 秒</option>
              <option value={5000}>每 5 秒</option>
              <option value={20000}>每 20 秒</option>
              <option value={60000}>每分钟</option>
            </select>
            {cronActive && (
              <button className="btn btn-xs btn-danger" onClick={stopCron} title="停止定时重复">
                ■ 停止
              </button>
            )}
          </div>
          {cronActive && <span className="cron-hint">定时重复进行中…</span>}
        </div>
      </aside>

      <main className="any-main">
        <div className="req-row">
          <select className={`input method-select ${METHOD_CLASS[method] ?? ""}`} value={method} onChange={(e) => setMethod(e.target.value)}>
            {["POST", "GET", "PUT", "DELETE", "HEAD"].map((m) => <option key={m}>{m}</option>)}
          </select>
          <input
            className="input input-grow"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="path，如 _search 或 my-index/_doc/1"
            list="es-common-paths"
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <datalist id="es-common-paths">
            {COMMON_PATHS.map((p) => <option key={p} value={p} />)}
          </datalist>
          <button className="btn btn-primary" onClick={() => send()} disabled={sending}>
            {sending ? <span className="spinner" /> : null}
            {sending ? "请求中…" : "提交请求"}
          </button>
          <button className="btn btn-ghost" onClick={validate}>验证 JSON</button>
          <label className="timeout-field" title="单次请求的最大等待时间（秒），1-600">
            <span className="toolbar-sentence">超时:</span>
            <input
              className="input input-sm timeout-input"
              type="number"
              min={1}
              max={600}
              step={1}
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(clampTimeout(e.target.value))}
              onBlur={(e) => setTimeoutSec(clampTimeout(e.target.value))}
            />
            <span className="toolbar-sentence">秒</span>
          </label>
          <label><input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> 易读</label>
        </div>
        <QueryEditor
          value={body}
          onChange={setBody}
          height={220}
          label="请求体 JSON（Ctrl+Enter 提交）"
          onSubmit={() => send()}
        />
        {vizBody && (
          <details className="viz-details" open>
            <summary>查询结构可视化</summary>
            <QueryVisualizer body={vizBody} compact />
          </details>
        )}
        <div className="filter-section">
          <h4>结果转换器 <code>function(root, prev) {"{"}</code></h4>
          <textarea className="code-editor" rows={3} value={transform} onChange={(e) => setTransform(e.target.value)} spellCheck={false} />
          <code>{"}"}</code>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {out != null && (
          <div className="any-out">
            {stats.length > 0 && (
              <div className="result-meta">
                {stats.map((s) => (
                  <span key={s.label} className="result-chip">{s.label} <b>{s.value}</b></span>
                ))}
              </div>
            )}
            {hits ? <ResultsTable hits={hits} total={out.hits?.total?.value ?? out.hits?.total} scroll /> : null}
            {/* the raw JSON and the table would fight over the space, so the
                table wins when both are switched on */}
            {asJson && !hits && <JsonView data={out} title="响应" />}
          </div>
        )}
      </main>
    </div>
  );
}
