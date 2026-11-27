import { useEffect, useMemo, useRef, useState } from "react";
import { Connection, errorText, esGet, esPost, friendlyError } from "../lib/es";
import { parseMappingResponse } from "../lib/format";
import { clampTimeout, loadTimeout, saveTimeout } from "../lib/timeout";
import { columnStoreKey } from "../lib/columns";
import { buildDSL, Clause, newClause, SearchState } from "../lib/queryBuilder";
import QueryEditor from "../components/QueryEditor";
import QueryVisualizer from "../components/QueryVisualizer";
import ResultsTable, { Hit } from "../components/ResultsTable";
import JsonView from "../components/JsonView";
import Drawer from "../components/Drawer";
import ExportDialog from "../components/ExportDialog";

// Structured Query — head-style query builder:
// clause rows (must/should/must_not/filter + query type + field + value),
// multi-field sort rows, output format/size — plus an advanced DSL editor
// mode with autocomplete and the visualizer (显示查询语句).
// It is also where the bulk export lives (导出), and where multi-index
// searches are composed.

interface UIClause {
  id: number;
  must: Clause["must"];
  type: Clause["type"];
  field: string;
  value: string;
  gte: string;
  lte: string;
}

interface UISort {
  id: number;
  field: string;
  order: "asc" | "desc";
}

let uid = 0;
const nextId = () => ++uid;

const newUIClause = (p: Partial<UIClause> = {}): UIClause => ({
  id: nextId(),
  must: "must",
  type: "match_all",
  field: "",
  value: "",
  gte: "",
  lte: "",
  ...p,
});

/** One index with its document count. */
interface IndexInfo {
  name: string;
  docs: number | null;
}

/**
 * Read the index list together with its document counts.
 *
 * `docs.count` of _cat/indices counts the primary shards only, so it matches
 * the number the overview page shows.
 */
async function fetchIndexList(conn: Connection): Promise<IndexInfo[]> {
  const r = await esGet(conn, "_cat/indices?format=json&h=index,docs.count");
  if (!Array.isArray(r.json)) return [];
  return r.json.map((x: any) => ({
    name: x.index,
    docs: x["docs.count"] != null && x["docs.count"] !== "" ? Number(x["docs.count"]) : null,
  }));
}

const MUST_OPTIONS: { value: Clause["must"]; label: string }[] = [
  { value: "must", label: "must" },
  { value: "should", label: "should" },
  { value: "must_not", label: "must_not" },
  { value: "filter", label: "filter" },
];

const TYPE_OPTIONS: { value: Clause["type"]; label: string }[] = [
  { value: "match_all", label: "match_all（无条件）" },
  { value: "term", label: "term" },
  { value: "terms", label: "terms（多值）" },
  { value: "match", label: "match（全文）" },
  { value: "match_phrase", label: "match_phrase（短语）" },
  { value: "range", label: "range（范围）" },
  { value: "wildcard", label: "wildcard（通配）" },
  { value: "prefix", label: "prefix（前缀）" },
  { value: "exists", label: "exists（存在）" },
];

const VALUE_TYPES = new Set(["term", "terms", "match", "match_phrase", "wildcard", "prefix"]);

/**
 * Page numbers to show: always the first and the last page, plus a window
 * around the current one. "..." marks a gap.
 */
function buildPageItems(current: number, last: number): (number | "...")[] {
  if (last <= 0) return [];
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const out: (number | "...")[] = [1];
  const start = Math.max(2, current - 2);
  const end = Math.min(last - 1, current + 2);
  if (start > 2) out.push("...");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < last - 1) out.push("...");
  out.push(last);
  return out;
}

