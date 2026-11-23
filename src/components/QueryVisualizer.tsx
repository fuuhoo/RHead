import { useMemo } from "react";

// Query DSL visualizer: renders a search body as a readable tree of
// bool groups (must AND / should OR / must_not NOT / filter) and leaf
// conditions, plus a summary row for size / sort / aggs meta.

type Tone = "must" | "should" | "not" | "filter" | "leaf";

interface LeafNode {
  t: "leaf";
  op: string;
  field?: string;
  text: string;
  tone: Tone;
}
interface BoolNode {
  t: "bool";
  op: string;
  sections: { label: string; tone: Tone; nodes: VNode[]; hint?: string }[];
}
interface ListNode {
  t: "list";
  op: string;
  nodes: VNode[];
}
type VNode = LeafNode | BoolNode | ListNode;

const TONE_BY_CLAUSE: Record<string, Tone> = {
  must: "must",
  should: "should",
  must_not: "not",
  filter: "filter",
};

function compactValue(v: any, depth = 0): string {
  if (v == null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") return String(v);
  if (depth > 1) return "{…}";
  if (Array.isArray(v)) {
    const inner = v.slice(0, 4).map((x) => compactValue(x, depth + 1));
    return `[${inner.join(", ")}${v.length > 4 ? `, …(${v.length})` : ""}]`;
  }
  const entries = Object.entries(v);
  if (!entries.length) return "{}";
  const inner = entries.slice(0, 4).map(([k, x]) => `${k}: ${compactValue(x, depth + 1)}`);
  return `{ ${inner.join(", ")}${entries.length > 4 ? ", …" : ""} }`;
}

function rangeText(v: any): string {
  const parts: string[] = [];
  if (v.gte != null) parts.push(`≥ ${compactValue(v.gte)}`);
  if (v.gt != null) parts.push(`> ${compactValue(v.gt)}`);
  if (v.lte != null) parts.push(`≤ ${compactValue(v.lte)}`);
  if (v.lt != null) parts.push(`< ${compactValue(v.lt)}`);
  if (!parts.length) return compactValue(v);
  return parts.join(" 且 ");
}

/** Build a visual node from a query clause object (single key or unknown shape). */
function buildNode(q: any): VNode {
  if (q == null || typeof q !== "object") {
    return { t: "leaf", op: "?", text: compactValue(q), tone: "leaf" };
  }
  if (Array.isArray(q)) {
    return { t: "list", op: "组", nodes: q.map(buildNode) };
  }
  const keys = Object.keys(q);
  if (keys.length === 0) {
    return { t: "leaf", op: "match_all", text: "全部文档", tone: "leaf" };
  }

  // bool
  if (keys.includes("bool")) {
    const b = q.bool ?? {};
    const sections = (["must", "should", "must_not", "filter"] as const)
      .filter((k) => b[k] != null)
      .map((k) => {
        const raw = b[k];
        const arr = Array.isArray(raw) ? raw : [raw];
        return {
          label: k,
          tone: TONE_BY_CLAUSE[k],
          nodes: arr.filter((x: any) => x != null && typeof x === "object" && Object.keys(x).length).map(buildNode),
          hint: k === "should" && b.minimum_should_match != null ? `min ${b.minimum_should_match}` : undefined,
        };
      })
      .filter((sec) => sec.nodes.length > 0);
    if (!sections.length) {
      // an empty bool matches all documents — render as a match_all leaf
      return { t: "leaf", op: "bool", text: "无条件 — 命中全部文档", tone: "leaf" };
    }
    return { t: "bool", op: "bool", sections };
  }

  // nested wraps an inner query
  if (keys.includes("nested")) {
    const n = q.nested ?? {};
    const inner = n.query ? buildNode(n.query) : null;
    const path = n.path ?? "";
    return {
      t: "list",
      op: "nested",
      nodes: [
        { t: "leaf", op: "path", field: path, text: "", tone: "leaf" },
        ...(inner ? [inner] : []),
      ],
    };
  }

  // constant_score / function_score / boosting wrap a query
  for (const wrapper of ["constant_score", "function_score", "boosting"]) {
    if (keys.includes(wrapper)) {
      const inner = q[wrapper]?.query ?? q[wrapper]?.filter ?? q[wrapper]?.positive;
      const rest = Object.entries(q[wrapper] ?? {})
        .filter(([k]) => k !== "query" && k !== "filter" && k !== "positive" && k !== "negative")
        .map(([k, v]) => ({ t: "leaf", op: k, text: compactValue(v), tone: "leaf" }) as LeafNode);
      return {
        t: "list",
        op: wrapper,
        nodes: [...(inner ? [buildNode(inner)] : []), ...rest],
      };
    }
  }

  // ids
  if (keys.includes("ids")) {
    const vals = q.ids?.values;
    return {
      t: "leaf",
      op: "ids",
      text: Array.isArray(vals) ? `id ∈ [${vals.slice(0, 5).map(compactValue).join(", ")}${vals.length > 5 ? ", …" : ""}]` : "",
      tone: "leaf",
    };
  }

  // multi_match / query_string
  if (keys.includes("multi_match") || keys.includes("query_string") || keys.includes("simple_query_string")) {
    const op = keys.includes("multi_match") ? "multi_match" : keys.includes("query_string") ? "query_string" : "simple_query_string";
    const v = q[op] ?? {};
    const fields = Array.isArray(v.fields) ? v.fields.join(", ") : undefined;
    return { t: "leaf", op, field: fields || undefined, text: compactValue(v.query ?? ""), tone: "leaf" };
  }

  // field-map leaf: { term: { field: value } }
  const op = keys[0];
  const payload = q[op];
  if (payload != null && typeof payload === "object" && !Array.isArray(payload)) {
    const pk = Object.keys(payload);
    if (pk.length === 1) {
      const field = pk[0];
      const val = payload[field];
      const text = op === "range" ? rangeText(val) : compactValue(val);
      return { t: "leaf", op, field, text, tone: "leaf" };
    }
    // options form: { value, boost, ... } or { field: ... }
    if (payload.field != null) {
      return { t: "leaf", op, field: String(payload.field), text: compactValue(payload.value ?? ""), tone: "leaf" };
    }
    return { t: "leaf", op, text: compactValue(payload), tone: "leaf" };
  }
  if (typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean") {
    return { t: "leaf", op, text: compactValue(payload), tone: "leaf" };
  }
  return { t: "leaf", op, text: compactValue(payload), tone: "leaf" };
}

interface MetaChip {
  label: string;
  value: string;
}

function extractMeta(body: any): MetaChip[] {
  const chips: MetaChip[] = [];
  if (body == null || typeof body !== "object") return chips;
  if (body.size != null) chips.push({ label: "size", value: String(body.size) });
  if (body.from != null) chips.push({ label: "from", value: String(body.from) });
  if (Array.isArray(body.sort) && body.sort.length) {
    const s = body.sort[0];
    const key = typeof s === "string" ? s : Object.keys(s ?? {})[0];
    const order = typeof s === "object" && s?.[key]?.order ? s[key].order : "";
    chips.push({ label: "sort", value: `${key}${order ? " " + order : ""}` });
  }
  if (body.aggs && typeof body.aggs === "object") {
    chips.push({ label: "aggs", value: `${Object.keys(body.aggs).length} 个聚合` });
  }
  if (body._source != null) {
    chips.push({ label: "_source", value: typeof body._source === "boolean" ? String(body._source) : Array.isArray(body._source) ? body._source.join(", ").slice(0, 40) : "自定义" });
  }
  if (body.track_total_hits != null) chips.push({ label: "track_total_hits", value: String(body.track_total_hits) });
  if (body.highlight) chips.push({ label: "highlight", value: "高亮" });
  if (body.collapse?.field) chips.push({ label: "collapse", value: String(body.collapse.field) });
  return chips;
}

function countClauses(n: VNode, acc: { must: number; should: number; not: number; filter: number; leaf: number }) {
  if (n.t === "bool") {
    for (const sec of n.sections) {
      acc[sec.tone === "must" ? "must" : sec.tone === "should" ? "should" : sec.tone === "not" ? "not" : "filter"] +=
        sec.nodes.length;
      sec.nodes.forEach((c) => countClauses(c, acc));
    }
  } else if (n.t === "list") {
    n.nodes.forEach((c) => countClauses(c, acc));
  } else {
    acc.leaf++;
  }
}

export default function QueryVisualizer({
  body,
  title = "查询结构",
  compact = false,
}: {
  body: any;
  title?: string;
  compact?: boolean;
}) {
  const parsed = useMemo(() => {
    if (body == null) return { ok: false as const, error: "暂无查询" };
    const q = body?.query;
    if (q == null) return { ok: false as const, error: "该请求不含 query 条件" };
    try {
      const node = buildNode(q);
      const counts = { must: 0, should: 0, not: 0, filter: 0, leaf: 0 };
      countClauses(node, counts);
      return { ok: true as const, node, meta: extractMeta(body), counts };
    } catch (e: any) {
      return { ok: false as const, error: String(e?.message ?? e) };
    }
  }, [body]);

  if (!parsed.ok) {
    return (
      <div className={`qv qv-empty ${compact ? "qv-compact" : ""}`}>
        {title && <div className="qv-title">{title}</div>}
        <div className="empty">{parsed.error}</div>
      </div>
    );
  }

  const { node, meta, counts } = parsed;
  const summary = [
    `${counts.leaf} 个条件`,
    counts.must ? `${counts.must} AND` : "",
    counts.should ? `${counts.should} OR` : "",
    counts.not ? `${counts.not} NOT` : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className={`qv ${compact ? "qv-compact" : ""}`}>
      {title && (
        <div className="qv-head">
          <span className="qv-title">{title}</span>
          <span className="qv-summary">{summary}</span>
        </div>
      )}
      {!compact && meta.length > 0 && (
        <div className="qv-meta">
          {meta.map((m) => (
            <span key={m.label} className="qv-chip">
              <em>{m.label}</em> {m.value}
            </span>
          ))}
        </div>
      )}
      <div className="qv-body">{renderNode(node, 0, "root")}</div>
    </div>
  );
}

function renderNode(n: VNode, depth: number, key: React.Key) {
  if (n.t === "bool") {
    const secMeta: Record<string, string> = { must: "AND", should: "OR", must_not: "NOT", filter: "AND·不打分" };
    return (
      <div className="qv-bool" key={key}>
        <div className="qv-bool-head">
          <span className="qv-op qv-op-bool">bool</span>
        </div>
        {n.sections.map((sec, i) => (
          <div key={i} className={`qv-section qv-sec-${sec.tone}`}>
            <div className="qv-sec-label">
              <span className="qv-sec-name">{sec.label}</span>
              <span className={`qv-sec-and qv-and-${sec.tone}`}>{secMeta[sec.label]}</span>
              {sec.hint && <span className="qv-sec-hint">{sec.hint}</span>}
              {sec.nodes.length === 0 && <span className="qv-sec-hint">空</span>}
            </div>
            {sec.nodes.map((c, j) => (
              <div key={j} className="qv-section-item">
                {renderNode(c, depth + 1, j)}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (n.t === "list") {
    return (
      <div className="qv-list" key={key}>
        <span className="qv-op qv-op-list">{n.op}</span>
        <div className="qv-list-items">
          {n.nodes.map((c, j) => (
            <div key={j}>{renderNode(c, depth + 1, j)}</div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="qv-leaf" key={key}>
      <span className={`qv-op qv-op-${n.tone}`}>{n.op}</span>
      {n.field != null && n.field !== "" && <span className="qv-field" title={n.field}>{n.field}</span>}
      {n.text && <span className="qv-val" title={n.text}>{n.text}</span>}
    </div>
  );
}
