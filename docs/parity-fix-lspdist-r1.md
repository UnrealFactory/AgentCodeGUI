# LSPDIST R1 — 배포본에서 TS·Python LSP가 cwd와 무관하게 항상 뜨게 한다

> 대상: `crates/ccg-lsp/src/launch.rs` · `crates/ccg-lsp/src/spec.rs` · `src-tauri/tauri.conf.json`
> 여는 미결: `docs/decisions-3.0.md` §1.6-A2(제품 결함) · §1.6-F(공시할 팔) · §1.4-b(0.627/0.839 띠)
> PoC: `scripts/poc-lspdist-r1.mjs` → `bench/results/poc-lspdist-r1.json`
> 커밋: `adcef10`(cwd 사슬 삭제) · `ef03f73`(번들 적재 + 매니페스트 계약) ·
> `e36ea7d`(PoC·프로브 provenance) · 이 커밋(보고서 + 벤치 결과 2개)

---

## 0. 한 줄

**모듈은 설치기에 실었고(+5.87MB), 프로세스 cwd는 해석 사슬에서 잘라냈다.** 이제 배포본의
TS·Python LSP는 어디서 켜든 뜨고, 같은 파일을 문다 — §1.4-b의 `0.627 ↔ 0.839` 띠는
「어느 팔을 공시할까」가 아니라 **그 띠가 사라져서** 닫힌다. 대신 배포 경로의 유휴 WS는
LSP가 있는 쪽으로 **올라간다** — 두 팔 실측 **577.3 / 567.5MB**(비 0.803 / 0.790 · 전에는
450.5 ↔ 603.7로 153MB가 벌어졌다). 숨기지 않고 §4.4에 그대로 적었고, 그 비율의 분모에
대해 이번에 새로 찾은 흠은 §6.5에 적었다.

> **★R2 정정(확인 크리틱 R1 C1)** — 위 「어디서 켜든 뜨고」는 **「PATH에 node가 있는
> 기계에서」**라는 단서를 지고 있어야 했다. 크리틱 실측: PATH에서 node를 걷어내면
> **두 언어 × 두 cwd 네 팔 전부 `error`**다. R1이 닫은 것은 「cwd가 결과를 가른다」이고,
> 「node가 없으면 안 뜬다」는 §6.1에 자백만 해 둔 채 열려 있었다.
> **그 나머지를 LSPDIST R2가 닫았다**(고정 판 `node.exe`를 설치기에 싣는다) —
> `docs/parity-fix-lspdist-r2.md`.

---

## 1. 결함 — 무엇이 갈렸나

`shipped_module()`은 `node_modules`를 세 곳에서 찾았다(`launch.rs`, 고치기 전):

```
① CCG_LSP_MODULES
② exe 폴더 / exe 폴더의 resources / 그 조상들
③ 프로세스 cwd의 조상들            ← 이 칸
```

설치 폴더(`%LOCALAPPDATA%\AgentCodeGUI3`)와 그 조상에는 `node_modules`가 없다.
**실측으로 재확인**: 그 폴더는 `AgentCodeGUI3.exe`와 `uninstall.exe` **두 파일 · 6MB**다.
그래서 ②는 언제나 빈손이고, **③만이** LSP의 생사를 정했다:

| 켜는 방법 | 프로세스 cwd | ③이 무는 것 | TS·Python |
|---|---|---|---|
| 시작 메뉴 / 바탕화면 | 설치 폴더 | 없음 | **안 뜬다** |
| 앱이 등록한 폴더 우클릭(`nsis/hooks.nsh`) | 그 프로젝트 | 그 프로젝트의 `node_modules` | **뜬다** |

같은 exe·같은 설치 자리인데 **켜는 방법이 코드 인텔리전스를 껐다 켰다** 했다. §1.4-b가
유휴 WS `0.627`(헬퍼 0)과 `0.839`(헬퍼 3)로 잰 그 두 상태다.

### 1.1 ③이 물던 것은 애초에 우리 것이 아니었다

이 칸은 「없는 것보다 낫다」도 아니다. cwd는 대개 **사용자가 연 프로젝트**이고, 거기서
찾은 `node_modules/typescript`는 **그 프로젝트의 TS 판**이다. 그런데 같은 크레이트가
바로 옆에서 반대를 약속하고 있었다 — `spec.rs::ts_init_options`:

> *"번들된 tsserver를 못박는다 — 해석이 열린 프로젝트에 의존하지 않게(2.6.2와 같은 값)."*

③은 그 불변식을 `shipped_module()` 층에서 깨고 있었다. 2.6.2는 이 문제가 없었다:
Electron이 곧 Node였고 모듈은 `app.getAppPath()/node_modules`, 즉 **앱의 것**이었다.

### 1.2 그리고 실패가 조용했다

