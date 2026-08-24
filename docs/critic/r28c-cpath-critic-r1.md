# R28c 「CPATH」 확인 크리틱 R1 — **구멍은 진짜로 닫혔다.** 그런데 새 헬퍼는 이름 철자 하나에 다시 열리고, 이 라운드의 인수인계 노트가 정확히 그 지뢰를 밟으라고 적혀 있다

크리틱: CPATH 확인 갈래 · 2026-08-25 · `feature/3.0.0-beta` · 판정 대상 `5b4a8cf` + `a31c420`

---

## 0. 한 문단 결론

**빌더의 숫자는 전부 내 손에서 재현됐다.** 내가 순수 HEAD로 다시 빌드한 exe로 승격 하네스를
**손대지 않고** 돌려 `PASS 9/0 · hole:false`가 나왔고, 같은 하네스를 **CPATH 직전 커밋
(`5a91881`)에서 따로 빌드한 대조군**에 물리니 `FAIL 4/5 · hole:true`가 나왔다 — A팔은
`unknown:1 · fetches:0 · t=90초 발사 · 대기표 소멸`, 즉 크리틱 R28b §3이 적은 그 사고 그대로다.
「진짜 전역 codex」 D팔도 수정본에서 `asks:2 · unknown:0 · unavailable:2 · 미발사`로 뒤집혔다.
B·C팔은 두 exe에서 글자 하나 안 흔들렸다 = 이 하네스는 고친 축만 가른다. cargo(ccg-engine
207/0 · agentcodegui 145/0 6회 반복) · typecheck 3종 · 옆 축 셋(poc-limit-codex 8/0 ·
poc-limit-engine 11/0 · poc-limit-resume 197/0) 전부 초록이다.

**그런데 새 헬퍼 `resolve_bin`은 「셸의 규칙」이 아니다.** Windows 후보 확장자 목록
(`path_exts`, `versions.rs:172`)에 **빈 확장자가 없다** — 그래서 맨 이름에 확장자가 이미 붙어
있으면(`codex.exe`) `codex.exe.COM`·`codex.exe.EXE`…만 뒤지고 정작 `codex.exe`는 **한 번도 안
본다**. 승격 하네스 A팔의 씨앗에서 **철자 하나만** `codex` → `codex.exe`로 바꿔(PATH에 놓인 실물
파일 이름 그대로) **수정본 exe에** 물렸더니 이번 라운드가 지운 바로 그 사고가 되살아났다:
`unknown:1 · fetches:0 · t=90초 발사 · 표 소멸 · hole:true`.

codex는 폴백 철자가 `codex`라 오늘은 안 터진다. **그러나 클로드는 `claude.exe`다**
(`src-tauri/src/engine/versions.rs:125·129`), 그리고 이 라운드의 「미완/넘김」이 바로 그
`claude_bin_exists()`를 `resolve_bin`으로 바꾸라고 적어 두었다. 이 컴퓨터의 `where claude`는
`C:\Users\User\.local\bin\claude.exe`다 — 노트대로 하면 전역 PATH claude 사용자 전원이
로그인·로그아웃·커밋 메시지에서 「실행 파일을 못 찾았어요」를 보게 된다. 지뢰가 아니라
**지뢰를 밟으라고 적힌 화살표**다.

---

## 1. 무엇으로 쟀나 — 빌드와 정직한 한 줄

| | 무엇 |
|---|---|
| 트리 | `feature/3.0.0-beta` @ `a31c420` — **추적 파일 미커밋 0건**(`git diff HEAD` 비었음). 빌더의 exe는 다른 갈래의 미커밋을 안고 구워졌지만(`md5 6f2f4534…`) 내 것은 순수 HEAD다 |
| 수정본 | `CARGO_TARGET_DIR=target-critcpath` · `npm run app:build` + `cargo build --release --features custom-protocol -p agentcodegui` → **6,469,632 B · md5 `7f789813dd587caeb263082136c70432`** |
| 가짜 CLI | `cargo build --release -p ccg-engine --features fakecli --bin ccg-fakecodex --bin ccg-fakecli`(같은 target) |
| **대조군** | `git archive 5a91881`(= CPATH의 **부모**) → `C:\Temp\ccg-critcpath-ctrl` · `CARGO_TARGET_DIR=target-critcpathctl` → **6,465,024 B**. 빌더가 쓴 대조군은 R28b 크리틱의 옛 exe였는데, 나는 **CPATH 두 커밋만 빠진 트리**로 다시 구웠다 — 다른 갈래의 변화가 섞이지 않은 대조군이다 |
| 격리 | `CCG_HOME`은 하네스가 파는 `.poc-home-cpath`/`.poc-home-critcpathx`(주행 후 잔여 0) · CDP **9491·9492·9493**(다른 갈래와 안 겹침) · `CCG_NO_NET=1` · 이름 기반 kill 0회(`killTree`만) · 공용 `target/`·남의 `target-*`에 한 바이트도 안 지었다 |
| 기준 파일 | `docs/critic/codex-path-cpath-r1.json`·`limit-*-{crit,t3t4}-*.json` **0개 덮음** — 전부 `--out=`으로 내 이름(`*-critcpath-*.json`)에 썼다 |

