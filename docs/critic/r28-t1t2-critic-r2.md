# R28 T1T2 확인 크리틱 R2 — 침묵은 진짜로 끝났다. 다만 **npm이 없는 컴퓨터**에서는 2.6.2가 말하고 3.0은 여전히 말이 없다

판정자: T1T2 확인 크리틱 **R2**(새 컨텍스트) · 2026-08-24 · `feature/3.0.0-beta`
판정 대상: `5c197c3`(로그인 자식 소유권) + `27834d7`(부팅 엔진 자동 업데이트 · 게이트 좁히기)
방법: 빌더의 보고서·커밋 메시지·산출 파일을 **근거로 쓰지 않고**, 커밋된 소스에서 릴리즈 exe를
다시 빌드해 **독립 하네스**로 전부 다시 쟀다. 2.6.2와의 대조는 동결 `out/`을 실제로 띄워서 했다.

| 산출(전부 이 라운드에서 새로 만든 것) | 무엇 |
|---|---|
| `docs/critic/r28-t1t2-critic-r2.json` | 독립 하네스 A~E 실측 **33개 중 실패 0** (+ 하네스 결함으로 폐기한 판정 2건을 `supersededChecks`에 남김) |
| `docs/critic/r28-t1t2-critic-r2-nonpm.json` | ★ **npm 없는 컴퓨터** 부팅 A/B — 3.0(Tauri) vs 2.6.2(Electron) |
| `docs/critic/r28-t1t2-critic-r2-nonpm-settings.json` | 같은 판에서 **설정 ▸ Engine**이 무엇을 말하는가 A/B |
| `docs/critic/r28-t1t2-critic-r2-harnessblast.json` | 다른 하네스 모양의 격리 홈이 이제 **진짜 npm 설치를 시작한다**는 증거 |
| `docs/critic/r28-t1t2-critic-r2-bootupd.json` | 빌더 하네스(`poc-boot-engine-update.mjs`)를 **복사본**으로 재주행 22/22(기준 파일 미접촉) |
| `docs/critic/m11-r1-switch-critr2.json` | `poc-account-switch.mjs --out=-critr2` 재주행 |
| `bench/shots/tauri-critr2/report.json` | A/B `engine-gate-prompt --tag=critr2` 재주행 |

하네스: `bench/scratch/critr2-t1t2.mjs`(gitignore · 제품 코드·기존 하네스 무수정) ·
격리 홈 `.poc-home-critT1T2r2c` · CDP 9375(다른 갈래와 안 겹침) · 실계정 0건 · 이름 기반 kill 0건.

---

## 0. 한 문단 판정

**R1이 `pass=false`로 되돌린 그 한 줄은 실제로 닫혔다.** 설정을 만진 적 없는 새 사용자의
격리 홈(엔진 0개 · `CCG_CLAUDE_BIN=''` · 기본값 = 자동 업데이트 켬)에서 **2.86초에 진행 카드가
뜨고 10.7초에 두 엔진이 진짜로 깔린다**(디스크 `engines/0.3.241` + `codex-engines/0.149.1`,
`config.json`·`codex-config.json`까지). 두 번 주행해 둘 다 같았다(2,834ms · 2,863ms).
체크리스트 여섯 항목은 **전부 실측 통과**했고, 이 라운드가 만진 경로에서 2.6.2 규약 위반은 0이다.
→ **pass = true.**

그런데 감사 T2가 쓴 증상 문장 — *「CLI가 없는 컴퓨터에서 아무 안내도 안 뜬다」* — 은
**한 인구에서 그대로 살아 있다: npm(Node.js)이 없는 컴퓨터.** 빌더는 이것을 남은 리스크 1에
*「2.6.2도 같다(파리티지 개선 아님)」* 라고 적었는데, **실측이 그 문장을 반증한다.** 같은 판에서
2.6.2는 4.3초에 카드를 띄우고 실패 사유까지 말하며, 심지어 **번들 엔진(v0.3.161)으로 계속
동작한다.** 3.0은 45초 동안 카드 0장이고 설정 ▸ Engine의 버전 목록도 **0개에 오류 한 줄 없다.**

