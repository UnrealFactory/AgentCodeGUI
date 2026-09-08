## AgentCodeGUI 3.1.3

Codex 대화에서도 `/btw`로 현재 맥락을 이어받은 질문 창을 열 수 있습니다. 대화를 연 뒤 추가하거나 삭제한 계정이 다음 전송에 바로 반영됩니다.

### 새 기능

- **Codex /btw 질문 창** — Codex 대화에서 `/btw 질문`을 입력하면 현재 대화를 분기한 별도 창이 열리고 첫 질문이 바로 전송됩니다. 본 작업은 계속 진행되고, 질문과 후속 답변은 별도 창에서 이어집니다. Claude Code와 Codex 모두 같은 방식으로 동작합니다.
- **원본 작업 목표를 이어받지 않음** — 분기된 질문 창은 원본 대화의 자동 진행 목표를 해제한 뒤 질문을 보냅니다. 분기가 실패하면 질문을 보내지 않고 오류로 표시하며, 다시 보내도 원본 대화에 이어쓰지 않고 새로 분기합니다. 준비 중 취소하면 늦게 도착한 응답은 무시합니다.

### 수정

- **열린 대화에 계정 변경 반영** — 대화를 연 뒤 계정을 추가하거나 삭제해도 다음 전송부터 바로 반영됩니다. 선택한 계정이나 폴더를 적용할 수 없으면 이전 계정이나 폴더로 보내지 않고 전송을 취소하며, 입력한 내용은 유지됩니다.
- **질문 창 안내 문구** — Codex에서 포크를 지원하지 않는다는 안내를 제거하고, 원본에 대화가 없거나 작업 폴더가 달라진 경우만 안내합니다.

---

## AgentCodeGUI 3.1.3 (English)

Codex chats can now open a `/btw` side window that inherits the current context. Accounts added or removed after a chat was opened apply to its next send.

### New

- **Codex /btw side questions** — Typing `/btw question` in a Codex chat opens a separate window forked from the current conversation and sends the question right away. The main task keeps running, and the question and follow-ups continue in the side window. Claude Code and Codex behave the same way.
- **No inherited task goal** — The forked window clears the original conversation’s automatic goal before sending. If forking fails, the question is not sent and an error is shown; sending again forks anew instead of appending to the original conversation. Late responses after cancelling during setup are ignored.

### Fixes

- **Account changes apply to open chats** — Accounts added or removed after a chat was opened take effect on its next send. If the selected account or folder cannot be applied, the send is cancelled instead of going out under the previous account or folder, and your input is kept.
- **Side window notice** — Removed the notice that Codex does not support forking. The notice now appears only when the original chat has no conversation yet or the working folder changed.
