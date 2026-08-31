# HOSTI18N R1 — 셸이 en 사용자에게 한국어로 답하던 자리를 닫는다

> 대상: `feature/3.0.0-beta`. 확인 크리틱 R1·R2가 **두 라운드 연속** 「남은 최대 격차」로
> 지목한 `decisions-3.0.md` §3.4-A의 **실물 세 자리**를 연다. 그 자리들은
> `docs/critic/small3-critic-r1.md` §4.2와 `docs/parity-fix-small3-r1.md` §10에
> 이월돼 있었고, 크리틱이 "값싼 순서"까지 매겨 뒀다.
>
> **결론 한 줄**: 세 자리 전부 실재하는 결함이었고 닫았다. 훑는 김에 **같은 부류 셋**을
> 더 찾아 함께 닫았다(총 여덟 문자열). 검증은 SMALL3(R1~R4)에서 세운 문법을 그대로 썼다.

---

## 0. 한눈에

| # | 자리 | 증상 | 처방 |
|---|---|---|---|
| ① | `ipc/lsp.rs` `VERSE_OUT_OF_SCOPE` | en 사용자가 「Verse 서버 지정」을 누르면 **한국어 한 문장**을 받는다 | `const` → `fn verse_out_of_scope()` + `ccg_fs::t` |
| ② | `ipc/system.rs` `pick_directory` | 2.6.2의 창 제목을 **통째로 잃었다**(OS 기본 제목) | `set_title(pick_directory_title())` 신설 |
| ③ | `win.rs` / `popout.rs` 창 제목 | en 사용자의 **제목 표시줄·작업 표시줄이 한국어** | `session_window_title()` · `panel_window_title()` |
| ★ | `ipc/lsp.rs` 설치 대상 없음 · `engine/versions.rs`·`codex_versions.rs` 버전 공백 | 같은 부류(셸이 고정 한국어를 `error`로 보냄) | 인라인 `ccg_fs::t` |

**문자열 여덟**(ko/en 넷 쌍은 2.6.2 원문 그대로, 넷은 3.0 전용이라 여기서 정함).

---

## 1. ① Verse — **렌더러가 셸의 한국어에 진다**

### 1.1 구조가 고약한 자리

```rust
const VERSE_OUT_OF_SCOPE: &str = "Verse 서버 지정은 3.0에서 아직 제공하지 않아요";
…
LSP_PICK_VERSE_SERVER => json!({ "error": VERSE_OUT_OF_SCOPE }),
```

렌더러는 이것을 이렇게 받는다(`app/src/components/Settings.tsx:2296`):

```tsx
error: r.error || t('설정에 실패했습니다.', 'Setup failed.')
```

**번역문은 폴백일 뿐이다.** 셸이 문자열을 실어 보내는 순간 화면에 앉는 값은 셸의 한국어다
— 화면 쪽 i18n은 멀쩡한데 호스트 한 줄이 그것을 덮는다. 크리틱이 "더 고약하다"고 적은
이유가 이것이다.

### 1.2 처방을 어떻게 골랐나

지시가 선택을 열어 뒀다. 둘을 놓고 골랐다:

| 안 | 내용 | 판단 |
|---|---|---|
| **A. 셸이 `t(ko,en)`으로 답한다** | 한 함수 | **채택** |
| B. 에러를 **코드**로 내리고 렌더러가 `t()`로 그린다 | 계약면 변경 | 기각 |

**B를 기각한 결정적 이유**: 계약면은 `src/shared/protocol.ts`이고 그 파일은 **동결 구역**이다
(`src/` 전체). 에러 코드 축을 새로 만들려면 동결 구역을 열어야 한다. 게다가 이 라운드는
옆 갈래(LSPDIST 크리틱 R2)와 같은 트리를 쓴다 — 계약면을 건드리는 것은 충돌 위험도 크다.

