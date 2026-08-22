# M2 R1 — 통합 스토어(chats-v3) · 무손실 마이그레이션 · IPC 분할

작성: 3.0.0-beta, `feature/3.0.0-beta`
근거 문서: `docs/design/ux-chat-unify.md` §4·§5·§6 / `docs/design/m-logic.md` §2·§5.8 / `docs/design/ux-parity-map.md`
판정은 이 문서가 하지 않는다 — **수치·커버리지·안 되는 것**만 적는다.

---

## 0. 한 줄

`chats-v3/` + `boards/` 스토어와 3스토어 마이그레이션을 넣고, 검증 하네스
(`scripts/poc-chat-unify-migrate.mjs`)를 **실홈 복사본 · 벤치 픽스처 · 부하 픽스처** 셋에
돌렸다. 세 홈 모두 전 항목 통과(불일치 0). 신채널은 **`CCG_UNIFIED_STORE=1` 옵트인**
뒤에만 있고 **기본 경로는 2.6.2 3스토어 그대로**다.

---

## 1. 저장 스키마 (구현된 모양)

```
~/.agentcodegui/
  chats-v3/
    index.json     { version:1, order:[chatId…], activeChatId, migratedFrom:"2.6.2", migratedAt }
                   ← 쓰기 주인 = 렌더러 팬아웃 (+ chats:set-active만 즉시 갱신)
    status.json    { version:1, statuses:{ <chatId>: ChatStatusLite } }
                   ← 쓰기 주인 = **Rust 전용**. chats:save 페이로드에 statuses가 없다
    <chatId>.json  { id, origin, title, custom, locked, color,
                     identity, queue?, hold?,          ← ★ Rust 소유 3필드
                     draft?, draftImages?, btwOf?, btwSeed?, btwPrompt?,
                     empty?, updatedAt?, snapshot }
  boards/
    index.json     { version:1, order:[boardId…], activeBoardId }
    <boardId>.json { id, title, custom, count, chrome, order, slots[6], updatedAt? }
  chats/ multi-agent/ session-chats/ chat-talk.json   ← 읽고 **남긴다**(삭제하지 않는다)
  backup-2.6.2-<stamp>/                               ← 원본 3디렉터리 + chat-talk 통째 복사
```

파일 위치: `crates/ccg-store/src/{fanout,chats_v3,boards,status,raw_identity,migrate_v3,legacy_bridge}.rs`

### 1.1 되끼움 — 3.0에서 대화가 증발할 수 있는 자리

| 대상 | 규약 | 구현 |
|---|---|---|
| `snapshot` | `unloaded:true` 마커가 오면 디스크의 스냅샷을 되끼운다(2.6.2 `chats.ts:22-35`) | `chats_v3::merge_marker` |
| `identity` | 페이로드 값을 **채택하지 않는다.** 런타임 → 디스크 → **없으면 전역값으로 물질화**(m-logic §2.4 규약 2) | `chats_v3::apply_owned` |
| `queue`·`hold` | 페이로드 값을 **채택하지 않는다.** 런타임 → 디스크 → **없으면 키를 지운다** | 동상 |

> 첫 구현은 "저장된 값이 없으면 페이로드를 부트스트랩"이었고, 하네스 §5.3-2가 그 구멍으로
> 들어온 가짜 `queue`/`hold`를 **311건 전부** 잡아냈다(리포트 초판 FAIL). 지금은 `identity`만
> 기본값 물질화로 메우고 나머지 둘은 지운다.

### 1.2 `ChatStatusLite` (status.json)

- 쓰기 주인 Rust 하나. 디스크는 **500ms 디바운스 + `flush()`**(`status.rs`의 전용 스레드).
- 부팅 강제: `busy=false`·`ask='none'`·`bgActive=false`, `working/analyzing` → `idle`.
  **`queued`·`hold`는 강제하지 않는다**(재장전 대상).
- 이중 진실: `hold`·`queued`의 진실은 `<chatId>.json`. 장전할 때마다 그 파일에서 되맞춘다.
- `status.json`이 없거나 깨져도 **얕은 스캔**으로 재구성한다 — `serde`가 모르는 필드를
  `IgnoredAny`로 건너뛰므로 `snapshot`은 파싱하지 않는다(`status::ChatLite`).