---

## 1. 체크리스트 판정표

| # | 항목 | 판정 | 실측 근거 |
|---|---|---|---|
| 1 | 릴리즈 빌드 후 격리 홈에서 설정 ▸ Account 왕복 | **통과** | 재빌드본으로 버튼 클릭 왕복 **9/9**(§3). 「＋계정 추가」는 **157ms**에 폴백 로그인 URL까지 화면에 |
| 2 | 계정 쓰기가 flock+3-way+CAS · 동시 쓰기 테스트 | **통과(단서 1)** | 코드 전수 대조(우회 0) + `t1_list_edit_race` 1/1 · `m11r4_store_cas` **16주행 중 1빨강**(부하 겹칠 때만 · R1이 선행 결함으로 확정한 것 · §7) |
| 3 | `poc-account-switch.mjs` 초록 | **통과** | `--out=-critr2` → **PASS · 시나리오 6/6**(PICK·NONE·OFF·DIRTY·CHAIN·TOGGLE) |
| 4 | engine 5채널 · 설치 안내 · `install-progress` | **통과** | C1~C9 9/9 · A/B `engine-gate-prompt` **OK 1/1(1,105ms)** · 기본 설정 판에서 카드 2.86초(§2) · 자동 업데이트 끔 판은 **503ms**(§2.3) |
| 5 | 크레이트별 `cargo test` + typecheck 3종 | **통과** | ccg-auth **97** · ccg-engine **197**(기준 191 후퇴 없음) · ccg-store **76** · agentcodegui **107** · tsc 3종 exit 0 |
| 6 | 2.6.2 규약(로그아웃=해지→제거 · 오염가드) | **통과** | 해지가 격리 `CLAUDE_CONFIG_DIR`로 나간 것을 표식 내용으로 확인(D1~D4) · 오염 스킵 살아 있음(DIRTY `"contaminated"`) · 로그인 자식 소유권은 이제 **관측된다**(§4) |

> 여섯 항목 밖에서 찾은 것 셋(§5 npm 없는 컴퓨터 · §6 하네스 유탄 · §7 잔가지)은 아래에 따로 적는다.
> 그중 §5는 **다음 라운드의 최대 격차**이고, §6은 **오늘 당장 다른 갈래의 측정을 오염시키는** 자리다.

---

## 2. ★ R1이 실패시킨 그 줄 — 시계열로 두 번 쟀다

R1은 표본 하나로 쟀고(그래서 스스로 닫히는 카드를 놓칠 수 있었다), 빌더는 그 사실을 정직하게
지적했다. 이 라운드는 **표본이 아니라 시계열**로 잰다 — 0.7초 간격으로 DOM과
`engine:update-status`를 같이 찍는다.

### 2.1 기본값 · 엔진 0개 · CLI 없음 · **실 npm** (2회 주행)

```text
t+   1ms  eu=0  {active:false, done:false}                       ← 아직 조사 중
t+2863ms  eu=1  {active:true}  claude:installing · codex:pending  ★ 카드가 뜬다
t+7833ms  eu=1  claude:done · codex:installing
t+10658ms eu=1  claude:done · codex:done · cleanup:done · done:true
t+12777ms eu=0  (성공 카드가 스스로 닫혔다)
```

카드가 그린 줄: `["Claude Code0.3.241 새로 설치", "Codex CLI0.149.1 새로 설치", "이전 버전 정리"]`
디스크: `engines/["0.3.241"]` · `config.json {"activeVersion":"0.3.241"}` ·
`codex-engines/["0.149.1"]` · `codex-config.json {"activeVersion":"0.149.1"}`
1차 주행 `firstEu = 2,834ms` · 2차 `2,863ms`. **`.sd-title`은 두 주행 모두 한 번도 안 떴다**
(= 안내 카드와 진행 카드가 겹치지 않는다).

