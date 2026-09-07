## AgentCodeGUI 3.1.0

도구 실행 내역을 더 자세히 확인하고, Codex 초기화권과 모델별 컨텍스트를 앱에서 관리하세요. 질문 카드·이미지·스크롤·완료 알림도 개선했습니다.

### 새 기능

- **Web 검색 상세** — Codex의 검색어와 검색 결과 링크를 펼쳐 확인할 수 있습니다. 페이지 열기·본문 찾기 등 엔진이 전달하는 작업 정보도 함께 표시합니다.
- **도구 실행 상세** — Bash의 전체 명령·출력·종료 코드, MCP와 기타 도구의 요청 인자·응답·오류를 카드에서 확인하고 복사할 수 있습니다. 출력이 없는 명령도 열리며, 엔진이 출력 일부만 전달한 경우 이를 표시합니다.
- **서브에이전트 도구 내역** — 서브에이전트 카드 안의 도구도 클릭해 상세 정보와 파일을 볼 수 있습니다. 닫기·Esc·왼쪽 마우스 제스처로 이전 카드에 돌아옵니다.
- **Codex 초기화권** — 설정 › Account의 OpenAI 계정에서 보유 수량과 제공되는 지급·만료 정보를 확인하고 직접 사용할 수 있습니다. 사용 후 한도와 보유량을 갱신하며, 결과를 확인하지 못한 요청은 같은 요청으로 재확인해 중복 사용을 방지합니다. 초기화권 제공 여부는 계정과 Codex 버전에 따라 다릅니다.
- **모델별 컨텍스트 설정** — 설정 › Engine에서 채팅에 표시되는 Codex 모델의 컨텍스트 크기와 자동 압축 기준을 확인하고 조절합니다. 기본값·추천값·직접 설정을 지원하며 **처음에는 기본값**을 사용합니다. 추천값은 직접 선택해 저장할 때만 적용되며, 현재 Astra에 512,000 / 430,000 토큰을 설정하고 다른 모델은 기본값을 유지합니다.
- **별도의 컨텍스트 관리** — 메모와 과거 기록 검색으로 작업 맥락을 유지하는 실험 기능을 독립된 ON/OFF 카드로 분리했습니다. 처음에는 OFF이며, 스위치를 바꾸면 자동 저장됩니다. 컨텍스트 크기는 저장 버튼으로 따로 저장합니다. **두 설정 모두 새 대화·재연결부터 적용**되며 기존 Codex 설정 파일은 수정하지 않습니다.

### 개선 및 수정

- **Codex 질문 카드** — 답변 중 전달된 질문이 카드로 나타나지 않던 문제를 수정했습니다. 작업을 강제로 중단하지 않고 답할 수 있으며, 전송에 실패하면 답을 유지해 다시 시도할 수 있습니다.
- **첨부 이미지 표시** — Markdown의 로컬 이미지가 링크처럼 보이거나 표시되지 않던 문제를 수정했습니다. 대화 안에서 보고 클릭해 확대할 수 있습니다.
- **스트리밍 스크롤** — AI가 답변 중일 때 위로 스크롤했다 돌아오면 글자가 겹치거나 빠르게 떨리던 현상을 개선했습니다.
- **완료 알림** — 내부 정리 작업·대화 복원·반복 상태 통지로 예전 답변이 다시 알림으로 뜨던 문제를 수정했습니다. 중단·초기화도 완료로 알리지 않습니다.
- **아이콘과 펼치기 표시** — Web에 앱과 어울리는 아이콘을 적용하고, 파일·웹 결과의 펼치기 화살표를 더 잘 보이게 했습니다.
- **README** — 한국어·영어 기능 소개에 도구 내역, 초기화권, 컨텍스트 설정과 새 화면을 반영했습니다.

---

## AgentCodeGUI 3.1.0 (English)

Inspect more tool activity and manage Codex resets and per-model context settings in the app. Also improves question cards, images, scrolling and completion alerts.

### New features

- **Web search details** — Expand Codex queries and search-result links, including page-open and in-page search details when supplied by the engine.
- **Tool detail cards** — Inspect and copy full Bash commands, output and exit codes, plus arguments, responses and errors from MCP and other tools. Commands without output still open; partial output supplied by the engine is identified.
- **Subagent tool history** — Click tools inside subagent cards to inspect details and open files. Close, Escape or a left mouse gesture returns to the previous card.
- **Codex resets** — See your balance and available grant/expiry details under Settings › Account, then use a reset manually. Usage limits and the balance refresh afterward. Unconfirmed requests reuse the same request on retry to prevent double spending. Availability depends on the account and Codex version.
- **Per-model context settings** — Settings › Engine lists the Codex models shown in chat with editable context windows and auto-compaction thresholds. Choose Default, Recommended or Custom; **Default is selected initially**. Recommended requires an explicit save and currently sets Astra to 512,000 / 430,000 tokens while keeping other models at their defaults.
- **Separate context management** — The experimental notes and history-search feature has its own ON/OFF card and starts OFF. The switch saves automatically; context sizes have a separate Save button. **Both apply to new or reconnected chats**, without editing your existing Codex configuration file.

### Improvements and fixes

- **Codex question cards** — Fixed questions sent during a response not appearing as cards. Answer without manually stopping the task; failed sends preserve the answer for retry.
- **Attached images** — Fixed local Markdown images appearing as links or failing to load. Images display inline and open in the image viewer when clicked.
- **Streaming and scrolling** — Improved overlapping or rapidly jittering text when scrolling up and returning to an AI response that is still streaming.
- **Completion alerts** — Fixed internal cleanup, restored chats and repeated status events announcing an old reply again. Stopping or clearing a chat no longer counts as completion.
- **Icons and expansion controls** — Web uses an icon consistent with the app, and file/web-result expand arrows are easier to see.
- **README** — Updated the Korean and English feature tours with tool history, resets, context settings and new screenshots.
