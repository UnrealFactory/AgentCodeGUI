//! D1 — 실행 정체성을 **값 하나**로. (`docs/design/m-logic.md` §2)
//!
//! 타입이 셋인 이유(§2.2 ★R3): 저장 포맷·부분 패치·정규화값을 한 타입이 겸직하면
//! "effort만 바꿨는데 폴백 model이 되돌아온다"(크리틱 N2)가 다시 난다.
//!
//! | 타입 | 무엇 | 어디에 |
//! |---|---|---|
//! | [`RawIdentity`] | **완전 지정** 원시 정체성(값은 미해석 가능) | 채팅 파일 · `normalize()` 입력 · 마이그레이션 1차 비교 키 |
//! | [`RawIdentityPatch`] | **리프 단위** 부분 패치(`None` = 안 건드림) | `chat:identity-set` 인자 · [`Staged`] |
//! | [`RunIdentity`] | 정규화된 확정값. 생성자는 [`RunIdentity::normalize`] 하나 | `ChatRuntime.identity` · `stream.spawn_identity` · 큐 항목 · 리비전 |

use crate::canon::{fingerprint8, stable_hash16};
use crate::ids::FrameSeq;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

// ─────────────────────────────────────────────────────────────────────────────
// 값 공간 (닫힌 열거형)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffortId {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// 값 공간은 **2.6.2 picker의 것**이다(`normal|plan|acceptEdits|auto|bypass`).
/// 근거: 마이그레이션 매핑 함수(`ccg-store/src/raw_identity.rs` `MODE_IDS`)가 이 문자열을
/// 파일에 쓴다 — 여기서 CLI 쪽 이름(`default`/`bypassPermissions`)을 쓰면 두 크레이트가
/// 같은 `RawIdentity` JSON을 교환하지 못한다. CLI argv 매핑은 driver.rs가 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModeId {
    Normal,
    Plan,
    AcceptEdits,
    Auto,
    Bypass,
}

/// CLI 내장 4종만 유효. 그 외 값은 정규화에서 `None`이 된다(`engine.ts:56-60` 파리티).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum OutputStyle {
    Concise,
    Explanatory,
    Learning,
    Proactive,
}

impl OutputStyle {
    pub fn parse(s: &str) -> Option<OutputStyle> {
        match s {
            "Concise" => Some(OutputStyle::Concise),
            "Explanatory" => Some(OutputStyle::Explanatory),
            "Learning" => Some(OutputStyle::Learning),
            "Proactive" => Some(OutputStyle::Proactive),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            OutputStyle::Concise => "Concise",
            OutputStyle::Explanatory => "Explanatory",
            OutputStyle::Learning => "Learning",
            OutputStyle::Proactive => "Proactive",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillOverride {
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BillingKind {
    Subscription,
    ApiKey,
}

/// 정규화된 절대경로 — 구분자 통일 + 후행 `\` 제거. **표시·스폰용 원래 대소문자는 보존**하고,
/// 동일성(비교·해시·직렬화)만 소문자로 접는다.
///
/// ★3.0.5 — 3.0.4까지는 `of`가 경로를 통째로 소문자화했다(`CanonPath(s.to_lowercase())`). 그
/// 값이 `as_str()`로 나와 CLI 스폰 cwd(`driver.rs`)·에코된 `session.cwd`·저장된 정체성(`to_raw`)
/// 까지 전부 소문자였고, 작업 폴더 이름이 화면에서 `C:\Code\VoxArtDev` → `c:\code\voxartdev`로
/// 바뀌어 보였다(2026-09-03 보고, 실측 chats-v3의 `identity.cwd`가 소문자). 이제 원래 표기를
/// 들고 다니고 **비교·해시만** 접는다 — §2.3(P1b: `C:\Code\x` 와 `c:\code\x\`가 재스폰을 만들면
/// 안 된다)은 접힌 `key`로 지키고, 정체성 해시는 `key`를 직렬화하므로 골든 값도 그대로다.
#[derive(Debug, Clone)]
pub struct CanonPath {
    /// 표시·스폰·저장용 — **원래 대소문자**(구분자·후행 슬래시만 정규화).
    orig: String,
    /// 동일성 키 — 소문자로 접은 값(Windows 파일시스템은 대소문자 무관).
    key: String,
}

impl CanonPath {
    /// 표시·스폰·저장에 쓰는 **원래 대소문자** 경로.
    pub fn as_str(&self) -> &str {
        &self.orig
    }
    /// 비교용 **접힌 키**(대소문자 무관). 재사용·스레드 판정이 쓴다 — 여기서 원래 표기를
    /// 쓰면 같은 폴더를 다른 대소문자로 만났을 때 헛 재스폰이 난다(P1b).
    pub fn key(&self) -> &str {
        &self.key
    }
    /// 폴딩을 플랫폼 조건부로 두지 않는 이유: 정체성 해시가 **플랫폼 간에도** 같아야
    /// 재생 하네스(리눅스 CI)와 실앱(Windows)이 같은 값을 낸다.
    pub fn of(raw: &str) -> CanonPath {
        let mut s = raw.trim().replace('/', "\\");
        while s.len() > 3 && s.ends_with('\\') {
            s.pop();
        }
        let key = s.to_lowercase();
        CanonPath { orig: s, key }
    }
}

// 동일성은 **접힌 키만** 본다(원래 대소문자는 표시용이라 정체성에 안 샌다).
impl PartialEq for CanonPath {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}
impl Eq for CanonPath {}
impl std::hash::Hash for CanonPath {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.key.hash(state);
    }
}
impl PartialOrd for CanonPath {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for CanonPath {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.key.cmp(&other.key)
    }
}
// ★ 직렬화는 **접힌 값**이다 — 정체성 해시(`canon_json`)가 이걸 쓰므로 P1b·골든 해시가
// 원래 대소문자에 흔들리면 안 된다. 표시용 원래 표기는 `identity_wire`가 따로 싣는다.
impl Serialize for CanonPath {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.key)
    }
}

pub type AccountEmail = String;
pub type KeyFingerprint = String;
pub type ModelId = String;
pub type SkillId = String;
pub type McpServerId = String;

// ─────────────────────────────────────────────────────────────────────────────
// RunIdentity — 정규화된 확정값
// ─────────────────────────────────────────────────────────────────────────────

/// 엔진별 모델 id 공간·계정 스토어가 다르다 → 태그드 유니온.
/// 평평하게 두면 "codexModel은 claude일 때 무시"가 비교식에 스며든다(P1).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EngineAxis {
    Claude {
        model: ModelId,
        effort: EffortId,
    },
    Codex {
        model: ModelId,
        effort: EffortId,
        account: Option<String>,
        /// ★2026-09-05 — 속도 티어 id(`"priority"` = Fast). `None` = 표준. 직렬화 생략으로
        /// 티어 없는 Codex 정체성의 `hash()`가 3.0.8과 같다(재스폰 사유가 생기지 않는다).
        #[serde(skip_serializing_if = "Option::is_none")]
        tier: Option<String>,
    },
}

