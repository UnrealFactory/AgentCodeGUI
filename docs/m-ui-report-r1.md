# M-UI R1 — 알림 7종을 실렌더러에 (`app/src`)

> 스펙: `docs/design/ui-notify.md` · 목업: `docs/design/mockups/ui-notify-*.html`
> (크리틱 블라인드 8승 0패 · `docs/critic/mui-r1.md` · `mui-r1-contrast.md`)
> 이 문서는 **적용 보고서**다 — 판정은 다음 크리틱이 한다. 여기엔 무엇을 어떻게 심었는지,
> 실물에서 잰 값, 그리고 아직 안 된 것만 적는다.

사용자 기준: **정보 밀도 손실 금지 · 블라인드에서 이겨야 한다.**

---

## 0. 한 줄 결론

목업이 주장한 밀도 이득(−11.7~12.5%)이 **실렌더러에서도 성립한다: 902.5px → 783.2px
(−119.3px · −13.2%)**. 알림이 없는 화면 8종은 **0픽셀**(임계 1, 최대 채널차 0). 게이트
넷 전부 PASS. 대신 게이트 계약 2건을 **바꿨고**(아래 §6) 남은 조각 5개가 있다(§7).

---

## 1. 무엇을 심었나

### 1.1 토큰 — `app/src/styles.css` `:root`

`--ntf-*` **11개만** 새로 정의했다. 기존 토큰(`--radius`·`--text-*`·`--*-soft`·
`--shadow-sm`·`--font-mono`…)은 **하나도 재정의하지 않는다** — 덮으면 알림 밖 화면의
픽셀이 따라 움직인다(이번 라운드의 파리티 계약이 바로 그것이다).

```
--ntf-pad-y:11px   (현행 12 — 줄인 방향)   --ntf-pad-x:14px  (현행 15)
--ntf-radius:12px  (현행 14 → --radius와 한 값)  --ntf-gap:10px
--ntf-ic:15px      (글리프 칸 — 현행 15/9/14 → 하나로)
--ntf-tile:30px    (카드 타일 — 현행 32)   --ntf-title:13.5px
--ntf-body:13px    --ntf-meta:11px  --ntf-lh:1.6  --ntf-ease:cubic-bezier(.2,.8,.2,1)
```

**충돌 규약(반드시 읽을 것).** 목업의 짧은 클래스는 실앱에 **이미 있다**:

| 목업 이름 | `styles.css`의 기존 용례 수 | 실앱에 심은 이름 |
|---|---|---|
| `.act` | 2 | `.ntf-act` |
| `.num` | 1 | `.ntf-num` |
| `.tx` | 4 | `.ntf-tx` |
| `.ti` | 3 | `.ntf-ti` |
| `.spin` | 6 | `.ntf-spin` |
| `.qa` | 6 | `.ntf-qa` |
| `.band` `.card` `.rule` `.tray` `.raw` `.hair` `.lb` `.tm` `.bd` `.g` `.tile` `.bg` `.sb` | 0 (오늘은 안 겹침) | `ntf-` 접두 **일괄** |

0건인 이름까지 접두를 붙인 이유: 4277줄짜리 공유 스타일시트에서 `.card`·`.rule`은
**다음 라운드에 누군가 쓰기 딱 좋은 이름**이다. 픽셀은 목업과 같고 이름만 다르다.
색조 변수도 `--ntf-fg / --ntf-key / --ntf-face / --ntf-edge`다 — 색조 클래스가
자손에 값을 흘리는 구조라(캐스케이드) 짧은 이름이면 알림 안에 들어온 남의 컴포넌트가
오염된다.

**목업을 안 따른 두 값(의도):** 목업 로컬 `--shadow-sm`(`0 2px 8px -2px`)과
`--font-mono`(Consolas 스택)는 **채택하지 않았다.** 실앱 값(`0 1px 2px rgba(0,0,0,.45)` /
JetBrains+Wanted Sans)이 2.6.2 원본이고 `.cmd-card`가 이미 그 값이다. 알림만 다른
그림자를 쓰면 카드 계열이 두 벌로 갈린다. 목업 CSS 쪽 전사 오류로 본다.

**AA 수정치 3건은 그대로 심었다**(`mui-r1-contrast.md` R2):

