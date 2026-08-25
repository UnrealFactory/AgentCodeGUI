//! 계정 **쓰기** 채널 — 최종 파리티 감사 **T1**.
//!
//! 감사 실측: `auth:login`·`auth:logout`·`auth:set-default-account`·`auth:remove-account`·
//! `auth:reorder-accounts`의 Rust 핸들러가 **0개**였다(읽기 두 개만 있었다 —
//! `system.rs`의 `auth:list-accounts`·`codex-auth:list-accounts`). 그래서 설정 ▸ Account의
//! 「＋계정 추가」·「기본으로」·「삭제」가 전부 무반응이었고, 무엇보다 —
//!
//! > **새 사용자는 3.0에서 로그인할 방법이 없었다.** 2.6.2의 홈을 승계해야만 쓸 수 있었다.
//!
//! 도메인은 이미 `ccg-auth`에 다 있다(M5). 여기는 **배선**이다: 채널 ↔ 값, 자식 프로세스
//! 실행, 로그인 URL 방출. 세 가지를 지킨다.
//!
//! ## 1. 실홈 불가침 — 타입이 강제한다
//! `claude auth login/logout/status`는 전부 [`ccg_auth::IsolatedConfigDir`]로만 조립한다
//! (`ccg_auth::verify`). 그 타입은 **앱 홈 밖 경로로 만들어지지 않는다** — 사용자의
//! `~/.claude`를 향해 `auth logout`(서버 토큰 해지 = 되돌릴 수 없다)을 쏠 방법이 코드에 없다.
//!
//! ## 2. 목록을 바꾸는 쓰기는 예외 없이 CAS 경로
//! 로그인 편입·로그아웃·기본 계정·순서는 전부 `ccg_auth::claude`의
//! `update_store`(flock + 3-way 병합 + compare-and-swap)를 지난다. 직접 `write_store_file`을
//! 부르는 우회로는 이 파일에 없다. M11 R4가 회전 경로에서 닫은 창을 T1 배선이 로그인
//! 경로에서 다시 열지 않기 위해 f1ab32d가 CAS를 목록 편집까지 넓혀 뒀다.
//!
//! ## 3. 로그인 자식은 **우리가 스폰한 것만** 죽인다
//! 이름 기반 kill이 없다. 진행 중인 프로세스 핸들 하나를 [`LOGIN`]에 들고 있고,
//! 취소·5분 상한 둘 다 그 핸들로만 죽인다.

use super::{arg, ch};
use serde_json::{json, Value};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrd};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use ccg_auth::claude;
use ccg_auth::verify::{self, AuthStatus};
use ccg_auth::{CommandSpec, IsolatedConfigDir};

/// 이 모듈이 답하는 채널인가.
///
/// `ipc_call`이 이 목록을 보고 **전용 블로킹 풀**로 보낸다. 이유가 파일·Git 팔과 같다
/// (오히려 더 극단적이다): `auth:login`은 사용자가 브라우저에서 로그인을 끝낼 때까지
/// **최대 5분** 막히고, `auth:logout`은 해지 왕복 20초다. tauri의 async 워커는 코어
/// 수만큼의 tokio 스레드라 거기서 5분을 자면 그동안 다른 창의 IPC가 통째로 굶는다.
pub fn owns(channel: &str) -> bool {
    matches!(
        channel,
        ch::AUTH_LOGIN
            | ch::AUTH_LOGIN_CANCEL
            | ch::AUTH_LOGOUT
            | ch::AUTH_SET_DEFAULT_ACCOUNT
            | ch::AUTH_REMOVE_ACCOUNT
            | ch::AUTH_REORDER_ACCOUNTS
            // ★R28f SHIPBLOCK N1 — Codex 축의 같은 다섯. `codex login`도 사용자가
            // 브라우저에서 끝낼 때까지 최대 5분 막히므로 **같은 블로킹 풀**이어야 한다.
            | ch::CODEX_LOGIN
            | ch::CODEX_LOGIN_CANCEL
            | ch::CODEX_LOGOUT
            | ch::CODEX_SET_DEFAULT_ACCOUNT
            | ch::CODEX_REORDER_ACCOUNTS
    )
}

/// 인자 0의 이메일(문자열) — 두 축의 삭제·맨 위로가 같은 자리를 읽는다.
fn email_arg(p: &Value) -> String {
    arg(p, 0).as_str().unwrap_or("").to_string()
}

/// 인자 0의 이메일 배열(순서 변경).
fn emails_arg(p: &Value) -> Vec<String> {
    arg(p, 0)
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

pub fn dispatch(app: &AppHandle, channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        ch::AUTH_LOGIN => login(app, arg(p, 0).as_bool().unwrap_or(false)),
        ch::AUTH_LOGIN_CANCEL => {
            cancel_login();
            Value::Null
        }
        ch::AUTH_LOGOUT => {
            let email = arg(p, 0).as_str().unwrap_or("").to_string();
            logout(&email)
        }
        // ★R28 ACCT §4 — 「기본 계정」 개념이 사라졌다. 이 채널은 이제 **「맨 위로 이동」과
        // 동치**다(`claude::set_default_account` = `move_account_to_top`). 채널을 없애지
        // 않는 이유: 2.6.2 렌더러(동결)가 아직 이 이름을 부르고, 그쪽에서 「기본으로」를
        // 누르면 3.0에서도 같은 결과(그 계정이 맨 위 = 기본)가 나와야 한다.
        // 목록에 없는 이메일이면 도메인이 조용히 무시한다(2.6.2와 같다).
        ch::AUTH_SET_DEFAULT_ACCOUNT => {
            claude::set_default_account(arg(p, 0).as_str().unwrap_or(""));
            super::system::list_claude_accounts()
        }
        // 해지 **없이** 목록에서만 뺀다. 해지까지 하는 문은 `auth:logout`이다.
        ch::AUTH_REMOVE_ACCOUNT => {
            claude::remove_account(arg(p, 0).as_str().unwrap_or(""));
            super::system::list_claude_accounts()
        }
        ch::AUTH_REORDER_ACCOUNTS => {
            claude::reorder_accounts(&emails_arg(p));
            super::system::list_claude_accounts()
        }

        // ── Codex(OpenAI) 축 — 같은 저장소·같은 잠금 규율 ────────────────────────
        // 도메인은 전부 `ccg_auth::codex`에 있다(M5). 여기는 **배선**이고, 세 규약은
        // 위 Anthropic 축과 글자 그대로 같다: 실홈 불가침(`IsolatedConfigDir`) ·
        // 목록을 바꾸는 쓰기는 도메인 함수 하나만 지난다 · 자식은 우리가 스폰한 것만 죽인다.
        ch::CODEX_LOGIN => codex_login(app),
        ch::CODEX_LOGIN_CANCEL => {
            CODEX_LOGIN_SLOT.cancel();
            Value::Null
        }
        ch::CODEX_LOGOUT => codex_logout(&email_arg(p)),
        // ★R28f SHIPBLOCK N1(2) — 「기본 계정」이 사라진 뒤의 이 채널.
        //
        // **재정렬로 흡수한다**(`codex::set_default_account` = `move_account_to_top`).
        // no-op으로 두지 않는 이유 셋:
        //  ① 같은 홈을 여는 **2.6.2 렌더러(동결)**가 아직 이 채널을 부른다. 거기서
        //     「기본으로」를 누르면 3.0에서도 같은 결과(그 계정이 맨 위 = 기본)가 나와야 한다.
        //  ② Anthropic 축이 이미 이 선택을 했다(`AUTH_SET_DEFAULT_ACCOUNT`). 두 축이
        //     같은 이름의 채널에서 다르게 굴면 장부가 두 벌이 된다.
        //  ③ no-op은 **성공처럼 보이는 실패**다 — 렌더러는 새 목록을 받아 그대로 그리므로
        //     아무 표시 없이 순서만 안 바뀐다(이 라운드가 닫는 병과 정확히 같은 모양).
        ch::CODEX_SET_DEFAULT_ACCOUNT => {
            ccg_auth::codex::set_default_account(&email_arg(p));
            super::system::list_codex_accounts()
        }
        ch::CODEX_REORDER_ACCOUNTS => {
            ccg_auth::codex::reorder_accounts(&emails_arg(p));
            super::system::list_codex_accounts()
        }
        _ => return None,
    })
}

