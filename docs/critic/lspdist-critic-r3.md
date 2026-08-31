# LSPDIST R3(마감) 확인 크리틱 — 판정문

> 대상 커밋: `af03756` · `5d6db26` · `ee64ed1` · `fac0791` · `2979178`(팁)
> 피감 보고서: `docs/parity-fix-lspdist-r3.md` (+ `-r2.md`의 ★R3 정정 4개 · `decisions-3.0.md` §1.6-F ★이관)
> 앞 판정문: `docs/critic/lspdist-critic-r1.md`(합격 · 중 5 · 낮음 4) ·
> `-r2.md`(합격 종결 · 중 2 · 낮음 4 · **이월 조건 R2-C1**)
>
> **표적 확인 라운드다** — 새 축은 안 팠다. R2가 남긴 이월분만 겨눴다.
>
> - 트리: `git archive 2979178` → `%TEMP%\ccg-critic-lspdist-r3\tree` (`node_modules` 정션만)
> - `CARGO_TARGET_DIR=C:\Temp\ccg-critic-r3-target` · `scripts/tauri-build.mjs stage` +
>   `cargo build --release -p ccg-lsp --features cli --bin ccg-lspprobe`
> - 계기: `docs/critic/tools/critic-lspdist-r3.mjs`(신설 · 판정 25 · 빌더 PoC 재실행 아님)
> - 증거: `docs/critic/lspdist-critic-r3-{probe,evidence}.json`
> - 규율: 이름 기반 kill 0 · NSIS 미실행 · 전 팔 `CCG_HOME` 격리 · 실홈 무접촉 ·
>   기준 파일 무접촉 · 제품 코드 무수정(돌연변이 4종 격리 사본, 해시로 원상복구 확인) ·
>   시스템 PATH 무변경

---

## 0. 판정

### **합격 — 최종 종결. 이월 조건(R2-C1)이 닫혔고, 잔여는 낮음 1건뿐이다.**

R2가 「남은 가장 큰 격차」로 꼽은 것은 **배포본이 죽을 때 하는 말이 틀렸다**였다. 내 계기로
그 말을 **전문으로 뽑았다**:

```
설치된 Node 런타임을 못 찾았어요. 설치가 손상됐을 수 있으니 앱을 다시 설치해 주세요
(PATH에 node를 깔아도 낫지 않아요). / The bundled Node runtime is missing — reinstall
the app; installing Node on PATH will not help. 찾아본 자리 / looked in:
  - ① CCG_LSP_NODE 미설정 / unset
  - ② 설치 폴더 사이드카: …\sidecar-lost\node.exe (없음 / missing)
  - ② resources 사이드카: …\sidecar-lost\resources\node.exe (없음 / missing)
  - ③ 개발 스테이징: …\sidecar-lost\src-tauri\lsp-runtime\node.exe (없음 / missing)
  - ③ 개발 스테이징: …\ccg-critic-lspdist-r3\src-tauri\lsp-runtime\node.exe (없음 / missing)
  - ③ 개발 스테이징: 조상 5칸 더 봤지만 없다 / 5 more ancestors
  - ④ PATH: 배포본이라 **보지 않는다**(결정론) / not consulted in a deployed build
```

R2가 지적한 네 가지 거짓·누락이 **전부** 없어졌다: 「PATH 순으로 찾는다」 소멸 · 뒤진 **절대
경로**를 실음 · 사슬 ③ 등장 · ④가 왜 닫혔는지 명시. 게다가 **사용자가 할 일**(재설치)과
**하면 안 되는 일**(node 설치)까지 말하고, ko/en 두 벌이다. 못을 문구가 아니라 **「후보 목록의
자리가 문장에 있는가」**에 박은 것도 옳다 — 사슬을 고치면 문장이 따라온다.

그리고 나머지 이월분도 전부 닫혔다:

| 이월 | R2 실측 | **R3 실측(내 계기)** |
|---|---|---|
| **R2-L2 / G6** — `$INSTDIR`에 `.cargo-lock` 심기 + 미끼 node | **ready**(미끼를 물었다) | **error · node=null**(ts·py 둘 다) |
| **R2-C2 / E1** 거울(dest 유지, src 바꿔치기) | 초록 | **red** |
| **R2-C2 / E2** 트리 삼키기(`../node_modules`) | 초록 | **red** |
| **R2-C2 / E3** LICENSE를 `node.exe`로 | 초록 | **red** |
| **E4**(빌더 신설) 스테이징 실물 1바이트 변조 | — | **red** |
| **R2-L1** FPS 수치 | 60.0/16.8(증거는 59.4/17) | 취소선 + 정정 |
| **R2-L3** 실패 후 원장 잔재 | 남음 | 정리됨 |
| **R2-L4** projcwd 팔 미측정 | 한 팔만 | 560.6 · 띠 7.0MB |
| **§1.6-F** | 소멸 판정만 | ★이관 주석으로 **닫힘**(② 한 줄만 §1.4-b로) |

