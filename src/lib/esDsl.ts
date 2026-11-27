// ES Query DSL knowledge base: context analysis + suggestion engine.
// Used by <QueryEditor /> to provide schema-aware autocomplete inside
// raw JSON search bodies. No external dependency; pure text scanning.

export type SuggKind = "key" | "field" | "value" | "snippet";

export interface Suggestion {
  /** Primary label — also the raw text inserted when the caret is inside a string. */
  label: string;
  /** Muted description shown on the right of the dropdown row. */
  detail?: string;
  kind: SuggKind;
  /** Full text inserted at a bare (non-string) position. `§` marks caret placement. */
  insert: string;
}

export interface EditorCtx {
  /** What the caret is waiting for at its current position. */
  expecting: "key" | "value" | "none";
  /** Caret is inside a string literal. */
  inString: boolean;
  /** Content between the opening quote and the caret (empty when not inString). */
  partial: string;
  /** Object-key path from the root to the innermost container, e.g. ["query","bool","must"]. */
  keyStack: string[];
  /** When expecting a value: the key whose value is being edited. */
  parentKey: string | null;
  /** The innermost container is an array. */
  inArray: boolean;
  /** Index of the opening quote when inString, else null. */
  stringStart: number | null;
}

/** Scan text up to `caret` and recover the JSON structural context. */
export function analyzeContext(text: string, caret: number): EditorCtx {
  const n = Math.min(Math.max(caret, 0), text.length);
  interface Frame {
    type: "obj" | "arr";
    key: string | null;
    idx: number;
  }
  const stack: Frame[] = [];
  let inString = false;
  let isKey = false;
  let escaped = false;
  let strContent = "";
  let curKey: string | null = null;
  let lastSig = ""; // last significant (non-whitespace) char outside strings
  const top = () => stack[stack.length - 1];

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        if (isKey) {
          curKey = strContent;
          isKey = false;
        }
      } else strContent += ch;
      continue;
    }
    if (/\s/.test(ch)) continue;
    switch (ch) {
      case '"':
        inString = true;
        strContent = "";
        isKey = (stack.length === 0 || top().type === "obj") && (lastSig === "{" || lastSig === ",");
        break;
      case "{":
        stack.push({ type: "obj", key: curKey, idx: 0 });
        curKey = null;
        break;
      case "[":
        stack.push({ type: "arr", key: curKey, idx: 0 });
        curKey = null;
        break;
      case "}":
      case "]": {
        const f = stack.pop();
        if (f) curKey = f.key;
        break;
      }
      case ",":
        if (top()?.type === "arr") top()!.idx++;
        else curKey = null;
        break;
      default:
        break; // numbers / true / false / null — lastSig tracking covers them
    }
    lastSig = ch;
  }

  const keyStack = stack.map((f) => f.key).filter((k): k is string => k != null);
  const t = top();
  const inArray = t?.type === "arr";

  if (inString) {
    // A value string inherits the key we're under; a key string has none.
    return {
      expecting: isKey ? "key" : "value",
      inString: true,
      partial: strContent,
      keyStack,
      parentKey: isKey ? null : curKey,
      inArray,
      stringStart: null,
    };
  }
  const base = { inString: false, partial: "", keyStack, inArray, stringStart: null };
  if (lastSig === "{" || lastSig === ",") {
    if (inArray) {
      return { ...base, expecting: "value", parentKey: t!.key };
    }
    return { ...base, expecting: "key", parentKey: null };
  }
  if (lastSig === ":") {
    return { ...base, expecting: "value", parentKey: curKey };
  }
  if (lastSig === "[") {
    // The array frame was pushed with the owning key, which curKey no longer holds.
    return { ...base, expecting: "value", parentKey: t?.key ?? null };
  }
  return { ...base, expecting: "none", parentKey: null };
}

// ---------------------------------------------------------------------------
// Knowledge tables
// ---------------------------------------------------------------------------

/** Query types whose value is a { field: value } map. */
const FIELD_MAP_TYPES = new Set([
  "match",
  "match_phrase",
  "match_phrase_prefix",
  "term",
  "terms",
  "range",
  "wildcard",
  "prefix",
  "fuzzy",
  "regexp",
]);

interface QueryTypeSpec {
  label: string;
  detail: string;
  /** Full object insert, e.g. `{ "term": { "§": "" } }`. */
  insert: string;
}

