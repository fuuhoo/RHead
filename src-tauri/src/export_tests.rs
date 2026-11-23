// Tests for the bulk export engine. A mock ES server serves a synthetic
// corpus so the paging strategies, the formatters and the limit/cancel
// handling can be verified without a real cluster.

use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

/// A mock ES that serves `total` documents over the PIT / search_after API
/// (and the classic from/size API).
struct MockEs {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
    pit_hits: Arc<AtomicUsize>,
}

fn mock_es(total: usize, pit_supported: bool, scroll_supported: bool) -> MockEs {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let pit_hits = Arc::new(AtomicUsize::new(0));

    let reqs = requests.clone();
    let hits = pit_hits.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or("GET").to_string();
            let target = parts.next().unwrap_or("/").to_string();

            // read body (Content-Length)
            let mut len = 0usize;
            for _ in 0..8 {
                let mut h = String::new();
                if reader.read_line(&mut h).is_err() {
                    break;
                }
                if h.trim().is_empty() {
                    break;
                }
                let lower = h.to_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; len];
            if len > 0 {
                let _ = reader.read_exact(&mut body);
            }
            let body = String::from_utf8_lossy(&body).to_string();
            reqs.lock().unwrap().push(format!("{} {}", method, target));

            let response = handle(
                &method,
                &target,
                &body,
                total,
                pit_supported,
                scroll_supported,
                &hits,
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });

    MockEs {
        port,
        requests,
        pit_hits,
    }
}

