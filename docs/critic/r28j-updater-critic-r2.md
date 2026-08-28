# R28j UPDATER 확인 크리틱 R2 — 못은 **내 손에서 진짜로 부러졌다**. 서명도 내 계산으로 열렸다. 남은 것은 장부 한 줄과, 못을 비껴가는 공백 하나

측정자: 새 컨텍스트의 크리틱(R2). 직전 R2 시도가 주간 쿼터로 두 번 죽어 미완이었던 자리를 대신한다.
**빌더 보고서(`docs/parity-fix-updater-r1.md`)와 커밋 메시지는 근거로 쓰지 않았다** — 무엇을 확인할지
고르는 데만 읽고, 수치는 전부 **내가 새로 구운 exe**와 **내가 처음부터 쓴 계기**로 격리 홈에서 다시 쟀다.
확인 크리틱 R1(`docs/critic/r28j-updater-critic-r1.md`)이 남긴 결함 일곱을 하나씩 되짚었다.
**레포 코드 수정 0**(커밋하는 것은 이 파일 한 장뿐).

---

## 0. 판정 요약 — **합격**

R1이 「낮음」으로 남긴 **핵심 결함 — 「그 함정을 막는다는 못이 진짜 종료 문을 안 본다」 — 는 닫혔다.**
내가 격리 사본에서 R1이 심었던 **바로 그 한 줄**(`tray.rs::quit()`에 `crate::updater::install(app)`)을
다시 심었더니 이번엔 **못이 붉어졌다.** `main.rs`의 종료 핸들러에 심어도, `use … as` 별칭으로 가려도
붉어진다. R1이 「중간」으로 매긴 **`npm run tauri:build`의 exit 1**도 닫혔다 — 키가 없으면 **cargo를 켜기
전에 366 ms에** 끝나고, 키가 있으면 exit 0 + `.sig`가 나오며, **그 `.sig`가 우리 공개키로 실제로 열린다**
(내가 Ed25519 + BLAKE2b-512를 직접 계산했다).

체크리스트 아홉 축 중 **여덟은 닫혔고, 하나(⑤ 오류 화면)는 R1과 같은 「파리티 합격 · 사용자 관점 미해결」**
이다. 기준선(agentcodegui **141** · workspace **779** · 릴리즈 경고 **0**)은 **하나도 안 줄었다.**

| 등급 | 남은 결함 |
|---|---|
| **낮음** | **장부(`renderer-divergence.md` §6.12)가 아직 안 옮겨졌다.** `App.tsx:2670`(실제 **2651**)이 그대로고, 보고서 §11.9가 「다음 갈래가 넣어 달라」고 넘긴 다섯 줄이 전부 미반영이다. ★그 미룸의 사유(「남의 미커밋 hunk가 같은 파일에 살아 있다」)는 **지금 HEAD에서 사라졌다** — 그 파일은 깨끗하다 |
| 정보 | 못 회피 하나가 남았다 — `crate :: updater :: install(app);`(`::` 둘레에 **공백**)은 **컴파일되는데 못이 통과한다**(내가 M4 팔로 실증). 문자열 부분일치 스캔의 한계다 |
| 정보 | `updater.rs:85`의 `protocol.ts:1074`(phase 유니온)가 **1073**으로 밀렸다. 민 것은 이 갈래가 아니라 **뒤에 온 `698257b`(M10 계약면 뒷정리)**다 |
| 정보 | 적용 뒤 `%TEMP%\AgentCodeGUI3-<ver>-updater-XXXXXX\`가 **안 지워진다**(내가 7개 발견 — 셋은 내 것이라 지웠다). 플러그인 몫이고 실제 크기는 설치기 한 장(2.8 MB) |
| 정보(환경) | **새 격리 홈 하나가 엔진 CLI ~630 MB를 내려받는다**(`engine-auto-update` 기본 on). 다음 라운드는 홈에 `engine-auto-update.json = {"enabled":false}`를 미리 심어라 — 나는 콜드 스타트·이벤트 주행에만 그렇게 했고, 그 앞의 16 주행이 ~10 GB를 받았다 |
| 정보(환경) | **측정 도중 C: 여유가 0이 됐다.** 레포 루트에 지난 라운드들의 `target-*`가 **43개 · ~200 GB** 쌓여 있다(`C:\Code\AgentCodeGUI` 216 GB · `C:\Temp` 241 GB). R1도 같은 자리에서 흔들렸다(그 보고서 §2.8의 ENOSPC). 내 몫은 최대 ~26 GB였고 전부 걷었다 |

---

## 1. 무엇으로 쟀나

### 1.1 트리 · 커밋

* 측정 트리: **`git archive 2af277d`** → `C:\Temp\r28jr2\tree`(레포 밖 격리 사본). 프런트엔드는
  그 트리에서 `npm run app:build`로 **내가 새로 구웠다**(레포의 `app/dist`는 08-26자라 HEAD와 다르다 —
  `diff`로 확인). 레포 `node_modules`는 정션으로만 빌려 썼다.
* **라운드 도중 HEAD가 움직였다**: 시작 `2af277d` → 끝 `eb60067`(남의 커밋 셋 — `db88c41` PoC 스크립트 ·
  `1d28e4a` 크리틱 프로브 둘을 추적으로 승격 + gitignore · `eb60067` 크리틱 산출물 145개).
  **제품 소스는 한 글자도 안 바뀌었다** — `git diff --name-only 2af277d..HEAD -- src-tauri crates app src`의
  결과가 `crates/ccg-engine/tests/probe_w{fire_crit,fr2}.rs` 둘뿐이다. 그래서 아래 수치는 새 HEAD에도 유효하다.

### 1.2 내가 구운 exe (전부 **새** `CARGO_TARGET_DIR` · 남의 target 재활용 0)

| 이름 | 빌드 | 크기(B) | sha256 | 쓴 곳 |
|---|---|---|---|---|
| **EXE-R**(출하 팔) | `cargo build --release --features custom-protocol`<br>`CARGO_TARGET_DIR=C:/Temp/r28jr2/t-rel` | **7,067,136** | `95e042028bd06381c52313a39af71490c50eada82715a93ca8ac6907e6d78f1c` | 원시 채널 · https 강제 · 출하 엔드포인트 · 콜드 스타트 · 번들 |
| **EXE-DA**(로컬 피드 팔) | 같은 명령 + `--config profile.release.debug-assertions=true` · `t-da` | **7,350,784** | `dabd0884bd31e61757a29157c2dddf9d17bd538b998bd636de9b42ba670e5e03` | 카드 전 흐름 · 오류 넷 · 종료 실측 · 이벤트 6종 |
| **EXE-DEV**(개발 팔) | `cargo build --release` (**`custom-protocol` 없음**) · `t-dev` | **6,558,720** | `887719ce803bd20fc10336ea1296393f2aad77dc51229ba52b981ccc6fcaffe4` | 개발 no-op A/B |
| **EXE-NOUPD**(콜드 스타트 대조군) | EXE-R와 같은 명령 · `main.rs`에서 **`updater::init` 한 줄만 제거**(격리 사본 `mut`) · `t-noupd` | **7,065,088** | (측정 뒤 target 삭제 — 크기만 남긴다) | 「업데이터가 부팅을 늦추는가」의 **인과 A/B** |
| 번들(서명) | `npm run tauri:bundle` · `CARGO_TARGET_DIR=t-rel` | setup.exe **2,797,543** + `.sig` **436** | — | §6 서명 실검증 |
| 번들(unsigned 팔) | `node scripts/tauri-build.mjs bundle --unsigned` | setup.exe **2,798,740** | `63d1ab7a5c82ea3fb9c8168060e9ee9a7762b746d430d5cc4b5c4dbe4135e1c7` | `.sig` **안 나온다**(의도) |

> **왜 EXE-DA가 따로 필요한가**: 순정 릴리즈 exe는 `http://` 피드를 **아예 거절한다**
> (플러그인 `config.rs`의 `#[cfg(not(debug_assertions))]` 게이트). 내가 **EXE-R로 그 거절을 실측**했고
> (§5의 음성 대조 · 피드 히트 **0**), 전 흐름은 **같은 소스·같은 피처에 `debug-assertions`만 켠** 팔로 쟀다.
> 사용자 기계의 **인증서 저장소는 건드리지 않았다**(R1이 모달에 걸렸던 그 길은 시도조차 안 했다).
> **진짜 GitHub 릴리스는 만들지 않았다.**

