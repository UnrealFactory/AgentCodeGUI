//! LSP 기본 프로토콜(Content-Length 프레이밍) 위의 최소 JSON-RPC 2.0 클라이언트.
//!
//! 2.6.2 `src/main/lsp/jsonrpc.ts`의 이식이되 **블로킹**이다 — IPC가 이미 전용 블로킹
//! 스레드에서 돌기 때문에(`ipc_call`의 `spawn_blocking`) 비동기 런타임을 끌어올 이유가
//! 없다. 서버당 읽기 스레드 하나가 프레임을 풀고, 요청자는 condvar에서 기다린다.
//!
//! **죽은 서버에 절대 패닉하지 않는다**: stdin이 닫히면 write는 조용히 실패하고 대기 중인
//! 요청은 `dispose`가 일괄 해제한다(2.6.2에서 EPIPE가 uncaughtException으로 앱을 통째로
//! 내리던 자리 — 그쪽은 `on('error')` 리스너로, 여기는 `Result` 무시로 같은 보장).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::process::{ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

enum Slot {
    Waiting,
    Done(Result<Value, String>),
}

struct Shared {
    pending: Mutex<HashMap<i64, Slot>>,
    cv: Condvar,
    dead: AtomicBool,
}

pub struct Rpc {
    stdin: Mutex<Option<ChildStdin>>,
    next_id: AtomicI64,
    shared: Arc<Shared>,
}

/// 서버가 보내오는 통지를 관찰하는 훅(`$/progress`·`projectInitializationComplete`).
/// 읽기 스레드에서 불리므로 **오래 걸리는 일을 하면 안 된다**.
pub type NotifyHook = Box<dyn Fn(&str, &Value) + Send + Sync>;

impl Rpc {
    /// 자식의 stdio를 물고 읽기 스레드를 띄운다.
    pub fn start(stdin: ChildStdin, stdout: ChildStdout, on_notify: NotifyHook) -> Arc<Rpc> {
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            cv: Condvar::new(),
            dead: AtomicBool::new(false),
        });
        let rpc = Arc::new(Rpc {
            stdin: Mutex::new(Some(stdin)),
            next_id: AtomicI64::new(1),
            shared: shared.clone(),
        });
        let reader_rpc = Arc::downgrade(&rpc);
        std::thread::Builder::new()
            .name("ccg-lsp-read".into())
            .spawn(move || read_loop(stdout, shared, reader_rpc, on_notify))
            .ok();
        rpc
    }

    pub fn is_dead(&self) -> bool {
        self.shared.dead.load(Ordering::Relaxed)
    }

    /// 요청 → 응답. 타임아웃/서버 사망은 `Err`.
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if self.is_dead() {
            return Err("LSP 서버가 종료됨".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        {
            let mut p = self.shared.pending.lock().unwrap();
            p.insert(id, Slot::Waiting);
        }
        if let Err(e) = self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })) {
            self.shared.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        let mut guard = self.shared.pending.lock().unwrap();
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match guard.get(&id) {
                None => return Err("요청이 사라짐".into()),
                Some(Slot::Done(_)) => {
                    if let Some(Slot::Done(r)) = guard.remove(&id) {
                        return r;
                    }
                    return Err("요청이 사라짐".into());
                }
                Some(Slot::Waiting) => {}
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                guard.remove(&id);
                // 서버가 계속 붙들고 있지 않게 취소를 보낸다(늦게 온 응답은 pending이 없어 버려진다)
                drop(guard);
                let _ = self.write(&json!({ "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": id } }));
                return Err(format!("LSP 요청 시간 초과: {method}"));
            }
            let (g, _t) = self.shared.cv.wait_timeout(guard, deadline - now).unwrap();
            guard = g;
        }
    }

    pub fn notify(&self, method: &str, params: Value) {
        if self.is_dead() {
            return;
        }
        let _ = self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// 대기 중인 요청을 전부 실패시키고 이후 호출을 즉시 실패로 만든다.
    pub fn dispose(&self, reason: &str) {
        if self.shared.dead.swap(true, Ordering::SeqCst) {
            return;
        }
        {
            let mut p = self.shared.pending.lock().unwrap();
            for (_, slot) in p.iter_mut() {
                *slot = Slot::Done(Err(reason.to_string()));
            }
        }
        self.shared.cv.notify_all();
        // stdin을 떨어뜨려 서버에 EOF를 준다(정상 종료 요청보다 확실하고 빠르다)
        *self.stdin.lock().unwrap() = None;
    }

    fn write(&self, msg: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        let mut guard = self.stdin.lock().unwrap();
        let Some(w) = guard.as_mut() else {
            return Err("stdin 닫힘".into());
        };
        // 헤더+본문을 한 번에 — 두 번 쓰면 그 사이에 다른 스레드가 끼어들 수 있다
        // (2.6.2는 단일 스레드라 문제가 없었지만 여기는 여러 IPC 스레드가 같은 rpc를 쓴다).
        let mut buf = Vec::with_capacity(body.len() + 32);
        buf.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
        buf.extend_from_slice(&body);
        w.write_all(&buf).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }
}