const QUERY_TYPES: QueryTypeSpec[] = [
  { label: "bool", detail: "组合查询 must / should / filter / must_not", insert: `{ "bool": { "must": [] } }` },
  { label: "match", detail: "全文匹配（分词）", insert: `{ "match": { "§": "" } }` },
  { label: "match_all", detail: "匹配全部文档", insert: `{ "match_all": {} }` },
  { label: "term", detail: "精确匹配（不分词）", insert: `{ "term": { "§": "" } }` },
  { label: "terms", detail: "多值精确匹配", insert: `{ "terms": { "§": [] } }` },
  { label: "range", detail: "范围查询 gte/gt/lte/lt", insert: `{ "range": { "§": { "gte": "", "lte": "" } } }` },
  { label: "exists", detail: "字段存在", insert: `{ "exists": { "field": "§" } }` },
  { label: "wildcard", detail: "通配符匹配", insert: `{ "wildcard": { "§": "*" } }` },
  { label: "prefix", detail: "前缀匹配", insert: `{ "prefix": { "§": "" } }` },
  { label: "fuzzy", detail: "模糊匹配（容错）", insert: `{ "fuzzy": { "§": "" } }` },
  { label: "regexp", detail: "正则匹配", insert: `{ "regexp": { "§": "" } }` },
  { label: "ids", detail: "按 _id 查询", insert: `{ "ids": { "values": [§] } }` },
  { label: "match_phrase", detail: "短语匹配", insert: `{ "match_phrase": { "§": "" } }` },
  { label: "match_phrase_prefix", detail: "短语前缀匹配", insert: `{ "match_phrase_prefix": { "§": "" } }` },
  { label: "multi_match", detail: "多字段匹配", insert: `{ "multi_match": { "query": "§", "fields": [] } }` },
  { label: "query_string", detail: "lucene 查询语法", insert: `{ "query_string": { "query": "§" } }` },
  { label: "simple_query_string", detail: "容错版查询语法", insert: `{ "simple_query_string": { "query": "§" } }` },
  { label: "nested", detail: "嵌套对象查询", insert: `{ "nested": { "path": "§", "query": { "match_all": {} } } }` },
  { label: "constant_score", detail: "固定得分", insert: `{ "constant_score": { "filter": § } }` },
  { label: "dis_max", detail: "取最高分", insert: `{ "dis_max": { "queries": [] } }` },
  { label: "function_score", detail: "自定义打分", insert: `{ "function_score": { "query": { "match_all": {} } } }` },
];

const BOOL_KEYS: Suggestion[] = [
  { label: "must", detail: "AND — 全部满足", kind: "key", insert: `"must": []` },
  { label: "should", detail: "OR — 满足其一（影响得分）", kind: "key", insert: `"should": []` },
  { label: "filter", detail: "AND — 过滤不打分", kind: "key", insert: `"filter": []` },
  { label: "must_not", detail: "NOT — 全部不满足", kind: "key", insert: `"must_not": []` },
  { label: "minimum_should_match", detail: "should 至少满足几个", kind: "key", insert: `"minimum_should_match": "§"` },
  { label: "boost", detail: "权重", kind: "key", insert: `"boost": §` },
];

interface AggSpec {
  label: string;
  detail: string;
  /** inner template, inserted after name when providing name+type at once */
  tpl: string;
}

const AGG_TYPES: AggSpec[] = [
  { label: "terms", detail: "桶 — 按字段值分组", tpl: `"terms": { "field": "§", "size": 10 }` },
  { label: "avg", detail: "指标 — 平均值", tpl: `"avg": { "field": "§" }` },
  { label: "sum", detail: "指标 — 求和", tpl: `"sum": { "field": "§" }` },
  { label: "min", detail: "指标 — 最小值", tpl: `"min": { "field": "§" }` },
  { label: "max", detail: "指标 — 最大值", tpl: `"max": { "field": "§" }` },
  { label: "stats", detail: "指标 — min/max/avg/sum", tpl: `"stats": { "field": "§" }` },
  { label: "cardinality", detail: "指标 — 去重计数", tpl: `"cardinality": { "field": "§" }` },
  { label: "value_count", detail: "指标 — 计数", tpl: `"value_count": { "field": "§" }` },
  { label: "percentiles", detail: "指标 — 分位数", tpl: `"percentiles": { "field": "§" }` },
  { label: "date_histogram", detail: "桶 — 按时间分桶", tpl: `"date_histogram": { "field": "§", "calendar_interval": "month" }` },
  { label: "histogram", detail: "桶 — 按数值区间", tpl: `"histogram": { "field": "§", "interval": 10 }` },
  { label: "range", detail: "桶 — 自定义区间", tpl: `"range": { "field": "§", "ranges": [] }` },
  { label: "filter", detail: "桶 — 条件过滤", tpl: `"filter": { "term": { "§": "" } }` },
  { label: "nested", detail: "桶 — 进入嵌套文档", tpl: `"nested": { "path": "§" }` },
  { label: "top_hits", detail: "桶 — 分组取 top N", tpl: `"top_hits": { "size": 3 }` },
  { label: "missing", detail: "桶 — 缺失该字段的文档", tpl: `"missing": { "field": "§" }` },
];

