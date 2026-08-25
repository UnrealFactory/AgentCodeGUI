# R28d 「WCAP」 확인 크리틱 R1 — 밤샘 주행은 진짜로 살아났다. 그리고 같은 손이 상한을 지우는 문을 새로 열었다

판정 대상: `06067db` (R28d WCAP R1). 크리틱은 **코드를 한 줄도 고치지 않았다** — 전부 직접 펼치고
빌드하고 주행해서 쟀다. 빌더 보고서(`docs/parity-fix-wcap-r1.md`)와 커밋 메시지는 **근거로 쓰지 않았다**
(재현 대상으로만 썼다).

**판정: 불합격(pass=false).**

겨눈 격차 — 「5시간을 꽉 채워 일하고 다음 창에서 막힌 재개까지 헛발질로 세서 밤샘 주행이 창 두 개에서
잘린다」 — 는 **진짜로 닫혔다**(내 손으로 잰 밤샘 3창 주행: 16시간 3발·`attempts` 0·안 접힘). 빌더가 적은
수치도 하나 빼지 않고 재현됐다. **그러나 같은 라운드가 상한을 통째로 지우는 문을 새로 열었다.**
「그 턴이 일을 했다」의 엔진 쪽 증거가 `saw_turn_activity`인데, 그 깃발은 **내용이 0인 프로토콜 프레임
한 장**(`ping` · `content_block_stop` · codex의 `thinking_delta`)에 켜진다. 꼬리 없는 한도 문구 축에서
그 한 장이 섞이면 12시간에 **71발**이 나간다 — **R28c 대조군은 똑같은 대본에 2발**이다. 즉 이것은
「남아 있던 구멍」이 아니라 **R1이 만든 회귀**다.

---

## 0. 실측 환경 — 왜 레포에서 재지 않았나

레포 워킹트리 HEAD는 `459993b`이고 그 위에는 **이 갈래의 R2·R3가 이미 얹혀 있다.** 레포에서 재면 R1을
재는 것이 아니다. 그래서 `06067db`를 `git archive`로 통째로 펼쳐 그 사본에서만 쟀다(레포 무수정 —
옆 갈래 셋이 같은 트리에서 돌고 있다).

| 항목 | 값 |
|---|---|
| 판정본 | `git archive 06067db` → `%TEMP%\wcapcrit1\repo` (레포 파일 수정 0줄) |
| 대조군(R28c 규칙) | `%TEMP%\wcapcrit1\ctrl` — 같은 펼침본에서 `arm_hold` **두 줄만** `let attempts = self.auto_resume_streak;`로 되돌림 |
| 격리 CARGO_TARGET_DIR | `%TEMP%\ccg-tgt-critwcap1` (판정본) · `…critwcap1c` (대조군) |
| node_modules | 레포 것을 정션(`mklink /J`) — `npm ci` 0회, `npm install` 0회 |
| CDP 포트 | 9425(engine 하네스) · 9437(codex 하네스) — 주행 전 `netstat`로 비어 있음 확인 |
| CCG_HOME | 하네스가 펼침본 안에 팜(`.poc-home-engine-t3t4` · `.poc-home-codex-crit`) — 사용자 실앱 홈 무접촉 |
| 이름 기반 kill | **0건** (하네스 자체 `killTree`만) |
| 실 HTTP | **0건** (`CCG_NO_NET=1` + 합성 자격증명) |
| 기준 결과 파일 덮어씀 | **0개** (`--out=%TEMP%\wcapcrit1\*.json`) |
| 레포 워킹트리 변경 | **0줄** (이 판정문 1개 제외) |

---

## 1. 빌더 수치 재현 — **전부 맞다.** 한 줄도 부풀리지 않았다

