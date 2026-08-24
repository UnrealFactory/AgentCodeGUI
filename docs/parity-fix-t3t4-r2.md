# 최종 파리티 R1 후속 — T3T4 갈래 **R2** (확인 크리틱 수정 라운드)

> **후속**: 확인 크리틱 R2는 6항 중 4항 통과 · 2항 부분으로 판정했다. 수정과 재실측은
> `docs/parity-fix-t3t4-r3.md`. 두 자리가 틀렸다 — ① §1의 *"훅이 살아나면 오판이
> 사라진다"*는 **본채팅에 안 걸린다**(`resumeOwner:"engine"`이라 그 훅이 안 돈다).
> ② §4의 `git:ai-message` 미룬 근거는 절반이 틀렸다(`--max-turns`는 숨은 **argv 플래그**이고
> `allowedTools: []`는 와이어에서 아무 일도 안 한다 — SDK 본체 인용은 R3 §3).
> 아래 본문은 당시 기록 그대로 둔다.

빌더: T3T4 · 2026-08-24 · `feature/3.0.0-beta`
앞 라운드: `docs/parity-fix-t3t4-r1.md` · 판정: 확인 크리틱 R1(**불합격** — 실패 2 · 부분 1 · [부분] 3)

| 커밋 | 무엇 |
|---|---|
| `5863055` | 실패1(조회 실패=풀림 오판) · 실패2(창 경계) · 실패3(하네스 경합) · [부분] 3건 |

실측 산출물(전부 **새 파일** — 기준 파일은 덮지 않았다):
`docs/critic/parity-t3t4-r2.json` · `docs/critic/limit-blind-t3t4-r1.json`

빌드: `cargo build --release --features custom-protocol` → 1분 27초 ·
`target-t3t4/release/agentcodegui.exe` **6,356,992바이트**(2026-08-24 18:59) ·
`app/dist`는 그 앞에 `npm run app:build`로 새로 떴다(심·훅 변경이 내장 자산에 들어가야 한다).

---

## 0. 한 문단 결론

크리틱이 지목한 **실패 2건과 부분 1건을 전부 고쳤고, 그 판정을 낸 실측을 같은 방식으로
다시 냈다**. 최대 격차였던 「조회 실패 = 풀림」은 판정을 둘에서 **셋**(막혔다 / 풀렸다 /
**못 물어봤다**)으로 늘려 없앴다 — 셸이 실패에 표식을 붙이고, 훅이 그때는 **유지**한다.
증거는 두 겹이다: 실 exe가 `CCG_NO_NET=1`에서 실제로 내는 값(14/14)과, **그 값을 실제
훅에 그대로 먹여 세 표면의 착지를 확인한 것**(141/0 — 하네스가 훅 소스를 직접 구동한다).
새 회귀였던 `shortcut:close`의 창 누수는 원인이 심의 전역 `listen()`이었고, 대상 필터를
살리면서 **브로드캐스트가 죽지 않는지**까지 같은 절에서 잰다. 남긴 것은 여전히 둘
(`git:ai-message` · `app:open-directory`)인데, 이번에는 **왜 못 하는지의 근거를 실측으로**
바꿔 뒀다(§4).

---

## 1. 실패1 — 「조회 실패 = 풀림」 오판 (최대 격차)

### 1.1 크리틱이 잡은 것

> 계정을 실은 격리 홈 + `CCG_NO_NET=1`(토큰은 나오는데 send가 죽는 판)에서 `usage:get`이
> `{fiveHour:null, weekly:null, weeklyFable:null, extraCredit:null}`을 돌려주고, 그 값을
> 훅이 실제로 부르는 `blockedResetsAt`에 먹이니 null → `fire()`의 착지는 ready=true(자동 전송).
> 상한이 있는 엔진 경로는 `managed`를 넘기는 본채팅(App.tsx:604)에만 붙어 있어
> 멀티·추가 채팅·팝아웃 3표면은 무방비.

