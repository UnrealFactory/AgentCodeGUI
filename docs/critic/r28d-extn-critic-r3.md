# R28d 「EXTN」 확인 크리틱 R3

> 대상 커밋 `f1fc70b`(코드 + 하네스 F팔 + 장부). 판정 기준 트리 = `git archive HEAD` →
> `C:\Temp\ccg-x3r3`(옆 갈래 M10의 미커밋 `runtime.rs`·`hub.rs`·`talk.rs`가 **한 바이트도
> 안 섞였다**). **빌더의 보고서·커밋 메시지는 한 줄도 근거로 쓰지 않았다** — 트리를 새로
> 뜨고, exe를 새로 굽고, 대조군·뮤테이션을 내 손으로 만들고, 그 값만 인용한다.
> 레포의 코드·하네스는 한 글자도 안 고쳤다(내 탐침은 전부 레포 밖).

**결론: PASS.** 이 라운드가 표지에 건 불변식 — *「띄울 수 있는가」와 「실제로 띄운다」가
**같은 폴더 목록**을 본다* — 이 **내 손에서 처음으로 8판 전부 참**이다. 크리틱 R2가 FAIL을
준 칸(연 프로젝트 폴더의 실행본이 엔진이 되던 자리)은 제품 경로에서 닫혔고, 그 닫힘이
「전부 막아서 얻은 초록」이 아니라는 것을 **제대로 구운 대조군**이 빨강으로 증명한다.
클로드 축(전역 PATH `claude.exe`·관리 설치본)·`file_diff` 폴더 3종·cargo 세 크레이트·
typecheck 3종 전부 무후퇴다.

남은 흠 셋은 전부 **비-차단**이고 §6에 적는다. 그중 하나는 이 라운드가 세 번째로 반복하는
집안 문제다 — **이 커밋이 자기 편집으로 자기 장부의 줄 번호 셋을 어긋나게 해 놓고 고치지
않았다**(`aimsg.rs:268→271`은 고쳤다).

---

## 0. 격리와 안전 (먼저)

| 무엇 | 값 |
|---|---|
| 판정 트리 | `git archive HEAD`(`f1fc70b`) → `C:\Temp\ccg-x3r3` · `node_modules`만 정션 |
| 대조군 트리 | 같은 archive + `crates/ccg-engine/src/codex/driver.rs`만 **R2 이전으로 되돌림**(`git apply -R`) → `C:\Temp\ccg-x3r3ctl` |
| 뮤테이션 트리 | 같은 archive + **`command_for`만** R1 모양(★**새 못 셋은 그대로 남겼다**) → `C:\Temp\ccg-x3r3mut` |
| fs 대조군 트리 | 같은 archive + `show_at`의 트리 가드 **3줄만** 제거 → `C:\Temp\ccg-x3r3fsctl` |
| CARGO_TARGET_DIR | `ccg-x3r3-tgt`(수정본 exe) · `ccg-x3r3ctl-tgt`(대조군 exe) · `ccg-x3r3-tgtp`(테스트) · `ccg-x3r3mut-tgt` · `-gs-tgt`/`-gsctl-tgt`/`-fsprobe-tgt`/`-fsprobectl-tgt`(탐침) — **레포의 `target*`은 한 번도 안 썼다** |
| 수정본 exe | `md5 9db2b9156498a193ec02f38cacf70f85` · **6,500,864 B** |
| 대조군 exe | `md5 07173033785acc5e4b07bb84e3bb7755` · 6,500,864 B (해시가 다르다 = 같은 파일을 두 번 잰 게 아니다) |
| 빌드 | 둘 다 `cargo build --release --features custom-protocol -p agentcodegui`(프론트는 트리 안에서 `vite build`) |
| CDP 포트 | **9791 · 9793 · 9795 · 9797 · 9799** (빌더 9781/9783 · 크리틱 R2 9761~9769 · 옆 갈래와 무충돌) |
| kill | `killTree`(자기가 spawn한 PID 트리)뿐 · **이름 기반 kill 0회**. 주행 전후 사용자 실앱 `…\Programs\AgentCodeGUI\AgentCodeGUI.exe` **5프로세스 그대로**(PID 6644·12924·23792·24836·26924). 살아 있던 `agentcodegui.exe` 하나는 옆 갈래의 `target-m10r6` 것이라 **손대지 않았다** |
| 실계정·실 HTTP | 합성 계정·가짜 CLI만. codex 축 `CCG_NO_NET=1`, 클로드 축은 해지를 재야 해서 `HTTPS_PROXY=http://127.0.0.1:9` → 실 HTTP 0 · **토큰 회전 0**. D팔이 본 이 컴퓨터의 진짜 전역 codex는 **한 번도 안 떴다**(미발사) |
| 기준 결과 파일 | 무접촉. 새 산출물은 새 이름으로만 — `codex-path-critextnr3(.ctl).json` · `claude-path-critextnr3.json` · `claude-axis-m-critextnr3(.ctl).json` · `gatespawn-critextnr3(.ctl).json` |
| 커밋 | 이 파일 하나만 — `git commit --only docs/critic/r28d-extn-critic-r3.md` |