R1의 같은 판 실측은 `.sd-title = null` · `.eu-card = 0`(25초 폴링)이었다. **닫혔다.**

부수 확인 하나: 설치가 도는 10초 동안 `engineUpdate.status()` IPC를 0.7초마다 28번 불렀고
전부 정상 응답했다 — 부팅 업데이터가 자기 스레드에서 돌아 **창을 얼리지 않는다**(주장의 실측).

### 2.2 이미 최신이면 아무 일도 없다

두 엔진의 활성 표식을 **부팅 전에** 심어 둔 판: `.eu-card` 0장 · `.sd-title` 0장 ·
`{active:false, cleanup:"done", done:true}` · `engines`·`codex-engines` 각각 1개 그대로(설치 0).

### 2.3 자동 업데이트를 끈 사용자에게 20초 대기 회귀가 없다

새 코드는 「업데이터의 결론」을 최대 20초 기다린다. 그 대기가 *자동 업데이트를 끈* 사용자에게
번지면 R1보다 나빠진다 — 안 번진다. `settleBootUpdater`가 `engineAutoUpdate()`를 먼저 묻는다.

```
engine-auto-update.json {enabled:false} + 엔진 0개 →  .sd-title "Claude 엔진 설치"  503ms · 518ms
```

빌더 하네스의 20.5초 판은 `CCG_NO_BOOT_ENGINE_UPDATE=1`(=자동 업데이트는 켬인데 아무도 안 도는
인공 상태)에서만 나온다. 내 복사본 재주행도 같았다(**20,440ms**). 제품에서 그 상태에 해당하는
것은 **`npm view`가 두 번 다 8초 상한을 먹는 판**이다 — 그때 사용자는 최대 20초 아무 말도 못 듣는다.
치명은 아니지만 「조사 중…」 한 줄이 없다는 사실은 적어 둔다.

---

## 3. 계정 다섯 문 — 버튼으로 다시 (9/9)

```
A1 Account 탭 도달(라벨 기반)                on = "Account"
A2 계정 3건 렌더                             [aa, bb, cc]@cr2.test
A3 디스크 초기 defaultEmail                   aa@cr2.test
A4 「기본으로」 클릭 → accounts.json          defaultEmail = bb@cr2.test
A5 reorderAccounts → 디스크 순서              [cc, bb, aa]
A6 「삭제」 클릭 → 디스크 제거 + 폴더 삭제      disk [bb, aa] · dirGone true
A7 「＋계정 추가」 → 「로그인 진행 중…」         2ms
A8 「＋계정 추가」 → 폴백 로그인 URL이 화면에   https://claude.ai/oauth/authorize?…  157ms
A9 「취소」 → 목록 불변 + <home>/login 청소     disk 2건 · loginDir false
```

계정은 `ccg-auth-probe seed`의 합성, 로그인은 `ccg-fake-claude` — 실 OAuth·실토큰 0건.

**쓰기 경로 재대조(코드).** `set_default_account` · `remove_account` · `reorder_accounts` ·
`import_account_from_dir`는 전부 `update_store → cas_edit`(flock + `record_base` 3-way 기준점 +
CAS + 파묻힌 쓰기 되살리기)를 지난다. `src-tauri`의 제품 코드에서 `claude::write_store_file`을
직접 부르는 자리는 **0건**(테스트·probe 바이너리뿐). 이 라운드는 이 경로를 한 글자도 안 건드렸고,
동시 쓰기 게이트 둘(`t1_list_edit_race` · `m11r4_store_cas`)도 재주행했다(§7).

> 하네스 한계 하나(양 라운드 공통): `reorder`는 **채널로** 불렀다. 렌더러는
> `reorderAccounts(...).then(setAccounts)` 구조(2.6.2와 동일)라 채널을 밖에서 부르면 화면 순서는
> 안 따라온다 — 디스크가 진실이다. **꾹-드래그 UI 경로 자체는 어느 라운드도 아직 안 눌러 봤다.**