// ── 로그인 ───────────────────────────────────────────────────────────────────

/// 진행 중인 로그인 자식 **하나** + 그 시도 번호. 2.6.2 `loginProc`와 같은 자리 —
/// 취소(`auth:login-cancel`)와 5분 상한이 이 핸들로만 죽인다(이름 기반 kill 없음).
///
/// ★R28 T1T2 R2 — 번호가 같이 앉은 이유는 확인 크리틱 §6.3이다. 2.6.2는 마무리에서
/// **자기 자식인지 확인하고** 놓는다(`src/main/auth.ts:663  if (loginProc === child)`).
/// R1은 확인 없이 `take()`했다 — 로그인 A가 도는 중에 B가 시작하면 B가 A를 죽이는데,
/// A의 마무리가 B의 `*LOGIN = Some(...)` **뒤에** 도달하면 A가 **B의 핸들을 꺼내
/// `wait()`** 한다. 그러면 `LOGIN`이 비어 「취소」가 아무것도 못 죽이고, A가 B의 임시
/// 폴더를 읽고 지운다. (크리틱은 코드 근거만 남겼다 — 1.5초 간격 이중 로그인으로는
/// A가 18ms에 착지해 창이 안 열렸다.)
/// ★R28f SHIPBLOCK N1 — 축이 **둘**이 되면서(claude·codex) 이 규칙도 두 벌이 될
/// 뻔했다. 두 벌이면 한쪽만 고쳐지는 순간 그 축에서만 "취소가 아무것도 못 죽인다"가
/// 되살아난다. 그래서 슬롯을 타입으로 만들고 정적 인스턴스를 축마다 하나씩 둔다
/// (핸들은 축별로 **따로** 있어야 한다 — codex 로그인이 진행 중인 claude 로그인을
/// 죽이면 안 된다).
struct LoginSlot {
    proc: Mutex<Option<Live>>,
    /// 로그인 시도 번호. **스폰 전에** 올린다 — 다음 시도가 우리를 죽이기 전에 번호가
    /// 올라가야 "내가 아직 최신인가"가 그 사이의 창에서도 참이다.
    gen: AtomicU64,
}

/// 슬롯에 앉은 살아 있는 로그인 하나.
struct Live {
    gen: u64,
    child: Child,
    /// `cmd /C` 래퍼를 거쳐 띄웠는가([`codex_command`]). 그렇다면 **우리가 띄우려던
    /// 프로그램**은 이 자식이 아니라 이 자식의 직속 자식이다 — 취소가 거기까지 닿아야 한다.
    wrapped: bool,
}

impl LoginSlot {
    const fn new() -> LoginSlot {
        LoginSlot { proc: Mutex::new(None), gen: AtomicU64::new(0) }
    }

    /// 다음 시도 번호를 발급한다(스폰 **전에** 부른다).
    fn begin(&self) -> u64 {
        self.gen.fetch_add(1, AtomicOrd::SeqCst) + 1
    }

    fn cancel(&self) {
        // 잠금 **밖에서** 죽인다. 래퍼 갈래는 프로세스 스냅샷을 한 번 훑으므로
        // 수십 ms가 걸리고, 그동안 잠금을 쥐고 있으면 `owns()`를 묻는 펌프 스레드와
        // 두 번째 「취소」가 같이 선다.
        let taken = self.proc.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(mut live) = taken {
            // 순서가 중요하다 — 부모가 살아 있어야 직속 자식을 찾는다.
            kill_wrapped_child(live.child.id(), live.wrapped);
            let _ = live.child.kill();
            let _ = live.child.wait(); // 좀비를 남기지 않는다
        }
    }

    fn put(&self, gen: u64, child: Child, wrapped: bool) {
        *self.proc.lock().unwrap_or_else(|e| e.into_inner()) = Some(Live { gen, child, wrapped });
    }

    /// 이 시도가 아직 **가장 최근의 시도**인가 — 2.6.2 `loginProc === child`의 판정.
    fn still_current(&self, gen: u64) -> bool {
        self.gen.load(AtomicOrd::SeqCst) == gen
    }

    /// 슬롯에 **아직 내 자식이 앉아 있는가**. `false` = 취소됐거나 다음 시도가 치웠다
    /// (둘 다 "내 자식은 이미 죽었다"는 뜻이다).
    ///
    /// ★R28f SHIPBLOCK R2 — 이 물음이 [`pump_login`]의 두 번째 완료 신호다. R1까지
    /// 완료 신호는 **파이프 EOF 하나**뿐이었고, 그것이 확인 크리틱이 잰 5분 감옥의 기전이다.
    fn owns(&self, gen: u64) -> bool {
        self.proc.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|l| l.gen) == Some(gen)
    }

    /// **자기 자식일 때만** 핸들을 놓고 기다린다(2.6.2 `if (loginProc === child)`).
    fn finish(&self, gen: u64) {
        let mut g = self.proc.lock().unwrap_or_else(|e| e.into_inner());
        let mine = g.as_ref().map(|l| l.gen) == Some(gen);
        let taken = if mine { g.take() } else { None };
        drop(g); // wait()는 잠금 밖에서 — 남의 자식을 기다리며 취소를 막지 않는다
        if let Some(mut live) = taken {
            let _ = live.child.wait();
        }
    }
}

