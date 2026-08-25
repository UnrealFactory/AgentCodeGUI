# R28g 「BANNER」 확인 크리틱 R1

> **판정: 합격(pass).** 체크리스트 일곱 칸 전부 내 손의 실측에서 초록이다.
> F1은 **진짜로 닫혔다** — 앱이 스스로 12발을 태워 접은 표를 들고 껐다 켰을 때, 실제 화면이
> 「이 한도 창에서 자동으로 **12번** 이어서 보냈는데 계속 막혔어요 — 눌러서 이어가기」를
> 버튼과 함께 그린다. 같은 홈·같은 대본을 **부모 트리 exe**에 물리면 그 자리에서
> 「한도가 풀렸어요 — 곧 이어서 계속해요」가 버튼도 없이 되살아난다(실앱 관찰 130초 0발 ·
> 부모 트리 프로브로는 12시간을 밀어도 재판정 자체가 없다). 남은 것은 **C급 한 칸**뿐이다: 부팅 행의 `autoResume`가
> `empty_lite`에서 상수 `true`라, 그 채팅의 행이 `status.json`에 없고 허브 lite가 늦으면
> 접힌 표가 다시 「곧 이어서 계속해요」로 선다(허브가 도는 정상 부팅에서는 관측 안 됨).

---

## 1. 무엇으로 쟀나 — 계기와 격리

빌더의 보고서·커밋 메시지는 **근거로 쓰지 않았다.** 빌드·계기·홈·주행을 새로 만들었다.

| 항목 | 값 |
|---|---|
| 판정 대상 | `f5bce57`(R28g BANNER R1) — 측정 중 다른 갈래가 커밋해 트리 HEAD는 `ae53d19`가 됐지만, `git diff f5bce57..HEAD -- <BANNER 경로 전부>`가 **빈 diff**라 내 측정은 현재 트리와 같다 |
| 워크트리(HEAD) | `C:\Temp\ccg-r28gbc\head` — `git worktree add --detach … f5bce57`(공용 워킹트리를 한 바이트도 안 건드린다 · 남의 미커밋 변경 0회 접촉) |
| 워크트리(대조군) | `C:\Temp\ccg-r28gbc\ctl` — 같은 방식으로 `127d9db`(=`f5bce57^`) |
| HEAD exe | `C:\Temp\ccg-r28gbc\tgt-head\release\agentcodegui.exe` sha256 `23d206bf3b0de7c37d91ae4153ff2eea93cf9cc297ccae2691bb6b68ee532b2f` (`npm run app:build` → `cargo build --release --features custom-protocol`) |
| **대조군 exe** | `C:\Temp\ccg-r28gbc\tgt-ctl\release\agentcodegui.exe` sha256 `abd9d9fee68d22b7069ab4bb6a8000fb264bb3e708e6dca00faf51ab8d2fdd12` — **새 `CARGO_TARGET_DIR`**(`tgt-ctl`, 재활용 0) |
| 가짜 CLI | `ccg-fakecli.exe` `164c50b1…6f4a43d` · `ccg-fakecodex.exe` `7201625e…a0359525` |
| 대조군 프로브 target | `C:\Temp\ccg-r28gbc\tgt-ctl-probe`(세 번째 디렉터리 — 부모 트리 러스트 프로브 전용) |
| 격리 홈 | `C:\Temp\ccg-r28gbc\home-{burn,boot-head,boot-ctl,boot-nohub,fold-fresh,fold-fresh2,ready-h,ready-c,press,eng,eng2,long,cx,smoke}` — 사용자 실홈(`%USERPROFILE%\.agentcodegui`) **접촉 0회** · 실계정 자격증명 0줄 · `CCG_NO_NET=1` |
| CDP 포트 | 10660 · 10665~10679 (BANNER 크리틱 = 10610+50 대역) |
| kill | 전부 `taskkill /PID <내가 spawn한 pid> /T /F` — **이름 기반 kill 0회** · 주행 뒤 내 exe 잔여 프로세스 0 |
| 기준 파일 | 덮어쓴 것 **0** — 내 산출물은 전부 `C:\Temp\ccg-r28gbc\out\*.json`(레포 밖) |

**내가 새로 쓴 계기 넷**(빌더 하네스를 물려받지 않았다):

