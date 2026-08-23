# M7 코드 탐색기 / LSP — R1 보고서

TS/JS 하나를 **끝까지** 개통하고, 그 과정을 잴 눈금(`bench/lsp.mjs`)을 먼저 세워 2.6.2를
같은 방법으로 박제했다. 언어를 늘리는 비용은 `ServerSpec` 한 항목이 되도록 설계했다.

- 하네스: `bench/lsp.mjs` · 픽스처 `bench/lspfix.mjs`
- 기준(2.6.2): `bench/results/lsp-electron-2.6.2.json`
- 3.0: `bench/results/lsp-tauri-3.0.0.json` (변량 확인용 2회차 `*-run2.json`)
- 크레이트: `crates/ccg-lsp/` · 라우트: `src-tauri/src/ipc/lsp.rs`
- 실화면: `bench/shots/lsp-{electron,tauri}/0{1..4}.png`
  (레포 관례상 `bench/shots/**`는 커밋하지 않는다 — 하네스를 다시 돌리면 그 자리에 다시 생긴다)

---

## 1. 무대와 눈금 — 무엇을 어떻게 쟀나

**공정성 = 대칭성.** 두 앱의 렌더러는 같은 화면 코드(2.6.2 `src/renderer` ≡ 3.0 `app/src`)라
계약면도 같다 — `window.api.lsp.*`. 그래서 측정은 전부 **렌더러 안에서** `performance.now()`로
하고(CDP 왕복을 측정에서 뺀다), 표본 루프도 페이지 안에서 돈다. 같은 코드가 같은 입력을
상대로 두 앱에서 돈다.

| 항목 | 값 |
|---|---|
| 작업 폴더 | 이 레포의 로컬 클론(`%TEMP%/ccg-lsp-repo`) — 실 레포는 읽기만 |
| 대형 파일 | `lspbench/big.ts` **3,369줄 / 127,334B** (생성 픽스처, 바이트 결정적) |
| 크로스 파일 | `lspbench/lib.ts` — 정의 이동의 목적지 |
| 표본 | 호버 48 · 정의 34 · 완성 10 |
| 홈 | `%TEMP%/ccg-lsp-home-<kind>` (실홈 격리) |
| 기기 | i7-13700KF · 63.8GB · Win11 26200 |

**생성 픽스처를 쓰는 이유**: 실 레포 파일을 쓰면 다른 빌더의 커밋이 파일을 바꾸는 순간
2.6.2 기준과 3.0 측정이 *다른 입력*을 재게 된다(호버 좌표까지 어긋난다). 생성 픽스처는
시드가 같으면 언제 만들어도 같은 바이트라 기준을 박제할 수 있다.

### 하네스를 만들며 밟은 함정 두 개 (둘 다 수치를 거짓말하게 만든다)

1. **프레임 창이 너무 짧았다.** 처음엔 `prewarm 완료`까지만 rAF를 샘플링했는데 그 창이
   0.5초라 표본이 3프레임이었다 — "24fps"라는 무의미한 숫자가 나왔다. 창을 "문서 시작 →
   첫 색칠"로 늘리고, **유휴 3초 대조군**을 같은 방법으로 함께 재게 했다. 대조군이 없으면
   낮은 fps가 인덱싱 탓인지 창이 가려져 rAF가 스로틀된 탓인지 못 가른다.
2. **'첫 색칠'을 나중에 재면 다른 걸 재게 된다.** 캐시 표본 5회를 앞에 끼워 넣었더니
   '콜드 토큰'이 372ms에서 56ms로 떨어졌다. 좋아진 게 아니라, 그때는 이미 status 폴링이
   `openDoc`을 시켜 서버가 그 문서를 파싱한 뒤였다. 그래서 첫 색칠 경주를
   **문서 시작 시점(`Page.addScriptToEvaluateOnNewDocument`)** 에 걸고 도착 시각을
   `navigationStart` 기준으로 박는다. 부수 효과로 하네스의 접속 속도에도 안 흔들린다.
   (3.0은 CDP를 붙인 뒤 문서가 한 번 더 갈려서, 늦게 심은 프로브가 통째로 사라지기도 했다 —
   `probeSurvived`로 그 사건을 결과에 남긴다.)

