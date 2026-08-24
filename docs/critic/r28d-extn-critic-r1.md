# R28d 「EXTN」 확인 크리틱 R1 — **세 축 전부 내 손에서 뒤집혔다.** 그런데 「도달 경로가 없다」고 적어 둔 그 자리는 앱 exe 옆에 있다

크리틱: EXTN 확인 갈래 · 2026-08-25 · `feature/3.0.0-beta` · 판정 대상 `aec79f6`·`a7b2636`·`1629dfc`·`24d16af`

---

## 0. 한 문단 결론

**빌더의 숫자는 하나도 빠짐없이 재현됐다 — 그것도 빌더가 안 쟀다고 스스로 적은 판에서.**
빌더의 하네스 exe는 1/3+2/3까지였다(본인 §미완). 나는 `git archive HEAD`로 **옆 갈래의
미커밋이 한 바이트도 안 섞인** 순수 트리를 뽑아 3/3과 옆 갈래 WCAP까지 전부 든 exe를 굽고
(`md5 d23e1bbb…` · 6,471,680 B) 승격 하네스를 손대지 않고 돌렸다 — **PASS 12/0 · `hole:false`**,
E팔 `asks:2 · fetches:1 · unknown:0 · unavailable:2` · 미발사 · 표 유지. 대조군은 빌더보다 더
좁게 잡았다: 커밋 통째 되돌리기가 아니라 **`scan_path`의 그 두 줄만** 뺀 트리를 따로 구워
(`md5 ff44ab4a…` · 같은 6,471,680 B) 같은 하네스를 물렸더니 **FAIL 1/3 · `hole:true`** —
`asks:1 · fetches:0 · unknown:1 · t=90초 발사 · 대기표 소멸`. 갈린 것은 그 두 줄뿐이다.

**클로드 축은 코드 읽기로 넘기지 않고 앱을 띄워 쟀다.** 격리 홈 + 내가 만든 가짜
`claude.exe`(자기 argv를 로그로 남긴다) 4팔 — **PASS 17/0**. 전역 PATH 판에서 로그인은 진짜로
`auth login --claudeai`를 띄웠고 URL이 렌더러까지 갔으며, AI 커밋 메시지는 `ok:true`로 돌아왔고,
**로그아웃은 `auth logout`을 격리 계정 폴더로 진짜 보냈다**(= 토큰 해지가 돈다). 관리 설치본
판은 같은 값에 실행 파일만 앱 홈 것이었다(무회귀). 아무 데도 없는 판은 셋 다 정직하게 막혔고
CLI 스폰 0회였다.

**폴더를 파일로 읽던 자리도 내 손에서 다시 나왔다.** ccg-fs를 외부에서 부르는 탐침을
두 벌(수정본·가드 제거본) 만들어 돌렸더니 대조군에서 `file_diff("-dir") = Some(("edit",0,4))` ·
`file_diff("보통dir") = Some(("edit",0,4))`가 그대로 나왔고(게다가 `head_content` 28·33바이트 —
트리 목록을 「지워진 파일의 스냅샷」으로 내주고 있었다), 수정본에서는 둘 다
`diff=None · error="내용을 읽을 수 없어요"`로 수렴했다. `-파일`·`대괄호`는 안 흔들렸다.

**격차 하나.** 보고서 §7.2가 남은 구멍을 *"`resolve_bin`은 여전히 **CWD**를 안 본다 … 지금
소비자에게는 **도달 경로가 없다**"* 고 적었다. **두 절 다 사실이 아니다.** 실측: Rust의
`Command::new("claude.exe")`는 CWD를 **안** 뒤지고(그래서 CWD는 이 축의 구멍이 아니다),
대신 **자기 exe가 놓인 폴더**를 뒤진다 — `resolve_bin`이 절대 안 보는 자리다. 그 판을 W팔로
앱에 물렸더니 로그인은 「claude 실행 파일을 찾지 못했어요」, AI 메시지는 「설치된 엔진이
없어요」, 그리고 **로그아웃은 해지 스폰 0회**였다. 턴은 같은 자리에서 잘 뜬다(`hub.rs:290`은
아직 맨 이름이다). 인구는 아주 작지만(앱 설치 폴더에 `claude.exe`를 둔 사람), **이 라운드가
막으려던 사고가 그대로 살아 있는 자리**이고 보고서는 그 자리를 「없다」고 적었다.