---

## 1. 표적 확인 — 칸별

### 1.1 ★ G6 재실측 — 뒤집혔다

R2에서 나는 **0바이트 `.cargo-lock`을 `$INSTDIR`에 심으면 PATH 칸이 열려 미끼 node를 문다**를
실측했다. 같은 계기·같은 배치로 다시 쟀다(미끼는 여전히 **진짜 node의 사본** — 물었다면
`ready`가 되어 시끄럽게 드러난다):

| 팔 | R2 | **R3** |
|---|---|---|
| `.cargo-lock` 심기 + 미끼 node 첫 칸 · ts | **ready · node=`bait-path\node.exe`** | **error · node=null** |
| 〃 · py | (미측정) | **error · node=null** |

게이트가 상류(`tauri_utils`)의 `target` 폴더명 조건을 AND로 마저 가져와 닫혔다. **한 파일을
심어서 결정론을 깨는 길이 없어졌다.**

### 1.2 ★ 개발 팔 무후퇴 — 조임의 대가를 다섯 모양으로 쟀다

게이트를 좁히면 **진짜 개발 판이 죽을 수** 있다. 그래서 `.cargo-lock` 있음 · 사이드카 없음 ·
조상에 스테이징본 없음으로 조건을 맞추고 **폴더 모양만** 바꿔, 「미끼 node를 무는가」로 판정했다:

| 배치 | 게이트 | 판정 |
|---|---|---|
| `…/target/release/` | **열림 · ready** | 기본값 무후퇴 ✅ |
| `…/target-lspdist/release/` | **열림 · ready** | 이 레포의 관례(`target-*/`) 무후퇴 ✅ |
| `…/target/x86_64-pc-windows-msvc/release/` | **열림 · ready** | 크로스 빌드(n−3 칸) 무후퇴 ✅ |
| `…/ccg-critic-r3-target/release/` | **닫힘 · error** | ← 말단이 `target`으로 **시작**하지 않는다 |
| `…/build/release/` | **닫힘 · error** | 〃 |
| `<트리>/target-sim/release/`(조상에 스테이징본) · **PATH에 node 없음** | — | **ready · node=③ 스테이징본** ✅ |

**이 프로젝트의 문서화된 개발 경로는 하나도 안 죽는다.** 기본 `target/`, 레포 관례 `target-*/`
(`.gitignore`가 `target-*/`로 받는 그 모양), 크로스 빌드 `target/<triple>/`가 전부 열리고,
`stage`를 한 번이라도 돌린 개발자는 게이트와 **무관하게** ③으로 산다. 닫히는 것은
「말단이 `target`으로 시작하지 않는 `CARGO_TARGET_DIR`」뿐이다 → §2 R3-L1.

### 1.3 ★ 회피 4종 — 전부 red, 그리고 무엇이 어긋났는지 말한다

격리 사본 실측(대조군은 매회 초록, 끝나고 해시로 원상복구 확인):

| # | 돌연변이 | R2 | **R3** | 문장 |
|---|---|---|---|---|
| E1 | dest 유지 · src를 `pyright/dist`로 | 초록 | **red** | *"출처와 목적지가 안 맞는다 … 매니페스트는 node_modules 구조를 그대로 비추기만 해야 한다"* |
| E2 | `resources = {node.exe, "../node_modules"→"node_modules"}` | 초록 | **red** | *"매니페스트가 node_modules를 통째로 나른다(출처 `../node_modules`)"* |
| E3 | dest `node.exe` · src `pyright/LICENSE.txt` | 초록 | **red** | *"node 런타임의 출처가 스테이징 자리가 아니다 — tauri-build.mjs가 해시를 검증해 놓는 그 파일만 실을 수 있다"* |
| E4 | 스테이징 **실물** 1바이트 변조(크기 동일) | — | **red** | *"스테이징된 node.exe가 NODE_PIN과 다르다 … `stage`로 다시 받아라"* |

