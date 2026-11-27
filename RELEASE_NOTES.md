RHead v0.3.0

Elasticsearch 桌面客户端，elasticsearch-head 的 Tauri 2 + React 重写版。

## 下载

| 平台 | 文件 |
|---|---|
| Windows x64 | `RHead_0.3.0_x64_en-US.msi` 或 `RHead_0.3.0_x64-setup.exe` |
| macOS Intel | `RHead_0.3.0_x64.dmg` |
| macOS Apple Silicon | `RHead_0.3.0_aarch64.dmg` |
| Linux x64 | `RHead_0.3.0_amd64.deb` / `RHead-0.3.0-1.x86_64.rpm` / `RHead_0.3.0_amd64.AppImage` |

## 本次更新

### 结构化查询

- **精确的命中总数** —— 之前 ES 默认把命中数截断在 10000，页数也跟着算错
  （33 万条的索引只显示 200 页，实际是 6753 页）。现在请求带上
  `track_total_hits`，命中数和页数都是准确的
- **导出符合筛选条件的数据** —— 导出的就是筛选命中的全部文档，不只是当前页。
  对话框里显示筛选条件摘要和精确命中数

### 修复

- **「另存为」没有反应** —— 原生保存对话框之前根本不弹出来（插件的回调版 API
  必须在主线程调用）。改用 `blocking_save_file`
- **导出的分页方式退化** —— `_pit` 端点不接受请求体、scroll 上下文不允许
  `track_total_hits: false`，两者失败后会退化成受 `max_result_window` 限制
  （默认 10000）的 `from` 分页，超过 1 万条就导不出来。现在正常使用 PIT

### 导出安全

- 单次导出**硬上限 1 亿条**，避免拖垮集群和网络。命中数超限时对话框会提示
- 提示全部数据导出请在服务器端进行（快照恢复 / elasticsearch-dump）

## 自行构建

```bash
npm install
npm run tauri build
```

或推 tag 触发 GitHub Actions 跨平台构建。

MIT License
