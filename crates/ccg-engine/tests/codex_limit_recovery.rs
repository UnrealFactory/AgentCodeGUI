use ccg_engine::clock::{Millis, VirtualClock, HOUR, SEC};
use ccg_engine::driver::{CliDriver, SpawnSpec};
use ccg_engine::identity::*;
use ccg_engine::limit::classify_limit_error_at;
use ccg_engine::runtime::{ChatRuntime, Cmd, ReloadHold};
use ccg_engine::event::Verdict;
use chrono::{Local, TimeZone};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::Arc;

#[derive(Default)]
struct Cli { alive: bool, accounts: Vec<Option<String>> }
impl CliDriver for Cli {
    fn spawn(&mut self, spec: &SpawnSpec) -> std::io::Result<()> {
        self.alive = true;
        self.accounts.push(spec.codex.as_ref().and_then(|p| p.account.clone()));
        Ok(())
    }
    fn send(&mut self, _: Value) {}
    fn close_input(&mut self) { self.alive = false; }
    fn kill(&mut self) { self.alive = false; }
    fn process_alive(&self) -> bool { self.alive }
    fn poll_frames(&mut self, _: Millis) -> Vec<Value> { vec![] }
}

fn rt(clock: Arc<VirtualClock>) -> ChatRuntime<Cli> {
    let raw = RawIdentity {
        engine: RawEngine { kind: EngineKind::Codex, model: "gpt-5.6-sol".into(), effort: EffortId::Low,
            codex_account: Some("limited@openai.test".into()), codex_tier: None },
        billing: RawBilling { kind: BillingKind::Subscription, account: Some("unrelated@claude.test".into()), drop_env_key: Some(false) },
        cwd: r"C:\ccg-fixture\work".into(), add_dirs: vec![], mode: ModeId::Normal,
        system_prompt: None, output_style: None, tools: RawTools::default(),
    };
    let defaults = IdentityDefaults {
        known_accounts: BTreeSet::from(["unrelated@claude.test".into()]),
        known_codex_accounts: BTreeSet::from(["limited@openai.test".into(), "ready@openai.test".into()]),
        ..Default::default()
    };
    ChatRuntime::new("codex-limit", raw, defaults, clock, Cli::default()).unwrap()
}

#[test]
fn codex_limit_message_keeps_the_explicit_reset_date_and_year() {
    let now = Local.with_ymd_and_hms(2026, 9, 9, 20, 47, 0).unwrap();
    let expected = Local.with_ymd_and_hms(2026, 9, 15, 10, 47, 0).unwrap().timestamp() as u64;
    let message = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 15th, 2026 10:47 AM.";
    let hit = classify_limit_error_at(message, now.timestamp_millis() as u64);
    assert!(hit.hit);
    assert_eq!(hit.resets_at, Some(expected));
}

#[test]
fn selecting_a_new_codex_account_cancels_the_old_hold_and_allows_the_first_message() {
    let clock = VirtualClock::new();
    clock.advance_to(SEC);
    let mut r = rt(clock.clone());
    r.reload_state(vec![], Some(ReloadHold { in_ms: Some(5 * HOUR), ..Default::default() }));
    let mut patch = RawIdentityPatch::default();
    patch.engine.codex_account = Some(Some("ready@openai.test".into()));
    assert_eq!(r.prepare_run_identity(patch), Verdict::Applied);
    assert!(r.hold().is_none(), "A GPT account change must invalidate the previous account's quota hold");
    r.dispatch(Cmd::Send { text: "Continue with the selected account".into() });
    assert_eq!(r.driver_ref().accounts, vec![Some("ready@openai.test".into())]);
    assert_eq!(r.queue_len(), 0);
}

#[test]
fn a_message_parked_behind_the_limit_uses_the_account_selected_to_resume_it() {
    let clock = VirtualClock::new();
    let mut r = rt(clock.clone());
    r.reload_state(vec![], Some(ReloadHold { in_ms: Some(5 * HOUR), ..Default::default() }));
    clock.advance_by(SEC);
    r.dispatch(Cmd::Send { text: "Continue this work".into() });
    assert_eq!(r.queue_len(), 1);
    assert!(r.driver_ref().accounts.is_empty());
    let mut patch = RawIdentityPatch::default();
    patch.engine.codex_account = Some(Some("ready@openai.test".into()));
    r.prepare_run_identity(patch);
    assert!(r.hold().is_none());
    assert_eq!(r.queue_len(), 0);
    assert_eq!(r.driver_ref().accounts, vec![Some("ready@openai.test".into())]);
}
