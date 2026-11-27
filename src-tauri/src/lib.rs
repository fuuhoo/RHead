// RHead: Rust side provides a CORS-free Elasticsearch proxy command
// plus a streaming bulk-export command (fetch -> format -> write to disk).
// The webview never talks to ES directly (browser CORS would block it,
// and the original head needed a node proxy for the same reason).
// Instead the frontend invokes `es_request` and Rust forwards to ES.
// ES HTTP error bodies (4xx/5xx) are returned as results, not Err, so the
// UI can display the real ES error. Only transport failures are Err.

use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Default request timeout (seconds) when the caller does not specify one.
const DEFAULT_TIMEOUT_SECS: u64 = 15;
/// Lower bound for a caller supplied timeout (seconds).
const MIN_TIMEOUT_SECS: u64 = 1;
/// Upper bound for a caller supplied timeout (seconds).
const MAX_TIMEOUT_SECS: u64 = 600;

#[derive(Serialize, Debug)]
struct EsResponse {
    status: u16,
    body: String,
}

/// Clamp a caller supplied timeout into the range this tool accepts.
fn resolve_timeout(timeout_secs: Option<u64>) -> u64 {
    timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS)
}

#[tauri::command]
async fn es_request(
    base_url: String,
    method: String,
    path: String,
    body: Option<String>,
    username: Option<String>,
    password: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<EsResponse, String> {
    // Only allow http(s) targets — this is a desktop tool, but keep the
    // command from being usable as a generic file/SSRF gadget.
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("地址需以 http:// 或 https:// 开头，例如 http://localhost:9200".into());
    }
    let url = format!("{}/{}", base, path.trim_start_matches('/'));

    // The caller may raise or lower the request timeout; clamp it to a
    // range that is useful for an interactive tool.
    let timeout = resolve_timeout(timeout_secs);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| e.to_string())?;

    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("不支持的请求方法: {}", method))?;

    let mut req = client
        .request(method, &url)
        .header("Content-Type", "application/json");
    if let Some(b) = body
        && !b.trim().is_empty()
    {
        req = req.body(b);
    }
    if let Some(u) = username
        && !u.is_empty()
    {
        req = req.basic_auth(u, Some(password.unwrap_or_default()));
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("请求超时（{} 秒内无响应）: {}", timeout, url)
        } else if e.is_connect() {
            format!(
                "无法连接到 {}：连接被拒绝或主机不可达，请确认 ES 已启动且地址/端口正确。详情：{}",
                url, e
            )
        } else {
            format!("请求失败 {}：{}", url, e)
        }
    })?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(EsResponse { status, body })
}

// ---------------------------------------------------------------------------
// Bulk export
//
// Large exports must not go through `es_request`: that command ships the
// whole response body to the webview as one string, which would blow up the
// renderer for anything but a toy result set. Instead the export runs here:
// pages are pulled from ES, formatted and appended to disk as they arrive,
// so memory stays constant no matter how many documents are exported.
//
// Paging strategy, picked at runtime:
//   1. PIT + search_after (ES 7.10+)  — snapshot view, no max_result_window
//   2. Scroll (ES <= 7.x)              — snapshot view, no max_result_window
//   3. from/size paging                — fallback, capped by max_result_window
// ---------------------------------------------------------------------------

