# SLUG R1 — **Claude 엔진이 계정 폴더 이름을 지어내고 있었다**

빌더: SLUG 갈래 · 2026-09-01 · `feature/3.0.0-beta`
과녁: FPS144 크리틱 보조 조사(계기 `docs/critic/tools/critic-fps144-slug.mjs` ·
증거 `docs/critic/evidence/fps144-slug-analysis.json`)

---

## 0. 한 문단 결론

**폴더 이름을 짓는 자리가 둘이었고, 한쪽은 규칙을 몰랐다.**

실물 이름은 `ccg-auth::account_slug()`가 만든다 — 소문자화 → `[a-z0-9._-]` 밖은 `_`
(**연속 구간을 하나로 접음**) → **항상 `-<base36(u32 해시)>` 접미**. 그런데
`ccg-engine::Runtime::account_dir()`은 `@`→`_`·`+`→`-` **두 치환**으로 슬러그를 조립해
`accounts/`를 접두 스캔했다. 해시 접미를 모르니 **정상 이메일에서도 접두 스캔에 기대야
했고**, 빗나가면 **존재하지 않는 경로를 조용히 돌려줬다**. 그 경로가 그대로
`CLAUDE_CONFIG_DIR`로 나가 CLI가 거기 빈 폴더를 파고 「Not logged in」이 됐다.
그리고 그 빈 폴더는 다음 실행부터 **정확 일치**로 먼저 잡혀 영구화됐다.

Codex 축에는 이 고리가 처음부터 있었다 — `CodexDriver::with_home_resolver()`에 셸이
`ccg_auth::codex::account_run_dir`을 꽂는다. **Claude 축에만 그 고리가 없었고**, 그래서
엔진이 모르는 규칙을 혼자 흉내 냈다. 수정은 같은 모양의 고리를 하나 더 놓는 것이다:
이름 짓는 일은 **아는 쪽**(`ccg-auth`)에만 두고, 엔진은 주입받은 함수에 물어본다.

| 자리 | 수정 전 | 수정 후 |
|---|---|---|
| 폴더 이름을 정하는 곳 | `ccg-auth`(진짜) **+ `ccg-engine`(추측)** 둘 | `ccg-auth` **하나** |
| 스폰이 부르는 함수 | 없음(추측 + `read_dir` 접두 스캔) | `ccg_auth::claude::account_run_dir` |
| 자격증명 물질화 | **한 번도 안 했다** | 스폰마다 한다(토큰·신원·공용 정션) |
| 계정을 못 찾았을 때 | 없는 경로를 **조용히** 반환 → CLI가 「Not logged in」 | 그 턴을 **사유가 보이는 오류**로 정착 |
| 리졸버가 없는 세계 | `accounts/<그럴듯한 이름>` (실계정 **옆에** 앉아 오염) | `accounts/_no-resolver/<표식>` (한 층 **아래** — 겹칠 수 없다) |

---

## 1. 무엇을 고쳤나

### 1.1 주입점 (`crates/ccg-engine/src/runtime.rs`)

```rust
pub type AccountResolver =
    Arc<dyn Fn(&str) -> Result<std::path::PathBuf, String> + Send + Sync>;
```

Codex 축의 `HomeResolver`와 **같은 모양**이다. `Err`는 사유 문자열이고, 그 문자열이
그대로 화면에 실린다.

`account_dir()`은 이제 이름을 만들지 않는다. 우선순위 세 칸이 전부다:

| 순위 | 자리 | 무엇 |
|---|---|---|
| 1 | `with_account_dir_override` | 라이브 스모크가 강제한 **단일** 경로(이메일 무관) |
| 2 | `AccountResolver` | 셸이 꽂은 `account_run_dir` — 실물 폴더 + 자격증명 물질화 |
| 3 | `unresolved_account_dir()` | 리졸버 **부재**(단위 테스트·재생 하네스)의 명시 폴백 |