const AGG_OPTION_KEYS: Record<string, Suggestion[]> = {
  terms: [
    { label: "field", detail: "分组字段", kind: "key", insert: `"field": "§"` },
    { label: "size", detail: "返回桶数量", kind: "key", insert: `"size": §` },
    { label: "order", detail: "桶排序", kind: "key", insert: `"order": { "_count": "desc" }` },
    { label: "min_doc_count", detail: "桶最小文档数", kind: "key", insert: `"min_doc_count": §` },
    { label: "include", detail: "值白名单（正则）", kind: "key", insert: `"include": "§"` },
    { label: "exclude", detail: "值黑名单（正则）", kind: "key", insert: `"exclude": "§"` },
    { label: "missing", detail: "缺失时取值", kind: "key", insert: `"missing": "§"` },
    { label: "aggs", detail: "子聚合", kind: "key", insert: `"aggs": {}` },
  ],
  date_histogram: [
    { label: "field", detail: "时间字段", kind: "key", insert: `"field": "§"` },
    { label: "calendar_interval", detail: "日历间隔 year/quarter/month/week/day/hour", kind: "key", insert: `"calendar_interval": "§"` },
    { label: "fixed_interval", detail: "固定间隔，如 30d / 1h", kind: "key", insert: `"fixed_interval": "§"` },
    { label: "format", detail: "返回格式", kind: "key", insert: `"format": "§"` },
    { label: "min_doc_count", detail: "桶最小文档数", kind: "key", insert: `"min_doc_count": §` },
    { label: "time_zone", detail: "时区，如 +08:00", kind: "key", insert: `"time_zone": "§"` },
    { label: "aggs", detail: "子聚合", kind: "key", insert: `"aggs": {}` },
  ],
  histogram: [
    { label: "field", detail: "数值字段", kind: "key", insert: `"field": "§"` },
    { label: "interval", detail: "步长", kind: "key", insert: `"interval": §` },
    { label: "min_doc_count", detail: "桶最小文档数", kind: "key", insert: `"min_doc_count": §` },
    { label: "aggs", detail: "子聚合", kind: "key", insert: `"aggs": {}` },
  ],
  top_hits: [
    { label: "size", detail: "每组返回条数", kind: "key", insert: `"size": §` },
    { label: "sort", detail: "组内排序", kind: "key", insert: `"sort": []` },
    { label: "_source", detail: "返回字段", kind: "key", insert: `"_source": []` },
  ],
};

const GENERIC_AGG_KEYS: Suggestion[] = [
  { label: "field", detail: "聚合字段", kind: "key", insert: `"field": "§"` },
  { label: "missing", detail: "缺失时取值", kind: "key", insert: `"missing": "§"` },
  { label: "script", detail: "脚本计算", kind: "key", insert: `"script": { "source": "§" }` },
  { label: "aggs", detail: "子聚合", kind: "key", insert: `"aggs": {}` },
];

