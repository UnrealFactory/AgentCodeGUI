# R28b 「RVERD」 확인 크리틱 R1 — 두 구멍은 진짜로 닫혔다. 그런데 새로 낸 **출구에 상한이 없다**(5시간에 27번 눈감고 쏜다)

판정자: RVERD 확인 크리틱 R1(새 컨텍스트) · 2026-08-25 · `feature/3.0.0-beta`
판정: **합격(pass = true).** 체크리스트 **5항 전부 크리틱 실측 통과.**
대상: `63bf667`(코드·하네스·라이브 리포트) · `008664d`(보고서 `docs/parity-fix-rverd-r1.md`)

빌더의 보고서·커밋 메시지는 **근거로 쓰지 않았다.** 전부 내 손으로 다시 빌드하고 다시 쟀다.

---

## 0. 한 문단 결론

**두 격차는 실측으로 닫혔다.** 시각 미상 대기표는 조회가 죽어 있어도 **3회차(645초)에 출구**를 얻고
(수정 전 20/20 hold → 수정 후 `1,2,R`), 시각을 아는 표의 사다리는 두 판 모두 글자 그대로 같다.
`codex-auth:accounts-usage`는 내가 빌드한 exe에서 **실물 행 2개를 82ms에** 돌려주고(2회차는 캐시 2ms),
설정 ▸ Account의 OpenAI 게이지는 **렌더러 수정 0줄로** 「5시간 0% 남음 · 주간 88% 남음」을 그린다.

**그런데 그 출구는 버튼이 아니라 발사이고, 발사에 상한이 없다.** 실제 훅(`useLimitResume.ts`)을 한 글자도
안 고치고 멀티 패널 슬롯 대본으로 5시간을 돌렸다 — 채널이 계속 빈 배열인 판에서 **27회** 눈감고 쐈다
(11·22·32…290분). 마지막 대기표까지 `probes:1`로 살아 있다. 즉 상한은 **한 대기표 안에서만** 있고,
쏜 턴이 같은 한도 에러로 죽으면 새 대기표가 `probes:0`으로 다시 서기 때문에 **주기가 영원히 돈다.**
엔진은 이 자리를 두 겹으로 막아 뒀다(`MAX_BLIND_PROBES=6` → `ready + auto_paused` 버튼, 그리고
`attempts >= MAX_AUTO_ATTEMPTS` → 자동 정지). 렌더러에는 그 둘 다 없다 — 이번 라운드는 조건만 맞추고
착지는 안 맞췄다. 지운 주석이 바로 그 사고를 예고했었다: *"그건 10분마다 다시 막히는 재전송기가 된다."*

그리고 **하필 그 재전송기가 켜지는 판이, 이번 라운드의 두 번째 자랑이 안 닿는 바로 그 판이다.**
전역 codex(npm 글로벌) 사용자는 `codex_bin()`이 맨 이름 `codex`를 돌려줘 `instrument()`의
`is_file()` 문지기에 걸린다 — 채널은 살아 있지만 **창이 빈 행**을 준다(라이브 실측:
`[{email,planType:null,windows:[]},…]`, 게이지 DOM `.limits` = 0개). 그 사용자에게 「게이지가 살아났다」는
아직 거짓이고, `codexUsageUnavailable`은 영구 참이라 **F1의 27회가 정확히 그 사용자에게 떨어진다.**

---

## 1. 무엇으로 쟀나

```
npm run app:build                                     → 2.11s · 산출 해시 동일(index-B8trWf6i.js)
CARGO_TARGET_DIR=target-rverd cargo build --release --features custom-protocol
                                                      → 1분 45초 · 로컬 크레이트 5개 재컴파일
exe 6,452,736바이트 · md5 733c29b08f5f3ef552baa066b1f8e202
```

빌더가 적은 값(6,444,544 · `ad7fff…`)과 다르다. 트리가 그새 바뀌었기 때문이다 —
그 빌드 뒤에 다른 갈래의 미커밋 변경이 더 들어왔다(`crates/ccg-auth/src/rotation.rs` 등). 빌더가 §3에
「내 exe는 순수 HEAD가 아니다」라고 적은 것과 같은 사정이고, 내 exe도 같은 사정이다(둘 다 정직하게 적는다).

