# R28k M10 「대화 연결」 제거 — 확인 크리틱 R1

> **한 줄.** 제거는 진짜다. 내 손으로 두 벌을 빌드해 대조하니 여섯 축이 전부 뒤집혔고,
> 지우면 안 되는 넷은 넷 다 살아 있으며, `initialize` 바이트는 제거 전후로 한 글자도
> 안 변했다(sha `afb039fc7966…` · 161B). **그런데 「grep 0건」은 사실이 아니다** — 이번
> 라운드가 `<TalkStopPill />`을 지우면서 그 알약을 설명하던 주석 두 덩이를 **바로 그
> 자리에 남겼고**, 그 주석은 지금 「이 창에도 정지가 있다」고 거짓을 말한다. 그리고
> 장부 §6.13이 적은 `missing 6`은 **뜬 앱의 사실이 아니다**: 죽은 상수 넷 덕에 감사
> 도구가 `crosstalk:*` 넷을 아직 `impl`로 세는데, 실제 앱은 넷 다
> `{__unimplemented:true}`를 돌려준다(내가 눌러 봤다) — 참값은 **10**이다.

- 판정: **불합격**(치명 0 · 중 1 · 낮음 5). 제품 동작 회귀는 **하나도 못 찾았다.**
  걸린 것은 전부 「죽은 채 남은 것」과 「장부가 실제와 다른 것」이다.
- 나는 코드를 **한 줄도 안 고쳤다**. 이 판정문 한 파일만 쓴다.

---

## 1. 무엇으로 쟀나 (전부 내가 새로 만든 것)

| 축 | 값 |
|---|---|
| 워크트리(제거 후) | `D:/ccg-crit/r28k-post` = `7686383` (detached · 남의 미커밋·미추적 0) |
| 워크트리(제거 전) | `D:/ccg-crit/r28k-pre` = `57e55e6` (= `741bf57^`) |
| target(제거 후) | `D:/ccg-crit/target-r28k-rm-crit` — **새로 만든 것**(재활용 0) |
| target(제거 전) | `D:/ccg-crit/target-r28k-rm-critpre` — **따로 만든 것** |
| 빌드 | 양쪽 `vite build` + `cargo build --release --features custom-protocol` · 둘 다 exit 0 |
| exe(후) | `agentcodegui.exe` sha256 `941ad6eb0867c2a3811d24986c1e61cf045ea325627c207c70f890ef655fd048` · 7,066,624 B |
| exe(전) | `agentcodegui.exe` sha256 `628458670db04977f540a83f49d7fa3bb1b4477cdf4f031825d77bffb2f340a6` · 6,615,040 B |
| 가짜 CLI | `ccg-fakecli.exe` sha256 `f4bc9952e4713fec2f0fa836364afe66a4caf964dbabefc711e5fb452af5caf6` — **양쪽 주행에 같은 한 벌**(계기는 피검체가 아니다) |
| 홈 | 전부 격리 — `%TEMP%\ccg-crit-m10rm-<tag>`(내 하네스) · 레포 안 `.poc-home-m10rm-<tag>`(빌더 계기, 자동 삭제 확인) |
| CDP 포트 | 11052 · 11054(바이트) · 11060 / 11064 / 11068 / 11072 / 11076 / 11080 / 11084(화면) — R28j의 10900~10970과 안 겹친다 |
| 계기 | `C:/Temp/crit-r28k/critic-m10rm.mjs` — **내가 새로 썼다**(빌더 하네스와 씨앗·어휘·축이 다르고 축이 셋 더 많다). 산출물 `C:/Temp/crit-r28k/*.json` |
| 안 한 것 | 실계정·네트워크·이름 기반 kill·`git push`·기준 결과 파일 덮어쓰기 **전부 0**. 내가 스폰한 PID 트리만 죽였다 |

> 두 exe는 M10 제거 말고도 그 사이에 착지한 R28i/R28j 커밋만큼 다르다(빌더가 §5.1에
> 정직하게 적어 둔 그대로다). 그래서 exe 크기는 **커졌다**(업데이터 플러그인). 아래
> 대조군이 뒤집히는 축은 전부 M10 표면이고, 안 뒤집히는 축(승인 카드·계정·한도)은
> 양쪽 다 초록이다 — 두 방향 다 확인했다.

---

## 2. 체크리스트 항목별 실측표

### 2-1) 잔재 사냥 — **일부 실패**