const TOP_LEVEL: Suggestion[] = [
  { label: "query", detail: "查询条件", kind: "key", insert: `"query": { "match_all": {} }` },
  { label: "aggs", detail: "聚合分析", kind: "key", insert: `"aggs": {}` },
  { label: "sort", detail: "排序", kind: "key", insert: `"sort": []` },
  { label: "size", detail: "返回条数", kind: "key", insert: `"size": §` },
  { label: "from", detail: "分页起点", kind: "key", insert: `"from": §` },
  { label: "_source", detail: "返回字段控制", kind: "key", insert: `"_source": []` },
  { label: "track_total_hits", detail: "精确统计命中总数", kind: "key", insert: `"track_total_hits": true` },
  { label: "highlight", detail: "高亮", kind: "key", insert: `"highlight": { "fields": {} }` },
  { label: "collapse", detail: "字段折叠去重", kind: "key", insert: `"collapse": { "field": "§" }` },
  { label: "post_filter", detail: "聚合后过滤", kind: "key", insert: `"post_filter": { "term": { "§": "" } }` },
  { label: "script_fields", detail: "脚本生成字段", kind: "key", insert: `"script_fields": {}` },
  { label: "docvalue_fields", detail: "docvalue 字段", kind: "key", insert: `"docvalue_fields": []` },
  { label: "fields", detail: "返回字段（ES7+，支持通配）", kind: "key", insert: `"fields": []` },
  { label: "min_score", detail: "最低得分", kind: "key", insert: `"min_score": §` },
  { label: "terminate_after", detail: "提前终止条数", kind: "key", insert: `"terminate_after": §` },
  { label: "version", detail: "返回 _version", kind: "key", insert: `"version": true` },
  { label: "explain", detail: "解释得分", kind: "key", insert: `"explain": true` },
  { label: "profile", detail: "执行画像", kind: "key", insert: `"profile": true` },
  { label: "timeout", detail: "超时，如 5s", kind: "key", insert: `"timeout": "§"` },
  { label: "suggest", detail: "纠错建议", kind: "key", insert: `"suggest": {}` },
  { label: "indices_boost", detail: "索引加权", kind: "key", insert: `"indices_boost": []` },
  { label: "knn", detail: "向量近邻检索", kind: "key", insert: `"knn": { "field": "§", "query_vector": [], "k": 10, "num_candidates": 100 }` },
];

