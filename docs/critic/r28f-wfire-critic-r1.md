# R28f 「WFIRE」 확인 크리틱 R1 — 예산은 진짜로 재시작을 넘는다. 그런데 그 재시작 뒤 화면은 「한도가 풀렸어요」라고 말한다

판정 대상: `d461f21` (R28f WFIRE R2 · 14파일 · +841/−28)
판정자: 새 컨텍스트. **빌더의 하네스·보고서·커밋 메시지를 근거로 쓰지 않았다** — 계기를 새로 쓰고,
대조군은 **부모 커밋 트리를 새 `CARGO_TARGET_DIR`로 따로 빌드**해서 잡았다.

**결론: 합격(체크리스트 8/8 초록).** ★①(예산이 재시작을 넘는다)은 엔진 축·디스크 왕복·실앱에서
전부 닫혔고, 판별력도 부모 트리 대조군으로 확인했다. 남은 최대 격차는 **같은 커밋의 ★③이
★①이 연 그 길(재시작)에서는 안 산다**는 것이다: 예산으로 접힌 표를 들고 앱을 껐다 켜면 실앱이
내리는 행이 `{ready:true, fires:12, paused:false}`이고, 그 행에 실번들 `budgetLanding`을 먹이면
**false**다 — 화면은 12발을 태운 표에 대고 「한도가 풀렸어요」라고 말한다.

---

## 1. 무엇으로 쟀나

| 축 | 값 |
|---|---|
| 판정 대상 exe | `C:\Code\AgentCodeGUI\target-r28f-wfire-crit\release\agentcodegui.exe` · sha256 `720df9e91cc09b1d249e5498784c0fb80471a1be69ebb111d2ff7235cbb76400` (HEAD=`d461f21` · `npm run app:build` → `cargo build --release --features custom-protocol`) |
| 가짜 CLI | `…\target-r28f-wfire-crit\release\ccg-fakecli.exe` · sha256 `24def98c08c240ef2764fe6bb18120706b7c187a251c59a007b2091910a812d9` (`-p ccg-engine --features fakecli`) · `ccg-fakecodex.exe` 동반 |
| **대조군 exe** | `C:\Code\AgentCodeGUI\target-r28f-wfire-crit-exectl\release\agentcodegui.exe` · sha256 `76e87e2d42e2023c6c05afd6d3b855bf32ab7075bc3ee38b28d88aeae8053997` — 부모 커밋 `dc454e4`를 `git archive`로 **레포 밖**(`C:\Temp\ccg-r28f-wfirecrit\parent`)에 풀어 **새 target 디렉터리**로 빌드(트랩 11). 프론트엔드는 HEAD의 `app/dist`를 복사(이 측정은 Rust 축이다) |
| 내 엔진 프로브 | `C:\Temp\ccg-r28f-wfirecrit\probe\tests\wfire_crit.rs` — **레포 밖 독립 크레이트**(`ccg-engine`을 경로 의존으로만 문다). 드라이버·눈금·대본 전부 새로 씀. HEAD용 `--features carry`, 부모용 무피처(부모 `ReloadHold`엔 칸이 없어 **컴파일이 갈린다** = 대조군의 정직한 모양) |
| 프로브 target | HEAD `target-r28f-wfire-crit-probe` · 부모 `target-r28f-wfire-crit-ctl` (둘 다 신규) |
| 실앱 계기 | `C:\Temp\ccg-r28f-wfirecrit\live-carry.mjs`(디스크 왕복 · CDP 안 씀) · `live-row.mjs`(앱이 실제로 emit 하는 `chat:status` 행을 CDP로 포획) · `rend.mjs`(esbuild로 `app/src/lib/*.ts`를 그 자리에서 묶어 **실번들** 판정 + 렌더러 축 시뮬레이터) |
| 격리 홈 | `C:\Temp\ccg-r28f-wfirecrit\home-{a,b,c,d,eng,cx,seed,long}` (사용자 실홈 0회 접촉 · 합성 자격증명 · `CCG_NO_NET=1`) |
| CDP 포트 | 10550 · 10551 · 10552 · 10553 · 10554 · 10555 (배정: WFIRE 크리틱 = 10500+50) |
| kill | 전부 `taskkill /PID <내가 스폰한 pid> /T /F` — 이름 기반 0회 |
| 기준 파일 | 덮어쓴 것 0 — `--out`으로 신규 3개(`limit-engine-crit-r28fwfire-r1{,-seed,-long}.json` · `limit-codex-crit-r28fwfire-r1.json`) |

---

## 2. 체크리스트 실측

