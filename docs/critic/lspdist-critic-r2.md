# LSPDIST R2 확인 크리틱 — 판정문

> 대상 커밋: `1bd2902` · `c3c9797` · `e9ff265` · `735992b` · `e18798a` · `b4f89b5`(팁)
> 피감 보고서: `docs/parity-fix-lspdist-r2.md` (+ `-r1.md`의 ★R2 정정 8개)
> 앞 라운드 판정문: `docs/critic/lspdist-critic-r1.md`(합격 · 중 5 · 낮음 4)
>
> **재현 환경(빌더의 워크트리·계기·산출물을 하나도 안 썼다)**
> - 트리: `git archive b4f89b5` → `%TEMP%\ccg-critic-lspdist-r2\tree` (`node_modules` 정션만)
> - `CARGO_TARGET_DIR=C:\Temp\ccg-critic-r2-target` · `npm run tauri:build:unsigned`
>   + `cargo build --release -p ccg-lsp --features cli --bin ccg-lspprobe`
> - `node.exe`는 내가 직접 스테이징(`scripts/tauri-build.mjs stage`)하고 **핀을 nodejs.org
>   공식 `SHASUMS256.txt`와 따로 대조**했다
> - 계기: `docs/critic/tools/critic-lspdist-r2.mjs`(신설 · 판정 23 · 빌더 PoC 재실행 아님)
> - 증거: `docs/critic/lspdist-critic-r2-{probe,evidence,mem-instcwd,mem-projcwd}.json`
> - 규율: 이름 기반 kill 0 · NSIS 설치기 **미실행** · 전 팔 `CCG_HOME` 격리 · 실홈 무접촉 ·
>   CDP 11032·11033 · 기준 파일 무접촉 · 제품 코드 무수정(돌연변이 14종 전부 격리 사본,
>   매회 원상복구를 해시로 확인) · 시스템 PATH 무변경(환경변수만 조작)

---

## 0. 판정

### **합격 — 종결한다. §1.6-A2는 「닫힘」으로 선언할 수 있다(단서 하나).**

R1이 남긴 **최대 격차가 진짜로 닫혔다.** 내 계기로 다시 쟀다:

| | R1 크리틱 실측 | **R2 크리틱 실측** |
|---|---|---|
| PATH에 node 없음 · ts · cwd=설치 폴더 | error | **ready · hover 6/6 · 토큰 1,565** |
| 〃 · ts · cwd=프로젝트 | error | **ready** |
| 〃 · py · cwd=설치 폴더 | error | **ready · hover 6/6** |
| 〃 · py · cwd=프로젝트 | error | **ready** |
| `resolve.node` | null | **`…\deployed\node.exe`(번들 사이드카)** |

**그리고 내가 던진 공격 중 가장 중요한 것들이 방어됐다.** 배포 배치(`.cargo-lock` 없음)에서
사이드카를 지우고 **진짜 node를 PATH에 두어도**, **미끼 `node.exe`(진짜 node의 사본)를 PATH
첫 칸에 세워도**, **cwd를 `.cargo-lock`이 있는 폴더로 놓아도** — 두 언어 모두 `error` ·
`resolve.node=null`이다. 게이트는 **exe 경로의 함수**가 맞다.

스테이징도 내 손으로 돌렸다. 핀 `5c976096…c707b5`는 **nodejs.org 공식 `SHASUMS256.txt`의
`win-x64/node.exe` 줄과 정확히 일치**하고(v24.20.0 = 2026-08-26 최신 Krypton LTS), 1바이트만
뒤집은 캐시는 **크기가 같아도 거절**되며, 해시 불일치·404 둘 다 **`Compiling` 0줄**로 죽는다.

남은 것은 **중 2 · 낮음 4**이고 둘 다 실질 위험이 제한적이다(하나는 문자열 한 줄, 하나는
「빠뜨림」이 아니라 「잘못 편집」을 요구한다). **합격 종결하고 잔여는 이월 장부로 넘긴다.**

---

## 1. 종결 판단 — 두 미결의 운명

### 1.1 §1.6-A2 — **닫힘. 단, 단서 하나.**

