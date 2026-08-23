# 잔여 청소 R1 — 여러 라운드가 **경계 때문에** 남긴 소품을 걷는다

이 라운드는 새 기능을 안 만든다. 앞선 라운드들이 "옳지만 내 경계 밖"이라고 적어 두고
간 다섯 자리를 닫는다. 다섯 항목 전부 **근거 문서에 위치와 처방까지 적혀 있던 것**이고,
여기서 한 일은 그 처방을 실물에 넣고 **실증한 것**이다.

| # | 무엇 | 근거 | 상태 |
|---|---|---|---|
| 1 | M11 되돌리기 알약 (스레드 band + 상태줄) | `docs/m11-report-r1.md` §6-1 | **닫음** — 실 창 클릭 실증 |
| 2 | M-UI F3(되돌리기 되먹임) · F7(압축 라벨 '왜') | `docs/m-ui-report-r1.md` §14·§16 | **닫음** |
| 3 | M7 §R2-7 "캐시 적중 회귀" 서술 정정 + `ipc/mod.rs` 주석 오기 | `docs/critic/r19-confirm.md` §2.1·§2.2·§6-1 | **닫음**(문서·주석) |
| 4 | `bench/lsp.mjs` provenance · `critic-m8-attack.mjs` 머리 주석 | 같은 문서 §6-2·§6-3 | **닫음** |
| 5 | `MultiAgent.applyPanelFlush`의 길이 가드 → 세대 비교 | 같은 문서 §6-4 | **닫음** |

---

## 1. M11 되돌리기 알약 — **두 자리를 다 붙였다**

M11 R1은 재료를 전부 와이어에 실어 놓고(`notice.switch.revertTo` +
`chat:identity{origin:'auto_account_switch'}`) 되돌리기 경로까지 실증했지만, 그 버튼을
그리는 파일이 경계 밖이라 **사용자가 보는 것은 문장 한 줄뿐**이었다. 보고서 §6-1이 적어
둔 붙일 자리는 둘이고, **하나만 붙이면 안 된다** — 엔진은 전환 한 번에 스레드 이벤트와
정체성 리비전을 **같은 문 안에서** 함께 내므로(runtime.rs `try_auto_switch` ②③), 한쪽만
그리면 다른 쪽이 침묵하거나 둘이 같은 말을 두 번 한다. 폴백 전환이 이미 그 쌍을 쓰고
있어 **같은 규약을 그대로 복사**했다.

### 1.1 스레드 — `notice{switch}`가 알약을 든다

`store/session.ts`의 `case 'notice'`가 `switch.revertTo`를 읽어 그 줄에
`action:'revert'` + `revertTo`를 세운다. **새 `ThreadItem` 종류를 파지 않았다** —
`protocol.ts` §notice가 적은 이유 그대로다(종류를 늘리면 리듀서의 소진 가드와 4개 표면의
`MessageView`가 전부 따라오고, 그 대가로 얻는 게 없다). `Chat.tsx`의 notice band가
폴백 band와 **같은 알약·같은 정착**을 그린다.

문장은 엔진이 만든 것을 그대로 쓴다. 꼬리(「약 29분 뒤 초기화돼요」)가 **왜 이 계정인가**의
답이고, 그걸 렌더러가 다시 조립하면 지어내기 시작한다. `revertTo`가 없거나 음수면
알약 없이 문장만 남는다(폴백 배너와 같은 규약).

### 1.2 상태줄 — `IdentityBand`

`App.tsx`의 `show` 판정에 `origin === 'auto_account_switch'`를 더하고, `IdentityBand`에
제목(`계정이 자동 전환됐어요`)과 문장 가지를 하나 넣었다. 계정 이름은
`identity.billing.account`가 원천이다(`engine.account`는 Codex 축이라 Claude 구독엔 없다) —
`IdentityWire`가 `billing`을 안 적고 있어 그 한 줄을 더했다. **모르면 이름 절을 뺀다.**

중복은 폴백과 **같은 판정**으로 막는다(`identBandNotice`): 스레드에 `revertTo ===
revision - 1`인 band가 있으면 상태줄은 비운다. 그 자리가 유일한 표면인 경우
(스냅샷이 옛것이라 그 줄이 없을 때)에만 상태줄이 선다.

### 1.3 죽은 버튼 하나를 같이 걷었다