R1의 이 자리는 내 판단 착오였다. 나는 "Rust가 실값을 흘리면 판정이 되살아난다"고 적었는데,
**되살아나는 것은 조회가 성공할 때뿐**이다. 실패는 값의 모양이 「한도 없음」과 같아서
그대로 자동 전송으로 착지한다 — 안전장치가 아니라 **눈감고 쏘는 재전송기**다.

### 1.2 무엇을 고쳤나 — 판정을 셋으로

크리틱이 준 세 선택지 중 **(a) + (b)** 를 함께 넣었다. (c)(세 표면에 `managed` 배선)는
안 골랐다: `managed`의 원천은 `chat:status.hold`이고 그건 **채팅 단위 엔진 대기표**라
멀티 패널 슬롯·팝아웃에는 아직 그 대응물이 없다. 없는 신호를 배선하면 세 화면이 조용히
"엔진이 들고 있다"고 믿고 손을 떼는 쪽이 된다 — 그게 더 나쁜 사고다.

| 층 | 조각 | 내용 |
|---|---|---|
| Rust | `ipc/parity/usage.rs` | 실패에 **표식**을 얹는다. 값의 모양(창 넷 `null`)은 2.6.2 그대로 |
| 계약면 | `src/shared/protocol.ts` `UsageInfo` | `unavailable?` · `stale?` (둘 다 선택 — 2.6.2 본체는 안 낸다) |
| 렌더러(순수) | `app/src/lib/limitResume.ts` | `usageUnavailable` · `codexUsageUnavailable` · `resumeVerdict` · `recheckDelayMs` · `holdDelayMs` · `MAX_AUTO_ATTEMPTS` · `LimitHold.probes` |
| 렌더러(배선) | `app/src/lib/useLimitResume.ts` | `fire()`가 위 판정을 부른다. 조회가 **던져도** 실패로 읽는다 |
| 렌더러(표시) | `app/src/components/Chat.tsx` | 카운트다운이 `resumeDelayMs` → `holdDelayMs`(타이머와 배너가 같은 함수를 본다) |

**표식의 규약**(Rust):

| 상황 | 값 | 표식 |
|---|---|---|
| 계정 없음 · 토큰 없음(미등록·재로그인 필요·`CCG_NO_NET`) | 창 넷 `null` | `unavailable:true` |
| 전송 실패·비200이고 **캐시가 있다** | 마지막 성공값 | `stale:true` |
| 전송 실패·비200이고 캐시도 없다 | 창 넷 `null` | `unavailable:true` |
| 정상 | 실값 | 없음 |

`auth:accounts-usage`의 행도 같은 규약이다(행은 목록에서 **사라지지 않는다** — 여섯 필드가
전부 `null`인 행이 "한도 0"으로 읽히면 「한도 적게 남은순」이 죽은 계정을 맨 위에 올린다).

**표식이 없어도 안전하다.** `usageUnavailable`의 둘째 규칙이 "창이 하나도 없다"이기 때문이다
— 옛 셸·2.6.2 본체에서도 같은 착지다(하네스 G절이 표식 없는 R1 값으로 따로 잰다).

**그래도 쏘는 자리 하나**: 조회 실패가 상한(`MAX_AUTO_ATTEMPTS = 2` — `ccg-engine`의
`limit.rs`와 같은 값)을 넘겼고 **문구가 알려 준 리셋 시각이 이미 지났을 때**만 한 번.
시각을 모르면(배너형 문구) 영원히 안 쏜다 — 근거가 하나도 없는데 쏘는 것이 이 사고였다.
재확인 간격은 15초 → 배증 → 10분(`PROBE_MS`)에서 멎는다.

### 1.3 실측 ①: 실 exe가 그 판에서 무엇을 내나 (`scripts/poc-limit-blind.mjs` — 신설)