1순위는 **폐기하지 않고 위상만 정리**했다(라이브 스모크가 실홈에 쓰지 않게 하는 강제
장치다). 다만 인자가 이메일을 안 받으므로 계정이 둘 이상인 판에서는 의미가 없다 —
그 사실을 주석에 못 박았다.

3순위는 `accounts/_no-resolver/<이메일표식>` **두 층**이고, 두 조각이 각각 일을 한다:

- `_no-resolver` — 실물 폴더는 언제나 `accounts/<safe>-<base36>` **한 층**이므로, 한 층
  더 들어간 이 경로는 어떤 계정 폴더도 가리거나 흉내 낼 수 없다. 값이 그대로
  `CLAUDE_CONFIG_DIR`에 실려 나가므로 **스폰 인자만 봐도 "셸이 리졸버를 안 꽂았다"가
  읽힌다**(관측 가능한 폴백).
- `<이메일표식>` — **계정이 갈리면 경로도 갈려야 한다**(§4의 회귀가 이걸 가르쳤다).

표식의 모양(`@`→`_`·`+`→`-`)은 옛 추측과 같지만 **하는 일이 다르다**: 찾기 위한
**열쇠가 아니라 이름표**다. 아무도 이 이름으로 `accounts/`를 훑지 않고, 한 층 아래라
실계정과 겹칠 수도 없다. 옛 코드의 죄는 이름의 모양이 아니라 **그 이름으로 실계정
폴더를 찾아다닌 것**이었다.

### 1.2 셸 어댑터 (`src-tauri/src/engine/claude_account.rs`, 신규)

`codex_versions::resolver()`의 Claude 짝이다. 하는 일은 둘:

1. `ccg_auth::claude::account_run_dir(email)` — 폴더를 **물질화**한다
   (`.credentials.json` 신선도 비교 쓰기 · `.claude.json`에 신원 병합 · 공용 상태 정션).
   옛 경로는 이 함수를 **한 번도 안 불렀다**.
2. `AuthError` → **사용자가 읽을 한 줄**로 번역한다. 영어 `Display`는 진단용이라 그대로
   쓰지 않고, 문장에 **다음 행동**을 담는다(설정 어디로 가야 하는가).

| `AuthError` | 화면 문장 |
|---|---|
| `NotRegistered` | 설정 ▸ Account에 등록된 계정이 아니에요(로그인이 필요해요) |
| `Undecryptable` | 저장된 자격증명을 풀지 못했어요 — 다른 사용자·다른 PC의 홈을 옮겨 온 경우예요(다시 로그인해 주세요) |
| `CorruptSnapshot` | 저장된 계정 정보가 깨졌어요(다시 로그인해 주세요) |
| `TokenCollision` | 같은 토큰이 `<다른계정>` 계정으로도 저장돼 있어요(한쪽을 로그아웃해 주세요) |
| `Io` | 계정 폴더를 준비하지 못했어요 (`<사유>`) |

**crate 경계는 유지된다** — `ccg-engine`은 `ccg-auth`를 여전히 모른다.

### 1.3 배선 (`src-tauri/src/engine/hub.rs`)

빌더 사슬에 한 줄:

```rust
.with_account_resolver(super::claude_account::resolver())
```

Codex 축의 `.with_home_resolver(codex_versions::resolver())`와 같은 자리다.

### 1.4 스폰마다 묻는다 (`runtime.rs::t1_spawn`)

리졸버는 **런타임 생성 시가 아니라 스폰 시**에, **큐 항목의 정체성 스냅샷**의 계정으로
불린다(P5 규약). 생성 시 한 번 굳히면 계정을 바꾼 뒤의 예약분이 옛 폴더로 나가고,
재로그인으로 폴더가 갈린 경우도 못 따라간다.

### 1.5 실패는 침묵하지 않는다 (M-LOGIC)