| 빌더 주장 | 내 실측 | 판정 |
|---|---|---|
| `node scripts/poc-limit-resume.mjs` 234 통과·0 실패 (197 → +37) | **234 통과 · 0 실패** · 5회 반복 전부 동일 | ✅ |
| `cargo test -p ccg-engine` 212 통과 · 2 무시 · 0 실패 | **212 / 2 / 0** | ✅ |
| 신설 테스트 20회 반복 20/20 | 신설 4종 + 내 탐침 8종을 **20회** — 이상 **0건** | ✅ |
| `npm run typecheck` + `typecheck:app` 3종 초록 | node·web·app 전부 exit 0 | ✅ |
| `cargo check -p agentcodegui --features custom-protocol` 초록 | 더 세게 — **`cargo build --features custom-protocol`로 exe까지 구움**(1m23s) | ✅ |
| 기준 결과 파일 0개 덮음 | `git show --name-only 06067db` → `docs/critic/*.json`·`bench/**` 매치 **0** | ✅ |
| 상한(2)·「이어가기」·`sanitizeHold`·`resumeVerdict` 무수정 | diff 확인 — `arm_hold`/`consume_hold` 추가분과 신설 필드뿐 | ✅ |
| 경계 정정(`src-tauri/src/engine/runtime.rs`는 없는 파일) | `ls` 확인 — 없다. `lite.rs`는 `auto_resume_streak`/`attempts` 미참조 | ✅ |

### 1.1 A/B가 진짜로 판별력이 있는가 — 직접 되돌려 확인

레포를 한 글자도 안 고치고 `%TEMP%\wcapcrit1\ctrl` 사본에서 `arm_hold`의 규칙 **두 줄만** R28c로
되돌린 뒤, **빌더의 신설 테스트를 그대로** 먹였다.

| 판 | R28c 대조군 | R1(HEAD) |
|---|---|---|
| ① 창이 진짜로 넘어간다(꼬리 +1h/턴 · 11h) | **2회 · attempts 2 · 접힘** ✗FAIL | **7회 · attempts 0 · 안 접힘** ✓ |
| ② 꼬리 없는 문구 + 그 턴이 일했다(65분) | **2회 · attempts 2 · 접힘** ✗FAIL | **6회 · attempts 0 · 안 접힘** ✓ |
| ③ 꼬리 없는 문구 + 빈손(5h) | 2회 · 접힘 ✓ | 2회 · 접힘 ✓(불변) |
| ④ 토큰 한 줄 + 같은 벽(6h) | 2회 · 접힘 ✓ | 2회 · 접힘 ✓(불변) |

빌더가 적은 그대로다. 못은 **바꾼 것만** 잡고 **지켜야 할 것은** 통과시킨다.

### 1.2 하네스 무회귀 — 빌더가 안 돌린 둘을 내가 돌렸다

빌더는 「`npm run app:build` 안 돌림」이라 적고 `poc-limit-engine`·`poc-limit-codex`를 **재실행하지
않았다**(체크리스트 3번의 절반). 내가 R1 exe를 구워서 돌렸다.

* `poc-limit-engine` (조회 불가 판에서 전송 0) — **11 통과 · 0 실패**. `spawns:0` · `stdin 0B` · `queue:0` ·
  `asks:2`(사다리) · `unavailable:2`.
* `poc-limit-codex` (Codex 채팅이 클로드 창에 잡히지 않는가) — **8 통과 · 0 실패**. t=90s에 `spawns:1` ·
  `stdin 534B` · `blocked:0`.

**RCAP·T3T4의 못은 이 라운드에서 안 깨졌다.**

---

## 2. 실패 1 (치명) — 「일했다」가 **일한 것을 안 잰다**

### 2.1 코드가 하는 말

`runtime.rs`의 구분자 ②는 `Turn::saw_turn_activity`다. 그 깃발을 켜는 자리는 `mark_activity()`이고,
호출부 셋 중 하나가 이렇다(`runtime.rs` `Frame::StreamEvent` 가지):

```rust
match (kind.as_str(), delta_kind.as_deref()) {
    (_, Some("text_delta")) => self.fire("F2"),
    (_, Some("thinking_delta")) => self.fire("F3"),
    ("content_block_start", _) => self.fire("F4"),
    _ => {}
}
self.mark_activity();          // ← match **밖**. 어떤 stream_event든 무조건 켠다.
```

`frames.rs`는 `{"type":"stream_event","event":{"type":"ping"}}`를 그대로
`Frame::StreamEvent{kind:"ping", delta_kind:None}`으로 만든다. 그러면 `_ => {}`로 떨어지고 —
**깃발은 켜진다.** 빌더 주석이 적은 「한도로 문전박대당한 턴에는 result 에러 하나뿐이다」는 사실이 아니다.

