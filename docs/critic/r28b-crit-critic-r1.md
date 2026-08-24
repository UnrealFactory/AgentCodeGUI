# R28b 「CRIT」 확인 크리틱 R1 — **2차 독립 패스**: 여섯 항목 전부 다시 초록. 그리고 새 훅에는 **전역 codex 사용자용 구멍**이 하나 남아 있다

판정자: CRIT 확인 크리틱 2차 패스(새 컨텍스트) · 2026-08-25 · `feature/3.0.0-beta`
판정: **합격(pass = true).** 체크리스트 **6항 전부 크리틱 실측 통과.**

> 오케스트레이터가 같은 프롬프트로 이 라운드를 한 번 더 스폰했다. 1차 판정문(커밋 `399ea08`)이 이미 커밋돼
> 있어서 **그것을 근거로 쓰지 않고** 처음부터 다시 빌드·측정했다. 1차 판정문은 지우지 않고 이 문서 아래에
> 그대로 붙였다 — 같은 라운드의 독립 두 패스를 나란히 두는 편이 덮어써서 한쪽 실측을 잃는 것보다 낫다
> (ACCT 2차 패스 `4e88653`이 세운 규약).

대상: `d6fdcca`(엔진 축) · `25fd697`(npm 없는 판) · `4450e5f`(허브 스레드 쓰기 제거) · `9a14353`·`fbb6b9d`(보고서·문구)

---

## 0. 한 문단 결론

**여섯 항목은 내 손으로 다시 재도 전부 초록이다.** Codex 채팅은 90초에 발사하고(`unknown=1 · blocked=0`,
큐에 세워 둔 사용자 메시지까지 함께), 클로드 축은 그대로 0바이트를 지키다가 556초에 손을 들고(눌러서 313B),
npm 없는 컴퓨터는 2.3초에 사유가 적힌 카드를 얻는다. npm 있는 판도 22/0으로 안 흔들렸다.

**그런데 새로 판 공격 하나가 구멍을 냈다.** 이 라운드의 헤드라인은 *"Codex면 `account/rateLimits/read` 창을
본다"* 인데, 그 문지기 `codex_limit::can_ask()`의 첫 줄이 `codex_bin().is_file()`이다. `codex_bin()`은
**활성 설치본이 없을 때 전역 PATH 폴백(맨 이름 `codex`)을 돌려주도록 설계된 함수**다. 즉 codex를 전역으로
깔아 쓰는 사용자는 — 이 판정을 돌린 **바로 이 컴퓨터가 그렇다**(`C:\Users\User\AppData\Roaming\npm\codex.cmd`) —
계정이 등록돼 있고 턴도 도는데 한도 재검증만 `Unknown`(=판정 안 함=눈감고 발사)으로 떨어진다.
A/B 실측으로 잠갔다(§3).

1차 판정문이 최대 격차로 지목했던 **렌더러 쌍둥이**(`resumeVerdict`의 `!past` · `codex-auth:accounts-usage`
미구현)는 이 주행 도중 다른 갈래가 닫았다(`63bf667` RVERD R1 — 내 exe는 그 커밋 **이전**이다). 그래서 이번
판정의 최대 격차는 그 자리가 아니라 위의 것이다.

---

## 1. 무엇으로 쟀나 — 빌드와 정직한 한 줄

```
CARGO_TARGET_DIR=target-crit cargo build --release --features custom-protocol -p agentcodegui   → 1분 31초
exe 6,437,888바이트 · md5 307605a274115cb3807889081f760378
사본을 %TEMP%\ccg-critr1b\ 로 떼어 전 측정에 썼다(다른 갈래가 공용 target-crit을 갈아도 내 측정본은 안 바뀐다).
```

> ⚠ **정직하게 적는 두 줄.**
> ① 내 exe는 **순수 HEAD가 아니다.** 빌드 시점(2026-08-24 23:37) 워킹트리에 다른 두 갈래의 미커밋 변경이
> 있었다(ACCT: `engine/{hub,ident,lite,mod}.rs`·`ipc/parity/{aimsg,usage}.rs`·`ipc/system.rs`·`main.rs`·
> `crates/ccg-{auth,store}` / GIT: `crates/ccg-fs/src/git.rs`). **CRIT 자신의 파일은 전부 tracked-clean이었다**
> (`ccg-engine/src/{limit,runtime}.rs`·`engine/{limit_probe,codex_limit}.rs`·`EngineGate.tsx`·`Settings.tsx`·
> `app/src/lib/limitResume.ts`). 빌더가 적은 6,431,744바이트와 크기가 다른 이유가 그 미커밋분이다.
> ② 주행 중 워킹트리가 **움직였다.** 네 번째 갈래(RVERD)가 `limitResume.ts`·`codex_limit.rs`·`parity/mod.rs`를
> 고쳤다가 커밋했다(`63bf667`·`008664d`). 내 exe와 내 수치는 **그 전** 상태의 것이고, 그래서 이 판정은
> CRIT 라운드 자체를 잰다. RVERD가 무엇을 닫았고 무엇을 안 닫았는지는 §3.3에 적었다.