### 0.1 ★내가 먼저 밟은 함정 — 「대조군이 초록」이 **내 빌드 캐시**였다

첫 대조군 F팔은 `ran:false · hole:false`(= 초록)로 나왔다. **그건 빌더가 틀린 게 아니라
내가 잰 게 틀린 것이었다.** 대조군 `CARGO_TARGET_DIR`를 판정 트리 것에서 robocopy로
워밍업했는데, `deps/*.d`가 **상대 경로**를 담고 있고 `git archive`가 두 트리에 **같은
mtime**을 주는 바람에 cargo가 `ccg-engine`을 **재컴파일하지 않고** 판정 트리(=고쳐진)
rlib을 그대로 링크했다(빌드 로그에 `Compiling agentcodegui` 한 줄뿐).

워크스페이스 크레이트의 `.fingerprint`/`deps`를 지우고 소스를 `touch`한 뒤 다시 구웠더니
로그에 여섯 크레이트가 다 뜨고(2m39s) 대조군이 **빨개졌다**. 그래서 아래 §1.2의 대조군
값은 **두 번째**(제대로 구운) exe의 것이다. 첫 값은 폐기했다.

---

## 1. 체크1 — `codex.exe` 철자 팔 · 기존 4팔 무회귀 · **F팔 판별력**

### 1.1 수정본 6팔 — `PASS 15 / FAIL 0 · hole:false`

승격 하네스 `scripts/poc-codex-path.mjs`를 **한 글자도 안 고치고** 내가 구운 exe에 물렸다
(격리 홈 `.poc-home-critx3r3` · CDP 9791 · `CCG_NO_NET=1`).

| 팔 | 씨앗 | 발사 | 최종 probe | 대기표 |
|---|---|---|---|---|
| A 전역 PATH | `CCG_CODEX_BIN=codex` | 안 함 | `asks:2 fetches:1 unavailable:2 unknown:0` | 살아 있음 |
| B 앱 설치본 | 절대 경로 | 안 함 | 같은 값 | 살아 있음 |
| **C 아무 데도** | PATH에서 codex 제거 | **t=90초 발사** | `asks:1 unavailable:0 unknown:1` | 사라짐 |
| **E 확장자 붙은 맨 이름** | `CCG_CODEX_BIN=codex.exe` | 안 함 | `asks:2 fetches:1 unavailable:2 unknown:0` | 살아 있음 |
| D 이 컴퓨터의 진짜 전역 codex | 우회로 없음 | 안 함 | 같은 값(`where codex` = `…\Roaming\npm\codex`·`codex.cmd`) | 살아 있음 |
| **F 연 폴더에만 codex** | 작업 폴더에 `codex.cmd` | **t=90초 발사**(C와 같은 옛 계약) | `asks:1 unknown:1` | 사라짐 · **`ran:false` `talked:false`** |