**정직한 한 줄 둘.**

1. **대조군 D팔은 실제로 발사했고, 그 순간 사용자의 진짜 `codex.cmd`가 한 번 떴다.**
   나는 그것을 피하려고 npm 전역 폴더를 PATH에서 빼고 돌렸는데 **필터가 안 먹었다** —
   Windows 환경 블록은 `Path`와 `PATH`를 동시에 갖고, `{...process.env, PATH: …}`로 만든 env는
   원래 키(`Path`)를 그대로 남겨 그쪽이 이겼다(`rep.machine.whereCodex`가 여전히 npm 경로를
   가리킨 것이 물증이다). 그때도 `CODEX_HOME`은 격리 홈 안의 폴더라 **실계정 0건**이고,
   주행 뒤 `codex.exe`·`agentcodegui.exe` 잔여 프로세스는 **0개**다(WMI 실측 — 남은 5개는
   사용자의 설치본 Electron `AgentCodeGUI.exe`로, 손대지 않았다).
2. 내 추가 공격(§4)에 쓴 하네스는 승격본의 **복사본**이고 `bench/scratch/`(gitignored)에 있다.
   `scripts/`·`crates/`·`src-tauri/`는 **한 글자도 안 고쳤다**.

---

## 2. 체크리스트 판정표 — 전부 이번 패스의 실측

| # | 항목 | 판정 | 실측 |
|---|---|---|---|
| 1 | 승격 하네스 A팔이 뒤집히는가(`hole:false`) · B팔 불변 | ✅ | 수정본 `PASS 9/0 · hole:false` / 대조군 `FAIL 4/5 · hole:true`. B팔은 두 exe에서 **동일** |
| 2 | 세 자리가 같은 헬퍼/기준인가 · 캐시가 tick 부하를 안 늘리는가 | ✅ (주석 한 줄만 ✖ — §5.2) | `is_file()` 게이트 잔존 **0개**. 부하는 「사다리당 1회 · 최악 6.9 ms」로 실측 |
| 3 | poc-limit-codex · poc-limit-engine · poc-limit-resume 무회귀 | ✅ | **8/0 · 11/0 · 197/0** |
| 4 | cargo 크레이트별(ccg-engine 203 후퇴 금지) · typecheck 3종 | ✅ | ccg-engine **207/0**(+2 ignored) · agentcodegui **145/0**(6회 반복 전부) · typecheck node/web/app 초록 |

---

## 3. 통과로 확인한 것 — 숫자 그대로

### 3.1 ★ A/B — 갈리는 값은 이 라운드가 고친 축 하나뿐

같은 하네스(`scripts/poc-codex-path.mjs`, **무수정**) · 같은 씨앗 · 다른 exe.

| 팔 | 수정본(`7f789813…`) | 대조군(`5a91881` 빌드) |
|---|---|---|
| **A · 전역 PATH**(`CCG_CODEX_BIN=codex` + PATH 앞에 실물 `codex.exe`) | `asks:2 · fetches:1 · unknown:0 · unavailable:2` · **미발사** · 표 유지 | `asks:1 · fetches:0 · unknown:1 · unavailable:0` · **t=90초 발사** · **표 소멸** |
| **B · 앱 설치본**(절대 경로) | `asks:2 · unknown:0 · unavailable:2` · 미발사 | **같음**(안 흔들렸다) |
| **C · 아무 데도**(PATH에서 codex 제거) | `unknown:1` · **t=90초 발사**(옛 계약) | **같음**(안 흔들렸다) |
| **D · 진짜 전역**(우회로 없음 · PATH 그대로) | `asks:2 · fetches:1 · unknown:0 · unavailable:2` · **미발사** | `asks:1 · fetches:0 · unknown:1` · **t=90초 발사** |
| 판정 | `hole:false` · **PASS 9/0** | `hole:true` · **FAIL 4/5** |