크리틱과 **같은 판**을 만든다. 다른 점 하나: 계정이 **합성**이다(만료 1시간 남은 가짜
액세스 토큰) — `CCG_NO_NET=1`이라 HTTP가 한 번도 안 나가므로 판정에 필요한 성질
("토큰은 나오는데 send가 죽는다")이 그대로 서고, **실계정 자격은 한 줄도 안 읽는다**.

```
B1  창 넷의 모양은 2.6.2 그대로(전부 null)                  ✓
B2 ★조회 실패에 「못 물어봤다」 표식                        ✓ {…, unavailable:true}
B3  계정 인자 없이 · B4 없는 계정도 같다                    ✓
B5  캐시가 없으니 stale은 아니다                            ✓
B6  그 값을 **옛 판정**(blockedResetsAt)에 먹이면 null      ✓ (= R1 오판의 조건을 재현)
B7 ★같은 값을 새 판정에 → 못 물어봤다                       ✓
B8 ★재검증 착지 = 유지(자동 전송 없음)                      ✓ hold{probes:1}
B9  두 번째 재검증도 유지                                   ✓ hold{probes:2}
B10~B12 auth:accounts-usage — 행은 남고 표식이 붙는다        ✓
B13 ★추가 채팅 창에서도 같은 값 · B14 같은 착지             ✓
                                              → 14 통과 / 0 실패
```

### 1.4 실측 ②: **실제 훅**이 어디로 착지하나 (`scripts/poc-limit-resume.mjs` — 39 → 141)

크리틱은 순수 함수(`limitResume.ts`)만 구동하고 훅의 착지는 코드로 읽었다. 이번에는
**훅 소스를 그대로 돌린다**: 최소 훅 런타임(`useState`/`useRef`/`useEffect`를 esbuild
alias로 `react` 자리에 꽂는다) + 가짜 `window.api` + 가짜 시계. 그리고 **세 표면이 실제로
넘기는 props**(본채팅 `holdKey=chatId`·`canSend`·`managed` / 멀티 패널 `holdKey=slot-0` /
추가 채팅 `holdKey=''`)로 각각 같은 대본을 돌린다.

| 시나리오 | 착지(세 표면 전부 동일) |
|---|---|
| ★조회 실패 1회차 | **유지** · `probes:1` · 전송 0 · 다음 재확인 15초 |
| ★조회 실패 2회차 | **유지** · `probes:2` · 전송 0 |
| 상한 초과 + 리셋 시각이 이미 지남 | 눈감고 한 번(전송 1) — 2.6.2의 동작, 이제 **상한 안에서만** |
| ★시각 미상 + 조회 실패 5회 | **유지** · 전송 0 (영원히 안 쏜다) |
| ★표식 없는 R1 실패값 | **유지** · 전송 0 (표식에만 기대지 않는다) |
| ★조회가 던짐 | **유지** · 전송 0 |
| 실값(아직 막힘) | 그 시각으로 재장전 · `probes:0` |
| 실값(풀림) | 이어서 전송 1회(문구 = '이어서') |
| `managed` | 장전 자체를 안 한다(재개 주체 하나) |

A~E절은 **2.6.2 동결본과 3.0 이식본 두 사본에 똑같이** 먹인다 — 이번 분기가 기존 판정에
손대지 않은 **덧붙이기**임을 회귀로 못 박는다. 실패값은 하네스가 지어낸 모양이 아니라
`poc-limit-blind`가 실 exe에서 읽어 남긴 `docs/critic/limit-blind-t3t4-r1.json`을 읽어 쓴다.

> **결과 141 통과 / 0 실패** (R1의 39/0에서 늘어난 것은 두 사본 × A~E + F절 22 + G절 63).

### 1.5 대조군 — 기능은 죽지 않았다

