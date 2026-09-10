## AgentCodeGUI 3.2.1

외부 도구의 선택 내용과 상태를 대화에 연결할 수 있습니다. 대화 기록은 더 빠르게 켜고 끄며, 긴 기록 탐색과 파일 보관, 세션 ZIP 이동도 개선했습니다.

- **외부 도구를 대화에 연결** — 편집기·표 등 연동 도구의 선택 내용과 상태를 대화에 포함할 수 있습니다. 도구 이름과 아이콘으로 연결 상태를 확인하고 필요한 도구를 선택합니다.
- **같은 도구를 여러 세션에서 사용** — 하나의 외부 도구를 여러 채팅과 패널에 동시에 연결할 수 있습니다. 연결 ON/OFF, 다음 메시지 포함 여부와 연결 해제는 세션별로 독립적입니다.
- **전송 시점의 도구 내용을 보관** — 메시지를 보내거나 예약할 때 선택 내용과 도구 상태의 사본을 첨부합니다. 이후 도구 내용이 바뀌어도 이미 보낸 첨부는 바뀌지 않습니다.
- **선택 내용과 전송 첨부를 간결하게** — 입력창에 도구명과 선택 제목을 함께 표시하고 다음 메시지 포함 여부를 스위치로 바꿨습니다. 전환 중 깜빡임을 줄이고, 보낸 도구 첨부는 각각 또는 여러 개를 함께 펼쳐 확인할 수 있습니다.
- **개발 AI에게 연동 지침 전달** — 설정의 External Tools에서 한국어·영어 연동 지침을 복사할 수 있습니다. 규격과 연결 코드, 실행 예제를 함께 제공해 다른 도구의 연동을 개발 AI에게 요청하기 쉬워졌습니다.
- **세션 헤더 메뉴 동작 통일** — MCP & SKILL과 외부 도구 메뉴의 위치와 닫기 동작을 통일했습니다. 메뉴가 패널 경계에 잘리는 문제를 줄이고 바깥 클릭·Escape·다른 메뉴 열기에 맞춰 닫힙니다.
- **긴 기록도 아래로 계속 읽기** — 다음 버튼 대신 아래로 스크롤하면 기록을 이어서 불러옵니다. 화면 주변과 필요한 본문만 표시해 긴 기록의 부담을 줄이고, 위로 돌아왔을 때 펼친 상태와 스크롤 위치를 유지합니다.
- **파일 기록에 가려지던 대화 표시 수정** — 자동 파일 원본·변경 보관 항목을 대화 목록에서 숨겨 메시지와 실제 도구 작업에 집중할 수 있습니다. 파일 보관 기록이 많으면 저장된 대화가 보이지 않던 문제도 수정했습니다. 파일 사본은 계속 보존합니다.
- **빠르게 반응하는 기록 ON/OFF** — 헤더는 ON/OFF만 표시하고 클릭에 바로 반응합니다. 처리 중 다시 눌러도 마지막 선택을 반영하며, 대화 기록은 먼저 시작하고 초기 파일 사본은 뒤에서 준비합니다. 중지 후 다시 켜면 기존 기록에 이어 저장합니다.
- **불필요한 파일 보관 줄이기** — 프로젝트의 무시 규칙과 빌드·의존성·캐시·앱 실행 데이터 제외를 적용했습니다. 대규모 파일 검사로 기록 시작이 지연되거나 WebView 잠금 파일 때문에 경고가 뜨던 문제를 줄였습니다. 기존 사본과 기록은 유지합니다.
- **잠깐 잠긴 파일은 자동 재시도** — 일시적인 잠금과 복사 중 변경은 간격을 두고 다시 시도합니다. 사본을 확정하기 전에 파일 상태와 교체 여부를 확인하고, 같은 오류는 반복해서 쌓지 않습니다. 다른 파일과 대화 기록은 계속하며 정상 보관되면 현재 오류를 해제합니다.
- **세션 ZIP 내보내기·가져오기** — 기록을 중지한 뒤 세션 내보내기를 누르면 대화 원문, 세션 이름과 파일 사본을 ZIP 하나로 저장합니다. 세션 가져오기에서 ZIP 파일이나 기존 세션 폴더를 선택할 수 있습니다. 손상·누락·잘못된 경로를 검사하고 같은 ID도 별도 세션으로 가져옵니다. 실패한 내보내기는 기존 ZIP을 유지합니다. 가져오기가 실패하면 임시 파일을 정리합니다.
- **기록소에서도 닫기와 스크롤** — 우클릭 드래그로 ↓→를 그리면 기록소를 닫고, ↑/↓로 대화 맨 위·아래로 이동합니다. 제스처 궤적과 안내가 기록소 위에 보이도록 수정했으며 일반 우클릭의 세션 메뉴도 사용할 수 있습니다.
- **기록 상태와 상단 버튼 정리** — 파일 준비와 저장 오류는 기록소의 기록 상태에서 확인합니다. 헤더의 준비·중지 문구와 파일 경고 툴팁을 없애고, 새로고침을 주변 버튼과 같은 아이콘+텍스트 형태로 맞췄습니다. 불필요한 보관됨 배지도 제거했습니다. 기록소에서는 현재 기록 중인 세션만 기록 중 표시를 유지합니다.

