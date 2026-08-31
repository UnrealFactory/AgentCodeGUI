# LSPDIST R1 확인 크리틱 — 판정문

> 대상 커밋: `adcef10` · `ef03f73` · `e36ea7d` · `bcd0734`(팁) · 브랜치 `feature/3.0.0-beta`
> 피감 보고서: `docs/parity-fix-lspdist-r1.md`
> 여는 미결: `docs/decisions-3.0.md` §1.6-A2 · §1.6-F · §1.4-b
>
> **재현 환경(빌더의 워크트리·빌더의 계기를 하나도 안 썼다)**
> - 트리: `git archive bcd0734` → `%TEMP%\ccg-critic-lspdist\tree` (`node_modules`는 정션만 · `npm ci` 금지)
> - `CARGO_TARGET_DIR=C:\Temp\ccg-critic-lspdist-target` · `npm run tauri:build:unsigned`
>   + `cargo build --release -p ccg-lsp --features cli --bin ccg-lspprobe`
> - 옛 코드 팔: `git archive adcef10^`(= `09b9bc7`) → 별도 트리·별도 타깃에서 따로 구움
> - 계기: `docs/critic/tools/critic-lspdist-r1.mjs`(신설 · 빌더 PoC 재실행 아님)
> - 증거: `docs/critic/lspdist-critic-r1-probe.json` · `-evidence.json` ·
>   `-mem-instcwd.json` · `-mem-projcwd.json`
> - 규율 준수: 이름 기반 kill 0 · NSIS 설치기 **미실행** · 전 팔 `CCG_HOME` 격리 ·
>   실홈(`%USERPROFILE%\.agentcodegui`) 무접촉 · CDP 포트 11030·11031 · 기준 파일 무접촉 ·
>   제품 코드 무수정(돌연변이는 전부 격리 사본에서, 매회 원상복구 확인)

---

## 0. 판정

### **합격 — 단, §1.6-A2는 「해소」가 아니라 「좁혀짐」이다.**

이 라운드가 **자기가 겨눈 못은 진짜로 부러뜨렸다.** 내 계기로 다시 쟀고 전부 재현된다:

- **cwd 사슬은 코드에서 실제로 사라졌다.** 번들 없는 배포 모사에서 cwd를 사용자 프로젝트로
  놓아도 **ts·py 둘 다 error**이고 `resolve.modules`가 `null`이다. 옛 트리(`09b9bc7`)로 같은
  자리에서 되짚으면 같은 팔이 **ready·토큰 1,565**로 뜬다 — 띠의 존재와 사망을 둘 다 실측했다.
- **번들은 진짜로 실린다.** 같은 exe로 리소스만 빼고 다시 구웠다:
  `8,973,000 B → 2,812,813 B`, 차이 **+6,160,187 B**. 빌더 신고값 +6,160,174 B와 **13바이트** 차.
- **두 cwd 팔이 같은 판을 문다** — `resolve.modules` 바이트 동일(두 언어 모두).
- **메모리 띠가 사라진 것도 참이다.** 내 실측 두 팔 차 **4.65MB(0.8%)**, 방향은 빌더와 **반대**.
  → 남은 차가 모양이 아니라 잡음이라는 빌더의 결론을 오히려 강화한다.

그런데 **「배포본에서 TS·Python LSP는 항상 뜬다」는 참이 아니다.** PATH에서 node를 걷어낸
기계 모사에서 **두 언어 × 두 cwd 네 팔 전부 `status=error` · `resolve.node=null`**이다.
2.6.2는 그 전제가 **0**이었다(Electron이 곧 Node · 모듈은 `app.asar.unpacked` 안 — 동결 구역
`src/main/lsp/manager.ts:787-791`의 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, 실제 2.6.2
빌드 산출물에서 세 모듈 실물 확인).

즉 **§1.6-A2가 겨눈 사용자 증상(「배포본에서 코드 인텔리전스가 안 뜬다」)은 없어지지 않았다.
「cwd에 따라 갈린다」가 「node가 없으면 안 뜬다」로 바뀌었을 뿐이다.** 결정론은 얻었고 인구는
줄었지만 **닫힌 것은 아니다.** 빌더는 이 사실을 §6.1에 ★로 자백했으므로 은폐가 아니고,
그래서 판정은 합격이다. 다만 §0·§4.3의 결론 문장이 그 단서를 안 지고 있다(→ C1).

