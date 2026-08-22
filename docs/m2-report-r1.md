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

---
---

# §R2 — 크리틱 M2 R1 대응

대상 크리틱: `docs/critic/m2-r1.md`(치명 3 · 높음 3 · 중간 7 · 낮음 4 · 조용한 손실 8/15).
**판정 도구는 크리틱의 것을 그대로 돌렸다** — 내 하네스로 자기 채점하지 않았다.
`docs/critic/tools/critic-m2-{migrate,damage,kill,semantics,tauri,api}.mjs`.

## R2.0 하네스 결과 (크리틱 도구 · 재실행)

| 하네스 | R1 | R2 | 근거 파일 |
|---|---|---|---|
| `critic-m2-migrate` | findings 3 | **ok: true / findings 0** | `docs/critic/m2-r1-migrate.json` |
| `critic-m2-damage` | preserved 7 · **조용한 손실 8** | **preserved 14 · reported-drop 1 · 조용 0 · crash 0** | `m2-r1-damage.json` |
| `critic-m2-kill` | oldDirs✔ · **tornCommit 있음** | **oldDirsAlwaysIntact ✔ · neverPartial ✔ · tornCommitSeen [] · rerunAlwaysRecovers ✔** | `m2-r1-kill.json` |
| `critic-m2-semantics` | findings 7 | **ok: true / findings 0** | `m2-r1-semantics.json` |
| `critic-m2-tauri` | findings 2 | **findings 1**(§R2.6 — 하네스 형상 결함, 증거 첨부) | `m2-r1-tauri.json` |
| `critic-m2-api` | findings 1 | **findings 1**(같은 항목) | `m2-r1-api.json` |
| `cargo test -p ccg-store` | 13 | **54** | — |
| `poc-chat-unify-migrate`(눈 교체본) | PASS(맹점 포함) | **PASS**(실홈 복사본·픽스처·부하 3개 모두) | `docs/poc-out/` |

`reported-drop` 1건은 **깊은 중첩 JSON(1000단)** 하나다 — §R2.4에 사유와 트레이드오프.
`critic-m2-{tauri,api}`에 남은 1건은 **같은 항목**이고 제품 결함이 아니다(§R2.6).

## R2.1 D1 (치명) — 별칭이 런타임 정체성을 되돌린다 (P3 재발)

`legacy_bridge.rs`에 **두 겹 가드**를 넣었다. 페이로드의 `identity`는 어떤 경우에도 채택하지
않고(§4.1 ★R3 그대로), 옛 필드(`picker`·`manualCwd`·`cwd`·`refDirs`·`api`)를 **저자로 인정할지**만 가른다:

1. **에코 판별** — `chats:get`/`ma:get`/`chats:load`가 내보낸 옛 필드 묶음의 정준 바이트를
   `PROJECTED`에 기억한다. 돌아온 페이로드가 그것과 **같으면** 렌더러는 저자가 아니다
   (그냥 되돌려준 것) → 정체성을 손대지 않는다. 다르면 사람이 picker를 바꾼 것 → 번역해 세운다.
2. **출처 불명이면 런타임/디스크 우선** — `PROJECTED`에 기록이 없는데(다른 프로세스·재시작·CLI)
   `chats_v3::has_identity_truth(id)`가 참이면 **렌더러 사본을 믿지 않는다.**

스트리밍 중 자동저장 폭격 시나리오(`App.tsx:607-637` deps에 `state`가 있어 토큰마다 재무장)를
그대로 재현한 것이 크리틱 B2다: `alias-chats-get`(폴백 전 사본) → `set-owned identity`(턴 중 폴백)
→ `alias-chats-save`(낡은 사본). 실측 `p3Regression.runtimeWon: true`, 대조군 `p3Control` = `haiku`.
`cargo test`로도 잠갔다 — `a_stale_renderer_copy_cannot_revert_the_runtime_identity`,
그리고 **반대 방향**(`a_real_picker_edit_still_lands`)도 같이 잠갔다(가드가 기능을 죽이지 않게).

## R2.2 D2 (치명) — index 손상이 대화 파일을 지운다

규약을 둘로 갈랐다(`fanout.rs`):

- **읽기**: 인덱스를 못 읽으면 **디렉터리를 훑는다**(파일이 진실, 순서는 파일 이름).
  인덱스도 없고 항목 파일도 없을 때만 `None`.
