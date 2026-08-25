//! D5 — 예약 큐(정체성 스냅샷 동봉) · 한도 대기(큐 게이트) · 되돌리기 버퍼. (§7)

use crate::clock::Millis;
use crate::identity::{BillingAxis, RunIdentity};
use crate::ids::RunId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueOrigin {
    User,
    LimitResume,
    ViewerAsk,
    NotifReplay,
    /// ★M10 — **다른 채팅의 세션이 보낸 메시지**(대화 연결 · `engine/talk.rs`).
    ///
    /// `User`와 갈라 두는 것이 안전 규약의 일부다: 이 값은 "사람이 개입했다"로 읽히면
    /// 안 된다. `User`였다면 ① 헛 재개 연쇄 카운터(`auto_resume_streak`)가 리셋되고
    /// ② 한도 대기표가 "사용자가 이미 다시 보냈다"로 판정해(`armed_at` 비교) 기계의
    /// 이어서 항목을 생략한다 — 둘 다 **AI가 보낸 줄 하나로** 사람의 자리를 대신
    /// 차지하는 것이다.
    Talk,
}

/// 예약 후 채팅 정체성이 바뀌었을 때의 정책. 기본은 **예약할 때 보던 대로**(P5의 약속 확장).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnDrift {
    KeepSnapshot,
    UseCurrent,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadIntent {
    Continue,
    Fresh,
}

impl QueueOrigin {
    /// 계약면 표기(`chat:queue`의 항목 `origin`).
    pub fn wire(self) -> &'static str {
        match self {
            QueueOrigin::User => "user",
            QueueOrigin::LimitResume => "limit_resume",
            QueueOrigin::ViewerAsk => "viewer_ask",
            QueueOrigin::NotifReplay => "notif_replay",
            QueueOrigin::Talk => "talk",
        }
    }
}

/// **예약 한 건의 입력**(★R4 — 렌더러 큐 이관).
///
/// R3까지 큐 항목은 **텍스트뿐**이었다(`Cmd::Enqueue { text }`). 렌더러의 예약은
/// `{text, images, picker}`라(`App.tsx ScheduledMsg`) 큐를 Rust로 옮기는 순간
/// **첨부·모델·모드가 통째로 사라진다**(M-UX R2.1 표 #3). 그래서 입력을 값으로 세운다.
///
/// `picker`는 *지금 채팅 정체성 위에 얹는 패치*다. 예약 시점의 picker로 스냅샷을 만들되
/// **채팅의 정체성은 바꾸지 않는다** — "예약할 때 보던 대로 나간다"(§7 P5의 약속)와
/// "예약이 채팅 설정을 몰래 바꾸지 않는다"를 동시에 지키는 유일한 모양이다.
#[derive(Debug, Clone, Default)]
pub struct QueueInput {
    pub text: String,
    /// 첨부 이미지의 **경로**(2.6.2 `ScheduledMsg.images`와 같은 값).
    pub images: Vec<String>,
    pub picker: Option<crate::identity::RawIdentityPatch>,
    /// ★M10 — **이 입력을 만든 자**. `None` = 사람(옛 경로 전부의 뜻 그대로).
    ///
    /// 필드로 둔 이유: `Cmd::Enqueue`는 상태에 따라 *지금 보낼지 세울지*가 갈리는
    /// 명령표의 한 행이고, 그 행을 원본마다 복제하면 표가 두 벌이 된다. 갈라야 하는
    /// 것은 **누가 넣었나**뿐이라 입력에 싣는다.
    pub origin: Option<QueueOrigin>,
    /// ★M10 R3 — **picker가 안 서면 이 항목을 버려라**(fail-closed).
    ///
    /// 기본은 `false` = 지금까지의 규약 그대로다: 정규화가 실패하면(폴더 없음·계정
    /// 없음) 항목이 사라지는 것보다 *"보던 대로"* 로 떨어지는 편이 낫다(R4 폴백).
    ///
    /// 그 규약이 **대화 연결에는 안 맞는다.** 거기서 picker는 "예약할 때 보던 대로"가
    /// 아니라 **봉투 턴의 권한 하한**이고, 하한을 못 걸면 그 한 건이 원래 모드
    /// (`bypass`일 수 있다)로 돈다 — 예약 하나가 사라지는 것보다 나쁘다. 도달 경로는
    /// 좁지만 실재한다: `AccountUnavailable`은 폴더가 멀쩡한 채로 난다(M11 로그아웃).
    pub require_picker: bool,
}