제품 코드(`app/src` · `src-tauri/src` · `crates/*/src`) 직접 grep:

| 어휘 | 건수 | 판정 |
|---|---|---|
| `talk_guide` · `spawn_guide` · `talk_run` · `TalkStop` · `TalkConfig` · `TalkSent` · `TalkResult` · `QueueOrigin::Talk` · `require_picker` · `@talk` · `Ctrl+Shift+.` · `msg-origin` · `talk-stop` | **각 0** | 깨끗 |
| `picker_unavailable` · `TALK-DATA` · `reply_only` · `maxHops` · `maxFanout` · `injectPolicy` · `noticeAckAt` · `stopVerdict` · `stoppedAt` · `unstoppable` · `hop_cap` | **각 0** | 깨끗(빌더가 안 센 어휘까지 훑었다) |
| `crosstalk` | **4** — 전부 `src-tauri/src/ipc/mod.rs:285-289` | §3 **F1** |
| `대화 연결` | **6** — 5는 이번 라운드가 박은 못, 1은 위 파일 | 못은 정당 |
| `봉투` | 다수 — `chat:event`/`ma:event`/컨트롤 프레임의 일반 낱말. M10 것 아님 | 깨끗 |
| `M10`(주석 전수) | **PanelWindow.tsx:452 · SessionWindow.tsx:737 · runtime.rs:701** | §3 **F2·F3** |

번들(`app/dist/assets/*.{js,css}`): `crosstalk` · `talk-stop` · `@talk` · `대화 연결` ·
`msg-origin` · `talkpulse` · `TalkStop` **각 0**.

죽은 채 남은 것도 훑었다 — `ccg-store::talk::empty_blob`은 `ipc/unified.rs:84`가 쓰고,
`IconMessage`는 `NewChatModal`·`Sidebar`가 쓰며, `ThreadItem.origin`은 완전히 사라졌다.
`.chat--talk` 두 규칙은 **동결 렌더러**(`src/renderer/src/styles.css:796`)에도 같이 있는
1.x 잔재라 M10 몫이 아니다.

### 2-2) 부수 피해 — **넷 다 살아 있다**(★(d)는 바이트로 확인)

| 지우면 안 되는 것 | 내 확인 방법 | 결과 |
|---|---|---|
| (a) `crates/ccg-store/src/talk.rs` | 파일 31줄 · `read`/`write`/`empty_blob` 셋 · 호출처 `ipc/unified.rs:84` | **산다** |
| (b) `window.api.talk.getState/saveState` + 1.x 편입 | 씨앗에 `chat-talk.json`(대화 1건)을 심고 부팅 → `chats:get`에 그 제목이 **편입돼 있고**, 블롭은 `chats:[]`로 비워졌으며 `getState()`가 정상 응답 (**C8 초록**) | **산다** |
| (c) `migrate_v3`의 chat-talk 5단계 | 위 편입이 곧 그 단계의 실행 증거 · 소스 `migrate_v3.rs:389-410 · 712-714` 잔존 | **산다** |
| ★(d) `runtime.rs` `RunIdentity::system_prompt` append | **가짜 CLI stdin 바이트** — 추가 지시가 있는 채팅의 `initialize` 전문에 그 문자열이 `systemPrompt.append`로 실려 나갔다 | **산다** |

(d)의 전문(제거 **후** exe, 내 주행):

```
{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize","forwardSubagentText":true,"supportedDialogKinds":["refusal_fallback_prompt"],"systemPrompt":{"type":"preset","preset":"claude_code","append":"너는 코드 리뷰어다. 답은 한 문장으로만 한다."}}}
```

### 2-3) 프롬프트 바이트 — **동일** ✔

| 축 | 제거 전 exe(`…-critpre`) | 제거 후 exe(`…-crit`) | 판정 |
|---|---|---|---|
| 추가 지시 **없는** 채팅 `initialize` | sha256 `afb039fc7966a648…` · **161 B** · `systemPrompt` 키 **부재** | 같은 sha · 같은 161 B · 키 부재 | **바이트 동일** |
| 추가 지시 **있는** 채팅 `initialize` | sha256 `e73cf2f2310e…` · **291 B** · append에 그 문자열 | 같은 sha · 291 B | **바이트 동일** |

`--diff` 판정 `pass:true` · `plain.identical:true` · `instructed.identical:true`
(`C:/Temp/crit-r28k/bytes-critpre.json` · `-critpost.json`). 빌더의 값과 sha까지 일치한다 —
**내가 새로 빌드한 두 exe에서 재현됐다.**

