# R28d 「WCAP」 R1+R2+R3 — 상한이 「헛발질」과 「제대로 일한 재개」를 가른다

> **R2 추가분은 §6부터, R3 추가분은 §11부터.** R1(아래 §0~§5)은 그대로 두고, 확인 크리틱
> (`docs/critic/r28d-wcap-critic-r1.md`)이 실패시킨 체크리스트 2번 —— 구분자 ②의 **문턱**이
> 엔진과 렌더러에서 달랐다(같은 12시간 대본에 **엔진 71발 / 렌더러 2발**) —— 을 §6이 고친다.
> §2의 규칙표에서 `worked`의 엔진 쪽 정의(`Turn::saw_turn_activity`)만 **틀렸었고**,
> 지금은 `Turn::saw_turn_output`이다.
>
> **R3(§11~)이 고치는 것**: R2는 「**무엇을** 산출로 세는가」만 맞추고 「**어느 턴의 것으로**
> 세는가」를 안 맞췄다(`docs/critic/r28d-wcap-critic-r2.md` §3.3). `tool_result`가 턴 경계를
> 넘는 다리에서 같은 **엔진 71발 / 렌더러 2발**이 되살아나 있었다.
>
> **⚠ 아래 §8.1의 함정 기록과 §10의 둘째·첫째 항목은 사실관계가 틀렸다** — 정정은 §14에
> 모아 두었다(읽는 순서: §14를 먼저).

빌더: WCAP R1 · 2026-08-25 · `feature/3.0.0-beta`
과녁: `docs/critic/r28c-rcap-critic-r1.md` §4.1(그 라운드의 **최대 격차**)
경계: `crates/ccg-engine/src/runtime.rs`(attempts 규칙부) · `app/src/lib/limitResume.ts` ·
`app/src/lib/useLimitResume.ts` · `scripts/poc-limit-resume.mjs` · (신설)
`crates/ccg-engine/tests/wcap_limit_streak.rs`

> **경계 표기 정정.** 인수인계는 엔진 파일을 `src-tauri/src/engine/runtime.rs`로 적었는데
> 그런 파일은 없다. 대기표 상태기계(`arm_hold`/`consume_hold`/`check_hold`)가 사는 곳은
> `crates/ccg-engine/src/runtime.rs` 하나다(`src-tauri/src/engine/`에는 `lite.rs`가
> `rt.hold()`를 **읽기만** 한다 — 그쪽은 안 건드렸다). EXTN 갈래가 만지는
> `src-tauri/src/engine/versions.rs`와는 파일이 겹치지 않는다.

---

## 0. 한 문단

**두 구분자를 엔진과 렌더러에 같은 규칙 한 벌로 넣었다.** 재개 턴이 한도로 죽었을 때
계수를 물려받을지 말지를 이제 실제로 판정한다: **시각을 둘 다 아는 판은 시계가**(새 벽이
직전 벽보다 뒤이고 아직 오지 않았나), **한쪽이라도 미상인 판은 일한 흔적이**(그 턴이
어시스턴트 출력·도구 호출을 하나라도 냈나) 가른다. 엔진 A/B 실측(같은 대본을 R28c 코드에
먹인 대조군): 창을 일곱 번 넘는 밤샘 주행이 **2회 → 7회**, 꼬리 없는 축의 일한 재개가
**2회 → 6회**로 열렸고, **진짜 헛발질은 양쪽 모두 2회에서 그대로 접힌다**(RCAP 불변).
렌더러 하네스 **197 → 234 단언**, 실패 0. `cargo test -p ccg-engine` **212 통과 · 2 무시 ·
0 실패**(신설 4 포함). typecheck 3종 초록.

---

## 1. 무엇이 틀렸었나

`firesRef`(렌더러) / `auto_resume_streak`(엔진)은 **한도로 죽은 착지마다** 올랐다. 그 턴이
30초 만에 같은 벽에 부딪혔는지, 5시간을 꽉 채워 일하고 **다음 창에서** 막혔는지를 아무도
안 봤다. 현실 시나리오:

```
22시 한도 → 03시 자동 재개(성공, 5시간 일함) → 08시 새 한도
          → 13시 자동 재개(성공)              → 18시 새 한도
          → 23시 **자동이 접힌다**
```

사용자는 아침에 「자동으로 이어서 보낸 turn이 계속 한도에 막혔어요」를 읽는다 — 그 turn들은
막힌 게 아니라 **일했다.** 「한도 자동 이어서」의 본래 값(밤샘 연속 주행)이 창 두 개에서 잘렸다.

## 2. 무엇을 고쳤나 — 규칙 한 벌

```
carried(streak, fired, next, worked, now):
  streak == 0                    → 0
  fired != null && next != null  → (next > fired && next > now) ? 0 : streak   # 시계가 판정
  그 밖                          → worked ? 0 : streak                          # 흔적이 판정
```

* `streak` = 표 바깥의 연속 계수 (`firesRef` / `auto_resume_streak`)
* `fired` = **직전에 자동 발사한 표**의 리셋 시각 (`fireResetsRef` / `auto_resume_at` — 이번에 새로 둔 값)
* `next` = 이번 한도 문구가 알려 준 리셋 시각
* `worked` = 그 턴이 어시스턴트 출력·도구 호출을 하나라도 냈다
  (렌더러: 마지막 사용자 말풍선 뒤의 `msg(assistant, !error, 비지 않음)` 또는 `toolgroup(tools>0)` /
   엔진: `Turn::saw_turn_activity`)

### 2.1 왜 OR가 아니라 우선순위인가 — **내가 판 함정 하나를 실측으로 메웠다**

첫 초안은 크리틱이 적은 대로 `① || ②`였다. 그 판을 엔진 테스트에 먹였더니
「토큰 한 줄 내고 **같은 벽**에 다시 부딪히는」 시나리오가 **6시간에 39발**을 쐈다 —
계수가 매번 0이 되고 `due_at = max(resets_at + 90s, armed_at + 15s)`라 15초마다 CLI를
태우는, **RCAP이 막은 그 무한 주기의 부활**이다. 시각을 둘 다 아는 판에서 ①의 답은 이미
완전하다(진짜로 넘어갔다면 새 창의 리셋은 반드시 더 뒤다). 그래서 그 판에서는 ②를 안 본다.
지금 값: 같은 시나리오 **2발**에서 접힘(`wcap_limit_streak.rs` ④가 그 자리를 잠근다).

### 2.2 왜 `next > now` 다리가 하나 더 붙었나 — **엔진 축에서만 드러난 사실**

엔진의 `epoch_secs_to_runtime`은 `saturating_sub`라 **지난 epoch을 `now`로 접는다.** 그래서
같은 벽에 다시 부딪힌 표의 런타임 `resets_at`은 언제나 "지금"이 되고, 크리틱이 적은 첫
다리(`next > fired`)만으로는 그 판이 **항상 「넘어갔다」**가 된다(위 39발의 직접 원인).
렌더러는 epoch 축이라 첫 다리가 그대로 살아 있다. 두 다리를 **양쪽 다** 두어 규칙을 한 벌로
맞췄다 — 렌더러에서 둘째 다리는 「이미 지난 시각을 새 벽이라고 내미는 문구」를 거르는 몫이다.

## 3. 실측

### 3.1 엔진 A/B — 같은 대본, R28c 코드 대 HEAD

대조군은 `crates/ccg-engine`을 `%TEMP%`에 복사해 **`arm_hold`의 규칙 세 줄만 R28c로
되돌린** 것이다(레포 무수정 · 워크스페이스 분리 후 `cargo test --offline`). 신설 테스트
파일을 그대로 두 판에 먹였다.

