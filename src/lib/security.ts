// Elasticsearch security (X-Pack) API wrappers: users, roles, role mappings.
//
// All of these live under /_security and need a privileged account - the
// built-in `elastic` user, or any account with the `manage_security`
// cluster privilege.

import { Connection, esDelete, esGet, esPost, esPut, EsError, EsResult, errorText } from "./es";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A user as returned by GET /_security/user. */
export interface EsUser {
  username: string;
  roles: string[];
  full_name?: string | null;
  email?: string | null;
  metadata?: Record<string, any>;
  enabled: boolean;
  /** true for the built-in accounts (elastic, kibana_system, ...) */
  reserved?: boolean;
  /** true for the deprecated `kibana` account */
  deprecated?: boolean;
  /** realms the user is authenticated by */
  authentication_realm?: { name: string; type: string };
}
/** One index privilege block of a role. */
export interface RoleIndexPrivilege {
  names: string[];
  privileges: string[];
  allow_restricted_indices?: boolean;
}

/** One application privilege block of a role. */
export interface RoleApplicationPrivilege {
  application: string;
  privileges: string[];
  resources?: string[];
}

/** A role as returned by GET /_security/role. */
export interface EsRole {
  cluster: string[];
  indices: RoleIndexPrivilege[];
  applications: RoleApplicationPrivilege[];
  run_as: string[];
  metadata?: Record<string, any>;
  /** true for the built-in roles (superuser, viewer, ...) */
  reserved?: boolean;
  transient_metadata?: Record<string, any>;
}

/** A role mapping: rules that grant a set of roles to matching users. */
export interface EsRoleMapping {
  enabled: boolean;
  roles: string[];
  rules: Record<string, any>;
  metadata?: Record<string, any>;
  reserved?: boolean;
}

/** Result of GET /_security/_authenticate - who am I. */
export interface EsAuthInfo {
  username: string;
  roles: string[];
  full_name?: string | null;
  email?: string | null;
  metadata?: Record<string, any>;
  enabled: boolean;
  authentication_realm?: { name: string; type: string };
}

// ---------------------------------------------------------------------------
// Well known privilege names
// ---------------------------------------------------------------------------

/** Cluster privileges offered in the role editor. */
/**
 * Privileges offered in the role editor, grouped for readability.
 *
 * The names come from the ES privilege set (verified against the privileges
 * used by the built-in roles). Note that `read` / `write` / `index` / `delete`
 * are *index* privileges - they must not appear in the cluster list.
 */
export interface PrivilegeGroup {
  label: string;
  items: string[];
}

/** Cluster privileges. */
export const CLUSTER_PRIVILEGE_GROUPS: PrivilegeGroup[] = [
  { label: "组合", items: ["all", "manage"] },
  { label: "监控", items: ["monitor", "monitor_ml", "monitor_transform", "monitor_watcher", "monitor_rollup", "monitor_data_frame_transforms", "monitor_text_structure"] },
  { label: "安全", items: ["manage_security", "manage_privileges", "manage_api_key", "grant_api_key", "manage_own_api_key", "manage_service_account", "manage_token", "manage_saml", "manage_oidc", "delegate_pki", "manage_audit", "manage_recovery", "transport_client"] },
  { label: "模板与流水线", items: ["manage_index_templates", "manage_ingest_pipelines", "manage_logstash_pipelines", "manage_pipeline", "manage_search_pipeline", "manage_unmapped_fields"] },
  { label: "ILM 与快照", items: ["manage_ilm", "manage_ilm_policies", "manage_slm", "manage_snapshots", "create_snapshot", "manage_upgrade_policy", "manage_ccr", "cross_cluster_replication"] },
  { label: "ML 与转换", items: ["manage_ml", "manage_transform", "manage_data_frame_transforms", "manage_rollup", "manage_enrich"] },
  { label: "其它", items: ["manage_watcher"] },
];

/** Index privileges. */
export const INDEX_PRIVILEGE_GROUPS: PrivilegeGroup[] = [
  { label: "组合", items: ["all", "manage"] },
  { label: "数据读写", items: ["read", "write", "create", "create_doc", "index", "delete", "view_index_metadata", "read_cross_cluster", "monitor"] },
  { label: "索引管理", items: ["create_index", "delete_index", "maintenance", "auto_configure"] },
  { label: "细粒度", items: ["indices:admin/aliases", "indices:admin/delete", "indices:admin/mapping/put", "indices:admin/rollover", "indices:admin/settings/update"] },
];