> 계기 흠 하나(판정에 영향 없음): `poc-m10-removal-bytes.mjs`의 `exe.sha256`은 파일의
> sha256이 **아니다**(`readFileSync().toString('latin1')`을 다시 utf8로 해싱한다).
> 도장으로는 작동하지만 이름이 사실과 다르다. 진짜 파일 해시는 §1에 적었다.

### 2-4) 옛 홈 관용 — **초록**(홈은 내가 만들었다)

씨앗: `talk-config.json`(`enabled:true` · 보드 옵트인 2 · `injectPolicy:'readonly'` ·
`stoppedAt` · `noticeAckAt`) + `talk-state.json`(연쇄 2건) + `ui-prefs.json`에 `talk.enabled` ·
`crosstalk.board` 두 키 + `chat-talk.json`(1.x 대화 1건) + 손으로 심은 큐 **세 줄**.

- 부팅 ✔ · `#root` 마운트 ✔ · `window.api.app.getVersion()` ✔
- **두 M10 파일은 바이트로 그대로 남았다**(제거가 사용자 홈을 뒤지지 않는다)
- 설정 모달 정상 개시 ✔

### 2-5) 화면 잔재 — **세 창 전부 초록** (대조군은 세 창 전부 붉다)

| 축 | 제거 후 | 제거 전(대조군) |
|---|---|---|
| 나침반 `talk` · `대화 연결` · `crosstalk` · `긴급` · `봉투` · `@talk` · `세션 간` | 일곱 다 **`[]`** | `talk`/`대화 연결`/`crosstalk`/`긴급` → **`["Talk"]`** |
| 나침반 대조 검색어 `계정` | `["Account"]` (계기가 눈멀지 않았다) | 같음 |
| 메인 창 알약 + Ctrl+Shift+. | 없음 · 무반응 · 본문에 「대화 연결/긴급 정지」 문자열 0 | 알약 **뜸** · 본문 문자열 **있음** |
| 추가 채팅 창(`#session`) | 없음 · 무반응 | 키 누르니 알약 **뜸** |
| 팝아웃(`#mapanel`) | 없음 · 무반응 | 키 누르니 알약 **뜸** |
| `crosstalk:{config,set,stop,state}` 채널 | **넷 다 `{__unimplemented:true}`** | `config`/`set`/`stop`이 **설정 전문을 돌려준다**(`stop`은 `purged:1`까지) |

### 2-6) 봉투 재장전 — **버려지고, 디스크에서도 지워진다** (빌더보다 한 칸 더 재봤다)

빌더 씨앗은 두 줄(봉투·사람)이었다. 나는 **세 줄**로 심었다 — 필터가 **과잉**인지도
봐야 하기 때문이다: `origin:'talk'`(죽어야) · `'user'`(살아야) · `'limit_resume'`(살아야).

| 축 | 제거 후 | 제거 전(대조군, 긴급 정지 축을 끄고 잰 판) |
|---|---|---|
| 런타임 큐 | `queued:2` — 사람 ✔ 한도재개 ✔ **봉투 ✘** | `queued:3` — **봉투가 그대로 되살아난다** |
| 디스크(`chats-v3/<id>.json`) | `queue` 원본이 `["user","limit_resume"]`로 **다시 굳었다** | — |
| 계약면(`chats:load`) | `TALK-DATA` 0건 | — |
| 화면(본문 스캔) | `TALK-DATA` · `[대화 연결]` 0건 | — |

**`is_retired_talk_row`는 진짜 일을 하고, 과잉도 아니다.** 「어휘만 지우면 사람 이름표를
달고 되살아난다」는 빌더의 주장은 대조군에서 실제로 재현됐다.

### 2-7) 게이트 — **전부 초록**

| 게이트 | 값 |
|---|---|
| `cargo build --release --features custom-protocol` | exit 0 (양쪽) |
| `cargo test --workspace` (제거 후 워크트리) | **exit 0 · 756 passed / 0 failed / 13 ignored** |
| `agentcodegui` 기본 병렬 **10회 연속** | **10/10 초록 · 매회 136 = 1,360/1,360** |
| `tsc -p tsconfig.node.json` · `tsconfig.web.json` · `app/tsconfig.json` | **셋 다 exit 0** |
| `vite build --config app/vite.config.ts` | exit 0 (양쪽) |
| **컴파일 경고** | 제거 **전 0개** → 제거 **후 4개**(§3 **F1**) |