---

## 4. 로그인 자식 소유권 — R1이 못 연 창이 이번엔 열렸다

R1은 코드 근거만 남겼다(1.5초 간격 이중 로그인에서 A가 18ms에 착지 → 창이 안 열림).
같은 시나리오를 **두 간격**으로 돌렸다.

| 간격 | A가 B 시작 뒤 착지 | `p1` | 취소 후 B 착지 | 목록 | `<home>/login` |
|---|---|---|---|---|---|
| 1,500ms | **2ms** | `{ok:false, error:"다른 로그인이 시작되어 이 시도는 취소됐어요."}` | 54ms | 불변 | 청소됨 |
| 120ms | **3ms** | 같은 문장 | 18ms | 불변 | 청소됨 |

그 문장이 곧 **A가 자기가 최신이 아님을 알아채고 B의 핸들·임시 폴더에 손대지 않은 경로**다.
번호를 `spawn`이 아니라 `cancel_login()` **앞**에서 올린 것이 그 창을 덮는다. 취소 경로(핸들만
사라지고 번호는 그대로)는 여전히 폴더를 청소한다 — A9·E가 같이 증명한다.

> 다만 이것을 지키는 **단위 게이트는 반쯤 동어반복**이다:
> `a_finishing_login_never_takes_the_next_ones_handle`의 마지막 세 줄은 `*g = None`을 넣고
> `None != Some(a)`를 확인한다(언제나 참). 실제 판정이 사는 자리(`login()`의 마무리 블록)는
> 함수로 빠져 있지 않아 테스트가 닿지 않는다. **보증을 지고 있는 것은 위의 실측이지 그 테스트가 아니다.**

---

## 5. ★ 남은 최대 격차 — npm이 없는 컴퓨터에서 2.6.2는 말하고 3.0은 말이 없다

빌더의 남은 리스크 1: *「npm·네트워크가 둘 다 없는 컴퓨터는 여전히 카드 0장 — 2.6.2도 같다(파리티)」*.
**둘 다 없는 판은 그 말이 맞다. 그러나 흔한 판은 그게 아니다** — *네트워크는 있고 npm만 없는*
컴퓨터(= Node.js를 안 깐 일반 Windows 사용자). 두 앱을 같은 조건으로 띄워 쟀다
(PATH에서 npm·node 제거 · 네트워크 유지 · 엔진 0개 · 기본 설정).

### 5.1 부팅 (`…-nonpm.json`)

| | 2.6.2 (Electron, 60초 관측) | 3.0 (Tauri, 45초 관측) |
|---|---|---|
| 카드 | **4,314ms에 진행 카드** | **없음** |
| 카드 문장 | `일부 엔진을 업데이트하지 못했어요` + `설치 실패 (npm 종료 코드 1)` | — |
| 카드 줄 | `Claude Code0.3.241 새로 설치` · `이전 버전 정리…` | — |
| 홈의 engines | (반쪽 폴더 생성됨) | `[]` |
| `update-status` 종착 | — | `{active:false, cleanup:"done", done:true}` |

원인은 **조회 수단이 갈렸기 때문**이다. 2.6.2는 `fetch('https://registry.npmjs.org/<pkg>')`
(`src/main/engine/versions.ts:160`)라 npm 없이도 `latest`를 안다 → 할 일이 생긴다 → 카드가 뜨고
설치가 실패하며 **사유를 말한다**. 3.0은 조회까지 `npm view`(`crates/ccg-engine/src/versions.rs:358`)라
`latest`를 모른다 → 할 일이 없다 → `done:true` → `EngineGate`도 `listAvailable`이 비어 물러난다.
**침묵이 설계상 필연이다.**

### 5.2 그리고 설정 화면도 말하지 않는다 (`…-nonpm-settings.json`)

사용자가 스스로 설정 ▸ Engine을 열었을 때:

| | 2.6.2 | 3.0 |
|---|---|---|
| `listAvailable().latest` | `0.3.241` (274개) | `null` |
| 그 응답의 `error` | — | `"레지스트리 응답을 읽지 못했어요(npm view 출력이 JSON이 아닙니다)"` |
| 화면 버전 목록 | **30개 렌더** | **0개** |
| 화면 오류 문구 | — | **없음** |
| 엔진 상태 줄 | `v0.3.161 (번들) · CLI` — **번들 엔진으로 실제로 동작한다** | `미설치 — 버전을 골라 설치하세요` |

3.0은 사유를 **값으로** 내리는데(`{latest:null, versions:[], error}`) 렌더러가 그 `error`를 읽지
않는다(`Settings.tsx:994` — `.then(r => setAvailable(r.versions))`, `listError`는 **거부일 때만**
채워지므로 영영 `null` → `"목록을 불러오지 못했습니다"`가 뜰 수 없다). `versions.rs:51`의 주석
*"렌더러의 폴백이 같은 자리를 그린다"* 는 이 채널에서는 **사실이 아니다.**

정리하면 그 컴퓨터의 사용자는 **부팅에서도, 설정에서도, 목록에서도 아무 이유를 못 듣고**,
2.6.2와 달리 번들 폴백도 없어 앱이 아예 동작하지 않는다. 뿌리 둘(M4의 `npm view` 조회 · M3의
번들 제거)은 **이 라운드가 만든 것이 아니다.** 그러나 보고서가 그 자리를 「파리티」라고 적은 것은
실측으로 틀렸고, 감사 T2의 증상 문장은 그 인구에서 **아직 살아 있다.**

**최소 수선 후보(둘 중 하나면 침묵이 사라진다)**
1. `latest`를 모를 때도 `EngineGate`가 **버전 없는 안내**를 띄운다(“엔진을 설치해야 하는데
   npm(Node.js)을 찾지 못했어요 — 설치 후 다시 실행하세요”). `listAvailable().error`가 이미 그 문장을 안다.
2. 설정 ▸ Engine이 응답의 `error`를 읽어 목록 자리에 띄운다(한 줄). ①이 부팅을, ②가 사후 확인을 덮는다.

---

## 6. 하네스 유탄 — 이제 격리 홈 하나마다 735MB가 붙을 수 있다

빌더는 *「격리 홈으로 앱을 띄우는 하네스가 전부 그걸 시작하면 측정이 그것부터 재게 된다」* 고
직접 쓰고, 그 팔(`CCG_NO_BOOT_ENGINE_UPDATE`)을 만들고, **하네스 하나(`poc-account-switch.mjs`)에만**
두 줄을 심었다. 나머지는 그대로다.

`scripts/poc-talk.mjs:238-245`와 **같은 모양**의 홈(플랫폼 stub + `config.json{activeVersion:'fake'}` ·
SDK 마커 없음 · auto-update 파일 없음)을 만들어 앱을 띄우고 npm 호출을 셌다(진짜 다운로드를
피하려고 PATH 앞에 가짜 npm):

```json
[["view","@anthropic-ai/claude-agent-sdk","--json"],
 ["view","@openai/codex","--json"],
 ["install","@anthropic-ai/claude-agent-sdk@9.9.9","--prefix","…\\engines\\9.9.9", …],
 ["install","@openai/codex@8.8.8","--prefix","…\\codex-engines\\8.8.8", …]]
```

그리고 `.eu-card` 오버레이가 떴다(`eu: true`). 실 npm이면 이 주행 하나가
**361MB(claude) + 374MB(codex) = 735MB**를 받는다(실홈 설치본 실측 크기). 노출된 하네스는
`poc-talk` · `poc-limit-blind` · `poc-parity-t3t4` · `poc-live-chat` · `critic-m10-*` 등이고,
**오늘 세 갈래가 같은 워킹트리에서 하네스를 돌리고 있다.** 카드가 클릭 위에 앉는 것도 같은 유탄이다
(빌더가 자기 하네스에서 겪고 두 줄로 막은 바로 그 증상).

