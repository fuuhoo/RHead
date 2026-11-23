// Shared JSON tokenizer for syntax highlighting (JsonView + QueryEditor).
import type { ReactNode } from "react";

export function highlightJson(json: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(json))) {
    if (m.index > last) parts.push(json.slice(last, m.index));
    const tok = m[0];
    const cls = tok.startsWith('"')
      ? tok.endsWith(":") || /"\s*:$/.test(tok)
        ? "jk"
        : "js"
      : /true|false/.test(tok)
        ? "jb"
        : /null/.test(tok)
          ? "jn"
          : "jnum";
    parts.push(
      <span key={k++} className={cls}>
        {tok}
      </span>
    );
    last = m.index + tok.length;
  }
  if (last < json.length) parts.push(json.slice(last));
  return parts;
}