### 1.3 격리 홈 · 포트

* 홈: `C:\Temp\r28jr2\home-*` · `ev-*` · `cs-*` — **주행마다 새로 파고 주행이 끝나면 지웠다.**
  테스트 홈 `testhome` / `testhome10` / `testhome-mut`.
  사용자 실홈(`%USERPROFILE%\.agentcodegui`)은 **읽지도 않았다.** 이름 기반 kill **0** —
  죽인 것은 내가 스폰한 PID뿐(`taskkill /PID <내 pid> /T /F`).
* CDP: **11301–11305 · 11321–11326 · 11331–11334 · 11340 · 11350 · 11360–11369 · 11370–11372**(전부 11300~).
* 가짜 피드: **11310–11318**(+ **11319** = 일부러 아무도 안 듣는 포트 = 「네트워크 없음」).
  세울 때마다 그 포트가 비어 있는지 확인했고 남의 포트를 뺏은 적은 없다.
* 개발 팔 한 주행에만 **127.0.0.1:5273**(= `devUrl`)에 내 정적 서버를 40초 세웠다 — 그때 사용자의 vite dev
  서버는 **떠 있지 않았다**(먼저 확인했다). 주행 끝에 내렸다.

### 1.4 내가 새로 쓴 계기 (전부 레포 밖 · `C:\Temp\r28jr2\`)

| 파일 | 하는 일 |
|---|---|
| `chanscan.mjs` | 계약면 **독립** 스캐너. `protocol.ts`의 `IPC` 블록을 중괄호 균형으로 잘라 채널을 뽑고, Rust 전수에서 `pub const … &str = "…"` 정의 · **match 팔** · 그 밖의 참조를 갈라 `impl`/`codeRef`/`deadconst`/`missing`으로 분류한다. 감사·빌더 도구는 안 썼다 (★자기 함정 둘을 밟고 고쳤다: 주석 속 중괄호가 블록을 조기 종료 · CRLF 때문에 `$`가 안 물려 후행 주석이 있는 줄 156개가 통째로 안 세어졌다 — 둘 다 고친 뒤의 값이 아래 표다) |
| `rawprobe.mjs` | 같은 질문을 **다른 방법으로** — 뜬 exe에 `__TAURI_INTERNALS__.invoke('ipc_call', …)`을 직접 눌러 `{__unimplemented:true}`인지 본다(양성·음성 대조 포함) |
| `feed.mjs` | 로컬 가짜 피드(ok / 404 / tamper / old / badjson · 첫 바이트 지연 · 청크 스로틀 · 모든 히트를 UA와 함께 JSONL로) |
| `fake_installer.rs` → `setup-ok.exe` | argv/pid/시각만 적고 끝나는 **가짜 NSIS**(진짜 설치기를 돌리면 사용자 설치본을 건드린다). 8.0 MiB로 패딩한 뒤 **진짜 개인키로 서명**(`npx tauri signer sign`) |
| `sigverify.mjs` | minisign `.sig`를 **손으로 연다** — 알고리즘/키 ID 파싱 → `BLAKE2b-512(원문)` → 원시 32바이트 공개키를 SPKI로 감싸 **Ed25519 검증**. trusted comment 전역 서명도 본다. **개인키는 안 읽는다** |
| `drive.mjs` | CDP 드라이버 — 0.3~0.4초마다 **화면**(`.upd`의 클래스 · **계산된** opacity/pointer-events · 문구 · 게이지 폭 · 버튼)과 **셸**(`app:update-status`)을 같이 찍어 변화만 타임라인에 남기고, 지정한 phase에서 버튼을 누른다 |
| `eventprobe.mjs` | `app:update-event`가 **정말 방출되는지**를 제품 자신의 구독 경로(`window.api.app.onUpdateEvent`)로 조회 시각(5초) 전에 낚는다 |
| `quitprobe.mjs` | 「받아둔 채 진짜로 종료」 — X(`win:close`) → 트레이 생존 확인 → **첫 숨김 안내 카드(traynotice)의 「완전히 종료」를 그 창에서** 클릭 → 설치기 실행 횟수를 종료 +15초까지 센다 |
| `mutate.mjs` | 못 변이 하네스(M0~M5). 격리 사본 `C:\Temp\r28jr2\mut`에서만 돈다 |
| `coldstart.mjs` | 콜드 스타트 A/B — 두 팔 **번갈아** 14회 · 홈은 매 반복 새로 · 엔진 자동 설치는 **양쪽 다 끄고** |
| `show.mjs` | 주행 JSON 요약 출력기 |

---

## 2. 체크리스트 아홉 축 — 실측표