→ 제품 결함은 아니다(2.6.2 파리티 동작이다). 그러나 **다음 라운드가 하네스 쪽을 일괄로 막지 않으면
다른 갈래의 수치가 조용히 오염된다.** 한 줄이면 된다: 하네스 공용 기동부(`bench/lib.mjs` ·
`scripts` 공용 `seedHome`)에 `CCG_NO_BOOT_ENGINE_UPDATE=1`.

---

## 7. 게이트·수치 (전부 이 라운드 실측)

```
재빌드   npm run app:build (2.13s) → CARGO_TARGET_DIR=target-t1t2 cargo build --release
         --features custom-protocol   Finished in 1m 27s
         agentcodegui.exe 6,356,992 B (2026-08-24 18:58)
         측정 트리 = 5863055(=T1T2의 5c197c3·27834d7 포함, 깨끗) · 이후 코드 델타는
         src-tauri/src/ipc/git.rs +10(T3T4)뿐 — 계정·엔진 경로와 무관

cargo test (크레이트별 · CARGO_TARGET_DIR=target-t1t2)
  ccg-auth      97 passed / 0 failed   (lib 79 + m11r3attack 14 + race 2 + cas 1 + t1race 1)
  ccg-engine   197 passed / 0 failed / 2 ignored   (기준 191에서 후퇴 없음)
  ccg-store     76 passed / 0 failed
  agentcodegui 107 passed / 0 failed   (빌더 보고 106 → 그 뒤 T3T4 커밋으로 +1)
  m11r4_store_cas 단독 반복: 8/8 초록 · 오늘 전체 16주행 중 1빨강(앱 하네스와 겹쳐 돈 판)
    → R1이 교대 12쌍으로 확정한 **선행 결함**이 맞고, 부하가 걸리면 더 자주 나온다

npm run typecheck (node+web) · typecheck:app                 exit 0 · 0

독립 하네스 bench/scratch/critr2-t1t2.mjs                     33개 중 실패 0
  A 계정 UI 9/9 · B 게이트 7/7 · C 엔진 9/9 · D 로그아웃 4/4 · E 이중 로그인 4/4
빌더 하네스 복사본(홈·포트·산출만 변경)                        22/22
scripts/poc-account-switch.mjs --out=-critr2                  PASS · 6/6
bench/ab.mjs tauri --only=engine-gate-prompt --tag=critr2     OK 1/1 · 1,105ms
```

기준 결과 파일 무손상: `git status`에 **수정된 추적 파일 0건**(새 태그 산출만 untracked).
빌더의 `docs/critic/boot-engine-update-r1.json`은 손대지 않았다 — 그 하네스는 `--out`이 없어
**복사본**으로 돌렸다(다음 라운드 숙제: `poc-boot-engine-update.mjs`에 `--out` 접미사를 달아라).

---

## 8. 잔가지 (판정에는 안 넣지만 남긴다)

1. **20초 침묵 구간**(§2.3) — 업데이터가 결론을 못 내면 게이트가 최대 20.4초 조용하다.
   제품에서는 `npm view` 두 번이 다 상한을 먹는 판이 여기다.
2. **느슨/엄격 두 판정이 아직 갈려 있다** — `claude_bin()`은 *적힌 값 + exe 존재*,
   `engine:state`는 *패키지 `package.json`까지*. 게이트가 더 이상 비켜서지 않게 된 지금은
   이 차이가 **화면으로 샌다**(CLI는 도는데 설치 안내 모달이 뜨는 홈). 빌더가 자기 하네스에
   SDK 마커를 심어야 했던 것이 그 모양의 실물이다. npm이 있으면 부팅 업데이터가 스스로 덮는다.
