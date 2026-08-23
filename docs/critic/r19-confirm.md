# R19 확인 크리틱 — M7 R2 · M4 R2 · M8 R2

착지한 세 조각(`a6fcdba` M7 LSP R2 · `a6dad11` M4 R2 · `d3c564f` M8 R2)이 **자기 보고서에
적은 수치대로 실물에서 서는지**만 본다. 판정은 전부 빌더가 아니라 크리틱 도구·하네스의
출력이고, 실행은 전부 격리 워크트리다. 자기 채점은 없다 — 이 문서의 모든 숫자는 아래
"증거" 열의 파일에서 그대로 옮긴 것이다.

## 0. 방법 · 경계

| 항목 | 값 |
|---|---|
| 핀 | **`d3c564f`의 코드** (워크트리는 `00d3bad` — `d3c564f`와의 차이는 `progress/data.js` 2줄뿐, 코드 변경 0. `git diff --stat d3c564f 00d3bad`로 확인) |
| 워크트리 | `C:\Users\User\AppData\Local\Temp\ccg-r19c-wt` (detached) |
| 빌드 | `cargo build --release --offline --features custom-protocol -p agentcodegui` · 워크트리 로컬 `target/` (= `%TEMP%` 안) · 테스트용 debug는 `%TEMP%/ccg-r19c-tgtdbg` |
| 기준 바이너리 | `%TEMP%/ccg-r19c-baseA.exe` = 핀 소스 무수정 빌드 스냅샷 (M4·M8·M7 도구는 전부 이것으로 돌렸다) |
| 안전 | 이름 기반 kill **0회**(죽인 것은 내가 spawn한 PID 트리 + 하네스가 알려 준 자식 pid뿐) · `CCG_HOME` 전부 격리 · 실홈 읽기/복사만 · `npm ci` **0회**(`node_modules`는 실 레포 심링크) · 사용자 실앱(PID 24836 계열) 무접촉 |
| 메인 워킹 트리 | **무접촉**. 다른 갈래의 미커밋 작업(M11 `ccg-auth`·M9 `McpSkillView`)은 손대지 않았고, 이 라운드가 메인 레포에 add하는 것은 이 파일 하나뿐이다 |
| 기준 결과 파일 | 크리틱 하네스가 `docs/critic/m4-r1-attack.json`·`m8-r1-attack.json`을 자기 기본 경로로 덮어써서 **`git checkout`으로 복원**했다(워크트리 안에서만 벌어진 일) |

> **직전 라운드 잔여물 처리.** 세션 한도로 죽은 앞 회차가 같은 워크트리에 결과 8개를 남겼다
> (`docs/critic/m7-r19c-*.json` · `m4-r1-codex-r19c.json` · `m8-r1-winsurface-r19c*.json`).
> 검증 없이 쓰지 않았다 — **전부 이번 세션에 다시 돌렸고**(`-r19c2`/`-r19cc`/`-r19cf` 태그),
> 두 회차의 값이 일치하는 것만 아래에 적었다. 앞 회차 파일은 교차 확인용으로만 썼다.

## 1. 판정 요약

| 갈래 | 판정 | 한 줄 |
|---|---|---|
| **M7 R2** | **통과(조건부)** — 제품 게이트 8/8 재현. 다만 **보고서 §R2-7·§게이트의 "캐시 적중 116 대 280 회귀"는 기각**(재현 불가·인과 서술도 틀렸다) | 죽은 서버 30.5초 복귀 · 편집 버퍼 6/6 · config `[null,null]` · race 1×5 |
| **M4 R2** | **통과** — 4/4 재현, 불일치 0 | transcode 23/0 · `CL-1 → th-sw` · notice 1건 · poc-codex 9/9 findings 0 |
| **M8 R2** | **통과** — 소실 0(디스크 포함) 재현. `critic-m8-attack A4-자리` 1건이 붉지만 **크리틱 도구 자신의 좌표 결함**이고 제품 배치는 정상 | X 안내 카드 · 트레이 아이콘 1→0 · en 라벨 2/2 |

## 2. M7 — 재현표

전부 **크리틱 도구 무수정**, 기준 바이너리(`ccg-r19c-baseA.exe`)로 이번 세션에 다시 돌린 값이다.