라이브는 전부 **격리 홈 · 전용 CDP 포트 · 합성 계정(DPAPI) · 가짜 app-server**다. 실계정 0건 · 실 HTTP 0건 ·
이름 기반 kill 0건(`killTree(pid)`만). 기준 결과 파일은 하나도 안 덮었다 — 전부 `--out`으로 새 파일에 썼다.

---

## 2. 체크리스트 — 5항 전부 실측

### 2.1 판정 사다리(체크리스트 1) — 통과

`app/src/lib/limitResume.ts`를 esbuild로 묶어 **레포 밖에서 직접 구동**했다. 대조군은
`git show 63bf667^:app/src/lib/limitResume.ts`(수정 전 사본)이고, 같은 입력을 두 판에 먹였다.

| 대기표 | 수정 전(`63bf667^`) | 수정 후(HEAD) |
|---|---|---|
| `resetsAt = null` + 조회 실패 20연속 | **ready 0회**(20/20 hold) ← 크리틱 값 재현 | **3회차 ready**(`1,2,R`) |
| `resetsAt = NOW+3600`(미래) | 20/20 hold | 20/20 hold — **불변** |
| `resetsAt = NOW-100`(과거) | 3회차 ready | 3회차 ready — **불변** |
| 막혔다는 신선 증거(`still`) | `probes:0`으로 리셋 | 같음 |
| 물어봤고 막는 창 없음 | `ready` | 같음 |

출구까지의 벽시계 = `PROBE_MS 600,000 + recheck 15,000 + 30,000` = **645초(10분 45초)**.
「시각 아는 표 동작 불변(probe 3 도달)」도 위 표의 3행에서 그대로 확인된다.

### 2.2 채널과 게이지(체크리스트 2) — 통과(단, 조건부다 — §3.3)

내가 빌드한 exe로 `scripts/poc-codex-usage.mjs`를 다시 돌렸다(`--out`으로 새 파일).
→ **9 통과 / 0 실패** · 결과: `docs/critic/rverd-r1-crit-codexusage.json`

```
U1 ipc_call('codex-auth:accounts-usage') → 행 2개 · 82ms   (크리틱 R1에서는 {"__unimplemented":true})
U2 window.api.codexAuth.accountsUsage() → len=2            (크리틱 R1에서는 [])
U3/U4 planType:"pro" · 라벨 ["5시간","주간"] · resetsAt 실값
U5 가짜 app-server stdin에 account/rateLimits/read × 2      (와이어 물증)
U6 2회차 82ms→2ms · asks 2→2                                (캐시 2분)
U7 스토어 plan free→pro 되싱크
U8 재검증 판정 {unavailable:false, blockedUntil:1787587839}
```

**게이지는 빌더가 안 열어 본 자리라 내가 직접 열었다**(독립 라이브 프로브 · 격리 홈 `.poc-home-rverdcrit` ·
CDP 9458): 사이드바 `.sb-foot` → `.set-ni`(Account) 클릭 후 DOM을 읽었다.

```
OpenAI 카드 2장 · 각 카드에 .limits 1개
  "5시간 0% 남음 1시간 뒤 · 주간 88% 남음 1일 1시간 뒤"
  플랜 라벨 "ChatGPT Pro 플랜"   ← rateLimits의 planType이 화면까지 닿았다
```

### 2.3 하네스 무후퇴(체크리스트 3) — 통과

| 하네스 | 결과 |
|---|---|
| `poc-limit-resume.mjs`(현재) | **164 통과 / 0 실패** |
| `poc-limit-resume.mjs`(**63bf667^ 판**) × 현재 lib | **137 통과 / 4 실패** |
| `poc-limit-codex.mjs`(라이브 · 내 exe) | **8 / 0** — t=85s 발사 · `unknown=1 · blocked=0` |
| `poc-limit-engine.mjs`(라이브 · 내 exe) | **11 / 0** — 110초 `spawns=0 · stdin 0B` |