fn handle(
    method: &str,
    target: &str,
    body: &str,
    total: usize,
    pit_supported: bool,
    scroll_supported: bool,
    pit_hits: &Arc<AtomicUsize>,
) -> String {
    let path = target.split('?').next().unwrap_or("/");
    let is_scroll_query = target.contains("scroll=");

    if method == "DELETE" {
        return json_response(200, "{}");
    }
    if path.ends_with("/_pit") {
        if !pit_supported {
            return json_response(400, r#"{"error":{"reason":"no PIT here"}}"#);
        }
        return json_response(200, r#"{"id":"pit-1"}"#);
    }
    if path == "/_search/scroll" {
        // continuation: the scroll id carries the next offset and the page size
        let v: Value = serde_json::from_str(body).unwrap_or(json!({}));
        let sid = v.get("scroll_id").and_then(|x| x.as_str()).unwrap_or("");
        let mut it = sid.split(':');
        let _tag = it.next();
        let start: usize = it.next().unwrap_or("0").parse().unwrap_or(0);
        let size: usize = it.next().unwrap_or("10").parse().unwrap_or(10);
        let end = (start + size).min(total);
        let mut hits = Vec::new();
        for i in start..end {
            hits.push(doc_hit(i));
        }
        return json_response(
            200,
            &json!({
                "_scroll_id": format!("scroll:{}:{}", end, size),
                "hits": { "total": { "value": total, "relation": "eq" }, "hits": hits }
            })
            .to_string(),
        );
    }
    if path.ends_with("/_search") || path == "/_search" {
        let v: Value = serde_json::from_str(body).unwrap_or(json!({}));
        let size = v.get("size").and_then(|x| x.as_u64()).unwrap_or(10) as usize;
        let mut start = 0usize;
        if let Some(sa) = v.get("search_after").and_then(|x| x.as_array()) {
            if let Some(last) = sa.first().and_then(|x| x.as_u64()) {
                start = last as usize + 1;
            }
        } else if let Some(f) = v.get("from").and_then(|x| x.as_u64()) {
            start = f as usize;
        }
        let end = (start + size).min(total);
        let mut hits = Vec::new();
        for i in start..end {
            hits.push(doc_hit(i));
        }
        if v.get("pit").is_some() {
            pit_hits.fetch_add(1, Ordering::SeqCst);
        }
        let mut resp = json!({
            "took": 1,
            "hits": { "total": { "value": total, "relation": "eq" }, "max_score": 1.0, "hits": hits }
        });
        if is_scroll_query {
            if !scroll_supported {
                return json_response(400, r#"{"error":{"reason":"no scroll here"}}"#);
            }
            resp["_scroll_id"] = json!(format!("scroll:{}:{}", end, size));
        }
        return json_response(200, &resp.to_string());
    }
    json_response(404, r#"{"error":{"reason":"not found"}}"#)
}

fn doc_hit(i: usize) -> Value {
    json!({
        "_index": "test-index",
        "_id": format!("doc-{}", i),
        "_score": 1.0,
        "_source": {
            "seq": i,
            "name": format!("中文名称{}", i),
            "tricky": format!("comma,quote\"newline\ntab\tend{}", i),
            "nullable": if i.is_multiple_of(5) { Value::Null } else { json!(i) },
            "nested": { "a": i, "b": format!("v{}", i) },
            "list": [1, 2, 3],
            "objs": [{ "x": 1 }],
            "flag": i.is_multiple_of(2)
        },
        "sort": [i]
    })
}

fn json_response(status: u16, body: &str) -> String {
    format!(
        "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        body.len(),
        body
    )
}

fn tmp_path(name: &str) -> String {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "rhead-export-test-{}-{}.out",
        name,
        std::process::id()
    ));
    p.to_string_lossy().to_string()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
}

/// Options for a single export run in the tests.
#[allow(clippy::too_many_arguments)]
fn run(
    es: &MockEs,
    format: &str,
    fields: Option<Vec<String>>,
    include_meta: bool,
    csv_columns: Option<Vec<String>>,
    out: &str,
    max_rows: Option<usize>,
    chunk: usize,
    cancel: Option<Arc<AtomicBool>>,
) -> ExportSummary {
    let base = format!("http://127.0.0.1:{}", es.port);
    let flag = cancel.unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    let noop = |_: usize, _: u64, _: &str| {};
    let rt = tauri::async_runtime::Runtime::Tokio(
        tauri::async_runtime::TokioRuntime::new().expect("runtime"),
    );
    rt.block_on(async {
        export_core(
            &client(),
            &base,
            &None,
            &None,
            "test-index",
            r#"{"query":{"match_all":{}},"from":0,"size":50}"#,
            format,
            fields,
            include_meta,
            csv_columns,
            out,
            max_rows,
            chunk,
            &flag,
            &noop,
        )
        .await
    })
    .expect("export failed")
}

#[test]
fn exports_everything_via_pit_as_ndjson() {
    let es = mock_es(2500, true, true);
    let out = tmp_path("ndjson");
    let s = run(&es, "ndjson", None, true, None, &out, None, 500, None);

    assert_eq!(s.rows, 2500, "all documents must be exported");
    assert_eq!(s.strategy, "PIT", "PIT must be preferred when available");
    assert!(s.complete);
    assert!(s.bytes > 0);

    let text = std::fs::read_to_string(&out).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2500);
    // every line is a standalone JSON document: _source fields merged at the
    // top level, metadata prefixed
    for (i, l) in lines.iter().enumerate() {
        let v: Value = serde_json::from_str(l).unwrap_or_else(|_| panic!("line {} is not json", i));
        assert_eq!(v["_index"], "test-index");
        assert_eq!(v["_id"], format!("doc-{}", i));
        assert_eq!(v["seq"], i as u64);
        assert_eq!(v["name"], format!("中文名称{}", i));
    }
    // the paging actually advanced
    assert!(es.pit_hits.load(Ordering::SeqCst) >= 5);
    let reqs = es.requests.lock().unwrap().clone();
    assert!(reqs.iter().any(|r| r.contains("/_pit")));
    let _ = std::fs::remove_file(&out);
}

#[test]
fn exports_as_csv_with_header_and_escaping() {
    let es = mock_es(120, true, true);
    let out = tmp_path("csv");
    let s = run(
        &es,
        "csv",
        None,
        true,
        Some(vec!["seq".into(), "name".into(), "tricky".into()]),
        &out,
        None,
        50,
        None,
    );
    assert_eq!(s.rows, 120);

    let bytes = std::fs::read(&out).unwrap();
    // UTF-8 BOM so Excel detects the encoding
    assert_eq!(&bytes[0..3], &[0xEF, 0xBB, 0xBF]);
    let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
    let mut lines = text.lines();
    let header = lines.next().unwrap();
    assert_eq!(header, "_index,_id,seq,name,tricky");
    let first = lines.next().unwrap();
    // commas and quotes must be quoted, newlines escaped inside the field
    assert!(first.starts_with("test-index,doc-0,0,"));
    assert!(first.contains("\"comma,quote\"\"newline"));
    let all: Vec<&str> = text.lines().collect();
    // 1 header + 120 rows (the embedded newline stays inside its quoted field)
    assert!(all.len() >= 121);
    let _ = std::fs::remove_file(&out);
}

#[test]
fn exports_as_json_array() {
    let es = mock_es(70, true, true);
    let out = tmp_path("json");
    let s = run(&es, "json", None, false, None, &out, None, 30, None);
    assert_eq!(s.rows, 70);
    let text = std::fs::read_to_string(&out).unwrap();
    let v: Value = serde_json::from_str(&text).expect("valid json array");
    let arr = v.as_array().expect("array");
    assert_eq!(arr.len(), 70);
    // include_meta = false -> no _index/_id keys
    assert!(arr[0].get("_id").is_none());
    assert_eq!(arr[0]["seq"], 0);
    let _ = std::fs::remove_file(&out);
}

#[test]
fn honours_the_row_limit() {
    let es = mock_es(1000, true, true);
    let out = tmp_path("limit");
    let s = run(&es, "ndjson", None, true, None, &out, Some(25), 10, None);
    assert_eq!(s.rows, 25);
    assert!(!s.complete, "a limited export is not complete");
    let text = std::fs::read_to_string(&out).unwrap();
    assert_eq!(text.lines().count(), 25);
    let _ = std::fs::remove_file(&out);
}

#[test]
fn can_be_cancelled() {
    let es = mock_es(5000, true, true);
    let out = tmp_path("cancel");
    let flag = Arc::new(AtomicBool::new(false));
    let f2 = flag.clone();
    // cancel as soon as the export starts
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(30));
        f2.store(true, Ordering::SeqCst);
    });
    let s = run(&es, "ndjson", None, true, None, &out, None, 10, Some(flag));
    assert!(!s.complete, "a cancelled export is not complete");
    assert!(s.rows < 5000);
    let _ = std::fs::remove_file(&out);
}

