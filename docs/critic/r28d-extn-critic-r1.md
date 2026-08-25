# R28d 「EXTN」 확인 크리틱 R1

> 대상 커밋 `aec79f6`(1/3) · `a7b2636`(2/3) · `1629dfc`(3/3) · `24d16af`(보고서).
> 판정 기준 트리 = `459993b`(feature/3.0.0-beta HEAD). **빌더의 보고서·커밋 메시지는 한 줄도
> 근거로 쓰지 않았다** — 전부 새로 빌드하고 새로 재고 그 값만 인용한다. 코드·하네스 무수정.

**결론: FAIL.** 겨눈 세 축(codex 철자 · 클로드 계정 명령 · 폴더를 파일로 읽던 자리)은
**내 손으로 재도 진짜로 뒤집힌다.** 그런데 이 라운드가 자기 입으로 세운 헤드라인 불변식 —
*"「띄울 수 있는가」는 앱에 **한 자리**뿐이다 · 규칙이 두 벌이 되면 「띄울 수 있다」와
「실제로 띄운다」가 서로 다른 값을 보게 된다"* — 은 **아직 서 있지 않다.** 새 게이트
`claude_exe()`는 **PATH만** 훑는데 턴 스폰은 `Command::new(맨 이름)`이라 **실행 파일이
있는 폴더**를 PATH보다 먼저 본다. 그 한 칸 차이에서 게이트는 "없다", 스폰은 "있다"가 되고,
그 판의 로그아웃은 **토큰 해지를 조용히 건너뛴다** — 이 라운드가 스스로 "뇌관"이라 부른
바로 그 방향이다(부호만 뒤집혔다). 장부 정정 둘 중 하나(`resolve_bin` 캐시 근거)는
**정정된 문장 자체가 사실이 아니다**.

---

## 0. 격리와 안전 (먼저)

| 무엇 | 값 |
|---|---|
| 판정용 트리 | `git archive HEAD`(459993b) → `C:\Temp\ccg-crx2` — **옆 갈래의 미커밋(ccg-auth 4파일)이 한 바이트도 안 섞였다** |
| 대조군 트리 | 같은 archive → `C:\Temp\ccg-crx2ctl`(`scan_path` 두 줄만 제거) · `C:\Temp\ccg-crx2fsctl`(`show_at` 트리 가드 네 줄만 제거) |
| CARGO_TARGET_DIR | `C:\Temp\ccg-crx2-tgt` · `-ctl-tgt` · `-fsctl-tgt` (레포 안 `target-*`은 **한 번도** 안 썼다) |
| 수정본 exe | `C:\Temp\ccg-crx2-tgt\release\agentcodegui.exe` · md5 `242f406ec3c740ab3b7bce556b6dd5fe` · **6,483,456 B** |
| 대조군 exe | `C:\Temp\ccg-crx2ctl-tgt\release\agentcodegui.exe` · md5 `1166f000f3057934a875d2d408204ec2` · **6,482,944 B** (해시·크기가 둘 다 다르다 = 빌더가 밟았다는 `copyFileSync` mtime 함정에 안 빠졌다) |
| CDP 포트 | 9701 · 9703 · 9705 · 9707 (빌더 9481~9483, 옆 갈래와 무충돌) |
| 격리 홈 | `.poc-home-critx2`(수정본) · `.poc-home-critx2c`(대조군) — 주행 후 잔여 **0** · 그 밖은 전부 `C:\Temp\ccg-crx2-*` |
| 실계정·실 HTTP | 합성 계정만. codex 하네스는 `CCG_NO_NET=1`. 클로드 축은 **해지 갈래를 재야 해서** `CCG_NO_NET`을 일부러 껐고 대신 `HTTPS_PROXY=http://127.0.0.1:9`로 밖으로 나가는 길을 막았다 → 실 HTTP **0건 · 토큰 회전 0** |
| kill | 자기가 spawn한 PID 트리만(`killTree`). 이름 기반 kill **0회** — 주행 내내 사용자의 실앱(`…\Programs\AgentCodeGUI\AgentCodeGUI.exe` 5프로세스)은 무접촉 |
| 기준 파일 | 새 이름으로만 썼다: `docs/critic/codex-path-critextnr1v2.json` · `…v2ctl.json`. 기존 산출물 무접촉 |
| 커밋 | 이 파일 하나만 `git commit --only docs/critic/r28d-extn-critic-r1.md` |

---