- `unread`는 **항상 0**으로 출하(필드만 예약).

### 1.3 light 조회

스냅샷을 싣는 집합 = (a) 활성 보드의 보이는 자리 ∪ (b) `openChatIds`(열린 창) ∪ (c) 활성 채팅
∪ (d) **스냅샷이 빈 채팅 전부**. 나머지는 `snapshot:null + unloaded:true`.
(d)는 2.6.2의 예외 보존(`chats.rs:97-104` — 지우면 "새 채팅을 눌렀는데 골라둔 모델이 사라진다").

### 1.4 `origin` — 스펙 §4.1 필드 목록 **밖의 추가 필드**

`'chat' | 'panel' | 'session'`. 이유 하나: 얼려 둔 2.6.2 렌더러가 목록을 **셋**으로 나눠 들고
있어서, 별칭 계층이 `chats:save`로 온 목록을 저장할 때 **어디까지 prune해도 되는지**를 알아야
한다. 없으면 본채팅 저장 한 번이 멀티 패널·추가 채팅 대화를 통째로 지운다. 통합 UI가 서면
별칭 계층과 함께 사라진다. **스펙에 없는 필드를 늘린 건이므로 크리틱 판정 대상으로 올린다.**

---

## 2. 마이그레이션

`crates/ccg-store/src/migrate_v3.rs` — `chats/` + `multi-agent/` + `session-chats/`
(+ `chat-talk.json`) → `chats-v3/` + `boards/`.

- id: 일반 채팅 **유지** / 패널 `ma-<sid>-<i>` / 추가 채팅 충돌 시 `sc-<id>` / talk 충돌 시 `talk-<id>`
- 순서: 일반 → 멀티 패널 → 추가 채팅 → talk 연결(결정론)
- 보드: `default`(기본) + 세션별. `default.count = workspace.mode==='multi' ? 활성 세션 count : 1`,
  `chrome = count===1 ? 'ide' : 'grid'`, `slots[0] = 이전 activeChatId`
- `activeBoardId` = 멀티를 보고 있었으면 그 세션, 아니면 `'default'`
- 전역 pref는 **물질화**한다(상속 아님): `api.mode`·`claude.outputStyle`·MCP/Skill 토글 →
  `identity.billing` / `.outputStyle` / `.tools`
- `btwOf` 재작성: `${sid}::${slot}` → `ma-<sid>-<slot>`, 그 외는 idMap, 실패는 drop + 카운트
- `chat-talk.json`은 **제목이나 대화가 있는 것만** 편입(2.6.2 `App.tsx:558-566`과 같은 필터),
  편입분이 있을 때만 원본을 비운다
- 스테이징(`chats-v3.tmp-<stamp>`) 완성 → 마지막에 rename. 시작할 때 죽은 스테이징을 쓸어낸다
- 옛 3디렉터리는 **지우지 않는다** + `backup-2.6.2-<stamp>/`에 통째 복사

### 2.1 매핑 함수 `to_raw_identity` (M-UX 소관)

`crates/ccg-store/src/raw_identity.rs`. 화면마다 다른 `DEFAULT_PICKER`를 그대로 옮겼다 —
본채팅 `{opus,xhigh,auto}`(App.tsx:76) / 패널 `{opus,xhigh,bypass}`(MultiAgent.tsx:86) /
추가 채팅 `{opus,high,auto}`(SessionWindow.tsx:66). 저장본에 없던 필드를 임의 기본값으로
채우면 마이그레이션이 조용히 정체성을 바꾼다.

---

## 3. 검증 결과 (하네스 실행 수치)

리포트: `docs/poc-out/chat-unify-2026-08-22T15-37-24-867Z.json`
실행: `node scripts/poc-chat-unify-migrate.mjs --clone-from-real --fixture --synthetic` → **PASS**
(전 홈 실패 0. 전체 주행 9~10초)

