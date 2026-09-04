//! `ChatStatusLite` 합성 — **쓰기 주인은 Rust 하나**(m-logic §5.8 · M-UX §4.3).
//!
//! 다섯 줄 규약 중 이 파일이 지키는 것:
//!  - 값을 만드는 곳은 여기 하나다(런타임 상태 → lite). 렌더러 팬아웃은 이 필드를 못 쓴다.
//!  - 전이마다 **메모리 갱신 + 브로드캐스트**(즉시), 디스크는 `ccg_store::status`가
//!    500ms 디바운스로 쓴다. 브로드캐스트와 디스크의 지연이 다르다 — 크래시 창 최대 500ms.
//!  - `hold`·`queued`의 **진실은 런타임**이고 `status.json`은 파생 캐시다.
//!  - `unread`는 3.0.0에서 항상 0(스토어가 강제한다).
//!
//! `status`(2.6.2 `AgentStatus`)와 `bgActive`를 **따로** 싣는 이유: 메모리에 박힌 사용자
//! 정정 — *"완료 색은 bg까지 걷혀야 한다(effectiveStatus 단일 소스)"*. 두 값을 여기서
//! 미리 합치면 표시 쪽이 그 규칙을 다시 못 만든다. 합성은 UI의 몫으로 남긴다.

use ccg_engine::driver::CliDriver;
use ccg_engine::live::{AskKind, LiveKind};
use ccg_engine::runtime::ChatRuntime;
use ccg_engine::state::StateTag;
use serde_json::{json, Value};

/// 이 채팅의 마지막 종결 상태(턴이 끝난 뒤에도 남는 표시값).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Terminal {
    None,
    Done,
    Error,
    /// 사용자가 끊은 턴. **`Done`으로 적으면 안 된다** — 이 값은 `status.json`에
    /// 영속되고 `load_boot`는 `done`을 안 내리므로, 중단한 턴이 재시작 뒤에도
    /// "완료"로 남는다(크리틱 배선 R1 F11). 2.6.2 `AgentStatus`에는 대응 어휘가
    /// 없으므로 **`idle`로 접는다** — "완료도 오류도 아니다"가 지금 낼 수 있는
    /// 가장 정확한 값이다(사이드바 점 색은 `done`과 같아 화면은 안 바뀐다).
    Aborted,
}

/// 런타임 시계 ms(단조) → **unix 초**. `hub::persist_hold`가 디스크로 내릴 때 하는 것과
/// 같은 환승이고, 짝인 되돌리기는 `engine::remaining_ms`다. 시각 미상(`None`)은 그대로
/// `null`로 나간다 — 렌더러가 "언제 풀리는지 모른다" 문장을 따로 갖고 있다.
fn runtime_ms_to_epoch_secs(rt_now: u64, wall_now_ms: u64, at: Option<u64>) -> Value {
    match at {
        Some(r) => json!((wall_now_ms as f64 + (r as f64 - rt_now as f64)) / 1000.0),
        None => Value::Null,
    }
}

/// ★R28 ACCT R2(F1) — **이 런타임이 계정을 물고 있는가**(「사용 중」 칩의 생존 판정).
///
/// 뜻은 *"이 슬롯이 아직 시체가 아니다"*이다. 슬롯이 있다는 것 자체가 「살아 있는
/// 세션」이고(대화가 열려 있고 다음 턴이 이 계정을 태운다), 예외는 하나다:
///
/// > **상주 상태인데 프로세스가 죽었다** — 밖에서 CLI가 살해되거나 크래시한 판.
///
/// 그 자리는 §3이 존재하는 이유가 무너지는 곳이다(아무것도 안 도는데 경고가 켜져 있다).
/// 확인 크리틱 R1 F1이 「허브에 슬롯 회수가 없어 상주 CLI가 죽어도 칩이 남는다」로 적은
/// 부수 사실이 이것이고, 같은 라운드의 (b) 지시가 *"상주 CLI가 죽은 슬롯도 같은 규약"*이다.
///
/// **턴이 끝나고 스트림을 정상적으로 닫은 `Idle`은 시체가 아니다.** 이 앱의 기본
/// 종료 정책은 `OnIdle`이라 턴마다 프로세스가 사라진다 — 그것까지 "안 물고 있다"로
/// 접으면 칩은 턴 중에만 깜빡이고 §3은 사실상 없는 기능이 된다.
///
/// (`process_alive`는 *Dead 관측*을 읽는 문이라 워치독의 `Alive` 사다리와 무관하다 —
///  §5.4-b ⓪. 여기서는 표시값이므로 불변식 11의 대상이 아니다.)
fn holds_account(state: StateTag, process_alive: bool) -> bool {
    match state {
        // 명령을 안 받는 종결 상태 — 다음 tick에 `Idle`로 나간다. 시체로 센다.
        StateTag::Ended => false,
        StateTag::Resident => process_alive,
        _ => true,
    }
}

