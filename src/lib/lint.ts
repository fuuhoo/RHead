// Smart hints for the free-form request body of the composite query page.
//
// Two kinds of checks:
//   * structural - things that are wrong or risky regardless of the cluster
//   * mapping aware - things that only show up when the field is compared
//     against the real mapping of the target index
//
// The mapping aware checks need the mapping of the index in the path, so the
// page fetches it and hands it in.

/** One hint about the request. */
export interface LintHint {
  level: "error" | "warn" | "info";
  title: string;
  detail?: string;
  /** where in the body the problem is, e.g. "query.term.deviceId" */
  at?: string;
  /** an action the user can apply with one click */
  fix?: { label: string; body: any };
}

/** What is known about a field. */
export interface FieldInfo {
  type: string;
  /** false when doc_values is disabled - sorting on it fails */
  docValues: boolean;
  index: boolean;
}

export type FieldMap = Record<string, FieldInfo>;

export interface LintContext {
  /** the fields of the target index (empty when the mapping is unknown) */
  fields: FieldMap;
  /** the index names taken from the path */
  indices: string[];
  /** false when the target index does not exist */
  indexExists: boolean;
  /** index.max_result_window of the target index */
  maxResultWindow: number;
  /** true when the mapping could be read */
  mappingKnown: boolean;
}

export const DEFAULT_MAX_RESULT_WINDOW = 10000;

import { Connection, esGet } from "./es";

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Flatten a `_mapping` response into a field lookup.
 *
 * ES 7+/8: { index: { mappings: { properties: { ... } } } }
 * Older ES: { index: { mappings: { typeName: { properties: { ... } } } } }
 */
export function buildFieldMap(mappingJson: any): FieldMap {
  const out: FieldMap = {};
  if (!mappingJson || typeof mappingJson !== "object") return out;

  for (const idxDef of Object.values(mappingJson as any[])) {
    const m = idxDef?.mappings ?? idxDef;
    if (!m || typeof m !== "object") continue;
    const roots = m.properties
      ? [m]
      : Object.values(m).filter((t: any) => t && typeof t === "object" && t.properties);
    for (const root of roots as any[]) walkProps(root.properties, "", out);
  }
  return out;
}

