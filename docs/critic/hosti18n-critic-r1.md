# HOSTI18N R1 확인 크리틱 — `026c00d`

> 판정자: 확인 크리틱(SMALL3 R1~R3와 같은 규율).
> 오염 없는 트리: `git archive 026c00d` → `%TEMP%\ccg-hosti18n-crit`.
> `node_modules`와 `src-tauri/lsp-runtime`(93MB node.exe·gitignore)은 워크트리를 가리키는
> **읽기 전용 정션**(`npm ci`/`install` 0회), `app/dist`는 `vite build`로 **실제** 빌드,
> `CARGO_TARGET_DIR`은 새 디렉터리 둘.
> 제품 코드 한 줄도 안 고쳤다 · 돌연변이는 격리 사본에만 · 복원은 네 파일 다 해시 대조 ·
> 사용자 실홈 무접촉 · **실앱 무접촉**(내가 띄운 PID 하나만 경로로 식별해 종료, 이름 기반 kill 0).

## 판정: **합격(핵심 다섯 자리) · 그러나 종결은 못 한다**

빌더가 닫겠다고 한 **다섯 자리는 정말 닫혔다.** 내 손으로 재현했고, 실제 화면까지 갔다.
①의 처방 A(`r.error ?? t(…)` 구조를 남기고 셸이 en으로 답하기)는 **실행 중인 앱에서 참**이다.

그러나 **장부의 범위 주장 둘이 사실과 다르고**, 같은 부류의 **실물 결함이 이 라운드가
만진 바로 그 화면에 남아 있다**(사진으로 첨부). 중 셋이므로 종결 조건(잔여 낮음뿐)에
해당하지 않는다 — **R2가 필요하다.**

---

## 0. 빌더 주장 vs 내 실측

| 빌더가 말한 것 | 내가 잰 값 | 판정 |
|---|---|---|
| 다섯 문구가 en/ko/무설정을 따른다 | 못 재현 + 실앱 실측 | 참 |
| en 넷은 2.6.2 원문 바이트 그대로 | **넷 다 UTF-8 바이트 동일**(독립 계기 15/15) | 참 |
| verse만 3.0 전용(대조 원문 없음) | 2.6.2에 그 문구 없음 확인 | 참 |
| H1~H5 전부 exit 101 | **101 · 101 · 101 · 101 · 101**(실패 못 이름까지 일치) | 참 |
| 무해 HOK1/HOK2는 exit 0 | **0 · 0** — 거짓 양성 없음 | 참 |
| `agentcodegui` 148/0/2 | **148/0/2** | 참 |
| 릴리즈 경고 0 | **exit 0 · `warning` 0줄**(새 target) | 참 |
| 못의 구멍 둘을 스스로 찾아 고쳤다(§5.2) | H4가 이제 **동결 대조 못까지** 붉힌다 — 확인 | 참 |
| 커밋 경계에 옆 갈래 없음 | 9파일, `crates/ccg-lsp` 미포함(LSPDIST는 미커밋으로 별도) | 참 |
| **② 부모 창은 플러그인 제약이라 불가** | **거짓** — `set_parent`가 공개 API다(§2 R1-D1) | **틀림** |
| **나머지 15건은 동적 값이라 부류가 다르다** | **거짓** — 최소 셋은 100% 정적 한국어(§2 R1-D2) | **틀림** |

---

## 1. 실제 화면까지 갔다 — ①의 처방 A는 참이다

지시가 요구한 자리다. 셸 응답만 재면 `r.error ?? t(…)`의 **순서**를 못 보므로,
격리 홈(`ui.lang=en`)으로 **릴리즈 빌드를 실제로 띄우고** CDP(11020)로 붙었다.

**렌더러가 정말 en이다**(독립 확인): `New chat` · `Extra chat` · `Select folder` ·
`LANGUAGE SERVERS` · `Install` · `What can I help with, User?`.

**심을 거친 값** — `Settings.tsx doVersePick`의 `catch`가 보는 바로 그 `e.detail`:

```
window.api.lsp.pickVerseServer()  → THREW detail="Setting a Verse server isn't available in 3.0 yet"
window.api.lsp.setVersePath('x')  → {"ok":false,"error":"Setting a Verse server isn't available in 3.0 yet"}
```

`detail`이 **non-nullish 영어**이므로 `detail ?? t(폴백)`은 `detail`을 고른다.
**순서 문제는 없다** — 셸을 고친 것으로 화면이 따라온다. ①의 B 기각(계약면 `protocol.ts`
동결) 판단도 이 결과와 모순되지 않는다.

> **다만 적어 둘 것**: `Settings > Code`의 서버 목록에 **Verse 행 자체가 안 그려진다**
> (TypeScript · Python · C# · C·C++ 넷뿐). 즉 고친 문구는 **이 화면에서 현재 도달 불가**다.
> 고친 것이 틀렸다는 말이 아니라(계약면은 살아 있고 심을 통해 실제로 영어가 온다),
> **"화면에서 확인했다"의 범위가 셸→심까지**라는 뜻이다. 보고서가 이 사실을 안 적었다.

---

## 2. 결함

### 치명 — 없다

### 중

**R1-D1. ② 이월의 근거가 사실이 아니다 — `set_parent`는 공개 API다.**

보고서와 코드 주석은 *"`tauri-plugin-dialog`의 `pick_folder`에 부모 지정이 없다
(rfd `set_parent` 미노출)"* 라며 부모 창을 이월했다. **플러그인 소스가 반대를 말한다:**

```
tauri-plugin-dialog-2.7.2/src/lib.rs   impl<R: Runtime> FileDialogBuilder<R>
    pub fn set_file_name(…)
    pub fn set_parent<W: HasWindowHandle + HasDisplayHandle>(…)   ← 공개
    pub fn set_title(…)

tauri-plugin-dialog-2.7.2/src/desktop.rs:100-101   (FileDialogBuilder → rfd::FileDialog)
    #[cfg(desktop)]
    if let Some(parent) = d.parent { builder = builder.set_parent(&parent); }
```

`set_parent`는 **이미 쓰고 있는 `.set_title(…)` 바로 옆 메서드**이고, 변환기가
`pick_folder`를 포함한 모든 `pick_*`에 적용한다. 즉 `.set_parent(&window)` 한 줄이면
2.6.2의 부모 지정 파리티가 닫힌다.

이월 자체는 결정의 문제지만 **거짓 전제로 이월한 것**은 다르다 — 다음 사람이 이 문장을
읽고 다시 안 찾아본다. 게다가 같은 전제가 `src-tauri/src/ipc/parity/dialog.rs` 모듈
헤더에도 **SMALL3 R1부터** 실려 있다. **내가 R1~R3에서 이 문장을 세 번 읽고도 안 짚었다 —
내 실책이기도 하다.** 지금 바로잡는다.

**R1-D2. "나머지 15건은 동적 값이라 부류가 다르다"가 사실과 다르다.**

표본을 손으로 열어 봤다. 최소 셋은 **동적 성분이 0인 정적 한국어**이고, 같은
`?? t(…)` 표현으로 그대로 흘러간다:

| 셸 | 문자열 | 모양 | 렌더러 |
|---|---|---|---|
| `src-tauri/src/ipc/accounts.rs:659` | `codex 실행 파일을 찾지 못했어요` | `const` → `login_error(why)` → `json!({"error": why})` | `Settings.tsx:473` |
| `src-tauri/src/ipc/accounts.rs:423` | `다른 로그인이 시작되어 이 시도는 취소됐어요.` | `status_wire(…, Some("…"))` | `Settings.tsx:455` |
| `crates/ccg-lsp/src/install.rs:316` | `파일이 아직 사용 중이에요. 잠시 후 다시…` | `Err("…".into())` | `Settings.tsx:2234` |

앞의 **둘은 못이 훑는 `src-tauri` 안**이다. 안 걸린 이유는 범위가 아니라 **모양**이다 —
못이 `"error"`와 한국어가 **같은 줄**에 있을 때만 보는데, 이 둘은 변수·헬퍼를 거친다
(= 내 회피 변이 S2가 가설이 아니라 **실물**이라는 뜻이다).

즉 이 라운드가 닫은 것은 **다섯 자리**이고 **부류가 아니다.** 보고서의 "15건은 부류가
다르다"는 문장은 그 다섯 자리 밖을 안전하다고 읽히게 만든다.

**R1-D3. en 화면에 한국어가 남아 있다 — 이 라운드가 만진 바로 그 화면이다.**

실앱 화면 캡처(`%TEMP%/ccg-crit-en-code.png`, 판정문과 함께 증거 json에 경로 기록):
`Settings > Code`는 제목·설명·`LANGUAGE SERVERS`·`Bundled`·`Install`·하단 안내까지
**전부 영어**인데, **C# 행 배지만 「.NET SDK 10+ 필요」로 한국어**다.

원인은 셸이 아니다 — 셸은 `requires`(ko)와 `requiresEn`(en)을 **둘 다** 보낸다
(`crates/ccg-lsp/src/lib.rs:449-453`, 주석에 *"표시 쪽이 고르게 한다"*). 그런데
`app/src/components/Settings.tsx:2377`이 `{s.requires}`를 **무조건** 그리고,
`requiresEn`은 **`app/` 전체에서 아무도 안 읽는다**(전수 grep 0건). 계약면
(`src/shared/protocol.ts:196`)에 필드만 있고 배선이 없다.

이 자리가 이번 훑기에서 빠진 이유는 분명하다 — 빌더의 렌더러 훑기는 **`?? t(`/`|| t(`
패턴**을 셌는데, 이 자리는 폴백이 없는 **맨 렌더**(`{s.requires}`)라 그 그물에 안 걸린다.
증상은 이 라운드가 고친 것과 **똑같다**(en 사용자가 한국어를 본다).

### 낮음

**R1-D4. 훑기 못(③)이 좁다 — 다섯 형태가 전부 통과한다.**

대조군 S0(빌더의 H5와 같은 한 줄 형태)만 잡고, 나머지는 전부 초록이다:

| 변이 | 형태 | `cargo test` |
|---|---|---|
| S0 | `"error": "한국어"` 한 줄 | **101**(잡힌다) |
| S1 | `"error":` 뒤 **줄바꿈**, 한국어는 다음 줄 | **0** |
| S2 | 변수 경유 — `let m = "한국어"; … "error": m` | **0** |
| S3 | 유니코드 이스케이프 | **0** |
| S4 | 다른 키 — `"message": "한국어"` | **0** |
| S5 | `format!` 경유 | **0** |

S1은 **적대적이지 않아도 난다**: 이 줄이 100칸을 넘으면 rustfmt가 `"error":` 뒤에서 접는다.
S2는 위에서 봤듯 **이미 실물이 있다**(`NO_CODEX_BIN`). 범위도 좁다 — `crates/`를 안 걷는다
(그건 보고서가 밝혀 뒀다).

못을 「그물」로 부른 것 자체는 정직하다. 다만 그 그물의 **눈이 얼마나 큰지**를 보고서가
안 적었고, R1-D2가 보여 주듯 **그 눈으로 실물이 이미 빠져나가 있다.**

### 결함이 아닌 것(확인만)

- **다섯 자리의 처방은 정확하다**: 전부 `const`가 아니라 `fn`(모듈 스코프 `t()` 금지 준수 —
  `const`였다면 프로세스 첫 언어로 박제된다), 배선 못(④)이 호출부를 따로 재고,
  동결 대조 못(②)이 **양쪽 다 파일에서 읽어** 대조한다(기대값을 못 안에 두는 함정을
  빌더가 스스로 찾아 고쳤고, H4가 그것을 증명한다).
- **`verse`가 3.0 전용이라 대조 못이 없다**는 예외를 못 안에 **명시**해 둔 것도 옳다
  (2.6.2에 그 문구가 생기면 붉어지는 역방향 assert까지 있다).
- **창 제목은 생성 시 한 번 정해진다**(이미 열린 창은 언어를 바꿔도 그대로)는 성질을
  2.6.2와 **같다**고 적고 그대로 둔 판단 — 확인했고 동의한다.

---

## 3. 남은 가장 큰 격차 (하나)

> **닫힌 것은 다섯 자리이고, 부류는 안 닫혔다.**

이 라운드는 내가 §3.4-A에서 이름을 짚어 준 **바로 그 세 자리(+둘)** 를 정확히 닫았다.
그러나 §3.4-A의 실체는 「이름을 아는 몇 자리」가 아니라 **「셸이 보낸 한국어가 en 화면을
이기는 부류」** 이고, 그 부류는 살아 있다 — 화면 사진 한 장이 그것을 말한다.

다음 라운드가 볼 자리를 값싼 순서로 적어 둔다:

1. **`Settings.tsx:2377`의 `{s.requires}` → `requiresEn` 배선**(R1-D3). 셸은 이미 en을
   보내고 있다. **렌더러 한 줄**이면 닫히고, 화면에서 즉시 확인된다.
2. **`accounts.rs:659`·`:423`**(R1-D2) — `src-tauri` 안이고 100% 정적이다. `ccg_fs::t`로
   감싸면 끝이며, 이 라운드가 세운 못 모양을 그대로 쓴다.
3. **훑기 못을 모양이 아니라 값으로**(R1-D4): 줄 단위 문자열 매칭 대신
   ⓐ `"error"`뿐 아니라 렌더러가 실제로 읽는 키 전부를 대상으로, ⓑ 같은 줄 제약을 풀고,
   ⓒ `crates/`까지 걷도록. 최소한 **S1(줄바꿈)과 S2(변수)** 는 막아야 실물을 잡는다.
4. **`set_parent` 한 줄**(R1-D1) — 제약이 아니었으므로 이월할 이유가 없다.

> 이 조각 밖의 잔여는 그대로다: `wire.rs` 44 · `runtime.rs` 38(매 턴 보이는 채팅 기록).
> 보고서 §6.1이 이월해 뒀고, 그 판단에는 동의한다.

---

## 4. 재현 방법

```bash
git archive 026c00d | tar -x -C %TEMP%\ccg-hosti18n-crit
mklink /J %TEMP%\ccg-hosti18n-crit\node_modules        C:\Code\AgentCodeGUI\node_modules
mklink /J %TEMP%\ccg-hosti18n-crit\src-tauri\lsp-runtime C:\Code\AgentCodeGUI\src-tauri\lsp-runtime
npx vite build --config app/vite.config.ts        # app/dist는 gitignore라 아카이브에 없다
set CARGO_TARGET_DIR=C:\Temp\target-hosti18n-crit
cargo test -p agentcodegui --features custom-protocol      # 148/0/2

# 정적 대조(독립 계기)
node docs/critic/tools/critic-hosti18n-r1.mjs --json docs/critic/critic-hosti18n-r1-static.json

# 빌더의 열 / 크리틱의 회피 열
node scripts/poc-hosti18n-mutate.mjs <격리트리> H1|H2|H3|H4|H5|HOK1|HOK2|restore
node docs/critic/tools/critic-hosti18n-scan-mutate.mjs <격리트리> S0|S1|S2|S3|S4|S5|restore

# 실화면(격리 홈 + CDP 11020) — 실앱과 겹치지 않게 CCG_HOME을 반드시 준다
CCG_HOME=<격리홈> WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=11020 \
  C:\Temp\target-hosti18n-rel\release\agentcodegui.exe
node docs/critic/tools/critic-hosti18n-cdp.mjs 11020
#  정리: 이름이 아니라 **ExecutablePath로** 내 PID만 골라 종료할 것(실앱이 같은 이름이다)

# 정리: 정션 **둘을** 먼저 끊는다
rmdir %TEMP%\ccg-hosti18n-crit\node_modules
rmdir %TEMP%\ccg-hosti18n-crit\src-tauri\lsp-runtime
```

계기·증거: `docs/critic/tools/critic-hosti18n-r1.mjs` ·
`critic-hosti18n-scan-mutate.mjs` · `critic-hosti18n-cdp.mjs` ·
`docs/critic/critic-hosti18n-r1-static.json` · `critic-hosti18n-r1-evidence.json`.