/// Cancel flags of running exports, keyed by export id.
#[derive(Default)]
struct ExportState {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// Hard upper bound for a single export.
///
/// Pulling a hundred million documents over the network would hammer both the
/// cluster and the link for hours. When more than this is needed the export
/// belongs on the server side (a snapshot + restore, or elasticsearch-dump).
const MAX_EXPORT_ROWS: usize = 100_000_000;

#[derive(Serialize)]
struct ExportSummary {
    path: String,
    format: String,
    rows: usize,
    bytes: u64,
    strategy: String,
    /// false when the export was cut short (canceled or row limit reached)
    complete: bool,
    /// the row limit that was applied, if any
    limit: Option<usize>,
    /// true when the hard cap stopped the export
    hit_hard_cap: bool,
}

#[derive(Clone, Serialize)]
struct ExportProgress {
    id: String,
    rows: usize,
    bytes: u64,
    phase: String,
}

/// Wraps the output file and counts the bytes written, so the UI can show
/// progress without stat-ing the file.
struct Counting<W: Write> {
    inner: W,
    count: u64,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.count += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Ask for a cancellation of a running export.
#[tauri::command]
fn export_cancel(state: State<'_, ExportState>, id: String) {
    if let Some(flag) = state.cancels.lock().ok().and_then(|m| m.get(&id).cloned()) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Open the native save dialog and return the chosen path.
#[tauri::command]
async fn export_pick_path(
    app: AppHandle,
    default_name: String,
    ext: String,
) -> Result<Option<String>, String> {
    // `blocking_save_file` waits for the user, so it runs on a blocking
    // thread - the async worker stays free for the other commands.
    //
    // The non blocking `save_file` variant must not be used here: it is meant
    // for the main thread and silently does nothing when called from an async
    // command (no dialog ever appears).
    let filter_name = ext.to_uppercase();
    let filter_ext = ext.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(default_name)
            .add_filter(filter_name, &[filter_ext.as_str()])
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("打开保存对话框失败：{}", e))?;

    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// Export the documents matching the given query into a file.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn export_docs(
    app: AppHandle,
    state: State<'_, ExportState>,
    id: String,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
    indices: String,
    body: String,
    format: String,
    fields: Option<Vec<String>>,
    include_meta: bool,
    csv_columns: Option<Vec<String>>,
    out_path: String,
    max_rows: Option<usize>,
    chunk_size: Option<usize>,
) -> Result<ExportSummary, String> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("地址需以 http:// 或 https:// 开头，例如 http://localhost:9200".into());
    }
    let chunk = chunk_size.unwrap_or(1000).clamp(1, 10_000);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = state.cancels.lock() {
        map.insert(id.clone(), cancel.clone());
    }
    let res = run_export(
        &app,
        &cancel,
        &id,
        &base,
        username,
        password,
        &indices,
        &body,
        &format,
        fields,
        include_meta,
        csv_columns,
        &out_path,
        max_rows,
        chunk,
    )
    .await;
    if let Ok(mut map) = state.cancels.lock() {
        map.remove(&id);
    }
    res
}

#[allow(clippy::too_many_arguments)]
async fn run_export(
    app: &AppHandle,
    cancel: &Arc<AtomicBool>,
    id: &str,
    base: &str,
    username: Option<String>,
    password: Option<String>,
    indices: &str,
    body: &str,
    format: &str,
    fields: Option<Vec<String>>,
    include_meta: bool,
    csv_columns: Option<Vec<String>>,
    out_path: &str,
    max_rows: Option<usize>,
    chunk: usize,
) -> Result<ExportSummary, String> {
    // A dedicated client: exports may run long, so they get a wider timeout
    // than the interactive es_request (15s) without slowing browsing down.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let emitter = app.clone();
    let eid = id.to_string();
    let on_progress = move |rows: usize, bytes: u64, phase: &str| {
        let _ = emitter.emit(
            "rhead://export-progress",
            ExportProgress {
                id: eid.clone(),
                rows,
                bytes,
                phase: phase.to_string(),
            },
        );
    };

    export_core(
        &client,
        base,
        &username,
        &password,
        indices,
        body,
        format,
        fields,
        include_meta,
        csv_columns,
        out_path,
        max_rows,
        chunk,
        cancel,
        &on_progress,
    )
    .await
}

