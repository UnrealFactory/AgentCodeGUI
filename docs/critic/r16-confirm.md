# R16 확인 크리틱 — 엔진 한도 수정(`9dd0259`~`e0769d4`) · 렌더러 R4(`7470297`)

**임무**: 두 갈래의 "고쳤다"를 **빌더 실행을 믿지 않고 독립 재실행**해 확인/불일치를 가르고,
그 위에서 **새 구멍**을 판다. 이번 라운드의 사냥터는 리드가 지정한 둘이다 —
① 한도 오탐 코퍼스에 **없는 실전 문구**(2.6.2 이후 CLI가 새 문구를 냈을 가능성),
② `auto_paused` 뒤 **사용자 수동 재개 경로**.

빌더의 산출 JSON은 증거로 안 썼다. 하네스를 내가 다시 돌려 나온 값만 적는다.

---

## 0. 판정

| 갈래 | 판정 |
|---|---|
| **엔진 한도 수정**(`9dd0259` · `8696ce6` · `cd3a545` · `e0769d4`) | **확인.** `cargo test -p ccg-engine` **130 passed / 0 failed / 2 ignored** · `ccg-store 62` · `src-tauri 20`. `r14_limit_parity` **18종 불일치 0**, `r14_limit_loop` **6/6**(30분 헛 재개 **0회** · 시각 미상 5시간 **정확히 2회** 뒤 영원히 0 · 상한 뒤 사용자 손 출구 · 프로브 재장전 · F1×F2 조합). `.r14-cwdgone` **+3초에 사유 말풍선 · spinner 0 · stopBtn 0**. **재현 불일치 0건.** |
| **렌더러 R4**(`7470297`) | **확인.** `poc-dial` **47검사 PASS · 결함 0**(`settle` 3 신설 · `raise.same-para` 신설 포함, `settle.after-reflow worstErr 0` · `settle.scale-agrees gap 0`). `poc-live-chat` **PASS · 결함 0 · 8단계**. `user-echo` — 엔진이 연 턴에 `.msg.user .content = ["이어서 진행해 주세요","예약 하나"]`. `IdentityBand` 되돌리기 — 클릭 → **model `fable` · revision 2 · origin `revert` · 배너 소멸**. **재현 불일치 0건.** |

**추가 확인(빌더가 안 한 검사)** — 이식의 **정규식 세 개를 손으로 푼 자리**가 원본과 같은지
40,000줄 **차등 퍼즈**로 쟀다: 2.6.2 원본 함수를 파일에서 그대로 떼어 eval하고 같은 입력을
Rust에 먹였다. **의도치 않은 불일치 0**(`hit` · `resetsAt` 둘 다). 코퍼스 18줄이 못 보던
경계(`[^.\n]{0,24}`의 24, `\d{10}`의 자릿수, `hour` 앞 구분자)가 전부 일치한다.

**그러나 재현이 곧 안전은 아니다.** 새 발견 6건 + 정보 2건은 §4. 값어치 순:

- **N1(높음)** — **1순위 근거가 영구 사망 상태다.** `rate_limit_event.rate_limit_info.status`의
  실물 열거는 `allowed | allowed_warning | rejected`인데(설치본 `sdk.d.ts:4583`, 0.3.238~0.3.241 동일)
  엔진은 `"blocked"`만 막힌 것으로 읽는다. 이 라운드가 그 경로의 시각 축 버그를 고쳤지만
  **닿을 수 없는 코드를 고친 것**이고, 공짜로 오는 정확한 `resetsAt`(실측 `1787377200`)을 버린다.
- **N2(높음)** — **이 라운드의 머리 기사가 실기에서 거의 안 닿는다.** 오늘의 CLI가 한도로
  턴을 죽일 때 만드는 문장은 `You've hit your session limit · resets 3pm` 계열이고
  **`|1755150000` 꼬리가 없다.** 그래서 진짜 5시간 한도가 **시각 미상 갈래**로 가고,
  10분 → 2회 헛 재개 → `auto_paused`. 즉 **"자동 이어서"가 30분 만에 사람에게 넘어간다.**
- **N3(중간)** — 코퍼스에 없는 **새 오탐**: `Server is temporarily limiting requests
  (not your usage limit)`. 부정문 안의 `usage limit`이 ① 분기를 확정 hit로 통과한다.
  그 10분 동안 **사용자가 새로 친 말도 안 나가고**(게이트가 닫힌다), `managed` 배너에는
  **✕가 없다** — 되돌릴 손이 없다.
