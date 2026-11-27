import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EditorCtx, analyzeContext, getSuggestions, Suggestion } from "../lib/esDsl";
import { highlightJson } from "../lib/jsonHighlight";

// JSON DSL editor with ES-aware autocomplete:
// - overlay syntax highlighting over a transparent textarea
// - context-aware suggestions (keys / mapping fields / values / snippets)
// - auto-close brackets & quotes, smart indent, Ctrl+Enter submit

interface Props {
  value: string;
  onChange: (v: string) => void;
  fields?: { name: string; type: string }[];
  /** field name -> the values that actually occur in the index */
  valueHints?: Record<string, string[]>;
  /** called whenever the caret context changes, so the page can load values */
  onContextChange?: (ctx: EditorCtx) => void;
  /** the maximum height of the editing area */
  height?: number;
  /** shrink the editing area to fit the content (but never below this) */
  minHeight?: number;
  autoHeight?: boolean;
  placeholder?: string;
  label?: string;
  onSubmit?: () => void;
  className?: string;
}

const LINE_H = 18;
const PAD_Y = 8;
const PAD_X = 10;

export default function QueryEditor({
  value,
  onChange,
  fields,
  valueHints,
  onContextChange,
  height = 220,
  minHeight = 108,
  autoHeight = true,
  placeholder,
  label,
  onSubmit,
  className,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const charW = useRef(7.2);

  const [caret, setCaret] = useState(0);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => {
    const t = value.trim();
    if (!t) return { ok: true as const, empty: true, msg: "" };
    try {
      JSON.parse(t);
      return { ok: true as const, empty: false, msg: "" };
    } catch (e: any) {
      return { ok: false as const, empty: false, msg: String(e.message ?? e) };
    }
  }, [value]);

  const highlighted = useMemo(() => highlightJson(value + "\n"), [value]);

  /**
   * Shrink the editing area to the content so a short body does not push
   * the result area out of the window. A long body still gets the full
   * height and scrolls inside.
   */
  const shellHeight = useMemo(() => {
    if (!autoHeight) return height;
    const lines = value.split("\n").length;
    const wanted = lines * LINE_H + PAD_Y * 2 + 1;
    return Math.min(height, Math.max(minHeight, wanted));
  }, [value, height, minHeight, autoHeight]);

  // Measure monospace char width once for caret-relative dropdown placement
  useLayoutEffect(() => {
    if (measureRef.current) {
      const w = measureRef.current.getBoundingClientRect().width / 10;
      if (w > 0) charW.current = w;
    }
  }, []);

  const refreshSuggestions = useCallback(
    (text: string, pos: number, force = false) => {
      setCaret(pos);
      const ctx = analyzeContext(text, pos);
      onContextChange?.(ctx);
      let list: Suggestion[] = [];
      if (force || ctx.expecting !== "none") {
        list = getSuggestions(ctx, fields, valueHints);
      }
      if (list.length) {
        setItems(list);
        setActive(0);
        setOpen(true);
      } else {
        setOpen(false);
        setItems([]);
      }
    },
    // valueHints is part of the identity: new values have to re-run the
    // suggestion engine so the dropdown picks them up
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fields, valueHints, onContextChange]
  );

  // the values arrive after the editor asked for them - re-run the
  // suggestion engine so the dropdown picks them up
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const ctx = analyzeContext(ta.value, caret);
    const list = getSuggestions(ctx, fields, valueHints);
    if (list.length) {
      setItems(list);
      setActive(0);
      setOpen(true);
    } else if (!ctx.inString) {
      setOpen(false);
    }
  }, [valueHints, caret, fields]);

  useEffect(() => {
    // Reposition caret after programmatic value changes (auto-pairs, accepts)
    if (pendingCaret.current != null && taRef.current) {
      const pos = pendingCaret.current;
      taRef.current.selectionStart = taRef.current.selectionEnd = pos;
      pendingCaret.current = null;
      refreshSuggestions(taRef.current.value, pos);
    }
  });

  function syncScroll() {
    if (taRef.current && hlRef.current) {
      hlRef.current.scrollTop = taRef.current.scrollTop;
      hlRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  }

  function updateCaret() {
    const ta = taRef.current;
    if (!ta) return;
    refreshSuggestions(ta.value, ta.selectionStart);
  }

  function applyEdit(newText: string, caretPos: number) {
    onChange(newText);
    pendingCaret.current = caretPos;
    // optimistic: also update immediately in case no re-render happens
    requestAnimationFrame(() => {
      if (taRef.current && pendingCaret.current != null) {
        taRef.current.selectionStart = taRef.current.selectionEnd = pendingCaret.current;
        refreshSuggestions(taRef.current.value, pendingCaret.current);
        pendingCaret.current = null;
      }
    });
  }

  function acceptSuggestion(s: Suggestion) {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const text = ta.value;
    const ctx = analyzeContext(text, pos);
    let newText: string;
    let caretPos: number;
    if (ctx.inString) {
      // replace the partial content between the opening quote and the caret
      let start = pos;
      while (start > 0 && text[start - 1] !== '"') start--;
      const raw = s.label;
      newText = text.slice(0, start) + raw + text.slice(pos);
      caretPos = start + raw.length;
    } else {
      const insert = s.insert;
      const marker = insert.indexOf("§");
      const body = marker >= 0 ? insert.slice(0, marker) + insert.slice(marker + 1) : insert;
      newText = text.slice(0, pos) + body + text.slice(pos);
      caretPos = marker >= 0 ? pos + marker : pos + body.length;
    }
    applyEdit(newText, caretPos);
    setOpen(false);
    ta.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const end = ta.selectionEnd;
    const text = ta.value;

    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      onSubmit?.();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === "Space") {
      e.preventDefault();
      refreshSuggestions(text, pos, true);
      return;
    }
    if (open && items.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptSuggestion(items[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
    }
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }

    // Auto-close pairs (and wrap selection)
    const closers: Record<string, string> = { "{": "}", "[": "]", '"': '"' };
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && closers[e.key]) {
      const close = closers[e.key];
      e.preventDefault();
      if (pos !== end) {
        const sel = text.slice(pos, end);
        applyEdit(text.slice(0, pos) + e.key + sel + close + text.slice(end), pos + 1 + sel.length + 1);
      } else {
        applyEdit(text.slice(0, pos) + e.key + close + text.slice(pos), pos + 1);
      }
      return;
    }
    // Skip over an existing closer
    if ((e.key === "}" || e.key === "]" || e.key === '"') && pos === end && text[pos] === e.key && !e.ctrlKey) {
      e.preventDefault();
      pendingCaret.current = pos + 1;
      requestAnimationFrame(() => {
        if (taRef.current && pendingCaret.current != null) {
          taRef.current.selectionStart = taRef.current.selectionEnd = pendingCaret.current;
          pendingCaret.current = null;
        }
      });
      return;
    }
    // Smart indent on Enter
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const before = text.slice(0, pos);
      const after = text.slice(end);
      const lineStart = before.lastIndexOf("\n") + 1;
      const indent = /^[ \t]*/.exec(before.slice(lineStart))![0];
      const prevChar = before.trimEnd().slice(-1);
      const nextChar = after.trimStart()[0] ?? "";
      let ins: string;
      if ((prevChar === "{" && nextChar === "}") || (prevChar === "[" && nextChar === "]")) {
        ins = "\n" + indent + "  " + "\n" + indent;
      } else if (prevChar === "{" || prevChar === "[") {
        ins = "\n" + indent + "  ";
      } else {
        ins = "\n" + indent;
      }
      applyEdit(before + ins + after, pos + ins.length);
      return;
    }
    // Tab → two spaces (suggestions closed)
    if (e.key === "Tab" && !open) {
      e.preventDefault();
      const after = text.slice(end);
      applyEdit(text.slice(0, pos) + "  " + after, pos + 2);
      return;
    }
  }

  function prettify() {
    try {
      const j = JSON.parse(value.trim() || "{}");
      onChange(JSON.stringify(j, null, 2));
      pendingCaret.current = 0;
    } catch {
      /* parseError already shown in footer */
    }
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  // ---- dropdown position ----------------------------------------------------
  const dropPos = useMemo(() => {
    const before = value.slice(0, caret);
    const nl = before.lastIndexOf("\n");
    const line = (before.match(/\n/g) ?? []).length;
    const col = nl >= 0 ? before.length - nl - 1 : before.length;
    const ta = taRef.current;
    const st = ta?.scrollTop ?? 0;
    const sl = ta?.scrollLeft ?? 0;
    return {
      top: PAD_Y + (line + 1) * LINE_H - st,
      left: Math.max(4, PAD_X + col * charW.current - sl),
    };
  }, [caret, value, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open && listRef.current) {
      const el = listRef.current.querySelector<HTMLElement>(".qe-item.active");
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [active, open]);

  const showEditorChrome = label !== undefined ? !!label : true;

  return (
    <div className={`qe ${className ?? ""}`}>
      {showEditorChrome && (
        <div className="qe-head">
          <span className="qe-title">{label ?? "JSON"}</span>
          <span className="qe-status">
            {parsed.empty ? (
              <span className="qe-tag qe-tag-idle">空</span>
            ) : parsed.ok ? (
              <span className="qe-tag qe-tag-ok">✓ JSON 有效</span>
            ) : (
              <span className="qe-tag qe-tag-err" title={parsed.msg}>
                ✕ JSON 错误
              </span>
            )}
          </span>
          <span className="qe-actions">
            <button type="button" className="btn btn-xs" onClick={prettify} title="格式化 JSON">
              格式化
            </button>
            <button type="button" className="btn btn-xs" onClick={copyAll} title="复制内容">
              {copied ? "已复制" : "复制"}
            </button>
          </span>
        </div>
      )}
      <div className="qe-shell" style={{ height: shellHeight }}>
        <pre ref={hlRef} className="qe-hl" aria-hidden>
          {highlighted}
        </pre>
        <textarea
          ref={taRef}
          className="qe-ta"
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v);
            refreshSuggestions(v, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onSelect={updateCaret}
          onClick={updateCaret}
          onScroll={syncScroll}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="soft"
        />
        {open && items.length > 0 && (
          <ul
            ref={listRef}
            className="qe-list"
            style={{ top: dropPos.top, left: dropPos.left }}
            role="listbox"
          >
            {items.map((s, i) => (
              <li
                key={s.kind + s.label + i}
                className={`qe-item ${i === active ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  acceptSuggestion(s);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className={`qe-icon qe-icon-${s.kind}`}>
                  {s.kind === "field" ? "f" : s.kind === "snippet" ? "{}" : s.kind === "value" ? "=" : "K"}
                </span>
                <span className="qe-label">{s.label}</span>
                {s.detail && <span className="qe-detail">{s.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        <span ref={measureRef} className="qe-measure" aria-hidden>
          0000000000
        </span>
      </div>
      <div className="qe-foot">
        <span className="muted">
          Ctrl+Space 补全 · Tab/Enter 采纳 · Ctrl+Enter {onSubmit ? "执行" : "换行"}
        </span>
        {!parsed.ok && !parsed.empty && <span className="qe-error" title={parsed.msg}>⚠ {parsed.msg}</span>}
      </div>
    </div>
  );
}