계정 폴더를 못 낸 판은 **프로세스를 아예 띄우지 않는다**. 옛 코드는 없는 경로를 넘겨
CLI를 태웠고, 사용자가 본 것은 사유가 아니라 CLI의 증상(「Not logged in」)이었다.

정착 셀은 스폰 IO 실패와 **같다**(`Starting → Terminating{SpawnFailed}` →
`Event::Exit` → 셸의 `stream_closed` → 오류 말풍선 · 스피너 정착 · 컴포저 해제).
채널을 늘리지 않았다 — 계기만 다르고 착지는 이미 있는 그 자리다. 나가는 문장은

```
<이메일> 계정 폴더를 열지 못했어요 — <사유>
```

누구의 · 무엇이 실패했는지가 **둘 다** 들어간다.

---

## 2. (a)~(d) 재현 → 해소

크리틱이 코드로 확정한 네 갈래를 **격리 픽스처로 각각 재현**하고 못을 박았다
(`src-tauri/src/engine/claude_account.rs`의 테스트 — `ccg-auth`의 **진짜** 슬러그를 쓴다).
옛 알고리즘(`old_guess` + `old_scan`)을 테스트 안에 그대로 남겨 두고 리졸버와 나란히
세웠으므로, **옛 코드가 무엇을 집었는지**가 같은 파일에 증거로 남는다.

| # | 결함 | 픽스처(합성 · `@example.invalid`) | 옛 코드가 집던 것 | 지금 |
|---|---|---|---|---|
| (a) | **자가영속 오염** | `accounts/user_example.invalid`(오염) + `…-1sqbe9q`(실물) | 오염 폴더 — **정확 일치**로 언제나 먼저 이긴다 | 실물 폴더 + `.credentials.json` 물질화 확인 |
| (b) | **자격증명 크로스오버** | `a_b@…`와 `a!b@…` — safe 이름이 같고 해시만 다름 | 후보 **둘**, `read_dir` 순서 복권 → 남의 폴더 가능 | 각자 자기 해시 폴더(섞일 수 없다) |
| (c) | **접두 그림자** | `eve@ex.invalid` vs `eve@ex.invalid-corp.test` | 이웃 폴더가 **먼저** 열거돼 실제로 이긴다 | 각자 자기 폴더 |
| (d) | **대문자 · `+` 주소** | `A.B+tag@Example.invalid` | 조립이 `A.B-tag_Example.invalid` — **확정 미스** → (a)로 영구화 | `a.b_tag_example.invalid-hjlo1j` 정확 일치 |
| 덤 | **파일도 집었다** | 슬러그 이름의 **파일** | 그 파일을 계정 폴더로 반환(`file_type` 미검사) | 폴더를 만들어 답하므로 여지 없음 |

**(c) 픽스처는 적대적으로 골랐다.** 크리틱 증거가 쓴 `bob@…`으로 잡으면 해시가
`3o2bl3`이라 `-` 뒤 첫 글자가 `3` < `c`, 즉 **우연히 실물이 먼저 열거돼 결함이 숨는다**.
`eve@…`는 해시가 `m1yb3c`라 이웃(`…-corp.test-12ig38x`)이 먼저 온다. 그래서 이 픽스처에서
옛 스캔은 "이길 수도 있다"가 아니라 **실제로 남의 폴더를 집는다** — 그것이 "복권"이라는
말의 뜻이고, 돌연변이 M2에서 (c)가 죽고 살고를 가른 것도 이 선택이다(§3).

엔진 쪽 못은 따로 있다(`crates/ccg-engine/src/runtime.rs::slug_r1_account_dir_tests`) —
엔진 크레이트는 `ccg-auth`를 모르므로 거기서는 **"훑지 않는다"** 자체를 잰다:
`accounts/`에 (a)(b)(c) 모양을 전부 깔아 두고도 결과는 리졸버가 말한 것 하나다.

---

## 3. 돌연변이 — 못이 진짜 박혔나

