## AgentCodeGUI 3.0.7

채팅이 끝나는 순간 앱이 「응답 없음」으로 굳던 알림 창의 교착, 마켓플레이스 플러그인으로 설치한 스킬이 목록에 안 보이던 것, 사이드바 빈 곳을 가리키거나 눌러도 추가 채팅 줄이 잡히던 것, 한도에 걸렸을 때 「언제 풀리는지 알 수 없어」라고 하던 것을 고쳤습니다. MCP & Skill 목록에는 「로컬」·「전역」 알약이 생겼습니다.
3.0.x를 쓰고 있다면 앱 안에서 자동으로 이 업데이트를 받습니다.

**바뀐 것**

- **채팅이 끝나는 순간 앱이 「응답 없음」으로 굳던 것 — 알림 창의 스레드 교착.** 다른 창을 보고 있거나 앱이 뒤로 가 있을 때 채팅이 끝나면 화면 우하단에 알림 카드가 뜨는데, 그 카드 창을 만드는 코드가 백그라운드 스레드에서 창 스타일을 바꾸는 호출을 잠금을 쥔 채 불렀습니다. Windows는 그 호출을 창을 가진 UI 스레드에 넘겨 답을 기다리는데, 바로 그 순간 사용자가 창을 다시 클릭해 UI 스레드가 같은 잠금을 기다리면 둘이 서로를 영원히 기다립니다 — 키보드가 먼저 안 먹고, 이어서 창이 하얗게 되며 「응답 없음」이 됩니다. 사용자가 보내 준 정지 덤프에서 두 스레드의 자리를 확인했습니다. 이제 알림 창의 생성·파기·스타일 변경은 전부 UI 스레드에서만 하고 그 잠금은 없앴습니다. 트레이 메뉴 창의 같은 구조도 함께 고쳤습니다.
- **마켓플레이스 플러그인으로 설치한 스킬이 목록과 「/」 팔레트에 안 보이던 것.** PowerShell 등 CLI에서 `claude plugin install`로 넣은 플러그인의 스킬은 클로드 코드가 쓰는데, 앱은 `~/.claude/skills`와 프로젝트의 `.claude/skills` 두 곳만 훑어서 헤더의 「MCP & Skill」 목록에도 입력창의 「/」 팔레트에도 나오지 않았습니다(제보). 이제 클로드 코드의 설치 목록과 켬/끔 설정(프로젝트 설정 포함)을 읽어 켜진 플러그인의 스킬을 「플러그인」 배지로 함께 보여 주고, 클로드 코드가 부르는 이름 그대로 `/플러그인:스킬`로 넣어 줍니다. 플러그인 스킬은 클로드 코드가 앱의 끄기 설정을 받지 않으므로 스위치를 두지 않습니다.
- **MCP & Skill 목록에 「로컬」·「전역」 알약 — 이 폴더 것만, 전역 것만, 또는 둘 다.** 헤더의 「MCP & SKILL」 칩을 열면 「도구 환경」 제목 옆에 알약 두 개가 붙었습니다(계정 목록의 숨김 알약과 같은 모양). 「로컬」만 켜면 이 폴더의 것 — 프로젝트의 `.claude/skills` 스킬과 `.mcp.json` 서버 — 만, 「전역」만 켜면 개인·플러그인·내장 스킬과 `~/.claude.json` 서버만, 둘 다 켜면 전부 보입니다. MCP와 SKILL 두 섹션에 함께 걸리고, 섹션 머리의 수도 켜진 범위만 셉니다. 마지막 하나는 끌 수 없고, 선택은 기억됩니다. 제목 줄 오른쪽 끝에 있던 폴더 이름은 뺐습니다(옆 폴더 칩이 이미 말합니다).
- **사이드바 빈 곳에 마우스를 두면 추가 채팅 첫 줄이 켜지고, 아무 데나 눌러도 그 줄이 눌리던 것.** 추가 채팅 창이 떠 있으면 사이드바의 그 줄에 작은 「창」 칩이 붙는데, 그 칩의 CSS 클래스 이름이 앱 창 전체를 뜻하는 이름과 같아서 칩이 보이지 않게 사이드바 전체를 덮고 있었습니다. 그래서 목록 아래 빈 곳에 마우스를 두면 그 줄이 호버로 켜지고, 빈 곳이나 다른 줄을 눌러도 그 창이 앞으로 왔습니다(자동 숨김 사이드바에서 특히 잘 보였습니다). 칩의 클래스 이름을 바꿔 칩은 칩 크기만 차지합니다.
- **한도에 걸리면 「언제 풀리는지 알 수 없어」라고 하던 것 — CLI가 적어 준 시각을 이제 읽습니다.** 한도 오류 카드에는 `You've hit your session limit · resets 3:30pm (Asia/Seoul)`처럼 풀리는 시각이 버젓이 적혀 있는데, 앱은 옛 CLI가 붙이던 숫자 꼬리(`|1755150000`)만 알아서 요즘 문구에서는 시각을 못 읽고 「언제 풀리는지 알 수 없어 잠시 뒤 다시 확인할게요」로 빠졌습니다. 이제 `resets 3:30pm`·`3pm`·`Sep 8 at 3pm`·`in 1h 5m` 꼴을 이 기기 시각으로 읽어 「풀리는 시각에 맞춰 이어서 보낼게요」로 가고, 그 시각에 맞춰 자동 재개합니다. 시각이 정말 없는 문구만 종전처럼 되묻습니다.