**체크1의 답: 초록이다.** E팔(`codex.exe` 철자)이 A팔과 **글자 하나까지 같은 값**을 내고,
C가 여전히 옛 계약대로 쏜다는 사실이 그 초록이 "전부 unavailable로 만들어 얻은 가짜"가
아님을 잠근다. → `docs/critic/codex-path-critextnr3.json`

F팔이 **`fired:true`** 라는 것이 중요하다 — 런타임의 `spawns`는 `driver.spawn()`의 성공
여부와 무관하게 오르므로(`runtime.rs:1658`), 이 값은 **제품이 실제로 `command_for`까지 가서
스폰을 시도했다**는 증표다. 즉 `ran:false`는 「아무 일도 안 일어나서 초록」이 아니다.

### 1.2 대조군 F팔 — `FAIL 3 · hole:true`

같은 하네스·같은 씨앗을 **제대로 구운 대조군 exe**(`07173033…`)에 물렸다:

```text
F1 ✗ 연 폴더에 떨어진 codex를 띄우지 않았다 → ran:true
F2 ✗ 게이트와 스폰의 답이 같다            → unknown:1 인데 ran:true
F3 ✗ 그 실행본과 한 줄도 주고받지 않았다   → talked:true (가짜 app-server의 stdin 기록이 생겼다)
판정: {"F.fired":true,"F.unknown":1,"F.cwdCodexRan":true,"hole":true}
```

**갈리는 칸은 「그 폴더의 실행본이 뜨는가」 하나**다. 게이트의 답(`unknown:1`)도 발사
시각(t=90초)도 그대로다. → `docs/critic/codex-path-critextnr3ctl.json`

### 1.3 ★게이트 ↔ 스폰을 **앱의 두 함수로** 8판 물었다 (하네스가 못 보는 칸까지)

`resolve_bin`(게이트)과 `command_for`(스폰 조립기)를 같은 판에서 나란히 부르고, 「무엇이
실제로 떴나」는 심은 배치/사본이 남긴 표식으로 읽는 탐침을 레포 밖에 만들었다. **팔마다
이름을 다르게 쓴다** — `resolve_bin`의 캐시가 (이름 + PATH) 키에 15초짜리라 같은 키로 두 팔을
재면 앞 팔의 답이 뒤 팔로 샌다(첫 주행에서 실제로 샜고, 그래서 이름을 갈랐다).

| 판 | 이름이 있는 곳 | 게이트 | **실제로 뜬 것** | 대조군에서 실제로 뜬 것 |
|---|---|---|---|---|
| P | PATH 한 칸 | `pathdir\…CMD` | **같은 파일** | 같은 파일 |
| X | 실행 파일 옆 | `exedir\…CMD` | **같은 파일** | **`null`** ← 있다 했는데 못 띄움 |
| **C** | 자식 작업 폴더에 `.cmd` | `null` | **`null`** | **`cwd\…cmd`** ← ★ |
| **C2** | 자식 작업 폴더에 `.exe`(맨 이름) | `null` | **`null`** | **`cwd\…exe`** ← ★ |
| **C3** | 자식 작업 폴더에 `.exe`(`codex.exe` 철자) | `null` | **`null`** | **`cwd\…exe`** ← ★ |
| N | 아무 데도 | `null` | `null` | `null` |
| **M** | **cwd + PATH 둘 다** | `pathdir\…CMD` | **`pathdir\…cmd`** | **`cwd\…cmd`** ← ★ 답과 다른 파일을 띄웠다 |
| E | PATH에 `.exe` 철자 | `pathdir\…exe` | 같은 파일(셸 없이 직접) | 같은 파일 |

**수정본 8/8 일치 · 대조군 4칸 불일치.** → `docs/critic/gatespawn-critextnr3(.ctl).json`

세 가지가 여기서 처음 잡혔다(하네스에는 그 팔이 없다):
- **C2·C3** — 크리틱 R2가 구멍을 쟀던 철자는 `codex.exe`인데 빌더의 F팔은 `codex.cmd`를
  심는다. **두 철자 다** 닫혔다는 것을 확인했다.
- **M** — 「PATH에도 있고 연 폴더에도 있다」는 판. 대조군은 게이트가 PATH 것이라 답해 놓고
  **연 폴더 것을 띄운다**(= 「같은 폴더 목록」이 이 칸에서도 깨져 있었다). 수정본은 PATH 것을
  띄운다.