| 계기 | 무엇 |
|---|---|
| `crit-burn.mjs` | **앱이 스스로 예산 12발을 태우게** 만든다. 과금 축을 API 키로 두어(`limit_probe`의 첫 문이 `Clear`) `CCG_NO_NET`에서도 실발사가 일어나게 하고, 가짜 CLI 대본을 1초마다 다시 써서 한도 문구의 epoch이 늘 「지금+6초」가 되게 한다(= 매 착지가 「창이 넘어갔다」라 연속 계수는 0, **예산만** 쌓인다) |
| `crit-screen.mjs` | **배너를 실제로 렌더해 문장을 화면에서 읽는다** — `.limit-hold .lh-sub` 텍스트와 `.lh-go` 버튼을 100ms 간격 + MutationObserver로 기록 |
| `zz_crit_banner_probe.rs`(+`_ctl`) | 엔진 축 10칸(대본·눈금·단언 새로 씀 · `WALL` 상수도 빌더와 다른 값). 부모 트리에서 짝 파일이 돈다 |
| `crit-renderer.mjs` | 렌더러 실소스를 esbuild로 묶어 **디스크 표 여섯 모양**을 먹인다(두 축 재시작 규칙 비교) |

> 미추적 프로브(`probe_wfire_crit.rs`·`probe_wfr2.rs`)는 남의 계기라 **워크트리에 아예 없다**
> (내 카운트에서 자동으로 빠진다). 내 프로브 파일도 워크트리 밖으로 나가지 않았다.

---

## 2. 체크리스트 실측

### ① F1이 닫혔는가 — **초록**(실제 exe · 실제 화면)

**앱이 스스로 태웠다.** 예산 0에서 시작해 `crit-burn`이 관찰만 하는 동안 실앱이 12번 이어서
보냈고(96초 간격 · `spawns` 1→12 · `attempts` 내내 0 = 예산 착지의 정의) t=1239초에 접혔다:

```
t=95s fires=1 … t=1143s fires=12 → ★ 접혔다 t=1239s
디스크: {"resetsAt":1787664296.0008285,"ready":true,"paused":true,"attempts":0,"fires":12}
```

그 홈을 **껐다 켜서 화면을 읽었다**(같은 홈 사본 · exe만 갈아 끼운 대조군):

| exe | 배너 문장(`.lh-sub`) | 「이어가기」 | 130초 발사 | 부팅 뒤 디스크 행 |
|---|---|---|---|---|
| **HEAD** `23d206bf…` | **「이 한도 창에서 자동으로 12번 이어서 보냈는데 계속 막혔어요 — 눌러서 이어가기」**(+0.5s) | **있음** | 0 (`asks` 0) | `{ready:true,**paused:true**,attempts:0,fires:12}` |
| **부모** `abd9d9fe…` | 「**한도가 풀렸어요 — 곧 이어서 계속해요**」(+0.7s) | 없음 | 0 (`asks` 0) | `{ready:true,attempts:0,fires:12}` — **`paused` 칸이 부팅 한 번에 지워진다** |

「풀렸어요」는 HEAD 화면 어디에도 없다. 부모 트리에서는 그 거짓말이 **그대로 재현**되고,
게다가 부모 쪽 문장은 「곧 이어서 계속해요」 = *지키지 못할 약속*이면서 **버튼도 없다**
(`press = ready && auto !== true`인데 부모는 `auto_paused`를 잃어 와이어 `autoResume`가 `true`).

**출구도 실물로 확인했다** — 화면의 그 버튼을 CDP로 **실제 클릭**: `spawns 0→1` ·
가짜 CLI `stdin.log` **3756바이트** · 표 소진 · `episodeFires` 0으로 복귀 · 배너 사라짐.
접힘은 막다른 방이 아니다.

### ② 디스크 행이 진실을 담는가 — **초록**(`engine:debug`가 아니라 파일)

`chats-v3/c-crit-burn.json`을 파일로 직접 읽었다(위 표의 마지막 칸). 네 칸 전부:
`paused true` · `ready true` · `fires 12` · `attempts 0`. **부팅 뒤에도** 같은 값으로 다시 쓰인다
(HEAD). 부모 exe로 부팅하면 같은 파일에서 `paused`가 **사라진다** — 재시작 두 번이면 그 사실은
영영 복구 불가다.

### ③ `check_hold`의 `ready` 필터 처방이 실제로 도는가 — **초록**