| # | 축 | 판정 | 핵심 수치 |
|---|---|---|---|
| ① | 세 채널이 미구현 표식이 아닌가 | **닫힘** | 내 스캐너 `total 212 · impl 174 · codeRef 32 · deadconst 0 · **missing 6**` · 원시 호출 11칸(양성·음성 대조 포함) |
| ② | 패키징 빌드에서 카드가 **진짜 경로로** 뜨는가 | **닫힘** | 시드 0 · `class="upd show"` · **계산된 opacity 1** · `pointer-events:auto` · 게이지 6%→98% → 「바로 적용돼요」 + 버튼 둘 → 클릭 시 받아둔 바이트가 **진짜 실행**(`/P /R /UPDATE /ARGS`) · 앱 exit 0 (클릭 +312 ms 이내) |
| ③ | 종료 시 자동 설치가 꺼져 있는가 | **닫힘 · 못도 닫힘** | 실측: 받아둔 채 X→트레이→「완전히 종료」 → 설치기 **0회**, +15초에도 **0회** · 변이: **M1·M2·M3 전부 붉음**(M0 초록) |
| ④ | 개발 실행 no-op | **닫힘** | 개발 팔 35초: phase `idle` **하나뿐** · 카드 0 · **피드 히트 0** · `[updater]` stderr **0** (같은 피드 패키징 대조 팔은 히트 2) |
| ⑤ | 오류 경로가 화면에 | **부분**(R1과 동일 · 회귀 아님) | 서명 불일치 → **카드 뜸**. 네트워크 없음 · 404 → 상태·로그·stderr에만 |
| ⑥ | 서명 검증이 **진짜**인가 · 키 유출 | **닫힘** | 릴리스 `.sig` → **Ed25519 검증 true**(출하 공개키) · 음성 대조 둘(1바이트 변조 → false · 다른 프로젝트 키 → 키 ID 불일치 + false) · 히스토리에 개인키 **0건** |
| ⑦ | 2.6.2와 의미가 같은가 | **닫힘** | `UpdateStatus` 키 정확히 `{error,log,percent,phase,version}` · 이벤트 **6종 전부 실제 방출로 관측** · 문구 글자 일치 |
| ⑧ | 무회귀 | **닫힘 · 후퇴 0** | agentcodegui **141**(=기준선) · workspace **761**(+미추적 18 = **779** = 기준선) · 릴리즈 경고 **0**(=기준선) · typecheck 3/3 · 10회 **1410/1410** · 콜드 스타트 **458 vs 454 ms** |
| ⑨ | 외부 행위 0 | **닫힘**(GET은 적는다) | push **0**(미푸시 163) · `v3*` 태그 **0** · 릴리스 생성/삭제 **0** · GET: GitHub 매니페스트 **1회** + 앱 자신의 엔진 부팅 자동 설치가 npm 레지스트리에서 받은 것(§9) |

---

## 3. ★핵심 — 못이 진짜 종료 문을 지키는가 (R1 §3.2의 재판)

### 3.1 변이 실증 — **다섯 팔**

격리 사본 `C:\Temp\r28jr2\mut`(= `git archive HEAD`)에서만 했다. **레포 `src-tauri/src/tray.rs`·`main.rs`는
처음부터 끝까지 안 건드렸다**(`git status` 추적 변경 0으로 확인).
명령은 매 팔 동일: `cargo test -p agentcodegui --bin agentcodegui install_is_never_wired_to_exit`
(`CARGO_TARGET_DIR=C:/Temp/r28jr2/t-mut`).

| 팔 | 심은 것 | 컴파일 | **못** |
|---|---|---|---|
| **M0** | (변이 없음 · 대조군) | ✅ | **초록** `1 passed` |
| **M1** | `tray.rs::quit()`에 `crate::updater::install(app);` — **R1이 심었던 바로 그 한 줄** | ✅ | **붉음** — `assertion left == right failed: 설치를 부르는 파일이 카드 한 곳이 아니다` (`updater.rs:620`) |
| **M2** | `main.rs`의 `RunEvent::ExitRequested` 정상 종료 팔에 같은 호출 | ✅ | **붉음**(같은 단언) |
| **M3** | `tray.rs::quit()`에 `use crate::updater::install as autoinstall; autoinstall(app);` (별칭 회피) | ✅ | **붉음**(같은 단언) |
| **M4** | `tray.rs::quit()`에 `crate :: updater :: install(app);` (**`::` 둘레에 공백**) | ✅ (`Compiling agentcodegui` 확인) | **초록** ← **여기가 남은 구멍** |

**R1이 실패시킨 그 자리는 닫혔다.** 못은 이제 파일을 고르지 않고 `CARGO_MANIFEST_DIR/src`를 **실행 시각에
전수로 걸어** `updater::install`을 부르는 **파일 집합**이 `ipc/app_meta.rs` 하나임을 박는다. 못이 엉뚱한
트리를 본 게 아닌지도 스스로 확인한다(`main.rs`의 `RunEvent::ExitRequested` · `tray.rs`의 `app.exit(0)`가
거기 있어야 통과 · 파일 수 ≥ 10).

**남은 구멍(정보)**: 판정이 **문자열 부분일치**라 경로에 공백을 넣으면 비껴간다(M4). 실제로 그렇게 쓸 이유는
없지만, 「어느 파일에 심어도 못이 먼저 부러진다」는 주석의 문장은 **글자 그대로는 참이 아니다.**
값싼 보강: `updater\s*::\s*install` 같은 공백 허용 판정, 또는 `install` 함수 자체를 `pub(in crate::ipc)`로 좁히기.

### 3.2 실측 — 받아둔 채 **진짜로** 종료

`quitprobe.mjs` · **EXE-DA** · 홈 `home-quit` · 로컬 피드 `http://127.0.0.1:11310/latest.json`(v9.9.9 · 8.0 MiB).

| t(ms) | 한 일 | 프로세스 | **설치기 실행 횟수** |
|---|---|---|---|
| 11,258 | `phase:"downloaded"` 도달(설치본을 들고 있다) | 살아 있음 | **0** |
| 11,311 | **X** = `window.api.win.close()`(= `win:close`) | | |
| 14,321 | X +3초 | **살아 있음**(트레이로 숨었다) | **0** |
| 14,345 | 첫 숨김 안내 카드 발견 — 「앱이 트레이에서 계속 실행돼요 — 눌러서 다시 열기 / **완전히 종료**」 → **그 창에서 클릭** | | |
| 14,601 | | **사망 · exit 0** | **0** |
| 19,631 / 24,675 / 29,703 | 종료 +5 / +10 / **+15초** | 사망 | **0 / 0 / 0** |

