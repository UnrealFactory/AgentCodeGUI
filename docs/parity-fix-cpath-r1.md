# R28c 「CPATH」 R1 — **전역 PATH로 codex를 쓰는 사람에게는 한도 재검증이 한 번도 안 돌았다**

빌더: CPATH 갈래 · 2026-08-25 · `feature/3.0.0-beta`
과녁: R28b CRIT 확인 크리틱 R1(`docs/critic/r28b-crit-critic-r1.md`) **§3 — 이 라운드의 최대 격차**

크리틱이 적은 문장을 그대로 옮긴다:

> `codex_limit::can_ask()`의 첫 줄이 `codex_bin().is_file()`인데, `codex_bin()`은 **활성 설치본이
> 없을 때 전역 PATH 폴백(맨 이름 `codex`)을 돌려주도록 설계된 함수**다. 즉 codex를 전역으로 깔아
> 쓰는 사용자는 — 이 판정을 돌린 **바로 이 컴퓨터가 그렇다** — 계정이 등록돼 있고 턴도 도는데
> 한도 재검증만 `Unknown`(= 판정 안 함 = 눈감고 발사)으로 떨어진다.

닫았다. 같은 판(**진짜 전역 codex · 우회로 없음**)에서 이제 재검증이 **돌고**(`asks≥1`),
「물어봤는데 못 얻었다」로 착지해(`unavailable≥1 · unknown=0`) **발사하지 않는다**.

---

## 0. 한 문단 결론

**`is_file()`을 「실행본이 있나」의 대용으로 쓴 것이 전부였다.** `codex_bin()`의 마지막 값은
파일 경로가 아니라 **맨 이름 `codex`**(= "PATH에서 찾아라")이고, 턴을 띄우는 `hub.rs`는 그 값을
`cmd /C`로 넘겨 **실제로 잘 띄웠다**. 한도 쪽만 그 값을 stat해 「실행본 없음」이라 판정했고,
그 판정의 뜻이 「물어볼 창구가 없다 = 옛 계약대로 발사」였다. 그래서 전역 설치 사용자에게는
**턴은 돌고 한도만 눈을 감는** 조합이 만들어졌다. R28b RVERD가 연 `accounts_usage()`도 같은 문을
지나므로 설정 ▸ Account의 OpenAI 게이지까지 같은 이유로 비어 있었다.

수정은 **판정을 한 자리로 모으는 것**이다: `codex_versions::codex_exe()` 하나가 「띄울 수 있는가」에
답하고, 턴(`hub.rs`)·계정 조회(`ipc/parity/codex.rs`)·한도 재검증(`codex_limit.rs`)이 그 하나를 본다.
해석 규칙은 셸의 그것(경로면 stat, 맨 이름이면 `PATH` × `PATHEXT`)이고, 허브 스레드가 tick마다
부르는 자리라 **맨 이름 해석은 캐시한다**(15초 · 키에 `PATH`를 넣어 저절로 무효가 되게).

| 판 | 수정 전(크리틱 실측) | 수정 후(내 실측) |
|---|---|---|
| **전역 PATH codex** + 등록 계정 + 리셋 지난 대기표 | `{asks:1, unknown:1, unavailable:0}` · **t=90초 발사** | `{asks:2, unknown:0, unavailable:2}` · **미발사 · 대기표 유지** |
| **이 컴퓨터의 진짜 전역 codex**(우회로 없음) | 같음 — **t=90초 발사**(내가 옛 exe로 재현) | 같음 — **미발사** |
| 앱 설치본(실물 파일) | `{unknown:0, unavailable:2}` · 미발사 | 같음(안 흔들렸다) |
| **아무 데도 없다**(PATH에서 codex를 걷어냄) | — (크리틱은 안 쟀다) | `{unknown:1}` · **t=90초 발사**(옛 계약 그대로) |
| 설정 ▸ Account OpenAI 게이지의 조회 문(`instrument`) | 전역 판에서 언제나 `None` | 같은 문을 지난다(`codex_exe`) |

---

## 1. 무엇을 고쳤나

### 1.1 해석 헬퍼 하나 (`crates/ccg-engine/src/codex/versions.rs`)

```rust
pub fn resolve_bin(bin: &Path) -> Option<PathBuf>   // Some(실물 경로) = 띄울 수 있다
pub fn is_bare_name(bin: &Path) -> bool             // `command_for`의 그 규칙 — 이제 한 벌
```

- 구분자가 있으면 stat 하나(**캐시하지 않는다** — 방금 설치한 실행본을 다음 tick에 알아봐야 한다).
- 맨 이름이면 `PATH`를 앞에서부터 훑되 디렉터리 하나마다 `PATHEXT`를 다 대 본다(= `cmd.exe`의 순서).
  Windows에서 **확장자 없는 파일은 후보가 아니다**: npm은 `codex`(sh 스크립트)와 `codex.cmd`를 같은
  폴더에 깔고 `cmd /C codex`가 실행하는 것은 후자다.