두 번째 줄이 「141 무후퇴」의 진짜 증거다. 옛 하네스를 새 lib에 먹였더니 **137 + 4 = 141**이고,
빨강 4개는 정확히 계약이 뒤집힌 자리다(F절 「상한 초과여도 시각 미상이면 절대 안 쏜다」 1개 +
G절 ② 세 표면 3개). 나머지 137개는 한 개도 안 흔들렸다. 빌더의 「바뀐 단언 4개」는 참이다.

### 2.4 테스트·타입·커밋 위생(체크리스트 4) — 통과

| 크레이트 | 결과 | 빌더 주장 |
|---|---|---|
| `agentcodegui`(bin) | **142 / 0** | 140 / 0 |
| `ccg-engine` | **203 / 0**(+2 ignored) | 203 / 0 |
| `ccg-store` | **79 / 0** | 79 / 0 |
| `ccg-auth` | **102 / 0** | 116 / 0 |

bin(+2)·auth(−14)의 차이는 **공유 트리의 다른 갈래 미커밋 테스트**가 그새 늘고 준 것이다(빌더도 같은 사유를
적었다). 실패는 어느 크레이트에도 0이다. `codex_limit` 테스트 7개도 이름으로 따로 돌려 초록을 봤다.
`npm run typecheck`(node·web) + `typecheck:app` **3종 초록**.

커밋 위생: `63bf667`은 **7파일**이고 공유 파일에 자기 hunk만 담겼다 —
`src-tauri/src/engine/mod.rs`는 `@@ -43`(`pub mod codex_limit;`) 하나뿐이고, ACCT의 `@@ -281`
(`panel_seat_for_chat`)은 **미커밋 그대로** 워킹트리에 남아 있다. `Settings.tsx`·`ipc/parity/usage.rs`·
`app/src/lib/accounts.ts`는 커밋에 한 글자도 없다. 기준 결과 파일은 0개 덮었다.

### 2.5 멀티 패널 codex 시나리오(체크리스트 5) — 통과, 그리고 §3.1의 자리

멀티 패널은 `managed`를 안 넘긴다(`lrOptsFor`에 그 키가 없다 — 본채팅 `App.tsx:635`만 넘긴다).
즉 그 표면의 대기표 주인은 **렌더러 훅**이다. 실제 훅을 그대로 구동해 슬롯 0 대본으로 쟀다:
`engine:'codex'` · codex 한도 문구(꼬리 없음 → `resetsAt: null`) · 채널은 계속 빈 배열.

```
장전 → 1회차 hold(probes 1) → 2회차 hold(probes 2) → 3회차 ready → 전송 1  (무한 재확인 탈출 ✔)
```

**출구는 생겼다.** 문제는 그 다음이다 — §3.1.

---

## 3. 격차

### 3.1 【최대】 새 출구에 **상한이 없다** — 5시간 창 하나에 눈감은 재전송 27회

`useLimitResume.ts`를 수정 없이 구동해 **5시간(가상 시계)** 을 돌렸다. 쏜 턴이 같은 한도 문구로 또 죽는
것까지 재현했다(앱이 실제로 하는 일: busy 상승 → `status:error` → 재장전). 결과 파일:
`docs/critic/rverd-r1-crit-blindloop.json`

| 판 | 5시간 동안 눈감고 쏜 재개 |
|---|---|
| **HEAD(63bf667 이후)** | **27회** — 11·22·32·43…290분 · 마지막 대기표도 `probes:1`로 살아 있다 |
| `63bf667^`(수정 전) | 0회 — 대신 `probes:35`까지 갇힘(= 크리틱이 지목한 그 방) |
| 2.6.2 동결본(`src/renderer/src/lib`) | 30회 — 10분 정각 간격 |

빌더의 「2.6.2와 같은 자리」는 **참이다**(27 ≈ 30). 하지만 그 사실이 이 착지를 정당화하지 못한다.
같은 레포가 이미 이 사고를 이름 붙여 막아 뒀기 때문이다 — `crates/ccg-engine/src/limit.rs:36-42`:

> **눈감고 쏘는 재개의 상한.** … 재개 턴이 같은 한도 에러로 또 죽으면 그것이 곧 "아직 안 풀렸다"는
> 신선한 증거다. 그런데도 계속 쏘면 **5시간 창 하나에 CLI를 ~46회 띄우고** 스레드에 「이어서 진행해
> 주세요」와 오류 말풍선을 한 쌍씩 쌓는다. (R14 F2)

엔진은 그래서 두 겹이다: ① `probes < MAX_BLIND_PROBES(6)` 를 넘기면 `ready + auto_paused`(**아무것도 안
태우고** 버튼 + 공지), ② 그래도 쏜 턴이 또 죽으면 `attempts >= MAX_AUTO_ATTEMPTS(2)`에서 자동 정지 + 공지.
렌더러에는 **①의 착지도 ②의 계수도 없다.** `MAX_AUTO_ATTEMPTS`라는 이름만 같고 세는 대상이 다르다
(렌더러의 그것은 *재확인 횟수*이지 *재발사 횟수*가 아니다). 이번 라운드는 조건(`known && !past`)만
엔진과 맞추고 착지를 안 맞췄고, 그 결과 **한 앱 안에서 같은 상황의 답이 둘**이 됐다:

* 본채팅 = `resumeOwner:"engine"`(lite.rs가 무조건 싣는다) → 465초 뒤 「눌러서 이어가기」 + 공지 1줄
* 멀티 패널·팝아웃·추가 채팅 = 렌더러 훅 → **645초마다 발사, 공지 0줄, 버튼 0개, 상한 없음**

그리고 지운 주석이 정확히 이것을 예고했다: *"근거가 정말 하나도 없으면(시각 미상) 쏘지 않는다 —
그건 10분마다 다시 막히는 재전송기가 된다."* 그 문장은 답을 받지 못하고 지워졌다.

**다음 라운드 지시(구체):** `LimitHold`에 재발사 계수(엔진 `attempts` 짝)를 넣고, 상한을 넘긴 표는
`ready`를 켜되 **소진 effect가 쏘지 않게** 한다(엔진 `auto_paused` 짝). 그 표의 배너에는
`LimitHoldBar`의 비-`managed` 갈래에 **「이어가기」 버튼이 없으므로 그것부터 만들어야 한다**(§3.2).

### 3.2 커밋 메시지 한 줄이 사실이 아니다 — 그 경로에 「이어가기 버튼」은 없다

`63bf667` 커밋 메시지: *"수정 후 — **3회차에 ready(이어가기 버튼 + 자동 재개 출구)**"*.
실물은 다르다. 렌더러 소유 대기표에서 `ready`는 소진 effect가 **그 즉시** 삼켜 전송으로 바꾸고
(`useLimitResume.ts:189-198`), `LimitHoldBar`의 비-`managed` 갈래(`Chat.tsx:3342-3377`)에는
**버튼이 ✕ 하나뿐**이다(「이어가기」 버튼은 `managed` 갈래에만 있다). 즉 사용자가 누를 출구는 안 생겼고
자동 발사만 생겼다. 보고서 §1.1은 이 사실을 바르게 적었는데(「렌더러는 `ready`(눈감고 한 번 쏜다)」)
커밋 메시지만 반대로 적혀 있다 — 이 갈래는 커밋 메시지를 사실로 취급하는 규약이므로 한 줄 정정이 필요하다.
덧붙여 「한 번 쏜다」도 부정확하다: **한 대기표당 한 번**이고, 대기표는 5시간에 27번 다시 선다(§3.1).

### 3.3 전역 codex 설치본에서는 채널이 **빈 창**을 준다 — 게이지도 재검증도 그대로다