**메모리는 재지 않았다** — 4명 동시 주행의 노이즈가 커서 리드가 따로 잰다. 대신 결과 JSON에
**서버 프로세스 목록(이름·PID)** 을 남겨 리드가 그 PID를 바로 재게 했다(`cold.procs`).

---

## 2. 기준(2.6.2) 대 3.0 — TS/JS

같은 세션에서 2.6.2 → 3.0 순으로 연달아 돌린 A/B를 **2회** 주행했다. 모든 "첫 …" 수치는
**문서 시작 기준**. 아래는 두 주행의 범위(run1 / run2)를 그대로 적는다 — 평균을 내면
동시 주행의 흔들림이 감춰진다.

| 눈금 | electron 2.6.2 | tauri 3.0.0 | 판정 |
|---|---:|---:|---|
| prewarm → `status:ready` | **201 / 220 ms** | **483 / 530 ms** | ⚠ **3.0이 ~290ms 늦다** — 겹치지 않는다 (§8-1) |
| 첫 색칠 · 캐시 미적중 | 881 / 818 ms | 788 / 849 ms | 대등 (범위가 겹친다) |
| 첫 색칠 · 캐시 적중 | 115 / 133 ms | 163 / 175 ms | 3.0 +40~50ms |
| 토큰 왕복(문서 아는 상태) | 31 / 29 ms | 31 / 32 ms | 동일 |
| 캐시 호출 첫 / p50 | 6.1 / 4.4 ms | 11.4 / 5.5 ms | p50 대등 |
| 호버 p50 | 2.6 / 1.9 ms | 2.5 / 2.5 ms | 대등 |
| 호버 p95 | 4.4 / 2.9 ms | 3.4 / 3.9 ms | 대등 (주행마다 순위가 뒤집힌다) |
| 정의 이동 p50 / p95 | 1.6·1.2 / 2.9·2.5 ms | 2.2·2.3 / 3.4·3.4 ms | 3.0이 ~1ms 느리다(일관) |
| 완성 첫 후보 p50 / p95 | 10.1·8.0 / 41.5·35.3 ms | 11.6·12.3 / 37.0·37.0 ms | p50 3.0 +3ms · p95 대등 |
| 파일 변경 → 재정확화 | 128 / 118 ms | 110 / 120 ms | 대등 |
| fps 워밍 / 유휴 대조 | 56.4·56.2 / 60·60 | 58.6·58.0 / 60·59.7 | **둘 다 60fps 유지** |
| 긴 프레임(>33ms) | 3 | 2 | — |
| 뷰어 실화면 실증 | **5/5 · 5/5** | **5/5 · 5/5** | §3 |
| 유휴 회수 실측 | 주입 스위치 없음 | **회수 확인 + 재기동 614ms** | §5 |

읽는 법: **부팅 계열(ready·첫 색칠)만 유의미하게 갈리고, 요청 계열(호버·정의·완성·왕복·
재정확화)은 전부 대등**하다. 갈린 한 칸(`ready`)은 두 주행에서 범위가 겹치지 않으므로
노이즈가 아니다 — §8-1에 원인 추적과 함께 적었다.

**정확성(수치가 아니라 결과의 동일성):**

| | 2.6.2 | 3.0 |
|---|---:|---:|
| 시맨틱 토큰 수 | **10,925** | **10,925** |
| 호버 적중 | 48 / 48 | 48 / 48 |
| 정의 적중(그중 크로스 파일 `lib.ts`) | 34 / 34 (24) | 34 / 34 (24) |
| 완성 후보 | 4 — `lookup register size tagsOf` | 4 — `lookup register size tagsOf` |

두 구현이 **같은 토큰 수·같은 후보 목록**을 낸다. 성능이 비슷한 것보다 이쪽이 중요한 판정이다.

동시 주행(4명) 중이라 부팅 계열은 주행 간 ±50~100ms로 흔들린다. **부팅 계열 수치는
한 자리 유효숫자로 읽어야 한다.** 요청 계열은 ±0.5ms 안쪽으로 재현된다.
결과 파일: run1 = `lsp-{electron-2.6.2,tauri-3.0.0}.json`, run2 = `…-run2.json`.

---

## 3. 뷰어 실화면 실증 (CDP, 5/5 양쪽)

`window.api`만 두드린 게 아니라 **화면에 실제로 뜨는지**를 DOM으로 확인한다.