- 맨 이름 해석만 캐시한다(TTL 15초, 키 = 이름 + `PATH` 전문). 허브 스레드는 활성 tick이 20ms다.

`driver.rs::command_for`의 `bare_name` 사본은 지우고 이 함수를 부른다 — 규칙이 두 벌이면
「띄울 수 있다」와 「실제로 띄운다」가 다시 갈린다.

### 1.2 판정을 한 자리로 (`src-tauri/src/engine/codex_versions.rs`)

```rust
pub fn codex_exe() -> Option<PathBuf>   // 「띄울 수 있는가」 — 앱 전체에서 이것 하나
pub fn spawn_bin() -> PathBuf           // 스폰 인자(해석된 실물 경로 우선, 못 찾으면 옛 인자 그대로)
```

| 자리 | R28b까지 | 지금 |
|---|---|---|
| `hub.rs:313`(턴) | `codex_bin()` — 검사 없음 | `spawn_bin()` |
| `ipc/parity/codex.rs:71`(모델 조회) | `codex_bin()` — 검사 없음 | `codex_exe()`, 없으면 왕복 자체를 안 만든다 |
| `codex_limit.rs:104·119`(한도·게이지) | **`codex_bin().is_file()`** | `codex_exe()` |
| `codex_limit.rs:206`(조회 스폰) | `codex_bin()` | `spawn_bin()` |

`spawn_bin()`이 못 찾을 때 **옛 인자(맨 이름)를 그대로 넘기는 것**이 규약이다: 그 판의 스폰 실패가
엔진 미설치 안내 카드(EngineGate)까지 가는 경로이고, 인자를 비우면 그 카드에 닿는 사유가 바뀐다.

### 1.3 거짓 주석 (`codex_limit.rs:102-103`)

> 활성 설치본이 없으면 `codex_bin`은 맨 이름(`codex`)을 돌려준다 = 이 앱에는 실행본이 없다.
> 그 판에서는 codex 턴 자체가 못 뜨므로 한도를 물을 이유도 없다.

**두 문장 다 거짓이었다.** 지웠고, 그 자리에 무엇이 왜 틀렸는지와 크리틱의 실측을 적었다.
모듈 헤더에도 「실행본이 없다」를 **누가 판정하는가** 절을 새로 뒀다.

---

## 2. 회귀 못 — `scripts/poc-codex-path.mjs` (승격 + 팔 둘 추가)

크리틱의 `bench/scratch/critr1b-codexpath.mjs`를 `scripts/`로 승격했다. **바꾼 것은 씨앗의 출처**다:
크리틱의 A팔은 「이 컴퓨터에 전역 codex가 깔려 있다」에 기댔는데, 승격본은 팔마다 `PATH`를 직접
세운다(어느 컴퓨터에서 돌려도 같은 답이 나와야 게이트다). 그리고 팔을 둘 늘렸다.

| 팔 | 씨앗 | 기대 |
|---|---|---|
| **A · 전역 PATH** | `CCG_CODEX_BIN=codex` + `PATH` 앞에 실물 `codex.exe`(가짜 app-server 사본) | 미발사 · `unavailable>0 · unknown=0` |
| **B · 앱 설치본** | `CCG_CODEX_BIN=<ccg-fakecodex.exe>` | 미발사(R28b에도 초록이던 대조군) |
| **C · 아무 데도**(신규) | `CCG_CODEX_BIN=codex` + `PATH`에서 codex를 걷어냄 | **발사** · `unknown>0` — 이 팔이 빨강이면 A의 초록은 "전부 unavailable로 만들어" 얻은 가짜다 |
| **D · 진짜 전역**(신규) | 우회로 **없음** · `PATH` 그대로 | A와 같은 답 — 크리틱이 지목한 인구를 씨앗 없이 태운다 |

나머지 씨앗은 네 팔이 완전히 같다: 클로드 계정 1 + **등록된 codex 계정 1** + Codex 채팅 1 +
리셋이 2시간 전인 대기표 + 자동 재개 ON + `CCG_NO_NET=1`.

### 2.1 실측 — 수정본 **PASS 9 / 0**, 같은 하네스가 옛 exe에서 **4 / 5**

```
수정본  target-cpath\release\agentcodegui.exe · 6,469,632B · md5 6f2f45340e86b6c859d6ee8e7ea4ab6c
대조군  target-crit \release\agentcodegui.exe · 6,437,888B · md5 307605a274115cb3807889081f760378 (크리틱이 R28b에 빌드한 그 exe)
```