pub fn build<D: CliDriver>(rt: &ChatRuntime<D>, terminal: Terminal, now_ms: u64, seat: Option<super::Seat>) -> Value {
    let state = rt.state();
    let ledger = rt.ledger();
    let ask = ledger
        .items()
        .iter()
        .filter_map(|i| i.ask.as_ref())
        .map(|a| match a.ask_kind {
            AskKind::Permission => "permission",
            AskKind::Question => "question",
            AskKind::Dialog => "dialog",
        })
        .next()
        .unwrap_or("none");
    let bg_active = ledger.items().iter().any(|i| {
        matches!(
            i.kind,
            LiveKind::BgShell | LiveKind::BgAgent | LiveKind::Workflow
        )
    });
    // 2.6.2 `AgentStatus` 어휘로 접는다(사이드바 알약·창 목록이 읽는 값).
    let status = match state {
        StateTag::Starting => "analyzing",
        StateTag::Streaming | StateTag::AwaitingUser | StateTag::HeldResult | StateTag::Interrupting => "working",
        _ => match terminal {
            Terminal::Done => "done",
            Terminal::Error => "error",
            Terminal::Aborted | Terminal::None => "idle",
        },
    };
    // 키 이름은 `ccg_store::status::truth_from_chat_file`와 **같아야** 한다 —
    // 그쪽이 `<chatId>.json`에서 만드는 파생 요약과 모양이 갈리면 규약 3("어긋나면
    // 채팅 파일이 이긴다")이 매번 발동해 화면이 깜빡인다.
    //
    // ★R5 — `resetAt`은 **unix 초**다. 렌더러가 `managed.resetAt * 1000 - Date.now()`로
    // 남은 시간을 만들고(`Chat.tsx` `LimitHoldBar`), 디스크 짝(`hub::persist_hold`)도
    // 같은 축이다. R4까지 여기만 **런타임 시계 ms**(앱 기동 뒤 경과)를 그대로 실어
    // 배너의 "약 N 뒤"가 늘 0이었다 — F2가 적은 "화면도 거짓말한다"의 나머지 반쪽이다.
    // ★R28f WFIRE — 배너가 **착지를 구분해서** 말하려면 두 값이 더 필요하다
    // (R28e 확인 크리틱 R1 §4.3). R28e까지 이 표면의 문장은 `ready`면 늘
    // 「한도가 풀렸어요 — 눌러서 이어가기」였는데, 예산으로 접힌 표는 한도가 **안**
    // 풀렸다: 자동으로 12번 이어서 보냈고 그때마다 일도 했는데 그래도 막혀서 멈춘
    // 것이다. 엔진은 그 사실을 스레드 공지로는 정확히 말하고 있었으므로(`check_hold`)
    // 화면 위 한 줄만 거짓이었다.
    //
    //  * `paused` — 「엔진이 자동을 접었다」(`auto_paused`). 아래 `auto_resume`가 표시용으로
    //    접어 버리는 값을 **접기 전 사실 그대로** 싣는다. 이게 없으면 화면은 「예산으로
    //    접힌 표」와 「화면 밖이라 안 쏘는 표」를 구분할 수 없다 — 둘 다 `auto:false`다.
    //  * `fires` — 그 에피소드가 태운 자동 재개 수. 접힌 이유가 예산인지 연속 헛발질인지를
    //    가르고(`>= MAX_EPISODE_FIRES`), 공지와 **같은 숫자**를 배너에도 준다.
    let hold = match rt.hold() {
        Some(h) => json!({ "resetAt": runtime_ms_to_epoch_secs(rt.now(), now_ms, h.resets_at),
                           "ready": h.ready,
                           "fires": rt.episode_fires(),
                           "paused": h.auto_paused }),
        None => Value::Null,
    };
    // ★R5 — **자동 재발화 상한을 넘겨 멈춘 표**(`LimitHold::auto_paused`)는 화면에서
    // "화면 밖이라 안 쏘는 표"와 같은 얼굴이어야 한다. 둘 다 *ready인데 엔진이 안 쏜다*이고,
    // 출구도 `resume_now` 하나로 같다. `resumeOwner.ts`의 `canPressResume`이
    // `ready && auto !== true`라, 여기서 접어 주지 않으면 배너가
    // "곧 이어서 계속해요"라고 적고 버튼을 안 준다 — 아무 일도 안 일어나는데.
    // (진짜 게이트는 `hold_gate_open()`의 `auto_paused`다. 이 값은 표시용 접힘이다.)
    let auto_resume = rt.auto_resume() && !rt.hold().is_some_and(|h| h.auto_paused);
    // ★R28 ACCT §3 — **이 채팅이 지금 물고 있는 구독 계정.**
    //
    // picker·설정 목록의 「사용 중 · N번 자리」 칩이 서는 유일한 근거다. 값을 렌더러가
    // 만들지 않는 이유는 창이 여럿이기 때문이다: 본채팅·멀티 자리·추가 창·팝아웃이 각자
    // 다른 JS 힙이라, 렌더러가 모은 표는 **자기 창의 자리만** 안다. 이 REPLACE는 모든
    // 창에 같은 배열로 나가므로 어느 화면에서 열어도 같은 답이 나온다.
    //
    // **키가 있으면 살아 있는 런타임이다.** 세 자리가 함께 그 문장을 참으로 만든다:
    //  1. 여기 — 아래 `holding`(스펙의 *"busy 턴 중이거나 상주 CLI 생존"* 그대로).
    //  2. `ccg_store::status` — 이 두 키를 **디스크에 안 쓰고, 부팅 장전에서 걷어낸다**
    //     (R1은 그냥 영속돼, 턴을 한 번 돌린 채팅이 이후 모든 부팅에서 계정을 물었다 —
    //     확인 크리틱 R1 F1).
    //  3. `hub::Op::Dispose` — 슬롯을 거두면 마지막 lite에서 계정을 뗀다.
    //
    // API 키 축은 구독 계정이 없으므로 키를 안 싣는다(그 실행은 남의 한도를 안 태운다).
    //
    // ★R2(F1) `holding` — 이 슬롯이 **아직 시체가 아닌가**([`holds_account`] 참고).
    let holding = holds_account(state, rt.driver_ref().process_alive());
    let account = match rt.identity().billing() {
        ccg_engine::identity::BillingAxis::Subscription { account, .. } if holding => {
            // 빈 문자열은 「계정 미상」이지 계정이 아니다 — 그걸 실으면 목록에 없는
            // 계정 하나가 모든 자리를 물고 있는 것처럼 보인다.
            Some(account.to_string()).filter(|s| !s.is_empty())
        }
        _ => None,
    };
    json!({
        "chatId": rt.chat_id,
        "status": status,
        "account": account,
        // ★R28 ACCT §3 — 이 채팅이 앉은 **보드 자리**(`${boardId}::${slot}`). 「사용 중 ·
        // 2번 자리」의 그 번호가 여기서 나온다. 렌더러가 panelId ↔ chatId를 못 잇기
        // 때문이다(그 대응의 진실은 보드 스토어이고 셸만 안다 — `panel_seat_for_chat`).
        // 자리에 안 앉은 채팅(본채팅·추가 창)은 `null`이고, 그쪽 이름표는 렌더러가 안다.
        //
        // ★R2(F4) — 라우팅용 `panel_id_for_chat`이 아니라 **표시용** `panel_seat_for_chat`을
        // 쓴다. 마이그레이션이 만든 `default` 보드(`chrome:"ide"` = 본채팅 화면)가 본채팅을
        // 슬롯 0으로 물고 있어서, R1은 본채팅의 칩도 「사용 중 · 1번 자리」였다 —
        // 멀티 1번 자리와 문구가 충돌하고 「본채팅」 이름표는 도달 불가였다(크리틱 F4).
        "panelId": if holding { seat.as_ref().map(|s| s.panel_id.clone()) } else { None },
        // ★3.0.5 — **보이는 자리 번호**(1‥N, `order` 앞 `count`개 안의 위치). 「사용 중 · N번 자리」의
        // N은 이 값이다 — `panelId`의 슬롯 인덱스는 정체성이지 화면 위치가 아니다(드래그로 옮기면
        // 어긋난다 — 2026-09-03 보고). 접힌 자리는 `null`. 자리 조회는 허브가 펌프당 한 번 한다.
        "seat": if holding { seat.as_ref().and_then(|s| s.num) } else { None },
        "busy": rt.busy(),
        "bgActive": bg_active,
        "ask": ask,
        "hold": hold,
        "queued": rt.queue_len(),
        "unread": 0,
        // ★R4 — **재개의 주인**(m-logic P6 "행위자 하나" · M-UX R2.9의 이중 전송 축).
        //
        // `resumeOwner: "engine"`은 *"이 채팅의 한도 재개는 Rust가 관장한다"*는 선언이고,
        // 렌더러의 `useLimitResume`은 이 값을 보고 **자기 발화를 꺼야 한다**(`enabled:false`).
        // `autoResume`은 그 안에서 갈리는 스펙 ⑤다: 보이는 자리·열린 창은 스스로 쏘고
        // (`true`), 화면 밖 채팅은 `hold.ready`만 켜고 사용자가 누를 때까지 멈춘다(`false`).
        // 두 값을 하나로 접지 않는 이유는 `status`/`bgActive`를 안 접는 것과 같다 —
        // "관장한다"와 "지금 자동이다"는 다른 사실이고, 표시 쪽이 둘 다 필요하다.
        "autoResume": auto_resume,
        "resumeOwner": "engine",
        "updatedAt": now_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★R5 — `resetAt`은 렌더러가 `× 1000 - Date.now()`로 쓰는 **unix 초**여야 한다.
    /// 런타임 시계 ms를 그대로 실으면 배너의 남은 시간이 늘 0이 된다(R14 F2 후반부).
    #[test]
    fn reset_at_leaves_as_unix_seconds() {
        // 앱이 뜬 지 12초(런타임 ms), 벽시계는 1_755_000_000.000초.
        let rt_now = 12_000;
        let wall = 1_755_000_000_000;
        // 대기표는 런타임 기준 5시간 뒤 → 벽시계로 1_755_018_000초
        let v = runtime_ms_to_epoch_secs(rt_now, wall, Some(rt_now + 5 * 3600 * 1000));
        assert_eq!(v.as_f64(), Some(1_755_018_000.0));
        // 시각 미상은 null 그대로 — 렌더러가 "언제 풀리는지 모른다" 문장을 갖고 있다.
        assert!(runtime_ms_to_epoch_secs(rt_now, wall, None).is_null());
        // 이미 지난 시각도 과거로 정직하게 나간다(0으로 접지 않는다).
        let past = runtime_ms_to_epoch_secs(rt_now, wall, Some(2_000));
        assert_eq!(past.as_f64(), Some(1_754_999_990.0));
    }

    /// 프로세스 생존만 조종하는 최소 드라이버 — `holding` 판정의 대조군.
    struct Fake {
        alive: bool,
    }
    impl CliDriver for Fake {
        fn spawn(&mut self, _spec: &ccg_engine::driver::SpawnSpec) -> std::io::Result<()> {
            Ok(())
        }
        fn send(&mut self, _line: Value) {}
        fn close_input(&mut self) {}
        fn kill(&mut self) {}
        fn process_alive(&self) -> bool {
            self.alive
        }
        fn poll_frames(&mut self, _now: ccg_engine::clock::Millis) -> Vec<Value> {
            vec![]
        }
    }

    fn runtime(alive: bool) -> ccg_engine::runtime::ChatRuntime<Fake> {
        use ccg_engine::identity::*;
        let raw = RawIdentity {
            engine: RawEngine { kind: EngineKind::Claude, model: "opus".into(), effort: EffortId::Xhigh, codex_account: None },
            billing: RawBilling {
                kind: BillingKind::Subscription,
                account: Some("one@ccg.test".into()),
                drop_env_key: Some(false),
            },
            cwd: "C:\\Code".into(),
            add_dirs: vec![],
            mode: ModeId::Auto,
            system_prompt: None,
            output_style: None,
            tools: RawTools::default(),
        };
        ChatRuntime::new(
            "c-a",
            raw,
            IdentityDefaults::default(),
            ccg_engine::clock::VirtualClock::new(),
            Fake { alive },
        )
        .expect("픽스처 정체성")
    }

    /// ★R28 ACCT R2(F1) — **살아 있는 슬롯은 물고, 시체는 안 문다.**
    ///
    /// 확인 크리틱 R1 F1의 부수 사실: 「상주 CLI가 죽어도 `rt.identity()`는 살아 있어
    /// 칩이 남는다」. 그 한 칸만 판다 — 턴을 마치고 스트림을 정상적으로 닫은 `Idle`은
    /// 시체가 아니다(이 앱의 기본 정책이 `OnIdle`이라 턴마다 프로세스가 사라진다.
    /// 그것까지 접으면 칩이 턴 중에만 깜빡이고 §3이 사라진다).
    #[test]
    fn only_a_dead_resident_stops_holding_the_account() {
        use ccg_engine::state::StateTag as S;
        // 상주인데 프로세스가 죽었다 = 밖에서 CLI가 살해된 판 → 유일한 시체.
        assert!(!holds_account(S::Resident, false), "★ 죽은 상주 CLI가 계정을 물고 있다");
        assert!(holds_account(S::Resident, true), "★ busy 아닌 상주-생존도 「사용 중」이다");
        // 턴을 마친 Idle(프로세스 없음)은 살아 있는 세션이다 — 다음 턴이 이 계정을 태운다.
        assert!(holds_account(S::Idle, false), "★ 턴 사이의 정상 Idle을 시체로 셌다");
        for s in [S::Starting, S::Streaming, S::AwaitingUser, S::HeldResult, S::Interrupting, S::Terminating] {
            assert!(holds_account(s, false), "{s:?}는 턴 중이다");
        }
        assert!(!holds_account(S::Ended, true), "Ended는 다음 tick에 사라진다");
    }

    /// 그 판정이 실제 lite에 실리는가 — 계정·자리가 **함께** 뜨고 함께 떨어진다.
    #[test]
    fn the_account_key_rides_the_lite_only_while_the_slot_holds_it() {
        let rt = runtime(true);
        let v = build(&rt, Terminal::Done, 1_000, None);
        println!("[F1] 살아 있는 슬롯 = {v}");
        assert_eq!(v["account"], json!("one@ccg.test"));
        assert_eq!(v["status"], json!("done"), "종결 상태는 그대로다(사이드바 점 색)");
        // 보드가 없는 픽스처라 자리는 없음 — 본채팅 이름표는 렌더러가 붙인다(F4).
        assert!(v["panelId"].is_null());
    }
}