### ①  예산이 재시작을 넘는가 — **초록**

내 프로브(`burn` → `hold`의 디스크 짝을 뽑아 **새 런타임**에 `reload_state`):

| 못 | HEAD(값 물려받음) | 같은 바이너리·칸만 0 | **부모 트리** |
|---|---|---|---|
| C1 예산 소진 표 재장전 + 20시간 | **0발** · `episode_fires 12` · `paused true` | 4발 | **4발** |
| C1b 헛발질 상한 표 재장전 + 12시간 | **0발** | 2발(= 크리틱이 잰 「+2발」) | **2발** |
| C1c 재장전을 **두 번** + 20시간 | **0발** | — | 표 자체가 증발 |

부모 트리에서 R28e의 증상이 그대로 재현된다(같은 대본·같은 프로브 소스·**다른 target 디렉터리**).
20시간에 12발이 아니라 4발인 것은 내 대본이 「5시간 창·4.5시간 작업」이라 20시간에 네 창뿐이기
때문이다 — 재충전이 일어난다는 사실은 같다.

**디스크 왕복은 실앱으로 따로 쟀다**(`engine:debug` 같은 이번 라운드의 새 창을 안 쓰고, 파일만 본다.
부팅이 파일을 **다시 쓰기** 때문에 「부팅 뒤 파일에 무엇이 남았나」가 네 칸 전체의 판별기다):

| 심은 값 | HEAD exe 부팅 뒤 파일 | 부모 exe 부팅 뒤 파일 |
|---|---|---|
| `{ready:false, attempts:2, fires:12}` | `{resetsAt:…, ready:false, attempts:2, fires:12}` | **`{resetsAt:…, ready:false}`** — 두 칸이 부팅 한 번에 지워진다 |
| `{ready:false, attempts:0, fires:0}` | `{…, attempts:0, fires:0}` | — |

빌더 하네스도 내 exe로 돌렸다: `poc-limit-engine --seed-fires=12 --seed-attempts=2` → **14/0**
(E11 `seeded 12 / got 12` · E12 `2 / 2` · E13 파일에 두 칸).

**같이 보라고 한 문 둘:**
* `ma:dispose` — `Hub::ensure`는 디스크 hold를 **안 읽는다**(읽는 곳은 부팅 `reload_pending` 하나).
  자리를 접으면 표와 예산이 인메모리에서 통째로 사라진다. 빌더가 §미완 1로 신고한 그대로다.
  덧붙일 사실 하나: 그 뒤 **새 에피소드가 표를 세우면 `persist_hold`가 디스크의 12를 1로 덮어쓴다**
  (`slot.rt.episode_fires()`를 그대로 적는다) — 즉 다음 부팅에도 안 돌아온다.
* 채팅 삭제 — 행과 파일이 함께 사라지므로 예산 질문 자체가 없다(`dispose_removed_chats`/`retain`).

### ②  렌더러 축의 처리가 정직한가 — **초록**(문장 하나는 부정확)

**앱이 실제로 emit 한 행**을 CDP로 떠서 **실번들**(esbuild로 묶은 `app/src/lib`)에 먹였다:

```
empty_lite 행 {chatId, status:"idle", hold:null, autoResume:true, resumeOwner:"engine", …}
live  lite 행 {chatId, hold:{resetAt, ready:false, fires:12, paused:false}, autoResume:false, resumeOwner:"engine", …}
engineOwnsResume(empty_lite) = true
engineOwnsResume(live lite)  = true
```

두 행 다 `true`다 → `App.tsx`의 훅은 언제나 `managed` → `useLimitResume`이 `if (o.managed) return`으로
장전을 안 하고, `limitResume.hold` pref는 늘 비고(그 pref를 읽고 쓰는 곳은 `App.tsx` 682/692 **하나뿐**임을
확인), 그래서 `sanitizeHold`의 계수·예산 복원 분기는 **실앱에서 값을 받지 못한다.** 빌더가 고른 셋째 길
(규칙은 남기고 계기로 못 박기)은 이 값과 **맞는다** — ①도달 가능화는 `resumeOwner`의 존재 이유(재개 주체
하나)를 무르는 것이고, ②제거는 두 축의 공통 규칙을 한쪽만 지우는 것이다.

정확히 하나만 정정: 보고서·주석의 「`sanitizeHold`에는 **호출자가 없다**」는 틀렸다. 호출자는 있다
(`App.tsx:682` — 부팅마다 돈다). 없는 것은 **입력**이다(pref가 늘 `null`). 같은 주석 아래 문단이 그 사실을
정확히 적고 있으므로 실질은 맞고, 표제 문장만 실측과 어긋난다.