- **E4가 이 라운드의 진짜 보강이다.** 스테이징 스크립트의 검사는 **빌드 시각**의 것이라
  그 뒤에 파일이 바뀌면 아무도 안 봤다. 이제 테스트가 한 번 더 본다.
- **핀이 단일 출처다** — `node_pin_from_build_script(root)`가 `scripts/tauri-build.mjs`의
  `NODE_PIN`을 읽는다. 두 벌이 안 생긴다.
- **그들의 `sha256` 크레이트를 내 계기로 교차검증했다**: 93MB 스테이징 파일에 대해
  그들 구현이 낸 값 = `coreutils sha256sum` = `NODE_PIN` = nodejs.org 공식 `SHASUMS256.txt`.
  NIST 벡터(그들 테스트)보다 이쪽이 강한 검증이다 — 실물 대용량 입력에서 독립 구현과 일치한다.
- 비용 주장도 맞다: `ccg-lsp` 라이브러리 테스트 **2.47s**(R2에서는 0.05s). 93MB를 매 실행
  해싱하는 값이고, 워크스페이스 전체로는 묻힌다.

### 1.4 회귀 가드 · 수치

- **온전한 배포본**: PATH에 node 없이 **ts·py 둘 다 ready**, `node` = 배포 사이드카. 무후퇴.
- `cargo test --workspace`: **804 통과 · 0 실패 · 15 무시 · 타깃 35** — 주장과 완전 일치.
  `ccg-lsp` 라이브러리 **74** + 통합 **1**도 일치.
- `-lspdistr3-projcwd.json`: WS **560.6** · Priv 356 · 8프로세스 · 헬퍼 3 · 3주행.
  instcwd 567.6과의 띠 **7.0MB** — R1(9.8 / 4.65) · R2(6.9)와 같은 잡음 대역, 부호도 또 뒤집혔다.

### 1.5 문서·경계

- **§1.6-F ★이관**: diff 확인 결과 **삽입된 인용 블록 하나뿐**이고 **본문 수치·표는 한 글자도
  안 건드렸다**(*"본문 수치는 손대지 않았다"*는 자기 진술이 참이다). F ①③을 닫고 **②만
  §1.4-b로** 옮긴 것은 내 R2 §1.2 판정 그대로다.
- **R2 보고서 ★R3 정정 4개**(C1 · L1 · L2 · L4) — 전부 사실과 맞고, R1·R2와 같이 **원문을
  안 지우고** 취소선 + 주석으로 남겼다. L1 정정이 「R1의 같은 자리 값을 그대로 옮겨 적었다」는
  **원인**까지 적은 것은 다음 사람에게 쓸모 있다.
- **커밋 경계 깨끗하다**: R3 5커밋의 13개 파일과 옆 갈래 HOSTI18N(`026c00d`·`6c21f0f`)의
  16개 파일의 **교집합 0**. 특히 HOSTI18N이 `src-tauri/src/ipc/lsp.rs`를 만지는 중인데
  `af03756`이 커밋 메시지에 *"그 파일은 지금 옆 갈래(HOSTI18N)의 것이라 무접촉이 규율"*이라
  적고 **실제로 안 열었다** — ko/en을 한 문자열에 담은 이유가 그 규율이다.

---

## 2. 결함

### 치명 — 없다. · 중 — 없다.

### 낮음 (1건)

**R3-L1. 게이트를 좁힌 대가: 말단이 `target`으로 시작하지 않는 `CARGO_TARGET_DIR`은 ④를 잃고,
그때 하는 말이 「배포본이라」고 단정한다.**

실측(§1.2): `…/ccg-critic-r3-target/release/`와 `…/build/release/`는 `.cargo-lock`이 있어도
게이트가 닫혀 `error`다. 그 팔의 문장은:

```
- ④ PATH: 배포본이라 **보지 않는다**(결정론) / not consulted in a deployed build
```

**개발 판인데 「배포본이라」고 말하고, 「앱을 다시 설치해 주세요」를 권한다.** R2-C1과 **같은
부류**(검증하지 않은 이유를 단정)의 축소판이다 — ④가 닫힌 진짜 이유는 「배포본이라서」가 아니라
「cargo 산출 폴더로 안 보여서」다.

**왜 낮음인가** — 완화가 세 겹이다:
1. **문서화된 개발 경로는 하나도 안 죽는다**(§1.2 표 위 세 줄). 이 레포는 `target-*/`를
   `.gitignore`로 받는 관례라 `starts_with("target")`가 그 관례를 정확히 덮는다.