A는 이 레포의 기존 규약과도 정확히 일치한다(인라인 `t(ko,en)` · 사전 없음 · 즉시 전환).
`const`가 아니라 `fn`인 것이 규약의 핵심이다 — **상수였다면 프로세스 첫 언어로 박제된다**
(모듈 스코프 `t()` 금지).

> **A가 남기는 것**(정직하게): `r.error ?? t(…)`라는 **구조 자체**는 그대로다. 셸이
> 언어를 고르므로 증상은 없어지지만, "호스트 문자열이 번역문을 이긴다"는 성질은 남는다.
> 그래서 그 성질이 다시 해로워지지 않도록 **못 ③**(셸이 생 한국어 `error`를 보내면
> 붉어진다)을 박았다 — 구조를 못 바꾸면 구조를 감시한다.

### 1.3 en은 우리가 정했다

이 문구는 **3.0 전용**이다 — 2.6.2에는 Verse 지정이 실재하므로 대응 원문이 없다.
그래서 en(`Setting a Verse server isn't available in 3.0 yet`)은 옮겨 온 것이 아니라
여기서 정한 것이고, **동결 원문 대조 못이 없는 유일한 자리**다. ko는 초판 문자열을
한 글자도 안 바꿨다. 이 사실을 못 안에도 적어 뒀다(누가 "왜 verse만 빠졌나"를 다시
묻지 않도록).

## 2. ② 폴더 선택 — 문구가 굳은 게 아니라 **제목을 잃었다**

2.6.2 `src/main/index.ts:1339`:

```ts
title: t('작업할 프로젝트 폴더 선택', 'Choose a project folder to work in')
```

3.0은 `set_title`이 **아예 없었다**. 즉 §3.4-B(첨부 대화상자)와 형제 자리인데 증상이
다르다 — 그쪽은 "한국어로 굳었다"였고 여기는 "**2.6.2가 주던 것을 잃었다**"이다.
한 줄을 되살렸고 en은 동결 원문에서 바이트 그대로 옮겼다.

### 2.1 부모 창은 **못 고쳤다**(제약)

크리틱이 같이 짚은 두 번째 항목이다. 2.6.2는
`BrowserWindow.fromWebContents(_e.sender)`로 **부른 창**에 픽커를 붙인다(추가 채팅 창을
위한 주석까지 달려 있다). 3.0은 부모가 없다.

**이건 누락이 아니라 제약이다**: `tauri-plugin-dialog`의 `pick_folder`에 부모 지정이 없다
(rfd `set_parent` 미노출). `pick_attachments`가 이미 같은 제약을 모듈 헤더에 적어 뒀고,
같은 그물(`close_orphan_dialogs`)이 고아 대화상자를 거둔다. 코드에 주석으로 남기고
**이월**한다(§6) — 플러그인이 부모를 열어 주면 그때 한 줄이다.

## 3. ③ 창 제목 — 앱 밖에서까지 보이는 자리

`win.rs`가 둘(`추가 채팅` · `btw 질문`), `popout.rs`가 하나(`패널`). 셋 다 2.6.2에 원문이
있어 바이트 그대로 옮겼다. 크리틱이 "`popout.rs:140`도 같다"고 짚었으므로 **같은 부류로
함께** 닫았다.

> **알아 둘 성질**: 제목은 창을 만들 때 한 번 정해진다 — 이미 열린 창은 언어를 바꿔도
> 그대로다. **2.6.2도 같다**(생성 시 `t()`). 파리티가 어긋난 게 아니라 둘 다 같은
> 성질이라 그대로 뒀다. 코드 주석에도 적었다.

## 4. ★ 같은 부류 셋을 더 찾아 함께 닫았다

지시가 *"같은 부류면 함께 닫고, 부류가 다르면 장부에만"* 이라고 못 박았다. 그래서
**부류의 정의**를 먼저 정했다:

> **같은 부류 = 셸이 「고정 한국어 문장」을 사용자에게 보내는 자리.**
> 셸이 보내는 것이 **동적 값**(OS 에러·git stderr·예외 메시지)이면 부류가 다르다 —
> 그건 외부 도구의 출력이라 번역 대상 자체가 아니다.

`src-tauri/src`에서 `"error"`에 한국어 리터럴이 실리는 자리를 전수로 훑어 셋을 더 찾았다:

| 자리 | 문구 | 사용자에게 어떻게 닿나 |
|---|---|---|
| `ipc/lsp.rs` `LSP_INSTALL` | `이 파일 형식을 맡는 서버가 없어요` | 뷰어의 "설치할까요?" 응답 |
| `engine/versions.rs` | `버전이 비어 있어요` | 엔진 설치(`Settings.tsx:1185`가 `r.error ?? t(…)`) |
| `engine/codex_versions.rs` | 〃 | 〃(Codex 축) |

셋 다 2.6.2에 대응 원문이 없다(3.0 전용) — en은 여기서 정했다.

### 4.1 렌더러 훑기 — **부류가 다른 것**은 장부에만

`app/src` 전체를 훑어 `백엔드필드 ?? t(…)` 꼴을 **18건**(Class A) 찾았다. 전부 닫지
**않았다** — 대부분 부류가 다르기 때문이다:

- **15건은 2.6.2에서 그대로 이식된 것**이라 파리티상 회귀가 아니다.
- 대부분 셸이 보내는 값이 **동적**이다(`git` stderr · `fs` OS 에러 · 설치 스크립트 출력).
  그 자리에서 우리가 번역할 대상은 애초에 없다.
- 3.0에서 **새로 생긴 통로 넷**(`Settings.tsx:473`·`2265`·`1123`, `EngineGate.tsx:73`)은
  shim 재작성이 만든 것인데, 그중 `2265`(Verse)는 이 라운드가 **호스트 쪽에서** 닫았다.

**범위 팽창을 막으려고 손대지 않은 것**과 그 이유는 §6에 적었다.

## 5. 검증 — SMALL3의 문법을 그대로 재사용

### 5.1 못 넷(`ipc/system.rs::hosti18n_tests`)

문구가 네 모듈에 흩어져 있어 각자 못을 두면 자식 프로세스가 넷이 된다. **한 곳에 모으고**
각 헬퍼를 `pub(crate)`로 열었다.

| 못 | 무엇을 재나 |
|---|---|
| `the_host_strings_follow_ui_lang` | **격리 홈 실측** — en·ko·무설정 3벌. 언어마다 **자식 프로세스**(TTL 캐시가 프로세스 전역이라 한 프로세스에서 두 언어를 못 본다) |
| `the_en_strings_came_from_the_frozen_262_source` | **동결 원문 대조** — 우리 소스에서 en을 **읽어** 2.6.2와 맞춘다 |
| `the_call_sites_use_the_translated_helpers` | **배선** — 호출부가 헬퍼를 먹는가 + 문구의 출처가 하나인가 |
| `the_shell_never_sends_a_raw_korean_error_to_the_renderer` | **훑기** — `src-tauri/src` 전체에서 생 한국어 `error` 0 |

넷째가 이 라운드의 **재발 방지 그물**이다. `r.error ?? t(…)` 구조를 못 바꾸니 구조를
감시한다 — 셸이 한국어를 보내는 순간 붉어진다.

### 5.2 못을 짓다가 **못 자체의 구멍 둘**을 찾았다

정직하게 적는다. 초판 못을 변이에 걸었더니 둘이 새어 나갔다:

1. **동결 대조 못이 H4(en 표류)를 놓쳤다.** 초판은 기대값 넷을 **못 안에 적어 두고**
   "2.6.2에 그게 있나"만 봤다. 그러면 우리 쪽 en이 표류해도 안 걸린다.
   → **양쪽 다 파일에서 읽어** 대조하도록 고쳤다. SMALL3 R3가 배운 것과 같은 함정이다
   (기대값을 못 안에 두면 문구와 기대값을 같이 바꾸는 손을 못 막는다).
