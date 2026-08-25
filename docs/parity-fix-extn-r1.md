# R28d 「EXTN」 R1 — 철자 하나(`.exe`)가 세 화면을 막고 있었다. 그리고 폴더를 파일처럼 읽던 자리를 닫는다

라운드: R28d EXTN · 2026-08-25 · `feature/3.0.0-beta`
커밋: `aec79f6`(1/3 · 맨 이름 해석) · `a7b2636`(2/3 · 클로드 축) · 3/3(이 문서와 함께)

---

## 0. 한 문단

**R28c CPATH가 만든 새 헬퍼 `resolve_bin`은 「셸의 규칙」이 아니었다.** 후보 확장자를
**붙이기만** 해서 `codex.exe`로 물으면 `codex.exe.COM`·`codex.exe.EXE`…만 뒤지고 정작
PATH 앞칸의 실물 `codex.exe`는 한 번도 안 봤다. 크리틱이 그 사실을 승격 하네스의 철자
하나로 증명했고(§1), 같은 라운드의 인수인계가 **폴백 철자가 `claude.exe`인 클로드 축**을
그 헬퍼로 바꾸라고 적어 두었다 — 그대로 했으면 전역 PATH claude 사용자가 로그인·
**로그아웃(=토큰 해지)**·AI 커밋 메시지에서 전부 막혔다. 순서를 지켜 **먼저** 해석을 고치고
(1/3) **그 다음** 클로드 축을 갈아 끼웠다(2/3). 셋째로, R28c GDASH가 넓혀 둔 잠복 사마귀
— `git show HEAD:<dir>`의 **트리 목록을 파일 본문으로 읽어** `edit(add:0, del:4)`를 자신
있게 그리던 자리 — 를 `cat-file -t`로 닫았다(3/3). 장부 두 줄도 사실대로 고쳤다.

**세 축 전부 대조군으로 재현했다.** 「고치기 전엔 빨갛다」를 내 손으로 보지 않은 초록은
이 문서에 하나도 없다.

---

## 1. ★ 맨 이름 해석 — `codex.exe`를 그 이름 그대로 찾는다 (1/3 · `aec79f6`)

### 1.1 무엇이 틀렸나

`crates/ccg-engine/src/codex/versions.rs`의 `scan_path`는 `dir.join(name)` **뒤에**
`PATHEXT` 항목을 붙이기만 했다. 이름에 확장자가 이미 있으면 후보가 전부 헛것이 된다:

```text
resolve_bin("codex.exe")  후보: codex.exe.COM · codex.exe.EXE · codex.exe.BAT …
                          ← `codex.exe` 자신은 후보에 없다. cmd.exe는 그 이름을 먼저 찾는다.
```

### 1.2 고친 것

```rust
fn scan_path(name: &Path, path_env: &OsStr) -> Option<PathBuf> {
    let mut exts = path_exts();
    if cfg!(windows) && name.extension().is_some() {
        exts.insert(0, OsString::new());          // ← 「그 이름 그대로」가 첫 후보
    }
```

판정 기준은 **`Path::extension().is_some()`** 하나다. 확장자 **없는** 이름(`codex`)에는
빈 후보를 안 준다 — npm이 같은 폴더에 까는 sh 스크립트 `codex`를 `cmd /C codex`가 실행하지
않기 때문이고, 그건 R28c가 **일부러** 막은 것이다. 폴더는 `is_file()`이 걸러 낸다.

### 1.3 실측 — 승격 하네스에 E팔을 박고, 대조군으로 판별력을 증명했다

`scripts/poc-codex-path.mjs`에 팔을 하나 더했다(크리틱이 요구한 그 못):
**E · `CCG_CODEX_BIN=codex.exe` + PATH는 A팔과 완전히 동일**. A팔과 **글자 하나만** 다르다.
같이 넣은 것: `--only=`(대조군을 팔 하나만 2분에 돌린다) · `--home=`(세 갈래가 같은
격리 홈을 파지 않게).

| | 수정본 `aec79f6`+ (`md5 6e4dff0f…` · 6,476,800B) | 대조군 `bab4539` 빌드 (`md5 d9a8b6c8…` · 6,470,656B) |
|---|---|---|
| **E · `codex.exe`** | `asks:2 · fetches:1 · unknown:0 · unavailable:2` · **미발사** · 표 유지 | `asks:1 · fetches:0 · unknown:1 · unavailable:0` · **t=90초 발사** · **표 소멸** |
| A · `codex` | 같은 값(`unavailable:2` · 미발사) | (안 돌림 — `--only=e`) |
| B · 절대 경로 | `unavailable:2` · 미발사 | — |
| C · 아무 데도 | `unknown:1` · **t=90초 발사**(옛 계약) | — |
| D · 이 컴퓨터의 진짜 전역 codex | `asks:2 · unavailable:2 · unknown:0` · 미발사 | — |
| 판정 | **PASS 12/0 · `hole:false`** | **FAIL 1/3 · `hole:true`** |

- 대조군의 `fetches:0`이 물증이다 — **워커를 깨우지도 않았다.** R28b가 처음 적고 R28c
  크리틱이 §4.2에서 되살린 그 계수와 글자까지 같다.
- **B·C·D가 수정본에서 안 흔들린 것**이 「E의 초록이 전부 unavailable로 만든 가짜가 아니다」의
  근거다. 특히 C(창구가 진짜 없음)는 여전히 옛 계약대로 t=90초에 쏜다.
- 이 컴퓨터의 `where codex`는 `AppData\Roaming\npm\codex`·`codex.cmd`이고, 수정본 D팔은
  **발사하지 않았다** = 사용자의 실 codex 프로세스 0개.

산출물: `docs/critic/codex-path-extn-r1.json`(수정본 · PASS 12/0) ·
`docs/critic/codex-path-extn-r1ctl.json`(대조군 · FAIL 1/3 · `hole:true`).
기준 파일 `codex-path-cpath-r1.json`은 **한 바이트도 안 건드렸다**.

### 1.4 단위 그물 — 「두 줄을 빼면 빨갛다」

새 테스트 `a_name_that_already_has_an_extension_is_tried_as_is`를 **두 줄을 뺀 대조군**에
물렸다:

```text
assertion `left == right` failed: PATH에 있는 codex.exe를 그 이름 그대로 못 찾았다
  left: None
 right: Some("c:\…\ccg-codex-ver-extname-36580\codex.exe")
```

같은 테스트가 클로드 철자(`claude.exe`)와 **과잉 교정 금지**(없는 이름 · 폴더 `codex-dir.exe`)도
같이 잠근다.

---

## 2. ★ 클로드 축 — 「실행 파일을 못 찾았어요」를 사실로 만든다 (2/3 · `a7b2636`)

