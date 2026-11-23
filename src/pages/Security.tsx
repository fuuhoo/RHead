import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, errorText, friendlyError } from "../lib/es";
import {
  CLUSTER_PRIVILEGE_GROUPS,
  EsRole,
  EsRoleMapping,
  EsUser,
  INDEX_PRIVILEGE_GROUPS,
  MAPPING_RULE_MODES,
  PrivilegeGroup,
  deleteRole,
  deleteRoleMapping,
  deleteUser,
  describeIndexPrivilege,
  effectivePermissions,
  fetchAuthInfo,
  fetchRoleMappings,
  fetchRoles,
  fetchUsers,
  flattenPrivileges,
  indexNamesFor,
  parseIndexPatterns,
  putRole,
  putRoleMapping,
  putUser,
  setPassword,
  summarizeRole,
  togglePrivilege,
  usersOfRole,
} from "../lib/security";
import Drawer from "../components/Drawer";
import JsonView from "../components/JsonView";
import Modal from "../components/Modal";

type Tab = "users" | "roles" | "mappings";

/**
 * Work out which rule shape an existing role mapping uses, so the editor can
 * show it instead of replacing it with the default on save.
 */
function parseRules(rules?: Record<string, any>): { mode: string; pattern: string; raw: string } {
  const raw = rules ? JSON.stringify(rules) : "";
  const field = rules?.field;
  if (field && typeof field === "object") {
    if (typeof field.match === "string") return { mode: "match", pattern: field.match, raw };
    if (typeof field.regex === "string") return { mode: "regex", pattern: field.regex, raw };
    if (typeof field.exclude === "string") return { mode: "exclude", pattern: field.exclude, raw };
  }
  // anything else (metadata rules, match_all, ...) is kept as raw JSON
  return { mode: "advanced", pattern: raw || '{\n  "field": { "match": "*" }\n}', raw };
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "users", label: "用户", icon: "👤" },
  { id: "roles", label: "角色权限", icon: "🔑" },
  { id: "mappings", label: "角色映射", icon: "🔗" },
];