impl QueueInput {
    /// 본문만 있는 예약(재생 하네스·재장전의 기본 모양).
    pub fn text(t: impl Into<String>) -> QueueInput {
        QueueInput {
            text: t.into(),
            ..Default::default()
        }
    }
}

impl From<&str> for QueueInput {
    fn from(t: &str) -> QueueInput {
        QueueInput::text(t)
    }
}
impl From<String> for QueueInput {
    fn from(t: String) -> QueueInput {
        QueueInput::text(t)
    }
}

/// `chat:queue-mutate`의 op — **넣기 말고** 큐 자체를 만지는 것들(§6.1).
///
/// `enqueue`는 여기 없다: 상태에 따라 *지금 보낼지 세울지*가 갈리므로
/// (`command_cell("enqueue", state)`) 명령표를 타는 [`crate::runtime::Cmd::Enqueue`]다.
#[derive(Debug, Clone)]
pub enum QueueOp {
    /// 항목 하나 취소. 없는 id는 거부(`no_item`)다 — 조용히 성공하면 화면이 거짓말한다.
    Remove { id: String },
    /// 새 순서(항목 id 목록). 목록에 없는 항목은 **뒤에 원래 순서대로** 남는다 —
    /// 렌더러가 낡은 목록으로 재정렬해도 예약이 사라지지 않는다.
    Reorder { ids: Vec<String> },
    /// 전부 비움(되돌리기 토큰을 남긴다 — §7.4).
    Clear,
    /// 모르는 op. 접수만 하고 아무것도 안 한다(렌더러가 앞서 나가도 셸이 안 죽는다).
    Noop,
}

#[derive(Debug, Clone)]
pub struct QueuedMessage {
    pub id: String,
    pub text: String,
    /// 첨부 이미지 경로. 드레인할 때 본문 뒤 **첨부 노트**로 접혀 나간다
    /// (2.6.2 `promptWithNotes` 파리티 — `runtime::compose_prompt`).
    pub attachments: Vec<String>,
    /// 예약한 순간의 **확정** 정체성 — 이 값으로 나간다.
    pub identity: RunIdentity,
    pub identity_rev: u32,
    pub thread: ThreadIntent,
    pub on_drift: OnDrift,
    pub created_at: Millis,
    pub origin: QueueOrigin,
}