---

## 1. 실측 재현 — 칸별 대조

### 1.1 기능·결정론 (`critic-lspdist-r1.mjs` · 판정 21개 전부 통과)

| 팔 | 번들 | cwd | ts | py | 빌더 신고 | 일치 |
|---|---|---|---|---|---|---|
| `bundled/install-cwd` | 있다 | 설치 폴더 | **ready · hover 6/6 · 토큰 1,565** | **ready · 6/6** | ready·8/8·1,565 | ✅ |
| `bundled/project-cwd` | 있다 | 격리 트리 안 프로젝트 | **ready · 1,565** | **ready** | 동일 | ✅ |
| `bare/install-cwd` | 없다 | 설치 폴더 | error | error | error | ✅ |
| **`bare/project-cwd`** | 없다 | **조상에 `node_modules` 있음** | **error · modules=null** | **error · null** | error | ✅ |
| `before(09b9bc7)/bare/install-cwd` | 없다 | 설치 폴더 | error | error | error | ✅ |
| **`before/bare/project-cwd`** | 없다 | 프로젝트 | **ready · 1,565** | **ready** | ready(ts만 쟀다) | ✅ + py 확장 |

- 두 `bundled` 팔의 `resolve.modules`는 **바이트 동일**이고, 문 파일은 배포 모사 번들 안이다
  (`…\ccg-critic-lspdist\bundled\node_modules\…`). 「둘 다 성공」이 아니라 「같은 판」임을 확인했다.
- 옛 코드 되짚기를 **파이썬 팔까지** 넓혔다 — 띠는 TS만의 현상이 아니었다.
- `CCG_LSP_MODULES` 레버 생존: 번들 없는 exe + 환경변수만 → **ready**. ✅
- 개발 실행: exe를 `<트리>/target-sim/release/`에 두고 **cwd 조상에 `node_modules`가 하나도
  없는 자리**에서 켜도 **ready**, 문 파일은 트리의 `node_modules`. → cwd를 지운 대가를 개발이
  치르지 않는다는 §2.1 (3)번 근거가 **런타임으로도** 참이다. ✅

### 1.2 ★ PATH에 node가 없는 기계 — 빌더가 한 칸만 잰 자리를 네 칸으로

| 팔 | status | `resolve.node` | 모듈 |
|---|---|---|---|
| `nonode/bundled/install-cwd` · ts | **error** | null | 찾는다 |
| `nonode/bundled/project-cwd` · ts | **error** | null | 찾는다 |
| `nonode/bundled/install-cwd` · py | **error** | null | 찾는다 |
| `nonode/bundled/project-cwd` · py | **error** | null | 찾는다 |
| **`nonode/sidecar/install-cwd` · ts** | **ready · 토큰 1,565** | `…\bundled\node_modules` 옆 `node.exe` | — |
| **`nonode/sidecar/install-cwd` · py** | **ready** | 〃 | — |

두 줄이 이 판정문의 핵심이다:

1. **네 팔 전부 죽는다** — cwd도, 언어도 구원하지 못한다. 진단은 정확하지만(모듈은 찾는다)
   서버는 못 뜬다.
2. **`<설치 폴더>\node.exe` 한 파일이면 두 언어가 즉시 산다.** `node_exe()`의 사이드카 칸이
   이미 코드에 있고 동작한다 — **빠진 것은 코드가 아니라 설치기 매니페스트 한 줄과 그 파일을
   재현 가능하게 스테이징하는 빌드 단계뿐**이다. §6.1의 「다음 라운드 결정」은 설계 결정이
   아니라 패키징 작업이다.

### 1.3 풋프린트 — 같은 exe로 두 번 구웠다

| | 설치기(NSIS·lzma) | 내 실측 | 빌더 신고 | 차 |
|---|---|---:|---:|---:|
| 리소스 있음 | `…x64-setup.exe` | **8,973,000 B** | 8,971,808 B | +1,192 B(무서명/경로 차) |
| 리소스 없음 | 같은 exe · 번들 단계만 재실행 | **2,812,813 B** | 2,811,634 B | +1,179 B |
| **차이** | | **+6,160,187 B (5.87MB)** | +6,160,174 B | **13 B** |

