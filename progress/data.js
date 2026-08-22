window.PROGRESS = {
  phase: 'M1 빌더 R1 + M0 잔여(스크롤·스트리밍 기준)',
  note: 'M1: Tauri 스캐폴드+렌더러 이식 빌더 가동(Opus·max) · M3 프로토콜 정찰 병행 · 정찰(픽스처 모양) 대기 중',
  updatedAt: '2026-08-22 12:45',
  metrics: [
    { name: '유휴 메모리 (프로세스 트리 WS 합)', unit: 'MB', base: 428.1, new: null, target: '≤214' },
    { name: '유휴 메모리 (Private 합)', unit: 'MB', base: 341.4, new: null, target: '≤171' },
    { name: '콜드 스타트 → 첫 창 (웜 중앙값)', unit: 'ms', base: 336, new: null, target: '≤168' },
    { name: '콜드 스타트 → UI 사용 가능', unit: 'ms', base: 422, new: null, target: '≤211' },
    { name: '긴 스레드 스크롤 평균 FPS (471항목 전량 렌더)', unit: 'fps', base: 60, new: null, target: '≥60' },
    { name: '스트리밍 중 프레임 드랍 (긴 스레드 위)', unit: '%', base: 0, new: null, target: '0' },
    { name: '전송 → 엔진 busy', unit: 'ms', base: 89, new: null, target: '≤89' },
    { name: '설치 풋프린트', unit: 'MB', base: 650, new: null, target: '대폭 감소' }
  ],
  pieces: [
    { name: 'M0 기준 실측', scope: '2.6.2 수치 박제 (콜드 스타트·메모리·스크롤·스트리밍)', state: 'build' },
    { name: 'M1 아키텍처+셸', scope: 'Tauri 워크스페이스·창 시스템·api 심·렌더러 이식 빌드', state: 'build', round: 1 },
    { name: 'M2 스토리지', scope: 'chats·uiPrefs·profile·api-config 등 저장 도메인', state: 'wait' },
    { name: 'M3 Claude 엔진', scope: 'stream-json 상주 CLI·승인/질문·중단·포크·백그라운드', state: 'wait' },
    { name: 'M4 Codex 엔진+버전 관리', scope: 'app-server JSONL·엔진 설치/업데이트', state: 'wait' },
    { name: 'M5 계정 도메인', scope: '로그인·전환·per-chat 격리·한도 조회 (DPAPI)', state: 'wait' },
    { name: 'M6 파일·Git·뷰어', scope: 'fs ops·git 래퍼·HTML 미리보기 스킴·아이콘', state: 'wait' },
    { name: 'M7 LSP', scope: 'TS/Py/C#/C++/Verse 서버 관리·토큰 캐시', state: 'wait' },
    { name: 'M8 멀티 창 표면', scope: '멀티 패널·팝아웃·추가 채팅·btw·토스트·트레이', state: 'wait' },
    { name: 'M9 신기능: MCP/Skill 뷰', scope: '멀티채팅 전용 MCP·Skill 가시화', state: 'wait' },
    { name: 'M10 신기능: 세션 간 협업', scope: '클로드 세션 4개 상호 대화 (stash 설계 부활)', state: 'wait' },
    { name: 'M11 신기능: 한도 자동 전환', scope: '소진 시 초기화 임박순 노는 계정 자동 이어가기', state: 'wait' },
    { name: 'M12 패키징+최종 A/B', scope: 'NSIS 대체 설치본·전 화면 대조·최종 인증', state: 'wait' }
  ],
  log: [
    { t: 'M0', m: '스트리밍 실측(471항목 전량 렌더 + 실 haiku 턴): 60fps · 드랍 0% · 롱태스크 0ms · 전송→busy 89ms — 성능 승부처는 메모리·콜드 스타트' },
    { t: 'M0', m: '스크롤 실측(471항목): 윈도잉 업스윕 60fps / 전량 렌더 스윕 60fps · 드랍 0%' },
    { t: 'M5 발견', m: '계정 토큰은 Chromium OSCrypt(userData Local State의 DPAPI 키) 암호화 — Rust가 같은 스킴을 읽어야 기존 계정이 재로그인 없이 산다' },
    { t: 'M0', m: '유휴 메모리 실측: WS 428.1MB / Private 341.4MB (5프로세스, 60초 정착)' },
    { t: 'M0', m: '콜드 스타트 실측: 첫 창 336ms / UI 사용 가능 422ms (웜 중앙값 5회) · 진짜 콜드 첫 회 1967/2079ms' },
    { t: '시작', m: '브랜치 feature/3.0.0-beta 생성 · 2.6.2 프로덕션 번들 빌드 완료 · 측정 하네스 작성' }
  ]
}
