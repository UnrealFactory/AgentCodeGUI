//! 와이어 프레임 → 상태기계가 아는 모양으로. (`docs/protocol-claude-cli.md` §5)
//!
//! 규약 둘:
//! 1. **모르는 프레임에 죽지 않는다**(§5.16 · 불변식 10) — [`Frame::Unknown`]으로 떨어뜨린다.
//! 2. `tool_name`/`input`/`tool_use_id` 외 전부 `Option`이다 —
//!    `can_use_tool` 페이로드가 최소 7키라는 것이 실측이다(`docs/critic/m3-poc.md` §2.3).

use crate::live::AskKind;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskEntry {
    pub task_id: String,
    pub task_type: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    ControlResponse {
        request_id: String,
        ok: bool,
        /// `initialize` 재전송(능동 프로브 ⑥)의 응답인지 식별하려면 우리가 보낸 id를 봐야 한다.
        payload_has_tasks: bool,
    },
    ControlRequest {
        request_id: String,
        subtype: String,
        tool_name: Option<String>,
        tool_use_id: Option<String>,
        dialog_kind: Option<String>,
        description: Option<String>,
        /// `request_user_dialog`의 `payload.fallbackModel`(있을 때만 — §4.4b).
        fallback_model: Option<String>,
    },
    ControlCancel {
        request_id: String,
    },
    SystemInit {
        session_id: String,
        model: Option<String>,
    },
    SystemStatus {
        status: String,
    },
    StreamEvent {
        sidechain: bool,
        kind: String,
        delta_kind: Option<String>,
    },
    Assistant {
        sidechain: bool,
        model: Option<String>,
        has_text: bool,
        tool_uses: Vec<(String, String)>,
        usage_tokens: Option<u64>,
    },
    User {
        sidechain: bool,
        tool_results: Vec<String>,
        /// `<task-notification>`이 실린 배달 — T12 재주입 판정의 재료(F12).
        task_notifications: Vec<String>,
        text: Option<String>,
    },
    Result {
        is_error: bool,
        subtype: String,
        terminal_reason: Option<String>,
        text: Option<String>,
        error_text: Option<String>,
    },
    CompactBoundary {
        trigger: String,
        pre_tokens: Option<u64>,
    },
    ModelRefusalFallback {
        fallback_model: String,
    },
    Notification {
        text: String,
    },
    BackgroundTasksChanged {
        tasks: Vec<TaskEntry>,
    },
    TaskProgress {
        task_id: String,
        has_workflow: bool,
        label: Option<String>,
    },
    TaskStarted {
        task_id: String,
        tool_use_id: Option<String>,
    },
    TaskNotification {
        task_id: String,
        tool_use_id: Option<String>,
        status: String,
        by_user: bool,
    },
    RateLimit {
        blocked: bool,
        resets_at: Option<u64>,
    },
    /// ★3.0.8 — `system/api_retry`: CLI가 API 오류(과부하 529 · 5xx · 429 · 연결 실패)를 **스스로
    /// 재시도하며 기다리는 중**이라는 진행 신호(SDK `SDKAPIRetryMessage` · CLI 2.1.260 실측
    /// `{attempt, max_retries, retry_delay_ms, error_status, error}`). 상태·원장 무영향 — 표시
    /// 전용이라 셸(`wire.rs`)이 옮기고 상태기계는 `SystemStatus`처럼 흘려보낸다.
    /// 3.0.7까지는 F21(미지)로 버려져 몇 분의 재시도 대기가 화면에서 **침묵**이었다.
    /// `error_status`는 HTTP 상태이고 연결 실패는 `None`이다(지어내지 않는다).
    ApiRetry {
        attempt: u64,
        max_retries: u64,
        retry_delay_ms: u64,
        error_status: Option<u64>,
        error: String,
    },
    /// 미지 `type`/`subtype` — 조용히 버린다(F21).
    Unknown,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string())
}