/// `cmd /C` 래퍼 갈래에서 **래퍼 안의 CLI**를 죽인다 — 래퍼가 아닌 경우엔 아무것도 안 한다.
///
/// ★R28f SHIPBLOCK R2 · 확인 크리틱 ★최대 격차의 절반.
///
/// 실측(크리틱): 가짜 `codex.cmd`(login이 `ping -n 600`으로 버팀)를 PATH 맨 앞에 두고
/// 「계정 추가」→「취소」를 누르면 **손자 `PING.EXE`가 앱 종료 뒤에도 산다**. 기전은
/// [`codex_command`]의 `cmd /C`다 — 우리 자식은 `cmd.exe`고 `Child::kill()`은 그것만
/// 죽인다. 정작 우리가 띄우려던 프로그램(셰임이 부른 CLI)은 재부모화되어 살아남는다.
///
/// ## 왜 트리 전체(`taskkill /T`)가 아니라 **직속 자식까지**인가
///
/// 로그인 CLI는 **브라우저를 자기가 연다**(`login()` 헤더의 실측 — "Opening browser to
/// sign in…"). 그 브라우저는 CLI의 자식이므로 트리째 죽이면 **사용자가 방금 연 브라우저
/// 창이 같이 죽는다**(그 브라우저가 그때 처음 뜬 인스턴스면 창이 통째로 사라진다).
///
/// 그리고 `.exe` 갈래와 **대칭이 맞아야 한다**: 네이티브 `codex.exe`를 띄웠을 때
/// `Child::kill()`은 codex.exe만 죽이고 그것이 연 브라우저는 건드리지 않는다. `cmd /C`는
/// **우리 구현의 사정**이지 사용자의 것이 아니므로, 래퍼 갈래에서 죽여야 할 것은 정확히
/// 「래퍼 + 래퍼가 대신 띄운 그 프로그램」 = 자식과 **직속** 자식들이다. 그 아래는 CLI가
/// 스스로 띄운 것이고, 그건 `.exe` 갈래에서도 살아남는다.
///
/// 스냅샷은 **우리 자식이 아직 살아 있을 때** 찍는다(부모 링크가 있어야 찾는다). 그래서
/// 호출 순서는 이 함수 → `child.kill()`이다.
fn kill_wrapped_child(pid: u32, wrapped: bool) {
    if !wrapped {
        return;
    }
    for c in direct_children(pid) {
        terminate(c);
    }
}

/// `pid`의 **직속** 자식 PID들. 부모가 아직 살아 있을 때만 부른다(죽은 뒤엔 링크가 끊긴다).
#[cfg(windows)]
fn direct_children(pid: u32) -> Vec<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut e).is_ok();
        while ok {
            if e.th32ParentProcessID == pid && e.th32ProcessID != pid {
                out.push(e.th32ProcessID);
            }
            ok = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

#[cfg(windows)]
fn terminate(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            if !h.is_invalid() {
                let _ = TerminateProcess(h, 1);
                let _ = CloseHandle(h);
            }
        }
    }
}

#[cfg(not(windows))]
fn direct_children(_pid: u32) -> Vec<u32> {
    Vec::new()
}

#[cfg(not(windows))]
fn terminate(_pid: u32) {}

static LOGIN: LoginSlot = LoginSlot::new();
static CODEX_LOGIN_SLOT: LoginSlot = LoginSlot::new();

fn cancel_login() {
    LOGIN.cancel()
}

/// `claude auth login` — 브라우저 OAuth. **로그인 전엔 이메일을 모르므로** 임시 폴더
/// (`~/.agentcodegui/login`)로 붙고, 끝난 뒤 그 폴더의 신원을 읽어 스토어에 편입한다.
/// 기존 계정은 한 번도 위협받지 않는다(전역 크리덴셜을 덮어쓰는 경로 자체가 없다).
///
/// 브라우저는 **CLI가 직접 연다**("Opening browser to sign in…" 실측). 우리가 또 열면
/// 같은 인증 페이지가 두 장 뜬다 — 뽑은 URL은 `auth:login-url`로 렌더러에 보내 "안 열렸을
/// 때 눌러 보는 링크"로만 쓴다(2.6.2와 같은 규약).
fn login(app: &AppHandle, use_console: bool) -> Value {
    // ★R28d EXTN — 「실행 파일을 못 찾았어요」가 **사실**인지 셸과 같은 규칙으로 묻는다.
    // R28c까지는 PATH 폴백이면 무조건 통과였고(= 판정을 안 했다), 그 뒤 스폰이 실패해야
    // 사유가 나왔다. 통과하면 **해석된 실물 경로**로 띄운다(OS가 같은 훑기를 또 하지 않게).
    let Some(bin) = crate::engine::versions::claude_exe() else {
        return status_wire(false, &AuthStatus::default(), Some(NO_BIN));
    };
    let gen = LOGIN.begin();
    cancel_login(); // 이전 시도가 있으면 정리(2.6.2와 같은 첫 줄)

    let dir = IsolatedConfigDir::for_claude_login();
    // 이전의 부분 상태를 지우고 시작한다 — 반쯤 남은 `.credentials.json`을 이번 로그인의
    // 결과로 오독하면 **엉뚱한 계정이 편입된다**.
    let _ = std::fs::remove_dir_all(dir.path());
    if let Err(e) = std::fs::create_dir_all(dir.path()) {
        return status_wire(false, &AuthStatus::default(), Some(&format!("로그인 폴더를 만들지 못했어요: {e}")));
    }

    let spec = verify::login_command(&bin.to_string_lossy(), use_console);
    // claude 축은 래퍼를 안 쓴다(`build` = 직접 스폰) — `wrapped: false`.
    if let Err(e) = pump_login(app, &LOGIN, gen, build(&spec), spec.timeout_ms, false) {
        return status_wire(false, &AuthStatus::default(), Some(&format!("{NO_BIN} ({e})")));
    }
    // 우리가 도는 사이에 **다른 로그인이 시작**됐다면 이 시도는 이미 무효다. 임시 폴더는
    // 이제 그쪽 것이므로 읽지도 지우지도 않고 물러난다 — 안 그러면 A가 B의 자격증명을
    // 자기 결과로 읽거나(엉뚱한 계정 편입) B가 쓰는 중에 폴더를 지운다.
    // (취소로 핸들이 사라진 경우는 여기 해당하지 않는다 — 번호가 그대로다.)
    if !LOGIN.still_current(gen) {
        return status_wire(false, &AuthStatus::default(), Some("다른 로그인이 시작되어 이 시도는 취소됐어요."));
    }

    // 결과 판정은 종료 코드가 아니라 `auth status --json`이다 — 로그아웃 상태면 CLI가
    // **비-0으로 끝나면서** JSON에 `loggedIn:false`를 준다(verify 모듈 헤더).
    let status = status_for(&bin.to_string_lossy(), &dir);
    let ok = status.logged_in && status.email.is_some();
    if ok {
        let email = status.email.clone().unwrap_or_default();
        // 편입은 CAS 경로(`update_store`)를 탄다. 가드는 2.6.2 `authLogin`과 같은 `None` —
        // 방금 그 계정으로 붙은 것이 확실하므로 토큰 충돌 검사로 막지 않는다.
        if let Err(e) = claude::import_account_from_dir(dir.path(), &email, status.subscription_type.as_deref(), ccg_auth::claude::ImportGuard::None) {
            let _ = std::fs::remove_dir_all(dir.path());
            return status_wire(false, &status, Some(&format!("계정을 저장하지 못했어요: {e}")));
        }
    }
    // 평문 토큰을 임시 자리에 남기지 않는다(성공이든 실패든).
    let _ = std::fs::remove_dir_all(dir.path());
    status_wire(ok, &status, None)
}

