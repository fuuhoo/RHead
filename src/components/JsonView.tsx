import { useState } from "react";
import { highlightJson } from "../lib/jsonHighlight";

// Syntax-highlighted, collapsible JSON viewer (replaces ui/JsonPretty).
// Nested objects/arrays collapse individually; deep levels start collapsed.

interface Props {
  data: any;
  title?: string;
  /** Levels expanded by default; deeper containers start collapsed. */
  defaultDepth?: number;
}

export default function JsonView({ data, title, defaultDepth = 2 }: Props) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  if (data == null) return <div className="empty">无数据</div>;
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const bytes = new Blob([text]).size;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  const body =
    typeof data === "string" ? (
      <pre className="json-pre">{text}</pre>
    ) : (
      <pre className="json-pre">
        <JsonNode value={data} depth={0} defaultDepth={defaultDepth} />
      </pre>
    );

  return (
    <div className="json-panel">
      <div className="json-panel-head">
        <button className="json-panel-toggle" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {title ?? "JSON"}
        </button>
        <span className="json-panel-meta">{formatBytes(bytes)}</span>
        <button className="btn btn-xs json-panel-copy" onClick={copy}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      {open && body}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function JsonNode({ value, depth, defaultDepth }: { value: any; depth: number; defaultDepth: number }) {
  const isCollapsible =
    value != null && typeof value === "object" && Object.keys(value).length > 0;
  const [expanded, setExpanded] = useState(depth < defaultDepth);

  if (!isCollapsible) {
    if (value == null) return <span className="jn">null</span>;
    if (typeof value === "string") {
      const cls = value.length > 200 ? "js js-long" : "js";
      return <span className={cls}>{JSON.stringify(value)}</span>;
    }
    if (typeof value === "number") return <span className="jnum">{String(value)}</span>;
    if (typeof value === "boolean") return <span className="jb">{String(value)}</span>;
    return <span>{String(value)}</span>;
  }

  const isArr = Array.isArray(value);
  const entries: [string, any][] = isArr
    ? (value as any[]).map((v, i) => [String(i), v])
    : Object.entries(value);
  const openCh = isArr ? "[" : "{";
  const closeCh = isArr ? "]" : "}";

  if (!expanded) {
    return (
      <span className="json-collapsed" onClick={() => setExpanded(true)} title="点击展开">
        {openCh}
        <span className="json-collapse-badge">
          {isArr ? `${value.length} 项` : `${entries.length} 键`}
        </span>
        {closeCh}
      </span>
    );
  }

  return (
    <span className="json-block">
      <span className="json-brace" onClick={() => setExpanded(false)} title="点击折叠">
        {openCh}
      </span>
      <span className="json-children">
        {entries.map(([k, v], i) => (
          <span className="json-line" key={k + i}>
            {!isArr && <span className="jk">{JSON.stringify(k)}</span>}
            {!isArr && <span className="json-colon">: </span>}
            <JsonNode value={v} depth={depth + 1} defaultDepth={defaultDepth} />
            {i < entries.length - 1 && <span className="json-comma">,</span>}
            {"\n"}
          </span>
        ))}
      </span>
      <span className="json-brace json-brace-close">{closeCh}</span>
    </span>
  );
}

// re-export the flat highlighter for text-mode previews
export { highlightJson };