| 판(`wcap_limit_streak.rs`) | R28c | HEAD |
|---|---|---|
| ① 창이 진짜로 넘어간다(꼬리가 매 턴 1시간 뒤로 · 11시간) | **2회** · `ready+auto_paused+attempts:2` | **7회** · `attempts:0` · 안 접힘 |
| ② 꼬리 없는 문구 + 그 턴이 일을 했다(65분) | **2회** · 접힘 | **6회** · `attempts:0` · 안 접힘 |
| ③ 꼬리 없는 문구 + 빈손 = 진짜 헛발질(5시간) | 2회 · 접힘 | **2회 · 접힘(불변)** |
| ④ 토큰 한 줄 + 같은 벽(6시간) | 2회 · 접힘 | **2회 · 접힘(불변)** |

③④가 대조군에서도 초록인 것이 요점이다 — 이 라운드의 못은 **바꾼 것만 잡고 지켜야 할 것은
그대로 통과시킨다.** ①②는 대조군에서 붉고 HEAD에서 초록이다(붉음 → 수정 → 초록).

### 3.2 렌더러 하네스 — `scripts/poc-limit-resume.mjs`

```
PASS — 234 통과, 0 실패      (RCAP 기준 197 → +37)
5회 반복 주행 전부 234/0
```

J절이 새로 재는 것(훅 실구동 · 본채팅/멀티/추가 채팅 props):

| 항목 | 실측 |
|---|---|
| 밤샘 주행(창 6개 · 매 턴 일함) | **6발 · 계수 `[0,0,0,0,0,0]` · 안 접힘** |
| 같은 대본에서 구분자만 뺀 대조군 | **2발 · 계수 `[1,2]` · `ready+autoPaused`** |
| ① 창 이동만(턴은 빈손) | 4발 · 계수 전부 0 |
| ② 일한 흔적만(codex 배너형 — 읽을 꼬리 없음) | 4발 · 계수 전부 0 |
| codex 축 헛발질 | **2발**(불변) |
| 리셋 뒤 다시 세는가 | 일한 재개 → 백지 → 헛발질 1 → 2 → **접힘(3발에서 멎음)** |
| 토큰 한 줄 + 같은 벽(8회 시도) | **2발에서 접힘** |

I절(RCAP의 5시간 주행)은 손대지 않았고 그대로다: **R28b(`63bf667`) 27회 → HEAD 2회 ·
32분에 자동 정지.** G/H절(조회 실패 세 갈래 · codex 채널)도 무손상.

### 3.3 그 밖

```
cargo test -p ccg-engine            → 212 통과 · 2 무시 · 0 실패 (기존 208 + 신설 4)
cargo check -p agentcodegui --features custom-protocol → 초록(17.1s)
npm run typecheck (node·web) + typecheck:app          → 3종 초록
신설 테스트 20회 반복                → 20/20 ok (플레이키 아님)
```

## 4. 만진 파일

| 파일 | 무엇 |
|---|---|
| `crates/ccg-engine/src/runtime.rs` | `auto_resume_at` 필드 신설 · `consume_hold`가 발사한 표의 리셋 시각을 챙김 · `arm_hold`의 `attempts` 계승 규칙에 리셋 조건 추가(계수를 **표 안팎 둘 다** 되돌린다) |
| `app/src/lib/limitResume.ts` | `windowRolled` · `turnDidWork` · `carriedAttempts`(+`TurnItem`) 신설 — 순수 판정 |
| `app/src/lib/useLimitResume.ts` | `fireResetsRef` 신설(엔진 `auto_resume_at`의 짝) · 장전 자리에서 `carriedAttempts` 호출 · 소진 자리에서 두 값을 함께 나름 |
| `scripts/poc-limit-resume.mjs` | J절 신설(37 단언) · `rearm(h, text, {work})` 손잡이 |
| `crates/ccg-engine/tests/wcap_limit_streak.rs` | 신설 — 엔진 축 회귀 잠금 4종(①②가 이번 수정, ③④가 RCAP 불변) |

**안 건드린 것**: RCAP이 세운 상한(`MAX_AUTO_ATTEMPTS`=2)·「이어가기」 버튼·계승 구조·
`sanitizeHold` 복원 규약·`resumeVerdict`의 세 갈래·CSS 0줄. 기준 결과 파일
(`bench/results/*` · `bench/shots/*/report.json` · `docs/critic/*.json`) **0개 덮음**.

## 5. 안 한 것 · 남는 것

* **라이브 앱 주행 없음.** 이 변경에 닿으려면 실 CLI를 여러 번 한도까지 태우고 창이
  넘어가기를 기다려야 한다(5시간 단위). 대신 엔진은 가상 시계 재생으로, 렌더러는 훅
  실구동(세 표면 props)으로 쟀다. 실계정 토큰 0건 · 실 HTTP 0건 · 이름 기반 kill 0건.
* **`npm run app:build` 안 돌림** — 같은 트리에서 다른 갈래가 굽는 중일 수 있어
  `app/dist`를 안 흔든다(RCAP 라운드와 같은 이유).
* **남는 좁은 판**: 시각을 **한쪽도** 모르는 축(codex 배너형)에서, 매 턴 토큰 한 줄만 내고
  같은 한도로 죽는 서버가 있으면 계수가 계속 0이라 자동이 안 접힌다. 그 축에는 견줄 시계가
  없어서 값싼 구분자가 ②뿐이다. 다만 그 판의 간격은 `unknown_wait(0)` = **10분**이고
  (계수가 0이라 백오프도 안 붙는다), 출력이 하나도 없는 턴이 한 번만 섞이면 계수가 곧바로
  다시 선다(하네스 J③이 그 복귀를 잠근다). 렌더러 쪽 같은 축의 간격은 `PROBE_MS` 10분이다.
* **크리틱 §4.2(본채팅 계수가 채팅마다가 아니라 창 하나에 하나) · §4.3(프롬프트 없는 표의
  침묵) · §4.4(한글 문구 속 `turn`)** 은 이 라운드의 과녁이 아니라 손대지 않았다.

---

# R2 — 「화면에 아무것도 안 남기는 프레임 한 장」이 상한을 지웠다

빌더: WCAP R2 · 2026-08-25 · 과녁: `docs/critic/r28d-wcap-critic-r1.md` §3.2(그 라운드의 **최대 격차**)

## 6. 한 문단

크리틱이 옳다. R1의 구분자 ②는 엔진에서 `Turn::saw_turn_activity`를 읽었는데, 그 깃발은
`Frame::StreamEvent` 처리의 **맨 끝줄에서 조건 없이** 섰다 — `match`의 `_ => {}` 갈래로 빠진
프레임도 그 줄에 닿는다. 그래서 `ping` **한 장**이면 「일했다」가 됐고, 시각 미상 축
(= codex 대기표의 기본 축, ①이 영영 침묵하는 축)에서는 ②가 유일 판정자라 그 한 장이
RCAP의 「자동은 최대 2발」을 통째로 지웠다. **엔진의 문턱을 렌더러의 문턱으로 좁혔다**:
비어 있지 않은 어시스턴트 텍스트 · 도구 호출 · 도구 결과. 넓은 `saw_turn_activity`는 자기
자리(무음 result 보류 T8 · 미니턴 오판 복구 T9)에 그대로 남는다 — 거기서는 낮은 문턱이 옳다.

## 7. 무엇을 고쳤나