이게 실기에 닿는지도 확인했다: `driver.rs:98`이 클로드 CLI에 **`--include-partial-messages`를 항상**
넘긴다(SSE의 `ping`·`message_start`·`content_block_stop`이 전부 프레임으로 들어온다). codex 축은
`codex/transcode.rs:725`가 추론 델타를 `thinking_delta` stream_event로 만든다.

### 2.2 실측 — 같은 판, 프레임 한 장 차이

`crates/ccg-engine/tests/probe_wcap_critr1.rs`(탐침, %TEMP% 사본에만 둠). 빌더의 `WcapCli`와 같은 자·
같은 가상시계이고, **「일했다」의 증거만 어시스턴트 텍스트에서 내용 0 프레임으로 바꿨다.**

| 탐침 | 대본 | R28c 대조군 | **R1(HEAD)** |
|---|---|---|---|
| P2 | 배너형(꼬리 없음) + 완전 무음 · 12h ＝ 빌더 ③ | 2발 · 접힘 | 2발 · attempts 2 · 접힘 ✓ |
| **P1** | **같은 판 + `ping` 한 장** · 12h | **2발 · 접힘** | **71발 · attempts 0 · 안 접힘** ✗ |
| **P3** | 같은 판 + `content_block_stop` 한 장 · 12h | **2발 · 접힘** | **71발 · attempts 0 · 안 접힘** ✗ |
| **P8** | 같은 판 + `thinking_delta` 한 장(codex 추론) · 12h | — | **71발 · attempts 0 · 안 접힘** ✗ |
| **P4** | 첫 표는 꼬리 있음 → 이후 꼬리 없음(mixed) + `ping` · 12h | **2발 · 접힘** | **42발 · attempts 0 · 안 접힘** ✗ |
| P5 | 밤샘: 꼬리가 창마다 +5h · 그 턴이 일함 · 16h | (붉음) | **3발 · attempts 0 · 안 접힘** ✓ 겨눈 격차 |
| P6 | 같은 벽 · 출력 0(클로드 꼬리 축) · 12h | 2발 | **2발 · attempts 2 · 접힘** ✓ |
| P7 | 같은 벽 + `ping`(클로드 꼬리 축) · 12h | 2발 | **2발 · attempts 2 · 접힘** ✓ 시계가 이긴다 |

**P1 대 P2가 이 라운드의 전부다.** 사람 눈으로 두 판은 **완전히 같다**: 재개 턴이 아무 답도 못 내고
같은 한도로 죽는다. 다른 것은 서버가 하트비트 한 장을 흘렸느냐뿐이고, 그 한 장에 **10분마다 밤새**
CLI가 뜬다. `attempts`가 영원히 0이라 지수 백오프(`unknown_wait`: 10→20→40분)도 같이 죽는다 —
71 ≈ 12h ÷ 10분.

**그리고 R28c 대조군은 P1·P3·P4 전부 2발이다.** 이 문은 R1이 열었다.

### 2.3 재현

```
git archive 06067db | tar -x -C %TEMP%\wcapcrit1\repo
cp probe_wcap_critr1.rs %TEMP%\wcapcrit1\repo\crates\ccg-engine\tests\
cd %TEMP%\wcapcrit1\repo
set CARGO_TARGET_DIR=%TEMP%\ccg-tgt-critwcap1
cargo test -p ccg-engine --offline --test probe_wcap_critr1 -- --nocapture --test-threads=1
```

---

## 3. 실패 2 — 「엔진·렌더러 같은 규칙 한 벌」이 **아니다** (체크리스트 2번)

커밋 헤드라인은 「구분자 둘을 엔진·렌더러 한 벌로 넣는다」이고, 양쪽 주석은 서로 「글자 그대로 같은
둘을 같은 순서로 본다」고 적는다. **같은 대본을 양쪽에 먹여 계수 궤적을 재 봤다.**