- **C3의 스폰 모양이 `Command::new(맨 이름)`**(셸 없음)이고 그 판에서 아무것도 안 떴다는 것이
  **클로드 축이 안전한 진짜 이유**(Rust `Command`는 CWD를 안 본다)를 내 손으로 확인한 자리다 —
  클로드 스폰이 정확히 그 코드 경로다.

---

## 2. 체크2 — 클로드 축 (실 exe · 네 판)

### 2.1 X·P·N — `poc-claude-path.mjs`(빌더 커밋본, 무수정 · CDP 9795)

세 팔 다 앱 exe를 복사한 폴더에서 띄우고 `CCG_CLAUDE_BIN`은 지웠다(= 진짜 폴백 사슬 `claude.exe`).

| 팔 | 로그인 | 로그인 URL | **로그아웃 = 해지 호출** | AI 커밋 메시지 |
|---|---|---|---|---|
| X 실행 파일 옆 | NO_BIN 아님 | 도착 | **나갔다** · 격리 계정 폴더로 | 통과 |
| **P 전역 PATH(`claude.exe` 맨 이름)** | NO_BIN 아님 | 도착 | **나갔다** · 격리 계정 폴더로 | 통과 |
| N 아무 데도 | `찾지 못했어요` | — | **0회**(옛 계약) | `설치된 엔진이 없어요…`에 막힘 |

**PASS 3팔 / FAIL 0.** → `docs/critic/claude-path-critextnr3.json`

### 2.2 관리 설치본(M) 무회귀 — **두 exe에서 값이 같다**

새 하네스에 M팔이 없어 크리틱 R1의 탐침(레포 밖)을 두 exe에 각각 물렸다(CDP 9797·9799).

| exe | M1 로그인 | M2 URL | M3 **해지 호출** | M4 aimsg |
|---|---|---|---|---|
| 수정본 | 통과 | `https://claude.ai/oauth/authorize?code=FAKE-T1T2…` | `called:true` | 통과 |
| 대조군 | 통과 | 같은 값 | `called:true` | 통과 |

**둘 다 PASS 4/0 · 글자 하나까지 같다** = 이번 커밋은 클로드 축을 움직이지 않는다(디프도
`codex/*`와 주석뿐이다). → `docs/critic/claude-axis-m-critextnr3(.ctl).json`

---

## 3. 체크3 — `file_diff(cwd, "-dir")`가 정직한가

`ccg-fs`를 레포 밖에서 부르는 탐침 두 벌(판정 트리 / 트리 가드 **3줄만** 걷어낸 트리)로
같은 씨앗 저장소를 물었다.

