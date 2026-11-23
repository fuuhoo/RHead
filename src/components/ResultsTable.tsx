import { useMemo, useState } from "react";
import { cellText, flattenSource } from "../lib/format";

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
}

export default function ResultsTable({
  hits,
  total,
  onSort,
  sortField,
  sortOrder,
  onSelect,
  scroll,
}: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  const columns = useMemo(() => {
    const cols = new Set<string>(["_index", "_id", "_score"]);
    for (const h of hits.slice(0, 100)) {
      Object.keys(flattenSource(h._source ?? {})).forEach((c) => cols.add(c));
    }
    return [...cols];
  }, [hits]);

  const rows = useMemo(
    () =>
      hits.map((h) => {
        const flat = flattenSource(h._source ?? {});
        return { hit: h, cells: columns.map((c) => (c in flat ? flat[c] : h[c])) };
      }),
    [hits, columns]
  );

  if (!hits.length) return <div className="empty">没有命中文档</div>;

  return (
    <div className={`table-block ${scroll ? "table-block-fill" : ""}`}>
      <div className="table-meta">
        共 <b>{total ?? hits.length}</b> 条命中 · 显示 {hits.length} 条
      </div>
      <div className={`table-wrap ${scroll ? "table-wrap-scroll" : ""}`}>
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((c) => (
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