| 자리 | R1 | R2 |
|---|---|---|
| `Turn`(엔진) | `saw_turn_activity` 하나 | `saw_turn_output` **신설**(좁은 문턱). 넓은 쪽은 T8/T9 몫으로 그대로 |
| `Frame::StreamEvent` | 끝줄에서 무조건 `mark_activity()` | `mark_activity()` **뒤에**, `text_delta`이고 그 텍스트가 공백만이 아닐 때만 `mark_output()` |
| `Frame::Assistant` | `has_text \|\| tool_uses` → 활동 | 같은 조건에서 활동, **그리고** 도구 호출이 있거나 텍스트 블록이 **비어 있지 않을** 때만 산출 (`has_text`는 `{"type":"text","text":""}`에도 참이다) |
| `Frame::User` 도구 결과 | 활동 | 활동 + 산출 |
| `arm_hold`의 `worked` | `saw_turn_activity` | **`saw_turn_output`** |
| `turnDidWork`(렌더러) | 추론 말풍선이 없다고 *가정* | `id === 'thinking'`을 **이름으로 건너뛴다** |

마지막 줄이 R2의 두 번째 조각이다. 렌더러가 추론을 안 세는 것은 원래 **다른 파일의
습관**(스토어가 착지마다 `THINKING_ID`를 걷는다)이었지 이 함수의 규칙이 아니었다. 엔진이
정확히 그 틈으로 갈라졌으므로(추론 꼬리를 `stream_event thinking_delta`로 그대로 내보내는
codex 트랜스코더 · `crates/ccg-engine/src/codex/transcode.rs:725`), 렌더러 쪽에도 규칙을
글자로 박아 **두 축이 같은 문장 하나**를 들게 했다.

`mark_output()`은 **반드시 `mark_activity()` 뒤에** 부른다 — 상주 정리턴 재개(T19b)가
`mark_activity()` 안에서 턴을 새로 열기 때문에, 먼저 부르면 방금 열린 턴이 아니라 없는 턴에 적는다.

## 8. 실측 — 크리틱이 실패시킨 표를 직접 재현했다

### 8.1 엔진 A/B(레포 무수정 · `%TEMP%/wcapr2ws` 사본 · `Cargo.lock` 함께 복사)

대조군은 크리틱의 절차 그대로다: `crates/`+`Cargo.toml`+`Cargo.lock`을 `%TEMP%`에 복사하고
`members`에서 `src-tauri`만 뺀 뒤, **`arm_hold`의 한 줄만** R1(`saw_turn_activity`)로
되돌렸다. 신설 테스트 ⑤⑥을 두 판에 그대로 먹였다(시각 미상 배너형 · 12시간 가상 주행).

| 죽기 전에 흘린 프레임 | R1 대조군 | HEAD(R2) |
|---|---|---|
| 없음(순수 문전박대) | 2회 · attempts 2 · 접힘 | 2회 · attempts 2 · 접힘 (불변) |
| `stream_event {type:"message_start"}` | **71회 · attempts 0 · 안 접힘** | **2회 · attempts 2 · 접힘** |
| `stream_event` `thinking_delta` | **71회 · 안 접힘** | **2회 · 접힘** |
| `stream_event {type:"ping"}` | **71회 · 안 접힘** | **2회 · 접힘** |
| `stream_event content_block_start(text)` | **71회 · 안 접힘** | **2회 · 접힘** |
| `text_delta`인데 내용이 공백뿐 | **71회 · 안 접힘** | **2회 · 접힘** |
| `assistant` 텍스트 블록인데 빈 문자열 | **71회 · 안 접힘** | **2회 · 접힘** |

크리틱이 잰 **71**과 한 자리도 안 다르다. 반대 방향(과잉 절단)도 같이 쟀다 — 화면에 남는
산출은 **양쪽 다** 그대로 「일했다」다:

| 65분 · 시각 미상 | R1 대조군 | HEAD(R2) |
|---|---|---|
| `text_delta`(스트리밍 글자) | 6회 · attempts 0 | 6회 · attempts 0 |
| 완성 `assistant` 텍스트 | 6회 · 0 | 6회 · 0 |
| 도구 호출 + 결과 | 6회 · 0 | 6회 · 0 |
| 도구 결과만 | 6회 · 0 | 6회 · 0 |

그리고 R1이 세운 네 못(①②③④)의 숫자는 **한 칸도 안 움직였다**: 7 / 6 / 2 / 2.

> **함정 하나 — 하네스 쪽이었다.** ⑥의 「도구 호출」 판을 결과 없이 흘렸더니 그 스트림이
> 도구가 도는 채로 **상주**가 되고(실측 `state=Resident` · 재스폰 0) 한도 재발사 경로에
> 아예 안 들어갔다. R1의 가짜 CLI가 「스폰 하나에 답 한 번」이라 **프로세스를 재사용하는
> 재개**에 영영 답을 안 준 탓이다. 줄의 종류로 갈랐다(`line["type"] == "user"`일 때만 응답
> — 제어 줄은 턴이 아니다). ①②③④의 숫자가 그대로인 것이 이 손질이 중립임을 보인다.

### 8.2 렌더러 A/B(`app/`·`scripts/`·`src/renderer/src/lib`를 `%TEMP%/wcapr2ren`에 복사)

`turnDidWork`에서 `id === 'thinking'` 건너뛰기 한 줄만 뺀 대조군.

| 판 | 대조군 | HEAD(R2) |
|---|---|---|
| `turnDidWork([사용자, 추론, 오류])` | `true` ✗ | `false` ✓ |
| `turnDidWork([사용자, 추론])` | `true` ✗ | `false` ✓ |
| 추론이 사용자 경계를 가리는가 | `true` ✗ | `false` ✓ |
| 훅 실구동 · codex 배너형 · 추론만 흘리고 죽는 턴 ×8 | **8발 · 계수 `[0,0,0,0,0,0,0,0]` · 안 접힘** ✗ | **2발 · 계수 `[1,2]` · `ready+autoPaused`** ✓ |
| (과잉 절단 방지) 추론 **아래**의 진짜 출력은 보는가 | `true` ✓ | `true` ✓ |

`node scripts/poc-limit-resume.mjs` — 대조군 **232 통과 · 5 실패**, HEAD **240 통과 · 0 실패**
(R1 기준 234 → +6, 무후퇴).

### 8.3 그 밖

```
cargo test -p ccg-engine     → 214 통과 · 0 실패 · 2 무시 (R1의 212 + 신설 2)
cargo test -p ccg-store      → 89 / 0
cargo test -p ccg-auth       → 104 / 0
cargo test -p ccg-fs         → 101 / 0 / 2 무시
cargo test -p ccg-lsp        → 59 / 0
cargo test -p agentcodegui   → 146 / 0
wcap_limit_streak 20회 반복  → 20/20 초록 (플레이키 아님)
npm run typecheck(node·web) + typecheck:app → 3종 초록(exit 0)
```

## 9. 만진 파일(R2)

| 파일 | 무엇 |
|---|---|
| `crates/ccg-engine/src/runtime.rs` | `Turn::saw_turn_output` 신설 · `mark_output()` · 프레임 세 자리에서 좁은 문턱으로 표시 · `arm_hold`의 `worked`가 그 값을 읽음 · 헬퍼 `nonblank`/`nonblank_assistant_text` |
| `app/src/lib/limitResume.ts` | `TurnItem.id` · `turnDidWork`가 `THINKING_ID`를 건너뜀 · 문턱이 「두 축의 정의 그 자체」임을 주석에 못 박음 |
| `crates/ccg-engine/tests/wcap_limit_streak.rs` | 못 ⑤(안 남는 프레임 7종 · 크리틱 P4 표) · ⑥(남는 산출 4종) 신설 · 가짜 CLI의 응답 조건을 「사용자 줄」로 교체 |
| `scripts/poc-limit-resume.mjs` | J①에 추론 못 4단언 · J②에 훅 실구동 「추론만 흘리는 밤샘」 2단언 · `rearm(…, {think})` 손잡이 |