2. **하네스가 배선(H2·H3)을 안 봤다.** `cargo test`는 붉은데 하네스는 exit 0이었다.
   → 하네스에 **A2 배선 절**을 더했다. SMALL3 R2의 D2와 같은 자리다.

초판 훑기 못은 **거짓 양성 6건**을 냈다(테스트 assert 4 + 내가 이미 `t()`로 감싼 2).
`#[cfg(test)]` 앞만 보고 `ccg_fs::t(`로 감싼 줄은 면제하도록 고쳤다.

### 5.3 실측 — 격리 홈 3벌(`node scripts/poc-hosti18n.mjs`)

```
ui.lang=en
  verse     Setting a Verse server isn't available in 3.0 yet
  pickdir   Choose a project folder to work in
  win_chat  Extra chat — AgentCodeGUI
  win_btw   btw question — AgentCodeGUI
  panel     Panel — AgentCodeGUI

ui.lang=ko / 설정 없음(둘이 같다)
  verse     Verse 서버 지정은 3.0에서 아직 제공하지 않아요
  pickdir   작업할 프로젝트 폴더 선택
  win_chat  추가 채팅 — AgentCodeGUI
  win_btw   btw 질문 — AgentCodeGUI
  panel     패널 — AgentCodeGUI
```

셋째가 **ko 기본 동작 무변**의 증거다(언어를 한 번도 안 고른 홈은 예전과 같다).

### 5.4 돌연변이 — 격리 사본(`C:\Temp\ccg-hosti18n`)

`git archive HEAD` + 미커밋 파일. `node_modules`와 `src-tauri/lsp-runtime`은 워크트리를
가리키는 **읽기 전용 정션**(`npm install` 0회). **워크트리에서 빌드하지 않았다.**

**부러져야 하는 것 — 다섯 다 부러졌다:**

| 변이 | 무엇을 부쉈나 | `cargo` | 하네스 | 붉은 못 |
|---|---|---|---|---|
| H1 | verse 헬퍼를 리터럴로 | **101** | **1** | 실측 |
| H2 | `.set_title(pick_directory_title())` 제거(=초판 상태) | **101** | **1** | 배선 |
| H3 | 창 제목을 리터럴로 되돌림 | **101** | **1** | 배선 |
| H4 | en 한 칸 표류 | **101** | **1** | **동결 대조** + 실측 |
| H5 | 셸이 생 한국어 `error`를 새로 보냄 | **101** | 0 | 훑기 |

**초록이어야 하는 것 — 둘 다 초록:**

| 변이 | `cargo` | 하네스 |
|---|---|---|
| HOK1 — 헬퍼에 주석 한 줄 | **0** | **0** |
| HOK2 — `session_window_title`의 if/else를 **조건까지 함께** 뒤집기(동작 동일) | **0** | **0** |

유해 변이가 붉은 것만으로는 못이 좋은지 알 수 없다 — 무해한 편집에 안 걸리는 것까지
봐야 한다(SMALL3 R4에서 세운 규율).

> H5에서 하네스가 0인 것은 **설계다**: 소스 전체 훑기는 크레이트 못의 몫이고 하네스는
> 값과 배선을 본다. 역할 분담이지 구멍이 아니다.

복원 뒤 `git hash-object` 대조: `lsp.rs`·`system.rs`·`win.rs` **셋 다 워크트리와 동일**.

## 6. 수치 · 손댄 것 · 이월

