# R28d 「WCAP」 확인 크리틱 R1 — 밤샘 주행은 진짜로 안 잘린다. 다만 `ping` 한 프레임이 상한을 통째로 지운다

판정 대상: `06067db` (R28d WCAP R1). 크리틱은 코드를 고치지 않았다 — 전부 직접 빌드·주행·실측했다.
빌더 보고서(`docs/parity-fix-wcap-r1.md`)와 커밋 메시지는 **근거로 쓰지 않았다.**

**판정: 불합격(pass=false).** 겨눈 격차(밤샘 연속 주행이 창 두 개에서 잘림)는 **진짜로 닫혔다.**
빌더가 적은 수치도 내 손으로 재현했다. 그러나 체크리스트 2번 —— 「엔진·렌더러가 같은 구분자인가」 ——
이 **실측으로 깨졌다.** 같은 서버 행동에 엔진은 12시간에 **71발**, 렌더러는 **2발**을 낸다.

---

## 0. 실측 환경

| 항목 | 값 |
|---|---|
| 격리 CARGO_TARGET_DIR | `%TEMP%/ccg-target-critwcap` (테스트) · `C:/Code/AgentCodeGUI/target-critwcap` (릴리즈) |
| 릴리즈 빌드 | `cargo build --release --features custom-protocol -p agentcodegui` → 06:29 재빌드(2m12s) · `-p ccg-engine --features fakecli --bins` |
| 하네스 exe | `target-critwcap/release/{agentcodegui,ccg-fakecli,ccg-fakecodex}.exe` |
| 엔진 A/B 사본 | `%TEMP%/wcapws` (레포 `Cargo.toml`+`Cargo.lock`+`crates/` 복사 · `src-tauri` 멤버만 제거) |
| 이름 기반 kill | 0건 (하네스 자체 `killTree`만) |
| 실 HTTP | 0건 (`CCG_NO_NET=1` · 합성 자격증명) |
| 기준 결과 파일 덮어씀 | 0개 (`git status`에 `docs/critic`·`bench/**` 수정 0 · 새 리포트는 `--out=…critwcap-r1.json`) |
| 레포 코드 수정 | 0줄 (A/B·탐침은 전부 `%TEMP%` 사본) |

---

## 1. 빌더 수치 재현 — 전부 맞다

### 1.1 A/B가 진짜로 판별력이 있는가 (직접 되돌려 확인)

레포를 한 글자도 안 고치고 `%TEMP%/wcapws` 사본에서 `arm_hold`의 규칙 세 줄만 R28c
(`let attempts = self.auto_resume_streak;`)로 되돌린 뒤 **빌더의 신설 테스트를 그대로** 먹였다.

| 판 | R28c 대조군 | HEAD |
|---|---|---|
| ① 창이 진짜로 넘어간다(꼬리 +1h/턴 · 11h) | **2회 · attempts 2 · 접힘** ✗FAIL | **7회 · attempts 0 · 안 접힘** ✓ |
| ② 꼬리 없는 문구 + 그 턴이 일했다(65분) | **2회 · attempts 2 · 접힘** ✗FAIL | **6회 · attempts 0 · 안 접힘** ✓ |
| ③ 꼬리 없는 문구 + 빈손(5h) | 2회 · 접힘 ✓ | 2회 · 접힘 ✓ (불변) |
| ④ 토큰 한 줄 + 같은 벽(6h) | 2회 · 접힘 ✓ | 2회 · 접힘 ✓ (불변) |

빌더의 표와 **한 칸도 다르지 않다.** ①②는 대조군에서 붉고 HEAD에서 초록, ③④는 양쪽 초록 —
새 못은 바꾼 것만 잡고 지켜야 할 것은 통과시킨다. 판별력 있음.

### 1.2 그 밖의 초록