> **처음 설치할 때 파란 경고 창이 뜨면 — 정상입니다.** AgentCodeGUI3은 코드 서명 인증서를 쓰지 않습니다.
> 「**추가 정보**」 → 「**실행**」을 누르면 설치가 시작됩니다. 설치 위치는 `%LOCALAPPDATA%\AgentCodeGUI3`, 기존 2.6.2는 그대로 남습니다.

---

## AgentCodeGUI 3.0.7 (English)

Fixes a deadlock in the toast window that froze the app the moment a chat finished, skills from marketplace plugins missing from the skill list, sidebar hovers and clicks on empty space landing on the chat-window row, and a usage-limit hold that said the reset time was unknown. The MCP & Skill list gains "Local" / "Global" pills.
If you are on 3.0.x, the app picks this update up on its own.

**Changed**

- **The app froze ("Not responding") the moment a chat finished — a deadlock in the toast window.** When a chat finishes while its window is not focused, a small toast card appears at the bottom right. The code that creates that card changed the window style from a background thread while holding a lock. Windows hands that call to the UI thread that owns the window and waits for the answer — and if at that very moment you click back into the app, the UI thread goes to wait for the same lock, and the two wait for each other forever: the keyboard stops first, then the window goes white and reads "Not responding". Both threads were found in a hang dump a user sent in. Creating, destroying and restyling the toast window now happens on the UI thread only, and the lock is gone. The tray menu window had the same shape and was fixed the same way.
- **Skills installed through marketplace plugins were missing from the list and the "/" palette.** Skills that come with a plugin installed from the CLI (`claude plugin install`) are used by Claude Code, but the app only scanned `~/.claude/skills` and the project's `.claude/skills`, so they never appeared in the header's "MCP & Skill" list or the composer's "/" palette (reported). The app now reads Claude Code's install registry and enabled-plugins settings (project settings included), lists the skills of enabled plugins with a "Plugin" badge, and inserts them under the name Claude Code uses, `/plugin:skill`. Plugin skills have no switch: Claude Code does not apply the app's off setting to them.
- **"Local" / "Global" pills on the MCP & Skill list — this folder only, global only, or both.** Open the "MCP & SKILL" chip in the header and two pills now sit next to the "Tool environment" title (same shape as the hide pills in the account list). With only Local on you see this folder's items — the project's `.claude/skills` skills and `.mcp.json` servers; with only Global on, personal, plugin and built-in skills and `~/.claude.json` servers; with both on, everything. The filter applies to both the MCP and SKILL sections, and the section counts follow it. The last pill cannot be turned off, and the choice is remembered. The folder name that sat at the right end of the title row is gone (the folder chip next door already says it).
- **Hovering empty sidebar space lit up the first chat-window row, and clicking anywhere hit it.** When a chat window is open, its sidebar row carries a small "win" chip. The chip's CSS class name was the same as the one that means the whole app window, so the chip invisibly covered the entire sidebar: hovering the empty area below the lists highlighted that row, and clicking empty space or other rows brought that window to the front (most visible with the auto-hiding sidebar). The chip now has its own class name and takes up only its own size.
- **A usage-limit hold said the reset time was unknown — it now reads the time the CLI prints.** The limit error card plainly shows the reset time, e.g. `You've hit your session limit · resets 3:30pm (Asia/Seoul)`, but the app only knew the numeric tail older CLIs appended (`|1755150000`), so on current wording it fell back to "can't tell when it resets — will check again shortly". It now reads `resets 3:30pm`, `3pm`, `Sep 8 at 3pm` and `in 1h 5m` in this machine's local time, says "will resume when it resets", and resumes on that schedule. Only wording with no time at all still falls back to re-checking.

> **A blue warning on first install is expected.** AgentCodeGUI3 is not code-signed.
> Click **More info** → **Run** to start the install. It installs to `%LOCALAPPDATA%\AgentCodeGUI3`; an existing 2.6.2 install is left untouched.