`MessageView`에 `canRevert`를 넣었다. 그전에는 `onNotify &&`로만 걸러, **멀티 패널과 추가
채팅 창에도 폴백 배너의 `[되돌리기]`가 그려졌고 눌러도 아무 일이 없었다** — 두 파일의
주석이 "그 알약은 아예 안 그려진다(누르면 아무 일 없는 버튼을 그리는 게 제일 나쁘다)"고
적어 둔 바로 그것이다. 주석이 말하던 것을 이제 **코드가 지킨다**: 능력은 콜백 유무가
아니라 `canRevert` 한 줄로 선언하고, 본채팅만 준다.

(이 정리는 항목 5의 전제이기도 하다 — r19-confirm §6-4가 "지금은 도달 경로가 없다"고
낮게 본 근거가 이 주석이었는데, 코드는 그 말을 안 지키고 있었다.)

### 1.4 실증 — 실 창 6판 (`docs/critic/m11-r1-switch-sweep.json`)

`node scripts/poc-account-switch.mjs --out=-sweep` → **PASS · 시나리오 6개 · 결함 0**.
`--out=<접미사>`는 이번에 하네스에 판 것이다(R1 보고서가 `m11-r1-switch.json`을 근거로
인용하므로 재주행이 그 파일을 말없이 덮으면 안 된다 — `poc-live-chat --tag`·`bench --out`과
같은 규약). **기준 파일은 무접촉이다.**

되돌리기 판정은 R1의 "IPC를 손으로 invoke"에서 **DOM 알약 클릭**으로 갈았다. 그전 판정은
와이어가 옳다는 증명이었지 사용자가 되돌릴 수 있다는 증명이 아니었다.

```
✓ PICK-알약          — ["계정 되돌리기"]
✓ PICK-되돌리기(알약) — {"to":"a@ccg.test","revision":"1→2"}
✓ PICK-정착          — ["되돌림 ✓"]
```

즉 **알약을 누르니 원계정으로 돌아왔고**(soon@ccg.test → a@ccg.test), 되돌리기는
히스토리 삭제가 아니라 **새 리비전**이며(1→2), 배너는 남고 알약만 정착했다(비활성).
나머지 5판(후보 없음 · 설정 꺼짐 · 오염 스킵 · 연속 소진 A→B→C · 설정 토글)은 R1과
같은 값으로 전부 초록이다.

리듀서 층은 따로 12검사로 먼저 잡았다(임시 하네스 — `%TEMP%/ccg-sweep/revert-check.mjs`,
레포에 안 남긴다): `switch` 있음/없음 · `revertTo<0` · 정착 · **참조 동일로 무변화 확인**
(안 맞는 지점 · 두 번째 클릭) · 폴백 band도 같은 액션으로 정착.

---

## 2. M-UI 잔여 F3·F7

### F3 — `[되돌리기]`에 되먹임이 없었다

뷰는 R2 때부터 `reverted`가 서면 `[되돌림 ✓]`로 정착할 준비가 돼 있었다. **세우는 쪽이
없었다.** 눌러도 알약이 계속 '되돌리기'라, 두 번째 클릭이 `no_revision`을 받고 사용자는
눌린 건지조차 모른다.

`store/session.ts`에 `{type:'reverted', revertTo}` 액션 + `useAgentSession().noteReverted`를
세웠다. `App.tsx`의 `onNotifyAction`·`onRevertIdent`가 **셸이 `true`를 준 뒤에만** 친다 —
거절이면 아무것도 안 세운다(사유는 `chat:verdict` 구독자가 그린다. 지어내지 않는다).
대상은 그 지점을 가리키던 배너 전부(폴백 band + M11 계정 전환 notice)이고, 못 찾으면
**상태를 갈지 않는다**(헛 렌더 하나가 스레드 꼬리 윈도잉을 흔든다).

### F7 — 압축 경계 라벨이 '왜'를 버렸다

`'여기까지 요약됨'` → `'컨텍스트가 차서 여기까지 요약됨'`
(en: `'Context filled — summarized up to here'`). 크리틱 제안 그대로다. 같은 한 줄이라
**높이는 안 변한다** — 수치 절은 그대로 오른쪽에 붙는다.