/// 과금·자격 경로. `api_mode` 불리언 + `account` 문자열 두 필드로 두면
/// "useApi면 account 무시"가 비교식 밖에 남는다 → 하나로 접는다.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BillingAxis {
    Subscription {
        account: AccountEmail,
        #[serde(rename = "dropEnvKey")]
        drop_env_key: bool,
    },
    /// **지문만.** 키 원문은 해시·로그·이벤트에 실리므로 절대 정체성에 넣지 않는다.
    ApiKey {
        #[serde(rename = "keyFp")]
        key_fp: KeyFingerprint,
    },
}

/// 스폰 시점 settings 플래그에 굳는 도구 정책(`engine.ts:870-877`). **P1e**.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPolicyAxis {
    pub skill_overrides: BTreeMap<SkillId, SkillOverride>,
    pub denied_mcp: BTreeSet<McpServerId>,
}

/// **정규화된** 실행 정체성.
///
/// - 생성자는 [`RunIdentity::normalize`] 하나뿐이고 필드는 `pub(crate)`이다 →
///   "정규화 안 된 정체성"이라는 상태가 타입에 존재하지 않는다.
/// - `Deserialize`를 **일부러 구현하지 않는다**: 디스크에서 되싣는 경로가 생기면
///   그 순간 정규화를 건너뛴 값이 들어온다. 저장은 [`RawIdentity`]로 한다(§2.4 물질화).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunIdentity {
    pub(crate) engine: EngineAxis,
    pub(crate) billing: BillingAxis,
    pub(crate) cwd: CanonPath,
    pub(crate) add_dirs: BTreeSet<CanonPath>,
    pub(crate) mode: ModeId,
    pub(crate) system_prompt: Option<String>,
    pub(crate) output_style: Option<OutputStyle>,
    pub(crate) tools: ToolPolicyAxis,
}

impl RunIdentity {
    pub fn engine(&self) -> &EngineAxis {
        &self.engine
    }
    /// 엔진 축의 **종류만**. 세션 신원(resume 키)이 어느 엔진의 것인지 가르는 데 쓴다 —
    /// Claude의 `session_id`는 codex의 `threadId`가 아니고 그 반대도 아니다.
    pub fn engine_kind(&self) -> EngineKind {
        match &self.engine {
            EngineAxis::Claude { .. } => EngineKind::Claude,
            EngineAxis::Codex { .. } => EngineKind::Codex,
        }
    }
    pub fn billing(&self) -> &BillingAxis {
        &self.billing
    }
    pub fn cwd(&self) -> &CanonPath {
        &self.cwd
    }
    pub fn add_dirs(&self) -> &BTreeSet<CanonPath> {
        &self.add_dirs
    }
    pub fn mode(&self) -> ModeId {
        self.mode
    }
    pub fn tools(&self) -> &ToolPolicyAxis {
        &self.tools
    }
    pub fn model(&self) -> &str {
        match &self.engine {
            EngineAxis::Claude { model, .. } | EngineAxis::Codex { model, .. } => model,
        }
    }
    pub fn effort(&self) -> EffortId {
        match &self.engine {
            EngineAxis::Claude { effort, .. } | EngineAxis::Codex { effort, .. } => *effort,
        }
    }
    pub fn account(&self) -> Option<&str> {
        match &self.billing {
            BillingAxis::Subscription { account, .. } => Some(account),
            BillingAxis::ApiKey { .. } => None,
        }
    }
    /// 채팅별 추가 지시(§2.3에서 trim + 빈 문자열 = 없음으로 정규화된 값).
    /// Codex는 이 값을 `developerInstructions`로 싣는다(Claude는 `initialize`의 append).
    pub fn system_prompt(&self) -> Option<&str> {
        self.system_prompt.as_deref()
    }
    /// **O4** — Codex 실행이 소비할 OpenAI 계정. Claude 정체성이면 항상 `None`이다
    /// (평평한 필드가 아니라 축 안에 있어서 타입이 그것을 보장한다 — ★R2).
    pub fn codex_account(&self) -> Option<&str> {
        match &self.engine {
            EngineAxis::Codex { account, .. } => account.as_deref(),
            EngineAxis::Claude { .. } => None,
        }
    }
    /// ★2026-09-05 — Codex 속도 티어 id(`"priority"` = Fast). 표준·Claude면 `None`.
    pub fn codex_tier(&self) -> Option<&str> {
        match &self.engine {
            EngineAxis::Codex { tier, .. } => tier.as_deref(),
            EngineAxis::Claude { .. } => None,
        }
    }

    /// 16바이트 hex. 정준 직렬화 기반이라 프로세스 간·릴리즈 간에 같다(canon.rs).
    pub fn hash(&self) -> String {
        stable_hash16(&serde_json::to_value(self).expect("RunIdentity serialize"))
    }