### ③  71발 축 무회귀 — **초록**

12시간 대본 셋(내 드라이버 · 꼬리 없는 배너형 문구 · 즉사):

| 대본 | HEAD | 부모 트리 |
|---|---|---|
| 어시스턴트 텍스트 한 줄 즉사 | **2발** · `ready+paused` · `attempts 2` | 2발 |
| 도구 하나 열고 결과 없이 즉사 | **2발** | 2발 |
| 한도 문구를 **텍스트로** 받음 | **2발** | 2발 |

전부 예산(12) 한참 아래다. R28e에서 이미 닫힌 축이라 부모에서도 2발이 나오는 것이 정답이고,
이번 라운드가 그 축을 건드리지 않았음을 확인한 것이 이 표의 값이다.

### ④  진짜 밤샘은 안 잘리는가 / 60시간 경계 — **초록**

* 창이 매 턴 1시간 뒤로 + 45분 일함 · 12시간 → **7발 · `attempts 0` · 안 접힘**(HEAD·부모 동일).
* 5시간 창 · 4.5시간 작업을 끝까지 → **표가 선 뒤 60.52시간에 12발로 접힘**. 렌더러 축 시뮬레이터도
  같은 대본에서 12발 · (t0 기준 65.03시간 = 표가 선 뒤 60.0시간).
* 즉 코드 주석의 **「약 60시간까지는 안 잘린다」는 내 눈금에서도 참**이다. 다만 보고서 §2의
  「값이 **정확히** 60시간이다」는 대본 의존이다(빌더 못 ⑮는 꼬리 없는 배너형 + 10분 대기라 60.0,
  내 대본은 벽을 미는 축이라 60.52 · 첫 프롬프트 기준으로는 65시간). 「약」이 맞고 「정확히」는 과하다.

### ⑤  헛발질(출력 0)은 2발에서 접히는가 — **초록**

6시간·12시간 대본 모두 **2발 → `ready:true` + `auto_paused:true` + `attempts:2`**. 버튼이 뜨는 상태다
(실번들 `canPressResume`은 `ready && auto!==true`).

### ⑥  엔진·렌더러 궤적 일치(2/6/12) — **초록**

같은 대본 여섯을 두 축에 먹였다(렌더러 축은 `useLimitResume`의 세 조각을 그대로 옮긴 루프 +
**실번들 순수 함수**):

| 대본 | 엔진 2h/6h/12h | 렌더러 2h/6h/12h |
|---|---|---|
| 텍스트 즉사 | 2 / 2 / 2 (접힘) | 2 / 2 / 2 (접힘) |
| 도구만 열고 즉사 | 2 / 2 / 2 (접힘) | 2 / 2 / 2 (접힘) |
| 한도 문구 텍스트 | 2 / 2 / 2 (접힘) | 2 / 2 / 2 (접힘) |
| 밤샘(45분 작업·창 이동) | 0 / 1 / 7 (안 접힘) | 0 / 1 / 7 (안 접힘) |
| 헛발질 | 2 / 2 / 2 (접힘) | 2 / 2 / 2 (접힘) |
| 5시간 창·4.5시간 작업 | 0 / 1 / 2 | 0 / 1 / 2 |

여섯 대본 × 세 눈금 = 18칸이 전부 같다.

### ⑦  무후퇴 — **초록**

| 계기 | 결과 |
|---|---|
| `poc-limit-resume` | **343 / 0** (R28e 322 · 후퇴 0) |
| `poc-limit-engine`(내 exe) | **14 / 0** · `--seed-fires=12 --seed-attempts=2` **14 / 0** · `--long` **17 / 0** |
| `poc-limit-codex`(내 exe) | **8 / 0** |
| cargo(크레이트별 · `target-r28f-wfire-crit`) | `ccg-engine` **249/0**(2 ignored) — 미추적 프로브 둘이 18(`probe_wfire_crit` 8 + `probe_wfr2` 10) → **추적본 231** · `wcap_limit_streak` **16/0** · `ccg-store` **90/0** · `ccg-fs` **101/0**(2 ig) · `ccg-lsp` **59/0** · `ccg-auth` **124/0** · `agentcodegui`(custom-protocol) **154/0** |
| typecheck | node · web · app **3종 exit 0** |

내 프로브 크레이트는 레포 **밖**이라 위 수에 한 건도 안 섞인다.

### ⑧  커밋 경계 — **초록**

