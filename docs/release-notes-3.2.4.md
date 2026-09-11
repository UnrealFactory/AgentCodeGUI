## AgentCodeGUI 3.2.4

ChatGPT 구독을 바꾼 뒤에도 카드에 옛 플랜과 「초기화권 · 확인 불가」가 남던 문제를 고쳤습니다. 웹 구독을 확인하면 플랜·한도·초기화권을 현재 값으로 다시 맞춥니다.

- **ChatGPT 플랜과 초기화권을 새 구독으로 갱신** — 설정 → Account에서 웹 연결이나 새로고침으로 구독을 확인하면 Codex 로그인 토큰을 새로 받아 플랜, 한도, 초기화권을 다시 조회합니다. 초기화권 창의 새로고침도 같은 방식으로 최신 값을 가져옵니다.
- **조회 실패를 옛 플랜과 구분** — 한도 조회가 실패하면 로그인 때 저장한 플랜 대신 「ChatGPT 플랜 · 확인 불가」와 다시 확인 버튼을 표시합니다. 실패가 확정된 값처럼 보이지 않습니다.
- **Claude 플랜 이름도 현재 구독으로** — Claude 계정의 웹 구독을 확인하면 Anthropic 프로필에서 현재 구독 종류를 읽어 계정 카드의 플랜 이름을 갱신합니다. 한도 게이지는 이전과 같이 항상 서버 값을 보여줍니다.

구독 변경이 반영되지 않으면 설정 → Account에서 해당 계정의 새로고침을 눌러 주세요.

---

## AgentCodeGUI 3.2.4 (English)

Fixed account cards that kept showing the old ChatGPT plan and "Resets · unavailable" after a subscription change. Checking the web subscription now brings the plan, limits, and resets back in line with the current values.

- **ChatGPT plan and resets follow the new subscription** — Connecting or refreshing a web account in Settings → Account now renews the Codex sign-in token and re-reads the plan, limits, and resets. Refresh in the resets dialog uses the same path to fetch current values.
- **Failed checks are no longer shown as the old plan** — When a limits check fails, the card shows "ChatGPT plan · unavailable" with a Retry button instead of the plan saved at sign-in, so a failure never looks like a confirmed value.
- **Claude plan name reflects the current subscription** — Checking a Claude web subscription reads the current subscription type from the Anthropic profile and updates the plan name on the account card. Limit gauges continue to show live server values.

If a subscription change does not appear, press Refresh on that account in Settings → Account.