- **N4(중간)** — **재시작이 상한을 지운다.** `auto_paused`·`attempts`는 메모리에만 있고,
  디스크로 넘어간 `ready` 표는 **활성 채팅에서 출구 없는 배너로 굳는다**(24시간 실측: 소진 0 · 버튼 0).

---

## 1. 측정 조건

빌더 넷이 동시에 커밋 중이라 **착수 시점 HEAD를 핀**으로 박고 그 스냅샷만 썼다.
(주행 중 메인 워킹트리에 다른 라운드의 미커밋 편집이 10개 넘게 떴다 — `crates/ccg-lsp/`
`src-tauri/src/{notify,popout,tray}.rs` 등. 워크트리를 판 이유가 이것이다.)

- 핀: **`3c23525`**(착수 HEAD). `git diff 7470297..3c23525 -- src-tauri crates app scripts bench`
  = `bench/results/multi-tauri-3.0.0-default.json` **한 파일뿐**. 즉 내가 잰 코드는 판정 대상
  `7470297`(그리고 그 조상인 엔진 4커밋)과 **동일**하다.
- 격리 워크트리: `%TEMP%/ccg-r16c-wt`(detached `3c23525`) + `node_modules` 정션.
  **모든 하네스를 이 워크트리에서 돌렸다** — 격리 홈·CDP 산출물·`docs/critic/*.json`이
  전부 워크트리 안에 떨어진다. 그래서 추적 중인 기준 파일
  (`docs/critic/m-ux-r3-dial.json` · `m3-r4-live.json`)을 **한 바이트도 안 덮었다**(원복 불필요).
- Rust: `CARGO_TARGET_DIR=%TEMP%/ccg-r16c-tgt`. 공용 `target/`을 안 써서 경합·exe 잠금을 피했다.
- 렌더러 검증용 바이너리: 리드 지시대로 **메인 레포 빌드**(`npm run tauri:build`, 14:11 완료,
  **4,884,992 B** · sha256 `2729a0d075a37bea…`). 그 exe를 워크트리 `target/release/`로 복사해
  하네스를 돌렸다 — 바이너리는 메인 빌드, 산출물은 격리. 빌드 시점의 메인 워킹트리는
  `progress/data.js` 하나 외에 깨끗했다(그 뒤에 다른 라운드 편집이 들어왔다).
  빌더가 적은 4,884,480 B와 512 B 차이는 같은 소스에서 나온 PE 패딩 차이로 본다(코드 diff 0).
- `poc-live-chat`은 `--tag=r16c`/`--tag=r16p`/`--tag=r16q`로 돌렸다(홈·포트·산출물 분리).

### 안전 장부

| 항목 | 결과 |
|---|---|
| 사용자 실앱(Electron 2.6.2) | **동일한 6 PID**(6644·9840·12924·23792·24836·26924), 시작 시각도 R12·R14 기록과 같다. 건드림 0 |
| 이름 기반 kill | **0회.** 죽인 것은 하네스가 spawn한 PID 트리뿐(`killTree`) |
| 실홈 | **읽기/복사만.** `engines/`는 정션(poc-dial) · `claude.exe`·`sdk.d.ts`는 읽기 전용 스캔. `accounts.json`은 내 첫 명령(14:0x) **전인 12:15**이 마지막 수정이고 주행 내내 불변. `codex-accounts.json` md5 `695516d1…` — R12·R14와 **동일** |
| 격리 홈 잔존 | **0**(`.poc-home-*`·`.critic-home-*` 전부 회수) |
| 메인 레포 | 이 보고서 한 장. 그 밖에 바꾼 것은 `target/`·`app/dist`(둘 다 gitignore) — 추적 파일 수정 0 |
| 메모리 측정 | **안 했다**(리드 지시 — 동시 주행 노이즈) |
| 돈 | 실 CLI 턴: poc-dial(queue 3턴 · own 1턴) · poc-live-chat(live 1턴). 나머지는 가짜 CLI·가상 시계·합성($0) |

---

## 2. 엔진 재현

### 2.1 게이트