#[test]
fn selects_only_the_requested_fields() {
    let es = mock_es(20, true, true);
    let out = tmp_path("fields");
    let s = run(
        &es,
        "ndjson",
        Some(vec!["seq".into(), "nested.a".into()]),
        true,
        None,
        &out,
        None,
        10,
        None,
    );
    assert_eq!(s.rows, 20);
    let text = std::fs::read_to_string(&out).unwrap();
    let first: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert!(first.get("seq").is_some());
    assert!(first.get("nested.a").is_some());
    assert!(
        first.get("name").is_none(),
        "unselected fields must be dropped"
    );
    assert_eq!(first["_id"], "doc-0");
    let _ = std::fs::remove_file(&out);
}

#[test]
fn removes_the_output_file_when_the_export_fails() {
    // bind and immediately release a port -> nothing is listening there
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let out = tmp_path("fail");
    let base = format!("http://127.0.0.1:{}", port);
    let flag = Arc::new(AtomicBool::new(false));
    let noop = |_: usize, _: u64, _: &str| {};
    let rt = tauri::async_runtime::Runtime::Tokio(
        tauri::async_runtime::TokioRuntime::new().expect("runtime"),
    );
    let res = rt.block_on(async {
        export_core(
            &client(),
            &base,
            &None,
            &None,
            "test-index",
            r#"{"query":{"match_all":{}}}"#,
            "ndjson",
            None,
            true,
            None,
            &out,
            None,
            100,
            &flag,
            &noop,
        )
        .await
    });
    assert!(res.is_err(), "the export must fail");
    assert!(
        !std::path::Path::new(&out).exists(),
        "a failed export must not leave an empty file behind"
    );
}

#[test]
fn falls_back_to_scroll_when_pit_is_missing() {
    let es = mock_es(300, false, true);
    let out = tmp_path("scroll");
    let s = run(&es, "ndjson", None, true, None, &out, None, 100, None);
    assert_eq!(
        s.strategy, "Scroll",
        "must fall back to scroll when PIT is missing"
    );
    assert_eq!(s.rows, 300);
    let text = std::fs::read_to_string(&out).unwrap();
    assert_eq!(text.lines().count(), 300);
    let _ = std::fs::remove_file(&out);
}

#[test]
fn falls_back_to_from_paging_without_pit_or_scroll() {
    let es = mock_es(300, false, false);
    let out = tmp_path("from");
    let s = run(&es, "ndjson", None, true, None, &out, None, 100, None);
    assert_eq!(
        s.strategy, "from",
        "must fall back when neither PIT nor scroll exist"
    );
    assert_eq!(s.rows, 300);
    let _ = std::fs::remove_file(&out);
}