### 2.1 무엇을 바꿨나

| 전 | 후 |
|---|---|
| `claude_bin_exists()` = `b == PathBuf::from(EXE) \|\| b.exists()` | **삭제** |
| — | `claude_exe() -> Option<PathBuf>` = `resolve_bin(&claude_bin())` |
| — | `claude_spawn_bin()` = 해석된 실물 1순위 · 못 찾으면 **옛 인자 그대로** |

소비자 셋 — 크리틱이 「하나가 아니라 셋」이라고 정정한 그 셋 — 을 전부 갈아 끼웠다:

| 자리 | 무엇을 가르나 | 지금 |
|---|---|---|
| `ipc/accounts.rs:132` (로그인) | `NO_BIN` 문구 | `claude_exe()`가 `None`일 때만 |
| `ipc/accounts.rs:293` (로그아웃) | **토큰 해지 여부** | `Some(bin)`이면 해지 명령을 그 실물로 보낸다 |
| `ipc/parity/aimsg.rs:268` (AI 커밋 메시지) | 「설치된 엔진이 없어요」 | 같은 함수 · 스폰은 `claude_spawn_bin()` |

codex 축의 `codex_exe()`/`spawn_bin()`과 **같은 함수·같은 규칙**이다. 규칙이 두 벌이 되면
「띄울 수 있다」와 「실제로 띄운다」가 서로 다른 값을 본다 — 그게 R28c의 뿌리였다.

### 2.2 왜 순서가 목숨이었나 — 대조군으로 증명

R28c의 인수인계는 *"`resolve_bin`으로 바꾸면 계정 명령의 「실행 파일을 못 찾았어요」가
추측이 아니라 사실이 된다"* 고 적었다. **1/3 없이 그렇게 했으면 정반대**가 된다.
새 테스트 `the_path_fallback_is_resolved_the_way_the_shell_does_it`을 **1/3의 두 줄을 뺀
대조군**에 물린 결과:

```text
assertion `left == right` failed: PATH의 claude.exe를 못 찾았다
  left: None
 right: Some("C:\…\ccg-test-extn-claude-path-…\pathshim\claude.exe")
```

`None`이면 로그인은 즉시 `NO_BIN`, AI 커밋 메시지는 「설치된 엔진이 없어요」, 그리고
로그아웃은 **아무 말 없이 토큰 해지를 건너뛴다**. 이 컴퓨터의 `where claude`는
`C:\Users\User\.local\bin\claude.exe`다 — 즉 그 인구가 여기 있다.

같은 테스트의 반대 방향도 잠근다: claude로 해석되는 PATH 칸을 걷어내면
`claude_exe() == None` · `claude_spawn_bin() == "claude.exe"`(옛 인자 그대로).

### 2.3 주석의 사실 정정

`logout`의 헤더가 *"해지를 건너뛰는 경우는 **하나뿐**"* 이라고 적고 있었다. **둘이다** —
계정 폴더를 물질화조차 못 했을 때, 그리고 **띄울 CLI가 이 컴퓨터에 없을 때**. 앞은 보낼
토큰이 없고 뒤는 보낼 창구가 없다. 그 두 번째 문이 이 라운드의 뇌관이었다.

---

## 3. ★ 폴더를 파일처럼 읽던 자리 (3/3)

### 3.1 실측한 git의 행동

```text
git show     HEAD:dir  → exit 0 · "tree HEAD:dir\n\nf.txt\n"     ← 성공하면서 목록을 준다
git cat-file -t HEAD:dir → "tree"                                 ← 같은 질문에 바르게 답한다
git show     HEAD:top.txt → 내용                                   ← blob
```

R28c GDASH가 `-` 가드를 걷은 뒤 그 목록이 `Blob::Text`로 흘러
`file_diff(cwd, "-dir")`가 **자신 있게** diff를 그렸다. 크리틱이 「이번 라운드가 넓힌 잠복
사마귀」로 적은 자리다(평범한 `dir`도 같은 병을 앓고 있었다 — R28b GIT R5 §5).

### 3.2 고친 것 — 비용은 0

```rust
// 트리거는 첫 줄 모양, 판정은 언제나 `cat-file -t`
if r.stdout.starts_with(&format!("tree {spec}\n")) && !is_blob(root, &spec) {
    return Blob::Unreadable;
}
```

`cat-file -t`를 **늘** 부르면 `file_diff`의 스폰이 파일당 2 → 3으로 는다(뷰어 클릭마다
프로세스 하나 · 게이트 `bulk_diffs_beat_per_file_calls_on_a_wide_repo`가 그 수를 잠그고
있다). 그래서 첫 줄 모양을 **트리거로만** 쓴다 — 거짓 양성(내용이 우연히 그 줄로 시작하는
진짜 파일)은 스폰 하나를 더 치르고 **정확히** `Text`로 답한다. 답을 바꾸는 것은 언제나
`cat-file -t`다.

`Absent`가 아니라 **`Unreadable`**을 돌리는 것이 핵심이다: `discard`의 「HEAD에 없던 새
파일 = 휴지통」 갈래는 `Absent`에만 열린다. 「모르면 없다고 하지 않는다」가 `Blob`이 넷인 이유다.

### 3.3 실측 — 새 테스트와 그 대조군

새 테스트 `a_directory_is_not_read_as_if_it_were_a_file`(픽스처: `-dir/` · `보통dir/` 각
2파일 + 평범한 파일 + 「함정 파일」).

| | 대조군(두 줄 뺌) | 지금 |
|---|---|---|
| `show_at(HEAD, "-dir")` | `Text(트리 목록)` | **`Unreadable`** |
| `file_diff(cwd, "-dir")` | **`Some(("edit", 0, 4))`** ★ | `diff=None` · `error="내용을 읽을 수 없어요"` |
| `file_diff(cwd, "보통dir")` | 같은 병 | 같은 답(수렴) |
| `show_at`이 `Absent`인가 | — | **아니다**(휴지통 갈래가 안 열린다) |
| 평범한 파일의 `file_diff` 스폰 | 2 | **2**(안 늘었다) |
| 「함정 파일」(내용이 `tree HEAD:함정.txt`로 시작) | — | `Text` 그대로 · 스폰 **3**(거짓 양성의 대가) |

★ `("edit", 0, 4)`가 크리틱이 잰 `{"tag":"edit","add":0,"del":4}`와 **같은 값**이다 —
그들의 숫자를 인용한 게 아니라 내 대조군에서 다시 나왔다.

---

## 4. 장부 정정

### 4.1 「`-`로 시작하는 폴더는 「AgentCodeGUI로 열기」로 못 연다」 — **사실이 아니다**

