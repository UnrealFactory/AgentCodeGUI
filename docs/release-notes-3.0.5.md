## AgentCodeGUI 3.0.5

AI가 「지난 질문에 답을 안 보냈다」며 같은 답을 되풀이하던 것, 「예약으로 넣었어요」가 계속 뜨던 것, 별도 창의 계정 표시와 「N번 자리」 번호를 고쳤습니다.
3.0.x를 쓰고 있다면 앱 안에서 자동으로 이 업데이트를 받습니다.

**고친 것**

- **AI가 「지난 질문에 답을 안 보냈다」며 밀린 답을 되풀이하던 문제.** 턴이 끝나는 순간 앱이 CLI를 바로 종료했는데, CLI는 마지막 답을 그 뒤에야 세션 파일에 적습니다. 그래서 파일에는 질문과 도구 호출만 남고 답은 빠졌고, 다음 턴이 그 파일로 이어지면 CLI가 「끊긴 턴」으로 보고 이어가기 문구를 끼워 넣었습니다. 모델의 눈에는 답 없이 끝난 질문이 쌓인 대화라 매 턴 「밀린 답」을 다시 썼습니다. 이제 턴이 끝나면 CLI가 스스로 정리하고 나갈 때까지 기다립니다(중지·무응답은 예전처럼 즉시 종료).
- **「예약으로 넣었어요」가 계속 뜨던 문제.** 답이 오는 중에 보낸 메시지는 예약이 되는데, 그 예약이 나갈 때 화면에 「턴 시작」이 전달되지 않아 엔진은 답을 쓰는데 화면은 유휴였습니다. 그 상태에서 또 보내면 또 예약 — 연쇄였습니다. 이제 예약된 메시지가 나가는 순간 화면도 작업 중으로 바뀌고, 거절된 전송이 다음 턴 표시를 삼키던 누수도 막았습니다. 그리고 중지가 예약된 메시지를 버릴 때(중지 = 뒤에 줄 선 것까지 취소) 지금까지는 말풍선만 남고 아무 말이 없었는데 — 「채팅이 씹힌」 것처럼 보이던 그 자리 — 이제 「예약된 메시지 N건은 보내지 않았어요」로 알립니다.
- **별도 창(팝아웃)에서 계정의 「현재」·「사용 중」이 안 보이던 문제.** 팝아웃 창은 다른 창들이 받는 계정 상태 표를 구독하지 않아, 「현재」가 목록 맨 위 계정으로 잘못 찍히고 다른 자리가 쓰는 계정의 「사용 중」 칩이 안 떴습니다. 이제 팝아웃 창도 같은 표를 받습니다.
- **「사용 중 · N번 자리」의 번호가 패널을 옮겨도 안 바뀌던 문제.** 번호를 슬롯의 고정 번호로 그려서, 패널을 드래그로 옮기면 화면의 1번이 칩에는 「3번 자리」였습니다. 이제 화면에 보이는 자리 순서로 세고, 옮기면 바로 갱신됩니다. 접힌 자리는 「접힌 자리」로 표시합니다.
- **/clear 뒤 첫 메시지가 씹히던 문제(Esc로 끊고 다시 보내면 되던 것).** /clear는 엔진에 「전부 중지」를 보내는데, 대화가 유휴면 「도는 실행이 없어요」로 거절만 되고 엔진 쪽 한도 대기표·예약은 그대로 남았습니다. 그 뒤 첫 전송은 「수락」으로 큐에 들어가되 닫힌 대기표 뒤에 조용히 주차돼 화면만 「작업 중」으로 굳었습니다. 이제 유휴에서도 /clear가 큐와 대기표를 비우고, 첫 전송이 바로 나갑니다.
- **작업 폴더 이름이 소문자로 바뀌어 보이던 문제.** `C:\Code\VoxArtDev` 같은 폴더가 대화를 한 번 돌린 뒤 `c:\code\voxartdev`로 소문자가 되어 보였습니다. 엔진이 폴더 경로를 정체성 비교용으로 소문자로 접으면서 그 접힌 값을 스폰 폴더·저장까지 그대로 썼기 때문입니다. 이제 원래 대소문자를 그대로 두고, 같은 폴더인지 판정할 때만 속으로 접습니다.
- **HTML 파일(index.html) 미리보기 위에 「AgentCodeGUI 시작하는 중」이 뜨던 문제.** 파일 뷰어로 `index.html`을 미리보면 그 페이지 위에 앱 시작 스플래시가 떠서 한동안 안 걷혔습니다. 앱이 창에 까는 부팅 스플래시 스크립트가 미리보기 iframe 안에서도 돌았고, 파일 이름이 `index.html`이라 화면 판정을 통과했습니다. 이제 스플래시는 앱의 최상위 창에서만 그려집니다.
- **턴마다 「[stderr] Warning: claude.ai MCP servers blocked by enterprise policy」 카드가 뜨던 것.** 설정에서 끈 claude.ai 커넥터(Gmail·Calendar·Drive)는 CLI에 「거부 목록」으로 전달되는데, CLI가 그걸 기업 정책으로 보고 매번 경고를 찍었고 앱은 그 줄을 스레드 카드로 그렸습니다. 직접 끈 것의 확인 문장이라 이제 그 경고 한 종류만 거릅니다. 다른 stderr 경고는 그대로 보입니다.
- **패널 여럿이 답을 쓸 때의 버벅임 일부.** 팝아웃 창마다 다른 패널의 토큰까지 전부 받아 버리던 것을 그 패널의 창에만 보내고, 한 틱에 온 토큰 조각은 합쳐 보내며, 자리 조회를 틱마다 하던 것을 줄였습니다. 스레드의 메시지가 토큰마다 다시 그려지던 자리 하나(알림 콜백)도 고쳤습니다.

