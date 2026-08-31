# LSPDIST R3(마감) — 죽을 때 하는 말을 고치고, 계약이 출처를 보게 한다

> 여는 판정문: `docs/critic/lspdist-critic-r2.md`(커밋 `a061cff`) — **합격 종결** ·
> 치명 0 · 중 2 · 낮음 4 · §1.6-A2 닫힘 · 미결 F 소멸
> 대상: `crates/ccg-lsp/**` · `scripts/tauri-build.mjs` · `docs/decisions-3.0.md`(★이관 주석 1곳)
> PoC: `scripts/poc-lspdist-r3.mjs` → `bench/results/poc-lspdist-r3.json`
> 커밋: `af03756`(진단을 사슬과 한 출처로 + cargo 게이트) · `5d6db26`(계약이 출처를 본다 + sha256) ·
> `ee64ed1`(실패 시 원장 정리) · `fac0791`(PoC + 프로브 launchError) · 이 커밋(장부 · R2 보고서 ★R3 정정 4개 · decisions ★이관)

---

## 0. 한 줄

크리틱 R2가 **「남은 가장 큰 격차」**로 꼽은 것은 코드 한 문장이었다:
**«이 라운드는 「조용히 틀린 판을 무는 것보다 소리 내어 죽는 편이 낫다」를 사서 PATH를
끊었는데, 죽을 때 하는 말이 틀렸다. 그러면 그 거래에서 산 것을 절반 잃는다.»**

R3은 그 말을 고쳤다 — 그리고 **문구를 고친 게 아니라 문구가 사슬과 갈라질 수 있는 구조를
없앴다.** 이제 탐색과 진단이 같은 목록(`node_candidates()`)을 읽는다.
같이, 계약이 목적지만 보고 출처를 안 보던 구멍(크리틱 회피 3종)도 닫았다.

**중 2 · 낮음 4를 전부 닫았다.** 이월 없음. LSPDIST 종결.

---

## 1. 판정문 대조표

| # | 크리틱 R2의 지적 | 어떻게 닫았나 | 실측 |
|---|---|---|---|
| **R2-C1** | 사이드카 유실 시 실패 문자열이 «PATH 순으로 찾는다»(배포본은 PATH를 안 본다) · 사슬 ③ 언급 없음 · 경로 0개. 머리말·보고서는 «경로를 지목한다»고 **거짓** | `launch::node_search_hint()` 신설 — 탐색과 진단이 **같은 목록**을 읽는다. `server.rs`는 그것을 그대로 쓴다. 머리말·R2 보고서에 ★R3 정정 | §3.1 · 유실 팔 실패 문자열 전문 |
| **R2-C2** | 계약이 `res.values()`만 읽어 **출처를 안 본다**. 회피 3종 전부 초록(E3은 비가역) | 계약이 키(출처)도 본다 — 출처↔목적지 거울 · 트리 통째 적재 금지 · 런타임 출처는 스테이징 자리 하나 · **스테이징 실물 sha256 == `NODE_PIN`** | §3.3 · 회피 **4종 전부 red** |
| **R2-L1** | 보고서 FPS 60.0/16.8이 증거 파일(59.4/17)과 다르다 | R2 보고서에 ★R3 정정(값 교체) | §4.1 |
| **R2-L2** | `.cargo-lock` 단독 판정은 상류보다 약하고 인용도 Windows에서 부정확 | 상류의 `target` 폴더명 조건을 **AND로** 마저 가져왔다 | §3.2 · G6 재현이 **닫혔다** |
| **R2-L3** | 스테이징 실패 뒤 `node.exe.pin.json`이 남아 거짓 원장이 된다 | `fatalRuntime`이 원장을 같이 지운다 | §4.2 |
| **R2-L4** | 메모리를 한 팔만 쟀다(node 판을 바꿔 놓고) | 빠진 `projcwd` 팔을 내 계기로 쟀다 | §3.4 |
| **이관** | 미결 F②(2.6.2 분모)는 F를 떠나 §1.4-b로 | `docs/decisions-3.0.md` §1.6-F에 ★R3 이관 주석(본문 수치 무접촉) | §4.3 |