`plan()`의 실패 문자열은 `번들 모듈을 못 찾음: node_modules/…`까지만 말하고 **어느 자리를
봤는지**는 말하지 않았다. §1.6-A2가 「제품 결함」으로 올라오기까지 세 라운드가 걸린 이유의
절반이 이 침묵이다(나머지 절반은 벤치 exe가 레포 안이라 아무도 못 밟았다는 것).

---

## 2. 처방 — 무엇을 골랐고 무엇을 안 골랐나

### 2.1 사슬: cwd 칸을 **폴백으로 강등하지 않고 삭제**

| 갈래 | 결과 |
|---|---|
| 유지 | 결함 그대로 |
| **최후 폴백으로 강등** | 번들이 실린 배포본에서는 안 닿지만, **번들 없는 빌드**(cargo 단독·포터블 실수·리소스 누락)에서는 두 팔이 **여전히 갈린다**. 띠가 「보통은 안 보이는」 상태로 남는다 |
| **삭제** ← 골랐다 | 해석 결과가 **exe 경로의 함수**가 된다. 번들이 없으면 두 팔이 **똑같이 실패**한다 — 그게 결정론이다 |

강등이 아니라 삭제인 결정적 이유: **띠를 없애는 유일한 조치**다. 그리고 §1.1대로 그 칸이
물던 값 자체가 틀렸으므로, 「없는 것보다 낫다」는 방어도 성립하지 않는다.

남는 비결정 요소는 **exe 조상 사슬** 하나인데, 이건 「어디에 설치했는가」의 함수라 한
설치본 안에서 절대 안 흔들리고, 배포본에서는 첫 칸(exe 폴더 = 번들 자리)이 항상 먼저
맞는다. 개발·벤치 실행(`<레포>/target*/release/` → `<레포>/node_modules`)을 살리는 값이
그 사슬이라 남긴다. **cwd를 지워도 개발이 안 깨지는 근거가 정확히 이것**이다 — 개발에서
모듈을 물던 힘은 cwd가 아니라 exe 위치였다(테스트
`a_dev_build_still_reaches_the_repo_node_modules_through_ancestors`).

### 2.2 배포: (a) tauri `bundle.resources`에 **모듈만** 싣는다

과제가 준 후보 중 **(a)를 택하되 런타임은 빼고 모듈만** 실었다.

| 후보 | 설치기 | 설치 폴더 | 판정 |
|---|---:|---:|---|
| **(a′) 모듈만 번들** ← 골랐다 | **+5.87MB** | +58.8MB | 결함의 원인 100%를 덮는다. 오프라인·무전제 |
| (a) 모듈 + node.exe 번들 | +5.87 **+21.81** MB | +58.8 **+87.2** MB | 「항상」이 문자 그대로 참이 된다. **하지만 §6.1** |
| (b) 앱 홈에 온디맨드 설치 | +0 | 0(설치 전) | 2.6.2는 전제 0으로 **바로** 됐다. 첫 사용에 내려받기(압축 약 6MB · 푼 뒤 44MB)를 끼우는 것은 파리티 후퇴이고, 오프라인에서 못 쓴다. 설치기 5.87MB를 아끼려고 「첫 호버가 네트워크를 탄다」를 사는 거래는 안 맞는다 |
| (c) 그대로 두고 문서화 | — | — | 「cwd로 켜졌다 꺼졌다」를 사용자에게 설명해야 한다. 안 된다 |

`node.exe`를 **이번에 안 실은 이유는 크기가 아니라 재현성**이다 — §6.1에 따로 적었다.

### 2.3 확장점: 매니페스트를 **SPECS에서 파생**시키고 테스트로 묶는다

번들 목록을 `tauri.conf.json`에만 두면 그것이 **두 번째 진실**이 되고, 언어를 붙일 때
한쪽만 고쳐지면 §1.6-A2가 그대로 재발한다(코드는 `Bundled`인데 파일이 없는 상태).

- `ServerSpec::extra_modules` — 실행 스크립트 말고 **또** 실려야 하는 최상위 패키지.
  TS가 유일한 사용자다: 실행은 `typescript-language-server`가, tsserver는 `typescript`가
  낸다. `Launch::Node`만 보고 번들을 만들면 서버는 **뜨는데** tsserver를 못 찾는다.
- `spec::bundled_packages()` — `SPECS`에서 파생(수기 목록 없음).
- `spec::tests::every_bundled_node_package_is_in_the_installer_manifest` — 파생 목록과
  `tauri.conf.json`을 **양방향** 대조한다. 빠진 것 = 안 뜨는 서버, 남은 것 = 유령 적재.

`install.rs::every_download_spec_has_a_source`가 `Provision::Download`에 걸어 둔 규율과
같은 모양이다. **새 언어 추가 비용은 그대로 「SPECS 1항목」이고, Node 서버면 매니페스트
1줄이 붙는다 — 그 1줄을 빠뜨리면 사용자가 아니라 테스트가 먼저 깨진다.**