| 검사 | 결과 |
|---|---|
| `cargo test -p ccg-engine` | **212 통과 · 0 실패 · 2 무시** (14개 바이너리 합) — 빌더 주장과 일치 |
| 신설 `wcap_limit_streak` 20회 반복 | **20/20 초록** (플레이키 0) |
| `cargo test -p ccg-store` | 89 / 0 |
| `cargo test -p ccg-auth` | 104 / 0 |
| `cargo test -p ccg-fs` | 101 / 0 / 2 무시 |
| `cargo test -p ccg-lsp` | 59 / 0 |
| `cargo test -p agentcodegui` | 146 / 0 |
| `node scripts/poc-limit-resume.mjs` ×5 | **234 통과 · 0 실패**, 5회 전부 동일 (RCAP 기준 197 → +37, 무후퇴) |
| `node scripts/poc-limit-engine.mjs` (WCAP exe) | **11 통과 · 0 실패** — 전송 0 · stdin 0B · 사다리 정상 |
| `node scripts/poc-limit-codex.mjs` (WCAP exe) | **8 통과 · 0 실패** — t=90s 정상 발사 · 큐 해제 |
| `npm run typecheck` (node·web) + `typecheck:app` | 3종 초록 |

### 1.3 경계 표기 정정도 사실

`src-tauri/src/engine/runtime.rs`는 **없는 파일**이 맞다. 대기표 상태기계는
`crates/ccg-engine/src/runtime.rs` 하나에 산다. EXTN의 `versions.rs`와 겹치지 않는다.

---

## 2. 체크리스트 1 — 밤샘 주행 · 헛발질 (합격)

내 대본으로 다시 쟀다(빌더 하네스가 아니라 크리틱이 쓴 것).

**엔진**(`%TEMP%/wcapws` · 가상 시계):

* 창이 턴마다 1시간씩 뒤로 가는 판(11시간) → **7발 · attempts 0 · 안 접힘**
* 배너형 + 빈손(12시간) → **2발 · attempts 2 · `ready+auto_paused`** — RCAP 동작 불변

**렌더러**(`app/src/lib/useLimitResume.ts`를 esbuild로 번들해 실구동 — 레포 무수정):

* 창이 5시간씩 열두 번 넘어가는 밤샘 → **12발 · 계수 `[0,0,0,…,0]` · 안 접힘**
* 같은 벽 + 출력 0 → **2발 · `ready:true, autoPaused:true, attempts:2`** — 「이어가기」가 유일 출구

「창 3개 연속이면 끝까지 이어간다」는 양쪽에서 참이다. 상한 2도 살아 있다.

**배너 문구**(체크리스트 4의 뒷다리): `Chat.tsx:3364`의
「자동으로 이어서 보낸 turn이 계속 한도에 막혔어요 — 눌러서 이어가기」는 `canPressContinue`
(= `ready && autoPaused`) 일 때만 뜨고, `autoPaused`는 이제 `attempts >= 2`에서만 선다.
그 둘은 **구분자가 「안 넘어갔다」고 판정한 착지**뿐이다 — 문구가 사실과 맞는다.
(문구 속 영단어 `turn`은 §4.4로 이 라운드 과녁이 아님. 동의.)

---

## 3. ★체크리스트 2 실패 — 「같은 규칙 한 벌」이 아니다

### 3.1 궤적은 맞는다(내가 짠 7단 대본)

엔진과 렌더러에 **같은 대본**을 먹였다. 대본은 착지 순서대로:

```
L0 꼬리=w0(지난 벽)·빈손 / L1 꼬리=w0(같은 벽)·일했다 / L2 꼬리=w1(+5h)·빈손
L3 꼬리 없음·일했다      / L4 꼬리 없음·빈손        / L5 꼬리=w2(+10h)·빈손
```

| | 계수 궤적 | 착지 |
|---|---|---|
| 엔진 (`ChatRuntime`, 가상 시계) | `[0, 1, 0, 0, 1, 2]` | L5에서 접힘 |
| 렌더러 (`useLimitResume` 실구동) | `[0, 1, 0, 0, 1, 2]` | L5에서 `ready+autoPaused` |