**판정: 통과.** 체크리스트 네 항목 전부 초록이고, 위 격차는 문장의 오류 + 인구가 극히 작은
회귀다(다음 라운드 후보).

---

## 1. 무엇으로 쟀나 — 정직한 한 줄

| | 무엇 |
|---|---|
| 트리 | `feature/3.0.0-beta` @ **`24d16af`**. 워킹트리에는 옆 갈래(ccg-auth·ccg-store)의 미커밋이 살아 있어서 **`git archive HEAD`로 `C:\Temp\ccg-critextn`에 순수 트리를 뽑아** 거기서 빌드했다(남의 것 무접촉 · `app/dist`만 레포에서 복사) |
| 수정본 exe | `CARGO_TARGET_DIR=C:\Temp\ccg-critextn-target` · `cargo build --release --features custom-protocol -p agentcodegui` → **6,471,680 B · `md5 d23e1bbb1e82baf1fb1eda8a3c9cb511`**. 빌더의 하네스 exe(6,476,800 B)와 달리 **3/3(git.rs)과 옆 갈래 WCAP까지 들어 있다** |
| 대조군 exe | 같은 순수 트리를 복사(`C:\Temp\ccg-critextn-ctl`)해 **`scan_path`의 두 줄만** 뺀 것 → **6,471,680 B · `md5 ff44ab4a7d6f852f5b50eca7e941a8d4`**. 크기가 같고 md5만 다르다 = 갈린 것은 그 두 줄뿐 |
| 가짜 CLI | `-p ccg-engine --features fakecli --bins`(같은 target) · 클로드 축은 내가 쓴 스텁 `C:\Temp\fakeclaude`(argv·`CLAUDE_CONFIG_DIR`를 JSONL로 남긴다) |
| 격리 | CDP **9601**(하네스·대조군) · **9602**(클로드 축) · **9603**(argv) — 다른 갈래의 9471·9481~9483·9491~9493·9931~9953과 안 겹친다. 격리 홈 `.poc-home-critextn`·`.poc-home-critextnctl`(주행 후 잔여 **0**) · `C:\Temp\ccg-critextn-homes` |
| 안전 | **이름 기반 kill 0회** — 죽인 것은 내가 spawn한 PID 트리뿐. 측정 뒤 사용자 실앱 `AgentCodeGUI.exe` **6프로세스 그대로**. 3.0 `agentcodegui.exe` 잔여 0. 실계정 0건 · 실 claude/codex 프로세스 0개. 기준 파일(`docs/critic/codex-path-cpath-r1.json`·`bench/results/*`·`bench/shots/*/report.json`) 읽지도 쓰지도 않았다 |

---

## 2. ★ 체크 1 — codex.exe 철자(E팔)가 진짜로 뒤집혔나

### 2.1 수정본 5팔 — **PASS 12/0 · `hole:false`**

산출물: `docs/critic/codex-path-critextn-r1.json`

| 팔 | 씨앗 | 결과 |
|---|---|---|
| **E** · `CCG_CODEX_BIN=codex.exe` | PATH 앞칸에 실물 `codex.exe` | `asks:2 · fetches:1 · unknown:0 · unavailable:2` · **미발사** · 표 유지 |
| A · `CCG_CODEX_BIN=codex` | 같은 PATH | 같은 값(글자 하나 안 흔들렸다) |
| B · 절대 경로 | — | 같은 값 · 미발사 |
| C · 아무 데도 없음 | PATH에서 codex 제거 | **t=90초 발사 · `unknown:1` · `fetches:0`** ← 판별력의 증거(옛 계약이 살아 있다) |
| D · 이 컴퓨터의 **진짜** 전역 codex | 우회로 없음 (`where codex` = `AppData\Roaming\npm\codex`·`codex.cmd`) | `asks:2 · unavailable:2 · unknown:0` · **미발사** = 사용자 실 codex 프로세스 0개 |

### 2.2 대조군 — **FAIL 1/3 · `hole:true`** (내가 구운 두 줄짜리 대조군)