`docs/parity-fix-gdash-r1.md` §5(와 커밋 `a95173c` 메시지)에 사실로 적혀 있었다.
**내 릴리스 exe로 다시 쟀다**(`bench/scratch/extn-argv-dash.mjs` · 격리 홈 · CDP 9482):

```json
{ "absolute": { "argv": "…\\ccg-extn-argv-…\\-열어볼폴더",
                "initialDirectory": "…\\ccg-extn-argv-…\\-열어볼폴더" },   ← 열린다
  "relative": { "argv": "-열어볼폴더", "initialDirectory": null } }         ← 이때만 못 연다
```

`initial_dir()`가 보는 것은 argv 원소 **문자열 전체**이고 탐색기 컨텍스트 메뉴는 `"%1"` =
**절대 경로**를 준다. 못 여는 것은 셸에서 상대 경로로 직접 부를 때뿐이고 그건 「열기」가 아니다.
**코드는 정당하고 문장이 틀렸다.**

고친 곳 둘: `docs/parity-fix-gdash-r1.md` §5(정정 블록) · `src-tauri/src/ipc/parity/misc.rs`의
`initial_dir` 헤더(실측을 코드 옆에 남겼다 — 다음 사람이 보는 자리는 거기다).
**커밋 `a95173c`의 메시지는 고칠 수 없다** — 그 정정은 이 문단이 장부다.

### 4.2 `resolve_bin`의 캐시 근거 「허브 스레드가 tick 20ms마다 부른다」 — 사실이 아니다

R28c CPATH 확인 크리틱 R1 §5.2가 실측으로 반박한 문장이다. `can_ask`의 유일한 호출자는
`limit_probe::codex_verdict`이고 그것은 **재확인 사다리**에서만 닿는다 — 같은 레포의
`poc-limit-engine` E8「tick마다 조회하지 않는다 — asks:2」가 이미 그 사실을 잠그고 있었다.
헤더를 **「설정 ▸ Account 게이지 조회(`accounts_usage()`)」**로 고쳐 적었다(계정 수만큼 연달아
묻는 자리라 캐시의 진짜 수혜자다). 크리틱이 잰 스캔 비용도 같이 적었다: PATH 46칸 ×
`PATHEXT` 11개 = 최악 506 stat · 6.9 ms.

> **★수정 라운드 R1의 정정 — 위 문단의 「진짜 수혜자」도 거짓이었다.** EXTN 확인 크리틱 R1
> §4.4가 호출 그래프로 반박했고 **나도 다시 떠서 확인했다**: `accounts_usage()`는
> `src-tauri/src/ipc/parity/usage.rs`에 있고 그 파일에 `resolve_bin`·`codex_exe`·
> `claude_exe`·`versions::` 참조가 **0건**이며, 그것이 부르는 `ccg-auth`의 deps에는
> `ccg-engine`이 아예 없다(`ccg-store`·`serde`·`sha2`·`ureq`) — **닿을 방법이 없다.**
> 검증한 사실만 다시 적는다(`grep`으로 센 값이다):
>
> | 무엇 | 값 |
> |---|---|
> | `resolve_bin` 호출자 | **넷** — `codex_exe` · `spawn_bin`(codex) · `claude_exe` · `claude_spawn_bin` |
> | 계정 수만큼 도는 자리 | **없다** |
> | 한 사건이 같은 이름을 해석하는 횟수 | codex 한도 재검증 **3회**(`codex_limit.rs:121`·`:138`·`:224`) · AI 커밋 메시지 **2회**(`aimsg.rs:268`·`:361`) |
> | 훑기 비용 | `PATH` 46칸 × `PATHEXT` 11개 = 최악 **506 stat**(이 컴퓨터의 두 환경변수를 직접 셌다. 6.9 ms는 크리틱의 값이라 인용만 하고 내 근거로는 안 쓴다) |
>
> 캐시가 지우는 것은 「루프」가 아니라 **한 사건 안의 3회·2회**다. 코드 헤더
> (`crates/ccg-engine/src/codex/versions.rs`)와 `engine/codex_versions.rs:134`의
> *"(허브 tick이 부르는 자리다)"* 도 같이 고쳤다.

---

## 5. 테스트·타입 — 전부 이번 패스의 실측

| 무엇 | 값 |
|---|---|
| `cargo test -p ccg-fs` | **101 통과 · 0 실패 · 2 ignored**(기준 100 → 신규 1) |
| `cargo test -p ccg-engine` | **208 통과 · 0 실패 · 2 ignored**(기준 207 → 신규 1). 이후 옆 갈래(WCAP `06067db`)가 4개를 더해 **212/0/2**로 늘었고 여전히 초록 |
| `cargo test -p agentcodegui` | **146 통과 · 0 실패**(기준 145 → 신규 1) — 프로세스 전역 `PATH`를 잠깐 바꾸는 테스트라 **6회 연속** 주행: 1.48~1.55초로 동일(플레이키 0) |
| `npm run typecheck`(node·web) · `typecheck:app` | 전부 exit 0 |
| 릴리스 빌드 | `CARGO_TARGET_DIR=target-extn` · `--features custom-protocol` · **6,476,800 B** |

**함정 하나를 실제로 밟았다(기록용).** 대조군을 되돌릴 때 `fs.copyFileSync`가 Windows에서
**원본 mtime을 보존**해(내부적으로 `CopyFileW`) cargo가 대조군 아티팩트를 신선하다고 믿고
그대로 썼다 — 되돌린 뒤 첫 `cargo test -p ccg-fs`가 대조군의 실패를 그대로 뱉었다.
`fs.utimesSync`로 시각을 올리고 다시 돌려 **101/0/2**를 확인했다. 대조군 놀이를 하는 다음
사람은 되돌린 뒤 반드시 파일 시각을 올려라.

---

## 6. 격리·안전 (전부 지켰다)

- **이름 기반 kill 0회.** 죽인 것은 내가 spawn한 PID 트리(`killTree`)뿐. 사용자의 실앱
  프로세스는 측정 전후 그대로다(측정 끝 시점 6개 · 손대지 않았다).
- `CARGO_TARGET_DIR`: `target-extn`(수정본) · `target-extnctl`(대조군 · 소스는 레포 밖
  `C:\Temp\ccg-extn-ctrl` = `git archive bab4539`). 공용 `target/`·남의 `target-*`에
  한 바이트도 안 지었다.
- CDP **9481**(하네스) · **9482**(argv 실측) · **9483**(대조군) — 다른 갈래의
  9471·9491~9493·9931~9942·9951~9953과 안 겹친다.