/// The export engine. Kept free of Tauri types so it can be unit tested
/// against a mock ES server.
#[allow(clippy::too_many_arguments)]
async fn export_core(
    client: &reqwest::Client,
    base: &str,
    username: &Option<String>,
    password: &Option<String>,
    indices: &str,
    body: &str,
    format: &str,
    fields: Option<Vec<String>>,
    include_meta: bool,
    csv_columns: Option<Vec<String>>,
    out_path: &str,
    max_rows: Option<usize>,
    chunk: usize,
    cancel: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(usize, u64, &str) + Send + Sync),
) -> Result<ExportSummary, String> {
    let idx = if indices.trim().is_empty() {
        "_all".to_string()
    } else {
        indices.trim().to_string()
    };

    // The row limit can never exceed the hard cap. A limit of zero means
    // "no limit" - the cap takes over then.
    let limit: usize = match max_rows {
        Some(0) | None => MAX_EXPORT_ROWS,
        Some(n) => n.min(MAX_EXPORT_ROWS),
    };
    let user_limit = max_rows.filter(|n| *n > 0);

    // Reuse the query built by the UI, but drop the parts that only make
    // sense for an interactive page (paging, sorting, aggregations).
    let mut base_body: Value = serde_json::from_str(body).unwrap_or_else(|_| json!({}));
    if let Some(obj) = base_body.as_object_mut() {
        for k in ["from", "size", "sort", "aggs", "aggregations", "version"] {
            obj.remove(k);
        }
    }
    let query = base_body
        .get("query")
        .cloned()
        .unwrap_or_else(|| json!({ "match_all": {} }));

    // ---- pick a paging strategy ----
    let mut strategy = "from".to_string();
    let mut pit_id: Option<String> = None;
    let mut scroll_id: Option<String> = None;
    let mut first_page: Option<Value> = None;

    // 1) PIT — ES 7.10+, snapshot view, no max_result_window limit.
    // The endpoint does not accept a request body.
    let pit_url = format!("{}/{}/_pit?keep_alive=1m", base, idx);
    if let Ok(v) = send_no_body(client, "POST", &pit_url, username, password).await
        && let Some(pid) = v.get("id").and_then(|x| x.as_str())
    {
        pit_id = Some(pid.to_string());
        strategy = "PIT".to_string();
    }
    // 2) Scroll — ES <= 7.x, snapshot view, no max_result_window limit.
    // A scroll context does not allow track_total_hits to be disabled.
    if pit_id.is_none() {
        let scroll_url = format!("{}/{}/_search?scroll=2m", base, idx);
        let probe = json!({ "query": query, "size": chunk, "sort": ["_doc"] });
        if let Ok(v) = send_json(client, "POST", &scroll_url, &probe, username, password).await
            && v.get("_scroll_id").and_then(|x| x.as_str()).is_some()
        {
            scroll_id = v
                .get("_scroll_id")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            strategy = "Scroll".to_string();
            first_page = Some(v);
        }
    }

    // ---- output file ----
    let file = File::create(out_path).map_err(|e| format!("无法创建文件 {}：{}", out_path, e))?;
    let mut writer = Counting {
        inner: BufWriter::new(file),
        count: 0,
    };

    // CSV column set: metadata columns first, then the source fields.
    // When nothing is known upfront the source columns are derived from the
    // first document (see write_row).
    let mut source_cols: Vec<String> = match &fields {
        Some(list) => list.clone(),
        None => csv_columns.clone().unwrap_or_default(),
    };
    let mut derive_source_cols = source_cols.is_empty();
    let mut columns: Vec<String> = Vec::new();
    if include_meta {
        columns.push("_index".to_string());
        columns.push("_id".to_string());
    }
    columns.append(&mut source_cols);
    let mut header_done = format != "csv";
    let mut first_json = true;
    if format == "csv" {
        // BOM so Excel detects UTF-8 (Chinese field values otherwise garble)
        writer
            .write_all(&[0xEF, 0xBB, 0xBF])
            .map_err(|e| format!("写入文件失败：{}", e))?;
    }
    if format == "json" {
        writer
            .write_all(b"[")
            .map_err(|e| format!("写入文件失败：{}", e))?;
    }

    let mut rows: usize = 0;
    let mut last_sort: Option<Value> = None;
    let mut next_from: usize = 0;
    let mut complete = true;

    on_progress(0, 0, "running");

    // The paging loop runs inside an async block so that a failure can clean
    // up an output file which never received a single row.
    let loop_result: Result<(), String> = async {
        loop {
            if cancel.load(Ordering::SeqCst) {
                complete = false;
                break;
            }

            let page = match first_page.take() {
                Some(p) => p,
                None => match strategy.as_str() {
                    "PIT" => {
                        let mut b = json!({
                            "query": query,
                            "size": chunk,
                            "sort": [{ "_shard_doc": "asc" }],
                            "pit": { "id": pit_id.clone().unwrap_or_default(), "keep_alive": "1m" },
                            "track_total_hits": false
                        });
                        if let Some(ls) = &last_sort {
                            b["search_after"] = ls.clone();
                        }
                        send_json(
                            client,
                            "POST",
                            &format!("{}/_search", base),
                            &b,
                            username,
                            password,
                        )
                        .await?
                    }
                    "Scroll" => {
                        let sid = scroll_id.clone().unwrap_or_default();
                        send_json(
                            client,
                            "POST",
                            &format!("{}/_search/scroll", base),
                            &json!({ "scroll": "2m", "scroll_id": sid }),
                            username,
                            password,
                        )
                        .await?
                    }
                    _ => {
                        let b = json!({
                            "query": query,
                            "size": chunk,
                            "from": next_from,
                            "track_total_hits": false
                        });
                        send_json(
                            client,
                            "POST",
                            &format!("{}/{}/_search", base, idx),
                            &b,
                            username,
                            password,
                        )
                        .await?
                    }
                },
            };

            let hits = page
                .get("hits")
                .and_then(|h| h.get("hits"))
                .and_then(|h| h.as_array())
                .cloned()
                .unwrap_or_default();

            // advance the pager
            if strategy == "PIT" {
                last_sort = hits.last().and_then(|h| h.get("sort")).cloned();
            } else if strategy == "Scroll" {
                if let Some(sid) = page.get("_scroll_id").and_then(|x| x.as_str()) {
                    scroll_id = Some(sid.to_string());
                }
            } else {
                next_from += hits.len();
            }

            for hit in &hits {
                if cancel.load(Ordering::SeqCst) {
                    complete = false;
                    break;
                }
                if rows >= limit {
                    complete = false;
                    break;
                }
                write_row(
                    &mut writer,
                    format,
                    hit,
                    &fields,
                    include_meta,
                    &mut columns,
                    &mut derive_source_cols,
                    &mut header_done,
                    &mut first_json,
                )?;
                rows += 1;
            }
            if !complete {
                break;
            }

            on_progress(rows, writer.count, "running");

            if hits.len() < chunk {
                break; // last page
            }
        }
        Ok(())
    }
    .await;

    if let Err(e) = loop_result {
        if writer.count == 0 {
            // nothing was written -> do not leave a misleading empty file
            let _ = std::fs::remove_file(out_path);
        }
        return Err(e);
    }

    if format == "json" {
        writer
            .write_all(b"]")
            .map_err(|e| format!("写入文件失败：{}", e))?;
    }
    writer.flush().map_err(|e| format!("写入文件失败：{}", e))?;

    // release ES-side resources
    if let Some(pid) = &pit_id {
        let _ = send_json(
            client,
            "DELETE",
            &format!("{}/_pit", base),
            &json!({ "id": pid }),
            username,
            password,
        )
        .await;
    }
    if let Some(sid) = &scroll_id {
        let _ = send_json(
            client,
            "DELETE",
            &format!("{}/_search/scroll", base),
            &json!({ "scroll_id": [sid] }),
            username,
            password,
        )
        .await;
    }

    on_progress(
        rows,
        writer.count,
        if complete { "done" } else { "cancelled" },
    );

    Ok(ExportSummary {
        path: out_path.to_string(),
        format: format.to_string(),
        rows,
        bytes: writer.count,
        strategy,
        complete,
        limit: user_limit,
        // the export was cut short because the hard cap was reached, not
        // because of the user's own row limit or a cancel
        hit_hard_cap: !complete && user_limit.is_none() && rows >= MAX_EXPORT_ROWS,
    })
}