const MATCH_OPTIONS: Suggestion[] = [
  { label: "operator", detail: "and / or", kind: "key", insert: `"operator": "§"` },
  { label: "fuzziness", detail: "容错度 AUTO/0/1/2", kind: "key", insert: `"fuzziness": "§"` },
  { label: "analyzer", detail: "分词器", kind: "key", insert: `"analyzer": "§"` },
  { label: "minimum_should_match", detail: "至少匹配的词数", kind: "key", insert: `"minimum_should_match": "§"` },
  { label: "boost", detail: "权重", kind: "key", insert: `"boost": §` },
];
const TERM_OPTIONS: Suggestion[] = [
  { label: "value", detail: "匹配值", kind: "key", insert: `"value": "§"` },
  { label: "boost", detail: "权重", kind: "key", insert: `"boost": §` },
  { label: "case_insensitive", detail: "忽略大小写", kind: "key", insert: `"case_insensitive": true` },
];
const RANGE_OPTIONS: Suggestion[] = [
  { label: "gte", detail: "≥ 大于等于", kind: "key", insert: `"gte": "§"` },
  { label: "gt", detail: "> 大于", kind: "key", insert: `"gt": "§"` },
  { label: "lte", detail: "≤ 小于等于", kind: "key", insert: `"lte": "§"` },
  { label: "lt", detail: "< 小于", kind: "key", insert: `"lt": "§"` },
  { label: "format", detail: "日期格式", kind: "key", insert: `"format": "§"` },
  { label: "time_zone", detail: "时区，如 +08:00", kind: "key", insert: `"time_zone": "§"` },
  { label: "boost", detail: "权重", kind: "key", insert: `"boost": §` },
];
const EXISTS_OPTIONS: Suggestion[] = [{ label: "field", detail: "字段名", kind: "key", insert: `"field": "§"` }];
const IDS_OPTIONS: Suggestion[] = [{ label: "values", detail: "_id 列表", kind: "key", insert: `"values": [§]` }];
const MULTI_MATCH_OPTIONS: Suggestion[] = [
  { label: "query", detail: "检索词", kind: "key", insert: `"query": "§"` },
  { label: "fields", detail: "字段列表，可加权重如 title^2", kind: "key", insert: `"fields": [§]` },
  { label: "type", detail: "best_fields / most_fields / cross_fields / phrase", kind: "key", insert: `"type": "§"` },
  { label: "operator", detail: "and / or", kind: "key", insert: `"operator": "§"` },
];
const QUERY_STRING_OPTIONS: Suggestion[] = [
  { label: "query", detail: "lucene 语法，如 status:active AND age:>18", kind: "key", insert: `"query": "§"` },
  { label: "fields", detail: "限定字段", kind: "key", insert: `"fields": [§]` },
  { label: "default_operator", detail: "AND / OR", kind: "key", insert: `"default_operator": "§"` },
  { label: "analyze_wildcard", detail: "通配符分词", kind: "key", insert: `"analyze_wildcard": true` },
];
const NESTED_OPTIONS: Suggestion[] = [
  { label: "path", detail: "嵌套字段路径", kind: "key", insert: `"path": "§"` },
  { label: "query", detail: "嵌套内查询", kind: "key", insert: `"query": { "match_all": {} }` },
  { label: "inner_hits", detail: "返回命中的嵌套文档", kind: "key", insert: `"inner_hits": {}` },
  { label: "score_mode", detail: "avg / sum / max / none", kind: "key", insert: `"score_mode": "§"` },
];
const HIGHLIGHT_KEYS: Suggestion[] = [
  { label: "fields", detail: "高亮字段", kind: "key", insert: `"fields": {}` },
  { label: "pre_tags", detail: "前标签", kind: "key", insert: `"pre_tags": ["<em>"]` },
  { label: "post_tags", detail: "后标签", kind: "key", insert: `"post_tags": ["</em>"]` },
  { label: "fragment_size", detail: "片段长度", kind: "key", insert: `"fragment_size": §` },
  { label: "number_of_fragments", detail: "片段数量", kind: "key", insert: `"number_of_fragments": §` },
  { label: "type", detail: "unified / plain / fvh", kind: "key", insert: `"type": "§"` },
];
const SCRIPT_KEYS: Suggestion[] = [
  { label: "source", detail: "脚本内容，如 doc['price'].value * 2", kind: "key", insert: `"source": "§"` },
  { label: "lang", detail: "painless / expression", kind: "key", insert: `"lang": "§"` },
  { label: "params", detail: "脚本参数", kind: "key", insert: `"params": {}` },
];
const COLLAPSE_KEYS: Suggestion[] = [
  { label: "field", detail: "折叠字段", kind: "key", insert: `"field": "§"` },
  { label: "inner_hits", detail: "组内明细", kind: "key", insert: `"inner_hits": { "name": "§", "size": 3 }` },
];
const KNN_KEYS: Suggestion[] = [
  { label: "field", detail: "向量字段", kind: "key", insert: `"field": "§"` },
  { label: "query_vector", detail: "查询向量", kind: "key", insert: `"query_vector": []` },
  { label: "k", detail: "返回近邻数", kind: "key", insert: `"k": §` },
  { label: "num_candidates", detail: "候选数（> k）", kind: "key", insert: `"num_candidates": §` },
  { label: "filter", detail: "过滤条件", kind: "key", insert: `"filter": { "match_all": {} }` },
];
const SORT_OBJ_KEYS: Suggestion[] = [
  { label: "order", detail: "asc / desc", kind: "key", insert: `"order": "§"` },
  { label: "missing", detail: "_first / _last / 值", kind: "key", insert: `"missing": "§"` },
  { label: "unmapped_type", detail: "字段缺失时的类型", kind: "key", insert: `"unmapped_type": "§"` },
  { label: "mode", detail: "数组字段取值 min/max/avg", kind: "key", insert: `"mode": "§"` },
];

const SOURCE_KEYS: Suggestion[] = [
  { label: "includes", detail: "包含字段（通配）", kind: "key", insert: `"includes": [§]` },
  { label: "excludes", detail: "排除字段（通配）", kind: "key", insert: `"excludes": [§]` },
];

const QUERY_TYPE_SUGGS: Suggestion[] = QUERY_TYPES.map((t) => ({
  label: t.label,
  detail: t.detail,
  kind: "snippet",
  insert: t.insert,
}));

/** agg 类型建议：name 位置（"aggs": { ▮ ) 一起插入桶名 */
const AGG_NAME_SUGGS: Suggestion[] = AGG_TYPES.map((t) => ({
  label: t.label,
  detail: t.detail,
  kind: "snippet",
  insert: `"my_agg": { ${t.tpl.replace("§", "")} }`,
}));

const AGG_TYPE_SUGGS: Suggestion[] = AGG_TYPES.map((t) => ({
  label: t.label,
  detail: t.detail,
  kind: "snippet",
  insert: `{ ${t.tpl} }`,
}));