- 대조군 A팔의 `fetches:0`이 R28b 크리틱이 짚은 그 물증이다 — **워커를 깨우지도 않았다.**
  수정본에서 `fetches:1`로 올라간 것이 「이제 진짜로 물어본다」의 숫자다.
- **B·C가 두 exe에서 같다** = 이 하네스는 「고친 축」만 가른다. C가 초록이라 A의 초록은
  "전부 unavailable로 만들어 얻은 가짜"가 아니다.
- D팔이 뒤집힌 것이 이 라운드의 실질이다: **우회로도 가짜도 없이**, 이 컴퓨터의
  `where codex`(`AppData\Roaming\npm\codex` · `codex.cmd`)만으로 재검증이 돈다.

산출물: `docs/critic/codex-path-critcpath-r1.json`(수정본) · `C:\Temp\ccg-critcpath-ctrl-report.json`(대조군 · 레포 밖).

### 3.2 세 자리 단일화 — 코드로 확인

`is_file()`을 「실행본이 있나」의 대용으로 쓰는 자리는 codex 축에 **하나도 안 남았다**
(`grep -rn "is_file()\|\.exists()" src-tauri/src` → 남은 것은 주석과 테스트, 그리고 클로드 축의
`versions.rs:121·137`뿐).

| 자리 | 지금 무엇을 보는가 |
|---|---|
| `engine/hub.rs:318`(턴) | `codex_versions::spawn_bin()` |
| `ipc/parity/codex.rs:74`(모델 조회) | `codex_versions::codex_exe()` — `None`이면 왕복 자체를 안 만든다 |
| `engine/codex_limit.rs:121·138`(한도·게이지) | `codex_versions::codex_exe()` |
| `engine/codex_limit.rs:224`(조회 스폰) | `codex_versions::spawn_bin()` |
| `codex/driver.rs:140`(맨 이름 판정) | `versions::is_bare_name` — 사본 제거 확인 |

`spawn_bin()`이 못 찾을 때 **옛 인자를 그대로 넘기는** 규약도 확인했다(EngineGate 경로 불변).
`parity/codex.rs`의 조기 반환값 `[]`은 이전(스폰 실패 → `[]`)과 같은 값이고, 위쪽 캐시의
`(0, Some(prev)) => prev` 규율도 안 바뀌었다.

### 3.3 옆 축 무회귀 · 테스트

| 무엇 | 값 |
|---|---|
| `poc-limit-codex`(수정본 exe) | **8/0** — `t=90초 spawns=1 · stdin=502B · unknown=1 · blocked=0` · 큐 드레인 |
| `poc-limit-engine`(수정본 exe) | **11/0** — `asks:2 · fetches:2 · unavailable:2 · spawns:0 · stdin 0B` |
| `poc-limit-resume`(순수 JS) | **197/0** |
| `cargo test -p ccg-engine` | **207 passed · 0 failed · 2 ignored**(신규 4 = 기준 203 유지) |
| `cargo test -p agentcodegui` | **145 passed · 0 failed** — **6회 연속 동일**(새 테스트가 프로세스 전역 `PATH`를 갈아 끼우므로 flaky를 의심해 반복했다. 1.48~1.51초로 안정 = 진짜 app-server를 띄운 주행도 없다) |
| typecheck | `typecheck:node` · `typecheck:web` · `typecheck:app` 전부 exit 0 |

빌더가 기존 테스트 둘에 박은 `CCG_CODEX_BIN` 못은 **꼭 필요한 것이었다** — 그 못이 없으면
`can_ask`가 참이 되어 `accounts_usage()`가 이 컴퓨터의 진짜 `codex app-server`를 계정 수만큼
띄운다(12초 마감 × N). 반복 주행의 1.5초가 그 못이 살아 있다는 물증이다.

산출물: `docs/critic/limit-codex-critcpath-r1.json` · `docs/critic/limit-engine-critcpath-r1.json`.

---

## 4. ★ 크리틱이 새로 판 공격 — **철자 하나로 같은 구멍이 다시 열린다**

