# Model selection investigation — 2026-09-05

The reported Codex warning corresponds to a real model change: the local rollout
records Astra before 21:54 KST and Sol for the turn starting at 21:54:58. The saved
picker identity remained Astra when inspected. No model-fallback card was found
in that conversation. The original application run request was not recorded, so
the exact trigger for that particular switch cannot be established from the
remaining evidence. The reported Claude picker change was not independently
confirmed in the saved conversations.

## Reproduced application defect

`hub::Op::Run` applies the request's picker through `Cmd::IdentitySet` and then
dispatches `Cmd::Send`. If a prior turn is active, the identity change is staged
until turn end. `Send` used the current identity, capturing the old model in the
new message. Applying the staged change afterward did not update that frozen
message. This could leave the selected identity and the actual execution model
different.

`Send` now snapshots the effective staged patch, using the same fallback conflict
rules as turn-end application. Older queue entries retain their own settings.

## Validation

- The regression failed before the fix: Astra was requested but the queued
  message contained Sol.
- Both Sol → Astra and Opus → Fable now reach the actual driver spawn arguments.
- An older queued message retains its earlier model and runs before the new one.
- Multiple staged changes are merged for the new send.
- A later fallback wins over an earlier staged selection; an explicit selection
  after the fallback wins again.
- `cargo test -p ccg-engine --tests --quiet`: 284 passed, 2 existing tests ignored.
- `cargo check -p agentcodegui --quiet`: passed.

Tests use local fake drivers and do not call model services or alter user chats.