    /// 차이 **리프 경로** 목록 — UI 문구·정착 사유·재스폰 사유가 그대로 쓴다.
    ///
    /// 비교는 **정규화값의 리프**로 한다. `to_raw()`로 접어서 비교하면 `billing.keyFp`가
    /// 원시값에 없어 **키를 갈아도 차이가 0으로 보인다** — P1e("옛 키로 계속 과금")의 재발.
    pub fn diff(&self, other: &Self) -> Vec<IdentityField> {
        let mut out = vec![];
        for f in IdentityField::ALL {
            if norm_leaf_value(self, f) != norm_leaf_value(other, f) {
                out.push(f);
            }
        }
        out
    }

    /// 정규화값 → 원시값 되접기. 저장·마이그레이션 2단 비교(O12 수정판)가 쓴다.
    /// `normalize(to_raw(x)) == x`는 골든 테스트가 강제한다.
    pub fn to_raw(&self) -> RawIdentity {
        let (kind, model, effort, codex_account, codex_tier) = match &self.engine {
            EngineAxis::Claude { model, effort } => {
                (EngineKind::Claude, model.clone(), *effort, None, None)
            }
            EngineAxis::Codex {
                model,
                effort,
                account,
                tier,
            } => (EngineKind::Codex, model.clone(), *effort, account.clone(), tier.clone()),
        };
        let billing = match &self.billing {
            BillingAxis::Subscription {
                account,
                drop_env_key,
            } => RawBilling {
                kind: BillingKind::Subscription,
                account: Some(account.clone()),
                drop_env_key: Some(*drop_env_key),
            },
            BillingAxis::ApiKey { .. } => RawBilling {
                kind: BillingKind::ApiKey,
                account: None,
                drop_env_key: None,
            },
        };
        RawIdentity {
            engine: RawEngine {
                kind,
                model,
                effort,
                codex_account,
                codex_tier,
            },
            billing,
            cwd: self.cwd.as_str().to_string(),
            add_dirs: self
                .add_dirs
                .iter()
                .map(|p| p.as_str().to_string())
                .collect(),
            mode: self.mode,
            system_prompt: self.system_prompt.clone(),
            output_style: self.output_style.map(|s| s.as_str().to_string()),
            tools: RawTools {
                skill_overrides: self.tools.skill_overrides.clone(),
                denied_mcp: self.tools.denied_mcp.iter().cloned().collect(),
            },
        }
    }