**게이트 계약이 바뀐다.** 내 경계 안의 기대값(`scripts/poc-auto-compact.mjs` 검사 5)은
같이 갈았고 재주행했다: **22검사 all ok**(3.0 15 + 2.6.2 7). 크리틱 도구 쪽에 남은
옛 문자열은 **손대지 않았다**(크리틱 도구 수정 금지) — 아래 §6에 장부로 남긴다.

---

## 3. M7 보고서 정정 — 자랑한 "회귀"는 실재하지 않았다

`docs/m7-report-r1.md` §R2-7이 "캐시 적중 첫 색칠 116 대 280 = 3.0 +164ms 회귀"라고 적고,
거기에 "부팅 프리웜이 앱 기동과 CPU를 나눠 쓰는 거래"라는 인과와 "어느 쪽이 사용자
체감인지는 리드가 고를 문제"라는 결론까지 붙였다. **셋 다 틀렸다.**

R19 확인 크리틱이 기준 바이너리로 같은 기계에서 6회 다시 돌린 값은 **174~191ms이고 280은
한 번도 안 나왔다.** 실제 격차는 130 대 ~178 = **+48ms**다. 인과는 같은 크리틱의
`CCG_PREWARM_AT` A/B가 직접 반증했다 — 프리웜을 `win:mounted` 뒤로 통째로 밀어도 캐시
적중은 안 움직이고(182~191) `ready`만 3배 나빠진다(481~557). **거래가 없으므로 고를
문제도 없다.**

§R2-7에 정정 상자를 박고(두 표 포함), §R2-9 #4("첫 IPC 창")를 `+102ms` → **`+48ms 전부`**로
고치면서 **유일한 원인으로 승격**했다. 다음 라운드가 그 +48ms를 원하면 손댈 자리는
프리웜이 아니라 첫 IPC 창 하나다.

`src-tauri/src/ipc/mod.rs`의 `boot_prewarm` 주석도 같이 고쳤다(**주석만**). "셸이 창을 만든
직후"라고 적혀 있었는데 실제 호출은 `main.rs:136` — `tauri::Builder`보다 **앞**(창 생성
전)이다. `lsp.rs` 주석이 맞고 이쪽이 크리틱 §3.2의 *제안* 자리를 옮겨 적은 오기였다.
위 A/B가 **이 자리가 `ready`의 전부**임을 보였으므로, 주석이 틀리면 다음 라운드가 옮긴다.

---

## 4. 증거·도구 위생

### 4.1 `bench/lsp.mjs`에 provenance

`bench/lib.mjs`는 `arm`(CCG_* 조합 슬러그) · `bin`(exe 경로·mtime·크기·sha256·gitHead·
gitDirty) · `armEnv`(모든 CCG_*)를 결과에 박는 헬퍼를 갖고 있고 `boot`·`coldstart`·
`crash`·`gpuprobe`·`multi`는 전부 부르는데 **`lsp.mjs`만 안 불렀다.** 그래서 R19 크리틱은
프리웜 A/B를 돌려 놓고 `--out` 접미사와 ready 델타로 팔을 갈라야 했다(추측이 섞이는
자리다). 프로필은 `boot()`이 쓰는 것과 **같은 인자**로 만들어 넘긴다.

확인 주행(`node bench/lsp.mjs tauri --out -sweep --blocks 40 --no-viewer`) →
`bench/results/lsp-tauri-3.0.0-sweep.json`에 필드가 실렸다:

```json
"arm": "default",
"bin": { "exe": "…\\ccg-lsp-exe\\agentcodegui.exe", "exeSha256": "21eb7efb34819192",
         "exeSize": 6273024, "gitHead": "ac7694b", "gitDirty": true },
"armEnv": { "CCG_HOME": "…\\.bench-home-tauri", "CCG_CDP_PORT": "9372" }
```

**그 주행의 성능 수치는 쓸 수 없다** — `ready`가 안 떴다(`status가 180000ms 안에 ready가
안 됨`). 원인은 제품이 아니라 워크트리다: 같은 레포에서 동시 주행 중인 다른 라운드가
그 사이 `node_modules`를 비우고(`tsserver`가 사라진다) `target/release/agentcodegui.exe`를
자기 빌드로 갈아치웠다 — 위 `exeSha256`/`exeSize`(6,273,024)가 **내 빌드가 아니라 그쪽
것**임을 그대로 말하고 있다. **provenance가 없었으면 이 사실 자체를 몰랐을 것이다**(이
필드를 박은 이유가 정확히 그거다). 수치는 다음 조용한 주행에서 다시 잰다.