export default function StructuredQuery({ conn, initialIndex }: { conn: Connection; initialIndex?: string }) {
  const [allIndices, setAllIndices] = useState<IndexInfo[]>([]);
  const [index, setIndex] = useState<string>("");
  const [fields, setFields] = useState<{ name: string; type: string; indices: number }[]>([]);
  const [mode, setMode] = useState<"build" | "dsl">("build");
  const [clauses, setClauses] = useState<UIClause[]>([newUIClause()]);
  const [sortRows, setSortRows] = useState<UISort[]>([{ id: nextId(), field: "", order: "desc" }]);
  const [outputType, setOutputType] = useState<"json" | "table" | "csv">("table");
  const [size, setSize] = useState(50);
  const [from, setFrom] = useState(0);
  const [jumpPage, setJumpPage] = useState("");
  const [timeoutSec, setTimeoutSec] = useState<number>(() => loadTimeout());
  const lastSig = useRef("");
  const [queryText, setQueryText] = useState("");
  const [showDSL, setShowDSL] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [src, setSrc] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [inspected, setInspected] = useState<Hit | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [idxSearch, setIdxSearch] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);

  // index list (with doc counts)
  useEffect(() => {
    let alive = true;
    fetchIndexList(conn)
      .then((rows) => {
        if (!alive) return;
        setAllIndices(rows);
        // a query must always target one explicit index - preselect the first
        // usable one so the page is usable right away. System indices (".x")
        // are rejected by ES, so they are skipped.
        setIndex((cur) => {
          if (cur) return cur;
          if (!rows.length) return "";
          const usable = rows.find((r) => !r.name.startsWith("."));
          return (usable ?? rows[0]).name;
        });
      })
      .catch((e: any) => setError(friendlyError(e, conn)));
    return () => {
      alive = false;
    };
  }, [conn]);

  // preselect an index (e.g. opened from the shard matrix)
  useEffect(() => {
    if (initialIndex) setIndex(initialIndex);
  }, [initialIndex]);

  // remember the timeout across sessions
  useEffect(() => {
    saveTimeout(timeoutSec);
  }, [timeoutSec]);

  // close the index picker on outside click / Esc
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  // mapping of the selected index - a query must always target one explicit
  // index, so this never falls back to the whole cluster (which would merge
  // thousands of fields)
  useEffect(() => {
    if (!index) {
      setFields([]);
      return;
    }
    esGet(conn, `/${index}/_mapping`).then((r) => {
      setFields(parseMappingResponse(r.json));
    }).catch((e: any) => setError(friendlyError(e, conn)));
  }, [conn, index]);

  const visibleIndices = useMemo(() => {
    const q = idxSearch.trim().toLowerCase();
    return allIndices.filter((i) => !q || i.name.toLowerCase().includes(q));
  }, [allIndices, idxSearch]);

  /** total number of documents stored in the selected index */
  const indexDocs = useMemo(() => {
    if (!index) return null;
    const hit = allIndices.find((i) => i.name === index);
    return hit?.docs ?? null;
  }, [allIndices, index]);

  // switching the index resets the result (it no longer belongs to this index)
  const selectIndex = (name: string) => {
    if (name === index) return;
    setIndex(name);
    setResult(null);
    setSrc(null);
    setError("");
  };

  // ---- builder state helpers ----
  const updateClause = (id: number, patch: Partial<UIClause>) =>
    setClauses((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const appendClause = () => setClauses((cs) => [...cs, newUIClause()]);
  const removeClause = (i: number) =>
    setClauses((cs) => (cs.length > 1 ? cs.filter((_, idx) => idx !== i) : cs));

  const updateSort = (id: number, patch: Partial<UISort>) =>
    setSortRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addSortRow = () => setSortRows((rs) => [...rs, { id: nextId(), field: "", order: "desc" }]);
  const removeSortRow = (i: number) =>
    setSortRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));

  // UI clause rows -> ES clauses (skip empty rows, like head)
  function toClauses(): Clause[] {
    const out: Clause[] = [];
    for (const c of clauses) {
      if (c.type === "match_all") continue;
      if (!c.field) continue;
      if (c.type === "range") {
        const v: any = {};
        if (c.gte.trim()) v.gte = c.gte.trim();
        if (c.lte.trim()) v.lte = c.lte.trim();
        if (!Object.keys(v).length) continue;
        out.push(newClause({ field: c.field, type: "range", value: v, must: c.must }));
      } else if (c.type === "terms") {
        const arr = c.value.split(",").map((s) => s.trim()).filter(Boolean);
        if (!arr.length) continue;
        out.push(newClause({ field: c.field, type: "terms", value: arr, must: c.must }));
      } else if (c.type === "exists") {
        out.push(newClause({ field: c.field, type: "exists", value: "", must: c.must }));
      } else {
        if (!c.value.trim()) continue;
        out.push(newClause({ field: c.field, type: c.type, value: c.value.trim(), must: c.must }));
      }
    }
    return out;
  }

  /**
   * A short human readable summary of the active filter.
   *
   * Shown in the export dialog so it is obvious which documents are about to
   * be written to the file.
   */
  const filterSummary = useMemo(() => {
    if (mode === "dsl") {
      const t = queryText.trim();
      return t ? `自定义 DSL（${t.length} 字符）` : "无（全部文档）";
    }
    const parts = toClauses().map((c) => {
      const op = c.must === "must_not" ? "非" : c.must === "should" ? "或" : c.must === "filter" ? "过滤" : "且";
      const v =
        c.type === "exists"
          ? "存在"
          : c.type === "range" && c.value && typeof c.value === "object"
            ? Object.entries(c.value)
                .map(([k, val]) => `${k}=${val}`)
                .join("~")
            : Array.isArray(c.value)
              ? c.value.join("/")
              : c.value;
      return `${op} ${c.field} ${c.type} ${v}`;
    });
    return parts.length ? parts.join("；") : "无（全部文档）";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, queryText, clauses]);

  function makeSearch(): SearchState {
    let queryString = "";
    if (mode === "dsl" && queryText.trim()) {
      try {
        const p = JSON.parse(queryText);
        // tolerate a full request body: extract its query clause
        const q = p && typeof p === "object" && !Array.isArray(p) && p.query != null ? p.query : p;
        queryString = JSON.stringify(q);
      } catch {
        queryString = queryText; // buildDSL falls back to an empty bool; error surfaced on search
      }
    }
    return {
      indices: index ? [index] : [],
      types: [],
      clauses: mode === "dsl" ? [] : toClauses(),
      from,
      size,
      sort: sortRows.filter((r) => r.field).map((r) => ({ field: r.field, order: r.order })),
      aggs: {},
      queryString,
    };
  }

  // live preview for the visualizer
  const previewBody = useMemo(() => {
    if (mode === "dsl" && queryText.trim()) {
      try {
        JSON.parse(queryText);
      } catch {
        return null;
      }
    }
    return buildDSL(makeSearch()).body;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, queryText, clauses, sortRows, size, index, from]);

  async function search() {
    if (!index) {
      setError("请先在右上角选择要查询的索引");
      return;
    }
    if (mode === "dsl" && queryText.trim()) {
      try {
        JSON.parse(queryText);
      } catch (e: any) {
        setError("查询 JSON 无效：请检查括号与引号是否配对");
        setLoading(false);
        return;
      }
    }
    // a changed query starts over at the first page; an unchanged one keeps
    // the current page
    const sig = querySignature();
    await runSearch(sig === lastSig.current ? from : 0);
  }

  /** Run the query at a given offset. */
  async function runSearch(offset: number) {
    setLoading(true);
    setError("");
    const { path, body } = buildDSL(makeSearch());
    body.from = offset;
    setSrc(body);
    let r;
    try {
      r = await esPost(conn, path, body, timeoutSec);
    } catch (e: any) {
      setLoading(false);
      setError(friendlyError(e, conn));
      return;
    }
    setLoading(false);
    if (r.json?.hits) {
      setResult(r.json);
      setFrom(offset);
      lastSig.current = querySignature();
    } else {
      setError(errorText(r));
    }
  }

  /** Everything that defines the query - used to detect a changed query. */
  function querySignature(): string {
    return JSON.stringify({ index, mode, queryText, clauses, sortRows, size });
  }

  const hits = result?.hits?.hits ?? [];
  const total = result?.hits?.total?.value ?? result?.hits?.total;
  /**
   * ES reports `relation: "gte"` when the total hit count was capped.
   * With track_total_hits the count is exact, but a cluster that ignores the
   * flag would still cap it - show the "+" so the number is not read as exact.
   */
  const totalRelation: string = result?.hits?.total?.relation ?? "eq";
  const totalIsCapped = totalRelation === "gte";
  // there is a next page while the current window does not reach the end
  const canNext = total != null && from + hits.length < total;
  const totalPages = total != null ? Math.max(1, Math.ceil(total / size)) : 0;
  const currentPage = Math.floor(from / size) + 1;
  const pageItems = buildPageItems(currentPage, totalPages);
  const csv =
    outputType === "csv" && hits.length
      ? [Object.keys(hits[0]._source ?? {}).join(","), ...hits.map((h: any) => Object.values(h._source ?? {}).join(","))].join("\n")
      : null;

  return (
    <div className="page page-fill">
      <div className="page-toolbar">
        <h2>结构化查询</h2>
        <div className="toolbar-actions">
          <span className="toolbar-sentence">搜索</span>
          <div className="idx-picker" ref={pickerRef}>
            <button
              className={`btn idx-picker-btn ${index ? "" : "btn-required"}`}
              onClick={() => setPickerOpen((o) => !o)}
              aria-expanded={pickerOpen}
              title={index || "必须先选择索引"}
            >
              {index ? (
                <>
                  <span className="idx-picker-name">{index}</span>
                  <span className="caret">▾</span>
                </>
              ) : (
                <>
                  请选择索引 <span className="caret">▾</span>
                </>
              )}
            </button>
            {pickerOpen && (
              <div className="idx-pop">
                <input
                  className="input input-sm"
                  placeholder="搜索索引…"
                  value={idxSearch}
                  onChange={(e) => setIdxSearch(e.target.value)}
                />
                <div className="idx-list">
                  {visibleIndices.map((i) => {
                    const on = index === i.name;
                    return (
                      <button
                        key={i.name}
                        className={`idx-item ${on ? "idx-item-on" : ""}`}
                        title={i.name}
                        onClick={() => {
                          selectIndex(i.name);
                          setPickerOpen(false);
                        }}
                      >
                        <span className="idx-check">{on ? "✓" : ""}</span>
                        <span className="idx-body">
                          <span className="idx-name">{i.name}</span>
                          {i.docs != null && <span className="idx-meta">{i.docs.toLocaleString()} 文档</span>}
                        </span>
                      </button>
                    );
                  })}
                  {!visibleIndices.length && <div className="field-empty">无匹配索引</div>}
                </div>
                <div className="idx-pop-foot">
                  <span className="muted">
                    共 {allIndices.length} 个索引，只能选择一个
                  </span>
                </div>
              </div>
            )}
          </div>
          {index && (
            <span className="idx-total" title={`索引 ${index} 中的文档总数`}>
              索引共 <b>{indexDocs != null ? indexDocs.toLocaleString() : "-"}</b> 条
            </span>
          )}
          <button
            className="btn btn-xs"
            onClick={() => setShowExport(true)}
            disabled={!index}
            title={
              index
                ? "导出符合当前筛选条件的文档（Rust 侧流式写盘，内存恒定）"
                : "请先选择索引"
            }
          >
            ⬇ 导出命中数据
          </button>
        </div>
      </div>

      {!index ? (
        <div className="connect-hero">
          <div className="hero-glyph">⌗</div>
          <h2>请先选择要查询的索引</h2>
          <p>
            结构化查询必须指定索引，避免误查整个集群。
            <br />
            点击右上角「请选择索引 ▾」选择；也可以在概览页点击分片方块直接定位到某个索引。
          </p>
          <button className="btn btn-primary" onClick={() => setPickerOpen(true)}>
            选择索引
          </button>
        </div>
      ) : (
        <>
      <div className="builder-card">
        <div className="builder-main">
        <div className="builder-col builder-col-input">
        <div className="builder-section">
          <div className="builder-head">
            <div className="builder-head-left">
              <h4>查询条件</h4>
              {mode === "build" && (
                <button className="btn btn-xs" title="添加一行条件" onClick={appendClause}>+ 添加条件</button>
              )}
            </div>
            <div className="mode-seg" role="tablist">
              <button className={mode === "build" ? "on" : ""} onClick={() => setMode("build")}>条件构建</button>
              <button className={mode === "dsl" ? "on" : ""} onClick={() => setMode("dsl")}>DSL 编辑</button>
            </div>
          </div>

          {mode === "build" ? (
            <div className="clause-list">
              {clauses.map((c, i) => (
                <div className="clause-row" key={c.id}>
                  <select
                    className="input input-sm clause-must"
                    value={c.must}
                    onChange={(e) => updateClause(c.id, { must: e.target.value as Clause["must"] })}
                    title="逻辑关系"
                  >
                    {MUST_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  <select
                    className="input input-sm clause-type"
                    value={c.type}
                    onChange={(e) => updateClause(c.id, { type: e.target.value as Clause["type"] })}
                    title="查询类型"
                  >
                    {TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  {c.type !== "match_all" && (
                    <select
                      className="input input-sm clause-field"
                      value={c.field}
                      onChange={(e) => updateClause(c.id, { field: e.target.value })}
                      title="字段"
                    >
                      <option value="">选择字段…</option>
                      {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                    </select>
                  )}
                  {VALUE_TYPES.has(c.type) && (
                    <input
                      className="input input-sm clause-value"
                      placeholder={c.type === "terms" ? "多值用英文逗号分隔" : c.type === "wildcard" ? "支持 * 通配" : "值"}
                      value={c.value}
                      onChange={(e) => updateClause(c.id, { value: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && search()}
                    />
                  )}
                  {c.type === "range" && (
                    <span className="range-inputs">
                      <input className="input input-sm" placeholder="≥ (gte)" value={c.gte}
                        onChange={(e) => updateClause(c.id, { gte: e.target.value })} onKeyDown={(e) => e.key === "Enter" && search()} />
                      <input className="input input-sm" placeholder="≤ (lte)" value={c.lte}
                        onChange={(e) => updateClause(c.id, { lte: e.target.value })} onKeyDown={(e) => e.key === "Enter" && search()} />
                    </span>
                  )}
                  <span className="clause-btns">
                    <button className="btn btn-xs clause-del" title="删除此行条件" disabled={clauses.length <= 1} onClick={() => removeClause(i)}>−</button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <QueryEditor
              value={queryText}
              onChange={setQueryText}
              fields={fields}
              height={170}
              label="查询 DSL（覆盖条件构建，Ctrl+Enter 执行）"
              placeholder='如 {"term": {"status": "active"}}，粘贴完整请求体会自动提取 query'
              onSubmit={search}
            />
          )}
        </div>

        <div className="builder-section">
          <div className="builder-head">
            <h4>排序 <em className="builder-hint">可多字段，自上而下优先</em></h4>
            <button className="btn btn-xs" title="添加一个排序字段" onClick={addSortRow}>+ 添加排序</button>
          </div>
          <div className="clause-list">
            {sortRows.map((r, i) => (
              <div className="clause-row sort-row" key={r.id}>
                <select
                  className="input input-sm clause-field"
                  value={r.field}
                  onChange={(e) => updateSort(r.id, { field: e.target.value })}
                  title="排序字段"
                >
                  <option value="">默认 (_score)</option>
                  {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </select>
                <select
                  className="input input-sm clause-must"
                  value={r.order}
                  onChange={(e) => updateSort(r.id, { order: e.target.value as "asc" | "desc" })}
                >
                  <option value="asc">升序</option>
                  <option value="desc">降序</option>
                </select>
                <span className="clause-btns">
                  <button className="btn btn-xs clause-del" title="删除此行" disabled={sortRows.length <= 1} onClick={() => removeSortRow(i)}>−</button>
                </span>
              </div>
            ))}
          </div>
        </div>
        </div>
        </div>

        <div className="builder-actions">
          <button className="btn btn-primary" onClick={search} disabled={loading || !index}>
            {loading ? <span className="spinner" /> : null}
            {loading ? "搜索中…" : "搜索"}
          </button>
          <span className="toolbar-sentence">返回格式:</span>
          <select className="input input-sm" value={outputType} onChange={(e) => setOutputType(e.target.value as any)}>
            <option value="table">表格</option>
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
          <span className="toolbar-sentence">显示数量:</span>
          <select className="input input-sm" value={size} onChange={(e) => setSize(+e.target.value)}>
            {[10, 50, 100, 500].map((n) => <option key={n}>{n}</option>)}
          </select>
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
          <button
            className="btn btn-xs"
            onClick={() => setShowDSL(true)}
            title="在右侧抽屉中查看查询结构与请求 DSL"
          >
            查看查询语句
          </button>
        </div>

        {/* result summary + pagination */}
        {result && (
          <div className="builder-result">
            <div className="result-meta">
              <span
                className="result-chip result-chip-hit"
                title={
                  totalIsCapped
                    ? "命中数达到 ES 的统计上限，实际数量可能更多"
                    : "符合当前筛选条件的文档总数"
                }
              >
                命中 <b>{total != null ? total.toLocaleString() : "-"}{totalIsCapped ? "+" : ""}</b> 条
              </span>
              {indexDocs != null && (
                <span className="result-chip" title={`索引 ${index} 中的文档总数`}>
                  索引共 <b>{indexDocs.toLocaleString()}</b> 条
                </span>
              )}
              <span className="result-chip">耗时 <b>{result.took}ms</b></span>
              <span className="result-chip">
                分片 {result._shards?.successful ?? "-"}/{result._shards?.total ?? "-"}
              </span>
              <span className="result-chip">
                第 <b>{currentPage}</b> / {totalPages || "-"} 页
              </span>
            </div>
            <div className="pager">
              <button
                className="btn btn-xs"
                disabled={loading || from === 0}
                onClick={() => runSearch(0)}
                title="第一页"
              >
                首页
              </button>
              <button
                className="btn btn-xs"
                disabled={loading || from === 0}
                onClick={() => runSearch(Math.max(0, from - size))}
              >
                上一页
              </button>
              {pageItems.map((p, i) =>
                p === "..." ? (
                  <span key={`gap-${i}`} className="pager-gap">
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    className={`btn btn-xs pager-num ${p === currentPage ? "pager-num-on" : ""}`}
                    disabled={loading}
                    onClick={() => runSearch((p - 1) * size)}
                    title={`第 ${p} 页`}
                  >
                    {p}
                  </button>
                )
              )}
              <button
                className="btn btn-xs"
                disabled={loading || !canNext}
                onClick={() => runSearch(from + size)}
              >
                下一页
              </button>
              <button
                className="btn btn-xs"
                disabled={loading || !canNext}
                onClick={() => runSearch((totalPages - 1) * size)}
                title="最后一页"
              >
                末页
              </button>
              <span className="pager-jump-label">跳至</span>
              <input
                className="input input-sm pager-jump"
                placeholder="页码"
                value={jumpPage}
                onChange={(e) => setJumpPage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const n = Math.floor(Number(jumpPage));
                  if (!Number.isFinite(n) || n < 1 || n > totalPages) {
                    setError(totalPages ? `页码需在 1 到 ${totalPages} 之间` : "请先执行搜索");
                    return;
                  }
                  setError("");
                  runSearch((n - 1) * size);
                  setJumpPage("");
                }}
                title="输入页码后回车跳转"
              />
              <button
                className="btn btn-xs pager-export"
                onClick={() => setShowExport(true)}
                disabled={!index || total == null || total === 0}
                title={
                  total == null || total === 0
                    ? "没有可导出的命中数据"
                    : `导出符合当前筛选条件的全部 ${total.toLocaleString()} 条文档`
                }
              >
                ⬇ 导出命中数据
              </button>
            </div>
          </div>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {result && outputType === "table" && (
        <ResultsTable
          hits={hits}
          total={total}
          onSelect={setInspected}
          scroll
          storeKey={columnStoreKey(conn.baseUrl, conn.username, index)}
        />
      )}
      {result && outputType === "json" && <JsonView title="结果" data={result} />}
      {csv && <pre className="code-editor">{csv}</pre>}
        </>
      )}

      {inspected && (
        <Drawer title={`${inspected._index}/${inspected._id}`} onClose={() => setInspected(null)}>
          <JsonView title="文档" data={inspected} />
        </Drawer>
      )}

      {/* the query structure and the request DSL live in a side drawer so
          they never take space away from the result table */}
      {showDSL && (
        <Drawer title="查询语句" onClose={() => setShowDSL(false)} width={520}>
          <QueryVisualizer body={previewBody} title="查询结构" />
          {src ? (
            <JsonView title="请求 DSL" data={src} defaultDepth={2} />
          ) : (
            <div className="json-panel qv-placeholder">
              <div className="empty">执行搜索后显示请求 DSL</div>
            </div>
          )}
        </Drawer>
      )}

      {showExport && (
        <ExportDialog
          baseUrl={conn.baseUrl}
          username={conn.username}
          password={conn.password}
          indices={index ? [index] : []}
          body={buildDSL(makeSearch()).body}
          fields={fields}
          filterSummary={filterSummary}
          total={total ?? 0}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
