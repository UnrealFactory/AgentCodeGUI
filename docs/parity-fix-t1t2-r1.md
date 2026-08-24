# 최종 파리티 T1·T2 배선 R1 — 「새 사용자가 3.0을 시작할 수 있다」

> 근거 문서: `docs/critic/final-parity-r1.md` §3.1 (치명 T1·T2)
> 코드: `crates/ccg-engine/src/versions.rs` · `src-tauri/src/engine/versions.rs` ·
> `src-tauri/src/ipc/accounts.rs`
> 실증: `scripts/poc-t1t2.mjs` → `docs/critic/t1t2-r1.json`

---

## 0. 무엇이 문제였나

감사가 잡은 두 치명은 **같은 문장**으로 요약된다 — *3.0 단독으로는 시작조차 못 한다.*

| # | 감사 실측 | 사용자가 겪는 것 |
|---|---|---|
| **T1** | `auth:login`·`logout`·`set-default-account`·`remove-account`·`reorder-accounts` Rust 핸들러 **0개**. 계정 채널 구현은 읽기 2개뿐 | 설정 ▸ Account의 「＋계정 추가」·「기본으로」·「삭제」가 전부 무반응. **새 사용자는 로그인할 방법이 없다**(2.6.2 홈 승계로만 사용) |
| **T2** | `engine:list-available`·`install`·`uninstall`·`set-active`·`cleanup` 전부 미구현(`engine:state`만 있음). Codex 쪽은 구현됨 = **비대칭** | CLI 없는 컴퓨터에서 **아무 안내도 안 뜬다**(A/B `engine-gate-prompt` 실패). 설정 ▸ Engine 버튼 전부 무반응 |

심(shim)이 안전값을 돌려주니 크래시는 없었다. 대신 **조용했다.**

---

## 1. T2 — 엔진 CLI 버전 관리

### 1.1 알맹이를 두 엔진 공용으로 합쳤다

2.6.2에서도 이 규칙은 **파일 두 벌**이었다(`src/main/engine/versions.ts` ↔
`src/main/codex/versions.ts`). 문자열 셋만 다르고 나머지는 같다. 합친 이유는 DRY가 아니라
**어긋남**이다 — 실제로 `maxRetries: 5`(Windows EPERM 견디기)는 codex 쪽에만 있다가
뒤늦게 옮겨 갔다.

`crates/ccg-engine/src/versions.rs`의 `Spec`이 다른 것만 담는다:

```text
                 package                          engines_dir     config_file
 CLAUDE  @anthropic-ai/claude-agent-sdk           engines         config.json
 CODEX   @openai/codex                            codex-engines   codex-config.json
```

`codex/versions.rs`는 **얇은 위임**만 남았다(공개 API 불변 — 기존 호출부 수정 0).
codex 고유로 남은 것은 둘뿐이다: 경로 상수와 `codex_bin`(플랫폼 패키지 안의 네이티브
실행본 훑기 — Claude 쪽에는 없는 구조다).

### 1.2 실행 파일 고르기를 한 곳으로

`hub.rs::cli_path()`가 `claude.exe`를 고르고 있었는데, 계정 팔이 `claude auth login`을
조립하려면 **같은 실행 파일**을 써야 한다. 경로가 두 곳에 적히면 한쪽만 고쳐지는 순간
"채팅은 도는데 로그인만 안 되는" 상태가 태어난다. `engine/versions.rs::claude_bin()`이
단일 소스가 되고 `cli_path()`는 그걸 부른다.

**판정 규칙은 한 글자도 안 바꿨다.** 일부러 느슨하다 — `config.json`에 적힌 값 +
실행 파일 존재만 본다(`active_version`의 엄격 판정이 아니다). 하네스들이 SDK 패키지
없이 `claude-agent-sdk-win32-x64/claude.exe` 하나만 심기 때문이다
(`scripts/critic-m10-attack.mjs:124`). 엄격하게 바꿨으면 그 하네스가 전부 PATH 폴백으로
조용히 떨어져 **다른 것을 재게 된다**. `engine::versions::tests`가 그 성질을 붙잡는다.

### 1.3 설치 직후 재시작 없이 돈다

`self.cli`는 허브 기동 때 **한 번** 정해졌다. 그러면 미설치 안내 카드로 방금 설치·활성화한
사용자가 앱을 껐다 켤 때까지 PATH 폴백(대개 없음)으로 돈다 = *"설치했는데도 안 된다."*
`Hub::ensure`가 런타임을 새로 만들 때 다시 고른다(작은 JSON 한 번).

