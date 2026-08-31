# HOSTI18N R2 확인 크리틱 — `5ab35ce`

> 판정자: 확인 크리틱 R2. 같은 규율 — `git archive 5ab35ce` → `%TEMP%\ccg-h2-crit`,
> `node_modules`·`src-tauri/lsp-runtime` 둘 다 워크트리를 가리키는 **읽기 전용 정션**
> (`npm ci`/`install` 0회), `app/dist`는 `vite build`로 실제 빌드, `CARGO_TARGET_DIR` 새 둘.
> 제품 코드 무수정 · 돌연변이는 격리 사본에만 · 복원은 다섯 파일 해시 대조 ·
> 실홈 무접촉 · **실앱 무접촉**(같은 이름 프로세스 다섯 개 중 `ExecutablePath`로 내 것만
> 골라 종료, 이름 기반 kill 0) · CDP는 11021·11022.

## 판정: **합격 — 이 조각을 종결한다**

**내가 R1에서 낸 중 3 · 낮음 1이 전부 닫혔다.** 넷 다 내 손으로 재현했고,
D3는 **R1에서 내가 사진으로 잡은 바로 그 자리를 다시 찍어** 대조했다.

남은 것은 **낮음 둘**(서술 부정확 하나 · 그물 눈 하나)이고 실질 위험이 없다.
지시가 준 종결 조건에 해당하므로 **합격 종결**을 선언하고 둘은 이월 장부로 넘긴다.

---

## 0. 빌더 주장 vs 내 실측

| 빌더가 말한 것 | 내가 잰 값 | 판정 |
|---|---|---|
| D3 en 배지 `["Bundled","Bundled",".NET SDK 10+ required"]` | **글자까지 일치** · Code 패널 한국어 **0** | 참 |
| D1 부모 있으면 앱 창 하나 `enabled:false` | **`enabled:false` 확인** | 참 |
| D2 정적 다섯을 닫았다 | 훑기 못이 실제로 물고, 이월 넷은 손으로 열어 확인 | 참 |
| D2 `install.rs:316`은 LSPDIST `f0a3496`이 마감 | 그 커밋 실재·5ab35ce의 **조상**·내용 일치 | 참 |
| D4 S1~S5 전부 0→101 · SOK 0 | **S0~S5 전부 101 · SOK 0**(거짓 양성 없음) | 참 |
| H 열 무후퇴 | H1~H5 **101** · HOK1/HOK2 **0** | 참 |
| 148/0/2 · ccg-lsp 75/0 · ccg-fs 103/0/2 | **전부 일치** | 참 |
| 릴리즈 경고 0 · `typecheck:app` 0 | **exit 0 · warning 0줄 · tsc exit 0** | 참 |
| 커밋 경계에 옆 갈래 혼입 없음 | 9파일. `ccg-lsp` 접촉은 LSPDIST 마감 **뒤** | 참 |
| **rfd 창이 `#32770`으로 열거되지 않았다** | **재현 안 됨** — 첫 시도에 열거됐다(§2) | **틀림** |

---

## 1. 실화면 — R1의 사진과 같은 자리를 다시 찍었다

**D3.** 격리 홈(`ui.lang=en`) + 릴리즈 빌드 + CDP로 `Settings > Code`를 열었다.

```
before (R1, 026c00d):  C#  [.NET SDK 10+ 필요]      ← 영어 화면에 한국어
after  (R2, 5ab35ce):  C#  [.NET SDK 10+ required]
badges = ["Bundled","Bundled",".NET SDK 10+ required"]   ·   패널 내 한국어 0
```

사진 둘을 나란히 남겼다(`critic-hosti18n-r1-en-screen.png` ↔ `critic-hosti18n-r2-en-screen.png`).
**내가 R1에서 잡은 결함이 화면에서 사라진 것을 화면으로 확인했다.**

**폴백이 ko를 그리는 케이스가 실재하는가 → 아니다.** 지시가 물은 자리다.
`crates/ccg-lsp/src/spec.rs:120`의 `requires`는 `Option<(&'static str, &'static str)>` —
**(ko, en) 튜플**이라 *ko만 있고 en이 없는 상태가 구조적으로 불가능*하다. 현재 `requires`를
가진 서버는 `cs` 하나뿐이다. 즉 `s.requiresEn || s.requires`의 뒷항은 **방어용이고 도달
경로가 없다**. (2.6.2와 같은 모양이라는 빌더의 설명도 맞다.)

---

## 2. 부모 창 — 걸렸고, **풀리는 것까지** 확인했다

**D1이 참인 것**은 쉽게 확인됐다. 폴더 선택을 띄운 순간:

```
#32770        "Choose a project folder to work in"   enabled=true    ← 대화상자(제목도 영어)
Tauri Window  "AgentCodeGUI3"                        enabled=false   ← 부모가 잠겼다
```

`set_parent`가 실제로 걸린다. R1에서 내가 "제약이 아니다"라고 한 것이 맞았고, 빌더가
그것을 제품에 넣었다.