| 팔 | 수정본 | 대조군(옛 exe) |
|---|---|---|
| **A · 전역 PATH** | `asks:2 · unknown:0 · unavailable:2` · **미발사** · 표 유지 | `asks:1 · unknown:1 · unavailable:0` · **t=90초 발사** · 표 소멸 |
| **B · 앱 설치본** | `unknown:0 · unavailable:2` · 미발사 | 같음(**안 흔들렸다**) |
| **C · 아무 데도** | `unknown:1` · **t=90초 발사** | 같음(**안 흔들렸다**) |
| **D · 진짜 전역** | `asks:2 · unknown:0 · unavailable:2` · **미발사** | `asks:1 · unknown:1` · **t=90초 발사** |
| 판정 | `hole:false` · **PASS 9/0** | `hole:true` · **FAIL 4/5** |

```
[A/PATH] t= 90s spawns=0 hold=yes asks=1 unknown=0 unavailable=1
[A/PATH] t=120s spawns=0 hold=yes asks=2 unknown=0 unavailable=2   ← 미발사 · 표 유지
[B/APP ] t=120s spawns=0 hold=yes asks=2 unknown=0 unavailable=2
[C/NONE] t= 90s spawns=1 hold=no  asks=1 unknown=1 unavailable=0   ← 옛 계약대로 발사
[D/REAL] t=120s spawns=0 hold=yes asks=2 unknown=0 unavailable=2   ← 이 컴퓨터의 진짜 전역 codex
판정: {"A.fired":false,"A.unknown":0,"A.unavailable":2,"B.fired":false,
       "C.fired":true,"C.unknown":1,"D.unknown":0,"D.unavailable":2,"hole":false}
```

크리틱의 하네스가 돌려주던 `hole:true`가 **`hole:false`로 뒤집혔다.** 그리고 **B·C는 두 exe에서
같은 답**이다 — 이 하네스가 "옛 exe면 전부 빨강"인 종류가 아니라 **고친 축만** 가른다는 뜻이다.

대조군 리포트: `bench/scratch/cpath-control-r1.json`(gitignored) · 수정본: `docs/critic/codex-path-cpath-r1.json`.

### 2.2 판정 계수는 t≈90초에 처음 움직인다 (하네스를 한 번 틀리게 만든 사실)

첫 주행에서 D팔만 20초를 봤다가 `asks=0`으로 헛다리를 짚었다. 재확인 사다리가 처음 판정을 묻는
시각이 **t≈90초**라 그 전에는 어느 팔이든 계수가 0이다(A·B도 t=85초까지 `asks=0`이었다).
그래서 D팔도 다른 팔과 같은 창을 본다. 「20초면 갈린다」는 내 가정이 틀렸고, 그 사실을 하네스
주석에 적어 뒀다.

---

### 2.3 단위 못 여섯 개 (하네스가 없어도 빨개지게)

| 어디 | 테스트 | 무엇을 잠그나 |
|---|---|---|
| `ccg-engine` | `a_bare_name_resolves_through_path_the_way_the_shell_does` | 맨 이름은 PATH에서 찾는다(빈 항목·없는 폴더는 건너뛴다) |
| `ccg-engine` | `on_windows_an_extensionless_file_is_not_a_command` | npm이 같이 까는 `codex`(sh)는 후보가 아니다 — `codex.cmd`가 답이다 |
| `ccg-engine` | `a_path_shaped_value_is_answered_by_one_stat_and_is_never_cached` | 방금 설치한 실행본을 곧바로 알아본다 · 지운 것을 캐시가 살려내지 않는다 |
| `ccg-engine` | `the_bare_name_cache_is_keyed_by_the_path_it_was_answered_with` | PATH가 바뀌면 캐시가 저절로 무효 |
| `ccg-engine` | `codex_bin_falls_back_to_path_when_nothing_is_installed`(+2줄) | **그 폴백값은 파일이 아니다** — 이 라운드 구멍의 씨앗 |
| `agentcodegui` | `a_codex_found_on_the_global_path_is_an_instrument_too` | ★ 전역 PATH codex + 등록 계정 → `can_ask`·`instrument` 둘 다 산다 |
| `agentcodegui` | `a_codex_that_is_nowhere_is_still_no_instrument` | 대조군 — 진짜로 없으면 여전히 창구가 없다 |

**기존 테스트 둘에 못을 박았다.** `the_channel_answers_with_one_row_per_registered_account`와
`an_unregistered_account_has_no_instrument_…`는 「이 컴퓨터에 codex가 깔려 있나」에 답이 흔들리는
상태였다(고친 뒤에는 전역 설치 판에서 **진짜 app-server를 띄웠을** 것이다 — 12초 마감 × 계정 수).
`CCG_CODEX_BIN`을 없는 경로로 못 박아 어느 컴퓨터에서나 같은 판이 되게 했다.

