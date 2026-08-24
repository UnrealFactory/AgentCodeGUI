# 최종 파리티 T1·T2 **R2** — 엔진 없는 컴퓨터가 드디어 말을 한다

라운드: R28 T1T2 수정 R1 · 2026-08-24 · `feature/3.0.0-beta`
판정 대상: `docs/critic/r28-t1t2-critic-r1.md` (확인 크리틱, `pass = false`)
전제: R1 보고서 `docs/parity-fix-t1t2-r1.md` §4의 **네 번째 줄** — 그 줄이 이 라운드의 전부다.

| 산출 | 무엇 |
|---|---|
| `docs/critic/boot-engine-update-r1.json` | 새 하네스 `scripts/poc-boot-engine-update.mjs` 실측(A~D, 22/22) |
| `docs/critic/m11-r1-switch-t1t2fixr1.json` | `poc-account-switch.mjs` 재주행(기준 파일 미접촉) |
| `bench/shots/tauri-t1t2fixr1/report.json` | A/B `engine-gate-prompt` 재주행(기준 파일 미접촉) |

---

## 0. 크리틱이 실패시킨 한 줄

> **엔진이 하나도 없고 PATH에도 CLI가 없는 컴퓨터에서, 설정을 만진 적 없는 새 사용자는
> 25초를 기다려도 카드 한 장 못 본다.** (§4.2 — `.sd-title = null` · `.eu-card = 0`)

원인은 **두 카드가 서로를 가린 것**이었다.

```text
EngineGate.tsx:30    "자동 업데이트가 켜져 있으니(기본 켬) 저쪽이 알아서 한다" → 즉시 물러남
EngineUpdateGate     engine:update-status 가 app_meta.rs:34 하드코딩 {active:false}
                     engine:update-event 방출자 0                        → 영영 안 뜸
```

즉 **비켜선 자리에 아무도 없었다.** 2.6.2는 같은 판에서 침묵하지 않는다
(`src/main/index.ts:2046 runBootEngineUpdate` — 조회 → 설치 → 활성화 → 정리 + 카드).

이 라운드는 크리틱이 제시한 두 수선을 **둘 다** 했다. 하나만 하면 각각 구멍이 남는다:
(1)만 하면 부팅 업데이터가 실패·부재인 판에서 다시 침묵하고, (2)만 하면 2.6.2가 하던
「알아서 깔아 준다」가 여전히 없다.

---

## 1. 무엇을 붙였나

### 1.1 `src-tauri/src/engine/boot_update.rs` (신규) — 부팅 엔진 자동 업데이트

2.6.2 `runBootEngineUpdate`/`silentEngineUpdate`의 3.0 자리다. 알맹이는 이미
`ccg_engine::versions`(T2가 두 엔진 공용으로 합쳐 둔 것)에 있어서 여기는 **순서와 봉투**만 한다.

```text
부팅 +1.5초 ─ 두 엔진 latest 조회(npm view, 8초 상한)
            ─ 할 일 판정 plan(latest, active)
                ├ 없음 → 옛 버전만 조용히 정리 → {active:false, done:true} 방출("끝났다")
                └ 있음 → {active:true, items:[…]} 방출
                         → 설치 → 활성화 → 항목마다 REPLACE 스냅샷
                         → cleanup:'running' → 최신 하나만 남기고 정리 → done:true
6시간 주기 ── 설치·활성화만(삭제 없음 · 카드 없음)
```

지킨 규약 셋(전부 2.6.2 주석의 논거를 그대로 승계):

- **부팅 직후인 이유** = 아직 어떤 세션도 돌기 전이라 옛 버전 삭제가 실행 중 CLI를
  물 수 없는 유일한 시점. 6시간 주기가 삭제를 안 하는 것도 같은 이유다.