**크레이트별 테스트 수 — 이름까지 `comm`으로 대조했다**(제거 전/후 워크트리에 같은
방법 적용 · `--list` 기준이라 `#[ignore]` 포함):

| 크레이트 | 전(`57e55e6`) | 후(`7686383`) | 차 | 사라진 이름 |
|---|---|---|---|---|
| `agentcodegui` | 174 | 136 | **−38** | `engine::talk::tests::*` **43개 전부** · 늘어난 5는 R28j의 `updater::tests::*`(내 대조에서도 남의 것) |
| `ccg-engine` | 235 | 234 | **−1** | `turning_the_board_off_respawns_the_resident_cli`(순삭) + 이름만 바뀐 둘(`a_chat_without_a_talk_guide_…`→`…_without_extra_instructions_…`, `the_talk_guide_actually_reaches_the_cli`→`the_per_chat_extra_instruction_actually_reaches_the_cli`) |
| `ccg-store` | 92 | 85 | **−7** | `talk::m10_tests::*` 7개 전부 |
| `ccg-auth` · `ccg-fs` · `ccg-lsp` | 135 · 103 · 59 | 135 · 103 · 59 | 0 | — |
| 합 | **798** | **752** | −46 | = M10 51개 −  R28j 신설 5 |

인수인계 기준선 `workspace 798`과 내 제거 전 합계가 **정확히 798**로 맞는다.
`ccg-engine`이 빌더 표에서 233/232인 것은 `#[ignore]` 2개를 뺀 수치다(같은 값).
**사라진 51개는 하나도 빠짐없이 M10 것이고, 그 밖에 사라진 테스트는 0이다.**

### 2-8) 부수 피해 실사용 왕복 — **셋 다 초록**(대조군에서도 초록 = 제거와 무관)

| 축 | 확인 | 결과 |
|---|---|---|
| 승인 카드 왕복 | 가짜 CLI가 `can_use_tool{Write}` → `permission-request` 이벤트 ✔ → 렌더러 카드 ✔ → `chat:permission{allow}` → **CLI stdin에 `control_response` 도착(바이트 확인)** → `status:done` | **닫힌다** |
| 계정 축 | `auth.listAccounts()` = 두 계정 · `isDefault` 정상 | **산다** |
| 한도 자동 재개 | 재장전이 대기표를 그대로 날랐다 — `resetsAt` ✔ `attempts:1` ✔ **`episodeFires:2`** ✔ `autoPaused:false` · `autoResume:true` · 큐의 `limit_resume` 줄 생존 | **산다** |

### 2-9) 계약면 재고 — 빌더 수치 재현, **다만 그 수치가 사실이 아니다**

감사 도구(`docs/critic/tools/critic-r28e-channels.mjs`)를 **내가 두 워크트리에 직접** 돌렸다:

| 트리 | total | impl | commentOnly | missing |
|---|---|---|---|---|
| `D:/ccg-crit/r28k-pre` (`57e55e6`) | 216 | 207 | 0 | **9** |
| `D:/ccg-crit/r28k-post` (`7686383`) | 216 | 210 | 0 | **6** |

빌더의 표와 한 칸도 안 다르다. 줄어든 셋은 `app:update-*`(R28j 몫)이 맞다.
**그러나** 도구 산출 원자료를 열어 보니 `crosstalk:*` 넷의 `impl` 근거는 각각
`src-tauri/src/ipc/mod.rs`의 **상수 정의 한 줄뿐**이고(`codeN:1`), 뜬 앱은 넷 다
`{__unimplemented:true}`다(§2-5에서 내가 눌렀다). → §3 **F1**.

### 2-10) 커밋 경계 — **깨끗**

네 커밋(`741bf57`·`fe626b3`·`e86edd5`·`7686383`) 28+13파일 전수 확인:

- R28j UPDATER 소유(`ipc/mod.rs` · `api/shim.ts` · `protocol.ts` · `lib.rs` · `Cargo.toml` ·
  `tauri.conf.json` · `AppUpdateGate.tsx`) **0건**