- 적재물: `installer.nsi`의 `File /a "/oname=node_modules\…"` **5,426줄** · 원바이트 **43.53MB** ·
  4KiB 클러스터 **58.78MB** — 보고서와 **완전 일치**. 패키지 분해도 일치
  (pyright 18.16 / typescript 23.17 / tsls 2.20MB).
- 2.6.2 분모: 설치기 **165,119,775 B** 일치 · `dist/win-unpacked` **650MB** 일치 ·
  파일 수 **8,139**(보고서 8,141 — 오차 2, 무시 가능).
- `node.exe` v24.13.1 = **91,406,496 B = 87.17MB** — §6.1 값 일치.
- 유령 바이트 실측 **14.12MB**(`_tsc.js` 5.95 · 로케일 4.27 · pyright 소스맵 2.55 ·
  `cli.mjs.map` 1.35) — 보고서 「약 15MB」는 오차 내.

### 1.4 메모리 — 두 팔 × 2회 (`--tag`·`--out`으로 기준 파일 무접촉)

| 팔 | cwd | 프로세스 | 헬퍼 | 헬퍼 WS | 유휴 WS | 유휴 Priv | FPS |
|---|---|---:|---:|---:|---:|---:|---|
| I | 설치 폴더 | 8 | 3 | 124.7 | **568.85** | **354.45** | 60.0 / p95 16.8 / 드랍 0% |
| P | 프로젝트 | 8 | 3 | 125.0 | **573.50** | **362.80** | 60.0 / p95 16.8 / 드랍 0% |
| 차 | — | 0 | 0 | 0.3 | **4.65 (0.8%)** | 8.35 | — |

- **띠 소멸은 참이다.** 고치기 전 153.2MB → 빌더 9.8MB → **내 실측 4.65MB**, 게다가 부호가
  빌더와 **반대**(빌더는 설치 팔이 컸고 나는 프로젝트 팔이 크다). 두 계기가 서로 다른 부호로
  같은 결론을 낸다 = 남은 차는 잡음이다. **§1.6-F ①(「어느 팔을 공시할까」)는 실제로 소멸했다.**
- 비율(분모 2.6.2 `718.6 / 508.9`): 있는 그대로 **0.792 / 0.798**(빌더 0.803 / 0.790),
  G1(LSP 제외) **0.618 / 0.624**(빌더 0.627 / 0.613). 전부 같은 자리. — 단 §2 C5를 반드시 같이 읽어라.

### 1.5 무후퇴

- `cargo test --workspace`(격리 트리·격리 타깃): **787 통과 · 0 실패 · 14 무시.**
  `ccg-lsp` 라이브러리 **66개** — 보고서의 「ccg-lsp 66개(신설 7 포함)」는 **정확**하다.
  다만 워크스페이스 합계 **「362개」는 재현되지 않는다**(→ L1).
- 엔진 파일(`manager.rs`·`rpc.rs`) 0줄 변경 확인. `server.rs`는 진단 문자열 1곳(다중행 포맷)뿐.

---

## 2. 결함

### 치명 — **없다.**

### 중

**C1. §1.6-A2를 「해소」로 적었다 — node 없는 기계에서는 안 닫혔다.**
`§4.3` 표의 *"셋째 줄이 §1.6-A2의 해소다"*, `§0`의 *"이제 배포본의 TS·Python LSP는 어디서
켜든 뜨고"*가 단서 없이 서 있다. 내 실측은 **PATH에 node가 없으면 네 팔 전부 죽는다**이다.
§1.6-A2의 문장은 「배포본이 LSP 없음/있음 두 상태를 갖는다」이므로 *두 상태*는 하나가 됐지만,
그 하나가 node 없는 기계에서는 **「없음」**이다. §6.1이 자백하고 있으므로 은폐는 아니고
**서술의 결함**이다. 고칠 값: §0·§4.3에 「PATH에 node가 있는 기계에서」를 명시.

**C2. §6.1의 완화 논거가 실행 경로에서 거짓이다.**
보고서는 *"3.0의 엔진 설치 경로가 `npm install`이라 앱을 쓰려면 어차피 npm이 필요하다"*로
후퇴의 무게를 깎는다. 코드는 반대로 말한다:
- `src-tauri/src/engine/versions.rs:118-131` `claude_bin()` — ① `CCG_CLAUDE_BIN` →
  ② `engines/<v>/…/claude.exe` → ③ **PATH의 `claude.exe`**. 셋 다 node를 안 지난다.
  `crates/ccg-engine/src/driver.rs:347` 이 그 실물 exe를 그대로 스폰한다.
