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
    pub armed_from_run: RunId,
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
    /// 시각 앎  → max(resets_at + 90s, armed_at + 15s)   // RESET_GRACE_MS · Math.max(15_000, …)
    /// 시각 미상 → armed_at + PROBE(10분) × 2^attempts    // PROBE_MS + ★R5 지수 백오프
    /// ```
    ///
    /// 백오프가 2.6.2에 없는 이유는 그쪽 프로브가 **usage 조회 1회**였기 때문이다.
    /// 여기서는 같은 자리가 **CLI 턴 1회**를 태운다([`crate::limit::PROBE`] 주석).
    pub fn due_at(&self) -> Option<Millis> {
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