/// POST/DELETE a JSON body to ES and return the parsed response.
async fn send_json(
    client: &reqwest::Client,
    method: &str,
    url: &str,
    body: &Value,
    username: &Option<String>,
    password: &Option<String>,
) -> Result<Value, String> {
    send_request(client, method, url, Some(body), username, password).await
}

/// A request without a body.
///
/// The `_pit` endpoint rejects a request body ("does not support having a
/// body"), so it cannot go through `send_json`.
async fn send_no_body(
    client: &reqwest::Client,
    method: &str,
    url: &str,
    username: &Option<String>,
    password: &Option<String>,
) -> Result<Value, String> {
    send_request(client, method, url, None, username, password).await
}

async fn send_request(
    client: &reqwest::Client,
    method: &str,
    url: &str,
    body: Option<&Value>,
    username: &Option<String>,
    password: &Option<String>,
) -> Result<Value, String> {
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client
        .request(m, url)
        .header("Content-Type", "application/json");
    if let Some(b) = body {
        req = req.body(serde_json::to_string(b).unwrap_or_else(|_| "{}".into()));
    }
    if let Some(u) = username
        && !u.is_empty()
    {
        req = req.basic_auth(u, Some(password.clone().unwrap_or_default()));
    }
    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("连接超时（60 秒内无响应）: {}", url)
        } else {
            format!("请求失败 {}：{}", url, e)
        }
    })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        let reason = value
            .get("error")
            .and_then(|e| e.get("reason"))
            .and_then(|r| r.as_str())
            .unwrap_or("");
        let detail = if reason.is_empty() {
            text.chars().take(300).collect::<String>()
        } else {
            reason.to_string()
        };
        let mut msg = format!("ES 返回 HTTP {}：{}", status.as_u16(), detail);
        if detail.contains("Result window is too large") {
            msg.push_str(
                "（该集群未提供 PIT/Scroll，此分页方式受 index.max_result_window 限制；\
                 请减少导出条数或改用支持深分页的集群）",
            );
        }
        return Err(msg);
    }
    Ok(value)
}