/// 로그인 자식 **하나**를 끝까지 돌린다 — 두 축이 공유하는 몸통.
///
/// 스폰 → 출력 두 갈래에서 첫 `https://` URL을 `auth:login-url`로 방출 → 상한·취소·자연
/// 종료 중 하나로 마무리. 마무리는 **자기 자식일 때만** 핸들을 놓는다([`LoginSlot::finish`]).
/// `Err` = 스폰 자체가 실패했다(사유 문구는 호출부가 축 이름을 얹어 만든다).
///
/// ★R28f SHIPBLOCK N1 — 이 함수가 생기기 전에는 claude 축에만 이 몸통이 있었다. Codex
/// 축을 배선하면서 복사했다면 「청크 단위로 읽는다」(개행 없이 멈추는 CLI)·「취소가 자기
/// 자식만 죽인다」 같은 실측 규약이 두 벌이 됐을 것이고, 다음 라운드에 한쪽만 고쳐진다.
///
/// ★R28f SHIPBLOCK R2 — **완료 신호가 하나뿐이면 안 된다**(확인 크리틱 ★최대 격차).
/// R1의 완료 판정은 파이프 EOF([`RecvTimeoutError::Disconnected`]) 하나였는데, 파이프의
/// 쓰기 끝은 **자식이 아니라 자식의 후손 전부**가 들고 있다. `cmd /C` 래퍼 갈래에서
/// 「취소」가 cmd.exe만 죽이면 손자가 파이프를 쥔 채 살아 EOF가 **영영 안 온다** →
/// 이 루프가 5분 상한까지 서고 → `codex-auth:login` IPC가 5분간 안 돌아오고 →
/// 렌더러 `busy='codex-login'`이 계정 탭의 두 축 버튼을 전부 disabled로 묶는다.
///
/// 그래서 신호를 **둘**로 만든다: 파이프 EOF **또는** 「슬롯에 내 자식이 더 이상 없다」
/// ([`LoginSlot::owns`]). 후자는 취소·다음 시도 둘 다를 덮는다(R1은 「다음 로그인이
/// 시작됐다」에서도 같은 이유로 EOF를 기다렸다). 손자 쪽은 [`kill_wrapped_child`]가
/// 따로 닫는다 — 이 루프는 그것이 실패해도 서지 않아야 한다.
fn pump_login(
    app: &AppHandle,
    slot: &LoginSlot,
    gen: u64,
    mut cmd: Command,
    timeout_ms: u64,
    wrapped: bool,
) -> Result<(), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    // 출력 두 갈래를 한 채널로 모은다 — URL은 stdout에도 stderr에도 올 수 있다.
    let (tx, rx) = channel::<String>();
    for pipe in [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut pipe = pipe;
            let mut buf = [0u8; 4096];
            // **줄 단위가 아니라 청크 단위**로 읽는다: CLI가 URL을 개행 없이 뱉고
            // 사용자를 기다리면 `read_line`은 영영 안 돌아온다(URL이 화면에 못 닿는다).
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 || tx.send(String::from_utf8_lossy(&buf[..n]).to_string()).is_err() {
                    return;
                }
            }
        });
    }
    drop(tx);
    slot.put(gen, child, wrapped);

    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut sent_url = false;
    loop {
        // 신호 ②: 슬롯이 비었거나 다른 시도의 것이다 = 취소됐다 / 밀려났다.
        if !slot.owns(gen) {
            break;
        }
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            slot.cancel(); // 5분 상한(2.6.2의 setTimeout과 같은 값)
            break;
        }
        match rx.recv_timeout(left.min(CANCEL_POLL)) {
            Ok(chunk) => {
                if !sent_url {
                    if let Some(url) = verify::extract_login_url(&chunk) {
                        sent_url = true;
                        let _ = app.emit(ch::AUTH_LOGIN_URL, json!(url));
                    }
                }
            }
            // 폴 주기가 끝났을 뿐이다 — 상한과 취소는 루프 머리에서 다시 판정한다.
            // (여기서 바로 끊으면 조용한 CLI가 150ms 만에 죽는다.)
            Err(RecvTimeoutError::Timeout) => {}
            // 파이프 둘이 다 닫혔다 = 자식이 끝났다.
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    slot.finish(gen);
    Ok(())
}

/// 「취소됐는가」를 다시 묻는 주기. 이 값이 곧 **취소 → 화면이 풀리기까지의 상한**이다
/// (5분 상한의 정확도에는 영향이 없다 — 상한은 `deadline`으로 따로 잰다).
const CANCEL_POLL: Duration = Duration::from_millis(150);

const NO_BIN: &str = "claude 실행 파일을 찾지 못했어요";

/// `auth status --json` 한 번(20초 상한).
fn status_for(bin: &str, dir: &IsolatedConfigDir) -> AuthStatus {
    let spec = verify::status_command(bin, dir);
    match run(&spec) {
        Some(out) => verify::parse_status(&out),
        None => AuthStatus::default(),
    }
}

