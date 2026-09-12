## AgentCodeGUI 3.2.5

채팅에서 글을 드래그할 때마다 뜨던 선택 툴바를 우클릭 전용으로 바꾸고, 해지된 ChatGPT 구독이 「구독 중」으로만 표시되던 문제를 고쳤습니다.

- **선택 툴바는 우클릭에서만** — 채팅 본문에서 글을 드래그해도 복사·더 자세히·번역 툴바가 바로 뜨지 않습니다. 선택한 글 위에서 우클릭하면 커서 위치에 툴바가 열립니다. Esc, 다른 곳 클릭, 스크롤로 닫히는 동작은 그대로입니다.
- **해지된 ChatGPT 구독의 종료일 표시** — 웹에서 해지해 남은 기간만 이용할 수 있는 ChatGPT 계정이 날짜 없이 「구독 중」으로 표시되던 문제를 고쳤습니다. 이제 「취소 예정」과 이용 종료일을 표시하며, 유예 기간이 더해진 만료일은 쓰지 않습니다.

구독 표시가 바뀌지 않으면 설정 → Account에서 해당 계정의 새로고침을 눌러 주세요.

---

## AgentCodeGUI 3.2.5 (English)

The chat selection toolbar now opens only on right-click instead of after every drag, and cancelled ChatGPT subscriptions no longer show as simply "Subscribed".

- **Selection toolbar on right-click only** — Dragging text in the chat thread no longer pops up the Copy, Tell me more, and Translate toolbar. Right-click the selected text to open it at the cursor. Esc, clicking elsewhere, and scrolling still dismiss it.
- **End date for cancelled ChatGPT subscriptions** — A ChatGPT account cancelled on the web, with access until the end of the period, showed "Subscribed" with no date. It now shows "Cancellation scheduled" with the last day of access, and never uses the expiry that includes grace time.

If the subscription display does not change, press Refresh on that account in Settings → Account.