### 4.1 무엇을 의심했나

`resolve_bin`의 헤더는 이렇게 약속한다(`crates/ccg-engine/src/codex/versions.rs:114-118`):

> 해석 규칙은 **셸의 그것**이다 … 맨 이름이면 `PATH`를 앞에서부터 훑되 **디렉터리 하나에
> `PATHEXT`를 다 대 보고** 다음 디렉터리로 간다 — `cmd.exe`가 하는 순서 그대로다.

그런데 `path_exts()`(`:172`)는 Windows에서 `PATHEXT` 항목만 돌려주고 **빈 확장자를 넣지 않는다.**
`scan_path`(`:152`)는 그 목록을 `dir.join(name)` **뒤에 붙이기만** 한다. 그러면 이름에 확장자가
이미 붙어 있을 때 후보는 `codex.exe.COM`·`codex.exe.EXE`·… 뿐이고 **`codex.exe` 자신은
후보에 없다.** `cmd.exe`는 확장자가 붙은 이름을 **그 이름 그대로** 먼저 찾는다 — 약속과 다르다.

### 4.2 실측 — 수정본 exe에서 그 사고가 그대로 되살아난다

승격 하네스를 `bench/scratch/critcpath-extname.mjs`로 복사하고 **A팔의 변수 하나만** 바꿨다:
`codexBin: 'codex'` → `codexBin: 'codex.exe'`. 씨앗은 그대로다 — PATH 앞칸에 놓이는 실물 파일
이름이 원래부터 `codex.exe`이므로(승격 하네스 `seedHome()`의 그 줄) **PATH에는 정확히 그 파일이
있다**. 즉 「PATH에서 찾을 수 있어야 정상」인 판이다.

```
[A/PATH] t= 85s spawns=0 hold=yes asks=0 unknown=0 unavailable=0
[A/PATH] t= 90s spawns=1 hold=no  asks=1 unknown=1 unavailable=0   ← 발사 · 표 소멸
✗ A1 전역 PATH 판이 발사하지 않았다 — t=90초에 쐈다
✗ A2 unavailable로 판정했다 — unknown=1 unavailable=0
✗ A3 대기표가 살아 있다 — 표가 사라졌다
판정: {"A.fired":true,"A.unknown":1,"A.unavailable":0,"hole":true}      ← 수정본 exe다
```

`fetches:0` — **워커를 깨우지도 않았다.** R28b §3이 대조군에서 잰 계수와 글자까지 같다.
그리고 턴은 멀쩡히 뜬다: `spawn_bin()`이 해석에 실패해 맨 이름을 그대로 넘기고,
`command_for`가 맨 이름이므로 `cmd /C ""codex.exe" app-server"`로 풀어 **PATH에서 찾아 띄운다**.
「턴은 돌고 한도만 눈을 감는다」 — 이번 라운드가 지운 그 조합이다.

산출물: `bench/scratch/critcpath-extname.json`(gitignored).

### 4.3 왜 이것이 지금 중요한가 — **이 라운드의 인수인계가 그 지뢰를 가리킨다**

codex는 오늘 안 터진다. `versions::codex_bin()`의 폴백 철자가 `codex`(확장자 없음)이고
`CCG_CODEX_BIN`은 하네스 전용이기 때문이다. **클로드는 다르다:**

```rust
// src-tauri/src/engine/versions.rs
125:    PathBuf::from(EXE)              // ← PATH 폴백
129:    const EXE: &str = "claude.exe"; // ← Windows
135:    pub fn claude_bin_exists() -> bool { let b = claude_bin(); b == PathBuf::from(EXE) || b.exists() }
```

그리고 `docs/parity-fix-cpath-r1.md`의 「미완/넘김」이 이렇게 적혀 있다:

> `resolve_bin`으로 바꾸면 계정 명령의 "실행 파일을 못 찾았어요"가 추측이 아니라 사실이 된다.

**사실이 아니라 정반대가 된다.** 이 컴퓨터의 `where claude`는 `C:\Users\User\.local\bin\claude.exe`
— 즉 전역 PATH claude 사용자다. 노트대로 바꾸면 `resolve_bin(Path::new("claude.exe"))`가
`claude.exe.COM`…만 뒤지다 `None`을 내고, 그 값을 읽는 **세 자리**가 전부 거짓 안내로 막힌다.