const AGG_KEY_SUGGS: Record<string, Suggestion[]> = {};
for (const t of AGG_TYPES) {
  AGG_KEY_SUGGS[t.label] = [
    { label: t.label, detail: t.detail, kind: "snippet", insert: `${t.tpl.replace("§", "")}` },
  ];
}

const FIELD_INSERT_FOR_TYPE: Record<string, (f: string) => string> = {
  terms: (f) => `"${f}": []`,
  wildcard: (f) => `"${f}": "*§*"`,
  range: (f) => `"${f}": { "gte": §, "lte": "" }`,
  fuzzy: (f) => `"${f}": { "value": "§", "fuzziness": "AUTO" }`,
};

const ASC_DESC: Suggestion[] = [
  { label: "asc", detail: "升序", kind: "value", insert: `"asc"` },
  { label: "desc", detail: "降序", kind: "value", insert: `"desc"` },
];

const CALENDAR_INTERVALS: Suggestion[] = ["year", "quarter", "month", "week", "day", "hour", "minute", "second"].map(
  (v) => ({ label: v, detail: "时间间隔", kind: "value" as const, insert: `"${v}"` })
);

const DATE_FORMATS: Suggestion[] = [
  { label: "strict_date_optional_time||epoch_millis", detail: "默认日期格式", kind: "value", insert: `"strict_date_optional_time||epoch_millis"` },
  { label: "yyyy-MM-dd HH:mm:ss", detail: "常用格式", kind: "value", insert: `"yyyy-MM-dd HH:mm:ss"` },
  { label: "yyyy-MM-dd", detail: "仅日期", kind: "value", insert: `"yyyy-MM-dd"` },
  { label: "epoch_millis", detail: "毫秒时间戳", kind: "value", insert: `"epoch_millis"` },
];

// ---------------------------------------------------------------------------
// Suggestion engine
// ---------------------------------------------------------------------------

export interface FieldInfo {
  name: string;
  type: string;
}

const MAX_FIELD_SUGGS = 40;

function fieldKeySuggs(fields: FieldInfo[] | undefined, partial: string): Suggestion[] {
  if (!fields?.length) return [];
  const p = partial.toLowerCase();
  const out: Suggestion[] = [];
  for (const f of fields) {
    if (p && !f.name.toLowerCase().startsWith(p) && !f.name.toLowerCase().includes(p)) continue;
    out.push({ label: f.name, detail: f.type, kind: "field", insert: fieldInsertFor(f.name) });
    if (out.length >= MAX_FIELD_SUGGS) break;
  }
  return out;
}

function fieldValueSuggs(fields: FieldInfo[] | undefined, partial: string): Suggestion[] {
  if (!fields?.length) return [];
  const p = partial.toLowerCase();
  const out: Suggestion[] = [];
  for (const f of fields) {
    if (p && !f.name.toLowerCase().startsWith(p) && !f.name.toLowerCase().includes(p)) continue;
    out.push({ label: f.name, detail: f.type, kind: "field", insert: `"${f.name}"` });
    if (out.length >= MAX_FIELD_SUGGS) break;
  }
  return out;
}

function fieldInsertFor(name: string): string {
  return `"${name}": "§"`;
}

function filterByPartial(items: Suggestion[], partial: string): Suggestion[] {
  const p = partial.trim().toLowerCase();
  if (!p) return items;
  const scored = items
    .filter((s) => s.label.toLowerCase().includes(p))
    .map((s) => ({ s, idx: s.label.toLowerCase().indexOf(p) }))
    .sort((a, b) => a.idx - b.idx);
  return scored.map((x) => x.s);
}

function pathEnds(path: string[], ...suffix: string[]): boolean {
  if (path.length < suffix.length) return false;
  for (let i = 0; i < suffix.length; i++) {
    if (path[path.length - 1 - i] !== suffix[suffix.length - 1 - i]) return false;
  }
  return true;
}

/**
 * Compute suggestions for a caret context. `fields` supplies mapping field
 * names (from the selected index) used in field-position contexts.
 *
 * `valueHints` maps a field name to the values that actually occur in the
 * index - they are offered when the caret is at a value position for that
 * field, which turns the completion into something the data knows about.
 */
