import { useEffect, useMemo, useRef, useState } from "react";
import { cellText, flattenSource } from "../lib/format";
import { loadHiddenColumns, saveHiddenColumns } from "../lib/columns";

// Data table for _search hits (replaces ui/ResultTable + ui/Table).
// Click a row to inspect the full document; click a header to sort.

export interface Hit {
  _id: string;
  _index: string;
  _type?: string;
  _score?: number;
  _source?: any;
  [k: string]: any;
}

interface Props {
  hits: Hit[];
  total?: number;
  onSort?: (field: string, order: "asc" | "desc") => void;
  sortField?: string;
  sortOrder?: "asc" | "desc";
  onSelect?: (hit: Hit) => void;
  /**
   * Make the table its own scroll container: the header sticks to the top of
   * the table and the horizontal scrollbar sits right below the visible
   * rows instead of below the whole result set.
   */
  scroll?: boolean;
  /**
   * Where to persist the column visibility. Without it the choice is only
   * kept for the lifetime of the component.
   */
  storeKey?: string;
}

/** Columns that are always shown - they identify the row itself. */
const PINNED = ["_index", "_id", "_score"];

export default function ResultsTable({
  hits,
  total,
  onSort,
  sortField,
  sortOrder,
  onSelect,
  scroll,
  storeKey,
}: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [colFilter, setColFilter] = useState("");
  // mirrors `hidden` so rapid clicks always work on the latest value
  const hiddenRef = useRef<Set<string>>(new Set());
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // the store key the current `hidden` set belongs to
  const loadedKey = useRef<string | null>(null);

  const allColumns = useMemo(() => {
    const cols = new Set<string>(PINNED);
    for (const h of hits.slice(0, 100)) {
      Object.keys(flattenSource(h._source ?? {})).forEach((c) => cols.add(c));
    }
    return [...cols];
  }, [hits]);

  // load the stored preference when the key changes (a different index)
  useEffect(() => {
    if (!storeKey) return;
    if (loadedKey.current === storeKey) return;
    loadedKey.current = storeKey;
    const stored = loadHiddenColumns(storeKey);
    hiddenRef.current = stored;
    setHidden(stored);
  }, [storeKey]);

  /**
   * Change the hidden columns and persist them.
   *
   * Saving happens at the mutation site instead of in an effect: an effect
   * would also run on mount, where it would write the empty initial set over
   * the preference that was just loaded.
   */
  const updateHidden = (next: Set<string>) => {
    hiddenRef.current = next;
    setHidden(next);
    if (storeKey) saveHiddenColumns(storeKey, next);
  };

  // A column that reappears (new page, different index) must not stay hidden.
  const visibleColumns = useMemo(
    () => allColumns.filter((c) => !hidden.has(c)),
    [allColumns, hidden]
  );

  // The picker lists every column the user knows about: the ones in the
  // current result plus the ones they hid earlier. A column that is hidden
  // but not in this page of results must stay listed - otherwise hiding a
  // field and paging on would silently bring it back.
  const pickerColumns = useMemo(() => {
    const out = [...allColumns];
    for (const c of hidden) if (!out.includes(c)) out.push(c);
    return out;
  }, [allColumns, hidden]);

  // narrow the picker list down by column name
  const filteredColumns = useMemo(() => {
    const q = colFilter.trim().toLowerCase();
    if (!q) return pickerColumns;
    return pickerColumns.filter((c) => c.toLowerCase().includes(q));
  }, [pickerColumns, colFilter]);

  // close the picker on an outside click
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

  const rows = useMemo(
    () =>
      hits.map((h) => {
        const flat = flattenSource(h._source ?? {});
        return { hit: h, cells: visibleColumns.map((c) => (c in flat ? flat[c] : h[c])) };
      }),
    [hits, visibleColumns]
  );

  const toggle = (c: string) => {
    const next = new Set(hiddenRef.current);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    updateHidden(next);
  };

  const showAll = () => updateHidden(new Set());
  const hideAll = () => updateHidden(new Set(pickerColumns.filter((c) => !PINNED.includes(c))));
  /** keep only the pinned columns plus the given one */
  const showOnly = (c: string) =>
    updateHidden(new Set(pickerColumns.filter((x) => x !== c && !PINNED.includes(x))));

  if (!hits.length) return <div className="empty">没有命中文档</div>;

  const hiddenCount = hidden.size;

  return (
    <div className={`table-block ${scroll ? "table-block-fill" : ""}`}>
      <div className="table-meta">
        共 <b>{total ?? hits.length}</b> 条命中 · 显示 {hits.length} 条
        <span className="table-meta-cols">
          {visibleColumns.length}/{pickerColumns.length} 列
          {hiddenCount > 0 ? ` · 已隐藏 ${hiddenCount}` : ""}
        </span>
        <div className="col-picker" ref={pickerRef}>
          <button
            className="btn btn-xs"
            onClick={() => {
              setPickerOpen((v) => {
                if (v) setColFilter("");
                return !v;
              });
            }}
            title="选择要显示的列"
          >
            列设置{hiddenCount > 0 ? ` (${hiddenCount})` : ""}
          </button>
          {pickerOpen && (
            <div className="col-picker-panel">
              <div className="col-picker-bar">
                <button className="btn btn-xs" onClick={showAll}>显示全部</button>
                <button className="btn btn-xs" onClick={hideAll}>仅显示关键列</button>
                <button className="btn btn-xs" onClick={() => setPickerOpen(false)}>关闭</button>
              </div>
              <div className="col-picker-search">
                <input
                  className="input input-sm col-picker-input"
                  placeholder="筛选列名…"
                  value={colFilter}
                  onChange={(e) => setColFilter(e.target.value)}
                  autoFocus
                />
                {colFilter && (
                  <span className="col-picker-count">
                    {filteredColumns.length}/{pickerColumns.length}
                  </span>
                )}
              </div>
              {storeKey && (
                <div className="col-picker-hint">列的显示状态按索引保存，下次打开自动恢复</div>
              )}
              <div className="col-picker-list">
                {filteredColumns.map((c) => {
                  const on = !hidden.has(c);
                  const pinned = PINNED.includes(c);
                  return (
                    <label key={c} className={`col-picker-item ${on ? "" : "off"}`}>
                      <input type="checkbox" checked={on} disabled={pinned} onChange={() => toggle(c)} />
                      <span className="col-picker-name" title={c}>{c}</span>
                      <button
                        className="col-picker-only"
                        title={`只看 ${c} 和关键列`}
                        onClick={(e) => { e.preventDefault(); showOnly(c); }}
                      >
                        只看
                      </button>
                    </label>
                  );
                })}
                {filteredColumns.length === 0 && (
                  <div className="col-picker-empty">没有匹配「{colFilter}」的列</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className={`table-wrap ${scroll ? "table-wrap-scroll" : ""}`}>
        <table className="data-table">
          <thead>
            <tr>
              {visibleColumns.map((c) => (
                <th
                  key={c}
                  onClick={() => {
                    if (!onSort) return;
                    const next: "asc" | "desc" =
                      sortField === c && sortOrder === "asc" ? "desc" : "asc";
                    onSort(c, next);
                  }}
                  className={onSort ? "sortable" : ""}
                >
                  {c} {sortField === c ? (sortOrder === "asc" ? "▲" : "▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ hit, cells }) => (
              <tr
                key={hit._index + hit._id}
                className={selected === hit._id ? "selected" : ""}
                onClick={() => {
                  setSelected(hit._id);
                  onSelect?.(hit);
                }}
              >
                {cells.map((v, i) => (
                  <td key={i} title={cellText(v)}>
                    {cellText(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