세 갈래를 되돌려 보고, 각 못이 **무엇을 지키고 있는지**를 확인했다.

| 돌연변이 | 무엇을 되돌렸나 | 죽은 못 | 살아남은 못 |
|---|---|---|---|
| **M1** | `account_dir`이 리졸버를 무시하고 옛 조립+스캔 | 엔진 4/4 **전부 red** | — |
| **M2** | `resolver()` 안에서 옛 조립+스캔 | 셸 6/7 red — (a)(b)(c)(d)+파일+미등록 사유 | `folder_name_comes_from_ccg_auth…`(슬러그 모양만 보는 순수 테스트 — 리졸버를 안 부른다) |
| **M3** | `hub.rs`의 `.with_account_resolver(…)` 한 줄 삭제 | **단위 테스트는 전부 green** | 전부 — 오직 PoC만 잡는다(§4) |

M1의 진단 출력이 결함 (a)를 그대로 보여 준다:

```
assertion `left == right` failed: 훑기가 아니라 리졸버가 답한다
  left:  ...\accounts\user_example.invalid          ← 오염 폴더(옛 코드가 집던 것)
  right: ...\accounts\user_example.invalid-1sqbe9q  ← 실물
```

**M3이 이 라운드에서 PoC가 필요한 이유다.** 주입점과 어댑터가 둘 다 완벽해도 `hub.rs`의
한 줄이 없으면 앱은 여전히 `accounts/_no-resolver`로 CLI를 태운다(= 미로그인). 그 줄의
유무는 **실행 중인 앱이 CLI에 넘긴 env**로만 보인다.

---

## 4. 실측 — `scripts/poc-slug-account-dir.mjs`

격리 홈 + 합성 계정(`@example.invalid`) + 가짜 CLI. **실홈은 읽지도 않았고**
`CCG_NO_NET=1`이라 네트워크도 안 탔다. 산출물 `docs/critic/slug-r1-account-dir.json`.

관측 장치는 가짜 CLI의 대본 선택이다 — `ccg-fakecli`는 `CLAUDE_CONFIG_DIR`의 **마지막
폴더 이름**으로 형제 대본(`fake.<그이름>.jsonl`)을 고른다. 그래서 화면에 찍히는 답
한 줄이 곧 "엔진이 어느 폴더를 집었나"의 증언이다.

| 대본 | 답 | 뜻 |
|---|---|---|
| `fake.slug-a_example.invalid-1atacxe.jsonl` | `OK-REAL` | 실물 폴더를 집었다 |
| `fake.slug-a_example.invalid.jsonl` | `WRONG-GUESS` | 옛 추측(오염 폴더)을 집었다 |
| `fake.jsonl` | `NO-ACCOUNT-DIR` | 리졸버 미배선(`_no-resolver`) |

### A(resolve) — (a) 오염 폴더가 깔린 홈

| 검사 | 결과 |
|---|---|
| A1 `CLAUDE_CONFIG_DIR`이 실물 폴더 | **OK-REAL** (`real`) |
| A2 자격증명 물질화 | `accounts/slug-a_example.invalid-1atacxe/.credentials.json` 존재 |
| A3 오염 폴더는 비어 있다 | 통과 — `.credentials.json` 없음 |
| A4 CLI가 실제로 떴다 | stdin 307바이트 |

### B(fail) — 등록은 됐는데 `credEnc`를 못 푸는 계정

렌더러까지 닿은 문장(실측 그대로):

```
slug-b@example.invalid 계정 폴더를 열지 못했어요 — 저장된 자격증명을 풀지 못했어요
— 다른 사용자·다른 PC의 홈을 옮겨 온 경우예요(다시 로그인해 주세요)
```