> **처음 설치할 때 파란 경고 창이 뜨면 — 정상입니다.** AgentCodeGUI3은 코드 서명 인증서를 쓰지 않습니다.
> 「**추가 정보**」 → 「**실행**」을 누르면 설치가 시작됩니다. 설치 위치는 `%LOCALAPPDATA%\AgentCodeGUI3`, 기존 2.6.2는 그대로 남습니다.

---

## AgentCodeGUI 3.0.5 (English)

The AI no longer keeps "re-sending answers it never sent", the "Queued instead" card no longer loops, and popped-out windows show the right account and seat number.
If you are on 3.0.x, the app picks this update up on its own.

**Fixed**

- **The AI kept saying it had not answered earlier questions and re-sent them.** The app terminated the CLI the moment a turn ended, but the CLI writes the final reply to the session file only after that. The file kept the question and tool calls and lost the answer; the next turn resumed from that file, the CLI treated it as a cut-off turn and injected a continuation prompt. To the model the history looked like a pile of unanswered questions, so every turn it "re-sent the backlog". The app now waits for the CLI to finish and exit on its own after a turn (stop and hung processes are still killed immediately).
- **"Queued instead" kept appearing.** A message sent while a reply is streaming is queued — but when that queued message went out, the screen was never told a turn had started, so the engine was streaming while the UI showed idle. Sending again in that state queued again, and so on. The UI now switches to working the moment a queued message goes out, and a rejected send no longer swallows the next turn's start. And when Stop discards queued messages (Stop cancels everything lined up behind the turn), the thread used to keep the bubble and say nothing — the "my message got eaten" moment — it now says "N queued messages were not sent".
- **Popped-out windows did not show "Current" / "In use" for accounts.** A popped-out panel window never subscribed to the account-status table the other windows get, so "Current" pointed at the top account in the list and "In use" chips for other seats never appeared. Popped-out windows now receive the same table.
- **"In use · Slot N" did not follow panel reordering.** The number was the slot's fixed index, so after dragging panels around the first panel on screen could read "Slot 3". It now counts by the visible order and updates as soon as you move a panel; folded seats read "folded slot".
- **The first message after /clear got swallowed (Esc, then resend, worked).** /clear sends "stop everything" to the engine, but on an idle chat that was merely rejected as "nothing running", leaving the engine's limit hold and queue in place. The next send was then "accepted" into the queue and parked silently behind the closed hold while the screen showed "working". /clear now clears the queue and hold even when idle, so the first message goes straight out.
- **The working-folder name showed up lowercased.** A folder like `C:\Code\VoxArtDev` turned into `c:\code\voxartdev` once the conversation had run once. The engine folds the path to lowercase for identity comparison and was then using that folded value for the spawn folder and for storage. It now keeps the original case and only folds internally when deciding whether two folders are the same.
- **"AgentCodeGUI starting" appeared over an HTML (index.html) preview.** Previewing an `index.html` in the file viewer drew the app's startup splash on top of that page and left it there for a while. The boot-splash script the app injects into its window also ran inside the preview iframe, and the file being named `index.html` passed its screen check. The splash now draws only in the app's top-level window.
- **A "[stderr] Warning: claude.ai MCP servers blocked by enterprise policy" card on every turn.** The claude.ai connectors you turn off in Settings (Gmail, Calendar, Drive) reach the CLI as a deny list, which the CLI reports as an enterprise-policy warning on every spawn — and the app drew that line as a thread card. It only confirms what you switched off yourself, so that one warning is now filtered; other stderr warnings still show.
- **Some of the stutter while several panels stream.** Each popped-out window used to receive and discard every other panel's tokens; panel events now go only to the windows that draw that panel, token fragments arriving in the same tick are merged, the seat lookup runs once per tick instead of once per slot, and one per-token re-render of the whole thread (the notify callback) was fixed.

> **A blue warning on first install is expected.** AgentCodeGUI3 is not code-signed.
> Click **More info** → **Run** to start the install. It installs to `%LOCALAPPDATA%\AgentCodeGUI3`; an existing 2.6.2 install is left untouched.