`d461f21`이 만진 14파일에 남의 갈래 파일이 없다. `runtime.rs` diff의 추가 줄에 M10 마커
(`talk_guide`·`spawn_guide`·`append_prompt`) **0건**, `src-tauri/src/engine/talk.rs`(M10의 미커밋 변경)
**미포함**, `crates/ccg-auth/**`·`src-tauri/src/ipc/**`·`App.tsx`·`Settings.tsx`·`bench/**`·`progress/**`
전부 미포함. 경계 밖 두 파일(`engine/mod.rs` 4줄 · `resumeOwner.ts`)은 보고서에 신고된 그대로다.

---

## 3. 남은 결함

### F1 [B급 · 이번 라운드가 연 자리] 배너의 「예산 착지」 구분이 **재시작을 못 넘는다**

★①이 계수·예산을 재시작 너머로 실어 나른 바로 그 경로에서 ★③이 침묵한다. 세 조각이 겹친 결과다:

1. `hub::persist_hold`는 `auto_paused`를 **일부러 안 적는다**(설계 결정).
2. `status::truth_from_chat_file`은 부팅 행에 `"paused": false`를 **상수로** 적는다.
3. **그리고 `check_hold`는 그 판정을 다시 하지 않는다.** `check_hold`의 첫 문이
   `filter(|h| !h.ready)`라, 디스크에 `ready:true`로 적힌 표(= 접힌 표·화면 밖에서 풀린 표가
   바로 그 모양이다)는 재장전 뒤 **영원히 판정에 도달하지 못한다.**

즉 새 주석 세 곳이 근거로 든 문장 — `runtime.rs::reload_state`의 「판정은 `check_hold`가 재장전 뒤
다시 한다」, `hub::persist_hold`의 「판정은 부팅 뒤 `check_hold`가 이 두 값으로 다시 한다」,
`status.rs`의 「이 행이 그리게 될 상태도 「아직 안 접힌 표」다」 — 중 앞의 둘이 **실측과 반대**다.

**재현(내가 한 그대로):**
```
node live-carry.mjs --exe=<HEAD exe> --fakecli=<fakecli> --home=C:\Temp\…\home-d \
     --fires=12 --attempts=0 --ready=1 --secs=10       # 예산 소진 + ready 표를 심고 한 번 부팅
node live-row.mjs   --exe=<HEAD exe> --home=C:\Temp\…\home-d --port=10555
```
실앱이 내린 행(포획 원문):
```json
{"chatId":"c-crit-carry","hold":{"resetAt":1787649364.888,"ready":true,"fires":12,"paused":false},
 "autoResume":false,"resumeOwner":"engine"}
```
그 행에 실번들을 먹이면 `budgetLanding(false, 12) = false`, `canPressResume = true`.
`Chat.tsx`의 사다리는 `press → budgetLanding? … : managed.paused? … : t('한도가 풀렸어요 — 눌러서 이어가기')`
이므로 화면 문장은 **「한도가 풀렸어요 — 눌러서 이어가기」**다. 12발을 태우고 막힌 표에 대고
「풀렸어요」라고 말하는 것 — R28d가 밤샘 축에서, R28e가 예산 축에서 고친 것과 **같은 종류의 거짓**이다.
화면에 보이는 채팅(`autoResume:true`)이면 `press`가 거짓이 되어 **「곧 이어서 계속해요」**가 뜨는데,
아래 F3대로 영영 안 보낸다.

닫는 길은 셋 중 하나다(동작 변경이라 판단은 넘긴다): `auto_paused`를 영속한다 · `check_hold`가
`ready` 표도 한 번은 재판정하게 한다 · 부팅 행의 `paused`를 `fires >= MAX_EPISODE_FIRES`로 짓는다.

### F2 [B급 · 신고된 것의 **크기**가 틀렸다] 예산이 디스크에 없는 시간 = 「분 단위」가 아니라 에피소드의 44~77%

`consume_hold`가 표를 걷으면 `refresh_lite`가 `hold:null`을 내려 `persist_hold`가 디스크에 `null`을 적는다.
다음 표가 설 때까지 **예산도 대기표도 디스크에 없다.** 그 창에서 재시작하면 부팅 후보 자체가 없다.
보고서 §미완 2는 이 창을 「분 단위」라고 적었는데, 내 프로브(`c7_disk_blind_window`)의 실측은:

| 대본 | 표가 디스크에 없는 시간 | 최장 공백 |
|---|---|---|
| 밤샘(45분 작업) | **5.25h / 12h = 44%** | 45분 |
| 5시간 창·4.5시간 작업(예산 12발을 정의하는 그 대본) | **54h / 70h = 77%** | **4.5시간** |
| 텍스트 즉사(빠른 헛돌이) | 0h (0%) | 0 |