| 빌더 주장 | 내 실측 |
|---|---|
| `ccg-engine` 130 green (+2 ignored) | **130 passed / 0 failed / 2 ignored** — lib 37 · frame_coverage 5 · identity_golden 11 · live_smoke 0(+2 ignored) · **r14_limit_loop 6** · **r14_limit_parity 3** · replay 27 · replay_standing 36 · zz_coverage_gate 5 |
| `ccg-store` 62 | **62 passed / 0 failed** |
| `src-tauri` 20 | **20 passed / 0 failed** |

### 2.2 `r14_limit_parity` — 18종 **불일치 0**

```
HITS 9 / MISSES 9 / 불일치 0
  R14가 오탐으로 잡았던 셋이 전부 miss로 죽었다:
    "context limit reached: conversation too long" · "output token limit exceeded"
    · "rate limited; retry shortly"
  꼬리도 함께 돌아온다: "…usage limit reached|1755150000" → 1755150000
                        "Session limit reached|1799999999" → 1799999999
```

### 2.3 `r14_limit_loop` — 6/6, 두 갈래 모두 재현

```
the_engine_reads_the_reset_epoch_in_the_error_text
    hold.resets_at = Some(19000000) · due_at = Some(19090000) · now = 1030000   (= 리셋 + 90초)
a_still_blocked_resume_loops_every_six_and_a_half_minutes
    30분 동안 spawns 1 → 1 · 보낸 사용자 텍스트 1건: ["첫 턴"]     ← R14: 30분에 4회
a_hold_without_a_reset_time_stops_blind_firing_at_the_cap
    5시간 동안 눈감고 쏜 재개 2회 · hold{ready:true, auto_paused:true, attempts:2}
    그 뒤 다시 5시간 → 0회
the_user_can_still_press_resume_after_the_cap                     ok  (수동 출구)
the_probe_rearms_instead_of_firing_while_still_blocked            ok  (재장전은 전송이 아니다)
a_context_overflow_error_never_arms_a_hold                        ok  (F1×F2 조합)
```

단언 방향도 봤다. ②는 R14가 붉게 남긴 그 단언 그대로고(`spawns1 <= spawns0` ·
`texts == ["첫 턴"]`), ①만 뒤집혔다(꼬리를 **읽는다**) — 커밋 설명과 일치한다.
나머지 넷은 이 라운드가 더한 잠금이다.

### 2.4 F4 엔진 몫 — `.r14-cwdgone.mjs`(크리틱 소유 도구, 무수정)

```
 +3s  hasProbe true · spinner 0 · stopBtn 0 · composerDisabled false
      "오류 · 오후 2:19 · 작업 폴더를 찾을 수 없어요 — c:\…\this-folder-does-not-exist.
       고친 뒤 다시 보내면 이어집니다."
+10s / +25s / +40s  같은 화면(나레이션 없음 · 중지 버튼 없음)
```

R14의 그림(40초까지 `stopBtn 1` · 나레이션 회전 · 오류 0건)이 **+3초에 문장 하나로 바뀌었다.**
`errMsgs []`는 **도구의 눈이 안 닿는 것**이지 화면이 빈 것이 아니다 — 그 도구의 셀렉터는
`.msg.error, .msg .error, .notice`인데 이 렌더러는 `.error-row`/`.error-text`를 쓴다
(`Chat.tsx:905,915`). 빌더가 §R5.4에 적은 해명이 **맞다**(내가 소스로 확인).

---

## 3. 렌더러 재현

### 3.1 `poc-dial` 전체 — **47검사 PASS · 결함 0**

```
[dial] 14   [active] 2   [raise] 7   [settle] 3   [own] 9   [bg] 5   [queue] 7   = 47
```

R14가 F3으로 잡은 축이 그대로 초록이다 — 그리고 **저울이 바뀐 자리**가 핵심이다:

```
settle.anchor-saved   {"id":"p2a14","off":-331}
settle.after-reflow   {"worstErr":0,"at":1200,"samples":[0,0,0,0]}    ← R14: -365 ×4 (3/3 결정적)
settle.scale-agrees   {"gap":0,"landingGot":-331,"live":-331}         ← 착지 기록 == 화면
raise.same-para       {"i":13,"off":-163,"text":"패널 2 · 구간 4 검토 결과 세대 "}
raise.same-pixel      {"dTop":274,"dH":275,"sameW":true,"sameCh":true,"sameH":false}
```