- 격리 홈: `.poc-home-extn` · `.poc-home-extnctl` · `%TEMP%/ccg-extn-argvhome-*`.
  주행 후 잔여 **0**.
- `CCG_NO_NET=1` · 실계정 0건 · 실 HTTP 0건 · 토큰 회전 0. 대조군 E팔이 t=90초에 발사했지만
  그때 뜬 것은 PATH 앞칸에 우리가 놓은 **가짜 codex.exe**다(사용자의 실 codex 아님).
  주행 뒤 `codex`·`ccg-fakecodex` 잔여 프로세스 **0개**.
- 기준 결과 파일 **무접촉**: `bench/results/*` · `bench/shots/*/report.json` ·
  기존 `docs/critic/*.json`은 읽지도 쓰지도 않았다. 새 산출물은 내 이름으로만 썼다
  (`codex-path-extn-r1.json` · `codex-path-extn-r1ctl.json`).
- `npm ci` 안 씀. 남의 미커밋 변경 무접촉(`git commit --only <자기 경로>`만 썼다).

---

## 7. 안 한 것 · 다음 라운드 후보

1. ~~**`engine/hub.rs:290`(턴 스폰)은 그대로 `claude_bin()`이다.**~~ → **★수정 라운드 R1에서
   닫았다(§9).** "경계 밖"이 아니라 이 라운드가 세운 불변식이 서지 않는 자리였다 — 게이트가
   `PATH`만 보고 스폰이 실행 파일 폴더를 먼저 보는 바람에 **로그아웃의 토큰 해지가 조용히
   생략되는 판**이 있었다(EXTN 확인 크리틱 R1 §2.1).
2. ~~**`resolve_bin`은 여전히 CWD를 안 본다.** `cmd.exe`는 PATH보다 먼저 현재 폴더를 뒤진다
   (크리틱 §4.4). 지금 소비자에게는 도달 경로가 없다.~~ → **★거짓이었다. 수정 R2에서 닫았다(§10).**
   도달 경로는 있다 — `CodexDriver::spawn`의 `cmd.current_dir(&spec.cwd)`, 즉 **사용자가 연
   프로젝트 폴더**다. "없다"는 확인하지 않고 적은 문장이다.
3. **`.VBS`/`.JS` 비대칭**(크리틱 §4.4): `path_exts()`는 `PATHEXT` 전부를 후보로 쓰는데
   `command_for`는 `.cmd`/`.bat`/맨 이름만 셸로 보낸다. `codex.js`가 잡히면 「띄울 수 있다」고
   답한 뒤 직접 스폰해 실패한다. 이번에 더한 「이름 그대로」 후보는 이 비대칭을 넓히지 않는다
   (이름에 확장자가 있을 때만이고, 그 값은 `is_bare_name`이 참이라 셸로 간다).
4. **하네스에 `--no-real`이 아직 없다**(크리틱 §6). D팔을 의도적으로 끄는 길은 이제
   `--only=a,b,c,e`로 열렸지만, 이름은 그대로 「팔 고르기」다.
5. `show_at`의 `spec.starts_with('-')` 가지는 여전히 죽은 가지다(도달 불가). 이번에도 안 건드렸다.

---

## 8. 산출물

| 무엇 | 어디 |
|---|---|
| 승격 하네스 · 수정본(5팔) | `docs/critic/codex-path-extn-r1.json` — PASS **12/0** · `hole:false` |
| 승격 하네스 · 대조군(`bab4539` 빌드 · E팔만) | `docs/critic/codex-path-extn-r1ctl.json` — FAIL **1/3** · `hole:true` |
| ★수정 R1 · 클로드 축 하네스 | `scripts/poc-claude-path.mjs` — 수정본 `docs/critic/claude-path-extnr1.json`(PASS 3팔) · 대조군 `…-extnr1ctl.json`(FAIL 5 = X팔만) |
| ★수정 R1 · 승격 하네스 재주행(5팔) | `docs/critic/codex-path-extnr1v3.json` — PASS **12/0** · `hole:false`(무회귀) |
| argv 실측(장부 §4.1) | `bench/scratch/extn-argv-dash.mjs` · `extn-argv-dash.json`(gitignored) |
| 대조군 패치 도구 | `bench/scratch/extn-ctl-patch.cjs`(gitignored) |
| 대조군 트리 | `C:\Temp\ccg-extn-ctrl`(`git archive bab4539`) · `target-extnctl/`(gitignored) |

---

## 9. ★수정 라운드 R1 — 「띄울 수 있는가」를 진짜로 **한 자리**로 (확인 크리틱 FAIL 대응)

> 크리틱 판정문: `docs/critic/r28d-extn-critic-r1.md`(커밋 `5448bb0`).
> 판정은 **FAIL**이었고 그 이유는 §2.1 하나 + 장부 한 줄(§4.4)이다. 겨눈 세 축(codex 철자 ·
> 클로드 계정 명령 · 폴더를 파일로 읽던 자리)은 크리틱이 자기 손으로 다시 재서 **전부 초록**을
> 확인했으므로 그 셋은 건드리지 않았다.

### 9.1 무엇이 아직 깨져 있었나

이 라운드가 표지에 건 불변식 — *"「띄울 수 있는가」는 앱에 **한 자리**"* — 이 **두 자리**였다.

| 자리 | 무엇을 보나 |
|---|---|
| 게이트 `claude_exe()` = `resolve_bin(claude_bin())` | **`PATH`만** |
| 턴 스폰 `hub.rs:290 cli_path()` → `driver.rs Command::new(&spec.cli)` | Rust std/`CreateProcess` 순서 — 자식 `PATH` → **실행 파일이 있는 폴더** → system32 → windows → 부모 `PATH` |

그 한 칸 차이에서 **게이트는 "없다", 스폰은 "있다"** 가 되고, `ipc/accounts.rs`의 로그아웃은
`claude_exe()`가 `None`이면 해지 명령 자체를 안 보낸다 = **서버에 살아 있는 토큰을 남긴 채
로그아웃이 끝난다.** R28c의 거짓(항상 참 = 판정 안 함)을 지우면서 **반대 방향의 거짓**
(PATH에 없으면 무조건 없다)이 들어왔던 것이다.

### 9.2 고친 것 (두 줄이 아니라 두 자리)

```rust
// crates/ccg-engine/src/codex/versions.rs — 훑을 폴더의 순서가 곧 「어디까지가 창구인가」다
fn search_dirs(path_env: &OsStr) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {                       // POSIX의 execvp는 PATH만 본다 — 거기선 넣으면 안 된다
        if let Some(d) = exe_dir() { dirs.push(d); }   // ← 커널이 PATH보다 먼저 보는 그 한 칸
    }
    dirs.extend(std::env::split_paths(path_env));
    dirs
}
```