- **`+1.5초`** = 2.6.2 `setTimeout(…, 1500)`. 없애면 안 되는 이유가 실제로 있다:
  npm 캐시가 더운 판에서는 흐름이 **렌더러가 구독하기 전에 끝나** 진행 카드가 한 번도
  안 뜬다(`EngineUpdateGate`는 이미 `done`인 스냅샷을 뒤늦게 그리지 않는다 — `sawLiveRef`).
- **`plan`의 `>=` 판정** = 활성이 latest 이상이면 할 일 없음. `===`만 보던 초기 2.6.2가
  프리뷰↔stable 무한 사이클을 만든 자리다(설치와 정리가 서로를 지운다).

`engine:update-status`는 이제 이 흐름의 스냅샷이다. **셋을 구분한다** — 이게 (2)의 근거다:

| `active` | `done` | 뜻 |
|---|---|---|
| false | false | 아직 조사 중(또는 시작 전) |
| **true** | – | **돌고 있다** → 카드는 `EngineUpdateGate`의 몫 |
| false | **true** | 끝났고 **이번 부팅엔 할 일이 없었다** |

### 1.2 `EngineGate.tsx` — 조기 반환을 「켜져 있다」에서 「돌고 있다」로

```text
R1  const auto = await engineAutoUpdate();  if (auto) return          ← 기본값이 켬이라 언제나 물러남
R2  ① engine.state()      활성 엔진이 있으면 할 말이 없다 → 즉시 반환(레지스트리 조회도 안 한다)
    ② settleBootUpdater() 부팅 업데이터의 **결론**을 기다린다(active면 물러남 · 상한 20초)
    ③ listAvailable()     아무도 안 돈다 → 무엇을 깔아야 하는지 알아내 안내 카드
  + engine:update-event 구독 — 뒤늦게 일이 시작되면 프롬프트가 물러난다(카드 겹침 방지)
```

①을 앞에 둔 것은 비용 때문이다: R1은 `auto`가 켜져 있으면 조회를 아예 안 했는데,
판정을 바꾸면 부팅마다 `npm view` 자식이 하나 늘 수 있다. 활성 엔진이 있는 **정상적인
사용자에게는 디스크 한 번으로 끝난다**(실측 §2.1 A8/C4 — npm 왕복이 늘지 않았다).

### 1.3 `ipc/app_meta.rs` — 사본 두 개를 걷었다

- `ENGINE_UPDATE_STATUS` 하드코딩 → `boot_update::status()`
- `auto_update()` 사본 → `boot_update::auto_update()` 한 벌(화면 토글과 실제로 도는
  흐름이 다른 사본을 읽으면 "켜 놨는데 안 돈다"가 조용히 생긴다)
- `engine_state`의 `installed`/`active` 판정 + `cmp_desc` **세 번째 벌**(크리틱 §4.3) →
  `ccg_engine::versions::{CLAUDE, CODEX}` 위임. 판정은 한 글자도 안 바뀐다(둘 다
  `node_modules/<패키지>/package.json`까지 보는 엄격 판정이었다) — 사본만 사라졌다.

### 1.4 `ipc/accounts.rs` — 로그인 자식 소유권(크리틱 §6.3 잠복)

2.6.2 `if (loginProc === child)`에 해당하는 확인이 없어, 로그인 A의 마무리가 B의 핸들을
꺼내 `wait()`할 수 있었다(→ 「취소」가 아무것도 못 죽인다). **시도 번호**를 도입했다.

```rust
static LOGIN: Mutex<Option<(u64, Child)>>   // 핸들에 시도 번호가 같이 앉는다
static LOGIN_GEN: AtomicU64                 // 번호는 spawn 전에 올린다
```

- 마무리는 **자기 번호일 때만** 핸들을 놓는다.
- 우리가 도는 사이에 다른 로그인이 시작됐으면(`still_current(gen) == false`) 임시 폴더를
  **읽지도 지우지도 않고** 물러난다 — 남의 자격증명을 자기 결과로 읽거나 남이 쓰는 중에
  폴더를 지우는 두 번째 사고를 같이 막는다.