부수로 무회귀 두 칸이 같이 확인됐다: **X = 트레이 숨김** · **안내 카드에서 완전히 종료**.
그리고 **디스크에 아무것도 안 남는다** — 「업데이트」를 누른 주행만 `%TEMP%`에 추출본을 만들었고,
종료 주행은 추출 자체가 없다.

---

## 4. ①②④⑦ — 화면과 배선

### 4.1 ① 계약면 — **missing 6**(감사 기준선 10 → 6)

내 스캐너(`2af277d` 트리 · 레포 워킹트리에서도 같은 값):

```
total 212 · impl 174 · codeRef 32 · deadconst 0 · missing 6
missing = ["talk:run","talk:cancel","talk:permission-respond",
           "talk:question-respond","talk:bg-task","talk:event"]
app:update-status  impl(ipc/app_meta.rs)   app:update-check   impl(ipc/app_meta.rs)
app:update-install impl(ipc/app_meta.rs)   app:update-event   codeRef(updater.rs · 방출 전용)
```

R1은 같은 자리에서 `total 216 · missing 6`을 얻었다. **총계가 4 줄어든 것은 UPDATER가 아니라 `698257b`
(M10 계약면 뒷정리)가 `crosstalk:*` 넷을 계약면에서 걷어낸 결과다.** missing 여섯은 그대로 `talk:*`이고
M10 제거 갈래의 몫이다. **감사 기준선 10 → 지금 6**이며, 그 감소분은 UPDATER 3채널(N8)이 아니라
「`crosstalk` 4가 사라지고 `update` 3이 구현됐다」의 합이다.

**원시 호출**(`rawprobe.mjs` · **EXE-R** · 격리 홈):

| 채널 | 돌아온 값 | 판정 |
|---|---|---|
| `app:update-status` | `{"phase":"idle","version":null,"percent":0,"log":[],"error":null}` | 구현 |
| `app:update-check` | `null` | 구현 |
| `app:update-install` | `null` | 구현 |
| `app:update-event` | `{"__unimplemented":true}` | 방출 전용 |
| ★양성 대조 `engine:update-event` | `{"__unimplemented":true}` | **이미 구현된** 방출 전용도 같은 모양 |
| ★양성 대조 `engine:update-status` | `{"active":false,"items":[],…}` | 구현된 조회 채널은 값을 준다 |
| ★양성 대조 `app:get-version` | `"3.0.0-beta.1"` | 구현 |
| ★음성 대조 `talk:run` · `talk:event` · `talk:bg-task` | `{"__unimplemented":true}` | 알려진 missing |
| ★음성 대조 `app:update-nonexistent-xyz`(없는 이름) | `{"__unimplemented":true}` | 디스패처의 기본 팔 |

「방출 전용 채널은 원래 이 모양」이라는 판별은 양성 대조로 확인된다. 그리고 **그 방출이 실제로 일어나는
것은 §4.4에서 제품의 구독 경로로 직접 낚았다** — 「상수만 있고 아무도 안 쏜다」가 아니다.

### 4.2 ② 카드가 뜬다 — **시드 0**

`drive.mjs` · **EXE-DA** · 홈 `home-vis`(새로 판 것) · 로컬 피드 v9.9.9 · **주입·시드 0**.
화면과 셸을 같이 찍은 타임라인(발췌):

| t(ms) | `.upd` class | **계산된** opacity | pointer-events | phase | 화면 |
|---|---|---|---|---|---|
| 1,227 | (요소 없음) | — | — | `idle` | — |
| 6,164 | `upd show` | 0.976(트랜지션 중) | auto | `downloading` | 새 버전이 나왔어요 / `3.0.0-beta.1 → 9.9.9 · 받는 중 — 6%` · 게이지 `6%` |
| 6,980 | `upd show` | **1** | **auto** | `downloading` | … 20% · 게이지 `20%` |
| 9,430 | `upd show` | 1 | auto | `downloading` | … 60% · 게이지 `60%` |
| 11,679 | `upd show` | 1 | auto | `downloading` | … 98% · 게이지 `98%` |
| **12,096** | `upd show` | 1 | auto | **`downloaded`** | **「3.0.0-beta.1 → 9.9.9 · 바로 적용돼요」 + `button.later`(나중에) + `button.go`(업데이트)** |

`available` 단계는 첫 바이트를 4초 늦춘 피드로 따로 잡았다(`run-avail`): **5,308 ms**에 `phase:"available"` ·
카드 뜸 · 게이지 0%. 로그는 5%마다 한 줄로 **21줄 + 앞뒤 안내 3줄 = 24줄**.

**「나중에」**(`run-later`): 클릭 312 ms 뒤 `class="upd"`(=`.show` 빠짐) · **계산된 opacity 0** ·
`pointer-events:none` — DOM은 남고 **화면에서는 사라진다**.

**「업데이트」**(`run-go`): 클릭 11,281 ms → 카드 사라짐 → **11,593 ms에 프로세스 exit 0**.
그리고 받아진 바이트가 **진짜로 실행됐다**:

```
{"pid":18780,"argv":["C:\\Users\\User\\AppData\\Local\\Temp\\AgentCodeGUI3-9.9.9-updater-RDRyRW\\AgentCodeGUI3-9.9.9-installer.exe",
                     "/P","/R","/UPDATE","/ARGS"]}
```

tauri NSIS 템플릿의 `passive` + 재시작 + 업데이트 모드 그대로다.
**감사 R5 §9.1이 「높음」으로 매긴 `N8`(앱 안에 갱신 통로가 0)은 내 손에서도 더 이상 사실이 아니다.**

### 4.3 ④ 개발 실행 no-op — **완전한 0**

| 팔 | exe | `location.href` | 관측된 phase | 카드 | **피드 히트** | stderr `[updater]` |
|---|---|---|---|---|---|---|
| **개발**(`custom-protocol` 없음) | EXE-DEV | `http://localhost:5273/` (내 정적 서버가 `app/dist`를 서빙 → `window.api` 살아 있음) | **`idle` 하나뿐**(35초 내내 상태가 한 번도 안 바뀌었다) | **0** | **0**(요청 로그 파일 자체가 안 생겼다) | **0** |
| **패키징 대조** | EXE-DA | `http://tauri.localhost/` | `idle`→`checking`→`available`→`downloading`→`downloaded` | 뜸 | **2**(`/latest.json` + `/setup.exe`) | 0 |

같은 계기·같은 모양의 피드를 **다른 포트로** 하나씩 주고 히트를 세었다. 개발 팔은 dev 서버가 없을 때도
따로 쟀는데(오류 페이지) 그때도 히트 0 · `[updater]` 0이었다. **가짜 오류 카드가 뜰 자리가 없다.**

