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