### 4.2 `critic-m8-attack.mjs` 머리 주석 (주석만)

A1~A6만 나열했는데 파일은 처음부터 A1~A9를 구현하고 `--only=a7|a8|a9`로 돈다. 세 줄을
채우고, 같은 크리틱이 §4.1에서 지적한 **도구 자신의 결함**(`A4-자리`의 `onScreen`이 가상
데스크톱 좌표 `screenX`를 그 모니터 폭 `availWidth`와 직접 견줘 **보조 모니터에서는 항상
붉다** — `availLeft`/`availTop` 환산 누락)을 머리 주석에 명시했다. **동작은 한 글자도 안
건드렸다** — 고치는 것은 이 도구에 권한이 있는 쪽 몫이다.

---

## 5. `MultiAgent.applyPanelFlush` — 길이가 아니라 **세대**

팝아웃 복귀분이 라이브를 덮지 못하게 막는 가드가 `incoming >= live`(메시지 **개수**)였다.
r19-confirm §6-4: 이러면 **짧아지는 편집을 영구히 버린다.** 되돌리기·메시지 삭제처럼
스레드가 줄어드는 조작을 창에서 하면 복귀분이 통째로 무시된다.

크리틱은 "지금은 패널에 revert 알약이 안 그려져 도달 경로가 없다"며 결함이 아니라고 했다.
그 전제는 §1.3이 보여 주듯 **코드가 아니라 주석에만 있었고**, 통합 스토어 `chatId`가
패널에 들어오는 순간 살아난다. 지금 닫았다.

판정을 `seq`(리듀서가 모든 변화마다 +1 하는 단조 세대 카운터)로 갈았다:

| 상황 | 길이 | 세대 |
|---|---|---|
| 라이브가 앞선다(디바운스 600ms 동안 그리드가 더 먹었다) | 거절 ✔ | 거절 ✔ (M8-R2가 막은 그 사고 그대로) |
| 창에서만 일어난 변화(전송·중단·**되돌리기**) | 짧아지면 **거절 ✘** | 채택 ✔ |
| 스레드가 상한(`capThread`)에 닿아 둘 다 길이가 안 늘 때 | 구분 못 함 ✘ | 갈린다 ✔ |

`seq`가 숫자가 아닌 옛 복귀분만 예전 길이 규칙으로 떨어뜨린다(`sanitizeSnapshot`은 이미
`seq`를 보존한다).

---

## 6. 게이트

| 게이트 | 결과 |
|---|---|
| `npm run typecheck:app` | **PASS**(§6.1 단서) |
| `npm run tauri:build` | **PASS** (release · 1m26s · vite 번들 포함) |
| `node scripts/poc-live-chat.mjs --tag=sweep` | **PASS · 결함 0** — `docs/critic/m3-r4-live-sweep.json` |
| `node scripts/poc-dial.mjs` | **PASS**(다이얼 1↔6 무손실 · 전 항목 초록) |
| `node scripts/poc-auto-compact.mjs` | **all ok**(22검사 · F7 새 라벨 포함) |
| `node scripts/poc-account-switch.mjs --out=-sweep` | **PASS · 6판** — `docs/critic/m11-r1-switch-sweep.json` |
| 리듀서 12검사(임시 하네스) | all ok |

**기준 결과 파일 보호.** `poc-dial`에는 `--out`이 없어 `docs/critic/m-ux-r3-dial.json`을
덮었고, 주행 뒤 `git checkout --`으로 **원본 복원**했다(초록 판정은 위 표에 남긴다).
`poc-live-chat`은 `--tag=sweep`, `poc-account-switch`는 새로 판 `--out=-sweep`,
`bench/lsp.mjs`는 `--out -sweep`으로 전부 자기 파일에 썼다.

### 6.1 `typecheck:app` 단서 — 마지막에 **다시 못 돌렸다**

초록은 진짜다: `app/src` 다섯 파일(`store/session.ts`·`components/Chat.tsx`·`App.tsx`·
`api/unified.ts`·`components/MultiAgent.tsx`) 편집이 **전부 끝난 뒤** 돌려 통과했고, 그
뒤로 `app/src`는 한 글자도 안 건드렸다(이후 편집은 문서·`bench/`·`scripts/`·Rust 주석).
같은 소스를 `tauri:build`의 vite 단계가 한 번 더 굽고 통과했다.

