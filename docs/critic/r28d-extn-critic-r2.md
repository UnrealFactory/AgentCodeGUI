# R28d 「EXTN」 확인 크리틱 R2

> 대상 커밋 `8de26c6`(불변식 수정) · `0127b75`(장부 + 보고서). 판정 기준 트리 =
> `0127b75`(feature/3.0.0-beta HEAD). **빌더의 보고서·커밋 메시지는 한 줄도 근거로 쓰지
> 않았다** — 트리를 새로 뜨고, exe를 새로 굽고, 하네스를 새로 물리고, 그 값만 인용한다.
> 코드·하네스 무수정(내가 만든 탐침은 전부 레포 밖 격리 트리 안에만 있다).

**결론: FAIL.** 이 라운드가 겨눈 자리는 **내 손에서도 전부 뒤집힌다** — 실행 파일 옆에만
claude가 있는 판에서 로그인 URL이 오고 **로그아웃이 토큰 해지를 진짜로 부른다**(대조군
exe에서는 정확히 그 다섯 칸만 빨갛다). 무회귀도 실측으로 잡혔다(전역 PATH·관리 설치본·
아무 데도 없음이 한 칸도 안 바뀌었고 codex 5팔 12/0 `hole:false`). 그런데 이 커밋이 표지에
다시 건 문장 — *"이제 「띄울 수 있는가」와 「실제로 띄운다」가 **같은 폴더 목록**을 본다"* —
는 **codex 축에서 아직 거짓**이다. `search_dirs`가 안 보는 `CWD`를 `command_for`의
`cmd /C`는 본다. 그리고 그 칸을 안 닫은 근거로 적힌 두 문장 — 코드 주석의
*"지금 소비자에게 도달 경로가 없다"* 와 보고서 §9.7의 *"「없다고 했는데 뜬다」 방향이라
해지 생략 방향은 아니다"* — 는 **내 실측에서 둘 다 사실이 아니다.** 도달 경로는
`CodexDriver::spawn`의 `cmd.current_dir(&spec.cwd)`, 즉 **사용자가 연 프로젝트 폴더**이고,
「없다고 했는데 뜬다」는 **R1의 해지 생략을 낳은 바로 그 방향**이다(부호가 뒤집혀 인용됐다).
장부가 세 라운드 연속 「검증 안 된 문장」으로 결정을 정당화한다.

---

## 0. 격리와 안전 (먼저)

| 무엇 | 값 |
|---|---|
| 판정 트리 | `git archive HEAD`(0127b75) → `C:\Temp\ccg-x2r2` — 옆 갈래의 미커밋(ccg-auth 4 · scripts 4 · docs 1)이 **한 바이트도 안 섞였다**(node_modules만 정션) |
| 대조군 트리 | 같은 archive → `C:\Temp\ccg-x2r2ctl`(`search_dirs`의 exe_dir 칸 **한 곳** + `hub.rs cli_path` **한 줄**만 되돌림) · `C:\Temp\ccg-x2r2fsctl`(`show_at`의 트리 가드 **세 줄**만 제거) |
| CARGO_TARGET_DIR | `C:\Temp\ccg-x2r2-tgt` · `-tgtp`(테스트·탐침) · `ccg-x2r2ctl-tgt` · `ccg-x2r2fsctl-tgt` — 레포의 `target*`은 **한 번도** 안 썼다 |
| 수정본 exe | `…\ccg-x2r2-tgt\release\agentcodegui.exe` · md5 `ad55164e263808df35c5e9dbb4429bc9` · **6,483,968 B** |
| 대조군 exe | `…\ccg-x2r2ctl-tgt\release\agentcodegui.exe` · md5 `91a14630254ac11a2b37d6a610ee1d65` · **6,483,456 B**(해시·크기 둘 다 다르다 = 같은 파일을 두 번 잰 게 아니다) |
| 빌드 | 둘 다 `cargo build --release --features custom-protocol`(프론트는 트리 안에서 `vite build`로 새로 구웠다) |
| CDP 포트 | **9761 · 9763 · 9765 · 9767 · 9769** (빌더 9741~9745 · 크리틱 R1 9701~9707 · 옆 갈래와 무충돌) |
| kill | `killTree`(자기가 spawn한 PID 트리)뿐. **이름 기반 kill 0회** — 주행 내내·주행 후 사용자 실앱 `…\Programs\AgentCodeGUI\AgentCodeGUI.exe` **6프로세스 그대로**(tasklist로 확인) |
| 실계정·실 HTTP | 합성 계정·가짜 CLI만. codex 하네스는 `CCG_NO_NET=1`, 클로드 축은 해지를 재야 해서 `CCG_NO_NET=0` + `HTTPS_PROXY=http://127.0.0.1:9` → 실 HTTP 0건 · **토큰 회전 0** |
| 기준 결과 파일 | 무접촉. 새 산출물은 새 이름으로만: `docs/critic/claude-path-critextnr2(.ctl).json` · `codex-path-critextnr2.json` · `gatespawn-critextnr2.json` · `fsprobe-critextnr2(.ctl).json` · `claude-axis-m-critextnr2(.ctl).json` |
| 커밋 | 이 파일 하나만 — `git commit --only docs/critic/r28d-extn-critic-r2.md` |