/// 한도 대기 = **큐 게이트**. 자동 이어서는 별개 행위자가 아니라 큐 항목이다(P6를 죽인다).
#[derive(Debug, Clone)]
pub struct LimitHold {
    /// 대기표도 정체성 축으로 식별 — 계정을 바꾸면 이 표는 무효다.
    pub account: BillingAxis,
    /// 해제 예정 시각 — **런타임 시계 ms**(벽시계 unix 초가 아니다.
    /// `ChatRuntime::epoch_secs_to_runtime`이 옮긴 값이다).
    ///
    /// ★R5 — `None`은 이제 **"시각 미상"** 그대로다. R4까지는 장전이 `None`을 받으면
    /// `now + 5분`으로 **덮어썼고**(그래서 5시간 한도에도 화면이 "약 5분 뒤"라고 적었다),
    /// 6.5분마다 헛 재개가 돌았다(R14 확인 크리틱 F2 — 30분에 4회).
    pub resets_at: Option<Millis>,
    pub verified_at: Option<Millis>,
    pub ready: bool,
    /// ★R5 — **자동 재발화 상한 소진**. `ready`는 켜되(사이드바가 "이어갈 수 있음"을
    /// 그린다) 엔진은 스스로 쏘지 않는다. 출구는 사용자의 `resume_now` 하나다.
    /// 스펙 ⑤(화면 밖 채팅)와 착지점이 같고, 이유만 다르다.
    pub auto_paused: bool,
    /// ★R5 — 이 한도 에피소드에서 엔진이 **이미 태운 자동 재개 턴** 수.
    /// 0 = 사용자(또는 일반 드레인)의 턴이 죽어서 처음 걸린 표.
    /// 시각 미상 대기의 지수 백오프 지수이자 [`crate::limit::MAX_AUTO_ATTEMPTS`]의 기준.
    pub attempts: u32,
    /// ★T3T4 R3 — **판정 근거를 못 얻은 재검증**의 연속 횟수(이식본 `LimitHold.probes`).
    ///
    /// [`attempts`](Self::attempts)와 세는 것이 다르다: 저쪽은 *태운 CLI 턴*이고 이쪽은
    /// *실패한 usage 조회*다. 그래서 간격도 다르다([`crate::limit::recheck_wait`] —
    /// 15초부터 배로, [`crate::limit::PROBE`]에서 멎는다). 값을 얻은 재검증이 0으로 되돌린다.
    pub probes: u32,
    /// 마지막 재검증 **시도** 시각 — `probes`가 세는 재확인 간격의 기준점.
    ///
    /// `armed_at`을 안 쓰는 이유: 그 값은 [`crate::runtime::ChatRuntime`]이 "표 뒤에 들어온
    /// 사용자 메시지인가"를 가르는 데도 쓴다(재개 단일 소유). 재확인마다 그걸 밀면
    /// 대기 중에 사용자가 걸어 둔 메시지가 **표보다 먼저 온 것**으로 읽혀 나팔이 하나 더
    /// 끼워진다 = 한 번의 해제에 두 턴.
    pub probed_at: Option<Millis>,
    pub armed_from_run: RunId,
    /// ★M11 R2(C3) — **아직 말하지 않은 대기 문장이 있다.**
    ///
    /// R1은 이 플래그를 런타임 필드(`hold_notice_due`)로 뒀고, 내리는 자리는 둘뿐이었다
    /// (전환 성사 · 실제 발화). 그런데 대기표는 **다른 세 경로**로도 죽는다(§7.3 계정
    /// 변경 · `Cmd::HoldCancel` · undo 복원). 표가 죽어도 플래그가 살아남아, 사용자가
    /// 방금 「계정을 바꿔서 대기표를 취소했어요」를 읽은 **바로 다음 줄**에 「사용 한도에
    /// 걸려 대기합니다」가 붙었다(R1 크리틱 C2/A1·A2). 게다가 표가 없으니 `resets_at`도
    /// 잃어 「언제 풀리는지 알 수 없어」 변종이 나갔다 — 알던 시각까지 버린 것이다.
    ///
    /// 그래서 플래그를 **표 안으로 옮겼다**: 표가 죽으면 미뤄 둔 문장도 같이 죽는다.
    /// 가드를 한 줄 더하는 대신 구조적으로 불가능하게 만드는 쪽을 골랐다 — 표를
    /// `None`으로 만드는 자리는 앞으로도 늘어난다.
    pub notice_due: bool,
    /// ★R28g BANNER — **이 표는 디스크에서 재장전됐고, 이 프로세스에서 아직 한 번도
    /// 판정받지 않았다**([`crate::runtime::ChatRuntime::reload_state`]가 켜는 유일한 칸).
    ///
    /// 왜 필요한가(R28f WFIRE 확인 크리틱 R1 F1/F3 실측): `check_hold`의 첫 문이
    /// `filter(|h| !h.ready)`라, **디스크에 `ready:true`로 적힌 표는 재장전 뒤 영영
    /// 판정에 도달하지 못한다.** 인프로세스에서는 그 필터가 옳다 — `ready`가 켜진 표는
    /// 같은 tick에 소진되거나(=표가 사라진다) 세 착지 중 하나에서 멎은 표이고, 다시
    /// 들여다보면 같은 문장을 매 tick 되뇐다. 그런데 **재장전은 그 tick의 바깥**이다:
    /// 표는 `ready`인데 이 프로세스는 그 판정을 한 번도 안 했다. 그래서 크리틱의
    /// c8 실측이 「`ready:true`로 저장된 표 = 재장전 뒤 20시간 **0발**」이었고, 그동안
    /// 배너는 「곧 이어서 계속해요」라고 **지키지 못할 약속**을 했다(D7의 반대편).
    ///
    /// 통행권은 **한 번**이다. 첫 판정에 들어가는 순간 내려가고([`crate::runtime`]의
    /// `check_hold`), 그 판정은 `ready`를 잠시 내려 **인프로세스와 똑같은 경로**를 타게
    /// 한다 — 그래야 `Blocked`(다시 기다린다)·`Unavailable`(재확인 계수)·`Clear`(발사 또는
    /// 접힘) 세 착지가 전부 설계된 모양으로 산다.
    pub reloaded: bool,
    /// 이 표를 **건 시각**(★R4 — 재개 단일 소유).
    ///
    /// 소진할 때 "이어서" 항목을 넣을지 말지를 이 값이 가른다: 표가 걸린 **뒤에**
    /// 접수된 사용자 메시지가 큐에 있으면 *그것이 이 채팅의 재개*이고, 기계가 앞에
    /// 나팔을 하나 더 넣으면 **한 번의 해제에 두 턴**이 나간다(렌더러 `useLimitResume`가
    /// 먼저 쏜 경우가 정확히 그 모양이다 — M-UX R2.9의 재현 축).
    pub armed_at: Millis,
}