| | 실홈 복사본 | 벤치 픽스처 | 부하 픽스처 |
|---|---|---|---|
| before 일반 채팅 | 1 | 1 | 200 |
| before 멀티 세션 / 내용 있는 패널 | 1 / 4 | 0 / 0 | 20 / 80 |
| before 추가 채팅 | 0 | 0 | 30 |
| chat-talk 편입 | 0 (제목·대화 없어 미채택) | 0 | 1 (빈 것 1건은 미채택) |
| **after 채팅 수** | **5** | **1** | **311** |
| 메시지 총수 before → after | **299 → 299** | **471 → 471** | **15810 → 15810** |
| 보드 수 (기본 포함) | 2 | 1 | 21 |
| 파일 수 chats-v3 / boards | 5 / 2 | 1 / 1 | 311 / 21 |
| **정체성 1차(원시 바이트) 비교/불일치** | **5 / 0** | **1 / 0** | **311 / 0** |
| 정체성 2차(정규화 해시) 비교/불일치/미수행 | 5 / 0 / **0** | 1 / 0 / **0** | 0 / 0 / **311** |
| 2차 미수행 사유 | — | — | `account_unavailable` 291 · `api_key_missing` 20 |
| btw 재작성 / drop (기대) | 0 / 0 (0/0) | 0 / 0 (0/0) | **20 / 1 (20/1)** |
| 마이그레이션 소요 | 55 ms | 21 ms | **1.4~1.5 s** |
| 피크 워킹셋 | 13.5 MB | 8.7 MB | **51.4 MB** |

- 1차 = **저장 원시 필드의 정준 직렬화 바이트 비교(전 항목)**. 해시가 아니라 바이트를 그대로
  비교하므로 어긋난 **리프 경로**를 짚어 준다. before는 하네스가 매핑표에서 **따로 구현한**
  `toRawIdentity` 미러, after는 디스크의 `identity`.
- 2차 미수행은 **경고**이고 게이트를 막지 않는다(O12 수정판). 부하 픽스처가 전건 미수행인
  이유는 합성 홈에 `accounts.json`·API 키가 없기 때문이다 — 실홈 복사본은 **5/5 수행, 불일치 0**.

### 3.1 §5.2 검증 항목 커버리지

| 항목 | 비교 | 결과 |
|---|---|---|
| 채팅 수 · id 집합 | 기대 id(규칙으로 계산) ↔ after | 3홈 동일 |
| 메시지 총수 · 채팅별 메시지 수 | 맵 | 동일 |
| 마지막 메시지 해시 · **스레드 전체 해시** | `sha256(canon(...))` 맵 | 동일 |
| 세션 id(resume) | `snapshot.session.sessionId` 맵 | 동일 |
| 제목·잠금·색 | 기본값 주입 후 맵 | 동일 |
| 초안 | 맵. 패널은 **공집합** | 동일 |
| `updatedAt` | 맵(화이트리스트 제외 **없음**) | 동일 |
| 정체성 | 1차 바이트 + 2차 해시 | 위 표 |
| 상태 | before(`SessionChatRecord.status`/패널 `snapshot.status`) ↔ `status.json` | 동일 |
| 예약 큐 | 2.6.2는 어디에도 영속하지 않는다 → **공집합** | 동일 |
| 한도 대기표 | `ui-prefs.limitResume.hold` → 그 채팅의 `Chat.hold` | 3홈 모두 대기표 없음(0건 이관) |
| btw 그래프 | 재작성 실패 0 + 간선 수 · drop 건수 | 기대와 일치 |
| 보드 | `count`·`panelOrder→order`·`slots`·제목·custom·chrome | 동일 |
| 목록 순서 · 활성 선택 | `chats-v3.order`·`boards.order`·`activeChatId`·`activeBoardId` | 동일 |
| 파일 수 | 기대 계산 | 동일 |

> `snapshot.session.**id**`(스펙 §5.2)는 실제 필드명이 `sessionId`다(`store/session.ts:68`).
> 하네스는 실물 필드로 비교했다.

### 3.2 §5.3 추가 검사

