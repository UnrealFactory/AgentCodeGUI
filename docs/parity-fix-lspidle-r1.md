# LSPIDLE R1 — LSP 유휴 회수 + 온디맨드 기동

*3.0.0-beta · `feature/3.0.0-beta` · 2026-08-31 · 사용자 승인 「성능 패스 ①」*

---

## 0. 한 문단 요약

유휴 상태의 LSP 헬퍼 몫을 **0으로** 만들었다. 방법은 회수가 아니라 **방아쇠**였다 —
유휴 회수(10/30분)는 R1부터 멀쩡히 돌고 있었고, 문제는 「프로젝트를 열었다」만으로
서버가 뜨는 프리웜이었다. 그 한 줄을 「준비만」으로 바꾸니 배포 모사 유휴에서
**프로세스 8 → 5, 전체 WS 579 → 453MB, 전체 Private 354 → 249MB**(헬퍼 몫
125.9/102.7MB가 통째로 0)가 됐다.

**공짜가 아니다.** 부팅과 겹쳐 돌던 서버 기동이 열람 시점으로 밀리면서, 켜자마자 파일을
여는 경우의 **첫 색칠(캐시 미적중)이 654ms → 1153ms**로 늦어졌다(중앙값, n=3 교차 주행).
「다시 쓸 때」를 지키는 눈금인 **첫 색칠(캐시 적중)은 167 → 169ms로 무후퇴**고
호버·정의도 무후퇴다. 그 교환을 아래 §4에 그대로 적는다 — 되돌리는 문
([`Prewarm::Eager`])도 한 글자로 열어 뒀다.

---

## 1. 무엇이 문제였나 — 「회수가 없다」가 아니었다

과제는 「2.6.2에는 유휴 회수가 있는데 3.0 배포본은 헬퍼 3개가 항상 산다」였다.
그런데 코드를 열어 보니 회수는 **이미 있었다**: `manager::sweep_idle`이 60초마다 돌고,
`ServerSpec::idle_ttl_ms`가 2.6.2와 같은 10분/30분이며, `bench/lsp.mjs`의 유휴 프로브가
그것을 실측까지 하고 있었다(`reclaimed: true`).

빠져 있던 것은 **「애초에 안 뜨게 하는 것」**이었다.

```rust
// lib.rs::prewarm — R1까지의 마지막 줄
let _ = manager::start(spec, &root);   // ← 프로젝트를 열면 서버가 뜬다
```

`lsp:prewarm`은 앱이 부팅할 때(`ipc/lsp.rs::boot_prewarm`)와 렌더러가 cwd를 정할 때
(`App.tsx:922`) 불린다. 둘 다 **코드 뷰어와 무관하다.** 그래서 채팅만 쓰는 사용자도
tsls + tsserver + conhost 세 프로세스를 부팅 직후부터 종료까지 물고 있었다.
회수는 그것을 못 막는다 — 회수는 «열람한 적 있는 서버»를 접을 뿐이다.

이 진단이 이 라운드의 방향을 전부 정했다. 그래서 손댄 곳이 회수 로직이 아니라
**프리웜의 정의**다.

---

## 2. 무엇을 했나

### 2.1 온디맨드 기동 — 프리웜을 두 조각으로 쪼갰다