---

## 1. 체크1 — `codex.exe` 철자 팔이 초록인가 · 기존 4팔 무회귀

승격 하네스 `scripts/poc-codex-path.mjs`를 **한 글자도 안 고치고** 내가 구운 exe에 물렸다
(격리 홈 `.poc-home-critx2r2` · CDP 9769 · `CCG_NO_NET=1`).

| 팔 | 씨앗 | 발사 | 최종 probe | 대기표 |
|---|---|---|---|---|
| A 전역 PATH | `CCG_CODEX_BIN=codex` | 안 함 | `asks:2 fetches:1 unavailable:2 unknown:0` | 살아 있음 |
| B 앱 설치본 | 절대 경로 | 안 함 | 같은 값 | 살아 있음 |
| **C 아무 데도** | PATH에서 codex 제거 | **t=91초 발사** | `asks:1 unavailable:0 unknown:1` | 사라짐 |
| **E 확장자 붙은 맨 이름** | `CCG_CODEX_BIN=codex.exe` | 안 함 | `asks:2 fetches:1 unavailable:2 unknown:0` | 살아 있음 |
| D 이 컴퓨터의 진짜 전역 codex | 우회로 없음 | 안 함 | 같은 값(`where codex` = `…\Roaming\npm\codex`·`codex.cmd`) | 살아 있음 |

**PASS 12 / FAIL 0 · `verdict.hole = false`.** C가 옛 계약대로 여전히 빨갛게 쏜다는 것이
A·E의 초록이 "전부 unavailable로 만들어 얻은 가짜 초록"이 아님을 잠근다. D는 실물로 돌았고
**발사 0** = 사용자의 실 codex 프로세스는 한 번도 안 떴다. → `docs/critic/codex-path-critextnr2.json`

E팔 전용 대조군은 R1에서 이미 `hole:true`로 갈렸고(그 두 줄은 이번 커밋이 안 건드렸다)
이번 라운드의 diff는 그 자리를 지나가지 않는다 — 그래서 여기서는 **무회귀만** 확인했다.

---

## 2. 체크2 — 클로드 축 (실 exe · 네 판)

### 2.1 X·P·N — 새 하네스 `poc-claude-path.mjs`(빌더 커밋본, 무수정)

세 팔 모두 앱 exe를 복사한 폴더에서 띄우고 `CCG_CLAUDE_BIN`은 지웠다(= 진짜 폴백 사슬).

| 팔 | 로그인 | 로그인 URL | **로그아웃 = 해지 호출** | AI 커밋 메시지 게이트 |
|---|---|---|---|---|
| **X 실행 파일 옆** | NO_BIN 아님 | `https://claude.ai/oauth/authorize?code=FAKE-T1T2&…` 도착 | **호출됨** → `…\x\home\accounts\seed-critextnr2_claudepath.test-1lh534` | 통과 |
| **P 전역 PATH** | NO_BIN 아님 | 도착 | 호출됨(같은 모양) | 통과 |
| N 아무 데도 | `claude 실행 파일을 찾지 못했어요` | — | **0회**(옛 계약) | `설치된 엔진이 없어요…` |

**PASS 3팔 / FAIL 0** · `headline = {armX_logoutCalled:true, armX_loginNoBin:false}`.
→ `docs/critic/claude-path-critextnr2.json`

### 2.2 판별력 — 대조군 exe에서 **X팔만** 빨갛다

