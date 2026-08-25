# R28i LOCKS 확인 크리틱 R1 — 세 자물쇠는 내 손에서도 닫혔다. 그런데 ③이 「고쳤다」는 그 화면은 대조군에서도 거짓말을 안 한다

**판정: pass = true.** 체크리스트 여덟 항목을 전부 내 계기로 다시 쟀고, 하나도 안 떨어졌다.
최대 격차는 §5-B — ③의 **처방과 못은 옳은데, 보고서·커밋·제품 주석이 적은 「사용자에게
출구가 없다」는 화면이 출하 구성에서 **재현되지 않는다**(등급 **중**).

빌더 보고서를 근거로 쓰지 않았다. 빌드도 하네스도 홈도 전부 새로 만들었고, 돌연변이는
언제나 **새 CARGO_TARGET_DIR**에서 잤다. 레포 코드는 **한 줄도 안 고쳤다**(§7).

---

## 1. 무엇으로 쟀나

| 것 | 값 |
|---|---|
| 판정 기준 커밋 | **`668ac7e`**(R28i LOCKS 보고서 · LOCKS 갈래의 마지막 커밋). 주행 중 옆 갈래가 `837ae19`를 올렸으나 내 측정에는 안 들어갔다 |
| 작업 트리 | **레포를 안 건드리는 분리 워크트리 4개** — `D:\ccg-crit\wt`(HEAD) · `wtapp`(HEAD·앱) · `wtctl`(HEAD−③처방) · `wtpre`(`1ec1964`=②직전) |
| 왜 워크트리인가 | 같은 워킹트리에서 R28h(M10)·OPENDIR이 동시에 돈다. 남의 미커밋 hunk를 내 돌연변이가 물들이면 그건 재는 게 아니다 |
| target(전부 신규·재활용 0) | `t-base` `t-mutd` `t-muta` `t-mutb` `t-auth` `t-authnet2` `t-inlocka` `t-inlockb` `t-store` `t-storectl` `t-eng` `t-ws2` `t-pre` `t-app` `t-ctl3` (D: 드라이브 — C:는 지난 라운드 `target-*` 75개로 20G까지 말랐다) |
| 앱 exe(HEAD) | `D:\ccg-crit\t-app\debug\agentcodegui.exe` · sha256 `8a15664d485ea3f7bd8a0de0c9a5344a116e32fb4fa8d2a8e4c01dfc6d1a7ce0` (`--features custom-protocol`) |
| 앱 exe(대조군 ③처방 제거) | `D:\ccg-crit\t-ctl3\debug\agentcodegui.exe` · sha256 `02333c456afbc077002fed5e6b336dca5b70ef439a86dfadeadb4035196fde90` |
| 가짜 CLI | `D:\ccg-crit\t-app\debug\ccg-fakecli.exe` · sha256 `d9345c6c3d88db78e7c4d898cda17b2e469323231d6290ffbd8496ed62608f82` |
| 격리 홈 | `D:\ccg-crit\home-b3` · `home-ff-ctl` · `home-ff-ctl-nohub` · `home-ff-head-nohub` · `poc-home-engine` · `C:\Code\AgentCodeGUI\.crit-home-r28i-locks` |
| CDP 포트 | **10860~10872**(LOCKS 크리틱 대역). R28h의 10700대·OPENDIR의 10800대와 안 겹친다 |
| 내 계기(레포 밖) | `D:\ccg-crit\crit-banner.mjs`(배너를 **화면에서** 읽는다) · `D:\ccg-crit\crit-firstframe.mjs`(부팅 첫 프레임 궤적을 10ms로 훑는다) |
| 안전 | 실앱·실홈·실계정 접촉 0(합성 계정 + `CCG_NO_NET=1`) · 이름 기반 kill 0(내가 spawn한 PID 트리만) |

---

## 2. 체크리스트 실측표