impl Frame {
    pub fn parse(v: &Value) -> Frame {
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let sub = v.get("subtype").and_then(|x| x.as_str()).unwrap_or("");
        let sidechain = v
            .get("parent_tool_use_id")
            .map(|x| !x.is_null())
            .unwrap_or(false);
        match ty {
            "control_response" => {
                let r = &v["response"];
                Frame::ControlResponse {
                    request_id: s(r, "request_id").unwrap_or_default(),
                    ok: r.get("subtype").and_then(|x| x.as_str()) == Some("success"),
                    payload_has_tasks: r
                        .get("response")
                        .map(|p| p.get("background_tasks").is_some())
                        .unwrap_or(false),
                }
            }
            "control_request" => {
                let r = &v["request"];
                Frame::ControlRequest {
                    request_id: s(v, "request_id").unwrap_or_default(),
                    subtype: s(r, "subtype").unwrap_or_default(),
                    tool_name: s(r, "tool_name"),
                    tool_use_id: s(r, "tool_use_id"),
                    dialog_kind: s(r, "dialog_kind").or_else(|| s(r, "kind")),
                    description: s(r, "description"),
                    fallback_model: s(&r["payload"], "fallbackModel")
                        .or_else(|| s(&r["payload"], "fallback_model")),
                }
            }
            "control_cancel_request" => Frame::ControlCancel {
                request_id: s(v, "request_id").unwrap_or_default(),
            },
            "stream_event" => Frame::StreamEvent {
                sidechain,
                kind: s(&v["event"], "type").unwrap_or_default(),
                delta_kind: s(&v["event"]["delta"], "type"),
            },
            "assistant" => {
                let msg = &v["message"];
                let mut has_text = false;
                let mut tool_uses = vec![];
                if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
                    for b in blocks {
                        match b.get("type").and_then(|x| x.as_str()) {
                            Some("text") => has_text = true,
                            Some("tool_use") => tool_uses.push((
                                s(b, "id").unwrap_or_default(),
                                s(b, "name").unwrap_or_default(),
                            )),
                            _ => {}
                        }
                    }
                }
                Frame::Assistant {
                    sidechain,
                    model: s(msg, "model"),
                    has_text,
                    tool_uses,
                    usage_tokens: msg["usage"]["input_tokens"].as_u64(),
                }
            }
            "user" => {
                let msg = &v["message"];
                let mut tool_results = vec![];
                let mut text = None;
                let mut notifs = vec![];
                if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
                    for b in blocks {
                        match b.get("type").and_then(|x| x.as_str()) {
                            Some("tool_result") => {
                                tool_results.push(s(b, "tool_use_id").unwrap_or_default())
                            }
                            Some("text") => {
                                let t = s(b, "text").unwrap_or_default();
                                // 여는 태그에 속성이 붙는다(`<task-notification task_id="…">`) —
                                // 닫힌 형태로만 찾으면 통지가 통째로 안 잡힌다.
                                if t.contains("<task-notification") {
                                    // `task_id="…"` 또는 첫 토큰을 id로 삼는다(합성 픽스처 규약).
                                    for part in t.split("task_id=\"").skip(1) {
                                        if let Some(end) = part.find('"') {
                                            notifs.push(part[..end].to_string());
                                        }
                                    }
                                }
                                text = Some(t);
                            }
                            _ => {}
                        }
                    }
                } else if let Some(t) = msg.get("content").and_then(|c| c.as_str()) {
                    text = Some(t.to_string());
                }
                Frame::User {
                    sidechain,
                    tool_results,
                    task_notifications: notifs,
                    text,
                }
            }
            "result" => Frame::Result {
                is_error: v["is_error"].as_bool().unwrap_or(false),
                subtype: sub.to_string(),
                terminal_reason: s(v, "terminal_reason"),
                text: s(v, "result"),
                error_text: s(v, "error").or_else(|| s(v, "result")),
            },
            "rate_limit_event" => {
                let info = &v["rate_limit_info"];
                Frame::RateLimit {
                    blocked: info.get("status").and_then(|x| x.as_str()) == Some("blocked"),
                    resets_at: info["resetsAt"].as_u64(),
                }
            }
            "system" => match sub {
                "init" => Frame::SystemInit {
                    session_id: s(v, "session_id").unwrap_or_default(),
                    model: s(v, "model"),
                },
                "status" => Frame::SystemStatus {
                    status: s(v, "status").unwrap_or_default(),
                },
                "compact_boundary" => Frame::CompactBoundary {
                    trigger: s(&v["compact_metadata"], "trigger")
                        .or_else(|| s(v, "trigger"))
                        .unwrap_or_else(|| "auto".into()),
                    pre_tokens: v["compact_metadata"]["pre_tokens"].as_u64(),
                },
                "model_refusal_fallback" => Frame::ModelRefusalFallback {
                    fallback_model: s(v, "fallback_model").unwrap_or_default(),
                },
                "api_retry" => Frame::ApiRetry {
                    attempt: v["attempt"].as_u64().unwrap_or(0),
                    max_retries: v["max_retries"].as_u64().unwrap_or(0),
                    retry_delay_ms: v["retry_delay_ms"].as_u64().unwrap_or(0),
                    error_status: v["error_status"].as_u64(),
                    error: s(v, "error").unwrap_or_default(),
                },
                "notification" | "informational" => Frame::Notification {
                    text: s(v, "text")
                        .or_else(|| s(v, "message"))
                        .unwrap_or_default(),
                },
                "background_tasks_changed" => Frame::BackgroundTasksChanged {
                    tasks: v["tasks"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|t| TaskEntry {
                                    task_id: s(t, "task_id").unwrap_or_default(),
                                    task_type: s(t, "task_type").unwrap_or_default(),
                                    description: s(t, "description").unwrap_or_default(),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                },
                "task_progress" => Frame::TaskProgress {
                    task_id: s(v, "task_id").unwrap_or_default(),
                    has_workflow: v
                        .get("workflow_progress")
                        .map(|w| w.is_array())
                        .unwrap_or(false),
                    label: s(v, "description"),
                },
                "task_started" => Frame::TaskStarted {
                    task_id: s(v, "task_id").unwrap_or_default(),
                    tool_use_id: s(v, "tool_use_id"),
                },
                "task_notification" => Frame::TaskNotification {
                    task_id: s(v, "task_id").unwrap_or_default(),
                    tool_use_id: s(v, "tool_use_id"),
                    status: s(v, "status").unwrap_or_default(),
                    by_user: v["by_user"].as_bool().unwrap_or(false)
                        || s(v, "status").as_deref() == Some("stopped")
                            && v["stopped_by_user"].as_bool().unwrap_or(false),
                },
                _ => Frame::Unknown,
            },
            _ => Frame::Unknown,
        }
    }
}

