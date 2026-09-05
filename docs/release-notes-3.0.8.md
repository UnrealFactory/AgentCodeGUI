## AgentCodeGUI 3.0.8

재시도 대기를 더 명확하게 표시하고, 작업 폴더와 멀티 패널 문제를 수정했습니다.

- **API 재시도 대기 표시** — Claude가 서버 오류로 재시도를 기다릴 때 사유·시도 횟수·남은 시간을 표시합니다.
- **작업 폴더 오류 수정** — 선택한 폴더 대신 바탕화면을 찾다가 전송에 실패하던 문제를 수정했습니다. OneDrive로 이동한 바탕화면도 올바르게 인식합니다.
- **패널 순서 유지** — 패널 수를 줄였다 늘려도 원래 순서로 돌아옵니다. 직접 드래그해서 정한 순서는 유지합니다.
- **좁은 패널의 헤더 정리** — 5·6분할 화면에서 폴더·MCP & Skill·작업 상태 표시가 겹치던 문제를 수정했습니다.

---

## AgentCodeGUI 3.0.8 (English)

Makes retry waits clearer and fixes working-folder and multi-panel issues.

- **Visible API retry waits** — When Claude waits to retry a server error, the app shows the reason, attempt count, and time remaining.
- **Working-folder fix** — Fixed sends failing because the app looked for the Desktop instead of the selected folder. Desktops redirected to OneDrive are also recognized.
- **Keep panel order** — Reducing and restoring the panel count now restores the original order. Orders set by dragging are preserved.
- **Cleaner narrow headers** — Fixed folder, MCP & Skill, and activity indicators overlapping in five- and six-panel layouts.