`search_dirs`의 exe_dir 한 칸과 `hub.rs`의 한 줄만 되돌린 exe(md5 `91a14630…`)에 **같은
하네스**를 물렸다:

```text
X : login=「claude 실행 파일을 찾지 못했어요」 · login-url 안 옴 ·
    aimsg=「설치된 엔진이 없어요…」 · **해지 호출 0회(.fake-logout-called 없음)**  → FAIL 5
P : 값이 한 칸도 안 바뀜(초록)      N : 값이 한 칸도 안 바뀜(초록)
```

**FAIL 5 · 전부 X팔.** 이 라운드가 닫았다고 말한 그 구멍이 정확히 그 자리에서만 열린다 =
겨눈 못이 맞고, 반대 방향의 거짓(있다고 답하고 못 띄움)도 안 생겼다.
→ `docs/critic/claude-path-critextnr2ctl.json`

### 2.3 관리 설치본(M) 무회귀 — 새 하네스에 **그 팔이 없어서** 따로 쟀다

`poc-claude-path.mjs`의 팔은 x·p·n 셋뿐이라 체크리스트의 「관리 설치본 무회귀」를 덮지
못한다. 크리틱 R1이 쓰던 M팔 탐침(`C:\Temp\ccg-crx2-claudeaxis.mjs`, 레포 밖)을 **두 exe에
각각** 물렸다:

| exe | M1 로그인 | M2 URL | M3 **해지 호출** | M4 aimsg |
|---|---|---|---|---|
| 수정본 | 통과 | 도착 | `called:true` | 통과 |
| 대조군 | 통과 | 도착 | `called:true` | 통과 |

**둘 다 PASS 4/0 · 값이 글자 하나까지 같다** = 관리 설치본 인구는 이 커밋에 영향을 안
받는다(경로가 박힌 값은 `is_bare_name`이 거짓이라 새 폴더 칸을 아예 안 지난다).
→ `docs/critic/claude-axis-m-critextnr2(.ctl).json`

### 2.4 게이트 ↔ 스폰 짝맞춤을 **앱의 두 함수로 직접** 물었다

`resolve_bin`(게이트)과 `command_for`(codex 스폰 조립기) + `Command::new`(클로드 스폰)를
같은 판에서 나란히 부르는 탐침을 판정 트리 안에 만들어(레포 밖) 네 판을 쟀다. 가짜 CLI는
탐침 자신의 사본이고, 「무엇이 실제로 떴나」는 그 사본이 남긴 표식으로 읽는다.

| 판 | `resolve_bin("claude.exe")` | `Command::new("claude.exe")`가 띄운 것 | `resolve_bin("codex")` | `command_for`가 띄운 것 |
|---|---|---|---|---|
| **sibling**(exe 옆) | `app\claude.exe` | **같은 파일** | `app\codex.EXE` | **같은 파일** |
| **cwd**(현재 폴더) | `null` | 못 띄움(일치) | `null` | **`cwd\codex.exe`를 띄웠다** ← ★ |
| **both**(양쪽) | `app\claude.exe` | 같은 파일 | `app\codex.EXE` | 같은 파일 |
| none | `null` | 못 띄움 | `null` | 못 띄움 |

sibling·both·none 세 판은 **완전 일치** = 이 라운드의 수정이 진짜로 두 답을 한 벌로 만들었다.
갈리는 칸은 하나 — **`cwd`** 다(§5).
→ `docs/critic/gatespawn-critextnr2.json`

---

## 3. 체크3 — `file_diff(cwd, "-dir")`가 정직한가

`ccg-fs`를 레포 밖에서 부르는 탐침 두 벌(판정 트리 / 트리 가드 세 줄만 걷어낸 트리)로 같은
씨앗 저장소를 물었다(git 2.53.0.windows.1).