| 물음 | **판정 트리** | 대조군(가드 없음) |
|---|---|---|
| `file_diff("-dir")` | `diff:null` · `내용을 읽을 수 없어요` | `edit(add:0,del:5)` · head_content **34 B** |
| `file_diff("보통dir")` | 같은 답(수렴) | `edit(0,4)` · 33 B |
| `file_diff("app/posts/[id]")` | 같은 답 | `edit(0,3)` · 35 B |
| `commit_file_diff(<sha>,"-dir")` | `diff:null` · 사유 | `edit(1,1)` · content **70 B** |
| `commit_file_diff(<sha>,"보통dir")` · `…"[id]"` | 같은 답 | `edit(1,1)` · 69 B · 71 B |
| `file_diff("-파일.txt")` | `edit(1,1)` | **같은 값** — 못 그대로 |
| `file_diff("app/posts/[id]/page.tsx")` | `edit(1,0)` | **같은 값** — 대괄호(`:(literal)`) 못 그대로 |
| `file_diff("함정.txt")`(본문이 `tree HEAD:함정.txt`로 시작) | `Text`(`edit(0,0)`) | **같은 값** — 거짓 양성이 답을 안 바꾼다 |
| `commit_file_diff("-파일.txt"·`[id]/page.tsx`·`함정.txt`) | 정상(content 28·15·36 B) | **같은 값** |

폴더 세 모양이 **두 얼굴에서 다 정직**하고, 진짜 파일 못은 한 칸도 안 움직였다. 대조군이
트리 목록을 본문으로 읽는다는 것이 판별력이다. → `docs/critic/fsprobe-critextnr3(.ctl).json`

---

## 4. 체크4 — cargo(크레이트별) · 반복 · typecheck

격리 홈 `C:\Temp\ccg-x3r3-home` · `CCG_NO_NET=1` · 판정 트리에서.

| 크레이트 | 결과 | 기준 | 반복 주행 |
|---|---|---|---|
| `ccg-engine` | **221 통과 · 0 실패 · 2 ignored**(테스트 바이너리 15개 합) | 체크리스트 207 · R2 크리틱 219 → **후퇴 없음** | `--lib` **20/20** 초록(매번 73) |
| `ccg-fs` | **101 · 0 · 2**(2개) | 101 → 후퇴 없음 | — |
| `agentcodegui` | **146 · 0**(1개) | R2 크리틱 146 → 후퇴 없음 | **20/20** 초록(매번 146) |

**빌더의 「151」은 사실 확인됐다.** 내 클린 트리(M10 미커밋 없음)에서 **146**이 나온다 =
차이 5는 옆 갈래의 미커밋 `engine::talk::tests`가 맞고, 이 커밋이 더한 `src-tauri` 테스트는
**0**이다(그 두 파일 디프는 주석뿐).

`typecheck:node` · `typecheck:web` · `typecheck:app` **전부 exit 0**.

### 4.1 새 못의 판별력 — 뮤테이션으로 직접 확인

`command_for`만 R1 모양으로 되돌리고 **새 못 셋은 남긴** 트리에서 `codex::` 필터:

```text
---- the_gate_and_a_real_spawn_agree_when_the_cli_sits_only_in_the_chat_folder ----
★ 게이트는 「창구 없음」인데 스폰이 **연 폴더의 실행본**을 띄웠다(= 한도 Unknown으로 눈감고 발사)
---- a_bare_name_is_resolved_here_so_the_shell_never_searches ----
  left: "\"\"ccg-extn-cmdfor-28760\" app-server\""   ← 맨 이름이 셸로 갔다
---- a_scripted_extension_goes_through_the_shell_but_a_native_one_does_not ----
  C:\x\codex.vbs의 갈래가 게이트와 어긋난다
