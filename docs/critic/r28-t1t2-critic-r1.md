# R28 T1T2 확인 크리틱 R1 — 계정 다섯 문은 진짜로 열렸고, 엔진 안내는 **픽스처에서만** 뜬다

판정자: T1T2 확인 크리틱(새 컨텍스트) · 2026-08-24 · `feature/3.0.0-beta`
판정 대상: `06ac40b` 「최종 파리티 T1·T2」 (+ 직전 착지분 `f1ab32d`)
방법: 빌더의 보고서·커밋 메시지·산출 파일을 **근거로 쓰지 않고**, 커밋된 소스에서 릴리즈 exe를
다시 빌드해 **독립 하네스**로 전부 다시 쟀다.

| 산출 | 무엇 |
|---|---|
| `docs/critic/r28-t1t2-critic-r1.json` | 이 라운드의 독립 하네스 실측(A~E 시나리오) |
| `docs/critic/m11-r1-switch-critr28.json` | `poc-account-switch.mjs` 재주행(빌더 파일 미접촉) |
| `bench/shots/tauri-critr28/report.json` | A/B `engine-gate-prompt` 재주행(기준 파일 미접촉) |

하네스: `bench/scratch/crit-t1t2.mjs`(gitignore, 코드·기존 하네스 무수정) ·
격리 홈 `.poc-home-critT1T2` · CDP 9371 · `CCG_NO_NET=1` · 실계정 0건 · 이름 기반 kill 0건.

---

## 0. 한 문단 판정

**T1(계정 쓰기 5채널)은 진짜로 붙었다.** 설정 ▸ Account에서 실제로 버튼을 눌러
「기본으로」·「삭제」·「＋계정 추가」가 전부 **디스크까지** 닿는 것을 확인했고(10/10),
목록 쓰기는 예외 없이 `flock + 3-way + CAS` 문을 지난다(직행 `write_store_file` 0건).
**T2는 절반이다.** 다섯 채널·`install-progress`·A/B 게이트는 실동작하지만, 정작 감사가
쓴 증상 — *「CLI가 없는 컴퓨터에서 아무 안내도 안 뜬다」* — 은 **기본 설정에서 그대로다.**
안내 카드는 `engine-auto-update.json = {enabled:false}`일 때만 뜨는데 그 값은 A/B 픽스처와
빌더 하네스가 심는 값이고, **기본값은 켬**이다. 2.6.2는 같은 판에서 부팅 자동 업데이트가
돌아 엔진을 깔고 카드를 띄운다(`src/main/index.ts:2046 runBootEngineUpdate`) — 3.0은 침묵한다.

→ **pass = false.** 실패 항목은 체크리스트 4번의 알맹이 한 줄이다.

---

## 1. 체크리스트 판정표

| # | 항목 | 판정 | 실측 근거 |
|---|---|---|---|
| 1 | 릴리즈 빌드 후 격리 홈에서 설정 ▸ Account 왕복 | **통과** | 재빌드(`--features custom-protocol`, 1m32s) 후 UI 클릭 왕복 10/10 (§2) |
| 2 | 계정 쓰기가 flock+3-way+CAS인가 + 동시 쓰기 테스트 | **통과(단서 1)** | 코드 전수 대조 + `t1_list_edit_race` 초록. 단 M11 R4 게이트가 **선행 flaky**(§3) |
| 3 | `poc-account-switch.mjs` 초록 | **통과** | PASS · 시나리오 6/6 (§5) |
| 4 | engine 5채널 · 설치 안내 · `install-progress` | **부분 실패** | 채널·이벤트·A/B는 전부 실동작. **기본 설정에서 안내 0** (§4) |
| 5 | 크레이트별 `cargo test` + typecheck 3종 | **통과** | ccg-auth 97 · ccg-engine 197 · ccg-store 76 · src-tauri bin 98/0 · tsc 3종 exit 0 (§5) |
| 6 | 2.6.2 규약(로그아웃=해지→제거 · 오염가드) | **통과(관찰 2)** | 해지가 격리 CONFIG_DIR로 나갔음을 실측. 잠복 발산 1건·범위 밖 구멍 1건(§6) |

