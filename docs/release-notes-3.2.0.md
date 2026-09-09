## AgentCodeGUI 3.2.0

대화와 실제 작업 과정을 파일 사본까지 함께 보관하는 대화 기록소를 추가했습니다. 선택 문장 번역, Git 메시지 생성의 AI 선택, Codex 한도 대기와 계정 전환도 개선했습니다.

### 대화 기록소

- **대화와 작업을 한 흐름으로** — 채팅 상단의 대화 기록 버튼으로 수집을 켜고, 사이드바의 대화 기록소에서 프롬프트·답변·명령 실행·도구 입력과 출력을 시간순으로 확인할 수 있습니다. 여러 요청과 앱 재시작 이후의 기록도 같은 세션에 누적됩니다.
- **실제 파일 내용 보관** — 작업·참조 폴더와 도구에서 확인한 파일의 원본, 생성 후 내용, 수정 전후 및 삭제 전 사본을 보관합니다. 긴 명령 출력과 파일 내용은 나누어 조회하며, 저장 원문을 줄이지 않습니다. 확보하지 못한 사본이나 수집 중 오류는 보관 상태에서 확인할 수 있습니다.
- **세션 폴더로 이동** — 각 세션 폴더의 `Chat`에는 대화·실행 기록, `View`에는 파일 사본을 저장합니다. 기록을 중지한 뒤 세션 폴더 전체를 복사하고 다른 컴퓨터의 **세션 가져오기**로 열면 원래 작업 폴더 없이 보관 내용을 볼 수 있습니다. 가져올 때 파일 사본의 무결성을 확인하고, 같은 세션 ID가 있어도 기존 기록을 덮어쓰지 않습니다.
- **검색과 관리** — 세션 검색, 저장 위치 변경, 세션 폴더 열기, 우클릭 이름 변경·삭제를 지원합니다. 삭제는 확인 창에서 확정하며, 실제 작업 파일과 원래 채팅은 유지됩니다. 파일 보관 알림은 별도 보관 상태에 표시해 대화 본문을 읽기 편하게 정리했습니다.

### 선택 문장 번역

- **선택해서 바로 번역** — 대화에서 문장을 선택하고 번역을 누르면 현재 세션의 제공업체와 계정으로 번역합니다. 이동 가능한 결과 창에서 언어 변경과 복사를 지원하며, 번역을 별도 채팅 턴으로 추가하지 않습니다.
- **번역 전용 설정** — 설정의 Translation에서 기본 언어, Anthropic·OpenAI별 모델과 사고 수준, 지원하는 OpenAI 모델의 속도를 선택할 수 있습니다. 한국어·영어 자동 전환과 일본어·중국어·프랑스어·독일어·스페인어를 지원합니다.

### Git과 Codex 개선

- **Git 메시지 생성의 AI 선택** — Anthropic 또는 OpenAI를 선택한 뒤 계정·모델·사고 수준을 지정할 수 있습니다. 계정별 남은 한도를 확인하고, 선택한 계정으로 커밋 메시지를 생성합니다.
- **Codex 한도 대기와 계정 전환** — 한도 오류의 복구 날짜와 연도를 정확히 읽고, 여러 창과 패널에서 엔진의 대기 상태를 일관되게 표시합니다. 다른 Codex 계정으로 바꾸면 이전 계정의 대기를 해제하고, 대기 중 입력한 메시지도 새 계정으로 이어갑니다. 대기열에 들어간 전송이 계속 실행 중으로 표시되던 문제도 수정했습니다.

---

## AgentCodeGUI 3.2.0 (English)

The new conversation archive keeps conversations, tool activity, and actual file snapshots together. This release also adds selection translation, expands AI selection for Git messages, and improves Codex quota recovery and account switching.

### Conversation archive

- **Conversations and work in one timeline** — Enable recording in the chat header, then open the archive from the sidebar to review prompts, replies, commands, and complete tool inputs and outputs. Multiple requests and recordings after an app restart stay in the same session.
- **Actual file contents** — Preserve originals, newly created content, before-and-after edits, and pre-deletion snapshots from workspaces, reference folders, and files identified by tools. Long outputs and files are paged for viewing without truncating the saved originals. Capture status shows unavailable snapshots and recording errors.
- **Transfer a session folder** — Each session stores conversation and execution records in `Chat`, and file snapshots in `View`. Pause recording, copy the entire session folder, and use **Import session** on another computer to view the saved content without the original workspace. Import checks snapshot integrity and keeps existing sessions intact when IDs collide.
- **Search and management** — Search sessions, change the storage location, open a session folder, or right-click to rename and delete. Deletion requires confirmation and preserves workspace files and the original chat. Capture notices are kept in a separate status panel for a clearer conversation view.

### Selection translation

- **Select and translate** — Select a passage in a conversation and choose Translate to use that session's provider and account. Change languages or copy the result in a movable popup. Translation does not add a separate chat turn.
- **Dedicated settings** — Choose the default language, Anthropic and OpenAI models and effort, and supported OpenAI speed options in Translation settings. Supports automatic Korean/English switching and Japanese, Chinese, French, German, and Spanish.

### Git and Codex improvements

- **Choose the AI for Git messages** — Select Anthropic or OpenAI, then choose an account, model, and reasoning effort. Check remaining account limits and generate a commit message with the selected account.
- **Codex quota recovery and account switching** — Reset dates and years are parsed correctly, and panels and detached windows consistently show the engine's waiting state. Switching Codex accounts clears the previous account's hold and resumes messages entered while waiting with the new account. Queued sends no longer remain incorrectly marked as running.