### 2.1 내가 더 본 것 — **모달이 풀리는가**(지시의 IME/포커스 우려)

이 레포에는 네이티브 대화상자가 한국어 IME를 꼬이게 한 이력이 있다. 부모를 거는 변경은
**창을 잠그는** 변경이므로, 잠긴 부모가 **안 풀리면 앱이 통째로 멈춘다** — 이게 이번
라운드에서 가장 위험한 자리라 따로 쟀다.

고아 그물(`close_orphan_dialogs`)이 쓰는 **바로 그 수법**으로 닫았다 — 대화상자 HWND에
`WM_CLOSE`(`PostMessage 0x0010`):

```
WM_CLOSE 뒤:  Tauri Window "AgentCodeGUI3"  enabled=true   ← 정상 복귀
              렌더러 살아 있음(버튼 41개 조회 성공)
```

**모달 잠김 회귀 없음.** 취소 경로에서 부모가 OS에 의해 정상 재활성화되고 렌더러도
멀쩡하다. 이 계열 회귀는 만들어지지 않았다.

### 2.2 낮음 R2-D1 — 「`#32770`으로 열거되지 않았다」가 재현되지 않는다

빌더는 하네스 주석에 *"rfd가 여는 폴더 선택 창은 `#32770`으로 열거되지 않았다
(IFileDialog는 COM 호스팅이라 클래스·소유 스레드가 다르다)"* 고 적고, 그래서 소유자 HWND
대신 **모달 동작**으로 쟀다고 했다. 나는 **첫 시도에 `#32770`으로 열거했다**(위 표).

고른 방법(모달 동작)은 여전히 타당하고 결론도 같으므로 결함은 **낮음**이다. 다만 이 서술이
남으면 **`close_orphan_dialogs`가 이 대화상자를 못 거둔다**고 읽힐 수 있다 — 그 그물이
정확히 `#32770`을 노리기 때문이다. 내 실측은 반대를 말한다: 클래스가 `#32770`이고,
거기로 보낸 `WM_CLOSE`가 실제로 대화상자를 닫고 부모를 되살렸다. **그물은 이 창을 덮는다.**
장부에는 그렇게 적히는 편이 정확하다.

---

## 3. 훑기 못 — 내 회피 다섯이 닫혔다

R1에서 내가 뚫은 다섯이 전부 막혔고, 무해 대조군은 초록이다:

| | S0 | S1 줄바꿈 | S2 변수 | S3 이스케이프 | S4 다른 키 | S5 format! | SOK 영어 |
|---|---|---|---|---|---|---|---|
| R1 | 101 | **0** | **0** | **0** | **0** | **0** | — |
| **R2** | 101 | **101** | **101** | **101** | **101** | **101** | **0** |

`SOK`(영어 `error`)가 초록인 것이 중요하다 — 값 기준으로 바꾸면서 **거짓 양성을 안 만들었다**.

> 덤으로 빌더가 스스로 찾은 것 하나: R2가 부모 창을 걸며 줄이 길어지자 **rustfmt가
> `app` 다음에서 접어** SMALL3 배선 못의 앵커(`app.dialog()`)가 사라졌다. 내가 R1-D4에서
> *"S1은 적대적이지 않아도 rustfmt만으로 난다"* 고 쓴 것이 **자기 못에서 실물로 났다.**
> 앵커를 `.dialog()`로 줄여 고쳤다 — 옳은 처방이다.

### 3.1 낮음 R2-D2 — 그물은 여전히 **키 세 개짜리 허용목록**이다

새 축 둘을 팠다:

| 변이 | 무엇 | `cargo test` | 판정 |
|---|---|---|---|
| **N1** | 값이 **함수 호출**을 거친다(`"error": sneak_reason()`) | **0** | 구멍이나 **빌더가 스스로 적어 뒀다** |
| **N2** | **감시 키 목록 밖**의 키(`"detail": "한국어"`) | **0** | 구멍 · 미고지 |

**N1은 결함으로 안 센다.** 못 주석이 *"값이 함수 호출을 거치면 그 함수 본문까지 따라가지
않는다 … 심볼(ⓒ)까지가 이번 라운드의 사정거리다"* 라고 **한계를 감추지 않고 적었다.**
이 프로젝트에서 그건 정직의 표시지 결함이 아니다.

**N2는 적어 둘 값이 있다.** 못이 보는 키는 `"error"`·`"message"`·`"reason"` **셋뿐**이고,
목록 밖 키에 한국어를 실으면 조용하다. 보고서 §의 ⓐ는 *"키를 넓혔다 — error·message·reason"*
이라고 **개선으로만** 적었지 *"이 셋 밖은 안 본다"* 는 **경계로는 안 적었다.**
이게 낮음인 이유이자 동시에 적어야 하는 이유는 하나다 — **내가 R1에서 사진으로 잡은
실물(`requires`)이 바로 목록 밖 키였다.** 같은 부류가 다시 나면 같은 방식으로 빠져나간다.

---

## 4. 이월 넷을 손으로 열어 봤다 — 「안 열어 보고 쓴 칸」은 없다

