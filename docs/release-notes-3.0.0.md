## AgentCodeGUI 3.0.0

엔진을 완전히 새로 개발했습니다 — Electron에서 **Tauri + Rust**로. 더 가볍고, 더 안정적으로.
2.6.2까지 137개 커밋으로 쌓인 앱을 3.0에서 426개 커밋으로 다시 지었습니다.

> **처음 실행할 때 파란 경고 창이 뜹니다 — 정상입니다.**
> AgentCodeGUI3은 코드 서명 인증서를 쓰지 않습니다(2.6.2도 마찬가지입니다).
> 처음 내려받아 실행하면 Windows가 「**Windows의 PC 보호**」 창을 띄웁니다.
> 1. 창 안의 「**추가 정보**」를 누르세요.
> 2. 나타나는 「**실행**」 버튼을 누르면 설치가 시작됩니다.
>
> 설치는 관리자 권한이 필요 없고(현재 사용자 전용), 설치 위치는 `%LOCALAPPDATA%\AgentCodeGUI3`입니다.
> 기존 2.6.2는 **지워지지 않고 그대로 남습니다** — 두 버전을 나란히 쓸 수 있습니다.
> 대화와 로그인은 3.0으로 넘어오지 않습니다(앱 홈이 `~/.agentcodegui3`로 분리) — 3.0에서 한 번 다시 로그인해 주세요.
> **2.6.x의 자동 업데이트로는 3.0을 받을 수 없습니다** — 이 페이지에서 내려받아 설치하세요.

**무엇이 달라졌나** (자세한 목록은 앱 첫 실행의 패치노트 카드)

- 설치 파일 157.5MB → 30.9MB, 설치 폴더 633.7MB → 139.4MB
- 창을 하나 더 열 때 110.7MB · 프로세스 1 → 19MB · 프로세스 0, 4패널 유휴 505MB → 256MB
- 화면(렌더러)이 죽어도 앱이 0.45초 만에 스스로 복구
- 첫 창 336ms → 290ms, 사용 가능 422ms → 373ms
- 채팅 엔진을 상주 CLI + 명시적 상태기계로 재설계 — 계정·모델·모드 전환이 꼬이지 않음
- 도구 행 클릭으로 요청·결과 전문 보기, MCP 도구는 「서버_도구」
- 멀티 패널마다 MCP & Skill 칩(엔진이 알려준 값, 켜고 끄기)
- 파일 뷰어 별도 OS 창(자리 기억, 다음 파일도 그 창)
- 한도 소진 시 두 갈래: 다른 계정으로 이어서(초기화 임박순) / 현재 계정으로 이어서(최대 2회)
- 멀티 패널 다이얼 1~6, 사이드바 2섹션, 알림 문법 통일
- TS/JS/Python 코드 분석 무설치 동작, C#/C++ 원클릭, 언어 서버 온디맨드
- Git 2,000파일 커밋, 휴지통 페일세이프, X = 트레이 숨김, 앱 내 자동 업데이트
- Fable 5.1 모델
- 제거: Verse 지원

---

## AgentCodeGUI 3.0.0 (English)

The engine was rebuilt from scratch — from Electron to **Tauri + Rust**. Lighter and more stable.
Everything up to 2.6.2 took 137 commits; 3.0 alone took 426.

> **A blue warning appears the first time you run it — this is expected.**
> AgentCodeGUI3 is not code-signed (neither was 2.6.2). When you download and run it,
> Windows shows a “**Windows protected your PC**” dialog.
> 1. Click “**More info**” in the dialog.
> 2. Click the “**Run anyway**” button that appears.
>
> The installer needs no administrator rights (current-user install) and installs to `%LOCALAPPDATA%\AgentCodeGUI3`.
> Your existing 2.6.2 is **left untouched** — the two versions run side by side.
> Chats and logins do not carry over (the app home moved to `~/.agentcodegui3`) — sign in once more in 3.0.
> **2.6.x auto-update cannot deliver 3.0** — download and install it from this page.

**What changed** (full list in the patch-notes card on first launch)

- Installer 157.5MB → 30.9MB, installed folder 633.7MB → 139.4MB
- One extra window: 110.7MB + 1 process → 19MB + 0 processes; 4-panel idle 505MB → 256MB
- The app recovers a dead view by itself in 0.45s
- First window 336ms → 290ms, usable 422ms → 373ms
- Chat engine rebuilt as a resident CLI + explicit state machine — account/model/mode switches no longer tangle
- Click a tool row for the full request/result; MCP tools named “server_tool”
- MCP & Skill chip per multi panel (engine-reported, toggle on/off)
- File viewer in its own OS window (remembers position; next file opens there)
- Two ways forward when a limit runs out: continue on another account (soonest reset first) / on this account (up to twice)
- Multi-panel dial 1–6, two-section sidebar, unified notices
- TS/JS/Python code intelligence with nothing to install, one-click C#/C++, on-demand language servers
- Git commits of 2,000 files, Recycle Bin fail-safe, X hides to tray, in-app auto-update
- Fable 5.1 model
- Removed: Verse support
