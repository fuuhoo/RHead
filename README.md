# RHead — Elasticsearch Head（Tauri 重写）

依据 `elasticsearch-head` 的页面与交互逻辑，使用 **Tauri 2 + React + TypeScript** 重写，并做了现代化 UI 优化（深色侧栏 + 浅色内容、卡片式概览、语法高亮 JSON、响应式表格）。

## 与原版的对应关系

| 原版 (mobz/elasticsearch-head) | RHead |
|---|---|
| `index.html` + Grunt 打包 `_site/app.js` | Vite + React SPA |
| Node proxy (`proxy/esProxy.js`) 解决 CORS | Rust command `es_request`（`reqwest`）转发，免 CORS、免代理进程 |
| ClusterConnect（地址+账号+密码） | 顶栏连接条，localStorage 持久化；**连接管理**（多连接保存/切换/删除）、**断开连接**、连接状态条（连接中步骤 + 延迟） |
| Cluster Overview（节点/索引网格、排序、别名） | `pages/Overview.tsx`：健康卡片、节点表、**索引表（搜索、新建索引、状态/信息/Mapping、开关/刷新/Flush/别名/删除）**、快捷接口下拉、快速信息抽屉 |
| Browser + QueryFilter（字段过滤、排序、分页） | 已合并进 `pages/StructuredQuery.tsx`：单索引选择器、按 mapping 字段构建条件、排序、表格/JSON/CSV 输出、DSL 预览 |
| StructuredQuery + FilterBrowser | `pages/StructuredQuery.tsx`：原版式条件行（must/类型/字段/值，+/- 增删）、多字段排序（标题栏 + 添加）、返回格式（表格/JSON/CSV）、数量、索引文档数展示；另附 DSL 编辑模式（自动补全）与查询结构可视化。**只能查询一个索引**（顶部选择器切换，按钮上直接显示当前索引名），未选时禁止搜索/导出；**完整分页**（首页/上一页/页码/下一页/末页 + 跳页）；查询条件与查询结构/请求 DSL **左右两栏并排**（窗口窄时自动堆叠）；**可设置请求超时**（1-600 秒，默认 15，持久化到 localStorage） |
| AnyRequest（任意 method/path/body、历史、转换器、定时重复） | `pages/AnyRequest.tsx`：全部保留，历史存 localStorage；同样支持**可设置请求超时** |
| ClusterState（并行拉取 5 个接口） | `lib/cluster.ts` `fetchSnapshot`（含 `_all` 降级） |
| MetaDataFactory / mapping 解析 | `lib/format.ts` `parseMapping`（兼容 ES2–ES8 mapping 形状） |
| Query / BoolQuery（must/must_not/should） | `lib/queryBuilder.ts` |
| JsonPretty / ResultTable | `components/JsonView.tsx` / `components/ResultsTable.tsx` |
| 批量导出（原版没有，本项目新增） | `components/ExportDialog.tsx` + `src-tauri/src/lib.rs` 的 `export_docs`：Rust 侧分页拉取、边拉边写盘，内存恒定 |
| Security（用户 / 角色 / 角色映射） | `pages/Security.tsx` + `lib/security.ts`：**用户管理**（新建/编辑/删除/改密码/启用禁用，内置账号自动锁定编辑）、**角色权限**（集群权限 + 索引权限规则 + run_as）、**角色映射**（按规则批量授予角色） |

## 导出数据

结构化查询页右上角「⬇ 导出」，导出**当前查询命中**的文档。

| 项 | 说明 |
|---|---|
| 格式 | NDJSON（无损、可回灌 ES）/ CSV（Excel 友好，带 UTF-8 BOM）/ JSON 数组 |
| 字段 | 全部字段，或从 mapping 里指定字段子集 |
| 分页 | 自动降级：**PIT + search_after**（ES 7.10+，快照一致、不受 `max_result_window` 限制）→ **Scroll**（ES ≤ 7.x）→ **from/size**（兜底，受 `max_result_window` 限制） |
| 大数据量 | 全部在 Rust 侧完成：每页拉一批就追加写盘，**内存不随结果集增长**；带进度条与取消 |
| 其它 | 条数上限、每页大小可调；未选索引时导出全部索引（弹窗会明确提示） |

## 权限管理

顶栏「🔑 权限管理」，直接调用 ES 的 `_security` 接口（需要 `manage_security` 或 `superuser` 权限）。

