## AgentCodeGUI 3.0.7

알림과 사이드바의 안정성을 높이고, 플러그인 스킬과 도구 필터를 개선했습니다.

- **채팅 완료 시 멈춤 수정** — 완료 알림이 뜨는 순간 앱이 응답 없음으로 멈추던 문제를 수정했습니다. 트레이 메뉴도 함께 안정화했습니다.
- **플러그인 스킬 표시** — Claude 플러그인으로 설치한 스킬이 MCP & Skill 목록과 / 자동완성에 표시됩니다. 플러그인 스킬은 목록에서 확인할 수 있으며 개별 스위치는 제공하지 않습니다.
- **로컬·전역 필터** — MCP & Skill 목록에서 프로젝트 항목과 전역 항목을 나눠 볼 수 있습니다. 선택한 필터는 다음에도 유지됩니다.
- **사이드바 클릭 오류 수정** — 사이드바의 빈 곳이나 다른 항목을 눌렀는데 별도 채팅 창이 열리던 문제를 수정했습니다.
- **한도 초기화 시각 인식** — Claude가 안내한 초기화 시각을 인식해 대기 시간을 표시합니다. 자동 재개를 사용하면 해당 시각에 맞춰 이어갑니다.

---

## AgentCodeGUI 3.0.7 (English)

Improves notification and sidebar stability, plugin skills, and tool filters.

- **Fix for freezes on completion** — Fixed the app becoming unresponsive when a completion notification appeared. Tray menu handling was also improved.
- **Show plugin skills** — Skills installed through Claude plugins now appear in MCP & Skill and / completion. Plugin skills are listed without individual toggles.
- **Local and Global filters** — View project and global items separately in MCP & Skill. Your filter selection is remembered.
- **Sidebar click fix** — Fixed clicks on empty sidebar space or other items bringing an extra chat window to the front.
- **Recognize limit reset times** — The app reads the reset time reported by Claude and displays the wait. Automatic resume continues at that time when enabled.