기준 결과 파일 **0개 덮음** — 전 주행이 `--out=bench/scratch/critr1b-*`(gitignored)로 나갔다.
실계정 0건 · 실 HTTP 0건(`CCG_NO_NET=1` 또는 가짜 npm) · 이름 기반 kill 0회(자기 PID 트리만).
격리 홈 `.poc-home-{codex-crit,engine-t3t4,cr1b-nonpm-t,cr1b-nps-t,cr1b-codexpath,bootupd-cr1b}` — 주행 후 전부 삭제됨(잔여 0).
CDP 포트 9425·9437·9461·9462·9463·9464.

---

## 2. 체크리스트 판정표 — 전부 이번 패스의 실측

| # | 항목 | 판정 | 내가 낸 수치 |
|---|---|---|---|
| 1 | 회귀 레시피(codex 채팅 · 리셋 지난 표) 발사 | **통과** | `poc-limit-codex` **8/0** · t=**90초** `spawns=1 · stdin 502B` · `{asks:1, fetches:0, blocked:0, unavailable:0, unknown:1}` · 큐 드레인 |
| 2 | 클로드 채팅 재검증(오판 소멸) 유지 | **통과** | `poc-limit-engine` **11/0**(`spawns=0 · stdin 0B` · `{asks:2, fetches:2, unavailable:2, unknown:0}`) · `--long` **14/0**(t=**556초** `ready+autoPaused · probes=6 · stdin 0B` → 눌러서 **313B**) |
| 3 | `poc-limit-resume` 무회귀 | **통과** | **141 / 0** |
| 4 | npm 없는 판 — 카드 + 사유 + 설정 목록 오류 줄 | **통과** | 카드 **2,306ms** · `.sd-why` 실물 · `[나중에·다시 시도]` · 설정 picker 「목록을 불러오지 못했습니다」 + `.vpick-why` |
| 5 | npm 있는 판 무회귀(부팅·설치·자동 닫힘) | **통과** | 가짜 npm **22/0** · A3 done **2,645ms**(기준 2,620ms) · A9 카드 겹침 0 · A10 자동 닫힘 · C2 할 일 없으면 카드 0장 |
| 6 | cargo 크레이트별 + typecheck 3종 | **통과** | ccg-engine **203/0**(기준 197 → **+6**) · agentcodegui **139/0** · ccg-store **79/0** · ccg-auth **100/0**(기본) · **116/0**(`--features net`) · typecheck 3종 초록 |

### 2.1 ★ 회귀 레시피 (항목 1)

```
   t= 85s spawns=0 stdin=0B hold=yes resetsAt=0 blocked=0 unknown=0
   t= 90s spawns=1 stdin=502B hold=no  resetsAt=-  blocked=0 unknown=1   ← 발사
   C5 사용자 메시지가 큐에서 풀려 나갔다 — {"queue":[],"spawns":1,"hold":null}
PASS — 8 통과, 0 실패
```

**하네스의 한계를 이번 패스도 확인했다(그리고 갈음했다).** 지시문의 레시피는 「클로드 주간 `pct:100`(해제
미래)」를 요구하는데, 이 하네스는 `CCG_NO_NET=1`이라 그 값을 **라이브로 못 세운다** — `peek_usage`가 읽는
메모리 캐시의 유일한 작성자가 `usage_get`의 HTTP 성공이고, `usage-cache.json`은 `accounts_usage` 전용이다.
그래서 클로드 축은 언제나 `Unavailable`이다. 갈음은 둘:

- `limit_probe::tests::a_codex_chat_is_never_judged_by_the_claude_weekly_window` — 캐시에 `weekly {pct:100,
  resetsAt:+180,000초}`를 심고 **같은 계정**으로 Claude/Codex를 각각 묻는다 → 앞 `Blocked{+180,000}`,
  뒤 `Unknown`, `blocked` 계수 불변. **내 cargo 주행에서 초록으로 돌았다**(`critr1b-cargo.log:411`).
- 위 실측의 `fetches:0` — codex 판정은 워커를 **깨우지도 않았다** = 클로드 축의 캐시를 재료로 쓸 길 자체가 없다.

### 2.2 클로드 축 무회귀 (항목 2)

`unknown=0`이 핵심이다 — **클로드 채팅이 새 갈래로 새지 않았다.** 그리고 `--long`의 착지 시각 **556초**가
T3T4 R3이 잰 556초와 같다 = §1.3의 `known && !past` 손질이 **시각을 아는 표의 사다리를 안 흔들었다.**

### 2.4 npm 없는 컴퓨터 (항목 4) — 문구까지 그대로 옮긴다

```
title : 엔진을 설치할 수 없어요
msg   : Claude Code 엔진이 설치되지 않았는데, 설치할 버전 목록을 가져오지 못했습니다.
        엔진 설치에는 npm(Node.js)과 인터넷 연결이 필요해요 — 확인한 뒤 다시 시도하세요.
sd-why: 레지스트리 응답을 읽지 못했어요(npm view 출력이 JSON이 아닙니다)
btns  : [나중에] [다시 시도]        firstSdMs = 2,306ms · .eu-card = 0장(표본 109)
설정 ▸ Engine : listAvailable = {latest:null, versions:[], error:…}
                .vpick-msg 「목록을 불러오지 못했습니다」 + .vpick-why 사유 한 줄
```

`fbb6b9d`의 문구 정정(「npm(Node.js)**과 인터넷 연결**」)이 실물에 실려 있다 — 잠깐 오프라인인 컴퓨터에게
없는 문제를 시키지 않는다. 2.6.2(Electron) 팔은 **일부러 안 돌렸다**(그쪽 부팅 정리가 `CCG_HOME`을 무시하고
사용자 실홈의 `codex-engines`를 지운다 — 크리틱 R2 §9).

