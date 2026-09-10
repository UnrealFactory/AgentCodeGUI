## AgentCodeGUI 3.2.1

대화 기록소의 세션을 ZIP 하나로 옮길 수 있습니다. 기록소의 마우스 제스처와 오류 알림 표시도 개선했습니다.

- **세션 ZIP 내보내기·가져오기** — 기록을 중지한 뒤 **세션 폴더** 옆의 **세션 내보내기**를 누르면 대화 원문, 세션 이름과 파일 사본을 ZIP 하나로 저장합니다. **세션 가져오기**에서 ZIP 파일이나 기존 세션 폴더를 선택할 수 있습니다.
- **기존 기록을 지키는 가져오기** — ZIP 안의 파일 사본이 손상되거나 누락됐는지, 압축 경로가 올바른지 검사합니다. 같은 세션 ID가 있어도 별도 세션으로 가져옵니다. 내보내기가 실패하면 기존 ZIP을 유지하고, 가져오기가 실패하면 임시 파일을 정리합니다.
- **기록소 마우스 제스처** — 우클릭 드래그의 `↓→` 닫기와 `↑/↓` 대화 맨 위·아래 이동을 지원합니다. 제스처 궤적과 안내가 기록소 뒤에 가려지던 문제도 수정했습니다. 일반 우클릭의 세션 메뉴는 그대로 사용할 수 있습니다.
- **오류 알림 표시 정리** — **보관 상태**를 **오류 알림**으로 바꾸고 저장 오류와 누락 가능성을 확인하는 영역임을 명확히 했습니다. 아이콘도 다른 버튼처럼 글자 앞에 맞췄습니다.
- **불필요한 보관됨 표시 제거** — 기록 중인 세션에만 **대화 기록중**을 표시합니다.

---

## AgentCodeGUI 3.2.1 (English)

Transfer an archived session as a single ZIP file. Mouse gestures and error notifications in the conversation archive have also been improved.

- **Export and import session ZIP files** — Pause recording and choose **Export session** next to **Session folder** to save the original conversation, session name, and file snapshots in one ZIP. **Import session** now offers both ZIP files and existing session folders.
- **Imports preserve existing records** — ZIP imports check for damaged or missing snapshots and unsafe archive paths, and create a separate session when IDs collide. Failed exports preserve the existing ZIP, while failed imports clean up temporary files.
- **Archive mouse gestures** — Hold the right mouse button and draw `↓→` to close the archive, or `↑/↓` to move to the top or bottom of the conversation. Gesture trails and labels now appear above the archive. A regular right-click still opens the session menu.
- **Clearer error notifications** — **Capture status** is now called **Error notifications**, with clearer descriptions of storage errors and possible gaps. Its icon appears before the label, matching the other buttons.
- **Removed the unnecessary Saved badge** — Only sessions currently recording show **Recording conversation**.