**안 건드린 것**: `saw_turn_activity`의 기존 쓰임(T8 무음 result 보류 · T9 미니턴 오판 복구 ·
`on_result`의 착지 판정) · 구분자 ①과 그 두 다리 · 우선순위 규약 · 상한 2 · 「이어가기」 ·
`app/src/lib/useLimitResume.ts`(R2에서 0줄) · CSS 0줄. 기준 결과 파일 **0개 덮음**.

## 10. 남는 리스크

* **`text_delta`는 여전히 「일했다」다.** 서버가 매 턴 글자 한 자를 흘리고 같은 한도로 죽으면
  시각 미상 축에서 계수가 계속 0이다. 이건 격차가 아니라 **정의**다 — 그 판에서는 렌더러
  스레드에도 어시스턴트 말풍선이 남으므로 두 축이 같은 답을 내고, 사용자가 화면에서 보는
  것과도 맞는다. 간격은 `unknown_wait(0)` = 10분이고, 출력이 없는 턴이 한 번만 섞이면 계수가
  다시 선다(J③이 그 복귀를 잠근다).
* **엔진의 `Frame::Assistant{tool_use}` 한 다리는 단독 못이 없다.** 결과 없이 죽은 도구 호출은
  스트림을 상주로 만들어 한도 재발사 경로에 아예 안 들어가므로(§8.1의 함정) 쌍으로만 잰다.
  그 다리를 지워도 `tool_result` 쪽이 같은 답을 낸다 — 중복이지만, 렌더러가 「비어 있지 않은
  도구 그룹」을 세는 규칙과 글자를 맞추려고 남겼다.
* **부팅 재장전의 비대칭**(엔진 `reload_state`가 `attempts: 0`을 심고 렌더러는 `sanitizeHold`가
  살린다)은 R28c부터 있던 것이고 이 라운드 변경과 무관하다. 크리틱 §4의 기록 그대로 남는다.
* **라이브 앱 주행 없음**(R1과 같은 이유 — 창 하나가 5시간이다). 실계정 토큰 0건 · 실 HTTP
  0건 · 이름 기반 kill 0건 · 격리 `CARGO_TARGET_DIR=target-wcapr2`.

---

# R3 — 「무엇을 세는가」는 맞췄는데 「어느 턴의 것으로 세는가」를 안 맞췄다

빌더: WCAP R3 · 2026-08-25 · 과녁: `docs/critic/r28d-wcap-critic-r2.md` §3.3(그 라운드의 **최대 격차**)

## 11. 한 문단

크리틱이 옳다. R2는 두 축의 **문턱**(무엇이 산출인가)만 맞췄고 **경계**(어느 턴의 산출인가)를
안 맞췄다. 엔진의 `saw_turn_output`은 *프레임이 도착한 엔진 턴*에 적히고, 렌더러의
`turnDidWork`는 *마지막 사용자 말풍선 뒤 구간*에서 읽는다. 도구가 그 경계를 넘으면 —— 앞 턴에서
결과 없이 죽은 `tool_use`의 `tool_result`가 재개 턴에 뒤늦게 도착하면 —— 두 축이 정반대 답을
낸다. **엔진의 도구 결과 계수에 「이 턴 안에서 열린 도구만」이라는 경계를 붙였다.** 인과
대조군(그 한 조각만 R2로 되돌림)으로 크리틱의 숫자를 그대로 재현했다: P12 대본이 **12시간 71발 ·
attempts 0 · 안 접힘 → 2발 · attempts 2 · 접힘**. 회귀 잠금 ⑦ 신설 + ⑤에 「짝 없는 도구 결과」
편입 + ⑥의 오분류 한 줄 제거. **계기 눈금도 고쳤다** — R2까지 재발사를 `spawns`(재스폰)로 셌는데
상주 스트림의 주입 재개는 스폰을 안 올린다(실측 재스폰 0 · CLI턴 71). 이제 프롬프트 줄을 센다.
`cargo test -p ccg-engine` **215/0/2무시**, 렌더러 하네스 **249/0**(R2 240 → +9), typecheck 3종 초록.

## 12. 무엇을 고쳤나

| 자리 | R2 | R3 |
|---|---|---|
| `runtime.rs` `Frame::User`의 도구 결과 | **무조건** `mark_output()` | 원장 항목의 `born_run == 이 턴의 run_id`일 때만 `mark_output()`. 짝 없는 결과(원장에 없음)도 안 센다 |
| `Turn::saw_turn_output` 문서 | 「도구 결과」 | 「**이 턴 안에서 연** 도구의 결과」 |
| `arm_hold` 구분자 ② 주석 | 같은 문장 | 같은 문장 + 경계 |
| `limitResume.ts::turnDidWork` 문서 | 「비어 있지 않은 도구 그룹」 | 그 그룹이 **왜** 턴 경계를 못 넘는지(`tool-end`는 제자리 패치라 그룹이 사용자 말풍선 앞에 남는다)를 못 박음. **동작 변경 0줄** |
| `limitResume.ts::THINKING_ID` 주석 | 「엔진과 글자를 맞춘 수정」 | 「실물 무동작 · 옛 모양 대비 방어선일 뿐 · 판별력의 근거로 쓰지 마라」(§14.3) |
| `wcap_limit_streak.rs`의 재발사 눈금 | `driver.spawns` | **`WcapCli::turns`**(stdin으로 나간 사용자 프롬프트 줄 = CLI 턴 1회) |
| 못 ⑤ | 안 남는 프레임 7종 | +**「짝 없는 도구 결과」**(크리틱 §3.2 대조표의 유일한 불일치 줄) |
| 못 ⑥ | 「도구 호출+결과」·「도구 결과만」 | 「**같은 턴의** 도구 호출+결과」·「**결과 없이 죽는 도구 호출**」(뒤엣것은 R2의 눈금으로는 못 재던 상주 판) |
| 못 ⑦ | — | **신설** — P12(도구가 턴 경계를 넘음) |

렌더러의 **판정 로직은 한 줄도 안 바꿨다.** 크리틱이 확인한 대로 그쪽이 이미 옳았고(2발·접힘),
이 라운드는 엔진을 그 경계로 끌어온 것이다. 렌더러 쪽에 더한 것은 **주석과 못**뿐이다.

## 13. 실측 — 크리틱이 실패시킨 표를 직접 재현했다

### 13.1 엔진 인과 대조군(레포 무수정 · `%TEMP%/wcapr3ws` 사본 · `members`에서 `src-tauri`만 제거)

대조군 = **R3의 그 한 조각만** R2로 되돌린 것(`born == cur` 가드를 지우고 무조건 `mark_output()`).