### 1.4 블로킹 팔 — M4가 남긴 조각을 같이 닫았다

`npm view`는 8초 상한, `npm install`은 수십 초다. M4는 codex 쪽을 async 워커에서
그대로 막으며 *"블로킹 스레드로 넘기는 것은 `ipc/mod.rs`의 목록 한 줄이라 그쪽 소유"*라고
조각으로 남겼다. Claude 쪽을 붙이면서 그 한 줄을 같이 놓았다 —
`engine::heavy_owns`/`heavy_dispatch`가 두 엔진을 함께 전용 블로킹 풀로 보낸다.
같은 npm 왕복이 엔진에 따라 굶기고 안 굶기는 것이 더 나쁜 비대칭이다.

---

## 2. T1 — 계정 쓰기 5채널

`src-tauri/src/ipc/accounts.rs` 하나. 도메인은 M5가 다 만들어 뒀고 **노출만** 없었다.

### 2.1 지킨 것 셋

1. **실홈 불가침을 타입이 강제한다.** 모든 CLI 명령은 `ccg_auth::verify`가
   `IsolatedConfigDir`로만 조립한다. 그 타입은 앱 홈 밖 경로로 만들어지지 않으므로
   사용자의 `~/.claude`를 향해 `auth logout`(= **되돌릴 수 없는 서버 토큰 해지**)을
   쏠 방법이 코드에 없다.
2. **목록 쓰기는 예외 없이 CAS 경로.** 로그인 편입·로그아웃·기본 계정·순서가 전부
   `ccg_auth::claude::update_store`(flock + 3-way 병합 + compare-and-swap)를 지난다.
   `write_store_file`을 직접 부르는 우회로가 이 파일에 없다.
3. **우리가 스폰한 PID만 죽인다.** 진행 중 로그인 자식 하나를 `LOGIN` 뮤텍스에 들고,
   취소·5분 상한 둘 다 그 핸들로만 죽인다. 이름 기반 kill 없음.

### 2.2 안전핀 하나를 새로 뒀다

`CCG_NO_NET=1`이면 **해지를 생략**한다(로컬 제거는 그대로). 하네스가 이 문을 지나가도
사용자 실계정의 토큰이 서버에서 죽지 않는다. `ccg_auth::net::disabled()`와 같은 키다.

### 2.3 로그인 출력을 줄이 아니라 **청크**로 읽는다

CLI가 URL을 개행 없이 뱉고 사용자를 기다리면 `read_line`은 영영 안 돌아온다 —
그러면 폴백 링크가 화면에 못 닿는다. 4KB 청크로 읽어 첫 `https://`를 뽑는다.

---

## 3. 실측

### 3.1 화면 왕복 — `scripts/poc-t1t2.mjs` (격리 `CCG_HOME` + CDP, **결함 0**)

실계정 0건이다. 계정은 `ccg-auth-probe seed`가 만든 합성이고, 로그인은 새로 만든
**가짜 CLI**(`ccg-fake-claude`, `--features cli`에서만 빌드)로 밟는다 — 진짜 OAuth·브라우저·
토큰 해지 없음.

```
── T1 · 계정 쓰기 5채널 ───────────────────────────────────  26/26
  ✓ t1.list-3 / t1.default-first
  ✓ t1.set-default→배지 이동 · →디스크(defaultEmail)
  ✓ t1.reorder→반환 순서 · →디스크 순서            ["c","b","a"]
  ✓ t1.remove→2건 · →계정 폴더 삭제
  ✓ t1.logout→1건 · →기본이 남은 계정으로 · →CCG_NO_NET에서 해지 생략
  ✓ t1.login→auth:login-url 도착                    107~114ms
  ✓ t1.login-cancel→ok:false · 목록 불변 · 임시 폴더 청소
  ✓ t1.login-success→ok · email · 목록 편입 · 디스크 · 계정 폴더 물질화
  ✓ t1.login-success→임시 폴더 청소(평문 토큰 잔류 금지) · credEnc 저장
  ✓ t1.logout-revoke→해지 명령이 나갔다 · 격리 CONFIG_DIR(앱 홈 안)

── T2 · 엔진 관리 5채널 + 게이트 ─────────────────────────  9/9
  ✓ t2.state→active 없음 · installed 0
  ✓ t2.list-available→latest 0.3.241 · 274개              535~593ms
  ✓ t2.engine-gate-prompt→카드가 떴다 — "Claude 엔진 설치"
  ✓ t2.set-active→미설치 버전 거절(config.json 안 생김)
  ✓ t2.cleanup→removed 0 · kept null
  ✓ t2.codex 대칭 유지 — latest 0.149.1
```