렌더러 축은 훅의 결정 함수(`carriedAttempts`)와 훅의 발사 규칙(`firesRef = (attempts ?? 0) + 1`,
`fireResetsRef = cur.resetsAt`)을 그대로 굴렸다(esbuild로 `app/src/lib/limitResume.ts` 번들 후 인메모리).

| 같은 대본(꼬리 없는 문구 · 내용 0 프레임 한 장 · 12h) | 발사 | 계수 궤적 | 접힘 |
|---|---|---|---|
| **엔진** (`saw_turn_activity`) | **71발** | `[0,0,0,…,0]` | **안 접힘** |
| **렌더러** (`turnDidWork`) | **2발** | `[0,1,2]` | `autoPaused=true` |

같은 사실에 두 축이 정반대로 답한다:

```
turnDidWork([user, (ping은 항목을 안 만듦), error])   = false   ← 렌더러
turnDidWork([user, 빈 toolgroup, error])              = false
turnDidWork([user, 어시스턴트 본문, error])            = true
```

그리고 **빌더 자신이 이 어긋남을 주석에 적어 놓았다** — `limitResume.ts` `turnDidWork` 주석:
「`thinking`은 result가 도착할 때 스토어가 걷어내므로 이 자리에 애초에 없다(**엔진의 thinking_delta
활동과 다른 점** — 렌더러가 볼 수 있는 증거만 쓴다)」. 즉 「구분자 ②가 두 축에서 다른 것을 잰다」는
사실을 알고 적었으면서, 커밋 헤드라인과 보고서는 **「같은 규칙 한 벌」**이라고 말한다. P8이 그 문장의
값을 쟀다: 추론만 흘리고 죽는 codex 턴에서 엔진 **71발** 대 렌더러 **2발**.

> 참고 — 이 격차는 학술적이지 않다. `App.tsx:635`가 `managed: engineOwnsResume(...)`이고, 훅은
> `if (o.managed) return`으로 장전 자체를 건너뛴다. 3.0 본채팅에서 **실제로 도는 축은 엔진**이다.
> 즉 71발 쪽이 사용자가 밤새 겪는 값이고, 2발 쪽(렌더러)은 폴백 경로다.

---

## 4. 실패 3 — 자기 신고한 「좁은 판」이 실제로는 넓다

빌더의 자기 신고:

> 시각을 **한쪽도** 모르는 축(codex 배너형)에서 **매 턴 토큰 한 줄만 내고** 같은 한도로 죽는 서버가
> 있으면 … 출력 없는 턴이 한 번만 섞이면 계수가 곧바로 다시 선다(J③이 잠금).

실측으로 셋 다 틀렸다.

1. **「토큰 한 줄」이 필요 없다.** 출력 0 + 프로토콜 프레임 한 장이면 된다(P1·P3·P8).
2. **「codex 배너형」축만이 아니다.** `classify_limit_error`가 리셋 시각을 얻는 유일한 길은
   `parse_epoch` = 문구 안의 `|<10자리>` 꼬리다. 클로드의 실전 문구 중 `banner_limit_reached`
   (`5-hour/weekly/session/daily limit reached`) · `your_limit` · 한국어 `사용 한도…` 계열에는 그 꼬리가
   **없다**. 그 판은 전부 `resets_at = None` → `_ => worked` 가지다. 그리고 **한쪽만 미상이어도**
   같은 가지다(`match (resets_at, self.auto_resume_at)`의 `_`) — P4가 그 판이고 42발이다.
3. **「출력 없는 턴이 한 번 섞이면 계수가 다시 선다」가 이 판에서는 안 통한다.** P1은 *모든* 턴이
   출력 0이다. 그런데도 71발이다 — 계수를 세우는 것은 「출력이 없다」가 아니라 「`saw_turn_activity`가
   꺼져 있다」인데, 그 깃발은 출력과 무관하게 켜진다.

즉 자기 신고는 **격차의 축과 크기를 둘 다 축소**해서 적었다.

---

## 5. 실패 4 — 새 못이 그 문을 **못 본다** (테스트 커버리지)