`ready:true` · 안 접힘 · 자동 켬 표를 심고 **같은 홈**을 두 exe에 물렸다(관찰 170초):

| exe | 배너 문장 | 실제 발사 | `limitProbe.asks` |
|---|---|---|---|
| **HEAD** | 「한도가 풀렸어요 — 곧 이어서 계속해요」(+1.3s) → **+91초에 배너가 사라짐** | **1발**(`spawns 1` · `fires 0→1`) | **1** |
| **부모** | 같은 문장(+1.5s) · 끝까지 그대로 | **0발** | **0** |

즉 통행권(`LimitHold::reloaded`)은 도달 불가 코드가 아니라 **제품 경로에서 실제로 돈다**.
엔진 프로브에서도 통행권은 정확히 한 장이다(§C2).

### ④ WFIRE 무후퇴 전량 — **초록**(내 프로브 10칸 · 부모 트리 대조군 2칸)

`zz_crit_banner_probe.rs`(HEAD, `tgt-head`) / `zz_crit_banner_probe_ctl.rs`(부모, **새** `tgt-ctl-probe`):

| 축 | HEAD | 대조군 |
|---|---|---|
| C1 접힌 표 재장전 | 첫 프레임 `paused=true·fires=12`(예산문구 참) · 12h **0발** · `ready` 유지 | 같은 바이너리·칸만 false → 첫 프레임 거짓 / **부모 트리: 12h 뒤에도 `paused=false`**(영영 재판정 없음) |
| C2 통행권 | `ready`+자동 **1발** · `ready:false` **1발** · 화면 밖 **0발**(ready 유지) · 접힘 **0발**(ready 유지) | 부모: `ready`+자동 **0발** · `ready:false` 1발 |
| C3 예산이 재시작을 넘는가 | 12발 표 → 20h **0발** | 같은 바이너리·예산 칸만 0 → **3발** / 부모(=R28f 포함) → 0발 |
| C4 밤샘(창 이동) 12h | **7발** · `attempts 0` · 안 접힘 | 부모 동일(7발) |
| C5 헛발질 | **2발** → `ready+auto_paused+attempts 2` | 부모 동일(2발·접힘) |
| C6b 60시간 경계 | 5시간 창·4.5시간 작업 → **65.0시간·12발**에서 접힘 | — (코드 주석의 「약 60시간」과 같은 눈금대) |
| C9 71 축 12시간 대본 셋 | 즉사 **2발** · 배너형+산출 **2발** · 배너형 빈손 **2발**(전부 접힘) | — |
| C7 옛 파일(`paused` 칸 없음·12발) | 첫 프레임 false(=회귀 0) → 재판정이 근거만으로 **다시 접음** · 0발 | 부모: 재판정 자체가 없다 |
| C8 재시작 3회(11발 표) | 총 **1발**(1→0→0) · 그 뒤 접힘 유지 | — |

> ★「HEAD 0발 vs **부모 4발**」의 「부모 4발」은 R28f 확인 크리틱이 잰 **pre-WFIRE** 트리의 값이다.
> 이 라운드의 부모(`127d9db`)는 WFIRE를 이미 담고 있어 **부모도 0발**이고, 그것이 곧 무후퇴다.
> 판별력은 「같은 바이너리·예산 칸만 0 → 3발」이 진다(내 대본은 20시간에 창 셋이라 4가 아니라 3이다).

**두 축 궤적**(체크리스트의 「대본 6 × 3칸」) — 렌더러 실소스에 같은 여섯 디스크 표를 먹였다:

| 디스크 표 | HEAD 렌더러 `sanitizeHold` | 버튼 | 부모 렌더러 |
|---|---|---|---|
| S1 12발·접힘 | `paused=true ready=true fires=12` → 「…12번…막혔어요」 | 있음 | `paused=false ready=false` → 「약 N 뒤 자동으로」 |
| S2 헛발질·접힘 | `paused=true ready=true att=2` → 「…계속 한도에 막혔어요」 | 있음 | 같은 손실 |
| S3 옛 파일(12발) | `paused=false` + 예산 12 계승(엔진 C7과 같은 답으로 수렴) | 없음 | 동일 |
| S4 화면 밖 ready | `ready` 안 되살림(설계 그대로) | 없음 | 동일 |
| S5 11발 | 예산 계승 | 없음 | 동일 |
| S6 24시간 초과 | **표 폐기** | — | 동일 |