---

## 2. T1 — 설정 ▸ Account를 **눌러서** 잰다 (10/10)

빌더 하네스는 `window.api.auth.*`를 직접 불렀다. 감사가 쓴 문장은 *"「＋계정 추가」·
「기본으로」·「삭제」가 전부 무반응"* 이므로, 이 라운드는 **버튼을 눌러** 다시 쟀다.

```
A1  Account 탭 도달(라벨 기반)                 on = "Account"
A2  계정 3건 렌더                              [aa, bb, cc]@crit.test
A3  디스크 초기 defaultEmail                    aa@crit.test
A4  「기본으로」 클릭 → accounts.json           defaultEmail = bb@crit.test  (배지도 이동)
A5  reorderAccounts → 디스크 순서               [cc, bb, aa]
A6  「삭제」 클릭 → 디스크에서 제거 + 폴더 삭제   disk [bb, aa] · dirGone true
A7  「＋계정 추가」 → 「로그인 진행 중…」 카드      spinner true
A8  「＋계정 추가」 → 폴백 로그인 URL이 화면에     https://claude.ai/oauth/authorize?…   157~158ms
A9  「취소」 → 목록 불변 + <home>/login 청소      disk 2건 · loginDir false
A10 (참고) codexAuth.login()                    []  ← OpenAI 절반은 여전히 무반응
```

계정은 `ccg-auth-probe seed`의 합성이고 로그인은 `ccg-fake-claude`(가짜 CLI)다 —
실 OAuth·실토큰 0건. **A8이 이 라운드에서 가장 중요한 한 줄**이다: 감사가 「새 사용자는
3.0에서 로그인할 방법이 없다」고 쓴 그 자리가, 이제 버튼 한 번에 157ms 만에 폴백 링크까지
화면에 닿는다(2회 주행 157·158ms).

부수 실증 하나 — `auth:login`이 최대 5분 막히는 동안에도 같은 창의 IPC가 계속 돌았다
(A7·A8·A9가 그 사이에 전부 성사됐다). 전용 블로킹 풀 배정(`ipc/mod.rs:319`)이 실제로 산다.

---

## 3. 계정 쓰기 경로 — CAS 맞다. 단, 옆 게이트가 선행 flaky다

### 3.1 코드 전수 대조 (우회로 0)

- `set_default_account` · `remove_account` · `reorder_accounts` · `import_account_from_dir`
  → 전부 `claude::update_store` → `cas_edit`(flock + `record_base` 3-way 기준점 + CAS +
  파묻힌 쓰기 되살리기). `crates/ccg-auth/src/claude.rs:463,636,751,761,781,1131`
- `write_store_file` 직행 호출: `src-tauri` 제품 코드 **0건**(테스트·probe 바이너리뿐).
  `src-tauri`가 `accounts.json`을 여는 자리는 **읽기 두 곳**뿐(`ipc/system.rs:120,162`).
- CLI 명령은 전부 `IsolatedConfigDir`로만 조립된다(`verify::{login,logout,status}_command`).
  그 타입은 앱 홈 밖 경로로 만들어지지 않으므로 **실홈을 향해 `auth logout`을 쏠 방법이
  코드에 없다.** 타입 강제라는 주장은 사실이다.

### 3.2 동시 쓰기 — 새 게이트는 초록, 옛 게이트는 25판 중 1판 빨강

`crates/ccg-auth/tests/t1_list_edit_race.rs`(신규) 초록. 4회 배치 전부 97 passed.

그런데 **같은 크레이트의 M11 R4 게이트 `m11r4_store_cas`가 간헐적으로 빨갛다.**
오늘 이 트리에서 **27회 주행 중 1회 실패**했고(그와 별도로 두 주행을 겹쳐 돌린 판에서
2회 더 봤지만 그건 내 주행 겹침이라 세지 않는다), 실패 문장은 정확히 그 게이트가
막겠다고 적은 것이다:

