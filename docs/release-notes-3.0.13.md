## AgentCodeGUI 3.0.13

시스템 환경 연결과 Claude 계획 검토를 추가하고, 파일 링크와 계정 표시·세션 복구를 개선했습니다.

- **시스템 환경 사용** — Claude와 Codex 각각 앱 관리 또는 시스템 환경을 선택할 수 있습니다. 시스템 환경에서는 PC에 설치된 CLI와 기존 로그인·설정을 사용합니다. 환경 변경은 앱을 다시 시작한 뒤 새 대화에 적용됩니다.
- **환경 설정 화면 개선** — 자동 감지의 진행 상태와 결과를 표시하고, 실행 파일·설정 폴더를 직접 고르는 탐색 버튼을 추가했습니다. 변경할 때만 저장·취소 버튼이 나타나며, 경로 글꼴과 툴팁도 다듬었습니다.
- **Claude 계획 검토** — 계획 승인 요청을 해당 세션 안에서 확인하고 승인·거절할 수 있습니다. Markdown 계획 미리보기와 새로고침·복사를 지원합니다. 여러 패널이나 별도 창에서도 요청한 대화에 표시됩니다.
- **계획 결정 기록** — 승인·거절 결과가 질문 답변처럼 채팅에 남으며, 대화를 다시 열어도 유지됩니다.
- **로컬 파일 링크 수정** — 상세 제안서나 SVG 시안 등 채팅의 로컬 파일 링크가 밑줄만 표시되고 열리지 않던 문제를 수정했습니다.
- **계정 사용 표시 수정** — Claude와 GPT의 사용 세션 수가 섞여 집계되던 문제를 수정했습니다. GPT 계정에도 현재·사용 중 표시와 주간 소진 계정 숨기기를 추가했습니다. 초기화 시각이 지난 계정은 다시 표시합니다.
- **GPT 세션 복구 수정** — 한도 소진 이후 과거 Claude 계정 연결 정보 때문에 GPT 세션이 Clear 후에도 막히던 문제를 수정했습니다. 사용 가능한 GPT 계정으로 전환한 뒤 기존 세션에서 대화를 이어갈 수 있습니다.

---

## AgentCodeGUI 3.0.13 (English)

Adds system environments and Claude plan review, with fixes for file links, account indicators and session recovery.

- **System environments** — Choose an app-managed or system environment separately for Claude and Codex. System mode uses the CLI, login and settings already on your PC. Environment changes apply to new chats after restarting the app.
- **Environment settings** — Automatic detection shows progress and results, with native file and folder pickers for executable and configuration paths. Save and Cancel appear only when changes are pending. Path typography and tooltips have been refined.
- **Claude plan review** — Read and approve or decline plans inside the session that requested them. Supports Markdown previews, refresh and copy, including multi-panel layouts and separate windows.
- **Plan decision history** — Approval and decline decisions appear in chat like question answers and remain after reopening the conversation.
- **Local file links** — Fixed underlined local file links, such as proposals and SVG previews, doing nothing when clicked.
- **Account usage indicators** — Fixed Claude and GPT sessions being counted together. GPT accounts now show current and in-use indicators and support hiding accounts with exhausted weekly limits. Accounts reappear once their reset time has passed.
- **GPT session recovery** — Fixed stale Claude account references blocking GPT sessions after a limit, even after Clear. Switching to an available GPT account now lets you continue in the existing session.