- codex도 같다 — `crates/ccg-engine/src/codex/versions.rs:70-77`은 `codex.cmd` shim을
  **일부러 피하고**(*"cmd → node → codex.exe 세 겹 … node.js 런타임이 하나 더 뜬다"*)
  플랫폼 패키지의 `codex.exe`를 직접 쓴다.
- npm은 **설치·목록에만** 필요하고(`crates/ccg-engine/src/versions.rs:144-165`, `:337-345`,
  `:358-364`), 이미 설치해 둔 사용자는 그 경로를 안 탄다.

→ **「엔진은 되는데 LSP만 죽는」 구성이 성립하고, 코드가 그것을 1급으로 지원한다.**
결정적으로 `src-tauri/src/engine/versions.rs:156`이 `C:\Users\User\.local\bin\claude.exe`를
적어 두고 있다 — **Claude Code 네이티브 설치기의 경로**(npm 경로가 아니다). 그 구성의 기계에
node가 없으면 채팅·로그인·AI 커밋 메시지는 전부 정상이고 **TS·Python LSP만 죽는다.**
보조 인구: 2.6.2에서 3.0으로 올라온 사용자 중 사내 정책 등으로 node를 지운 사람 — 앱 홈이
같으므로(`crates/ccg-store/src/lib.rs:110`) 예전에 깔아 둔 엔진을 그대로 물고, LSP만 잃는다.
(정확한 후퇴 문장은 *"2.6.2는 전제가 0"*이 아니라 **"2.6.2에서 npm 없이 되던 것 중 LSP가
3.0에서 안 된다"**이다 — 2.6.2도 *채팅*에는 npm을 요구했다: `src/main/claude/engine.ts:764-771`.)

**C3. 매니페스트 계약이 이 라운드가 실제로 밟은 두 고장을 못 문다.**
`every_bundled_node_package_is_in_the_installer_manifest`는 **패키지 단위**로만 대조한다
(`d.starts_with("node_modules/<pkg>/")`). 격리 사본 돌연변이 실측:

| 돌연변이 | 기대 | 실제 |
|---|---|---|
| SPECS에 가짜 `Launch::Node` 서버 추가 | red | **red** ✅ (테스트 2개가 동시에) |
| 매니페스트에 유령 패키지 추가 | red | **red** ✅ |
| `typescript` 패키지 **두 줄 전부** 삭제 | red | **red** ✅ |
| **`"../node_modules/typescript/lib"` 한 줄만 삭제** | red | **초록** ✖ |
| **`typescript-language-server/package.json` 한 줄만 삭제** | red | **초록** ✖ |

아래 두 칸이 하필 **이 라운드가 실제로 겪은 고장**이다. 앞엣것은 §2.3이
*"`Launch::Node`만 보고 번들을 만들면 서버는 뜨는데 tsserver를 못 찾아 색이 반만 나온다
— 진단이 제일 어려운 종류의 고장"*이라 부른 바로 그것이고, 뒤엣것은 §5가 한 절을 통째로
쓴 `ENOENT … package.json` 함정 그 자체다. **그 함정을 겪고 만든 계약이 그 함정을 안 문다.**
→ 보고서 §2.3의 *"그 1줄을 빠뜨리면 사용자가 아니라 테스트가 먼저 깨진다"*는 **패키지를
통째로 빠뜨렸을 때만** 참이다. 고칠 값: 대조를 파일 단위로 내리거나
(`Launch::Node.module` 상대경로 + `extra_modules`별 필수 파일 목록), 최소한 스펙이 실제로
여는 파일(`cli.mjs` · `tsserver.js` · `langserver.index.js` · 각 `package.json`)이 매니페스트
어느 항목의 하위에 들어오는지를 **경로로** 검사할 것.

**C4. cwd 가드 테스트가 옛 결함이 살던 층을 안 문다.**
`the_search_chain_is_exactly_exe_shaped_and_has_no_cwd`는 **순수 함수 `module_roots_from`만**
통째로 대조한다. 실측 돌연변이:

| 돌연변이 | 기대 | 실제 |
|---|---|---|
| `module_roots_from` 안에 cwd 사슬 부활 | red | **red** ✅ |
| **`module_roots()`(= `shipped_module`이 부르는 층)에 cwd 사슬 부활** | red | **초록** ✖ |

두 번째가 **옛 코드에서 결함이 실제로 살던 자리**다(`09b9bc7`의 `shipped_module()` 본문).
주석은 *"무엇이든 더해지면 이 테스트가 먼저 깨지고"*라고 적었지만, 한 층 위에 더하면 안 깨진다.
SMALL3 R1 확인 크리틱이 같은 워크트리에서 남긴 판정 *"못은 물지만 호출부까지는 못 문다"*와
**같은 모양의 결함이 반복**됐다. 고칠 값: `shipped_module`/`module_roots`를 직접 먹이는
테스트를 하나 더 두거나(`CCG_LSP_MODULES`를 비우고 cwd를 미끼 폴더로 바꿔 `None`을 요구),
사슬 대조를 `module_roots()` 층으로 올릴 것.

**C5. §6.5의 보조 논거가 그 파일 자체로 반증된다 — 그리고 그게 무너지면 G1의 안전도 근거를 잃는다.**
§6.5의 **본론은 참이고 중요하다**: `bench/ratios.mjs`의
`/^(node|conhost|python|pyright|clangd|Microsoft\.CodeAnalysis)/i`는 `electron.exe`에 **구조적으로
안 걸린다.** 확인: `multi-electron-2.6.2-default-r28jdecr1.json`의 `procDetail`은 **9개 전부
`electron.exe`**, 정규식 적중 **0**. 그리고 2.6.2가 ts·py 서버를 `process.execPath`(=electron.exe)로
띄운다는 것은 동결 구역 코드로 확인했다. 따라서 **「2.6.2 LSP 헬퍼 0」은 측정이 아니라 분류
산물**이라는 §6.5 = **참**(빌더 주장 ③ 인정).

**그러나 보조 논거는 틀렸다.** 보고서는 *"`summary.idleGridProcs`는 7인데 `procDetail`은
9개 … 7 → 9의 2개가 tsls+tsserver라면 정착 시점에는 LSP가 없었고 주행 끝에는 있었던 것"*이라
추론한다. **같은 파일이 그 2개의 정체를 이미 적어 두고 있다**:

```
idleGrid = { procs: 7 }   idleWithWindows = { procs: 9 }   windowCost = { procsAdded: 2 }
```

`procDetail`은 창을 연 뒤에 찍힌다(`bench/multi.mjs:225`). 즉 **7 → 9는 하네스가 일부러 연
창 2개**이고 LSP와 무관하다(대조: 3.0 팔은 `procsAdded: 0`이라 8 → 8로 안 벌어진다).

그러면 **2.6.2의 정착 시점 7개에 LSP가 들어 있는지 아닌지는 아무도 모른다.** 그런데 보고서는
*"G1은 양쪽에서 같은 규칙으로 빼므로 이 흠에 덜 민감하다"*로 정리한다. 그건 **규칙이 같을 뿐
효과가 같지 않다** — 그 규칙은 3.0에서 **125MB를 빼고** 2.6.2에서 **0을 뺀다**. 만약 2.6.2의
718.6MB에 LSP가 들어 있다면 G1은 **3.0에 유리하게** 기울어 있고, 거칠게만 잡아도
`(568.85−124.7) / (718.6−120) ≈ 0.74`로 **제안선 0.70을 넘길 수 있다.**
→ **G1은 이 흠에 가장 둔감한 수가 아니라 가장 오염되기 쉬운 수다.** §1.4-b가 G1을
*"패키징 전후로 정의가 안 바뀌는 유일한 수"*라 부른 서술과 §4.4의 *"G1은 안 흔들렸다 · 통과"*는
**분모의 LSP 상태가 확정되기 전까지 게이트 근거로 쓸 수 없다.** (이 라운드에 재측정을 요구하지는
않는다 — 경계 밖이 맞다. 요구하는 것은 서술의 정정과 「미확인」 딱지의 확대다.)

### 낮음

**L1. `cargo test --workspace 362개 통과`가 재현되지 않는다.**
같은 명령·같은 트리·격리 타깃에서 **787 통과 · 0 실패 · 14 무시**다. 하위 주장
(「`ccg-lsp` 66개」·「신설 7개」·「0 실패」)은 전부 정확하므로 **무후퇴 결론은 유효**하고
합계 숫자만 틀렸다. 인용하면 다음 라운드가 회귀를 못 알아본다.

**L2. §3 표의 「`bundle.resources` 4줄」 — 실제 항목은 5개다**
(tsls/lib · tsls/package.json · typescript/lib · typescript/package.json · pyright).
커밋 `ef03f73` 메시지에도 「네 줄」로 같은 오기가 있다. 하필 §5가 「`package.json`을 빼먹어서
죽었다」를 적은 라운드라 **항목 수를 잘못 세는 것이 무해하지 않다**.

**L3. 2.6.2 설치 폴더 파일 수 8,141 → 실측 8,139.** 오차 2, 결론 무영향.

**L4. §4.4의 「고치기 전 450.5 ↔ 603.7 = 153.2MB」는 짝이 안 맞는 두 수의 차다.**
`450.5`는 `…-r28jdecr1-dist.json`(exe sha `0a3e5384…` · 3회), `603.7`은
`docs/critic/r28j-critr2-multi-tauri-distcwdrepo.json`(exe sha **`feaddb64…`** · **1회** ·
8/26 다른 세션)이다. **띠의 존재는 참**이고(§1.1의 옛 코드 팔이 독립으로 증명한다) 출처도
표기돼 있지만, **153.2MB라는 크기**는 같은 exe·같은 세션의 짝에서 나온 값이 아니다.
같은 흠을 `docs/decisions-3.0.md` §1.6-E가 이미 경고해 뒀다(「`gitHead` 말고 `exeSha256`을 봐라」).

---

## 3. 보고서·커밋 경계

- **커밋 경계 깨끗하다.** 네 커밋이 건드린 파일은 `launch.rs` · `server.rs` · `spec.rs` ·
  `tauri.conf.json` · `ccg_lspprobe.rs` · `scripts/poc-lspdist-r1.mjs` · `bench/results/*` ·
  `docs/parity-fix-lspdist-r1.md`뿐이다. **옆 갈래(SMALL3 R1 = `09b9bc7`, 첨부 대화상자 i18n)
  파일은 한 개도 섞이지 않았다.** 같은 워크트리 병렬 커밋 규율(`--only`/경로 지정)이 지켜졌다.
- 보고서 ↔ 실측이 어긋나는 칸: **C1 · C5(보조 논거) · L1 · L2 · L3 · L4.** 나머지 수치는
  내 계기로 전부 재현됐고, 설치기 증가분은 **13바이트** 차로 맞는다.
- §6.6(설치기 미실행)은 정당한 유보다. 사용자 실앱이 깔려 있어 NSIS를 돌리면 그것을 건드린다 —
  나도 같은 이유로 안 돌렸다. `installer.nsi`가 makensis에 넘어가는 그 파일이라 적재물의
  진실성은 보장되고, `Delete` 5,435줄 + `RMDir /REBOOTOK` 짝도 정상 생성돼 있다.

---

## 4. 남은 가장 큰 격차 — **하나만 꼽으면 node 런타임이다**

> **3.0 배포본은 TS·Python 코드 인텔리전스의 생사를 「사용자 PATH에 node.exe가 있는가」에
> 걸고 있다. 2.6.2는 그 전제가 0이었다.**

- **크기**: 내 실측으로 죽는 팔은 **두 언어 × 두 cwd = 넷 전부**다. 부분 고장이 아니라 전면 고장이다.
- **인구가 실재한다**: C2대로 3.0의 엔진은 **네이티브 `claude.exe`**로 뜨므로 node 없는 기계에서
  앱의 나머지는 멀쩡하다 — 사용자가 보는 것은 「앱은 잘 되는데 코드에 색이 안 칠해진다」이고,
  그건 §1.6-A2가 「제품 결함」으로 올라오기까지 세 라운드를 먹은 증상과 **구별이 안 된다**.
  빌더 본인 기계의 경로(`…\.local\bin\claude.exe`)가 코드에 적혀 있다는 것이 그 구성의 실재 증거다.
- **닫는 비용이 이미 측정돼 있고 작다**: 내 사이드카 팔이 **`<설치 폴더>\node.exe` 한 파일로
  두 언어가 즉시 살아나는 것**을 실측했다. `node_exe()`의 ② 칸은 이미 동작한다. 남은 일은
  ⓐ 매니페스트 한 줄 ⓑ 판 고정 + 체크섬 검증 스테이징 단계다(설치기 +21.8MB → 약 30.4MB로,
  2.6.2 대비 19% — 여전히 압도적 감소).
- **그래서 이건 「다음 라운드에 넘기는 결정」이 아니라 「출시 전 필수 작업」으로 격상돼야 한다.**
  §6.1이 제시한 두 갈래 중 (ⅱ) 온디맨드 설치는 **§2.2가 후보 (b)를 기각한 논리**
  (*"오프라인에서 못 쓴다 · 첫 사용에 네트워크를 끼우는 것은 파리티 후퇴"*)에 그대로 걸리므로,
  일관성을 지키면 답은 (ⅰ) 번들 하나다.

**차점**: C3 + C4 — 이 라운드가 세운 두 그물이 **자기가 방금 빠진 구멍의 모양을 안 뜬다.**
매니페스트 계약은 패키지 단위라 `tsserver.js`/`package.json` 누락을 못 잡고, cwd 가드는 순수
함수만 물어 옛 결함이 살던 층을 못 잡는다. 지금은 둘 다 사람이 「패키지를 통째로 빼먹는」
경우만 막는다.

---

## 5. 재현

```bash
# ① 오염 없는 트리 (node_modules는 정션 · npm ci 금지)
git archive bcd0734 | tar -x -C %TEMP%\ccg-critic-lspdist\tree
mklink /J %TEMP%\ccg-critic-lspdist\tree\node_modules C:\Code\AgentCodeGUI\node_modules

# ② 빌드 (공용 target/ 무접촉)
CARGO_TARGET_DIR=C:\Temp\ccg-critic-lspdist-target npm run tauri:build:unsigned
CARGO_TARGET_DIR=C:\Temp\ccg-critic-lspdist-target \
  cargo build --release -p ccg-lsp --features cli --bin ccg-lspprobe
# 옛 코드 팔: git archive adcef10^ -> 별도 트리 -> 같은 프로브를 별도 타깃에 굽는다

# ③ 기능·결정론·PATH 없는 node·사이드카·레버·개발 실행 (판정 21)
node docs/critic/tools/critic-lspdist-r1.mjs \
  --probe=C:\Temp\ccg-critic-lspdist-target\release\ccg-lspprobe.exe \
  --before=C:\Temp\ccg-critic-lspdist-before-target\release\ccg-lspprobe.exe \
  --nsi=C:\Temp\ccg-critic-lspdist-target\release\nsis\x64\installer.nsi \
  --tree=%TEMP%\ccg-critic-lspdist\tree \
  --out=docs/critic/lspdist-critic-r1-probe.json

# ④ 메모리 두 팔 (기준 파일 무접촉 — --out 필수 · 포트 11030~11049 대역)
node bench/multi.mjs tauri --repeats=2 --tag=critlspdistI --port=11030 \
  --exe=%LOCALAPPDATA%\ccg-critic-lspdist-app\AgentCodeGUI3.exe \
  --cwd=%LOCALAPPDATA%\ccg-critic-lspdist-app \
  --out=../../docs/critic/lspdist-critic-r1-mem-instcwd.json
node bench/multi.mjs tauri --repeats=2 --tag=critlspdistP --port=11031 \
  --exe=%LOCALAPPDATA%\ccg-critic-lspdist-app\AgentCodeGUI3.exe \
  --cwd=C:\Code\AgentCodeGUI \
  --out=../../docs/critic/lspdist-critic-r1-mem-projcwd.json

# ⑤ 풋프린트 델타 — 같은 exe로 리소스만 빼고 번들 단계만 재실행
#    (격리 사본의 tauri.conf.json에서 bundle.resources 삭제 후)
CARGO_TARGET_DIR=C:\Temp\ccg-critic-lspdist-target node scripts/tauri-build.mjs bundle --unsigned

# ⑥ 돌연변이 7종 — 전부 격리 사본에서, 매회 원상복구
CARGO_TARGET_DIR=C:\Temp\ccg-critic-lspdist-target cargo test -p ccg-lsp --lib spec::tests
CARGO_TARGET_DIR=C:\Temp\ccg-critic-lspdist-target cargo test -p ccg-lsp --lib launch::tests
```

증거: `docs/critic/lspdist-critic-r1-evidence.json`(수치·돌연변이 표 전부) ·
`-probe.json`(팔 원자료) · `-mem-instcwd.json` · `-mem-projcwd.json`.