```
assertion `left == right` failed: ★ 잠금을 모르는 이웃의 로그아웃이 우리 배경 쓰기에 취소됐다
  left: 1   right: 0
[r4-cas][DBG] 되살아난 파일 = {... "accounts":[ {"email":"mine@x"...}, {"email":"ghost@x"...} ] }
```

**T1T2의 회귀는 아니다.** 짝지어 잰 결과:

| 트리 | 실패/주행 |
|---|---|
| `076bf8c` (f1ab32d **이전** = CAS 확장 전) | **1 / 12** |
| `06ac40b` (HEAD) | **0 / 12** (오늘 전체로는 1 / 27) |

(같은 기계에서 baseline→head를 12쌍 교대 주행. 게이트 테스트 파일과 `ccg-store`의 flock·
testhome은 두 지점 사이에 한 글자도 안 바뀌었다.) 즉 이 flakiness는 **M11 R4가 남긴 것**이고
f1ab32d가 만든 것이 아니다. 다만 커밋 메시지의 *"cargo test -p ccg-auth 초록"* 은 **주행마다
참이지는 않다** — 게이트가 실행할 때마다 답이 갈리면 게이트가 아니라는 것이 이 저장소가
`engine/testhome.rs`를 합칠 때 쓴 바로 그 문장이다.

### 3.3 새 게이트의 **잣대가 옛 게이트보다 느슨하다**

같은 사고를 두 파일이 다르게 잰다.

| | `m11r4_store_cas`(배경 회전) | `t1_list_edit_race`(사용자 목록 편집) |
|---|---|---|
| 판정 | 로그아웃 직후 15ms를 **1ms 간격으로 훑어** 한 번이라도 되살아나면 실패 | **60ms 가라앉힌 뒤**의 파일만 본다. 그 사이의 되살아남은 `blip`으로 세기만 함 |
| 근거 문장 | *"그 순간의 파일이 곧 사용자가 보는 계정 목록이다"* | *"보증은 영구값이다"* |

빌더는 이 재정의를 테스트 주석(149~156행)에 정직하게 적었다. 그래도 **헤드라인
「영구 로그아웃 취소 0·0」은 잣대를 바꾼 뒤의 0**이라는 사실은 판정문에 남긴다.
`login_undone`(묻힌 이웃 로그인 1·4)을 단정하지 않고 측정만 한 처리는 옳다 — 코드가
주지 않는 보증을 게이트가 주장하지 않는다.

---

## 4. ★ T2 — 채널은 살았고, **기본 설정의 새 사용자는 여전히 아무것도 못 본다**

### 4.1 채널·이벤트·A/B는 전부 실동작 (8/8)

```
C1 engine.listAvailable()      latest 0.3.241 · 274개 · 572~649ms (2회 주행)
C2 engine.state()              심어 둔 설치본을 본다      installed ["9.9.9-crit"]
C3 engine.setActive()          config.json {"activeVersion":"9.9.9-crit"} · state.active 일치
C4 engine:install-progress     line 이벤트 7건  ("$ npm install @anthropic-ai/claude-agent-sdk@…")
C5 engine:install-progress     done 프레임 {version, done:true, ok:false, error:"설치 실패 (npm 종료 코드 1)"}
C6 없는 버전 설치              {ok:false} · 701ms
C7 engine.uninstall()          목록·디스크에서 사라짐
C8 engine.cleanup()            {removed:[], kept:null, freedBytes:0, activeSwitched:false}
```

C4·C5는 감사 §3.3의 **M4(`engine:install-progress` 미구현)**를 같이 닫는다.
(실 설치를 돌리지 않고 없는 버전으로 실패시켜 **이벤트만** 쟀다 — 네트워크·수백 MB 회피.)

A/B도 재주행했다(기준 파일 미접촉):

```
node bench/ab.mjs tauri --only=engine-gate-prompt --tag=critr28 --exe=target-t1t2/release/agentcodegui.exe
OK  engine-gate-prompt (boot:no-engines)   724ms · found 1     → bench/shots/tauri-critr28/report.json
```

### 4.2 그런데 그 초록은 **픽스처가 값을 하나 꺼 줘서** 나온다