| # | 물음 | 내 실측 | 판정 |
|---|---|---|---|
| 1 | ①의 새 못이 **배선**을 잡는가 (돌연변이 D) | `retrying(\|\| snapshot_children(pid))` → `snapshot_children(pid).unwrap_or_default()` · `t-mutd` · **3/3 붉음 · 168 passed / 2 failed** | **통과** |
| 2 | ①이 기존 자물쇠를 안 깼는가 | 돌연변이 A(`kill_wrapped_child` no-op) → **2 붉음**(R28g 못 + 새 못) · 돌연변이 B(`wrapped` 비트 무시) → **정확히 1 붉음**(자기 못만) | **통과** |
| 3 | ②의 새 못이 자물쇠 **안** Blind를 지나는가 | 자식 장부 `자물쇠안=1 · 근거못짚음=1 · 지연=0` **5/5 재현** · 두 줄 제거 → **3/3 붉음** · `blind_line`만 제거 → 붉음(「제품 줄 0개」) | **통과** |
| 4 | ②의 doc이 사실인가 | ②직전(`1ec1964`)+두 줄 제거 = **125 passed 0 failed**(doc의 숫자와 글자 그대로 일치) · R28g 못은 그 판에서 **10/10 초록** = 「자물쇠 밖만 잰다」가 참 | **통과** |
| 5 | ③이 닫혔는가 (**앱을 실제로 띄워** 화면에서 읽기) | HEAD 앱 화면 = 「이 한도 창에서 **자동으로 12번** 이어서 보냈는데 계속 막혔어요 — **눌러서 이어가기**」 + 「이어가기」 버튼 · 「곧 이어서 계속해요」 **0회** · ccg-store 못 92/대조군 91+1 | **통과**(단 §5-B) |
| 6 | WFIRE 무후퇴 | 엔진 `wcap_limit_streak` **18/18** — 71축 **2발**·밤샘 **7발 안 접힘**·헛발질 **2발 ready+auto_paused** · 앱 접힘 하네스 **9/9**(fires 12가 재시작을 넘고 전송 0) · `poc-limit-resume.mjs` **357 통과 0 실패** | **통과** |
| 7 | 게이트 안정 | `-p agentcodegui --bin agentcodegui --features custom-protocol` **10회 연속 초록 · 매회 170** · `cargo test --workspace` **exit 0 · 3/3 · 798 passed 0 failed 13 ignored** · 타입체크 3종 초록 | **통과** |
| 8 | 커밋이 셋으로 갈렸나 · 남의 hunk | `15c6d6f`(accounts.rs 1파일) · `5d6b5a2`(status.rs 1파일) · `7f9798f`(claude.rs+m11r4 2파일) · `668ac7e`(보고서 1파일) — **전부 LOCKS 소유 경로 · 섞인 hunk 0** | **통과** |

### 크레이트별 수(내 깨끗한 워크트리 · 미추적 프로브 없음)

| 크레이트 | 기준선 | 내 실측 | 차 |
|---|---|---|---|
| agentcodegui | 161 | **170** | +9 = LOCKS 3 + 같은 트리 OPENDIR 6 |
| ccg-auth (`-p ccg-auth`) | 125 | **126** | +1 = ② 새 못 |
| ccg-auth (workspace = `net` 통합) | — | **143** | `net` 전용 테스트 17개가 더 붙는다 |
| ccg-engine | 233 | **233** | 0 |
| ccg-fs | 101 | **101** | 0 |
| ccg-lsp | 59 | **59** | 0 |
| ccg-store | 90~91 | **92** | +1 = ③ 새 못 |
| **workspace 합** | 805 | **798 passed / 13 ignored** | §5-C |

---

## 3. ①·② — 진짜로 닫혔다

**① GATE.** 돌연변이 D의 붉은 첫 줄이 사고를 그대로 말한다 —
`★첫 스냅샷이 흔들렸다고 래퍼 안의 프로그램을 놓쳤다(pid 15424의 자식): [2412] · 남은 고장 2`
그리고 `★상한이 4가 아니다(남은 고장 13)`. R28g가 남긴 정책 못만으로는 5/5 초록이던 자리가,
이제 **배선이 끊기면 즉시 붉는다.** 곁가지(`walk_ended`)도 살아 있다: 돌연변이 A·B에서
기존 취소 못 둘이 각각 제 몫만 붉었다 = 재시도 처방이 취소의 다른 두 축을 안 물들였다.

**② NAIL.** 새 못은 **정말로 자물쇠 안**에 착지한다(자식 장부 `자물쇠안=1`, 5/5 재현·
`--workspace`에서도 초록). 그리고 **두 줄이 각각** 잠겼다 — 카운터를 지우면 자식이,
`blind_line`을 지우면 부모가 붉는다.

doc 정정도 실측으로 맞다. ②직전 커밋에서 자물쇠 안 두 줄만 지우면 `cargo test -p ccg-auth`가
**125 통과 0 실패** — 보고서가 적은 그 숫자 그대로다. 같은 판에서 R28g 못은 **10/10 초록**이라
「그 못은 자물쇠 밖 갈래를 잰다」가 참이다. 인용된 k6 수치(12,700판 · 안 262 · 밖 0 · 2.06%)는
`docs/critic/r28g-nail-critic-r1.md`의 §K6과 글자 그대로 일치한다 = 지어낸 숫자가 아니다.

`ignore` 프로브는 안 남겼다(보고서가 그 대안을 왜 버렸는지 적어 뒀고, 나는 그 판단이
근거 있다고 본다 — 안 도는 못은 지금의 무방비와 같다). 손잡이 `bury_rehearsal`은
**기본 0**이고 상한 5,000ms이며 켜질 때 stderr 한 줄을 남긴다는 것을 코드와 주행으로 확인했다.