> **★R2 정정(확인 크리틱 R1 C3)** — 이 문장은 **패키지를 통째로 빠뜨렸을 때만** 참이었다.
> 계약이 `d.starts_with("node_modules/<pkg>/")`라 **패키지 단위**였고, 크리틱이 격리 사본에서
> 실측한 대로 `"…/typescript/lib"` 한 줄만 지우거나 `"…/typescript-language-server/package.json"`
> 한 줄만 지우면 **초록**이었다. 하필 그 둘이 이 라운드가 실제로 밟은 고장이다(뒤엣것은 §5가
> 한 절을 통째로 쓴 ENOENT 함정 그 자체다). **R2가 계약을 파일 단위로 내렸다** —
> `spec::bundled_files()` + `every_bundled_file_is_covered_by_the_installer_manifest`,
> 그리고 「진입 스크립트의 `package.json`」은 모든 `Launch::Node` 스펙에 자동으로 걸린다.

---

## 3. 무엇이 바뀌었나(코드)

| 파일 | 변화 |
|---|---|
| `crates/ccg-lsp/src/launch.rs` | cwd 사슬 삭제 · 사슬을 순수 함수 `module_roots_from()`으로 분리 · `module_search_hint()` 신설 · 테스트 5 |
| `crates/ccg-lsp/src/server.rs` | 실패 문자열에 **찾아본 자리**를 싣는다(1줄) |
| `crates/ccg-lsp/src/spec.rs` | `ServerSpec::extra_modules` 필드 · `bundled_packages()` · 테스트 2 |
| `src-tauri/tauri.conf.json` | `bundle.resources` ~~4줄~~ **5개 항목**(★R2 정정 · 크리틱 L2 — tsls/lib · tsls/package.json · typescript/lib · typescript/package.json · pyright. 하필 §5가 「`package.json`을 빼먹어서 죽었다」를 적은 라운드라 항목 수 오기가 무해하지 않다. 커밋 `ef03f73` 메시지에도 같은 오기가 있다) |
| `crates/ccg-lsp/src/bin/ccg_lspprobe.rs` | `resolve` 블록 — **어느 파일을 물었나**를 출력에 싣는다 |

엔진 파일(`manager.rs`·`rpc.rs`)은 **0줄**이다. `server.rs`의 1줄은 진단 문자열이고
언어 이름이 없다.

---

## 4. 실측

### 4.1 풋프린트 — 같은 exe로 리소스만 넣고 빼서 두 번 구웠다

`CARGO_TARGET_DIR=target-lspdist npm run tauri:build`(서명 키 있음 · `.sig` 436B 정상 산출)
로 한 번 굽고, `tauri.conf.json`의 `resources`만 지운 채 **번들 단계만** 다시 돌렸다
(= 바이너리는 같은 것). 그래서 아래 차이는 **오롯이 적재물의 값**이다.

| | 설치기(NSIS·lzma) | 설치 폴더 | 파일 수 |
|---|---:|---:|---:|
| 3.0 오늘(리소스 없음) | 2,811,634 B (2.68MB) | 6MB | 2 |
| **3.0 이 라운드** | **8,971,808 B (8.56MB)** | **약 65MB** | **5,428** |
| 차이 | **+6,160,174 B (+5.87MB)** | +58.8MB | +5,426 |
| 2.6.2(분모) | 165,119,775 B (157.47MB) | 650MB | ~~8,141~~ **8,139**(★R2 정정 · 크리틱 L3 — 오차 2, 결론 무영향) |
| **2.6.2 대비** | **5.4%** | **10.0%** | 67% |

- 설치 폴더의 `+58.8MB`는 **4KiB 클러스터까지 센 값**이다(원바이트 43.53MB). pyright의
  typeshed 스텁이 5,289개 잔파일이라 슬랙이 15MB 붙는다 — 사용자가 실제로 잃는 디스크는
  원바이트가 아니라 이쪽이다.
- 「2.6.2 대비 대폭 감소」는 번들을 실은 뒤에도 **유지된다**: 설치기 157.5MB → 8.56MB,
  설치 폴더 650MB → 65MB. 자동 업데이트가 매번 받아 가는 양도 2.7MB → 8.6MB다.
- lzma 압축률 실측(파이썬 `lzma` preset 6, 참고값): tsls/lib 2.20→0.37 · typescript/lib+pkg
  23.17→2.70 · pyright 18.16→2.68 = **43.53 → 5.75MB**. 설치기 실측 증가분 5.87MB와의
  차 0.12MB가 5,426개 파일에 붙는 NSIS 항목 오버헤드다.

### 4.2 기능 — 배포 모사에서 실제로 답하는가

`scripts/poc-lspdist-r1.mjs`. 배포 모사 자리는 `%LOCALAPPDATA%\ccg-lspdist-r1\…`이고
**조상 사슬 어디에도 `node_modules`가 없음을 먼저 확인**한다. 적재물은 생성된
`installer.nsi`의 `File /a "/oname=node_modules\…"` 줄을 그대로 복제해 만든다 —
`tauri.conf.json`을 우리가 다시 해석하면 번들러의 해석과 어긋날 수 있고, 그러면 PoC는
통과하는데 설치기는 다른 것을 나르는 최악의 조합이 된다.