/// 2.6.2 `AuthStatus & { ok }`의 모양 그대로. `undefined`였던 자리는 키를 **빼서** 보낸다
/// (렌더러가 `typeof x === 'string'`으로 보는 자리라 `null`이 들어가면 안 된다).
fn status_wire(ok: bool, s: &AuthStatus, error: Option<&str>) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("ok".into(), json!(ok));
    o.insert("loggedIn".into(), json!(s.logged_in));
    for (k, v) in [
        ("email", &s.email),
        ("authMethod", &s.auth_method),
        ("subscriptionType", &s.subscription_type),
        ("orgName", &s.org_name),
    ] {
        if let Some(v) = v {
            o.insert(k.into(), json!(v));
        }
    }
    if let Some(e) = error {
        o.insert("error".into(), json!(e));
    }
    Value::Object(o)
}

// ── 로그아웃 ─────────────────────────────────────────────────────────────────

/// 계정 하나를 **버린다**: 서버 토큰 해지 → 스토어 제거 → 계정 폴더 삭제.
///
/// 해지가 실패해도(네트워크·이미 만료) 로컬은 지운다 — 목록에 거짓 항목을 남기지 않는
/// 것이 2.6.2의 규약이다. 반대로 **해지를 건너뛰는 경우는 둘뿐**이다: 계정 폴더를
/// 물질화조차 못 했을 때(스냅샷 손상), 그리고 **띄울 CLI가 이 컴퓨터에 없을 때**. 앞은
/// 보낼 토큰이 없고, 뒤는 보낼 창구가 없다.
///
/// ★R28d EXTN — 그 두 번째 문이 이 라운드의 뇌관이었다. 「CLI가 있나」의 판정이 거짓으로
/// 기울면 여기서는 UI 문구가 아니라 **토큰 해지가 조용히 생략**되고, 사용자는 로그아웃이
/// 끝난 화면을 보는데 서버에는 살아 있는 토큰이 남는다(CPATH 확인 크리틱 R1 §4.3). 그래서
/// `claude.exe`라는 철자를 PATH에서 진짜로 찾을 수 있는지부터 고치고
/// ([`ccg_engine::codex::versions::resolve_bin`]) 이 자리를 바꿨다.
///
/// `CCG_NO_NET`이 켜져 있으면 해지를 **생략한다**. 하네스가 이 문을 지나가도 사용자
/// 실계정의 토큰이 서버에서 죽지 않게 하는 안전핀이다(`ccg_auth::net::disabled`와 같은 키).
fn logout(email: &str) -> Value {
    if !email.is_empty() && !no_net() {
        if let Ok(dir) = IsolatedConfigDir::for_claude_account(email) {
            if let Some(bin) = crate::engine::versions::claude_exe() {
                let _ = run(&verify::logout_command(&bin.to_string_lossy(), &dir));
            }
        }
    }
    // 스토어 제거 + 폴더 삭제 + 건강 장부 청소(전부 `ccg_auth::claude::remove_account`).
    claude::remove_account(email);
    super::system::list_claude_accounts()
}

fn no_net() -> bool {
    std::env::var("CCG_NO_NET").is_ok_and(|v| !v.is_empty() && v != "0")
}

// ── Codex(OpenAI) 계정 ───────────────────────────────────────────────────────
//
// ★R28f SHIPBLOCK N1 — 최종 파리티 감사 R2와 그 확인 크리틱이 **독립적으로** 재현한
// 출하 차단. 실홈의 `codex-accounts.json`이 `accounts: []`인데 「계정 추가」가 무반응이라
// 이 사용자는 3.0에서 Codex 구독 엔진을 **한 번도 시작할 수 없었다**.
//
// 도메인은 M5부터 다 있었다(`ccg_auth::codex`). 없던 것은 이 파일의 다섯 줄이다.

/// `codex login` — 브라우저 OAuth. claude 축과 **같은 문법**이고 다른 점만 셋이다:
///
///  1. 격리 홈의 환경 변수 이름이 `CODEX_HOME`이다(`IsolatedConfigDir::for_codex_login`).
///  2. 결과 판정에 `auth status --json` 같은 창구가 없다 — 끝난 뒤 **임시 폴더의
///     `auth.json`을 읽어** 편입한다(`codex::import_account_from_dir`, 2.6.2와 같다).
///  3. 반환이 상태 객체가 아니라 **갱신된 계정 목록**이다(계약면 `codexAuth.login()`).
///
/// 브라우저는 CLI가 직접 연다. 뽑은 URL은 claude 축과 **같은 채널**(`auth:login-url`)로
/// 보낸다 — 2.6.2도 codex 로그인에서 `IPC.authLoginUrl`을 쓴다(`src/main/codex/auth.ts:357`).
///
/// ★**띄울 수조차 없을 때는 목록이 아니라 사유를 돌려준다**(`{ "error": "…" }`).
/// 2.6.2는 그 판에서 목록을 그대로 돌려줬고, 그러면 화면은 「눌렀는데 아무 일도 안 일어난다」다
/// — 이 라운드가 닫는 병과 **정확히 같은 모양**이다. claude 축은 반환 타입에 `error` 칸이
/// 있어 이미 말하고 있었다(`status_wire`). 심(`callStrict` + 배열 검사)이 이 모양을 reject로
/// 올리고 설정 화면이 문구를 세운다. 목록 setter에는 **배열만** 앉는다.
fn codex_login(app: &AppHandle) -> Value {
    // 「띄울 수 있는가」의 판정은 앱에 **한 자리**뿐이다(`codex_exe`의 표 — R28c CPATH).
    let Some(bin) = crate::engine::codex_versions::codex_exe() else {
        return login_error(NO_CODEX_BIN);
    };
    let gen = CODEX_LOGIN_SLOT.begin();
    CODEX_LOGIN_SLOT.cancel(); // 이전 시도가 있으면 정리(2.6.2 `codexLoginCancel()` 첫 줄)

    let dir = IsolatedConfigDir::for_codex_login();
    // 반쯤 남은 `auth.json`을 이번 로그인의 결과로 오독하면 **엉뚱한 계정이 편입된다**.
    let _ = std::fs::remove_dir_all(dir.path());
    if let Err(e) = std::fs::create_dir_all(dir.path()) {
        return login_error(&format!("로그인 폴더를 만들지 못했어요: {e}"));
    }

    let spec = verify::codex_login_command(&bin.to_string_lossy());
    let (cmd, wrapped) = codex_command(&bin, &spec);
    if let Err(e) = pump_login(app, &CODEX_LOGIN_SLOT, gen, cmd, spec.timeout_ms, wrapped) {
        return login_error(&format!("{NO_CODEX_BIN} ({e})"));
    }
    // 다른 로그인이 시작됐으면 임시 폴더는 이제 그쪽 것이다 — 읽지도 지우지도 않는다
    // (claude 축의 같은 자리와 같은 이유 · R28 T1T2 R2 §6.3).
    if !CODEX_LOGIN_SLOT.still_current(gen) {
        return super::system::list_codex_accounts();
    }
    // 편입 + 계정 폴더 물질화. API 키 인증(이메일 없음)이면 None을 주고 목록은 그대로다.
    let _ = ccg_auth::codex::import_account_from_dir(dir.path());
    // 평문 토큰을 임시 자리에 남기지 않는다(성공이든 실패든).
    let _ = std::fs::remove_dir_all(dir.path());
    super::system::list_codex_accounts()
}

