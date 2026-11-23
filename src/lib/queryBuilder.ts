// Query builder state — ports data/Query + boolQuery:
// bool query with must/must_not/should clauses, pagination, sorting.

export interface Clause {
  uqid: string;
  field: string;
  type:
    | "wildcard"
    | "range"
    | "term"
    | "terms"
    | "match"
    | "match_phrase"
    | "prefix"
    | "exists"
    | "match_all";
  value: any;
  must: "must" | "must_not" | "should" | "filter";
}

let seq = 0;
export function newClause(partial: Partial<Clause>): Clause {
  return { uqid: `c${++seq}`, field: "_all", type: "wildcard", value: "", must: "must", ...partial };
}

export interface SearchState {
  indices: string[];
  types: string[];
  clauses: Clause[];
  from: number;
  size: number;
  sort: { field: string; order: "asc" | "desc" }[];
  aggs: Record<string, any>;
  queryString: string; // raw DSL override (empty = use clauses)
}

export function defaultSearch(): SearchState {
  return {
    indices: [],
    types: [],
    clauses: [newClause({ field: "_all", value: "" })],
    from: 0,
    size: 50,
    sort: [],
    aggs: {},
    queryString: "",
  };
}

export function buildDSL(s: SearchState): any {
  const path = `${s.indices.join(",") || "_all"}/${s.types.length ? s.types.join(",") + "/" : ""}_search`;
  let query: any;
  if (s.queryString.trim()) {
    try {
      query = JSON.parse(s.queryString);
    } catch {
      query = { bool: { must: [] } };
    }
  } else {
    const must: any[] = [];
    const mustNot: any[] = [];
    const should: any[] = [];
    const filter: any[] = [];
    for (const c of s.clauses) {
      if (c.value === "" || c.value == null) continue;
      if (c.type === "match_all") continue;
      let clause: any;
      if (c.type === "wildcard") {
        const v = String(c.value).includes("*") ? c.value : `*${c.value}*`;
        clause = { wildcard: { [c.field]: v } };
      } else if (c.type === "range") {
        clause = { range: { [c.field]: c.value } };
      } else if (c.type === "exists") {
        clause = { exists: { field: c.field } };
      } else if (c.type === "terms") {
        clause = { terms: { [c.field]: c.value } };
      } else if (c.type === "match_phrase") {
        clause = { match_phrase: { [c.field]: c.value } };
      } else if (c.type === "prefix") {
        clause = { prefix: { [c.field]: c.value } };
      } else if (c.type === "term") {
        clause = { term: { [c.field]: c.value } };
      } else {
        clause = { match: { [c.field]: c.value } };
      }
      (c.must === "must_not" ? mustNot : c.must === "should" ? should : c.must === "filter" ? filter : must).push(clause);
    }
    query = { bool: { must, must_not: mustNot, should, filter } };
  }
  const body: any = { query, from: s.from, size: s.size, version: true };
  if (s.sort.length) {
    body.sort = s.sort.map((x) => ({ [x.field]: { order: x.order } }));
  }
  if (Object.keys(s.aggs).length) body.aggs = s.aggs;
  return { path, body };
}