엔진 축(C1·C2·C7)과 렌더러 축(S1·S2·S3)의 답이 같다. 다만 **렌더러 축은 실앱에 호출자가 없다**
(§3 D-1) — 규칙 수준의 파리티이지 화면의 파리티가 아니다.

### ⑤ 화면에 보이는 채팅(`autoResume:true`) 쪽 문구 — **초록**(선재 결함 해소됨)

③의 표가 그 답이다. HEAD에서 「곧 이어서 계속해요」는 **91초 뒤 실제 전송으로 지켜진다**
(약속을 지키는 문장 = 참). 부모에서는 같은 문장이 170초 내내 0발 · `asks` 0 —
R28f 크리틱이 잰 「20시간 0발」이 **부모 exe로 재현**된다. 즉 이 칸의 절반이 선재 결함이었다는
지적은 맞고, **그 선재 결함이 이 라운드에서 닫혔다**(빌더가 자기 몫 밖까지 고친 셈이다).

접힌 표 쪽 문구도 정확하다: 와이어 `autoResume`가 `false`로 접혀(`lite.rs`) `press`가 참이 되고,
그래서 화면이 예산 문장 + 버튼을 그린다(①의 실측).

### ⑥ 회귀 게이트 — **초록**(전부 내 손으로 재실행)

| 게이트 | 내 실측 | 빌더 주장 |
|---|---|---|
| `poc-limit-resume` | **357 / 0** · **5회 반복 전부 동일**(결정적 계산 하네스라 플레이키 0) | 357/0 ✓ |
| `poc-limit-engine`(기본) | **14 / 0** | 14/0 ✓ |
| `poc-limit-engine --seed-fires=12 --seed-attempts=2` | **14 / 0**(E11 12/12 · E12 2/2 · E13 파일에 두 칸) | 14/0 ✓ |
| `poc-limit-engine --long` | **17 / 0** | 17/0 ✓ |
| `poc-limit-codex` | **8 / 0** | 8/0 ✓ |
| cargo `ccg-engine` | **233 / 0**(2 ignored) · 그중 `wcap_limit_streak` **18 / 0** | 「추적본 233」 ✓ |
| cargo `ccg-store` | **91 / 0** | 91/0 ✓ |
| cargo `agentcodegui`(`--features custom-protocol`) | **159 / 0** | 「161/0」 ✗ — §3 D-3 |
| typecheck node · web · app | **3종 exit 0** | ✓ |
| 내 프로브 | HEAD **10 / 0** · 부모 트리 **2 / 0**(대조 측정) | — |

### ⑦ 커밋 경계 — **초록**

* `f5bce57`가 담은 16파일에 남의 파일 **0건**. `docs/critic/*.json` 6개는 전부 **신규 추가(A)** — 기준 파일 덮어쓴 것 0.
* `git show f5bce57 -- crates/ccg-engine/src/runtime.rs | grep -i 'talk|ipc::|accounts.rs|critic-m10'` → **0건**.
* 미추적 프로브(`probe_wfire_crit.rs`·`probe_wfr2.rs`) 커밋 **안 됨**.
* 경계 밖 1건(`src-tauri/src/engine/mod.rs` 4줄)은 빌더가 **스스로 신고**했고, 그 4줄이 없으면 다리가 끊긴다는 주장도 사실이다(`ReloadHold::paused`를 채우는 유일한 자리).
* `app/src/components/Chat.tsx`·`useLimitResume.ts`는 **한 줄도 안 고쳤다** — 커밋 파일 목록으로 확인.

---

## 3. 남은 결함

### C-1 (C급) 부팅 행의 `autoResume`가 상수 `true` — 접힌 표가 다시 「곧 이어서 계속해요」로 설 수 있다

이 라운드는 부팅 행의 `paused`를 진실로 만들었지만, **문장을 고르는 다른 한 칸**은 그대로다.
`LimitHoldBar`의 갈림은 `press = managed.ready && managed.auto !== true`이고, 그 `auto`는
`ccg_store::status::empty_lite`가 **상수 `true`**로 싣는다(`status.rs:178`). `status.json`에 그
채팅의 행이 있으면 마지막 lite의 `autoResume:false`가 살아 있어 문장이 옳지만, **행이 없으면**
(마이그레이션 직후 · `status.json` 유실 · 그 채팅이 이 홈에서 한 번도 안 돈 경우) 부팅 행은
`paused:true`인데도 `auto:true`라 화면이 **「한도가 풀렸어요 — 곧 이어서 계속해요」**를 그리고
**버튼도 없다**.