| 못 | R2 대조군 | HEAD(R3) |
|---|---|---|
| **⑦ P12 — 앞 턴 도구의 결과만 오는 재개(12시간·시각 미상)** | **71회 · attempts 0 · ready:false · 안 접힘** ✗ | **2회 · attempts 2 · ready+auto_paused** ✓ |
| ⑤ 짝 없는 도구 결과(12시간) | **71회 · attempts 0 · 안 접힘** ✗ | **2회 · attempts 2 · 접힘** ✓ |
| ⑤ 나머지 7줄(없음·`message_start`·`thinking_delta`·`ping`·`content_block_start`·빈 `text_delta`·빈 assistant) | 2회 · 접힘 | 2회 · 접힘 (불변) |
| ⑥ 4줄(`text_delta`·assistant 텍스트·같은 턴 도구쌍·결과 없이 죽는 도구 호출) | 6회 · attempts 0 | 6회 · attempts 0 (불변) |
| ①②③④ | 7 / 6 / 2 / 2 | 7 / 6 / 2 / 2 (불변) |

대조군 실행 결과 그대로:

```
test result: FAILED. 5 passed; 2 failed
  a_tool_result_that_crosses_the_turn_boundary_does_not_clear_the_streak
    assertion `left == right` failed: ★★ 턴 경계를 넘은 도구 결과가 상한을 지웠다 — 12시간에 71회
      left: 71   right: 2
  a_frame_that_leaves_nothing_on_screen_does_not_clear_the_streak
    assertion `left == right` failed: ★★ 「짝 없는 도구 결과」 한 장이 상한을 지웠다 — 12시간에 71회
      left: 71   right: 2
```

붉음 → 수정 → 초록. **반대 방향(과잉 절단)은 대조군에서도 초록**이다(⑥ 4줄·①②③④) — 이 못은
바꾼 것만 잡는다.

### 13.2 계기 눈금 — 재스폰은 재발사가 아니다(크리틱 §4.1 재현)

같은 사본의 탐침(`zprobe_r3.rs` · `%TEMP%`), 12시간·시각 미상:

| 대본 | 재스폰 | **CLI턴(프롬프트 줄)** | 상태 | attempts |
|---|---|---|---|---|
| 결과 없이 죽는 도구 호출 | **0** | **71** | `Resident` | 0 |
| P12(도구가 턴 경계를 넘음) | 1 | 2 | `Idle` | 2 |
| 순수 문전박대(대조) | 2 | 2 | `Idle` | 2 |

첫 줄이 R2 눈금의 눈먼 자리다 — `spawns`로는 71발이 **0**으로 보인다. 그래서 R3의 `run()`은
프롬프트 줄을 센다. 재스폰 경로에서는 두 눈금이 같은 값이라 ①②③④⑤⑥의 숫자는 안 움직였다.

### 13.3 렌더러 하네스 A/B(`app/`·`scripts/`·`src/renderer/src/lib`를 `%TEMP%/wcapr3ren`에 복사)

렌더러 판정은 안 바꿨으므로 대조군은 **경계 자체를 지운 판**이다(`turnDidWork`에서
`if (m.kind === 'msg' && m.role === 'user') return false` 한 줄 제거 = 엔진 R2의 프레임 축과 같은 판정).

| 판 | 대조군 | HEAD |
|---|---|---|
| `turnDidWork([앞 턴 도구그룹, 사용자, 오류])` | `true` ✗ | `false` ✓ |
| `carriedAttempts(2, null, null, [앞 턴 도구그룹, 사용자, 오류])` | `0` ✗ | `2` ✓ |
| 훅 실구동 · codex 배너형 · **앞 턴 도구 결과만** 오는 재개 ×8 | **8발 · 계수 `[0,0,0,0,0,0,0,0]` · 안 접힘** ✗ | **2발 · 계수 `[1,2]` · `ready+autoPaused`** ✓ |
| (과잉 절단 방지) 앞 턴 그룹이 남아 있어도 **이 턴이** 일했으면 | 4발 · 계수 전부 0 ✓ | 4발 · 계수 전부 0 ✓ |
| 스토어의 **실제** 추론 항목(`kind:'thinking'`) | `false` ✓ | `false` ✓ |

`node scripts/poc-limit-resume.mjs` — 대조군 **236 통과 · 10 실패**, HEAD **249 통과 · 0 실패**
(R2 기준 240 → +9, 무후퇴). 3회 반복 전부 249/0.

### 13.4 그 밖

```
cargo test -p ccg-engine     → 215 통과 · 0 실패 · 2 무시 (R2의 214 + 신설 ⑦)
cargo test -p ccg-store      → 89 / 0
cargo test -p ccg-auth       → 104 / 0 (86+14+2+1+1)
cargo test -p ccg-fs         → 101 / 0 / 2 무시
cargo test -p ccg-lsp        → 59 / 0
cargo test -p agentcodegui --features custom-protocol → 146 / 0
cargo build --release --features custom-protocol -p agentcodegui → exit 0
wcap_limit_streak 20회 반복  → 20/20 초록 (플레이키 0)
npm run typecheck(node·web) + typecheck:app → 3종 초록(exit 0)
격리 CARGO_TARGET_DIR = target-wcapr3 (다른 갈래와 안 겹침)
```

## 14. R2 보고서·커밋의 사실관계 오류 셋 — 정정

크리틱 §4가 짚은 셋을 **내 손으로 재현하고** 여기 정정한다. 위 §8.1·§10의 해당 문장은
**틀린 채로 남겨 둔다**(고쳐 쓰면 무엇이 틀렸는지가 사라진다) — 읽을 때 이 절이 우선이다.

### 14.1 「결과 없이 죽은 도구 호출은 한도 재발사 경로에 아예 안 들어간다」 → **재스폰만 0이다**

§8.1의 함정 기록과 §10 둘째 항목의 문장이다. 실측(§13.2): `state=Resident` · **재스폰 0** ·
**CLI턴 71**. 상주 스트림은 프로세스를 재사용해 재개를 **주입**하므로(`drain_if_possible`이
`Idle` **또는 `Resident`**에서 돈다) 스폰 계수가 안 오를 뿐, 재개는 71번 나갔다. 내 계기의
눈금을 오독한 것이고, 그 오독 위에 「그래서 도구 축은 쌍으로만 잰다」는 못 ⑥의 설계 근거가
서 있었다. 눈금을 프롬프트 줄로 바꾸고(§13.2), ⑥에 「결과 없이 죽는 도구 호출」 단독 줄을
세웠다(그 판은 렌더러에서도 「일했다」다 — 이 턴이 연 도구 그룹이 비어 있지 않다).

### 14.2 「출력 없는 턴이 한 번만 섞이면 계수가 다시 선다」 → **다시 서지만 1에서 멈춘다**

§10 첫째 항목의 완화 문장이다. 12시간 · 시각 미상 · `unknown_wait(0)`=10분, 내 탐침 실측:

| 대본 | 재발사 | attempts | 접힘 |
|---|---|---|---|
| 매 턴 글자 하나 | **71발** | 0 | ✗ |
| **두 턴에 한 번은 빈손** | **47발** | 1 | ✗ |
| 세 턴에 한 번은 빈손 | **53발** | 1 | ✗ |
| 매 턴 빈손(대조) | 2발 | 2 | ✓ |

계수는 확실히 다시 서지만 **1에서 멈춘다.** 상한 2에 닿으려면 빈손이 **연달아 둘**이어야 한다.
크리틱이 잰 숫자와 한 자리도 안 다르다. **이 라운드에서 안 고쳤다** — 아래 §16 첫 항목 참고
(파리티는 안 깨져 있고, 고치려면 RCAP의 「연속 계수」 구조 자체를 바꿔야 한다).

### 14.3 렌더러 R2 한 줄(`THINKING_ID` 건너뛰기)은 **실물 무동작**이고 그 증거는 합성이었다