프리웜을 통째로 지우는 것은 답이 아니다. 서버에 넘길 인자를 만들려면 **먼저 파일을
만들어야 하는** 언어가 있고(clangd의 `compile_commands.json` — UBT가 수 초~수 분),
루트를 정하려면 솔루션을 스캔해야 하는 언어가 있다(C#). 그 일들은 **메모리를
상주시키지 않으므로** 앞당겨도 공짜다. 미뤄야 하는 것은 **기동뿐**이다.

그래서 새 스펙 필드 하나로 갈랐다(엔진에는 여전히 언어 이름이 없다):

```rust
pub enum Prewarm {
    Prepare,  // 준비만 — 프로세스는 안 뜬다. 네 언어 전부 이 값.
    Eager,    // R1까지의 동작. 지금 쓰는 스펙 없음(되돌리는 문).
}
```

`Prepare`가 하는 일(`manager::prepare`): 준비 훅(`prepare_root`) · 루트 해석(`root_for`) ·
실행 계획 경로 사슬 메모(`launchable`). 실제 기동은 **그 언어의 파일을 열 때**
(`lsp:status`가 지연 스폰의 방아쇠, `lsp:warm`이 문서 예열) 일어난다.

`Prewarm::Eager`를 남긴 이유는 §4의 교환이 어떤 사용자에게는 안 맞을 수 있어서다.
되돌리는 것 자체는 한 글자지만, **모르고 되돌리는 것**은 못
(`every_shipped_spec_is_on_demand`)이 막는다 — 붉어지면 그 대가가 적힌 주석을 읽게 된다.

### 2.2 유휴 회수 — 규칙을 순수 함수로 꺼내고 두 구멍을 막았다

회수 자체는 이미 돌고 있었으므로 **고친 것은 두 구멍**이다.

**① 인덱싱 중 회수(새로 막음).** §R2-1이 `status` 폴링의 `touch()`를 걷어낸 뒤로 유휴
판정의 기준은 「마지막 **쿼리**」뿐이다. 그러면 **인덱싱만 하는 서버가 유휴로 보인다** —
clangd가 UE 프로젝트를 30분 넘게 인덱싱하는 동안 쿼리가 하나도 없으면 TTL(30분)이 그대로
차서, 회수 → 재스폰 → 인덱스를 처음부터 → 다시 회수…라는 방아를 돈다. 「회수가 체감
손해가 아니다」라는 명제가 거기서 뒤집힌다. 이제 `Server::indexing()`이 참인 동안은
타이머를 **되감는다**(건너뛰지 않는다 — 건너뛰기만 하면 인덱싱이 끝나는 순간 이미 TTL을
넘겨 있어 곧바로 접힌다).

**② 그 유예의 영생(같이 막음).** 진행률 `end`를 영영 안 보내는 서버가 실재하므로,
유예에 **절대 상한 30분**(`IDLE_GRACE_CAP_MS`)을 건다. 유예로 열린 구멍을 유예 안에서 닫는다.

규칙 전부를 순수 함수로 꺼냈다 — 실물 프로세스 없이 불릴 수 있어야 돌연변이가 각각 다른
줄을 붉힐 수 있기 때문이다:

```rust
fn sweep_decision(idle_ms: u64, ttl_ms: u64, indexing: bool) -> Sweep {
    if idle_ms < ttl_ms { return Sweep::Keep; }
    if indexing && idle_ms < IDLE_GRACE_CAP_MS { return Sweep::Rewind; }
    Sweep::Reclaim
}
```

**「회수됨」은 상태로 남는다.** `Entry.reclaimed_at_ms`를 `died_at_ms`와 **일부러 다른
칸**에 뒀다: 죽음은 사고고 회수는 정책이라, 한 칸에 쓰면 회수가 재스폰 쿨다운 30초를 물어
재열람이 30초 멈춘다. 회수된 자리는 쿨다운 없이 즉시 되살아나고, 되살아난 횟수는
`revivals`로 센다(계약면 `ccg_lsp::lifecycle()`).

**C#(Roslyn) 함정의 재발 방지.** 회수는 `Server`를 통째로 버리므로 재기동은 **새 인스턴스**다
— 문서 맵도 프라임 상태도 비어 있어 `didOpen` 중복이 구조적으로 불가능하고, 3초 조용 간격과
`solution/open` 재통지는 새 인스턴스가 처음부터 다시 밟는다. 회수가 그 규약을 «다시 밟는»
것이 맞고, 그게 안전한 쪽이다(상태를 이어받아 되살리는 설계였다면 정확히 그 함정을 밟았을 것이다).

### 2.3 좀비 안전망 — 세 번째 겹

기존 두 겹 위에 하나를 더 놨다:

| 겹 | 무엇을 막나 | 사는 곳 |
|---|---|---|
| ① 잡 오브젝트(KILL_ON_JOB_CLOSE) | **앱이 죽는다**(크래시·강제 종료 포함) | `jobkill.rs` (기존, 안 건드림) |
| ② 유휴 회수 스윕 | 앱은 사는데 **서버가 논다** | `manager::sweep_idle` |
| ③ **핸들 원장**(신규) | 앱도 살고 스윕도 도는데 **회수를 놓쳤다** | `zombie.rs` |

②는 레지스트리에 자리가 남은 서버만 본다. 자리에서 밀려났는데 `shutdown`이 안 불린 핸들,
스윕 스레드가 사라진 뒤에 뜬 서버, `kill_tree`가 실패해 손자만 남은 트리 — 셋 다 ②의 시야
밖이고 ①은 앱이 살아 있는 한 안 돈다.

**PID가 아니라 핸들을 들고 있는다.** 「우리가 띄운 PID를 30분 뒤에 죽인다」는 그 자체로
위험하다 — Windows는 PID를 재사용하고, 그 번호를 물려받은 것은 남의 프로세스일 수 있다.
스폰 직후 `OpenProcess`로 핸들을 열어 끝까지 들고 있으면 그동안 OS가 그 PID를 **재사용하지
않으므로**, 원장의 번호는 영원히 우리가 띄운 그 프로세스다. 이름으로 찾아 죽이는 경로
(`taskkill /IM node.exe`)는 이 파일에 **없다**.

여기에 **스윕 스레드 워치독**도 붙였다. `SWEEPER`는 「한 번만 띄운다」는 래치라, 그 스레드가
사라지면 깃발만 참으로 남고 회수는 영영 안 돈다 — 밖에서는 「서버가 계속 산다」로만 보인다
(이 라운드가 없애려는 증상 그대로다). 맥박(`LAST_SWEEP_MS`)이 주기의 세 배보다 오래
멎었으면 스폰 경로에서 다시 띄운다.

### 2.4 conhost 제거 — 플래그만으로는 절반만 닫혔다

`CREATE_NO_WINDOW`(0x0800_0000)는 「창 없는 콘솔」이라 **콘솔은 만든다** → `conhost.exe`가
따라 뜬다. `DETACHED_PROCESS`(0x8)는 아예 안 만든다. 그래서 스폰 플래그를 바꿨다.

**그런데 그것만으로는 conhost가 사라지지 않고 옮겨갔다.** TypeScript 서버는 두 겹이다 —
우리가 띄우는 것은 `typescript-language-server`이고, 그것이 **자기 손으로** `tsserver`를
`child_process.fork`한다. node의 기본값이 `windowsHide:true`(=`CREATE_NO_WINDOW`)라 그
손자가 콘솔을 새로 만든다. 실측으로 확인한 이동이다(부모에 붙던 conhost가 손자에 붙었고,
개수는 그대로 1).

그 fork 호출은 우리 것이 아니다. 그래서 그 프로세스의 node에게 **기본값을 바꿔 준다**:
앱 홈에 작은 프리로드 조각을 떨구고 `NODE_OPTIONS=--require <조각>`을 건다. NODE_OPTIONS는
node 트리 전체에 상속되므로 tsls → tsserver → typingsInstaller까지 같이 적용되고,
libuv에서 `detached:true` → `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`이라 결과가 우리
플래그와 같아진다.

**안전 규약이 이 조치의 절반이다.** `--require`가 가리키는 파일이 없으면 node는
`MODULE_NOT_FOUND`로 **기동 자체가 실패한다** — 즉 조각이 유실되면 대가가 「conhost가 하나
늘어난다」가 아니라 「코드 인텔리전스가 통째로 죽는다」다. 그래서 `node_preload()`는 파일을
쓰고 **실재를 확인한 뒤에만** 경로를 돌려주고, 실패하면 `None` → `NODE_OPTIONS`를 아예 안
건다(서버는 그대로 뜨고 conhost만 하나 남는다). 조각 자체도 어떤 경우에도 throw하지 않는다.

번들에 파일을 더하지 않은 것도 의도다 — 매니페스트 계약(§2.5)을 안 건드리려고 내용을
Rust 문자열에 두고 첫 기동 때 앱 홈에 떨군다.

**남은 한 조각(정직하게).** 파일을 여는 그 순간 tsserver가 띄우는 `typingsInstaller`에는
아직 conhost가 붙는다(1초 안에 사라진다). 정상 상태·유휴 상태의 프로세스 수에는 안 들어가고,
`bench/results/poc-lspidle-reclaim.json`의 `transientConhostAtOpen`에 그대로 남겨 뒀다.

### 2.5 유령 바이트 다이어트 — 목록이 아니라 규칙으로

`docs/parity-fix-lspdist-r1.md` §6이 이미 재 놓은 14.1MB(`_tsc.js` 6.2MB · 로케일 13벌
4.5MB · 소스맵 4.1MB)를 뺐다. R1이 남긴 사유는 「파일 목록을 손으로 관리하는 비용」이었는데,
**목록이 아니라 「무엇을 안 싣는가」의 규칙**으로 적으면 TypeScript 판이 올라도 안 썩는다.

사슬이 한 칸 늘었다: 레포 `node_modules` → **거른 사본**(`src-tauri/lsp-modules/`) → 설치기.
`bundle.resources`는 여전히 「거울」이지만 비추는 대상이 사본이고, 매니페스트 못의 E1
규칙도 그 칸으로 옮겼다(`src == "lsp-modules/node_modules/<tail>"`).

무엇을 빼는지의 근거:

| 뺀 것 | 크기 | 왜 안 쓰나 |
|---|---:|---|
| `typescript/lib/_tsc.js` + `tsc.js` | 6.24MB | 명령줄 컴파일러. 우리는 tsserver만 띄운다 — `tsserver.js` → `_tsserver.js` → `typescript.js`(둘 다 남긴다) |
| `typescript/lib/{13개 로케일}/` | 4.47MB | tsserver는 `--locale`을 받을 때만 읽는데 우리는 안 넘긴다 |
| `*.js.map` · `*.mjs.map` | 4.09MB | 소스맵. 사용자 PC에 디버거가 붙을 일이 없다 |

**규칙이 계약을 갉아먹지 못하게** 크레이트 쪽 못이 그 배열을 읽어 `bundled_files()`의 어느
경로도 걸리지 않는지 확인한다(`the_diet_never_eats_a_file_the_contract_promises`). 규칙을
넓히는 편집(예: 실수로 `typescript/lib/`를 통째로 넣기)은 빌드가 아니라 **테스트가 먼저**
죽인다 — §1.6-A2(코드는 `Bundled`인데 배포본에 파일이 없다)의 재발을 원인 쪽에서 막는다.

---

## 3. 실측

### 3.1 유휴 메모리 · 프로세스 수 (배포 모사 · `bench/multi.mjs`)

같은 날·같은 기계·같은 배포 모사 배치(설치 폴더에 exe + `node.exe` + 거른 `node_modules`),
두 팔 각 `--repeats=2`. before = `target-lead`의 exe(LSPIDLE 이전), after = 이 라운드.

| 눈금 | before | after | 차 |
|---|---:|---:|---|
| **유휴 프로세스 수** | **8** | **5** | **−3** |
| 유휴 WS(전체) | **579.0MB** | **453.1MB** | **−125.9MB (0.782×)** |
| 유휴 Private(전체) | **354.1MB** | **248.6MB** | **−105.5MB (0.702×)** |
| **LSP 헬퍼 수 / WS / Private** | **3 · 125.9·115.6MB · 102.7·101.8MB** | **0 · 0 · 0** | **−전부** |
| +창2 WS | 623.7MB | 504.4MB | −119.3MB |

before 팔의 유휴 트리에 있던 헬퍼 셋(= 2.6.2 대비 8:7을 만든 그 셋):
`node.exe`(tsls) 54.8/58.6 · `node.exe`(tsserver) 63.5/42.9 · `conhost.exe` 7.6/1.2 (WS/Priv MB).
run2의 헬퍼 몫 **115.6 / 101.8**은 gates 태그 실측(**115.5 / 101.6**)과 사실상 같은 수다 —
이 재현이 그 값을 독립적으로 다시 세웠고, 그래서 after의 0이 무엇에 대한 0인지가 분명하다.

after 팔의 유휴 트리는 `agentcodegui.exe` 하나 + `msedgewebview2.exe` 넷이다(양쪽 주행 동일).
**언어 서버도 conhost도 한 톨 없다.**

> **이 표가 재는 것을 정확히**: `multi.mjs`는 코드 뷰어를 **한 번도 열지 않는다**. 그래서
> after의 0은 「회수돼서 0」이 아니라 **「애초에 안 떠서 0」**이다. 둘은 겉보기가 같고 뜻이
> 다르므로 가려서 적는다 — 「열었다가 유휴가 되어 0」은 §3.2가 따로 잰다.

### 3.2 수명 시나리오 (`scripts/poc-lspidle-reclaim.mjs`, TTL 6s / 스윕 1s 주입)

크레이트 프로브(`ccg-lspidle`)의 자식이 곧 언어 서버라, 프로세스 트리를 세는 것이 그대로
답이 된다. 단계마다 **악수**로 프로브를 세우고 그 순간의 트리를 찍는다.

| 단계 | 앱 안 판정 | OS 트리 |
|---|---|---|
| 부팅 | live 0 | 자손 0 |
| **프리웜(프로젝트 열기)** | live 0 | **자손 0** ← 온디맨드 |
| 열람(`status`→ready 101ms) | live 1 | 자손 4(전이 포함) |
| 정상 상태 | live 1 | **자손 2 · conhost 0** |
| **TTL 경과 → 회수** | live 0 · reclaimed 1 | **자손 0** (판정→소멸 +0ms) |
| 회수 뒤 캐시 색칠 | live 0 | 자손 0 · **0.79ms · 적중** |
| 재열람 | live 1 · **revivals 1 · 새 PID** | 자손 2 |
| 종료 | live 0 · 원장 0 | 자손 0 |

12/12 통과. 핵심 수치: **회수 뒤 첫 색칠 0.79ms(디스크 캐시 적중, 서버 없이)**,
**투명 재기동 787ms**(토큰 왕복 포함), 재기동 뒤 토큰 수가 처음과 동일(22,560).

### 3.3 `bench/lsp.mjs` 눈금 무후퇴 (ts · n=3 교차 주행 · 중앙값)

before/after를 **번갈아** 돌려 기계 상태를 섞었다. 기준 파일은 안 건드렸다(`--out` 접미사).

| 눈금 | before | after | 판정 |
|---|---:|---:|---|
| **첫 색칠(캐시 적중)** | 167 | **169** | **무후퇴** ← 「다시 쓸 때」의 눈금 |
| hover p50 / p95 | 2.5 / 4.1 | 2.5 / 3.8 | 무후퇴 |
| def p50 / p95 | 2.2 / 3.5 | 2.3 / 4.9 | p50 대등 · p95 +1.4(표본 노이즈 범위) |
| 토큰 왕복 | 32 | 34 | 대등 |
| **prewarm ready** | 275 | **538** | **후퇴 +263ms** |
| **첫 색칠(캐시 미적중)** | 654 | **1153** | **후퇴 +499ms** |
| 웜 ready | 165 | 518 | 후퇴 +353ms |
| 회수→재기동 | 587 | 863 | 후퇴 +276ms(before 팔 분산 585–854) |

### 3.4 다이어트 (`scripts/poc-lspidle-diet.mjs`)

거른 사본**만** 보게 못박고(`CCG_LSP_MODULES`) 실물 서버를 띄워 잰다 — 레포의
`node_modules`가 옆에 있는 채로 재면 무엇을 물었는지 모른다. 대조군으로 레포 팔도 같이 돈다.

| | 레포 원본 | 거른 사본 |
|---|---:|---:|
| 크기 | 43.53MB / 5,426개 | **29.42MB / 5,406개** (−14.12MB / −20개) |
| 서버 기동 | ready | ready |
| 호버 적중 | 12/12 | **12/12** |
| 정의 이동(크로스 파일) | 12 | **12** |
| 시맨틱 토큰 수 | 1,800 | **1,800** |
| 자동완성 후보 | 3 (lookup, register, size) | **3 (동일)** |

9/9 통과. 「거른 사본을 정말 물었는가」를 먼저 확인한 뒤 동치를 본다 — 안 그러면 동치가
공짜로 통과한다.

---

## 4. 교환 — 무엇을 사고 무엇을 팔았나 (★사용자 판단이 필요한 자리)

**샀다.** 코드 뷰어를 안 쓰는 동안 **프로세스 3개와 Private 102.7MB / WS 125.9MB**를
안 문다. 쓰다가 손을 떼도 TTL(10/30분) 뒤 같은 자리로 돌아간다.

**팔았다.** 서버 기동이 앱 부팅과 더 이상 겹치지 않는다. 그 대가는 **켠 직후 파일을 여는
경우에만** 나타난다:

- 전에 본 적 있는 파일을 연다 → **색은 169ms에 그대로 뜬다(무후퇴)**. 호버·정의가 되기까지
  약 0.5초를 더 기다린다(웜 ready 165 → 518ms).
- 처음 보는 파일을 연다 → 첫 색칠 654 → **1153ms**.
- 켠 지 한참 뒤에 연다 → 전에는 「이미 준비됨」이었지만 이제는 위와 같은 기동 시간을 문다.

`bench/lsp.mjs`의 프리웜 눈금은 **최악의 경우**(t=0에 파일 열기)를 재므로 이 표의 후퇴가
가장 크게 보이는 자리다. 반대로 §3.1의 이득은 **채팅만 쓰는 시간 전부**에 걸린다.

**되돌리는 문.** 이 교환이 안 맞으면 `spec.rs`의 해당 언어를 `Prewarm::Eager`로 되돌리면
된다(엔진은 안 연다). 그 순간 유휴 헬퍼 몫이 그 언어만큼 되살아난다.

**아직 안 해 본 세 번째 길(제안 · 이 라운드 범위 밖).** 「지난 세션에서 코드 뷰어를 실제로
썼으면 프리웜에서 기동한다」. 코드를 안 보는 사용자는 계속 0을 내고, 보는 사용자는 부팅
겹침을 되찾는다. 다만 그러면 **벤치의 새 홈은 언제나 0을 내므로** 숫자가 좋아 보이는 쪽으로
측정이 기울 여지가 있다 — 그 정직성 문제를 어떻게 다룰지 정한 뒤에 손대야 한다.

---

## 5. 못(돌연변이 확인)

전부 **실제로 돌려서** 붉어지는 것을 봤다. 초록 상태 복구까지 확인했다.

| 돌연변이 | 붉어진 테스트 |
|---|---|
| 회수 타이머 무시(TTL 검사 삭제) | `manager::the_reclaim_rule_honours_the_timer_the_grace_and_the_cap` |
| 유예 상한(안전망) 제거 | 〃 |
| 온디맨드 되돌림(ts를 `Eager`로) | `spec::every_shipped_spec_is_on_demand` · `prewarm_prepares_without_spawning_a_single_process` |
| 다이어트가 계약 파일을 먹음(`typescript/lib/`를 제외 목록에) | `spec::the_diet_never_eats_a_file_the_contract_promises` |
| 매니페스트가 레포 `node_modules`를 직접 가리킴(다이어트 우회) | `spec::every_bundled_file_is_covered_by_the_installer_manifest` |
| 좀비 안전망이 아무것도 안 죽임 | `zombie::a_real_orphan_is_actually_killed` |

그 밖의 못: `the_child_is_spawned_detached_not_merely_windowless`(conhost를 부르는 플래그로
되돌아가지 않게) · `the_timers_stay_injectable_for_the_bench`(벤치가 10분을 기다리지 않게).

**측정 자체의 못도 두 번 고쳤다**(둘 다 조용히 틀린 수를 내고 있었다):

1. **ppid 재사용** — 직전 실행이 남긴 고아가 우리 자식으로 잡혔다. `bench/lib.mjs`와 같은
   방어(루트보다 나중에 태어난 것만)를 넣었다.
2. **단계와 표본의 시각 어긋남** — 트리 조회가 PowerShell 왕복(수백 ms)이라 그동안 프로브가
   다음 단계로 넘어가 서버를 띄웠다. 그래서 「프리웜 직후」라고 이름 붙은 표본이 실제로는
   「파일을 연 뒤」의 트리였고, 온디맨드가 멀쩡히 도는데도 자손 3개가 찍혔다.
   프로브가 표본을 다 찍을 때까지 멈추는 **악수**를 넣어 닫았다.

---

## 6. 건드린 곳

- `crates/ccg-lsp/src/spec.rs` — `Prewarm` 필드/열거 · 매니페스트 못의 E1 규칙 이동 · 다이어트 못
- `crates/ccg-lsp/src/manager.rs` — `prepare()` · `sweep_decision()` · 「회수됨」 상태 · 워치독 · 원장 스윕
- `crates/ccg-lsp/src/server.rs` — `DETACHED_PROCESS` · `NODE_OPTIONS` 프리로드 · `indexing()` · 원장 등록/해제
- `crates/ccg-lsp/src/launch.rs` — `STAGED_MODULES_DIR` · 프리로드 조각과 그 안전 규약
- `crates/ccg-lsp/src/zombie.rs` — **신규**. 핸들 원장
- `crates/ccg-lsp/src/lib.rs` — `prewarm`이 준비만 · `lifecycle()` 진단
- `crates/ccg-lsp/src/bin/ccg_lspidle.rs` — **신규**. 수명 시나리오 프로브
- `src-tauri/src/ipc/lsp.rs` — `boot_prewarm` 주석(당기는 것이 「기동」에서 「준비」로 바뀐 자리)
- `src-tauri/tauri.conf.json` · `.gitignore` · `scripts/tauri-build.mjs` — 거른 사본 스테이징
- `scripts/poc-lspidle-reclaim.mjs` · `scripts/poc-lspidle-diet.mjs` — **신규**

결과 파일: `bench/results/poc-lspidle-{reclaim,diet}.json` ·
`lsp-tauri-3.0.0-{lspidle,lspidle2,lspidle3,beforelead,beforelead2,beforelead3}.json` ·
`multi-tauri-3.0.0-default-{lspidle,lspidlebefore}.json`

---

## 7. 남은 것 / 다음 사람이 알아야 할 것

1. **§4의 교환은 사용자 결정이 필요한 자리다.** 첫 열람 +499ms(캐시 미적중)를 어떻게 볼지에
   따라 `Prewarm`의 값이 달라진다. 되돌림은 한 줄이고 못이 그 사실을 알려 준다.
2. **transient conhost 하나**가 남았다(§2.4 끝). tsserver가 typingsInstaller를 띄우는 그
   순간뿐이고 정상 상태 수에는 안 들어간다.
3. **`bench/lsp.mjs`의 tauri 팔은 이제 `CCG_LSP_MODULES`/`CCG_LSP_NODE`가 필요하다.**
   LSPDIST가 cwd 사슬을 지운 뒤로 `%TEMP%`에 스냅샷한 exe 옆에는 모듈도 런타임도 없다.
   이 라운드는 그 둘을 env로 넘겨 재기만 했다 — 하네스를 고치는 것은 그쪽 갈래의 몫이다
   (이 라운드의 경계에 `bench/lsp.mjs`가 없다).
4. **다이어트는 `npm run tauri:build`·`stage` 경로에만 걸린다.** 개발 실행은 여전히 레포의
   `node_modules`를 문다(exe 조상 사슬) — 그래서 개발에서 안 걸리는 다이어트 결함이 있을 수
   있고, 그것을 막으려고 §3.4의 PoC가 **사본만 보게 못박고** 잰다.