`t1.logout-revoke→격리 CONFIG_DIR`는 가짜 CLI가 남긴 표식의 **내용**이 그때의
`CLAUDE_CONFIG_DIR`이라, 실홈을 향했으면 그 문자열에서 드러난다.

### 3.2 A/B `engine-gate-prompt` — 실패 → **OK**

```
node bench/ab.mjs tauri --only=engine-gate-prompt --tag=t1t2 --exe=target-t1t2/release/agentcodegui.exe
  OK  engine-gate-prompt (boot:no-engines)      (R1: FAIL — .set-dialog .sd-title 0/1)
```

기준 파일은 안 건드렸다(`--tag=t1t2` → `bench/shots/tauri-t1t2/report.json`).
2.6.2 쪽은 R1에서 이미 `OK`라 재주행하지 않았다.

### 3.3 동시 쓰기 — `crates/ccg-auth/tests/t1_list_edit_race.rs` (신규)

R4의 게이트(`m11r4_store_cas.rs`)가 재는 것은 **배경 토큰 회전** 한 문뿐이다. T1이 붙인
것은 **목록 편집**이라 그 문이 아니다. 상대는 같다 — `src/main/auth.ts:124`의 통짜
`fs.writeFileSync` 한 줄(잠금·병합·mtime 검사 없음).

```
이웃 80판(로그인+로그아웃) · 사용자 목록 편집 ~1,400판 · 2회 주행
  영구: 취소된 로그아웃 = 0 · 0        ← 게이트
        유실된 우리 계정 = 0 · 0        ← 게이트
        묻힌 이웃 로그인 = 1 · 4        ← 측정만 (아래)
  잠깐(되살리기 전 창): 로그아웃 0·1 · 로그인 1·4
```

**단정하지 않은 것을 밝힌다.** `cas_edit`의 파묻힌 쓰기 되살리기는 이웃의 **지우기만**
받고 더하기는 안 받는다(`claude.rs`의 `Commit::Buried` 팔 — ABA 때문이다). 비대칭은
의도된 것이고 그 대가가 위 숫자다: **2.6.2가 방금 한 로그인이 3.0의 목록 편집에
영구히 묻힐 수 있다.** 0으로 단정하면 코드가 주지 않는 보증을 게이트가 주장하는 것이라
세기만 한다. 「잠깐」 칸도 사실이다 — 우리 `rename`이 이웃 쓰기를 묻는 순간과 CAS가
되살리는 순간 사이에 창이 있고, 그 안에 파일을 읽으면 취소된 것처럼 보인다.

### 3.4 크레이트별 테스트

| 크레이트 | 전 | 후 | 비고 |
|---|---|---|---|
| `ccg-auth` | 96 | **97** | +1 = `t1_list_edit_race` |
| `ccg-engine` | 191 | **197** | +6 = `versions.rs`(공용 알맹이) |
| `src-tauri`(bin) | 85 (불안정) | **98** (안정) | 내 몫 +5 · 나머지는 T3T4 미커밋분이 같이 컴파일된 것 |

`ccg-store`는 안 건드렸다(76 그대로).

### 3.5 곁가지로 고친 것 — `cargo test`가 실행 방식에 따라 답이 갈렸다

`src-tauri` 테스트가 **병렬 실행에서 1~2개 붉었다**(직렬은 초록). 원인은 `CCG_HOME`
자물쇠가 **한 바이너리 안에 둘**이었다는 것이다: `engine::*`는 `engine/testhome.rs`의
뮤텍스를, 최종 파리티 라운드가 새로 넣은 `ipc/parity/*`는 `ccg_store::testhome`의
뮤텍스를 잡았다. 서로를 안 보니 남이 드롭한 임시 홈을 가리킨 채로 썼다.

```
FAILED. 86 passed; 1 failed   engine::acct_switch::…::the_first_question_is_what_wakes_the_worker
FAILED. 85 passed; 2 failed     └ "accounts.json: 지정된 경로를 찾을 수 없습니다 (os error 3)"
FAILED. 86 passed; 1 failed
ok.     87 passed; 0 failed   ← --test-threads=1
```