산출물: `docs/critic/codex-path-critextn-r1ctl.json` (`--only=e` · CDP 9601 · 홈 `.poc-home-critextnctl`)

```text
[E/EXT] t= 90s spawns=1 hold=no asks=1 unknown=1 unavailable=0 blocked=0
✗ E1 발사하지 않았다 — t=90초에 쐈다
✗ E2 unavailable로 판정했다(unknown 0) — unknown=1 unavailable=0
✗ E3 대기표가 살아 있다 — 표가 사라졌다
판정: {"E.fired":true,"E.unknown":1,"E.unavailable":0,"hole":true}
```

빌더가 적은 대조군 값(`asks:1 · fetches:0 · unknown:1 · t=90초 · 표 소멸`)과 **글자까지 같다**.
빌더는 `git archive bab4539`(커밋 통째)로 잡았고 나는 **그 두 줄만** 뺐다 — 더 좁은 대조군에서
같은 빨강이 나왔으므로 「그 두 줄이 원인」이 값으로 잠긴다.

### 2.3 단위 그물의 이빨

두 줄을 뺀 트리에서 `cargo test -p ccg-engine --lib a_name_that_already_has_an_extension_is_tried_as_is`:

```text
assertion `left == right` failed: PATH에 있는 codex.exe를 그 이름 그대로 못 찾았다
  left: None
 right: Some("c:\...\ccg-codex-ver-extname-17612\codex.exe")
```

되돌리면 초록. **기존 4팔 무회귀**는 2.1 표의 A·B·C·D가 값으로 답한다.

---

## 3. ★ 체크 2 — 클로드 축을 앱으로 쟀다 (내 하네스 · PASS 17/0)

하네스: `C:\Temp\critextn-claude-axis.mjs` · 산출물 `C:\Temp\critextn-claude-axis2.json` ·
CDP 9602 · 계정은 `ccg-auth-probe seed`로 심은 합성 계정 하나(`extncrit@extn.test`) ·
가짜 `claude.exe`가 자기 argv와 `CLAUDE_CONFIG_DIR`를 남긴다.

| 팔 | 판 | 로그인 | 로그인 URL | AI 커밋 메시지 | **로그아웃 해지** |
|---|---|---|---|---|---|
| **P** | 전역 PATH `claude.exe` | 막히지 않음 · `pathshim\claude.exe auth login --claudeai` **실제 스폰** | `https://claude.ai/oauth/…` **렌더러 도착** | `ok:true` · subject `CRITEXTN-FAKE-COMMIT-MESSAGE` | **`auth logout` 스폰 O** (`CLAUDE_CONFIG_DIR=<홈>\accounts\extncrit_extn.test-odigca`) |
| **M** | 앱 홈 관리 설치본 | 같음 · `engines\fake\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe` | 같음 | 같음 | 같음 |
| **N** | 이 컴퓨터에 claude 없음 | `claude 실행 파일을 찾지 못했어요` | — | `설치된 엔진이 없어요 —…` | **스폰 0회**(정직) |
| **W** | `claude.exe`가 **앱 exe 옆** | `claude 실행 파일을 찾지 못했어요` | — | `설치된 엔진이 없어요` | **스폰 0회** ← §5의 격차 |

AI 커밋 메시지 팔에서 스텁이 받은 argv도 그대로 찍혔다 —
`--output-format stream-json --verbose --input-format stream-json --effort low --model sonnet --permission-mode default --max-turns 1`
(2.6.2 계약 그대로). **관리 설치본 무회귀**는 M팔이 P팔과 같은 값을 낸 것으로 잠긴다.

> 첫 주행은 내 씨앗이 틀려(`accounts.json`을 손으로 썼다 → `account snapshot is corrupt`)
> P4·P5·M4·M5가 빨갰다. 스냅샷은 **복호 가능해야** 하므로 `ccg-auth-probe seed`로 바꿔
> 다시 돌렸다. 그 실패는 하네스의 것이지 제품의 것이 아니다 — 기록으로 남긴다.

---

## 4. ★ 체크 3 — 폴더를 파일 본문으로 읽던 자리

`ccg_fs::git::file_diff`를 **레포 밖에서** 부르는 탐침 두 벌(`C:\Temp\probe-fix`·`probe-ctl`).
같은 픽스처, 갈린 것은 `show_at`의 세 줄뿐이다.

