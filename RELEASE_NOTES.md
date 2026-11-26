RHead v0.2.0

Elasticsearch 桌面客户端，elasticsearch-head 的 Tauri 2 + React 重写版。

## 下载

| 平台 | 文件 |
|---|---|
| Windows x64 | `RHead_0.2.0_x64_en-US.msi` 或 `RHead_0.2.0_x64-setup.exe` |
| macOS Intel | `RHead_0.2.0_x64.dmg` |
| macOS Apple Silicon | `RHead_0.2.0_aarch64.dmg` |
| Linux x64 | `RHead_0.2.0_amd64.deb` / `RHead-0.2.0-1.x86_64.rpm` / `RHead_0.2.0_amd64.AppImage` |

## 本次更新

### 结果表格

- **表头固定**，向下滚动时列名始终可见
- **横向滚动条常驻**在可见行下方，不必滚过整个表格才找得到
- **列名保留原始大小写** —— ES 字段名大小写敏感，`cellCraftId` 不再被显示成 `CELLRAFTID`
- **列显示/隐藏**：勾选列、显示全部、仅显示关键列、单列「只看」
- **列的显示状态按索引持久化**，刷新页面或下次打开自动恢复
- 列设置面板增加**列名筛选框**，列多时快速定位

### 结构化查询

- **查询语句改为右侧抽屉**，不再占用主区域，表格区域占比从 39% 提升到 55%
- 显示所选索引的**文档总数**，与命中数对照

### 概览页

- 索引列表增加**刷新按钮**，只请求 `_stats` 重读各索引的文档数与大小，不刷新整个集群

## 自行构建

```bash
npm install
npm run tauri build
```

或推 tag 触发 GitHub Actions 跨平台构建。

MIT License