| 자리 | 전 | 후 | 실앱 셀렉터 |
|---|---|---|---|
| rule의 수치(11px 모노) | `--text-3` (3.83) | **`--text-2` (7.5)** | `.ntf-rule .ntf-num` |
| 오류 원문 면(11.5px 모노) | `--text-3` (3.68) | **`--text-2` (6.9)** | `.ntf-band .ntf-raw` |
| rule의 시각(11px) | `--text-4` (2.29) | `--text-3` (3.83 · 3:1 통과) | `.ntf-rule .ntf-tm` |

`card`의 시각은 **일부러 `--text-4`로 뒀다** — 2.6.2에서 물려받은 자리라 파리티가
걸려 있다. `rule`은 시각을 **새로 넣은** 자리라 파리티 논거가 없어서 올렸다.

### 1.2 형태 3 × 색조 4

```
.ntf-rule            대화의 구조 — "앞뒤를 가르나?"        면 없음 · 15px
.ntf-rule.ntf-split  경계형(양쪽으로 선) = 여기서 갈렸다
.ntf-band            네 개입이 필요할 수 있다               면 + 트레이 · 47px(1줄)
.ntf-card            무엇이 만들어졌나                      면 + 그림자
.ntf-card.ntf-bare   face=off — 상태가 안 변하는 기록
.ntf-t-neutral / -notice / -danger / -positive   ← 색조는 심각도만 칠한다
```

`rule`에 `min-height`를 박지 않았다(목업 자가 계측이 20px 하한에서 +1.3px '밀도 손실'을
잡아낸 자리). 스레드 owl은 형태 단위로 승격했다:
`.thread > * + .ntf-rule{10px}` · `.thread > .ntf-rule + *{10px}`
(2.6.2의 `.thread > * + .stopline{10px}` 한 줄이 두 줄이 된 것 — 경계형 rule의 **아래쪽**도
붙어야 "가른다"가 보인다).

### 1.3 7종 적용 — 무엇이 어떻게 바뀌었나

| # | 종 | 2.6.2 | 3.0 (심은 것) |
|---|---|---|---|
| 1 | 모델 자동 전환 | `.notice-row` **재사용**(과금 안내와 같은 무게) | `ThreadItem.kind:'fallback'` 전용 항목 · `band·notice` · **`[되돌리기]`** |
| 2 | 안내 | `.notice-row`, 무조건 노랑 | `band` · `tone`(notice\|neutral) · `action`(과금 끄기) |
| 3 | 오류 | `.error-row` + 빨간 '오류' 제목 줄 | `band·danger` · 제목 줄 제거 · **모노 원문 면**(8줄 초과 접기) · `[복사]` |
| 4 | 중단 | `.stopline` (선+글자만) | `rule` 종결형 · **지속시간·도구 수·시각**(높이 불변) |
| 5 | 압축 경계 | `.cmd-card`(auto) — 카드 | `ThreadItem.kind:'boundary'` · `rule` 경계형 |
| 6 | 명령 | `.cmd-card` | `card` · 치수 통일 · 수치를 부제 줄에 `·`로 합침 |
| 7 | 문답 | `.qa` (맨몸) | `card.bare` · 왼쪽 15px 마커 칸 · 시각 · 답 15.5→14.5px |

**#1의 세부(요구사항이었던 것):**

- **되돌리기 유지 + 개선.** 되돌릴 지점을 이제 **엔진이 준 값**으로 잡는다. 셸은
  `model-fallback`에 `via`·`revertTo`를 이미 싣고 있는데(`src-tauri/src/engine/hub.rs:885`)
  계약면 타입(`src/shared/protocol.ts`)에 없어 아무도 안 읽고 있었다. 리듀서가 **좁은
  캐스트로 읽기만** 한다(계약면 무수정 — 경계 밖). 값이 없으면 버튼을 **안 그린다**.
  (기존 `IdentityBand`는 `revision - 1`로 **추정**했다 — 이제 그건 폴백 경로다.)
- **cause 문장 3종.** 형태는 하나, 문장은 셋. 갈리는 낱말을 하나씩 박았다 —
  `dialog`="**동의하셨어요**" · `refusal_frame`="엔진이 **묻지 않고**" ·
  `model_delta`="**사유는 오지 않았고**, 전환만 대화에 반영했습니다".
  `cause`가 없으면(옛 스냅샷·다른 엔진) 엔진이 준 완성 문장을 그대로 쓴다 — 지어내지 않는다.