- R28j DECIDE 소유(`docs/decisions-3.0.md` · `bench/**` · `m1/m12-report`) **0건**
- `docs/critic/final-parity-*.md` · `progress/**` **0건**
- `docs/renderer-divergence.md`는 **파일 끝 순수 추가 40줄**(`@@ -887,3 +887,43 @@`) — 옆
  갈래의 §6.12 헛(hunk)이 안 섞였다
- 기준 결과 파일(`docs/critic/*.json` · `bench/results/*`) 덮어쓰기 **0건**(전부 신규 추가)
- 미추적 남의 계기(`probe_wfire_crit.rs` · `probe_wfr2.rs`) 커밋 **안 됐다**
- 합계 **28파일 · +384 / −10,279** — 보고서 수치와 정확히 일치(`git show --numstat` 합산)

---

## 3. 남은 잔재·부수 피해 (등급 · 재현 절차)

### F1 [중] 장부 §6.13의 `missing 6`은 뜬 앱의 사실이 아니다 — 참값은 **10**

- **무엇.** `src-tauri/src/ipc/mod.rs:282-289`의 `CROSSTALK_{CONFIG,SET,STOP,STATE}` 넷은
  디스패처 팔이 사라져 **죽은 상수**다(컴파일러가 `never used` 4개로 확인 — 제거 **전**
  빌드 경고 0개 → **후** 4개). 감사 스캐너는 그 정의 한 줄씩을 근거로 넷을 아직
  `impl`로 세고, 그래서 `missing`이 6으로 나온다. 실제 앱은 넷 다 `{__unimplemented:true}`다.
- **왜 중인가.** 이 파일은 R28j UPDATER 소유라 **이 라운드가 못 고치는 것이 맞다**.
  문제는 그 사실이 **장부에 안 적혔다**는 것이다. `docs/renderer-divergence.md` §6.13은
  「제거 후 216 / impl 210 / missing **6**」을 표로 못 박아 놓고 이 관대함을 **한 줄도**
  안 붙였다(같은 경고가 `docs/parity-fix-m10-removal-r1.md` §6에는 블록인용으로 있다).
  최종 파리티 서명은 §6.13을 인용한다 — 그 순간 **채널 넷이 거짓 초록으로 통과한다.**
  체크리스트 7의 「장부가 실제와 맞는가」가 정확히 여기서 걸린다.
- **재현.**
  1. `node docs/critic/tools/critic-r28e-channels.mjs --tree=<제거 후 워크트리> --out=x.json`
     → `impl 210 / missing 6`. `x.json`에서 `crosstalk`를 찾으면 `verdict:"impl"` ·
     `code:["src-tauri/src/ipc/mod.rs:285"]` · `codeN:1`.
  2. 같은 exe를 격리 홈으로 띄우고
     `invoke('ipc_call',{channel:'crosstalk:config',payload:[{}]})` → `{__unimplemented:true}`.
     넷 다 같다.
- **뒷정리에 필요한 것.** 지금은 §6.13에 각주 한 줄이면 된다. 코드는 다음 라운드가
  `ipc/mod.rs` 282-289와 `protocol.ts`의 IPC 항목 넷을 **같은 커밋에서** 걷으면 닫힌다.

### F2 [낮음] `<TalkStopPill />`을 지우고 **그 알약을 설명하는 주석을 그 자리에 남겼다**

- **어디.**
  - `app/src/components/SessionWindow.tsx:737-739` — *「★M10 R3 C4 — **이 창에도 정지가
    있다.** R2는 알약·단축키·상태 구독이 전부 `App.tsx` 안에 있어서, 이 창에서
    Ctrl+Shift+. 를 눌러도 아무 일이 없었다(크리틱 D6). …」*
  - `app/src/components/PanelWindow.tsx:452-453` — *「★M10 R3 C4 — 팝아웃 패널은 **보드를
    보는 창**이다. … 그 창이 정확히 정지가 없는 창이었다(크리틱 D6).」*
- **왜 잔재인가.** `git show fe626b3` 를 보면 두 자리 모두 **주석 바로 다음 줄의
  `<TalkStopPill />`만 지웠다.** 지금 그 주석은 없는 UI를 「있다」고 말한다. 같은 커밋이
  `App.tsx`·`Chat.tsx`·`store/session.ts`에서는 **같은 성격의 주석을 전부 지웠다** —
  즉 의도가 아니라 **빠뜨린 것**이고, 보고서 §3 마지막 행의 「내가 새로 쓴 주석 5줄」
  목록에도 이 둘은 없다. 「grep 0건」이라는 문장이 이 둘 때문에 사실이 아니다.
