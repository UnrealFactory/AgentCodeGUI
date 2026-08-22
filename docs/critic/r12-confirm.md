# R12 확인 크리틱 — 배선 R2(`1b2171d`) · M5 R2(`c079304`)

**임무**: 두 빌더의 "고쳤다" 주장을 **빌더 실행을 믿지 않고 독립 재실행**해 확인/불일치를 가른다.
빌더의 산출물 JSON은 증거로 쓰지 않았다 — 하네스를 내가 다시 돌려 나온 값만 적는다.

---

## 0. 판정

| 갈래 | 판정 |
|---|---|
| **배선 R2**(`1b2171d`) | **확인.** A~F·dialog·winsave·별칭 S1~S4 전부 재현 green. R1이 치명으로 든 E·F(외부 CLI 사망 = m-logic P8)가 **5초 안에** 정착하고 사유가 화면에 뜬다. T22 백스톱의 반대 방향("살아 있으면 절대 정착 안 함")도 132초 실측으로 확인. **불일치 0건.** |
| **M5 R2**(`c079304`) | **확인.** 5건 전부 크리틱 도구로 재현됐다. 오염가드 순서 의존 소멸(양방향 Contaminated)·reorder 중복 레코드 3/3 유지·usage 71/71 일치(R1: 12 불일치)·version 3.0/2.0 관대성·캐시 4키·2.6.2 리더 `allRunnable=true`. **불일치 0건.** |

남은 위험 6건은 §4. **그중 제품 결함은 0건이고, 하네스/설계 경계 문제다.** 가장 값어치 있는 것은
R-1(공격 E의 전제가 3회 중 1회 무너지고, 무너진 회차가 산출물에 **초록으로 남는다**)과
R-2(T22가 잡는 것은 "죽음"이지 "행(hang)"이 아니다 — 이번 백스톱 시험이 증명한 무결점과 같은 코인의 뒷면).

---

## 1. 측정 조건 — 무엇으로 쟀나

빌더 3명이 동시에 커밋 중이라 **시작 시점 HEAD를 핀**으로 박고 그 스냅샷만 썼다.

- 핀: `96486fd`(내 착수 시점 HEAD). 착수 직후 다른 빌더가 `561cedb`를 올렸으나 **pull하지 않았다.**
- `git diff 1b2171d..96486fd -- src-tauri crates app` = **빈 diff.** 즉 내가 잰 바이너리는
  판정 대상 커밋 `1b2171d`와 **코드 동일**하다(96486fd는 문서·벤치·m5 드라이버 lockfile뿐).
- 격리 워크트리: `%TEMP%/ccg-r12-wt`(detached `96486fd`) + `node_modules` 정션.
  **모든 하네스를 이 워크트리에서 돌렸다** — `bench/results/*`·`docs/critic/*.json` 등
  공용 기준 파일을 건드릴 경로가 애초에 없다(메인 레포 수정 0건, 원복 불필요).
- 빌드: `CARGO_TARGET_DIR=%TEMP%/ccg-r12-tgt npm run tauri:build` → **4,587,008 B**, 1m44s.
  공용 `target/`을 안 써서 다른 빌더의 exe 잠금(os error 5)·경합을 회피했다.
- 크레이트 테스트/드라이버도 각자 별도 `CARGO_TARGET_DIR`(`ccg-r12-auth` · `ccg-r12-m5t`).

### 안전 장부

| 항목 | 결과 |
|---|---|
| 사용자 실앱(Electron 2.6.2) | 시작·종료 시 **동일한 6 PID**(6644·9840·12924·23792·24836·26924). 건드림 0 |
| 이름 기반 kill | **0회.** 죽인 것은 ⑴ 내가 spawn한 PID 트리 ⑵ `engine:debug`가 알려 준 **격리 홈의 자식 CLI 3개**(E 2차 `15408` · E 3차 `16368` · F `16160`)뿐 |
| 실홈 | 읽기/복사만. `accounts.json` md5 **작업 전후 `20bdd3c0c4d357f98c8e40ad76ad3773`** · `codex-accounts.json` **`695516d167e24a93cd6b889e212209ef`** 동일 |
| 격리 홈 잔존 | 0(`.critic-home-*` · `.poc-home-*` 전부 회수, engines 정션 `rmdir` 선행) |
| 네트워크로 나간 토큰 | M5 경로 0건(preflight는 요청을 **조립만** 한다). 배선 경로는 실 CLI가 정상 턴을 돈 것뿐 |