const NO_CODEX_BIN: &str = "codex 실행 파일을 찾지 못했어요";

/// 로그인이 **시작조차 못 했을 때**의 와이어 — 배열이 아니라 사유 객체다(위 주석).
/// 사용자가 브라우저에서 취소한 경우는 여기 해당하지 않는다(그건 실패가 아니라 선택이고,
/// 2.6.2처럼 목록을 그대로 돌려준다).
fn login_error(why: &str) -> Value {
    json!({ "error": why })
}

/// 계정 하나를 버린다 — `codex logout`(그 계정 폴더의 **로컬** auth 제거) → 등록 제거 +
/// 폴더 삭제. 2.6.2 `codexLogout`과 같은 순서다.
///
/// claude 축과 달리 이 명령은 **서버 토큰 해지가 아니다**(로컬 `auth.json`을 지운다).
/// 그래도 `CCG_NO_NET`에서 건너뛰는 이유는 대칭이다 — 하네스가 계정 축을 지나갈 때
/// 자식 프로세스를 하나도 안 띄우는 것이 규약이고, 어차피 바로 뒤의 `remove_account`가
/// 폴더째 지우므로 **결과가 같다**.
fn codex_logout(email: &str) -> Value {
    if !email.is_empty() && !no_net() {
        if let Ok(dir) = IsolatedConfigDir::for_codex_account(email) {
            // 폴더에 auth.json이 있을 때만 — 2.6.2도 `fs.existsSync`로 먼저 묻는다.
            if dir.path().join("auth.json").is_file() {
                if let Some(bin) = crate::engine::codex_versions::codex_exe() {
                    let spec = verify::codex_logout_command(&bin.to_string_lossy(), &dir);
                    let (cmd, wrapped) = codex_command(&bin, &spec);
                    wait_or_kill(cmd, spec.timeout_ms, wrapped);
                }
            }
        }
    }
    // 등록 제거 + 폴더 정리(정션 해제 포함) — 전부 `ccg_auth::codex::remove_account`.
    ccg_auth::codex::remove_account(email);
    super::system::list_codex_accounts()
}

/// 출력이 필요 없는 한 방짜리 명령(`codex logout`). 상한을 넘으면 **우리가 스폰한 그
/// 자식만** 죽인다([`run`]과 같은 규약 — 이름 기반 kill 없음).
///
/// ★R28f SHIPBLOCK R2 — 래퍼 갈래는 로그인과 같은 규칙을 쓴다([`kill_wrapped_child`]):
/// 상한을 넘겨 죽일 때 `cmd.exe`만 죽이면 정작 `codex logout`이 살아남는다.
fn wait_or_kill(mut cmd: Command, timeout_ms: u64, wrapped: bool) {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return };
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(60)),
            _ => {
                // 순서가 중요하다 — 부모가 살아 있어야 직속 자식을 찾는다.
                kill_wrapped_child(child.id(), wrapped);
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}

/// codex CLI용 [`Command`]. [`build`]와 다른 점 하나 — **커널이 직접 못 띄우는 확장자**면
/// `cmd /C`를 경유한다.
///
/// 왜 필요한가: codex는 전역 npm 설치에서 `codex.cmd` 셰임으로 앉는다(2.6.2가 `shell:true`로
/// 띄우던 이유). 앱이 관리하는 설치본은 네이티브 `.exe`라 이 갈래를 안 탄다.
/// 판정 규칙은 `ccg_engine::codex::driver::command_for`의 `needs_shell`과 같다 —
/// `.exe`·`.com`만 직접, 나머지 확장자는 셸. (그 함수는 인자가 `app-server` 고정이라
/// 로그인·로그아웃에 못 쓴다. 그 크레이트는 이 라운드의 경계 밖이라 판정만 옮겨 적는다.)
///
/// ★R28f SHIPBLOCK R2 — 두 번째 값이 **래퍼를 썼는가**다. 호출부는 그 한 비트를 자식과
/// 함께 들고 다녀야 한다: 래퍼 갈래에서는 죽여야 할 대상이 우리 자식(`cmd.exe`)이 아니라
/// **그 직속 자식**이기 때문이다([`kill_wrapped_child`]). 비트를 여기서 같이 돌려주는
/// 이유는 판정이 **한 자리**여야 해서다 — 호출부가 확장자를 다시 보면 두 판정이 갈린다.
fn codex_command(bin: &std::path::Path, spec: &CommandSpec) -> (Command, bool) {
    let needs_shell = cfg!(windows)
        && bin
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| !matches!(e.to_ascii_lowercase().as_str(), "exe" | "com"));
    if !needs_shell {
        return (build(spec), false);
    }
    let mut c = Command::new("cmd");
    let s = bin.to_string_lossy().to_string();
    let args = spec.args.join(" ");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.raw_arg("/C");
        c.raw_arg(format!("\"\"{s}\" {args}\""));
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        c.arg("/C").arg(format!("\"{s}\" {args}"));
    }
    for (k, v) in &spec.env {
        c.env(k, v);
    }
    (c, true)
}

// ── 자식 프로세스 ────────────────────────────────────────────────────────────

/// [`CommandSpec`] → [`Command`]. env는 **덧씌우기**다(전체 치환이 아니다 — 그러면
/// PATH·SystemRoot가 사라져 CLI가 못 뜬다).
fn build(spec: &CommandSpec) -> Command {
    let mut c = Command::new(&spec.program);
    c.args(&spec.args);
    for (k, v) in &spec.env {
        c.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — 콘솔 창이 번쩍이지 않게
    }
    c
}