`engine/testhome.rs`를 `ccg_store::testhome`의 **재수출**로 줄여 자물쇠를 하나로 만들었다
(함정 규약 4가 말하는 그 단일 증표). 이후 4회 연속 초록.

---

## 4. 안 한 것 / 남은 것

| 항목 | 왜 |
|---|---|
| `engine:install`을 **실제로** 돌리지 않았다 | 네트워크 + 수백 MB + 디스크. 조회·활성·정리·게이트까지만 밟았다. 설치 경로는 codex 쪽에서 M4가 이미 실측한 그 코드다(이제 **같은 함수**다) |
| 실 `claude auth login` | 브라우저 OAuth + 사용자 실계정. 가짜 CLI로 계약면만 밟았다(`bench/screens.mjs:1770`이 같은 이유로 그 화면을 `skip`했다) |
| `codex-auth:*` 쓰기 채널 | T1의 범위가 아니다(감사는 Anthropic 쪽 5채널만 잡았다). Codex 계정 추가·삭제·기본 지정은 **여전히 미구현**이다 — 설정 ▸ Account의 OpenAI 절반이 무반응이라는 뜻이다. 다음 라운드 후보 |
| `engine:auto-update`가 켜져 있을 때의 부팅 게이트(`EngineUpdateGate`) | `engine:update-status`가 여전히 `{active:false}` 고정이다(M1의 의도된 자리). 자동 업데이트가 **기본 켬**이라 실사용 기본 경로에서는 미설치 안내 카드가 아니라 그쪽이 떠야 한다 — 지금은 아무것도 안 뜬다. **T2의 남은 절반** |
| `engine.state.bundled`가 `"unknown"` | 3.0은 SDK를 번들하지 않는다(의도) — 감사 M6과 같은 판정 |

> ★ 위 네 번째 줄이 이 라운드에서 가장 정직하게 남겨야 할 조각이다. `EngineGate`는
> **자동 업데이트가 꺼져 있을 때만** 뜬다(`EngineGate.tsx:30`). 기본값은 켬이므로,
> 설정을 만진 적 없는 새 사용자는 이 카드를 못 본다. A/B 픽스처가 그 값을 끄고 재기 때문에
> `engine-gate-prompt`는 초록이 됐지만, **기본 설정의 새 사용자에게는 아직 안내가 없다.**

---

## 5. 만진 파일

```
crates/ccg-engine/src/versions.rs          (신규) 두 엔진 공용 버전 관리 알맹이
crates/ccg-engine/src/codex/versions.rs           위임으로 축소(공개 API 불변)
crates/ccg-engine/src/lib.rs                      pub mod versions
crates/ccg-auth/src/bin/ccg_fake_claude.rs (신규) 가짜 CLI(--features cli 전용)
crates/ccg-auth/Cargo.toml                        그 바이너리 선언
crates/ccg-auth/tests/t1_list_edit_race.rs (신규) 목록 편집 × 잠금 모르는 이웃
src-tauri/src/engine/versions.rs           (신규) engine:* 5채널 + claude_bin
src-tauri/src/engine/codex_versions.rs            owns() + 블로킹 주석 정정
src-tauri/src/engine/mod.rs                       heavy_owns/heavy_dispatch
src-tauri/src/engine/hub.rs                       cli_path 위임 + ensure에서 재해석
src-tauri/src/engine/testhome.rs                  ccg_store::testhome 재수출(자물쇠 통합)
src-tauri/src/ipc/accounts.rs              (신규) auth:* 쓰기 5채널 + login-cancel
src-tauri/src/ipc/mod.rs                          mod accounts · ch 상수 7 · 블로킹 팔
src-tauri/src/ipc/system.rs                       list_claude_accounts → pub(super)
scripts/poc-t1t2.mjs                       (신규) 실증 하네스
docs/parity-fix-t1t2-r1.md                 (신규) 이 문서
docs/critic/t1t2-r1.json                   (신규) 실증 산출
bench/shots/tauri-t1t2/report.json         (신규) engine-gate-prompt 재주행 기록
.gitignore                                        target-*/ · .poc-home-*/
```

`app/` 렌더러는 **한 글자도 안 고쳤다.** 버튼·호출부·`EngineGate`·`Settings`가 이미 다
있었고, 없던 것은 그 밑의 Rust 핸들러뿐이었다.