* 재현(실측): `status.json`이 없는 홈에 접힌 표(`ready:true,paused:true,fires:12`)를 심고
  `CCG_HOME=…\home-fold-fresh CCG_NO_ENGINE_HUB=1`로 기동 →
  와이어 `{ready:true,fires:12,paused:true}` + `autoResume:true` → 화면 30초 내내
  「한도가 풀렸어요 — 곧 이어서 계속해요」·버튼 없음. 같은 홈에서 **허브를 켜면** +0.5초에
  이미 옳은 문장(「…12번…」+버튼)이다.
* 등급이 C인 이유: 허브가 도는 정상 부팅에서는 내 계기(100ms 해상도 · 설치 +0.5초)로 **한 번도
  관측되지 않았다**. 다만 「부팅 행이 첫 프레임의 진실을 맡는다」(보고서 §본선의 근거 문장)는
  **조건부**다 — 진실을 맡는 것은 `hold` 세 칸이고 `autoResume`는 아니다.
* 고치는 값싼 길: `truth_from_chat_file`이 `hold.paused`를 아는 자리에서 `autoResume`도 함께
  접거나(`paused`면 false), `empty_lite`의 상수를 `hold`가 있을 때만 접는 것.

### D-2 (D급 · 빌더 신고와 일치) 렌더러 축 `sanitizeHold` 변경은 실앱 도달 불가

`app/src/lib/limitResume.ts`의 접힘 복원은 규칙으로는 옳고 내 §④ 표가 그것을 확인했지만,
본채팅은 `resumeOwner:"engine"`이라 `managed` 갈래만 돈다(내 네 번의 실앱 주행에서 와이어
`resumeOwner`는 항상 `"engine"`). 빌더가 §미완이 아니라 함수 주석에 **스스로 적어 두었고**
그 판단(파리티를 위해 남긴다)에 나는 반대하지 않는다. 다만 **이 라운드의 「두 축을 다시 같게」는
화면에 영향이 0**이라는 사실은 보고서 표에서 잘 안 보인다.

### D-3 (사실 정정) 빌더의 `agentcodegui 161/0`은 남의 미커밋 테스트를 포함한 값

내 클린 워크트리(`f5bce57` 그대로)에서는 **159/0**이다. 차이는 측정 시점 공용 워킹트리에 있던
이웃의 미커밋 변경(`src-tauri/src/engine/talk.rs`·`ipc/accounts.rs`)이 더한 테스트 2개다.
BANNER의 작업과 무관하고 무해하지만, 「내 커밋의 수치」로 인용된 값은 아니다.

### D-4 (기록) 빌더가 신고한 미완 넷은 내 확인에서도 사실이다

「화면 안팎 전환 재판정 없음(도달 불가 — `set_auto_resume` 호출자는 `Op::Reload` 하나)」·
「`ma:dispose`가 표·예산을 잃는다」·「`probes` 미영속(접힘이 살아 오므로 현재 실손해 0)」·
「`docs/parity-fix-wfire-r2.md` §미완 2의 「분 단위」 미정정」 — 코드 읽기로 전부 확인했고,
그중 셋은 이 라운드의 경계 밖이다. **「배너 문구의 픽셀은 안 봤다」(미완 4)는 이 판정문이
대신 갚았다** — 그 결과가 §①이고, 다행히 빌더에게 유리한 방향이었다.

---

## 4. 내가 만진 것

* **레포 코드 수정 0.** 이 판정문(`docs/critic/r28g-banner-critic-r1.md`) 한 파일만 추가하고
  `git commit --only` 그 경로로 커밋했다.
* 빌드·주행·프로브는 전부 **`C:\Temp\ccg-r28gbc`**(격리 워크트리 둘 + target 셋 + 격리 홈 14개)에서 했고,
  공용 워킹트리의 파일은 **읽기만** 했다. 남의 미커밋 변경에 `reset`·`checkout`·`stash`·`restore` 0회.
* 사용자 실홈·실계정 접촉 0회 · HTTP 0건(`CCG_NO_NET=1`) · 이름 기반 kill 0회.