- **재현.** `git grep -n "M10" -- app/src/components` → 두 줄. 두 파일을 열면 삭제된
  컴포넌트를 가리키는 주석이 그대로 있다.
- **영향.** 동작 0. 다음 사람이 「정지가 어디 갔지」를 찾아 헤매거나 되살릴 위험뿐이다.

### F3 [낮음] `runtime.rs:701-704`의 M10 주석이 **불가능해진 시나리오**를 설명한다

- 본문: *「★M10 R2 C4 — … 디스크에 `talk`으로 앉아 있던 세션 간 예약이 부팅 한 번에
  사람 것으로 되살아나 그 값이 다시 굳었다(크리틱 A7).」*
- `talk` 어휘는 이제 `QueueOrigin`에도 `origin_of`에도 없고, 그런 줄은 셸이
  `is_retired_talk_row`로 통째로 버린다. 같은 커밋이 **쌍둥이 주석**
  (`crates/ccg-store/src/status.rs`의 `QueuedText.origin` doc)에서는 `talk`을 어휘 목록에서
  **지웠다** — 여기만 안 지웠다. 서사가 서로 어긋난다.
- 재현: `sed -n '695,706p' crates/ccg-engine/src/runtime.rs`.

### F4 [낮음] 인수인계 문서가 아직 **M10을 만들라고** 적혀 있다

- `docs/HANDOFF-3.0.md:198` — *「**M10 신기능**: 세션 간 협업(클로드 4개가 서로 대화).
  과거 구현이 `git stash`에 보관돼 있다 … 참고만 하고 **새로 짜라**」* → 철회 표시 없음.
- `docs/ARCHITECTURE-3.0.md:42` — `ccg-peer  # (M10) 세션 간 메시징 허브` → 철회 표시 없음
  (이 줄은 원래도 낡았다 — 그 크레이트는 만들어진 적이 없다).
- 두 파일 다 어느 갈래 소유도 아니다. 다섯 장에 도장을 찍으면서 **다음 사람이 실제로
  먼저 읽는 문서 둘**이 빠졌다. 철회 사유가 「위험해서 사용자가 뺐다」인 기능인데
  인수인계서는 여전히 「새로 짜라」고 말한다.

### F5 [낮음] `docs/critic/`의 M10 판정문 일곱 장에는 철회 헤더가 없다

`m10-r{1,2,3}.md` · `r28f-m10-critic-r{1,2}.md` · `r28h-m10-critic-r{1,2}.md`.
이 중 `r28*-m10-*.md` 넷은 **이 갈래 소유**다(소유권 표의 `docs/critic/r28*-m10-*.md`).
보고서·설계 다섯 장은 도장을 받았는데 같은 사건의 판정문은 안 받았다.

### F6 [낮음] 미룬 계약면 줄 목록이 **세 군데 한 줄씩 어긋난다**

`docs/parity-fix-m10-removal-r1.md` §7.2를 `src/shared/protocol.ts`와 한 줄씩 대조했다:

| 보고서 | 실제 | 그대로 지우면 |
|---|---|---|
| `492–496` 주석 5줄 | 주석은 **492–497**(6줄) | 497(`// 사용자는 두 세션이 왜 안 붙는지…`)이 고아로 남는다 |
| `1542–1571` `TalkSent` | 인터페이스 닫는 `}`가 **1572** | `}` 하나가 남아 **TS 구문 오류**(다행히 즉시 잡힌다) |
| `1610–1616` `CROSSTALK` | doc 주석이 **1609** | `/** 긴급 정지 상수 … */` 가 고아로 남는다 |

`1511–1540`(`TalkResult`) · `1574–1608`(`TalkConfig`) · `1347–1353`(IPC 표) · 「건드리지
마라」 목록(`1117–1122` · `1275` · `796` · `TALK_GET`/`TALK_SAVE`)은 **전부 정확했다**.
`'picker_unavailable'`이 엔진에서 사라졌다는 §7.4의 지적도 사실이다(제품 코드 0건).

### 확인했으나 **결함이 아닌 것**(다음 크리틱이 다시 파지 않게 적어 둔다)