/** Flat list of a group set, without duplicates. */
export function flattenPrivileges(groups: PrivilegeGroup[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of groups) {
    for (const p of g.items) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * Toggle a privilege inside a selection.
 *
 * `all` supersedes every other privilege, so picking it clears the rest and
 * picking anything else drops `all` - that way a rule can never contain a
 * redundant combination.
 */
export function togglePrivilege(selected: string[], priv: string): string[] {
  if (priv === "all") {
    return selected.includes("all") ? [] : ["all"];
  }
  const next = selected.includes(priv)
    ? selected.filter((p) => p !== priv)
    : [...selected.filter((p) => p !== "all"), priv];
  return next;
}

/** The privilege needed to call the security API at all. */
export const MANAGE_SECURITY_NOTE =
  "需要 manage_security（或 superuser）权限才能查看/修改用户与角色。";

/**
 * The cluster runs with `xpack.security.enabled: false`.
 *
 * ES then refuses every /_security call with a 500 and this message. It is
 * a configuration state, not a failure of the app, so the UI shows an
 * explanation instead of an error.
 */
export const SECURITY_DISABLED_MESSAGE =
  "该集群未启用 X-Pack 安全功能（xpack.security.enabled = false），" +
  "因此没有用户、角色和角色映射可供管理。";

/**
 * Detect the "security is switched off" error in an ES response.
 *
 * The message is what ES produces for a basic license without security
 * enabled; there is no dedicated status code for it.
 */
export function isSecurityDisabledError(message: string): boolean {
  return /Security must be explicitly enabled|xpack\.security\.enabled/i.test(message);
}

/**
 * Ask the cluster whether X-Pack security is enabled.
 *
 * Returns null when the answer is unknown (the endpoint is not available or
 * not readable) - the caller then simply tries the security API as before.
 */
export async function probeSecurityEnabled(conn: Connection): Promise<boolean | null> {
  try {
    const r = await esGet(conn, "_xpack/usage?filter_path=security.enabled");
    const enabled = r.json?.security?.enabled;
    return typeof enabled === "boolean" ? enabled : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API wrappers
// ---------------------------------------------------------------------------

/**
 * The security API answers 401/403 with a normal JSON error body - without
 * this check the error object would be mistaken for the data (an empty
 * mapping) and the UI would silently show "no users".
 */
function ensureOk(r: EsResult, what: string): void {
  if (r.status === 401) {
    throw new EsError("unauthorized", errorText(r), 401);
  }
  if (r.status === 403) {
    throw new EsError(
      "es_error",
      `${MANAGE_SECURITY_NOTE}（ES 返回：${errorText(r).slice(0, 200)}）`
    );
  }
  if (r.status >= 400) {
    const detail = errorText(r);
    // a cluster without xpack.security answers 500 with this message - it is
    // a configuration state and must not be shown as a plain error
    if (isSecurityDisabledError(detail)) {
      throw new EsError("es_error", SECURITY_DISABLED_MESSAGE, r.status);
    }
    throw new EsError("es_error", `${what}失败：${detail}`);
  }
}

const enc = encodeURIComponent;

export async function fetchAuthInfo(conn: Connection): Promise<EsAuthInfo> {
  const r = await esGet(conn, "_security/_authenticate");
  return r.json as EsAuthInfo;
}

/** GET /_security/user -> { username: EsUser } */
export async function fetchUsers(conn: Connection): Promise<Record<string, EsUser>> {
  const r = await esGet(conn, "_security/user");
  ensureOk(r, "获取用户列表");
  const raw = (r.json ?? {}) as Record<string, EsUser>;
  const out: Record<string, EsUser> = {};
  for (const [name, u] of Object.entries(raw)) {
    // ES marks the built-in accounts in metadata, not in a top level field
    out[name] = {
      ...u,
      reserved: u.metadata?._reserved === true,
      deprecated: u.metadata?._deprecated === true,
    };
  }
  return out;
}

/** GET /_security/role -> { name: EsRole } */
export async function fetchRoles(conn: Connection): Promise<Record<string, EsRole>> {
  const r = await esGet(conn, "_security/role");
  ensureOk(r, "获取角色列表");
  const raw = (r.json ?? {}) as Record<string, EsRole>;
  const out: Record<string, EsRole> = {};
  for (const [name, role] of Object.entries(raw)) {
    // built-in roles carry metadata._reserved
    out[name] = { ...role, reserved: role.metadata?._reserved === true };
  }
  return out;
}

/** GET /_security/role_mapping -> { name: EsRoleMapping } */
export async function fetchRoleMappings(conn: Connection): Promise<Record<string, EsRoleMapping>> {
  const r = await esGet(conn, "_security/role_mapping");
  ensureOk(r, "获取角色映射列表");
  const raw = (r.json ?? {}) as Record<string, EsRoleMapping>;
  const out: Record<string, EsRoleMapping> = {};
  for (const [name, m] of Object.entries(raw)) {
    out[name] = { ...m, reserved: m.metadata?._reserved === true };
  }
  return out;
}

export interface UserPayload {
  password?: string;
  roles?: string[];
  full_name?: string;
  email?: string;
  metadata?: Record<string, any>;
  enabled?: boolean;
}

/** PUT /_security/user/<name> - creates or updates the user. */
export async function putUser(conn: Connection, name: string, payload: UserPayload): Promise<EsResult> {
  return esPut(conn, `_security/user/${enc(name)}`, payload);
}

/** DELETE /_security/user/<name> */
export async function deleteUser(conn: Connection, name: string): Promise<EsResult> {
  return esDelete(conn, `_security/user/${enc(name)}`);
}

/** POST /_security/user/<name>/_password */
export async function setPassword(
  conn: Connection,
  name: string,
  password: string
): Promise<EsResult> {
  return esPost(conn, `_security/user/${enc(name)}/_password`, { password });
}

export interface RolePayload {
  cluster?: string[];
  indices?: RoleIndexPrivilege[];
  applications?: RoleApplicationPrivilege[];
  run_as?: string[];
  metadata?: Record<string, any>;
}

/** PUT /_security/role/<name> - creates or updates the role. */
export async function putRole(conn: Connection, name: string, payload: RolePayload): Promise<EsResult> {
  return esPut(conn, `_security/role/${enc(name)}`, payload);
}

/** DELETE /_security/role/<name> */
export async function deleteRole(conn: Connection, name: string): Promise<EsResult> {
  return esDelete(conn, `_security/role/${enc(name)}`);
}

export interface RoleMappingPayload {
  enabled?: boolean;
  roles?: string[];
  rules?: Record<string, any>;
  metadata?: Record<string, any>;
}

/** PUT /_security/role_mapping/<name> */
export async function putRoleMapping(
  conn: Connection,
  name: string,
  payload: RoleMappingPayload
): Promise<EsResult> {
  return esPut(conn, `_security/role_mapping/${enc(name)}`, payload);
}

/** DELETE /_security/role_mapping/<name> */
export async function deleteRoleMapping(conn: Connection, name: string): Promise<EsResult> {
  return esDelete(conn, `_security/role_mapping/${enc(name)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A user/role is "built-in" when ES marks it as reserved. */
export function isReserved(x: { reserved?: boolean }): boolean {
  return x.reserved === true;
}

/** Human readable summary of an index privilege block. */
export function describeIndexPrivilege(p: RoleIndexPrivilege): string {
  const names = p.names?.length ? p.names.join(", ") : "*";
  const privs = p.privileges?.length ? p.privileges.join(", ") : "-";
  return `${names} → ${privs}`;
}

// ---------------------------------------------------------------------------
// The user -> role -> permission chain
//
// ES keeps users and permissions apart: a user holds roles, a role carries
// the privileges, and the effective permission of a user is the union of the
// privileges of every role it holds. The helpers below make that union
// visible so the chain can be followed in the UI.
// ---------------------------------------------------------------------------

/** The effective permissions of a user, merged over all of its roles. */
export interface EffectivePermissions {
  cluster: string[];
  indices: RoleIndexPrivilege[];
  applications: RoleApplicationPrivilege[];
  runAs: string[];
  /** roles referenced by the user that do not exist in the role list */
  missingRoles: string[];
}

/**
 * Merge the privileges of every role the user holds.
 *
 * Index rules that address the same set of indices are merged into one
 * block (their privileges are unioned); rules over different indices stay
 * separate.
 */
export function effectivePermissions(
  user: EsUser,
  roles: Record<string, EsRole>
): EffectivePermissions {
  const cluster = new Set<string>();
  const runAs = new Set<string>();
  const indexMap = new Map<string, RoleIndexPrivilege>();
  const appMap = new Map<string, RoleApplicationPrivilege>();
  const missingRoles: string[] = [];

  for (const name of user.roles ?? []) {
    const role = roles[name];
    if (!role) {
      missingRoles.push(name);
      continue;
    }
    (role.cluster ?? []).forEach((c) => cluster.add(c));
    (role.run_as ?? []).forEach((r) => runAs.add(r));

    for (const p of role.indices ?? []) {
      const key = (p.names ?? []).slice().sort().join(",");
      const existing = indexMap.get(key);
      if (existing) {
        existing.privileges = [...new Set([...(existing.privileges ?? []), ...(p.privileges ?? [])])];
        existing.allow_restricted_indices =
          existing.allow_restricted_indices || p.allow_restricted_indices;
      } else {
        indexMap.set(key, {
          names: [...(p.names ?? [])],
          privileges: [...(p.privileges ?? [])],
          allow_restricted_indices: p.allow_restricted_indices,
        });
      }
    }

    for (const a of role.applications ?? []) {
      const existing = appMap.get(a.application);
      if (existing) {
        existing.privileges = [...new Set([...(existing.privileges ?? []), ...(a.privileges ?? [])])];
        existing.resources = [...new Set([...(existing.resources ?? []), ...(a.resources ?? [])])];
      } else {
        appMap.set(a.application, {
          application: a.application,
          privileges: [...(a.privileges ?? [])],
          resources: [...(a.resources ?? [])],
        });
      }
    }
  }

  return {
    cluster: [...cluster].sort(),
    indices: [...indexMap.values()],
    applications: [...appMap.values()],
    runAs: [...runAs].sort(),
    missingRoles,
  };
}

/** One line summary of what a role grants - used as a tooltip. */
export function summarizeRole(role: EsRole | undefined): string {
  if (!role) return "角色不存在";
  const parts: string[] = [];
  if (role.cluster?.length) parts.push(`集群权限：${role.cluster.join(", ")}`);
  if (role.indices?.length) {
    parts.push(
      `索引权限：${role.indices
        .map((p) => `${p.names?.join(", ") || "*"} [${p.privileges?.join(", ") || "-"}]`)
        .join("；")}`
    );
  }
  if (role.applications?.length) {
    parts.push(`应用权限：${role.applications.map((a) => a.application).join(", ")}`);
  }
  if (role.run_as?.length) parts.push(`可 impersonate：${role.run_as.join(", ")}`);
  return parts.join("  ·  ") || "未授予任何权限";
}

/** The users that hold a given role. */
export function usersOfRole(users: Record<string, EsUser>, roleName: string): EsUser[] {
  return Object.values(users)
    .filter((u) => (u.roles ?? []).includes(roleName))
    .sort((a, b) => a.username.localeCompare(b.username));
}

/**
 * Parse the index patterns of a privilege rule.
 *
 * One pattern per line. Commas are NOT separators here - they are legal
 * characters in an index name, so splitting on them would break names like
 * "logs,archive". An empty input means "all indices".
 */
export function parseIndexPatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Convenience for the role payload: the names array to send to ES. */
export function indexNamesFor(text: string): string[] {
  const pats = parseIndexPatterns(text);
  return pats.length ? pats : ["*"];
}

/**
 * The rule shapes ES accepts for a role mapping.
 *
 * ES 7.x only understands a single `field` rule here - `{"field":{"match":"x"}}`,
 * `{"field":{"regex":"x"}}` or `{"field":{"exclude":"x"}}` - and refuses a
 * second key inside `field`. Metadata rules (`username`, `groups`, `dn`) are
 * rejected by ES 7.17 unless a realm provides them, so they are only
 * reachable through the "advanced" raw JSON mode.
 */
export const MAPPING_RULE_MODES = [
  { key: "match", label: "通配匹配", hint: '如 team_*（* 通配）', template: { field: { match: "*" } } },
  { key: "regex", label: "正则匹配", hint: "如 ^team-.*", template: { field: { regex: "^.*$" } } },
  { key: "exclude", label: "排除匹配", hint: "如 admin（匹配到但排除）", template: { field: { exclude: "*" } } },
] as const;

export type MappingRuleMode = "match" | "regex" | "exclude" | "advanced";