| 팔 | 번들 | 프로세스 cwd | status | hover | 시맨틱 토큰 |
|---|---|---|---|---:|---:|
| `bundled/install-cwd` · ts | 있다 | 설치 폴더 | **ready** | **8/8** | **1,565** |
| `bundled/project-cwd` · ts | 있다 | 레포 안 프로젝트 | **ready** | **8/8** | **1,565** |
| `bundled/install-cwd` · py | 있다 | 설치 폴더 | **ready** | **8/8** | — (pyright 미지원) |
| `bundled/project-cwd` · py | 있다 | 레포 안 프로젝트 | **ready** | **8/8** | — |
| `bare/install-cwd` · ts·py | 없다 | 설치 폴더 | error | — | — |
| `bare/project-cwd` · ts·py | 없다 | **레포 안 프로젝트** | **error** | — | — |

- 두 `bundled` 팔은 status뿐 아니라 **문 파일까지 같다**(`resolve.modules` 바이트 동일).
  「둘 다 성공」만으로는 같은 판을 물었다는 증명이 안 되기 때문에 프로브가 경로를 찍는다.
  실제 값: `…\ccg-lspdist-r1\bundled\node_modules\typescript-language-server\lib\cli.mjs` ·
  `…\node_modules\pyright\langserver.index.js` · tsserver도 같은 번들 안.
- 마지막 줄이 이 라운드의 피감수다. **cwd 조상에 레포의 `node_modules`가 있는데도**
  안 뜬다 = ③이 죽었다.

### 4.3 before/after — 주장이 아니라 옛 코드로 되짚었다

「고치기 전에는 떴다」를 문장으로 두지 않고, `git archive HEAD`로 푼 **고치기 전 트리**에서
프로브를 따로 구워 같은 픽스처·같은 자리에서 돌렸다.

| 코드 | 번들 | cwd = 설치 폴더 | cwd = 프로젝트 |
|---|---|---|---|
| **옛(HEAD)** | 없다 | error | **ready · 토큰 1,565** ← 띠 |
| **새(이 라운드)** | 없다 | error | **error** ← 띠 소멸 |
| 새 | 있다 | **ready** | **ready** |

첫 줄이 §1.4-b의 `0.627 / 0.839` 두 팔 그 자체다. 둘째 줄이 cwd 사슬의 사망 진단서고,
셋째 줄이 §1.6-A2의 해소다.

> **★R2 정정(확인 크리틱 R1 C1)** — 「해소」가 아니라 **「좁혀짐」**이었다. §1.6-A2의 문장은
> 「배포본이 LSP 없음/있음 **두 상태**를 갖는다」인데, R1이 없앤 것은 **두 상태**이지
> 「없음」이 아니다. PATH에 node가 없는 기계에서 그 하나는 여전히 **「없음」**이다
> (크리틱 실측: 두 언어 × 두 cwd 네 팔 전부 error). 이 표는 **「PATH에 node가 있는 기계에서」**
> 읽어야 한다. 나머지 절반은 R2가 닫았다 — `docs/parity-fix-lspdist-r2.md` §4.2.

### 4.4 메모리 — 숨기지 않는다. 배포 경로는 **올라간다**

헬퍼가 이제 배포본에서도 항상 뜨므로 배포 경로의 유휴 WS는 §1.4-b가 예고한 대로 **LSP가
있는 쪽**으로 간다. 이 라운드의 exe(`sha256 a8eb9eda9062a371…`)를 `%LOCALAPPDATA%` 아래
배포 모사(`exe 1개 + node_modules 번들` · 61MB)에 두고 **cwd만 두 개로** 갈라 3회씩 쟀다.

| 팔 | 프로세스 cwd | 프로세스 | LSP 헬퍼 | 헬퍼 WS | 유휴 WS | 유휴 Priv |
|---|---|---:|---:|---:|---:|---:|
| **A** | 설치 폴더(시작 메뉴) | **8** | **3** | 126.5 | **577.3** | **363.7** |
| **B** | 프로젝트(폴더 우클릭) | **8** | **3** | 126.7 | **567.5** | **353.3** |
| 차 | — | 0 | 0 | 0.2 | **9.8 (1.7%)** | 10.4 (2.9%) |

**띠가 사라졌다** — 이게 이 절의 요점이다:

| | cwd=설치 폴더 | cwd=프로젝트 | 벌어짐 |
|---|---:|---:|---:|
| 고치기 전(§1.4-b · 크리틱 R2) | 450.5 · 5프로세스 · 헬퍼 0 | 603.7 · 8프로세스 · 헬퍼 3 | ~~**153.2MB**~~ (★R2 정정 · 아래) |
| **이 라운드** | 577.3 · 8프로세스 · 헬퍼 3 | 567.5 · 8프로세스 · 헬퍼 3 | **9.8MB** |