test result: FAILED. 26 passed; 3 failed  (codex:: 필터)
```

셋이 빨갛다(빌더가 「정확히 둘」이라 한 것은 `needs_shell`을 남긴 더 작은 뮤테이션이라
그렇고, 방향은 같다). 중요한 것은 **판정 트리 주행에서 그 못의 내장 대조 팔(`control_ran`)이
통과했다**는 사실이다 — 옛 모양이 이 컴퓨터에서 진짜로 연 폴더의 실행본을 띄우므로
이 못은 **조용히 초록이 될 수 없다**. 주행 뒤 세 target 트리에 `ccg-extn-*` 잔여 **0개**.

---

## 5. 판정 요약

| 체크 | 결과 |
|---|---|
| 1) `codex.exe` 철자 팔 초록 · 기존 4팔 무회귀 | ✅ **PASS 15/0 · `hole:false`** · C만 t=90초 발사(판별력 유지) |
| 1') F팔(연 폴더)이 제품 경로에서 뒤집혔나 | ✅ **`ran:false talked:false`** · 대조군 **FAIL 3 · `ran:true talked:true`** |
| 1'') 게이트 ↔ 스폰이 한 벌인가 | ✅ **8판 전부 일치**(대조군 4칸 불일치) — `.cmd`/`.exe` 두 철자 · **cwd+PATH 동거 판**까지 |
| 2) 클로드 축 X·P·N | ✅ **PASS 3팔** (전역 PATH `claude.exe`에서 로그인 URL·**해지 호출**·커밋 메시지 전부 돈다) |
| 2') 관리 설치본 무회귀 | ✅ 두 exe **PASS 4/0 · 값 동일** |
| 3) `file_diff("-dir")` 정직 · 못 무회귀 | ✅ 폴더 3종 × 두 얼굴 수렴 · `-파일`/대괄호/함정 그대로 · 대조군은 트리를 본문으로 읽음 |
| 4) cargo 크레이트별 · 반복 · typecheck | ✅ **221 / 101 / 146** · 반복 20+20 흔들림 0 · typecheck 3종 exit 0 |
| 4') 장부 정정(크리틱 R2가 거짓이라 한 두 문장) | ✅ **둘 다 잰 값으로 다시 적혔다**(§6.1은 별건) |

---

## 6. 남은 흠 (전부 비-차단 · 다음 라운드 후보)

### 6.1 ★장부 표의 줄 번호 셋이 **이 커밋 자신의 편집**으로 어긋났다

`crates/ccg-engine/src/codex/versions.rs:141`의 표:

```text
| codex 한도 재검증 1회 | 3 — can_ask(engine/codex_limit.rs:121) → instrument(:138) → read_row의 spawn_bin()(:224) |
```

실제(HEAD에서 `grep -n`):

```text
123:    if crate::engine::codex_versions::codex_exe().is_none() {   ← can_ask
140:    crate::engine::codex_versions::codex_exe()?;                ← instrument
226:    let bin = crate::engine::codex_versions::spawn_bin();       ← read_row
```

**셋 다 +2**다. 그 +2는 이 커밋이 `codex_limit.rs`의 `can_ask` 주석을 3줄 → 5줄로 늘리면서
직접 만든 값이다. 같은 커밋이 `aimsg.rs:268 → :271`은 「크리틱이 지적했다」며 고쳤는데,
**자기가 방금 어긋나게 한 자기 파일의 줄 번호 셋은 안 봤다.** 값(3회·2회)은 여전히 맞고
동작에는 영향이 없다. 그래도 이 라운드가 세 판 연속 지적받는 그 집안이다 —
「장부에 적는 숫자는 적은 그 커밋에서 다시 센다」가 아직 규율이 아니다.

### 6.2 못 찾은 맨 이름 갈래가 `app-server` 인자를 **떨어뜨린다**

```rust
None => return Command::new(bin),   // ← `.arg("app-server")`가 없다
```

내 탐침 C3의 `shape`가 그 사실을 그대로 보여 준다(`ccgx3e37936.exe ` — 인자 없음). 이 갈래는
「게이트가 없다고 답했으니 스폰도 실패해야 한다」는 설계라 보통은 문제가 안 된다. 다만
`Command`가 `resolve_bin`보다 더 보는 칸(`system32`·`windows`)에 그 이름이 있으면
**실패가 아니라 「인자 없는 codex」가 뜬다**(app-server가 아닌 모드로 뜬 프로세스에 파이프를
물고 마감까지 기다린다). 이 컴퓨터에선 둘 다 PATH에 있어 도달하지 않는다.

### 6.3 `resolve_bin`은 여전히 `system32`·`windows`를 안 본다

빌더가 §10.8에 **스스로** 적었다(「안전해서 안 했다」가 아니라 「같은 방향인데 아직 안
닫았다」). 내 판정도 같다 — 이 컴퓨터에서는 둘 다 PATH에 있어 답이 갈리지 않지만,
「띄울 수 있는가 = 실제로 띄운다」를 글자 그대로 세우려면 남은 칸은 그 둘뿐이다.
(§1.3의 8판은 전부 그 두 칸 밖에서 잰 값이다.)

### 6.4 측정 위생 — 다음에 대조군을 구울 사람에게

`CARGO_TARGET_DIR`를 다른 트리 것에서 복사해 워밍업하면 **cargo가 워크스페이스 크레이트를
재컴파일하지 않는다**(`deps/*.d`의 상대 경로 + `git archive`가 주는 동일 mtime). §0.1이
그 사고의 기록이고, 대조군이 「초록」으로 나오면 **먼저 빌드 로그에 그 크레이트가 있는지**
봐야 한다. 없으면 그 대조군은 대조군이 아니다.
