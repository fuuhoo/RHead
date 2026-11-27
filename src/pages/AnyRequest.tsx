import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, esRequest, esGet, esPost, friendlyError } from "../lib/es";
import { clampTimeout, loadTimeout, saveTimeout } from "../lib/timeout";
import { columnStoreKey } from "../lib/columns";
import { EditorCtx } from "../lib/esDsl";
import {
  DEFAULT_MAX_RESULT_WINDOW,
  FieldMap,
  LintHint,
  buildFieldMap,
  fetchIndexNames,
  indicesFromPath,
  lintRequest,
  matchIndexNames,
} from "../lib/lint";
import QueryEditor from "../components/QueryEditor";
import QueryVisualizer from "../components/QueryVisualizer";
import ResultsTable from "../components/ResultsTable";
import JsonView from "../components/JsonView";
import ExportDialog from "../components/ExportDialog";

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

  /**
   * The mapping of the index the request targets - the smart hints compare
   * the fields in the query against it.
   */
  const [fields, setFields] = useState<FieldMap>({});
  const [indexExists, setIndexExists] = useState(true);
  const [maxResultWindow, setMaxResultWindow] = useState(DEFAULT_MAX_RESULT_WINDOW);
  const [mappingKnown, setMappingKnown] = useState(false);
  const mappingKey = useRef("");
  /** field name -> the values that really occur in the index */
  const [valueHints, setValueHints] = useState<Record<string, string[]>>({});
  const hintsLoading = useRef<string>("");
  /** the index names of the cluster - offered while the path is edited */
  const [indexNames, setIndexNames] = useState<string[]>([]);
  const [pathOpen, setPathOpen] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const targetIndices = useMemo(() => indicesFromPath(path), [path]);
  const targetKey = targetIndices.join(",");

  // the index names, for the path suggestions
  useEffect(() => {
    let alive = true;
    fetchIndexNames(conn).then((names) => {
      if (alive) setIndexNames(names);
    });
    return () => {
      alive = false;
    };
  }, [conn]);

  /** the text the user typed in the path, before the first slash */
  const pathPrefix = useMemo(() => path.split("/")[0] ?? "", [path]);
  const pathSuggestions = useMemo(
    () => matchIndexNames(indexNames, pathPrefix),
    [indexNames, pathPrefix]
  );

  /** the rest of the path, kept when an index is picked from the list */
  const pathSuffix = useCallback(
    () => {
      const slash = path.indexOf("/");
      const rest = slash >= 0 ? path.slice(slash + 1) : "search";
      return `/_${rest}`;
    },
    [path]
  );

  const applyIndex = useCallback(
    (indexName: string) => {
      const slash = path.indexOf("/");
      const rest = slash >= 0 ? path.slice(slash + 1) : "search";
      setPath(`${indexName}/_${rest}`);
      setPathOpen(false);
    },
    [path]
  );

  // fetch the mapping (and the index settings) whenever the target changes
  useEffect(() => {
    const isSearch = /_(search|count|msearch|field_caps)$/.test(path.split("?")[0]);
    if (!targetKey || !isSearch) {
      mappingKey.current = "";
      setFields({});
      setMappingKnown(false);
      return;
    }
    if (mappingKey.current === targetKey) return;
    mappingKey.current = targetKey;
    let alive = true;
    console.log("[lint] fetching mapping for", targetKey, "isSearch", isSearch);

    (async () => {
      const idx = encodeURIComponent(targetKey);
      const [mapRes, setRes, headRes] = await Promise.all([
        esGet(conn, `${idx}/_mapping`),
        esGet(conn, `${idx}/_settings?flat_settings=true&filter_path=*.index.max_result_window`),
        esGet(conn, idx),
      ]);
      if (!alive) return;

      // the mapping call answers 404 when the index does not exist
      const mapOk = mapRes.status < 400 && !!mapRes.json;
      setFields(mapOk ? buildFieldMap(mapRes.json) : {});
      setMappingKnown(!!mapOk);
      setIndexExists(headRes.status < 400);

      const settings = setRes.json ?? {};
      let limit = DEFAULT_MAX_RESULT_WINDOW;
      for (const def of Object.values(settings as any[])) {
        const v = def?.["index.max_result_window"];
        if (v != null) {
          limit = Number(v);
          break;
        }
      }
      setMaxResultWindow(Number.isFinite(limit) ? limit : DEFAULT_MAX_RESULT_WINDOW);
    })().catch(() => {
      if (alive) setMappingKnown(false);
    });

    return () => {
      alive = false;
    };
  }, [conn, path, targetKey]);

  // the hints are recomputed on every keystroke
  const hints = useMemo(
    () =>
      lintRequest(body, path, {
        fields,
        indices: targetIndices,
        indexExists,
        maxResultWindow,
        mappingKnown,
      }),
    [body, path, fields, targetIndices, indexExists, maxResultWindow, mappingKnown]
  );

  /** the fields of the target index, in the shape the editor wants */
  const editorFields = useMemo(
    () => Object.entries(fields).map(([name, f]) => ({ name, type: f.type })),
    [fields]
  );

  /**
   * Load the values that occur in the index for the field the caret is on.
   *
   * A terms aggregation is used - it reads the doc values and is cheap even
   * on a big index. Text fields have no doc values, so their keyword
   * subfield is used instead.
   */
  const loadFieldValues = useCallback(
    async (field: string) => {
      if (!field || !targetKey) return;
      if (valueHints[field]) return;
      if (hintsLoading.current === field) return;
      hintsLoading.current = field;

      const info = fields[field];
      // a text field cannot be aggregated - use its keyword subfield
      let aggField = field;
      if (info?.type === "text") {
        const kw = `${field}.keyword`;
        if (fields[kw]) aggField = kw;
        else {
          hintsLoading.current = "";
          return;
        }
      }

      try {
        const q = {
          size: 0,
          aggs: { v: { terms: { field: aggField, size: 30 } } },
        };
        const r = await esPost(conn, `${encodeURIComponent(targetKey)}/_search`, q, timeoutSec);
        const buckets = r.json?.aggregations?.v?.buckets;
        if (Array.isArray(buckets) && buckets.length) {
          const vals = buckets.map((b: any) => String(b.key));
          setValueHints((h) => (h[field] ? h : { ...h, [field]: vals }));
        }
      } catch {
        /* the aggregation failed - no values to offer */
      } finally {
        if (hintsLoading.current === field) hintsLoading.current = "";
      }
    },
    [conn, targetKey, fields, valueHints, timeoutSec]
  );

  // the caret context decides which field the values are needed for
  const onEditorContext = useCallback(
    (ctx: EditorCtx) => {
      if (ctx.expecting !== "value" || !ctx.parentKey) return;
      const field = ctx.parentKey;
      if (!fields[field]) return;
      loadFieldValues(field);
    },
    [fields, loadFieldValues]
  );

  const hintCounts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0 };
    for (const h of hints) c[h.level] += 1;
    return c;
  }, [hints]);

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

  /**
   * The export runs a search of its own, so it needs a query body and the
   * indices to run it against. A request that is not a search (a PUT, a
   * _count, ...) cannot be exported.
   */
  const exportable = useMemo(() => {
    if (!out?.hits) return false;
    if (!targetIndices.length) return false;
    try {
      const j = JSON.parse(body);
      if (!j || typeof j !== "object" || Array.isArray(j)) return false;
      return j.query != null || j.aggs != null;
    } catch {
      return false;
    }
  }, [out, targetIndices, body]);

  /** the parsed body, for the export */
  const exportBody = useMemo(() => {
    try {
      const j = JSON.parse(body);
      if (j && typeof j === "object" && !Array.isArray(j)) return j;
      return null;
    } catch {
      return null;
    }
  }, [body]);

  const exportTotal = out?.hits?.total?.value ?? out?.hits?.total ?? 0;

  /** a short description of the query, shown in the export dialog */
  const filterSummary = useMemo(() => {
    if (!exportBody) return "无（全部文档）";
    const parts: string[] = [];
    const q = exportBody.query;
    if (q) {
      const kind = Object.keys(q)[0] ?? "";
      parts.push(`query: ${kind}`);
    }
    if (exportBody.aggs) {
      parts.push(`聚合: ${Object.keys(exportBody.aggs).join(", ")}`);
    }
    if (exportBody.sort) {
      parts.push("排序");
    }
    return parts.length ? parts.join("，") : "无（全部文档）";
  }, [exportBody]);

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
          <div className="path-field">
            <input
              className="input input-grow"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onFocus={() => setPathOpen(true)}
              onBlur={() => setTimeout(() => setPathOpen(false), 150)}
              placeholder="path，如 _search 或 my-index/_doc/1"
              list="es-common-paths"
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
            {pathOpen && pathSuggestions.length > 0 && (
              <ul className="path-suggest">
                {pathSuggestions.map((n) => (
                  <li key={n}>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyIndex(n);
                      }}
                    >
                      <span className="path-suggest-name">{n}</span>
                      <span className="path-suggest-hint">{pathSuffix()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
          fields={editorFields}
          valueHints={valueHints}
          onContextChange={onEditorContext}
          height={220}
          label="请求体 JSON（Ctrl+Enter 提交）"
          onSubmit={() => send()}
        />
        <LintPanel
          hints={hints}
          errorCount={hintCounts.error}
          warnCount={hintCounts.warn}
          infoCount={hintCounts.info}
          onApply={(patch) => {
            try {
              setBody(JSON.stringify(patch, null, 2));
            } catch (e: any) {
              setError(e.message);
            }
          }}
        />
        {vizBody && (
          <details className="viz-details">
            <summary>查询结构可视化</summary>
            <QueryVisualizer body={vizBody} compact />
          </details>
        )}
        <details className="filter-section transformer-section">
          <summary className="transformer-summary">结果转换器 <code>function(root, prev) {"{"}</code></summary>
          <textarea className="code-editor" rows={3} value={transform} onChange={(e) => setTransform(e.target.value)} spellCheck={false} />
          <code>{"}"}</code>
        </details>
        {error && <div className="alert alert-error">{error}</div>}
        {out != null && (
          <div className="any-out">
            {stats.length > 0 && (
              <div className="result-meta">
                {stats.map((s) => (
                  <span key={s.label} className="result-chip">{s.label} <b>{s.value}</b></span>
                ))}
                {exportable && (
                  <button
                    className="btn btn-xs result-export"
                    title="导出符合当前请求的全部命中文档（Rust 侧流式写盘，内存恒定）"
                    onClick={() => setShowExport(true)}
                  >
                    ⬇ 导出命中数据
                  </button>
                )}
              </div>
            )}
            {hits ? (
              <ResultsTable
                hits={hits}
                total={out.hits?.total?.value ?? out.hits?.total}
                scroll
                storeKey={columnStoreKey(conn.baseUrl, conn.username, path)}
              />
            ) : null}
            {/* the raw JSON and the table would fight over the space, so the
                table wins when both are switched on */}
            {asJson && !hits && <JsonView data={out} title="响应" />}
          </div>
        )}
      </main>
      {showExport && exportBody && (
        <ExportDialog
          baseUrl={conn.baseUrl}
          username={conn.username}
          password={conn.password}
          indices={targetIndices}
          body={exportBody}
          fields={editorFields}
          filterSummary={filterSummary}
          total={Number(exportTotal) || 0}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}

const LEVEL_LABEL: Record<string, string> = {
  error: "错误",
  warn: "警告",
  info: "提示",
};

const LEVEL_GLYPH: Record<string, string> = {
  error: "⛔",
  warn: "⚠",
  info: "💡",
};

/**
 * The smart hints for the request being written.
 *
 * They show up while typing, so the panel stays collapsed when there is
 * nothing to say and opens itself when something is wrong.
 */
function LintPanel({
  hints,
  errorCount,
  warnCount,
  infoCount,
  onApply,
}: {
  hints: LintHint[];
  errorCount: number;
  warnCount: number;
  infoCount: number;
  onApply: (body: any) => void;
}) {
  const total = hints.length;
  const [open, setOpen] = useState(false);

  // open by itself when something is wrong, but never fight the user
  useEffect(() => {
    if (errorCount > 0) setOpen(true);
    else if (warnCount > 0) setOpen(true);
    else if (total === 0) setOpen(false);
  }, [errorCount, warnCount, total]);

  if (!total) {
    return (
      <div className="lint-panel lint-ok">
        <span className="lint-ok-glyph">✓</span>
        <span>没有发现问题</span>
      </div>
    );
  }

  const level = errorCount ? "error" : warnCount ? "warn" : "info";

  return (
    <div className={`lint-panel lint-${level}`}>
      <div className="lint-head">
        <button
          className="lint-toggle"
          onClick={() => setOpen((o) => !o)}
          title={open ? "收起" : "展开"}
        >
          <span className="lint-caret">{open ? "▾" : "▸"}</span>
          <span className="lint-badge lint-badge-error">{errorCount}</span>
          <span className="lint-badge lint-badge-warn">{warnCount}</span>
          <span className="lint-badge lint-badge-info">{infoCount}</span>
          <span className="lint-title">
            {errorCount ? "有错误" : warnCount ? "有警告" : "建议"}
          </span>
        </button>
      </div>

      {open && (
        <ul className="lint-list">
          {hints.map((h, i) => (
            <li key={i} className={`lint-item lint-item-${h.level}`}>
              <span className="lint-glyph">{LEVEL_GLYPH[h.level]}</span>
              <div className="lint-body">
                <div className="lint-item-title">
                  <span className="lint-text">{h.title}</span>
                  <span className="lint-level">{LEVEL_LABEL[h.level]}</span>
                  {h.at && <code className="lint-at">{h.at}</code>}
                  {h.fix && (
                    <button className="btn btn-xs lint-fix" onClick={() => onApply(h.fix!.body)}>
                      {h.fix.label}
                    </button>
                  )}
                </div>
                {h.detail && <div className="lint-detail">{h.detail}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
