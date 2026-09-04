## AgentCodeGUI 3.0.6

채팅 안의 시스템 안내가 전부 노란 경고 하나였던 것을 주제별 색·아이콘·라벨로 나눴고, 한도 대기 상태줄도 같은 모양으로 맞췄습니다. 오류 카드의 [복사]와 「예약으로 넣었어요」 줄은 뺐습니다.
3.0.x를 쓰고 있다면 앱 안에서 자동으로 이 업데이트를 받습니다.

**바뀐 것**

- **시스템 안내가 전부 같은 노란 경고로 뜨던 것 — 주제별로 나눴습니다.** 한도 대기, 계정 자동 전환, 엔진 무응답, 프로세스 종료, 중지, 예약, 거절, CLI 경고까지 전부 노란 ⚠ 한 가지로 나와 노랑이 아무 뜻도 없었습니다. 이제 주제마다 색·아이콘·작은 라벨을 하나씩 줍니다 — 한도 대기(라임 · 모래시계), 한도 풀림(초록 · ▶), 계정(청록 · 사람), 모델(보라 · 반짝임), 수명(파랑 · 맥박: 무응답·빈 응답·유휴 정리), 종료·재시작(무채색), 중지(주황 · ■), 예약(남색 · 시계), 거절(빨강 · ⊘), CLI 원문(무채색 · 고정폭). 색이 낯선 동안은 라벨이 알려 줍니다. 노란 계열 자체도 어두운 바탕에서 머스터드로 읽혀 라임으로 바꿨습니다.
- **한도 대기 상태줄(입력창 위)도 같은 모양으로.** 입력창 위의 「사용 한도에 도달했어요 — 약 N분 뒤 자동으로 이어서 계속해요」 줄은 스레드 안내와 다른 앰버색 유리였습니다. 이제 같은 판 문법입니다 — 기다리는 중은 한도 색(라임 · 모래시계), 정말 풀렸을 때는 풀림 색(초록 · ▶), 자동 재개가 접힌 표는 한도 색 그대로에 [이어가기]만 붙습니다. 모델·계정 자동 전환 알림 줄도 스레드와 같은 색을 따릅니다.
- **오류 카드의 [복사] 버튼을 뺐습니다.** 원문 칸을 드래그해 복사하면 되는 자리라 버튼이 하나 더 있을 이유가 없었습니다. 8줄 넘는 원문을 펼치는 [전체 보기]는 그대로입니다.
- **「예약으로 넣었어요」 줄을 뺐습니다.** 답이 오는 중에 보낸 메시지는 입력창 아래 예약 목록에 바로 보이는데, 스레드에도 「예약으로 넣었어요 — 턴이 끝나면 바로 나가요」를 한 줄 더 썼습니다. 같은 사실을 두 곳에서 말하던 것이라 스레드 줄만 뺐습니다. 턴 중에 모델·계정 등을 바꿨을 때의 「설정을 예약했어요」는 목록에 안 보이므로 남깁니다.
- **이 업데이트 소식 카드의 버전 버튼을 10개까지.** 카드가 커진 뒤로 한 줄에 버전 알약이 12개까지 서는데 5개에서 잘랐습니다. 이제 최신 10개를 오갈 수 있습니다(두 자리 패치 번호가 섞여도 한 줄).

> **처음 설치할 때 파란 경고 창이 뜨면 — 정상입니다.** AgentCodeGUI3은 코드 서명 인증서를 쓰지 않습니다.
> 「**추가 정보**」 → 「**실행**」을 누르면 설치가 시작됩니다. 설치 위치는 `%LOCALAPPDATA%\AgentCodeGUI3`, 기존 2.6.2는 그대로 남습니다.

---

## AgentCodeGUI 3.0.6 (English)

System notices in the thread were all the same yellow warning; they are now split by topic with their own color, icon and label, and the limit-hold bar matches. The [Copy] pill on error cards and the "Queued instead" line are gone.
If you are on 3.0.x, the app picks this update up on its own.

**Changed**

- **Every system notice looked like the same yellow warning — now split by topic.** Limit holds, automatic account switches, engine timeouts, process exits, stops, scheduling, refusals and CLI warnings all came out as one yellow ⚠, so yellow meant nothing. Each topic now has its own color, icon and small label — limit hold (lime · hourglass), limit lifted (green · ▶), account (teal · person), model (violet · sparkle), watchdog (blue · pulse: no reply, empty reply, idle cleanup), exit / restart (neutral), stopped (orange · ■), scheduled (indigo · clock), refused (red · ⊘), CLI output (neutral · monospace). The label carries you until the colors are familiar. The old yellow itself read as mustard on the dark background, so it became lime.
- **The limit-hold bar above the composer now uses the same shape.** The "Usage limit reached — auto-continues in ~N min" bar above the composer was a separate amber glass strip. It now uses the same band grammar as thread notices — the limit color (lime · hourglass) while waiting, the lifted color (green · ▶) once the limit is really gone, and the limit color with just a [Continue] pill when auto-resume has paused. The model / account auto-switch bars follow the same colors as the thread.
- **Removed the [Copy] pill from error cards.** You can select the raw pane and copy it, so the extra button had no job. [Show all] for raw output longer than 8 lines stays.
- **Removed the "Queued instead" line.** A message sent while a reply is streaming already shows up in the queue list under the composer, and the thread repeated it as "Queued instead — goes out when the turn ends". Same fact in two places, so the thread line is gone. "Setting scheduled" (changing model or account mid-turn) stays, because the queue list does not show it.
- **This what's-new card keeps up to 10 versions.** The card fits 12 version pills per row since it grew, but the list was capped at 5. It now keeps the latest 10 (still one row even with two-digit patch numbers).

> **A blue warning on first install is expected.** AgentCodeGUI3 is not code-signed.
> Click **More info** → **Run** to start the install. It installs to `%LOCALAPPDATA%\AgentCodeGUI3`; an existing 2.6.2 install is left untouched.