3. **`codex-auth:*` 쓰기 4채널은 여전히 0**(`codex-auth:list-accounts` 하나뿐). 설정 ▸ Account의
   OpenAI 절반은 계속 무반응 — R1 §6.4 그대로, T1T2 범위 밖.
4. **`ImportGuard::RejectTokenCollision` 제품 호출자 0** — 2.6.2 `migrateAccounts` 대응물이 없다(M5 공백).
5. **6시간 주기는 이번에도 실측 못 했다.** 코드는 부팅 흐름과 같은 `plan`·`RUNNING` 관문을 쓴다.
   다만 부팅과 달리 **삭제를 안 한다**는 성질은 코드로만 확인했다(2.6.2와 같다).
6. **부팅 업데이트가 도는 동안 채팅 전송** — 이번에도 안 쟀다(2.6.2도 같은 구조).

---

## 9. 측정 부작용 고지 (내가 낸 것)

§5의 2.6.2 팔을 격리 홈으로 띄운 순간, 2.6.2의 **알려진 결함**이 실홈을 건드렸다:
`src/main/codex/versions.ts:17`이 `APP_HOME`을 `os.homedir()`로 하드코딩해 `CCG_HOME`을 무시한다
(`docs/critic/final-parity-r1.md` §1.3 #11이 이미 적어 둔 자리). 그래서 2.6.2의 부팅 정리가
사용자의 실홈 `~/.agentcodegui/codex-engines`에서 **옛 버전을 지웠다**(카드 표기 `373 MB 확보`).

확인: 실홈은 `codex-engines/["0.149.1"]` · `codex-config.json {"activeVersion":"0.149.1"}` —
**활성 버전이 그대로 남아 있어 사용자의 2.6.2는 정상 동작한다.** claude 쪽(`engines/0.3.241`,
`config.json`)은 손대지 않았다. 지워진 것은 옛 codex 엔진 폴더이고 필요하면 설정에서 다시 깔 수 있다.
다음 라운드가 2.6.2를 격리 홈으로 띄울 때는 **`codex-engines`를 미리 정션**하거나
`codexCleanupOld`를 타지 않는 화면만 쓰기를 권한다.

---

## 10. 종합

| 질문 | 답 |
|---|---|
| R1이 실패시킨 한 줄이 닫혔는가 | **닫혔다.** 기본 설정·엔진 0개 판에서 2.86초에 카드, 10.7초에 두 엔진이 진짜로 깔린다(2회 주행 · 디스크 확인) |
| 새 코드가 다른 자리를 깨뜨렸는가 | **아니다.** 자동 업데이트를 끈 사용자는 503ms에 안내를 받고(대기 회귀 0), 최신 상태면 카드 0장·설치 0, 계정 다섯 문·CAS·로그아웃 규약은 그대로 |
| 잠복 §6.3(로그인 자식 소유권)은 | **실물로 관측**됐다(2ms·3ms 창에서 A가 물러나고 취소는 18~54ms에 듣는다). 단 이를 지키는 단위 게이트는 반쯤 동어반복이다 |
| 규약 위반 | **0** (이 라운드가 만진 경로에서) |
| 게이트 | ccg-auth 97 · ccg-engine 197 · ccg-store 76 · agentcodegui 107 · tsc 3종 · switch 6/6 · A/B 1/1 · 독립 33/33 |
| **남은 최대 격차** | **npm(Node.js)이 없는 컴퓨터의 완전한 침묵.** 2.6.2는 4.3초에 사유가 적힌 카드를 띄우고 번들 엔진으로 계속 동작하는데, 3.0은 부팅·설정·목록 어디에서도 이유를 말하지 않는다. 보고서의 「2.6.2도 같다」는 실측으로 반증됐다 |
| 그 다음 | 하네스 유탄 일괄 차단(§6 — 오늘 다른 갈래를 오염시킨다) · `codex-auth:*` 쓰기 4채널 · 느슨/엄격 판정 합치기 · `poc-boot-engine-update.mjs --out` |