| 검사 | 무엇을 보나 | 2.6.2 | 3.0 |
|---|---|---|---|
| `viewer-open` | 탐색기 → 뷰어에 본문이 뜬다 | ok | ok |
| `viewer-semantic-paint` | `.fv-body [class*="sem-"]` 스팬 45개 — **서버 토큰으로 칠해졌다** | ok (1ms) | ok (0ms) |
| `viewer-hover-card` | `makeConfig` 토큰에 진짜 마우스 → `.lsp-hover` 카드 등장 | ok (416ms) | ok (414ms) |
| `viewer-goto-definition` | Ctrl+클릭 → 제목이 `big.ts` → **`lib.ts`** 로 바뀐다 | ok (260ms) | ok (255ms) |
| `viewer-completion-popup` | Ctrl+E 편집 모드 → `registry.` 타이핑 → 팝업 4후보 | ok (257ms) | ok (258ms) |

(호버 카드의 400ms대는 서버 응답이 아니라 **렌더러의 호버 디바운스**다 —
`HOVER_DELAY = 300`(`app/src/components/FileModal.tsx`) + 하네스 폴링 200ms. 두 앱이 같은
렌더러 코드를 쓰므로 값도 같이 나온다. 서버 왕복은 위 표의 호버 p50 2.5ms 쪽이다.)

스크린샷(하네스가 매 주행마다 다시 남긴다): 3.0의 `02-hover.png`는 아크릴 창 위 뷰어에서
시맨틱 색(타입 청록·함수 노랑·`import type` 구분)과 호버 카드가 동시에 떠 있는 화면이고,
`04-completion.png`는 3,369번째 줄에서 `registry.` 뒤 후보 4개(`lookup`·`register`·`size`·
`tagsOf`)가 메서드/속성 아이콘까지 맞게 뜬 화면이다.

---

## 4. ServerSpec — 확장점 하나

`crates/ccg-lsp/src/spec.rs`. **엔진(`server.rs`/`manager.rs`)에는 언어 이름이 한 번도
나오지 않는다.** 2.6.2는 3,107줄짜리 매니저 본문에 Roslyn/clangd/Verse 특례가 흩뿌려져
있었고, 언어를 하나 더 붙이면 그 절반이 또 자라는 구조였다. 3.0은 그 특례들을 **스펙의
데이터**로 옮겼다.

```rust
pub struct ServerSpec {
    id, label, langs, exts_display, kind: Provision, requires,
    exts: &[(&str /*확장자*/, &str /*languageId*/)],

    launch: Launch,          // Node{module,args} | Exe{bin,args,extra_args(root)}
    root:   RootRule,        // ProjectCwd | NearestMarker | ReferencingSolution{…}

    init_options:      fn(&Path) -> Option<Value>,
    workspace_folders: fn(&Path) -> Option<Vec<(String,String)>>,
    after_initialized: Option<fn(&Rpc, &Path) -> bool>,
    awaits_project_init: bool,

    declare_watched_files: bool,      // ← Roslyn은 false여야 한다
    reprime: Reprime,                 // None | WorkspaceSymbol{ quiet_gap_ms }
    watch_exts: &[&str],

    idle_ttl_ms: u64,                 // bundled 10분 / 무거운 서버 30분
    cache_version: u32,               // 토큰 디스크 캐시 세대
}
```

### 2.6.2에서 피 흘려 얻은 함정 → 스펙 필드 대응표

| 2.6.2에서 밟은 것 | 3.0에서 어디에 사나 |
|---|---|
| Roslyn: `didChangeWatchedFiles`를 선언하면 서버 폴백 워처가 꺼진다 | `declare_watched_files: false` |
| Roslyn: 프라임은 스냅샷 → 변화 뒤 재프라임, **3초 조용 간격** 필수(헛프라임 방지) | `Reprime::WorkspaceSymbol { quiet_gap_ms: 3000 }` |
| C#: 루트는 그 csproj를 **참조하는** sln(UE 모노레포의 무관한 거대 sln 회피) | `RootRule::ReferencingSolution { project_ext, solution_exts, ttl_ms }` |
| clangd/UE: compile DB·인덱스는 **앱 홈**에 | `Launch::Exe { extra_args }` — 스펙이 앱 홈 경로를 만들어 넘긴다 |
| 무거운 서버는 유휴 회수를 길게 | `idle_ttl_ms` |
| 토큰 해석이 바뀌면 옛 캐시를 버려야 | `cache_version` |
| Roslyn: `initialize` 뒤에도 인덱싱이 이어진다(부분 토큰이 굳는 사고) | `awaits_project_init: true` |
| Roslyn: 솔루션을 스스로 안 찾는다 | `after_initialized` |