| 질문 | 대조군(가드 제거) | 수정본 |
|---|---|---|
| `file_diff("-dir")` | **`Some(("edit",0,4))`** · `head_content` 28바이트 | `diff=None` · `error="내용을 읽을 수 없어요"` |
| `file_diff("보통dir")` | **`Some(("edit",0,4))`** · `head_content` 33바이트 | 같은 답(수렴) |
| `file_diff("보통.txt")` | `("edit",1,1)` | `("edit",1,1)` |
| `file_diff("-file.txt")` | `("edit",1,1)` | `("edit",1,1)` |
| `file_diff("[br].txt")` | `("edit",1,1)` | `("edit",1,1)` |
| `file_diff("함정.txt")`(본문이 `tree HEAD:함정.txt`로 시작) | `Text` | `Text`(거짓 양성이 답을 안 바꾼다) |

`("edit",0,4)`는 크리틱이 잰 값이자 빌더가 재현한 값이고, **내 탐침에서 세 번째로** 나왔다.
`head_content`가 채워져 있었다는 것은 그 목록이 「지워진 파일의 스냅샷」 자리까지 갔다는 뜻이다.

**트리거의 사거리도 직접 쟀다**(git 2.53.0.windows.1) — `git show`는 준 spec을 **그대로** 되뱉는다:

```text
git show HEAD:sub    → "tree HEAD:sub\n\nb.txt\n"
git show HEAD^:sub   → "tree HEAD^:sub\n\nb.txt\n"      ← commit_file_diff의 부모 조회도 걸린다
git show <sha>:sub   → "tree 528cddb…:sub\n\nb.txt\n"
git show HEAD:sub/   → "tree HEAD:sub/\n\nb.txt\n"      ← 끝 슬래시(status의 미추적 폴더 행) 도 걸린다
git cat-file -t …    → "tree"                            ← 판정은 언제나 이쪽
```

단위 그물의 이빨: 세 줄을 뺀 트리에서 `a_directory_is_not_read_as_if_it_were_a_file`이
`-dir: 트리 목록을 파일 본문으로 읽었다`로 죽는다. 되돌리면 초록.
`-파일`·`대괄호`·`:(literal)` 못은 `cargo test -p ccg-fs` **101/0/2** 안에서 전부 다시 돌았다
(`a_dash_leading_path_is_asked_about_instead_of_declared_missing` ·
`the_argv_diff_path_asks_only_for_the_bracket_file` ·
`the_literal_prefix_keeps_folder_rows_and_deletions_working` ·
`discarding_a_dash_leading_path_keeps_the_file_when_checkout_is_locked_out`).

---

## 5. ★ 격차 — 「도달 경로가 없다」고 적힌 자리는 **앱 exe 옆**이다

보고서 `docs/parity-fix-extn-r1.md` §7.2:

> **`resolve_bin`은 여전히 CWD를 안 본다.** `cmd.exe`는 PATH보다 먼저 현재 폴더를 뒤진다
> (크리틱 §4.4). **지금 소비자에게는 도달 경로가 없다.**

두 절을 따로 쟀다(탐침 `C:\Temp\spawnprobe` — 앱의 턴 스폰과 **같은 모양**인
`Command::new("claude.exe")` 한 줄):

```text
CWD에 claude.exe · PATH에서 claude 제거              → SPAWN ERR program not found
탐침 exe **옆에** claude.exe · PATH에서 claude 제거   → SPAWN OK  {"loggedIn":true,…}
```

즉 **CWD는 이 축의 구멍이 아니고**(Rust는 CWD를 안 뒤진다), 진짜 구멍은
**「실행 중인 exe가 놓인 폴더」**다 — `resolve_bin`은 `PATH`만 훑으므로 절대 안 본다.
그리고 그 판은 소비자에게 **도달한다**. W팔(§3)이 앱으로 그것을 보였다:

| | R28c까지 | 지금(R28d) | 턴 스폰(`hub.rs:290`) |
|---|---|---|---|
| 로그인 | 스폰 성공(앱 폴더에서 찾는다) | **`claude 실행 파일을 찾지 못했어요`** | 잘 뜬다 |
| AI 커밋 메시지 | 스폰 성공 | **`설치된 엔진이 없어요`** | 〃 |
| 로그아웃 | **해지 스폰 O** | **해지 스폰 0회**(조용히 건너뛴다) | 〃 |