### 4.4 ⑦ 2.6.2와 의미가 같은가 — 이벤트 **6종 전부 실제 방출로**

`eventprobe.mjs`가 조회 시각(5초) **전에** `window.api.app.onUpdateEvent`로 붙어 낚은 것이다
(= 카드가 쓰는 바로 그 통로 · `app:update-event`).

| 2.6.2 electron-updater 이벤트 (`src/main/updater.ts`) | 2.6.2 상태·문구 | 3.0에서 **내가 낚은** 방출 | 주행 |
|---|---|---|---|
| `checking-for-update` | `checking` + 「업데이트를 확인하는 중…」 | ✅ `checking` + **같은 문구** (dt 4,733 ms) | ev-ok / ev-none / ev-err |
| `update-available` | `available` + 「새 버전 v{v}을(를) 찾았어요 · 다운로드를 시작합니다」 | ✅ `available` `version:"9.9.9"` + **같은 문구** (dt 4,735) | ev-ok |
| `update-not-available` | `none` + 「이미 최신 버전이에요」 | ✅ `none` + **같은 문구** (피드 버전 1.0.0) | ev-none |
| `download-progress` | `downloading` + `percent` + 5%마다 「다운로드 {p}% · {a} / {b} MB」 | ✅ `downloading` · `percent` 0→100 · **5%마다 21줄 · 같은 서식**(`다운로드 0% · 0.0 / 8.0 MB`) | ev-ok |
| `update-downloaded` | `downloaded` + 「다운로드 완료 · 업데이트 버튼으로 적용할 수 있어요」 | ✅ `downloaded` `percent:100` + **같은 문구** (dt 10,738) | ev-ok |
| `error` | `error` + 사유 + 「업데이트 중 오류가 발생했어요」 | ✅ `error` + `"Could not fetch a valid release JSON from the remote"` + **같은 문구** | ev-err |
| (`idle` 시드) | 마운트 시드 | ✅ `idle` | 전 주행 |

`app:update-status`가 돌려준 객체의 키는 언제나 정확히 **`error, log, percent, phase, version`**
(= `src/shared/protocol.ts:1073` `UpdateStatus`. 추가 필드 0).
그리고 화면 컴포넌트는 **2.6.2와 바이트가 같다** — `diff app/src/components/AppUpdateGate.tsx
src/renderer/src/components/AppUpdateGate.tsx` → **차이 0**(내가 직접 돌렸다).

> 30분 주기 재확인 / `probing` 침묵은 **R1이 37분 주행으로 이미 실측했고**(그 보고서 §2.6),
> 관련 코드(`RECHECK` · `probing` 분기)는 이 라운드의 수정 넷에서 **한 줄도 안 바뀌었다**
> (`4409097`의 Rust 변경은 `#[cfg(test)]` 안과 주석뿐 — 내가 diff로 확인). 그래서 재실측하지 않았다.

---

## 5. ⑤ 오류 경로 — 셋 중 하나만 화면에 (R1과 같은 판정)

| 경우 | 만든 법 | phase | **화면 카드** | 사유가 어디에 |
|---|---|---|---|---|
| **네트워크 없음** | 아무도 안 듣는 포트(`:11319`) | `checking`→`error`(7.5초) | **안 뜸** | 상태 `error:"error sending request for url (http://127.0.0.1:11319/latest.json)"` · 로그 2줄 · stderr 1줄 |
| **피드 404** | 로컬 피드 mode=404 | `checking`→`error`(5.3초) | **안 뜸** | 상태 `error:"Could not fetch a valid release JSON from the remote"` · 로그 2줄 · stderr 1줄 |
| **서명 불일치** | 매니페스트는 **진짜 서명**, 바이트는 **마지막 1바이트만 뒤집어** 보냄 | `downloading`(99%)→`error` | **뜸** — `.uic.err` | 「**업데이트 오류** / **The signature verification failed** / [확인]」 · `version:"9.9.9"` · `percent:100` |
| ★음성 대조: **출하 exe** + `http://` 피드 | **EXE-R** + `CCG_UPDATE_FEED=http://…:11317/latest.json` | `error` | 안 뜸 | ``The configured updater endpoint must use a secure protocol like `https`.`` · **피드 히트 0** — 요청 자체를 안 보낸다 |
| ★출하 설정 그대로 | **EXE-R** · `CCG_UPDATE_FEED` 없음 | `error` | 안 뜸 | `Could not fetch a valid release JSON from the remote` — **진짜 GitHub 엔드포인트에 닿았다**(외부 GET 1회 · §9) |

**서명 검증은 진짜로 작동한다**: 1바이트 바꾼 8 MiB를 **99%까지 받아 놓고도** 바이트를 안 돌려주고
카드에 사유를 띄운다. 「받아둔 파일 바꿔치기 = 임의 코드 설치」가 막히는 자리를 실측으로 봤다.

**「조회 실패는 카드를 안 띄운다」는 회귀가 아니다** — 카드 조건 `phase==='error' && version != null`
(`AppUpdateGate.tsx:47-48`)은 **2.6.2와 바이트가 같은 컴포넌트**가 정한 규칙이다. 빌더도 §11.3에서
「고치지 않고 장부에 박는다」로 답했고 나도 동의한다. 다만 **그 장부(`renderer-divergence.md`)에 아직 안
들어갔다**(§7.1). **판정: 파리티 합격 · 사용자 관점 미해결 · 그리고 장부 미기재.**

---

## 6. ⑥ 서명이 **진짜 우리 공개키로 열리는가** + 빌드 파이프라인

### 6.1 빌드 래퍼(`51446c6`) — 네 팔 전부 내 손에서 재현

| 팔 | 명령 | 종료 코드 | 걸린 시간 | 산출물 |
|---|---|---|---|---|
| 키 없음 | `CCG_UPDATER_KEY=<없는 경로> npm run tauri:bundle` | **1** | **366 ms** — `Compiling`/`Finished` 줄 **0개**(=**cargo를 아예 안 켰다**) | 없음 · 무엇을 해야 하는지 세 갈래로 안내 |
| 키 있음 | `npm run tauri:bundle` | **0** | 4.9 s(번들만) | setup.exe **2,797,543 B** + `.sig` **436 B** |
| `--unsigned` | `node scripts/tauri-build.mjs bundle --unsigned` | **0** | — | setup.exe **2,798,740 B** · **`.sig` 없음**(의도) + 「릴리스에 올리지 마라」 경고 |
| 문서 | `docs/HANDOFF-3.0.md:119-127` · `src-tauri/Cargo.toml`의 빌드 주석 | — | — | **둘 다 새 조건을 적고 있다**(R1 §3.1이 「한 줄도 없다」고 한 자리) |