즉 「분 단위」가 맞는 것은 **예산이 필요 없는 대본**뿐이고, 예산이 존재하는 이유인
「오래 일하며 천천히 죽는」 대본에서는 **에피소드 시간의 3/4이 무방비**다. `ReloadHold` 새 주석의
「되돌아가는 자리는 셋뿐이다 — **재시작은 그 셋이 아니다**」는 그래서 절대문으로는 거짓이다:
재개 턴이 도는 동안의 재시작은 그 셋에 든다. (실손해는 제한적이다 — 그 뒤 새 에피소드가 서려면
턴이 하나 필요하고 사용자 턴이면 어차피 예산이 열린다. 그래도 **문장은 사실이어야 한다.**)

### F3 [C급 · 선재 · 이번 라운드 밖] `ready`로 저장된 표는 재장전 뒤 **영영 자동 재개하지 않는다**

`c8_ready_reload`(자동 켬 · 20시간):

| 심은 표 | HEAD | 부모 트리 |
|---|---|---|
| `ready:true` · 시각 있음 · 예산 0 | **0발** · `hold(ready:true, paused:false)` · `resume_now`엔 1발 | 0발 |
| `ready:true` · 시각 미상 · 예산 0 | **0발** | 0발 |
| `ready:true` · 예산 12 | **0발** | 0발 |

부모에서도 같으므로 **이번 커밋의 회귀가 아니다.** 다만 「한도 자동 이어서」의 절반(화면 밖에서
풀린 표를 들고 앱을 껐다 켜는 흐름)이 재시작을 못 넘는다는 뜻이고, 그동안 배너는
「곧 이어서 계속해요」라고 말한다(D7의 반대편 — 침묵이 아니라 **거짓 약속**). F1과 뿌리가 같다.

### F4 [C급] 문장 정밀도 둘

* 보고서 §2 「값이 **정확히** 60시간이다」 — 대본 의존(내 눈금 60.52h · 65h). 코드 주석의 「약 60시간」이 맞다.
* 보고서·주석 「`sanitizeHold`에는 살아 있는 **호출자가 없다**」 — 호출자는 부팅마다 돈다(`App.tsx:682`).
  없는 것은 입력이다.

### F5 [C급 · 신고됨, 사실 하나 추가] `ma:dispose`

`Hub::ensure`가 디스크 hold를 안 읽는다는 신고는 코드로 확인했다. 추가 사실: 자리를 접은 뒤
**새 에피소드가 표를 세우면 `persist_hold`가 디스크의 예산을 새 값으로 덮어쓴다** — 「다음 부팅에
돌아온다」는 완충마저 그때 사라진다.

### 관찰(결함 아님)

`auto_paused` 표 뒤에 사용자가 **친** 메시지는 `hold_gate_open()`이 닫혀 있어 큐에 선다
(내 C1d/C1d2: 38시간·20시간 동안 `queue 1` · 발사 0 · 재시작 유무와 무관 = 선재이자 설계).
출구는 배너 버튼이고 실제로 열려 있다(C1e: `resume_now` → 30분 안에 1발, `consume_hold`의
`already` 가지가 큐도 함께 푼다 — codex 하네스 C5가 그 자리를 잰다).

---

## 4. 내가 만진 것

* **레포 수정 0.** 추적 파일 변경 0줄, 이 판정문 한 개만 추가한다.
* 레포 안에 남긴 것: `docs/critic/limit-engine-crit-r28fwfire-r1{,-seed,-long}.json` ·
  `docs/critic/limit-codex-crit-r28fwfire-r1.json` (전부 `--out` 신규 · 기준 파일 덮어쓴 것 0) ·
  빌드 산출물(`app/dist` 재생성 · `target-r28f-wfire-crit*` 세 개).
* 레포 **밖**: `C:\Temp\ccg-r28f-wfirecrit\`(프로브 크레이트 2 · 부모 트리 · 계기 3 · 격리 홈 8).
  내 프로브를 `crates/ccg-engine/tests/`에 안 둔 이유는 하나다 — 다섯 갈래가 같은 워킹트리를 쓰는데
  남의 `cargo test -p ccg-engine` 수를 내가 늘리지 않으려는 것이다(트랩 10).
* 남의 미커밋 변경(`src-tauri/src/engine/talk.rs` · `docs/critic/tools/critic-r28f-rawprobe.mjs`)은
  reset·checkout·stash 하지 않았다. 이름 기반 kill 0회. 실계정 파일 접촉 0회. 실 HTTP 0(`CCG_NO_NET=1`).