R1 크리틱은 «닫힌 게 아니라 좁혀졌다»로 판정했다. 근거는 하나였다: **node 없는 기계에서
네 팔이 전부 죽는다.** 그 근거가 사라졌다 — 같은 네 팔이 전부 산다.

이제 배포본의 TS·Python은 **cwd와 무관하고**(R1이 닫음) **기계의 node 유무와도 무관하다**
(R2가 닫음). 「LSP 없음 / 있음 두 상태」는 **한 상태**가 됐고, 그 하나는 **「있음」**이다.

> **단서**: 「`$INSTDIR\node.exe`가 온전할 때」. 이건 「`$INSTDIR\AgentCodeGUI3.exe`가 온전할
> 때」와 같은 종류의 전제(설치본 무결성)이므로 미결로 남길 값이 아니다. **다만 그 전제가
> 깨졌을 때 사용자가 원인을 알 수 없다** — R2-C1. 그래서 닫힘 선언에 **「진단 문자열 정정」을
> 이월 조건으로** 붙인다(코드 한 문장 · §4).

### 1.2 `docs/decisions-3.0.md` 미결 F(공시 팔) — **소멸한다.**

F는 «같은 exe·같은 배포 위치인데 cwd가 헬퍼 0(0.627)과 3(0.839)을 가른다»에서 나온
「①공시값을 보수적으로 잡을지, 두 팔을 나란히 낼지」다. 그 질문은 **두 팔이 갈릴 때만**
성립한다. 갈리지 않는다:

| 라운드 | 계기 | cwd=설치 / cwd=프로젝트 | 벌어짐 | 프로세스·헬퍼 |
|---|---|---:|---:|---|
| 고치기 전 | R28j·크리틱 R2 | 450.5 / 603.7 | 헬퍼 0 ↔ 3 | 5 ↔ 8 |
| R1 | 빌더 | 577.3 / 567.5 | 9.8MB | 8·3 = 8·3 |
| R1 | **크리틱** | 568.85 / 573.50 | 4.65MB(부호 반대) | 8·3 = 8·3 |
| **R2** | **크리틱** | **571.5 / 564.6** | **6.9MB(부호 또 반대)** | **8·3 = 8·3** |

세 계기·세 세션이 **부호까지 뒤집으며** 4.65~9.8MB에 머문다 = 잡음. 공시값은 한 쌍이 아니라
**하나**다. → **F ①은 답이 필요 없어졌고, F ③(「그것 자체가 제품 결함」)은 A2와 함께 닫혔다.**

> **F ②만은 F를 떠나 살아 있다** — 「2.6.2 분모도 같은 상태로 재야 한다」. 그건 **공시 팔의
> 문제가 아니라 분모의 문제**이므로 §1.4-b / R1-C5 / R2 §6.4로 이관해 추적해야 한다.
> F 항목 자체는 닫고, 그 한 줄만 옮겨라.

---

## 2. 실측 재현 — 칸별 대조

### 2.1 스테이징 파이프라인 (내가 직접 4팔)

| 팔 | 기대 | 실측 |
|---|---|---|
| 핀 ↔ nodejs.org **공식 `SHASUMS256.txt`** | 일치 | **일치** (`5c976096…c707b5` · v24.20.0 = 최신 Krypton LTS · 2026-08-26) |
| 스테이징 후 내가 다시 센 sha256 | 일치 | **일치** · 93,381,448 B |
| **S1** 캐시 1바이트 오염(**크기 동일**) | 거절 후 재다운로드 | **거절** (`있던 sha256=36165c06…`) → 재다운로드 → 핀 일치 |
| **S2** 핀 해시 변조 → `build --unsigned` | exit 1 · **cargo 전** | **exit 1** · `Compiling` **0줄** · 사유/주소/자리/오프라인 문 출력 |
| **S3** 없는 판(404) | exit 1 · `.part` 정리 | **exit 1** · `Compiling` **0줄** · `.part` **0개** · `curl 종료 코드 22` |
| **S4** 복구 후 2회차 | 다운로드 → 캐시 적중 | **그대로** |

