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

---

# §R2 — 크리틱(`docs/critic/m7-r1.md`) 대응

크리틱이 낸 제품 결함 7건(치명 2 · 중 4 · 소 1)을 전부 고치고, **크리틱이 만든 도구로**
다시 쟀다. 자기 채점을 하지 않기 위해 판정 도구는 한 글자도 안 고쳤다 —
`docs/critic/tools/m7-*.mjs` · `critic-m7-drive` · 가짜 서버 `m7-fakelsp.mjs` 그대로다.
산출은 `docs/critic/m7-r2-*.json`(크리틱의 `m7-r1-*.json`은 손대지 않았다) ·
`bench/results/lsp-*-r2.json`(기준 파일 `lsp-*-{2.6.2,3.0.0}.json` 무접촉).

**측정 조건**: 같은 기기(i7-13700KF · Win11 26200), **빌더 4명 동시 주행 중**.
크리틱 세션보다 부하가 커서 절대값이 그때보다 크다 — 그래서 R1 판정 대상 exe
(`51a954f` 빌드)를 **같은 세션에서 나란히** 돌려 팔끼리만 비교한다.
빌드는 전부 개인 타깃(`%TEMP%/ccg-m7r2-tgt`)이고 공용 `target/release`는 안 건드렸다
(`bench/lsp.mjs`에 `--exe`를 새로 뚫은 이유).

## R2-1. C-1 [치명] 서버가 죽으면 영영 안 살아나고 `status`는 `ready`라 말한다 — 고쳤다

기전은 크리틱이 짚은 그대로였다: `Rpc`가 EOF로 dispose돼도 `Server.state.status`는
`Ready`로 남아 ① 좀비 스윕(`raw_status()==Error`)에 안 걸리고 ② 매 폴링의 `touch()`가
유휴 TTL을 되감았다.

세 자리를 고쳤다.

| 자리 | 무엇을 |
|---|---|
| `server.rs::raw_status()`·`status()` | `Ready`인데 `rpc.is_dead()`면 **`Error`**. 2.6.2 child `exit` 훅(manager.ts:2632)이 하던 일을 파이프 상태로 대신한다. `wait_ready()`도 죽은 서버에 1.5초를 안 버린다 |
| `manager.rs::start()` | 죽음을 **처음 관측한 시각**을 `died_at_ms`에 찍는다(스윕이 60초 뒤에 와도 복귀가 그만큼 밀리지 않게). 쿨다운 안에는 죽은 그대로 보고 → `status`가 정직하게 `error` |
| `manager.rs::start()` | **`touch()`를 안 한다.** 상태 폴링이 유휴 타이머를 400ms마다 되감으면 파일을 열어 둔 것만으로 TTL이 영원히 안 찬다. 이제 TTL은 **실제 쿼리**(호버·정의·토큰·완성)만 미룬다 |

**실증** — `m7-kill.mjs --watch 45000`, 같은 세션 3팔:

| | electron 2.6.2 | tauri R1(크리틱) | **tauri R2** |
|---|---|---|---|
| kill 뒤 관측된 `lsp:status` | `error`→`starting`→`ready` | **`ready` 하나뿐(45s)** | **`error`→`starting`→`ready`** |
| `lsp:project-status` | `idle`→`ready` | `ready` 하나뿐 | **`idle`→`ready`** |
| 시맨틱 토큰 회복 | **30.9s**(이번 세션 실측) | 회복 없음 | **30.9s** |
| 호버 회복 | 예 | 아니오 | **예** |
| 서버 재기동 | 33.3s(새 PID) | 없음 | **33.3s**(새 PID) |

(R2를 세 번 돌린 값: 토큰 30.5 / 30.6 / **30.9**s · 재기동 32.8 / 32.7 / **33.3**s.
커밋된 `m7-r2-kill-tauri.json`은 마지막 주행이다.)

크레이트 계층(가짜 서버가 ready 뒤 자살)도 같다 — R1은 40초 내내 `status="ready"` ·
토큰 0 · 재시작 0이었고, R2는 `{error, starting, ready}` · **30.0초에 토큰 복귀** ·
`procStarts 2`다(`m7-r2-drive.json` `scenarios.death`).

> 복귀가 30초인 것은 2.6.2 `RESPAWN_COOLDOWN`(30초)을 그대로 지켰기 때문이다.
> 망가진 설치가 스폰 루프를 도는 것보다 30초 쿨다운이 낫다는 2.6.2의 판단을 안 뒤집었다.

## R2-2. C-2 [치명] 편집 버퍼를 디스패처가 버려 저장 전 호버·정의가 오답 — 고쳤다

`ipc/lsp.rs`가 `text`를 크레이트로 넘기고(`hover_at`·`definition_at`),
`server.rs`가 2.6.2 manager.ts:1994와 같은 한 줄 분기를 한다 —
`text`가 있으면 `sync_buffer`, 없으면 `open_doc`.

**실증** — `m7-buffer.mjs`(디스크 앞에 빈 줄 7개 + 7줄 밀린 좌표):

| | electron 2.6.2(크리틱) | tauri R1(크리틱) | **tauri R2** |
|---|---:|---:|---:|
| 버퍼 호버 적중 | 6 / 6 | **1 / 6** | **6 / 6** |
| 버퍼 정의 → `lib.ts` | 6 / 6 | **2 / 6** | **6 / 6** |
| 대조군(디스크 좌표) | 6 / 6 | 6 / 6 | **6 / 6** |

크리틱이 덧붙인 부수 효과(완성이 버퍼를 밀어 넣은 뒤 호버가 디스크로 되엎는 왕복)도
같이 없앴다: `status` 폴링과 `warm`이 부르는 데우기를 **`warm_doc`**(이미 열려 있으면
아무것도 안 함)으로 바꿨다. 디스크 재동기화가 진짜로 필요한 자리(`semantic_tokens`·
`files_changed`)는 그대로 `open_doc`이라 재정확화 눈금은 안 바뀐다(두 주행 110·164ms — 아래 표).

## R2-3. C-3/C-4 [중] cwd 표기로 서버 두 벌 · 프리웜↔첫 status 경쟁 스폰 — 고쳤다

- **키 정규화**: `manager::canon_root()` — `std::fs::canonicalize`(구분자·후행 슬래시에
  더해 8.3 단축명·심볼릭 링크·디스크상 대소문자까지 접는다) 뒤에 키를 만든다. 없는
  폴더에서만 문법적 정규화로 떨어진다. `status`가 400ms마다 부르는 경로라 성공한 결과는
  폴더당 한 번만 syscall하도록 메모한다. `project_state()`의 접두 비교도 같은 함수를 탄다.
- **단일 비행 스폰**: 레지스트리 항목에 `spawning` 플래그를 두고 **자리를 먼저 잠근 뒤**
  스폰을 백그라운드 스레드로 보낸다. 같은 키의 두 번째 진입은 `Starting`을 받고 끝난다.
  R1의 "둘 다 띄우고 진 쪽을 `taskkill`" 경로는 사라졌다.

**실증** — `m7-cwdform.mjs`(가짜 서버로 기동 수를 센다) · `m7-drive-all.mjs`의 `spawnRace`:

| 시험 | R1(크리틱) | **R2** |
|---|---|---|
| `C:\…\ccg-lsp-repo` (정규형) | 뜬 1 · 산 1 | **1 · 1** |
| `C:/…/ccg-lsp-repo` (슬래시) | 뜬 **2** · 산 **2** | **1 · 1** |
| `C:\…\ccg-lsp-repo\` (후행) | 뜬 **2** · 산 **2** | **1 · 1** |
| 프리웜+status 경쟁(5주행) | `2,2,2,2,2` | **`1,1,1,1,1`** |
| 잡 시험의 `serverPidsSeen` | 2개(1개는 이미 죽음) | **1개** |

R2에서는 방아쇠가 **셋**(셸 부팅 프리웜 · 렌더러 프리웜 · 렌더러 첫 status)인데도
실앱 기동 수가 1이다(`m7-r2-cwdform-*.json`).

## R2-4. C-5 [중·게이트] `rpc.rs` 재설계 — 언어가 늘어도 이 파일이 다시 안 열리게

```rust
// spec.rs — 스펙에 자리가 생겼다
pub configuration: fn(&Path, &str /*section*/) -> Option<Value>,
// rpc.rs — arity는 규약이 지키고, 값은 스펙이 준다
fn answer_server_request(method: &str, params: &Value, config: &ConfigFn) -> Value
//   "workspace/configuration" => items.iter().map(|i| config(section_of(i)).unwrap_or(Null)).collect()
```

`Rpc::start`가 `ConfigFn`(= `Box<dyn Fn(&str) -> Option<Value>>`)을 하나 더 받고,
`Server::spawn`이 `move |section| (spec.configuration)(&root, section)`으로 채운다.
`rpc.rs`에는 여전히 언어 이름이 한 번도 안 나온다.

- 가짜 서버가 items 2개로 물었을 때: **`clientAnswered.result = [null, null]` ·
  `lspContractOk: true`**(R1은 `[]` · `false`). 2.6.2 `items.map(() => null)`과 같은 답이다.
- 단위 테스트 4개를 그 자리에 붙였다(`configuration_answer_has_one_element_per_item` ·
  `configuration_values_come_from_the_spec_hook` — 후자는 스펙 훅이 준 값이 실제로 실리고
  **모르는 섹션만 null이 되며 길이는 유지**되는지를 본다).

### pyright 스펙이 정말 값만으로 서는가 (크리틱 §5.1 재시험)

`spec.rs` 헤더에 pyright 항목을 리터럴로 적어 뒀다. 크리틱이 "값으로 담을 수 없다"고
한 네 축의 지금 상태:

| 크리틱이 지적한 축 | R2 |
|---|---|
| `workspace/configuration`(인터프리터·venv) | **`configuration` 필드로 해결.** `rpc.rs` 무수정 |
| `workspace/didChangeConfiguration` 푸시 | **아직 없다.** 설정 UI가 생기는 라운드의 일이다(스펙 필드 하나 + `server.rs` 한 줄) |
| `Provision::Download` + `Launch::Node` 조합 | **아직 없다.** `launch.rs`(게이트 밖) — pyright는 `Bundled`라 해당 없음 |
| 프리웜 언어 감지 하드코딩 | **여전히 `lib.rs`.** py/cs/cpp는 미리 적혀 있어 공짜, 다섯 번째 언어는 `lib.rs`를 연다 |

즉 **pyright는 이제 `SPECS` 한 항목 + `py_configuration` 함수 하나로 선다**(엔진 3파일
무수정). 크리틱의 반증은 유효했고, 그 한 칸을 메웠다.

## R2-5. C-6/C-7 [중·소] 재프라임 5규약 · `watch_exts` · `files_changed` · `cache_version`

**재프라임** — 2.6.2 `primeFullSemantics`(manager.ts:2958)의 규약 다섯을 전부 옮겼다.
R1은 조용 간격 하나였다.

| # | 규약 | R2의 자리 |
|---|---|---|
| ① | `didOpen` 뒤 **최소 1.5초**(2.6.2 실측: 갭 0ms=실패) | `PRIME_MIN_OPEN_GAP_MS` + `last_open_ms`(didOpen 통지 시각) |
| ② | 조용 간격 · **자는 동안 또 바뀌면 다시 기다린다** | 남은 시간을 다시 계산하는 대기 루프 |
| ③ | 프라임 **도중** 변화가 오면 확정하지 않는다 | `dirty_gen`을 왕복 직전에 들고 가 돌아와서 대조 |
| ④ | 히트 0 쿼리 | `query: "zz__semantic_prime__"`(R1은 `""` = 전 심볼 덤프) |
| ⑤ | 동시 요청은 한 번만 프라임 | `running` 플래그 + condvar(2.6.2의 프라미스 공유) |

타임아웃도 2.6.2와 같은 180초로 맞췄다. TS 스펙은 `Reprime::None`이라 지금은 무해하지만,
C#을 붙일 때 `server.rs`를 다시 열지 않는 게 이 작업의 값어치다.

**`watch_exts` 소비 + `files_changed` 실체** — R1의 `files_changed()`는 브로드캐스트
페이로드 조립뿐이었다. 2.6.2 `notifyWatchedFiles`(manager.ts:2337)가 하던 네 가지를
`Server::files_changed`로 옮기고, `manager::notify_files_changed`가 팬아웃한다:

1. `workspace/didChangeWatchedFiles` 통지(`declare_watched_files`와 무관하게 항상 —
   2.6.2의 "pyright류를 위한 최선 노력")
2. **열린 문서의 디스크 재동기화** — 없으면 "낡은 열린 사본"으로 컴파일이 확정된다
3. 삭제된 문서 `didClose`(유령 문서가 컴파일에 남지 않게)
4. 재프라임 예약(`mark_prime_dirty`)

거르는 기준이 `spec.watches_ext()` = `exts` ∪ **`watch_exts`** 다 — C#의
`csproj/sln/slnx/props/targets`가 여기로 들어온다(2.6.2가 `CS_EXTRA`로 하드코딩하던 자리).
브로드캐스트 `exts`도 "그 확장자를 무는 스펙의 뷰어 확장자 전부"로 넓혔다.
**서버가 하나도 없으면 `None`**(2.6.2와 같은 규약 — 갱신할 토큰이 없다).
쏘는 자리(`fs:write-file`)는 여전히 이 라운드의 경계 밖이라 **호출부는 아직 없다.**

**`cache_version`** — R1은 인자를 `debug_assert_eq!`로만 봐서 릴리스에선 무시·디버그에선
패닉이었다("세대 레버"라고 문서에 적어 둔 필드가 아무것도 안 했다). 이제 세대가 2 이상이면
serverId 자리에 붙여(`ts` → `ts2`) **그 서버의 캐시만** 버린다. 세대 1은 2.6.2와 바이트
동일이라 호환이 유지된다 — `m7-cachekey262.cjs`로 재확인:

```
2.6.2 식이 가리키는 자리 : ccg-lsp-repo-90f3e3d7e327e563 / 24 / 24a24ae4ef7a7dca815938b9aa96346e38e1000d.json
3.0 R2가 쓴 자리         : (동일)   → MATCH: true · 2.6.2 검증기로 읽기 ok · 토큰 10,925
```

## R2-6. `ready` 격차 — 크리틱 §3.3 제안 두 개를 적용하고 다시 쟀다

**(a) 방아쇠를 렌더러 밖으로.** 셸이 마지막으로 쓴 프로젝트의 cwd(활성 채팅의 `manualCwd`)를
읽어 부팅 때 한 번 프리웜한다(`ipc/lsp.rs::boot_prewarm`, `main.rs` 한 줄).
**크리틱 제안은 창 생성 직후였는데, 그 자리로는 41ms밖에 안 당겨졌다** — 실측으로
`win::create_main`까지가 이미 수백 ms였다. 그래서 `main()` 첫 줄(단일 인스턴스 락 직후)로
더 당겼다. 앱 spawn → 언어 서버 프로세스 `start`까지(가짜 서버의 wall 로그):

| | R1 | R2(창 생성 뒤) | **R2(main 첫 줄)** |
|---|---|---|---|
| ms | 703 / 818 / 790 | 647 / 819 / 730 | **320 / 76 / 57 / 57** |

**(b) 첫 status가 프로세스 생성을 안 물게.** `status`는 `manager::start()`를 타고,
자리를 잠근 뒤 스폰을 스레드로 넘기고 즉시 `starting`을 돌려준다(C-4도 이걸로 같이 사라진다).

**`m7-ready.mjs` n=7 · p50 · 같은 세션 3팔** (`docs/critic/m7-r2-ready.json`):

| p50 (n=7) | electron 2.6.2 | tauri R1(`51a954f`) | R2(창 생성 뒤) | **tauri R2(최종)** |
|---|---:|---:|---:|---:|
| `window.api.lsp` 등장 | 90.8 | 117.6 | 112.5 | 133.6 |
| 첫 `lsp:status` 왕복 | 10.1 | 61.4 | 51.2 | 55.3 |
| 첫 status → `ready` | 126 | 522 | 509 | **55** |
| **`ready`** | **238.2** | **625.0** | 606.3 | **188.9** |
| 첫 status가 돌려준 값 | `starting` 7/7 | `starting` 7/7 | `starting` 7/7 | **`ready` 7/7** |

**격차가 뒤집혔다**: 같은 세션에서 R1은 2.6.2보다 +386.8ms, R2는 **−49.3ms**(2.6.2보다 빠르다).
첫 status가 7/7 `ready`인 것이 핵심이다 — 렌더러가 처음 물을 때 서버는 이미 다 섰다.
(중간판 열은 "창 생성 뒤 프리웜"으로는 왜 부족했는지를 남긴 것이다 — 606.3ms.)

정직하게 남는 것 둘:

- **첫 status 왕복이 아직 57ms**(2.6.2는 10ms). 이건 LSP가 아니라 크리틱 §3.1이 밝힌
  "문서 시작부터 ~230ms 창"의 비용이고, `m7-ipcwarm.mjs`를 다시 돌려도 그대로다
  (A팔 first 5.4ms · restMax 151.6ms — 그 창에 걸린 호출이 누구든 문다).
  **선워밍은 여전히 처방이 아니다**(§3.1이 기각했다) — 셸 부팅 프리웜은 *더미 호출*이
  아니라 *진짜 방아쇠를 앞당긴 것*이라 성질이 다르다.
- `window.api` 등장이 아직 +27ms(preload 대 번들). 서버가 그전에 이미 준비되므로
  `ready`에는 더 이상 영향이 없다.

## R2-7. 비교표 재주행 (`bench/lsp.mjs both --out -r2`)

두 번 돌렸다(run1은 중간판 exe, **run2가 커밋된 코드**). 표는 run2를 적고 run1을 괄호에 남긴다 —
동시 주행 4명의 노이즈가 커서 한 주행만 적으면 그 흔들림이 감춰진다.

| 눈금 | electron 2.6.2 | tauri 3.0.0 **R2** | 판정 |
|---|---:|---:|---|
| prewarm → `status:ready` | 225 (200) | **169** (164) | **뒤집혔다**(R1은 +217~290ms 뒤졌다) |
| 첫 색칠 · 캐시 미적중 | 872 (1,257) | **673** (559) | 3.0이 앞선다(서버가 이미 서 있다) |
| 첫 색칠 · 캐시 적중 | 116 (96) | ~~280 (198)~~ → **174~191** | ~~3.0 +164ms~~ → **+48ms** — **아래 정정** |
| 토큰 왕복 | 41 (44) | 38 (31) | 대등 |
| 캐시 호출 첫/p50 | 4.7 / 4.7 | 15.3 / 8 | 첫 호출은 §3.1 창 |
| 호버 p50/p95 | 2.3 / 3.7 | 2.7 / 3.5 | 대등 |
| 정의 p50/p95 | 1.4 / 2.5 | 2.5 / 4 | 대등(~1ms 뒤) |
| 완성 p50/p95 | 8.1 / 34 | 16.8 / 63.5 | 3.0이 뒤진다(run1은 12.4/38.1 — 주행 편차가 크다) |
| 재정확화 | 114 (104) | 164 (110) | run1 대등 · run2 +50ms(폴링 한 틱) |
| fps 워밍/유휴 · 긴 프레임 | 56.7 / 60 · 3 | 58.5 / 60 · 2 | 둘 다 60fps |
| 시맨틱 토큰 수 | **10,925** | **10,925** | 동일 |
| 호버·정의 적중 | 48/48 · 34/34 | 48/48 · 34/34 | 동일 |
| 뷰어 실화면 | **5/5** | **5/5** | 동일 |
| 유휴 회수 | 주입 불가 | 회수 + 재기동 **639ms** (590) | ✔ |

> ### ⚠ 정정 (R19 확인 크리틱 — `docs/critic/r19-confirm.md` §2.1·§2.2)
>
> **이 자리에 원래 적혀 있던 "캐시 적중 첫 색칠이 198 → 280ms로 나빠졌다(3.0 +164ms)"는
> 회귀는 실재하지 않는다.** 크리틱이 기준 바이너리(`ccg-r19c-baseA.exe`)로 같은 기계에서
> `both` 1회 + tauri 6회를 다시 돌렸다(`--out -r19c*`, 기준 결과 파일 무접촉):
>
> | 팔 | warm 캐시적중 첫 색칠 |
> |---|---:|
> | electron 2.6.2 | **130** |
> | 3.0 boot (A · 기준 exe) | **174** |
> | 3.0 boot (B1 · B2) | **181 · 178** |
> | *(위 표가 적은 R2 값)* | *280* |
>
> **6회 주행이 전부 174~191ms다. 280은 한 번도 재현되지 않았다** — 단발 표본의 잡음이었다.
> 실제 격차는 130 대 ~178 = **+48ms**다.
>
> 붙였던 인과("부팅 프리웜이 앱 기동과 CPU를 나눠 쓰는 거래")도 **반증됐다.** 크리틱이 같은
> 바이너리에 레버 하나(`CCG_PREWARM_AT`)를 파고 팔을 번갈아 돌린 A/B(§2.2):
>
> | 팔 | warm 캐시적중 | warm ready |
> |---|---:|---:|
> | boot(현행 · `main()` 첫 줄) | 174 · 178 · 181 | 173 · 177 · 180 |
> | mounted(`win:mounted` 뒤) | **182 · 191** | **494 · 530** |
> | delay:400 | 183 | 406 |
>
> 프리웜을 마운트 뒤로 통째로 밀어도 **캐시 적중은 안 움직이고**(노이즈 폭 안) **ready만
> 3배 나빠진다.** 즉 프리웜이 그 자리를 먹고 있던 게 아니다 — 캐시 적중 첫 색칠의 바닥은
> "언제 `window.api`가 생기나"이고, 그 자리는 이미 §R2-9 #4가 지목한 **첫 IPC 창**이다
> (`window.api`가 preload가 아니라 번들 실행 뒤에 생긴다). **거래는 없었으므로 "리드가 고를
> 문제"도 없다** — 현행(`main()` 첫 줄)이 두 눈금 모두에서 옳고, +48ms를 줄이려면 프리웜이
> 아니라 첫 IPC 창을 건드려야 한다.
>
> (2.6.2의 그 회차 cold 수치가 나쁜 것(525/2228)은 크리틱이 방금 `out/`을 새로 구워
> 페이지 캐시가 차가웠기 때문이다 — 위 정정은 **warm 열끼리만** 비교한 값이다.)

## R2-8. 크리틱 도구 전량 재주행 결과

| 도구 | 결과 |
|---|---|
| `m7-drive-all.mjs`(가짜 서버 8종) | `dupopen` didOpen/URI **1** · 생존 · `storm(sync2)` range 없는 didChange **0** / 총 7,884B · `storm(sync1)` 120건 전부 range 없음(규약대로) · `config` **lspContractOk true** · `death` **error→starting→ready · 30.0s 회복** · `cache` **패닉 0** · `manydocs` didOpen 400 / didClose **368**(=400−32) · 축출 뒤 재개통 ok · `spawnRace` **1,1,1,1,1** |
| `m7-kill.mjs`(tauri·electron) | 위 R2-1 표 |
| `m7-buffer.mjs` | 6/6 · 6/6 · 6/6 |
| `m7-cwdform.mjs`(back/fwd/trail) | 전부 기동 1 · 생존 1 |
| `m7-ready.mjs`(n=7 × 3팔) | 위 R2-6 표 |
| `m7-lifetime.mjs` | 유휴 회수 1→0 · 재기동 **37ms** · 잡 안전망 leaked **0** · `serverPidsSeen` **1개** |
| `m7-cachekey262.cjs` | 버킷·키·본문 2.6.2와 동일(MATCH true · 토큰 10,925) |
| `m7-bigapp.mjs`(3,000 .ts + nm 15,000) | 600파일 연속 열기 **600/600 토큰** · 파일당 **13.97ms** · 그 구간 fps **60.0 / 긴 프레임 0** · 유휴 대조 60.0 · 서버 프로세스 2 → 2(누수 0) |
| `m7-ipcwarm.mjs` | §3.1 재현(첫 창의 비용은 그 창에 걸린 호출이 문다) — 처방 없음 |
| `cargo test -p ccg-lsp` | **32 통과**(R1 24 + 8: 설정 응답 arity·스펙 위임·키 정규화·캐시 세대 레버 등) |

## R2-9. R2에서도 안 고친 것 (다음 라운드)

1. **`lsp:files-changed`를 쏘는 자리가 없다.** 크레이트 쪽은 이제 실체가 있지만
   (`files_changed`가 통지·재동기화·didClose·재프라임을 한다), 호출부는 `fs:write-file`
   경로이고 그 파일은 이 라운드의 경계 밖이다. 호출은 한 줄이다:
   `if let Some(v) = ccg_lsp::files_changed(&paths) { app.emit(ch::LSP_FILES_CHANGED, v) }`.
2. **`workspace/didChangeConfiguration` 푸시**와 **`Provision::Download`+`Launch::Node`**
   조합은 여전히 없다(§R2-4 표).
3. **프리웜 언어 감지**가 `lib.rs`에 하드코딩(ts/py/cs/cpp). 다섯 번째 언어는 그 파일을 연다.
4. **첫 IPC 창 ~230ms**(크리틱 §3.1)는 LSP 밖의 문제로 남는다 — 캐시 적중 첫 색칠의
   ~~+102ms~~ **+48ms 전부**가 그 창 안에 있다.
   → **정정·승격**: R19 확인 크리틱의 프리웜 A/B(§R2-7 정정 상자)가 이 항목을 **유일한
   원인**으로 못 박았다. 프리웜을 어디로 옮겨도 캐시 적중은 안 움직인다 — 다음 라운드가
   그 +48ms를 원하면 손댈 자리는 여기 하나뿐이다.
5. **캐시 파일 쓰기가 비원자**(`fs::write`)고 손상 파일을 스스로 안 지운다(크리틱 C-10의
   하드닝 여지). 심각도가 낮아 이번에도 안 건드렸다 — `ccg_store::write_atomic`으로
   바꾸는 것이 다음 자리다.
6. 유휴 TTL이 이제 **실제 쿼리에만** 미뤄진다. 뷰어를 열어 둔 채 10분간 아무것도 안
   물으면 회수되고, 다음 호버가 재기동 비용(실측 590~639ms)을 문다. 2.6.2는 상태 폴링이
   TTL을 되감아 그런 회수가 없었다 — **의도한 차이**이고(그 되감기가 C-1의 기전이었다)
   프리웜+디스크 캐시가 복귀를 싸게 만든다는 전제 위에 있다.

---

# §R3 — Python(pyright) · C#(Roslyn) 개통, 그리고 "스펙 한 항목"이라는 주장의 실측

R2는 이렇게 적었다: *"pyright는 이제 `SPECS` 한 항목 + `py_configuration` 함수 하나로 선다
(엔진 3파일 무수정)."* R3은 그 문장을 **실제로 붙여서** 검증하는 라운드였다.
**절반은 맞았고 절반은 틀렸다.** 아래는 그 절반씩을 숫자로 적은 것이다.

- 크레이트: `crates/ccg-lsp/`(`spec.rs`·`server.rs`·`launch.rs`·`lib.rs`·**신규 `install.rs`**)
- 라우트: `src-tauri/src/ipc/lsp.rs` · 하네스: `bench/lsp.mjs` · 픽스처: `bench/lspfix.mjs`
- 결과: `bench/results/lsp-{electron-2.6.2,tauri-3.0.0}-r3{ts2,py2,cs2}.json`
  (기준 파일 `lsp-*-{2.6.2,3.0.0}.json`·R2의 `-r2` 무접촉)
- 크리틱 도구 재주행: `docs/critic/m7-r3-*.json`(크리틱의 `m7-r1-*`·`m7-r2-*`는 무접촉)
- 측정 조건: i7-13700KF · Win11 26200 · **빌더 4명 동시 주행 중**. 3.0 exe는 개인 타깃
  (`%TEMP%/ccg-m7r3-rel`)에서 구웠고 공용 `target/release`는 안 건드렸다.

## R3-1. 확장점 검증 — 엔진 3파일 diff 줄 수 (이 라운드의 본론)

R1이 못 박은 판정 기준은 **"언어를 붙이는 diff가 `SPECS` 배열 증가로 끝나야 한다.
엔진 파일이 열리면 그 설계는 실패한 것"** 이었다. 실측:

| 엔진 파일 | 추가 줄 | 그중 코드 | 무엇 때문에 |
|---|---:|---:|---|
| `crates/ccg-lsp/src/manager.rs` | **0** | **0** | — |
| `crates/ccg-lsp/src/rpc.rs` | **0** | **0** | — |
| `crates/ccg-lsp/src/server.rs` | 189 | 123 | 아래 분해 |

`server.rs`의 코드 123줄 분해(주석·빈 줄 66줄 제외):

| 갈래 | 코드 줄 | 내용 |
|---|---:|---|
| **py 때문** | **1** | `initialize`에 `capabilities.workspace.configuration: true` 선언 |
| **cs 때문** | **75** | 새 확장점 하나의 호출부 — 멤버십 폴러 23 · 통지 짝 12 · 순수 헬퍼 38(`membership_step`·`membership_stamp`) · 상수/호출 2 |
| **버그 수정**(언어 무관) | **6** | 재프라임 트리거의 라이브 버퍼 조건(R3-5) |
| 테스트 | 41 | 신규 단위 테스트 3개 |

**판정: py는 주장에 가깝게 섰고(엔진 1줄), cs는 안 섰다(엔진 75줄).**
자기 채점을 피하려고 두 줄로 나눠 적는다 —

- **py의 +1줄은 R2의 주장이 틀렸다는 증거다.** R2가 만든 `configuration` 필드는 **죽어
  있었다**: 엔진이 `capabilities.workspace.configuration`을 선언하지 않아 pyright는 그 경로로
  **한 번도 묻지 않았다**(R3 실측 — 아래 R3-4). 필드가 있어도 값이 서버에 닿지 않았다.
  다만 그 한 줄은 **언어 이름이 없는 LSP 클라이언트 능력**이라 다음 언어에서 다시 안 열린다.
- **cs의 +75줄은 "스펙 필드로 표현할 수 없는 함정이 하나 남아 있었다"는 뜻이다.**
  slnx 재생성 → `solution/open` 재통지는 값이 아니라 **행동**이고, R2의 스펙에는 그
  행동을 걸 자리가 없었다. R3은 그 자리를 스펙 필드 두 개로 만들었다:
  `membership_files: fn(&Path) -> Vec<PathBuf>` + `reload_project: Option<fn(&Rpc,&Path)->bool>`.
  75줄은 **그 두 필드의 엔진 쪽 호출부**이고, 거기에 언어 이름은 한 번도 안 나온다.
  2.6.2는 같은 일을 매니저 본문의 C# 전용 메서드 셋(`watchCsSolution`·`watchCsProjectOpen`·
  `watchCsProjects`, 약 150줄, `csproj`/`sln` 하드코딩)으로 했다. **다음 라운드의 판정 기준**:
  C++가 `compile_commands.json`을 멤버십 파일로 대는 것으로 끝나면 이 75줄은 값을 한 것이고,
  또 열리면 이 설계도 틀린 것이다.

경계 밖 파일 diff(참고): `spec.rs` +555/−64(스펙 두 항목 + 훅 함수 + 루트 규칙 본문 + 테스트 8개) ·
`launch.rs` +35/−4 · `lib.rs` +44/−6 · `install.rs` 신규 246줄 · `ipc/lsp.rs` +26/−3.

## R3-2. 언어별 수치표 — 2.6.2 대비 (TS와 같은 눈금)

같은 세션·같은 하네스(`bench/lsp.mjs both --lang <lang>`), 콜드/웜 각 1주행.
모든 "첫 …"은 **문서 시작(navigationStart) 기준**.

| 눈금 | ts 2.6.2 | ts 3.0 | py 2.6.2 | py 3.0 | cs 2.6.2 | cs 3.0 |
|---|---:|---:|---:|---:|---:|---:|
| prewarm → `status:ready` ms | 206 | 295 | 444 | 483 | 2,218 | **1,961** |
| 첫 색칠 · 캐시 미적중 ms | 789 | **576** | n/a | n/a | 5,124 | **4,769** |
| 첫 색칠 · 캐시 적중 ms | 110 | 169 | n/a | n/a | 158 | 167 |
| 토큰 왕복 ms | 31 | 32 | n/a | n/a | 208 | 206 |
| 캐시 호출 첫 / p50 ms | 4.2 / 4.2 | 11.4 / 5.2 | 1.2 / 1.1 | 2.0 / 1.7 | 11.5 / 11.2 | 23.1 / 11.9 |
| 호버 p50 / p95 ms | 2.0 / 3.3 | 2.4 / 3.5 | 1.3 / 1.6 | 1.9 / 3.4 | 4.5 / 8.0 | **3.3 / 7.1** |
| 정의 p50 / p95 ms | 1.3 / 3.3 | 2.2 / 3.3 | 0.8 / 1.2 | 2.2 / 2.7 | 3.1 / 5.9 | **2.5 / 5.2** |
| 완성 p50 / p95 ms | 7.6 / 34.6 | 11.8 / 36.5 | 1.7 / 120.6 | 4.7 / 233.8 | 10.3 / 146.8 | 11.8 / 139.5 |
| 재정확화(토큰) ms | 100 | 117 | 24 | 34 | 328 | 372 |
| 재정확화(호버·교차확인) ms | 2 | 2 | 1 | 2 | 37 | 33 |
| fps 워밍 / 유휴 · 긴 프레임 | 56.8 / 59.9 · 3 | **59 / 60 · 2** | 57.1 / 59.9 · 3 | **59 / 60 · 1** | 58.7 / 60 · 4 | **59.4 / 60 · 2** |
| 유휴 회수 | 주입 불가 | 회수 + 602ms | 주입 불가 | 회수 + 680ms | 주입 불가 | 회수 + 3,281ms |

**정확성(수치보다 이쪽이 중요하다) — 세 언어 전부 결과가 같다:**

| | ts 2.6.2 / 3.0 | py 2.6.2 / 3.0 | cs 2.6.2 / 3.0 |
|---|---|---|---|
| 시맨틱 토큰 수 | **10,925 / 10,925** | 없음 / 없음(서버가 안 냄) | **34,057 / 34,057** |
| 호버 적중 | 48/48 / 48/48 | 48/48 / 48/48 | 48/48 / 48/48 |
| 정의 적중(그중 크로스 파일) | 34/34(24) / 34/34(24) | 34/34(24) / 34/34(24) | 36/36(**26**) / 36/36(**26**) |
| 완성 후보 수 | 4 / 4 | 29 / 29 | 8 / 8 |

읽는 법:

- **요청 계열(호버·정의·완성·토큰 왕복)은 세 언어 모두 대등**하고, C#에서는 3.0이 앞선다.
- **부팅 계열(`ready`)은 주행마다 흔들린다.** 이 주행의 ts는 3.0이 +89ms인데, 같은 세션의
  `m7-ready.mjs`(n=5·p50)는 **3.0 149.2ms 대 2.6.2 203.6ms**로 반대다(R3-7). 4명 동시
  주행에서 `bench/lsp.mjs`의 단발 `prewarmMs`는 한 자리 유효숫자로 읽어야 한다.
- **cs의 유휴 재기동 3,281ms**는 회귀가 아니라 값이다 — Roslyn은 솔루션을 다시 읽는다.
  그래서 스펙의 `idle_ttl_ms`가 30분(2.6.2 `IDLE_TTL_HEAVY`와 같은 값)이다.
- **py의 토큰 칸이 n/a인 이유는 R3-4**에 있다(제품 결함이 아니라 pyright의 사실).

## R3-3. 뷰어 실증 — 실화면에서 색·호버·정의·완성 (CDP)

`window.api`만 두드린 게 아니라 **화면에 뜨는지**를 DOM으로 본다.

| 검사 | ts 3.0 | py 3.0 | cs 3.0 |
|---|---|---|---|
| `viewer-open` | ok (36줄) | ok (36줄) | ok (36줄) |
| 색칠 | ok — 시맨틱 스팬 45 | ok — **문법 색(highlight.js) 스팬 63** | ok — 시맨틱 스팬 227 |
| `viewer-hover-card` | ok 403ms · `FUNCTION NAME makeConfig …` | ok 417ms · `FUNCTION NAME make_config PARAMS id: int name: str …` | ok 416ms · `STATIC METHOD NAME MakeConfig ACCESS public …` |
| `viewer-goto-definition` | ok 257ms · big.ts → **lib.ts** | ok 253ms · big.py → **lib.py** | ok 253ms · Big.cs → **Lib.cs**(다른 프로젝트) |
| `viewer-completion-popup` | ok · 4후보 `lookup register size tagsOf` | ok · 29후보(`register` `lookup` `tags_of` `size` 포함) | ok · 8후보 `Lookup Register Size TagsOf …` |
| **합계** | **5/5** | **5/5** | **5/5** |

(호버 카드의 400ms대는 서버가 아니라 렌더러의 `HOVER_DELAY=300` + 하네스 폴링 200ms다.
서버 왕복은 위 표의 호버 p50 쪽이다.)

**2.6.2 팔은 이 세션에서 3/5로 나왔다 — 그리고 그건 2.6.2의 결함이 아니다.**
실패한 둘은 언제나 **마우스로 하는 두 개**(호버 카드·Ctrl+클릭)이고, 키보드로 하는 완성
팝업은 항상 통과한다. ts·py·cs 세 언어 × 4주행에서 같은 두 칸만 실패했다(R2 때는 5/5였다).
같은 세션에서 **API 계층은 두 앱이 동일**하다 — 호버 48/48, 정의 34/34·36/36(크로스 파일
24·26 동일), 완성 후보 수 동일. 즉 **2.6.2 팔의 합성 마우스 입력이 이 환경에서 안 먹는
하네스 아티팩트**이고 제품 판정에는 쓸 수 없다. 결과 JSON에 그대로 남겼다.

## R3-4. R2의 주장 정정 — 실측으로 뒤집힌 것 넷

### (a) `configuration` 필드는 **죽어 있었다** (엔진 1줄이 필요했다)

`node <pyright>/langserver.index.js --stdio`에 직접 `initialize`를 던져 봤다:

| 클라이언트 능력 | pyright가 `workspace/configuration`을 묻는가 |
|---|---|
| `workspace: { workspaceFolders: true }` (= R2·**2.6.2와 같은 선언**) | **안 묻는다 (0회)** |
| `workspace: { workspaceFolders: true, configuration: true }` | 묻는다 — `python` · `python.analysis` · `pyright` 3회 |

LSP 규약대로다: 서버는 클라이언트가 `workspace.configuration`을 선언해야 물어본다.
2.6.2의 `items.map(() => null)` 핸들러를 실제로 치는 서버는 **Roslyn 하나**뿐이었고
(Roslyn은 능력 선언과 무관하게 razor·html 섹션 4개를 묻는다 — 실측), pyright의 인터프리터
설정은 2.6.2에서도 **한 번도 전달된 적이 없다.** 3.0은 그 한 줄을 선언하고,
`py_configuration`이 인터프리터를 실제로 실어 보낸다.

인터프리터 탐색도 값으로 넣었다: venv(`.venv`/`venv`/`env`) → PATH → `%LOCALAPPDATA%\Programs\Python\*`.
**Microsoft Store 앱 실행 별칭은 거른다** — 이 기계의 `PATH`에 걸리는 `python.exe`는
121바이트짜리 리파스 포인트라 pyright가 stderr에 `Python`만 세 번 뱉고 인터프리터 없이
뜬다(실측). 크기 4KB 미만이면 인터프리터로 안 쓴다.

### (b) pyright에는 **시맨틱 토큰이 없다** (Pylance 전용 기능)

`initialize` 응답에 `semanticTokensProvider`가 없다(실측 · `dist/pyright-internal.js`에
`semanticTokens` 문자열 자체가 0회). 2.6.2도 3.0도 같다 — 파이썬 뷰어의 색은 두 앱 모두
**highlight.js 문법 색**으로 떨어진다. 크레이트는 이 경우 `semantic_tokens`가 `null`을
돌려주고(= "지원 안 함"), 렌더러는 그 신호로 폴링을 멈춘다. 그래서 py 행의 토큰 칸은
"측정 실패"가 아니라 **없는 것**이다. 결과 JSON에 문자열로 남겼다(`noSemanticReason`).

### (c) "하네스는 한 글자도 안 고친다"는 **절반만 맞았다**

R1/R2가 적은 그 약속은 **수치 루프에서는 참**이었다(픽스처가 `hoverAt`·`defAt`·
`completionProbe`·`edit`을 대면 그대로 돈다). 하지만 **뷰어 실증에는 TS 식별자가 네 군데
박혀 있었고**(`big.ts`·`makeConfig`·`lib.ts`·`registry.`), 더 나쁜 건 **"모든 서버는 시맨틱
토큰을 낸다"가 암묵 전제**였다는 것이다(pyright에서 120초 헛폴링이 돈다).
그 둘을 픽스처 필드 다섯(`openName`·`symbol`·`crossName`·`typeText`·`semantic`)으로 뽑아냈고,
그 과정에서 하네스 본문이 **순증 +91줄**(152 추가 / 61 삭제) 바뀌었다. 부수로 고친 것 둘:

- 토큰 위치 찾기를 `span.textContent === '심볼'` → **텍스트 노드 Range**로 바꿨다.
  시맨틱 색이 없으면 highlight.js는 식별자를 span으로 감싸지 않아 옛 방식이 py에서 통째로
  실패했다(이 수정 전 py는 3/5, 후 **5/5**).
- 스크린샷 폴더에 언어를 넣었다 — 안 그러면 py 주행이 ts 스크린샷을 조용히 덮는다.

### (d) `installed_bin` 경로가 2.6.2와 달라서 **C#은 영원히 `need-install`이었다**

R2까지 3.0은 `<앱 홈>/lsp/bin/<id>/<name>`을 봤는데, 2.6.2가 실제로 설치하는 자리는
`<앱 홈>/lsp/<id>/`이고 실행 파일은 버전이 박힌 하위 폴더에 있다
(`tools/net10.0/win-x64/Microsoft.CodeAnalysis.LanguageServer.exe`).
그 자리는 아무도 채우지 않아서 C#은 코드가 다 있어도 기동 불가였다.
2.6.2 `install.ts::findFile`과 같은 **재귀 탐색**으로 맞췄다 — 그 결과
**2.6.2로 이미 받아 둔 159MB 설치를 3.0이 그대로 쓴다(다시 안 받는다).**
`lsp:status`가 400ms마다 이 판정을 하므로 **찾은 결과는 메모**한다(매번 `exists()`로 되짚어
삭제·재설치가 즉시 반영된다).

## R3-5. R3이 벤치로 찾아 고친 실측 버그 — 재프라임이 토큰 응답을 3초 세웠다

첫 cs 주행에서 재정확화가 **2.6.2 328ms 대 3.0 3,285ms**로 벌어졌다. 원인은 재프라임
트리거의 조건 하나였다.

```text
2.6.2 (manager.ts:3098)  if (def.awaitsProjectInit && pre.mtimeMs !== -1)  ← '직전'이 라이브 버퍼였나
3.0 R2 (server.rs)       if !notify_open && mtime_ms != -1                  ← '지금' 밀어 넣는 게 버퍼인가
```

3.0은 **반대편을 봤다.** 완성(라이브 버퍼 푸시)을 한 번 쓰고 나면 그 다음 디스크
재동기화가 매번 재프라임을 예약하고, 이어지는 토큰 요청이 조용 간격(3초)만큼 통째로
세워진다. 두 조건을 **둘 다** 보게 고쳤다(`was_live_buffer`).

| | 2.6.2 | 3.0 (고치기 전) | 3.0 (고친 뒤) |
|---|---:|---:|---:|
| cs 재정확화(토큰) | 328 ms | **3,285 ms** | **372 ms** |
| cs 재정확화(호버 교차확인) | 37 ms | — | **33 ms** |

같은 자리에서 **하네스의 위양성도 하나 찾았다**: `tokensCover`는 "그 **줄 번호**에 토큰이
있나"만 본다. C# 픽스처의 새 심볼이 원래 주석 토큰이 있던 앵커 줄(3790)에 앉아서,
**바뀌기 전 토큰으로도 통과한다.** 그래서 호버로 이름을 직접 확인하는 교차 눈금
(`retokenizeHover`)을 모든 언어에 추가했다. 위 표의 두 번째 행이 그것이고, 그쪽 값이
"디스크 변화를 서버가 알기까지"의 진짜 값이다(cs 33 대 37ms — 대등).

## R3-6. 멤버십 재통지(스펙 필드 두 개)의 런타임 증거

2.6.2의 `watchCsSolution` — *"Roslyn은 솔루션 멤버십을 로드 때 한 번만 읽는다. 외부 도구가
`.slnx`를 재생성하면 새 프로젝트의 모든 `.cs`가 misc(무색)로 남는다"* — 를 스펙 필드로 옮겼다.
엔진은 **언제 부를지**만 알고, 무엇을 보낼지는 스펙이 정한다(`cs_reload_project`).
두 경로가 있다: ① 앱을 거친 변화 통지(`files_changed`) ② 밖에서 일어난 재생성(폴러).

`ccg-lspprobe`로 Roslyn을 실물로 띄운 뒤 `Bench.slnx`를 실제로 건드려 잰 값
(`primed=false` = 재프라임이 예약됐다 = 훅이 돌았다):

| 시나리오 | `primed` | 다음 토큰 왕복 |
|---|---|---:|
| 기준(프라임 유효) | `true` | 347 ms |
| ① 파일 변경 + `files_changed` 통지 | **`false`** | 3,509 ms (조용 간격 3초를 문다) |
| ② 파일 변경만(통지 없음) → 6초 대기 | **`false`** | 79 ms (간격이 이미 지났다) |
| 대조군(아무것도 안 건드리고 6초) | `true` | 79 ms |

②가 `false`인데 대조군이 `true`인 것이 **폴러가 실제로 돌았다**는 증거다.
폴러의 디바운스("한 주기 조용해진 뒤 한 번")는 순수 함수(`membership_step`)로 빼서 단위
테스트로 못 박았다 — 재생성은 삭제→생성으로 지문이 두세 번 튀는데, 중간(빈 솔루션)에
재통지하면 서버가 그 빈 것을 로드한다.

`RootRule::ReferencingSolution`도 본문이 생겼다(2.6.2 `csRootFor` 이식 · UE 특례 제외).
픽스처에 **미끼**를 깔아 실물로 시험한다: `src/App/AppOnly.slnx`(프로젝트 1개, 안쪽) 대
`Bench.slnx`(프로젝트 2개, 바깥). 크레이트 프로브가 고른 서버 루트는
`…\lspbench_cs`(= 바깥)였고, 그래서 크로스 **프로젝트** 정의 이동이 36/36 중 26 전부
`Lib.cs`(Core 프로젝트)로 갔다. 미끼가 이겼다면 이 칸이 0이 된다.

## R3-7. 크리틱 도구 전량 재주행 (판정 도구는 한 글자도 안 고쳤다)

산출은 `docs/critic/m7-r3-*.json`(크리틱의 `m7-r1-*`·`m7-r2-*` 무접촉).

| 도구 | R3 결과 | R2 대비 |
|---|---|---|
| `m7-drive-all.mjs`(가짜 서버 8종) | `dupopen` didOpen/URI **1** · 생존 · `storm(sync2)` range 없는 didChange **0**/총 7,884B · 버전 단조 · `storm(sync1)` 120건 전부 range 없음(규약대로) · `config` **lspContractOk true**(`[null,null]`) · `death` **error→starting→ready · 30.0s 회복 · procStarts 2** · `cache` **패닉 0/8** · `manydocs` didOpen 400 / didClose **368**(=400−32) · 축출 뒤 재개통 ok · `spawnRace` **1,1,1,1,1** | 동일 |
| `m7-kill.mjs`(tauri) | `error→starting→ready` · project `idle→ready` · 토큰 **30.7s** 회복 · 호버 회복 · 재기동 **32.8s**(새 PID) | 동일(R2 30.9/33.3s) |
| `m7-buffer.mjs`(tauri) | 버퍼 호버 **6/6** · 버퍼 정의→lib.ts **6/6** · 디스크 대조군 **6/6** | 동일 |
| `m7-cwdform.mjs` back/fwd/trail | 전부 **기동 1 · 생존 1** | 동일 |
| `m7-ready.mjs`(n=5·p50) | tauri **ready 149.2ms** · 첫 status가 **`ready` 5/5** · electron(n=3) 203.6ms · 첫 status `starting` 3/3 | R2(188.9 대 238.2)보다 양쪽 다 개선 |
| `m7-lifetime.mjs` | 유휴 회수 1→0 · 재기동 **36ms** · 잡 안전망 leaked **0** · `serverPidsSeen` 1개 | 동일 |
| `m7-bigapp.mjs`(3,000 .ts + nm 15,000 · 600파일) | **600/600 토큰** · 파일당 **9.86ms**(R2 13.97) · fps **60/60 · 긴 프레임 0** · 서버 2→2(누수 0) | 개선 |
| `m7-cachekey262.cjs` | **ts·cs 둘 다 MATCH true** — 버킷·키·본문이 2.6.2 식과 동일(ts 10,925 · **cs 34,057** 토큰) | cs로 확장 |
| `cargo test -p ccg-lsp` | **46 통과**(R2 32 + 14) | — |

새로 붙은 단위 테스트 14개 중 값어치 있는 것:
`referencing_solution_prefers_the_biggest_referencing_solution`(미끼 sln이 진짜를 가리는 사고) ·
`slnx_wins_over_sln` · `unrelated_solution_is_not_adopted`(UE 모노레포의 그 사고) ·
`orphan_file_falls_back_to_cwd` · `membership_poller_fires_once_after_one_quiet_tick` ·
`membership_stamp_sees_content_and_list_changes` · `store_alias_is_not_an_interpreter` ·
`three_languages_claim_their_extensions`.

## R3-8. 설치 경로(`lsp:install*`) — 최소로 열었다

C#은 `Provision::Download`라 설치가 없으면 설정 화면에 누를 버튼이 없었다. 2.6.2
`install.ts`의 **최소 이식**을 `crates/ccg-lsp/src/install.rs`(246줄)로 넣고
`ipc/lsp.rs`에서 세 채널을 받는다(`lsp:install` · `lsp:install-server` · `lsp:uninstall-server`).
2.6.2와 같게 지킨 것: 설치 자리(`<앱 홈>/lsp/<id>/`) · **System32 bsdtar 절대 경로**(PATH 앞쪽의
GNU tar는 드라이브 콜론에 질식한다) · 삭제 전 그 폴더에서 도는 프로세스 먼저 죽이기.
의존성 없이 `curl.exe`(Win10+ 기본)로 받고, 없으면 PowerShell로 떨어진다.

**정직하게 다른 것: 진행률 스트리밍이 없다.** `lsp:install-progress`를 쏘려면 크레이트가
창(AppHandle)을 알아야 하는데 그건 이 라운드의 경계 밖이다. 설정 카드는 "준비 중…"에서
완료/실패로 한 번에 넘어간다. 네트워크를 타는 경로라 **이번 라운드에서 실제 다운로드는
돌려 보지 않았다**(측정에 쓴 Roslyn은 실홈 설치를 격리 홈에 정션으로 이어 썼다) —
단위 테스트는 "모르는 id는 거부" · "진행 플래그 수명"까지만 본다. 다음 크리틱이 확인할 칸이다.

## R3-9. R3에서도 안 고친 것 / 다음 라운드

1. **`lsp:files-changed`를 쏘는 자리는 여전히 없다.** 크레이트 쪽(`files_changed`)은 R2부터
   실체가 있고 R3에서 멤버십 재통지까지 붙었지만, 호출부는 `fs:write-file`이고 그 파일은
   이 라운드의 경계 밖이다. 한 줄이다:
   `if let Some(v) = ccg_lsp::files_changed(&paths) { app.emit(ch::LSP_FILES_CHANGED, v) }`.
   **이게 없으면 멤버십 재통지가 열린 뷰어를 못 깨운다** — 서버 쪽은 회복돼 호버·정의·완성이
   바로 맞지만, 이미 칠해진 토큰은 그 문서를 다시 열 때까지 낡은 채로 남는다.
2. **설치 진행률 스트리밍**(R3-8) · **실제 다운로드 미검증**.
3. **`workspace/didChangeConfiguration` 푸시**는 아직 없다(설정 UI가 생기는 라운드).
   지금은 `initialize` 시점의 pull(`workspace/configuration`)만 있다.
4. **프리웜의 언어 감지가 `lib.rs`에 하드코딩**(ts/py/cs/cpp). 네 언어는 미리 적혀 있어
   공짜지만 다섯 번째는 그 파일을 연다. 또 **프리웜은 `root_for`를 안 거친다** — 솔루션이
   하위 폴더에 있는 C# 프로젝트에서는 프리웜이 cwd에 서버를 띄우고 실제 파일 열기는 솔루션
   폴더에 또 띄운다(2.6.2도 같은 구조다. 유휴 회수가 걷지만 30분간 한 벌이 논다).
5. **`ServerSpec::requires`가 하드코딩 한국어**(`".NET SDK 10+ 필요"`). 2.6.2는 `t()`를 썼다 —
   Rust 쪽 문자열이라 렌더러의 i18n을 못 탄다. 계약면에 `{ko,en}`을 실어야 한다.
6. **캐시 파일 쓰기가 비원자**(`fs::write`)고 손상 파일을 스스로 안 지운다(R2 잔여 그대로).
7. **`bench/lsp.mjs`의 2.6.2 팔 합성 마우스 입력**이 이 환경에서 안 먹는다(R3-3).
   3.0 팔은 되므로 A/B의 뷰어 칸만 비대칭이다 — 다음 크리틱이 재현·원인 규명할 자리.

### 남은 언어: C/C++(clangd) 계획

| 필요한 것 | 어디에 | R3에서 이미 선 것 |
|---|---|---|
| `Launch::Exe { extra_args }`로 앱 홈 compile DB 지정 | `SPECS` 항목 | **선다** — cs가 같은 필드로 `--extensionLogDirectory`를 넘긴다 |
| 설치(`clangd-windows-<ver>.zip`, GitHub API) | `install.rs`의 `download_for`에 한 항목 | **선다** — 표만 늘리면 된다(cs와 같은 zip+tar 경로) |
| 백그라운드 인덱싱 `$/progress` 배지 | 엔진에 이미 있다(`on_notify` + `project_state`) | **선다** — clangd가 `window.workDoneProgress` 선언에 gate돼 있고 그 선언은 R1부터 있다 |
| `compile_commands.json` 재생성 → 재인덱싱 | **`membership_files` + `reload_project`** | **이 라운드가 만든 확장점의 두 번째 사용자** — 여기서 엔진이 또 열리면 R3의 75줄이 틀린 것이다 |
| UE compile DB 생성기(`ue-db`) | 새 도메인(스펙 밖) | 안 섰다 — 2.6.2 `ue.ts` 275줄의 이식이 필요하다 |
| `RootRule::NearestMarker`(CMakeLists·compile_commands) | 이미 구현돼 있다 | **선다** |

즉 **C++의 게이트는 하나로 좁혀진다**: `SPECS` 한 항목 + `install.rs` 한 항목 + 픽스처 하나로
끝나는가. 끝나면 R3의 확장점 설계가 값을 한 것이고, `server.rs`가 또 열리면 아니다.

---

# §R4 — C/C++(clangd) 개통, 그리고 R3이 남긴 잔여의 마감

R3은 C++의 게이트를 이렇게 못 박았다: *"`SPECS` 한 항목 + `install.rs` 한 항목 + 픽스처
하나로 끝나는가. 끝나면 R3의 확장점 설계가 값을 한 것이고, `server.rs`가 또 열리면 아니다."*

**결과를 먼저 적는다: `server.rs`는 안 열렸고(코드 0줄), `rpc.rs`도 안 열렸다(0줄).
그런데 `SPECS` 한 항목으로도 안 섰다 — `manager.rs`가 코드 34줄 열렸다.**
그 34줄이 무엇이고 왜 값으로 표현할 수 없었는지가 이 라운드의 본론이다.

- 크레이트: `crates/ccg-lsp/`(`spec.rs`·`manager.rs`·`lib.rs`·`install.rs`·`semcache.rs`·**신규 `cppdb.rs`**)
- 셸: `src-tauri/src/ipc/lsp.rs`(+`ipc/mod.rs` 4줄 훅) · 계약면: `src/shared/protocol.ts`(선택 필드 1개)
- 하네스: `bench/lsp.mjs` · 픽스처: `bench/lspfix.mjs` · 배선 실증: **신규 `bench/lspwire.mjs`**
  (`lsp:files-changed`·`lsp:install-progress`) · cpp `ready` p50: **신규 `bench/lspready.mjs`**
  (판정 도구 `m7-ready.mjs`를 무접촉으로 감싼다 — 그 도구에는 내려받는 서버를 격리 홈에
  이어 주는 훅이 없어 cpp가 영영 `need-install`이었다)
- 결과: `bench/results/lsp-{electron-2.6.2,tauri-3.0.0}-r4{ts,py,cs,cpp}.json`
  (기준 파일 `lsp-*-{2.6.2,3.0.0}.json`·R2 `-r2`·R3 `-r3*` 전부 무접촉)
- 크리틱 도구 재주행: `docs/critic/m7-r4-*.json`(크리틱의 `m7-r1/r2/r3-*`는 무접촉)
- 측정 조건: i7-13700KF · Win11 26200 · **빌더 여럿이 동시 주행 중**. 3.0 exe는 개인
  워크트리(`%TEMP%/ccg-m7r4-wt`)에서 개인 타깃으로 구웠고 공용 `target/release`는 안 건드렸다.

## R4-1. 확장점 검증 — 엔진 3파일 diff 줄 수 (이 라운드의 본론)

| 엔진 파일 | 추가 줄 | 그중 코드 | 무엇 때문에 |
|---|---:|---:|---|
| `crates/ccg-lsp/src/rpc.rs` | **0** | **0** | — |
| `crates/ccg-lsp/src/server.rs` | 5 | **0** | 기존 테스트에 cpp 단언 두 줄(+주석 2) |
| `crates/ccg-lsp/src/manager.rs` | 54 | **34** | 새 확장점 하나의 호출부 — `prepare_once` 14 · `drop_slot` 14 · 호출 1 · 나머지 5 |

**R3이 만든 75줄(멤버십 재통지)은 다시 안 열렸다.** cpp는 그 확장점을 값으로만 채운다 —
`membership_files = compile_commands.json` · `reload_project = cpp_reload_db`. R3이 스스로
걸었던 그 판정에서 R3의 설계는 이겼다.

**그런데 새 확장점이 하나 더 필요했다:** `ServerSpec::prepare_root`.
값(`extra_args`)으로 표현할 수 없는 것이 남아 있었고, 한 줄로 줄이면 이렇다 —

> **인자를 만들려면 먼저 파일을 만들어야 하고, 그 파일이 생기면 이미 뜬 프로세스는
> 틀린 인자로 떠 있다.**

clangd는 `compile_commands.json`이 **있어야** 앱 홈을 가리키는 `--compile-commands-dir`를
받을 수 있는데, UE 프로젝트에서 그 파일은 UnrealBuildTool이 수 초~수 분에 걸쳐 만들어야
존재한다. 스폰 경로에서 동기로 만들 수는 없고(첫 호버가 그만큼 멈춘다), 비동기로 만들면
그 사이에 뜬 clangd는 DB를 모른 채로 떠 있다. R3의 `reload_project`(재통지)로도 안 된다 —
여기서 필요한 것은 재통지가 아니라 **다른 인자로의 재기동**이기 때문이다.

`manager.rs`의 34줄은 그 훅의 호출부다: ① 루트당 한 번 백그라운드로 부르고 ② `true`면
그 자리를 **쿨다운 없이** 비운다. 거기에 언어 이름은 한 번도 안 나온다. 2.6.2는 같은 일을
매니저 본문의 `if (def.id === 'cpp') this.maybeUeDb(cwd)` + `restart('cpp', cwd)`로 했다
(manager.ts:1342·1526 — `cpp` 하드코딩).

**다음 라운드의 판정 기준**: 다섯 번째 언어가 `prepare_root`를 안 쓰면 이 34줄은 안 열린다.
쓰는데도 또 열리면 이 훅의 모양이 틀린 것이다.

경계 밖 diff(참고): `spec.rs` +238/−8(cpp 항목 + 훅 4개 + 필드 2개 + 테스트 4개) ·
**신규 `cppdb.rs` 618줄**(2.6.2 `ue.ts` 275줄의 이식 + 일반 C++ 미러 + 테스트 6개) ·
`lib.rs` +92/−26 · `install.rs` +116/−3 · `semcache.rs` +61/−3 ·
`ipc/lsp.rs` +95/−6 · `ipc/mod.rs` +7/−1 · `protocol.ts` +4(선택 필드 1개).

## R4-2. 4언어 수치표 — 2.6.2 대비 (한 세션·같은 눈금)

`bench/lsp.mjs both --lang <lang>` 콜드/웜 각 1주행. 모든 "첫 …"은 문서 시작 기준.
**ts·py·cs도 이 라운드에 다시 돌렸다** — R4가 공용 경로(토큰 캐시 쓰기·프리웜 루트 해석)를
건드렸으므로 R3 숫자를 그대로 옮기면 거짓말이 된다.

| 눈금 | ts 2.6.2 | ts 3.0 | py 2.6.2 | py 3.0 | cs 2.6.2 | cs 3.0 | **cpp 2.6.2** | **cpp 3.0** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| prewarm → `status:ready` ms | 229 | **178** | 356 | 481 | 1,930 | **1,875** | 257 | 470 |
| 첫 색칠 · 캐시 미적중 ms | 828 | **550** | n/a | n/a | 4,748 | **4,680** | 381 | 544 |
| 첫 색칠 · 캐시 적중 ms | 99 | 164 | n/a | n/a | 148 | 209 | 161 | 172 |
| 토큰 왕복 ms | 33 | 31 | n/a | n/a | 202 | 212 | 13 | 16 |
| 캐시 호출 첫 / p50 ms | 4.2 / 4.3 | 11.0 / 5.4 | 1.9 / 1.4 | 2.9 / 2.0 | 11.2 / 10.9 | 32.2 / 12.5 | 5.2 / 5.0 | 13.4 / 6.1 |
| 호버 p50 / p95 ms | 2.0 / 3.5 | 2.6 / 3.6 | 1.5 / 1.9 | 2.0 / 2.7 | 4.3 / 10.3 | **3.2 / 6.4** | 2.3 / 2.9 | 2.5 / 3.2 |
| 정의 p50 / p95 ms | 1.2 / 2.4 | 2.3 / 3.3 | 0.9 / 2.5 | 2.0 / 2.6 | 3.4 / 13.6 | **2.4 / 13.3** | 1.0 / 1.2 | 1.7 / 2.1 |
| 완성 p50 / p95 ms | 8.1 / 34.2 | 11.6 / 36.7 | 1.8 / 127.1 | 4.1 / 127.3 | 9.8 / 150.6 | 10.2 / **136.5** | 19.3 / 21.7 | 22.2 / 22.9 |
| 재정확화(토큰) ms | 111 | 111 | 32 | 31 | 363 | 451 | 157 | **150** |
| 재정확화(호버·교차확인) ms | 2 | 3 | 1 | 2 | 33 | 79 | 2 | 3 |
| fps 워밍 / 유휴 · 긴 프레임 | 56.2 / 59.6 · 3 | **58.1 / 60 · 3** | 56.2 / 59.6 · 3 | **59 / 60 · 1** | 58.6 / 60 · 3 | **59.4 / 60 · 2** | 57.3 / 60 · 4 | **58.4 / 60 · 2** |
| 뷰어 실증 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** | **5/5** |
| 유휴 회수 | 주입 불가 | 회수 + 632ms | 주입 불가 | 회수 + 640ms | 주입 불가 | 회수 + 3,188ms | 주입 불가 | **회수 + 142ms** |
| **프로젝트 오염** | — | — | — | — | — | — | **있음(3개)** | **없음(0개)** |

**정확성 — 네 언어 전부 두 앱의 결과가 같다:**

| | ts (2.6.2 / 3.0) | py | cs | cpp |
|---|---|---|---|---|
| 시맨틱 토큰 수 | 10,925 / 10,925 | 없음 / 없음(서버가 안 냄) | 34,057 / 34,057 | **13,025 / 13,025** |
| 호버 적중 | 48/48 / 48/48 | 48/48 / 48/48 | 48/48 / 48/48 | **48/48 / 48/48** |
| 정의 적중(그중 크로스 파일) | 34/34(24) 양쪽 | 34/34(24) 양쪽 | 36/36(26) 양쪽 | **36/36(26) 양쪽** |
| 완성 후보 수 | 4 / 4 | 29 / 29 | 8 / 8 | **4 / 4** |

읽는 법(그리고 정직한 단서):

- **요청 계열은 네 언어 모두 대등**하다. C#에서는 3.0이 앞선다(호버 p50 3.2 대 4.3).
- **cpp의 `ready` 470 대 257은 이 표에서 가장 나쁜 칸이고, 그 대부분은 눈금의 흔들림이다.**
  같은 세션에서 `m7-ready.mjs`를 **n=5 p50**으로 돌리면 **3.0 368.5ms 대 2.6.2 330.7ms**로
  격차가 38ms로 줄어든다(R4-7). 단발 `prewarmMs`는 R3이 적은 대로 한 자리 유효숫자로 읽어야
  한다. 남는 38ms의 자리도 같은 도구가 짚어 준다: 첫 `status` 왕복이 **59ms 대 42ms**
  (3.0은 그 호출에서 설치 판정 + 인자 조립을 함께 한다) · `window.api`가 생기는 시각이
  **104.6ms 대 81.2ms**(3.0은 번들 실행 뒤, 2.6.2는 preload — R1부터 알던 구조 차이).
- **cs의 재정확화(호버) 79ms 대 33ms**는 R3(33 대 37)보다 벌어졌다. 이 주행에서만 보이고
  원인을 못 짚었다 — R4에서 안 고친 것으로 아래에 남긴다.
- **cpp의 유휴 재기동 142ms**가 네 언어 중 가장 싸다. 인덱스가 앱 홈 디스크에 남아 있어
  재기동이 "인덱스를 다시 읽는" 일로 끝나기 때문이다(Roslyn은 솔루션을 다시 읽어 3.2초).

## R4-3. 뷰어 실증 — cpp도 실화면에서 5/5

| 검사 | cpp 2.6.2 | cpp 3.0 |
|---|---|---|
| `viewer-open` | ok (36줄) | ok (36줄) |
| 색칠 | ok — 시맨틱 스팬 121 | ok — 시맨틱 스팬 121 |
| `viewer-hover-card` | ok | ok 412ms · `FUNCTION NAME makeConfig MODIFIERS inline PARAMS int id const char * name BenchMode mode = DEFAULT_MODE RETURN BenchConf…` |
| `viewer-goto-definition` | ok | ok 264ms · big.cpp → **lib.h** |
| `viewer-completion-popup` | ok | ok · 4후보 `add(const BenchConfig &)` `size() const` `tagsOf(int id) const` `lookup(int id) const` |
| **합계** | **5/5** | **5/5** |

이 세션에서는 **2.6.2 팔도 네 언어 전부 5/5**로 나왔다. R3-3이 "2.6.2의 합성 마우스 입력이
이 환경에서 안 먹는 하네스 아티팩트"라고 적었던 그 두 칸(호버 카드·Ctrl+클릭)이 이번엔
전부 통과했다 — **간헐적**이라는 뜻이고, R3의 "제품 결함이 아니다"라는 판정을 뒷받침한다.
(같은 cpp를 세 번 돌리는 동안 2.6.2가 3/5로 떨어진 회차가 한 번 있었다.)

## R4-4. 프로젝트 오염 — 표에 새로 생긴 칸(3.0만 통과한다)

clangd는 **compile DB 폴더 옆에** 디스크 인덱스(`.cache/clangd`)를 쌓는다. 즉 DB를 어디에
두느냐가 곧 "사용자 폴더가 더러워지는가"다. 2.6.2는 이 규약을 **UE 프로젝트에만** 적용했고
(`ue-db`), 그 밖의 C/C++은 손대지 않아 인덱스가 소스 트리에 쌓였다. 3.0은 둘 다 앱 홈으로
보낸다 — UE는 2.6.2와 **같은 자리·같은 해시**(`lsp/ue-db/<이름>-<sha1[..8]>`), 그 밖은
원본 CDB를 `lsp/cpp-db/<이름>-<해시>`로 미러한다(CDB의 경로가 전부 절대라 사본이 그대로
유효하다 — 그래서 clangd가 앱 홈의 사본을 읽어도 소스를 찾는다).

같은 픽스처·같은 clangd·같은 주행에서:

| | 2.6.2 | 3.0 |
|---|---|---|
| 프로젝트 폴더(`lspbench_cpp/.cache`) | **파일 3개** | **0개(폴더 자체가 없다)** |
| 앱 홈(`lsp/cpp-db/lspbench_cpp-<해시>`) | 0개 | **4개**(`compile_commands.json` + `.cache/clangd` 인덱스) |

크레이트 계층에서도 같은 결과를 따로 확인했다(`ccg-lspprobe` 단독 주행 뒤 프로젝트 폴더에는
`big.cpp`·`lib.h`·`compile_commands.json`만 남는다).

**하네스가 처음엔 이 칸에서 거짓말을 했다**(정직하게 적는다): 두 팔이 작업 폴더를 공유하므로,
먼저 도는 2.6.2가 남긴 `.cache`를 뒤에 도는 3.0이 그대로 뒤집어썼다(3.0도 "있음(3개)").
팔마다 콜드 앞에서 소스 트리의 흔적을 지우는 `resetTrace`를 픽스처에 넣어 고쳤다.

**2.6.2의 UE 특례를 하드코딩 없이 옮겼다는 증거**: `db_folder_name`이 실홈에 실제로 있는
폴더 이름과 바이트가 같다 — `C:\Code\ElmwoodOnline` → `ElmwoodOnline-683b8183`,
`C:\Code\UE6Study` → `UE6Study-de63668c`(단위 테스트로 못 박았다). 즉 사용자가 2.6.2로
이미 만들어 둔 UE compile DB를 3.0이 **그대로 쓴다**(Roslyn 159MB 재사용과 같은 규약).

## R4-5. R3이 남긴 잔여(§R3-9) — 일곱 항목 마감표

| # | R3이 남긴 것 | R4 | 증거 |
|---|---|---|---|
| ① | `lsp:files-changed`를 **쏘는 자리가 없다** | **닫음** | `ipc/lsp.rs::after_fs_change` + `ipc/mod.rs` 4줄 훅. 실증: 앱에서 `fs:write-file` → **140ms 만에** 전 창 브로드캐스트(`paths` 1 · `exts` 9) → 서버가 새 심볼을 앎(호버가 `benchEdit7`을 말한다) |
| ② | 설치 **진행률 스트리밍 없음** · **실제 다운로드 미검증** | **둘 다 닫음** | 격리 홈에서 clangd를 **진짜로 내려받았다**: `need-install` → 이벤트 7건(`0% → … 26.9MB` → `100% 준비 완료`) → 단조 증가 · 중간값 관측 · exe 실재 → `starting` |
| ③ | `workspace/didChangeConfiguration` 푸시 없음 | **안 함** | 설정 UI가 생기는 라운드의 일(아래 R4-8) |
| ④ | 프리웜 언어 감지가 `lib.rs` 하드코딩 · 프리웜이 `root_for`를 안 거침 | **둘 다 닫음** | 표를 `ServerSpec::detect_markers`로 옮겼다(테스트 `detect_markers_pick_the_project_language`) · 프리웜이 얕은 스캔으로 표본 파일을 찾아 `root_for`를 거친다(`first_source_file` — 예산 600항목·3단·`node_modules` 제외) |
| ⑤ | `ServerSpec::requires`가 하드코딩 한국어 | **크레이트 쪽만 닫음** | `requires: (ko, en)` + 계약면에 `requiresEn?: string`(선택·추가). **렌더러 배선은 안 했다** — `Settings.tsx`는 이 라운드의 경계 밖이다 |
| ⑥ | 캐시 쓰기가 비원자 · 손상 파일을 안 지움 | **닫음** | 임시 파일 → rename(임시 이름에 pid) · 읽다 깨지면 그 자리에서 삭제. **크리틱 도구가 스스로 확인해 준다**: `m7-drive-all`의 `cache.corruptFileStillThere`가 R3 `true` → R4 **`false`**(도구는 한 글자도 안 고쳤다) |
| ⑦ | 2.6.2 팔의 합성 마우스 입력이 안 먹음 | **원인 규명 못 함(간헐)** | 이 세션에서는 네 언어 8주행 전부 5/5. 같은 cpp를 세 번 돌리는 동안 한 회차만 3/5 — 재현 조건을 못 잡았다 |

덧붙여 R3 본문이 "이미 있다"고 적었던 것들을 실물로 다시 확인했다(회귀 없음):
`files_changed`의 네 갈래(재프라임 예약 · 열린 문서 디스크 재동기화 · 삭제 문서 `didClose` ·
`workspace/didChangeWatchedFiles`)는 R2/R3에 들어간 그대로고, R4가 붙인 것은 **그것을 부르는
자리**뿐이다. `watch_exts`는 cpp가 자기 확장자 9개를 실어 브로드캐스트에 반영된다
(위 ① 증거의 `exts` 9개가 그 값이다). `cache_version`은 cpp까지 포함해 스펙별 세대 레버로
살아 있고, 세대 1에서 **2.6.2와 바이트 호환**이다 — `m7-cachekey262.cjs`(2.6.2 식을 직접
계산하는 판정 도구)가 cpp에서도 `MATCH true`(버킷·키·본문 일치, 13,025토큰 · 25타입).

## R4-6. R4가 벤치로 찾아 고친 실측 버그 둘

### (a) 헛재기동 — 방금 뜬 clangd를 곧바로 접었다

첫 설계는 준비 훅이 "DB의 mtime이 준비 전후로 달라졌는가"로 재기동을 판정했다. 그런데
일반 C++ 프로젝트에서는 준비(=원본 CDB 미러)가 **밀리초**에 끝나므로 첫 스폰과 경주가
붙어 **항상** "달라졌다"가 나왔다 — 인자 없이 뜬 clangd가 곧바로 접히고 다시 떴다.

고친 방법: 기준을 시간이 아니라 **인자를 만든 쪽이 본 값**으로 바꿨다. 싼 준비(미러)는
인자를 만드는 자리(`db_file`)가 직접 하고, 준비 훅은 "지금 서버가 물고 간 DB와 다른가"만
본다. 어느 쪽이 먼저 돌든 답이 같다(단위 테스트
`prepare_does_not_ask_for_a_restart_that_is_not_needed`). UE 경로는 그대로다 — UBT가 분
단위로 만들어 낸 DB는 반드시 "다르다"가 되어 재기동이 걸린다(= 2.6.2 `maybeUeDb → restart`).

같은 자리에서 **레이스 하나도 닫았다**: 자리를 그냥 비우면 착지하는 스폰이
`entry().or_insert()`로 자리를 **다시 만들어** 낡은 인자의 프로세스를 꽂는다(그러면 유휴
TTL 30분까지 틀린 서버가 산다). `drop_slot`은 날고 있는 스폰의 착지를 먼저 기다린다.

### (b) `%TEMP%`에 49,370개 — `.uproject` 조상 워크가 폴링마다 그걸 읽었다

cpp의 첫 `ready`가 2.6.2의 257ms 대 **578ms**로 벌어졌다. 원인은 `ue_root`(=`.uproject`
조상 찾기)가 **`lsp:status` 400ms 폴링 경로에 있으면서 부모 폴더를 통째로 읽는다**는 것.
이 기계의 `%TEMP%`에는 항목이 **49,370개** 있고 벤치 작업 폴더가 그 아래라, 폴링 한 번마다
그 목록을 두 번씩 읽었다. 2.6.2는 같은 이유로 `ueDirMemo`를 갖고 있었는데 이식에서 빠졌다.

| | 메모 전 | 메모 후 |
|---|---:|---:|
| cpp `ready`(하네스 단발) | 578 ms | **470 ms** |
| cpp `ready`(`m7-ready` n=5 p50) | — | **368.5 ms**(2.6.2 330.7) |

폴더별 메모(상한 512)를 넣어 닫았다. 정직한 한계: 2.6.2와 같게 **무효화가 없다** — 앱이
도는 동안 `.uproject`를 새로 만들면 다음 실행까지 못 본다.

## R4-7. 크리틱 도구 전량 재주행 (판정 도구는 한 글자도 안 고쳤다)

산출은 `docs/critic/m7-r4-*.json`(크리틱의 `m7-r1/r2/r3-*` 무접촉). `m7-lifetime.mjs`는
`--out`이 없고 크리틱 워크트리의 `m7-r1-lifetime.json`을 덮으므로, **돌리기 전에 그 파일을
백업하고 끝나고 되돌렸다**(표준 출력만 `m7-r4-lifetime.json`으로 받았다).

| 도구 | R4 결과 | R3 대비 |
|---|---|---|
| `m7-drive-all.mjs`(가짜 서버 8종) | `dupopen` didOpen/URI **1** · 생존 · `storm(sync2)` range 없는 didChange **0**/총 7,884B · 버전 단조 · `storm(sync1)` 120건 전부 range 없음 · `config` **lspContractOk true** · `death` **error→starting→ready · 32.0s 회복 · procStarts 2** · `cache` **패닉 0/8** + **`corruptFileStillThere` false** · `manydocs` didOpen 400 / didClose **368** · `spawnRace` **1,1,1,1,1** | 동일 — 단 `cache`의 손상 파일 칸이 **true → false**(§R3-9 ⑥) |
| `m7-kill.mjs`(tauri) | `error→starting→ready` · project `idle→ready` · 토큰 **30.6s** 회복 · 호버 회복 · 재기동 **32.7s**(새 PID) | 동일(R3 30.7/32.8s) |
| `m7-buffer.mjs`(tauri) | 버퍼 호버 **6/6** · 버퍼 정의→lib.ts **6/6** · 디스크 대조군 **6/6** | 동일 |
| `m7-cwdform.mjs` back/fwd/trail | 전부 **ready · 기동 1** | 동일 |
| `m7-ready.mjs`(**cpp** · n=5 p50) | tauri **ready 368.5ms** · 첫 status 왕복 59ms · electron **330.7ms** · 왕복 42ms | 신규(cpp) |
| `m7-lifetime.mjs` | 유휴 회수 1→0 · 재기동 **36ms** · 잡 안전망 leaked **0** · `serverPidsSeen` 1개 | 동일 |
| `m7-bigapp.mjs`(3,000 .ts · 600파일) | **600/600 토큰** · 파일당 **3.25ms**(R3 9.86) · fps **60 · 긴 프레임 0** · 서버 누수 0 | 개선(디스크 캐시 온도 차이가 섞인 값이라 "회귀 없음"으로만 읽는다) |
| `m7-cachekey262.cjs`(**cpp**) | **MATCH true** — 버킷·키·본문이 2.6.2 식과 동일(13,025 토큰 · 25 타입) | cpp로 확장 |
| `cargo test -p ccg-lsp` | **59 통과**(R3 46 + 13) | — |

새로 붙은 단위 테스트 13개 중 값어치 있는 것:
`db_folder_name_matches_262_ue_db`(2.6.2가 만든 UE DB를 못 찾으면 UBT를 처음부터 다시 돈다) ·
`prepare_does_not_ask_for_a_restart_that_is_not_needed`(R4-6a) ·
`mirror_copies_once_and_only_when_newer`(매번 쓰면 멤버십 폴러가 자기 복사에 반응해 무한 재통지) ·
`cpp_points_clangd_outside_the_project_folder` · `cpp_root_is_the_nearest_compile_root` ·
`four_languages_claim_their_extensions`(확장자 중복 주장 금지 + `cache_version` 하한) ·
`detect_markers_pick_the_project_language` · `every_download_spec_has_a_source`(R3에서 cpp가
"설치 버튼은 있는데 눌러도 «알 수 없는 서버»"였던 상태를 다시 못 만들게) ·
`write_is_atomic_and_a_corrupt_entry_heals_itself` · `first_source_file_finds_a_sample_within_budget`.

## R4-8. R4에서도 안 고친 것 / 다음 라운드

1. **`requires`의 렌더러 배선.** 크레이트는 `{ko,en}`을 싣지만 `Settings.tsx`가 아직
   `requires`(한국어)만 읽는다. 그 파일은 이 라운드의 경계 밖이다 — 한 줄이다.
2. **`workspace/didChangeConfiguration` 푸시**는 여전히 없다(§R3-9 ③ 그대로).
   지금은 `initialize` 시점의 pull만 있다.
3. **에이전트 편집은 아직 `files_changed`를 안 탄다.** R4가 배선한 자리는 `ipc_call`의
   파일 채널(`fs:write-file`·`create`·`delete`·`rename`·`move`)이다. 2.6.2는 여기에 더해
   claude/codex 엔진의 도구 편집에서도 불렀다(`engine.ts:2119`·`codex/engine.ts:951`).
   그 파일들은 다른 빌더가 이 라운드에 만지고 있어 손대지 않았다.
4. **UE compile DB 생성은 코드만 이식했고 실물로 안 돌렸다.** 실홈에 UE 프로젝트가 있지만
   (`C:\Code\ElmwoodOnline` 등) 사용자 폴더·엔진 툴체인을 건드리는 경로라 이번 라운드에서는
   읽기만 했다 — 폴더 이름 규칙이 실홈의 실제 폴더와 일치한다는 것까지만 못 박았다.
   UBT 호출·엔진 탐색(레지스트리→런처 목록→추측)·컴파일러 폴백 세 갈래는 **다음 크리틱이
   실물로 확인할 칸**이다.
5. **`cs`의 재정확화(호버)가 이 주행에서 79ms 대 33ms**로 벌어졌다(R3은 33 대 37로 대등했다).
   한 주행뿐이라 원인을 못 짚었다.
6. **`ue_root` 메모에 무효화가 없다**(R4-6b) — `installed_bin` 메모와 같은 계열의 한계인데,
   그쪽은 매번 `exists()`로 되짚는 반면 이쪽은 안 되짚는다.
7. **cpp 픽스처는 표준 라이브러리를 안 쓴다.** 그게 측정의 정직함(툴체인이 아니라 서버를
   잰다)을 위해 고른 값이지만, `<vector>`가 섞인 실물 프로젝트의 콜드 파싱 비용은 이 표에
   없다. UE 실프로젝트 측정과 함께 다음 라운드로.
