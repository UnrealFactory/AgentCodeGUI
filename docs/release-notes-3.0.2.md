## AgentCodeGUI 3.0.2

3.0.1에 들어온 보고 넷을 고쳤습니다 — 업데이트 화면, Git 목록, 대화 비우기, 모델 전환 알림.
3.0.x를 쓰고 있다면 앱 안에서 자동으로 이 업데이트를 받습니다.

**고친 것**

- **업데이트 설치가 윈도우 기본 설치 마법사로 뜨던 문제.** 3.0은 설치기의 기본 진행 화면을 그대로 썼습니다 — 「뒤로/다음/취소」 단추와 압축 해제 경로가 흐르는 그 창입니다. 2.6.2처럼 조용히 설치하고, 그동안 앱의 스플래시(「새 버전으로 업데이트하는 중」)를 보여 준 뒤 설치가 끝나면 자동으로 다시 열립니다.
- **같은 저장소가 두 줄로 보이던 문제.** 폴더를 소문자 경로로 열었을 때(`c:\code\…`) Git이 알려 주는 실제 표기(`C:\Code\…`)와 글자가 달라, 같은 저장소를 서로 다른 두 곳으로 세어 탐색기 아래 「main」 줄이 두 번 그려졌습니다. 윈도우는 경로 대소문자를 가리지 않으므로 한 곳으로 셉니다.
- **대화를 비웠는데 지운 대화가 되살아나던 문제.** `/clear`는 화면만 비우고 엔진이 쥔 세션은 그대로였습니다. 그래서 다음 메시지가 방금 지운 대화를 이어받아, 지운 내용이 계속 쌓이고 「Continue from where you left off」가 되풀이됐습니다. 이제 대화를 비우면 엔진도 그 세션을 놓아 다음 메시지가 진짜 새 대화로 시작합니다. 폴더를 바꾼 뒤 첫 메시지도 같습니다.
- **「Opus 5 → Opus 5」처럼 같은 모델로 전환했다는 알림.** 모델이 한 번 자동 전환된 뒤(예: Fable 5.1 → Opus 5) 같은 모델의 전환 신호가 또 오면, 바뀐 것이 없는데도 「Opus 5가 거부해 Opus 5로 전환했어요」라는 알림이 떴습니다. 되돌리기 알약도 아무것도 되돌리지 않는 자리를 가리켰습니다. 이제 실제로 모델이 바뀔 때만 알립니다.

> **처음 설치할 때 파란 경고 창이 뜨면 — 정상입니다.** AgentCodeGUI3은 코드 서명 인증서를 쓰지 않습니다.
> 「**추가 정보**」 → 「**실행**」을 누르면 설치가 시작됩니다. 설치 위치는 `%LOCALAPPDATA%\AgentCodeGUI3`, 기존 2.6.2는 그대로 남습니다.

---

## AgentCodeGUI 3.0.2 (English)

Four fixes reported on 3.0.1 — the update screen, the Git list, clearing a chat, and model-switch notices.
If you are on 3.0.x, the app picks this update up on its own.

**Fixed**

- **Installing an update showed the standard Windows installer wizard.** 3.0 used the installer's default progress window — the one with Back/Next/Cancel and a stream of extraction paths. It now installs quietly as 2.6.2 did, showing the app's own splash ("Updating to the new version") while it runs, and reopens automatically when the install finishes.
- **The same repository appeared twice.** Opening a folder by a lower-case path (`c:\code\…`) spelled it differently from what Git reports (`C:\Code\…`), so one repository was counted as two and the "main" row was drawn twice under the explorer. Windows paths are case-insensitive, so they now count as one.
- **A cleared conversation came back.** `/clear` only emptied the screen — the engine kept the session. The next message therefore resumed the conversation you had just cleared, so the old turns kept piling up and "Continue from where you left off" was replayed. Clearing now releases the session on the engine too, so the next message really does start a new conversation. The same applies to the first message after changing folders.
- **A notice saying it switched from "Opus 5" to "Opus 5".** After the model had already switched once (say Fable 5.1 → Opus 5), another switch signal for the same model produced "Opus 5 refused, so the engine switched to Opus 5" — a switch that changed nothing, with an undo pill pointing at nothing. The notice now appears only when the model actually changes.

> **A blue warning on first install is expected.** AgentCodeGUI3 is not code-signed.
> Click "**More info**" → "**Run anyway**". It installs to `%LOCALAPPDATA%\AgentCodeGUI3`; an existing 2.6.2 is left untouched.