- **한 턴 2배너.** `fallback_arms`가 벡터라 배너도 여러 개다. 항목이 **이벤트 1:1**이므로
  구조적으로 지원된다(각자 자기 `revertTo`를 들고, 두 번째 배너의 `from`은 엔진이 주는
  직전 도착값이다). 사이에 아무것도 끼우지 않으므로 owl 18px 그대로 연속으로 선다.
- **중복 금지.** 엔진은 전환 1회에 `chat:identity(engine_fallback)`과 `model-fallback`을
  **함께** 낸다(`runtime.rs::fallback_signal` — `apply_identity` + `Event::FallbackBanner`가
  한 문 안에). 스레드 band가 되돌리기까지 들었으므로, 컴포저 위 `IdentityBand`는 같은
  사건이면 **비운다**(`App.tsx` — 배너의 `revertTo === 리비전-1`이면 같은 사건).
  드리프트(`deferred_apply`)는 스레드에 대응 이벤트가 없으므로 계속 상태줄이 맡는다.
  그 상태줄도 문법은 `.ntf-band`로 갈아탔다(같은 자리, 같은 문법).

**#3의 세부:** 요약을 **지어내지 않는다.** 첫 줄을 요약으로 세우고 나머지를 원문 면에
넣을 뿐이다. 한 줄짜리 오류엔 면을 주지 않는다(늘린 픽셀마다 정보가 있어야 한다).
그 결과 실측에서 오류는 목업 예상(+19.1px)과 달리 **−11px**이 됐다 — 제목 줄이 빠진
만큼을 원문 면이 다 먹지 않았다.

**#6의 새 규약(중복 금지):** `pendingCommand`가 살아 있는 턴의 `error`는 **카드만**
말한다. 오류 band를 따로 만들지 않는다(`session.ts` `case 'error'`).

### 1.4 수정 파일 6 (전부 `app/src/`)

| 파일 | 무엇 |
|---|---|
| `styles.css` | `--ntf-*` 토큰 · 3형태 × 4색조. `.notice-row`·`.error-row`·`.stopline`·`.cmd-card*`·`.qa*` 블록은 **대체**(삭제 후 신설) |
| `store/session.ts` | `fallback`·`boundary` 항목 신설 · `notice.tone/action` · `interrupted.ms/tools/time` · `qa.time` · `state.turnAt` · `fallbackCause()`·`noticeTone()`·`interruptStats()` · error 중복 금지 |
| `components/Chat.tsx` | `MessageView` 7분기 · `FallbackBand`·`ErrorBand` 신설 · `CmdResultCard`·`IdentityBand` 새 문법 · `NotifyAction` 타입 |
| `App.tsx` | `onNotifyAction`(revert · billing-off) 배선 · `IdentityBand` 중복 억제 |
| `components/MultiAgent.tsx` · `components/SessionWindow.tsx` | `onNotify` 배선(각 표면이 소유한 것만) |

**훅 클래스 2개는 스타일 없이 남겼다** — `.cmd-card`·`.cmd-card-title`. 파리티 저울
(`bench/screens.mjs:959·963`)이 두 앱을 **같은 셀렉터**로 밟기 때문이다. 한쪽만 이름을
갈면 그 화면은 3.0에서 캡처 자체가 안 되고, 비교가 성립하지 않는다.

---

## 2. 밀도 자가 계측 — 목업의 계측기를 실렌더러에

목업의 `ui-notify.js`는 렌더 후 실제 높이를 재서 "밀도 손실"을 목업 안에 찍는다.
같은 것을 **실앱**에 얹었다: 목업 시트 0과 **같은 사건 열**을 스냅샷으로 심고,
같은 픽스처 홈·같은 창(1440×900)으로 부팅해 `.thread`와 그 자식들의 실제 렌더 높이를
CDP로 잰다. A는 2.6.2 항목 모양, B는 3.0 항목 모양 — **같은 사건, 다른 문법**이다.

측정 대상 3개(같은 사건 열):

| | 앱 | 렌더러 | 스레드 높이 |
|---|---|---|---|
| A₁ | Electron 2.6.2 | `src/renderer` 원본 | **902.5px** |
| A₂ | Tauri 3.0 (M-UI 직전 빌드) | `app/src` 이식본 | **902.5px** |
| B | Tauri 3.0 (M-UI 적용) | `app/src` | **783.2px** |

