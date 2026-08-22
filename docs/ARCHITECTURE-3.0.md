# AgentCodeGUI 3.0.0 — Tauri + Rust 아키텍처

기준: 2.6.2(Electron)의 기능·UI를 하나도 잃지 않고, 유휴 메모리·콜드 스타트를 절반
이하로. 이 문서는 조각(M1~M12)들보다 먼저 서는 **경계와 확장점**이다 — 조각이 아무리
얹혀도 이 경계는 유지된다.

## 확정 결정

1. **런타임**: Tauri 2.x + WebView2 (Windows 우선 — 2.6.2도 Windows 전용 배포).
2. **프론트엔드**: 기존 렌더러(React 19 + CodeMirror + styles.css)를 **통째 이식**.
   렌더러는 이미 `window.api`(WindowApi, `shared/api.ts`) 단일 관문으로만 메인과
   대화한다 → preload를 **api 심(shim)** 하나로 교체하면 나머지 33k LOC는 그대로.
   UI 블라인드 A/B 동률은 여기서 구조적으로 나온다.
3. **계약면이 곧 스펙**: `src/shared/protocol.ts`(IPC ~180채널 + 타입)가 캐노니컬.
   Rust는 이 계약면을 구현한다. 채널 이름·페이로드 모양·이벤트 의미(REPLACE 목록,
   소비형 조회, once 안내 등 주석에 명문화된 규약 전부)를 보존한다.
4. **앱 홈 호환**: `~/.agentcodegui` 레이아웃·포맷을 그대로 사용(chats/, accounts.json,
   engines/, ui-prefs.json …). 3.0 첫 실행에 사용자의 기존 데이터가 그대로 산다.
   개발·벤치는 항상 `CCG_HOME` 격리(설정 시 무조건 존중 — dev/release 불문).
5. **Node는 이미 하드 의존성**: 2.6.2가 엔진 CLI를 npm으로 설치·구동하므로 시스템
   Node 없이는 애초에 앱이 기능하지 않는다. 따라서 TS/Pyright 언어 서버도 시스템
   Node로 스폰한다(번들 Node 없음 — 풋프린트 유지).

## 저장소 배치

```
crates/
  ccg-proto    # protocol.ts 미러 serde 타입 (protocol.ts가 원본 — 여기는 미러임을 명시)
  ccg-store    # 앱 홈 경로·원자 저장·JSON 스토어들(chats/sessionChats/maStore/talkStore/
               # uiPrefs/profile/apiConfig/apiUsage/window-state)·DPAPI 암호화
  ccg-engine   # 엔진 공통: EngineHost 트레이트(run/interrupt/cancel/respond/bgTask),
               # EventSink 추상(창 라우팅과 분리), 턴 생명주기 상태기계
  ccg-claude   # Claude Code CLI 드라이버 — stream-json + control 프로토콜
               # (initialize/can_use_tool/interrupt/set_permission_mode/hook), 상주
               # 유지·optsMatch 재스폰 게이트·소프트 중단·notif 재주입·계정 CONFIG_DIR
  ccg-codex    # Codex app-server JSONL 드라이버
  ccg-auth     # 계정 스토어(claude+codex)·로그인 플로(CLI 스폰)·usage API·DPAPI
  ccg-lsp      # LSP 매니저: JSON-RPC 프레이밍·서버 레지스트리(ts/py=node, roslyn,
               # clangd, verse-lsp)·시맨틱 토큰 디스크 캐시·Verse 레지스트리 파서
  ccg-git      # git CLI 래퍼 (status/log/diff/commit/push/pull/branches/AI 메시지)
  ccg-fs       # 탐색기 목록·읽기/쓰기 캡·휴지통·워처(notify)·HTML 미리보기 루트
  ccg-peer     # (M10) 세션 간 메시징 허브 — N개 세션 버스, stash 설계 부활
src-tauri/     # 앱 셸: 창 레지스트리·트레이·전역 단축키·아크릴·단일 인스턴스·업데이터
               # + IPC 디스패처(#[tauri::command] ipc_call 하나 + 채널 레지스트리)
app/           # 이식된 렌더러 (vite 루트) — src/api/shim.ts 가 WindowApi 구현
bench/         # 공용 측정 하네스 (Electron/Tauri 동일 방법론) — 크리틱의 저울
progress/      # 라이브 진행 페이지
```

## IPC 어댑터 규약 (확장점 #1)

- Rust에 **단일 디스패처** `ipc_call(channel: String, payload: Value) -> Value` +
  채널 레지스트리. 채널 문자열은 protocol.ts의 IPC 상수 그대로.
- 이벤트(메인→렌더러)는 Tauri 이벤트로 **같은 채널명** 유지, `emit_to(label, …)`로
  창 단위 라우팅(sessionEvent→그 창, maEvent→메인+팝아웃 팬아웃 미러).
- 새 기능 추가 = 레지스트리에 핸들러 1개 + (필요시) shim 메서드 1개. Tauri 커맨드
  증식 없음.

## 창 시스템 (확장점 #2)