```rust
// src-tauri/src/engine/hub.rs — 스폰도 **게이트가 찾은 그 실물**로 나간다
fn cli_path() -> std::path::PathBuf { super::versions::claude_spawn_bin() }
```

둘 중 하나만으로는 부족하다: `hub.rs`만 바꾸면 못 찾았을 때 옛 인자(맨 이름)가 그대로 나가
커널이 **다시** 그 폴더를 보므로 갈림이 남고, `search_dirs`만 바꾸면 값은 맞지만 스폰이
같은 훑기를 한 번 더 한다. 둘을 같이 놓아야 **두 질문이 한 함수**를 지난다.
codex 축은 이미 `spawn_bin()`이라 값만 따라 움직인다(해석된 절대 경로는 `command_for`에서
`needs_shell`이 거짓이 되어 그대로 뜬다 — 그래서 이쪽도 게이트와 스폰이 같은 답이다).

### 9.3 실측 ① — 실 exe 세 팔 · 대조군으로 뒤집힘 확인

새 하네스 **`scripts/poc-claude-path.mjs`**(`poc-codex-path`의 클로드 축 짝 — 다음 사람이
이 라운드의 헤드라인을 그대로 다시 잴 수 있게 레포에 넣었다). 팔의 차이는 **「claude.exe가
어디 있나」 하나뿐**이다 — 세 팔 다 앱 exe를 복사한 폴더에서 띄우고, `CCG_CLAUDE_BIN`은
지웠고(우회로 없음 = 진짜 폴백 사슬), 계정은 `ccg-auth-probe seed`가 만든 합성 하나다.

| 팔 | 로그인 문구 | `auth:login-url` | **로그아웃 = 해지 호출** | AI 커밋 메시지 |
|---|---|---|---|---|
| **X 실행 파일 옆** · 대조군(`5448bb0`) | `claude 실행 파일을 찾지 못했어요` | 안 옴 | **안 나갔다** (`.fake-logout-called` 없음) | `설치된 엔진이 없어요…`에 막힘 |
| **X 실행 파일 옆** · 수정본 | 없음(정상) | `https://claude.ai/oauth/authorize?code=FAKE-T1T2&…` | **나갔다** — `…\x\home\accounts\seed-fix_extnr1.test-31tp1p` | 통과(그 뒤 CLI 사유로 실패) |
| P 전역 PATH | 대조군·수정본 **동일**(정상 · URL 도착 · 해지 나감 · 게이트 통과) | | | |
| N 아무 데도 | 대조군·수정본 **동일**(`찾지 못했어요` · 해지 0회 · `설치된 엔진이 없어요`) | | | |

- 대조군 **FAIL 5**(전부 X팔) / 수정본 **PASS 3팔 · FAIL 0**.
- P·N이 두 exe에서 **한 칸도 안 바뀐 것**이 이 한 칸이 「전부 있다고 답하게 만든 가짜 초록」이
  아니라는 근거다. 특히 N은 옛 계약대로 여전히 전부 막힌다(= 반대 방향의 거짓도 없다).
- 산출물: `docs/critic/claude-path-extnr1.json`(수정본) · `docs/critic/claude-path-extnr1ctl.json`(대조군).
  다시 재려면:
  `node scripts/poc-claude-path.mjs --exe=<릴리스 exe> --tag=<이름> --port=9743 --fake=… --probe=…`

### 9.4 실측 ② — 단위 못 둘 (그중 하나는 **진짜 `CreateProcess`로** 잰다)

`crates/ccg-engine/src/codex/versions.rs`에 둘을 더했다.

| 못 | 무엇을 잠그나 |
|---|---|
| `the_folder_of_the_running_exe_is_searched_before_path` | 폴더 목록의 **첫 칸**이 실행 파일 폴더다(Windows) · POSIX에서는 안 넣는다 · 같은 이름이 둘이면 앞칸이 이긴다 |
| `the_gate_and_a_real_spawn_agree_when_the_cli_sits_next_to_the_exe` | 실행 파일 옆에 실행본을 하나 두고(테스트 바이너리를 그대로 복사 — 진짜로 뜨는 exe여야 한다) `PATH`에서는 빼고 **게이트와 스폰을 나란히** 묻는다 |

대조군(`C:\Temp\ccg-x1uctl` = `git archive HEAD` + 이 파일에서 **exe_dir 칸만** 제거)에서
둘 다 빨갛다 — 그리고 두 번째 못의 실패 문장이 이 라운드의 전부다:

```text
---- the_gate_and_a_real_spawn_agree_when_the_cli_sits_next_to_the_exe ----
assertion `left == right` failed: ★ 스폰은 되는데 게이트가 「없다」고 답했다
                                   = 그 판의 로그아웃이 토큰 해지를 건너뛴다
  left: None
 right: Some("…\\deps\\ccg-extn-sibling-16248.exe")
```

(`spawned == true`가 먼저 통과했다는 것이 「커널은 띄운다」의 물증이다 — 크리틱의 binprobe와
같은 사실을 레포 안 못으로 옮겼다.)

### 9.5 실측 ③ — 무회귀

| 무엇 | 값 |
|---|---|
| 승격 하네스 `poc-codex-path`(5팔 · 수정본 exe) | **PASS 12 / FAIL 0 · `hole:false`** — A·B·E 미발사 `unavailable:2 unknown:0` · C는 옛 계약대로 t=90초 발사 · D 미발사 → `docs/critic/codex-path-extnr1v3.json` |
| `cargo test -p ccg-engine`(격리 트리) | **217 통과 · 0 실패 · 2 ignored**(크리틱 기준 215 → 새 못 2) · lib 반복 **22/22** 초록(0.20~0.49s) |
| `cargo test -p ccg-fs` | **101 / 0 / 2**(기준과 같음 — 안 건드렸다) |
| `cargo test -p agentcodegui` | **146 / 0**(기준과 같음) |
| 레포 트리(옆 갈래 미커밋 포함) 3크레이트 합 | **466 통과 · 0 실패 · 4 ignored** |
| `npm run typecheck`(node·web) · `typecheck:app` | 전부 **exit 0** |
| 이 컴퓨터의 실제 설치 폴더 | `…\Programs\AgentCodeGUI`에 `claude.exe`·`codex.exe` **없음** = 새 한 칸이 이 컴퓨터의 답을 바꾸지 않는다(팔 P가 그 무회귀를 실측으로 잡는다) |

### 9.6 격리·안전