---

## 2. 배선 R2 재현

### 2.1 치명 2건 — E·F (R1의 "제품에 T22 진입점이 없다")

**F — 스트리밍 중 CLI kill: green.** `taskkill /T /F /PID 16160` 후 **첫 5초 샘플에서 이미**:

```
state=idle · result=true · busy=false · composerDisabled=false
notice: "엔진(CLI)이 외부에서 종료됐어요. 다시 보내면 새 프로세스로 이어집니다."
```

굳지 않았다는 증거로 그 뒤 전송이 그대로 돌았다 — `PING` 결과 도착(R1은 45s 타임아웃).
`engine:debug`: `spawns 1 / exits 1`(누수 0).

**E — 승인 카드 뜬 채 CLI kill: green(3회 중 2회, §R-1).** 정착 회차의 값:

```
settledIn = 0 (첫 5s 샘플에 이미 카드 없음) · state=idle · ask=none · busy=false
settled[] = [ { id: toolu_019iE4…, kind: running_tool, reason: stream_closed:externalkill },
              { id: 2f3d580a-…,   kind: ask_card,     reason: stream_closed:externalkill } ]
notice: "엔진(CLI)이 외부에서 종료됐어요 — 진행 중이던 표시 2개를 정리했어요. 다시 보내면…"
```

여기서 두 가지가 동시에 확인된다. ① `chat:run-state.settled[]`가 **더는 빈 배열이 아니다**
(R1의 지적). ② 실린 두 id가 `frames.jsonl`의 실제 `tool_use.id`·`control_request.request_id`와
**일치**한다 — 즉 합성 값이 아니라 원장에서 나온 값이다. 카드를 눌러 보고 Esc도 눌러 봤지만
이미 정착한 뒤라 둘 다 no-op(탈출구가 필요 없는 상태).

### 2.2 A~D 재실행

| 공격 | 결과 | 근거 |
|---|---|---|
| **A** 스트리밍 중 소프트 중단(Esc) | ✅ | 중단 마커 DOM에 있음 · `runStates: starting→streaming→interrupting→terminating→idle` · 재개 턴 `RESUMED`(isError false) · 잔존 CLI 0 |
| **B** 승인 카드 거부 | ✅ | 카드 옵션 `[허용, 항상 허용, 거부]` · 거부 클릭 → `tool-end{status:error, "사용자가 거부했습니다."}` · **파일 미생성** · 카드 사라짐 · `status=done, busy=false, ask=none` |
| **C** busy 중 채팅 전환 | ✅ | busy 상태에서 사이드바 클릭 → `activeChatId=c-b`, locked 클래스 없음(R1이 판정 커밋에서 실패로 본 항목 — 이제 통과) |
| **D** 스트리밍 중 강종 → 재시작 | ✅ | 재시작 후 `working=false` · 진행 중 텍스트 없음 · 사이드바 dot에 busy 클래스 없음 · composer 활성 · 후속 턴 `ALIVE` |

D는 **디스크에 남은 값까지** 봤다: 강종 시점 `chats-v3/status.json`은
`{"c-a":{"status":"working","busy":true,…}}`로 남는다. 화면이 깨끗한 이유는 유령을 안 만들어서가
아니라 `status::load_boot`(`crates/ccg-store/src/status.rs:107-119`)이 부팅마다
`busy=false · ask=none · bgActive=false · working|analyzing→idle`을 **강제**하기 때문이다(§R-4).

### 2.3 dialog · winsave · 별칭