    /// **유일한 생성 경로.** 실패는 `IdentityError`(폴더 없음 / 미로그인 계정 / 키 없음).
    pub fn normalize(
        raw: RawIdentity,
        defaults: &IdentityDefaults,
    ) -> Result<RunIdentity, IdentityError> {
        // billing 먼저 — 계정/키 문제는 폴더 문제보다 사용자 조치가 명확하다.
        let billing = match raw.billing.kind {
            BillingKind::ApiKey => {
                let key_fp = defaults
                    .api_key
                    .as_ref()
                    .map(|k| fingerprint8(k))
                    .ok_or(IdentityError::ApiKeyMissing)?;
                BillingAxis::ApiKey { key_fp }
            }
            BillingKind::Subscription => {
                let account = raw
                    .billing
                    .account
                    .clone()
                    .or_else(|| defaults.default_account.clone())
                    .ok_or_else(|| IdentityError::AccountUnavailable(String::new()))?;
                if !defaults.known_accounts.is_empty()
                    && !defaults.known_accounts.contains(&account)
                {
                    return Err(IdentityError::AccountUnavailable(account));
                }
                // 전역 ANTHROPIC_API_KEY가 없으면 이 축은 의미가 없다 → false 고정.
                // 있으면 그 **키 지문별로 저장된 사용자 답**, 미응답이면 안전값 true(구독).
                let drop_env_key = if !defaults.env_api_key_present {
                    false
                } else {
                    raw.billing
                        .drop_env_key
                        .or(defaults.env_key_answer)
                        .unwrap_or(true)
                };
                BillingAxis::Subscription {
                    account,
                    drop_env_key,
                }
            }
        };

        let cwd_src = if raw.cwd.trim().is_empty() {
            defaults.default_cwd.clone()
        } else {
            raw.cwd.clone()
        };
        let cwd = CanonPath::of(&cwd_src);
        if !defaults.cwd_probe.exists(&cwd) {
            return Err(IdentityError::CwdMissing(cwd.as_str().to_string()));
        }

        let add_dirs: BTreeSet<CanonPath> = raw
            .add_dirs
            .iter()
            .map(|p| CanonPath::of(p))
            .filter(|p| p != &cwd) // `App.tsx:1058` 파리티
            .collect();

        let engine = match raw.engine.kind {
            EngineKind::Claude => EngineAxis::Claude {
                model: raw.engine.model.clone(),
                effort: raw.engine.effort,
            },
            // ★O4 — Codex 축의 계정도 **구독 계정과 같은 규칙**으로 접는다(M4에서 닫음):
            //  ① 미지정이면 기본 계정으로 해석한다(2.6.2 `req.codexAccount ??
            //     codexDefaultAccountEmail()` — `codex/engine.ts:1589`)
            //  ② 앱이 아는 계정 목록이 있으면 그 안에 있어야 한다. 없으면
            //     `AccountUnavailable` — 로그아웃된 계정으로 스폰해 **격리 CODEX_HOME이
            //     빈 폴더로 물질화되는 것**(= 미로그인 상태로 뜬 뒤 첫 턴에서 죽는 것)을
            //     정규화 단계에서 막는다.
            //  ③ 목록이 비어 있으면 검사하지 않는다(재생 하네스 기본값 — 구독 축과 동일).
            // 계정이 하나도 없으면 `None`으로 남는다: 그 판정(=로그인 안내)은 스폰
            // 시점의 셸이 한다. 정체성 자체는 "계정 미지정"이라는 정직한 값을 유지한다.
            EngineKind::Codex => {
                let account = raw
                    .engine
                    .codex_account
                    .clone()
                    .or_else(|| defaults.default_codex_account.clone());
                if let Some(a) = &account {
                    if !defaults.known_codex_accounts.is_empty()
                        && !defaults.known_codex_accounts.contains(a)
                    {
                        return Err(IdentityError::AccountUnavailable(a.clone()));
                    }
                }
                EngineAxis::Codex {
                    model: raw.engine.model.clone(),
                    effort: raw.engine.effort,
                    account,
                    tier: normalize_tier(raw.engine.codex_tier.as_deref()),
                }
            }
        };

        let system_prompt = raw
            .system_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        let output_style = raw.output_style.as_deref().and_then(OutputStyle::parse);

        Ok(RunIdentity {
            engine,
            billing,
            cwd,
            add_dirs,
            mode: raw.mode,
            system_prompt,
            output_style,
            tools: ToolPolicyAxis {
                skill_overrides: raw.tools.skill_overrides.clone(),
                denied_mcp: raw.tools.denied_mcp.iter().cloned().collect(),
            },
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RawIdentity — 채팅 파일에 저장되는 완전 지정 원시값(§2.4 물질화)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEngine {
    pub kind: EngineKind,
    pub model: ModelId,
    pub effort: EffortId,
    #[serde(default)]
    pub codex_account: Option<String>,
    /// ★2026-09-05 — Codex **속도 티어**(app-server `serviceTier` · 실측 `model/list`의
    /// `serviceTiers[{id:"priority", name:"Fast"}]`). `None` = 표준. Claude 정체성에는 없다.
    /// 옛 파일에는 키가 없다 → `default`; 없으면 직렬화도 생략해 옛 정체성의 원시값이 그대로다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_tier: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawBilling {
    pub kind: BillingKind,
    /// 마이그레이션 매핑이 `api_key`일 때 이 키를 아예 안 쓴다 → `default` 필수.
    #[serde(default)]
    pub account: Option<AccountEmail>,
    #[serde(default)]
    pub drop_env_key: Option<bool>,
}

/// **★D17 — 스토어와 바이트가 같아야 한다.** 직렬화를 손으로 쓴 이유가 이것뿐이다.
///
/// 마이그레이션의 **1차 비교 키**는 `RawIdentity`의 정준 직렬화다(`raw_hash`). 그 값을
/// 만드는 저자가 둘이다 — 마이그레이션은 `ccg-store::raw_identity::to_raw_identity`,
/// 실행 중 저장은 이 크레이트의 `RunIdentity::to_raw()`. 그런데 `api_key` 변형에서
/// 모양이 갈렸다:
///
/// | 저자 | `api_key`일 때 |
/// |---|---|
/// | `ccg-store` (+ 크리틱 독립 미러 `critic-m2-migrate.mjs:57`) | `{"kind":"api_key"}` |
/// | 파생 `derive(Serialize)` | `{"kind":"api_key","account":null,"dropEnvKey":null}` |
///
/// 크리틱 하네스의 `canon()`은 **null을 지우지 않는다**(`critic-m2-lib.mjs:35-42`) —
/// 엔진이 `to_raw()`를 저장하기 시작하는 순간 1차 비교가 **거짓 불일치**를 낸다
/// (크리틱 R8 §4 후속 D17). 고치는 방향은 하나뿐이다: **엔진이 스토어에 맞춘다.**
/// 반대로 스토어에 null 두 개를 넣으면 크리틱의 독립 미러가 깨지고, 그건 "판정자를
/// 판정 대상에 맞추는" 수정이다.
///
/// 규칙: `kind`는 항상. `account`·`dropEnvKey`는 **구독일 때만**(값이 없으면 `null`로).
/// 역직렬화는 파생 그대로라 두 모양 다 읽는다.
impl Serialize for RawBilling {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let subscription = matches!(self.kind, BillingKind::Subscription);
        let mut m = ser.serialize_map(Some(if subscription { 3 } else { 1 }))?;
        m.serialize_entry("kind", &self.kind)?;
        if subscription {
            m.serialize_entry("account", &self.account)?;
            m.serialize_entry("dropEnvKey", &self.drop_env_key)?;
        }
        m.end()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTools {
    pub skill_overrides: BTreeMap<SkillId, SkillOverride>,
    pub denied_mcp: Vec<McpServerId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawIdentity {
    pub engine: RawEngine,
    pub billing: RawBilling,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub add_dirs: Vec<String>,
    pub mode: ModeId,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub output_style: Option<String>,
    #[serde(default)]
    pub tools: RawTools,
}

impl RawIdentity {
    /// 마이그레이션 **1차 비교 키**(O12 수정판) — 정규화가 실패하는 데이터에서도 항상 정의된다.
    pub fn raw_hash(&self) -> String {
        stable_hash16(&serde_json::to_value(self).expect("RawIdentity serialize"))
    }

    /// 패치를 얹은 새 원시값. 지정되지 않은 리프는 self의 값이 그대로 산다.
    pub fn patched(&self, p: &RawIdentityPatch) -> RawIdentity {
        let mut r = self.clone();
        if let Some(k) = p.engine.kind {
            r.engine.kind = k;
        }
        if let Some(m) = &p.engine.model {
            r.engine.model = m.clone();
        }
        if let Some(e) = p.engine.effort {
            r.engine.effort = e;
        }
        if let Some(a) = &p.engine.codex_account {
            r.engine.codex_account = a.clone();
        }
        if let Some(t) = &p.engine.codex_tier {
            r.engine.codex_tier = t.clone();
        }
        if let Some(k) = p.billing.kind {
            r.billing.kind = k;
        }
        if let Some(a) = &p.billing.account {
            r.billing.account = Some(a.clone());
        }
        if let Some(d) = p.billing.drop_env_key {
            r.billing.drop_env_key = Some(d);
        }
        if let Some(c) = &p.cwd {
            r.cwd = c.clone();
        }
        if let Some(d) = &p.add_dirs {
            r.add_dirs = d.clone();
        }
        if let Some(m) = p.mode {
            r.mode = m;
        }
        if let Some(v) = &p.system_prompt {
            r.system_prompt = v.clone();
        }
        if let Some(v) = &p.output_style {
            r.output_style = v.clone();
        }
        for (k, v) in &p.tools.skill_overrides {
            match v {
                Some(x) => {
                    r.tools.skill_overrides.insert(k.clone(), *x);
                }
                None => {
                    r.tools.skill_overrides.remove(k);
                }
            }
        }
        for (k, on) in &p.tools.denied_mcp {
            let cur: BTreeSet<String> = r.tools.denied_mcp.iter().cloned().collect();
            let mut cur = cur;
            if *on {
                cur.insert(k.clone());
            } else {
                cur.remove(k);
            }
            r.tools.denied_mcp = cur.into_iter().collect();
        }
        r
    }

    /// 패치가 **실제로 지정한** 리프 경로 — 충돌 판정(§4.2-b)과 verdict 문구가 쓴다.
    pub fn touched(p: &RawIdentityPatch) -> Vec<IdentityField> {
        let mut v = vec![];
        use IdentityField as F;
        if p.engine.kind.is_some() {
            v.push(F::EngineKind);
        }
        if p.engine.model.is_some() {
            v.push(F::EngineModel);
        }
        if p.engine.effort.is_some() {
            v.push(F::EngineEffort);
        }
        if p.engine.codex_account.is_some() {
            v.push(F::EngineCodexAccount);
        }
        if p.engine.codex_tier.is_some() {
            v.push(F::EngineCodexTier);
        }
        if p.billing.kind.is_some() {
            v.push(F::BillingKind);
        }
        if p.billing.account.is_some() {
            v.push(F::BillingAccount);
        }
        if p.billing.drop_env_key.is_some() {
            v.push(F::BillingDropEnvKey);
        }
        if p.cwd.is_some() {
            v.push(F::Cwd);
        }
        if p.add_dirs.is_some() {
            v.push(F::AddDirs);
        }
        if p.mode.is_some() {
            v.push(F::Mode);
        }
        if p.system_prompt.is_some() {
            v.push(F::SystemPrompt);
        }
        if p.output_style.is_some() {
            v.push(F::OutputStyle);
        }
        if !p.tools.skill_overrides.is_empty() {
            v.push(F::ToolsSkillOverrides);
        }
        if !p.tools.denied_mcp.is_empty() {
            v.push(F::ToolsDeniedMcp);
        }
        v
    }
}

/// ★2026-09-05 — 속도 티어 정규화: 빈 문자열·`"default"`(app-server의 「표준」 표기)는 `None`.
/// 그래야 「표준으로 되돌림」이 렌더러 표기와 무관하게 한 값이고, 티어 없는 정체성의 해시가 안 흔들린다.
fn normalize_tier(t: Option<&str>) -> Option<String> {
    t.map(str::trim).filter(|t| !t.is_empty() && !t.eq_ignore_ascii_case("default")).map(str::to_string)
}

/// **정규화값**에서 리프 하나를 JSON 값으로 뽑는다 — `diff()`의 유일한 비교 근거.
fn norm_leaf_value(r: &RunIdentity, f: IdentityField) -> serde_json::Value {
    use serde_json::json;
    use IdentityField as F;
    let (kind, codex_account, codex_tier) = match &r.engine {
        EngineAxis::Claude { .. } => (EngineKind::Claude, None, None),
        EngineAxis::Codex { account, tier, .. } => (EngineKind::Codex, account.clone(), tier.clone()),
    };
    let (bkind, account, drop_env_key, key_fp) = match &r.billing {
        BillingAxis::Subscription {
            account,
            drop_env_key,
        } => (
            BillingKind::Subscription,
            Some(account.clone()),
            Some(*drop_env_key),
            None,
        ),
        BillingAxis::ApiKey { key_fp } => {
            (BillingKind::ApiKey, None, None, Some(key_fp.clone()))
        }
    };
    match f {
        F::EngineKind => json!(kind),
        F::EngineModel => json!(r.model()),
        F::EngineEffort => json!(r.effort()),
        F::EngineCodexAccount => json!(codex_account),
        F::EngineCodexTier => json!(codex_tier),
        F::BillingKind => json!(bkind),
        F::BillingAccount => json!(account),
        F::BillingDropEnvKey => json!(drop_env_key),
        F::BillingKeyFp => json!(key_fp),
        // ★3.0.5 — 재사용/재스폰 판정(P1b)은 **접힌 키**로 비교한다. `as_str`은 이제 원래
        // 대소문자라, 여기서 그걸 쓰면 같은 폴더를 다른 표기로 만난 것이 정체성 변화로 읽혀
        // 헛 재스폰이 난다(골든 `add_dirs_order_and_case_do_not_change_identity`가 잡는다).
        F::Cwd => json!(r.cwd.key()),
        F::AddDirs => json!(r
            .add_dirs
            .iter()
            .map(|p| p.key())
            .collect::<Vec<_>>()),
        F::Mode => json!(r.mode),
        F::SystemPrompt => json!(r.system_prompt),
        F::OutputStyle => json!(r.output_style.map(|s| s.as_str())),
        F::ToolsSkillOverrides => json!(r.tools.skill_overrides),
        F::ToolsDeniedMcp => json!(r.tools.denied_mcp),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RawIdentityPatch — 리프 단위 부분 패치 (★R3 N2)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EnginePatch {
    /// 지정하면 `model`을 반드시 함께 지정해야 한다(모델 id 공간이 갈린다).
    pub kind: Option<EngineKind>,
    pub model: Option<ModelId>,
    pub effort: Option<EffortId>,
    pub codex_account: Option<Option<String>>,
    /// ★2026-09-05 — `Some(None)` = 표준으로 되돌린다.
    pub codex_tier: Option<Option<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BillingPatch {
    pub kind: Option<BillingKind>,
    pub account: Option<AccountEmail>,
    pub drop_env_key: Option<bool>,
    // ★ key_fp는 여기 없다 — 저장된 키에서 정규화가 계산한다(키 원문이 계약면에 안 오른다).
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolPatch {
    /// `Some(None)` = 그 키를 지운다, `Some(Some(v))` = 그 키를 v로.
    pub skill_overrides: BTreeMap<SkillId, Option<SkillOverride>>,
    /// true = 차단, false = 해제.
    pub denied_mcp: BTreeMap<McpServerId, bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawIdentityPatch {
    pub engine: EnginePatch,
    pub billing: BillingPatch,
    pub cwd: Option<String>,
    /// 전체 교체(집합이라 서브필드가 없다).
    pub add_dirs: Option<Vec<String>>,
    pub mode: Option<ModeId>,
    /// `Some(None)` = 지우기.
    pub system_prompt: Option<Option<String>>,
    pub output_style: Option<Option<String>>,
    pub tools: ToolPatch,
}

impl RawIdentityPatch {
    /// **이 패치 타입이 주소를 가질 수 있는 리프.**
    ///
    /// 설계 §2.3의 골든 테스트는 `RawIdentityPatch::leaf_paths() == IdentityField::ALL`을
    /// 요구하지만, 같은 문서 §2.2가 `billing.keyFp`를 "패치로 줄 수 없다"고 못박는다 —
    /// 두 문장은 동시에 참일 수 없다. 여기서는 **후자를 계약으로 채택**했다
    /// (키 원문이 계약면에 오르지 않는다 = 지문은 파생값이다).
    /// 잠금은 "파생 리프를 뺀 나머지 전부"로 좁혀 유지한다 — 리프가 늘면 테스트가 깨진다.
    pub fn leaf_paths() -> Vec<&'static str> {
        IdentityField::ALL
            .iter()
            .filter(|f| !f.is_derived())
            .map(|f| f.path())
            .collect()
    }

    /// 리프 단위 last-write-wins 병합(§4.2-b). **전체 교체가 아니다.**
    pub fn merge_leaves_from(&mut self, other: RawIdentityPatch) {
        if other.engine.kind.is_some() {
            self.engine.kind = other.engine.kind;
        }
        if other.engine.model.is_some() {
            self.engine.model = other.engine.model;
        }
        if other.engine.effort.is_some() {
            self.engine.effort = other.engine.effort;
        }
        if other.engine.codex_account.is_some() {
            self.engine.codex_account = other.engine.codex_account;
        }
        if other.engine.codex_tier.is_some() {
            self.engine.codex_tier = other.engine.codex_tier;
        }
        if other.billing.kind.is_some() {
            self.billing.kind = other.billing.kind;
        }
        if other.billing.account.is_some() {
            self.billing.account = other.billing.account;
        }
        if other.billing.drop_env_key.is_some() {
            self.billing.drop_env_key = other.billing.drop_env_key;
        }
        if other.cwd.is_some() {
            self.cwd = other.cwd;
        }
        if other.add_dirs.is_some() {
            self.add_dirs = other.add_dirs;
        }
        if other.mode.is_some() {
            self.mode = other.mode;
        }
        if other.system_prompt.is_some() {
            self.system_prompt = other.system_prompt;
        }
        if other.output_style.is_some() {
            self.output_style = other.output_style;
        }
        for (k, v) in other.tools.skill_overrides {
            self.tools.skill_overrides.insert(k, v);
        }
        for (k, v) in other.tools.denied_mcp {
            self.tools.denied_mcp.insert(k, v);
        }
    }

    /// 폴백 우선 규칙이 이긴 리프를 패치에서 **뺀다**(§4.2-b 규약 2).
    pub fn clear_leaf(&mut self, f: IdentityField) {
        use IdentityField as F;
        match f {
            F::EngineKind => self.engine.kind = None,
            F::EngineModel => self.engine.model = None,
            F::EngineEffort => self.engine.effort = None,
            F::EngineCodexAccount => self.engine.codex_account = None,
            F::EngineCodexTier => self.engine.codex_tier = None,
            F::BillingKind => self.billing.kind = None,
            F::BillingAccount => self.billing.account = None,
            F::BillingDropEnvKey => self.billing.drop_env_key = None,
            F::BillingKeyFp => {}
            F::Cwd => self.cwd = None,
            F::AddDirs => self.add_dirs = None,
            F::Mode => self.mode = None,
            F::SystemPrompt => self.system_prompt = None,
            F::OutputStyle => self.output_style = None,
            F::ToolsSkillOverrides => self.tools.skill_overrides.clear(),
            F::ToolsDeniedMcp => self.tools.denied_mcp.clear(),
        }
    }

    pub fn is_empty(&self) -> bool {
        RawIdentity::touched(self).is_empty()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 리프/축
// ─────────────────────────────────────────────────────────────────────────────

/// 리프 경로 **15개**. UI 문구·정착 사유·드리프트 보고·재스폰 사유의 어휘.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentityField {
    EngineKind,
    EngineModel,
    EngineEffort,
    EngineCodexAccount,
    /// ★2026-09-05 — Codex 속도 티어(`engine.codexTier`).
    EngineCodexTier,
    BillingKind,
    BillingAccount,
    BillingDropEnvKey,
    BillingKeyFp,
    Cwd,
    AddDirs,
    Mode,
    SystemPrompt,
    OutputStyle,
    ToolsSkillOverrides,
    ToolsDeniedMcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentityAxis {
    Engine,
    Billing,
    Cwd,
    AddDirs,
    Mode,
    SystemPrompt,
    OutputStyle,
    Tools,
}

impl IdentityField {
    pub const ALL: [IdentityField; 16] = {
        use IdentityField::*;
        [
            EngineKind,
            EngineModel,
            EngineEffort,
            EngineCodexAccount,
            EngineCodexTier,
            BillingKind,
            BillingAccount,
            BillingDropEnvKey,
            BillingKeyFp,
            Cwd,
            AddDirs,
            Mode,
            SystemPrompt,
            OutputStyle,
            ToolsSkillOverrides,
            ToolsDeniedMcp,
        ]
    };

    pub fn path(self) -> &'static str {
        use IdentityField as F;
        match self {
            F::EngineKind => "engine.kind",
            F::EngineModel => "engine.model",
            F::EngineEffort => "engine.effort",
            F::EngineCodexAccount => "engine.codexAccount",
            F::EngineCodexTier => "engine.codexTier",
            F::BillingKind => "billing.kind",
            F::BillingAccount => "billing.account",
            F::BillingDropEnvKey => "billing.dropEnvKey",
            F::BillingKeyFp => "billing.keyFp",
            F::Cwd => "cwd",
            F::AddDirs => "addDirs",
            F::Mode => "mode",
            F::SystemPrompt => "systemPrompt",
            F::OutputStyle => "outputStyle",
            F::ToolsSkillOverrides => "tools.skillOverrides",
            F::ToolsDeniedMcp => "tools.deniedMcp",
        }
    }

    /// 파생 리프 = 사용자가 직접 지정할 수 없고 정규화가 계산하는 값.
    pub fn is_derived(self) -> bool {
        matches!(self, IdentityField::BillingKeyFp)
    }

    pub fn axis(self) -> IdentityAxis {
        use IdentityAxis as A;
        use IdentityField as F;
        match self {
            F::EngineKind | F::EngineModel | F::EngineEffort | F::EngineCodexAccount | F::EngineCodexTier => {
                A::Engine
            }
            F::BillingKind | F::BillingAccount | F::BillingDropEnvKey | F::BillingKeyFp => {
                A::Billing
            }
            F::Cwd => A::Cwd,
            F::AddDirs => A::AddDirs,
            F::Mode => A::Mode,
            F::SystemPrompt => A::SystemPrompt,
            F::OutputStyle => A::OutputStyle,
            F::ToolsSkillOverrides | F::ToolsDeniedMcp => A::Tools,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 기본값 / 오류
// ─────────────────────────────────────────────────────────────────────────────

/// cwd 존재 판정. 재생 하네스가 파일시스템에 의존하지 않게 **주입 가능**하게 둔다.
#[derive(Debug, Clone)]
pub enum CwdProbe {
    /// 실제 파일시스템(출하 경로).
    Fs,
    /// 무조건 존재(대부분의 재생 시나리오).
    AssumeExists,
    /// 이 집합에 있는 정규 경로만 존재(§4.2 `cwd_missing` 시나리오).
    Only(BTreeSet<String>),
}

impl CwdProbe {
    fn exists(&self, p: &CanonPath) -> bool {
        match self {
            CwdProbe::Fs => std::path::Path::new(p.as_str()).is_dir(),
            CwdProbe::AssumeExists => true,
            CwdProbe::Only(set) => set.contains(p.as_str()),
        }
    }
}

/// 앱이 아는 기본값 — 정규화의 두 번째 입력. `normalize()`가 미해석 값을 여기로 해석한다.
#[derive(Debug, Clone)]
pub struct IdentityDefaults {
    /// 빈 cwd의 대체(바탕화면 — `engine.ts:38-44` 파리티).
    pub default_cwd: String,
    /// `accounts.json.defaultEmail`.
    pub default_account: Option<AccountEmail>,
    /// 로그인된 계정 집합. 비어 있으면 검사하지 않는다(재생 기본값).
    pub known_accounts: BTreeSet<AccountEmail>,
    /// ★O4 — `codex-accounts.json.defaultEmail`. Anthropic 계정과 **다른 스토어**라
    /// 필드를 나눈다(같은 필드를 쓰면 "클로드 계정으로 Codex를 띄운다"가 된다).
    pub default_codex_account: Option<AccountEmail>,
    /// 등록된 OpenAI 계정 집합. 비어 있으면 검사하지 않는다.
    pub known_codex_accounts: BTreeSet<AccountEmail>,
    /// safeStorage에 저장된 API 키 **원문**(지문 계산에만 쓰고 밖으로 안 나간다).
    pub api_key: Option<String>,
    /// 전역 `ANTHROPIC_API_KEY` 존재 여부.
    pub env_api_key_present: bool,
    /// 그 키 지문에 저장된 "구독으로 돌린다" 답(`engine.ts:846-852` 파리티).
    pub env_key_answer: Option<bool>,
    pub cwd_probe: CwdProbe,
}

impl Default for IdentityDefaults {
    fn default() -> Self {
        IdentityDefaults {
            default_cwd: "C:\\ccg-fixture\\desktop".into(),
            default_account: None,
            known_accounts: BTreeSet::new(),
            default_codex_account: None,
            known_codex_accounts: BTreeSet::new(),
            api_key: None,
            env_api_key_present: false,
            env_key_answer: None,
            cwd_probe: CwdProbe::AssumeExists,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    CwdMissing(String),
    AccountUnavailable(String),
    ApiKeyMissing,
    EngineSwitchNeedsModel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityRejectReason {
    AccountUnavailable,
    ApiKeyMissing,
    CwdMissing,
    EngineUnavailable,
    ChatGone,
    EngineSwitchNeedsModel,
    NoPending,
    WrongCardKind,
}

impl IdentityError {
    pub fn reason(&self) -> IdentityRejectReason {
        match self {
            IdentityError::CwdMissing(_) => IdentityRejectReason::CwdMissing,
            IdentityError::AccountUnavailable(_) => IdentityRejectReason::AccountUnavailable,
            IdentityError::ApiKeyMissing => IdentityRejectReason::ApiKeyMissing,
            IdentityError::EngineSwitchNeedsModel => IdentityRejectReason::EngineSwitchNeedsModel,
        }
    }
    pub fn message(&self) -> String {
        match self {
            IdentityError::CwdMissing(p) => format!("폴더를 찾을 수 없어요: {p}"),
            IdentityError::AccountUnavailable(a) => {
                format!("그 계정으로 로그인되어 있지 않아요: {a}")
            }
            IdentityError::ApiKeyMissing => "저장된 API 키가 없어요".into(),
            IdentityError::EngineSwitchNeedsModel => "엔진을 바꿀 땐 모델도 골라 주세요".into(),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 예약(Staged) + 폴백 우선 규칙 (§4.2-b 규약 2)
// ─────────────────────────────────────────────────────────────────────────────

/// 폴백 신호 하나. 한 턴에 전환이 둘 이상일 수 있어 `ChatRuntime`은 이걸 **벡터**로 든다(N16).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FallbackArm {
    pub to_model: ModelId,
    pub via: FallbackVia,
    /// §4.2-b 규약 2의 순서 비교 기준.
    pub at_seq: FrameSeq,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackVia {
    Dialog,
    RefusalFrame,
    ModelDelta,
}

impl FallbackArm {
    /// 이 전환이 건드린 정체성 리프. 오늘은 항상 `['engine.model']`이다.
    pub fn touched_leaves(&self) -> &'static [IdentityField] {
        &[IdentityField::EngineModel]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyPolicy {
    Now,
    AfterTurn,
    AskIfCostly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingOp {
    Merge,
    Replace,
    Cancel,
}

/// 턴 끝에 착지할 예약분. **정체성 전체가 아니라 리프 패치**를 든다(§4.2-b).
#[derive(Debug, Clone)]
pub struct Staged {
    pub patch: RawIdentityPatch,
    /// 리프별 접수 순번 — 폴백과의 충돌 판정에 쓴다.
    pub touched_at: BTreeMap<IdentityField, FrameSeq>,
    /// 접수 시점 리비전 — 표시·진단용. 착지 계산에는 **쓰지 않는다**.
    pub base_revision: u32,
    /// 접수 시점 미리보기(컴포저 배지). 착지 계산에는 **쓰지 않는다**.
    pub preview: RunIdentity,
    pub policy: ApplyPolicy,
}

/// 착지 직전 계산. 반환 = (적용할 패치, 폴백에 밀려 버려진 리프).
///
/// - 패치 접수가 폴백보다 **앞서면 폴백이 이긴다**(사용자는 폴백 이전 세계를 보고 골랐다).
/// - 뒤면 **패치가 이긴다**(폴백을 보고도 바꾼 것이다).
/// - **리프가 안 겹치면 충돌 자체가 없다** — effort-only 패치는 폴백 model을 못 건드린다(N2 잠금).
pub fn resolve_fallback_conflicts(
    staged: &Staged,
    arms: &[FallbackArm],
) -> (RawIdentityPatch, Vec<IdentityField>) {
    let mut patch = staged.patch.clone();
    let mut kept = vec![];
    for arm in arms {
        for leaf in arm.touched_leaves() {
            if staged
                .touched_at
                .get(leaf)
                .is_some_and(|s| *s < arm.at_seq)
            {
                patch.clear_leaf(*leaf);
                if !kept.contains(leaf) {
                    kept.push(*leaf);
                }
            }
        }
    }
    (patch, kept)
}

#[cfg(test)]
mod canon_path_tests {
    use super::*;

    /// ★3.0.5 — `as_str`은 **원래 대소문자**(표시·스폰), 동일성은 접힌 키. 작업 폴더 이름이
    /// 소문자로 바뀌어 보이던 버그(2026-09-03 보고)의 회귀 못.
    #[test]
    fn canon_path_keeps_original_case_but_folds_identity() {
        let a = CanonPath::of("C:/Code/VoxArtDev/");
        // 표시·스폰용 — 원래 표기 유지(구분자·후행 슬래시만 정규화).
        assert_eq!(a.as_str(), "C:\\Code\\VoxArtDev");
        // 비교 키 — 접힘.
        assert_eq!(a.key(), "c:\\code\\voxartdev");

        let b = CanonPath::of("c:\\code\\voxartdev");
        // 대소문자만 다른 두 경로는 **같은 정체성**이다(P1b) — 헛 재스폰 금지.
        assert_eq!(a, b);
        assert_eq!({ let mut s=std::collections::hash_map::DefaultHasher::new(); std::hash::Hash::hash(&a,&mut s); std::hash::Hasher::finish(&s) },
                   { let mut s=std::collections::hash_map::DefaultHasher::new(); std::hash::Hash::hash(&b,&mut s); std::hash::Hasher::finish(&s) });
        // …하지만 표시는 각자의 원래 표기를 지킨다.
        assert_eq!(b.as_str(), "c:\\code\\voxartdev");
        // 직렬화(정체성 해시용)는 접힌 값 — 원래 대소문자에 흔들리지 않는다.
        assert_eq!(serde_json::to_value(&a).unwrap(), serde_json::json!("c:\\code\\voxartdev"));
    }
}

#[cfg(test)]
mod d17_tests {
    use super::*;

    /// ★D17 — `api_key` 정체성의 바이트가 **스토어(`ccg-store::raw_identity`)와 같아야** 한다.
    /// 크리틱의 독립 미러(`docs/critic/tools/critic-m2-migrate.mjs:57`)도 같은 모양을 낸다:
    /// `billing: api ? { kind: 'api_key' } : { kind:'subscription', account, dropEnvKey }`.
    /// 이 테스트가 붉어지면 **마이그레이션 1차 비교가 거짓 불일치를 낸다**(대화가 바뀐 것처럼 보인다).
    #[test]
    fn api_key_billing_serializes_without_null_leftovers() {
        let b = RawBilling {
            kind: BillingKind::ApiKey,
            account: None,
            drop_env_key: None,
        };
        assert_eq!(serde_json::to_string(&b).unwrap(), r#"{"kind":"api_key"}"#);

        // 구독은 두 키가 **항상** 있다(값이 없으면 null) — 스토어 to_raw_identity와 같은 모양.
        let s = RawBilling {
            kind: BillingKind::Subscription,
            account: None,
            drop_env_key: Some(false),
        };
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"kind":"subscription","account":null,"dropEnvKey":false}"#
        );

        // 역직렬화는 두 모양 다 읽는다(옛 파일에 null이 박혀 있어도 로드된다).
        let back: RawBilling = serde_json::from_str(r#"{"kind":"api_key","account":null,"dropEnvKey":null}"#).unwrap();
        assert_eq!(back, b);
        assert_eq!(serde_json::to_string(&back).unwrap(), r#"{"kind":"api_key"}"#);
    }
}
