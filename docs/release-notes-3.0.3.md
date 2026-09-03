## AgentCodeGUI 3.0.3

쓰다 보면 느려지다 「응답 없음」으로 멈추던 문제를 고쳤습니다 — 그리고 뷰어 등장 버벅임, 도구 행 툴팁.
3.0.x를 쓰고 있다면 앱 안에서 자동으로 이 업데이트를 받습니다.

**고친 것**

- **쓰다 보면 점점 느려지던 문제.** 답변이 흐르는 동안 엔진이 20ms마다, 열린 채팅마다 보드 파일을 디스크에서 다시 읽고 있었습니다(초당 수백 번). 화면 쪽도 글자가 올 때마다 대화 전체를 다시 훑고, 도구 하나가 끝날 때마다 그 묶음의 도구 행을 전부 다시 그렸습니다. 이제 보드는 바뀔 때만 읽고, 검사는 이번 턴만 보며, 도구 행은 바뀐 것만 다시 그립니다. 끝없이 자라던 기록(백그라운드 작업·stderr 알림·보낸 문장·모델 전환 이력)에도 상한을 두었습니다.
- **「응답 없음」으로 멈추던 문제.** 채팅·저장 요청이 엔진의 답을 최대 3초 기다리는데, 그 대기가 모든 창이 함께 쓰는 작은 작업자 풀에서 일어나 엔진이 잠깐 느려지면 모든 창의 요청이 같이 멈췄습니다. 전용 풀로 옮겼습니다. 답변 중 0.6초마다 돌던 대화 저장(대화 전체를 다시 직렬화)도 답변 중에는 2초 간격으로 늦췄습니다. 그래도 멈추면 원인을 남기도록, 화면이 6초 넘게 답이 없으면 앱 폴더에 `hang-*.dmp` 진단 파일을 자동으로 씁니다.
- **파일 뷰어·사이드바가 스르륵 뜰 때 버벅이던 문제.** 파일을 열면 내용이 등장 애니메이션 도중에 도착해, 구문 강조와 수천 줄 그리기가 애니메이션의 프레임을 먹었습니다 — 같은 파일을 다시 열면 캐시라 부드럽고, 처음 여는 큰 파일만 버벅이던 이유입니다. 이제 애니메이션이 끝난 뒤에 내용을 붙입니다. 자동 숨김 사이드바는 펼칠 때마다 다시 칠하던 그림자와 블러 레이어를 상주시켜 컴포지터만 움직입니다.
- **도구 행의 「결과 보기」 툴팁 제거.** Bash·Write·Web 같은 도구 행에 마우스를 올리면 뜨던 「결과 보기 / 파일 보기 / 찾은 페이지 보기」 툴팁을 뺐습니다. 호버 안내는 밑줄만 남고, 클릭 동작은 그대로입니다.

> **처음 설치할 때 파란 경고 창이 뜨면 — 정상입니다.** AgentCodeGUI3은 코드 서명 인증서를 쓰지 않습니다.
> 「**추가 정보**」 → 「**실행**」을 누르면 설치가 시작됩니다. 설치 위치는 `%LOCALAPPDATA%\AgentCodeGUI3`, 기존 2.6.2는 그대로 남습니다.

---

## AgentCodeGUI 3.0.3 (English)

Fixed the slowdown that ended in "Not responding" — plus the stuttering viewer entrance and the tool-row tooltips.
If you are on 3.0.x, the app picks this update up on its own.

**Fixed**

- **The app got slower the longer you used it.** While a reply streamed, the engine re-read the board files from disk every 20 ms, for every open chat (hundreds of reads per second). The UI also rescanned the whole conversation on every token and redrew every tool row in a group each time one tool finished. Boards are now read only when they change, the check looks at the current turn only, and only changed rows redraw. Records that grew without bound (background tasks, stderr notices, sent prompts, model-switch history) are now capped.
- **The app froze with "Not responding".** Chat and save requests wait up to 3 seconds for the engine, and that wait ran on the small worker pool every window shares — so a brief engine stall froze every window's requests at once. They now run on a dedicated pool. The conversation save that fired every 0.6 s during a reply (re-serialising the whole chat) now waits 2 s while a reply is streaming. Should the UI still stall for more than 6 seconds, the app writes a `hang-*.dmp` diagnostic file into its home folder.
- **The file viewer and sidebar stuttered while sliding in.** File contents arrived in the middle of the entrance animation, so syntax highlighting and thousands of rows ate the animation's frames — which is why reopening the same file (cached) was smooth and only the first open of a big file stuttered. Contents now mount after the animation ends. The auto-hide sidebar keeps its shadow and blur layer resident instead of repainting them on every reveal.
- **Removed the "View output" tooltip on tool rows.** The "View output / View file / View found pages" tooltip that appeared when hovering Bash, Write or Web rows is gone. Hover shows the underline only; clicking works as before.

> **A blue warning on first install is expected.** AgentCodeGUI3 is not code-signed.
> Click "**More info**" → "**Run anyway**". It installs to `%LOCALAPPDATA%\AgentCodeGUI3`; an existing 2.6.2 is left untouched.