`claude_bin_exists()`는 PATH 폴백이면 무조건 참이라 이 판에서도 통과했고, 스폰이 실제로
성공했다. 지금은 판정이 「없다」로 기울고 **로그아웃이 아무 말 없이 토큰 해지를 건너뛴다** —
2/3 커밋 메시지가 *"판정이 거짓으로 기울면 … 토큰 해지가 조용히 생략된다"* 고 쓴 바로 그
사고다. 인구는 아주 작다(앱 설치 폴더에 `claude.exe`를 손으로 둔 사람뿐이고, 앱의 엔진
설치는 `~/.agentcodegui/engines/`로 간다). **막는 값이 아니라 문장이 틀린 값**으로 판정한다:
§7.2를 「CWD」가 아니라 「**exe가 놓인 폴더**」로 고치고 「도달 경로 없음」을 지워야 한다.
같은 뿌리(「띄울 수 있나」의 탐색 집합 ≠ 「실제로 띄운다」의 탐색 집합)는 `hub.rs:290`이
아직 맨 이름이라는 §7.1과 한 몸이다.

부수 관찰(막는 값 아님): `resolve_bin`의 15초 음수 캐시가 이제 클로드 축에도 걸린다 —
「로그인 → 없다고 나옴 → claude 설치 → 곧바로 다시 로그인」이 15초 안이면 여전히 `NO_BIN`이다.
헤더가 그 TTL의 근거를 이미 적어 두었고(설치에 15초 이상 걸린다), 스스로 낫는다.

---

## 6. ★ 체크 4 — 테스트·타입·장부

| 무엇 | 값(전부 내 주행) |
|---|---|
| `cargo test -p ccg-fs` | **101 통과 · 0 실패 · 2 ignored** — 기준 100 무후퇴 |
| `cargo test -p ccg-engine` | **212 통과 · 0 실패 · 2 ignored** (14개 바이너리 합: 69+3+21+4+5+11+0+13+11+3+27+36+4+5). 기준 **207 후퇴 없음**(EXTN 신규 1 + 옆 갈래 WCAP 4) |
| `cargo test -p agentcodegui` | **146 통과 · 0 실패** |
| 플레이키 | agentcodegui 테스트 바이너리 **24회 연속** 146/0(1.46~1.61초) · ccg-fs **20/20** · ccg-engine lib **20/20** — **0회 흔들림**. (PATH를 프로세스 전역으로 갈아치우는 새 테스트가 있어 일부러 세게 돌렸다. `spawn_count`가 `thread_local`이라 계수가 안 섞이는 것도 확인했다) |
| `npm run typecheck`(node·web) · `npm run typecheck:app` | **exit 0 · exit 0 · exit 0** |

**장부 정정 2건 — 확인했고, 정정된 문장이 사실인지도 따로 쟀다.**

1. **`-`로 시작하는 폴더는 열린다.** `docs/parity-fix-gdash-r1.md` §5에 정정 블록이 들어갔고
   `src-tauri/src/ipc/parity/misc.rs`의 `initial_dir` 헤더에도 같은 실측이 붙었다.
   내 exe로 다시 쟀다(CDP 9603 · 격리 홈):

   ```json
   { "absolute": { "argv": ["C:\\Temp\\ccg-critextn-argv\\-열어볼폴더"],
                   "initialDirectory": "C:\\Temp\\ccg-critextn-argv\\-열어볼폴더" },
     "relative": { "argv": ["-열어볼폴더"], "initialDirectory": null } }
   ```

   탐색기 컨텍스트 메뉴는 `"%1"` = 절대 경로를 준다 → **코드는 정당하고 옛 문장이 틀렸다**가 맞다.
   커밋 `a95173c` 메시지는 못 고치므로 `docs/parity-fix-extn-r1.md` §4.1이 장부라는 처리도 옳다.