| 주장(커밋) | 이번 실측 | 증거(워크트리) |
|---|---|---|
| 죽은 서버: `error→starting→ready` · 토큰 30.9s · 재기동 33.3s | **토큰 30.48s · 재기동 32.63s** · `statusesAfterKill=["error","starting","ready"]` · 복귀 전 `ready` 거짓말 **0회**(37표본) | `docs/critic/m7-r19c2-kill-tauri.json` |
| 편집 버퍼 호버·정의 6/6 | **6/6 · 6/6** (디스크 대조군 6/6) | `docs/critic/m7-r19c2-buffer-tauri.json` |
| cwd 표기 3형 전부 기동 1·생존 1 | back/fwd/trail **starts=1 · survived=1 · exits4s=0 · root 1종** | `docs/critic/m7-r19c2-cwdform-{back,fwd,trail}.json` |
| `workspace/configuration` 응답 `[null,null]` | **`result:[null,null]` · `lspContractOk=true`** | `docs/critic/m7-r19c2-drive.json` `scenarios.config` |
| spawnRace 1,1,1,1,1 | **[1,1,1,1,1] · `alwaysTwo=false`** | 같은 파일 `scenarios.spawnRace` |
| dupopen 1 · rangeless 0 · manydocs 400/368 · cache 패닉 0 · death 복귀 | **maxDidOpen 1 · storm2 rangeless 0 · 400/368(empty 0) · 패닉 0/8 · recovered true** | 같은 파일 |

`storm_sync1`의 `rangeless=120`은 **의도된 대조군 팔**이다(sync1 = 전체 문서 치환). 오해 방지로 적어 둔다.

### 2.1 `bench/lsp.mjs` 재주행 — "캐시 적중 116 대 280"은 **재현되지 않는다**

같은 세션·같은 기계에서 `both` 1회 + tauri 6회를 돌렸다(`--out -r19c*`, 기준 결과 파일 무접촉).

| 팔 | cold ready | cold 첫색칠(캐시미스) | **warm 첫색칠(캐시적중)** | warm ready | 캐시호출 첫/p50 |
|---|---|---|---|---|---|
| electron 2.6.2 | 525 | 2228 | **130** | 448 | 4.7 / 4.7 |
| 3.0 boot (A · 기준 exe) | 188 | 714 | **174** | 173 | 12.2 / 5.2 |
| 3.0 boot (B1) | 151 | 534 | **181** | 180 | 11.7 / 6.1 |
| 3.0 boot (B2) | 183 | 663 | **178** | 177 | 15.7 / 5.6 |
| *(커밋이 적은 R2 값)* | *169* | *673* | ***280*** | *280* | *15.3 / 8* |

**캐시 적중 첫 색칠은 6회 주행 전부 174~191ms다. 280은 한 번도 나오지 않았다.**
커밋의 280은 단발 표본의 잡음이고, 거기에 붙인 인과("부팅 프리웜이 앱 기동과 CPU를 나눠
쓰는 거래")도 아래 A/B가 직접 반증한다. 실제 격차는 2.6.2 130 대 3.0 ~178 = **+48ms**이고,
그 자리는 보고서 §R2-9 #4가 이미 정확히 지목한 **첫 IPC 창**이다(`window.api`가 preload가
아니라 번들 실행 뒤에 생긴다). 2.6.2의 cold 수치가 이번에 나쁜 것(525/2228)은 내가 방금
`out/`을 새로 빌드해 페이지 캐시가 차가웠기 때문이다 — warm 열만 비교 대상이다.

**요청**: 보고서 §R2-7과 커밋 메시지의 "캐시적중 첫 색칠은 116 대 280으로 나빠졌다" 한 줄을
정정할 것. 회귀 자체가 없다.

### 2.2 절충 실험 — 프리웜을 `win:mounted` 뒤로 미루면 **ready만 잃고 캐시적중은 안 산다**

`flags.rs`의 인터리브 A/B 규약대로 **같은 바이너리에 레버 하나**(`CCG_PREWARM_AT`)를 파고
팔을 번갈아 돌렸다. 기본값(레버 미지정)은 현행과 동작이 한 글자도 다르지 않다.

| 팔 | 방아쇠 자리 | cold ready | **warm 캐시적중 첫색칠** | warm ready |
|---|---|---|---|---|
| boot (현행) | `main()` 첫 줄 | 151 · 183 · 188 | **181 · 178 · 174** | 180 · 177 · 173 |
| **mounted** | `win:mounted` 뒤 | **481 · 557** | **182 · 191** | 494 · 530 |
| delay:400 | `main()` + 400ms | 428 | 183 | 406 |