export function getSuggestions(
  ctx: EditorCtx,
  fields?: FieldInfo[],
  valueHints?: Record<string, string[]>
): Suggestion[] {
  const { expecting, keyStack: path, parentKey, inArray, partial } = ctx;
  if (expecting === "none") return [];

  const partialFieldKey = fieldKeySuggs(fields, partial);
  const partialFieldValue = fieldValueSuggs(fields, partial);

  // ---- a value for a known field ------------------------------------------
  // the caret sits inside the value of "field": "..." - offer the values that
  // really occur in the index
  if (expecting === "value" && parentKey && valueHints?.[parentKey]?.length) {
    const p = partial.trim().toLowerCase();
    const out: Suggestion[] = [];
    for (const v of valueHints[parentKey]) {
      if (p && !v.toLowerCase().includes(p)) continue;
      out.push({ label: v, detail: "索引里的实际值", kind: "value", insert: `"${v}"` });
      if (out.length >= MAX_FIELD_SUGGS) break;
    }
    if (out.length) return out;
  }

  // ---- key position -------------------------------------------------------
  if (expecting === "key") {
    const last = path[path.length - 1];
    const prev = path[path.length - 2];

    // aggregation contexts first: "aggs" buckets have user-defined names,
    // which would otherwise collide with query/agg types of the same label.
    if (path[0] === "aggs" && last) {
      if (last === "aggs") return filterByPartial(AGG_NAME_SUGGS, partial);
      if (AGG_OPTION_KEYS[last]) return filterByPartial(AGG_OPTION_KEYS[last], partial);
      if (AGG_KEY_SUGGS[last]) return filterByPartial([...AGG_KEY_SUGGS[last], ...GENERIC_AGG_KEYS], partial);
      return filterByPartial(AGG_TYPE_SUGGS, partial); // user agg name level
    }
    if (last === "sort") {
      return filterByPartial(
        [
          { label: "_score", detail: "按相关性得分", kind: "field", insert: `"_score": { "order": "§" }` },
          { label: "_doc", detail: "按索引顺序", kind: "field", insert: `"_doc": { "order": "§" }` },
          ...partialFieldKey,
        ],
        partial
      );
    }
    if (path[0] === "sort" && path.length >= 2) {
      // sort element object options: { field: { order, missing, ... } }
      return filterByPartial(SORT_OBJ_KEYS, partial);
    }
    if (last === "bool") return filterByPartial(BOOL_KEYS, partial);
    if (last === "exists") return filterByPartial(EXISTS_OPTIONS, partial);
    if (last === "ids") return filterByPartial(IDS_OPTIONS, partial);
    if (last === "multi_match") return filterByPartial(MULTI_MATCH_OPTIONS, partial);
    if (last === "query_string" || last === "simple_query_string") return filterByPartial(QUERY_STRING_OPTIONS, partial);
    if (last === "nested") return filterByPartial(NESTED_OPTIONS, partial);
    if (last === "knn") return filterByPartial(KNN_KEYS, partial);
    if (last === "collapse") return filterByPartial(COLLAPSE_KEYS, partial);
    if (last === "highlight") return filterByPartial(HIGHLIGHT_KEYS, partial);
    if (last === "_source") {
      return filterByPartial([...SOURCE_KEYS, ...partialFieldKey], partial);
    }
    if (last === "fields" || last === "docvalue_fields") {
      return filterByPartial([{ label: "*", detail: "全部字段", kind: "key", insert: `"*": {}` }, ...partialFieldKey], partial);
    }
    if (last === "script") return filterByPartial(SCRIPT_KEYS, partial);
    if (last === "script_fields") {
      return filterByPartial(
        [{ label: "script_name", detail: "自定义字段名", kind: "snippet", insert: `"my_field": { "script": { "source": "§" } }` }],
        partial
      );
    }

    // inside a field-map object of a known query type (e.g. query>match)
    if (last && FIELD_MAP_TYPES.has(last)) {
      return filterByPartial(queryTypeFieldKeys(last, fields), partial);
    }
    // one level deeper: the field name is the last key, its parent is the op
    if (last && prev && FIELD_MAP_TYPES.has(prev)) {
      const opts = FIELD_OPTIONS[prev] ?? [];
      return filterByPartial(opts, partial);
    }
    if (last === "query") return filterByPartial(QUERY_TYPE_SUGGS, partial);
    if (path.length === 0) {
      return filterByPartial(fields?.length ? [...TOP_LEVEL, ...partialFieldKey] : TOP_LEVEL, partial);
    }
    // unknown object — offer fields when available, else nothing
    return filterByPartial(partialFieldKey, partial);
  }

  // ---- value position -----------------------------------------------------
  const pk = parentKey ?? "";
  // bool clauses / post_filter / highlight_query — a single clause object or an
  // array element, both take a full query-type object.
  if (pk === "must" || pk === "should" || pk === "must_not" || pk === "filter" || pk === "post_filter" || pk === "highlight_query") {
    return filterByPartial(QUERY_TYPE_SUGGS, partial);
  }
  if (pk === "query") {
    // nested.query / bool clauses / root query → object; query_string.query → text
    if (pathEnds(path, "nested", "query") || path.length <= 1) return filterByPartial(QUERY_TYPE_SUGGS, partial);
    return [];
  }
  if (pk === "field") return filterByPartial(partialFieldValue, partial);
  if (pk === "fields") return filterByPartial(inArray ? partialFieldValue : partialFieldKey, partial);
  if (pk === "path") return filterByPartial(partialFieldValue, partial);
  if (pk === "order") return filterByPartial(ASC_DESC, partial);
  if (pk === "sort" && inArray) {
    return filterByPartial(
      [
        { label: "_score", detail: "相关性得分", kind: "field", insert: `"_score"` },
        { label: "_doc", detail: "索引顺序", kind: "field", insert: `"_doc"` },
        ...partialFieldValue,
      ],
      partial
    );
  }
  if (pk === "calendar_interval") return filterByPartial(CALENDAR_INTERVALS, partial);
  if (pk === "format") return filterByPartial(DATE_FORMATS, partial);
  if (pk === "operator") return filterByPartial([{ label: "and", kind: "value", insert: `"and"` }, { label: "or", kind: "value", insert: `"or"` }], partial);
  if (pk === "default_operator") return filterByPartial([{ label: "AND", kind: "value", insert: `"AND"` }, { label: "OR", kind: "value", insert: `"OR"` }], partial);
  if (pk === "type") {
    return filterByPartial(
      ["best_fields", "most_fields", "cross_fields", "phrase", "phrase_prefix", "unified", "plain", "fvh"].map((v) => ({
        label: v,
        kind: "value" as const,
        insert: `"${v}"`,
      })),
      partial
    );
  }
  if (pk === "analyze_wildcard" || pk === "lenient" || pk === "version" || pk === "explain" || pk === "profile" || pk === "case_insensitive") {
    return filterByPartial([{ label: "true", kind: "value", insert: `true` }, { label: "false", kind: "value", insert: `false` }], partial);
  }
  if (pk === "minimum_should_match") {
    return filterByPartial(
      ["1", "2", "3", "75%"].map((v) => ({ label: v, detail: "至少满足", kind: "value" as const, insert: `"${v}"` })),
      partial
    );
  }
  return [];
}