```
[DIALOG]  D1-카드 {opts:["sonnet로 계속","중단"], state:"AwaitingUser"}
          D2-응답 {behavior:"completed", result:"retry_fallback", toolUseID:"toolu_fake_1"}
          D3-진행 {result:"FALLBACK-OK", banner:["fable 이(가) 응답을 거부해 sonnet 로 전환했어요"]}
          D4-폴백리비전 {model:"sonnet", revision:1}                      → PASS 4/4
[WINSAVE] W1-id "sc-1787438696303-1"(재시작 생존형) · W2-턴 · W3-저장(origin:session, msgs 2)
          W3-격리 · W4-재시작목록 잔존 · W5-복원 · W5-중복없음            → PASS 7/7
[ALIAS]   S1 unloaded 병합(3채팅 6/7/8 msgs) · S2 ma 패널 저장 · S3 열기+닫기 목록
          S4 session-wins:{persist,hydrate,rename}                       → PASS 7/7
```

D3의 배너 모델명이 `sonnet`이다 — 커밋이 말한 "폴백 대상 모델을 `tool_use_id`에서 읽던 버그"가
실제로 `payload.fallbackModel` 우선으로 고쳐졌음을 화면 문자열이 증언한다(`toolu_fake_1`이 아니다).

### 2.4 ★ T22 백스톱의 **반대 방향** — "프로세스 생존 중 절대 정착 안 함"

E·F는 *죽였을 때 정착하는가*만 본다. 커밋이 내세운 **무기한 승인 대기 계약**(m-logic §3.2)이
백스톱에 깨지지 않는지는 아무도 안 쟀다. 그래서 **안 죽이고 방치하는** 시험을 따로 짰다
(`docs/critic/tools/.r12-backstop.mjs` — 격리 홈 · 실 CLI · 10초 간격 샘플).

승인 카드를 띄운 뒤 **132초**(백스톱 `STREAM_STALL_BACKSTOP` = 90s를 42초 초과) 아무것도 안 했다:

```
 10s .. 132s (13샘플 전부 동일)
   card=true · state=awaiting_user · settled=0 · results=0 · notices=0
   status=[{s:"working", busy:true, ask:"permission"}] · cliAlive=true (pid 11364)
engine:debug 방치 직후 : { state:"AwaitingUser", spawns:1, exits:0 }
```

90초 경계를 넘긴 샘플이 5개(91·102·112·122·132s) 있고 전부 카드가 살아 있다. **오발 0.**
그리고 이 대기가 *죽은 대기*가 아니었음을 같은 주행에서 확인했다 — 그 뒤 '허용'을 누르니
`DONE` 결과가 오고 파일이 실제로 생겼다(`fileCreated: true`, `exits:1`).

> 판정: 커밋의 주장 그대로다. 다만 **왜** 안 터지는지는 §R-2·R-3에 적었다 — 조건 하나에 걸려 있다.

### 2.5 게이트 재현

| 커밋 주장 | 내 실측 |
|---|---|
| `ccg-engine` 104 green (+2 ignored) | **104 passed / 0 failed / 2 ignored**(20+5+11+27+36+5) |
| `ccg-store` 58 green | **58 passed / 0 failed** |
| `critic-wiring-{live,alias}` 전 항목 green | **live A~F green · alias S1~S4 green**(§2.1~2.3) |
| `poc-live-chat` PASS | `--only=dialog` · `--only=winsave` **둘 다 PASS, 결함 0** |

---

## 3. M5 R2 재현

빌더의 프로브·단위 테스트가 아니라 **R1 크리틱이 커밋한 도구**를 다시 돌렸다.
드라이버는 워크스페이스 밖 크레이트(`docs/critic/tools/critic-m5-drive`, ccg-auth 공개 API만).