export default function Security({ conn }: { conn: Connection }) {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<Record<string, EsUser>>({});
  const [roles, setRoles] = useState<Record<string, EsRole>>({});
  const [mappings, setMappings] = useState<Record<string, EsRoleMapping>>({});
  const [whoami, setWhoami] = useState<{ username: string; roles: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [u, r, m] = await Promise.all([
        fetchUsers(conn),
        fetchRoles(conn),
        fetchRoleMappings(conn),
      ]);
      setUsers(u);
      setRoles(r);
      setMappings(m);
    } catch (e: any) {
      setError(friendlyError(e, conn));
    } finally {
      setLoading(false);
    }
  }, [conn]);

  useEffect(() => {
    reload();
    fetchAuthInfo(conn)
      .then((a) => setWhoami({ username: a.username, roles: a.roles ?? [] }))
      .catch(() => setWhoami(null));
  }, [conn, reload]);

  return (
    <div className="page">
      <div className="page-toolbar">
        <h2>权限管理</h2>
        <div className="toolbar-actions">
          {whoami && (
            <span className="muted" title={`当前账号角色: ${whoami.roles.join(", ")}`}>
              当前账号 <b>{whoami.username}</b>
              {whoami.roles.length ? ` · ${whoami.roles.join(", ")}` : ""}
            </span>
          )}
          <button className="btn" onClick={reload} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {msg && <div className="alert alert-ok">{msg}</div>}

      <div className="mode-seg sec-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} role="tab">
            {t.label}
            <span className="sec-tab-count">
              {t.id === "users" ? Object.keys(users).length : t.id === "roles" ? Object.keys(roles).length : Object.keys(mappings).length}
            </span>
          </button>
        ))}
      </div>

      {tab === "users" && (
        <UsersTab conn={conn} users={users} roles={roles} reload={reload} setMsg={setMsg} setError={setError} />
      )}
      {tab === "roles" && (
        <RolesTab conn={conn} roles={roles} users={users} reload={reload} setMsg={setMsg} setError={setError} />
      )}
      {tab === "mappings" && (
        <MappingsTab conn={conn} mappings={mappings} roles={roles} reload={reload} setMsg={setMsg} setError={setError} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function UsersTab({
  conn,
  users,
  roles,
  reload,
  setMsg,
  setError,
}: {
  conn: Connection;
  users: Record<string, EsUser>;
  roles: Record<string, EsRole>;
  reload: () => Promise<void>;
  setMsg: (s: string) => void;
  setError: (s: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<EsUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [detail, setDetail] = useState<EsUser | null>(null);

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => !q || u.username.toLowerCase().includes(q))
      .sort((a, b) => a.username.localeCompare(b.username));
  }, [users, filter]);

  async function remove(name: string) {
    if (!window.confirm(`确定删除用户「${name}」？此操作不可撤销。`)) return;
    setError("");
    try {
      const r = await deleteUser(conn, name);
      setMsg(r.status < 300 ? `用户 ${name} 已删除` : errorText(r));
      if (r.status < 300) reload();
    } catch (e: any) {
      setError(friendlyError(e, conn));
    }
  }

  async function toggleEnabled(u: EsUser) {
    setError("");
    try {
      // PUT /_security/user replaces the whole definition - sending only
      // {enabled} would wipe the roles and ES rejects it ("roles are missing")
      const r = await putUser(conn, u.username, {
        roles: u.roles ?? [],
        full_name: u.full_name ?? "",
        email: u.email ?? "",
        metadata: u.metadata ?? {},
        enabled: !u.enabled,
      });
      setMsg(r.status < 300 ? `用户 ${u.username} 已${u.enabled ? "禁用" : "启用"}` : errorText(r));
      if (r.status < 300) reload();
    } catch (e: any) {
      setError(friendlyError(e, conn));
    }
  }

  return (
    <>
      <div className="h3-row">
        <h3>用户 ({list.length})</h3>
        <input
          className="input input-sm index-search"
          placeholder="搜索用户…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn btn-xs" onClick={() => setCreating(true)}>＋ 新建用户</button>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>姓名</th>
              <th>邮箱</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.username}>
                <td>
                  <b>{u.username}</b>
                  {u.reserved && <span className="tag tag-muted">内置</span>}
                  {u.deprecated && <span className="tag tag-warn">已弃用</span>}
                </td>
                <td className="sec-roles">
                  {(u.roles ?? []).length ? u.roles.map((r) => <span className="tag" key={r}>{r}</span>) : <span className="muted">无</span>}
                </td>
                <td>{u.full_name || <span className="muted">—</span>}</td>
                <td>{u.email || <span className="muted">—</span>}</td>
                <td>
                  {u.enabled ? <span className="tag tag-ok">启用</span> : <span className="tag tag-off">禁用</span>}
                </td>
                <td className="sec-actions">
                  <button className="btn btn-xs" onClick={() => setDetail(u)}>详情</button>
                  <button className="btn btn-xs" onClick={() => setEditing(u)} disabled={!!u.reserved}
                    title={u.reserved ? "内置账号不可修改（只能改密码）" : "编辑用户"}>
                    编辑
                  </button>
                  <button className="btn btn-xs" onClick={() => setPwFor(u.username)}>改密码</button>
                  <button className="btn btn-xs" onClick={() => toggleEnabled(u)} disabled={!!u.reserved}> 
                    {u.enabled ? "禁用" : "启用"}
                  </button>
                  <button className="btn btn-xs btn-danger" onClick={() => remove(u.username)} disabled={!!u.reserved}>删除</button>
                </td>
              </tr>
            ))}
            {!list.length && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: "center", padding: 20 }}>
                  没有用户
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <UserForm
          conn={conn}
          roles={roles}
          user={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={(text) => {
            setCreating(false);
            setEditing(null);
            setMsg(text);
            reload();
          }}
          onError={setError}
        />
      )}

      {pwFor && (
        <PasswordDialog
          conn={conn}
          username={pwFor}
          onClose={() => setPwFor(null)}
          onDone={(text) => {
            setPwFor(null);
            setMsg(text);
          }}
          onError={setError}
        />
      )}

      {detail && (
        <Drawer title={`用户 ${detail.username}`} onClose={() => setDetail(null)} width={680}>
          <div className="kv-list">
            <div className="kv"><span>用户名</span><b>{detail.username}</b></div>
            <div className="kv"><span>姓名</span><b>{detail.full_name || "—"}</b></div>
            <div className="kv"><span>邮箱</span><b>{detail.email || "—"}</b></div>
            <div className="kv"><span>状态</span><b>{detail.enabled ? "启用" : "禁用"}</b></div>
            <div className="kv"><span>角色</span><b>{(detail.roles ?? []).join(", ") || "无"}</b></div>
            <div className="kv"><span>认证域</span><b>{detail.authentication_realm?.name ?? "—"}</b></div>
            <div className="kv"><span>元数据</span><b>{JSON.stringify(detail.metadata ?? {})}</b></div>
          </div>

          {/* the user -> role -> permission chain, spelled out */}
          <EffectivePermissionsPanel user={detail} roles={roles} />

          <JsonView title="原始定义" data={detail} />
        </Drawer>
      )}
    </>
  );
}