- 판정 트리 셋 다 **레포 밖**: `C:\Temp\ccg-x1`(대조 = `git archive HEAD` `5448bb0`) ·
  `C:\Temp\ccg-x1f`(수정 = 같은 archive + 내 파일 4개) · `C:\Temp\ccg-x1uctl`(단위 대조).
  **옆 갈래의 미커밋(ccg-auth 4파일 · ccg-engine `runtime.rs` 등)이 한 바이트도 안 섞였다.**
- `CARGO_TARGET_DIR`: `C:\Temp\ccg-x1-tgt` · `-x1f-tgt` · `-x1f-dbg` · `-x1uctl-tgt` ·
  `ccg-extnr1-tgt`. 레포 안 `target*`은 한 번도 안 썼다.
- 대조군 exe md5 `2f3bcf6f355c9b56be4b3a881f523e46`(6,483,456 B) ·
  수정본 exe md5 `44057fead01c8f12caa3aa992d7a4d98`(6,483,968 B) — 해시·크기 둘 다 다르다.
- CDP **9741**(대조 팔) · **9743**(수정 팔) · **9745**(승격 하네스). 크리틱 9701~9707,
  옆 갈래 9471·9481~9483·9931~9953과 무충돌.
- **이름 기반 kill 0회** — 죽인 것은 spawn한 PID 트리(`killTree`)뿐. 사용자 실앱 무접촉.
- 실계정 0건 · 토큰 회전 0. 해지 갈래를 재려고 `CCG_NO_NET`을 껐고 대신
  `HTTPS_PROXY=http://127.0.0.1:9`로 밖으로 나가는 길을 막았다(실 HTTP 0건).
  해지 명령이 간 상대는 언제나 `ccg-fake-claude`다.
- 기준 결과 파일 무접촉 — 새 산출물은 새 이름(`docs/critic/codex-path-extnr1v3.json`)으로만 썼다.

### 9.7 안 한 것 (그대로 남은 것)

1. ~~`resolve_bin`은 **여전히 CWD·system32·windows를 안 본다**. 앞은 `cmd /C` 갈래에만 있는
   경로고(맨 이름 codex) 뒤 둘은 사실상 언제나 `PATH`에 있다. 둘 다 「없다고 했는데 뜬다」
   방향이라 **해지 생략 방향은 아니다** — 방향이 다르다는 것이 이 라운드의 판단 근거다.~~
   → **★이 문단은 두 군데가 거짓이다. 확인 크리틱 R2 §5가 둘 다 실측으로 뒤집었고 수정
   R2가 CWD 칸을 닫았다(§10).** 정정:
   - *"`cmd /C` 갈래에만 있는 경로"* 는 맞지만 **그 갈래에 도달 경로가 있다** — 채팅의 작업
     폴더(= 사용자가 연 프로젝트 폴더)가 그 명령의 현재 폴더다.
   - *"「없다고 했는데 뜬다」 방향이라 해지 생략 방향은 아니다"* 는 **부호가 뒤집혔다**:
     R1이 고친 해지 생략이 **정확히 그 방향**이었다(게이트 `None` → `logout`이 해지를 건너뜀).
     클로드 축이 CWD에 안 걸리는 진짜 이유는 방향이 아니라 **Rust `Command`가 CWD를 아예 안
     보기 때문**이고, 그 사실은 R1 장부 어디에도 없었다.
2. ~~`.VBS`/`.JS` 비대칭(§7.3)도 그대로다.~~ → **수정 R2에서 같이 닫았다(§10.2).**

---

## 10. ★수정 라운드 R2 — 「연 폴더의 실행본」이 엔진이 되던 마지막 칸 (확인 크리틱 R2 FAIL 대응)

> 크리틱 판정문: `docs/critic/r28d-extn-critic-r2.md`(커밋 `fca2feb`). 이 라운드는 커밋 하나
> (코드 + 하네스 + 장부)로 들어간다.
> 판정은 **FAIL**이고 이유는 §5 하나 — 그리고 그 §5는 「코드가 틀렸다」보다 **「안 닫은
> 근거로 적힌 두 문장이 거짓이다」**에 무게가 있다. 크리틱이 자기 손으로 다시 재서 초록을
> 확인한 것(클로드 축 X·P·N·M · codex 5팔 12/0 · `file_diff` 폴더 3종 · cargo 219/101/146 ·
> 장부 정정 ②)은 **한 줄도 안 건드렸다.**

### 10.1 무엇이 아직 깨져 있었나

이 라운드가 표지에 건 불변식 — *"「띄울 수 있는가」와 「실제로 띄운다」가 **같은 폴더
목록**을 본다"* — 이 codex 축에서 서지 않았다. 게이트는 `resolve_bin`(실행 파일 폴더 +
`PATH`)인데 스폰은 `cmd /C ""codex" app-server"`이고, **`cmd.exe`는 `PATH`보다 현재 폴더를
먼저 뒤진다.** 그 현재 폴더가 `codex/driver.rs`의 `cmd.current_dir(&spec.cwd)` —
**사용자가 연 프로젝트 폴더**다.

```text
resolve_bin("codex") = null   ← 게이트: "물어볼 창구가 없다" → can_ask=false → 한도 Unknown = 눈감고 발사
cmd /C ""codex" app-server"   → 실제로 뜬 파일 = <연 폴더>\codex.exe        ← 스폰
```

즉 **남의 저장소를 열기만 해도 그 안의 `codex.exe`가 이 앱의 엔진이 되고**, 그 판의 한도
재검증은 R28c CPATH가 지운 바로 그 `Unknown`(눈감고 발사)으로 떨어진다.

### 10.2 고친 것 — **게이트가 CWD를 보게** 하지 않고 **스폰이 CWD를 안 보게** 했다

크리틱이 준 선택지는 둘이었다. (b) `search_dirs`가 `CWD`를 본다 = 지금 동작(그 폴더의
실행본으로 턴을 띄운다)을 **사실로 인정**한다. (a) 못 찾은 맨 이름을 셸에 안 넘긴다 =
스폰을 그 자리에서 실패시켜 「없다」를 한 벌로 만든다.

**(a)를 골랐다. 이유는 규칙 수가 아니라 위험 방향이다** — (b)는 「클론한 저장소 안에
`codex.exe`를 넣어 두면 사용자가 그 폴더를 열고 턴을 보내는 순간 그것이 뜬다」를 계약으로
만든다(바이너리 심기). 앱이 띄울 실행본은 **사용자가 설치한 것**이어야지 열어 본 폴더가
정하는 것이 아니다. 그래서 결정은 **「CWD는 창구가 아니다」** 이고, 두 답을 그 값으로 맞췄다.