impl LimitHold {
    /// 신선 usage 재검증 시각 — 2.6.2 `resumeDelayMs`(`limitResume.ts:90`)의 이식.
    ///
    /// ```text
    /// 조회 실패 → probed_at + recheck_wait(probes)      // ★T3T4 R3 — 15초부터 배로, 10분 상한
    /// 시각 앎  → max(resets_at + 90s, armed_at + 15s)   // RESET_GRACE_MS · Math.max(15_000, …)
    /// 시각 미상 → armed_at + PROBE(10분) × 2^attempts    // PROBE_MS + ★R5 지수 백오프
    /// ```
    ///
    /// 백오프가 2.6.2에 없는 이유는 그쪽 프로브가 **usage 조회 1회**였기 때문이다.
    /// 여기서는 같은 자리가 **CLI 턴 1회**를 태운다([`crate::limit::PROBE`] 주석).
    ///
    /// 첫 줄이 맨 위인 이유(이식본 `holdDelayMs`와 같은 순서): 조회에 실패해 유지된 표는
    /// 리셋 시각이 **이미 지나 있다**. 그 시각으로 다음 재검증을 잡으면 `due`가 매 tick
    /// 참이라 초당 수십 번 조회를 때린다.
    pub fn due_at(&self) -> Option<Millis> {
        if self.probes > 0 {
            let base = self.probed_at.unwrap_or(self.armed_at);
            return Some(base + crate::limit::recheck_wait(self.probes));
        }
        Some(match self.resets_at {
            Some(r) => (r + crate::limit::GRACE).max(self.armed_at + crate::limit::MIN_DELAY),
            None => self.armed_at + crate::limit::unknown_wait(self.attempts),
        })
    }
}

#[derive(Debug, Clone)]
pub struct QueueUndo {
    pub items: Vec<QueuedMessage>,
    pub hold: Option<LimitHold>,
    pub token: String,
    /// 다음 성공 send 또는 5분, 둘 중 먼저.
    pub valid_until: Millis,
}

/// §7.2 배칭 계획 — **연속 동일 정체성은 한 스트림에서 연속 주입**한다.
/// 이 계산이 참이 되려면 §3.4-a(드레인 가능하면 close 보류)가 있어야 한다.
pub fn drain_plan(
    items: &[QueuedMessage],
    current_stream_identity: Option<&RunIdentity>,
) -> Vec<crate::event::PlanGroup> {
    let mut out: Vec<crate::event::PlanGroup> = vec![];
    let mut left = current_stream_identity.map(|i| i.hash());
    for m in items {
        let h = m.identity.hash();
        match out.last_mut() {
            Some(g) if g.identity_hash == h => g.count += 1,
            _ => {
                let will_respawn = left.as_ref().is_some_and(|l| *l != h);
                out.push(crate::event::PlanGroup {
                    count: 1,
                    identity_hash: h.clone(),
                    will_respawn,
                    kills_live: vec![],
                });
                left = Some(h);
            }
        }
    }
    out
}