「**일찍, 사유를 말하고 실패한다**」는 규약이 실제로 선다. 서명 키 게이트와 같은 모양이다.

### 2.2 `.cargo-lock` 게이트 공격 (6팔)

| 팔 | 배치 | PATH | 기대 | 실측 |
|---|---|---|---|---|
| G1 | 배포·사이드카 없음 | **진짜 node** | error | **error · node=null** |
| G2 | 〃 | **미끼 node.exe 첫 칸**(ts) | error | **error · null · 미끼 안 뭄** |
| G3 | 〃 | 미끼(py) | error | **error · null** |
| G4 | 〃 · **cwd = `.cargo-lock` 폴더** | 미끼 | error | **error · null** ← 게이트는 exe 경로의 함수 |
| G5 | 고아 exe(사이드카·조상·lock 전무) | 진짜 node | error | **error** |
| G6 | 배포 배치 + **0바이트 `.cargo-lock`을 내가 심음** | 미끼 | ready(설계대로) | **ready · node=`bait-path\node.exe`** |

- **「PATH 폴백 금지」는 실제로 지켜진다.** 미끼를 진짜 node의 **사본**으로 만든 것이 요점이다 —
  물었다면 `ready`가 되어 누출이 시끄럽게 드러났을 텐데, 넷 다 조용히 `error`다.
- **G4가 조율자가 물은 「사용자가 cargo 레포 안에서 설치본을 돌리는 판」이다.** 안 열린다.
- **G6은 실패가 아니라 게이트의 실체 확인**이다 — 판정이 정확히 그 한 파일이다(위험도는 §3 L2).

### 2.3 개발 실행 — 안 잃었다

| 팔 | 실측 |
|---|---|
| exe가 `<트리>/target-sim/release/`(`.cargo-lock` O · 사이드카 X) · **PATH에 node 없음** · cwd = 중립 자리 | **ready** · node = `…\tree\src-tauri\lsp-runtime\node.exe` (③ 스테이징 산출물) |
| 같은 배치 · py | **ready** |

PATH를 걷어낸 채로도 산다 = ③이 실제로 개발을 받친다(④ PATH에 기대지 않는다).

### 2.4 돌연변이 — 빌더 6종 + 크리틱 신규 3종

| # | 돌연변이 | R1 | **R2** |
|---|---|---|---|
| C3-a | 매니페스트 `typescript/lib` 한 줄 삭제 | **초록**(구멍) | **red** |
| C3-b | 매니페스트 `tsls/package.json` 한 줄 삭제 | **초록**(구멍) | **red** |
| R2-c | 매니페스트 `lsp-runtime/node.exe` 한 줄 삭제 | — | **red** |
| D | 매니페스트 `pyright` 한 줄 삭제 | red | **red** |
| E | 유령 적재(SPECS에 없는 패키지) | red | **red** |
| C4-a | `module_roots_from`에 cwd 부활 | red | **red**(단위) |
| C4-b | `module_roots()`에 cwd 부활 | **초록**(구멍) | **red**(단위 **+ 통합**) |
| C4-c | `shipped_module` **본문**에 cwd 부활(옛 결함 자리) | — | **red**(**통합만**) |

**C4-c가 통합 테스트만 잡는다** — 단위 테스트 8개는 전부 초록이다. `tests/cwd_is_never_consulted.rs`가
장식이 아니라 **유일한 그물**인 자리가 실재한다는 뜻이고, 그 파일의 존재 이유가 실측으로 정당화됐다.
(양성 대조군 `CCG_LSP_MODULES` 레버까지 들어 있어 「애초에 아무것도 못 찾는다」와 구별된다.)

내가 새로 고안한 회피 변이 3종은 **전부 통과했다** → §3 R2-C2.

### 2.5 풋프린트