- 번호를 `spawn` 앞에서 올리는 이유: B가 `kill → spawn → 핸들 저장` 하는 사이의 창에서도
  A가 "나는 이제 최신이 아니다"를 알아야 한다. 크리틱이 못 연 18ms 창이 그 사이다.

### 1.5 귀속 팔 `CCG_NO_BOOT_ENGINE_UPDATE`

이 흐름은 **npm 왕복 + 수백 MB 설치**다. 격리 홈으로 앱을 띄우는 하네스가 전부 그걸
시작하면 측정이 그것부터 재게 된다. `flags.rs` 규약대로 **기본값은 켬**이라 아무 env도
없으면 제품 동작은 한 글자도 바뀌지 않는다.

---

## 2. 실측 (전부 이 라운드, 재빌드본 기준)

```text
빌드  CARGO_TARGET_DIR=target-t1t2 cargo build --release --features custom-protocol
      (app:build 선행 — 렌더러 변경이 dist에 들어가야 한다)
      Finished in 1m 34s · agentcodegui.exe 6,354,944 B
```

### 2.1 새 하네스 `scripts/poc-boot-engine-update.mjs` — 22/22

앱 코드에 하네스용 분기는 **한 줄도 없다**. 바꾸는 것은 자식이 보는 PATH 하나다 —
PATH 앞에 **가짜 npm**(view는 합성 패큐먼트, install은 폴더 하나 + 1.2초 지연)을 꽂아
흐름 전체를 결정적으로 밟는다. 실 네트워크 0건 · 실계정 0건.

```text
A 기본값(engine-auto-update.json 없음 = 켬) · engines 0개 · CCG_CLAUDE_BIN=''
  A0 engineAutoUpdate() = true                     ← 크리틱이 잰 바로 그 판
  A1 ★ .eu-card 가 뜬다                             (R1: 25초 폴링 0/1)
  A2 카드가 두 엔진을 줄로 그린다   ["Claude Code 9.9.9 새로 설치","Codex CLI 8.8.8 새로 설치","이전 버전 정리"]
  A3 done · cleanup done                            2,366ms
  A4 두 엔진 모두 설치·활성화 성공  claude null→9.9.9 done · codex null→8.8.8 done
  A5 from=null(신규 설치 표기)
  A6 디스크  config.json {"activeVersion":"9.9.9"} · codex-config.json {"activeVersion":"8.8.8"}
  A7 engine:state.active = 9.9.9
  A8 npm 왕복 = view 2 + install 2                  (EngineGate가 조회를 더 태우지 않는다)
  A9 .sd-title = null                               (카드 둘이 안 겹친다)
  A10 성공 카드는 스스로 닫힌다                      (done +1.65초)

B 자동 업데이트는 **켬**인데 아무도 안 도는 판 (CCG_NO_BOOT_ENGINE_UPDATE=1)
  B1 ★ .sd-title = "Claude 엔진 설치"                20.5초(= 업데이터 결론 대기 상한)
  B2 문구가 설치할 버전을 말한다                      "최신 버전(9.9.9)을 설치하면…"
  B3 .eu-card = false
   → R1의 3.0이 **영구적으로** 앉아 있던 상태(플래그는 켬 · 도는 것은 없음)에서
     이제 안내가 뜬다. 이것이 조기 반환을 좁힌 효과의 단독 증명이다.

C 최신이 이미 활성 + 옛 버전 하나
  C1 {active:false, done:true, cleanup:'done'}      1,321ms
  C2 카드 0장(할 말이 없다)
  C3 옛 버전 정리됨   claude ["9.9.9"] · codex ["8.8.8"]
  C4 install 0회

D 설치가 실패하는 판(가짜 npm이 코드 1)
  D1 흐름은 끝까지 간다(done)
  D2 항목마다 사유   "설치 실패 (npm 종료 코드 1)" ×2
  D3 실패 카드는 스스로 안 닫힌다 + .eu-err 에 사유
  D4 반쪽 폴더는 설치본으로 안 잡힌다  installed [] · active null
```