> **★R2 정정(확인 크리틱 R1 L4)** — `153.2MB`는 **짝이 안 맞는 두 수의 차**다.
> `450.5`는 `…-r28jdecr1-dist.json`(exe sha `0a3e5384…` · 3회)이고 `603.7`은
> `docs/critic/r28j-critr2-multi-tauri-distcwdrepo.json`(exe sha **`feaddb64…`** · **1회** ·
> 8/26 **다른 세션**)이다. **띠의 존재는 참**이고 §4.3의 옛 코드 팔이 독립으로 증명하지만,
> **크기 153.2MB는 같은 exe·같은 세션의 짝에서 나온 값이 아니다**(§1.6-E가 이미 경고해 둔
> 흠이다 — 「`gitHead` 말고 `exeSha256`을 봐라」).
> **같은 exe·같은 세션의 짝으로 말할 수 있는 크기는 하나뿐이다**: 팔 A의 헬퍼 합
> **126.5MB**(577.3 − 450.8). 띠는 「헬퍼가 뜨느냐 마느냐」였으므로 그 값이 곧 띠의 크기다.
> 앞으로는 이 수를 인용하라.

남은 9.8MB는 **모양이 아니라 잡음**이다. 두 팔의 프로세스 수·헬퍼 수·헬퍼 크기가
사실상 같고(126.5 vs 126.7MB), 방향도 뒤집혔다(전에는 프로젝트 팔이 컸는데 지금은 설치
팔이 크다). 「어느 팔을 공시할까」(§1.6-F ①)라는 질문 자체가 없어진다.

**교차 검증 하나**: 팔 A에서 헬퍼를 빼면 `577.3 − 126.5 = 450.8`인데, 고치기 전 헬퍼 0
주행의 실측이 **450.5**다(0.07% 차). 두 계기가 서로를 검증한다 — 늘어난 126.8MB는
정확히 「LSP가 켜진 값」이고 앱 몫은 안 움직였다.

비율(분모 = 2.6.2 `718.6 / 508.9` · **§6.5의 단서를 반드시 같이 읽어라**):

| 잣대 | 팔 A | 팔 B | 제안선 | 판정 |
|---|---:|---:|---:|---|
| 유휴 WS(있는 그대로) | **0.803** | **0.790** | — | §1.6-F의 새 공시 후보. **하나의 수**가 됐다 |
| 유휴 Private(있는 그대로) | 0.715 | 0.694 | — | 〃 |
| **G1 — LSP 제외**(근사) | **0.627** | 0.613 | ≤0.70 | **통과** |

- **G1은 안 흔들렸다.** §1.4-b가 「패키징 전후로 정의가 안 바뀌는 유일한 수」라고 부른
  그대로다 — 0.643(벤치 산술) · 0.627(배포 실측, 고치기 전) · 0.627(오늘) 이 같은 자리다.
- **G2는 정의째 죽는다.** G2는 「배포 위치 · LSP 헬퍼 0인 팔」의 수였는데, 배포본에서
  헬퍼 0인 상태가 **더 이상 존재하지 않는다.** 대신 위 0.79~0.80 한 쌍이 그 자리를 잇는다.
  (그 수를 게이트로 삼을지는 §6.5가 정리된 뒤의 일이다.)
- FPS는 두 팔 모두 60.0 / p95 16.8 / 드랍 0% / 3주행 전부 무드랍.

결과 파일(신규 · **기준 파일은 하나도 안 덮었다**):
`bench/results/multi-tauri-3.0.0-default-lspdist-instcwd.json` ·
`bench/results/multi-tauri-3.0.0-default-lspdist-projcwd.json`

### 4.5 무후퇴

- `CARGO_TARGET_DIR=target-lspdist cargo test --workspace` — ~~**362개 통과**~~ · 0 실패
  (`ccg-lsp` 66개에 이번 신설 7개 포함).

  > **★R2 정정(확인 크리틱 R1 L1)** — **362는 틀렸다.** 크리틱이 같은 명령·같은 트리에서
  > **787 통과 · 0 실패 · 14 무시**를 쟀고, R2가 오늘 다시 재니 **795 통과 · 0 실패 ·
  > 14 무시**(테스트 바이너리 35개 · 그 사이 옆 갈래 SMALL3의 신설분이 더해졌다)다.
  > **틀린 이유**: `cargo test --workspace` 출력을 `| tail -30`으로 잘라 보고 **화면에 남은
  > `test result:` 줄 15개만 합산**했다. 바이너리가 35개라 스무 줄이 잘려 나갔다.
  > 하위 주장(「`ccg-lsp` 66개」·「신설 7개」·「0 실패」)은 전부 정확하므로 **무후퇴 결론은
  > 유효**하고 합계만 틀렸다. **교훈**: 합계를 눈으로 세지 마라 — R2는 파서로 센다(§7 재현).
- 렌더러는 **안 건드렸다** → `npm run typecheck:app`은 이 라운드의 대상이 아니다.

---

## 5. 이 라운드가 밟은 함정 하나 (다음 사람을 위해)

