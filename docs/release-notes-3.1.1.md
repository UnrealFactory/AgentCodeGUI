## AgentCodeGUI 3.1.1

Blazor 코드 보기와 관련 파일 정리, 서브에이전트 정보, stderr·재연결 알림 표시를 개선했습니다.

### 개선 및 수정

- **Blazor / Razor 코드 지원** — Razor 마크업과 C# 구문 색상을 추가했습니다. C# 코드 분석을 설정한 프로젝트에서 컴포넌트와 코드비하인드의 호버·정의 이동·의미 기반 색상을 지원하고, Razor 토큰 때문에 C# 색상이 잘못 표시되지 않도록 개선했습니다. C# 코드 분석에는 설치된 Roslyn 서버와 .NET SDK 10 이상이 필요합니다.
- **Razor 관련 파일 묶기** — 같은 폴더의 `.razor`·`.cshtml` 파일 아래에 `.cs`·`.css`·`.js`·`.ts` 동반 파일을 묶어 표시합니다. 펼침 상태를 기억하며, 각 파일을 열고 검색할 수 있습니다. 부모 파일이 없는 동반 파일은 개별 항목으로 남습니다.
- **서브에이전트 모델·추론 강도** — 목록과 상세 카드에 엔진이 제공하는 모델과 추론 강도를 표시합니다. 늦게 도착한 정보는 완료 상태를 유지한 채 갱신하며, 제공되지 않은 값은 추측해 표시하지 않습니다.
- **stderr·재연결 기록 정리** — 계속 쌓이던 알림을 실행별 접힌 기록으로 모으고, 연속으로 반복된 출력은 횟수로 표시합니다. 펼치면 원문과 시각을 확인할 수 있습니다. 기록별 최근 100개 항목을 보관하며, 초과한 이전 출력은 생략 건수를 표시합니다. 기존 대화에 저장된 알림도 복원할 때 정리합니다.
- **현재 재시도 상태 표시** — 하단에는 최신 재시도 횟수나 HTTPS 전환 상태를 표시합니다. 답변·도구 실행이 재개되면 재시도 표시를 해제하고 기록을 ‘작업 재개됨’으로 바꿉니다. 이전 실행의 늦은 통지나 서브에이전트·백그라운드 활동 때문에 현재 재시도 상태가 잘못 바뀌던 문제를 수정했습니다. 최종 오류는 기존 오류 메시지로 표시합니다.
- **작업 표시 문구** — Codex 대화의 작업 도구 설명에 Claude 이름이 나오던 오류를 수정하고, 작업 표시줄의 반복적인 클릭 안내 문구를 정리했습니다.

---

## AgentCodeGUI 3.1.1 (English)

Improves Blazor code viewing, companion file organization, subagent information, and stderr/reconnection notices.

### Improvements and fixes

- **Blazor / Razor code support** — Adds distinct Razor markup and C# syntax colors. Projects with C# code analysis configured support hover, go to definition and semantic colors across components and code-behind files. Razor token registration preserves existing C# colors. C# code analysis requires the installed Roslyn server and .NET SDK 10 or later.
- **Razor companion files** — Groups `.cs`, `.css`, `.js` and `.ts` companions beneath their `.razor` or `.cshtml` file in the same folder. Expansion is remembered, and each file remains available to open and search. Companions without a parent remain visible as individual entries.
- **Subagent model and reasoning effort** — Lists and detail cards show values supplied by the engine. Late metadata updates preserve completed status, and unavailable values are not guessed.
- **Compact stderr and reconnection logs** — Groups accumulated notices by run in collapsed logs, with counts for consecutive repeated output. Expand to inspect original messages and timestamps. Each log retains its latest 100 entries and reports the number of earlier entries omitted. Existing saved notices are grouped when restoring a conversation.
- **Accurate current retry status** — The working indicator shows the latest retry count or HTTPS transition. Responses or tool execution clear the retry indicator and mark the log “Work resumed.” Late events from old runs and activity from subagents or background tasks no longer overwrite the current retry state. Final errors retain their normal error messages.
- **Activity labels** — Fixed Claude appearing in tool descriptions for Codex chats and removed repetitive click instructions from activity indicators.
