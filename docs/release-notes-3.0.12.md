## AgentCodeGUI 3.0.12

모델을 바꾼 뒤 다음 메시지가 이전 모델로 실행될 수 있던 문제를 수정했습니다.

- **선택한 모델로 전송** — 이전 작업이 진행 중일 때 모델을 바꾸고 메시지를 보내면, 변경 적용을 기다리는 동안 메시지에 이전 모델이 저장되던 오류를 수정했습니다. Codex와 Claude 모두 적용됩니다.
- 기존 예약 메시지는 예약 당시 선택한 모델을 유지합니다.

---

## AgentCodeGUI 3.0.12 (English)

Fixed a case where the next message could run with the previous model after changing the selection.

- **Send with the selected model** — When a model change was deferred until the active turn finished, a new send could retain the previous model. Fixed for both Codex and Claude.
- Existing reservations keep the model selected when they were queued.