스토어의 추론 항목은 `{ kind:'thinking', id, text }`이고(`app/src/store/session.ts:36`)
`turnDidWork`는 `kind`가 `'msg'`/`'toolgroup'`인 것만 본다 — 그 줄이 없어도 답은 거짓이다.
§8.2가 판별력의 증거로 든 「대조군 8발」의 픽스처 `{ id:'thinking', kind:'msg' }`는 **스토어가
결코 만들지 않는 모양**이었다. 줄 자체는 남긴다(옛 `kind:'msg'` 모양이 돌아와도 막힌다). 다만
주석에 「실물 무동작 · 판별력의 근거로 쓰지 마라」를 박았고, 하네스에는 **실물 모양**의 못
(`{ kind:'thinking' }` → `false`)을 따로 세웠다. **R2의 실제 수정은 엔진 한 축뿐**이었다.

## 15. 만진 파일(R3)

| 파일 | 무엇 |
|---|---|
| `crates/ccg-engine/src/runtime.rs` | `Frame::User`의 도구 결과에 `born_run == 이 턴` 경계 · `Turn::saw_turn_output`과 `arm_hold` ②의 문장을 그 경계로 정정 |
| `crates/ccg-engine/tests/wcap_limit_streak.rs` | 못 ⑦ 신설(P12) · ⑤에 「짝 없는 도구 결과」 · ⑥의 「도구 결과만」 제거 + 「결과 없이 죽는 도구 호출」 신설 · 재발사 눈금을 `spawns`→프롬프트 줄 · `cross_turn_tool` 손잡이 |
| `app/src/lib/limitResume.ts` | **주석만**(경계가 왜 사용자 말풍선인지 · `THINKING_ID`의 실물 무동작 정정) — 판정 로직 0줄 |
| `scripts/poc-limit-resume.mjs` | J①에 실물 추론 모양 2단언 + P12 도구 그룹 2단언 + `carriedAttempts` 2단언 · J②에 훅 실구동 crossTool 3단언 · `rearm(…, {crossTool})` 손잡이 |
| `docs/parity-fix-wcap-r1.md` | 이 절들 |

**안 건드린 것**: `app/src/lib/useLimitResume.ts`(R2·R3 모두 0줄) · `turnDidWork`의 판정 로직 ·
구분자 ①과 두 다리 · 우선순위 규약 · 상한 2 · 「이어가기」 · `saw_turn_activity`의 기존 쓰임
(T8/T9) · CSS 0줄 · `src-tauri/**` 0줄(EXTN 갈래와 경로 무충돌). 기준 결과 파일 **0개 덮음**.

## 16. 남는 리스크

* **§14.2의 47발은 아직 「정의」로 남아 있다.** 매 턴 산출을 내면서 같은 벽에 계속 부딪히는
  서버가 있으면, 빈손이 연달아 둘 오기 전까지 자동이 안 접힌다(12시간 47~71발 · 10분 간격).
  **파리티는 안 깨져 있다** — 렌더러도 같은 답을 낸다(하네스 J③이 그 복귀를 잠근다). 고치려면
  RCAP의 「연속 헛발질 계수」를 「에피소드 총 발사 예산」 같은 다른 구조로 바꿔야 하는데, 그건
  이 라운드가 받은 경계(「상한·버튼·계승 구조는 그대로 두고 리셋 조건만 더한다」) 밖이고
  ①②(밤샘 주행)를 다시 자를 위험이 크다. 다음 라운드의 후보로 남긴다.
* **부팅 재장전 비대칭**(엔진 `reload_state`가 `attempts:0`을 심어 재시작마다 눈감은 2발이
  새로 생긴다 — 렌더러는 `sanitizeHold`가 계수를 살린다)은 R28c부터 있던 것이고 이 변경과
  무관하다. 크리틱 R2 §5의 기록 그대로 남는다.
* **`rate_limit_event`(1순위 프레임) 경로**는 턴 한복판에서 `arm_hold`를 부르므로 그 턴이 방금
  흘린 산출을 그대로 「일했다」로 읽고, 그 턴의 `result`는 성공이라 **렌더러는 표를 아예 안
  세운다**(축이 하나뿐). 코드 주석대로 아직 미관측(O14)이라 이 라운드에서 안 건드렸다.
* **한도 문구가 어시스턴트 텍스트로 오는 판**은 두 축 다 「일했다」로 읽는다. 파리티는 맞지만
  공통 맹점이다(크리틱 §3.2의 그 줄).
* **라이브 앱 주행 없음**(R1·R2와 같은 이유 — 창 하나가 5시간이다). 실계정 토큰 0건 ·
  실 HTTP 0건 · 이름 기반 kill 0건.

---

# R4 — 같은 문(門)의 네 번째 판: 「이 턴이 연 도구 그룹」이 **누가 턴을 열었느냐**에 매달려 있었다

빌더: WCAP R4 · 2026-08-25 · 과녁: `docs/critic/r28d-wcap-critic-r1.md`(커밋 `1ac86bb` — `06067db`를
겨눈 **두 번째** R1 판정문. 첫 번째는 `0f404be`이고 같은 파일을 덮었다)

## 17. 한 문단 — 판정문이 겨눈 회귀는 이미 닫혀 있었다. 그 판정문이 **남긴** 것을 닫는다

판정문 `1ac86bb`는 `06067db`(R1)를 잰 것이고, 레포 HEAD에는 이미 R2(`f8da858`)·R3(`468d905`)가
얹혀 있다. **그 최대 격차(내용 0 프레임 한 장이 상한을 지운다)는 R2가, 두 번째 격차(도구가 턴
경계를 넘는다)는 R3가 이미 닫았다** —— 이 라운드는 그 말을 믿지 않고 **직접 재현했다**: 레포를
한 줄도 안 고치고 `crates/`+`Cargo.toml`+`Cargo.lock`을 `%TEMP%/wcapr4ws`에 복사해 `arm_hold`의
**한 줄만**(`saw_turn_output` → `saw_turn_activity`) R1 규칙으로 되돌린 대조군에 **같은 못**을
먹였다. 판정문의 숫자가 그대로 나왔다: 내용 0 프레임 **71 → 2**, 턴 경계 넘은 도구 결과
**71 → 2**, 그리고 판정문 P4의 **반쪽만 아는 벽 42 → 2**. 그 세 축은 HEAD에서 전부 초록이다.

**그러나 판정문이 남긴 셋이 열려 있었다.** ① §6의 「한글 문장 안의 `turn`」은 실제로 미착수였고,
② §8-3이 요구한 「같은 대본을 **양쪽에** 먹인 계수 궤적이 일치하는 못」은 없었으며, ③ 그 못을
실제로 박아 보니 **파리티가 아직 한 자리에서 깨져 있었다** —— R3 확인 크리틱(`29712ed`) §4.3이
「다음 라운드 후보」로 남긴 그 자리다. 두 축의 공통 문장은 R3에서 「**이 턴이 연** 비어 있지 않은
도구 그룹」이 됐는데, 렌더러에서 「이 턴」을 정하는 것은 스토어의 `openGroupId`이고 그 값을 비우는
자리에 **`user-echo`가 빠져 있었다.** 한도 자동 재개는 정확히 그 경로다(엔진이 큐를 드레인하며
여는 턴). 그래서 **텍스트 없이 도구만 여는 재개 턴**에서 스토어는 그 도구를 앞 턴의 열린 그룹에
밀어 넣었고, 뒤에서부터 훑는 `turnDidWork`는 사용자 말풍선에서 멎어 거짓을 냈다 —— 엔진은 참이라
**71 대 2가 `tool_use` 문으로 한 번 더** 서 있었다. **스토어 한 줄로 닫았다.**