### 2.2 크리틱의 하네스를 그대로 재주행 — **27 / 27**

`bench/scratch/crit-t1t2.mjs`를 **복사**해 홈(`.poc-home-critT1T2r2`)·포트(9372)·산출 경로만
바꿔 돌렸다(기준 파일 `docs/critic/r28-t1t2-critic-r1.json` **미접촉**).

```text
A 설정 ▸ Account UI 왕복 10/10   (A7 로그인 URL 155ms)
B 엔진 미설치 안내      3/3       ← R1: 1 실패
C 엔진 채널             8/8       (latest 0.3.241 · 274개 · 622ms)
D 로그아웃 해지 규약    4/4
E 로그인 중복 시 취소   2/2
```

**B에는 한 줄을 고쳐야 했고, 그 사실을 여기 적는다.** 원본 B는 `.sd-title`을 25초
폴링한 **뒤에야** `.eu-card`를 한 번 본다. 성공한 부팅 업데이트 카드는 done +1.65초에
스스로 닫히므로(`EngineUpdateGate`의 설계 그대로) 그 표본 시각에는 이미 사라져 있다 —
**카드를 봤어도 못 본 것으로 센다.** 고친 것은 두 카드를 **같이** 폴링하는 한 줄이고,
나머지 코드는 원본 그대로다. 고치기 전 실측이 그 증거다:

```text
원본 그대로 :  B[default] gateTitle=null · engineUpdateCard=false   → B-핵심 실패
같이 폴링   :  B[default] gateTitle=null · engineUpdateCard=true    → B-핵심 OK
```

그리고 **표본이 아니라 시계열**로도 쟀다(같은 판, 실 npm · 3초 간격 · `.poc-home-dbgboot`):

```text
t+0s   eu=false  {active:false, done:false}
t+3s   eu=true   {active:true, items:[claude null→0.3.241 installing, codex null→0.149.1 pending]}
t+6s   eu=true   {active:true, items:[claude done, codex installing]}
t+9s   eu=true   {active:true, items:[claude done, codex done], cleanup:'done', done:true}
t+12s  eu=false  (성공 카드가 스스로 닫혔다)
engines 디렉터리 = ['0.3.241']   ← 진짜 Claude Code 엔진이 실제로 깔렸다
```

즉 **기본 설정의 새 사용자에게 3.0이 실제로 엔진을 깔아 주고, 그 사이 카드로 말한다.**
(이 주행은 격리 홈에 실 npm 설치를 시켰고, 주행 뒤 홈을 통째로 지웠다.)

### 2.3 §6.3 잠복 — 이제 **관측된다**

크리틱은 코드 근거만 남겼다(1.5초 간격 이중 로그인에서 A가 18ms에 착지 → 창이 안 열림).
같은 시나리오 E를 새 바이너리로 돌리니 A가 B 시작 **2ms** 뒤에 착지했고, A의 응답이
바뀌어 있다:

```json
p1 = {"ok":false,"loggedIn":false,"error":"다른 로그인이 시작되어 이 시도는 취소됐어요."}
p2 = {"ok":false,"loggedIn":false}          취소 후 착지 17ms · 목록 불변
```

`p1`의 그 문장이 **A가 자기가 최신이 아님을 알아채고 B의 핸들·폴더에 손대지 않은
경로**다. 번호를 spawn 앞에서 올린 덕에 B가 아직 핸들을 저장하기 전인 창에서도 성립한다.

### 2.4 게이트