function walkProps(props: any, prefix: string, out: FieldMap) {
  if (!props || typeof props !== "object") return;
  for (const [name, def] of Object.entries(props) as [string, any][]) {
    const full = prefix ? `${prefix}.${name}` : name;
    if (def?.type) {
      out[full] = {
        type: def.type,
        docValues: def.doc_values !== false,
        index: def.index !== false,
      };
    }
    if (def?.properties) walkProps(def.properties, full, out);
    if (def?.fields) walkProps(def.fields, full, out);
  }
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

/** The index part of an ES path, e.g. "logs-x/metrics-y/_search" -> "logs-x,metrics-y". */
export function indicesFromPath(path: string): string[] {
  const clean = path.replace(/^\/+/, "").split("?")[0];
  if (!clean) return [];
  const first = clean.split("/")[0];
  if (!first || first.startsWith("_")) return [];
  return first.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * The index names of the cluster.
 *
 * Used to suggest an index for the request path - searching the whole
 * cluster when one index was meant is the most common mistake.
 */
export async function fetchIndexNames(conn: Connection): Promise<string[]> {
  const r = await esGet(conn, "_cat/indices?format=json&h=index");
  if (r.status >= 400) return [];
  return ((r.json ?? []) as any[])
    .map((x) => String(x?.index ?? ""))
    .filter(Boolean)
    .sort();
}

/**
 * The indices whose name matches the text the user typed.
 *
 * The path input holds things like `my-index/_search`, so only the part
 * before the first slash is matched.
 */
export function matchIndexNames(names: string[], text: string, limit = 20): string[] {
  const q = text.trim().toLowerCase();
  if (!q) return names.slice(0, limit);
  const starts: string[] = [];
  const contains: string[] = [];
  for (const n of names) {
    const lower = n.toLowerCase();
    if (lower.startsWith(q)) starts.push(n);
    else if (lower.includes(q)) contains.push(n);
  }
  return [...starts, ...contains].slice(0, limit);
}

// ---------------------------------------------------------------------------
// The analyzer
// ---------------------------------------------------------------------------

/** Query clauses whose value is a { field: ... } object. */
const FIELD_CLAUSES = new Set([
  "term",
  "terms",
  "terms_set",
  "match",
  "match_phrase",
  "match_phrase_prefix",
  "multi_match",
  "range",
  "exists",
  "wildcard",
  "prefix",
  "regexp",
  "fuzzy",
  "ids",
  "prefix_query",
]);

export function lintRequest(bodyText: string, path: string, ctx: LintContext): LintHint[] {
  const hints: LintHint[] = [];

  const text = bodyText.trim();
  if (!text) return hints;

  let body: any;
  try {
    body = JSON.parse(text);
  } catch (e: any) {
    hints.push({
      level: "error",
      title: "JSON 语法错误：" + (e?.message ?? String(e)),
      detail: "请求体不是合法的 JSON，提交请求会失败。",
    });
    return hints;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return hints;

  checkPath(path, ctx, hints);
  checkBody(body, "", ctx, hints);

  return hints;
}

function checkPath(path: string, ctx: LintContext, hints: LintHint[]) {
  const indices = indicesFromPath(path);
  if (!indices.length) {
    const looksLikeSearch = /_search|_count|_msearch|_field_caps/.test(path);
    if (looksLikeSearch) {
      hints.push({
        level: "warn",
        title: "路径里没有指定索引，会搜索集群里的全部索引",
        detail:
          "写成 `目标索引/_search` 可以少扫很多分片，快得多。多个索引用逗号分隔。",
        at: "path",
      });
    }
    return;
  }
  if (!ctx.indexExists) {
    hints.push({
      level: "error",
      title: `索引 ${indices.join(", ")} 不存在`,
      detail: "索引名写错，或者索引已经被删除了。",
      at: "path",
    });
  }
  // a wildcard that matches nothing is common when the pattern is wrong
  if (indices.some((i) => i.includes("*"))) {
    hints.push({
      level: "info",
      title: "路径里用了通配符索引",
      detail: "通配符会展开成多个实际索引，命中范围和性能都不如直接写具体索引。",
      at: "path",
    });
  }
}

function checkBody(body: any, at: string, ctx: LintContext, hints: LintHint[]) {
  // ---- paging ----
  const from = num(body.from);
  const size = num(body.size);
  if (from != null && size != null) {
    const limit = ctx.maxResultWindow || DEFAULT_MAX_RESULT_WINDOW;
    if (from + size > limit) {
      hints.push({
        level: "error",
        title: `from + size = ${from + size}，超过 max_result_window（${limit}）`,
        detail:
          "ES 会直接拒绝这个请求。深分页请用 search_after 或 scroll/PIT，" +
          "并且带上 \"track_total_hits\": true 拿到精确总数。",
        at: at ? `${at}.from` : "from",
      });
    }
  }
  if (size != null && size > 100) {
    hints.push({
      level: "info",
      title: `size = ${size} 偏大`,
      detail: "一次拉太多文档会拖慢查询，通常 50~100 就够看了。",
      at: at ? `${at}.size` : "size",
    });
  }

  // ---- total hits ----
  if (body.query != null && body.track_total_hits === undefined) {
    hints.push({
      level: "info",
      title: "没有设置 track_total_hits，命中总数最多只到 10000",
      detail:
        'ES 默认把 hits.total 截断在 10000。要精确的总数，加 "track_total_hits": true。',
      at: "track_total_hits",
      fix: { label: "加上 track_total_hits: true", body: { ...body, track_total_hits: true } },
    });
  }

  // ---- deprecated / removed keys ----
  if (body.query?.filtered != null) {
    hints.push({
      level: "error",
      title: "filtered 查询在 ES 7 已经被删除了",
      detail: "改成 bool 查询：把 query 放进 must，把 filter 放进 filter。",
      at: "query.filtered",
    });
  }
  if (body.indices_boost != null || body.query?.indices_boost != null) {
    hints.push({
      level: "warn",
      title: "indices_boost 在 ES 5 之后被移除了",
      detail: "用 sort 里的 _index 排序加上自己的 boost 值来代替。",
    });
  }
  if (body.query?.match_all?.boost != null) {
    hints.push({
      level: "info",
      title: "match_all 上的 boost 没有意义",
      detail: "match_all 命中所有文档，再乘一个系数结果一样。",
      at: "query.match_all.boost",
    });
  }

  // ---- source filtering ----
  if (body.query != null && body._source === undefined && size != null) {
    hints.push({
      level: "info",
      title: "没有过滤 _source，会把整个文档拉回来",
      detail: '只需要部分字段时用 "_source": ["字段1", "字段2"]，能少很多网络流量。',
      at: "_source",
    });
  }

  // ---- sort ----
  if (Array.isArray(body.sort)) {
    for (let i = 0; i < body.sort.length; i++) {
      const s = body.sort[i];
      if (!s || typeof s !== "object") continue;
      for (const [field] of Object.entries(s)) {
        if (field === "_score" || field === "_doc" || field.startsWith("_")) continue;
        const info = ctx.fields[field];
        if (info && !info.docValues) {
          hints.push({
            level: "error",
            title: `字段 ${field} 关掉了 doc_values，不能用来排序`,
            detail: "排序会直接报错。要排序的话要么打开 doc_values，要么改用 keyword 子字段。",
            at: `sort.${i}.${field}`,
          });
        }
      }
    }
  }

  // ---- the query itself ----
  if (body.query != null) walkQuery(body.query, "query", ctx, hints);

  // ---- aggregations ----
  if (body.aggs || body.aggregations) {
    const aggs = body.aggs ?? body.aggregations;
    for (const [name, def] of Object.entries(aggs ?? {})) {
      const agg = def as any;
      if (agg?.terms?.field) {
        const info = ctx.fields[agg.terms.field];
        if (info && info.type === "text") {
          hints.push({
            level: "warn",
            title: `聚合字段 ${agg.terms.field} 是 text 类型`,
            detail:
              "text 字段被分词了，按它聚合会按词分组而不是按值。" +
              "改用它的 keyword 子字段，或把该字段的 mapping 改成 keyword。",
            at: `aggs.${name}.terms.field`,
          });
        }
      }
    }
  }
}

function walkQuery(q: any, at: string, ctx: LintContext, hints: LintHint[]) {
  if (!q || typeof q !== "object") return;

  for (const [key, value] of Object.entries(q) as [string, any][]) {
    const here = `${at}.${key}`;

    if (key === "bool") {
      const b = value ?? {};
      for (const part of ["must", "filter", "should", "must_not"] as const) {
        const list = Array.isArray(b[part]) ? b[part] : b[part] ? [b[part]] : [];
        for (const sub of list) {
          walkQuery(sub, `${here}.${part}`, ctx, hints);
          // a clause that only filters could be a cacheable filter
          if (part === "must" && isFilterOnly(sub)) {
            hints.push({
              level: "info",
              title: `must 里的子句只做过滤，放到 filter 里能被缓存`,
              detail:
                "只用于过滤、不参与打分和排序的条件写在 filter 里可以命中 filter cache，" +
                "查询会快不少。",
              at: `${here}.${part}`,
            });
          }
        }
      }
      continue;
    }

    if (key === "nested") {
      const path = value?.path;
      if (path && ctx.mappingKnown && !ctx.fields[path]) {
        hints.push({
          level: "error",
          title: `nested 路径 ${path} 不在 mapping 里`,
          detail: "nested 查询的路径必须是 mapping 里 type 为 nested 的字段。",
          at: `${here}.path`,
        });
      }
      if (value?.query) walkQuery(value.query, `${here}.query`, ctx, hints);
      continue;
    }

    if (key === "constant_score") {
      if (value?.filter) walkQuery(value.filter, `${here}.filter`, ctx, hints);
      continue;
    }

    if (key === "function_score" || key === "script_score") {
      if (value?.query) walkQuery(value.query, `${here}.query`, ctx, hints);
      if (value?.filter) walkQuery(value.filter, `${here}.filter`, ctx, hints);
      checkScript(value, here, hints);
      continue;
    }

    if (key === "query_string" || key === "simple_query_string") {
      const q2 = value?.query;
      const fields: string[] = Array.isArray(value?.fields) ? value.fields : [];
      for (const f of fields) {
        const info = ctx.fields[f];
        if (info && info.type === "text") {
          hints.push({
            level: "info",
            title: `query_string 的字段 ${f} 是 text 类型`,
            detail:
              "text 字段会被分词后再匹配。精确匹配一个值的话，" +
              "用 term 查询它的 keyword 子字段更准也更快。",
            at: `${here}.fields`,
          });
        }
      }
      if (typeof q2 === "string" && /[+\-=&|><{}()[\]^"~*?:\\/]/.test(q2)) {
        hints.push({
          level: "warn",
          title: "query_string 的值里有特殊字符，会被当成查询语法",
          detail:
            "比如 `+`、`-`、`|`、括号在 query_string 里是运算符，不是普通字符。" +
            "想按字面匹配就改用 simple_query_string，或者用 term 查询。",
          at: `${here}.query`,
        });
      }
      continue;
    }

    if (key === "script" || key === "script_score") {
      checkScript({ script: value }, here, hints);
      continue;
    }

    if (key === "exists") {
      const field = value?.field;
      if (field && ctx.mappingKnown && !ctx.fields[field]) {
        hints.push({
          level: "warn",
          title: `exists 查询的字段 ${field} 不在 mapping 里`,
          detail: "mapping 里没有这个字段，exists 永远不会匹配到任何文档。",
          at: `${here}.field`,
        });
      }
      continue;
    }

    if (key === "terms_set") {
      const field = firstKey(value);
      if (field) checkFieldUsage(key, field, value, here, ctx, hints);
      continue;
    }

    if (FIELD_CLAUSES.has(key)) {
      if (key === "ids") continue;
      const field = firstKey(value);
      if (field) checkFieldUsage(key, field, value, here, ctx, hints);
      continue;
    }

    // unknown clause - keep looking, some queries nest deeper
    if (value && typeof value === "object" && !Array.isArray(value)) {
      walkQuery(value, here, ctx, hints);
    }
  }
}

function firstKey(value: any): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  return keys.length ? keys[0] : null;
}

function checkFieldUsage(
  clause: string,
  field: string,
  value: any,
  at: string,
  ctx: LintContext,
  hints: LintHint[]
) {
  if (!ctx.mappingKnown) return;
  const info = ctx.fields[field];
  if (!info) {
    hints.push({
      level: "warn",
      title: `字段 ${field} 不在目标索引的 mapping 里`,
      detail:
        "拼错字段名，或者这个字段在另一个索引里。" +
        "用不存在的字段查询，结果一定是空的。",
      at: `${at}.${field}`,
    });
    return;
  }

  const raw = value?.[field];
  const text = typeof raw === "string" ? raw : raw?.query;

  switch (clause) {
    case "term":
      if (info.type === "text") {
        hints.push({
          level: "error",
          title: `term 查询用在了 text 字段 ${field} 上`,
          detail:
            "text 字段被分词过，term 查的是分词后的某个词元，" +
            "几乎匹配不到原始值。改用 match，或者查它的 keyword 子字段。",
          at: `${at}.${field}`,
        });
      }
      break;
    case "match":
      if (info.type === "keyword") {
        hints.push({
          level: "warn",
          title: `match 查询用在了 keyword 字段 ${field} 上`,
          detail:
            "keyword 字段不分词，整个值就是一个词元，" +
            "match 的分析器对它不起作用。精确匹配用 term 更快。",
          at: `${at}.${field}`,
        });
      }
      if (info.type === "keyword" && typeof text === "string" && /\s/.test(text)) {
        hints.push({
          level: "error",
          title: `keyword 字段 ${field} 上用 match 匹配一个带空格的词`,
          detail:
            "keyword 字段的值里如果有空格，标准分析器会拆成多个词元，" +
            "match 就匹配不到了。要整体匹配请用 term。",
          at: `${at}.${field}`,
        });
      }
      break;
    case "wildcard":
    case "regexp":
    case "prefix":
      if (info.type === "keyword") {
        hints.push({
          level: "warn",
          title: `${clause} 查询用在了 keyword 字段 ${field} 上`,
          detail:
            "通配符和正则会遍历所有词元，keyword 字段上很慢。" +
            "能确定前缀就用 prefix；要模糊匹配的话，给字段加 edge_ngram " +
            "子字段来查会快得多。",
          at: `${at}.${field}`,
        });
      }
      break;
    case "range":
      if (info.type === "date") {
        const v = raw?.gte ?? raw?.gt ?? raw?.lte ?? raw?.lt;
        if (typeof v === "string" && !/^\d{4}-\d{2}-\d{2}/.test(v) && !/^\d+$/.test(v)) {
          hints.push({
            level: "warn",
            title: `日期字段 ${field} 上的范围值 "${v}" 不像日期格式`,
            detail:
              "date 字段默认接受 `2024-01-01` 或 `2024-01-01T00:00:00` 这种格式，" +
              "也支持 epoch 毫秒数。写别的格式要配 format 参数。",
            at: `${at}.${field}`,
          });
        }
      }
      if (info.type === "text") {
        hints.push({
          level: "warn",
          title: `range 查询用在了 text 字段 ${field} 上`,
          detail: "text 字段被分词了，范围比较没有意义。改用 keyword 子字段。",
          at: `${at}.${field}`,
        });
      }
      break;
    case "match_phrase":
      if (info.type === "keyword") {
        hints.push({
          level: "info",
          title: `match_phrase 用在了 keyword 字段 ${field} 上`,
          detail: "keyword 不分词，短语查询等价于 term 查询。",
          at: `${at}.${field}`,
        });
      }
      break;
  }
}

function checkScript(value: any, at: string, hints: LintHint[]) {
  const script = value?.script;
  if (!script) return;
  const src = typeof script === "string" ? script : script.source;
  if (typeof src !== "string") return;
  hints.push({
    level: "warn",
    title: "脚本查询不能被缓存，而且有安全风险",
    detail:
      "script 过滤条件每次都要执行，无法命中 filter cache；" +
      "如果脚本来自用户输入，还可能被注入。尽量改成普通的 term/range 条件。",
    at: `${at}.script`,
  });
}

/** True when a clause only filters and does not contribute to the score. */
function isFilterOnly(clause: any): boolean {
  if (!clause || typeof clause !== "object") return false;
  const keys = Object.keys(clause);
  if (keys.length !== 1) return false;
  const k = keys[0];
  return ["term", "terms", "exists", "range", "prefix", "wildcard", "regexp", "ids"].includes(k);
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