```
cargo test -p ccg-engine    207 / 0   (크리틱 기준 203 → +4)
cargo test -p agentcodegui  145 / 0   (내 +2 포함 — 145 = 이 시점 트리의 전량)
npm run typecheck(node·web) · typecheck:app   3종 초록
```

### 2.4 옆 축 무회귀 — `poc-limit-codex` **8 / 0**

CRIT R1의 헤드라인 레시피(등록 codex 계정이 **없는** 판)를 내 exe로 다시 쟀다. 이 라운드가
`can_ask`의 문을 넓혔으니 「창구가 없다 → 발사」가 사라졌을까 봐 건 확인이다:

```
t= 90s spawns=1 stdin=502B hold=no  {asks:1, fetches:0, blocked:0, unavailable:0, unknown:1}
C5 사용자 메시지가 큐에서 풀려 나갔다 — {"queue":[],"spawns":1,"hold":null}
PASS — 8 통과, 0 실패     (→ bench/scratch/cpath-limit-codex.json)
```

**계정이 없으면 여전히 `unknown`이고 여전히 t=90초에 발사한다** — 문을 넓힌 것은
「실행본이 있나」 하나뿐이고, 「등록 계정이 있나」는 그대로다.

---

## 3. 안전

- **수정본 주행에서는 사용자의 실 codex 프로세스가 한 번도 안 떴다.** A팔이 PATH에서 찾는 것은
  격리 홈에 방금 놓은 가짜 사본이고, D팔은 진짜를 PATH에 두지만 **발사하지 않으므로**(그것이 이
  라운드의 수정) 스폰이 없다. 정직하게 적자면 **대조군(옛 exe) 주행에서는 D팔이 t=90초에 발사해
  진짜 `codex app-server`가 한 번 떴다** — 그것이 바로 이 라운드가 고친 사고다. 그때도 `CODEX_HOME`은
  격리 홈 안의 빈 폴더(`unregistered`)라 실계정은 안 닿고("not logged in"), 프로세스는 `killTree`가 거뒀다.
- 실계정 0건(합성 자격증명) · `CCG_NO_NET=1`이라 HTTP 0건 = **토큰 회전 0**.
- 이름 기반 kill 0회 — 죽인 것은 내가 spawn한 PID 트리뿐(`killTree`).
- 격리 홈 `.poc-home-cpath` · CDP 포트 9471(대조군 9472) · `CARGO_TARGET_DIR=target-cpath`.
- 기준 결과 파일 **0개 덮음**. 새 파일 `docs/critic/codex-path-cpath-r1.json` 하나만 썼고,
  대조군은 gitignored `bench/scratch/`로 냈다.
- ⚠ **내 exe는 순수 HEAD가 아니다.** 빌드 시점 워킹트리에 다른 갈래의 미커밋 변경이 있었다
  (`crates/ccg-fs/src/git.rs` · `crates/ccg-store/{chats_v3,status}.rs` · `app/src/**`). **CPATH 자신의
  파일은 전부 내 것**이고(`crates/ccg-engine/src/codex/{versions,driver}.rs` ·
  `src-tauri/src/engine/{codex_limit,codex_versions,hub}.rs` · `src-tauri/src/ipc/parity/codex.rs`),
  렌더러는 이 라운드에 한 줄도 안 만졌다(`app/dist`는 이전 빌드 그대로 — 이 하네스는 렌더러를 안 탄다).

---

## 4. 남는 것 · 정직한 한 줄

- **PATH 훑기는 stat이다.** 죽은 네트워크 드라이브가 `PATH`에 들어 있으면 그 stat이 느릴 수 있고,
  그 자리가 허브 스레드다. 캐시(15초)가 그 빈도를 상한 짓지만 0으로 만들지는 못한다. 지금 판단은
  「앱이 어차피 `cmd /C`로 같은 훑기를 한다」이다 — 진짜로 아프면 그때 워커로 옮긴다.
- **Claude 축에는 같은 질문의 다른 답이 이미 있다**(경계 밖이라 안 만졌다 — 읽기만 했다).
  `engine/versions.rs:135`의 `claude_bin_exists()`는 맨 이름 폴백을 만나면 *"존재를 확인할 수 없으므로
  **있다고 본다**(스폰이 판정한다)"* 로 답한다. codex 쪽은 같은 자리에서 정반대(**없다고 본다**)를
  골랐고 그것이 이 라운드의 구멍이었다. 셋째 답이 이제 있다 — **찾아본다**(`resolve_bin`).
  `claude_bin_exists()`를 그 헬퍼로 바꾸면 계정 명령의 "실행 파일을 못 찾았어요"가 추측이 아니라
  사실이 된다. 다음 라운드의 후보로 적어 둔다(`ipc/accounts.rs:129-130`이 유일한 소비자다).