실 HTTP 주행(`poc-parity-t3t4` T3): `usage:get(fresh)` = `weekly{pct:100, resetsAt:1787752799}`
· `weeklyFable{pct:33}` · `fiveHour{pct:0}` · 계정 5/5 실값(남은 % = 0·50·91·0·63) ·
첫 조회 334ms → 캐시 3ms. 즉 **막혔다/풀렸다 판정은 그대로고, 못 물어본 판만 갈렸다.**

---

## 2. 실패2 — `shortcut:close`가 창 경계를 안 지키던 자리 (새 회귀)

### 2.1 원인은 심의 전역 `listen()`이었다

Tauri는 대상이 `Any`인 리스너를 **필터보다 먼저** 통과시킨다:

```rust
// tauri/src/event/listener.rs
fn match_any_or_filter(target, filter) -> bool {
    *target == EventTarget::Any || filter.map(|f| f(target)).unwrap_or(true)
}
```

심의 `subscribe()`는 `listen(channel, cb)`를 그대로 썼고, 그 기본 대상이 `{kind:'Any'}`다.
즉 셸이 `emit_to(창, …)`로 **한 창에만** 보낸 이벤트가 **모든 창에 도착했다**.
`FileModal.tsx:2998`이 이 채널로 뷰어를 닫으므로 **다른 창의 Ctrl+W가 이 창에 열린 파일
뷰어를 닫는다** — `ipc/parity/misc.rs:54`의 주석이 "그러면 안 된다"고 적은 바로 그 사고다.
같은 병이 두 군데 더 있었다: `win:state`(남의 최대화가 내 타이틀바 아이콘을 뒤집는다) ·
`session-wins:flush-request`(한 창을 닫으면 전 창이 저장한다).

### 2.2 고친 것 — 그리고 **함께 고쳐야 했던 셸 한 줄**

- `app/src/api/shim.ts` — 구독을 **현재 창 라벨**로 등록한다(`{target: label}` → `AnyLabel`).
  라벨을 못 읽으면 옛 동작(전역)으로 떨어진다(이벤트를 통째로 잃는 것보다 낫다).
- `src-tauri/src/win.rs broadcast_sessions` — `emit_to(MAIN)` → **`app.emit`**.
  2.6.2 `broadcastSessionWins`는 `getAllWindows()`를 돌며 *"팝아웃 창도 자기 panelId의 btw
  알약을 그리므로 목록 변화를 같이 받아야 한다"* 고 적어 뒀는데, 3.0은 메인에만 쐈고
  **위 버그 덕분에 우연히** 전 창에 닿고 있었다. 필터를 살리는 순간 그 줄이 팝아웃·추가
  채팅 창의 알약을 죽인다. (크리틱이 T4에서 "팝아웃 창도 목록 수신 2/2"로 통과시킨 그
  성질이 실은 이 버그에 얹혀 있었다.)

`emit_to`를 쓰는 나머지 자리는 전수로 확인했다 — 전부 **그 창이 받아야 하는 것**이거나
(창별 상태·세션 이벤트·닫기 flush·트레이/토스트), 이미 `app.emit` 브로드캐스트다
(`ma:event`·`chat:status`·`chat:windows`·유리·언어·LSP·엔진 업데이트).

### 2.3 실측 (`poc-parity-t3t4` M1 — 3회 반복 동일)

```
M1-1 Ctrl+W가 렌더러까지 왕복한다               main 1 · other 0
M1-2 ★메인의 Ctrl+W가 다른 창을 건드리지 않는다  other 0   (크리틱: other 1)
M1-3 ★반대 방향도 창 경계를 지킨다              other 1 · main 그대로
M1-4  목록 브로드캐스트는 여전히 **전 창**       main 0→2 · other 0→2
```

---

## 3. 실패3 — 「37/0」 재현 불가 (검사의 거짓 실패)

크리틱의 진단이 정확하다. H5-2의 증거가 `session.persist({title:'FLUSH-OK'})`였는데,
그건 **컴포넌트 자신의 persist와 같은 그릇**이다(`SessionWindow.tsx:351`이 같은 요청에
자기 스냅샷을 저장한다) — 마지막에 쓴 쪽이 이긴다.