## 1. 체크1 — `codex.exe` 철자 팔이 진짜로 초록으로 뒤집히는가 · 기존 4팔 무회귀

승격 하네스 `scripts/poc-codex-path.mjs`를 **한 글자도 안 고치고** 내가 구운 exe에 물렸다.

### 1.1 수정본 — **PASS 12 / FAIL 0 · `hole:false`**

| 팔 | 씨앗 | 발사 | 최종 probe | 대기표 |
|---|---|---|---|---|
| A 전역 PATH | `CCG_CODEX_BIN=codex` | **안 함** | `asks:2 fetches:1 unavailable:2 unknown:0` | 살아 있음 |
| B 앱 설치본 | 절대 경로 | 안 함 | 같은 값 | 살아 있음 |
| C 아무 데도 | PATH에서 codex 제거 | **t=90초 발사** | `asks:1 fetches:0 unavailable:0 unknown:1` | 사라짐 |
| **E 확장자 붙은 맨 이름** | `CCG_CODEX_BIN=codex.exe` | **안 함** | `asks:2 fetches:1 unavailable:2 unknown:0` | **살아 있음** |
| D 이 컴퓨터의 진짜 전역 codex | 우회로 없음 | 안 함 | `asks:2 fetches:1 unavailable:2 unknown:0` | 살아 있음 |

C가 옛 계약대로 **여전히 빨갛게 쏜다**는 것이 A/E 초록이 가짜가 아님을 잠근다(전부
`unavailable`로 만들어 얻은 초록이 아니다). D는 이 컴퓨터의 실물
(`…\Roaming\npm\codex` + `codex.cmd`)로 돌았고 **발사 0** = 사용자의 실 codex 프로세스는
한 번도 안 떴다.
→ `docs/critic/codex-path-critextnr1v2.json`

### 1.2 대조군 — **FAIL 4/3 · `hole:true`** (판별력 증명)

`scan_path`의 **두 줄만** 걷어낸 트리를 따로 구워(md5 `1166f000…`) 같은 하네스를 물렸다.

```
A(codex)     → 초록 그대로 : asks:2 unavailable:2 unknown:0 · 미발사   ← R28c의 못은 안 건드렸다
E(codex.exe) → 빨강        : asks:1 unavailable:0 unknown:1 · t=90초 발사 · 대기표 소멸
verdict      : {"E.fired":true,"E.unknown":1,"hole":true}
```

**A는 초록인데 E만 빨갛다** = E팔은 이 라운드가 세운 규칙의 **전용 못**이고, 그 두 줄이
빠지면 정확히 그 자리만 다시 열린다. 겨눈 구멍은 진짜로 닫혔다.
→ `docs/critic/codex-path-critextnr1v2ctl.json`

---

## 2. 체크2 — 클로드 축 (전역 PATH `claude.exe` · 관리 설치본 · 없음)

코드 읽기로 넘기지 않고 **실 exe를 띄워** 쟀다(격리 홈 · `ccg-fake-claude.exe`를 `claude.exe`로
심음 · CDP 9705 · `auth:login-url`은 `plugin:event|listen`으로 렌더러에서 직접 구독).
이 컴퓨터는 크리틱이 지목한 그 인구다 — `where claude` = `C:\Users\User\.local\bin\claude.exe`.

| 팔 | 로그인 | 로그인 URL | **로그아웃 = 토큰 해지 호출** | AI 커밋 메시지 게이트 |
|---|---|---|---|---|
| **P 전역 PATH** | NO_BIN 아님 | `https://claude.ai/oauth/authorize?…` **도착** | **호출됨** — 가짜 CLI가 `…\accounts\seed_crx2.test-14goa20`을 향해 불렸다 | 통과(그 뒤 계정 사유로 실패) |
| **M 관리 설치본** | NO_BIN 아님 | 도착 | 호출됨(같은 값) | 통과 → **무회귀** |
| N 아무 데도 | `claude 실행 파일을 찾지 못했어요` | — | 호출 **0회** | `설치된 엔진이 없어요…` |

PASS 11 / FAIL 0. 세 축(로그인 URL · 해지 · 커밋 메시지)이 전역 PATH 판에서 **전부 돈다**.
관리 설치본은 값이 한 칸도 안 바뀌었다.

### 2.1 ★그런데 게이트와 스폰이 아직 두 벌이다 — 「앱 exe 옆」 (미해결 · 이 라운드의 헤드라인 불변식)