| | 내 실측 | 빌더 신고 | 차 |
|---|---:|---:|---:|
| 설치기(NSIS·lzma) | **32,410,584 B** | 32,410,863 B | **279 B**(무서명·경로 차) |
| 설치 폴더 | **150MB** | 약 150MB | — |
| 2.6.2 대비 설치기 | **19.63%** | 19.6% | — |
| 2.6.2 대비 설치 폴더 | **23.1%** | 23.1% | — |
| `installer.nsi` node.exe 적재 | **:6948** | :6948 | 줄 번호까지 일치 |
| 언인스톨 짝 | **:12493** `Delete "$INSTDIR\node.exe"` | 「생성돼 있다」 | 확인 |
| 모듈 적재 줄 / 총 `File /a` | 5,426 / **5,427** | 5,426 | — |

### 2.6 메모리 — 무후퇴, 그리고 띠는 여전히 없다

| 팔 | cwd | 프로세스 | 헬퍼 | 헬퍼 WS | 유휴 WS | 유휴 Priv | 비 | G1 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| I | 설치 폴더 | 8 | 3 | 119.7 | **571.5** | 358.8 | 0.795 | 0.629 |
| P | 프로젝트 | 8 | 3 | 114.8 | **564.6** | 356.5 | 0.786 | 0.626 |

- 런타임 판이 v24.13.1(시스템) → v24.20.0(번들)로 바뀌었는데 **유휴 WS·프로세스·헬퍼가 안 움직였다**.
- **빌더는 이 라운드에서 한 팔만 쟀다**(instcwd, 3회). 두 cwd 팔이 새 바이너리에서도 안 갈리는지는
  **내가 메웠다**(→ §3 L4). 띠 **6.9MB**로 여전히 잡음.
- 비율의 분모는 §6.4의 「LSP 상태 미확인」 딱지를 그대로 진다(R1-C5 · 아직 유효).

### 2.7 무후퇴·정정·경계

- `cargo test --workspace`: **795 통과 · 0 실패 · 14 무시 · 테스트 타깃 35개** — 빌더 신고와 **완전 일치**.
  `ccg-lsp` 라이브러리 **69** + 통합 **1**도 일치.
- **R1 보고서의 ★R2 정정 8개는 전부 사실과 맞는다.** 원문을 지우지 않고 취소선+주석으로 남긴
  방식도 옳다. L1 정정에 **틀린 이유까지**(`| tail -30`으로 잘라 35개 중 15줄만 합산) 적은 것은
  다음 사람에게 실제로 쓸모 있는 기록이다.
- **커밋 경계 깨끗하다**: R2 6커밋이 건드린 11개 파일과 옆 갈래 SMALL3(`bae5bd7`·`fc245ac`)의
  8개 파일의 **교집합 0**. `dialog.rs`·`ccg-fs/src/lib.rs` 혼입 없음. 공유 파일 `.gitignore`를
  건드렸지만 내용은 `src-tauri/lsp-runtime/` 한 항목으로 LSPDIST 고유다.

---

## 3. 결함

### 치명 — **없다.**

### 중

**R2-C1. ★ 배포본이 죽을 때 하는 말이 틀렸다 — 이 라운드가 만든 유일한 새 실패 모드의 진단이다.**

`crates/ccg-lsp/src/server.rs:139`:

```
"Node 런타임을 못 찾음 (CCG_LSP_NODE · exe 옆 node.exe · PATH 순으로 찾는다)"
```

R2는 **배포본에서 PATH를 끊었다.** 그런데 이 문자열이 뜨는 상황은 정확히 **배포본 + 사이드카
유실**이고, 거기서 **PATH는 안 본다.** 게다가:

- 사슬 ③(**exe 조상의 `src-tauri/lsp-runtime/node.exe`**)은 **언급조차 없다.**
- **경로를 하나도 안 싣는다** — 어느 자리를 봤는지 사용자가 알 수 없다.

그런데 두 곳이 반대로 적고 있다:

- `crates/ccg-lsp/src/launch.rs` 머리말: *"실패 문자열이 사이드카 경로를 지목한다(`crate::server::plan`)"*
- `docs/parity-fix-lspdist-r2.md` §6.1: *"실패 문자열이 그 경로를 지목한다"*

**둘 다 거짓이다.** `server.rs`는 R2에서 **한 줄도 안 바뀌었다**(마지막 변경 = `adcef10`, R1).