```text
cargo test (크레이트별 · CARGO_TARGET_DIR=target-t1t2)
  ccg-auth       97 passed / 0 failed   (기준 97 — 후퇴 없음)
  ccg-engine    197 passed / 0 failed   (기준 197)
  ccg-store      76 passed / 0 failed   (기준 76)
  agentcodegui  106 passed / 0 failed   (기준 98 → +5 boot_update · +1 로그인 소유권
                                          · +2 는 같은 트리의 다른 갈래 미커밋분)
npm run typecheck / typecheck:app / typecheck:web      exit 0 · 0 · 0
scripts/poc-account-switch.mjs --out=-t1t2fixr1        PASS · 시나리오 6/6
bench/ab.mjs tauri --only=engine-gate-prompt --tag=t1t2fixr1   OK 1/1 · 성공률 100%
```

`poc-account-switch.mjs`에는 **두 줄을 심었다**(그 하네스의 격리 홈이 엔진 카드를 한 장도
안 띄우게):

1. `engine-auto-update.json {enabled:false}` — 부팅 업데이터가 그 홈에 진짜 npm 설치를
   시작하면 그 시간과 디스크가 이 하네스의 측정에 얹힌다(`bench/fixture.mjs:16`과 같은 이유).
2. `node_modules/@anthropic-ai/claude-agent-sdk/package.json` 마커 — 그 홈은 실행본만
   심어서 `engine:state`의 엄격 판정에 걸려 `active=null`이었다. 그러면 `EngineGate`가
   설치 안내(모달)를 띄우고 그 오버레이가 설정 화면 클릭 위에 앉는다.

---

## 3. 안 한 것 / 남은 것

| 항목 | 왜 / 상태 |
|---|---|
| npm·네트워크가 **둘 다** 없는 컴퓨터 | 카드가 여전히 0장이다. `latest`를 모르면 "무엇을 깔라"고 말할 수 없고 깔 수단도 없다 — **2.6.2도 같다**(파리티). 사용자 문장은 T3(엔진 층)의 스폰 실패 경로가 낸다 |
| `codex-auth:*` 쓰기 4채널 | 범위 밖(크리틱 §6.4). 설정 ▸ Account의 OpenAI 절반은 여전히 무반응 |
| `ImportGuard::RejectTokenCollision` 제품 호출자 0 | 2.6.2 `migrateAccounts` 대응물이 3.0에 없다(M5 범위의 선행 공백 — 크리틱 §6.2) |
| `m11r4_store_cas` 선행 flakiness | 이 라운드가 만든 것이 아니고(크리틱 §3.2 교대 12쌍) 이 라운드가 고치지도 않았다 |
| 6시간 주기 사일런트 업데이트 | 붙였지만 **실측하지 않았다**(6시간을 기다릴 수 없다). 부팅 흐름과 같은 `plan`·`RUNNING` 관문을 쓴다 |
| 부팅 업데이트가 도는 동안의 채팅 전송 | 활성 엔진이 바뀌는 순간에 턴이 시작되면 어느 실행본을 무는지 이 라운드는 안 쟀다. 2.6.2도 같은 구조(부팅 직후 = 세션 0개)라 파리티지만, 보장으로 적을 근거는 없다 |

---

## 4. 만진 파일

```
src-tauri/src/engine/boot_update.rs   (신규) 부팅 자동 업데이트 + 6시간 주기 + status/auto_update
src-tauri/src/engine/mod.rs                  pub mod boot_update
src-tauri/src/ipc/app_meta.rs                update-status 배선 · auto_update 위임 · state 사본 제거
src-tauri/src/ipc/accounts.rs                로그인 자식 소유권(시도 번호) + 테스트 1
src-tauri/src/flags.rs                       CCG_NO_BOOT_ENGINE_UPDATE
src-tauri/src/main.rs                        setup에서 흐름 시작(1줄)
app/src/components/EngineGate.tsx            조기 반환을 「돌고 있다」로 · 이벤트 구독
scripts/poc-boot-engine-update.mjs    (신규) 가짜 npm 하네스(A~D)
scripts/poc-account-switch.mjs               격리 홈 두 줄(카드 0장 보장)
docs/parity-fix-t1t2-r2.md            (신규) 이 문서
docs/critic/boot-engine-update-r1.json (신규) 실증 산출
```