- **prune**: `index_trusted()` — 인덱스를 **완전히 판독했을 때만** 돈다. 못 믿는 상태에서는
  지우는 대신 목록에서 빠진 파일을 `order` 꼬리에 실어 **인덱스를 복구**한다.
- 별칭 계층의 목록 prune(`chats_save`·`ma_save`)도 같은 게이트를 통과해야 돈다.
- `chat_ids()`(부팅 상태 장전)도 인덱스가 깨지면 디렉터리 이름 스캔으로 대신한다.

실측(`m2-r1-semantics.json`): index를 20바이트로 자른 뒤 `readChatsNull:false` ·
`aliasChatsNull:false`(R1은 둘 다 `null`), 그 상태에서 새 채팅 저장 → 생존 파일 9개
(R1은 1개). **"유일 사본을 지우는 경로"가 코드에 없다**는 것을 테스트로 고정했다:
`fanout::prune_never_runs_while_the_index_is_unreadable`,
`chats_v3::a_broken_index_does_not_turn_the_next_save_into_a_wipe`,
`boards::writing_a_subset_while_the_index_is_broken_keeps_the_other_board_files`.

## R2.3 D3 (치명) — 재마이그레이션이 3.0의 변경을 덮는다

- **완료 마커**: `index.migrationComplete` + `is_migrated()`가 `migratedAt` **와**
  `boards/index.json` 존재를 함께 본다(D8과 한 몸).
- **보존 규칙**: `chats-v3`가 이미 서 있으면(마커 존재) **이미 있는 id는 소스가 손대지 않는다** —
  3.0 사본을 그대로 스테이징으로 복사하고 `kept_v3_record` 경고를 남긴다. **보드도 같다**
  (`kept_v3_board`) — 자리 배치를 되감으면 패널이 남의 채팅을 가리킨다.
- 3.0에서만 생긴 채팅/보드도 `carried`로 그대로 넘어간다. 즉 이 연산의 정의는
  **"2.6.2에서 새로 생긴 것만 데려오기"**다.
- 스펙 §4.1의 재마이그레이션 카드 문구를 고쳤다(*"새로 만든 것만 가져올까요?"* + 덮지 않는다는
  규칙 명시). 문구를 안 고치면 UI가 붙는 순간 그 버튼이 데이터 파괴 버튼이 된다.

실측: `m2-r1-migrate.json.remigrationClobber.clobbered: false`(R1은 `true` — 제목이 `""`,
메시지 0으로 되감겼다). `cargo test`: `remigration_never_overwrites_a_record_that_3_0_kept_writing`
+ `remigration_still_brings_in_a_chat_created_in_2_6_2_afterwards`(보존이 *수입*을 막지 않는지).

## R2.4 D4 — 조용한 드랍 0

`read_fanout`을 **인덱스 + 디렉터리 합집합**으로 바꾸고 네 종류의 경고를 심었다:
`unreadable_index` · `not_in_index` · `missing_source_file` · `unreadable_source`.
파싱 불가 원본은 `quarantine/<stamp>/<dir>/<id>.json`으로 **격리 보관**한다(복구 경로 셋:
옛 디렉터리 · `backup-2.6.2-*` · `quarantine/`).

손상 15종 판정: **preserved 14 · reported-drop 1 · silent-* 0 · crash 0**.

남은 1건은 **1000단 중첩 JSON**이다. `serde_json::disable_recursion_limit()`으로 보존까지
시도했고 실제로 통과했지만 — **스택 오버플로로 마이그레이션 프로세스가 죽었다**(그 주행의
판정은 `crash`였다). 마이그레이션이 안 끝나면 앱이 못 뜨므로 **크래시 0이 병적 중첩의 보존보다
우선**이라고 판단했다. 그 파일은 경고 + 격리 + 옛 디렉터리로 남고, 조용히 사라지지 않는다.
(진짜 해결은 파싱·직렬화·드롭을 전부 큰 스택 스레드로 옮기는 것인데, 그러면 런타임 조회
경로까지 같은 처리를 해야 해서 반경이 이번 라운드를 넘는다. 남은 것 목록에 올린다.)

## R2.5 D5 — api 모드에서 채팅별 계정 소실