## 18. 무엇을 고쳤나

| # | 자리 | 무엇 |
|---|---|---|
| ① | `app/src/store/session.ts` — `user-echo` | **`openGroupId: null` 한 줄.** `begin`이 처음부터 갖고 있던 줄이다. 새 사용자 말풍선이 붙으면 열린 도구 그룹은 닫힌다 — **여는 주체와 무관하게.** |
| ② | `crates/ccg-engine/src/runtime.rs` · `app/src/components/Chat.tsx` | 한글 공지·배너의 `turn` → **`턴`**(판정문 §6). 두 문장은 같은 착지(`attempts >= MAX_AUTO_ATTEMPTS`)에서 뜨므로 같이 고쳤다. |
| ③ | `crates/ccg-engine/tests/wcap_limit_streak.rs` | 못 **⑧⑨ 신설**(판정문 P4 = **반쪽만 아는 벽** 축) · ⑤에 `content_block_stop` 편입 · `mixed_wall` 손잡이 |
| ④ | `scripts/poc-limit-resume.mjs` | **K절 신설** — 픽스처를 안 쓰고 **실제 스토어 리듀서**로 스레드를 지어 `turnDidWork`와 **훅**에 먹인다. 같은 이벤트 열을 `begin`/`user-echo` 두 벌로 돌려 **답·스레드 모양·계수 궤적**이 같은지 본다(판정문 §8-3). |

**판정 로직은 0줄이다.** `turnDidWork`·`carriedAttempts`·`windowRolled`·`arm_hold`의 규칙·상한 2·
「이어가기」·계승 구조 전부 그대로다. R4가 고친 것은 **그 판정에 들어가는 스레드를 스토어가
어떻게 짓는가**이고, 그래서 화면의 거짓(§20)도 같이 사라진다.

### 18.1 왜 `result`는 안 비웠나

R3 크리틱은 「`user-echo`(와 `result`)」라고 적었다. `result`는 **일부러 뺐다.** 파리티에는
`user-echo` 하나로 충분하다 —— 렌더러가 보는 모든 턴은 `begin`(사용자 전송) 또는
`user-echo`(엔진이 연 턴)로 시작하고, 그 둘이 다 비우면 「이 턴이 연 그룹」의 정의가 닫힌다.
반대로 `result`까지 비우면 **같은 실행이 이어서 내용을 내는 판**(무음 오판 뒤 진짜 턴 재개 —
`done→working` 재점등, `stripSilentTail`이 사는 그 자리)에서 한 턴이 도구 그룹 두 개로 쪼개진다.
판정에는 영향이 없고 화면만 나빠지는 변경이라 안 했다.

## 19. 실측 — 판정문이 실패시킨 표를 직접 재현했다

### 19.1 엔진 A/B — 판정문의 숫자가 그대로 나온다(레포 무수정)

`%TEMP%/wcapr4ws`(= `crates/`+`Cargo.toml`+`Cargo.lock` 복사 · workspace members에서 `src-tauri`만
제거 · **Cargo.lock을 반드시 같이** — 판정문 §함정의 indexmap 함정). 대조군은 `arm_hold`의
**한 줄만** R1 규칙으로 되돌린 것이고, 먹인 못은 **레포의 그 파일 그대로**다.

| 못 | 대본 | R1 규칙(대조군) | HEAD |
|---|---|---|---|
| ⑤ | 내용 0 프레임 한 장(`message_start`·`ping`·`thinking_delta`·`content_block_start`·**`content_block_stop`**·빈 델타·빈 텍스트·짝 없는 도구 결과) · 12h | **71회 · attempts 0 · 안 접힘** (`left: 71 right: 2`) | **2회 · attempts 2 · ready+auto_paused** |
| ⑦ | 앞 턴 도구의 결과만 오는 재개(P12) · 12h | **71회** (`left: 71 right: 2`) | **2회 · 접힘** |
| **⑧** | **반쪽만 아는 벽**(첫 표만 꼬리 있음) + `ping` · 12h | **42회** (`left: 42 right: 2`) | **2회 · 접힘** |
| ⑨ | 같은 축 + **진짜 산출** · 12h | 42회 · attempts 0 · 안 접힘 | **42회 · attempts 0 · 안 접힘**(불변) |
| ①②③④⑥ | 창 이동 7 / 일한 재개 6 / 헛발질 2 / 같은 벽 2 / 산출 4종 6 | 전부 동일 | 전부 동일(불변) |

대조군 실행 = **`6 passed; 3 failed`**(⑤⑦⑧이 붉다). **판별력 있음 · 과잉 절단 없음.**
⑧의 **42**는 판정문 P4가 잰 값과 같은 숫자다(⑤의 71보다 작은 이유는 첫 대기가 꼬리대로 5시간을
진짜 기다리기 때문이다). ⑨는 그 축에서 **좁히기가 과하지 않다**는 반대편 못이다.

> ⑧이 ⑤와 다른 것을 재는 이유: `arm_hold`의 `match (resets_at, self.auto_resume_at)`는 **한쪽만
> 미상이어도** 같은 `_ => worked` 가지로 떨어진다. 즉 ②가 유일 판정자가 되는 축은 「꼬리가 아예
> 없는 codex 배너형」만이 아니다 —— 클로드 문구 중 `…|epoch` 꼬리가 붙는 것은 일부고
> (`banner_limit_reached`·`your_limit`·한국어 계열엔 없다) 같은 계정이 턴마다 다른 문구를 받는다.
> **R1의 자기 신고가 「codex 배너형 + 토큰 한 줄」로 축소돼 있던 자리**(판정문 §4)이고, R2·R3의
> 못은 전부 `banner: true` 축에만 서 있었다.

### 19.2 렌더러 A/B — 이 라운드가 실제로 고친 자리

`%TEMP%/wcapr4ren`(= `app/`+`src/`+`scripts/poc-limit-resume.mjs` 복사 · `node_modules` 정션).
대조군은 **`user-echo`의 `openGroupId: null` 한 줄만** 뺀 것이다.

| 같은 이벤트 열(시각 미상 축 · 매 턴 도구를 여는 재개 · 6턴) | 대조군 | HEAD |
|---|---|---|
| 스레드(실제 리듀서) — 렌더러가 연다(`begin`) | `u TG(1) a! u TG(1) a!` | 동일(불변) |
| 스레드 — **엔진이 연다**(`user-echo`) | **`u TG(2) a! u a!`** | **`u TG(1) a! u TG(1) a!`** |
| `turnDidWork` — `begin` / `user-echo` | true / **false** | true / **true** |
| 훅 실구동 발사·계수 — `begin` | 6발 · `[0,0,0,0,0,0]` · 안 접힘 | 동일(불변) |
| 훅 실구동 발사·계수 — **`user-echo`** | **2발 · `[1,2]` · ready+autoPaused** | **6발 · `[0,0,0,0,0,0]` · 안 접힘** |

대조군 실행 = **268 통과 · 5 실패**, HEAD = **273 통과 · 0 실패**(그 사본엔 `.git`이 없어 I절의
`git show` 대조군 3단언이 빠진다 — 레포에서는 **276/0**). 반대 방향도 잠갔다: 「빈손(문전박대)」·
「앞 턴 도구의 결과만」은 **`begin`·`user-echo` 양쪽 다 2발 · `[1,2]` · 접힘**(RCAP 불변).