/// Build the exported document: the _source (optionally reduced to the
/// selected fields) plus the hit metadata.
fn build_obj(hit: &Value, fields: &Option<Vec<String>>, include_meta: bool) -> Value {
    let src = hit.get("_source").cloned().unwrap_or(Value::Null);
    let mut obj = match fields {
        Some(list) => {
            let mut m = serde_json::Map::new();
            for f in list {
                m.insert(f.clone(), get_path(&src, f));
            }
            Value::Object(m)
        }
        None => src,
    };
    if include_meta && let Some(m) = obj.as_object_mut() {
        if let Some(v) = hit.get("_index") {
            m.insert("_index".into(), v.clone());
        }
        if let Some(v) = hit.get("_id") {
            m.insert("_id".into(), v.clone());
        }
        if let Some(v) = hit.get("_score")
            && !v.is_null()
        {
            m.insert("_score".into(), v.clone());
        }
    }
    obj
}

/// Read a (possibly dotted) path out of a document.
fn get_path(src: &Value, path: &str) -> Value {
    if !path.contains('.') {
        return src.get(path).cloned().unwrap_or(Value::Null);
    }
    let mut cur = src;
    for part in path.split('.') {
        match cur.get(part) {
            Some(v) => cur = v,
            None => return Value::Null,
        }
    }
    cur.clone()
}