| 물음 | 대조군(가드 없음) | **판정 트리** |
|---|---|---|
| `file_diff("-dir")` | `edit(add:0,del:3)` · head_content **22 B** | `diff:null` · `내용을 읽을 수 없어요` |
| `file_diff("보통dir")` | `edit(0,3)` · 23 B | 같은 답(수렴) |
| `file_diff("app/posts/[id]")` | `edit(0,3)` · 35 B | 같은 답 |
| `commit_file_diff(<sha>,"-dir")` | `edit(1,1)` · content **58 B** | `diff:null` · 사유 |
| `commit_file_diff(<sha>,"보통dir")` | `edit(1,1)` · 59 B | 같은 답 |
| `commit_file_diff(<sha>,"app/posts/[id]")` | `edit(1,1)` · 71 B | 같은 답 |
| `file_diff("-파일.txt")` | `edit(1,0)` | **`edit(1,0)`** — 못 그대로 |
| `file_diff("app/posts/[id]/page.tsx")` | `edit(0,0)` | 같은 값 — 대괄호(`:(literal)`) 못 그대로 |
| `file_diff("함정.txt")`(본문이 `tree HEAD:함정.txt`로 시작) | Text | **Text** — 거짓 양성이 답을 안 바꾼다 |
| `commit_file_diff("-파일.txt"·`[id]/page.tsx`·`함정.txt`) | 정상 | **정상**(content 8·4·33 B) |

폴더 세 모양이 두 얼굴(`file_diff`·`commit_file_diff`)에서 **다 정직**하고, 진짜 파일 못은
한 칸도 안 움직였다. 대조군이 폴더를 본문으로 읽는다는 것이 판별력이다.
→ `docs/critic/fsprobe-critextnr2(.ctl).json`

---

## 4. 체크4 — cargo(크레이트별) · typecheck · 장부

### 4.1 cargo (격리 홈 `C:\Temp\ccg-x2r2-home` · `CCG_NO_NET=1`)

| 크레이트 | 결과 | 기준 | 반복 주행 |
|---|---|---|---|
| `ccg-engine` | **219 통과 · 0 실패 · 2 ignored**(테스트 바이너리 15개 합) | 207(체크리스트) · 215(R1 실측) · 217(빌더) → **후퇴 없음** | lib **22/22** 초록 |
| `ccg-fs` | **101 · 0 · 2** | 100/101 → 후퇴 없음 | — |
| `agentcodegui` | **146 · 0 · 0** | 145/146 → 후퇴 없음 | **22/22** 초록 |

빌더가 적은 217과 내 219가 다른 이유는 기준점이다 — 내 트리는 그 커밋보다 뒤(HEAD)라 옆
갈래가 그 사이에 못을 더 박았다. **후퇴는 없다.**

새 못 둘의 판별력도 확인했다 — exe_dir 칸만 걷어낸 대조군에서 **정확히 둘만** 빨갛다:

```text
the_folder_of_the_running_exe_is_searched_before_path        FAILED
  left: Some("…\Temp\ccg-codex-ver-order-path-32444") / right: Some("C:\Temp\ccg-x2r2ctl-tgt\debug\deps")
the_gate_and_a_real_spawn_agree_when_the_cli_sits_next_to_the_exe  FAILED
  ★ 스폰은 되는데 게이트가 「없다」고 답했다 — left: None / right: Some("…\deps\ccg-extn-sibling-32444.exe")
test result: FAILED. 9 passed; 2 failed  (codex::versions 필터)
```

두 번째 못이 **진짜 `CreateProcess`로** 잰다는 점(테스트 바이너리를 실행 파일 옆에 복사해
게이트와 스폰을 나란히 묻는다)도 소스로 확인했다. 뒷정리도 한다 — 주행 뒤 세 target 트리
어디에도 `ccg-extn-sibling-*.exe` 잔여 **0개**.

### 4.2 typecheck

`typecheck:node` · `typecheck:web` · `typecheck:app` **전부 exit 0** — 판정 트리(`C:\Temp\ccg-x2r2`)와
레포 워킹트리(옆 갈래 미커밋이 얹힌 상태) **양쪽에서** 세 종 다 초록이다.

### 4.3 장부 정정 ② — 이번엔 **사실이다** ✅ (내가 다시 셌다)

| 장부의 문장 | 내 실측 |
|---|---|
| `resolve_bin` 호출자는 **넷** | 맞다 — `codex_versions.rs:139`(codex_exe) · `:147`(spawn_bin) · `versions.rs:162`(claude_exe) · `:170`(claude_spawn_bin). 그 밖은 전부 doc 링크 |
| codex 한도 재검증 1회 = **3번** | 맞다 — `codex_limit.rs:121`(can_ask) · `:138`(instrument) · `:224`(spawn_bin) |
| AI 커밋 메시지 1회 = **2번** | 맞다 — 게이트 `aimsg.rs:`**271**` · 스폰 `:361`(장부는 `:268`이라 적었다 — 주석 블록 시작 줄이다. 3줄 어긋남, 값은 맞다) |
| 최악 **506 stat**(PATH 46 × PATHEXT 11) | 맞다 — 내가 `cmd`로 다시 세도 46 · 11 |
| `codex_versions.rs`의 「허브 tick이 부르는 자리다」 삭제 | 맞다(디프로 확인) |
| `system32`·`windows`는 사실상 언제나 PATH에 있다 | 맞다 — 이 컴퓨터 PATH에 `c:\windows\system32`·`c:\windows` 둘 다 있다 |

