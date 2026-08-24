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

1. **`engine/hub.rs:290`(턴 스폰)은 그대로 `claude_bin()`이다.** 그 자리는 원래 검사가 없고
   스폰 실패가 엔진 미설치 안내 카드까지 가는 경로다. codex는 이미 `spawn_bin()`을 쓰므로
   **두 축의 스폰 값이 아직 비대칭**이다 — 바꾸면 카드에 닿는 사유가 바뀔 수 있어 경계 밖으로 뒀다.
2. **`resolve_bin`은 여전히 CWD를 안 본다.** `cmd.exe`는 PATH보다 먼저 현재 폴더를 뒤진다
   (크리틱 §4.4). 지금 소비자에게는 도달 경로가 없다.
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
| argv 실측(장부 §4.1) | `bench/scratch/extn-argv-dash.mjs` · `extn-argv-dash.json`(gitignored) |
| 대조군 패치 도구 | `bench/scratch/extn-ctl-patch.cjs`(gitignored) |
| 대조군 트리 | `C:\Temp\ccg-extn-ctrl`(`git archive bab4539`) · `target-extnctl/`(gitignored) |