/// 서버→클라이언트 **요청**에 답한다. 답하지 않으면 서버 큐가 멈출 수 있다.
fn answer_server_request(method: &str) -> Value {
    match method {
        // tsserver-ls가 실제로 보내는 것들
        "workspace/configuration" => json!([]), // items 수만큼 null이 정석이지만 빈 배열도 수용된다
        "workspace/applyEdit" => json!({ "applied": false }),
        "window/workDoneProgress/create" => Value::Null,
        _ => Value::Null,
    }
}

fn read_loop(stdout: ChildStdout, shared: Arc<Shared>, rpc: std::sync::Weak<Rpc>, on_notify: NotifyHook) {
    let mut r = BufReader::new(stdout);
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut chunk = [0u8; 32 * 1024];
    loop {
        let n = match r.read(&mut chunk) {
            Ok(0) => break, // EOF — 서버 종료
            Ok(n) => n,
            Err(_) => break,
        };
        buf.extend_from_slice(&chunk[..n]);
        // 프레임이 여러 개 붙어 오거나 잘려 오는 걸 모두 처리
        loop {
            let Some(sep) = find(&buf, b"\r\n\r\n") else { break };
            let header = String::from_utf8_lossy(&buf[..sep]).to_ascii_lowercase();
            let len = header
                .split("content-length:")
                .nth(1)
                .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).find(|t| !t.is_empty()))
                .and_then(|s| s.parse::<usize>().ok());
            let Some(len) = len else {
                buf.drain(..sep + 4); // 헤더가 깨졌다 — 건너뛴다
                continue;
            };
            let end = sep + 4 + len;
            if buf.len() < end {
                break; // 본문이 아직 다 안 왔다
            }
            let body: Vec<u8> = buf[sep + 4..end].to_vec();
            buf.drain(..end);
            let Ok(msg) = serde_json::from_slice::<Value>(&body) else { continue };
            dispatch(&msg, &shared, &rpc, &on_notify);
        }
    }
    // 서버가 죽었다 — 대기 중인 요청을 전부 해제한다(안 그러면 타임아웃까지 매달린다)
    if let Some(rpc) = rpc.upgrade() {
        rpc.dispose("LSP 서버가 종료됨");
    } else {
        shared.dead.store(true, Ordering::SeqCst);
        let mut p = shared.pending.lock().unwrap();
        for (_, slot) in p.iter_mut() {
            *slot = Slot::Done(Err("LSP 서버가 종료됨".into()));
        }
        drop(p);
        shared.cv.notify_all();
    }
}

fn dispatch(msg: &Value, shared: &Arc<Shared>, rpc: &std::sync::Weak<Rpc>, on_notify: &NotifyHook) {
    let method = msg.get("method").and_then(Value::as_str);
    let id = msg.get("id");
    if let (Some(m), Some(id)) = (method, id) {
        // 서버 → 클라이언트 요청
        if let Some(rpc) = rpc.upgrade() {
            let _ = rpc.write(&json!({ "jsonrpc": "2.0", "id": id, "result": answer_server_request(m) }));
        }
        return;
    }
    if let Some(m) = method {
        on_notify(m, msg.get("params").unwrap_or(&Value::Null));
        return;
    }
    let Some(id) = id.and_then(Value::as_i64) else { return };
    let out = if let Some(e) = msg.get("error") {
        Err(e.get("message").and_then(Value::as_str).unwrap_or("LSP 오류").to_string())
    } else {
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    };
    let mut p = shared.pending.lock().unwrap();
    if let Some(slot) = p.get_mut(&id) {
        *slot = Slot::Done(out);
        drop(p);
        shared.cv.notify_all();
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::find;

    #[test]
    fn finds_frame_separator() {
        assert_eq!(find(b"Content-Length: 5\r\n\r\nhello", b"\r\n\r\n"), Some(17));
        assert_eq!(find(b"nope", b"\r\n\r\n"), None);
    }
}