**그리고 이 표의 오른쪽 열이 곧 엔진의 답이다** —— K절의 기대값은 손으로 적은 숫자가 아니라
`wcap_limit_streak.rs` ⑤⑥⑦의 착지를 그대로 옮긴 표(`K_WANT`)다. 판정문 §8-3이 요구한 「같은
대본을 양쪽에 먹인 궤적이 일치하는 못」이 이것이다.

### 19.3 무회귀

| 검사 | 값 |
|---|---|
| `cargo test -p ccg-engine` | **217 / 0 / 2 무시** (R3의 215 + 신설 ⑧⑨) — 주행 뒤 **219/0/2**로 오름, §19.4 |
| `wcap_limit_streak` **20회 반복** | **20/20 초록** (플레이키 0) |
| `-p ccg-store` / `-p ccg-auth` / `-p ccg-fs` / `-p ccg-lsp` / `-p agentcodegui` | 90/0 · 110/0 · 101/0/2 · 59/0 · 146/0 |
| `node scripts/poc-limit-resume.mjs` ×3 | **276 통과 · 0 실패** (R3 249 → **+27**, 무후퇴) |
| `npm run typecheck`(node·web) + `typecheck:app` | 3종 **exit 0** |
| `npm run app:build` | 초록(2.24s) — `app/dist/`는 `.gitignore` |
| 릴리즈 빌드 `--release --features custom-protocol -p agentcodegui` | 초록 2m31s(`CARGO_TARGET_DIR=target-wcapr4`) + `-p ccg-engine --features fakecli --bins` 13s |
| `node scripts/poc-limit-engine.mjs`(그 exe) | **11 / 0** — `spawns=0` · `stdin=0B` · `queue=0` · `asks=2` · `unavailable=2` |
| `node scripts/poc-limit-codex.mjs`(그 exe) | **8 / 0** — t=90s 발사 · `spawns=1` · `stdin=502B` · `blocked=0` |

### 19.4 계수가 주행 중에 217 → 219로 오른 이유(옆 갈래의 미커밋 변경)

이 워킹트리는 세 갈래가 같이 쓴다. 커밋 직후 확인 주행에서 `ccg-engine`이 **219/0/2**로 나왔다 ——
+2는 **EXTN 갈래가 `crates/ccg-engine/src/codex/versions.rs`에 얹은 미커밋 인라인 테스트 둘**이고
(`git diff`로 확인: `+156/-17` · `#[test]` 2개), 내 커밋에는 그 파일이 없다. **217은 그 변경이
뜨기 전 트리의 값, 219는 뜬 뒤의 값**이다. 둘 다 `failed=0`이고 이 라운드가 만든 못은 그중
`wcap_limit_streak` **9개**다(R3의 7 + ⑧⑨). 재측정하는 사람은 옆 갈래의 미커밋 상태에 따라 이
숫자가 달라진다는 것을 알고 재야 한다 —— `--test wcap_limit_streak`으로 좁히면 **9/0**으로 고정이다.

## 20. 화면 — 판정이 아니라 **눈에 보이는 것**도 고쳐졌다

§19.2의 대조군 스레드 `u TG(2) a! u a!`를 사람 눈으로 읽으면 이렇다: 밤새 자동 재개가 71턴을
돌면 **그 71턴이 연 도구 행이 전부 첫 턴의 도구 그룹에 쌓이고**, 그 아래 「이어서」 말풍선 71개는
**텅 빈 채로** 남는다. R3 크리틱이 「지금은 계수가 안 갈리지만 **화면은 이미 거짓**」이라고 적은
그 자리다(본채팅은 `resumeOwner:"engine"`이라 `turnDidWork`를 아무도 안 읽는다 — `lite.rs:175`).
이 한 줄은 그 거짓과 파리티의 잠재 구멍을 **같이** 없앤다. 「이 턴이 연 도구 그룹」이라는 공통
정의가 이제 **여는 방식에 안 매달린다**.

## 21. 만진 파일(R4)

| 파일 | 무엇 |
|---|---|
| `app/src/store/session.ts` | `user-echo`에 `openGroupId: null` **한 줄** + 근거 주석 |
| `crates/ccg-engine/src/runtime.rs` | 공지 문장의 `turn` → `턴`(문자열 1줄 + 주석) |
| `app/src/components/Chat.tsx` | 배너 문장의 `turn` → `턴`(한국어 쪽만 · 영문은 불변) |
| `crates/ccg-engine/tests/wcap_limit_streak.rs` | `mixed_wall` 손잡이 · 못 ⑧⑨ 신설 · ⑤에 `content_block_stop` |
| `scripts/poc-limit-resume.mjs` | K절 신설(실제 스토어 리듀서 구동 · **27단언** = 249 → 276) · `mountArmed(…, thread)` 손잡이 |
| `app/src/lib/limitResume.ts` | **주석만**(R4 절 + 배너 인용 문구 정정) — 판정 로직 0줄 |
| `docs/parity-fix-wcap-r1.md` | 이 절들 |

**안 건드린 것**: `app/src/lib/useLimitResume.ts`(R2·R3·R4 전부 0줄) · `turnDidWork`/`carriedAttempts`/
`windowRolled`/`arm_hold`의 판정 · 상한 2 · 「이어가기」 · `saw_turn_activity`의 T8/T9 쓰임 ·
`result`의 `openGroupId`(§18.1) · CSS 0줄 · `src-tauri/**` 0줄(EXTN 갈래와 경로 무충돌) ·
`src/renderer/**`(2.6.2 동결본) 0줄. 기준 결과 파일 **0개 덮음**(하네스 산출물은 `--out`으로
`docs/critic/limit-{engine,codex}-wcapr4.json` 새 이름).

## 22. 남는 리스크

* **§14.2의 47발은 여전히 「정의」다.** R3 리스크 그대로 — 매 턴 진짜 산출을 내면서 같은 벽에
  계속 부딪히는 서버가 있으면 빈손이 연달아 둘 오기 전까지 안 접힌다(12시간 42~71발).
  파리티는 안 깨져 있다. R4가 그 축을 **⑧⑨로 두 개 더 덮었을 뿐** 구조는 안 바꿨다.
* **`turnDidWork`를 읽는 표면이 늘어나면** §19.2의 A/B를 다시 돌려야 한다. 지금 본채팅은
  엔진이 표를 들어 그 함수를 안 읽고(`managed`), 멀티 패널·팝아웃·추가 창은 자기 `send`로 쏘므로
  늘 `begin`이다 —— **R4 뒤로는 그 규약이 깨져도 답이 안 바뀐다**는 것이 이 라운드의 산출이다.
* **부팅 재장전 비대칭**(엔진 `reload_state`의 `attempts:0` ↔ 렌더러 `sanitizeHold`)은 R28c부터의
  것이고 이 변경과 무관하다.
* **`rate_limit_event` 경로**·**한도 문구가 어시스턴트 텍스트로 오는 판**은 R2·R3 기록 그대로.
* **라이브 앱 주행 없음**(창 하나가 5시간). 다만 이번엔 릴리즈 exe로 `poc-limit-engine`·
  `poc-limit-codex`를 직접 돌렸다. 실계정 토큰 0건 · 실 HTTP 0건(`CCG_NO_NET=1`) ·
  이름 기반 kill 0건 · 격리 `CARGO_TARGET_DIR=target-wcapr4`(+`…r4b` 반복 · `…r4c` 대조군) ·
  CDP 9425·9437은 주행 전 `netstat`로 비어 있음 확인.