---

## 4. WFIRE — 후퇴 0

```
[WCAP①] 창 이동 재개 7회 · hold{ready:false, auto_paused:false, attempts:0}   ← 밤샘 안 접힘
[WCAP③] 헛발질 2회 · hold{ready:true, auto_paused:true, attempts:2}           ← 헛발질 2발
[WCAP⑤ ping|thinking_delta|message_start|…8종] 12시간 2회 · attempts 2 · ready true · auto_paused true
                                                                              ← 71축이 2발
wcap_limit_streak : 18 passed 0 failed
poc-limit-resume  : PASS — 357 통과, 0 실패 (N절 두 축 궤적 = 엔진 ⑰⑱과 같다)
앱 접힘 하네스(내 exe·내 홈·포트 10870) : PASS — 9 통과 0 실패
   F2 예산이 재시작을 넘는다(심은 12발이 그대로) · F5 전송 0 · F7 조회 0 · F8 접힌 채 유지
```

---

## 5. 남은 결함

### A. (등급 **하**) ③의 못은 렌더러 문법을 **Rust 안에 손으로 다시 적어** 잰다

`status.rs`의 `a_folded_table_still_gets_the_button_…` 안 `says` 클로저는 `Chat.tsx`
`LimitHoldBar`의 갈림을 베껴 쓴 것이다. `Chat.tsx`가 바뀌어도 이 못은 초록으로 남는다
(못의 doc은 "재는 것은 필드가 아니라 **화면 문구**"라고 적는다 — 화면은 안 뜬다).

**재현 절차**: `app/src/components/Chat.tsx:3347`의 「곧 이어서 계속해요」를 아무 문자열로
바꿔라 → `cargo test -p ccg-store` 92 초록 그대로. 진짜 화면을 재는 계기는 이 크리틱이
만든 `D:\ccg-crit\crit-banner.mjs`뿐이고, 그건 레포 밖에 있다.

### B. ★ (등급 **중**) ③이 「고쳤다」는 그 화면은 **대조군에서도 거짓말을 안 한다**

보고서·커밋 메시지·`status.rs` 주석이 셋 다 같은 문장을 적는다 —
*"화면은 「한도가 풀렸어요 — 곧 이어서 계속해요」라고 적고 「이어가기」 버튼을 안 준다.
… 사용자에게는 출구가 없다."* 나는 그 배치를 실앱으로 세워 **처방을 뺀 exe로도** 읽었다.

```
배치: status.json 없는 격리 홈 + 채팅 파일 하나(ready:true · fires:12 · paused:true · resetsAt −2h)
      · 자동 이어서 토글 켬 · 활성 채팅

HEAD    (t-app  · 8a15664d…) 화면 = 「… 자동으로 12번 … — 눌러서 이어가기」 + [이어가기]   ← 옳다
대조군  (t-ctl3 · 02333c45…) 화면 = 「… 자동으로 12번 … — 눌러서 이어가기」 + [이어가기]   ← **똑같이 옳다**
        같은 exe의 부팅 행 : autoResume=false · hold{ready:true,fires:12,paused:true}
10ms 궤적(crit-firstframe.mjs) : 대조군에서 「곧 이어서 계속해요」를 본 횟수 **0**,
                                 행이 autoResume=true였던 순간 **0**
```

**왜 안 뜨나**(코드로 확인):

1. `engine::boot()`의 순서는 `load_boot` → `hub::start` → `reload_pending` → 첫 `chat:status`다.
   전부 **창이 생기기 전**이다.
2. `hub::call`은 `rx.recv_timeout`으로 **동기 왕복**이다(`hub.rs:160`). 즉 `reload_pending`이
   돌아올 때는 런타임 행이 이미 `status::set`으로 앉아 있다.
3. `reload_candidates`는 `status.json`이 아니라 **채팅 파일**을 본다(`status.rs:423`,
   `truth_from_chat_file`). 그러므로 **③의 처방이 의미를 갖는 행(=`hold.paused`가 참인 행)은
   빠짐없이 재장전 후보**이고, 그 행은 반드시 `engine::lite::build`의
   `rt.auto_resume() && !hold.auto_paused`로 덮인다.

즉 `row_from_disk`의 `autoResume`이 화면에 닿을 창은 **부팅 함수 안에서 닫힌다**.
내가 그 거짓말을 실물로 세운 유일한 방법은 귀속 팔을 켜는 것이었다:

```
CCG_NO_ENGINE_HUB=1  대조군 : +370ms 「사용 한도에 도달했어요 / 한도가 풀렸어요 — 곧 이어서 계속해요」 · 버튼 없음
CCG_NO_ENGINE_HUB=1  HEAD   : +406ms 「… 자동으로 12번 … — 눌러서 이어가기」 · 버튼 있음
```

**그래서 무엇인가.** 처방 자체는 옳다(부팅 행이 런타임 규칙과 같은 말을 하게 됐고, 못도
그 행을 정확히 잠근다). 회귀도 없다. 다만 **이 라운드가 스스로 세운 기준**(「제품은 정직한데
게이트가 그걸 안 잡는다」)에서 ③만은 반대다 — 잡을 사고가 화면에는 없었다. 다음 사람이
`status.rs`의 그 주석을 읽고 「출구가 없던 화면을 고친 자리」로 믿으면 그게 다음 라운드의
잘못된 지도다.

**재현 절차**(내 계기 그대로):
```
node D:\ccg-crit\crit-banner.mjs --exe=<③처방 뺀 exe> --home=<빈 홈> --port=10865 --out=<…>
  → B2/B3/B4 전부 PASS = 처방 없이도 화면이 옳다
CCG_NO_ENGINE_HUB=1 node D:\ccg-crit\crit-firstframe.mjs --exe=<같은 exe> …
  → 「곧 이어서 계속해요」가 그때만 뜬다
```

### C. (등급 **하**) 「816 passed」는 남의 미추적 프로브 18개를 안고 있다

보고서는 *"미추적 `probe_wfire_crit.rs`·`probe_wfr2.rs`는 … 수에서도 뺐다"*고 적고
workspace 합계를 **816**으로 보고한다. 미추적 프로브가 없는 내 워크트리에서 같은 명령은
**798 passed / 0 failed / 13 ignored**다. 798 + 18 = 816 — 즉 보고된 총계는 그 18개를
포함한 값이다(기준선 805도 같은 이유로 18을 안고 있어 「805 + 5 + 6 = 816」 산수는 맞는다).
숫자가 틀렸다기보다 **분모가 두 종류**라는 것을 표가 말하지 않는다.

**재현**: 깨끗한 워크트리(`git worktree add --detach <경로> 668ac7e`)에서
`CARGO_TARGET_DIR=<새 경로> cargo test --workspace` → 798.

### D. (등급 **하** · 사고 기록) 내가 한 번 **거짓 결함**을 만들 뻔했다

첫 workspace 주행이 4/4로 ②의 새 못에서 붉었고, 나는 그것을 「`net` 피처에서만 침묵한다」로
읽을 뻔했다. 원인은 제품이 아니라 **내 워크트리에 돌연변이 B(`blind_line` 제거)가 남아
있던 것**이었다. 되돌린 뒤 같은 명령은 3/3 초록(798)이고,
`cargo test -p ccg-auth --features net --test m11r4_store_cas`도 **16 passed 0 failed**다.
기록해 두는 이유: 돌연변이를 되돌리는 것은 target 디렉터리를 가르는 것만큼 중요한 규율이고,
이 라운드의 규칙표에는 그 줄이 없다.

---

## 6. 진짜로 닫힌 것 (공정하게)

* ①의 못 둘은 **제품 배선을 지난다**. 돌연변이 D가 3/3 붉고, 기존 취소 못 둘은 각자 제 축만 지킨다.
* ②의 못은 **자물쇠 안**에 착지한다(계수로 증명). 두 줄이 **각각** 잠겼다.
* ②의 doc 정정은 **실측이 뒷받침한다** — ②직전+돌연변이 = 125/0, R28g 못 10/10 초록.
* ③의 부팅 행은 이제 런타임과 **같은 규칙**을 쓴다. 대조군 못이 그 한 칸을 정확히 잡는다(91+1).
* WFIRE 여섯 축 전부 후퇴 0. 게이트 10/10, workspace 3/3, 타입체크 3/3.
* 커밋 셋 + 보고서 하나. 남의 hunk 0.

---

## 7. 내가 만진 것

* **레포 코드 수정 0.** 돌연변이·대조군은 전부 `D:\ccg-crit\wt*`의 **분리 워크트리**에서만 살았고,
  다 잰 뒤 원복했다(`git status` 깨끗 · 워크트리는 남겨 둔다 — 다음 라운드가 지워도 된다).
* 이 파일 하나만 쓴다: `docs/critic/r28i-locks-critic-r1.md`.
* 기준 결과 파일은 하나도 안 덮었다(`--out`은 전부 `D:\ccg-crit\` 아래).
* 사용자 실홈·실계정: 읽기도 쓰기도 0. 토큰 회전 0(`CCG_NO_NET=1` · 합성 자격증명).
* 죽인 프로세스: 내가 spawn한 앱 PID 트리 6개뿐(이름 기반 kill 0).