번들을 실었는데 **TS만 안 떴다.** 모듈 경로는 셋 다 배포 자리로 잘 해석됐는데
(`resolve.modules`가 그걸 보여 줬다) 프로세스가 즉사했다. 손으로 돌려 보니:

```
Error: ENOENT: no such file or directory, open
  '…\node_modules\typescript-language-server\package.json'
  at file:///…/typescript-language-server/lib/cli.mjs:24956:39
```

`cli.mjs`는 rollup으로 자기 의존성을 다 말아 넣은 단일 파일이지만, **기동 즉시 자기
`package.json`을 읽는다**(버전 문자열). `files: ["lib"]`만 보고 `lib`만 실은 초판이
정확히 여기서 죽었다. 교훈 둘:

1. **패키지의 `files` 필드는 「실행에 필요한 것」의 목록이 아니다.** 최상위 폴더를 통째로
   싣거나(pyright처럼) 못 실을 이유가 있으면 `package.json`을 같이 실어라.
2. **PoC가 「모듈을 찾았다」에서 멈췄으면 못 잡았다.** 실제 호버·토큰 응답까지 재는
   판정이 있어서 그 자리에서 걸렸다.

---

## 6. 남은 것 — 정직하게

### 6.1 ★ Node 런타임은 여전히 PATH에 기댄다 (파리티 후퇴가 맞다)

모듈은 실었지만 **`node.exe`는 안 실었다.** `node_exe()`의 사슬은
`CCG_LSP_NODE` → exe 옆 사이드카 → **PATH**인데, 사이드카를 채우는 사람이 아직 없다.

**실측**(PoC `[6]` 팔 — PATH에서 `node.exe`가 있는 디렉터리를 전부 걷어내고 같은 배포
모사에서 실행): `status=error` · `resolve.node=null` · **모듈은 찾는다**. 즉 진단은
정확하지만 서버는 못 뜬다.

2.6.2는 Electron이 곧 Node라 전제가 **0**이었으므로 이건 파리티 후퇴다. 완화 근거는
있지만 결정적이지는 않다 — 3.0의 엔진 설치 경로(`ccg_engine::versions::install`)가
`npm install`이라 **앱을 쓰려면 어차피 npm이 필요**하다. 다만 Claude Code에는 npm을 안
타는 네이티브 설치본도 있으므로 「node 없는 사용자」는 실재한다.

> **★R2 정정(확인 크리틱 R1 C2)** — 위 완화 논거는 **실행 경로에서 거짓이다.**
> 3.0의 엔진은 **네이티브 `claude.exe`로 뜬다**: `src-tauri/src/engine/versions.rs:118-131`의
> `claude_bin()`은 ① `CCG_CLAUDE_BIN` → ② `engines/<v>/…/claude.exe` → ③ **PATH의
> `claude.exe`** 순이고 **셋 다 node를 안 지난다**(`ccg-engine/src/driver.rs:347`이 그
> 실물 exe를 그대로 스폰한다). codex도 같다 — `codex/versions.rs:70-77`은 `codex.cmd`
> shim을 **일부러 피하고** 플랫폼 패키지의 `codex.exe`를 직접 쓴다. npm은 **설치·목록에만**
> 필요하고, 이미 깔아 둔 사용자는 그 경로를 안 탄다.
> 결정적 증거: 같은 파일 `:156`이 `…\.localin\claude.exe`(**Claude Code 네이티브
> 설치기**의 경로)를 적어 두고 있다.
> → **「엔진은 되는데 LSP만 죽는」 구성이 성립하고 코드가 그것을 1급으로 지원한다.**
> 그 기계에서 사용자가 보는 것은 「앱은 잘 되는데 코드에 색이 안 칠해진다」이고, 그건
> §1.6-A2가 「제품 결함」으로 올라오기까지 세 라운드를 먹은 증상과 **구별이 안 된다.**
> 정확한 후퇴 문장은 *"2.6.2는 전제가 0"*이 아니라 **"2.6.2에서 npm 없이 되던 것 중 LSP가
> 3.0에서 안 된다"**이다(2.6.2도 *채팅*에는 npm을 요구했다).
> **이 후퇴는 R2가 닫았다** — 이제 런타임이 설치기에 실린다.

**닫는 값은 쟀다**: 고정 판 `node.exe`(v24.13.1 · 87.17MB) → 설치기 **+21.81MB**(lzma
실측) · 설치 폴더 **+87.2MB**. 그러면 설치기는 8.56 → 약 30.4MB(2.6.2 대비 19%)다.

**이번에 안 실은 이유는 크기가 아니라 재현성이다.** 지금 손에 있는 방법은 「빌더 PC의
`C:\Program Files\nodejs\node.exe`를 복사」뿐인데, 그러면 설치기가 **빌드한 사람의 node
판에 따라 달라진다**. 제대로 하려면 (ⅰ) 판을 고정하고 (ⅱ) nodejs.org에서 받아
(ⅲ) 체크섬을 검증해 (ⅳ) 스테이징하는 빌드 단계가 필요한데, 그건
`package.json`/`scripts/`/`.gitignore`를 건드리는 **패키징 라운드의 일**이고 이 라운드의
경계 밖이다. 게다가 이 레포는 「오프라인 빌드」를 지켜 왔다(`ccg_engine::versions` 머리말).