| 子页 | 能力 |
|---|---|
| 用户 | 列表 / 搜索 / 新建 / 编辑 / 删除 / 改密码 / 启用禁用 / 详情抽屉；**内置账号**（elastic、kibana_system…）自动禁用编辑与删除，只允许改密码（与 ES 的限制一致）；顶部显示当前登录账号及其角色 |
| 角色权限 | 列表 / 搜索 / 新建 / 编辑 / 删除 / 详情抽屉；可勾选**集群权限**、配置多条**索引权限规则**（索引名 + 权限组）、设置 **run_as**（可 impersonate 的用户）；列表显示**使用者数量** |
| 角色映射 | 列表 / 新建 / 编辑 / 删除；按规则给一批用户批量授予角色，规则支持通配 / 正则 / 排除，另有「高级」模式可手写任意 JSON |

### 角色编辑器的几个约定

| 项 | 做法 |
|---|---|
| 权限列表 | 按用途**分组**（组合 / 监控 / 安全 / 模板与流水线 / ILM 与快照 / ML 与转换 …），**无重复项**；名称取自 ES 的权限集（`read`、`write`、`index`、`delete` 属于索引权限，不会出现在集群权限里） |
| `all` | `all` 包含其它所有权限，因此是**互斥**的：选中后其它项隐藏，再点一次取消——不会出现 `all` + `read` 这种冗余组合 |
| 索引名 | **每行一个**模式。逗号是索引名合法字符的一部分，不再被当作分隔符（`logs,archive` 会被当作一个索引名）；输入框下方实时显示解析结果 |
| 提交内容 | 表单底部可展开「查看将提交给 ES 的角色定义」，所见即所得 |

### 用户 → 角色 → 权限 这条链

ES 把「谁」和「能干什么」分开存：用户只持有角色，权限挂在角色上，用户的**有效权限 = 所有角色权限的并集**。UI 把这条链接起来了：

| 位置 | 能看到 |
|---|---|
| 用户详情抽屉 | **有效权限**（所有角色合并后的集群权限 / 索引权限 / run_as）+ **各角色贡献的权限**逐条展开 |
| 角色详情抽屉 | **持有该角色的用户**列表 |
| 角色列表 | 每个角色的**使用者数量** |
| 用户编辑表单 | 角色选择器悬停显示该角色的权限摘要，选中后在下方列出每个角色的权限预览 |

合并规则：集群权限与 run_as 取并集；索引权限中**指向同一组索引**的规则合并、权限组取并集，不同索引的规则保持分开。

> ES 7.17 的角色映射只接受 `{"field":{"match"/"regex"/"exclude":...}}` 这一种规则形状（`username` / `groups` / `dn` 等元数据规则会被 ES 拒绝），所以规则编辑器默认给这三种，复杂规则可用高级模式手写。编辑已有映射时，若没动规则，原规则会原样保留。

## 运行

```bash
npm install
npm run tauri dev    # 桌面开发（需要 Rust 工具链）
```

也可以只看 Web UI（浏览器直连 ES，需要 ES 开启 CORS）：

```bash
npm run dev          # http://localhost:1420
```

## 打包

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`（Windows 下同时生成 `.msi` 和 `.exe` 安装包）。

## 下载

Releases 页可下载各平台安装包。自行构建请打 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 会自动构建 Windows / macOS (Intel + Apple Silicon) / Linux 四个平台并创建 Release。

## 说明

- ES 版本兼容：查询语法使用通用 bool/wildcard/range DSL；`_type` 仅在 ES 6 及以下路径中出现，ES7+ 自动省略。
- 连接信息（含密码）保存在本机 localStorage；生产环境建议改用系统钥匙串。
- 权限管理功能需要 ES 开启 X-Pack Security（basic 及以上 license 均支持），并使用 `manage_security` 或 `superuser` 账号连接。
- 角色映射的规则语法随 ES 版本不同：ES 7.x 只接受 `{"field":{"match"/"regex"/"exclude":...}}`；ES 8.x 支持 `username` / `groups` / `dn` 等元数据规则。

## 致谢

界面与交互逻辑参考 [mobz/elasticsearch-head](https://github.com/mobz/elasticsearch-head)，本项目为 Tauri 2 + React 的重写实现。

## License

[MIT](LICENSE)