> 재현 중 한 가지: `npm run tauri:bundle`은 `mainBinaryName`대로 `<target>/release/**AgentCodeGUI3.exe**`를
> 찾는다. 수동 `cargo build`는 `agentcodegui.exe`를 만들므로(레포 규약대로) 번들만 따로 돌리려면 그 이름으로
> 하나 놓아야 한다(`tauri build`는 스스로 rename한다). 결함이 아니라 사용법이고, 나는 그렇게 해서 위 값을 얻었다.

### 6.2 「`.sig`가 나온다」가 아니라 **열리는가** — 내가 다시 계산했다

`sigverify.mjs`(레포 밖 · 개인키 안 읽음)로 **릴리스 산출물 그 자체**를 검사했다:

```json
{ "artifact": "…/AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe",
  "artifactBytes": 2797543,
  "pubComment": "untrusted comment: minisign public key: E6F4DF7236E55E46",
  "pubKeyIdHex": "465ee53672dff4e6", "sigKeyIdHex": "465ee53672dff4e6", "keyIdMatch": true,
  "sigAlg": "ED", "message": "BLAKE2b-512(artifact)",
  "ed25519Verify": true, "trustedCommentVerify": true }
```

| 검사 | 결과 |
|---|---|
| `tauri.conf.json`의 `pubkey` == `~/.tauri/agentcodegui3-updater.key.pub` **파일 내용** | **문자열 그대로 동일**(둘 다 152자) — `b97dc8e`의 주장 ① 참 |
| 서명 키 ID == 공개키 키 ID | `465ee53672dff4e6` = `465ee53672dff4e6` |
| **Ed25519 검증**(출하 공개키 · 내 계산) | **true** · trusted comment 전역 서명도 **true** |
| ★음성 대조 A: 설치기 **마지막 1바이트만** 뒤집고 같은 검증 | **false**(키 ID는 그대로 일치) |
| ★음성 대조 B: **다른 프로젝트 키**(`~/.tauri/agentmonitoring.key`)로 서명하고 같은 검증 | 키 ID `a5925276d5e5bf15` ≠ `465ee53672dff4e6` → **keyIdMatch false · 검증 false** |

음성 대조 B가 `b97dc8e`가 걱정한 바로 그 고장(래퍼가 엉뚱한 키를 골라도 `.sig`는 나온다)을 재현한다.
`~/.tauri`에 실제로 **키 쌍이 세 벌** 있다(`agentcodegui3-updater` · `agentmonitoring` · `rookiss-workspace`).
지금 래퍼는 올바른 하나를 고른다.

### 6.3 개인키·토큰 유출

| 검사 | 결과 |
|---|---|
| `git log --all -S"rsign encrypted secret key"` / `"BEGIN PRIVATE KEY"` | **0 커밋** |
| `git log --all --diff-filter=A -- "*.key" "*.pem" "*.pfx" "*.p12" "*.jks"` | **0건** — 그런 파일이 레포에 들어온 적이 없다 |
| 추적 파일 중 키 파일 | **0건** |
| `tauri.conf.json`의 `pubkey` 디코드 | `untrusted comment: minisign public key: E6F4DF7236E55E46` — **공개키다** |
| `ghp_`/`gho_`/`ghs_`/`github_pat_` (추적 파일 · `git grep`) | **2곳뿐**: ① `docs/critic/r28j-updater-critic-r1.md:255`(R1이 **검색한 패턴 목록** 자체) ② `release.bat:10`의 **플레이스홀더** `ghp_xxxxxxxxxxxxxxxx`(접미사 16자 전부 `x`) — **실토큰 0** |
| 내가 개인키를 쓴 곳 | 가짜 설치기 1개 서명 + 번들 서명(둘 다 **로컬**). 키 **내용을 읽거나 출력한 적 없다**(래퍼도 경로만 넘긴다) |
| ★`git remote` URL | **읽지도 출력하지도 않았다**(함정 10) |

---

## 7. ⑧ 무회귀 — 기준선 대비 후퇴 0

### 7.1 테스트 · 경고 · 타입체크

| 축 | 지시서 기준선 | **내 측정**(`2af277d` 격리 트리 · 깨끗) | 판정 |
|---|---|---|---|
| `cargo test -p agentcodegui` | **141** | **141 passed · 0 failed** | 같음 |
| `cargo test --workspace` | **779** | **761 passed · 0 failed · 13 ignored · exit 0** | **761 + 미추적 프로브 18 = 779** ✅ (그 프로브 둘은 라운드 도중 `1d28e4a`가 추적으로 승격했다 — 새 HEAD에서는 글자 그대로 779) |
| 릴리즈 빌드 경고 | **0** | **0**(EXE-R · EXE-DA · EXE-DEV **세 빌드 전부**) | 같음 (R1 때의 `CROSSTALK_*` 넷은 `698257b`가 걷었다) |
| 크레이트별 | — | agentcodegui **141** · ccg-auth **126** · ccg-engine **232** · ccg-fs **101** · ccg-lsp **59** · ccg-store **85** (합 744) | 실패 0 |
| ★`agentcodegui --bin --features custom-protocol` 기본 병렬 **10회 연속** | — | **141 ×10 = 1410/1410 · 실패 0 · exit 0 ×10** | 후퇴 0 |
| typecheck | 3종 | `typecheck:node` ✅ · `typecheck:web` ✅ · `typecheck:app` ✅ | 초록 |

> **744(크레이트별 합) vs 761(workspace)의 17 차이는 결함이 아니라 피처 통일이다.** 내가 바이너리별로
> 갈라 봤더니 `ccg_auth` 93→103 · `critic_m11r2_token` 0→6 · `critic_m11r2_tls` 0→1 — 워크스페이스 실행이
> `ccg-auth`에 다른 멤버발 피처를 얹어 `#[cfg]`로 잠긴 테스트가 깨어난다. 빌더 보고서 §11.6이 같은 자리를
> 「크리틱의 크레이트별 값이 통합 테스트 셋을 빼고 세어졌다」로 설명했는데, **진짜 원인은 피처 통일**이다
> (같은 트리에서 두 방식으로 돌려 바이너리별로 확인했다). 어느 쪽도 결함은 아니고, 기준선 비교는
> **같은 방식끼리** 하면 된다.

### 7.2 ★콜드 스타트 — 인과 A/B

