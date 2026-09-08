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
    /// 서버가 `workspace/configuration`으로 물어오는 **섹션의 값**. 스펙이 준다
    /// ([`crate::spec::ServerSpec::configuration`]) — 이 파일은 규약(arity)만 지킨다.
    config: ConfigFn,
}

/// `(section) -> 값` — `None`이면 그 항목에 `null`을 돌려준다(2.6.2 `items.map(() => null)`).
/// 언어별 설정(pyright의 `python.pythonPath`·Roslyn의 옵션 묶음)은 **전부 여기로** 들어온다.
pub type ConfigFn = Box<dyn Fn(&str) -> Option<Value> + Send + Sync>;

/// 아무 설정도 안 주는 서버(tsserver-ls) — 스펙이 `no_configuration`일 때 쓰는 기본값.
pub fn null_config() -> ConfigFn {
    Box::new(|_| None)
}

/// 서버가 보내오는 통지를 관찰하는 훅(`$/progress`·`projectInitializationComplete`).
/// 읽기 스레드에서 불리므로 **오래 걸리는 일을 하면 안 된다**.
pub type NotifyHook = Box<dyn Fn(&str, &Value) + Send + Sync>;

impl Rpc {
    /// 자식의 stdio를 물고 읽기 스레드를 띄운다.
    /// `config`는 서버가 물어올 설정의 값 원천 — 스펙에서 온다(언어 특례가 여기 안 산다).
    pub fn start(stdin: ChildStdin, stdout: ChildStdout, on_notify: NotifyHook, config: ConfigFn) -> Arc<Rpc> {
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            cv: Condvar::new(),
            dead: AtomicBool::new(false),
        });
        let rpc = Arc::new(Rpc {
            stdin: Mutex::new(Some(stdin)),
            next_id: AtomicI64::new(1),
            shared: shared.clone(),
            config,
        });
        let reader_rpc = Arc::downgrade(&rpc);
        std::thread::Builder::new()
            .name("ccg-lsp-read".into())
            .spawn(move || read_loop(stdout, shared, reader_rpc, on_notify))
            .ok();
        rpc
    }

    /// ★LSPIDLE R3 — **자식도 스레드도 없는 살아 있는 rpc**(못 전용).
    ///
    /// 왜 필요한가: 크리틱 R2 §4-B가 생존시킨 돌연변이 넷(`sweep_step`·`status`가 멎음 시계를
    /// 위조 · 호출부가 `Reclaim`을 안 하거나 `step`을 안 부름)은 전부 **`Server`를 실제로
    /// 통과해야** 잡힌다. 그런데 `Server::spawn`은 진짜 언어 서버를 요구하고, 그건 갓 클론한
    /// 레포·CI·크리틱의 배치에서 안 뜬다 — 못이 환경에 기대면 조용히 통과한다(R2가 B급 ①에서
    /// 이미 밟은 함정이다).
    ///
    /// 그래서 수명 판정이 **실제로 만지는 것**(상태·시계)만 진짜인 서버를 만든다. `is_dead()`가
    /// 거짓이라야 스윕의 좀비 갈래로 새지 않으므로, 여기서 파이프 없이 「살아 있음」을 준다.
    /// 요청을 보내면 `write`가 「stdin 닫힘」으로 실패한다 — 수명 못은 요청을 안 보낸다.
    #[cfg(test)]
    pub(crate) fn inert_for_test() -> Arc<Rpc> {
        Arc::new(Rpc {
            stdin: Mutex::new(None),
            next_id: AtomicI64::new(1),
            shared: Arc::new(Shared {
                pending: Mutex::new(HashMap::new()),
                cv: Condvar::new(),
                dead: AtomicBool::new(false),
            }),
            config: null_config(),
        })
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
///
/// **여기에 언어 이름이 나오면 설계 실패다.** 이 함수가 아는 것은 LSP 규약뿐이고,
/// 값은 전부 `config`(= 스펙의 [`crate::spec::ServerSpec::configuration`])에서 온다.
/// pyright를 붙일 때 이 파일이 다시 열리지 않는 이유가 이 갈래다.
///
/// `workspace/configuration`의 규약: 응답은 **`items` 수와 같은 길이의 배열**이다
/// (2.6.2 `manager.ts:2478` `items.map(() => null)`). 빈 배열을 돌려주면 항목과 값을
/// 인덱스로 짝짓는 서버(pyright·Roslyn)가 그 자리에서 예외를 던지거나 설정을 통째로 버린다.
fn answer_server_request(method: &str, params: &Value, config: &ConfigFn) -> Value {
    match method {
        "workspace/configuration" => {
            let Some(items) = params.get("items").and_then(Value::as_array) else {
                // items가 없는 요청은 규약 위반 — 그래도 배열은 돌려준다(서버 큐가 멈추지 않게)
                return json!([]);
            };
            Value::Array(
                items
                    .iter()
                    .map(|i| {
                        let section = i.get("section").and_then(Value::as_str).unwrap_or("");
                        config(section).unwrap_or(Value::Null)
                    })
                    .collect(),
            )
        }
        "workspace/applyEdit" => json!({ "applied": false }),
        // 진행률 토큰 생성 수락 — 이후 $/progress(백그라운드 인덱싱 %)가 흘러온다
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
            let params = msg.get("params").unwrap_or(&Value::Null);
            if m == "client/registerCapability" {
                on_notify(m, params);
            }
            let result = answer_server_request(m, params, &rpc.config);
            let _ = rpc.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
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
    use super::*;

    #[test]
    fn finds_frame_separator() {
        assert_eq!(find(b"Content-Length: 5\r\n\r\nhello", b"\r\n\r\n"), Some(17));
        assert_eq!(find(b"nope", b"\r\n\r\n"), None);
    }

    /// **LSP 규약** — `workspace/configuration` 응답은 `items` 수만큼의 원소여야 한다.
    /// R1은 `[]`를 돌려줬고(크리틱 C-5), 그건 pyright/Roslyn이 인덱스로 짝짓는 순간 깨진다.
    #[test]
    fn configuration_answer_has_one_element_per_item() {
        let params = json!({ "items": [{ "section": "python" }, { "section": "python.analysis" }] });
        let r = answer_server_request("workspace/configuration", &params, &null_config());
        assert_eq!(r.as_array().map(Vec::len), Some(2), "{r}");
        assert!(r[0].is_null() && r[1].is_null(), "설정이 없으면 항목마다 null (2.6.2 items.map(() => null))");
    }

    /// 값은 **스펙**이 준다 — 이 파일에 언어 이름이 없어도 pyright의 인터프리터가 실린다.
    #[test]
    fn configuration_values_come_from_the_spec_hook() {
        let cfg: ConfigFn = Box::new(|section| match section {
            "python" => Some(json!({ "pythonPath": "C:\\venv\\Scripts\\python.exe" })),
            _ => None,
        });
        let params = json!({ "items": [{ "section": "python" }, { "section": "python.analysis" }] });
        let r = answer_server_request("workspace/configuration", &params, &cfg);
        assert_eq!(r[0]["pythonPath"], "C:\\venv\\Scripts\\python.exe");
        assert!(r[1].is_null(), "스펙이 모르는 섹션은 null — 배열 길이는 그대로 2");
    }

    #[test]
    fn configuration_without_items_still_answers_an_array() {
        let r = answer_server_request("workspace/configuration", &json!({}), &null_config());
        assert_eq!(r, json!([]));
    }

    #[test]
    fn other_server_requests_keep_their_262_answers() {
        assert_eq!(
            answer_server_request("workspace/applyEdit", &Value::Null, &null_config()),
            json!({ "applied": false })
        );
        assert_eq!(
            answer_server_request("window/workDoneProgress/create", &Value::Null, &null_config()),
            Value::Null
        );
        // 모르는 요청도 **반드시 답한다** — 안 답하면 서버 큐가 멈춘다
        assert_eq!(answer_server_request("client/registerCapability", &Value::Null, &null_config()), Value::Null);
    }
}