경합 없는 그릇으로 바꿨다: flush 핸들러가 `fs:write-file`로 스크래치 폴더에 마커를 쓰고,
창이 죽은 뒤 하네스가 **디스크에서** 확인한다. 대신 "그 대화가 닫힌 뒤에도 목록에 남는가"를
`H5-2b`로 따로 세웠다(persist 자체의 소실 여부는 여기서 본다).

`--no-live --only=h5` **5회 연속 5/5**(크리틱은 4회 중 1회). 덤으로 하네스에 `--out=`을
넣었다 — 기준 결과 파일(`parity-t3t4-r1.json`)을 덮지 않는다(병렬 규율 6).

---

## 4. [부분] 4건

### 4.1 429 백오프가 **헤더**를 읽는다 (고침)

`HttpResponse`에 헤더 자리가 없어서 `Retry-After`를 볼 수가 없었고, 대신 본문의
`retry_after`를 봤다 — 그 필드가 없는 실제 429에서는 **언제나 기본값 15초**였다.

- `crates/ccg-auth/src/net.rs` — `HttpResponse.headers` + `header(name)`(대소문자 무시).
  ureq 응답에서 **헤더를 먼저** 뜬다(본문을 읽으면 응답이 소비된다). 429는 ureq의
  `Err(Status)` 팔로 오므로 그쪽도 같은 경로로 만든다(여기서 버리면 헤더가 사라진다).
- 우선순위는 2.6.2와 같다: 헤더 → 본문 → 기본값 15초, 상한 30초. `parseInt` 규약까지
  맞췄다(`"3.9"`→3 · HTTP-date는 못 읽으므로 기본값).

### 4.2 401/403 재시도 (고침)

2.6.2 `auth.ts:549`의 `freshAccountToken(email, true)` 자리다 — 시간상 유효해 보여도
서버가 무효화한 토큰(다른 프로세스의 그랜트 회전)을 거르는 유일한 길.
`net::force_refresh(email, stale)`는 레인 안에서 **"앞 주자가 이미 새 토큰을 받아 놨나"**
를 먼저 보고(이중 회전 금지), 교환 뒤 토큰이 그대로면 재시도하지 않는다.

### 4.3 테스트가 0건이던 두 규약 (고침)

- **전역 1200ms 게이트가 실제로 간격을 벌리는가** — 상수만 대조하는 검사는 게이트를
  통째로 걷어내도 초록이다. `throttle()`을 세 번 불러 실제 경과를 잰다.
- **2분 디스크 TTL** — `CCG_NO_NET=1`로 가른다: 캐시가 신선하면 **조회 없이** 숫자가
  나오고(HTTP가 불가능한 판인데 값이 있다 = 캐시를 썼다), 만료되면 조회가 실패해
  `stale` 표식이 붙은 낡은 값으로 떨어지며, 캐시가 아예 없으면 `unavailable`이다.

### 4.4 남긴 것 둘 — 이번에는 **근거를 실측으로**