| 지적 | R1 | 내 재실측 | 판정 |
|---|---|---|---|
| **1. 오염가드 순서 의존** | 스토어 `[a,b]`면 `preflight(a)`가 **통과** | 배치 `[a,b]`·`[b,a]` **양쪽에서** `preflightA=Contaminated("b@x.com")`, `preflightB=Contaminated("a@x.com")`, `probe=false`, `diagnose`도 양쪽 `collides` | ✅ 확인 |
| **2. reorder 중복 레코드 유실** | 3건 → **2건**(credEnc 소멸) | seed `[dup(TOK-1), dup(TOK-2), ok(TOK-3)]` → `reorder(['ok','dup'])` → **3건 유지**, `distinctCredEnc=3`, 순서 `[ok, dup, dup]` | ✅ 확인 |
| **3. usage 파서 12/71 불일치** | 12건 | `critic-m5-ucases.cjs`(71종)를 2.6.2 파서(`critic-m5-uparse262.cjs`)와 3.0 파서(`uparse.exe`)에 먹여 **MISMATCH = 0/71** | ✅ 확인 |
| **4. 관대성 두 자리** | `version:3.0` → **계정 0건** / 캐시 4키형 폐기 | `edge.exe`: version `3`·`3.0`·`2`·`2.0` → **각 1건**(`"3"`·`4` → 0건, 2.6.2와 동일) · usage 캐시 읽힌 키 **`[a,b,c,e]` 4건** | ✅ 확인 |
| **5. `auth status` 오기 + 타입 봉인** | 주석이 "읽기 전용"이라 거짓 | `cargo test -p ccg-auth`의 `no_cli_command_can_ever_point_at_the_users_real_home` · `account_config_dirs_are_materialized_inside_the_app_home` green | ✅ 확인 |
| 곁다리(폴더 신원 역검증) | 선의의 실패 가능 | `real_account_folders_match_our_slug_and_junction_rules` green(실홈 6계정) | ✅ 확인 |

**게이트**

```
cargo test -p ccg-auth                 → 67 passed / 0 failed / 0 ignored (0.88s)   ← 주장 67 green 일치
cargo clippy -p ccg-auth --all-targets → ccg-auth 경고 0 (7건은 전부 ccg-store 기존분)
실홈 사본 10,380B 왕복(3.0 read→write) → md5 20bdd3c0… 전후 동일, 바이트 동일
2.6.2 리더(Electron 42 실 safeStorage) → version 3 · 6계정 · 전 행 hasAccess+hasRefresh
                                          · snapKeys [creds, account, userID] · allRunnable = true
```

순서 의존 수정의 핵심 증거는 **`diagnose`와 게이트가 같은 답을 낸다**는 것이다 — R1은 진단만 맞고
게이트가 틀렸다. 이번엔 `token_collision`(자기 제외) 단일 소스라 둘이 갈릴 구조가 아니다
(`verify.rs:188`). `token_owner`(첫 일치)는 삭제됐음을 소스에서 확인했다.

---

## 4. 남은 위험

### R-1 [하네스 · 값어치 최상] 공격 E의 전제가 3회 중 1회 무너지고, **무너진 회차가 산출물에 초록으로 남는다**

내 1차 주행(`--only=E,F`)에서 E는 `✗ E-카드 — 승인 카드가 안 떴다`로 죽었다. 공격이 성립도 못 한
것이다(120초 안에 카드 미출현). 2차·3차는 green. `--keep`으로 남긴 2차의 `frames.jsonl`에는
`control_request{subtype:"can_use_tool"}`가 정상 도착해 있어 **제품 결함의 증거는 없고**, 실 CLI·모델
비결정성으로 보인다. 그러나:

> **`critic-wiring-live.mjs`가 실패 회차를 조용히 덮는다.** `attackE`는 카드 미출현 시 `try` 안에서
> `return`하는데(`:394-397`), `rep.attacks.E = out`은 `try/finally` **뒤**(`:461`)라 실행되지 않는다.
> 그래서 결과 JSON에는 **직전(빌더) 주행의 완전한 초록 E 블록이 그대로 남고** `findings`에만 실패가
> 한 줄 붙는다. 내 1차 산출물이 실제로 그랬다 — `attacks.E`는 빌더 exe(`bench/scratch/pin/…`)로
> 찍힌 데이터였다. `attackB`도 같은 구조다(`:236-239` ↔ `:276`).

영향: 다음 라운드가 이 파일만 보고 "E 초록"을 인용한다. 고치는 법은 `return` 대신 플래그로 빠져
`rep.attacks.X = out`을 반드시 통과시키거나, 실패 시 `attacks.X = { failed: … }`로 덮는 것. 두 줄이다.
겸해서 **카드 미출현은 재시도로 흡수**해야 게이트로 쓸 수 있다(1회 표본으로 green/red를 가르면 안 된다).