/// 한 방에 끝나는 명령(status·logout). stdout을 돌려주고, 상한을 넘으면 **우리가 스폰한
/// 그 자식만** 죽인다. `None` = 실행 못 했거나 상한 초과.
fn run(spec: &CommandSpec) -> Option<String> {
    let mut cmd = build(spec);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    match rx.recv_timeout(Duration::from_millis(spec.timeout_ms)) {
        Ok(s) => {
            let _ = child.wait();
            Some(s)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 와이어 모양이 2.6.2 `AuthStatus & { ok }`와 같은가 — 없는 값은 **키째** 빠진다.
    #[test]
    fn status_wire_drops_absent_fields_instead_of_nulling_them() {
        let empty = status_wire(false, &AuthStatus::default(), Some("x"));
        assert_eq!(empty["ok"], json!(false));
        assert_eq!(empty["loggedIn"], json!(false));
        assert!(empty.get("email").is_none(), "undefined 자리에 null이 들어가면 안 된다: {empty}");
        assert_eq!(empty["error"], json!("x"));

        let full = status_wire(
            true,
            &AuthStatus {
                logged_in: true,
                email: Some("a@b.c".into()),
                auth_method: Some("claudeai".into()),
                subscription_type: Some("max".into()),
                org_name: None,
            },
            None,
        );
        assert_eq!(full["email"], json!("a@b.c"));
        assert_eq!(full["subscriptionType"], json!("max"));
        assert!(full.get("orgName").is_none());
        assert!(full.get("error").is_none(), "성공에는 error 키가 없다");
    }

    /// 쓰기 채널이 전부 이 모듈 것이어야 `ipc_call`이 블로킹 풀로 보낸다.
    /// (하나라도 빠지면 그 채널만 async 워커에서 5분을 잔다 = 앱 전체가 멈춘다.)
    ///
    /// ★R28f SHIPBLOCK N1 — Codex 축 다섯이 여기 붙었다. R1까지 이 다섯은 문자열이
    /// Rust 소스에 **0회**였고(감사 전수 grep), 그래서 심이 안전값 `[]`를 돌려줬다.
    #[test]
    fn the_write_channels_of_both_axes_are_all_claimed() {
        for c in [
            "auth:login",
            "auth:login-cancel",
            "auth:logout",
            "auth:set-default-account",
            "auth:remove-account",
            "auth:reorder-accounts",
            "codex-auth:login",
            "codex-auth:login-cancel",
            "codex-auth:logout",
            "codex-auth:set-default-account",
            "codex-auth:reorder-accounts",
        ] {
            assert!(owns(c), "{c}");
        }
        assert!(!owns("auth:list-accounts"), "읽기는 system.rs 것이다");
        assert!(!owns("codex-auth:list-accounts"));
        assert!(!owns("codex-auth:accounts-usage"), "한도 조회는 ipc/parity 것이다");
    }

    /// 취소는 **없는 자식에게도 안전**해야 한다(사용자가 카드를 두 번 닫는다).
    /// 두 축이 **따로** 취소된다는 것도 같이 잰다 — 슬롯이 한 벌이면 codex 로그인 취소가
    /// 진행 중인 claude 로그인을 죽인다.
    #[test]
    fn cancelling_with_no_login_in_flight_is_a_no_op() {
        cancel_login();
        cancel_login();
        CODEX_LOGIN_SLOT.cancel();
        assert!(LOGIN.proc.lock().unwrap().is_none());
        assert!(CODEX_LOGIN_SLOT.proc.lock().unwrap().is_none());
        assert!(!std::ptr::eq(&LOGIN as *const LoginSlot, &CODEX_LOGIN_SLOT as *const LoginSlot));
    }

    /// 인자 읽기 — 이메일 하나·이메일 배열. 잘못된 모양은 **빈 값**이고,
    /// 도메인이 빈 이메일을 조용히 무시한다(2.6.2와 같다).
    #[test]
    fn arg_readers_are_total() {
        assert_eq!(email_arg(&json!(["a@b.c"])), "a@b.c");
        assert_eq!(email_arg(&json!([])), "");
        assert_eq!(email_arg(&json!([42])), "");
        assert_eq!(emails_arg(&json!([["a", "b"]])), vec!["a".to_string(), "b".to_string()]);
        assert!(emails_arg(&json!(["a"])).is_empty(), "배열이 아니면 빈 순서 = 아무것도 안 바꾼다");
    }

    /// ★확인 크리틱 §6.3 — 로그인 자식의 **소유권**. 겹친 로그인에서 A의 마무리가
    /// B의 핸들을 꺼내 가면 「취소」가 아무것도 못 죽인다.
    ///
    /// 실프로세스 두 개로는 창이 18ms라 재현이 안 됐다(크리틱 실측). 그래서 **규칙**을
    /// 잰다: 번호는 스폰 전에 올라가고, 마무리는 자기 번호일 때만 핸들을 놓는다.
    #[test]
    fn a_finishing_login_never_takes_the_next_ones_handle() {
        let a = LOGIN.begin(); // 로그인 A 시작
        assert!(LOGIN.still_current(a), "혼자면 최신이다");
        // A가 마무리에 닿기 전에 로그인 B가 시작한다(번호 먼저 — 그 다음 kill·spawn).
        let b = LOGIN.begin();
        assert!(!LOGIN.still_current(a), "★A는 더 이상 최신이 아니다 = 폴더도 핸들도 A 것이 아니다");
        assert!(LOGIN.still_current(b));
        // 그 창에서 A가 마무리해도 B의 자리는 그대로다(핸들을 꺼내는 조건이 번호다).
        let mut g = LOGIN.proc.lock().unwrap_or_else(|e| e.into_inner());
        *g = None; // 자식 없이 번호만 확인하는 자리 — Child를 만들지 않는다
        assert!(g.as_ref().map(|l| l.gen) != Some(a));
        drop(g);
        // ★R28f — 축이 갈린다: codex 쪽 번호를 올려도 claude 쪽 "최신" 판정은 안 흔들린다.
        let c = CODEX_LOGIN_SLOT.begin();
        assert!(LOGIN.still_current(b), "★두 축은 서로의 시도를 무효화하지 않는다");
        assert!(CODEX_LOGIN_SLOT.still_current(c));
    }

    /// ★R28f SHIPBLOCK R2 — 래퍼 판정은 **한 자리**고, 그 비트가 호출부까지 간다.
    #[test]
    fn the_wrapper_bit_travels_with_the_command() {
        let spec = CommandSpec { program: "x".into(), args: vec!["login".into()], env: vec![], timeout_ms: 1000 };
        let (_, wrapped_exe) = codex_command(std::path::Path::new(r"C:\a\codex.exe"), &spec);
        let (_, wrapped_cmd) = codex_command(std::path::Path::new(r"C:\a\codex.cmd"), &spec);
        assert!(!wrapped_exe, "네이티브 exe는 래퍼를 안 쓴다 = 죽일 대상이 자식 그 자체다");
        assert_eq!(wrapped_cmd, cfg!(windows), "윈도우에서 .cmd는 cmd /C를 거친다");
    }

    /// ★R28f SHIPBLOCK R2 · 확인 크리틱 ★최대 격차 — **취소가 래퍼 안의 CLI까지 닿는가**.
    ///
    /// 크리틱의 픽스처를 그대로 코드로 옮긴다: `cmd /C`로 오래 도는 프로그램을 띄우고
    /// (셰임이 CLI를 부르는 모양), 파이프를 자식이 아니라 **손자**가 쥐게 한 뒤 취소한다.
    ///
    /// R1의 `cancel()`은 `cmd.exe`만 죽였다 — 그러면 손자가 살아 파이프가 안 닫히고
    /// `pump_login`의 유일한 완료 신호(EOF)가 영영 안 와서 IPC가 5분을 선다.
    /// 여기서 재는 것은 그 사슬의 첫 고리다: **손자가 죽는가**, 그리고 **슬롯이 비는가**
    /// (= `owns()`가 false = 펌프의 두 번째 완료 신호가 선다).
    ///
    /// ★픽스처의 함정(이 라운드에서 실제로 밟았다): 파이프를 `Child`에 그대로 둔 채
    /// 취소하면 `Child`가 드롭되면서 **읽기 끝이 닫히고**, 그러면 손자가 첫 출력에서
    /// 죽어 「고쳤다」가 거짓으로 초록이 된다(처방을 무력화해도 통과했다). 제품 경로는
    /// [`pump_login`]이 파이프를 **읽기 스레드로 옮기고** 그 스레드가 영영 안 끝나는
    /// 모양이라, 테스트도 그대로 옮겨야 한다.
    #[cfg(windows)]
    #[test]
    fn cancelling_a_wrapped_login_kills_the_program_inside_the_wrapper() {
        let (child, pid, kids) = spawn_wrapped_fixture();
        let slot = LoginSlot::new();
        let gen = slot.begin();
        slot.put(gen, child, true);
        assert!(slot.owns(gen), "스폰 직후엔 내 자식이 앉아 있다");

        slot.cancel();

        assert!(!slot.owns(gen), "★취소 뒤 슬롯은 비어 있다 = 펌프가 EOF를 안 기다리고 깬다");
        let leftover = wait_until_dead(&kids);
        for p in &leftover {
            terminate(*p); // 실패해도 뒤처리는 한다 — 테스트가 프로세스를 남기지 않게
        }
        assert!(leftover.is_empty(), "★래퍼 안의 프로그램이 살아남았다(pid {pid}의 자식): {leftover:?}");
    }

    /// 래퍼가 **아닌** 자식은 직속 자식을 건드리지 않는다 — 네이티브 CLI가 연 브라우저를
    /// 취소가 같이 죽이면 안 된다(그것이 트리째 죽이지 않는 이유다).
    #[cfg(windows)]
    #[test]
    fn cancelling_an_unwrapped_login_leaves_what_the_cli_launched_alone() {
        let (child, _pid, kids) = spawn_wrapped_fixture();
        // `wrapped:false` = 「이 자식이 곧 우리가 띄우려던 프로그램이다」.
        let slot = LoginSlot::new();
        let gen = slot.begin();
        slot.put(gen, child, false);
        slot.cancel();
        assert!(!slot.owns(gen));
        // 자식(cmd.exe)은 죽었지만 그 아래는 우리 것이 아니다 — 1초 뒤에도 살아 있어야 한다.
        std::thread::sleep(Duration::from_millis(1000));
        let still = kids.iter().copied().filter(|p| pid_is_alive(*p)).collect::<Vec<_>>();
        for p in &kids {
            terminate(*p); // 뒤처리
        }
        assert!(!still.is_empty(), "★unwrapped인데 CLI가 띄운 것까지 죽었다(브라우저가 죽는 모양)");
    }

    /// 크리틱의 `.cmd` 셰임과 같은 모양: `cmd /C`가 오래 도는 프로그램을 부르고, 파이프는
    /// [`pump_login`]처럼 **읽기 스레드**가 쥔다(`Child`에 남기지 않는다).
    /// 돌려주는 것: 슬롯에 앉힐 자식 · 그 pid · 그 직속 자식(손자) 목록.
    #[cfg(windows)]
    fn spawn_wrapped_fixture() -> (Child, u32, Vec<u32>) {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.raw_arg("/C").raw_arg("ping -n 600 127.0.0.1");
        c.creation_flags(0x0800_0000);
        c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = c.spawn().expect("cmd 스폰");
        let pid = child.id();
        for pipe in [
            child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
            child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            std::thread::spawn(move || {
                let mut pipe = pipe;
                let mut buf = [0u8; 4096];
                while matches!(pipe.read(&mut buf), Ok(n) if n > 0) {}
            });
        }
        // ★두 번째 픽스처 함정: `CREATE_NO_WINDOW`라도 `cmd.exe`는 **conhost.exe를 먼저**
        // 자식으로 단다. 첫 스냅샷을 바로 찍으면 그 하나만 잡히고(정작 `ping`은 아직
        // 안 떴다), conhost는 부모와 함께 죽으므로 두 테스트가 다 거짓으로 통과한다.
        // 그래서 **자식이 늘기를 멈출 때까지** 기다린 뒤 찍는다.
        let mut kids = direct_children(pid);
        for _ in 0..60 {
            std::thread::sleep(Duration::from_millis(100));
            let now = direct_children(pid);
            if now.len() > kids.len() {
                kids = now;
                continue;
            }
            if kids.len() >= 2 {
                break;
            }
            kids = now;
        }
        assert!(
            kids.len() >= 2,
            "★래퍼 안의 프로그램이 안 떴다 — 픽스처가 무의미하다(자식 {kids:?})"
        );
        (child, pid, kids)
    }

    /// 최대 5초 기다린 뒤 **아직 살아 있는** pid들.
    #[cfg(windows)]
    fn wait_until_dead(pids: &[u32]) -> Vec<u32> {
        let mut alive = pids.to_vec();
        for _ in 0..100 {
            alive.retain(|p| pid_is_alive(*p));
            if alive.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        alive
    }

    #[cfg(windows)]
    fn pid_is_alive(pid: u32) -> bool {
        use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            if h.is_invalid() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code).is_ok();
            let _ = CloseHandle(h);
            ok && code == STILL_ACTIVE.0 as u32
        }
    }
}