`same-pixel`이 **완화가 아니라 강화**라는 주장도 형태로 확인된다: 전제(`sameW`·`sameCh`)가
서면 픽셀을 묻고, 문서 높이가 변했으면 `dTop ≈ dH`를 묻는다(274 vs 275). R14 §2.3이
"성립 불가"로 판정했던 `|after.top − before.top| < 40`을 그대로 두지 않았다.

한도 배너의 거짓말도 사라졌다:

```
own.signal      hold.resetAt = 1787461967.63   ← unix 초(R4까지는 런타임 ms라 "약 0")
own.bar-managed {"sub":"약 1분 뒤 자동으로 이어서 계속해요","x":0,"go":0}
own.auto-fired  {"spawns":1}      own.press-resume {"spawns":1,"hold":null,"auto":true}
```

### 3.2 `poc-live-chat` — **PASS · 결함 0 · 8단계**

r81 1 · dialog 4 · winsave 7 · events 12 · error 1 · reload 4 · slots 6 · live 9.

### 3.3 `user-echo`(F5) — 하네스가 안 보던 자리를 내가 봤다

커밋된 하네스는 `B2-이어서 {spawns, dom}`만 찍는다(그 둘은 R14 때도 초록이었다).
그래서 **하네스 사본**(`scripts/.r16-live-probe.mjs` — 단언은 안 건드리고 관찰만 추가)으로
원 DOM을 읽었다:

```
[RELOAD] B1-재장전 … c-see{auto:true} · c-hide{auto:false}
  · [r16] .msg.user .content = ["이어서 진행해 주세요","예약 하나"]
  ✓ B2-이어서 {"spawns":1,"dom":true}
```

앞이 한도 재개, 뒤가 예약 드레인이 보낸 문장이다. **보고서의 수치와 글자 그대로 일치.**

### 3.4 `IdentityBand` 되돌리기(M3) — 클릭까지 재현

```
  · [r16] band  __ccgIdentity {n:2, rows:[{revision:0,origin:"default",model:"fable"},
                                          {revision:1,origin:"engine_fallback",model:"sonnet"}]}
          "모델이 자동 전환됐어요 · 엔진이 이 대화의 모델을 Sonnet 5(으)로 바꿨어요
           — 이후 대화도 같은 모델로 갑니다. [되돌리기]"
  · [r16] revert {"clicked":true}
          after  model "fable" · revision 2 · band []   (배너 소멸)
          __ccgIdentity {n:3, +{revision:2, origin:"revert", model:"fable"}}
```

히스토리 보존(§6.3 — 되돌리기가 **새 리비전**이다)도 그대로다.

---

## 4. 새 발견

### N1 [높음] 1순위 근거의 `status` 값이 실물에 없다 — `"blocked"` ∉ 열거

`frames.rs:224`는 `blocked = (status == "blocked")`로 읽는다. 설치본이 함께 배포하는
타입이 그 값을 부정한다:

```ts
// engines/0.3.241/…/@anthropic-ai/claude-agent-sdk/sdk.d.ts:4583  (0.3.238·239·240 동일)
export declare type SDKRateLimitInfo = {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
    rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | …;
    overageStatus?: 'allowed' | 'allowed_warning' | 'rejected'; … }
```

번들 바이너리의 zod 스키마도 같다(`Dr(["allowed","allowed_warning","rejected"])`),
그리고 **우리 레포의 실측 로그가 이미 그 어휘를 갖고 있었다**:
`tests/fixtures/wire/*.jsonl`의 `overageStatus:"rejected"`.
그런데 합성 픽스처(`fixtures/synth/rate-limit-blocked.jsonl`)는 스스로 *"아무도 이 모양을
본 적이 없다(assumed)"*라고 적어 두고 **`"blocked"`를 지어냈다.**

```
r16_probe::the_wire_never_says_blocked
  status=rejected → blocked=false resets_at=Some(1787377200)
```

값어치가 둘이다. ⑴ 이 라운드가 `rate_limit_event` 경로의 시각 축 버그(`s*1000`을 런타임 ms로
앉히던 것)를 고쳤는데 **그 코드에는 도달할 수 없다** — 커밋 설명의 *"실기라면 대기표가
2026년에 앉아 영원히 안 풀린다"*는 지금도 참이 될 수 없다. ⑵ `rejected`가 실을 `resetsAt`은
**정확한 벽시계 리셋 시각**이다. N2의 "꼬리가 없다"를 정확히 메우는 값을 지금 버리고 있다.
한 줄 고치면(`matches!(status, "rejected")`) 1순위 근거가 살아난다.