---

## AgentCodeGUI 3.2.1 (English)

Connect selections and state from external tools to your conversations. Recording controls respond faster, with improvements to long archives, file capture, and session ZIP transfers.

- **Connect external tools to conversations** — Include selections and state from integrated tools such as editors and tables in a conversation. Identify connected tools by their names and icons and choose which ones to use.
- **Share a tool across sessions** — Connect the same external tool to multiple chats and panels at once. Each session independently controls its connection, inclusion in the next message, and disconnection.
- **Keep the tool data attached at send time** — Sending or scheduling a message attaches a snapshot of its selected data and tool state. Later tool updates do not change attachments already sent.
- **Clearer selections and individual attachments** — The input area shows the tool name and selection title with a switch for the next message. Switches stay steady while saving, and sent tool attachments can be expanded individually or together.
- **Copy integration instructions for a coding AI** — External Tools settings provides Korean and English integration instructions with the protocol, connection code, and runnable examples, ready to pass to a coding AI.
- **Consistent session header menus** — MCP & SKILL and external tool menus now share placement and dismissal behavior. Menus stay within the viewport and close with an outside click, Escape, or another menu.
- **Read long archives by scrolling** — Scroll down to load more records instead of clicking Next. Only nearby rows and needed message bodies are rendered, while expanded items and scroll positions are retained when revisiting earlier content.
- **Conversations no longer hidden by file records** — Automatic file snapshot entries are hidden from the conversation timeline so messages and actual tool activity remain easy to read. Fixed saved conversations being obscured by large runs of file records. File snapshots are still preserved.
- **Responsive recording ON/OFF** — The header shows only ON/OFF and responds immediately to clicks. Further clicks retain your latest choice while settings are applied. Conversations start recording before initial file copies finish, and resuming continues the existing archive.
- **Avoid unnecessary file capture** — Automatic capture respects project ignore rules and excludes build outputs, dependencies, caches, and app runtime data. This reduces startup delays and warnings from locked WebView files while keeping earlier snapshots and records.
- **Retry temporary file locks** — Temporary read locks and changes during copying are retried after short delays. File state and replacement are checked before accepting a snapshot. Repeated errors are deduplicated, other files and conversations keep recording, and successful capture clears the current file error.
- **Export and import session ZIP files** — Pause recording and export a session's original conversation, name, and file snapshots as one ZIP. Import either a ZIP or an existing session folder. Imports check damaged or missing snapshots and unsafe paths, and keep sessions separate when IDs collide. Failed exports preserve the existing ZIP. Failed imports clean up temporary files.
- **Close and scroll in the archive** — Hold the right mouse button and draw ↓→ to close, or ↑/↓ to move to the top or bottom of the conversation. Gesture trails and labels appear above the archive, and regular right-clicks still open the session menu.
- **Recording status and matching toolbar buttons** — File preparation and storage errors are available under Recording status in the archive. Preparation text and file warning tooltips are removed from the header. Refresh now matches the neighboring icon-and-text buttons, and the unnecessary Saved badge is removed. The archive shows a recording badge only for sessions that are currently recording.