### 2.5 npm 있는 판 (항목 5)

가짜 npm 22/0. 이 라운드가 새로 세운 `blocked` 카드가 **부팅 업데이터와 안 겹친다**는 것이 A9로 잠겼고
(`gateTitle=null`), 할 일이 없는 판에서는 카드가 한 장도 안 뜬다(C2). A3 2,645ms vs 기준 2,620ms = 잡음 안.

---

## 3. ★ 크리틱이 새로 판 공격 — 「전역 codex」 사용자에게는 이 라운드가 **없다**

### 3.1 무엇을 의심했나

`codex_limit::can_ask()`(`src-tauri/src/engine/codex_limit.rs:104`)의 첫 줄과 그 주석:

```rust
// 활성 설치본이 없으면 `codex_bin`은 맨 이름(`codex`)을 돌려준다 = 이 앱에는 실행본이
// 없다. 그 판에서는 codex 턴 자체가 못 뜨므로 한도를 물을 이유도 없다.
if !crate::engine::codex_versions::codex_bin().is_file() { return false; }
```

**뒷문장이 사실이 아니다.** `codex_bin()`은 폴백을 **의도적으로** 돌려준다 —
`crates/ccg-engine/src/codex/versions.rs:81`의 주석이 *"폴백 순서: 네이티브 → `.bin` shim → 전역 `codex`(PATH)"* 이고,
같은 파일의 테스트 이름이 `codex_bin_falls_back_to_path_when_nothing_is_installed`다. 그 값을 그대로 쓰는
두 자리에는 `is_file()` 문이 **없다**:

| 자리 | 무엇 | `is_file()` |
|---|---|---|
| `engine/hub.rs:313` | 턴을 띄우는 `CodexDriver` | **없다** |
| `ipc/parity/codex.rs:71` | 계정 목록·로그인 상태 왕복 | **없다** |
| `engine/codex_limit.rs:104·119` | 한도 재검증(`can_ask`·`instrument`) | **있다** |

그리고 `codex::driver::command_for`는 맨 이름을 `cmd /C ""codex" app-server"`로 풀어 **PATH에서 찾는다**
(`bare_name` 분기). 즉 턴은 돌고 한도만 안 묻는다는 가설이다.

### 3.2 A/B로 잠갔다 — 갈리는 값은 `is_file()` 하나뿐

하네스 `bench/scratch/critr1b-codexpath.mjs`. 두 팔의 씨앗은 **완전히 같다**: 클로드 계정 1 +
**등록된 codex 계정 1**(`codex-accounts.json` — `email`은 평문 필드다) + Codex 채팅 + 리셋 2시간 전 대기표 +
`CCG_NO_NET=1`. 다른 것은 `CCG_CODEX_BIN` 하나다.

| 팔 | `CCG_CODEX_BIN` | 판정 계수 | 결과 |
|---|---|---|---|
| **A · 전역 PATH** | `codex` (= `codex_bin()`의 폴백값과 **같은 값**) | `{asks:1, fetches:0, unknown:1, unavailable:0, blocked:0}` | **t=90초 발사**(`spawns=1`) · 대기표 소멸 |
| **B · 앱 설치본** | `<ccg-fakecodex.exe>`(실물 파일) | `{asks:2, fetches:1, unknown:0, unavailable:2, blocked:0}` | **미발사** · 대기표 유지 · 재확인 사다리 |

`fetches:0`이 A팔의 핵심이다 — 워커를 깨우지도 않았다. **codex 창을 물어볼 시도조차 없었다.**
그리고 이 판정을 돌린 컴퓨터에는 전역 codex가 실제로 있다(`where codex` →
`C:\Users\User\AppData\Roaming\npm\codex.cmd`) — 가상의 인구가 아니다.

`spawns`는 `driver.spawn()`의 **성공 여부와 무관하게** 오른다(`runtime.rs:1558`, 바로 위 줄이 `spawn_err`를
따로 받는다). 그래서 A팔의 `spawns=1`이 뜻하는 것은 정확히 **"런타임이 보내기로 결정했다"** 이다 —
한도가 아직 살아 있어도 그렇다.

### 3.3 RVERD(`63bf667`)가 닫은 것과 안 닫은 것

1차 판정문의 최대 격차(렌더러 `resumeVerdict`의 `!past` · `codex-auth:accounts-usage` 미구현)는 이 주행
도중 닫혔다 — 지금 HEAD(`b369599`)의 `limitResume.ts:175`가 `(known && !past)`이고 `codex_limit.rs:164`에
`accounts_usage()`가 생겼다. **그러나 이 §3의 구멍은 안 닫혔다**: 새 `accounts_usage()`도 `fill()` →
`instrument()`를 지나고, `instrument()`의 첫 줄이 여전히 `codex_bin().is_file()`이다(`:119`). 그래서 전역
codex 사용자에게는 이제 **설정 ▸ Account의 OpenAI 게이지까지** 같은 이유로 빈다 — 구멍이 좁아진 게 아니라 넓어졌다.

### 3.4 다음 라운드에 넘기는 지시

`is_file()`을 「실행본이 있나」의 대용으로 쓰지 마라. 판정은 **맨 이름이면 PATH에서 찾을 수 있는가**로
갈라야 한다(`where`/`which` 한 번 또는 실제 spawn 성공). 최소 수정:

1. `codex_limit::can_ask`·`instrument`의 `is_file()` 검사를 `codex_bin()`이 **맨 이름일 때 PATH 해석까지
   보는** 헬퍼로 바꾼다(허브 스레드에서 도는 자리이므로 결과는 캐시해야 한다 — `can_ask`는 tick마다 불린다).
2. 그 헬퍼는 `hub.rs:313`·`parity/codex.rs:71`과 **같은 판단**을 써야 한다. 세 자리가 서로 다른 기준으로
   "실행본이 있다"를 판정하는 지금 상태가 이 구멍의 뿌리다.
3. `codex_limit.rs:102-103`의 주석("그 판에서는 codex 턴 자체가 못 뜨므로")은 **지금 거짓이다.** 고치거나 지워라.
4. 회귀 못: `bench/scratch/critr1b-codexpath.mjs`를 `scripts/`로 승격해 A팔이 `unavailable`(발사 아님)로
   뒤집히는지 잰다. 지금 그 하네스는 `hole:true`를 돌려준다.

---

## 4. 곁다리 정정 하나 — 「ccg-auth 116」은 피처가 붙은 숫자다

빌더 보고와 1차 판정문의 `ccg-auth 116`은 **기본 주행의 숫자가 아니다.** `cargo test -p ccg-auth`는
**100**(82+0+0+14+2+1+1)이고, `tests/critic_m11r2_{tls,token}.rs`가 `#![cfg(feature = "net")]`라 기본에서는
`running 0 tests`로 돈다. `--features net`을 붙이면 **116**(91+1+6+14+2+1+1)이다 — 그때도 실 HTTP는 0건이다
(TLS 라이브 팔은 `CCG_CRITIC_LIVE_TLS` 미설정이면 즉시 빠진다 · 0.00초).
회귀 판정에는 영향이 없다(양쪽 다 0 실패). 다만 **같은 이름의 숫자가 두 개**라는 사실은 적어 둔다.

---

## 5. 산출물

| 무엇 | 어디 |
|---|---|
| poc-limit-codex | `bench/scratch/critr1b-limit-codex.json` |
| poc-limit-engine · `--long` | `bench/scratch/critr1b-limit-engine{,-long}.json` |
| npm 없는 판(부팅·설정) | `bench/scratch/critr1b-nonpm-{boot,settings}.json` |
| npm 있는 판(가짜 npm) | `bench/scratch/critr1b-bootupd.json` |
| ★ 전역 codex A/B | `bench/scratch/critr1b-codexpath.json` (+ 하네스 `.mjs`) |
| cargo 로그 | `bench/scratch/critr1b-cargo{,-auth-net}.log` |

(전부 gitignored — 기준 결과 파일은 한 개도 안 덮었다.)

---
---

# ↓↓↓ 아래는 같은 라운드의 **1차 판정문**(커밋 `399ea08`) — 지우지 않고 그대로 둔다 ↓↓↓

# R28b 「CRIT」 확인 크리틱 R1 — 두 격차는 실제로 닫혔다. 그리고 **같은 구멍의 쌍둥이**가 렌더러에 그대로 있다

판정자: CRIT 확인 크리틱(새 컨텍스트) · 2026-08-24 · `feature/3.0.0-beta`
대상 커밋: `d6fdcca`(엔진 축) · `25fd697`(npm 없는 판) · `4450e5f`(허브 스레드 쓰기 제거) · `9a14353`·`fbb6b9d`(보고서·문구)
판정: **합격(pass = true).** 체크리스트 **6항 전부 크리틱 실측 통과.**
남은 최대 격차 1건(이 라운드가 만든 것은 아니다)은 §4에 실측과 함께 적었다.