왜 중인가: §6.1이 스스로 **이 라운드가 새로 만든 유일한 실패 모드**(백신 격리·부분 설치)라고
꼽은 자리다. 그 사용자는 「node를 설치하라」는 **헛수고**로 보내진다 — 설치해도 안 낫는다.
그리고 이건 §1.6-A2가 「제품 결함」으로 올라오기까지 세 라운드를 먹은 이유의 절반
(*"실패가 조용했다"*)과 **같은 병**이다. R1은 모듈 쪽에 `module_search_hint()`를 붙여 그 병을
고쳤는데, **런타임 쪽에는 대칭이 안 됐다.**

고치는 비용: `server.rs` 한 문장 + `launch::node_search_hint()` 하나(모듈 쪽에 이미 있는 패턴 그대로).

**R2-C2. 계약이 목적지만 보고 **출처**를 안 본다 — 내 회피 변이 3종 전부 초록.**

`every_bundled_file_is_covered_by_the_installer_manifest`는 `bundle.resources`의 **값(목적지)만**
읽는다(`res.values()`). 키(출처)는 한 번도 안 본다. 격리 사본 실측:

| # | 돌연변이 | 결과 | 실제 피해 |
|---|---|---|---|
| **E1** | `dest`는 `node_modules/typescript/lib` 그대로, `src`만 `../node_modules/pyright/dist`로 | **초록** | tsserver 누락 = **C3이 막으려던 바로 그 고장**이 다른 문으로 들어온다 |
| **E2** | `resources`를 `{node.exe, "../node_modules": "node_modules"}`로 | **초록** | 계약을 만족하며 레포 `node_modules` **통째** 적재. 유령 검사도 못 잡는다 — `strip_prefix("node_modules/")`가 맨 `node_modules`에는 `None`이라 `continue`한다 |
| **E3** | `dest=node.exe`, `src=../node_modules/pyright/LICENSE.txt` | **초록** | **실측**: `is_file()`이 텍스트 파일을 통과시켜 `resolve.node`가 그것을 가리키고 서버 사망. **그리고 R2가 PATH를 끊었으므로 복구 경로가 없다** |

R1의 C3보다는 **좁다** — 「한 줄을 빠뜨림」이 아니라 「잘못 편집」을 요구한다. 그래도 중인 이유:
① E2는 현실적인 「매니페스트 단순화」 편집이고, ② E3는 이 라운드가 새로 만든 **비가역** 실패이며,
③ 이 라운드의 명제가 *"그 1줄이 어긋나면 사용자가 아니라 테스트가 먼저 깨진다"*이기 때문이다.
현재 참인 명제는 **"목적지 문자열이 어긋나면"**까지다.

값싼 보강: 각 `dest`의 `src`가 실재하고(`Path::exists`), `node.exe` 항목의 `src`가 스테이징
자리(`lsp-runtime/node.exe`)인지 한 줄로 확인하면 E1·E3가 붉어진다. E2는 `dest`에 정확히
`node_modules`를 금지하면 된다.

### 낮음

**R2-L1. 보고서 §4.5의 FPS가 자기 증거 파일과 다르다.** 보고서는 **「FPS 60.0 / p95 16.8」**,
커밋된 `multi-tauri-3.0.0-default-lspdistr2-instcwd.json`은 **`avgFps: 59.4 / p95Ms: 17`**이다
(내 실측 59.35 / 60.35). 「드랍 0% · 3주행 무드랍」은 맞다. R1에서 같은 자리의 수는 실제로
60.0/16.8이었으므로 **앞 라운드 값을 그대로 옮겨 적은 것으로 보인다.**

**R2-L2. `.cargo-lock` 단독 판정은 상류보다 약하고, 상류 인용도 Windows에서 부정확하다.**
`tauri_utils::platform`(2.9.3)은 `is_cargo_output_directory`를 **단독으로 안 쓴다**:

```rust
if cfg!(target_os = "windows")
  || ((len >= 2 && parts[len-2] == "target") || (len >= 3 && parts[len-3] == "target"))
     && is_cargo_output_directory(exe_dir)
```

- 상류는 **`target` 폴더명 조건을 AND로** 더 걸고, 주석에 *"This ensures the check is safer so
  it doesn't affect apps in production"*이라 적어 뒀다. **빌더는 뒤 절반만 가져왔다.**
