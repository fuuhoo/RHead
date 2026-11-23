import { byteSize, count } from "../lib/format";
import { ShardEntry, ShardMatrix as ShardMatrixModel } from "../lib/cluster";

// Shard matrix — ports the index × node shard grid of the original Cluster
// Overview: columns are indices, rows are nodes, and every cell lists the
// shard copies living on that node (primary vs replica, plus relocation and
// unassigned states). Shards without a node get their own row at the bottom.

interface Props {
  matrix: ShardMatrixModel;
  onOpenIndex?: (index: string) => void;
}

export default function ShardMatrix({ matrix, onOpenIndex }: Props) {
  const { columns, rows, unassigned, totals } = matrix;

  if (!matrix.available) {
    return (
      <div className="table-wrap">
        <div className="empty">当前集群状态未包含路由表（routing table），无法展示分片分布。</div>
      </div>
    );
  }
  if (!columns.length) {
    return (
      <div className="table-wrap">
        <div className="empty">没有匹配的索引</div>
      </div>
    );
  }

  return (
    <div className="shard-wrap">
      <table className="shard-grid">
        <thead>
          <tr>
            <th className="shard-grid-corner">节点 / 索引</th>
            {columns.map((c) => (
              <th key={c.name} className="shard-grid-col">
                <button
                  className="shard-grid-idx"
                  title={`打开索引 ${c.name}`}
                  onClick={() => onOpenIndex?.(c.name)}
                >
                  {c.name}
                </button>
                <div className="shard-grid-meta">
                  {byteSize(c.sizeBytes)} · {count(c.docs)} docs
                </div>
                <div className="shard-grid-meta">
                  {c.primaries} 主 / {c.replicas} 副本
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th className="shard-grid-node">
                <span className={`shard-node-mark ${row.master ? "shard-node-master" : ""}`}>
                  {row.master ? "★" : "●"}
                </span>
                <span className="shard-node-name" title={row.name}>
                  {row.name}
                </span>
              </th>
              {columns.map((c) => (
                <td key={c.name} className="shard-grid-cell">
                  {(row.cells[c.name] ?? []).map((e) => (
                    <ShardChip
                      key={`${e.shard}-${e.primary ? "p" : "r"}`}
                      entry={e}
                      onOpenIndex={onOpenIndex}
                    />
                  ))}
                </td>
              ))}
            </tr>
          ))}

          {totals.unassigned > 0 && (
            <tr className="shard-grid-row-unassigned">
              <th className="shard-grid-node">
                <span className="shard-node-mark shard-node-bad">✕</span>
                <span className="shard-node-name">未分配</span>
              </th>
              {columns.map((c) => (
                <td key={c.name} className="shard-grid-cell">
                  {(unassigned[c.name] ?? []).map((e) => (
                    <ShardChip key={`u-${e.shard}`} entry={e} onOpenIndex={onOpenIndex} />
                  ))}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ShardChip({
  entry,
  onOpenIndex,
}: {
  entry: ShardEntry;
  onOpenIndex?: (index: string) => void;
}) {
  const title = [
    entry.index,
    `分片 ${entry.shard >= 0 ? entry.shard : "?"}`,
    entry.primary ? "主分片" : "副本",
    entry.state,
    entry.nodeName ? `节点 ${entry.nodeName}` : "未分配",
  ].join(" · ");
  return (
    <button className={chipClass(entry)} title={title} onClick={() => onOpenIndex?.(entry.index)}>
      {entry.shard >= 0 ? entry.shard : "?"}
    </button>
  );
}

function chipClass(e: ShardEntry): string {
  const base = "shard-chip";
  if (e.unassigned) return `${base} shard-chip-unassigned`;
  if (e.relocating) return `${base} shard-chip-relocating`;
  if (e.state === "INITIALIZING") return `${base} shard-chip-initializing`;
  if (e.state !== "STARTED") return `${base} shard-chip-warn`;
  return `${base} ${e.primary ? "shard-chip-primary" : "shard-chip-replica"}`;
}
