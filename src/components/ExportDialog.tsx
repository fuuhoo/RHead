import { useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import Modal from "./Modal";
import { byteSize, count } from "../lib/format";
import {
  cancelExport,
  ExportFormat,
  ExportProgress,
  ExportSummary,
  MAX_EXPORT_ROWS,
  onExportProgress,
  pickExportPath,
  runExport,
} from "../lib/export";

// Export dialog — configures and drives a bulk export of the current query.
// The heavy lifting happens in Rust; this dialog only collects the options,
// shows progress and reports the result.

interface Props {
  baseUrl: string;
  username: string;
  password: string;
  indices: string[];
  /** the current query body (DSL) */
  body: any;
  /** mapping field list, used for the CSV column set and field picking */
  fields: { name: string; type: string }[];
  /** estimated hit count of the current query */
  total: number;
  /** short human readable summary of the active filter, shown in the dialog */
  filterSummary?: string;
  onClose: () => void;
}

const FORMATS: { id: ExportFormat; label: string; ext: string; hint: string }[] = [
  { id: "ndjson", label: "NDJSON", ext: "ndjson", hint: "一行一个 JSON，无损、可回灌 ES" },
  { id: "csv", label: "CSV", ext: "csv", hint: "表格友好，字段自动扁平化（Excel 需 UTF-8 BOM）" },
  { id: "json", label: "JSON 数组", ext: "json", hint: "标准 JSON 数组" },
];

type Phase = "setup" | "running" | "done" | "error";

export default function ExportDialog({
  baseUrl,
  username,
  password,
  indices,
  body,
  fields,
  total,
  filterSummary,
  onClose,
}: Props) {
  const [format, setFormat] = useState<ExportFormat>("ndjson");
  const [allFields, setAllFields] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [fieldSearch, setFieldSearch] = useState("");
  const [maxRows, setMaxRows] = useState("100000");
  const [chunkSize, setChunkSize] = useState("1000");
  const [includeMeta, setIncludeMeta] = useState(true);
  const [outPath, setOutPath] = useState("");
  const [phase, setPhase] = useState<Phase>("setup");
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [error, setError] = useState("");
  const exportId = useRef(`exp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const [rowLimit, setRowLimit] = useState(100000);

  const meta = FORMATS.find((f) => f.id === format)!;

  const defaultName = useMemo(() => {
    const idx = indices.length === 1 ? indices[0] : indices.length ? `${indices.length}个索引` : "all";
    const safe = idx.replace(/[\\/:*?"<>|]/g, "_");
    const d = new Date();
    const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    return `rhead-${safe}-${ts}.${meta.ext}`;
  }, [indices, meta.ext]);

  // listen for progress events while the dialog is open
  useEffect(() => {
    let un: (() => void) | undefined;
    let alive = true;
    onExportProgress((p) => {
      if (!alive || p.id !== exportId.current) return;
      setProgress(p);
    }).then((f) => {
      if (alive) un = f;
      else f();
    });
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  // keep the row limit in sync with the input (empty = no limit)
  useEffect(() => {
    const n = Number(maxRows);
    setRowLimit(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  }, [maxRows]);

  const visibleFields = useMemo(() => {
    const q = fieldSearch.trim().toLowerCase();
    return fields.filter((f) => !q || f.name.toLowerCase().includes(q));
  }, [fields, fieldSearch]);

  async function choosePath() {
    try {
      const p = await pickExportPath(defaultName, meta.ext);
      if (p) setOutPath(p);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function start() {
    if (!outPath) {
      setError("请先选择保存位置");
      return;
    }
    setError("");
    setPhase("running");
    setProgress({ id: exportId.current, rows: 0, bytes: 0, phase: "running" });
    try {
      const res = await runExport({
        id: exportId.current,
        baseUrl,
        username,
        password,
        indices: indices.join(","),
        body,
        format,
        fields: allFields ? null : [...picked],
        includeMeta,
        csvColumns: fields.map((f) => f.name),
        outPath,
        maxRows: rowLimit > 0 ? rowLimit : null,
        chunkSize: Math.max(1, Math.min(10000, Number(chunkSize) || 1000)),
      });
      setSummary(res);
      setPhase("done");
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setPhase("error");
    }
  }

  async function stop() {
    try {
      await cancelExport(exportId.current);
    } catch {}
  }

  const rows = progress?.rows ?? 0;
  const bytes = progress?.bytes ?? 0;
  const pct = rowLimit > 0 ? Math.min(100, Math.round((rows / rowLimit) * 100)) : null;

  return (
    <Modal title="导出命中数据" onClose={onClose} width={520}>
      {phase === "running" && (
        <div className="export-panel">
          <div className="export-status">
            <span className="spinner spinner-dark" />
            <span>正在导出…</span>
          </div>
          <div className="export-progress">
            <div className="export-bar">
              <span style={{ width: `${pct ?? 8}%` }} />
            </div>
            <div className="export-progress-meta">
              <span>已导出 {count(rows)} 条 · {byteSize(bytes)}</span>
              {pct != null && <span>{pct}%</span>}
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn btn-danger" onClick={stop}>
              取消导出
            </button>
          </div>
        </div>
      )}

      {phase === "done" && summary && (
        <div className="export-panel">
          <div className="export-done">
            <span className="export-done-mark">✓</span>
            <div>
              <div className="export-done-title">
                {summary.complete
                  ? "导出完成"
                  : summary.hitHardCap
                    ? `达到单次导出上限 ${count(MAX_EXPORT_ROWS)} 条，已停止`
                    : "导出已中断（取消或达到条数上限）"}
              </div>
              <div className="export-done-meta">
                {count(summary.rows)} 条 · {byteSize(summary.bytes)} · 分页方式 {summary.strategy}
              </div>
              {summary.hitHardCap && (
                <div className="export-done-note">
                  需要导出全部数据请在服务器端进行（快照恢复 / elasticsearch-dump）。
                </div>
              )}
              <div className="export-done-path" title={summary.path}>
                {summary.path}
              </div>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => revealItemInDir(summary.path)}>
              打开所在文件夹
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      )}

      {phase !== "running" && phase !== "done" && (
        <>
          <div className="export-info">
            <div>
              <span className="export-info-label">索引</span>
              <span className="export-info-value">
                {indices.length ? indices.join(", ") : "（全部）"}
              </span>
            </div>
            <div>
              <span className="export-info-label">命中</span>
              <span className="export-info-value">
                {count(total)} 条
                <span className="export-info-sub">符合当前筛选条件</span>
              </span>
            </div>
            {filterSummary && (
              <div>
                <span className="export-info-label">筛选</span>
                <span className="export-info-value export-info-filter" title={filterSummary}>
                  {filterSummary}
                </span>
              </div>
            )}
          </div>

          <div className="export-row">
            <span className="export-label">格式</span>
            <div className="mode-seg">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  className={format === f.id ? "on" : ""}
                  onClick={() => setFormat(f.id)}
                  title={f.hint}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="export-hint">{meta.hint}</div>

          <div className="export-row">
            <span className="export-label">字段</span>
            <div className="export-seg">
              <button className={allFields ? "on" : ""} onClick={() => setAllFields(true)}>
                全部字段
              </button>
              <button
                className={!allFields ? "on" : ""}
                onClick={() => setAllFields(false)}
                disabled={!fields.length}
              >
                指定字段{picked.size ? ` (${picked.size})` : ""}
              </button>
            </div>
          </div>

          {!allFields && (
            <div className="export-fields">
              <input
                className="input input-sm"
                placeholder="搜索字段…"
                value={fieldSearch}
                onChange={(e) => setFieldSearch(e.target.value)}
              />
              <div className="export-field-list">
                {visibleFields.map((f) => (
                  <label key={f.name} className="export-field">
                    <input
                      type="checkbox"
                      checked={picked.has(f.name)}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(f.name);
                          else next.delete(f.name);
                          return next;
                        })
                      }
                    />
                    <span className="export-field-name" title={f.name}>
                      {f.name}
                    </span>
                    <span className="export-field-type">{f.type}</span>
                  </label>
                ))}
                {!visibleFields.length && <div className="field-empty">无可选字段</div>}
              </div>
            </div>
          )}

          <div className="export-row">
            <span className="export-label">条数上限</span>
            <input
              className="input input-sm export-num"
              placeholder="不限"
              value={maxRows}
              onChange={(e) => setMaxRows(e.target.value)}
            />
            <span className="export-label">每页</span>
            <input
              className="input input-sm export-num"
              value={chunkSize}
              onChange={(e) => setChunkSize(e.target.value)}
            />
            <label className="export-check">
              <input
                type="checkbox"
                checked={includeMeta}
                onChange={(e) => setIncludeMeta(e.target.checked)}
              />
              含元数据
            </label>
          </div>

          <div className="export-hint export-cap-hint">
            单次导出最多 {count(MAX_EXPORT_ROWS)} 条，避免拖垮集群和网络。需要导出全部数据请在服务器端进行
            （快照恢复 / elasticsearch-dump）。
          </div>

          <div className="export-row">
            <span className="export-label">保存到</span>
            <input
              className="input input-sm export-path"
              placeholder="点击右侧「另存为…」选择文件"
              value={outPath}
              onChange={(e) => setOutPath(e.target.value)}
            />
            <button className="btn btn-xs" onClick={choosePath}>
              另存为…
            </button>
          </div>

          {error && <div className="alert alert-error export-error">{error}</div>}

          {rowLimit > 0 && total > rowLimit && (
            <div className="alert export-warn">
              <span>
                条数上限 {count(rowLimit)} 小于命中数 {count(total)}，导出结果会被截断。
              </span>
            </div>
          )}

          {rowLimit === 0 && total > MAX_EXPORT_ROWS && (
            <div className="alert export-warn">
              <span>
                命中数 {count(total)} 超过单次导出上限 {count(MAX_EXPORT_ROWS)}，
                导出会在上限处停止。全部数据请在服务器端导出（快照恢复 / elasticsearch-dump）。
              </span>
            </div>
          )}

          {!indices.length && (
            <div className="alert export-warn">
              <span>未选择索引，将导出集群中全部索引的命中文档。</span>
            </div>
          )}

          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" onClick={start} disabled={!outPath}>
              开始导出
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