빌드는 크리틱이 직접 했다.
`CARGO_TARGET_DIR=target-crit cargo build --release --features custom-protocol` → **ccg-fs·agentcodegui 재컴파일(1분 28초)**,
exe **6,431,744바이트**(빌더가 적은 크기와 같다) · md5 `2bcf3c798e7eb1acb0f8bc907dccf8fe`
(빌더의 `f838824d…`와 다른 것은 **재빌드라서**다 — 크기·동작은 같다). 그 exe를 `%TEMP%\ccg-critr28b\`로 **복사해 두고**
모든 측정을 그 사본으로 했다(다른 갈래가 공용 `target-crit`을 갈아도 내 측정본이 안 바뀌게).

> ⚠ **정직하게 적는 한 줄**: 빌드 시점 워킹트리에 다른 갈래(GIT)의 **미커밋** `crates/ccg-fs/src/git.rs`(+232/−25)가 있었다.
> 즉 내 exe는 **순수 HEAD가 아니다.** 다만 이번 판정이 밟는 경로(`engine/limit_probe.rs`·`codex_limit.rs`·
> `ccg-engine/runtime.rs`·`app/src/components/EngineGate.tsx`·`Settings.tsx`)는 전부 tracked-clean이었고,
> `ccg-fs`는 git diff 모듈이라 한도·게이트 경로와 만나지 않는다.

---

## 0. 한 문단 결론

**Codex 채팅을 클로드 한도로 잠그던 자물쇠는 사라졌다** — 크리틱이 직접 돌린 `poc-limit-codex` **8/0**,
t=**85초**에 `spawns=1`, `limitProbe = {asks:1, unknown:1, blocked:0}`, 큐에 주차돼 있던 사용자 메시지도 그 순간 함께 나갔다(`queue []`).
**클로드 축의 안전장치는 그대로다** — `poc-limit-engine` **11/0**(전송 0 · stdin **0바이트**), `--long` **14/0**
(t=**556초** `ready+autoPaused`, 그 순간에도 stdin 0B → 눌렀을 때만 **313바이트**. T3T4 R3이 잰 556초·313B와 같은 자리).
**npm 없는 컴퓨터의 침묵도 끝났다** — 카드 **2,126ms**, 사유 줄까지 실린다. 설정 ▸ Engine도 목록 자리에 사유 한 줄을 세운다.

그리고 빌더가 *"라이브로 못 쟀다"* 고 적은 자리(§4-1의 `account/rateLimits/read` 왕복)를 **크리틱이 대신 쟀다.**
DPAPI 봉인은 장벽이 아니었다(PowerShell `ProtectedData.Protect` 한 줄). 합성 codex 계정을 심고 라이브로 확인한 결과
**(a) 경로는 양방향으로 작동한다**: codex 창이 100%면 **codex 자기 창의 해제 시각**(1시간 뒤)으로 재장전되고,
5%면 표가 풀려 발사된다. 클로드의 50시간은 한 번도 등장하지 않는다.

남은 격차는 **같은 구멍의 쌍둥이**다: 엔진에서 닫은 「시각 미상 표에도 출구」가 **렌더러 사본(`resumeVerdict`)에는
그대로 열려 있고**, 멀티 패널·팝아웃은 그 기계를 아직 쓴다(§4.1 — 실측).

---

## 1. 체크리스트 판정표 — 전부 크리틱 실측

| # | 항목 | 판정 | 근거(내가 낸 수치) |
|---|---|---|---|
| 1 | 회귀 레시피(격리 홈 · codex 채팅 · 리셋 지난 표) 발사 | **통과** | `poc-limit-codex` **8/0** · t=85s `spawns=1` · `unknown=1 · blocked=0` · 큐 드레인(§2.1) |
| 1+ | (크리틱 추가) codex 계정이 **등록된** 판의 (a) 경로 | **통과** | 창 100% → `resetsAt≈1시간`(3,599,517ms) 재장전 · 창 5% → 발사 · 와이어에 `rateLimits` 실물(§2.2) |
| 2 | 클로드 채팅의 재검증(오판 소멸) 유지 | **통과** | `poc-limit-engine` **11/0**(stdin 0B) · `--long` **14/0**(556s 착지 → 눌러서 313B)(§2.3) |
| 3 | `poc-limit-resume` 무회귀 | **통과** | **141 / 0**(§2.4) |
| 4 | npm 없는 판 — 카드 + 사유 + 설정 목록 오류 줄 | **통과** | 카드 **2,126ms** · `.sd-why` 실물 · picker 「목록을 불러오지 못했습니다」+사유(§2.5) |
| 5 | npm 있는 판 무회귀(부팅·설치·자동 닫힘) | **통과** | 가짜 npm **22/0**(A3 2,644ms vs 기준 2,620ms) · 실 npm `.eu-card` **3,244·3,363ms**(§2.6) |
| 6 | cargo 크레이트별 + typecheck 3종 | **통과** | 133 / **203** / 76 / 116 · 3종 초록(§2.7 — ccg-store 간헐 1건은 테스트 인프라, §5) |

---

## 2. 통과로 확인한 것 — 실측치

### 2.1 ★ 회귀 레시피 (체크리스트 1)

`node scripts/poc-limit-codex.mjs --exe=<내 사본> --out=<레포 밖>`

```
   t= 80s spawns=0 stdin=0B hold=yes resetsAt=0 blocked=0 unknown=0
   t= 85s spawns=1 stdin=0B hold=no  resetsAt=-  blocked=0 unknown=1     ← 발사
   C5 사용자 메시지가 큐에서 풀려 나갔다 — {"queue":[],"spawns":1,"hold":null}
