## AgentCodeGUI 3.0.4

링크가 안 열리던 것, 재시작 뒤 내 메시지만 사라지던 것, 워크플로를 멈추거나 한도에 걸린 뒤 한참 굳던 것을 고쳤습니다.
3.0.x를 쓰고 있다면 앱 안에서 자동으로 이 업데이트를 받습니다.

**고친 것**

- **링크를 눌러도 브라우저가 안 열리던 문제.** 답변 속 마크다운 링크, 웹 검색 행을 펼쳤을 때의 페이지 목록, 설정의 로그인 링크가 눌러도 아무 일도 없었습니다. 2.6.2에서 링크를 OS 브라우저로 넘기던 자리가 3.0 재구축 때 빠져 있었습니다. 이제 외부 http(s) 링크는 기본 브라우저로 열리고, 앱 화면이 그 페이지로 바뀌는 일도 없습니다.
- **껐다 켜면 AI 답은 남고 내 메시지만 사라지던 문제.** 패널을 별도 창으로 띄워 대화하면, 메인 창의 그리드도 같은 대화를 몰래 따라 그리는데 그 사본에는 사용자 말풍선이 한 번도 오지 않았습니다(보낸 창이 직접 그리니 엔진이 에코를 생략했습니다). 저장은 그 사본이 이기므로 디스크에는 답만 남았습니다. 이제 엔진이 사용자 말풍선을 보낸 창만 빼고 같은 대화를 그리는 모든 창에 전달합니다.
- **워크플로를 중지하거나 한도에 걸리면 한참 「작업 중」으로 굳던 문제.** 턴을 중지하거나 한도로 턴이 죽어도 그 턴이 띄운 워크플로는 목록에 그대로 남아, 더는 진행 신호가 오지 않는데도 90초 리스가 다 흐를 때까지 화면이 「작업 중」이었습니다 — 그 뒤에야 「진행 상태를 알 수 없어 표시를 정리했어요」가 떴습니다. 이제 중지·한도로 끝난 턴의 워크플로·백그라운드 에이전트는 그 자리에서 정리되고, 한도 안내도 바로 섭니다.
- **한도 뒤 「\<synthetic\>으로 전환」 → 계정 전환 → 재개 턴이 죽던 꼬임.** CLI는 한도 에러 문장을 모델 이름이 `<synthetic>`인 합성 메시지로 보내는데, 앱이 이걸 모델 전환으로 읽어 대화의 모델을 그 이름으로 바꿔 버렸습니다. 그 뒤 계정을 갈아타고 이어서 보낸 턴은 「There's an issue with the selected model」로 죽었고, 이 값이 파일에도 저장돼 재시작해도 반복됐습니다. 이제 자리표시자 모델은 전환으로 치지 않고, 이미 오염된 대화는 열 때 기본 모델로 되돌립니다.
- **계정을 바꿔 보냈는데 답이 없다가 /clear 뒤에야 되던 문제.** 한도에 걸린 뒤 다른 계정을 골라 보내도, 화면의 한도 대기표가 옛 계정 채로 남아 새 전송을 붙들고 있었습니다. 이제 계정을 바꾸는 순간 그 대기표는 무효가 됩니다(엔진 쪽 규칙과 같습니다).
- **아직 아무 말도 안 한 채팅에서 계정을 골라도 경고 카드가 뜨던 문제.** 계정 전환 확인 카드는 「이 대화의 프롬프트 캐시가 새 계정에 없다」는 비용을 경고하는 것인데, 주고받은 것이 없는 채팅에도 떴습니다. 이제 대화가 시작된 채팅에서만 묻고, 빈 채팅에서는 바로 바뀝니다.

> **처음 설치할 때 파란 경고 창이 뜨면 — 정상입니다.** AgentCodeGUI3은 코드 서명 인증서를 쓰지 않습니다.
> 「**추가 정보**」 → 「**실행**」을 누르면 설치가 시작됩니다. 설치 위치는 `%LOCALAPPDATA%\AgentCodeGUI3`, 기존 2.6.2는 그대로 남습니다.

---

## AgentCodeGUI 3.0.4 (English)

Links now open, your own messages no longer vanish after a restart, and stopping a workflow or hitting the limit no longer freezes the chat.
If you are on 3.0.x, the app picks this update up on its own.

**Fixed**

- **Clicking a link did nothing.** Markdown links in replies, the page list under a web-search row, and the login link in Settings did not open. The piece that handed links to the OS browser in 2.6.2 was missing from the 3.0 rebuild. External http(s) links now open in your default browser, and the app never navigates away to the page.
- **After a restart the AI replies were there but your own messages were gone.** While a panel was popped out into its own window, the main-window grid kept a shadow copy of the same conversation — and that copy never received your bubbles (the sending window drew them itself, so the engine skipped the echo). The shadow copy wins on save, so only the replies reached disk. The engine now delivers your message to every window showing that chat except the one that sent it.
- **Stopping a workflow or hitting the limit left the chat stuck on "Working".** When a turn was interrupted or killed by the usage limit, the workflows it had started stayed in the list even though no progress could arrive, so the chat showed "Working" until their 90-second lease ran out — only then did "cleaned up the display" appear. Workflows and background agents of a turn that ended by interrupt or limit are now settled on the spot, and the limit notice shows immediately.
- **Limit → "switched to \<synthetic\>" → account switch → resumed turn died.** The CLI reports a limit error as a synthetic message whose model is `<synthetic>`; the app read that as a model fallback and rewrote the chat's model to that name. The account switch and resume that followed then failed with "There's an issue with the selected model", and because the value was persisted it repeated after restarts. Placeholder models are no longer treated as a switch, and an already-poisoned chat is repaired to the default model when loaded.
- **Sending on another account got no reply until /clear.** After a limit, picking a different account and sending still went nowhere: the on-screen limit hold was still keyed to the old account and kept the new send queued. Changing the account now voids that hold, matching the engine's rule.
- **Picking an account in an empty chat showed the warning card.** The switch-account confirmation warns that the new account has no prompt cache for this conversation — yet it appeared in chats with no messages at all. It now asks only once a chat has started; in an empty chat the account changes immediately.

> **A blue warning on first install is expected.** AgentCodeGUI3 is not code-signed.
> Click **More info** → **Run** to start the install. It installs to `%LOCALAPPDATA%\AgentCodeGUI3`; an existing 2.6.2 install is left untouched.