`tests/wcap_limit_streak.rs`의 ②·④는 「일했다」를 **어시스턴트 텍스트 프레임 하나**로만 먹인다.
`scripts/poc-limit-resume.mjs` J절도 마찬가지로 어시스턴트 말풍선으로만 먹인다. 그래서 §2의 회귀가
**212개 초록 안에 통째로 숨는다**(내가 넣은 탐침 8종 중 4종이 붉어야 할 자리다).

「구분자 ②가 무엇을 증거로 받는가」가 이 라운드의 핵심 결정인데, 그 결정의 **경계값**(내용이 0인
프레임)에 못이 하나도 없다. 다음 라운드는 못을 먼저 박고 고쳐야 한다.

---

## 6. 그 밖 — 못 미침(치명 아님)

* **`turn`이 한글 문장 안에 그대로 있다.** `runtime.rs:3355` 공지 「자동으로 이어서 보낸 **turn**이 계속
  한도에 막혀서…」 · `Chat.tsx:3364` 같은 문장. 빌더가 「이 라운드 과녁 아님」으로 미뤘고 실제로 미착수다.
  (반대로 배너 문구 자체는 상황과 **맞다**: 엔진의 `auto_paused`는 `lite.rs:119`가 `autoResume=false`로
  내려 보내고, 배너는 그때 「약 N 뒤 여기서 이어갈 수 있어요」 + 「이어가기」를 준다 — 확인했다.)
* **라이브 앱 주행 없음**은 빌더 자기 신고 그대로이고, 이 변경의 성질상(5시간 단위) 타당한 대체다.
  다만 §2의 회귀는 라이브가 아니라 **엔진 단위 재생만으로 잡힌다** — 대체 수단이 부족했던 게 아니라
  탐침을 그 방향으로 안 쐈다.

---

## 7. 체크리스트 대조

| # | 항목 | 결과 |
|---|---|---|
| 1 | 밤샘 3창 연속 → 끝까지 이어지고 정지 없음 | ✅ P5: 16h 3발 · attempts 0 · 안 접힘 |
| 1 | 헛발질(같은 창·출력 0) → 상한 2 정지 + 이어가기 | ✅ P6/P2: 2발 · `ready+autoPaused` — **단, 프레임 한 장이 섞이면 무너짐(§2)** |
| 2 | 엔진·렌더러가 같은 구분자인가 | ❌ **71 대 2** (§3) |
| 3 | `poc-limit-resume.mjs` 무후퇴(197+) | ✅ 234/0 · 5회 동일 |
| 3 | `poc-limit-engine`·`poc-limit-codex` 무회귀 | ✅ 11/0 · 8/0 (빌더는 안 돌렸다 — 내가 돌렸다) |
| 4 | 크레이트별 cargo test + typecheck 3종 | ✅ ccg-engine 212/2/0 · typecheck 3종 exit 0 |
| 4 | 배너 문구가 실제 상황과 일치 | ✅ (한글 속 `turn` 표기는 미착수 — §6) |

---

## 8. 다음 라운드 통과 조건 (셋 다 실측으로)

1. **구분자 ②의 증거를 「내용이 있는 산출물」로 좁혀라.** `saw_turn_activity`는 스트림 생사 판정용
   깃발이지 「일했다」의 증거가 아니다(하트비트로 켜지는 것이 그 깃발의 **정상 동작**이다). 별도 사실이
   필요하다 — 예: 메인 경로 `text_delta`/`assistant{has_text|tool_uses}`/`tool_result`를 본 턴만.
   ★그 자리를 고칠 때 `Frame::StreamEvent`의 `mark_activity()`는 **건드리지 마라** — T9(보류 취소)·
   T19b(정리 턴 재개)가 그 호출에 매달려 있다.
2. **통과 조건은 하나다** — `probe_wcap_critr1.rs`의 P1·P3·P4·P8이 **2발 · `attempts=2` ·
   `auto_paused=true`**로 착지하고, P5·P6·P7·빌더 ①②③④가 **전부 그대로** 초록일 것.
3. **같은 대본을 양쪽에 먹인 계수 궤적이 일치하는 못**을 박아라(엔진 탐침 ↔ `poc-limit-resume.mjs` J절).
   지금은 두 축이 서로 다른 대본으로만 검증돼 있어서, 「같은 규칙 한 벌」이라는 문장을 지키는 못이 없다.