**다만 마무리 재확인은 못 했다** — 동시 라운드가 `node_modules`를 통째로 비웠고(11분 이상
빈 채로 남아 있었다) `tsc`가 사라졌다. 나는 `npm ci`/`npm install`을 돌리지 않는다(이
라운드 규약 + 남의 설치 한복판을 밟는 게 더 위험하다). 다음 사람이 조용한 워크트리에서
`npm run typecheck:app` 한 번을 다시 돌리면 그만이다.

### 게이트 계약 변경 1건 (장부)

압축 경계 라벨 문자열이 바뀌었다(§2 F7). 내 경계 안은 갈았고, **크리틱 도구 쪽은 안
건드렸다**:

- `docs/critic/tools/critic-mui-compact-app.mjs:51` — 같은 검사를 옛 문자열로 단정한다.
  **다음 크리틱이 돌리면 이 한 줄이 붉다. 제품 결함이 아니라 이 계약 변경이다.**
- `docs/critic/tools/critic-mui-density.mjs:81`(+ `mui-notify-*.html` 목업)은 **픽스처**다.
  안 건드린 이유: 그게 밀도 A/B의 **같은 자**라 바꾸면 R1·R2 폭 수치와 비교가 성립하지
  않는다. 빌더 쪽 반복 실험용 자(`scripts/poc-ntf-narrow.mjs:97`)도 같은 이유로 그대로다.
  다음 재계측 때 제품 문자열로 갱신하면 m-ui §16 #6(극단 폭 84px)이 얼마나 움직이는지
  같이 나온다.

---

## 7. 남은 것

1. **압축 경계 라벨의 좁은 폭 실측을 안 했다.** 크리틱이 "높이를 안 바꾼다"고 했고 같은
   한 줄인 것은 맞지만, 판 내용 264px 같은 극단 폭에서 선이 몇 px가 되는지는 **안 쟀다** —
   픽스처를 안 건드리기로 했기 때문이다(§6 장부). 다음 밀도 재계측의 몫.
2. **`bench/lsp.mjs` provenance는 "필드가 실린다"까지만 봤다.** 같은 주행의 성능 수치는
   `ready` 미도달로 전부 비었다(§4.1 — 동시 라운드가 `node_modules`와 exe를 갈았다).
   **어떤 성능 주장도 이 라운드에서 하지 않는다.**
3. **멀티 패널·추가 채팅 창의 되돌리기는 여전히 없다.** 알약을 **일부러 안 그린다**
   (`canRevert` 미전달). 통합 스토어 `chatId`가 그 표면에 들어오는 라운드가 켤 자리다 —
   그때 §5의 세대 비교가 곧바로 값을 한다.
4. **`IdentityBand`의 `auto_account_switch` 가지는 스레드 band가 없을 때만 보인다.**
   실 창 판에서는 스레드 band가 항상 떠서 그 가지 자체는 **실물 렌더 확인을 못 했다**
   (문장·제목은 코드 리뷰 수준). 폴백의 같은 가지와 한 몸이라 위험은 낮다.
5. **동시 라운드와 한 워크트리를 썼다.** 이 라운드의 게이트는 M10(`talk`) 라운드의
   미커밋 변경이 섞인 워크트리에서 빌드·주행됐다(`src/shared/protocol.ts`·`engine/*`·
   `crates/*`). 내 커밋에는 그 파일이 **하나도 안 들어간다**.
   주행 순서와 시각으로 어느 바이너리였는지는 갈랐다: 내 릴리스 빌드(22:58) → 위 네
   PoC(22:59~23:08) → 그쪽 빌드가 `target/release`를 갈아치움(23:14). M11 판정은 그 자체로
   자기 증명이다 — `계정 되돌리기`/`되돌림 ✓`는 **이번 변경에만 있는 문자열**이라 옛
   바이너리에서는 `PICK-알약`이 붉게 떨어진다. `bench/lsp.mjs`만 그 뒤에 걸렸다(§4.1).
   `poc-ntf-narrow`·크리틱 밀도 도구처럼 **폭을 재는 하네스는 이 소란 중에 돌리지 않았다** —
   그 수치는 조용한 워크트리에서만 의미가 있다.