```rust
// crates/ccg-engine/src/codex/driver.rs — 맨 이름의 해석을 **셸에 맡기지 않는다**
pub fn command_for(bin: &PathBuf) -> Command {
    let resolved: PathBuf = if cfg!(windows) && super::versions::is_bare_name(bin) {
        match super::versions::resolve_bin(bin) {
            Some(p) => p,                       // 찾았다 → 그 절대 경로로(셸이 다시 안 훑는다)
            None => return Command::new(bin),   // 못 찾았다 → Rust의 Command는 **CWD를 안 본다**
        }
    } else { bin.clone() };
    …
}
```

곁가지 하나를 같이 닫았다(§7.3의 `.VBS`/`.JS` 비대칭): 셸로 보낼지 말지를 `.cmd`/`.bat`
목록이 아니라 **`.exe`·`.com`이 아닌 확장자 전부**로 판정한다(`needs_shell`). 게이트의 후보는
`PATHEXT` 전부인데 스폰만 둘이면 「띄울 수 있다」고 답한 값을 직접 스폰해 실패한다.

| 판 | 게이트 `resolve_bin` | 스폰 `command_for` |
|---|---|---|
| PATH·exe 옆에 있다 | `Some(절대 경로)` | 그 **절대 경로**를 띄운다 |
| 아무 데도 없다 | `None` | `Command::new(맨 이름)` → **실패**(CWD를 안 본다) |
| 연 폴더에만 있다 | `None` | **실패**(← 이 라운드가 바꾼 칸) |

### 10.3 실측 ① — 제품 경로로 재현하고 뒤집었다 (하네스 F팔)

`scripts/poc-codex-path.mjs`에 팔을 하나 더했다. **F · 연 프로젝트 폴더에만 codex**:
`CCG_CODEX_BIN=codex` · `PATH`에서 codex 제거 · **채팅의 작업 폴더에 `codex.cmd`를 심는다**
(그 배치가 **자기 손으로** 표식 파일을 쓰고 가짜 app-server로 이어 준다 — "떴나"를 추론이
아니라 디스크의 바이트로 읽는다).

**그리고 `NoDefaultCurrentDirectoryInExePath`를 지우고 잰다.** Git Bash가 그 변수를 넣기
때문에(레지스트리엔 없다 — 크리틱 §5.4) 안 지우면 `cmd`가 현재 폴더를 아예 안 뒤져 이 팔이
**조용히 초록**이 된다. 데스크탑에서 뜨는 사용자 앱에는 그 변수가 없다.

**대조군을 둘 세웠다.** ① R1이 구운 exe(다른 트리) · ② **같은 트리에서 내 hunk만 되돌려
새로 구운 exe**(`command_for`의 그 세 줄만 R1 모양으로). ②가 있어야 "바뀐 것이 내 hunk다"가
말이 아니라 값이 된다.

| | ① R1 exe(`md5 f890d307…` · 6,479,872 B) | ② **같은 트리 · 내 hunk만 되돌림**(`md5 f97e357b…` · 6,509,056 B) | 수정본(`md5 0dfb1843…` · 6,509,568 B) |
|---|---|---|---|
| 연 폴더의 실행본이 떴나 | **`ran:true`** | **`ran:true`** | **`ran:false`** |
| 그것과 말을 섞었나 | **`talked:true`**(stdin 기록 501 B) | **`talked:true`** | **`talked:false`** |
| 게이트 판정 | `unknown:1`(창구 없음) | `unknown:1` | `unknown:1` — **같다** |
| 발사 | t=90초(옛 계약) | t=90초 | t=90초 — **같다**(C팔과 같은 값 = 창구가 진짜 없으니 맞는 착지다) |
| 판정 | **FAIL 3 · `hole:true`** | **FAIL 3 · `hole:true`** | **PASS · `hole:false`** |

→ `docs/critic/codex-path-extnr2ctl.json`(①) · `codex-path-extnr2ctl2.json`(②) ·
`codex-path-extnr2.json`(수정본 6팔)

바뀐 칸은 **「그 폴더의 실행본이 뜨는가」 하나**다. 게이트의 답도, 발사 여부도, 시각도
그대로다 — 「전부 막아서 얻은 초록」이 아니라는 뜻이다.

### 10.4 실측 ② — 단위 못 둘 + **그 못이 진짜 빨개지는지**를 뮤테이션으로 확인

`crates/ccg-engine/src/codex/driver.rs`에 넣었다.

| 못 | 무엇을 잠그나 |
|---|---|
| `the_gate_and_a_real_spawn_agree_when_the_cli_sits_only_in_the_chat_folder` | 임시 폴더에 `<이름>.cmd`를 심고 게이트와 스폰을 나란히 묻는다. **대조 팔이 못 안에 들어 있다** — R1의 모양(`cmd /C` + 맨 이름)을 손으로 만들어 같은 폴더에 쏴서 **그쪽은 반드시 떠야** 한다(안 뜨면 이 컴퓨터에선 이 못이 아무것도 못 잡는다는 뜻이라 같이 실패한다). 둘 다 `NoDefaultCurrentDirectoryInExePath`를 지우고 잰다 |
| `a_bare_name_is_resolved_here_so_the_shell_never_searches` | ① 해석되는 맨 이름은 셸에 **절대 경로**가 실린다 · ② 아무 데도 없는 맨 이름은 **셸로 안 간다** |
| `a_scripted_extension_goes_through_the_shell_but_a_native_one_does_not` | `.vbs`·`.js`·`.bat`는 셸 · `.exe`·`.COM`은 직접(§7.3 비대칭) |

`command_for`를 R1의 모양으로 되돌린 뮤테이션에서 **정확히 그 둘만** 빨갛다:

```text
---- the_gate_and_a_real_spawn_agree_when_the_cli_sits_only_in_the_chat_folder ----
★ 게이트는 「창구 없음」인데 스폰이 **연 폴더의 실행본**을 띄웠다(= 한도 Unknown으로 눈감고 발사)
---- a_bare_name_is_resolved_here_so_the_shell_never_searches ----
  left: "\"\"ccg-extn-cmdfor-18108\" app-server\""            ← 맨 이름이 셸로 갔다
 right: "\"\"…\deps\ccg-extn-cmdfor-18108.cmd\" app-server\""
test result: FAILED. 4 passed; 2 failed  (codex::driver 필터)
```

### 10.5 실측 ③ — 무회귀