2. **`resolve_bin` 캐시의 근거.** 헤더가 「허브 tick 20ms」 → 「설정 ▸ Account 게이지 조회」로
   바뀌었다. 코드로 확인: `can_ask`의 호출자는 `engine/limit_probe.rs:199` **하나뿐**이고
   (재확인 사다리), `codex_limit::accounts_usage()`는 **계정마다** `fill → instrument →
   codex_exe()`를 부른다 = 계정 수만큼 PATH 훑기가 돈다. **정정된 문장이 사실이다.**

기준 결과 파일 무접촉 확인: `docs/critic/codex-path-cpath-r1.json`의 마지막 변경은 `5b4a8cf`
(R28c)다 — 이 라운드가 안 건드렸다. 빌더의 산출물은 새 이름 둘(`codex-path-extn-r1.json`·
`…ctl.json`)로만 들어갔다.

---

## 7. 판정표

| 체크리스트 | 판정 | 근거 |
|---|---|---|
| 1. codex.exe 철자 A팔이 초록으로 뒤집히나 · 기존 4팔 무회귀 | **초록** | 수정본 PASS 12/0 `hole:false` · 두 줄짜리 대조군 FAIL 1/3 `hole:true` (§2) |
| 2. 클로드 축(전역 PATH `claude.exe`) 로그인 URL · 로그아웃 해지 · 커밋 메시지 · 관리 설치본 무회귀 | **초록** | 라이브 4팔 PASS 17/0 · 해지 스폰 실물 argv 확인 (§3) |
| 3. `file_diff(cwd,"-dir")`가 정직한 오류 · `-파일`·대괄호·`:(literal)` 무회귀 | **초록** | 외부 탐침 A/B + ccg-fs 101/0/2 (§4) |
| 4. 크레이트별 cargo · typecheck 3종 · 장부 두 곳 | **초록** | 101 / 212 / 146 · 플레이키 0(24·20·20회) · exit 0 ×3 · 장부 둘 다 사실 확인 (§6) |
| — 격차 | **문장 오류 + 좁은 회귀** | §7.2의 「CWD」·「도달 경로 없음」이 둘 다 틀렸다. 실제 자리는 **앱 exe 옆**이고 로그아웃 해지가 그 판에서 조용히 생략된다 (§5) |

---

## 8. 다음 라운드에 넘기는 것

1. **§7.2를 사실로 고쳐라.** 「CWD」가 아니라 「실행 중인 exe가 놓인 폴더」이고, 「도달 경로
   없음」이 아니다(W팔이 앱으로 재현). 값을 고칠지(= `resolve_bin`에 exe 폴더를 더하거나
   `claude_spawn_bin()`이 못 찾았을 때 게이트를 통과시키는 옛 규약으로 되돌릴지)는 그 다음 판단이다.
2. `hub.rs:290`(턴 스폰)과 계정 셋의 **스폰 값 비대칭**은 그대로다 — 1과 한 뿌리다.
3. `resolve_bin`의 `.VBS`/`.JS` 비대칭(`command_for`는 `.cmd`/`.bat`/맨 이름만 셸로 보낸다)도 그대로다.
4. 하네스 `--no-real`은 아직 없다(`--only=a,b,c,e`로 대체 중).

## 9. 산출물

| 무엇 | 어디 |
|---|---|
| 승격 하네스 · 수정본 5팔 | `docs/critic/codex-path-critextn-r1.json` — PASS **12/0** · `hole:false` |
| 승격 하네스 · 두 줄짜리 대조군 | `docs/critic/codex-path-critextn-r1ctl.json` — FAIL **1/3** · `hole:true` |
| 클로드 축 라이브 4팔 | `C:\Temp\critextn-claude-axis.mjs` · `C:\Temp\critextn-claude-axis2.json`(PASS 17/0) |
| `file_diff` 외부 탐침 A/B | `C:\Temp\probe-fix` · `C:\Temp\probe-ctl` |
| 턴 스폰 탐색 집합 탐침 | `C:\Temp\spawnprobe` |
| argv 재실측 | `C:\Temp\critextn-argv-dash.mjs` · `C:\Temp\critextn-argv-dash.json` |
| 순수 트리 · 대조군 트리 | `C:\Temp\ccg-critextn`(= `git archive 24d16af`) · `C:\Temp\ccg-critextn-ctl`(두 줄 뺌) |