| 잰 것 | 값 |
|---|---|
| `cargo test -p agentcodegui --features custom-protocol` | **148 / 0 / 2 · exit 0**(SMALL3 R4의 144/0/1 → **+4 통과 · +1 무시**) |
| 〃 (격리 사본) | **148 / 0 / 2 · exit 0** |
| `cargo build --release --features custom-protocol`(격리 사본 · 새 target) | **exit 0 · `^warning` 0줄** |
| `npm run typecheck:app` | **exit 0** |
| `node scripts/poc-hosti18n.mjs` | **전부 통과 · exit 0** |
| 변이 H1~H5 / HOK1·HOK2 | **전부 101 / 전부 0** |

**손댄 것**

| 파일 | 무엇 |
|---|---|
| `src-tauri/src/ipc/lsp.rs` | `verse_out_of_scope()` + 설치 대상 없음 문구 |
| `src-tauri/src/ipc/system.rs` | `pick_directory_title()` + `set_title` 배선 + **못 넷** |
| `src-tauri/src/win.rs` | `session_window_title()` + 배선 |
| `src-tauri/src/popout.rs` | `panel_window_title()` + 배선 |
| `src-tauri/src/engine/versions.rs`·`codex_versions.rs` | 같은 부류 한 줄씩 |
| `scripts/poc-hosti18n.mjs` · `scripts/poc-hosti18n-mutate.mjs` | 신설(실측 하네스 · 변이 열) |

**안 댄 것**: `crates/ccg-lsp` · `tauri.conf.json` · `scripts/tauri-build.mjs`(옆 갈래
LSPDIST 크리틱 R2 진행 중) · 동결 구역(`src/`·`out/`·`dist/`) · `app/src`(렌더러는
**읽기만** 했다 — 처방 A가 호스트에서 닫았으므로 만질 것이 없었다).

**안전**: 사용자 실홈·실앱 무접촉(홈은 `%TEMP%`에 새로 만들고 지웠다) · 이름 기반 kill 0 ·
공용 `target/` 미접촉 · `npm ci`/`install` 0회 · CDP 미사용(창을 안 띄웠다).

### 6.1 이월 — 손대지 않은 것과 그 이유

1. **`pick_directory`의 부모 창**(§2.1) — 플러그인 제약이다. `tauri-plugin-dialog`가
   `set_parent`를 열어 주면 한 줄. 코드 주석에도 남겼다.
2. **`crates/ccg-lsp/src/lib.rs:160`** — `이 파일 형식을 맡는 서버가 없어요`가 **그쪽에도**
   있다(`install_for_file`). 셸은 이 경로를 안 쓴다(`lsp.rs`가 `server_id_for_file`을 직접
   부른다). **옆 갈래 소유라 무접촉 지시**를 지켰다 — 그 갈래가 끝나면 한 줄이다.
3. **`crates/ccg-store/src/migrate_v3.rs:510,588`** — 마이그레이션 **리포트** 문구다.
   성격이 다르고(사용자 UI가 아니라 진단 기록) 경계 밖이라 안 건드렸다.
4. **렌더러 Class A 나머지 17건 · Class B 20여 건**(§4.1) — 셸이 보내는 값이 **동적**이라
   부류가 다르다. 다만 그중 **`verdict.ts:137`의 `default:` 분기**는 눈여겨볼 값어치가
   있다: 셸이 새 `reason` 코드를 추가하는 순간 Rust `Debug` 문자열이 그대로 화면에 뜬다.
   번역 문제라기보다 **계약면 문제**라 별도 라운드가 맞다.
5. **§3.4-A의 큰 덩어리는 여전히 열려 있다** — `engine/wire.rs` **44개**(도구 활동 라벨·
   엔진 종료 사유) · `ccg-engine/runtime.rs` **38개**(`Event::Notice`). 크리틱이 "가장 큰
   덩어리가 하필 매 턴 보이는 채팅 기록"이라고 적은 자리다. 이 라운드가 세운 모양
   (헬퍼 + 못 넷)이 그대로 듣는다 — `wire.rs`는 `labels()`식 표 분리가 특히 잘 맞는다.