R1이 지적한 「정정문 자체가 거짓」은 **닫혔다.** ①(`-`로 시작하는 폴더 argv)은 R1에서 이미
내 손으로 확인한 자리라 다시 재지 않았다.

---

## 5. ★남은 구멍 — `CWD`. 그리고 그것을 안 닫은 **근거 두 문장이 거짓이다**

### 5.1 무엇이 갈리나

`search_dirs`가 세운 목록은 `[실행 파일 폴더] + PATH`다. 그런데 codex 축의 실제 스폰은
`command_for`가 만드는 `cmd /C ""codex" app-server"`이고, **`cmd.exe`는 PATH보다 먼저
현재 폴더를 본다.** 게이트는 그 칸을 안 본다.

```text
resolve_bin("codex")                     = null   ← 게이트: "물어볼 창구가 없다"
cmd /C ""codex" app-server" (cwd=프로젝트) = 뜬다   ← 스폰:   그 폴더의 codex.exe를 띄웠다
```

### 5.2 「도달 경로가 없다」는 틀렸다 — 그 CWD는 **사용자가 연 프로젝트 폴더**다

`crates/ccg-engine/src/codex/driver.rs:180·184`:

```rust
let mut cmd = command_for(&self.bin);
…
cmd.current_dir(&spec.cwd)          // ← 채팅의 작업 폴더가 자식의 현재 폴더가 된다
```

부모의 CWD는 딴 데 두고 **자식의 작업 폴더만** 프로젝트 폴더로 준 뒤 같은 명령줄을 그대로
쏴 봤다(드라이버가 하는 그대로):

```text
parentCwd = C:\Temp                     childCwd = C:\Temp\ccg-x2r2-projtest
cmd /C ""codex" app-server"  → exit 0 · 실제로 뜬 파일 = C:\Temp\ccg-x2r2-projtest\codex.exe
```

즉 **PATH에도 exe 옆에도 codex가 없는 사용자가 `codex.exe`가 들어 있는 폴더를 열면**,
게이트는 「창구 없음」이라 답하고(→ `can_ask=false` → `Unknown` → **눈감고 발사**, R28c
CPATH가 지운 바로 그 사고) 턴은 **그 폴더의 실행본으로 뜬다.** 도달 경로는 있다.

> 참고: 이 갈래는 **이번 라운드가 만든 회귀가 아니다**(R28c부터 열려 있었다). 문제는
> 「닫지 않았다」가 아니라 **「닫지 않은 근거로 적힌 문장이 검증되지 않은 채 사실로
> 적혔다」**는 것이다 — R1이 FAIL을 준 바로 그 항목의 재발이다.

### 5.3 두 번째 문장은 **부호가 뒤집혔다**

보고서 §9.7 · 코드 주석:

> 둘 다 「없다고 했는데 뜬다」 방향이라 **해지 생략 방향은 아니다** — 방향이 다르다는 것이
> 이 라운드의 판단 근거다.

R1이 잡은 해지 생략은 **정확히 「없다고 했는데 뜬다」였다**(게이트 `None` → `ipc/accounts.rs`
`logout`이 해지 갈래를 건너뜀). 방향이 같다. 클로드 축에서 CWD가 안전한 진짜 이유는 방향이
아니라 **Rust `Command`가 CWD를 아예 안 보기 때문**이고(내 탐침 `cwd` 판: 게이트 `null` ·
스폰 실패 — 두 답이 일치), 그 사실은 장부 어디에도 없다. 맞는 결론에 틀린 이유가 붙어 있다.

### 5.4 하네스가 이 칸을 영원히 못 보는 이유 (측정 위생)