/**
 * Shows what a user can actually do: every role it holds, the privileges each
 * role contributes and the merged result.
 */
function EffectivePermissionsPanel({
  user,
  roles,
}: {
  user: EsUser;
  roles: Record<string, EsRole>;
}) {
  const eff = useMemo(() => effectivePermissions(user, roles), [user, roles]);

  return (
    <div className="sec-priv-list">
      <h4>有效权限（由所持有角色合并得出）</h4>

      {!(user.roles ?? []).length && <div className="field-empty">该用户没有角色，因此没有任何权限。</div>}

      <div className="sec-priv">
        <div className="sec-priv-names">集群权限</div>
        <div className="sec-priv-tags">
          {eff.cluster.length ? eff.cluster.map((c) => <span className="tag" key={c}>{c}</span>) : <span className="muted">无</span>}
        </div>
      </div>

      <div className="sec-priv">
        <div className="sec-priv-names">索引权限</div>
        <div className="sec-priv-tags">
          {eff.indices.length ? (
            eff.indices.map((p, i) => (
              <span className="tag" key={i} title={describeIndexPrivilege(p)}>
                {p.names?.join(", ") || "*"}: {p.privileges?.join(", ") || "-"}
              </span>
            ))
          ) : (
            <span className="muted">无</span>
          )}
        </div>
      </div>

      {eff.runAs.length > 0 && (
        <div className="sec-priv">
          <div className="sec-priv-names">可 impersonate</div>
          <div className="sec-priv-tags">
            {eff.runAs.map((r) => <span className="tag" key={r}>{r}</span>)}
          </div>
        </div>
      )}

      {eff.missingRoles.length > 0 && (
        <div className="field-hint field-hint-err">
          引用了不存在的角色：{eff.missingRoles.join(", ")}
        </div>
      )}

      <h4 style={{ marginTop: 10 }}>各角色贡献的权限</h4>
      {(user.roles ?? []).map((r) => (
        <div className="sec-priv" key={r}>
          <div className="sec-priv-names">{r}</div>
          <div className="sec-role-preview-desc">{summarizeRole(roles[r])}</div>
        </div>
      ))}
    </div>
  );
}