/// Flatten nested objects into dotted keys (mirrors flattenSource in TS).
fn flatten_into(v: &Value, prefix: &str, out: &mut serde_json::Map<String, Value>) {
    let obj = match v {
        Value::Object(m) => m,
        _ => return,
    };
    for (k, val) in obj {
        let key = if prefix.is_empty() {
            k.clone()
        } else {
            format!("{}.{}", prefix, k)
        };
        match val {
            Value::Object(_) => flatten_into(val, &key, out),
            Value::Array(a) => {
                let s = a
                    .iter()
                    .map(|x| match x {
                        Value::Object(_) | Value::Array(_) => x.to_string(),
                        Value::Null => String::new(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                out.insert(key, Value::String(s));
            }
            other => {
                out.insert(key, other.clone());
            }
        }
    }
}

fn csv_cell(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
    }
}

fn csv_escape(s: &str) -> String {
    if s.contains('"') || s.contains(',') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Write one hit in the requested format.
#[allow(clippy::too_many_arguments)]
fn write_row<W: Write>(
    writer: &mut Counting<W>,
    format: &str,
    hit: &Value,
    fields: &Option<Vec<String>>,
    include_meta: bool,
    columns: &mut Vec<String>,
    derive_source_cols: &mut bool,
    header_done: &mut bool,
    first_json: &mut bool,
) -> Result<(), String> {
    match format {
        "csv" => {
            if !*header_done {
                if *derive_source_cols {
                    // no column list given: derive it from the first document
                    let src = hit.get("_source").cloned().unwrap_or(Value::Null);
                    let mut flat = serde_json::Map::new();
                    flatten_into(&src, "", &mut flat);
                    columns.extend(flat.keys().cloned());
                    *derive_source_cols = false;
                }
                let head = columns
                    .iter()
                    .map(|c| csv_escape(c))
                    .collect::<Vec<_>>()
                    .join(",");
                writer
                    .write_all(format!("{}\n", head).as_bytes())
                    .map_err(|e| format!("写入文件失败：{}", e))?;
                *header_done = true;
            }
            let src = hit.get("_source").cloned().unwrap_or(Value::Null);
            let mut flat = serde_json::Map::new();
            flatten_into(&src, "", &mut flat);
            let cells = columns
                .iter()
                .map(|c| {
                    let v = match c.as_str() {
                        "_index" => hit.get("_index"),
                        "_id" => hit.get("_id"),
                        "_score" => hit.get("_score"),
                        other => flat.get(other),
                    };
                    csv_escape(&csv_cell(v))
                })
                .collect::<Vec<_>>()
                .join(",");
            writer
                .write_all(format!("{}\n", cells).as_bytes())
                .map_err(|e| format!("写入文件失败：{}", e))?;
        }
        "json" => {
            if *first_json {
                *first_json = false;
            } else {
                writer
                    .write_all(b",")
                    .map_err(|e| format!("写入文件失败：{}", e))?;
            }
            let obj = build_obj(hit, fields, include_meta);
            writer
                .write_all(
                    serde_json::to_string(&obj)
                        .unwrap_or_else(|_| "{}".into())
                        .as_bytes(),
                )
                .map_err(|e| format!("写入文件失败：{}", e))?;
        }
        _ => {
            // ndjson
            let obj = build_obj(hit, fields, include_meta);
            writer
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&obj).unwrap_or_else(|_| "{}".into())
                    )
                    .as_bytes(),
                )
                .map_err(|e| format!("写入文件失败：{}", e))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod export_tests;

#[cfg(test)]
mod timeout_tests;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ExportState::default())
        .setup(|app| {
            // The configured window size (1440x900) can be larger than the
            // screen - e.g. a 1138px wide logical desktop. Windows then clamps
            // the window but the webview keeps the size it was created with,
            // so everything on the right edge is clipped and invisible.
            // Size the window to the monitor instead.
            if let Some(window) = app.get_webview_window("main") {
                match window.current_monitor() {
                    Ok(Some(monitor)) => {
                        let scale = monitor.scale_factor();
                        let msize = monitor.size();
                        // monitor size in logical units (the window API wants those)
                        let avail_w = msize.width as f64 / scale;
                        let avail_h = msize.height as f64 / scale;
                        let w = (avail_w - 24.0).clamp(900.0, 1440.0);
                        let h = (avail_h - 48.0).clamp(600.0, 900.0);
                        let _ = window.set_size(tauri::LogicalSize::new(w, h));
                        let _ = window.center();
                    }
                    Ok(None) => {}
                    Err(_) => {}
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            es_request,
            export_cancel,
            export_pick_path,
            export_docs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