/// F13의 `task_type` 3분류(`/workflow/i` → Workflow, `/bash|shell/i` → BgShell, 그 외 BgAgent).
pub fn classify_task_type(t: &str) -> crate::live::LiveKind {
    let l = t.to_lowercase();
    if l.contains("workflow") {
        crate::live::LiveKind::Workflow
    } else if l.contains("bash") || l.contains("shell") {
        crate::live::LiveKind::BgShell
    } else {
        crate::live::LiveKind::BgAgent
    }
}

/// `can_use_tool`의 종류 판별 — `AskUserQuestion`만 질문 카드다(§3.6 ★R3 추가 2).
pub fn ask_kind_of(subtype: &str, tool_name: Option<&str>) -> Option<AskKind> {
    match subtype {
        "can_use_tool" => Some(if tool_name == Some("AskUserQuestion") {
            AskKind::Question
        } else {
            AskKind::Permission
        }),
        "request_user_dialog" => Some(AskKind::Dialog),
        _ => None,
    }
}

/// 2.6.2 `classifyLimitError`(`limitResume.ts:38`)의 Rust 이식 — 한도 장전 **2순위 근거**.
/// 1순위(`rate_limit_event{status:"blocked"}`)는 아직 **아무도 관측한 적이 없다**(O14).
///
/// ★R5 — 본체는 [`crate::limit`]로 옮겼다. 여기 있던 판이 2.6.2보다 관대해
/// 2.6.2 자기 코퍼스 18종에서 **오탐 3건**을 냈다(R14 확인 크리틱 F1: `context limit
/// reached…` · `output token limit exceeded` · `rate limited; retry shortly`). 원인은
/// 원본의 오탐 차단벽(`/context|token|output|length/`)이 이식에서 빠지고 원본이 일부러
/// 뺀 `rate limit`이 더해진 것 — 원본과 나란히 놓고 세는 자리가 없어서 안 보였다.
/// 이 두 줄은 호출부 호환을 위한 얼굴이고, 판정과 그 근거는 전부 `limit.rs`에 있다.
pub use crate::limit::{classify_limit_error, is_limit_error};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// ★3.0.8 — `system/api_retry`는 미지 프레임이 아니다(2026-09-04 보고: 간단한 질문이 6분
    /// 38초 동안 아무 표시 없이 「작업 중」 — CLI는 과부하를 스스로 재시도하고 있었다).
    #[test]
    fn api_retry_is_a_known_frame() {
        let f = Frame::parse(&json!({
            "type": "system", "subtype": "api_retry", "attempt": 3, "max_retries": 10,
            "retry_delay_ms": 42000, "error_status": 529, "error": "overloaded",
            "uuid": "u", "session_id": "S1"
        }));
        assert_eq!(
            f,
            Frame::ApiRetry { attempt: 3, max_retries: 10, retry_delay_ms: 42000, error_status: Some(529), error: "overloaded".into() }
        );
        // 연결 실패는 HTTP 상태가 없다.
        let g = Frame::parse(&json!({ "type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 10,
                                      "retry_delay_ms": 500, "error_status": null, "error": "unknown" }));
        assert!(matches!(g, Frame::ApiRetry { error_status: None, attempt: 1, .. }));
    }
}