### N2 [높음] 오늘의 CLI 한도 문구엔 `|epoch` 꼬리가 없다 — 머리 기사가 안 닿는다

설치본 `claude.exe`(0.3.241, 337,745,056 B)에서 한도 관련 문자열 **1,473조각**을 뽑고
(`.r16-clistrings.mjs`) 그중 조립 지점을 역추적했다:

```js
// 429 처리부
if (e.status === 429) {
  let s = <구독 모드>, a = nKp(e) /* anthropic-ratelimit-unified-* 헤더 → {status:"rejected", resetsAt, rateLimitType} */;
  if (s && a && !c) { let h = e3a(a, t); if (h) return Xd({content: h, error:"rate_limit", …}) }   // ← 구독 한도의 문장
  …
}
// 그 문장을 만드는 곳
function utt(e,t,r,n){ …; return `You've hit your ${e}${t}${o}` }
ebt = { five_hour:"session limit", seven_day:"weekly limit", seven_day_opus:"Opus limit",
        seven_day_sonnet:"Sonnet limit", seven_day_overage_included:"Fable 5 limit",
        overage:"usage credit limit" }
// 시각은 b$(resetsAt, true) — **사람 글자**("resets 3pm" / "resets Aug 20")
```

즉 오늘 5시간 창이 막으면 문장은 `You've hit your session limit · resets 3pm`이다.
`Claude AI usage limit reached` 라는 문자열은 **번들에 없다**(0 hits) — 그건 API 429 본문의
`error.message`이고, 지금 경로에서는 헤더가 있는 순간 CLI 자기 문장으로 **대체된다**.

Rust 판정자에 그대로 먹였다(`r16_probe::cli_corpus_2026_08_table`):

```
판정   리셋꼬리   문구
hit    -         "You've hit your session limit · resets 3pm"
hit    -         "You've hit your weekly limit · resets Aug 20"
hit    -         "You've hit your Opus limit · resets Aug 20"
hit    -         "You've hit your Sonnet limit · resets Aug 20"
hit    -         "You've hit your usage limit · resets 3pm"
hit    -         "You've hit your limit · resets 3pm · progress saved"
hit    -         "Usage limit reached again after you continued"
```

**잡기는 다 잡는다**(판정자는 건강하다). 문제는 **`resets_at`이 전부 `None`**이라는 것이다.
그러면 §R5가 세운 두 갈래 중 나쁜 쪽으로 간다:

| | 커밋이 그린 그림 | 오늘 CLI에서 실제로 가는 길 |
|---|---|---|
| 대기 | 리셋 시각 + 90초 — **정확히 그때** 한 번 | `PROBE` 10분 → ×2 백오프 |
| 발화 | 1회 | 눈감고 **2회**(둘 다 같은 에러로 죽는다) |
| 착지 | 이어서 계속 | **`auto_paused` — 사람에게 넘김** |

5시간 창에서 **약 30분 만에 자동이 끝나고 배너가 사람을 기다린다.** 스팸은 막았지만
"자동 이어서"의 약속(리셋 시각에 스스로 잇는다)은 실기에서 거의 안 지켜진다.
막는 것을 푸는 값이 N1(공짜로 오는 `resetsAt`)에 있다는 게 이 둘을 붙여 읽는 이유다.

> 정직한 여백: 나는 **번들이 문장을 조립하는 코드**를 읽었지, 실제 429를 받아 낸 것이 아니다.
> 헤더(`anthropic-ratelimit-unified-*`)가 없는 응답에서는 지금도 API 원문이 실려 꼬리가
> 살아 있을 수 있다(그 분기도 번들에 있다). 확정적으로 말할 수 있는 것은
> *"헤더가 붙은 구독 429에서 CLI가 만드는 문장에는 꼬리가 없다"* 하나다.

### N3 [중간] 코퍼스에 없는 **새 오탐** — 부정문 안의 `usage limit`

```js
WvE = "Server is temporarily limiting requests (not your usage limit)"
let f = s ? WvE : "Request rejected (429)", m = `this may be a temporary capacity issue.…`;
return Xd({ content: `${Y0}: ${f} · ${p||m}`, error:"rate_limit", apiErrorIsTransient: s })
```