`claude_exe()` = `resolve_bin(claude_bin())`은 **PATH만** 훑는다. 턴 스폰은
`engine/hub.rs:290 cli_path() → claude_bin()`(맨 이름 그대로)이고
`crates/ccg-engine/src/driver.rs:348 Command::new(&spec.cli)`로 나간다. Rust std의
`Command`는 CreateProcess와 같은 순서로 찾는다 — **실행 파일이 있는 폴더 → (CWD는 제외) →
system32 → windows → PATH**. 즉 `resolve_bin`은 그 앞칸 하나를 **안 본다**.

내 탐침(`crates/ccg-engine/examples/binprobe.rs`, 대조 트리 안에서만 만든 파일):

```text
① claude.exe가 **실행 파일 옆**, PATH에는 없음
   resolve_bin("claude.exe") = null      ← 게이트: "없다"
   Command::new("claude.exe").spawn()    = ok(exit 2)   ← 스폰: "있다"
② claude.exe가 **CWD**에만 있음  → 둘 다 없다(Rust std는 CWD를 안 본다)
③ 어디에도 없음                  → 둘 다 없다
```

그 상태를 실 앱으로 그대로 재현했다(팔 X — 앱 exe를 통째로 복사한 폴더에 `claude.exe`를
같이 두고 PATH에서는 claude를 걷어냈다):

```text
login   → "claude 실행 파일을 찾지 못했어요"
logout  → .fake-logout-called 없음   = **토큰 해지가 조용히 생략됐다**
aimsg   → "설치된 엔진이 없어요 — 설정 → Engine에서 먼저 설치해 주세요"
같은 폴더·같은 PATH에서 binprobe: resolve_bin=null / spawn=ok(exit 2)
```

즉 그 판의 앱은 **그 CLI로 턴은 띄우면서** 계정 화면에서는 "실행 파일이 없다"고 답하고,
로그아웃은 서버에 살아 있는 토큰을 남긴 채 끝난다. `hub.rs:283`의 주석이 스스로 경고한
*"그 경로가 두 곳에 적혀 있으면 한쪽만 고쳐지는 순간 「채팅은 도는데 로그인만 안 되는」
상태가 태어난다"* 가 **이 라운드에서 태어났다.** 2/3의 이유서가 "판정이 거짓으로 기울면
UI 문구가 아니라 토큰 해지가 조용히 생략된다"였는데, R28c의 거짓(항상 참 = 판정 안 함)을
지우면서 **반대 방향의 거짓(PATH에 없으면 무조건 없다)** 을 새로 들였다.

인구는 얇다(설치 폴더에 `claude.exe`를 같이 두는 사용자). 그러나 **불변식은 인구가 아니라
규칙이다** — 빌더가 「미완」으로 적은 `hub.rs:290`은 "경계 밖"이 아니라 **이 라운드가 세운
불변식이 서지 않는 자리**다. 고치는 법은 둘 중 하나로 충분하다: `scan_path`가 PATH 앞에
`current_exe().parent()`를 한 칸 넣거나, `hub.rs`가 `claude_spawn_bin()`을 쓰게 해서 두
자리가 같은 함수를 보게 하거나.

---

## 3. 체크3 — `file_diff(cwd, "-dir")`이 정직한가 (폴더를 파일 본문으로 읽던 자리)

`ccg-fs`를 **레포 밖에서** 부르는 탐침 두 벌(수정본 트리 / 트리 가드 네 줄만 걷어낸 트리)로
같은 씨앗 저장소를 물었다.

| 물음 | 대조군(가드 없음) | **수정본** |
|---|---|---|
| `file_diff("-dir")` | `edit(add:0, del:4)` · **head_content 28바이트** | `diff:null` · `내용을 읽을 수 없어요` |
| `file_diff("보통dir")` | `edit(0, 4)` · head_content 29B | 같은 답(**수렴**) |
| `file_diff("app/posts/[id]")` | `edit(0, 3)` · head_content 35B | 같은 답 |
| **`commit_file_diff(<sha>, "-dir")`** | **`edit(1, 1)` · content 64바이트** ← 커밋 뷰어가 **트리 목록을 파일 본문으로** 그린다 | `diff:null` · 사유 |
| `commit_file_diff(<sha>, "보통dir")` | `edit(1,1)` · content 65B | 같은 답 |
| `file_diff("-파일.txt")` | `edit(1,1)` | `edit(1,1)` — 못 그대로 |
| `file_diff("app/posts/[id]/page.tsx")` | `edit(1,1)` | `edit(1,1)` — 대괄호 못 그대로 |
| `file_diff("함정.txt")`(내용이 `tree HEAD:함정.txt`로 시작) | Text | **Text**(거짓 양성이 답을 안 바꾼다) |