- `app/src/styles.css`의 `.chat--talk` 두 규칙 — 동결 렌더러에도 같이 있다. 1.x이고 M10보다 앞선다.
- `app/src/api/shim.ts:510-518`의 `talk:{run,cancel,…}` 여섯 — 1.x 채팅 엔진. 감사의
  `missing 6`이 이것이고 **M10이 아니다**. 최종 파리티 감사 R5 §6의 「M10 소유」는
  이름 충돌 오분류라는 빌더의 정정이 맞다(2.6.2 `src/main/index.ts:1128`이 구현했고
  2.6.2 렌더러 호출처 0).
- `src/shared/protocol.ts:796` `ApiUsageSource`의 `'talk'` — 같은 1.x 축.
- `migrate_v3.rs`의 `★M10 R2 §5` 주석 셋 — **살아 있는 로직**의 역사 귀속이라 잔재가 아니다.
- `append_prompt`가 공백뿐인 추가 지시를 이제 `None`으로 떨군다(제거 전엔 공백을
  그대로 실었다). 2.6.2(`engine.ts:906`의 `req.systemPrompt?.trim()`)와 **같은 방향**이므로
  파리티 개선이다.

---

## 4. 내가 만진 것

- 레포 **코드 수정 0**. 새 파일은 이 판정문 하나(`docs/critic/r28k-m10rm-critic-r1.md`)뿐이고
  `git commit --only`로 그 한 파일만 커밋한다.
- 레포 밖: 워크트리 둘(`D:/ccg-crit/r28k-{pre,post}`) · target 둘
  (`D:/ccg-crit/target-r28k-rm-crit{,pre}`) · 계기와 산출물(`C:/Temp/crit-r28k/`).
  격리 홈은 전부 자동 삭제됐다(레포 안 `.poc-home-m10rm-*` 잔존 0 확인).
- 남의 미커밋 변경(`bench/multi.mjs` · `bench/ratios.mjs` · `docs/decisions-3.0.md` ·
  `docs/renderer-divergence.md` 등)은 **reset·checkout·stash·restore 전부 안 했다.**
- 기준 결과 파일은 하나도 안 덮었다 — 내 산출물은 전부 `C:/Temp/crit-r28k/` 아래
  새 이름(`bytes-crit{pre,post}.json` · `screen-crit*.json` · `chan-{pre,post}.json` ·
  `list-{pre,post}-*.txt`)이다.

---

## 5. 판정

**불합격 — 그러나 되돌릴 것은 없다.**

제거 자체는 이 갈래가 주장한 그대로였다. 라우터·봉투·회신 잠금·설정 탭·알약·단축키·
주입 배지가 **세 창 전부에서** 사라졌고, 대조군은 여섯 축에서 정확히 반대로 나오며,
지우면 안 되는 넷은 넷 다 살아 있고, `initialize` 바이트는 제거 전후로 같으며, 게이트는
크레이트별·워크스페이스·10회 병렬·타입체크 3종까지 전부 초록이다. 사라진 테스트 51개는
이름까지 M10 것이었고 그 밖에 사라진 것은 0이다. **제품 동작 회귀는 못 찾았다.**

불합격은 **잔재 조항**에서 온다.

1. **F1(중)** — 장부 §6.13이 못 박은 `missing 6`이 뜬 앱의 사실이 아니다. 참값은 10이고,
   그 차이는 이 라운드가 만든 죽은 상수 넷에서 온다. 코드를 못 고치는 것은 규율상
   옳지만, **아는 사실을 장부에 안 적은 것**은 이 라운드의 몫이다. 각주 한 줄이면 닫힌다.
2. **F2·F3(낮)** — 지운 컴포넌트를 설명하는 주석이 그 자리에 그대로 남아 거짓을 말한다
   (`SessionWindow.tsx:737` · `PanelWindow.tsx:452` · `runtime.rs:701`). 같은 커밋이 다른
   세 파일에서는 같은 주석을 지웠으므로 의도가 아니라 누락이고, 「grep 0건」이라는
   보고서 문장을 사실이 아니게 만든다.
3. **F4·F5·F6(낮)** — 인수인계서는 아직 M10을 만들라고 적혀 있고, 판정문 일곱 장에는
   도장이 없으며, 뒷정리 줄 목록이 세 군데 한 줄씩 어긋난다.

**가장 치명적인 하나: F1.** 나머지는 주석과 문서라 다음 사람이 웃고 지나가지만, F1은
**최종 파리티 서명이 인용할 숫자**다. 그 표에 각주가 없으면 `crosstalk:*` 넷이 「구현됨」
으로 통과한다 — 방금 통째로 들어낸 그 넷이.