`billing` 태그드 유니온과 **별개로** 레코드에 보존 칸을 뒀다: `chat.legacyAccount`
(정체성 축이 아니다 → `RawIdentity` 바이트 계약면을 건드리지 않는다 = 크리틱의 독립 미러와
1차 비교가 그대로 성립한다). 별칭 되그리기가 `picker.account`로 복원하고, 저장은
**디스크 우선 보존 필드**라 렌더러가 못 덮는다. 실측: 손상 13번 `accountsGone: []`.
`cargo test`: `the_api_mode_account_survives_a_full_alias_round_trip`.

## R2.6 D6 — 3.0이 쓴 키를 2.6.2가 읽는가

`safe_storage::encrypt()`가 **Local State의 OSCrypt 키가 있으면 `v10`으로 쓴다**(AES-256-GCM,
nonce는 `BCryptGenRandom` — 새 의존성 없음). 키가 없는 환경에서만 DPAPI 폴백이고, 그 제약은
모듈 주석에 정직하게 적었다. 디스크 실측: `prefixV10: true`(R1은 `01000000` = DPAPI blob).

**남은 하네스 1건은 제품이 아니라 하네스 형상의 문제다.** `critic-m2-tauri` §5b와
`critic-m2-api` §C는 Electron을 **시드하지 않은 빈 userData**로 띄운다. 그 Electron은
`<userData>/Local State`가 없어 **자기만의 임의 OSCrypt 키를 메모리에 새로 만든다**
(`critic-m2-lib`의 `seedLocalState` 주석이 바로 그 함정을 적어 뒀는데 §B에서만 쓴다).
그 프로필에서는 **어떤 v10도** 풀리지 않는다 — Electron 자신이 다른 프로필에서 만든 v10도 실패한다.

증거(같은 Electron 코드, 같은 암호문, Local State만 다르게):

| 대상 | 프로필 | 결과 |
|---|---|---|
| 3.0이 쓴 v10(하네스가 남긴 `%TEMP%/ccg-critic-m2-key.txt` 그대로) | 시드 없음(=§5b 형상) | `Error while decrypting the ciphertext provided to safeStorage.decryptString.` |
| **같은 암호문** | 설치본 Local State 시드 | **복호 성공** — `sk-ant-critic-m2-0000-TEST-9999` |
| Electron이 시드 프로필에서 만든 v10 | 시드 없음 | 실패(같은 에러) ← 하네스 형상이 v10 자체를 못 읽는다는 증명 |
| 3.0이 쓴 DPAPI(R1 포맷) | 시드 있음/없음 둘 다 | `Ciphertext does not appear to be encrypted.` ← **포맷 거부**(에러 문구가 다르다) |

에러 문구가 *"does not appear to be encrypted"*(포맷 거부) → *"Error while decrypting"*(키 불일치)로
**바뀌었다는 것 자체가 D6이 고쳐졌다는 지표**다. 크리틱 진단(“Electron이 `v10` 접두사를 검사해
DPAPI 폴백 전에 거부한다”)은 정확했고, 그 검사를 통과하도록 고쳤다.
→ 하네스 §5b/§C는 `seedLocalState(ud)` 한 줄이면 green이 된다(크리틱 소관이라 건드리지 않았다).

## R2.7 나머지 (D8·D10·D11·D12·D13·D16)

| # | 수정 요지 | 확인 |
|---|---|---|
| **D8** | `is_migrated()` = `migratedAt` **∧** `boards/index.json` 존재. `ensure_migrated()`는 `ok:false`면 `ONCE`를 소비하지 않고 다음 통합 채널 접촉에서 재시도 | `a_torn_commit_is_not_read_as_complete` · kill 하네스 `tornCommitSeen: []` |
| **D10** | `id_map`은 **먼저 온 매핑이 이긴다**(`entry().or_insert()`), 겹치면 `graph_ambiguous` 경고 | 손상 6번 `holdOn:["c-aaa"]` · `btwEdges:[{child:"s-yyy",parent:"c-aaa"}]`(R1은 `sc-c-aaa`) |
| **D11** | 패널 결정론 id가 `taken`과 겹치면 `-b`,`-c`… 로 비운다 | 손상 11번 `orderHasDup:false`, 두 대화 다 생존 |
| **D12** | `status`를 **레코드에도** 남기고(`ChatLite.status`), `status.json`이 없으면 그 값으로 재구성 | E2 `afterDelete` == `withFile`(`w-1:"done"`) |
| **D13** | `index.activeGen` 단조 카운터 — `chats:set-active`가 한 번이라도 쓰인 스토어에서는 `chats:save`가 `activeChatId`를 못 바꾼다 | F2 `overwritten:false` · `set_active_wins_against_a_later_stale_save` |
| **D16** | `cargo test -p ccg-store` **13 → 54**. 새로 채운 모듈: `chats_v3`(6) · `legacy_bridge`(11) · `fanout`(4) · `boards`(4) · `migrate_v3`(+10) · `prefs`(3) · `safe_storage`(+2) | — |