const FIELD_OPTIONS: Record<string, Suggestion[]> = {
  match: MATCH_OPTIONS,
  match_phrase: MATCH_OPTIONS,
  match_phrase_prefix: MATCH_OPTIONS,
  multi_match: MATCH_OPTIONS,
  term: TERM_OPTIONS,
  terms: TERM_OPTIONS,
  range: RANGE_OPTIONS,
  wildcard: TERM_OPTIONS,
  prefix: TERM_OPTIONS,
  regexp: TERM_OPTIONS,
  fuzzy: MATCH_OPTIONS,
};

/** Field-name keys inside a field-map query object, with a per-type value template. */
function queryTypeFieldKeys(type: string, fields: FieldInfo[] | undefined): Suggestion[] {
  const tplFor = (name: string): string => {
    const tpl = FIELD_INSERT_FOR_TYPE[type];
    return tpl ? tpl(name) : fieldInsertFor(name);
  };
  if (!fields?.length) {
    return [{ label: "字段名", detail: "选择索引后可补全字段", kind: "field", insert: tplFor("字段名") }];
  }
  const out: Suggestion[] = [];
  for (const f of fields) {
    out.push({ label: f.name, detail: f.type, kind: "field", insert: tplFor(f.name) });
    if (out.length >= MAX_FIELD_SUGGS) break;
  }
  return out;
}

/** Placeholder names used by snippets — should not be filtered out by partial matching. */
export const SNIPPET_PLACEHOLDERS = ["my_agg", "my_field", "字段名"];