R1은 「업데이터 이전 커밋」과 비교했는데, 그 사이에 M10 제거 등이 끼어 이제 그 대조군은 이 질문의 답이
아니다. 그래서 **같은 소스에서 `main.rs`의 `updater::init(app.handle());` 한 줄만 뺀 exe**를 새로 구워
번갈아 쟀다. 잣대는 두 팔 동일 — spawn → `#root`에 자식이 생긴 순간. 홈은 매 반복 새로 파고 엔진 자동
설치는 **양쪽 다 껐다**.

| 팔 | n | **median** | min | max |
|---|---|---|---|---|
| **updater ON**(EXE-R) | 14 | **458 ms** | 379 | 1350 |
| **updater OFF**(`updater::init` 제거) | 14 | **454 ms** | 394 | 931 |

**차이 +4 ms — 잡음 안이다**(같은 팔 안의 산포가 379~1350 ms). 구조로도 그렇다: `init`은 스레드 하나를
띄우고 **5초를 자고** 첫 조회를 하므로 임계 경로 밖이고, 내 모든 주행에서 `checking`은 **4.73~5.35초**에
왔다(마운트보다 10배 늦다). **업데이터는 부팅을 늦추지도 막지도 않는다.**

### 7.3 트레이 · X = 숨김

§3.2의 종료 실측이 그대로 무회귀 증거다: X → **앱 생존 + 트레이 숨김** → 첫 숨김 안내 카드
(「앱이 트레이에서 계속 실행돼요 — 눌러서 다시 열기 / 완전히 종료」) → 클릭 → **정상 종료 exit 0**.

---

## 8. 남은 결함 — 등급 · 재현 절차

### 8.1 【낮음】 장부(`renderer-divergence.md` §6.12)가 **아직 안 옮겨졌다**

R1이 §3.3~§3.7로 남긴 것 중 **코드로 고칠 것은 다 고쳐졌다.** 남은 것은 **장부 이전**인데,
빌더는 §11.9에서 「이 라운드는 그 파일을 못 만졌다 · 다음 갈래가 넣어 달라」로 명시적으로 넘겼다.
**정직한 넘김이지만, 넘겨진 것은 아직 아무도 안 받았다.**

현재 상태(내가 HEAD에서 확인):

| 넣어야 할 것(§11.9) | 지금 |
|---|---|
| 1. `App.tsx:2670` → **2651** | `renderer-divergence.md:927`이 **여전히 `App.tsx:2670`**(실제 2651) |
| 2. 「알면서 다르게 한 것」에 ③ `CCG_UPDATE_FEED` | **없다** |
| 3. ①(세션 메모리)에 실측값(PV +14.3 MB / WS +9.3 MB · 실제 설치기 2.8 MB · 실행마다 다시 받음) | **없다** |
| 4. 「조회 단계 실패는 화면에 아무 흔적이 없다」 | **없다**(§6.12의 오류 규칙 문단은 `AppUpdateGate.tsx:47-48`을 정확히 가리키지만 이 성질은 안 적혀 있다) |
| 5. 빌드 절차가 이제 서명 개인키를 요구한다 | **없다**(`HANDOFF-3.0.md`·`Cargo.toml`에는 있다) |

**★미룬 사유가 지금은 사라졌다.** §11.9는 「다른 갈래(R28L)의 미커밋 hunk가 같은 파일 §6.13에 살아 있어
`git commit --only`가 그걸 삼킨다」를 이유로 들었는데, **지금 HEAD의 워킹트리는 추적 변경 0이다**
(`git status --porcelain | grep -v '^??'` → 빈 결과). 즉 그 파일은 **지금 안전하게 커밋할 수 있다.**

**재현**: `grep -n "App.tsx:" docs/renderer-divergence.md` → `927:… App.tsx:2670 …` ·
`grep -n "<AppUpdateGate" app/src/App.tsx` → `2651`.

### 8.2 【정보】 못을 비껴가는 **공백 하나**

§3.1의 M4. `crate :: updater :: install(app);`은 컴파일되는데 못이 통과한다.
**재현**: `git archive HEAD` 사본에서 `tray.rs`의 `fn quit` 첫 줄 뒤에 그 한 줄을 넣고
`cargo test -p agentcodegui --bin agentcodegui install_is_never_wired_to_exit` → `1 passed`.
**고칠 자리**: 판정을 `updater\s*::\s*install`(또는 공백 제거 후 비교)로. 한 줄이다.

### 8.3 【정보】 `updater.rs:85`의 `protocol.ts:1074` — 실제 **1073**

민 것은 이 갈래가 아니라 **뒤에 온 `698257b`**(M10 계약면 뒷정리)다. R1은 이 좌표를 「정확했다」고 적었고
그때는 맞았다. 지금은 1 밀렸다.
**재현**: `grep -n "phase: 'idle'" src/shared/protocol.ts` → `1073`.
(같이 확인한 나머지 좌표는 **전부 맞다**: `App.tsx:2651` ✅ · `AppUpdateGate.tsx:47-48`(`const active`) ✅ ·
`:38`(`setDismissed(false)`) ✅ · `:48`(카드 조건) ✅ · `:108`(설치 버튼) ✅.)

### 8.4 【정보】 적용 뒤 `%TEMP%` 추출 디렉터리가 안 지워진다

「업데이트」를 누르면 플러그인이 `%TEMP%\AgentCodeGUI3-<ver>-updater-XXXXXX\<app>-<ver>-installer.exe`로
풀고 실행하는데, **그 디렉터리가 남는다.** 내가 7개를 발견했다(셋은 오늘 내 것이라 지웠고, 넷은
08-26자 남의 것이라 뒀다). 실제 크기는 설치기 한 장(2.8 MB)이고 플러그인 몫이라 등급은 정보다.
**재현**: 「업데이트」 클릭 주행 뒤 `ls %LOCALAPPDATA%\Temp\AgentCodeGUI3-*-updater-*`.

### 8.5 【정보 · 환경】 새 격리 홈 하나가 **엔진 CLI ~630 MB**를 받는다

내 홈 하나를 뜯어보니 `codex-engines` **385 MB** + `engines` **244 MB**였다. 부팅 자동 설치
(`engine::boot_update` → `npm view`/설치)가 기본 on이라 **주행마다 새로 받는다.**
UPDATER 축의 결함은 아니지만 **크리틱 계기의 비용**이고, 실제로 이번 라운드가 그 때문에 ~10 GB를
내려받고 디스크를 태웠다. **다음 라운드는 홈에 `engine-auto-update.json = {"enabled":false}`를 먼저
쓰고 앱을 띄워라**(내가 콜드 스타트·이벤트 주행에서 그렇게 했고, 홈이 수 MB로 줄었다).