| 무엇 | 값 | 기준 |
|---|---|---|
| 하네스 `poc-codex-path` 6팔(수정본) | **PASS 15 / FAIL 0 · `hole:false`** | 크리틱 12/0(5팔) → 새 팔 하나에 검사 3 |
| A 전역 PATH · B 앱 설치본 · E `codex.exe` 철자 · D **이 컴퓨터의 진짜 전역 codex** | 넷 다 **미발사** · `asks:3 fetches:2 unavailable:3 unknown:0` · 대기표 유지 | 크리틱과 방향 동일(계수는 `--watch=140`이라 사다리가 한 칸 더 돌았다) |
| C 아무 데도 | t=90초 **발사** · `unknown:1` | 옛 계약 유지 = 판별력 살아 있다 |
| `cargo test -p ccg-engine` | **221 통과 · 0 실패 · 2 ignored** · 반복 **22/22** 초록 | 크리틱 219 + 내 못 2(셋을 더하고 하나를 교체했다) |
| `cargo test -p ccg-fs` | **101 · 0 · 2** | 같음(안 건드렸다) |
| `cargo test -p agentcodegui` | **151 · 0** · 반복 **22/22** 초록 | 크리틱 146 + **옆 갈래(M10)의 미커밋 `engine::talk::tests` 5**. 내가 더한 것은 **0** — `git diff -- src-tauri`의 내 두 파일은 **주석만** 바뀌었다(비주석 diff 0줄) |
| `npm run typecheck`(node·web) · `typecheck:app` | 전부 **exit 0** | |

### 10.6 장부 정정 ③ — **이번에 지운 두 문장은 「검증 안 하고 적은 문장」이다**

| 어디 | 무엇이 거짓이었나 | 지금 |
|---|---|---|
| `codex/versions.rs` `search_dirs` 주석 | *"`CWD` … 지금 소비자에게 도달 경로가 없다"* | 도달 경로는 **채팅의 작업 폴더**다(위 실측). 「안 넣은 것은 결정이고 이유는 바이너리 심기」로 다시 적었다 |
| 같은 주석 · 보고서 §9.7·§7.2 | *"둘 다 「없다고 했는데 뜬다」 방향이라 **해지 생략 방향은 아니다**"* | **부호가 뒤집혀 있었다.** R1이 고친 해지 생략이 정확히 그 방향이다(게이트 `None` → `logout`이 해지를 건너뜀). 클로드 축이 안전한 진짜 이유는 **Rust `Command`가 CWD를 아예 안 보기 때문**이고 그 사실을 처음으로 적었다 |
| `codex/versions.rs` `resolve_bin` 주석 | AI 커밋 메시지 게이트 `aimsg.rs:268` | **`:271`**(268은 주석 블록 시작 줄이었다 — 크리틱이 3줄 어긋남을 지적했다) |
| `engine/codex_limit.rs` `can_ask` 주석 | *"`command_for`가 `cmd /C`로 실제로 찾아 띄운다"*(현재형) | 그 이관을 명시했다 — R28c 당시엔 `cmd /C`가, R2부터는 `resolve_bin`이 찾는다 |

### 10.7 격리·안전

- **CDP 9781**(수정본·대조군①) · **9783**(대조군②) — 크리틱 9761~9769 · 빌더 R1 9741~9745 ·
  옆 갈래와 무충돌.
- 격리 홈 `.poc-home-extnr2` · `.poc-home-extnr2ctl` · `.poc-home-extnr2ctl2` — 주행 후 하네스가 지운다.
- `CARGO_TARGET_DIR`: `C:\Temp\ccg-extnr2-tgt`(테스트·뮤테이션) · `target-extn`(수정본 exe) ·
  `target-extnctl`(대조군② exe — 둘 다 이 갈래가 R1부터 쓰던 제 것이다).
  **남의 `target-*`·공용 `target/`은 한 번도 안 썼다.**
- 대조군① exe는 R1이 구운 `target-extn/release/agentcodegui.exe`를 **덮기 전에**
  `C:\Temp\ccg-extnr2-ctl\`로 떠 둔 것이다(md5 `f890d307…`).
  대조군②는 지금 트리에서 `command_for`의 세 줄만 R1 모양으로 되돌려 구웠고(md5 `f97e357b…`),
  굽자마자 파일을 원본 해시(`22f10458…`)로 복원했다 — 워킹트리에 뮤테이션이 남아 있지 않다.
- **워킹트리에 옆 갈래(M10)의 미커밋이 얹혀 있다**(`src-tauri/src/engine/hub.rs`·`talk.rs` ·
  `crates/ccg-engine/src/runtime.rs`). 세 exe 전부 그 상태에서 구웠고 대조군②는 그 사이에
  8줄이 더 움직였다(빌드 전후 `git diff --stat`으로 확인). 그래서 **「내 hunk 하나만 다르다」를
  글자 그대로 보장하는 것은 단위 뮤테이션(§10.4 · 같은 초에 같은 트리)이고**, exe 둘은 그
  결론을 제품 경로에서 재확인하는 자리다. 그 갈래의 파일은 **읽지도 고치지도 않았다**.
- **이름 기반 kill 0회.** 죽인 것은 하네스가 spawn한 PID 트리뿐. 주행 뒤 `tasklist` 확인 —
  사용자 실앱 `…\Programs\AgentCodeGUI\AgentCodeGUI.exe` **5프로세스 그대로**, 내 트리
  (`target-extn`·`C:\Temp\ccg-extnr2-ctl`) 잔여 **0개**, `codex.exe`·`ccg-fakecodex.exe` 잔여 **0개**.
  (살아 있는 `agentcodegui.exe` 하나는 옆 갈래 M10의 `target-m10r6` 것이라 **손대지 않았다** —
  `Win32_Process`로 경로를 확인하고 넘겼다.)
- 실계정 0 · `CCG_NO_NET=1` · 실 HTTP 0 · 토큰 회전 0. F팔이 띄우려던 것도 우리가 심은 배치다.
- 기준 결과 파일 무접촉 — 새 산출물은 새 이름(`codex-path-extnr2.json` · `…r2ctl.json`)으로만.

### 10.8 안 한 것

1. `resolve_bin`은 여전히 `system32`·`windows`를 안 본다(`Command`는 본다). 이 컴퓨터에선
   둘 다 `PATH`에 있어 답이 같지만, **방향은 「없다고 답했는데 뜬다」 = 해지 생략과 같은
   방향**이다(R1이 반대로 적었던 그 자리). 닫으려면 그 두 칸을 `search_dirs`에 넣으면 된다 —
   이번 라운드의 경계 밖이라 안 했고, 「안전해서 안 했다」가 아니라 **「같은 방향인데 아직
   안 닫았다」**로 적어 둔다.
2. 클로드 축은 `Command::new`라 CWD를 안 본다 — 고칠 것이 없다(이번에 그 **이유**를 적었다).
3. `read_row`·`parity/codex.rs`의 `command_for` 호출은 `current_dir`를 안 꽂아 앱의 CWD를
   물려받는다. 그 값이 사용자 콘텐츠는 아니지만, 이제 어느 쪽이든 **CWD는 후보가 아니다**.