이 분기는 **구독자인데 한도 헤더가 없는 429** = *일시 과부하*다. 2.6.2 원본 주석이
*"일시 과부하(rate limited/overloaded 재시도류)도 CLI가 자체 재시도하므로 잡지 않는다"*고
못박은 바로 그 부류인데, 문장 안에 `usage limit`이 **부정문으로** 들어 있어 ① 분기
(`t.contains("usage limit")` → 확정 hit)를 그대로 통과한다.

```
r16_probe::a_transient_429_is_still_classified_as_a_usage_limit   hit · resets_at None
r16_probe::a_ten_minute_wait_…                                    due_at = armed + 10분
r16_probe::during_a_phantom_hold_the_users_own_message_is_parked_too
    9분 뒤: spawns +0 · 큐 1건 · 보낸 텍스트 ["첫 턴"]
r16_probe::a_transient_429_costs_two_doomed_cli_turns
    일시 429 → 눈감고 쏜 재개 2회 · ["첫 턴","이어서 진행해 주세요","이어서 진행해 주세요"]
```

사용자가 보는 것: 서버가 잠깐 붐볐을 뿐인데 **"사용 한도에 도달했어요 · 약 10분 뒤 자동으로
이어서 계속해요"**가 뜨고, 그 10분 동안 **새로 친 말도 안 나간다**(`hold_gate_open()`이
닫혀 있어 조용히 예약으로 접힌다). 그리고 `managed` 배너에는 **✕가 없다**
(엔진 대기표 취소 채널 미구현 — 렌더러 §R3이 스스로 적은 "남은 것"). 되돌릴 손이 없다.

상한(`MAX_AUTO_ATTEMPTS=2`)이 피해를 2턴으로 묶는다는 점에서 R14 시절보다는 훨씬 낫다.
그래도 **판정자 자체의 구멍**이고, 18줄 코퍼스로는 절대 안 보인다.
고치는 법은 싸다 — ① 분기 앞에 `not your usage limit` 부정문 가드,
또는 `apiErrorIsTransient`가 붙는 문장 지문(`temporary capacity issue`)을 차단벽에 추가.

### N4 [중간] 재시작이 상한을 지우고, 넘어온 `ready` 표는 **출구 없는 배너**가 된다

디스크로 내려가는 것은 `{resetsAt, ready}` 둘뿐이다(`hub::persist_hold:928`).
`auto_paused`·`attempts`는 없고, `reload_state:532-534`가 **명시적으로** `auto_paused:false ·
attempts:0`으로 되살린다(주석: *"재장전은 새 에피소드다 — 지난 판의 헛발질 횟수는 디스크에 없다"*).

```
r16_probe::restarting_the_app_hands_back_two_more_blind_shots
  재장전: ready=true auto_paused=false attempts=0 · 1판이 쓴 눈감은 발화 2회
```

⑴ **상한이 재시작마다 초기화된다** — 오탐으로 걸린 표라면 앱을 켤 때마다 2턴씩 더 태운다.

⑵ 더 나쁜 쪽은 **넘어온 `ready:true`**다. `mod.rs::reload_pending`은 *보이는 자리 + 활성
채팅*에 `auto=true`를 준다. 그 채팅의 표가 `ready:true`로 저장돼 있었다면(= 화면 밖에서
풀렸거나 `auto_paused`로 멈춘 표) 재장전 뒤 상태는 `ready && auto_resume && !auto_paused`다:

- `check_hold`는 `!h.ready`만 본다(`runtime.rs:2781`) → **다시 판정하지 않는다.**
- `lite.rs:93` → `autoResume: true` → `resumeOwner.ts::canPressResume = ready && auto !== true`
  → **false** → 「이어가기」 버튼 없음. `managed` 분기에는 ✕도 없다.
- 배너 문구는 `"한도가 풀렸어요 — 곧 이어서 계속해요"`(`Chat.tsx:3024`).

```
r16_probe::a_ready_hold_that_survived_a_restart_has_no_exit
  24시간 뒤: hold{ready:true, auto_paused:false} · auto_resume=true · spawns +0
r16_probe::the_same_ticket_reloaded_offscreen_does_offer_the_button   (auto=false면 버튼이 있다)
r16_probe::the_stuck_banner_does_not_wedge_sending                    (새 전송은 나간다)
```