- **캐시 적중은 안 움직인다** (174~181 → 182~191, 노이즈 폭 안). 프리웜을 아예 마운트 뒤로
  밀어도 첫 색칠이 안 빨라진다 = **프리웜이 그 자리를 먹고 있던 게 아니다.**
- **ready는 3배 나빠진다** (~180ms → 481~557ms). `mounted` 팔에서는 `warm ready`(494)와
  `warm 캐시적중`(182)이 **완전히 갈라진다** — 이 한 쌍이 결정적이다. 캐시 적중 첫 색칠의
  바닥은 "언제 `window.api`가 생기나"이지 LSP가 아니다.
- `delay:400`도 같다(ready 428, 캐시적중 183). 지연량을 어떻게 잡아도 거래가 성립하지 않는다.

**결론: 절충안 기각.** 현행(`main()` 첫 줄)을 유지하는 것이 맞다. 캐시 적중 +48ms를 줄이려면
프리웜이 아니라 **첫 IPC 창**(§R2-9 #4)을 건드려야 한다.

<details><summary>제안 diff (실험 레버 — <b>채택 비권장</b>, 재측정용으로만)</summary>

워크트리(`ccg-r19c-wt`)에만 있고 메인 레포에는 안 넣었다. 다음 라운드가 같은 질문을 다시
물으면 이 레버로 30분이 아니라 3분에 답할 수 있다.

```diff
--- a/src-tauri/src/ipc/lsp.rs
+++ b/src-tauri/src/ipc/lsp.rs
 pub fn boot_prewarm() {
+    match prewarm_at() {
+        "mounted" => {}                       // 방아쇠를 렌더러 마운트 뒤로
+        m => spawn_prewarm(m.strip_prefix("delay:").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0)),
+    }
+}
+/// `CCG_PREWARM_AT`: (없음)|`boot` = 현행 · `mounted` = win:mounted 뒤 · `delay:<ms>`
+fn prewarm_at() -> &'static str {
+    static V: std::sync::OnceLock<String> = std::sync::OnceLock::new();
+    V.get_or_init(|| std::env::var("CCG_PREWARM_AT").unwrap_or_default()).as_str()
+}
+fn spawn_prewarm(delay_ms: u64) {
     std::thread::Builder::new()
         .name("ccg-lsp-boot".into())
-        .spawn(|| {
+        .spawn(move || {
+            if delay_ms > 0 { std::thread::sleep(std::time::Duration::from_millis(delay_ms)); }
             let Some(cwd) = last_project_cwd() else { return };
             ccg_lsp::prewarm(&cwd);
         })
         .ok();
 }
+pub fn mounted_prewarm() {
+    if prewarm_at() != "mounted" { return }
+    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
+    if ONCE.set(()).is_err() { return }
+    spawn_prewarm(0);
+}

--- a/src-tauri/src/ipc/windows.rs
+++ b/src-tauri/src/ipc/windows.rs
         ch::WIN_MOUNTED => {
             crate::crash::note_mounted(window.label());
+            if window.label() == "main" { crate::ipc::mounted_prewarm(); }
```
(+ `ipc/mod.rs`에 `pub use lsp::mounted_prewarm;` 한 줄)
</details>

## 3. M4 — 재현표

| 주장 | 이번 실측 | 증거 |
|---|---|---|
| `critic-m4-transcode` 23/23 | **23 passed · 0 failed**(도구는 `critic-m4-transcode.rs`와 **바이트 동일** — `diff` 확인) | `cargo test -p ccg-engine --test critic_m4` |
| 엔진 전환 세션 신원 | `claude/CL-1` → **`codex/th-sw`**(spawns 1→2·queued 0) → 되돌림 `claude` · **findings 0** | `critic-m4-attack --only=switch` |
| `system/notification` 이중 팬아웃 제거 | **`{events:1, dom:1}`** | `critic-m4-notice.mjs` |
| poc-codex `--only=app` 9/9 | **9/9 ✓ · findings 0**(engine·session·stream·terminal·todos·fileChange·context·result·persist) | `docs/critic/m4-r1-codex-r19cc.json` |

불일치 0.

## 4. M8 — 재현표

| 주장 | 이번 실측 | 증거 |
|---|---|---|
| 팝아웃 닫기 소실 0(화면+디스크) | **L-end·L-mid 둘 다 grid=disk=[LOSS-ONE,TWO,THREE] · flushReqs 1 · closeMs 171/166** | `docs/critic/m8-r1-winsurface-r19cf.json` |
| X = 숨김 + 첫 안내 카드 | **카드 표시·문구 2행 정확·포커스 탈취 없음·복원 시 소멸·1회성(`noticeShown` true)** | 같은 파일 R6 6항목 |
| 트레이 아이콘 해제 | **`trayIconWindows 1 → 0`** | 같은 파일 R7 |
| S4 `ui.lang` | 메뉴 **["Open AgentCodeGUI","Quit completely"]** · 안내 **["AgentCodeGUI is still running in the tray — click to reopen","Quit completely"]** | 같은 파일 G1/G2 + `critic-m8-attack --only=a7`(A7-언어 ✓) |

### 4.1 유일한 붉음 `A4-자리` — 제품이 아니라 **크리틱 도구**의 결함

앞 회차 실행에서 `critic-m8-attack --only=a4`가 `A4-자리 "10행 카드가 작업 영역을 벗어났다"`로
붉었다(`x=4752, w=360, availW=2560`). 원인은 도구 쪽이다:

```js
out.bounds = { x: window.screenX, …, availW: window.screen.availWidth }
out.onScreen = … && out.bounds.x + out.bounds.w <= out.bounds.availW + 24
```

`screenX`는 **가상 데스크톱 좌표**, `availWidth`는 **그 모니터의 폭**이다. 이 기계는
`DISPLAY2(주, 0..2560)` + `DISPLAY1(보조, 2560..5120)` 2대이고 카드는 보조 모니터의
우하단(오른쪽 끝 5112 ≤ 5120, 아래 끝 1377 ≤ 1392)에 **정확히** 놓였다. 즉 모니터 로컬 환산이
빠진 비교라 보조 모니터에서는 항상 붉다 — **M8 R2가 자기 하네스에서 고쳤다고 적은 T4 증거
결함(`availLeft/availTop` 환산)과 같은 결함이, 손대면 안 되는 크리틱 도구 쪽에 그대로 남아
있는 것**이다. 제품 배치는 같은 회차의 `poc-winsurface R6-포커스탈취없음`이 모니터 로컬 좌표로
직접 확인했다(`x=4776, availLeft=2560, availW=2560` → 로컬 2216+336=2552 ≤ 2560).

**다만 커밋의 "critic-m8-attack A1~A9 findings 0"은 이 기계(모니터 2대)에서는 재현되지
않는다**는 사실 자체는 기록해 둔다. 다음 라운드가 이 도구를 고칠 권한을 가진 쪽에서
`availLeft/availTop` 두 줄을 넣으면 영구히 정리된다.

## 5. 세 보고서 "남은 것" stale 사냥 — **stale 0건**

핀 코드에서 하나씩 확인했다. 전부 **아직 사실**이다(즉 "고쳤는데 남은 것으로 적어 둔" 항목 없음).

| 출처 | 항목 | 확인 |
|---|---|---|
| M7 §R2-9 #1 | `lsp:files-changed`를 쏘는 자리 없음 | 사실 — 상수(`ipc/mod.rs:154`)만 있고 `emit` 0건 |
| M7 §R2-9 #2 | `didChangeConfiguration` 푸시 없음 | 사실 — `crates/ccg-lsp/src` 전체에 문자열 0건 |
| M7 §R2-9 #3 | 프리웜 언어 감지 하드코딩 | 사실 — `lib.rs::detect_project_spec`에 ts/py/cs/cpp 4분기 |
| M7 §R2-9 #4 | 첫 IPC 창 ~230ms | 사실이고 **이번 A/B가 오히려 이 항목을 승격시킨다**(§2.2) |
| M7 §R2-9 #5 | 캐시 쓰기 비원자 | 사실 — `semcache.rs:117` `fs::write`, 손상 파일 자가 삭제 없음(`remove_file`은 `prune`뿐) |
| M4 §R2.7 #1 | 앱 재시작 뒤 엔진 전환(`sessionEngine` 미영속) | 사실 — `sessionEngine`/`session_engine` 문자열 0건 |
| M4 §R2.7 #7 | `ipc/mod.rs`의 `codex-engine:*` 상수 | 사실 — `CODEX_ENGINE_STATE` 그대로 |
| M8 §R2-7 #1 | 설정 › 트레이 스위치 UI 부재 | 사실 — `app/src`에 `closeToTray` 0건 |
| M8 §R2-7 #2 | `crash::teardown_and_exit` 아이콘 미해제 | 사실 — `crash.rs:591` `std::process::exit(0)` |
| M8 §R2-7 #3 | `win:surface-debug` 채널 미잠금 | 사실 — 게이트 없음(`ipc/windows.rs:264~280`) |

## 6. 새 발견 (전부 낮음 — 치명 0)

1. **[문서·중] `ipc/mod.rs`의 `boot_prewarm` 주석이 실제 호출 자리와 다르다.**
   "셸이 **창을 만든 직후** 한 줄로 부른다"고 적혀 있는데 실제 호출은 `main.rs:136`,
   `tauri::Builder`보다 **앞**이다(창 생성 전). `lsp.rs`의 주석은 맞게 적혀 있어 두 주석이
   서로 어긋난다 — 크리틱 §3.2 제안 자리를 그대로 옮겨 적은 흔적으로 보인다.
   §2.2가 보여 주듯 **이 자리가 ready의 전부**라 주석이 틀리면 다음 라운드가 옮긴다.

2. **[증거·낮음] `bench/lsp.mjs`가 `provenance()`를 안 박는다.**
   `bench/lib.mjs`는 `arm`/`bin`/`armEnv`(모든 `CCG_*`)를 결과에 남기는 헬퍼를 갖고 있는데
   `lsp.mjs`는 안 부른다. 그래서 이번 A/B 결과 파일만 봐서는 어느 팔인지 알 수 없다
   (나는 `--out` 접미사와 ready 델타로 갈랐다). 두 줄이면 닫힌다.

3. **[도구·낮음] `critic-m8-attack.mjs` 머리 주석이 A1~A6만 나열**하는데 파일은 A1~A9를
   구현한다(A7 언어·A8 감시목록·A9 메뉴 12회). 커밋이 "A1~A9"라고 쓴 근거는 코드 쪽이 맞다.

4. **[잠재·낮음, 오늘은 재현 불가] `MultiAgent.applyPanelFlush`의 길이 가드는 "짧아지는 편집"을
   영구히 버린다.** `if (f.snapshot && incoming >= live)` — 팝아웃에서 스레드가 **줄어드는**
   조작(되돌리기·메시지 삭제)을 하면 복귀분이 통째로 무시된다. 지금은 패널에 `revert` 알약이
   아예 안 그려져(`MultiAgent.tsx:698` 주석) 도달 경로가 없어 **결함이 아니다.** 다만 통합
   스토어 `chatId` 배선이 패널에 들어오는 순간 곧바로 살아나는 함정이라 적어 둔다 —
   길이 대신 `updatedAt`/세대 비교로 바꾸는 것이 그 자리의 정답이다.

5. **[하네스 함정·기록용] 수동 `cargo build --release`는 `--features custom-protocol` 없이는
   프론트를 안 굽는다** — 릴리스 exe인데 `devUrl`을 로드해 `chrome-error://chromewebdata/`가
   뜨고, 벤치는 `ready=null`로 20분을 태운다(내가 이번에 그대로 밟았다). `src-tauri/Cargo.toml`
   주석이 이미 경고하고 있으니 **하네스 쪽에서** 부팅 직후 `#root` 자식 수 0을 즉시 실패로
   끊어 주는 게 낫다(`bench/lsp.mjs`의 `mounted:false`는 이미 그 신호를 갖고 있는데 180초를
   기다린 뒤에야 쓴다).

## 7. 산출물

메인 레포에 add한 것은 **이 파일 하나**다. 수치의 원본은 전부 워크트리
`C:\Users\User\AppData\Local\Temp\ccg-r19c-wt` 안에 있다:

- `docs/critic/m7-r19c2-{kill-tauri,buffer-tauri,cwdform-back,cwdform-fwd,cwdform-trail,drive}.json`
- `docs/critic/m4-r1-codex-r19cc.json` · `docs/critic/m8-r1-winsurface-r19cf.json`
- `bench/results/lsp-{electron-2.6.2,tauri-3.0.0}-r19cA.json` · `lsp-tauri-3.0.0-r19c{B1,B2,M1,M2,D1}.json`
- 실험 레버 diff: 워크트리의 `src-tauri/src/ipc/{lsp,mod,windows}.rs` 미커밋 변경