| 소비자 | 무슨 일이 일어나나 |
|---|---|
| `ipc/accounts.rs:130` (`login`) | 로그인 버튼이 `NO_BIN`("실행 파일을 못 찾았어요")로 즉시 거절 |
| `ipc/accounts.rs:285` (`logout`) | 토큰 **해지를 건너뛴다** — 서버에 살아 있는 토큰이 남는다 |
| `ipc/parity/aimsg.rs:268` (커밋 메시지) | "설치된 엔진이 없어요 — 설정 → Engine에서 먼저 설치해 주세요" |

덧붙여 보고서의 *"유일한 소비자는 `ipc/accounts.rs:129-130`"* 은 **사실이 아니다** — 위 표대로
셋이고, 그중 하나(`logout`)는 UI 문구가 아니라 **토큰 해지 여부**를 가른다. 다음 라운드가 그
한 줄을 믿고 「소비자 하나만 보면 된다」고 판단하면 그 부작용을 못 본다.

### 4.4 곁가지 둘 (같은 함수 · 낮은 심각도)

- **CWD를 안 본다.** `cmd.exe`는 PATH보다 먼저 현재 폴더를 뒤진다. `scan_path`는 PATH만 훑는다.
- **`.VBS`/`.JS` 해석의 비대칭.** `path_exts()`는 `PATHEXT` 전부(이 컴퓨터는 11개)를 후보로 쓰는데
  `command_for`는 `.cmd`/`.bat`/맨 이름만 셸로 보낸다. `codex.js`가 잡히면 「띄울 수 있다」고
  답한 뒤 직접 스폰해 실패한다 — 두 규칙이 "한 벌"이라는 이 라운드의 규약과 어긋나는 자리다.

---

## 5. 장부 정정 둘

### 5.1 「미완/넘김」의 소비자 수 (§4.3에 적었다)

`claude_bin_exists()`의 소비자는 **1이 아니라 3**이다.

### 5.2 「허브 스레드가 활성 tick 20ms마다 부르는 자리라 캐시가 필수」 — 실측과 다르다

`resolve_bin` 헤더(`versions.rs:124-125`)와 보고서·커밋 메시지가 캐시의 근거로 든 문장이다.
R28b 크리틱의 지시문에도 같은 말("`can_ask`는 tick마다 불린다")이 있었으니 **물려받은 말**이지만,
빌더는 그것을 확인하지 않고 자기 문서에 옮겨 적었다.

**측정.** `can_ask`의 유일한 호출자는 `limit_probe::codex_verdict`이고, 그 함수는
`runtime.rs:3191`의 `self.limit_probe.probe(&q)` 하나에서만 불린다. 그 줄은 `check_hold`가
`due`(재확인 사다리)일 때만 닿는다 — tick마다가 아니다.

- 내 주행: A팔 `asks`가 t=90 → t=105로 **15초 간격**에 1씩 올랐다(120초 관찰에 총 2회).
- 같은 레포의 게이트가 이미 그 사실을 잠그고 있다: `poc-limit-engine` **E8 「tick마다 조회하지
  않는다(사다리) — asks:2」**(110초 주행). 새 주석은 자기 레포의 초록 게이트와 모순된다.
- 스캔 자체의 비용도 쟀다: 이 컴퓨터는 `PATH` 46칸 × `PATHEXT` 11개 = 최악 506 stat, 실측
  **찾을 때 6.3 ms(422 stat) · 못 찾을 때 6.9 ms(506 stat)**.
- 그리고 `RESOLVE_TTL`(15초)이 **사다리 첫 칸(15초)과 같다** — 그 경로에서 캐시 적중은
  구조적으로 거의 0이다.

캐시가 해로운 것은 아니다(진짜 수혜자는 설정 화면의 `accounts_usage()`다). 문제는 **「거짓 주석을
지운 것」이 헤드라인인 라운드가 검증되지 않은 새 주석을 같은 파일에 남겼다**는 점이다.
근거를 「허브 tick」이 아니라 「계정 게이지 조회」로 고쳐 적으면 끝나는 한 줄이다.

---

## 6. 하네스·규율 관측

- 승격본 `scripts/poc-codex-path.mjs`는 **좋은 게이트**다: 씨앗이 「이 컴퓨터에 codex가 있다」에
  기대지 않고 팔마다 `PATH`를 세우며, C팔(아무 데도 없음)이 A팔의 초록이 가짜가 아님을 잠근다.
  D팔은 「이 컴퓨터가 그 인구일 때만」 도는 진단 팔로 설계가 정확하다.