**한 칸도 안 어긋난다.** 우선순위(시각을 둘 다 알면 시계가 이긴다)도, L5의 함정
(창은 넘어갔지만 **직전 표**가 시각 미상이라 ①이 침묵 → 흔적이 판정 → 못 넘은 것으로 셈)도 같다.
여기까지는 합격이다.

### 3.2 그런데 ②의 **문턱**이 다르다 — 같은 서버 행동에 71 대 2

구분자 ②는 「그 턴이 일을 했나」다. 두 축의 정의:

* 엔진 `Turn::saw_turn_activity` — `mark_activity()`가 세우고, 그 호출은
  `Frame::StreamEvent`의 **맨 끝줄에 조건 없이** 있다(`runtime.rs:2216`).
  `match`의 `_ => {}` 갈래로 빠진 프레임도 그 줄에 닿는다.
* 렌더러 `turnDidWork` — 마지막 사용자 말풍선 뒤의 **어시스턴트 텍스트(비어 있지 않음, 오류 아님)**
  또는 **비어 있지 않은 toolgroup**만 센다.

즉 엔진의 문턱은 「메인 경로 `stream_event`가 하나라도 왔나」이고, 렌더러의 문턱은
「화면에 글자나 도구가 남았나」다. **`ping` 한 프레임이 그 사이를 가른다.**

엔진 실측(가상 시계 12시간 · 시각 미상 배너형 문구 · 매 턴 같은 한도로 사망):

| 죽기 전에 흘린 프레임 | 12시간 자동 재발사 | attempts | 접힘 |
|---|---|---|---|
| 없음(순수 문전박대) | **2회** | 2 | ✓ 접힘 |
| `stream_event {type:"message_start"}` 하나 | **71회** | 0 | ✗ 안 접힘 |
| `stream_event` `thinking_delta` 하나 | **71회** | 0 | ✗ 안 접힘 |
| `stream_event {type:"ping"}` 하나 | **71회** | 0 | ✗ 안 접힘 |

같은 세 판에서 **렌더러의 스레드는 `[사용자 말풍선, 오류 말풍선]` 뿐이다.**
`thinking`은 result가 오면 스토어가 걷고(`store/session.ts:1206` `without`),
`ping`·`message_start`는 애초에 말풍선을 안 만든다. 그래서 `turnDidWork=false` →
렌더러는 그 세 판 모두 **2발에서 접힌다**(내 주행에서 실측: `[1,2]` → `ready+autoPaused`).

**71 대 2.** 커밋 메시지의 「렌더러 `carriedAttempts`가 **글자 그대로 같은 둘을 같은 순서로** 본다」는
①에 대해서만 참이고 ②에 대해서는 거짓이다.

### 3.3 왜 이게 아픈가 — RCAP의 보증이 codex 축에서 통째로 사라진다

1. 엔진의 codex 대기표는 **언제나 시각 미상**이다. codex 한도 문구엔 `…|epoch` 꼬리가 없고,
   방금 돌린 `poc-limit-codex`의 대기표도 `resetsAt=0` · 프로브 판정 `unknown=1`이었다.
   ⇒ 그 축에서는 ①이 영영 침묵하고 **②가 유일한 판정자**다.
2. codex 트랜스코더는 추론 꼬리를 **`stream_event` `thinking_delta`로 그대로 내보낸다**
   (`crates/ccg-engine/src/codex/transcode.rs:725`).
   ⇒ 추론 토큰 하나만 흘리고 한도로 죽는 codex 턴은 엔진이 「일했다」로 읽는다.
3. 그러면 계수가 영영 0이고, 시각 미상 대기 간격은 `unknown_wait(0)` = 10분이다.
   ⇒ **10분마다 CLI 한 턴.** 12시간 밤샘이면 71발.

RVERD 크리틱이 잰 사고가 「5시간 창 하나에 27발」이었고 RCAP이 그걸 **2발**로 묶은 것이
직전 두 라운드의 성과다. WCAP은 그 보증을 **화면에 아무것도 안 남기는 프레임 한 장**으로
해제할 수 있게 만들었다(같은 5시간에 29발 — 27발보다 나쁘다).