| # | 무엇 | 왜 아직 |
|---|---|---|
| M5 | `git:ai-message` | 2.6.2는 SDK `query()`에 `{maxTurns:1, allowedTools:[]}`를 줘 "도구 없는 순수 1턴"을 만든다. **그 둘은 argv 플래그가 아니다**: 설치본 `claude.exe 0.3.241`의 `--help`에 `turns`는 **0회** 등장하고(=`--max-turns` 없음), 도구 쪽은 `--allowedTools`(허용 목록)뿐이라 *빈 목록*을 표현할 수단이 없다. SDK는 그 값들을 **stream-json 제어 요청**(`initialize`)으로 넘긴다 → 파리티 있는 이식은 별도 스폰이 아니라 **지금의 드라이버**(`ccg_engine::driver`)를 타야 한다. `-p`로 흉내 내면 "도구 없는 1턴" 계약이 조용히 깨진 채 커밋 카드에서만 드러난다 |
| M2 후반 | `app:open-directory` | 이 채널은 **셸→렌더러 이벤트**다(심은 `subscribe`만 한다) — `ipc_call`로 부를 채널이 아니므로 `__unimplemented` 응답은 미구현의 증거가 아니다. 진짜 빠진 것은 **방출자**이고, 그 유일한 발원지는 단일 인스턴스 잠금의 second-instance다. 3.0에는 그 잠금이 **아예 없고**(전수 확인), 넣는 순간 격리 홈으로 여러 벌 띄우는 세 갈래의 하네스가 전부 죽는다. 설치기가 컨텍스트 메뉴를 등록하는 라운드(M12)와 함께 결정할 일 |

---

## 5. 실측 요약

| 항목 | R1 | **R2** |
|---|---|---|
| `poc-parity-t3t4.mjs`(격리 홈 + 실 HTTP) | 37/0(재현 36/1) | **41 / 0** |
| `poc-parity-t3t4.mjs --no-live --only=h5` × 5 | 4회 중 1회 통과 | **5 / 5** |
| `poc-limit-blind.mjs`(실 exe + `CCG_NO_NET`) | — | **14 / 0** |
| `poc-limit-resume.mjs` | 39 / 0 | **141 / 0** |
| `poc-btw-fork.mjs` | 33 / 0 | 33 / 0 |
| `poc-mcpskill.mjs` | 전부 통과 | 전부 통과 |
| `cargo test --bin agentcodegui` | 98 / 0(parity 19) | **107 / 0**(parity **22**) |
| `cargo test -p ccg-auth --features net` | 97 / 0 | **88 유닛 + 25 통합 / 0** |
| `cargo test -p ccg-store` | 76 / 0 | 76 / 0 |
| `cargo test -p ccg-engine` | 129 / 0 | **197 / 0**(2 ignored, 13 바이너리) |
| `npm run typecheck` + `typecheck:app` | 초록 | 초록 |

> `ccg-engine`·`ccg-store`는 세 갈래가 함께 늘리는 크레이트라 수치는 **이 시점의 트리** 기준이다.

## 6. 병렬 규율 — 이 라운드에 지킨 것

- **동결 구역 0파일**(`src/main`·`src/preload`·`src/renderer`·`out/`·`dist/`).
  `src/renderer/src/lib/limitResume.ts`는 하네스가 **읽기만** 한다(두 사본 대조).
- 남의 미커밋 변경을 `reset`·`checkout`·`stash` 하지 않았다. `git add -A`도 안 썼다 —
  스테이징은 내 경계 경로만이고, 공유 파일 `src/shared/protocol.ts`는 **내 hunk 하나**뿐임을
  `git diff`로 확인하고 넣었다.
- 기준 결과 파일을 덮지 않았다. 주행 중 한 번 `parity-t3t4-r1.json`에 썼고 **즉시
  `git checkout`으로 복원**한 뒤 하네스에 `--out=`을 넣어 재발을 막았다.
- 이름 기반 kill 0회(스폰한 PID 트리만) · 네이티브 대화상자도 그 PID의 `#32770`에만 `WM_CLOSE`.
- **실계정 토큰 회전 0회.** 새 하네스(`poc-limit-blind`)는 **합성 계정**만 쓰고
  `CCG_NO_NET=1`로 돈다. 실 HTTP는 `poc-parity-t3t4`의 usage GET뿐이고, 그쪽은 여전히
  액세스 토큰이 20분 이상 남은 계정만 싣는다.
- 격리: `CCG_HOME=.poc-home-t3t4`(파리티) · `.poc-home-blind-t3t4`(신설) ·
  CDP 포트 9421 / **9423** · `CARGO_TARGET_DIR=target-t3t4`.
