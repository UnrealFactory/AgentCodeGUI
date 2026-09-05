## AgentCodeGUI 3.0.9

사용 한도 표시를 개선하고, Codex 모델·속도 선택과 Updates 페이지를 추가했습니다.

- **한도 초기화 후 표시 갱신** — 한도가 초기화된 뒤에도 0%로 남아 있던 표시를 수정했습니다. 초기화 시각에 다시 조회하고, 새 값을 기다리는 동안 확인 중으로 표시합니다.
- **한도 조회 재시도 개선** — 한도 조회가 제한되면 서버가 안내한 시간만큼 기다립니다. 반복 요청으로 갱신이 늦어지던 문제를 줄였습니다.
- **모델과 속도 선택** — GPT-6-Astra를 추가하고 이전 세대 모델 목록을 정리했습니다. 지원 모델에서 표준·Fast·Ultrafast 속도를 선택할 수 있습니다.
- **응답 표시 안정성 개선** — 실행 시작 신호를 놓쳤을 때 답변이 화면에 표시되지 않던 문제를 보완했습니다.
- **설정에 Updates 추가** — 설정에서 업데이트 확인·설치·재시작을 진행할 수 있습니다. 이미 확인한 패치노트도 다시 열 수 있습니다.

---

## AgentCodeGUI 3.0.9 (English)

Improves usage-limit displays and adds Codex model and speed choices plus an Updates page.

- **Refresh limits after reset** — Fixed limits remaining at 0% after a reset. The app checks again at the reset time and shows a checking state until the new value arrives.
- **Better usage-query retries** — When usage queries are rate-limited, the app waits for the time requested by the server. This reduces repeated requests that delay fresh values.
- **Model and speed choices** — Added GPT-6-Astra and cleaned up older model entries. Supported models offer Standard, Fast, or Ultrafast speed options.
- **More reliable reply display** — Improved reply handling when the initial run-start signal is missed.
- **Updates in Settings** — Check for updates, install, and restart from Settings. You can also reopen patch notes you have already read.