A₁ = A₂라는 점이 이식 파리티를 한 번 더 확인해 준다(폭이 같으면 높이도 같다).

**판정: B − A = −119.3px (−13.2%).** 목업 주장(−114.7px · −12.5%)보다 **더 줄었다.**

### 항목별 (px, 여백 제외)

| 항목 | A (2.6.2) | B (3.0) | 차 | owl A/B |
|---|---|---|---|---|
| user 말풍선 | 48.8 | 48.8 | 0 | 0/0 |
| 안내(API 과금) | 46.8 | 47.0 | **+0.2** | 18/18 |
| 문답 | 40.0 | 38.0 | −2.0 | 18/18 |
| 도구 로그 | 82.0 | 82.0 | 0 | 18/18 |
| 모델 자동 전환 | 46.8 | 47.0 | **+0.2** | 18/18 |
| AI 답변 | 26.7 | 26.7 | 0 | 18/18 |
| **중단** | 15.0 | 15.0 | **0** | 10/10 |
| user 말풍선 | 48.8 | 48.8 | 0 | 18/**10** |
| **압축 경계** | 93.8 | **15.0** | **−78.8** | 18/**10** |
| 명령 카드(실패) | 73.8 | 69.8 | −4.0 | 18/**10** |
| **오류** | 127.2 | **116.2** | **−11.0** | 18/18 |
| 작업함 | 15.0 | 15.0 | 0 | 10/10 |
| **합(여백 포함)** | **846.7** | **727.3** | **−119.4** | |

정직하게:

- **+0.2px 두 자리(안내·모델 전환)는 동률이다.** 패딩을 12→11px로 줄여 번 것을,
  **테두리를 실제로 보이게 만든 것**(face와 다른 edge)이 도로 먹었다. 여기서 얻은 것은
  높이가 아니라 **기능**이다 — 같은 줄에 `[과금 끄기]`·`[되돌리기]`가 들어왔다.
- **중단은 정확히 0px**인데 지속시간(42초)·도구 수(3)·시각을 얻었다. 목업이 말한
  "빈 오른쪽 끝을 쓴다"가 실물에서 그대로 성립한다.
- **압축 경계 −78.8px**가 이득의 3분의 2다(여백까지 −86.8px). 수치는 하나도 안 버렸다.
- **오류는 목업 예상과 반대로 −11px.** §1.3에 이유를 적었다.
- 재현: `docs/critic/mui-r1.md`가 아니라 이 라운드의 하네스로 잰 값이다. 하네스는
  일회용이라 레포에 안 남겼다(경계). 원본 JSON은 §5에 경로가 있다.

---

## 3. 파리티 — 알림 밖은 1픽셀도 안 움직였다

**규약:** 알림 7종은 "**변경 화면**"이고 기준은 2.6.2가 아니라 **목업**이다
(장부 `docs/renderer-divergence.md` §6.2에 등재). 그 밖의 화면은 **픽셀 불변**.

측정 방법: M-UI **직전 빌드**와 **적용 빌드**를 같은 세션에서 연달아 띄우고, 같은
픽스처 홈·같은 조작 순서(`bench/screens.mjs`의 reach/assert 그대로)로 8화면을 찍어
`docs/critic/tools/critic-pixdiff.mjs --thr=1`로 비교했다.

| 화면 | 바뀐 픽셀(임계 1) | 최대 채널차 |
|---|---|---|
| `chat-header` | **0** | 0 |
| `composer` | **0** | 0 |
| `workbar` | **0** | 0 |
| `chat-welcome` | **0** | 0 |
| `explorer-tree` | **0** | 0 |
| `composer-picker-pop` | **0** | 0 |
| `composer-slash-palette` | **0** | 0 |
| `workbar-todo-pop` | **0** | 0 |

SHA-256도 8/8 일치.

**이 값을 얻기까지 잡은 계측 함정 둘 — 다음 라운드가 또 밟을 자리다.**

1. **창 크기가 실행마다 갈린다.** `Browser.setWindowBounds`를 마운트 전에 한 번만
   부르면 앱이 마운트 뒤 자기 기하를 다시 얹어 1320×880 / 1440×900로 **갈렸다**.
   그러면 두 캡처가 통째로 달라져 "회귀"로 보인다. 정착 후 `window.innerWidth`가
   목표와 같아질 때까지 **다시 세워야** 한다.
2. **스레드 스크롤이 ±16px 흔들린다.** 꼬리 윈도잉 + 자동 따라가기가 실행마다 다른
   자리에 멈춘다(**같은 exe끼리도** 세션이 갈리면 갈렸다 — 노이즈 실측 확인).
   캡처 직전 `.chat-scroll.scrollTop = scrollHeight`로 **못박아야** 0px이 뜻을 갖는다.

또 하나: **무변경 판정은 알림을 뺀 스레드로 잰다.** 벤치 픽스처의 스레드에는 안내·문답·
명령 카드·중단선이 섞여 있어서, 그 스레드가 보이는 화면은 정의상 '변경 화면'이다.
그래서 파리티 패스에서는 스냅샷에서 알림 6종을 걷고 잰다 — 재는 것은
"**알림 밖의 픽셀이 움직였는가**"뿐이고, 그건 0이어야 한다.

---

## 4. 게이트

| 게이트 | 결과 | 비고 |
|---|---|---|
| `npm run typecheck:app` | **PASS** | 오류 0 |
| `npm run tauri:build` | **PASS** | 1분 31초 · `target/release/agentcodegui.exe` |
| `poc-live-chat --only=live` | **PASS** | 실 CLI 1턴 · 결함 0 |
| `poc-live-chat --only=events` | **PASS** | EngineEvent 9종 + 오류 표면 · 결함 0 |
| `poc-live-chat --only=dialog` | **PASS** | 폴백 확인 카드 → 리비전 1 · 결함 0 |
| `poc-live-chat --only=winsave / reload / slots` | **PASS** | 각 결함 0 |
| `poc-dial --only=dial` | **PASS(green 유지)** | 다이얼 1↔6 무손실 |
| 무변경 8화면 0px | **PASS** | §3 |
| 밀도 계측표 | **−13.2%** | §2 |

전부 `--exe=`로 **스냅샷 exe**를 재도록 고정했고(4명 동시 주행 중 `target/release`가
갈릴 수 있다), `--tag=mui`로 홈·포트·산출물을 분리했다. `poc-dial`은 `--tag`가 없어
기준 결과 파일(`docs/critic/m-ux-r3-dial.json`)을 덮으므로 **`git checkout`으로
복원**했다(내 결과 사본은 §5).

메모리 게이트는 **안 쟀다** — 4명 동시 주행이라 노이즈다(리드 소관).

---

## 5. 산출물 경로

| 무엇 | 어디 |
|---|---|
| 알림 7종 A/B 블라인드 쌍 + 정답 키 | `bench/shots/mui-notify/` (`blind.html` · `notify-7-A.png` · `notify-7-B.png` · `key.json`) |
| 모델 전환 변형 시트(cause 3 · 되돌린 뒤 · 한 턴 2배너 · resume rule · neutral 안내) | `bench/shots/mui-notify/fallback-variants.png` |
| 좁은 폭(420px) 렌더 | `bench/shots/mui-notify/narrow-420.png` |
| 전체 화면 블라인드(54쌍 · 알림 화면 포함) | `bench/shots/blind.html` · 키 `bench/shots/blind-key.json` |
| 변경 화면 재캡처(3.0) | `bench/shots/tauri/chat-thread.png` · `cmd-result-card.png` (`--merge`로 그 둘만 교체) |
| 밀도 원본 JSON | `%TEMP%/mui-density/a-electron.json` · `b2.json` (항목별 높이·여백·클래스) |
| 파리티 캡처 + pixdiff | `%TEMP%/mui-parity3/{base,new}/*.png` · `pixdiff.json` |
| poc-live-chat 결과 | `docs/critic/m3-r4-live-mui.json` (기준 파일 아님 — 내 태그) |
| poc-dial 결과 사본 | `%TEMP%/mui-density/poc-dial-mui.json` (기준 파일은 복원함) |

블라인드 판정은 다음 크리틱이 한다. `bench/shots/mui-notify/blind.html`은 앱 이름을
어디에도 담지 않는다(파일명 A/B, 정답은 `key.json`에만).

---

## 6. 게이트 계약을 **바꾼** 2건 (숨기지 않는다)

둘 다 하네스가 **M-UI 이전 문법을 상수로 박아** 둔 자리다. 문법이 바뀌었다는 이유만으로
게이트가 빨개지면, 다음 사람은 게이트를 맞추려고 설계를 되돌린다.

1. **`scripts/poc-live-chat.mjs` `E9-error`.** 오류 표면을 낱말 '오류'의 개수로 셌다.
   M-UI가 그 제목 줄을 없앴으므로(§5-3 — 색조가 이미 말한다) 낱말이 0이 된다.
   판정을 `max(낱말 수, .thread의 danger band 수)`로 바꿨다 — **두 렌더러 모두에서**
   "없다/두 번 말한다"를 똑같이 잡는다. 검사를 약하게 만든 게 아니라 렌더러 중립으로
   만든 것이다. 바꾼 뒤 PASS(`labels:0, surfaces:1`).
2. **`scripts/poc-auto-compact.mjs` 검사 5·8·9.** 자동 압축을 `cmdresult` 카드로
   단정했다. M-UI §5-5가 그것을 `boundary`(rule)로 바꿨다(93.8px → 15px — 이번 밀도
   이득의 3분의 2). 검사를 `boundary` + `label`/`num`으로 갱신했다.
   **⚠ 실행은 못 했다** — 이 환경에서 `esbuild`가 해석되지 않아 그 하네스가 아예 안 뜬다
   (`Cannot find module 'esbuild'`, 내 변경 이전부터). 값은 리듀서를 손으로 따라간
   것이라 **다음 크리틱이 esbuild 있는 환경에서 한 번 돌려 확인해야 한다.**

---

## 7. 아직 안 된 것

1. **`[한도 풀리면 이어서]` 알약(목업 3-error)을 안 넣었다.** 자동 이어서는 **전역
   pref**(`limitResume.on`)라 표면마다 소유자가 다르고, 멀티 패널에는 그 setter가
   내려와 있지 않다. 눌러도 표면에 따라 다른 일이 일어나는 버튼은 안 만든다(§4-4).
   오류 band에는 **초기화 시각**(정보)이 남고, 그 아래 `LimitHoldBar`가 행동을 맡는다.
2. **`revert` 알약이 본채팅에만 있다.** 멀티 패널·추가 채팅 창에는 통합 스토어의
   `chatId` 배선이 아직 없다(패널은 슬롯, 창은 세션 id로 산다). `onNotify`를 안 준
   표면에서는 그 알약을 **아예 안 그린다** — 눌러도 아무 일 없는 버튼이 제일 나쁘다.
3. **`t-neutral` 안내의 실제 발화자가 하나뿐이다.** 목업의 예(CLI 2.1.4 업데이트)는
   스레드 notice로 오는 경로가 없다(앱 업데이트는 `EngineUpdateGate`가 맡는다).
   지금 neutral로 내려가는 건 우리가 만든 문장 하나(`…새 프로세스에서 시작했어요`)뿐이고,
   **남의 문장(CLI 배너)은 심각도를 판정할 근거가 없어 노랑을 유지**한다. 지어내지 않았다.
4. **`rule`의 나머지 쓰임 3종이 아직 없다** — resume 경계 · 엔진 재시작 · 백그라운드
   중지. `boundary.glyph:'resume'`까지는 심어 뒀지만 발화자가 없다. 목업
   `ui-notify-4-interrupt.html`의 R1/R2 패널이 그 자리다.
5. **`transient` 계열(토스트·워크바 칩·트레이)은 이 체계 밖**이다(스펙 §7-3 그대로).
   같은 사건이 토스트로도 뜨고 스레드에도 남는 경우의 규약은 여전히 없다.

**닫힌 열린 질문 하나 — 스펙 §7-7(420px에서 트레이가 접히는가).** 실측했다
(`bench/shots/mui-notify/narrow-420.png`): 트레이는 **접히지 않는다.** `.ntf-bd`가
`flex:1; min-width:0`이라 문장이 먼저 줄고, 알약과 시각은 **첫 줄에 그대로 남는다**.
즉 §4-1의 "행동 알약은 시각과 같은 줄에 산다"가 420px에서도 성립하고, §5-1이 예상한
"+22px"는 생기지 않는다. 두 절을 화해시킬 필요가 없어졌다.

되집는 법: `styles.css`의 `--ntf-*` 블록과 3형태 블록, `session.ts`의 `fallback`·
`boundary` 두 항목, `Chat.tsx`의 `FallbackBand`·`ErrorBand`를 걷고 `MessageView`의
7분기를 2.6.2 마크업으로 되돌리면 된다. 커밋 하나에 다 들어 있다.
