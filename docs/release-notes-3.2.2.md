## AgentCodeGUI 3.2.2

질문 카드와 기록소 안내를 일관되게 맞췄습니다. 기록 중 반복 파일 읽기와 닫힌 화면의 후속 요청을 줄이고, 자동으로 펼쳐지는 사이드바의 렌더링 부담도 낮췄습니다.

- **Codex와 Claude 질문 카드 표시 통일** — 분할 패널에서도 질문 제목, 선택지, 여백을 같은 기준으로 표시합니다. 좁은 패널에서는 긴 문장을 줄바꿈하고 카드 안에서 스크롤해 답변 입력까지 이어갈 수 있습니다.
- **앱 스타일로 맞춘 안내 툴팁** — 기록소의 복사·원문 보기·날짜·경로·내보내기 안내를 앱 공통 툴팁으로 바꿨습니다. 기록소 위에서 안내가 가려지지 않고 긴 경로도 화면 안에 표시됩니다.
- **변하지 않은 파일의 반복 읽기 감소** — 기록 중 도구 작업이 끝날 때 이미 보관한 감시 대상 파일이 그대로라면 다시 읽고 복사하는 작업을 줄입니다. 파일 변경 알림, 외부 파일, 일시적인 보관 실패는 계속 확인합니다.
- **닫힌 파일 화면의 후속 요청 정리** — 파일 뷰어를 닫으면 코드 분석 재시도와 HTML 미리보기 확인 요청을 정리합니다. 느린 미리보기 응답을 기다리는 동안 같은 확인 요청이 겹치지 않도록 했습니다.
- **빠른 전환 중 중복 Git 탐색 감소** — 탐색기를 빠르게 열고 닫을 때 진행 중인 저장소 검색을 공유합니다. 이미 닫힌 탐색기에서는 검색 결과가 늦게 도착해도 추가 Git 상태 조회를 시작하지 않습니다.
- **자동 펼침의 렌더링 부담 감소** — 마우스가 화면 가장자리에 가까워질 때 펼쳐지는 사이드바의 배경 블러를 없애고 같은 상태를 반복 갱신하지 않도록 했습니다. 기존 슬라이드 동작과 크기 조절, 감지 범위 설정은 유지합니다.

---

## AgentCodeGUI 3.2.2 (English)

Question cards and archive tooltips now look more consistent. Recording avoids repeated file reads, closed views stop follow-up requests, and the automatic sidebar takes less work to render.

- **Consistent Codex and Claude question cards** — Question titles, choices, and spacing now follow the same layout in split panels. Long text wraps in narrow panels, and the card scrolls so the answer field remains reachable.
- **Tooltips that match the app** — Copy, raw view, date, path, and export hints in the archive now use the shared app tooltip. Hints appear above the archive, and long paths stay within the viewport.
- **Fewer repeated reads of unchanged files** — After tool operations, recording skips unnecessary reads and copies of previously captured watched files whose state is unchanged. File change notifications, external files, and temporary capture failures are still checked.
- **Stop follow-up requests from closed file views** — Closing a file viewer clears code analysis retries and HTML preview checks. Slow preview responses no longer cause overlapping checks.
- **Fewer duplicate Git scans during quick switches** — Rapidly opening and closing the explorer shares a repository scan already in progress. A late scan result no longer starts more Git status requests for an explorer that has closed.
- **Lighter rendering for the automatic sidebar** — The sidebar that opens near the screen edge no longer blurs the content behind it or repeatedly updates an unchanged reveal state. Sliding, resizing, and trigger range settings retain their existing behavior.