빌더가 인용한 `("edit",0,4)`는 **내 손에서 그대로 재현됐다.** 덧붙여 빌더가 재지 않은 얼굴이
하나 더 있었다 — **`commit_file_diff`** 도 같은 병을 앓고 있었고(커밋 시점 조회의 `content`가
트리 목록 64바이트) 같은 세 줄이 그것도 같이 닫는다.

### 3.1 트리거(`tree <spec>\n`)가 진짜로 안 새는가 — git 2.53.0.windows.1 직접 실측

판정을 `cat-file -t`에 맡기더라도 **트리거를 못 밟으면** 그 자리가 그대로 샌다. 그래서 spec
아홉 모양을 내가 직접 물었다. 전부 **준 spec을 글자 그대로 되뱉는다**(= 트리거가 걸린다):

```text
HEAD:-dir            → "tree HEAD:-dir\n\n…"          cat-file -t = tree
HEAD:보통dir          → "tree HEAD:<UTF-8 그대로>\n"    (quotepath 인용 없음)
HEAD:app/posts/[id]  → "tree HEAD:app/posts/[id]\n"   (글롭 매직도 그대로)
HEAD:n/e/s/t         → 그대로     HEAD:            → "tree HEAD:\n"(루트 트리)
HEAD:보통dir/         → 끝 슬래시까지 그대로
HEAD^:-dir · <40자 sha>:-dir · HEAD^^{tree}:-dir → 전부 그대로
```

경계 하나 더 — **서브모듈(gitlink)** 은 트리 목록이 아니라 `exit 128 / "bad object"`라
`Blob::Absent`로 떨어진다(트리 누수 아님). 즉 이 자리에서 본문으로 새는 건 **트리**뿐이고
그 트리는 닫혔다.

---

## 4. 체크4 — cargo(크레이트별) · typecheck · 장부 두 곳

### 4.1 cargo (전부 격리 홈 `C:\Temp\ccg-crx2-home` · `CCG_NO_NET=1`)

| 크레이트 | 결과 | 기준 | 반복 주행 |
|---|---|---|---|
| `ccg-fs` | **101 통과 · 0 실패 · 2 ignored** | 100 → 후퇴 없음 | **20/20** 초록(9.06~9.99s) |
| `ccg-engine` | **215 통과 · 0 실패 · 2 ignored**(테스트 바이너리 14개 합) | 207 → 후퇴 없음 | lib **20/20** 초록 |
| `agentcodegui` | **146 통과 · 0 실패** | 145 → 후퇴 없음 | **22/22** 초록(1.47~1.62s) |

`ccg-engine`이 빌더가 적은 212가 아니라 215인 이유는 내 기준점이 3커밋 뒤(HEAD=459993b)라
옆 갈래(CASX)가 그 사이에 못을 더 박았기 때문이다 — **후퇴는 없다**.
`agentcodegui`에는 프로세스 전역 `PATH`를 잠깐 갈아치우는 새 테스트가 있어 22회를 연달아
돌렸다(그중 다수는 다른 앱 주행과 CPU를 다투는 중에 돌았다) — **흔들림 0**.

### 4.2 typecheck

`typecheck:node` · `typecheck:web` · `typecheck:app` **전부 exit 0**(archive 트리에서 주행).

### 4.3 장부 정정 ① — 「`-`로 시작하는 폴더는 열기로 못 연다」 → **정정이 옳다** ✅

두 자리에 다 적혀 있다(`docs/parity-fix-gdash-r1.md` §5 정정 블록 + `ipc/parity/misc.rs`
`initial_dir` 헤더). 문장이 사실인지 **내 릴리스 exe로 다시 쟀다**(CDP 9707 · 격리 홈):

```text
argv = "C:\Temp\ccg-crx2-argv\-열어볼폴더" (절대)  → getInitialDirectory() = 그 경로   ← 열린다
argv = "-열어볼폴더"                        (상대)  → null                              ← 이때만 못 연다
```

탐색기 컨텍스트 메뉴는 `"%1"` = 절대 경로다. **원래 문장이 틀렸고 정정이 맞다.**

### 4.4 장부 정정 ② — `resolve_bin` 캐시 근거 → **정정된 문장도 사실이 아니다** ❌