2. `stage`/`tauri:build`를 한 번이라도 돌린 개발자는 ③이 받친다. (단 타깃 폴더가 레포 **밖**이면
   ③도 못 닿는다 — 내 크리틱 배치가 정확히 그 경우였다.)
3. **탈출구가 화면 첫 줄에 있다** — 같은 문장이 `① CCG_LSP_NODE 미설정 / unset`을 이름으로
   말한다. 즉 이 라운드가 산 것(자기를 설명하는 실패)이 이 잔여도 같이 덮는다.

고칠 값: ④ 줄을 조건에 맞게 두 벌로 가르기 —
`is_cargo_output_dir`가 거짓인 이유가 「`.cargo-lock` 없음」인지 「폴더 이름」인지에 따라
「배포본이라」 / 「cargo 산출 폴더가 아니라」를 갈라 적으면 된다. **한 줄**이고, 다음에
`launch.rs`를 여는 사람이 같이 처리할 크기다. 라운드를 하나 더 열 값은 아니다.

### 이월(결함 아님)

- **R1-C5 / §1.4-b — 2.6.2 분모의 LSP 상태 미확인.** R3도 안 건드렸다(경계 밖이 맞다).
  §1.6-F ★이관이 이 항목을 §1.4-b로 정확히 옮겨 놨으므로 **추적이 끊기지 않는다.**
- R3 보고서가 남긴 유보(백신 상호작용 미측정 · 판 올리기 수동 · 유령 14.1MB · NSIS 미실행 ·
  `tauri:dev` 미배선)는 전부 R2에서 이미 정당하다고 판정한 것들이고 변한 것이 없다.

---

## 3. 종결

> **§1.6-A2 — 닫힘.** R2에서 「닫힘(이월 조건 R2-C1)」으로 조건부 선언했고, **그 조건이 닫혔다.**
> 배포본의 TS·Python은 cwd·PATH·기계의 node 유무와 무관하게 뜨고, 그 전제(`$INSTDIR\node.exe`
> 무결성)가 깨지면 **자기가 어디를 봤는지 전부 말하며** 죽는다. 조건 없는 닫힘이다.
>
> **`decisions-3.0.md` §1.6-F — 닫힘.** ①③ 소멸, ② 한 줄은 §1.4-b로 이관 완료.
>
> **LSPDIST 조각 전체 — 최종 종결.** 잔여는 낮음 1건(문장 한 줄)뿐이고, 그것도 이 라운드가
> 만든 진단이 스스로 탈출구를 가리킨다.

**남은 가장 큰 격차: 없다.** R3-L1은 「격차」가 아니라 다음에 그 파일을 여는 사람의 **한 줄**이다.
장부에 올릴 이월은 두 줄뿐이다 — ① R3-L1(④ 줄의 이유 분기), ② §1.4-b의 2.6.2 분모 재측정.

---

## 4. 재현

```bash
# ① 오염 없는 트리 · 스테이징 · 프로브
git archive 2979178 | tar -x -C %TEMP%\ccg-critic-lspdist-r3\tree
mklink /J %TEMP%\ccg-critic-lspdist-r3\tree\node_modules C:\Code\AgentCodeGUI\node_modules
node scripts/tauri-build.mjs stage
CARGO_TARGET_DIR=C:\Temp\ccg-critic-r3-target \
  cargo build --release -p ccg-lsp --features cli --bin ccg-lspprobe

# ② G6 재실측 · 유실 팔 실패 문자열 · 개발 배치 다섯 모양 (판정 25)
node docs/critic/tools/critic-lspdist-r3.mjs \
  --probe=C:\Temp\ccg-critic-r3-target\release\ccg-lspprobe.exe \
  --tree=%TEMP%\ccg-critic-lspdist-r3\tree \
  --out=docs/critic/lspdist-critic-r3-probe.json

# ③ 회피 4종 — 격리 사본에서만, 매회 해시로 원상복구 확인
#    E1 src 바꿔치기 / E2 ../node_modules 통째 / E3 LICENSE를 node.exe로 / E4 실물 1바이트 변조
CARGO_TARGET_DIR=C:\Temp\ccg-critic-r3-target cargo test -p ccg-lsp --lib spec::tests

# ④ 무후퇴
CARGO_TARGET_DIR=C:\Temp\ccg-critic-r3-target cargo test --workspace   # 804/0/15 · 타깃 35
```

증거: `docs/critic/lspdist-critic-r3-evidence.json`(팔·돌연변이·수치·문서 대조) ·
`-probe.json`(팔 원자료 + 실패 문자열 전문 + 개발 게이트 표).