**쐐기는 아니다** — 게이트가 열려 있어 새 전송은 정상이다. 남는 것은 *"곧 이어서 계속해요"*라고
적힌 채 **영원히 안 끝나고 누를 곳도 없는 배너**다. 침묵 no-op(D7)의 표시판이고,
`cd3a545`가 `auto_paused` 쪽에서 닫은 문과 **같은 모양의 문**이 재시작 경로에 하나 더 있다.
싼 수선 둘: `reload_state`가 `ready`를 받으면 `auto_paused`로 되살리거나,
`check_hold`가 `ready` 표도 한 번은 다시 보게 하거나.

### N5 [낮음] `auto_paused` 배너가 엔진의 사유와 **반대말**을 한다

같은 사건에 두 문장이 뜬다:

| 화자 | 문장 |
|---|---|
| 엔진 Notice(`runtime.rs:2838`) | "자동으로 이어서 보낸 turn이 계속 한도에 막혀서 자동 재개를 멈췄어요 — 준비되면 눌러서 이어가세요." |
| 배너(`Chat.tsx:3025`) | **"한도가 풀렸어요 — 눌러서 이어가기"** |

`auto_paused`는 *"풀렸는지 모르겠고 그만 두드린다"*이지 *"풀렸다"*가 아니다.
배너가 스레드에 남는 Notice보다 오래 보이는 표시판이라 **거짓말이 이기는 구조**다.
계약면에 `auto_paused`가 없어서 화면이 두 상태를 구분 못 하는 것이 원인이고,
보고서 §R5.6이 "남은 것"으로 적은 그 항목이 여기서 값을 낸다.
(곁다리: 저 Notice의 `"보낸 turn이"`는 한국어 문장에 영어 낱말이 박힌 자리다.)

### N6 [낮음] **리셋으로 안 풀리는** 것들에도 대기표가 걸린다

같은 코퍼스 주행에서:

```
hit  "Your group's usage limit is set to $0 · run /usage-credits to ask your admin…"   ← 관리자가 잠갔다
hit  "You've hit your monthly spend limit. Run /usage-credits to manage your limit"    ← 달이 바뀌어야 풀린다
hit  "Approaching usage limit · resets 3pm"          ← 경고다(턴을 안 죽인다)
hit  "You're close to your usage limit"              ← 같음
hit  "You've reached your Fable 5 limit."            ← 크레디트 소진
```

앞 둘은 10분 뒤 2턴을 태우고 `auto_paused`로 끝난다(상한이 있어서 파국은 아니다).
경고 둘은 오늘은 `severity:"warning"` 경로라 `error_text`로 안 오지만, **문장은 실재하고
판정자는 hit로 읽는다** — 이 경로가 언젠가 에러로 접히면 그날 바로 오탐이 된다.
차단벽에 `approaching` · `close to` · `is set to $0`를 더하는 것이 싸다.

### N7 [정보] 한국어 가지는 **원본에 없는 추가**다 — 퍼즈 차이의 전부

40,000줄 차등 퍼즈 결과:

```
대조 40000줄 · 한국어 가지 전용 차이 1176 · 그 밖 hit 불일치 0 · resetsAt 불일치 0
```

**의도치 않은 이식 오류는 0이다**(손으로 푼 `parse_epoch`·`banner_limit_reached`·`your_limit`이
경계까지 원본과 같다 — 이 라운드의 가장 조용한 성과다). 1,176건은 전부
`사용 한도` 가지 때문이고, 2.6.2 원본에는 한국어 분기가 **아예 없다**.
위험은 낮다(우리 CLI가 한국어 한도 문구를 내지 않는다). 다만 `r14_limit_parity`가
"불일치 0"이라고 적는 근거는 **한국어가 한 줄도 없는 18줄 코퍼스**라는 점은 기록해 둔다.

### N8 [정보] 재현 못 한 것 하나 — 중지 도중 도착한 한도 에러

`on_result`는 `arm_hold`를 `is_error`만 보고 부르고(`runtime.rs:2549-2558`),
`Interrupting`·`aborted` 조기 반환은 **그 뒤**에 있다(`:2569`). 읽는 대로면
"중지한 턴의 에러 문구로 대기표가 걸리는" 창이 있고, 그건 §7.3이 *"안 그러면 중지했는데
몇 시간 뒤 혼자 이어서 보낸다"*로 못박은 것과 반대다. **재현에 실패했다** —
스텁 드라이버로 런타임을 `Interrupting`까지 못 밀어 넣었다(state가 `Idle`에 머물렀다).
그래서 **발견으로 세지 않는다.** 다음 라운드가 실 CLI로 한 번 밟아 보면 싸게 갈린다.