| # | 검사 | 결과 |
|---|---|---|
| 1 | 왕복 안정성(읽기 → 되저장 → 인벤토리 재수집) | 3홈 diff 0 |
| 2 | unloaded 마커 병합 + **Rust 소유 3필드 되끼움**(낡은 값을 일부러 실어 보냄) | 대화 손실 0 · 가짜 값 채택 **0** |
| 3 | 별칭 왕복 `ma:get → ma:save → ma:get` | 블롭 동일 · 데이터 손실 0 (멀티 없는 홈은 skip) |
| 3b | 별칭 왕복 `chats:get → chats:save` | 데이터 손실 0 |
| 4 | light 조회 등가 (a)(b)(c) + 마커 되저장 손실 | 오분류 0 · 손실 0 |
| 4b | `chats:set-active` 즉시 반영(디스크 확인) | 3홈 ok |
| 5 | 멱등성(2회 실행 후 채팅 수·id 집합) | 5→5 / 1→1 / 311→311 |
| 6 | 크래시 내성 — **진짜 중간 kill**(SIGKILL) | 부하: 1.64 s 주행의 0.57 s 지점에서 kill → 옛 3디렉터리 **바이트 동일**, `chats-v3` **없음**(반쪽 없음) |
| 6b | 롤백 — 옛 디렉터리 무결 + 백업 생성 + 스테이징 잔여물 | 3홈 통과 |
| 7 | 부하 픽스처(200 / 20×6 / 30) 시간·피크 메모리 | 1.4~1.5 s · 51.4 MB |
| + | 부팅 재장전 후보(§4.3 / m-logic §5.8) | hold·큐 세팅 → 후보로 잡힘 / `status.json` 삭제 후에도 **얕은 스캔으로 재구성** / 해제하면 후보에서 빠짐 |

크래시 kill 실측에서 **죽은 스테이징(`chats-v3.tmp-*`)이 홈에 남는 것**을 발견해,
마이그레이션 시작 시 쓸어내는 코드를 넣었다(`sweep_leftovers`).

---

## 4. 나머지 도메인

| 도메인 | 상태 |
|---|---|
| `api-config:get/set-key/clear-key/set-budget/reset-budget` | 구현(`api_config.rs`) — 2.6.2 파일 포맷·2칸 들여쓰기·`envKeyChoices` 지문(sha256 앞 12자) 동일. 지문 레시피는 단위 테스트로 고정 |
| API 키 **승계** | **읽기 실측 성공** — 실홈 복사본에서 `keyDecrypts: true`(끝 4자리 `ywAA`, 예산 300 그대로). 스킴: `v10` 접두사면 `Local State`의 OSCrypt AES-256-GCM 키로 복호, 접두사 없으면 DPAPI 직접. `Local State`는 `<CCG_HOME>/userData/` → `%APPDATA%/agent-code-gui/` 순으로 찾는다 |
| API 키 **쓰기** | DPAPI 직접(`CryptProtectData`). Chromium `DecryptString`이 `v10` 없으면 DPAPI로 폴백하므로 **2.6.2도 그대로 읽는다**(되돌려도 키가 안 죽는다) |
| `api-usage:list` | 구현(`api_usage.rs`) — 손상 줄 스킵·최근 20000건·8MB 회전. `record()`는 아직 부르는 곳이 없다(M3 실행 종료가 부른다) |
| `talk:get/save` | 구현. 플래그가 켜지면 `talk:get`은 빈 블롭, `talk:save`는 no-op |
| `engine-auto-update` | M1이 이미 구현 — 건드리지 않았다 |

---

## 5. IPC 분할 · 플래그 상태

`src-tauri/src/ipc.rs`(1파일) → `src-tauri/src/ipc/`:

```
mod.rs (156)  디스패처 + ch 상수(단일 소스) + arg/unimplemented + emit_to_window
app_meta.rs   앱 버전·업데이트·엔진 버전 상태
stores.rs     profile·chats(2.6.2)·ui-prefs(+브로드캐스트)·ma·talk·api-config·api-usage
unified.rs    chats-v3/boards 코어 + 옛 채널 별칭  ← 플래그 뒤
windows.rs    추가 채팅 창 + 창 컨트롤
system.rs     fs/dialog + 계정 목록 + close_orphan_dialogs
```

- 위임 순서: `unified(플래그 켜졌을 때만) → app_meta → stores → windows → system`.
  각 모듈은 `Option<Value>`를 돌려주고 첫 `Some`이 이긴다.
- `crate::ipc::ch::*`와 `crate::ipc::close_orphan_dialogs`의 **경로가 그대로**라
  `win.rs`·`crash.rs`·`main.rs`는 한 줄도 안 고쳤다.