`EngineGate.tsx:30`이 첫 줄에서 자동 업데이트를 물어보고 **켜져 있으면 즉시 되돌아간다.**
`bench/fixture.mjs:16`과 `scripts/poc-t1t2.mjs:82`가 둘 다 `{enabled:false}`를 심는다.
**기본값은 켬이다**(`ipc/app_meta.rs:45` — 파일이 없으면 `true`).

기본값 판과 픽스처 판을 **같은 하네스로 나란히** 쟀다(둘 다 engines 0개 · `CCG_CLAUDE_BIN=''`):

| 판 | `engineAutoUpdate()` | `engine:update-status` | `.set-dialog .sd-title` | `.eu-card` |
|---|---|---|---|---|
| **기본값(파일 없음)** | `true` | `{active:false, items:[], done:false}` | **null (25초 폴링 0/1)** | **false** |
| 픽스처(`enabled:false`) | `false` | 같음 | **"Claude 엔진 설치"** | false |

즉 **엔진이 하나도 없고 PATH에도 CLI가 없는 컴퓨터에서, 설정을 만진 적 없는 새 사용자는
25초를 기다려도 카드 한 장 못 본다.** 감사 §3.1 T2가 쓴 증상 문장 그대로다.

이건 픽스처의 트집이 아니라 **2.6.2 대비 회귀 자리**다. 2.6.2는 같은 판에서 침묵하지 않는다:

```
src/main/index.ts:2046  runBootEngineUpdate()
  if (!engineVersions.getAutoUpdate()) return       ← 기본 켬이라 여기서 안 돌아간다
  … latest 조회 → 설치 → 활성화 → 정리 …
  pushEngUpdate() → IPC.engineUpdateEvent 로 진행 스냅샷 방출 → EngineUpdateGate 카드
```

3.0에는 `runBootEngineUpdate`에 해당하는 것이 **없고**, `engine:update-status`는
`ipc/app_meta.rs:34`의 **하드코딩 `{active:false}`**이며 `engine:update-event`는 방출자가 0이다.
그래서 두 카드가 서로를 가린다 — `EngineGate`는 "자동 업데이트가 할 테니 비켜" 하고 물러나고,
그 자동 업데이트는 존재하지 않는다.

빌더는 이것을 보고서 §4 네 번째 줄과 미완 §1에 **정직하게** 적었다. 정직함은 인정하되,
**커밋 제목의 후반부 「엔진 없는 컴퓨터가 말을 한다」는 기본 설정에서 아직 참이 아니다.**

### 4.3 곁가지 — 단일 소스라는 주장은 절반이다

`engine:state`는 여전히 `ipc/app_meta.rs:53,67`이 **자기 사본**으로 답한다
(`cmp_desc` 한 벌 더 + `installed`/`active` 판정 한 벌 더). 오늘은 두 구현의 답이 같지만,
"어긋남을 없애려고 합쳤다"는 T2의 논거를 그대로 적용하면 이 자리가 세 번째 사본이다.
게다가 판정 기준이 다르다 — `claude_bin()`은 **적힌 값 + exe 존재**(느슨), `engine:state`는
**패키지 `package.json`까지**(엄격). 플랫폼 패키지만 깔린 판에서는 CLI가 실제로 도는데
`state.active`가 `null`이라 `EngineGate`가 "설치하라"고 조를 수 있다(하네스가 만드는 모양).

---

## 5. 게이트·수치 (전부 이 라운드 실측)

