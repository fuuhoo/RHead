// Formatting helpers ported from the original head's `ut` (utils) templates.

export function byteSize(bytes: number | undefined | null): string {
  if (bytes == null || isNaN(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function count(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "-";
  return n.toLocaleString();
}

export function percent(used: number, total: number): number {
  if (!total) return 0;
  return Math.round((used / total) * 100);
}

export interface HealthFraction {
  /** shard copies that are assigned and running */
  active: number;
  /** all shard copies the cluster is supposed to hold */
  total: number;
  /** e.g. "82 of 145" */
  text: string;
  /** percentage of assigned copies */
  percent: number;
  unassigned: number;
  initializing: number;
}

/**
 * Shard assignment fraction of the cluster: assigned copies vs all copies.
 * Mirrors the "yellow (82 of 145)" badge of the original head.
 */
export function healthFraction(health: any): HealthFraction | null {
  if (!health) return null;
  const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : Number(v) || 0);
  const active = num(health.active_shards);
  const initializing = num(health.initializing_shards);
  const unassigned = num(health.unassigned_shards);
  // relocating shards are already counted as active by ES
  const total = active + initializing + unassigned;
  if (!total) return null;
  return {
    active,
    total,
    text: `${count(active)} of ${count(total)}`,
    percent: percent(active, total),
    unassigned,
    initializing,
  };
}

export function healthColor(status: string | undefined): string {
  switch ((status || "").toLowerCase()) {
    case "green":
      return "#22c55e";
    case "yellow":
      return "#eab308";
    case "red":
      return "#ef4444";
    default:
      return "#9ca3af";
  }
}

/** Flatten a hit's _source for table display (nested objects -> JSON string). */
export function flattenSource(source: any, prefix = "", out: Record<string, any> = {}) {
  if (source == null || typeof source !== "object") return out;
  for (const [k, v] of Object.entries(source)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      flattenSource(v, key, out);
    } else if (Array.isArray(v)) {
      out[key] = v.map((x) => (x != null && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
    } else {
      out[key] = v;
    }
  }
  return out;
}

export function cellText(v: any): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Parse ES mapping into a flat field list: [{name, type}]. */
export function parseMapping(mappings: any): { name: string; type: string }[] {
  const fields: { name: string; type: string }[] = [];
  if (!mappings || typeof mappings !== "object") return fields;
  // ES7+: { properties: {...} }  ES2/5: { typeName: { properties: {...} } }
  const walk = (props: any, prefix: string) => {
    if (!props || typeof props !== "object") return;
    for (const [name, def] of Object.entries(props) as [string, any][]) {
      const full = prefix ? `${prefix}.${name}` : name;
      if (def?.type) fields.push({ name: full, type: def.type });
      if (def?.properties) walk(def.properties, full);
      if (def?.fields) walk(def.fields, full);
    }
  };
  if (mappings.properties) walk(mappings.properties, "");
  else {
    for (const typeDef of Object.values(mappings) as any[]) {
      if (typeDef?.properties) walk(typeDef.properties, "");
    }
  }
  return fields.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse a GET /{index}/_mapping or /_all/_mapping response (ES7 & ES8 same shape:
 * { indexName: { mappings: { properties: {...} } } }) into merged flat fields.
 * `indices` tells how many of the queried indices define the field — with a
 * merged list the type shown is the one of the first index that declared it.
 */
export function parseMappingResponse(json: any): { name: string; type: string; indices: number }[] {
  if (!json || typeof json !== "object") return [];
  const seen = new Map<string, { type: string; indices: number }>();
  for (const idxDef of Object.values(json) as any[]) {
    const m = idxDef?.mappings ?? idxDef;
    for (const f of parseMapping(m)) {
      const cur = seen.get(f.name);
      if (cur) cur.indices += 1;
      else seen.set(f.name, { type: f.type, indices: 1 });
    }
  }
  return [...seen.entries()]
    .map(([name, v]) => ({ name, type: v.type, indices: v.indices }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