빌더도 이 판을 자기 신고했지만 두 군데가 사실과 다르다:

* 「**토큰 한 줄만 내고**」 — 아니다. 토큰이 **0개**여도 된다. `ping`이면 충분하다.
* 「출력 없는 턴이 한 번만 섞이면 계수가 곧바로 다시 선다」 — 그 「출력 없는 턴」은
  **`stream_event`가 한 장도 없는 턴**이라야 한다. 문턱이 자기 신고보다 훨씬 낮다.

### 3.4 재현 절차(그대로 다시 밟을 수 있다)

```
# 레포를 안 건드리는 사본
robocopy crates %TEMP%\wcapws\crates /E ;  copy Cargo.toml Cargo.lock %TEMP%\wcapws
# Cargo.toml의 members에서 "src-tauri"만 제거  (Cargo.lock은 반드시 레포 것을 쓴다 —
# 없으면 indexmap이 1.9.3 대신 2.14.0으로 풀려 이 판의 계측값이 통째로 달라진다)
set CARGO_TARGET_DIR=%TEMP%\wcapws\tgt
cargo test --offline -p ccg-engine --test critwcap_probe -- --nocapture
```
탐침 원본: `%TEMP%/wcapws/crates/ccg-engine/tests/critwcap_probe.rs`(P1~P4),
렌더러 짝: `%TEMP%/wcapcrit/renderer-parity.mjs`(실제 훅 번들 구동).

---

## 4. 부수 관찰(이 라운드 과녁 아님 · 기록만)

* **`arm_hold`의 「벽이 조금씩 밀리는」 판**: 서버가 같은 창의 리셋을 5분씩 뒤로 미는 대본에서는
  ①이 매번 「넘어갔다」로 읽는다. 실측은 5시간 10분에 **2발**이라 실해는 없었다
  (`due_at`이 새 벽 + 90초로 잡혀 스스로 벌어진다). 다만 원리적으로는 ①의 오탐 자리다.
* **부팅 재장전은 계수를 안 물려받는다**(엔진 `reload_state`가 `attempts: 0`을 심는다).
  렌더러는 `sanitizeHold`가 살린다. R28c부터 있던 비대칭이고 이 라운드 변경과 무관하다.
* **의존성 함정**: `Cargo.lock` 없이 `crates/ccg-engine`만 떼어 빌드하면 `indexmap`이
  2.14.0으로 풀리고, 그것만으로 위 ②의 실측값이 `71회 → 2회`로 뒤집힌다. 다음 크리틱이
  같은 A/B를 할 때 **반드시 레포 `Cargo.lock`을 함께 복사할 것.**

---

## 5. 결론

* **닫힌 것**(내 손으로 확인): 밤샘 연속 주행이 창 두 개에서 잘리던 §4.1의 격차. 엔진 7창·렌더러 12창을
  끝까지 이어가고, 진짜 헛발질(같은 벽·출력 0)은 양쪽 다 2발에서 접히며 「이어가기」가 뜬다.
  배너 문구도 이제 사실과 맞는다. 회귀 잠금(엔진 4종 · 렌더러 37단언)은 판별력이 있고 20/20 안정이다.
* **남은 최대 격차**: 구분자 ②의 **문턱이 두 축에서 다르다.** 엔진은 `ping`·`message_start`·
  `thinking_delta` 한 장이면 「일했다」로 읽어 시각 미상 축(= codex의 기본 축)에서 상한을 통째로
  해제한다 — 같은 대본 12시간에 **엔진 71발 / 렌더러 2발**. RCAP이 세운 「자동은 최대 2발」이
  화면에 아무것도 안 남기는 프레임 한 장으로 무너진다.

다음 라운드가 가장 먼저 재야 할 것: `saw_turn_activity`를 그대로 쓰지 말고 **렌더러와 같은 문턱**
(어시스턴트 텍스트 · 도구 호출/결과)으로 좁힌 뒤, 위 P4 표의 네 줄이 전부 `2회 · 접힘`이 되는지.