---

## 5. 재현 명령

```bash
# 핀 (메인 워킹트리에 남의 미커밋 편집이 있다)
git worktree add --detach %TEMP%/ccg-r16c-wt 3c23525
cd %TEMP%/ccg-r16c-wt && cmd //c "mklink /J node_modules C:\Code\AgentCodeGUI\node_modules"
# 렌더러용 바이너리는 메인 레포 빌드를 복사한다(산출물만 격리)
(cd C:/Code/AgentCodeGUI && npm run tauri:build)
cp C:/Code/AgentCodeGUI/target/release/{agentcodegui,ccg-fakecli}.exe target/release/

# 엔진
CARGO_TARGET_DIR=%TEMP%/ccg-r16c-tgt cargo test -p ccg-engine                       # 130 (+2 ignored)
CARGO_TARGET_DIR=%TEMP%/ccg-r16c-tgt cargo test -p ccg-engine --test r14_limit_parity -- --nocapture
CARGO_TARGET_DIR=%TEMP%/ccg-r16c-tgt cargo test -p ccg-engine --test r14_limit_loop   -- --nocapture
CARGO_TARGET_DIR=%TEMP%/ccg-r16c-tgt cargo test -p ccg-store                        # 62
(cd src-tauri && CARGO_TARGET_DIR=%TEMP%/ccg-r16c-tgt cargo test)                   # 20

# 렌더러
node scripts/poc-dial.mjs                            # 47검사
node scripts/poc-live-chat.mjs --tag=r16c            # 8단계
node docs/critic/tools/.r14-cwdgone.mjs              # F4(+3초 사유)
node scripts/.r16-live-probe.mjs --only=reload --tag=r16p   # ★ user-echo 원 DOM
node scripts/.r16-live-probe.mjs --only=dialog --tag=r16q   # ★ IdentityBand + 되돌리기 클릭

# 새 발견
CLI=~/.agentcodegui/engines/0.3.241/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe
node docs/critic/tools/.r16-clistrings.mjs "$CLI" --out=docs/critic/r16-clistrings.json   # N2·N3 원천
node docs/critic/tools/.r16-clifind.mjs   "$CLI" 'function utt' --ctx=800                 # 문장 조립부
node docs/critic/tools/.r16-parity-fuzz.mjs                                               # N7 코퍼스 40k
CARGO_TARGET_DIR=%TEMP%/ccg-r16c-tgt cargo test -p ccg-engine --test r16_parity_fuzz -- --nocapture
CARGO_TARGET_DIR=%TEMP%/ccg-r16c-tgt cargo test -p ccg-engine --test r16_probe       -- --nocapture
```

산출물·새 하네스는 전부 격리 워크트리 안에 남겼다:
`docs/critic/tools/.r16-{clistrings,clifind,parity-fuzz}.mjs` ·
`scripts/.r16-live-probe.mjs`(빌더 하네스 사본 — 단언 무수정, 관찰만 추가) ·
`crates/ccg-engine/tests/r16_{probe,parity_fuzz}.rs` ·
`docs/critic/{m-ux-r3-dial,m3-r4-live-r16c,m3-r4-live-r16p,m3-r4-live-r16q,r14-cwdgone,r16-parity-fuzz}.json|jsonl`.
**메인 레포에는 이 보고서 한 장만 더한다** — 공용 기준 파일을 한 바이트도 안 건드리기 위해서다.

---

## 6. 다음 라운드에 넘기는 우선순위(내 의견)

1. **N1** — 한 줄(`"blocked"` → `"rejected"`)로 1순위 근거가 살아나고, 그게 **N2를 같이 푼다**
   (정확한 `resetsAt`이 공짜로 온다). 값 대비 가장 싸다.
2. **N3** — 차단벽에 부정문/일시 과부하 지문 추가. 코퍼스도 실전 문구로 늘려야 한다
   (오늘의 18줄은 2.6.2 시절 문장이다).
3. **N4** — `reload_state`가 `ready`를 `auto_paused`로 되살리거나 `check_hold`가 한 번 더 보게.
4. **N5** — `auto_paused`를 계약면에 올려 배너 문장을 가른다(§R5.6이 이미 적어 둔 항목).