- WindowRegistry: label → kind(main / session:<chatId> / panel:<panelId> / toast /
  traymenu). 전 창이 같은 dist를 해시 라우트(#session, #mapanel, toast.html,
  tray.html)로 로드 — 2.6.2와 동일 문법.
- **M1 최대 리스크**: 숨김 타이틀바 + 네이티브 Snap/리사이즈 + 아크릴의 동시 성립.
  2.6.2는 titleBarStyle:hidden(네이티브 프레임 유지)이 답이었다. Tauri 후보:
  (a) decorations:true + 캡션 영역 커스텀 오버레이(WS_CAPTION 유지), (b) decorations:false
  + undecorated shadow + WM_NCHITTEST 수동, (c) tauri windowEffects(acrylic) 조합.
  → M1 빌더가 PoC로 셋을 실증하고 Snap Layouts·엣지 스냅·리사이즈 커서·아크릴이 전부
  사는 조합을 채택. 크리틱은 실창에서 스냅 동작을 검증.

## 엔진 전략 (최대 기술 리스크 — M3)

- SDK(Node) 없이 Rust가 Claude Code CLI의 stream-json(+ control 프로토콜)을 직접
  구사한다. 프로토콜 원전: node_modules/@anthropic-ai/claude-agent-sdk 소스(SDK도
  결국 CLI를 스폰하는 같은 프로토콜) + 2.6.2 claude/engine.ts의 의미론(상주·소프트
  중단·고아 통지 재주입·사이드체인 조기분리·백그라운드 REPLACE 규약).
- **M3-PoC 게이트**(조각 루프 전 선행): 스폰→initialize 핸드셰이크→턴 1회 스트리밍→
  can_use_tool 왕복→interrupt→resume→forkSession 실증 스크립트가 통과해야 M3 착수.
- Codex는 2.6.2도 app-server JSONL 직접 — 의미론 이식.

## M5 제약 — 기존 계정을 그대로 살리는 법 (실측으로 확인됨)

`~/.agentcodegui/accounts.json`의 토큰은 Electron safeStorage = **Chromium OSCrypt**로
암호화돼 있다: userData의 `Local State` 안에 DPAPI로 감싼 AES 키가 있고, 값은 `v10`
프리픽스 + AES-256-GCM. 벤치에서 홈만 옮기고 userData를 새로 만들었더니 앱이
"계정 데이터를 복호화하지 못했어요"로 실행을 거부한 것이 그 증거(bench/fixture.mjs가
설치본의 `%APPDATA%/agent-code-gui/Local State`를 복사해 해결).

→ 3.0의 `ccg-auth`는 둘 중 하나여야 한다: (a) 같은 OSCrypt 스킴을 Rust로 읽어
기존 계정을 무손실 승계, (b) 첫 실행 마이그레이션으로 재암호화(DPAPI 직접). **(a)를
채택**한다 — 사용자가 3.0으로 옮겨도 재로그인이 필요 없어야 한다. `Local State`
경로는 2.6.2 userData(`%APPDATA%/agent-code-gui`) 기준으로 읽고, 3.0이 새로 쓰는
값은 DPAPI 직접(CryptProtectData, 사용자 스코프)으로 저장하되 읽기는 두 포맷 모두 지원.

## 파리티 판정법 (크리틱 계약)

- 같은 렌더러·같은 CSS ⇒ 픽셀 파리티는 구조로 담보. 크리틱은 **백엔드 행동 파리티**를
  화면 단위로 판정: 두 앱을 격리 홈으로 나란히 부팅, 같은 시나리오를 CDP로 구동,
  (a) DOM 스냅샷 diff (b) 스크린샷 나란히 (c) 이벤트 스트림 기록 diff.
- 성능은 bench/ 하네스 수치만 인정: 유휴 메모리(WS·Private 합) ≤ ½, 콜드 스타트
  (첫 창·UI 사용 가능) ≤ ½, 스크롤 FPS ≥, 스트리밍 드랍 ≤, 풋프린트 ≪ 650MB.

## 조각 규칙

- 조각마다 빌더 1 + **새 컨텍스트** 크리틱 1. 빌더는 자기 채점 금지. 크리틱은 실제
  빌드를 돌리고 수치·재현 스크립트로 판정, "남은 가장 큰 격차 1개"를 지목해 반려.
  통과까지 라운드 무제한.
- 크리틱 판정문은 progress/ 라이브 페이지에 라운드마다 기록.

## 확장점 요약

| 확장 | 방법 |
|---|---|
| 새 엔진 | ccg-engine::EngineHost 구현 + 레지스트리 등록 |
| 새 IPC | 디스패처 레지스트리 1항목 + shim 1메서드 |
| 새 창 종류 | WindowRegistry kind 추가 |
| 새 LSP 서버 | ccg-lsp ServerSpec 1항목 (cmd·루트 판별·캐시 키) |
| 새 스토어 | ccg-store JsonStore<T> 헬퍼 재사용 |
| 세션 간 협업 확장 | ccg-peer 버스는 N-세션 전제 (2개 한정 아님) |
