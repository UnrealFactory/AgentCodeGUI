## AgentCodeGUI 3.0.1

3.0.0 첫 주에 들어온 보고 셋을 고쳤습니다 — 컨텍스트 게이지, 계정 선택, 멀티 패널 순서.
3.0.0을 쓰고 있다면 앱 안에서 자동으로 이 업데이트를 받습니다.

**고친 것**

- **컨텍스트 게이지가 대화 한 번에 100%로 튀던 문제.** 도구 호출이 이어진 턴의 결과 프레임은 호출마다 캐시 읽기를 다시 더한 턴 누적치인데, 그 값을 컨텍스트로 읽고 있었습니다. 2.6.2처럼 마지막 호출의 컨텍스트를 씁니다.
- **고른 계정이 정렬 뒤에 바뀌던 문제.** 맨 위 계정을 고르면 「맨 위를 따라감」으로 저장돼, 설정에서 계정을 정렬하면 그 채팅의 계정이 조용히 다른 계정으로 옮겨 갔습니다. 이제 고른 계정은 그 채팅에 고정됩니다. 실행 중인 채팅의 「현재」 표시는 목록 맨 위가 아니라 실제로 물고 있는 계정을 가리키고, 추가 채팅 창에서도 「현재」·「사용 중」 칩이 같이 보입니다.
- **멀티 패널 수를 줄였다 늘리면 1·2번이 밀리던 문제.** 줄일 때 포커스된 패널을 1번 자리에 끼워 넣어 나머지가 한 칸씩 밀렸습니다(4→2에서 3번에 포커스가 있으면 [3, 1], 다시 4로 가면 [3, 1, 2, 4]). 이제 접히게 된 포커스 패널은 보이는 마지막 자리로 오고 1‥N-1번은 그대로입니다. 헤더를 길게 눌러 옮길 때 리렌더 사이의 이벤트로 순서가 왕복하던 것도 막았습니다.

> **처음 설치할 때 파란 경고 창이 뜨면 — 정상입니다.** AgentCodeGUI3은 코드 서명 인증서를 쓰지 않습니다.
> 「**추가 정보**」 → 「**실행**」을 누르면 설치가 시작됩니다. 설치 위치는 `%LOCALAPPDATA%\AgentCodeGUI3`, 기존 2.6.2는 그대로 남습니다.

---

## AgentCodeGUI 3.0.1 (English)

Three fixes for the reports from 3.0.0's first week — the context gauge, account selection, and multi-panel order.
If you are on 3.0.0, the app picks this update up on its own.

**Fixed**

- **The context gauge jumped to 100% after a single exchange.** The result frame of a turn with several tool calls carries the turn's cumulative usage (cache reads are re-added on every call), and that value was being read as the context. It now uses the last call's context, as 2.6.2 did.
- **The account you picked changed after sorting.** Picking the top account was stored as "follow the top", so sorting accounts in Settings silently moved that chat to a different account. A picked account is now pinned to the chat. For a running chat, "Current" points at the account actually in use rather than the top of the list, and extra chat windows now show the "Current" and "In use" chips too.
- **Shrinking then growing the multi-panel count shifted panels 1 and 2.** Shrinking inserted the focused panel at slot 1 and pushed the rest down (4→2 with focus on panel 3 gave [3, 1]; back to 4 gave [3, 1, 2, 4]). A focused panel that would be folded now lands in the last visible slot, and slots 1‥N-1 stay put. Press-and-hold reordering no longer flips back and forth when events arrive between re-renders.

> **A blue warning on first install is expected.** AgentCodeGUI3 is not code-signed.
> Click "**More info**" → "**Run anyway**". It installs to `%LOCALAPPDATA%\AgentCodeGUI3`; an existing 2.6.2 is left untouched.