- 더 정확히는, **Windows에서는 `cfg!(target_os="windows")`가 먼저 단락되어 상류가 `.cargo-lock`을
  아예 안 본다.** 그러니 *"`resource_dir`가 「개발 중인가」를 가르는 바로 그 신호"*는 이 플랫폼에서
  성립하지 않는 서술이다.
- 실측(G6): `$INSTDIR`에 **0바이트** `.cargo-lock`을 심으면 PATH 칸이 열리고 미끼 node를 문다.
- **실질 위험은 낮다** — `$INSTDIR`에 파일을 쓸 수 있는 사람은 `node.exe` 자체를 바꾸는 게 더
  쉽다. 방어 심층화 항목이고, 상류의 `target` 조건을 같이 넣으면 한 줄로 좁아진다.

**R2-L3. 스테이징이 실패해도 `node.exe.pin.json`이 남는다.** S2 실측: 해시 불일치로 exit 1 한 뒤
폴더에 `node.exe`는 없고 `node.exe.pin.json`만 남는다 — 「스테이징됨」을 주장하는 원장이 거짓이
된다. 코드가 이 파일을 **읽지 않으므로 무해**하지만, 사람이 보는 원장으로서는 틀렸다.
`fatalRuntime`에서 같이 지우면 된다.

**R2-L4. 메모리를 한 팔만 쟀다.** 이 라운드는 **헬퍼가 도는 node 판을 바꿨다**(v24.13.1 → v24.20.0).
그러면 두 cwd 팔이 여전히 같은지는 이 바이너리로 다시 봐야 하는데 `instcwd` 하나만 커밋됐다.
결론(무후퇴·띠 없음)은 유효하지만 그 칸은 **크리틱이 메웠다**(571.5 / 564.6 · 6.9MB).

### 이월(결함 아님 — 앞 라운드에서 넘어온 것)

- **R1-C5 / R2 §6.4 — 2.6.2 분모의 LSP 상태 미확인.** 여전히 열려 있고 R2도 안 건드렸다(경계 밖이 맞다).
  §1.2대로 **미결 F에서 떼어 내 §1.4-b로 옮겨야** 추적이 끊기지 않는다.
- R2 §6.2(판 올리기 수동) · §6.3(유령 14.1MB) · §6.5(NSIS 미실행) · §6.6(`tauri:dev` 미배선)은
  전부 **정당한 유보**다. 특히 §6.5는 나도 같은 이유로 안 돌렸다.
- **관찰 하나**: `CCG_LSP_MODULES` 레버만으로는 이제 서버가 안 뜬다(런타임이 없으면 죽는다).
  배포 자리에서 재는 하네스 팔은 `CCG_LSP_NODE`를 같이 줘야 한다. 벤치 상용 경로는 영향 없다
  (`target*/release/`에 사이드카가 같이 놓인다). 문서화 가치만 있다.

---

## 4. 남은 가장 큰 격차 — **하나만 꼽으면 R2-C1(틀린 진단 문자열)**

> **이 라운드는 「조용히 틀린 판을 무는 것보다 소리 내어 죽는 편이 낫다」를 사서 PATH를 끊었다.
> 그런데 죽을 때 하는 말이 틀렸다.** 그러면 그 거래에서 산 것을 절반 잃는다.

- **크기**: 문자열 하나. 하지만 그 문자열이 덮는 것은 이 라운드가 **새로 만든 유일한 실패 모드**다.
- **왜 지금 중요한가**: R1까지는 이 자리가 PATH로 조용히 살아났으므로 문구가 틀려도 아무도 안
  밟았다. R2가 그 문을 닫는 순간 이 문자열이 **처음으로 사용자의 유일한 단서**가 됐다.
- **닫는 비용**: 모듈 쪽에 이미 있는 패턴(`module_search_hint()`)을 런타임 쪽에 대칭으로 놓기 —
  `server.rs` 한 문장 + `launch.rs`에 힌트 함수 하나. 사슬 ③을 문장에 넣고 PATH 표현을 **「cargo
  산출 폴더에서만」**으로 고치면 끝이다. 그리고 그 문장과 `launch.rs` 머리말·보고서 §6.1의
  「경로를 지목한다」가 **그때 비로소 참이 된다**.