### 스펙으로 표현하지 **않은** 것 — 엔진 불변식 두 개

스펙 작성자가 잊어도 서버가 죽으면 안 되는 것들은 옵션이 아니라 엔진이 항상 지킨다.

1. **`didOpen`은 문서당 정확히 한 번.**
   2.6.2에서는 `stat`/`readFile`의 await 갭에 동시 요청(status 폴링·warm·semanticTokens·
   hover가 한꺼번에 온다)이 겹쳐 `didOpen`이 두 번 나갔고, Roslyn은 그걸 unhandled
   exception으로 받아 **프로세스째** 죽었다(C# 전멸의 근본 원인). 그쪽 해법은 "await 뒤
   한 틱에 판정·기록·통지를 몰고 pre/cur 동일성으로 레이스를 감지"였다. 3.0은 판정·기록·
   통지가 **`docs` 뮤텍스 한 임계 구역 안**에 있다 — 겹칠 틈 자체가 없다
   (`server.rs::sync_locked`).
2. **`didChange`는 서버가 선언한 `syncKind`를 존중한다.**
   incremental(2)을 선언한 서버에 range 없는 전문 교체를 보내면 Roslyn은
   NullReferenceException으로 죽는다. `content_changes()`가 이걸 강제하고,
   **그 자리에 테스트가 붙어 있다** (`incremental_server_always_gets_a_range`).

### 다음 언어를 붙이는 diff의 모양

`spec.rs`의 `SPECS` 배열에 항목 하나. 헤더 주석에 C# 항목의 리터럴을 실제로 적어 뒀다.
**엔진 파일이 열리면 그 설계는 실패한 것**이라는 게 R2의 판정 기준이다.

---

## 5. 수명 — 유휴 회수 · 좀비 안전망

| | 2.6.2 | 3.0 |
|---|---|---|
| 유휴 TTL | 10분(bundled) / 30분(무거운 서버), 스윕 60초 | **같은 값** (`idle_ttl_ms`, 스윕 60초) |
| 테스트 주입 | 없음 | `CCG_LSP_IDLE_TTL_MS` · `CCG_LSP_SWEEP_MS` |
| 재스폰 쿨다운 | 30초 | 30초 |
| 죽은 핸들 정리 | 스윕이 함께 | 스윕이 함께 |
| 앱이 **크래시로** 죽었을 때 | 종료 훅이 안 돌아 서버가 남는다 | **Windows 잡(KILL_ON_JOB_CLOSE)** — OS가 걷어간다 |

**실측 (3.0, TTL 6초 주입):**
- 유휴 전 서버 프로세스 2개(`ts-ls` + `tsserver`) → TTL 경과 후 **0개** (`reclaimed: true`)
- 다음 요청에 **재기동 614ms**, 새 PID 확인 (`respawnedNewPid: true`)
- 크레이트 단독 프로브에서도 같은 결과: 회수 확인 · 재기동 573ms

**잡 안전망 실측:** 서버 2개를 띄운 채 앱 프로세스를 `Stop-Process -Force`(트리 종료가
**아닌** 방식 — 잡이 없으면 손자 `tsserver`가 살아남는 그 방식)로 죽이고 4초 뒤 확인 →
남은 언어 서버 **0개**. 2.6.2의 종료 훅+`taskkill /T`는 정상 종료 경로에서만 도는 구조라
크래시 경로에서 세트(수백 MB)가 남았다. 잡은 협조가 필요 없다.

2.6.2 쪽은 TTL을 주입할 문이 없어 **10분을 실제로 기다리지 않는 한 실측이 불가능**하다.
그래서 이 칸만 비대칭이고, 그 사실을 결과 JSON에 문자열로 남겼다(`idle.note`).

---

## 6. 토큰 디스크 캐시 — 2.6.2와 **바이트 호환**

`crates/ccg-lsp/src/semcache.rs`. 레이아웃·키·해시가 2.6.2 `src/main/lsp/semcache.ts`와 같다.

```
<앱 홈>/lsp/semcache/<basename>-<cwd sha1 16자>/
  .root                          ← 죽은 프로젝트 GC용
  24/24a24ae4….json              ← sha1("v1\0<serverId>\0<abs소문자>\0" + 내용)
```

Node `crypto`와 바이트가 같아야 해서 SHA-1을 직접 구현하고(`sha1.rs`), **Node가 뱉은 실제
값**을 테스트에 박았다(`matches_node_crypto_exactly`). 그 값을 다시 뽑는 스크립트는
`scripts/poc-lsp-sha1.mjs` — 캐시 키 조립을 손대면 이걸 돌려 테스트 상수를 갱신한다.

**실증 — 3.0이 2.6.2가 쓴 캐시를 읽는다:**
2.6.2 하네스 실행이 남긴 홈을 복사해 3.0 크레이트로 열었다.
- 버킷 이름 동일: `ccg-lsp-repo-90f3e3d7e327e563`
- 파일 키 동일: `24/24a24ae4ef7a7dca815938b9aa96346e38e1000d.json`
- **`cachedHit: true`, 1.58ms, 토큰 10,925** — 라이브 결과와 정확히 같은 수

즉 2.6.2 사용자가 3.0으로 올라오는 **첫 실행부터** 즉시 색칠이 된다.

---

## 7. 크레이트 계층 프로브 — 앱 계층의 몫을 뺄셈으로

`bench/lsp.mjs`가 앱 전체를 잰다면, `crates/ccg-lsp/src/bin/ccg_lspprobe.rs`는 같은 눈금을
**셸 없이** 잰다. 그 차이가 렌더러+IPC의 몫이다.

```
cargo run -p ccg-lsp --features cli --bin ccg-lspprobe -- <cwd> <rel> [표본수]
```

| 눈금 | 크레이트 단독 | 앱 전체(3.0) | 차이 = 렌더러+IPC |
|---|---:|---:|---:|
| prewarm → ready | 106~130 ms | 483 ms | 부팅 경합 포함 |
| 첫 라이브 토큰 | 476~486 ms | 788 ms | ~300 ms |
| 호버 p50 / p95 | 0.59 / 2.99 ms | 2.5 / 3.4 ms | ~2 ms |
| 정의 p50 / p95 | 0.37 / 1.70 ms | 2.2 / 3.4 ms | ~2 ms |
| 완성 p50 | 7.4 ms | 11.6 ms | ~4 ms |
| 캐시 적중 | 1.56 ms | 5.5 ms (p50) | ~4 ms |

이 프로브는 4명이 동시에 셸을 고치는 라운드에서 **남의 컴파일 오류에 내 측정이 막히지
않는 독립 경로**이기도 했다(실제로 이번 라운드에 그 상황이 있었다).

---

## 8. 정직한 한계 — 다음 라운드로 넘기는 것

1. **`prewarm → ready`가 2.6.2보다 ~290ms 늦다** (483·530 vs 201·220 — 두 주행에서 범위가
   겹치지 않는다). 크레이트 단독 프로브는 106~130ms라 **서버 기동 자체는 오히려 빠르다.**
   추적한 것까지: 캐시가 **비어 있어 payload가 null인** 첫 `cachedTokens`도 3.0에서는
   124ms(2.6.2는 2ms)였고 두 번째 호출부터 ~2ms로 떨어진다 → 페이로드 직렬화가 아니라
   **첫 `ipc_call`의 워밍업**이다(blocking 풀 기동/채널 초기화 의심). 원인 규명과 처방은 R2.
   이 지연이 `status` 폴링의 첫 응답을 밀고, 그게 `ready` 관측 시점을 민다.
   **단, 사용자 체감의 대표 눈금인 '첫 색칠'에서는 두 앱이 대등하다** — 순위가 갈리는
   칸과 대등한 칸을 한 줄에 적지 않은 이유다.
2. **Node 런타임을 아직 번들하지 않는다.** `bundle.active=false`인 지금은 개발/벤치 경로
   (레포 `node_modules` + 시스템 `node`)로 돈다. 해석 사슬은 `launch.rs`에 명시돼 있고
   `resources/node.exe`·`resources/node_modules/`가 이미 우선순위 위쪽에 있어, 패키징
   라운드는 파일을 싣기만 하면 된다(코드 변경 없음).
3. **`lsp:files-changed`를 쏘는 곳이 없다.** 상수와 크레이트 함수(`files_changed`)는 있고
   렌더러 구독도 살아 있지만, 쏘는 자리는 `fs:write-file` 경로이고 그 파일은 이 라운드의
   경계 밖이다. TS는 `open_doc`의 mtime 재검사만으로 스스로 회복하므로(재정확화 110ms 실측)
   R1의 기능에는 구멍이 없다. 값어치는 C#처럼 "재프라임 전까지 새 타입이 무색인" 서버에서
   생긴다 — R2에서 함께 배선.
4. **`lsp:install*`(서버 내려받기 UI)는 미구현.** C#/C++가 붙는 R2의 일이다. 지금은
   디스패처가 `{__unimplemented:true}`로 떨어뜨려 심이 채널당 1회 경고를 남긴다.
5. **`RootRule::ReferencingSolution`은 필드만 있고 본문은 R2.** 지금은 안전하게 cwd로
   떨어진다(TS는 `ProjectCwd`라 영향 없음).
6. **Verse 제외**(사용자 결정). 렌더러가 채널을 부르므로 `lsp:verse-*`는 **명시적 안전값**
   (`null`/`[]`)을 돌려준다 — 미구현 경고를 띄우지 않는다. 없는 게 정상이기 때문이다.

---

## 9. 남은 언어 계획 (R2 이후)

| 라운드 | 언어 | 스펙 항목에 새로 필요한 것 | 하네스 |
|---|---|---|---|
| R2 | **Python (pyright)** | `Launch::Node` 재사용 · `RootRule::ProjectCwd` — 사실상 값만 다르다. 가장 싼 두 번째 언어이자 **"스펙 1항목이면 끝"의 첫 검증** | `FIXTURES.py` 추가, `bench/lsp.mjs`는 무수정 |
| R2 | **C# (Roslyn)** | `ReferencingSolution` 본문 · `after_initialized`(solution/open) · `Reprime::WorkspaceSymbol{3000}` · `declare_watched_files:false` · 설치 UI(`lsp:install*`) · 솔루션/DLL 워처 | `FIXTURES.cs` — 참조 관계 있는 sln 2프로젝트 + "외부에서 새 .cs 생성 후 무색 여부" 검사 |
| R3 | **C/C++ (clangd)** | `Launch::Exe{extra_args}`로 앱 홈 compile DB 지정 · 백그라운드 인덱싱 `$/progress` 배지 · UE compile DB 생성기 | `FIXTURES.cpp` — CMake 프로젝트 + compile_commands.json |

**R2의 게이트를 지금 못 박아 둔다**: C#·Python을 붙이는 diff가 `spec.rs`의 `SPECS` 배열
증가 + 픽스처 추가로 끝나야 한다. `server.rs`/`manager.rs`/`rpc.rs`가 열리면(설치 UI 같은
새 도메인이 아니라 **언어 특례** 때문에 열린다면) 이 라운드의 설계가 틀린 것이다.

또 하나: 픽스처가 대는 것은 `{bigRel, libRel, hoverAt, defAt, completionProbe, edit,
editedMarker}` 뿐이고 하네스는 그 모양만 안다. 언어를 늘려도 `bench/lsp.mjs`는 한 글자도
안 고치는 게 설계 의도다.

---

## 10. 테스트

`cargo test -p ccg-lsp` — **24개 통과.** 값어치 있는 것만 추리면:

- `incremental_server_always_gets_a_range` — 불변식 ②. Roslyn을 죽이는 그 페이로드가
  절대 안 나가는지.
- `matches_node_crypto_exactly` — SHA-1이 Node와 바이트 동일(캐시 공유의 전제).
- `key_matches_262_formula` — 캐시 키 조립이 2.6.2 공식과 같은지.
- `absolutize_matches_lsp_relative_encoding` — 상대 좌표 → 절대 좌표(색이 한 줄 밀리는 버그).
- `minimal_change_utf16_positions` — LSP 좌표는 UTF-16. 이모지 뒤 좌표가 어긋나면 편집
  중 서버 문서가 통째로 어긋난다.
- `uri_roundtrip` / `uri_roundtrip_non_ascii` — 한글 경로에서 정의 이동이 죽지 않는지.
- `hover_markdown_flattens_all_shapes` · `map_item_flattens_documentation_shapes` —
  서버마다 다른 응답 모양을 계약면 하나로 접는 자리.