`origin`(D9)은 크리틱 최소안 그대로: 기본값을 **`unknown`**으로 내렸다 — 모르는 칸은 아무도
못 지우고 옛 목록에도 안 낀다. 스펙 §4.1 필드 목록에 **수명 명시**(별칭 계층과 함께 소멸)로
`origin`·`status`·`legacyAccount` 3줄을 추가했다. 크리틱이 권한 **차기 대안**(별칭 계층이
"내가 넘겨준 id 집합"을 들고 prune 범위를 그 교집합으로 제한)은 §R2.9 계획에 올린다 —
이번 라운드에 그 자료구조의 **절반**은 이미 섰다(`PROJECTED`·`HANDED_BOARDS`).

## R2.8 그 밖에 이번 라운드에서 같이 닫힌 것

- **D7(추가 채팅 도달 불가)** — `session-wins:list`를 통합 별칭이 가로채 **영속된
  `origin=session` 채팅 + 열린 창**을 합쳐 준다(2.6.2처럼 닫힌 것도 `open:false`로 남는다).
  창 소유는 그대로 셸(`win.rs`, 경계 밖)에 있다. 실측: 합성 홈 `reachableInUi: 2`(R1은 0).
  **남은 구멍**: `session-wins:changed` 브로드캐스트는 여전히 `win.rs`가 열린 창만 실어 보낸다
  (창이 열리고 닫히는 순간 목록이 한 번 짧아진다). `win.rs`가 경계 밖이라 다음 라운드.
- **D14(손상 전역 pref가 값을 뒤집음)** — `prefs::read_ui_prefs_salvaged()`가 **마지막으로
  온전히 끝난 상위 쌍까지** 건져 쓰고 `globals_unreadable` 경고를 남긴다. 값을 지어내지 않는다
  (반쪽 값은 버린다). 실측: 손상 14번 `billing.kind: "api_key"`(R1은 `subscription`으로 굳음).
- **C4(부분 `ma:save`가 남의 보드를 지움)** — D1과 같은 판별을 보드에 적용했다:
  `HANDED_BOARDS`(이 채널로 내준 적 있는 보드)만 삭제 후보다. 렌더러가 실제로 들고 있던
  세션을 지우는 정상 경로는 그대로 산다(`deleting_a_session_the_renderer_actually_holds_still_works`).

## R2.9 검증 게이트의 눈 교체 (크리틱 §7 — 가장 큰 격차)

`scripts/poc-chat-unify-migrate.mjs`가 마이그레이터와 같은 눈을 쓰던 세 자리를 바꿨다.

| 자리 | R1 | R2 |
|---|---|---|
| before/after 인벤토리 | `index.order`를 통해 항목을 센다 | **디렉터리의 파일**이 목록을 만들고 인덱스는 *순서*만 준다. `notInIndex`·`missingFiles`·`unreadable`을 리포트에 남긴다 |
| 값 비교 | before/after 둘 다 **자기 매핑 미러**를 통과한 값 | + **원본 리프 전수 감사**(`leafAudit`) — `picker.account`·codex 모델·`refDirs`·매핑표 밖 상위 키가 목적지에서 되찾아지는지 |
| 멱등 | 개수·id 집합 | **내용 해시**(`storeContentHash`, `migratedAt`만 제외) + "3.0에서 쓴 뒤 재실행" 케이스 |
| 사라진 항목 | 무조건 실패/무시 | 마이그레이터가 **스스로 신고한** 드랍은 경고, 신고 없이 사라진 것만 **실패** |