- 다만 **A팔의 이름 철자가 게이트의 사각지대**다(§4). 팔 하나(`codex.exe`)를 더 두면 이 라운드가
  세운 규칙("셸의 그것")이 코드와 어긋나는 순간 빨개진다 — 지금은 안 빨개진다.
- `--out`/`--exe`/`--port` 규약은 잘 지켜져 기준 파일을 하나도 안 덮고 병렬 주행이 가능했다.
- 하네스가 `where codex`로 D팔을 켜고 끄는데, 그 판정이 **부모 프로세스의 PATH**를 그대로 쓴다.
  D팔을 의도적으로 끄고 싶은 주행(= 사용자의 실 codex를 절대 안 띄우고 싶은 대조군)에서
  그것을 끌 스위치가 없다 — `--no-real` 같은 팔 하나가 있으면 §1의 「정직한 한 줄」이 필요 없어진다.

---

## 7. 종합

| | |
|---|---|
| 이 라운드가 닫겠다고 한 구멍 | **닫혔다.** 순수 HEAD 빌드 + 무수정 하네스 + 자체 대조군으로 `hole:true → false` 재현 |
| 빌더가 적은 숫자 | **전부 재현**(9/0 · 4/5 · 207 · 145 · 8 · 11 · typecheck 3종) |
| 세 자리 단일화 | **됐다** — codex 축에 `is_file()` 게이트 잔존 0 |
| 새로 판 구멍 | **있다** — `resolve_bin`은 확장자 붙은 맨 이름을 못 찾는다. 수정본 exe에서 `codex.exe` 한 철자로 `hole:true` 재현 |
| 그 구멍의 뇌관 | 이 라운드의 인수인계가 `claude_bin_exists()`(폴백 철자 **`claude.exe`**)를 `resolve_bin`으로 바꾸라고 적어 두었고, 소비자 셋 중 하나는 **토큰 해지**를 가른다 |
| 장부 | 두 줄이 사실이 아니다 — 「소비자 하나」(§5.1) · 「tick 20ms마다」(§5.2) |

**다음 라운드에 넘기는 지시**

1. `path_exts()`에 **원래 이름 그대로**(빈 확장자)를 후보로 넣어라 — 단, Windows에서 그 후보는
   *이름에 이미 확장자가 있을 때만* 유효해야 한다(확장자 없는 `codex` sh 스크립트를 다시 잡으면
   이 라운드가 일부러 막은 것을 되돌린다). 판정 기준은 **`Path::extension().is_some()`**이다.
2. 승격 하네스에 팔 하나(`CCG_CODEX_BIN=codex.exe` · PATH에 `codex.exe`)를 더해 못을 박아라.
   지금 그 팔은 수정본에서 **빨강**이다(`bench/scratch/critcpath-extname.json`).
3. `claude_bin_exists()`를 `resolve_bin`으로 바꾸기 **전에** 1을 먼저 해라. 순서가 반대면 전역
   PATH claude 사용자가 로그인·**로그아웃(토큰 해지)**·커밋 메시지에서 막힌다.
4. `resolve_bin` 헤더의 캐시 근거를 「허브 tick 20ms」에서 「설정 ▸ Account 게이지 조회」로 고쳐라.
   지금 문장은 같은 레포의 `poc-limit-engine` E8과 모순된다.

---

## 8. 산출물

| 무엇 | 어디 |
|---|---|
| 승격 하네스 · 수정본 | `docs/critic/codex-path-critcpath-r1.json`(PASS 9/0 · `hole:false`) |
| 승격 하네스 · 대조군(`5a91881` 빌드) | `C:\Temp\ccg-critcpath-ctrl-report.json`(FAIL 4/5 · `hole:true`) |
| 옆 축 무회귀 | `docs/critic/limit-codex-critcpath-r1.json`(8/0) · `docs/critic/limit-engine-critcpath-r1.json`(11/0) |
| 새 공격(§4) | `bench/scratch/critcpath-extname.mjs` · `bench/scratch/critcpath-extname.json`(gitignored) |
| 대조군 트리 | `C:\Temp\ccg-critcpath-ctrl`(`git archive 5a91881`) · `target-critcpathctl/`(gitignored) |