```
재빌드   CARGO_TARGET_DIR=target-t1t2 cargo build --release --features custom-protocol
         Finished in 1m32s  →  agentcodegui.exe 6,344,192 B (2026-08-24 17:43)
         ※ 빌더가 크리틱 자산으로 넘긴 exe는 6,343,168 B (17:30) — **커밋(17:39)보다 앞선다.**
           이 판정문의 모든 앱 실측은 재빌드본 기준이다.

cargo test (크레이트별 · CARGO_TARGET_DIR=target-t1t2)
  ccg-auth      97 passed / 0 failed   (배치 4회 연속 · lib 79 + m11r3attack 14 + race 2 + cas 1 + t1race 1)
  ccg-engine   197 passed / 0 failed   (기준 191에서 후퇴 없음)
  ccg-store     76 passed / 0 failed
  src-tauri bin 98 passed / 0 failed   (0.46s · 병렬 기본값에서 초록 — testhome 통합이 실제로 산다)
  ※ m11r4_store_cas는 오늘 27주행 중 1빨강(§3.2 — f1ab32d 이전에도 있던 선행 결함)

독립 하네스 bench/scratch/crit-t1t2.mjs (통합 주행)          27개 중 실패 1
  A 계정 UI 10/10 · B 게이트 2/3(★기본값 판 실패) · C 엔진 8/8 · D 로그아웃 4/4 · E 이중 로그인 2/2

npm run typecheck / typecheck:app / typecheck:web        exit 0 · 0 · 0

scripts/poc-account-switch.mjs --out=-critr28            PASS · 시나리오 6/6
  PICK(임박순·배너·되돌리기) · NONE(대기표) · OFF · DIRTY(오염 스킵 "contaminated")
  · CHAIN(a→b→c, 핑퐁 없음) · TOGGLE(디스크·셸 반영)

bench/ab.mjs tauri --only=engine-gate-prompt --tag=critr28   OK 1/1 · 724ms
```

기준 결과 파일 무손상 확인: `git status`에 `bench/shots/*/report.json`·`docs/critic/*.json`
수정 0건(새 태그 산출만 untracked). 다른 갈래의 미커밋 파일도 그대로다.

---

## 6. 2.6.2 규약 대조

### 6.1 로그아웃 = 해지 → 제거 — **지켜졌다(실측)**

가짜 CLI가 남긴 표식의 **내용**이 그때의 `CLAUDE_CONFIG_DIR`이다:

```
D1 해지 명령이 실제로 나갔다      .fake-logout-called 존재
D2 그 CONFIG_DIR                 C:\Code\AgentCodeGUI\.poc-home-critT1T2\accounts\bb_crit.test-6lglye
                                 → 앱 홈 안. 실홈(~/.claude)을 향한 흔적 0
D3 해지 후 스토어에서 제거        accounts [aa@crit.test]
D4 계정 폴더 삭제                 삭제됨
```

2.6.2 `authLogout`(`src/main/auth.ts:705`)의 순서 — `accountRunDir` 물질화 → `auth logout`
(20초 상한, `CLAUDE_CONFIG_DIR`) → `removeAccount` — 와 같다. 해지 실패해도 로컬은 지우는
성질, 폴더를 못 만들면 해지를 건너뛰는 성질도 같다. `CCG_NO_NET=1` 안전핀은 **추가**된
것이고 2.6.2 동작을 좁히지 않는다(기본값에서는 해지가 나간다 — D1이 그 증거).

### 6.2 오염가드 — T1이 만진 경로에서는 파리티, 다만 **제품 호출자가 없다**

- 로그인 편입: 2.6.2 `authLogin`은 가드 없음 → 3.0 `ImportGuard::None`. **일치**.
- 전환 시 오염 스킵: 살아 있다(`poc-account-switch` DIRTY 시나리오 — 사유 `"contaminated"`).
- 그런데 `ImportGuard::RejectTokenCollision`의 호출자가 **테스트뿐**이다. 2.6.2에서 그 가드가
  사는 자리는 `migrateAccounts`의 전역 `~/.claude` 가져오기(`src/main/auth.ts:786 collided`)인데,
  **3.0에는 그 마이그레이션 자체가 없다.** T1의 회귀는 아니다(M5 범위의 선행 공백)이고,
  T1이 붙은 지금은 "새로 로그인하면 된다"로 우회되지만, 사영표에는 안 적힌 공백이다.

### 6.3 잠복 발산 1건 — 로그인 자식 소유권 (실측 재현 실패)

2.6.2는 로그인이 끝날 때 **자기 자식인지 확인하고** 핸들을 놓는다:

```ts
// src/main/auth.ts:663
if (loginProc === child) loginProc = null
```

3.0에는 그 확인이 없다(`src-tauri/src/ipc/accounts.rs:180`):

```rust
if let Some(mut c) = LOGIN.lock().unwrap_or_else(|e| e.into_inner()).take() {
    let _ = c.wait();
}
```

로그인 A가 도는 중에 로그인 B가 시작하면 B가 A를 죽이는데, A의 마무리가 B의
`*LOGIN = Some(child)` **뒤에** 도달하면 A가 **B의 핸들을 꺼내 `wait()`** 한다. 그러면
`LOGIN`이 비어 「취소」가 아무것도 못 죽이고, A는 B가 쓰는 임시 폴더를 읽고 지운다.

실측(E 시나리오, 1.5초 간격 이중 로그인 → 취소): 재현 **못 했다**. A가 B 시작 18ms 뒤
착지했고 취소는 15ms 만에 들었다(`p2 = {ok:false}`, 목록 불변). 창이 좁다 —
`remove_dir_all`+`create_dir_all`+`spawn`(B) vs 파이프 EOF 전파(A)의 경주다.
**코드 근거만 있는 발산**으로 남긴다. UI는 `busy != null`로 한 창 안의 이중 클릭을 막지만
그것은 렌더러 상태라 창이 둘이면 보증이 아니다.

### 6.4 범위 밖이지만 같은 화면 — OpenAI 절반은 여전히 죽어 있다

`codex-auth:login`·`logout`·`set-default-account`·`reorder-accounts`의 Rust 핸들러가 0이다
(`codex-auth:list-accounts` 하나뿐). 실측: `window.api.codexAuth.login()` → `[]`(무반응).
감사 T1이 Anthropic 5채널만 적었으므로 **T1T2의 실패로 세지 않는다.** 다만 설정 ▸ Account를
연 사용자에게 「계정 추가」 버튼은 **두 개** 보이고 아래쪽 하나는 여전히 아무 일도 안 한다.

---

## 7. 종합

| 질문 | 답 |
|---|---|
| 감사 T1(계정)이 닫혔는가 | **닫혔다.** 버튼 왕복이 디스크까지 닿는다(10/10). 새 사용자가 3.0에서 로그인을 **시작**할 수 있다 |
| 감사 T2(엔진)가 닫혔는가 | **절반.** 5채널·`install-progress`·설정 ▸ Engine·A/B는 산다. **기본 설정의 새 사용자 안내는 0** |
| 규약 위반 | **0.** 로그아웃 해지 경로·격리 CONFIG_DIR·CAS 단일 문 전부 지켜졌다 |
| 게이트 | ccg-auth 97 · ccg-engine 197 · ccg-store 76 · src-tauri 98 · tsc 3종 · switch 6/6 · A/B 1/1 |
| 남은 최대 격차 | **부팅 엔진 자동 업데이트(`engine:update-status`/`update-event`)가 통째로 없다.** 그것이 없는 한 `EngineGate`는 기본값에서 영원히 비켜서고, 엔진 없는 컴퓨터는 계속 침묵한다 |
| 그 다음 | `codex-auth:*` 쓰기 4채널(같은 화면의 아래 절반) · `m11r4_store_cas` 선행 flakiness · 로그인 자식 소유권 확인(§6.3) |

**최소 수선(둘 중 하나면 증상이 사라진다)**
1. `ipc/app_meta.rs`의 `ENGINE_UPDATE_STATUS` 고정값을 걷고 `runBootEngineUpdate` 대응물을
   붙여 `engine:update-event`를 흘린다(2.6.2 파리티. 원래 T2의 남은 절반).
2. 그게 큰 공사면, `EngineGate.tsx:30`의 조기 반환을 **"자동 업데이트가 켜져 있고 실제로
   돌고 있을 때"**로 좁힌다 — `engine:update-status.active === false`면 물러날 이유가 없다.
   (렌더러 한 줄. 다만 2.6.2가 하던 「알아서 깔아 준다」는 여전히 없다.)