function UserForm({
  conn,
  roles,
  user,
  onClose,
  onDone,
  onError,
}: {
  conn: Connection;
  roles: Record<string, EsRole>;
  user: EsUser | null;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (s: string) => void;
}) {
  const editing = !!user;
  const [name, setName] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [pw2, setPw2] = useState("");
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [picked, setPicked] = useState<string[]>(user?.roles ?? []);
  const [roleFilter, setRoleFilter] = useState("");
  const [busy, setBusy] = useState(false);

  const roleNames = useMemo(() => {
    const q = roleFilter.trim().toLowerCase();
    return Object.keys(roles)
      .filter((r) => !q || r.toLowerCase().includes(q))
      .sort();
  }, [roles, roleFilter]);

  async function save() {
    setBusy(true);
    onError("");
    const payload: any = {
      roles: picked,
      full_name: fullName,
      email,
      enabled,
      metadata: user?.metadata ?? {},
    };
    if (!editing || password) payload.password = password;
    try {
      const r = await putUser(conn, name.trim(), payload);
      setBusy(false);
      if (r.status < 300) {
        onDone(editing ? `用户 ${name} 已更新` : `用户 ${name} 已创建`);
      } else {
        onError(errorText(r));
      }
    } catch (e: any) {
      setBusy(false);
      onError(friendlyError(e, conn));
    }
  }

  const nameInvalid = !name.trim();
  const pwMismatch = password !== pw2;
  const pwTooShort = password.length > 0 && password.length < 6;

  return (
    <Modal title={editing ? `编辑用户 ${user!.username}` : "新建用户"} onClose={onClose} width={620}>
      <label>
        用户名
        <input
          className="input"
          autoFocus
          value={name}
          disabled={editing}
          onChange={(e) => setName(e.target.value)}
          placeholder="登录用户名"
        />
      </label>
      <label>
        {editing ? "新密码（留空则不修改）" : "初始密码"}
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={editing ? "留空表示不修改密码" : ""}
        />
        {pwTooShort && <span className="field-hint field-hint-err">密码至少 6 位</span>}
      </label>
      <label>
        确认密码
        <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        {pw2 && pwMismatch && <span className="field-hint field-hint-err">两次输入不一致</span>}
      </label>
      <label>
        姓名
        <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </label>
      <label>
        邮箱
        <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="builder-toggle" style={{ marginLeft: 0 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用该账号
      </label>

      <div className="sec-field">
        <div className="sec-field-head">
          <span>分配角色</span>
          <input
            className="input input-sm"
            placeholder="搜索角色…"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
          />
        </div>
        <div className="sec-role-picker">
          {roleNames.map((r) => {
            const on = picked.includes(r);
            return (
              <button
                key={r}
                className={`sec-role-chip ${on ? "on" : ""}`}
                title={summarizeRole(roles[r])}
                onClick={() => setPicked((p) => (on ? p.filter((x) => x !== r) : [...p, r]))}
              >
                {on ? "✓ " : ""}
                {r}
              </button>
            );
          })}
          {!roleNames.length && <div className="field-empty">无匹配角色</div>}
        </div>
        <div className="field-hint">已选：{picked.length ? picked.join(", ") : "无"}</div>
        {/* what the selected roles actually grant - the user -> role -> privilege chain */}
        {picked.length > 0 && (
          <div className="sec-role-preview">
            {picked.map((r) => (
              <div className="sec-role-preview-row" key={r}>
                <span className="sec-role-preview-name">{r}</span>
                <span className="sec-role-preview-desc">{summarizeRole(roles[r])}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || nameInvalid || pwMismatch || pwTooShort}>
          {busy ? "保存中…" : editing ? "保存" : "创建"}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}

function PasswordDialog({
  conn,
  username,
  onClose,
  onDone,
  onError,
}: {
  conn: Connection;
  username: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (s: string) => void;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    onError("");
    try {
      const r = await setPassword(conn, username, pw);
      setBusy(false);
      if (r.status < 300) onDone(`用户 ${username} 的密码已更新`);
      else onError(errorText(r));
    } catch (e: any) {
      setBusy(false);
      onError(friendlyError(e, conn));
    }
  }

  return (
    <Modal title={`修改 ${username} 的密码`} onClose={onClose} width={460}>
      <label>
        新密码
        <input className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <label>
        确认密码
        <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        {pw2 && pw !== pw2 && <span className="field-hint field-hint-err">两次输入不一致</span>}
      </label>
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || !pw || pw !== pw2}>
          {busy ? "提交中…" : "确定"}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function RolesTab({
  conn,
  roles,
  users,
  reload,
  setMsg,
  setError,
}: {
  conn: Connection;
  roles: Record<string, EsRole>;
  users: Record<string, EsUser>;
  reload: () => Promise<void>;
  setMsg: (s: string) => void;
  setError: (s: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<EsRole | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<EsRole | null>(null);
  const [detailName, setDetailName] = useState("");
  const [editName, setEditName] = useState("");

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return Object.keys(roles)
      .filter((r) => !q || r.toLowerCase().includes(q))
      .sort();
  }, [roles, filter]);

  /** how many users hold each role - shows where a role is in use */
  const roleUserCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const u of Object.values(users)) {
      for (const r of u.roles ?? []) m[r] = (m[r] ?? 0) + 1;
    }
    return m;
  }, [users]);

  async function remove(name: string) {
    if (!window.confirm(`确定删除角色「${name}」？引用该角色的用户会失去对应权限。`)) return;
    setError("");
    try {
      const r = await deleteRole(conn, name);
      setMsg(r.status < 300 ? `角色 ${name} 已删除` : errorText(r));
      if (r.status < 300) reload();
    } catch (e: any) {
      setError(friendlyError(e, conn));
    }
  }

  return (
    <>
      <div className="h3-row">
        <h3>角色 ({list.length})</h3>
        <input
          className="input input-sm index-search"
          placeholder="搜索角色…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn btn-xs" onClick={() => setCreating(true)}>＋ 新建角色</button>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>角色名</th>
              <th>使用者</th>
              <th>集群权限</th>
              <th>索引权限</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((name) => {
              const r = roles[name];
              const n = roleUserCount[name] ?? 0;
              return (
                <tr key={name}>
                  <td>
                    <b>{name}</b>
                    {r.reserved && <span className="tag tag-muted">内置</span>}
                  </td>
                  <td>
                    {n ? (
                      <span className="tag">{n} 个用户</span>
                    ) : (
                      <span className="muted">未被使用</span>
                    )}
                  </td>
                  <td>
                    {r.cluster?.length ? r.cluster.map((c) => <span className="tag" key={c}>{c}</span>) : <span className="muted">无</span>}
                  </td>
                  <td className="sec-roles">
                    {r.indices?.length
                      ? r.indices.map((p, i) => (
                          <span className="tag" key={i} title={describeIndexPrivilege(p)}>
                            {p.names?.join(",") || "*"}: {p.privileges?.join(",") || "-"}
                          </span>
                        ))
                      : <span className="muted">无</span>}
                  </td>
                  <td className="sec-actions">
                    <button className="btn btn-xs" onClick={() => { setDetail(r); setDetailName(name); }}>详情</button>
                    <button className="btn btn-xs" onClick={() => { setEditing(r); setEditName(name); }} disabled={!!r.reserved}
                      title={r.reserved ? "内置角色不可修改" : "编辑角色"}>
                      编辑
                    </button>
                    <button className="btn btn-xs btn-danger" onClick={() => remove(name)} disabled={!!r.reserved}>删除</button>
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: "center", padding: 20 }}>没有角色</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <RoleForm
          conn={conn}
          role={editing}
          roleName={editName}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={(text) => {
            setCreating(false);
            setEditing(null);
            setMsg(text);
            reload();
          }}
          onError={setError}
        />
      )}

      {detail && (
        <Drawer title={`角色 ${detailName}`} onClose={() => setDetail(null)} width={660}>
          <RoleDetail role={detail} roleName={detailName} users={users} />
        </Drawer>
      )}
    </>
  );
}

function RoleDetail({
  role,
  roleName,
  users,
}: {
  role: EsRole;
  roleName: string;
  users: Record<string, EsUser>;
}) {
  const holders = useMemo(() => usersOfRole(users, roleName), [users, roleName]);
  return (
    <>
      <div className="kv-list">
        <div className="kv"><span>集群权限</span><b>{role.cluster?.join(", ") || "无"}</b></div>
        <div className="kv"><span>可 impersonate</span><b>{role.run_as?.join(", ") || "无"}</b></div>
        <div className="kv"><span>索引权限块</span><b>{role.indices?.length ?? 0}</b></div>
        <div className="kv"><span>应用权限块</span><b>{role.applications?.length ?? 0}</b></div>
        <div className="kv"><span>使用者</span><b>{holders.length ? `${holders.length} 个用户` : "无"}</b></div>
      </div>

      {/* who holds this role - the other end of the user -> role chain */}
      <div className="sec-priv-list">
        <h4>持有该角色的用户</h4>
        {holders.length ? (
          <div className="sec-role-picker sec-role-holders">
            {holders.map((u) => (
              <span className="tag sec-holder" key={u.username} title={`${u.full_name || ""} ${u.email || ""}`}>
                {u.username}
                {!u.enabled && <em>（已禁用）</em>}
              </span>
            ))}
          </div>
        ) : (
          <div className="field-empty">没有用户持有该角色</div>
        )}
      </div>
      {role.indices?.length > 0 && (
        <div className="sec-priv-list">
          <h4>索引权限</h4>
          {role.indices.map((p, i) => (
            <div className="sec-priv" key={i}>
              <div className="sec-priv-names">{p.names?.join(", ") || "*"}</div>
              <div className="sec-priv-tags">
                {p.privileges?.map((pr) => <span className="tag" key={pr}>{pr}</span>)}
                {p.allow_restricted_indices && <span className="tag tag-warn">含受限索引</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {role.applications?.length > 0 && (
        <div className="sec-priv-list">
          <h4>应用权限</h4>
          {role.applications.map((a, i) => (
            <div className="sec-priv" key={i}>
              <div className="sec-priv-names">{a.application}</div>
              <div className="sec-priv-tags">
                {a.privileges?.map((pr) => <span className="tag" key={pr}>{pr}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}
      <JsonView title="原始定义" data={role} />
    </>
  );
}

function RoleForm({
  conn,
  role,
  roleName,
  onClose,
  onDone,
  onError,
}: {
  conn: Connection;
  role: EsRole | null;
  roleName: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (s: string) => void;
}) {
  const editing = !!role;
  const [name, setName] = useState(roleName);
  const [cluster, setCluster] = useState<string[]>(role?.cluster ?? []);
  // kept as text so a trailing comma can be typed without being swallowed
  const [runAsText, setRunAsText] = useState((role?.run_as ?? []).join(", "));
  const [blocks, setBlocks] = useState<{ names: string; privileges: string[] }[]>(
    role?.indices?.map((p) => ({ names: (p.names ?? []).join("\n"), privileges: p.privileges ?? [] })) ?? [
      { names: "", privileges: ["read"] },
    ]
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    onError("");
    const payload = {
      cluster,
      run_as: runAsText.split(",").map((s) => s.trim()).filter(Boolean),
      indices: blocks
        .filter((b) => parseIndexPatterns(b.names).length || b.privileges.length)
        .map((b) => ({
          names: indexNamesFor(b.names),
          privileges: b.privileges.length ? b.privileges : ["read"],
        })),
      applications: [],
      metadata: role?.metadata ?? {},
    };
    try {
      const r = await putRole(conn, name.trim(), payload);
      setBusy(false);
      if (r.status < 300) onDone(editing ? `角色 ${name} 已更新` : `角色 ${name} 已创建`);
      else onError(errorText(r));
    } catch (e: any) {
      setBusy(false);
      onError(friendlyError(e, conn));
    }
  }

  /** the exact body that will be sent to ES - shown live */
  const preview = {
    cluster,
    run_as: runAsText.split(",").map((s) => s.trim()).filter(Boolean),
    indices: blocks
      .filter((b) => parseIndexPatterns(b.names).length || b.privileges.length)
      .map((b) => ({
        names: indexNamesFor(b.names),
        privileges: b.privileges.length ? b.privileges : ["read"],
      })),
    applications: [],
  };

  return (
    <Modal title={editing ? `编辑角色 ${roleName}` : "新建角色"} onClose={onClose} width={760}>
      <label>
        角色名
        <input className="input" autoFocus value={name} disabled={editing} onChange={(e) => setName(e.target.value)} placeholder="如 my_reader" />
      </label>

      <div className="sec-field">
        <div className="sec-field-head">
          <span>集群权限</span>
          {cluster.length > 0 && <span className="muted">已选 {cluster.length} 项</span>}
        </div>
        <PrivilegePicker
          groups={CLUSTER_PRIVILEGE_GROUPS}
          selected={cluster}
          onToggle={(p) => setCluster((cur) => togglePrivilege(cur, p))}
        />
      </div>

      <div className="sec-field">
        <div className="sec-field-head"><span>可 impersonate 的用户（run_as）</span></div>
        <input
          className="input"
          value={runAsText}
          onChange={(e) => setRunAsText(e.target.value)}
          placeholder="逗号分隔的用户名，留空表示不允许"
        />
        <div className="field-hint">
          {runAsText.split(",").map((s) => s.trim()).filter(Boolean).length
            ? `将授予：${runAsText.split(",").map((s) => s.trim()).filter(Boolean).join("、")}`
            : "留空表示该角色不能 impersonate 任何用户"}
        </div>
      </div>

      <div className="sec-field">
        <div className="sec-field-head">
          <span>索引权限</span>
          <button className="btn btn-xs" onClick={() => setBlocks((b) => [...b, { names: "", privileges: ["read"] }])}>
            ＋ 添加索引规则
          </button>
        </div>
        {blocks.map((b, i) => (
          <div className="sec-priv-editor" key={i}>
            <div className="sec-priv-editor-head">
              <span>规则 {i + 1} · 索引权限</span>
              <button
                className="btn btn-xs clause-del"
                disabled={blocks.length <= 1}
                onClick={() => setBlocks((all) => all.filter((_, x) => x !== i))}
              >
                −
              </button>
            </div>
            <label>
              索引名（每行一个，留空 = *）
              <textarea
                className="input code-editor sec-index-names"
                rows={3}
                spellCheck={false}
                value={b.names}
                onChange={(e) =>
                  setBlocks((all) => all.map((x, xi) => (xi === i ? { ...x, names: e.target.value } : x)))
                }
                placeholder={"logs-*\nmetrics-*"}
              />
            </label>
            <div className="field-hint">
              {parseIndexPatterns(b.names).length ? (
                <>
                  {parseIndexPatterns(b.names).length} 个索引模式：
                  {parseIndexPatterns(b.names).map((p) => (
                    <code key={p}>{p}</code>
                  ))}
                </>
              ) : (
                "未填写，将作用于全部索引（*）"
              )}
              {b.names.includes(",") && (
                <span className="field-hint-err">
                  {" "}逗号是索引名的一部分，不会再被当作分隔符
                </span>
              )}
            </div>
            <PrivilegePicker
              groups={INDEX_PRIVILEGE_GROUPS}
              selected={b.privileges}
              onToggle={(p) =>
                setBlocks((all) =>
                  all.map((x, xi) => (xi === i ? { ...x, privileges: togglePrivilege(x.privileges, p) } : x))
                )
              }
            />
          </div>
        ))}
      </div>

      <details className="sec-preview-json">
        <summary>查看将提交给 ES 的角色定义</summary>
        <pre className="code-editor">{JSON.stringify(preview, null, 2)}</pre>
      </details>

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>
          {busy ? "保存中…" : editing ? "保存" : "创建"}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}

/**
 * Grouped privilege chips.
 *
 * `all` supersedes everything else, so it is exclusive: picking it clears
 * the other selections and picking anything else drops it. That way a rule
 * can never end up with a redundant combination such as `all` + `read`.
 *
 * The toggle runs inside the state updater (not on the rendered value) so
 * two clicks in a row can never lose one of them.
 */
function PrivilegePicker({
  groups,
  selected,
  onToggle,
}: {
  groups: PrivilegeGroup[];
  selected: string[];
  onToggle: (priv: string) => void;
}) {
  const known = new Set(flattenPrivileges(groups));

  return (
    <div className="sec-priv-groups">
      {groups.map((g) => {
        const on = g.items.filter((p) => selected.includes(p));
        return (
          <div className="sec-priv-group" key={g.label}>
            <span className="sec-priv-group-label">{g.label}</span>
            <div className="sec-role-picker">
              {g.items.map((p) => {
                const active = selected.includes(p);
                const isAll = p === "all";
                // "all" supersedes the rest: once it is picked the other
                // entries are hidden (they would be redundant anyway)
                const hidden = !isAll && selected.includes("all");
                if (hidden) return null;
                return (
                  <button
                    key={p}
                    className={`sec-role-chip ${active ? "on" : ""}`}
                    onClick={() => onToggle(p)}
                    title={isAll ? "包含其它所有权限（选择后将不再显示其它项）" : p}
                  >
                    {active ? "✓ " : ""}
                    {p}
                  </button>
                );
              })}
            </div>
            {on.length > 0 && g.label !== "组合" && (
              <div className="field-hint">已选：{on.join(", ")}</div>
            )}
          </div>
        );
      })}
      {selected.filter((p) => !known.has(p)).length > 0 && (
        <div className="field-hint field-hint-err">
          保留了本列表之外的权限：{selected.filter((p) => !known.has(p)).join(", ")}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Role mappings
// ---------------------------------------------------------------------------

function MappingsTab({
  conn,
  mappings,
  roles,
  reload,
  setMsg,
  setError,
}: {
  conn: Connection;
  mappings: Record<string, EsRoleMapping>;
  roles: Record<string, EsRole>;
  reload: () => Promise<void>;
  setMsg: (s: string) => void;
  setError: (s: string) => void;
}) {
  const [editing, setEditing] = useState<EsRoleMapping | null>(null);
  const [creating, setCreating] = useState(false);
  const [editName, setEditName] = useState("");

  const list = useMemo(() => Object.keys(mappings).sort(), [mappings]);

  async function remove(name: string) {
    if (!window.confirm(`确定删除角色映射「${name}」？`)) return;
    setError("");
    try {
      const r = await deleteRoleMapping(conn, name);
      setMsg(r.status < 300 ? `角色映射 ${name} 已删除` : errorText(r));
      if (r.status < 300) reload();
    } catch (e: any) {
      setError(friendlyError(e, conn));
    }
  }

  return (
    <>
      <div className="h3-row">
        <h3>角色映射 ({list.length})</h3>
        <button className="btn btn-xs" onClick={() => setCreating(true)}>＋ 新建映射</button>
      </div>
      <div className="field-hint" style={{ marginBottom: 8 }}>
        角色映射按规则（用户名 / 组 / DN 等）给一批用户批量授予角色。
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>授予角色</th>
              <th>规则</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((name) => {
              const m = mappings[name];
              return (
                <tr key={name}>
                  <td><b>{name}</b></td>
                  <td className="sec-roles">
                    {(m.roles ?? []).map((r) => <span className="tag" key={r}>{r}</span>)}
                  </td>
                  <td className="sec-rules">
                    <code>{JSON.stringify(m.rules ?? {})}</code>
                  </td>
                  <td>{m.enabled ? <span className="tag tag-ok">启用</span> : <span className="tag tag-off">停用</span>}</td>
                  <td className="sec-actions">
                    <button className="btn btn-xs" onClick={() => { setEditing(m); setEditName(name); }}>编辑</button>
                    <button className="btn btn-xs btn-danger" onClick={() => remove(name)}>删除</button>
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: "center", padding: 20 }}>没有角色映射</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <MappingForm
          conn={conn}
          roles={roles}
          mapping={editing}
          mappingName={editName}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={(text) => {
            setCreating(false);
            setEditing(null);
            setMsg(text);
            reload();
          }}
          onError={setError}
        />
      )}
    </>
  );
}

function MappingForm({
  conn,
  roles,
  mapping,
  mappingName,
  onClose,
  onDone,
  onError,
}: {
  conn: Connection;
  roles: Record<string, EsRole>;
  mapping: EsRoleMapping | null;
  mappingName: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (s: string) => void;
}) {
  const editing = !!mapping;
  const [name, setName] = useState(mappingName);
  const [enabled, setEnabled] = useState(mapping?.enabled ?? true);
  const [picked, setPicked] = useState<string[]>(mapping?.roles ?? []);
  // an existing mapping must keep its own rule shape - editing it may not
  // silently rewrite it to the default "field match"
  const parsed = parseRules(mapping?.rules);
  const [mode, setMode] = useState(parsed.mode);
  const [pattern, setPattern] = useState(parsed.pattern);
  // only rebuild the rule when the user actually touches it - otherwise the
  // original rule (which may use a shape the editor does not offer) is kept
  const [rulesTouched, setRulesTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const roleNames = Object.keys(roles).sort();

  function buildRules(): Record<string, any> {
    if (editing && !rulesTouched) return mapping?.rules ?? { field: { match: "*" } };
    if (mode === "advanced") {
      // the raw JSON is validated by ES - send it through untouched
      try {
        return JSON.parse(pattern);
      } catch {
        return { field: { match: "*" } };
      }
    }
    const p = pattern.trim();
    return { field: { [mode]: p } };
  }

  async function save() {
    setBusy(true);
    onError("");
    try {
      const r = await putRoleMapping(conn, name.trim(), {
        enabled,
        roles: picked,
        rules: buildRules(),
        metadata: mapping?.metadata ?? {},
      });
      setBusy(false);
      if (r.status < 300) onDone(editing ? `角色映射 ${name} 已更新` : `角色映射 ${name} 已创建`);
      else onError(errorText(r));
    } catch (e: any) {
      setBusy(false);
      onError(friendlyError(e, conn));
    }
  }

  return (
    <Modal title={editing ? "编辑角色映射" : "新建角色映射"} onClose={onClose} width={620}>
      <label>
        名称
        <input className="input" autoFocus value={name} disabled={editing} onChange={(e) => setName(e.target.value)} placeholder="如 ops_team" />
      </label>
      <label className="builder-toggle" style={{ marginLeft: 0 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用该映射
      </label>

      <div className="sec-field">
        <div className="sec-field-head"><span>授予角色</span></div>
        <div className="sec-role-picker">
          {roleNames.map((r) => {
            const on = picked.includes(r);
            return (
              <button key={r} className={`sec-role-chip ${on ? "on" : ""}`} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== r) : [...p, r]))}>
                {on ? "✓ " : ""}
                {r}
              </button>
            );
          })}
        </div>
      </div>

      <div className="sec-field">
        <div className="sec-field-head"><span>匹配规则</span></div>
        <select
          className="input"
          value={mode}
          onChange={(e) => {
            const next = e.target.value;
            setMode(next);
            setRulesTouched(true);
            if (next !== "advanced") {
              const tpl = MAPPING_RULE_MODES.find((m) => m.key === next);
              if (tpl) setPattern((tpl.template as any).field[next]);
            } else {
              setPattern('{\n  "field": { "match": "*" }\n}');
            }
          }}
        >
          {MAPPING_RULE_MODES.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
          <option value="advanced">高级（手写 JSON）</option>
        </select>
        {mode === "advanced" ? (
          <textarea
            className="input code-editor"
            rows={5}
            value={pattern}
            onChange={(e) => {
              setPattern(e.target.value);
              setRulesTouched(true);
            }}
            spellCheck={false}
          />
        ) : (
          <input
            className="input"
            value={pattern}
            onChange={(e) => {
              setPattern(e.target.value);
              setRulesTouched(true);
            }}
            placeholder={MAPPING_RULE_MODES.find((m) => m.key === mode)?.hint}
          />
        )}
        <div className="field-hint">
          生成的规则：<code>{JSON.stringify(buildRules())}</code>
          {mode !== "advanced" && (
            <span className="muted">（ES 7.x 只支持 field 规则；组/DN 等元数据规则需用高级模式手写）</span>
          )}
        </div>
      </div>

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim() || !picked.length}>
          {busy ? "保存中…" : editing ? "保存" : "创建"}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}