`crates/ccg-engine/src/codex/versions.rs`의 새 헤더는 이렇게 적었다:

> 진짜 수혜자는 **설정 ▸ Account의 게이지 조회**(`accounts_usage()`)다: 계정 수만큼 연달아
> 물으므로 그 한 화면에서 PATH 훑기가 N번 된다.

호출 그래프를 직접 떠 보면 **둘 다 틀렸다**:

1. `accounts_usage()`는 `src-tauri/src/ipc/parity/usage.rs`에 있고 그 파일 전체에
   `resolve_bin` · `codex_exe` · `claude_exe` · `versions::` 참조가 **0건**이다. 그것이
   도는 자리는 `ccg_auth::claude::list_accounts()` + HTTP 조회이고, **`ccg-auth`는
   `ccg-engine`에 의존조차 하지 않는다**(`crates/ccg-auth/Cargo.toml`의 deps = ccg-store ·
   serde · sha2 · ureq). 즉 그 함수는 `resolve_bin`에 **닿을 방법이 없다**.
2. `resolve_bin`의 호출자는 앱 전체에서 딱 넷이다 — `codex_exe` · `spawn_bin`(codex) ·
   `claude_exe` · `claude_spawn_bin`. 그중 **계정 수만큼 도는 자리는 하나도 없다.**
   가장 가까운 후보 `ipc/parity/codex.rs:74`는 `models()` 안이고 그 위에
   **`TTL = 300초` 캐시**가 앉아 있다 — 한 화면에 N번이 아니라 5분에 1번이다.

1/3 커밋 메시지가 이 정정을 두고 *"검증되지 않은 문장을 사실로 고쳐 적었다"* 고 했는데,
실제로는 **검증되지 않은 문장을 다른 검증되지 않은(그리고 틀린) 문장으로 바꿨다.**
캐시 자체의 정당성은 흔들리지 않지만(맨 이름 해석은 46칸 PATH × PATHEXT라 비싸다),
근거로 적힌 소비자는 실재하지 않는다. 장부는 "두 곳 정정"이 아니라 **한 곳 정정 + 한 곳
새 오기**다.

---

## 5. 판정 요약

| 체크 | 결과 |
|---|---|
| 1) `codex.exe` 철자 E팔 초록 · 기존 4팔 무회귀 | ✅ PASS 12/0 `hole:false` · 대조군 FAIL 4/3 `hole:true`(A는 초록 유지 = 전용 못) |
| 2) 클로드 축 P/M/N (로그인 URL · 해지 · 커밋 메시지) | ✅ PASS 11/0 · 관리 설치본 무회귀 |
| 2') 게이트와 스폰이 **한 벌**인가 | ❌ **아니다** — PATH만 보는 게이트 vs 실행 파일 폴더까지 보는 스폰 · 그 판의 로그아웃이 해지를 생략 |
| 3) `file_diff("-dir")` 정직 · 못 무회귀 | ✅ 폴더 3종 수렴 · `commit_file_diff`까지 같이 닫힘 · `-파일`/대괄호/함정 파일 그대로 |
| 4) cargo 크레이트별 · typecheck | ✅ 101 / 215 / 146 · 반복 20~22회 흔들림 0 · typecheck 3종 exit 0 |
| 4') 장부 두 곳 정정 | ❌ **1/2** — ①은 옳고(내가 재확인) ②는 **정정문 자체가 거짓** |

**가장 치명적인 하나** — §2.1. 이 라운드가 표지에 건 불변식(「띄울 수 있는가」는 한 자리)이
아직 서 있지 않고, 그 틈이 하필 라운드가 스스로 "뇌관"이라 부른 방향(로그아웃의 토큰 해지
생략)으로 열린다.

**다음 라운드가 해야 할 것 (제안, 순서대로)**

1. `resolve_bin`이 PATH 앞에 `std::env::current_exe().parent()`를 한 칸 넣거나 —
   또는 `hub.rs:290`을 `claude_spawn_bin()`으로 바꿔 두 자리가 **같은 함수**를 보게 한다.
   어느 쪽이든 못 하나가 필요하다: 「실행 파일 옆에만 CLI가 있는 판에서 게이트와 스폰의
   답이 같다」.
2. `resolve_bin` 헤더의 캐시 근거 문장을 실제 호출자(넷)로 다시 적는다. 「검증된 문장만
   적는다」가 이 라운드의 규율이었다.