### R-2 [설계 경계] T22가 잡는 것은 "죽음"이지 "행(hang)"이 아니다

§2.4의 "오발 0"은 공짜가 아니다. 발화 조건이 `프레임 90s 정지 ∧ !process_alive()`이고
`process_alive() = child.is_some() && eof_at.is_none()`(`driver.rs:394-399`)인데, `eof_at`은
`poll_frames`가 stdout 채널 `Disconnected`를 볼 때만 선다(`:429-435`). 따라서:

- **프로세스는 살아 있는데 프레임만 멈춘 CLI**는 90초 아크가 조건에서 걸러져 `Streaming`/
  `AwaitingUser`로 **영원히** 남는다. 승인 무기한 대기와 코드가 구별하지 않는다 — 그게 계약이니까.
- 사용자 눈에는 둘이 같아 보인다("굳었다"). 탈출구는 Esc(소프트 중단)뿐이고 F에서 동작은 확인했지만,
  **화면이 그 사실을 알려 주지 않는다.**

지금 선택은 옳다(무기한 대기를 지키는 쪽). 다만 "무응답 N분이면 물어본다" 같은 층이 없으면
m-logic P8이 *다른 얼굴로* 남는다 — 3.0이 죽이겠다고 선언한 그 증상이다. 3.0 범위 밖이라면 장부에.

### R-3 [저확률 · 문장 정정] "생존 중 절대 정착 안 함"은 **stdout이 정상인 한** 참이다

`read_frames`의 루프는 `Ok(0) | Err(_) => break`다(`driver.rs:471`). 파이프 read **에러**도 EOF와
똑같이 취급되어 리더 스레드가 끝나고 → 채널 `Disconnected` → `eof_at` 설정 → `process_alive()=false`.
종료 코드가 안 잡히면 700ms(`EXIT_CODE_GRACE`) 뒤 `CloseCause::Crash`로 정착한다.
즉 "프로세스 생존 중 절대"는 논리적으로는 반증 가능한 문장이다(에러 주입 경로가 없어 실측은 못 했다).
커밋 문구를 "stdout이 살아 있는 한"으로 좁히는 편이 정확하다. 실사용 확률은 낮게 본다.

### R-4 [영속] D가 깨끗한 것은 유령을 **안 만들어서**가 아니라 **부팅마다 지워서**다

§2.2 실측대로 강종 시점 `status.json`에는 `working/busy:true`가 남는다. 안전판은
`load_boot`의 강제 하향 한 곳뿐이고, 현재 소비자는 `chats_v3.rs:390`·`:433` 두 곳 전부 그 경유다.
`status.json`을 `load_boot` 밖에서 읽는 소비자(팝아웃 창·멀티 패널·워크플로 등)가 하나라도 생기면
같은 유령이 되살아난다. 규약이 **코드 주석에만** 있다 — 테스트로 못 박아 두는 편이 싸다.

### R-5 [M5] 71/71은 "이 71개에서 같다"이지 파서 동치의 증명이 아니다

`usage_golden_2_6_2.json`은 **R1 크리틱이 고른 71종의 2.6.2 출력을 그대로 편입**한 것이다.
즉 코퍼스의 저자와 골든의 저자가 같고, 이 골든은 동치 증명이 아니라 **회귀 고정**이다.
코퍼스가 안 밟은 갈래(예: `weekly_fable` 라벨 매칭의 비ASCII·대소문자 조합, `cap→limit` 폴백과
`{credits}` 래퍼의 교차)에서 갈리면 지금 체계로도 못 잡는다. 이번 라운드의 잘못은 아니지만,
"파서가 2.6.2와 같다"는 문장을 71개 밖으로 넓혀 쓰면 안 된다.

### R-6 [M5] 로컬시의 **DST 갈래**는 이 머신에서 반증 불가