스펙 §5.2에 *"before는 인덱스가 아니라 디렉터리에서 만든다"* 한 줄, §5.3-5에 내용 해시 규칙을 넣었다.

**교체된 눈으로 실홈 복사본 재검증** (`node scripts/poc-chat-unify-migrate.mjs --clone-from-real`):

```
채팅 5개(본채팅 1 + 패널 4) · 메시지 316 → 316 · 마이그레이션 61 ms
정체성 1차 불일치 0 / 5    2차 불일치 0 / 5 · 미수행 0
리프 전수 감사 손실 0      디스크 기준 before: notInIndex 0 · unreadable 0 · missingFiles 0
after: orphanFiles 0 · missingFiles 0
멱등: ids ✔ · contentHash ✔    재마이그레이션 clobbered: false (keptV3 5)
롤백: 옛 3디렉터리 바이트 동일 ✔ · 스테이징 잔여물 0 · backup-2.6.2-* 존재 ✔
판정: PASS
```

같은 실행에서 픽스처 홈(메시지 471)과 부하 픽스처(311채팅 / 15810메시지)도 PASS.

## R2.10 남은 것 (R1 §6 갱신)

1. `chat:*` 13채널 · `win:chat-*` 4개 · `chat:status` 브로드캐스트 — M-LOGIC 소관(변동 없음).
2. **`session-wins:changed` 브로드캐스트**가 영속 목록을 안 싣는다(`win.rs` = 경계 밖).
   R1의 *"두 살림"* 서술은 **오기였다** — `src-tauri`에 `session-chats` 참조는 0건이고
   실제 증상은 "도달 불가"였다(크리틱 D7). 이번 라운드에 조회는 닫았고 통지가 남았다.
3. **D15 — 종료 flush 미배선.** `status::flush()`를 `RunEvent::ExitRequested`에서 불러야 하는데
   `main.rs`가 경계 밖이다. 지금은 `status::set`을 아무도 안 불러 무해하다.
4. **D17 — 두 크레이트의 `api_key` 변형 바이트가 다르다**(ccg-store `{"kind":"api_key"}` vs
   ccg-engine `+account:null,dropEnvKey:null`). 고칠 자리는 `ccg-engine`의
   `skip_serializing_if`이고 그 크레이트는 경계 밖이다. **ccg-store 쪽을 맞추면 안 된다** —
   크리틱의 독립 미러와 1차 비교가 깨진다.
5. 1000단 중첩 원본 보존(§R2.4) — 큰 스택 스레드로 파싱·직렬화·드롭을 몰아야 한다.
6. `origin` 폐기 계획: 별칭 계층이 채널별 "넘겨준 id 집합"을 들고 prune 범위를
   `(넘겨준 id) ∩ (그 뒤 이 채널이 만든 id)`로 제한한다. `PROJECTED`(채팅)·`HANDED_BOARDS`(보드)가
   이미 그 자리에 있으므로, 다음 라운드에 그 둘을 집합으로 승격하면 레코드 필드가 사라진다.
7. 2차 정체성 키를 실물 `RunIdentity::hash()`로 — 크리틱이 `m2-r1-identity.json`에서
   실홈 5/5 성공을 이미 실측했다. 하네스에 붙이는 일만 남았다.

## R2.11 재현

```bash
cargo build -p ccg-store --features cli
cargo test  -p ccg-store                      # 54 passed
npx tauri build                               # target/release/agentcodegui.exe (크리틱 tauri 하네스용)
node docs/critic/tools/critic-m2-migrate.mjs
node docs/critic/tools/critic-m2-damage.mjs
node docs/critic/tools/critic-m2-kill.mjs
node docs/critic/tools/critic-m2-semantics.mjs
node docs/critic/tools/critic-m2-tauri.mjs    # 5b는 §R2.6 — Local State 미시드
node docs/critic/tools/critic-m2-api.mjs      # C는 §R2.6 — 같은 원인
node scripts/poc-chat-unify-migrate.mjs --clone-from-real --fixture --synthetic
```

`target/release/agentcodegui.exe`가 다른 프로세스에 잡혀 있으면
`CARGO_TARGET_DIR=%TEMP%/ccg-m2-target npx tauri build` 후 결과물을
`%TEMP%/ccg-critic-m2-app.exe`로 복사하면 된다(크리틱 tauri 하네스가 그 경로를 먼저 본다).