---

## 2. 왜 「문구 수정」이 아니라 「구조 제거」인가

R2-C1을 문자열 한 줄 고치기로 끝낼 수도 있었다. 안 그런 이유는 **그 버그가 생긴 방식**에 있다.

R2는 사슬을 `node_exe_from()`에 두고 진단을 `server.rs`에 **따로** 적었다. 두 벌이니까
사슬이 바뀌어도 문자열은 안 바뀌었고, 아무도 안 밟았다 — R1까지는 그 자리가 PATH로 조용히
살아났기 때문이다. **R2가 그 문을 닫는 순간 이 문자열이 처음으로 사용자의 유일한 단서가
됐고**, 그때 그것은 이미 1년 묵은 거짓말이었다.

그래서 R3은 **두 벌을 한 벌로 만든다**:

```
node_candidates(exe_dir) -> [(칸 이름, 경로), …]     ← 단일 출처
        ├─ node_exe_from()      : 이 목록에서 첫 is_file()
        └─ node_search_hint()   : 이 목록을 그대로 문장으로
```

이제 칸을 더하거나 지우면 진단이 **자동으로** 따라온다. 갈라질 구조가 없다.
같은 이유로 못도 그 성질에 박았다 —
`the_runtime_hint_names_every_slot_it_actually_searched`는 문구를 검사하지 않고
**「후보 목록의 자리가 문장에 있는가」**를 검사한다.

> 이건 R1이 모듈 쪽에서 이미 한 일이다(`module_search_hint()`). R2가 런타임 쪽에 **대칭을
> 안 놓은** 것이 이 결함의 전부다. 크리틱의 표현대로 *"고치는 비용: `server.rs` 한 문장 +
> 힌트 함수 하나"*가 맞았다.

### 2.1 ko/en을 한 문자열에 담은 이유