`production_path_uses_the_real_os_offset`가 실 OS 오프셋 사용 자체는 본다. 그러나 이 머신은
KST(DST 없음)라 `TzSpecificLocalTimeToSystemTime`과 "현재 바이어스 폴백"이 **같은 답**을 낸다 —
DST 규칙까지 OS에 묻는다는 부분은 시험되지 않는다(사용자 머신의 타임존을 바꾸는 짓은 하지 않았다).
`zoneless_times_follow_the_injected_zone`이 주입 오프셋 3종(0·540·−300)을 보므로 산술은 맞다.
남은 것은 "실제 DST 존에서 OS가 옳은 오프셋을 주는가" 한 점이고, 이건 다른 머신이 필요하다.

### (관찰, 위험 아님) 외부 킬 뒤 채팅 상태가 `error`다

E·F 모두 정착 직후 `status="error"`로 뜬다. 사용자가 끊지 않았는데 빨간 상태라 오해 소지가 있으나,
같은 화면에 사유 notice가 함께 뜨고 다음 턴을 보내면 곧바로 `done`으로 갈린다(F에서 확인).
R2가 신설한 `TerminalStatus::Aborted`(사용자 중단 = 표시값 idle)와 어휘가 갈려 있는 것은 의도로 읽었다.

---

## 5. 재현 명령

```bash
# 핀 (다른 빌더와 격리)
git worktree add --detach %TEMP%/ccg-r12-wt 96486fd
cmd /c mklink /J %TEMP%/ccg-r12-wt/node_modules <repo>/node_modules
cd %TEMP%/ccg-r12-wt
CARGO_TARGET_DIR=%TEMP%/ccg-r12-tgt npm run tauri:build
CARGO_TARGET_DIR=%TEMP%/ccg-r12-tgt cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release
cp %TEMP%/ccg-r12-tgt/release/{agentcodegui,ccg-fakecli}.exe target/release/   # poc 하네스는 경로 고정

# 배선
node docs/critic/tools/critic-wiring-live.mjs  --only=E,F   --exe=%TEMP%/ccg-r12-tgt/release/agentcodegui.exe
node docs/critic/tools/critic-wiring-live.mjs  --only=A,B,C,D --exe=…
node docs/critic/tools/critic-wiring-alias.mjs --exe=…
node scripts/poc-live-chat.mjs --only=dialog
node scripts/poc-live-chat.mjs --only=winsave
node docs/critic/tools/.r12-backstop.mjs --exe=… --hold=130000    # ★ T22 오발 시험(이번에 추가)
CARGO_TARGET_DIR=%TEMP%/ccg-r12-auth cargo test -p ccg-engine -p ccg-store

# M5
CARGO_TARGET_DIR=%TEMP%/ccg-r12-auth cargo test -p ccg-auth              # 67 green
cd docs/critic/tools/critic-m5-drive && CARGO_TARGET_DIR=%TEMP%/ccg-r12-m5t cargo build --offline
#   스크래치: <scr>/userData/Local State ← %APPDATA%/agent-code-gui/Local State (복사)
CCG_HOME=<scr> SEED_JSON='[a,b]' m5drive.exe seed && CCG_HOME=<scr> A=a@x.com B=b@x.com m5drive.exe contamination
CCG_HOME=<scr> SEED_JSON='[dup,dup,ok]' m5drive.exe seed && CCG_HOME=<scr> EMAILS=ok@x.com,dup@x.com m5drive.exe reorder
node docs/critic/tools/critic-m5-ucases.cjs | node docs/critic/tools/critic-m5-uparse262.cjs   # 2.6.2
node docs/critic/tools/critic-m5-ucases.cjs | %TEMP%/ccg-r12-m5t/debug/uparse.exe              # 3.0  → diff 0/71
CCG_HOME=<iso> %TEMP%/ccg-r12-m5t/debug/edge.exe
CCG_HOME=<real-copy> CCG_USERDATA=<real-copy>/userData \
  ./node_modules/electron/dist/electron.exe docs/critic/tools/critic-m5-262reader.cjs read     # allRunnable
```

산출물은 전부 격리 워크트리 안에 남겼다(`%TEMP%/ccg-r12-wt/docs/critic/`:
`wiring-r1-attacks.json` · `wiring-r1-alias.json` · `m3-r2-live.json` · `r12-backstop.json`).
**메인 레포에는 이 보고서 한 장만 더한다** — 공용 기준 파일을 한 바이트도 안 건드리기 위해서다.
