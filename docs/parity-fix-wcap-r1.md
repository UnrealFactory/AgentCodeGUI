# R28d 「WCAP」 R1 — 상한이 「헛발질」과 「제대로 일한 재개」를 가른다

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
