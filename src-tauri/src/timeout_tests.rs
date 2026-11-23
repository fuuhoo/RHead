// Tests for the request timeout of `es_request`.
//
// A mock server accepts the connection but never answers, so the only way
// the request can end is the client-side timeout. This proves that the
// timeout the UI sets really reaches reqwest (and not just the error text).

use super::*;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::thread;
use std::time::Instant;

/// Start a server that accepts connections and never replies.
/// Returns the port it listens on.
fn black_hole() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        // Keep the connections open: read the request, then sleep forever.
        for stream in listener.incoming() {
            let stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };
            thread::spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                loop {
                    thread::sleep(std::time::Duration::from_secs(60));
                }
            });
        }
    });
    port
}

/// A server that answers every request immediately.
fn fast_responder(body: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                        break;
                    }
                }
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            });
        }
    });
    port
}

#[test]
fn clamps_the_caller_supplied_timeout() {
    // default when nothing is given
    assert_eq!(resolve_timeout(None), DEFAULT_TIMEOUT_SECS);
    // below the minimum
    assert_eq!(resolve_timeout(Some(0)), MIN_TIMEOUT_SECS);
    // above the maximum
    assert_eq!(resolve_timeout(Some(9999)), MAX_TIMEOUT_SECS);
    // inside the range is kept
    assert_eq!(resolve_timeout(Some(30)), 30);
    assert_eq!(resolve_timeout(Some(600)), 600);
}

#[tokio::test]
async fn a_hanging_server_is_cut_off_after_the_timeout() {
    let port = black_hole();
    let base = format!("http://127.0.0.1:{}", port);

    let t0 = Instant::now();
    let err = es_request(
        base.clone(),
        "POST".into(),
        "some-index/_search".into(),
        Some("{}".into()),
        None,
        None,
        Some(1),
    )
    .await
    .expect_err("the request must not succeed");
    let elapsed = t0.elapsed();

    // the error must name the timeout that was actually applied
    assert!(
        err.contains("请求超时（1 秒内无响应）"),
        "unexpected error: {}",
        err
    );
    // and it must have given up rather than hanging forever
    assert!(
        elapsed < std::time::Duration::from_secs(8),
        "took too long: {:?}",
        elapsed
    );
}

#[tokio::test]
async fn a_fast_server_is_not_affected_by_the_timeout() {
    let port = fast_responder(r#"{"ok":true}"#);
    let base = format!("http://127.0.0.1:{}", port);

    let res = es_request(base, "GET".into(), "".into(), None, None, None, Some(30))
        .await
        .expect("request must succeed");

    assert_eq!(res.status, 200);
    assert!(res.body.contains("\"ok\":true"));
}

#[tokio::test]
async fn a_short_timeout_also_cuts_off_a_fast_server() {
    // A 1 second timeout on a server that never answers must fail; this is
    // the case the UI relies on when the user lowers the timeout.
    let port = black_hole();
    let base = format!("http://127.0.0.1:{}", port);

    let err = es_request(
        base,
        "GET".into(),
        "_cluster/health".into(),
        None,
        None,
        None,
        Some(1),
    )
    .await
    .expect_err("the request must not succeed");

    assert!(err.contains("请求超时"), "unexpected error: {}", err);
}