CRIT 확인 크리틱 R1이 `can_ask()`에서 잡은 구멍(`codex_bin()`의 전역 PATH 폴백)이 **이 라운드의
`accounts_usage()`에도 그대로 있다** — 같은 `instrument()`를 쓰기 때문이다. 라이브로 확인했다
(`CCG_CODEX_BIN`을 **빼고** 같은 판을 돌렸다 = npm 전역 codex 사용자):

```
ipc_call('codex-auth:accounts-usage')
  → [{"email":"…a","planType":null,"windows":[]},{"email":"…b","planType":null,"windows":[]}]
설정 ▸ Account · OpenAI 카드 2장 — .limits 0개("ChatGPT Free 플랜"만, 게이지 없음)
```

행은 오지만 창이 없다. `CodexLimits`는 `windows.length === 0`이면 `null`을 돌려주므로 **게이지는 여전히
빈칸**이고, `codexUsageUnavailable([])`은 **영구 참**이라 codex 재검증은 그대로 「못 물어봤다」다.
`command_for()`는 맨 이름을 `cmd /C`로 감싸 **턴은 정상으로 돌린다** — 즉 "돌기는 도는데 한도만 못 묻는"
사용자가 존재하고, 그 사용자에게 §3.1의 27회가 정확히 떨어진다. 조회기를 새로 안 만든 판단 자체는 옳다
(캐시 한 벌). 다만 **「게이지가 살아났다」는 앱이 자기 홈에 codex를 설치한 판에서만 참**이라는 조건을
보고서가 달지 않았다. 뿌리는 CRIT 갈래에 있으므로 고치는 자리도 거기(`is_file()` 문지기)다.

### 3.4 【사소】 `resync_plan`이 락 없는 read-modify-write다

`fill()`이 이제 계정 스토어에 쓴다. `ccg_auth::codex::resync_plan`은 읽기 → 비교 → **전체 파일 쓰기**이고
(`codex.rs:424-445`), `write_store_file`에는 잠금이 없다. plan이 실제로 바뀐 순간에만 쓰므로 창이 아주
좁지만, 그 순간 사용자가 계정을 지우거나 순서를 바꾸면 한쪽이 사라진다. 게다가 이제 이 경로를 **두
스레드**가 밟는다(엔진 워커의 `limit_probe` · 새 채널의 블로킹 팔). 같은 이유로 두 스레드가 동시에
`fill()`을 부르면 같은 계정에 app-server가 **둘** 뜬다(in-flight 합치기가 없다).

---

## 4. 재현

```bash
# ① 사다리 A/B (레포 밖 스크래치 · 원본 무수정)
node_modules/.bin/esbuild app/src/lib/limitResume.ts --bundle --format=esm --platform=node --outfile=%TEMP%/head.mjs
git show 63bf667^:app/src/lib/limitResume.ts > %TEMP%/pre.ts   # 대조군

# ② 실훅 5시간 주행 — react 최소 스텁 + 가짜 타이머로 useLimitResume.ts를 그대로 구동
#    (대본·결과: docs/critic/rverd-r1-crit-blindloop.json의 method/runs)

# ③ 라이브
CARGO_TARGET_DIR=target-rverd cargo build --release --features custom-protocol
node scripts/poc-codex-usage.mjs  --exe=…/target-rverd/release/agentcodegui.exe --out=docs/critic/rverd-r1-crit-codexusage.json
node scripts/poc-limit-codex.mjs  --exe=… --out=docs/critic/rverd-r1-crit-limitcodex.json
node scripts/poc-limit-engine.mjs --exe=… --out=docs/critic/rverd-r1-crit-limitengine.json

# ④ 하네스·테스트
node scripts/poc-limit-resume.mjs                    # 164/0
CARGO_TARGET_DIR=target-rverd cargo test -p agentcodegui / -p ccg-engine / -p ccg-store / -p ccg-auth
npm run typecheck && npm run typecheck:app
```

증거 파일(전부 새로 만든 것 — 기준 결과 0개 덮음):
`docs/critic/rverd-r1-crit-blindloop.json` · `rverd-r1-crit-codexusage.json` ·
`rverd-r1-crit-limitcodex.json` · `rverd-r1-crit-limitengine.json`