> **다음 라운드에 넘기는 결정**: node.exe를 (ⅰ) 고정 판으로 설치기에 싣는다(+21.8MB /
> +87.2MB · 전제 0) vs (ⅱ) 앱 홈에 온디맨드로 설치한다(`install.rs` 재사용 · 설치기 0 ·
> 첫 사용에 네트워크). 수치는 위에 다 있다.

### 6.2 유령 바이트 — 안 쓰는 파일도 같이 실린다

최상위 폴더를 통째로 싣는 쪽을 골랐다(업그레이드 안전). 그래서 안 쓰는 것도 간다:

| 무엇 | 원바이트 | 왜 남겼나 |
|---|---:|---|
| `typescript/lib/_tsc.js` | 5.95MB | `tsc` 전용. 파일 단위로 빼면 TS 판올림마다 목록이 깨진다 |
| `typescript/lib/{cs,de,…}` 13개 로케일 | 약 5MB | 〃 |
| `pyright/dist/*.js.map` | 2.67MB | 〃 |
| `typescript-language-server/lib/cli.mjs.map` | 1.42MB | 〃 |

합계 약 15MB(원바이트 43.53MB의 34%). lzma 뒤로는 훨씬 작지만(설치기 기준 대략 1MB대),
**설치 폴더에서는 그대로 15MB**다. 줄이려면 §5의 교훈대로 「파일 목록을 손으로 관리하는
비용」을 받아야 한다 — 지금은 안 받았다.

### 6.3 `env_path`의 `exists()` 요구는 그대로

`CCG_LSP_MODULES`에 없는 경로를 주면 조용히 다음 후보로 떨어진다(§1.6-A의 각주).
「환경변수로 LSP를 끈다」는 레버는 여전히 없다. 이번 라운드의 주제가 아니라 안 건드렸다.

### 6.4 `%LOCALAPPDATA%` 조상에 `node_modules`를 둔 사용자

이론적으로 exe 조상 사슬이 남의 `node_modules`를 물 수 있다. 실제로는 번들이 사슬 **첫
칸**이라 배포본에서는 절대 안 닿는다(테스트
`the_bundle_next_to_the_exe_wins_over_any_ancestor`가 그 순서를 고정한다).

### 6.5 ★ 새로 찾았다 — 2.6.2 분모의 LSP 상태를 아무도 안 재고 있었다

§4.4의 비율을 쓰려다 발견했다. `bench/ratios.mjs`의 헬퍼 분류기는

```js
const HELPER = /^(node|conhost|python|pyright|clangd|Microsoft\.CodeAnalysis)/i
```

인데, **2.6.2는 언어 서버를 `electron.exe`로 띄운다**(`ELECTRON_RUN_AS_NODE=1` — 이
크레이트 머리말이 첫 줄에 적어 둔 바로 그 사실이다). 즉 2.6.2의 LSP 헬퍼는 이 정규식에
**구조적으로 안 걸린다.** §1.4-b 표의 「2.6.2 · LSP 헬퍼 0」은 측정이 아니라 **분류 산물**이다.

실제 파일을 보면 그 자리가 더 흐리다 — `multi-electron-2.6.2-default-r28jdecr1.json`의
`summary.idleGridProcs`는 **7**인데 주행 끝의 `procDetail`은 **9개(전부 `electron.exe`)**다.
7 → 9의 2개가 tsls+tsserver라면 **정착 시점(=피감수)에는 LSP가 없었고 주행 끝에는 있었던**
것이고, 그렇다면 오늘의 3.0 두 팔(정착 시점에 이미 헬퍼 3)과는 **다른 상태끼리** 나눈
비율이 된다. 방향은 3.0에 불리하다(3.0만 헬퍼를 지고 잰다).

**이번 라운드는 이 분모를 다시 재지 않았다**(2.6.2 팔 재측정은 이 과제의 경계 밖이고,
같은 세션에서 안 재면 눈금이 달라진다). 그래서 §4.4의 `0.803 / 0.790`은
**「분모의 LSP 상태 미확인」이라는 단서를 달아야 인용할 수 있는 수**다. 확실한 것은 둘:
① 3.0의 **두 팔은 같은 하네스·같은 순간으로 서로 비교됐다**(이 라운드의 주장은 그것뿐이고
그건 안전하다), ② G1(LSP 제외)은 양쪽에서 같은 규칙으로 빼므로 이 흠에 덜 민감하다.