이 문장은 Rust가 만들므로 렌더러의 `t()`를 못 탄다 — 스펙의 `requires`/`requiresEn`이 두 벌을
실어 나르는 것과 **같은 사정**이다(§R3-9 ⑤: *"Rust 문자열이라 … 영어 UI에서도 한국어가
나왔다"*). 계약면을 갈라 두 벌로 나르려면 `src-tauri/src/ipc/lsp.rs`를 열어야 하는데
**그 파일은 지금 옆 갈래(HOSTI18N)의 것**이라 무접촉이 규율이다.
그래서 **한 문자열에 두 언어를 담고**, 경로는 언어와 무관하게 그대로 싣는다.
나중에 호스트 i18n이 서면 이 함수가 내는 값을 쪼개면 된다 — **경로 목록은 그대로 쓰인다.**

---

## 3. 실측

### 3.1 ★ 사이드카 유실 팔 — 죽을 때 하는 말

배포 모사(`installer.nsi`의 `File /a` 줄을 복제)에서 `node.exe`만 격리(백신 모사)하고,
**PATH에는 진짜 node를 그대로 둔 채** 돌렸다.

| 검사 | ts | py |
|---|---|---|
| `status` | **error** | **error** |
| `resolve.node` (PATH의 진짜 node를 무는가) | **null** | **null** |
| 실패 문자열이 `$INSTDIR\node.exe`를 **지목**하는가 | **O** | **O** |
| R2의 틀린 문장(«PATH 순으로 찾는다»)이 사라졌나 | **O** | **O** |
| «배포본은 PATH를 안 본다»를 말하는가 | **O** | **O** |
| «node를 깔아도 안 낫는다»(헛수고 방지) | **O** | **O** |
| 사슬 ③(개발 스테이징)이 문장에 있나 | **O** | **O** |
| ko/en 두 벌인가 | **O** | **O** |

실제로 나오는 문장(프로브가 `resolve.launchError`로 그대로 싣는다 — 사용자가 볼 그 문자열):

```
설치된 Node 런타임을 못 찾았어요. 설치가 손상됐을 수 있으니 앱을 다시 설치해 주세요
(PATH에 node를 깔아도 낫지 않아요). / The bundled Node runtime is missing — reinstall the
app; installing Node on PATH will not help. 찾아본 자리 / looked in:
  - ① CCG_LSP_NODE 미설정 / unset
  - ② 설치 폴더 사이드카: …\deployed\node.exe (없음 / missing)
  - ② resources 사이드카: …\deployed\resources\node.exe (없음 / missing)
  - ③ 개발 스테이징: …\deployed\src-tauri\lsp-runtime\node.exe (없음 / missing)
  - ③ 개발 스테이징: …\ccg-lspdist-r3\src-tauri\lsp-runtime\node.exe (없음 / missing)
  - ③ 개발 스테이징: 조상 5칸 더 봤지만 없다 / 5 more ancestors
  - ④ PATH: 배포본이라 **보지 않는다**(결정론) / not consulted in a deployed build
```

- **③을 두 줄로 줄이고 나머지는 개수로 말한다.** 드라이브 뿌리까지 적으면 일곱 줄이라
  사용자가 읽을 문장이 아니게 된다. 자리를 **숨기는 게 아니라 몇 칸을 더 봤는지 밝힌다** —
  진단의 값은 ②(사이드카)와 ④(PATH를 안 본다)에 있다.
- 두 번째 줄이 이 라운드의 핵심이다: **「node를 설치하라」는 헛수고로 보내지 않는다.**

### 3.2 ★ `.cargo-lock` 심기(크리틱 G6) — 이제 안 열린다

배포 모사에서 사이드카를 치우고 **빈 `.cargo-lock`을 심은 뒤**, 진짜 node의 **사본**을
미끼로 만들어 PATH **첫 칸**에 세웠다(물었다면 `ready`가 되어 누출이 시끄럽게 드러난다).

| | R2(크리틱 G6) | **R3** |
|---|---|---|
| ts | **ready** · node = `bait-path\node.exe` | **error · node=null** |
| py | — | **error · node=null** |

게이트가 이제 **AND**다: ⓐ 한두 칸 위 조상 폴더 이름이 `target…`이고 ⓑ `.cargo-lock`이 있다.
`%LOCALAPPDATA%\AgentCodeGUI3`는 ⓐ에서 걸린다. 상류(`tauri_utils::platform`)가 원래 걸던
조건을 마저 가져온 것이고, 상류가 *"so it doesn't affect apps in production"*이라 적어 둔
바로 그 조건이다.

**개발은 안 잃었다** — `the_cargo_gate_still_opens_for_real_dev_layouts`가
`target/release` · `target-lspdist/release` · `target/<triple>/release` 셋 다 열리는 것을 못박는다
(이 레포는 접미사 붙은 타깃 폴더를 여럿 쓰므로 이름 비교는 `starts_with("target")`).

### 3.3 ★ 회피 변이 4종 — 전부 red

격리 사본에서만 돌리고 제품 트리 무접촉을 매회 확인한다.

| # | 변이 | R2 | **R3** | 무는 규칙 |
|---|---|---|---|---|
| **E1** | `dest`는 그대로, `src`만 남의 폴더로 | **초록** | **red** | 출처↔목적지 **거울** — `node_modules/<tail>`이면 출처도 `../node_modules/<같은 tail>` |
| **E2** | `{"../node_modules": "node_modules"}` 통째 적재 | **초록** | **red** | `dest == "node_modules"` 금지 · 출처가 뿌리인 것도 금지 |
| **E3** | `dest=node.exe` · `src=…/LICENSE.txt` | **초록** | **red** | 런타임 출처는 **스테이징 자리 하나뿐** |
| **E4**(신규) | 스테이징된 **실물**을 다른 파일로 바꿈 | — | **red** | 실물 **sha256 == `NODE_PIN`** |
| 대조군 | 변이 없음 | 초록 | 초록 | — |

- **E3이 왜 특별했나**: 크기·존재 검사를 통과하고, `resolve.node`가 텍스트 파일을 가리키고,
  서버가 죽고, **R2가 PATH를 끊었으므로 복구 경로가 없다.** 이 라운드가 만든 유일한
  비가역 실패였다.
- **E4는 크리틱이 요구하지 않은 칸**이다. 스테이징 스크립트도 같은 해시를 보지만 그건
  **빌드 시각**의 검사다 — 그 뒤에 파일이 바뀌면 아무도 안 봤다. 계약이 `cargo test`마다
  다시 센다(89MB · 약 2.4초 — `cargo test -p ccg-lsp`가 0.05s → 2.5s가 되는 비용을 샀다).
- **핀의 단일 출처는 `scripts/tauri-build.mjs`다.** 계약은 그 값을 **읽어 온다** — 여기에
  한 벌 더 적으면 그 순간 두 번째 진실이 생기고, 판을 올릴 때 한쪽만 고쳐진다
  (§1.6-A2를 낳은 그 모양).

### 3.4 메모리 — 빠졌던 두 번째 팔(R2-L4)

R2는 **헬퍼가 도는 node 판을 바꿔 놓고**(시스템 v24.13.1 → 번들 v24.20.0) `instcwd` 한 팔만
쟀다. 두 cwd 팔이 새 바이너리에서도 안 갈리는지는 다시 봐야 하는 칸이다. 크리틱이 메웠고,
R3이 **자기 계기로도** 채웠다(같은 exe · 3회).

| 팔 | 계기 | cwd | 프로세스 | 헬퍼 | 헬퍼 WS | 유휴 WS | 유휴 Priv | 비(WS) | G1 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| instcwd | R2 빌더 | 설치 폴더 | 8 | 3 | 115.3 | 567.6 | 357.6 | 0.790 | 0.629 |
| **projcwd** | **R3 빌더** | **프로젝트** | **8** | **3** | **114.8** | **560.6** | **356.0** | **0.780** | **0.620** |
| I / P | R2 크리틱 | 설치 / 프로젝트 | 8 / 8 | 3 / 3 | 119.7 / 114.8 | 571.5 / 564.6 | 358.8 / 356.5 | 0.795 / 0.786 | 0.629 / 0.626 |

- **띠는 여전히 없다.** 내 두 팔의 차 **7.0MB**(567.6 ↔ 560.6)이고 크리틱은 6.9MB다 —
  R1 이후 네 계기·다섯 세션이 **4.65 ~ 9.8MB**에 머문다. 프로세스·헬퍼 수는 언제나 **8 · 3**.
- 헬퍼 WS도 두 팔이 같다(115.3 ↔ 114.8) — 런타임 판을 바꾼 것이 유휴에 안 얹혔다.
- FPS 59.9 / p95 17 / 드랍 **0%** · 3주행 무드랍. **증거 파일의 값을 그대로 옮겼다**(R2-L1의 교훈).
- 비율의 분모는 §5의 「LSP 상태 미확인」 딱지를 그대로 진다.
- 결과 파일(신규): `bench/results/multi-tauri-3.0.0-default-lspdistr3-projcwd.json`.
  기준 파일은 하나도 안 덮었다.

### 3.5 무후퇴

- `CARGO_TARGET_DIR=target-lspdist cargo test --workspace` — **804 통과 · 0 실패 · 15 무시**
  (테스트 바이너리 35개 · **파서로 셌다**). R2의 795에서 +9 — 이번 신설분(sha256 3 ·
  게이트/힌트 2)과 옆 갈래 HOSTI18N의 신설분이 같이 들어 있다.
- `ccg-lsp` 라이브러리 **74** + 통합 **1**(R2의 69+1에서 sha256 3 · 게이트/힌트 2 추가).
- 렌더러 무접촉 → `npm run typecheck:app`은 이 라운드의 대상이 아니다.
- 옆 갈래(HOSTI18N · `ipc/lsp.rs`·`system.rs`·`win.rs`·`app/src`) 파일 **무접촉** — 커밋 경로 지정.
- **풋프린트는 안 바뀌었다**(적재물 변경 0). R2 값 그대로: 설치기 30.91MB · 설치 폴더 150MB.

---

## 4. 낮음 넷에 대한 답

### 4.1 R2-L1 — FPS(닫음)
보고서 §4.5의 **60.0 / p95 16.8**은 증거 파일(`avgFps 59.4` · `p95Ms 17`)과 달랐다.
**R1의 같은 자리 값을 그대로 옮겨 적은 것**이다. R2 보고서에 ★R3 정정으로 값을 갈아 끼웠다.
「드랍 0% · 3주행 무드랍」은 참이었고, 이 프로젝트가 오래 적어 온 대로 `avgFps` 절대치는
코드가 아니라 세션의 속성이라 결론은 안 바뀐다 — 그래도 **증거 파일과 다른 수를 본문에
적은 것 자체가 결함**이라는 지적이 옳다.

### 4.2 R2-L3 — 거짓 원장(닫음)
해시 불일치로 죽으면 `node.exe`는 없는데 `node.exe.pin.json`만 남아 「스테이징됨」을
주장했다. `fatalRuntime`이 나가면서 원장을 같이 지운다. 코드가 그 파일을 안 읽으므로
무해했지만, **사람이 보는 원장으로서는 틀렸다**는 지적이 옳다.

**실측**(격리 사본 — 스크립트를 임시 트리에 복사하면 `REPO`가 그 트리로 잡혀 제품 트리를
안 건드린다): 핀의 판을 없는 것으로 바꾸고 상한 캐시를 놓은 뒤 `stage`를 돌리면
**exit 1** · 사유 출력 · 폴더에 **남은 파일 0개**(상한 캐시도 원장도 지워진다) ·
제품 트리의 `src-tauri/lsp-runtime/`은 **그대로**.

### 4.3 이관 — F②(닫음, 옮김)
`docs/decisions-3.0.md` §1.6-F에 **★R3 이관 주석**을 달았다: F는 닫고(①은 답이 필요 없어졌고
③은 A2와 함께 닫혔다), **② 「2.6.2 분모도 같은 상태로 재야 한다」 한 줄만 §1.4-b로 옮겨**
추적한다. 그건 공시 팔의 문제가 아니라 **분모의 문제**라 F가 닫혀도 안 없어진다.
**본문 수치는 손대지 않았다** — `bench/ratios.mjs` 소관이고, 다음에 분모를 다시 재는 사람이
같이 고칠 자리다.

### 4.4 R2-L4 — 한 팔만 쟀다(닫음)
§3.4에서 내 계기로 채웠다.

### 4.5 크리틱의 「관찰 하나」도 받는다
> *"`CCG_LSP_MODULES` 레버만으로는 이제 서버가 안 뜬다(런타임이 없으면 죽는다).
> 배포 자리에서 재는 하네스 팔은 `CCG_LSP_NODE`를 같이 줘야 한다."*

맞다. 이 라운드의 PoC는 배포 모사에 **사이드카가 같이 놓이므로** 그 문제를 안 만나지만,
「모듈만 꽂고 재는」 옛 R1식 팔을 다시 쓰는 사람은 두 레버를 같이 줘야 한다.
`launch.rs`의 사슬 표가 ①에 두 변수를 나란히 적어 두고 있다.

---

## 5. 남은 것 — 정직하게 (이월 없음, 성질만)

R2 §6의 목록 중 **6.1(진단 문자열)은 이 라운드가 닫았다.** 나머지는 성질이 안 바뀌었다:

- **사이드카가 사라진 설치본은 여전히 죽는다** — 다만 이제 **정확히 무엇이 없는지 말하고
  죽는다**(§3.1). 의도한 교환이고, 89MB 무서명 `node.exe`에 대한 **백신 상호작용은 여전히
  안 쟀다**(관측되면 되돌리는 비용은 `node_exe_from`의 ④ 게이트 한 줄).
- **판 올리기는 수동**(`NODE_PIN` 세 값). 자동화는 일부러 안 한다 — 판올림은 의도적 결정이어야
  하고, 틀리면 빌드가 죽는다. R3이 더한 것: **계약도 그 핀을 읽어 실물과 대조한다.**
- **유령 바이트 14.1MB** 그대로(설치 폴더의 9.4%).
- **2.6.2 분모의 LSP 상태 미확인** — §4.3대로 §1.4-b로 옮겨 추적한다. 메모리 비율
  (0.79대 · G1 0.62대)은 그 딱지를 진 채로 읽어야 한다. **풋프린트 비율(19.6% / 23.1%)은
  디스크 실측이라 이 흠과 무관하다.**
- **NSIS 설치기 미실행** — 사용자 실앱이 깔려 있어 돌리면 그것을 건드린다. 크리틱도 같은
  이유로 안 돌렸다. 깨끗한 VM의 일로 남긴다.
- **`tauri:dev`에 스테이징 미배선** — `package.json`이 경계 밖. ③(스테이징 산출물)과
  ④(cargo 산출 폴더 PATH)가 받친다.

---

## 5-b. ★마감 — 확인 크리틱 R3이 남긴 마이크로 2건 (종결)

R3 판정문은 **합격 최종 종결**이면서 「라운드를 하나 더 열 값은 아닌」 한 줄급 둘을 남겼다.
둘 다 `crates/ccg-lsp` 안이라 여기서 닫는다.

### 5-b.1 R3-L1 — ④ 줄이 「배포본이라」고 단정했다

**결함**: 게이트가 닫히는 이유는 둘인데(`.cargo-lock` 없음 ↔ 폴더 이름이 `target…`이 아님)
문장은 언제나 *"배포본이라 보지 않는다"* + *"앱을 다시 설치해 주세요"*였다. 말단이
`target`으로 시작하지 않는 `CARGO_TARGET_DIR`(예: `…/build/release`)로 짓는 개발자는
**개발 판인데 재설치를 권유받는다** — R2-C1이 고친 병(**검증하지 않은 이유를 단정한다**)의
축소판이다.

**처방**: 게이트의 반환을 `bool` → `enum CargoGate {Open, NoLock, NotTargetDir}`로 바꿔
**이유를 값으로** 들고 다닌다. ④ 줄과 **머리 문장이 같이** 갈린다 — 개발 판에는 재설치가
아니라 `stage` / `CCG_LSP_NODE`를 권한다(그게 그 자리의 진짜 처방이다).

**실측**(exe를 `%LOCALAPPDATA%\ccg-lspdist-fin\build\release\`에 두고 `.cargo-lock`을 심은 뒤
PATH에서 node를 걷어내고 `CCG_LSP_MODULES`만 준 팔 — 모듈은 있고 런타임만 없는 상태):

```
Node 런타임을 못 찾았어요. 개발 배치로 보입니다 — `node scripts/tauri-build.mjs stage`로
런타임을 받거나 `CCG_LSP_NODE`로 직접 지정해 주세요. / Node runtime not found. This looks
like a dev layout — run `node scripts/tauri-build.mjs stage`, or point `CCG_LSP_NODE` at a
node binary. 찾아본 자리 / looked in:
  - ① CCG_LSP_NODE 미설정 / unset
  - ② 설치 폴더 사이드카: …\build\release\node.exe (없음 / missing)
  …
  - ④ PATH: 보지 않는다 — `.cargo-lock`은 있지만 폴더 이름이 `target…`이 아니다(개발 판일 수
    있다) / not consulted: has .cargo-lock but folder is not named target…
```

「배포본이라」도 「다시 설치」도 사라졌고, ④는 **본 것만** 말한다.
**배포 팔은 안 흔들렸다** — 사이드카 유실 팔은 여전히 `$INSTDIR\node.exe`를 지목하고
재설치를 권한다(§3.1 팔 전부 재통과). 못은 `the_cargo_gate_reports_why_it_closed`.

### 5-b.2 HOSTI18N 이월분 — `install.rs`의 정적 한국어

`crates/ccg-lsp/src/install.rs`의 제거 실패 문구(설정 ▸ 코드 분석에서 「제거」를 눌렀을 때
사용자가 보는 문장)를 `ccg_fs::t(ko, en)`으로 감쌌다. `ccg-lsp`에 `ccg-fs` 의존을 더했다
(순환 없음 — `ccg-fs`는 `ccg-store`만 본다).

**en은 지어내지 않았다.** 이 자리는 3.0 전용이 아니라 **동결 구역에 대응 원문이 있는 쌍**이다
— `src/main/lsp/install.ts:195`의 `t()` 둘째 인자를 **바이트 그대로** 옮겼다
(`"Files are still in use. Try again in a moment or restart the app."`).
HOSTI18N 규약이 *"ko/en 넷 쌍은 2.6.2 원문 그대로, 넷은 3.0 전용이라 여기서 정함"*이므로
이 건은 **앞쪽 부류**다. 조율자 지시문의 「en은 지어내되 3.0 전용임을 명시」는 이 자리에는
해당하지 않는다 — 동결 구역이 답을 갖고 있으면 그쪽이 언제나 옳다.

**기존 훑기 못이 이 파일을 무는가 — 실측: 안 문다.**
`src-tauri/src/ipc/system.rs`의 `the_shell_never_sends_a_raw_korean_value_to_the_renderer`는
ⓓ대로 `crates/`까지 걷지만, **`"error"`/`"message"`/`"reason"` 키의 값 자리**만 본다.
이 문구는 `Result::Err(...)`의 payload라 그 모양이 아니어서 **고치기 전에도 초록이었고
고친 뒤에도 초록이다**(내 변경은 그 못에 보이지 않는다). 즉 이 건은 그물이 잡아서 고친 게
아니라 **HOSTI18N이 장부에 손으로 적어 이월해 둔 것**이고, 그래서 이월 장부가 그물보다
넓었던 자리다. 그 못의 한계 주석(*"값이 함수 호출을 거치면 따라가지 않는다"*)과 같은 계열의
사각이다 — 넓히는 것은 그 파일의 주인(HOSTI18N)의 몫이라 **안 건드렸다**.

> **같이 안 고친 것 하나 — 일부러다.** 그 못의 `CARRIED_OVER`에는
> `ccg-lsp/src/lib.rs`의 *"이 파일 형식을 맡는 서버가 없어요"*가 올라 있고, 그 목록은
> **「있는데 안 걸리면 그것도 실패」**라는 규약을 진다. 내가 지금 그 줄을 고치면
> **HOSTI18N R2의 테스트가 깨진다**(고쳐졌으면 목록에서 지워야 하는데 그 파일은 내 경계
> 밖이다). 그래서 남긴다 — 그 줄은 `CARRIED_OVER` 항목을 지우는 커밋과 **같은 커밋**에서
> 닫혀야 한다.

**무후퇴**: `cargo test -p ccg-lsp` 라이브러리 **75** + 통합 1 · 워크스페이스 **805 통과 · 0 실패 · 15 무시**(바이너리 35) ·
HOSTI18N 훑기 못 통과 확인.

## 6. 재현

```bash
# ① 런타임 스테이징(굽지 않는다) — 해시 검증 포함
node scripts/tauri-build.mjs stage

# ② 설치기(적재물은 R2에서 안 바뀌었다 — 풋프린트 재측정 불필요)
CARGO_TARGET_DIR=target-lspdist npm run tauri:build

# ③ PoC — A(유실 팔의 말) · B(.cargo-lock 심기) · C(회피 4종) · D(회귀 가드)
node scripts/poc-lspdist-r3.mjs          # → bench/results/poc-lspdist-r3.json

# ④ 메모리 — R2가 빠뜨린 projcwd 팔(기준 파일 무접촉)
SIM=%LOCALAPPDATA%\ccg-lspdist-r2-app
node bench/multi.mjs tauri --repeats=3 --tag=lspdistr3 --port=11004 \
     --exe="$SIM\AgentCodeGUI3.exe" --cwd="C:\Code\AgentCodeGUI" \
     --out=multi-tauri-3.0.0-default-lspdistr3-projcwd.json

# ⑤ 무후퇴 — 합계는 파서로 센다(R2-L1의 교훈)
CARGO_TARGET_DIR=target-lspdist cargo test --workspace 2>&1 | grep "^test result" | \
  node -e "let p=0,f=0,i=0,n=0;require('readline').createInterface({input:process.stdin})\
    .on('line',l=>{const m=/(\d+) passed; (\d+) failed; (\d+) ignored/.exec(l);\
      if(m){p+=+m[1];f+=+m[2];i+=+m[3];n++}}).on('close',()=>console.log(n,p,f,i))"
```