### 8.6 【정보 · 환경】 ★C: 여유가 0이 됐다 — 레포에 `target-*`가 43개

측정 도중 C:가 가득 찼다(빌드 셋이 「지정된 경로를 찾을 수 없습니다」로 죽어서 알았다).
그 자리에서 내 target 둘을 지워 되살렸고, 라운드 끝에 내 것을 **전부** 걷었다.

| 자리 | 크기 | 비고 |
|---|---|---|
| `C:\Code\AgentCodeGUI` | **216 GB** | 이 중 `target-*` **43개 ≈ 200 GB**(08-25~08-28 라운드들의 잔여 · 전부 gitignore) |
| `C:\Temp` | **241 GB** | 지난 라운드들의 격리 트리·target(`ccg-r28j-upd` 33.7 GB · `ccg-r28f-shipcrit2` 21.0 GB …) |
| 내 몫 | 최대 **~26 GB** | target 6개 + 격리 홈 16개. **끝나고 전부 삭제**(남긴 것은 계기·주행 JSON·exe 사본 3개 = 수십 MB) |

R1도 같은 자리에서 흔들렸다(그 보고서 §2.8의 ENOSPC). **라운드마다 target을 새로 파는 규율은 옳지만,
끝난 라운드의 것을 걷는 규율이 없다.** 리드 판단이 필요하다.

---

## 9. ⑨ 외부 행위 — 쓰기 0 · GET은 적는다

| 검사 | 결과 |
|---|---|
| `git push` | **0**. `git rev-list --count origin/feature/3.0.0-beta..HEAD` = **163**(이 브랜치는 원격에 한 번도 안 올라갔다) |
| 태그 | `git tag -l "v3*"` = **0개**. 내가 만든 태그 0 |
| 릴리스 생성/삭제 · 원격 API 쓰기 | **0**. `gh` 명령 자체를 안 썼다 |
| 브랜치 이동 | **0**. `feature/3.0.0-beta` 그대로(HEAD가 움직인 것은 남의 커밋 셋 때문이다 — §1.1) |
| **외부 GET ①** | `https://github.com/UnrealFactory/AgentCodeGUI/releases/latest/download/latest.json` **1회** — EXE-R를 `CCG_UPDATE_FEED` 없이 띄운 주행(`run-smoke`)이 출하 설정 그대로 조회했다. 응답은 실패(`Could not fetch a valid release JSON from the remote`) |
| **외부 GET ②** | **앱 자신의 엔진 부팅 자동 설치**가 npm 레지스트리에서 Claude/Codex CLI를 받았다 — 격리 홈 **약 16개 × ~630 MB ≈ 10 GB**. 내가 의도한 통신은 아니지만 **내 주행이 유발한 것이라 여기 적는다**(§8.5). 전부 읽기다 |
| 로컬만 쓴 것 | 가짜 피드 서버 9개(11310–11318) · 정적 서버 1개(5273, 40초) · `npx tauri signer sign` 2회(로컬 서명) |

---

## 10. 내가 만진 것

* **레포 코드 수정 0.** 커밋하는 것은 **이 파일 한 장**뿐(`docs/critic/r28j-updater-critic-r2.md`),
  `git commit --only`로 건다. 동결 구역(`src/main`·`src/preload`·`src/renderer`·`out/`·`dist/`)은
  **읽기만** 했다(2.6.2 `updater.ts` 대조 · `AppUpdateGate.tsx` 바이트 비교).
* 못 변이(§3.1)와 콜드 스타트 대조군(§7.2)은 **레포가 아니라** `C:\Temp\r28jr2\mut`
  (`git archive HEAD` 사본)에서만 했고 매 팔 원복했다. 레포 `src-tauri/src/tray.rs`·`main.rs`는
  **처음부터 안 건드렸다**(`git status` 추적 변경 0으로 확인).
* 프런트엔드 빌드도 **격리 트리 안**에서 했다 — 레포의 `app/dist`는 안 덮었다.
  (레포 `node_modules`는 정션으로 **읽기** 위해 빌려 썼다. vite가 `node_modules/.vite` 캐시를
  건드렸을 수 있는데 그건 추적 대상이 아니다.)
* 기준 결과 파일(`bench/results/*` · `bench/shots/*/report.json` · `docs/critic/*.json`)은
  **하나도 안 덮었다.** 내 계기 출력은 전부 `C:\Temp\r28jr2\`에 있다.
* 새로 만든 것(레포 밖 · 미커밋): `chanscan.mjs` · `rawprobe.mjs` · `feed.mjs` · `static.mjs` ·
  `drive.mjs` · `eventprobe.mjs` · `quitprobe.mjs` · `mutate.mjs` · `coldstart.mjs` · `show.mjs` ·
  `sigverify.mjs` · `fake_installer.rs`(→ `setup-ok.exe` + `.sig`) · 주행 JSON(`run-*.json` ·
  `ev-*.json` · `coldstart.json` · `rawprobe.json` · `quitprobe.json`) · 격리 트리 `tree`/`mut` ·
  exe 사본 3개.
* target: `t-rel` · `t-da` · `t-dev` · `t-test` · `t-test-cp` · `t-mut` · `t-noupd`
  (**전부 새 디렉터리 · 남의 target은 하나도 안 썼다**). **측정이 끝나고 전부 삭제했다**(§8.6).
* 사용자 기계: 이름 기반 kill **0**(내가 스폰한 PID만) · 실홈 `accounts/`·`codex-accounts.json`
  **읽지도 않음** · 인증서 저장소 변경 **0** · 남의 미커밋 변경에 `reset`/`checkout`/`stash`/`restore`
  **0** · `%TEMP%`에서 지운 것은 **오늘 내 주행이 만든 셋**뿐이다.
* 개인키: **내용을 읽거나 출력한 적 없다.** 서명은 `npx tauri signer sign`에 **경로만** 넘겼고,
  검증은 공개키·서명·바이트만으로 계산했다. `git remote` URL은 읽지도 출력하지도 않았다.

---

## 11. 한 줄

**R1이 붉게 칠한 두 자리 — 「진짜 종료 문을 안 보는 못」과 「exit 1로 끝나는 빌드 명령」 — 는 내 손에서
닫혔다.** 못은 내가 다시 심은 그 한 줄에 **진짜로 부러졌고**, 서명은 내가 직접 계산한 Ed25519로 **열렸다**.
남은 것은 코드가 아니라 **장부 한 절**이고, 그 장부를 막고 있던 사유는 지금 없다.