- **플래그**: `ccg_store::unified_store_enabled()` = `CCG_UNIFIED_STORE=1|true`.
  꺼져 있으면 `unified::dispatch`가 **아예 실행되지 않는다** → 기본 경로 동작 불변.
- 켜지면: 첫 통합 채널 접촉에서 마이그레이션 1회(`ensure_migrated`, 멱등) →
  `chats:get/load/save`·`ma:get/save/load-session`·`talk:get/save`를 별칭이 가로채고
  `chats:set-active`·`board:get/load/save`가 추가된다.

### 5.1 별칭 계층의 명시된 과도기 예외

- **정체성 저자**: 페이로드에 옛 필드(`picker`/`manualCwd`/`cwd`)가 실려 있으면 별칭 계층이
  `to_raw_identity`로 **번역해 세운다**. 통합 모양 페이로드(옛 필드 없음)에는 §4.1의
  "Rust 값이 이긴다" 규약이 그대로 적용된다. 두 갈래를 하네스가 각각 밟는다.
- **codex 채팅의 `picker.model` 손실**: `RawIdentity`에 클로드 모델 축이 없으므로 역투영에서
  `opus`로 채워진다. 실행에는 영향이 없다(코덱스는 `codexModel`로 돈다). 되돌아가 보이는 값만 다르다.
- **`activeChatId`**: 옛 렌더러의 `chats:save`가 계속 실어 보내므로 마지막 디바운스 저장이
  `chats:set-active`를 덮을 수 있다 = 2.6.2와 같은 동작. 통합 UI가 서면 payload에서 뺀다.

---

## 6. 안 되는 것 / 남은 것

1. **`chat:*` 실행·정체성 채널 13개**는 `protocol.ts`에 **이름만** 있다 — 핸들러는 M-LOGIC.
2. **`win:chat-*` 4개**도 이름만 — 창 레지스트리(M4/`win.rs`)가 서야 한다.
3. **`chat:status` 브로드캐스트를 아무도 쏘지 않는다.** 상태 전이 주체(상태기계)가 아직 없다.
   저장·장전·재장전 후보 경로는 서 있다.
4. **`session-wins:*` 별칭 어댑터 미구현.** 창 wcId → chatId 역인덱스가 `win.rs`(이번 라운드
   내 경계 밖)에 있어야 한다. 그래서 플래그를 켜면 추가 채팅 창은 여전히 옛 `session-chats/`를
   읽는다 = 마이그레이션된 사본과 **두 살림**이 된다. 플래그를 기본으로 켤 수 없는 이유 중 하나.
5. **2차 정체성 키가 진짜 `RunIdentity::hash()`가 아니다.** `ccg-engine`의 `normalize()`가
   서면 하네스의 JS 미러를 그것으로 갈아끼워야 한다(1차는 영향 없음).
6. **플래그 경로를 실제 Tauri 창으로 띄워 보지 않았다.** `cargo check -p agentcodegui` 통과 +
   별칭 본체(`legacy_bridge`)를 하네스가 직접 돌린 것까지다.
7. `origin` 필드(§1.4)와 리포트 경로(`docs/design/poc-out/` → **`docs/poc-out/`**, 경계 때문)는
   스펙과 다른 선택이다.
8. 부하 픽스처의 2차 정체성이 전건 미수행이다(합성 홈에 계정·키가 없다). 계정이 있는 합성
   홈으로 2차까지 도는 케이스는 아직 없다.
9. `sha2`·`aes-gcm`(+ 의존 8개)이 `ccg-store`에 새로 붙었다. `sha2`는 워크스페이스 lock에
   이미 있던 버전이고 `aes-gcm`은 신규다(`Cargo.lock` 갱신).

---

## 7. 재현

```bash
cargo build -p ccg-store --features cli          # 하네스가 부르는 마이그레이터 바이너리
cargo test  -p ccg-store --features cli          # 단위 13개(매핑표·되끼움·DPAPI 왕복·base64)
node scripts/poc-chat-unify-migrate.mjs --clone-from-real --fixture --synthetic
npm run typecheck && npm run typecheck:app       # protocol.ts 순수 추가 확인
```

하네스 안전장치: `--home` 없이 돌면 종료, 대상이 실홈이면 거부, 실홈은 **읽기+복사만**,
마이그레이터는 항상 `CCG_HOME=<대상>`으로 스폰.