> **★R2 정정(확인 크리틱 R1 C5)** — 이 절의 **본론(분류 산물이다)은 참**이고 크리틱도
> 인정했다. **틀린 것은 보조 논거 둘**이다.
>
> **(가) `7 → 9`의 정체를 잘못 짚었다.** 같은 파일이 답을 적어 두고 있다 —
> `idleGrid.procs = 7` · `idleWithWindows.procs = 9` · `windowCost.procsAdded = 2`.
> `procDetail`은 **창을 연 뒤에** 찍히므로(`bench/multi.mjs:225`) 그 2개는 **하네스가
> 일부러 연 창**이지 LSP가 아니다(3.0 팔은 `procsAdded: 0`이라 8 → 8로 안 벌어진다).
> 즉 **2.6.2 정착 시점 7개에 LSP가 있는지 없는지는 여전히 아무도 모른다.**
>
> **(나) 「G1이 이 흠에 덜 민감하다」는 거꾸로다.** 규칙이 같을 뿐 **효과가 같지 않다** —
> 그 규칙은 3.0에서 **125MB를 빼고** 2.6.2에서 **0을 뺀다**(정규식이 `electron.exe`를 못
> 무니까). 만약 2.6.2의 718.6MB에 LSP가 들어 있다면 G1은 **3.0에 유리하게** 기울어 있고,
> 거칠게 잡아도 `(568.85−124.7) / (718.6−120) ≈ 0.74`로 **제안선 0.70을 넘길 수 있다.**
> → **G1은 가장 둔감한 수가 아니라 가장 오염되기 쉬운 수다.** §4.4의 「G1은 안 흔들렸다 ·
> 통과」와 §1.4-b의 「패키징 전후로 정의가 안 바뀌는 유일한 수」는 **분모의 LSP 상태가
> 확정되기 전까지 게이트 근거로 쓸 수 없다.** R2도 재측정은 안 했다(경계 밖) —
> 확대한 것은 「미확인」 딱지뿐이다.

**다음 라운드 숙제**: (ⅰ) 헬퍼 분류를 이름이 아니라 **부모-자식 관계**로 바꾸거나
(ⅱ) 2.6.2 팔을 LSP가 확실히 뜬 상태로 다시 재서 두 팔을 맞춘다. §1.4-b가 예고한
*"그때는 2.6.2 팔에도 LSP를 설치해야 두 팔이 같아진다"* 가 **오늘 도래했다.**

### 6.6 설치기를 **실행해서** 검증하지는 않았다

배포 모사는 `installer.nsi`의 `File` 줄을 복제해 만들었지 `setup.exe`를 돌린 것이 아니다.
**이유: 사용자 실앱이 깔려 있다.** Tauri NSIS 설치기는 같은 제품을 만나면 이전 판을
제거하고 도는 프로세스를 죽이므로, 돌리는 순간 사용자의 실제 설치본을 건드린다.
`installer.nsi`가 makensis에 넘어가는 그 파일이라 적재물의 진실성은 보장되지만,
**「설치기를 돌리면 그 배치가 된다」의 마지막 한 칸은 안 재고 남긴다**(깨끗한 VM의 일이다).
같은 이유로 언인스톨 경로도 파일만 확인했다 — `installer.nsi`에 `Delete` 5,426줄과
`RMDir /REBOOTOK` 짝이 정상 생성돼 있다(제거 시 잔재 없음).

---

## 7. 재현

```bash
# ① 설치기(서명) — 공용 target/ 오염 금지
CARGO_TARGET_DIR=target-lspdist npm run tauri:build

# ② 기능·결정론 PoC(배포 모사 · 네 팔 × 두 언어 + 옛 코드 되짚기)
#    옛 코드 팔을 켜려면 먼저:
#      git archive HEAD | tar -x -C target-lspdist/before-head
#      (cd target-lspdist/before-head && CARGO_TARGET_DIR=$PWD/target \
#         cargo build --release -p ccg-lsp --features cli --bin ccg-lspprobe)
node scripts/poc-lspdist-r1.mjs           # → bench/results/poc-lspdist-r1.json

# ③ 메모리(기준 결과 파일을 덮지 않는다 — --out을 반드시 준다)
SIM=%LOCALAPPDATA%\ccg-lspdist-r1-app     # exe 1개 + node_modules 번들
node bench/multi.mjs tauri --repeats=3 --tag=lspdist --port=11001 \
     --exe="$SIM\AgentCodeGUI3.exe" --cwd="$SIM" \
     --out=multi-tauri-3.0.0-default-lspdist-instcwd.json
node bench/multi.mjs tauri --repeats=3 --tag=lspdist --port=11002 \
     --exe="$SIM\AgentCodeGUI3.exe" --cwd="C:\Code\AgentCodeGUI" \
     --out=multi-tauri-3.0.0-default-lspdist-projcwd.json

# ④ 무후퇴
CARGO_TARGET_DIR=target-lspdist cargo test --workspace
```

`bench/results/multi-tauri-3.0.0-default-r28jdecr1-{dist,distmod,bench}.json`과
`multi-electron-2.6.2-default-r28jdecr1.json`은 **기준 파일이다. 덮지 마라.**