| 검사 | 결과 |
|---|---|
| B1 사유가 `notice` 채널로 나갔다 | 통과 |
| B2 누구의 실패인지가 문장에 있다 | 통과(이메일 포함) |
| B3 **화면(DOM)** 에 사유가 보인다 | 통과 |
| B4 CLI를 태우지 않았다 | stdin **0바이트** · argv 없음 |
| B5 그 자리에서 정착 | `Idle` |

### 돌연변이 M3 — 배선 한 줄을 지우면

`hub.rs`의 `.with_account_resolver(…)`만 주석 처리하고 **다시 빌드해서** 같은 주행:

| | 단위 테스트 11개 | PoC 9개 |
|---|---|---|
| M3 | **전부 green**(아무것도 못 잡는다) | **6건 red** |

A1이 `poison`으로 떨어지고(= 자격증명 없는 `_no-resolver/<표식>` 폴더 → 미로그인),
B1~B4가 통째로 무너진다(사유가 안 나가고, 없는 계정 폴더로 **CLI를 태운다**).
되돌리고 다시 빌드하니 9/9 green.

M3에서도 A3(오염 폴더는 비어 있다)은 통과한다 — 폴백이 `accounts/<표식>`이 아니라
**한 층 아래** `accounts/_no-resolver/<표식>`이라, 배선이 없는 세계에서도 실계정 층에
빈 폴더를 만들지 않는다. (a) 오염을 **구조로** 못 하게 막은 자리가 여기다.

### 회귀 하나 — 폴백이 계정을 뭉개면 하네스가 눈이 먼다

처음에는 폴백을 `accounts/_no-resolver` **한 폴더**로 뒀다. 워크스페이스 테스트가
`crates/ccg-engine/tests/critic_m11r2_attack.rs`의 B1·B2·B3 **3건 red**로 잡았다.

그 크리틱 하네스는 `slug_of(spec)` — `CLAUDE_CONFIG_DIR`의 **마지막 폴더 이름** — 으로
"이 턴이 어느 계정으로 떴나"를 읽고, 계정별 한도 대본을 그 이름으로 고른다. 계정 넷을
한 폴더로 뭉개니 판독이 통째로 눈이 멀어 *"셋 다 대기"* 가 됐다.

이건 테스트의 사정이 아니라 **내가 깬 성질**이다: 리졸버가 없어도
`CLAUDE_CONFIG_DIR`은 계정을 구분해야 한다(가짜 CLI의 계정별 대본 선택도 같은 성질에
선다). 그래서 폴백에 `<이메일표식>` 한 층을 더했다(§1.1). 크리틱 파일은 **한 글자도
안 고쳤다** — 빌더가 크리틱 하네스를 편집해서 초록을 만들면 그 하네스는 더 이상
독립 재생이 아니다.

### 하네스 자신의 함정 — 낡은 스텁이 만든 **공짜 통과**

첫 주행에서 A4(`argv.json` 존재)만 실패했는데, A1은 통과했다(= CLI가 분명히 떴다).
원인은 레포의 `target/release/ccg-fakecli.exe`가 **소스보다 오래된 빌드**여서
`CCG_FAKECLI_ARGV`를 몰랐던 것이다. 문제는 A4가 아니라 **B4**였다 —
「argv.json이 없다 = CLI가 안 떴다」는 판정이 스텁이 낡았다는 이유로 **언제나 참**이 된다.
「안 떴다」를 증명하려던 단언이 공짜로 통과한 것이다.

그래서 하네스를 두 군데 고쳤다:

- 판정 근거를 **stdin 바이트**로 바꿨다(스텁 나이와 무관한 증거).
- 스텁의 **능력을 먼저 확인**한다(`argvSupported` — exe 안에 그 문자열이 있는가).
  능력이 있는데 산출물이 없으면 그때는 실패다(A4b).
- 스텁 경로를 `--stub=`·`CARGO_TARGET_DIR`·`target/` 중 **가장 최신**으로 고른다.

### 회귀 — `poc-account-switch`(계정 물질화 경로 변경 시 필수)