PASS — 8 통과, 0 실패
```

빌더가 적은 t=90초와 5초 차이는 **표본 간격(5초)** 이다. 판정 재료는 같다.

**하네스의 한계도 적는다(빌더 보고에 없는 줄):** 이 하네스는 `CCG_NO_NET=1`이라
「클로드 주간 `pct:100`」을 **라이브로 못 세운다** — 클로드 축은 언제나 `Unavailable`이다
(`peek_usage`가 읽는 메모리 캐시는 `usage_get`의 **HTTP 성공**으로만 채워진다. `usage-cache.json`은
`accounts_usage` 전용이라 이 경로를 못 먹인다). 그래서 **「pct:100이었다면?」은 두 근거로 갈음했다**:
① `limit_probe::a_codex_chat_is_never_judged_by_the_claude_weekly_window`(캐시에 100%를 심고 같은 계정으로
Claude/Codex를 각각 묻는다 → 앞 `Blocked`, 뒤 `Unknown`, `blocked` 계수 불변) — 크리틱이 직접 돌려 초록,
② 아래 §2.2의 라이브(코덱스 판정이 **클로드 창을 재료로 쓰지 않음**을 값으로 확인).

### 2.2 ★ 크리틱 추가 공격 — 「codex 계정이 등록된 사용자」의 판을 **라이브로** 세웠다

빌더 §4-1: *"계정 스토어 `authEnc`가 DPAPI라 합성 codex 계정을 못 심는다 → 왕복은 라이브로 못 쟀다."*
**그 문장은 사실이 아니다.** `ccg_store::safe_storage::decrypt`는 `v10` 접두사가 없으면 **DPAPI 직접**으로 풀고
(`safe_storage.rs:155`), DPAPI는 PowerShell 한 줄로 만들 수 있다:

```powershell
[System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')  # → base64 → authEnc
```

그렇게 심은 계정 + 가짜 app-server(`ccg-fakecodex`가 `account/rateLimits/read`에 응답)로 두 판을 잤다
(`CCG_NO_NET`은 **끄고** 돌렸다 — 그 스위치가 `read_windows`를 즉사시키기 때문이다).

| 판(창 소진율) | t=90s | t=105s | 결론 |
|---|---|---|---|
| **100%**(해제 1시간 뒤) | `probes=1 · unavailable=1` | `hold.resetsAt = 3,599,517ms(≈1시간) · blocked=1` | **codex 자기 창**으로 재장전 — 클로드 50시간이 아니다 |
| **5%** | `probes=1 · unavailable=1` | `spawns=1 · hold=none · clear=1` | 표가 풀려 발사 |

부수 물증 둘: 가짜 app-server의 stdin 로그에 **`account/rateLimits/read` 실물**이 찍혔고,
격리 `CODEX_HOME`이 워커 쪽에서 물질화됐다(`codex/{accounts,shared}`) — 허브 스레드가 아니라는 §1.2 주장과 일치한다.

즉 **(a) 경로는 살아 있고 양방향으로 옳다.** 다만 그 확인은 **빌더가 아니라 크리틱이** 했다(§5-4).

### 2.3 클로드 축 무회귀 (체크리스트 2)

```
poc-limit-engine            11 / 0   t=90s probes=1 · t=105s probes=2 · spawns=0 · stdin 0B
   limitProbe = {asks:2, fetches:2, blocked:0, clear:0, unavailable:2, unknown:0}
poc-limit-engine --long     14 / 0   t=556s probes=6 ready=true autoPaused=true (stdin 0B)
   E10 눌렀더니 그때 나갔다 — spawns=1 · stdin **313바이트**
```

`unknown=0`이 중요하다: **클로드 채팅은 새 갈래로 새지 않았다.** 그리고 `--long`의 착지 시각(556초)이
T3T4 R3의 556초와 같다 = §1.3의 `known && !past` 손질이 **시각을 아는 표의 사다리를 안 흔들었다.**

### 2.4 렌더러 로직 무회귀 (체크리스트 3)

`node scripts/poc-limit-resume.mjs` → **141 통과 / 0 실패**(A~G 전 구간, 2.6.2 동결본 대조 포함).

### 2.5 npm(Node.js) 없는 컴퓨터 (체크리스트 4)

크리틱 사본 하네스(T1T2 R2의 `critr2-nonpm-ab.mjs`·`critr2-nonpm-settings.mjs`에서 **Tauri 팔만** 떼어
포트·홈·산출을 크리틱 것으로 바꾼 것. Electron 팔은 **일부러 안 돌렸다** — 그쪽 부팅 정리가 `CCG_HOME`을
무시하고 사용자 실홈의 `codex-engines`를 지운다).

```
부팅  : firstSd = 2,126ms
        title = 「엔진을 설치할 수 없어요」
        msg   = 「… 엔진 설치에는 npm(Node.js)과 인터넷 연결이 필요해요 — 확인한 뒤 다시 시도하세요.」
        why   = 「레지스트리 응답을 읽지 못했어요(npm view 출력이 JSON이 아닙니다)」
        btns  = [나중에, 다시 시도]         (.eu-card는 안 뜬다 = 카드 겹침 0)
설정 ▸ Engine :
        listAvailable = {latest:null, versions:[], error:"레지스트리 응답을 읽지 못했어요(…)"}
        picker msg    = 「목록을 불러오지 못했습니다」 + .vpick-why 사유 한 줄
        opts          = 0
```

R2가 잰 옛 판(45초 · 표본 54 · `.sd-title` **null** · `.vpick-msg` **null**)과 비교하면 **침묵이 사라졌다.**
문구 정정(`fbb6b9d`)도 확인했다 — 「npm이 없어요」 단정 대신 두 인구를 다 덮는 문장이고,
어느 쪽인지는 아래 사유 줄이 말한다.

### 2.6 npm 있는 판 무회귀 (체크리스트 5)

두 갈래로 나눠 쟀다(735MB 실설치를 끝까지 돌릴 이유가 없다).

| 무엇 | 기준(T1T2 R2) | 크리틱 실측 |
|---|---|---|
| 가짜 npm 전 흐름(부팅→설치→활성→정리→자동 닫힘) | 22/0 · A3 settle **2,620ms** | **22 / 0** · A3 settle **2,644ms** · A10 `.eu-card` 자동 닫힘 · B1 「Claude 엔진 설치」 · D3 실패 카드는 안 닫힘 |
| **실 npm** 부팅 카드 | `firstEu` 2,834 / 2,863ms | **3,244 / 3,363ms** · 줄 `["Claude Code0.3.241 새로 설치","Codex CLI0.149.1 새로 설치","이전 버전 정리"]` · `.sd-title` **0회** |

실 npm 쪽이 기준보다 **0.4~0.5초 느리다.** 회귀로 보지 않는 이유 셋: ① 같은 판의 결정적 하네스(가짜 npm)는
기준과 **24ms** 차이, ② 이 라운드가 만진 코드는 `latest === null`일 때만 갈라지는 자리라 npm 있는 경로를 안 지난다,
③ 측정 시각에 다른 두 갈래가 같은 기계에서 빌드·주행 중이었다(단일 측정 2회, 둘 다 3.2~3.4초).

### 2.7 회귀 그물 (체크리스트 6)

| 대상 | 크리틱 실측 | 빌더 보고 |
|---|---|---|
| `cargo test --bin agentcodegui` | **133 / 0** | 133 |
| `cargo test -p ccg-engine` | **203 / 0**(2 ignored) — 13 타깃 합산, 기준 197 대비 +6 | 203 |
| `cargo test -p ccg-store` | **76 / 0**(§5-3의 간헐 1건 주의) | 76 |
| `cargo test -p ccg-auth --features net` | **116 / 0**(91+1+6+14+2+1+1) | 116 |
| `npm run typecheck`(node·web) · `typecheck:app` | **3종 초록** | 3종 초록 |

이번 라운드가 심은 테스트 다섯도 **이름으로 확인**했다(전부 ok):
`the_probe_is_told_which_engine_the_limit_belongs_to` · `a_ticket_with_no_known_reset_time_still_reaches_the_users_hand` ·
`a_codex_chat_is_never_judged_by_the_claude_weekly_window` · `the_codex_windows_fold_like_the_renderer_does` ·
`an_unregistered_account_has_no_instrument_and_never_reaches_the_real_home`(허브 스레드가 폴더를 만들면 빨강).

---

## 3. 코드로 확인한 것 — 「어디서 갈리는가」

```text
check_hold (runtime.rs:3181-3192)
   축을 **표가 아니라 지금 정체성**에서 읽는다
   ProbeQuery{ billing: hold.account, engine: identity.engine_kind(), codex_account: identity.codex_account(), … }
        │
        ├── EngineKind::Claude → blocked_until_for(...)          ← 옛 경로 그대로(오판 소멸 유지)
        └── EngineKind::Codex  → codex_verdict(...)              ← 클로드 창을 **한 번도 안 본다**
                                   ApiKey            → Clear
                                   계정·실행본 없음   → **Unknown**(= 옛 계약 = 발사)
                                   스냅샷 차갑/실패   → Unavailable(표 유지 후 재확인)
                                   창 목록 있음       → fold_codex(= codexBlockedResetsAt의 Rust 짝)
```

`LimitProbe::probe`의 **기본 구현이 옛 메서드로 접힌다**(`limit.rs`의 trait 기본 구현 — 셸 훅만 `limit_probe.rs:293`에서 덮어쓴다)는 점도 확인했다 — 재생 하네스의 대본 훅은
한 글자도 안 바뀌고, 실제 조회를 하는 셸 훅만 갈래를 갖는다. 곁다리 손질도 한 줄로 확인된다:
`if probes < MAX_BLIND_PROBES || (known && !past)`(`runtime.rs:3240`).

---

## 4. 남은 격차 — 이 라운드가 만든 것은 아니지만, **같은 구멍의 쌍둥이**다

### 4.1 ★ 「시각 미상 표에도 출구」가 **엔진에서만** 닫혔다 — 렌더러 사본은 그대로 (실측)

크리틱이 `app/src/lib/limitResume.ts`를 esbuild로 묶어 **그 함수를 직접 돌렸다**:

```
① 시각 미상 표(resetsAt=null, codex) — 조회 실패를 20번 먹여도 ready 도달: **없음**(20/20 'hold')
   대조(시각 아는 표)                — probe 3에서 ready 도달
```

원인은 엔진에서 고친 그 조건의 **쌍둥이**다(`limitResume.ts:159`):

```ts
if (probes <= MAX_AUTO_ATTEMPTS || !past) return { kind: 'hold', … }   // past = resetsAt != null && resetsAt <= now
```

여기에 두 사실이 곱해진다.

1. **`codex-auth:accounts-usage`는 3.0 Rust에 없다.** 크리틱이 라이브로 불러 확인:
   `ipc_call('codex-auth:accounts-usage')` → `{"__unimplemented":true}`, 렌더러 심 경유 `window.api.codexAuth.accountsUsage()` → `[]`.
   `[]`면 `codexUsageUnavailable`이 참이라 codex 채팅의 렌더러 재검증은 **언제나** 「못 물어봤다」다.
2. **멀티 패널·팝아웃은 그 기계를 아직 쓴다.** `managed`를 넘기는 자리는 본채팅 하나뿐이다 —
   `App.tsx:635 managed: engineOwnsResume(chatStatus[activeChatId])`. `MultiAgent.tsx:1990 lrOptsFor`와
   `PanelWindow.tsx:290`의 옵션에는 `managed`가 **없다**(= `undefined` = 렌더러가 계속 주인).

⇒ **멀티 패널의 codex 채팅이 한도에 걸리고 그 문구에 `…|epoch` 꼬리가 없으면**, 그 패널의 대기표는
재확인만 무한 반복하고 「이어가기」 버튼도 자동 재개도 영영 오지 않는다. 이번 라운드가 엔진에서 없앤
바로 그 상태가, 사용자가 codex를 가장 많이 쓰는 표면에 남아 있다.

**다음 라운드 지시(우선순위 1)**: `resumeVerdict`의 조건을 엔진과 같은 뜻으로 맞추고
(`probes <= MAX || (resetsAt != null && !past)`), 같은 커밋에서 `codex-auth:accounts-usage`를 Rust에 노출하라
(조회기 `engine/codex_limit.rs`는 이미 있다 — 채널 하나면 설정 ▸ Account의 OpenAI 게이지까지 같이 산다).
**통과 조건**: 위 esbuild 하네스에서 시각 미상 표가 유한 회차에 `ready`가 되고, `accountsUsage()`가 빈 배열이 아닐 것.

### 4.2 자동 계정 전환은 **여전히 엔진 축을 안 본다** (코드 근거 · 기본 꺼짐)

`try_auto_switch`(`runtime.rs:696`)에는 `EngineKind` 분기가 없다. Codex 채팅의 대기표에서도 돌고,
성사되면 `self.hold = None`(`:768`) → 표를 걷고 발사한다. 즉 **codex 한도를 클로드 계정 교체로 "해결"했다고
사용자에게 말하는** 경로가 남아 있다(배너 `AccountSwitched`). 폭발 반경은 제한적이다 —
그 기능은 **기본 꺼짐**이고(`acct_switch.rs:216` `unwrap_or(false)`) 스냅샷 근거가 없으면 `pick`이 `None`이다.
그래도 이번 라운드가 없앤 사고와 **같은 축 혼동**이므로 다음 라운드 후보로 적어 둔다.

### 4.3 빌더가 「못 한다」고 적은 것이 사실은 5분이었다

§4-1의 DPAPI 벽은 없었다(§2.2). 그 결과 **이 라운드의 알맹이(`account/rateLimits/read` 왕복)가
빌더 손에서는 라이브 미검증인 채로 보고됐다.** 이번엔 크리틱이 대신 재서 통과로 확인했지만,
「못 잰다」는 문장은 그 자체가 검증 대상이다.

---

## 5. 하네스·규율 관측

1. **기준 결과 파일 0개 덮음.** 내 주행은 전부 `--out=<레포 밖>`이었고, 사본 하네스의 산출도
   `%TEMP%\ccg-critr28b\`다. 주행 뒤 `git status`에 `docs/critic`·`bench/results` 변경 없음
   (그 시각 워킹트리의 다른 변경은 M12R2·GIT 갈래의 것이다).
2. **레포의 코드·하네스 0줄 수정.** 크리틱 도구 넷(`critr28b-nonpm` · `critr28b-bootupd`(T1T2 사본) ·
   `critr28b-codexacct`(신규 공격) · `critr28b-renderer-gap`)은 전부 레포 밖에 있다.
3. ⚠ **`ccg-store` 테스트가 부하 중 간헐로 1건 빨강**(`migrate_v3::…a_damaged_global_pref_is_salvaged…`).
   단독 실행·`--test-threads=1`·연속 3회 주행은 전부 **76/0**. 원인은 이 라운드가 아니라 테스트 인프라다:
   `testkit::temp_home`(`lib.rs:248`의 뮤텍스)과 `testhome::take`(`testhome.rs:69`의 **다른** 뮤텍스)가
   같은 전역 `CCG_HOME`을 서로 모르고 갈아끼운다. 6회 주행 중 2회 재현(둘 다 GUI 하네스 동시 주행 중).
4. 이름 기반 kill **0**(전부 `killTree(pid)`) · 실계정 자격 **0** · 실 HTTP는 **실 npm 레지스트리 조회 2회**와
   합성 토큰의 usage 시도뿐(리프레시 토큰이 없으므로 **회전 0**).
5. 포트·홈은 다른 갈래와 안 겹치게 팠다: CDP **9442·9443·9445·9447·9448·9449·9450·9451**,
   격리 홈 `.poc-home-cr28b*`·`.poc-home-codexacct-cr28b-*`(주행 후 삭제) · `CARGO_TARGET_DIR=target-crit`.
6. 빌더 보고 수치는 **대체로 재현됐다**(8/0 · 11/0 · 14/0 · 141/0 · 133/203/76/116 · typecheck 3종 ·
   카드 2.1~3.1초 · 설정 사유 줄). 다른 곳 둘: 발사 시각 **85초**(보고 90초 — 표본 간격),
   부팅 카드 **2,126ms**(보고 2,485ms — 주행 편차).

---

## 6. 종합

| 사용자 기준 | 판정 |
|---|---|
| T3T4 R3이 실측한 치명 회귀(Codex 채팅 최대 7일 잠김)가 사라졌나 | **사라졌다.** 85초 발사 · `blocked=0` · 사용자 메시지 동시 드레인 |
| 그 수정이 클로드 축을 깼나 | **안 깼다.** 11/0 · `--long` 14/0(556초 착지 · 313B는 눌러야) |
| npm 없는 컴퓨터의 침묵이 끝났나 | **끝났다.** 2,126ms 카드 + 사유 + 설정 목록 사유 줄 |
| npm 있는 판이 느려졌나 | **아니다.** 결정적 하네스 22/0(2,644 vs 2,620ms) |
| 이번 라운드가 새 사고를 만들었나 | **안 만들었다**(크리틱이 만든 공격 둘 포함 전부 통과) |
| 남은 최대 격차 | **§4.1 — 렌더러 쌍둥이의 같은 구멍**(멀티 패널 codex 대기표에 출구가 없다) |