Git Bash가 주는 환경에는 `NoDefaultCurrentDirectoryInExePath=1`이 **들어 있다**(레지스트리
`HKCU\Environment`·`HKLM\…\Session Manager\Environment` 어디에도 없다 = 셸이 넣는 값이다).
그 변수가 있으면 `cmd`가 현재 폴더를 안 뒤진다. 그래서 **셸에서 띄운 하네스는 이 구멍을
구조적으로 못 본다** — 내 첫 주행도 그 변수 때문에 `ran:null`이 나왔고, 지운 뒤 다시 재서야
`cwd\codex.exe`가 떴다. 데스크탑에서 실행되는 사용자 앱에는 그 변수가 없다.

---

## 6. 판정 요약

| 체크 | 결과 |
|---|---|
| 1) `codex.exe` 철자 팔 초록 · 기존 4팔 무회귀 | ✅ **PASS 12/0 · `hole:false`**(C만 t=91초 발사 = 판별력 유지) |
| 2) 클로드 축 X·P·N (로그인 URL · **해지** · 커밋 메시지) | ✅ **PASS 3팔** · 대조군 **FAIL 5 = X팔만** |
| 2') 관리 설치본 무회귀 | ✅ 두 exe에서 **PASS 4/0 · 값 동일**(새 하네스엔 이 팔이 없어 따로 쟀다) |
| 2'') 게이트 ↔ 스폰이 한 벌인가 | ⚠️ **sibling·both·none 일치** · **`cwd`에서 갈린다**(codex 축) |
| 3) `file_diff("-dir")` 정직 · 못 무회귀 | ✅ 폴더 3종 × 두 얼굴 수렴 · `-파일`/대괄호/함정 파일 그대로 · 대조군은 트리를 본문으로 읽음 |
| 4) cargo 크레이트별 · typecheck | ✅ **219 / 101 / 146** · 반복 22+22회 흔들림 0 · typecheck 3종 exit 0 · 새 못 둘은 대조군에서 정확히 둘만 빨강 |
| 4') 장부 정정 ② | ✅ **사실이다**(호출자 넷 · 3회/2회 · 506 stat · tick 문장 삭제) |
| 4'') **새로 들어온 장부 문장** | ❌ **거짓 둘** — 「CWD는 도달 경로가 없다」(있다: 채팅 폴더) · 「「없다고 했는데 뜬다」는 해지 생략 방향이 아니다」(그 방향이 맞다) |

**가장 치명적인 하나** — §5. 이 커밋이 표지에 다시 건 불변식(「띄울 수 있는가」와 「실제로
띄운다」가 같은 폴더 목록)이 codex 축에서 아직 서지 않고, 그 틈이 **사용자가 연 프로젝트
폴더**로 열린다. 게이트는 「창구 없음」이라 답해 한도 재검증을 `Unknown`(눈감고 발사)으로
떨어뜨리면서, 턴은 그 폴더 안의 `codex.exe`를 띄운다. 그리고 그 칸을 남겨 둔 근거로 적힌
두 문장이 **검증되지 않은 채 사실로 적혔다** — R1이 FAIL을 준 항목(§4.4)과 같은 집안이다.

**다음 라운드가 해야 할 것 (순서대로)**

1. codex 축의 마지막 칸을 닫는다. 둘 중 하나면 충분하다 —
   (a) `spawn_bin()`이 **못 찾으면 맨 이름을 안 넘긴다**(스폰을 그 자리에서 실패시켜
   「없다」를 한 벌로 만든다), 또는 (b) `search_dirs`가 codex 축에 한해 `CWD`(= 채팅 폴더)를
   본다. (a)가 규칙을 줄이는 쪽이고 (b)는 「그 폴더의 실행본을 엔진으로 띄운다」는 지금 동작을
   유지한다 — **어느 쪽을 고르든 그 선택 자체가 결정이라 장부에 이유를 남겨야 한다.**
   못 하나가 필요하다: 「프로젝트 폴더에만 codex가 있는 판에서 게이트와 스폰의 답이 같다」.
2. 하네스가 그 칸을 볼 수 있게 `NoDefaultCurrentDirectoryInExePath`를 지우고 재라(§5.4).
   지금 상태로는 어떤 셸 하네스도 이 회귀를 못 잡는다.
3. 장부의 두 문장을 지우거나 **잰 값으로** 다시 적는다. 「검증된 문장만 적는다」가 이
   라운드가 스스로 세운 규율이고, 이번에도 그 규율이 결정의 근거 자리에서 깨졌다.