`--out=-slugr1`로 재주행: **PASS — 시나리오 6개**(pick · none · off · dirty · chain ·
toggle). 배너·되돌리기·연속 전환 전부 그대로다. 단, 이 재주행은 §5의 슬러그 수정을
**같이 해야만** 성립한다.

### 크리틱 계기(`critic-fps144-slug.mjs`)의 W1/W2는 어떻게 됐나

**변하지 않았고, 변할 수 없다.** 그 계기는 엔진 코드를 읽지 않는다 — `engineSlug()`
(도구 49행)가 옛 알고리즘의 **하드코딩된 이식본**이고, 레포에서 읽는 파일은
`ccg-auth/src/lib.rs`의 슬러그 벡터뿐이다. 즉 그 도구는 *"이런 알고리즘이 있다면
어떻게 되는가"* 를 시뮬레이션한다.

그래서 수정 후 재주행해도 W1 8/8 실패 · W2 5/8 실패 · W3 (a)(b)(c) 전부 재현으로
**같은 값**이 나온다(재주행해 확인했다). 달라진 사실은 눈금이 아니라 **그 알고리즘이
이제 제품에 없다**는 것이고, 그것을 재는 자리는 이 문서의 §2(단위 못)와 §4(PoC)다.
계기의 재주행이 파일 타임스탬프만 바꾸므로 원본 증거는 되돌려 놓았다(그 파일은
FPS144 크리틱 갈래의 산출물이다).

---

## 5. 덤 — 하네스 둘이 엔진과 **같은 실수**를 하고 있었다

`scripts/poc-account-switch.mjs:78`과 `scripts/poc-acct-live.mjs:73`의 슬러그 헬퍼가
`email.replace(/@/g, '_')`였다. 주석은 *"`ccg_auth::account_slug`와 같은 규칙이어야
한다"*고 적혀 있었지만 값은 규칙이 아니라 **엔진의 옛 추측**이었다.

그래서 두 하네스는 "맞아서" 돈 것이 아니라 **엔진과 같은 실수를 해서** 돌았다: 엔진이
`accounts/a_ccg.test`를 집고 하네스가 `fake.a_ccg.test.jsonl`을 써서 우연히 맞물렸다
(가짜 CLI는 `CLAUDE_CONFIG_DIR`의 마지막 폴더 이름으로 형제 대본을 고른다).

엔진이 실물 폴더를 집기 시작하면 그 맞물림이 풀린다 — 계정별 대본이 **한 장도 안
골라지고** 전부 기본 대본으로 떨어져, M11 한도 전환 시나리오가 조용히 사라진다. 즉 이
수정이 두 하네스를 **깨뜨린다**. 그래서 같이 고쳤다(진짜 레시피로 교체 + 사정을 주석에).

---

## 6. 안 한 것 · 잔여

- **`scripts/poc-rs/src/wire.rs::default_account_dir()`** 에 같은 접두 스캔이 남아 있다.
  손대지 않았다: ① 라이브 스모크 전용이고 ② **못 찾으면 `panic!`** 이라 조용히 틀리지
  않으며 ③ 그 함수는 **실홈을 읽는다** — 이 라운드의 규율이 실홈 무접촉이다.
  (`scripts/poc-claude-cli-wire.mjs`·`poc-dial.mjs`도 같은 이유로 그대로 뒀다.)
- **`CloseCause`를 늘리지 않았다.** 계정 실패는 `SpawnFailed`로 착지한다 — 사유는
  `Notice` 문장이 나른다. 새 변종은 셸·렌더러 매핑을 전부 건드리므로, 이 라운드에서
  값을 못 내는 확장이다.
- **`ccg-auth` 쪽은 한 글자도 안 건드렸다.** 슬러그 규칙은 2.6.2와 바이트 동일해야 하고
  (실물 폴더가 이미 그 이름으로 존재한다), 그 못은 이미 `ccg-auth`에 박혀 있다.