**차점**: R2-C2 — 계약이 출처를 안 본다. 값싼 보강 세 줄로 E1·E3가 붉어진다.

**종결 권고**: 이 조각(§1.6-A2 · 미결 F)은 **닫는다.** R2-C1은 **출시 전 반드시**, R2-C2와 낮음 4는
**이월 장부**로. R2-C1은 다음에 `server.rs`를 여는 사람이 같이 처리하면 되는 크기이지, 라운드를
하나 더 여는 크기가 아니다.

---

## 5. 재현

```bash
# ① 오염 없는 트리 (node_modules는 정션 · npm install 금지)
git archive b4f89b5 | tar -x -C %TEMP%\ccg-critic-lspdist-r2\tree
mklink /J %TEMP%\ccg-critic-lspdist-r2\tree\node_modules C:\Code\AgentCodeGUI\node_modules

# ② 스테이징을 직접 돌리고 핀을 공식 SHASUMS와 대조한다
CARGO_TARGET_DIR=C:\Temp\ccg-critic-r2-target node scripts/tauri-build.mjs stage
curl -sSL https://nodejs.org/dist/v24.20.0/SHASUMS256.txt | grep win-x64/node.exe   # 핀과 대조

# ③ 빌드 (공용 target/ 무접촉)
CARGO_TARGET_DIR=C:\Temp\ccg-critic-r2-target npm run tauri:build:unsigned
CARGO_TARGET_DIR=C:\Temp\ccg-critic-r2-target \
  cargo build --release -p ccg-lsp --features cli --bin ccg-lspprobe

# ④ 네 팔 + .cargo-lock 게이트 공격 + 개발 실행 (판정 23)
node docs/critic/tools/critic-lspdist-r2.mjs \
  --probe=C:\Temp\ccg-critic-r2-target\release\ccg-lspprobe.exe \
  --nsi=C:\Temp\ccg-critic-r2-target\release\nsis\x64\installer.nsi \
  --tree=%TEMP%\ccg-critic-lspdist-r2\tree \
  --out=docs/critic/lspdist-critic-r2-probe.json

# ⑤ 메모리 두 팔 (기준 파일 무접촉 · 포트 11030~11049)
node bench/multi.mjs tauri --repeats=2 --tag=critr2I --port=11032 \
  --exe=%LOCALAPPDATA%\ccg-critic-r2-app\AgentCodeGUI3.exe \
  --cwd=%LOCALAPPDATA%\ccg-critic-r2-app \
  --out=../../docs/critic/lspdist-critic-r2-mem-instcwd.json
node bench/multi.mjs tauri --repeats=2 --tag=critr2P --port=11033 \
  --exe=%LOCALAPPDATA%\ccg-critic-r2-app\AgentCodeGUI3.exe \
  --cwd=C:\Code\AgentCodeGUI \
  --out=../../docs/critic/lspdist-critic-r2-mem-projcwd.json

# ⑥ 스테이징 실패 팔 · 돌연변이 14종 — 전부 격리 사본에서, 매회 해시로 원상복구 확인
#    (NODE_PIN.sha256 변조 / NODE_PIN.version 변조 / node.exe 1바이트 뒤집기)
CARGO_TARGET_DIR=C:\Temp\ccg-critic-r2-target cargo test -p ccg-lsp --lib spec::tests
CARGO_TARGET_DIR=C:\Temp\ccg-critic-r2-target cargo test -p ccg-lsp --lib launch::tests
CARGO_TARGET_DIR=C:\Temp\ccg-critic-r2-target cargo test -p ccg-lsp --test cwd_is_never_consulted
```

증거: `docs/critic/lspdist-critic-r2-evidence.json`(스테이징 4팔 · 게이트 6팔 · 돌연변이 11종 ·
풋프린트 · 메모리 · 진단 결함) · `-probe.json`(팔 원자료) · `-mem-{instcwd,projcwd}.json`.