지시가 물은 자리다. `CARRIED_OVER` 네 항목을 전부 소스에서 확인했다:

| 이월 항목 | 적힌 사유 | 내가 연 결과 |
|---|---|---|
| `runtime.rs` 「사용자가 중지했습니다」 | §6.1의 `runtime.rs` 덩어리 일부 | `:2209` `json!({"behavior":"deny","message":…})` — **맞다** |
| `runtime.rs` 「거부」 | 같은 덩어리 | `:2245` 같은 모양. 부분 문자열이지만 **실제 일치 1줄**이라 과잉 허용 없음 |
| `migrate_v3.rs` 「스테이징 디렉터리 생성 실패」 | 마이그레이션 **리포트**라 사용자 UI가 아니다 | `:510`. 호출부 `unified.rs:157`의 결과는 **`eprintln!`로만** 나가고 렌더러로 안 간다 — **참으로 확인** |
| `migrate_v3.rs` 「채팅 파일 쓰기 실패」 | 위와 같음 | `:588` 같은 경로 |

**규약도 무결하다**: 목록에 있는데 더는 안 걸리면 **테스트가 실패한다**(자기검증). 그래서
목록이 썩지 않고, R2가 닫힌 둘(ccg-lsp 쌍둥이 · `install.rs`)을 **실제로 지웠다.**
`f0a3496`(LSPDIST 마감)이 `5ab35ce`의 조상인 것과 그 커밋이 정말 `install.rs:316`을 닫은
것도 확인했다 — **`ccg-lsp` 접촉은 접촉 금지가 풀린 뒤**라 경계 위반이 아니다.

---

## 5. 남은 가장 큰 격차 (하나)

> **그물은 「키 세 개 · 심볼 한 겹」까지다. 부류는 잘 지켜지지만 구조적으로 닫힌 것은 아니다.**

세 라운드에 걸쳐 이 부류의 방어는 이렇게 섰다 — 다섯 자리의 실측 못, 동결 원문 대조,
배선 못, 그리고 값 기준 훑기(S1~S5 봉쇄 · 거짓 양성 0 · 자기검증 이월 목록).
남은 통로는 **N1(함수 한 겹 더)** 과 **N2(목록 밖 키)** 둘이고, 둘 다 **새 코드를 쓸 때만**
열린다(지금 트리에 실물 구멍은 없다 — 내가 훑어 확인했다).

다음에 이 그물을 만질 사람에게: 값싼 순서는 ⓐ 키 목록에 `detail`·`hint`·`label`·`title`처럼
**렌더러가 실제로 읽는 키**를 더하고(계약면에서 뽑으면 목록을 손으로 안 적어도 된다),
ⓑ 심볼을 한 겹 더 따라가는 것이다. 지금 당장은 필요 없다 — **실물이 없기 때문이다.**

> **이 조각 밖의 이월(그대로)**: `ccg-engine/runtime.rs` 38 · `wire.rs` 44 —
> 매 턴 보이는 채팅 기록 덩어리다. 별도 라운드로 남긴 판단에 동의한다.

---

## 6. 재현 방법

```bash
git archive 5ab35ce | tar -x -C %TEMP%\ccg-h2-crit
mklink /J %TEMP%\ccg-h2-crit\node_modules          C:\Code\AgentCodeGUI\node_modules
mklink /J %TEMP%\ccg-h2-crit\src-tauri\lsp-runtime C:\Code\AgentCodeGUI\src-tauri\lsp-runtime
npx vite build --config app/vite.config.ts
set CARGO_TARGET_DIR=C:\Temp\target-h2-crit
cargo test -p agentcodegui --features custom-protocol   # 148/0/2
cargo test -p ccg-lsp                                   # 75/0
cargo test -p ccg-fs                                    # 103/0/2

node scripts/poc-hosti18n-mutate.mjs <격리트리> H1..H5|HOK1|HOK2|S0..S5|SOK|restore
node docs/critic/tools/critic-hosti18n-r2-mutate.mjs <격리트리> N1|N2|restore

# 실화면 + 모달(격리 홈 필수)
CCG_HOME=<격리홈> WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=11022 \
  C:\Temp\target-h2-rel\release\agentcodegui.exe
#  창 상태는 EnumWindows + IsWindowEnabled로, 대화상자는 그 HWND에 WM_CLOSE(0x0010)로 닫는다
#  ★정리는 이름이 아니라 ExecutablePath로 내 PID만 (실앱이 같은 이름으로 다섯 개 떠 있다)

rmdir %TEMP%\ccg-h2-crit\node_modules
rmdir %TEMP%\ccg-h2-crit\src-tauri\lsp-runtime
```

계기·증거: `docs/critic/tools/critic-hosti18n-r2-mutate.mjs` ·
`docs/critic/critic-hosti18n-r2-evidence.json` ·
사진 `critic-hosti18n-r1-en-screen.png`(before) ↔ `critic-hosti18n-r2-en-screen.png`(after).
R1 판정문: `docs/critic/hosti18n-critic-r1.md`.
