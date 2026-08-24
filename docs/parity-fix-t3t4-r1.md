# 최종 파리티 R1 후속 — T3T4 갈래 R1

> **후속**: 이 라운드는 확인 크리틱에서 **불합격**했다(실패 2 · 부분 1 · [부분] 3).
> 수정과 재실측은 `docs/parity-fix-t3t4-r2.md`. 특히 §1.3의 *"훅은 한 글자도 안 고쳤다"*
> 는 **틀린 판단이었다** — Rust가 실값을 흘려도 *조회가 실패하는 판*은 여전히
> 「풀렸다」로 착지한다(R2 §1). 아래 본문은 당시 기록 그대로 둔다.

빌더: T3T4 · 2026-08-24 · `feature/3.0.0-beta`
근거 문서: `docs/critic/final-parity-r1.md` (§3.1 T3·T4 · §3.2 H1·H2·H4·H5 · §3.3 M1·M2·M3·M5)

| 커밋 | 무엇 |
|---|---|
| `4197a84` | **T3** — `usage:get` · `auth:accounts-usage` |
| `e581b2a` | **T4 + H5·H1·H2·H4 + M1·M3·M2** — btw 포크 창 · 닫기 flush · 첨부 picker · MCP/스킬 · Codex 모델 · Ctrl+W · API 설정 점프 · 초기 폴더 |

실측 산출물: `docs/critic/parity-t3t4-r1.json` (하네스 `scripts/poc-parity-t3t4.mjs`)

---

## 0. 한 문단 결론

감사가 "치명 4 · 높음 5 · 중간 6"으로 센 자리 중 **9채널 묶음을 채웠고, 37/37 실물
실측으로 확인했다**(격리 홈 + 실 HTTP). 블라인드 유일한 1패의 원인이던 한도 조회는
실값을 낸다 — `weekly.pct=100 · resetsAt=1787752800`으로, 감사가 2.6.2에서 읽은
바로 그 값이다. 그 과정에서 **T4가 없으면 영영 드러나지 않는 잠복 버그 셋**을 잡았다
(§2.2). 남긴 것은 둘: `app:open-directory`의 second-instance 절반(설치기 라운드 몫,
§5) · `git:ai-message`(실행 계통 필요, §5).

---

## 1. T3 — 한도 조회 (치명)

### 1.1 무엇이 비어 있었나

`usage:get`·`auth:accounts-usage`에 Rust 핸들러가 없어 심이 `{fiveHour:null, weekly:null,
weeklyFable:null, extraCredit:null}`을 돌려줬다. 크래시가 없으니 화면은 멀쩡히 떴고,
그래서 **셋이 조용히 죽어 있었다**.

### 1.2 무엇을 만들었나

`src-tauri/src/ipc/parity/usage.rs`. `crates/ccg-auth`가 요청 빌더·파서·HTTP 실행기를
이미 갖고 있어(M5·M11) **조립만 했다 — ccg-auth는 한 줄도 안 고쳤다**(T1T2 갈래가 같은
크레이트를 만지고 있어 파일 단위로 겹치지 않는 게 이번 라운드의 규율).

새로 만든 것은 캐시 계층 하나뿐이다: 2.6.2 `index.ts:1006-1037` `usageCache`를 옮긴
메모리 캐시(**토큰 동치** + TTL 5분/신선 15초 + 계정별 조회 차선).

- **1200ms 직렬화는 여기서 또 감싸지 않았다.** 2.6.2는 `auth.ts:503` `usageSlot`으로
  두 경로를 함께 직렬화했는데, 3.0은 같은 규약이 한 층 아래 `net::send`의 전역 `GATE`
  (`USAGE_GAP_MS = 1_200`)에 이미 있다. 여기서 또 감싸면 간격이 2400ms로 겹친다.
- **`auth:accounts-usage`는 일부러 디스크 캐시**(`usage-cache.json`, 2분)를 읽는다.
  `engine/acct_switch.rs`의 자동 전환기가 쓰는 바로 그 파일이라 둘이 서로의 조회를
  재사용한다. 메모리 캐시를 따로 뒀다면 조회 루프가 두 벌이 되고, 그 둘이 각자 만료를
  세며 오래 논 계정의 리프레시 토큰을 번갈아 회전시킨다 — M11 R2 C1이 부팅 프리웜을
  들어낸 바로 그 사고다.

### 1.3 ★한도 자동 이어서의 오판이 사라졌다 (M11 안전장치 복구)

감사의 지적: `useLimitResume.ts:144`의 `blockedResetsAt(await getUsage(...))`가 창 넷이
전부 `null`인 값을 받으면 `limitResume.ts:62-71`의 `!w` continue를 타고 **"막는 창 없음"**
에 착지한다. 즉 조회가 죽어 있는 동안 M11이 세운 2단 재검증은 10분마다 다시 막히는
**재전송기**였다.

**훅은 한 글자도 안 고쳤다**(렌더러 이식본 불가침). Rust가 실값을 흘리는 것만으로 판정이
되살아난다. 실측(하네스 T3-2·T3-3):

```
usage:get(fresh) = {
  fiveHour:    { pct: 0,   resetsAt: null },
  weekly:      { pct: 100, resetsAt: 1787752800 },   ← 감사가 2.6.2에서 읽은 값과 동일
  weeklyFable: { pct: 33,  resetsAt: 1787752800 },
  extraCredit: { enabled:false, ..., pct: 0 }
}
→ blockedResetsAt의 입력 네 창이 전부 객체이고 pct가 숫자다 = 판정 근거가 있다
```

`scripts/poc-limit-resume.mjs` **39 통과 / 0 실패**(훅 로직 무수정 회귀 확인).

### 1.4 계정별 한도 — 「한도 적게 남은순」의 근거 (T3-4~6)

6계정 전부 실값. 설정 ▸ Account가 정렬에 쓰는 세 필드(`Settings.tsx:318`
`[fiveHourPct, fablePct, weeklyPct]`)가 계정마다 갈린다:

```
lmg56634@…  남은 0%     junelius@naver  남은 1%     lmg56631@…  남은 24%
lmg56635@…  남은 52%    lmg56630@…      남은 63%    lmg56632@…  남은 85%
```

캐시: 첫 조회 334ms → 두 번째 3ms(TTL 적중).

---

## 2. T4 — `/btw` 포크 질문 창 (치명)

### 2.1 규약 넷을 전부 세웠다

Rust 핸들러가 **0개**였다(`engine/mod.rs:27` 주석에만 이름이 있었다). 전 화면 A/B의
도달 실패 3건(`btw-dock`·`multi-panel-btw-dock`·`session-window-btw`)이 이 한 채널이다.

| 규약 | 어디서 | 실측 |
|---|---|---|
| forkSession 포크 | 레코드의 `btwSeed{fork,cwd}` → hydrate → `btwRunResume` | T4-5 · **T4-6b** |
| own 생기면 재포크 금지 | 렌더러 몫(`btwRunResume`이 `own`을 먼저 본다) | `poc-btw-fork` D |
| btwPrompt는 읽으면 소비 | `legacy_bridge::session_chat_hydrate` | T4-7 · T4-8 |
| 브로드캐스트는 전 창 | `win.rs broadcast_sessions` | T4-2 |
| wrapBtwFork 포크 실행 1회만 | **렌더러 몫으로 남겼다** — 셸이 또 붙이면 두 벌이 된다 | `poc-btw-fork` E |

`scripts/poc-btw-fork.mjs` **33 통과 / 0 실패**.

**T4-6b가 이 라운드의 가장 강한 증거다.** 합성 시드(`ses-fork-1`)로 창을 열었더니 첫
실행이 실제로 `--resume ses-fork-1`로 나갔고, CLI가 *"Provided value \"ses-fork-1\" is
not a UUID"* 로 거절했다 — **거절문이 시드를 인용한다 = 포크 인자가 실행에 실렸다.**
(진짜 세션 id로 재려면 턴을 한 번 돌려야 하는데, 이 계정은 주간 한도 100%라 불가능하다.)

레코드를 **창보다 먼저** 심는다. 2.6.2는 메모리 Map이라 순서가 보장됐지만 3.0의 진실은
파일이고 hydrate도 파일을 읽는다 — 뒤집으면 첫 실행이 포크가 아니라 새 대화로 나가
원본 컨텍스트를 통째로 잃는다.

### 2.2 ★그 과정에서 잡은 잠복 버그 셋

**T4를 만들지 않았다면 셋 다 드러나지 않는다.** 셋 다 "구현이 없어서"가 아니라
"구현이 있는데 값이 안 통한다"는 종류라, 채널 전수 대조로는 안 잡힌다.

1. **포크 시드를 펴는 자리가 없었다** (`legacy_bridge.rs session_chat_hydrate`).
   계약면은 평평한 `btwFork`/`btwForkCwd`인데 레코드는 `btwSeed{fork,cwd}` 묶음이고
   (마이그레이션도 그 모양 그대로 옮긴다 — `migrate_v3.rs:225`), 3.0은 평평한 키를
   *복사만* 했다. 그 키의 작성자가 아무도 없으니 값은 **언제나 없었다** = 2.6.2에서
   마이그레이션해 온 btw 채팅조차 첫 실행이 새 대화로 나갔다.
   2.6.2 `index.ts:1206`처럼 **펴서** 내린다.
2. **`shown`이 `true` 고정**이었다 (`legacy_bridge.rs session_chat_infos`).
   `shown`의 뜻은 "그 창이 지금 눈에 보인다"인데 **창이 아예 없는 줄**에 참이 실렸다.
   btw 알약은 `!w.shown`으로 거르므로(`Chat.tsx:4885`) 이 한 칸 때문에 **알약이 영원히
   안 뜬다** = "창 X = 무조건 알약"이라는 2.6.2 규약이 통째로 죽고, 닫은 btw 창으로
   돌아갈 길이 없어진다.
3. **`btwOf`가 목록에 안 실렸다.** 원본 간선이 없으면 어느 화면도 알약을 못 그린다
   (`App.tsx:1995`). 열린 창은 `SessionRec`이 창 생성 시 한 번 읽어 들고(턴마다 도는
   브로드캐스트가 디스크를 다시 파지 않게), 닫힌 채팅은 `ChatHead`에 필드 한 칸을 더해
   얕은 스캔 그대로 싣는다.

덤으로 최소화/복원 전이에서 목록을 다시 쏜다(**값이 바뀐 순간에만** — 드래그 리사이즈는
초당 수십 번이다). 안 그러면 창을 내려놓고 알약을 찾을 수 없다.

---

## 3. 높음 4건

### H5 — 닫기 전 마지막 저장 악수

두 구멍이 겹쳐 있었다.

(a) **`session-wins:flush-request`의 방출자가 0**이었다. 3.0 셸은 `chat:flush-req`로
갈아탔는데 이식 렌더러는 옛 채널만 듣는다 → 요청이 한 번도 도착한 적이 없다.
→ **셸이 둘 다 쏜다**(장부 §3.5.1에 규약으로 남겼다).

(b) **추가 채팅 창에 `CloseRequested` 핸들러가 없었다**(`Destroyed`만). X를 누르면 그
순간 문서가 죽고, 렌더러 저장은 600ms 디바운스라 마지막 편집이 창과 함께 사라진다.
팝아웃 창은 `popout.rs:255`가 합성 `beforeunload`로 덮었는데 이 창만 안 덮였다.

2.6.2 `flushAndDestroy`/`finishFlush`와 같은 순서(가로채기 → "지금 저장해" → 저장 도착
또는 1.5초 유예 → 파기). 다른 것 하나: **숨기지 않는다.** 3.0은 실행이 창이 아니라
채팅에 붙어 있어(`engine/hub`) 창을 없애도 턴이 계속 돈다 — 숨은 창을 들고 있을 이유가
없다(창 하나가 곧 25.1MB다).

실측(H5-1·H5-2): 창의 X → **창이 실제로 닫히고**, 그 직전에 옛 채널로 도착한 요청이
만든 저장(`FLUSH-OK`)이 디스크에 남아 있다. *증거를 디스크에 남긴 이유*: 창은 flush
직후 파기되므로 페이지 안의 카운터는 읽어 낼 창이 없다.

### H1 — 첨부 파일 선택

컴포저 「＋」가 3표면에서 무반응이었다(드래그·붙여넣기는 되므로 착각하기 쉬운 자리).
다중 선택 + 필터 3벌, 취소는 `[]`. 확장자는 동결 구역 `src/shared/attachments.ts`의
미러이고 **단위 테스트가 그 파일을 직접 읽어 대조한다**.

실측: 본채팅·추가 채팅 창·멀티 패널 **3표면 모두** 네이티브 `#32770` 대화상자가 떴다
(우리 PID의 창만 세고, 확인 후 그 창에만 `WM_CLOSE`).

> **부수 관측 1건(이 라운드 범위 밖).** 같은 그물로 `dialog:pick-directory`를 재 보니
> `#32770` 창이 **안 잡힌다**(폴더 picker는 다른 창 클래스다). 즉 크래시 복구의 고아
> 대화상자 정리(`ipc/system.rs close_orphan_dialogs`)는 **첨부 picker는 덮고 폴더
> picker는 못 덮을 가능성**이 있다. R4 크리틱 A5가 재현했던 그 사고의 원본이 폴더
> picker였으므로, 다음 라운드가 클래스 그물을 다시 재 볼 것을 권한다.

### H2 — MCP·스킬 목록/토글

감사 실측은 2.6.2 = 1건/1건, 3.0 = 0건/0건이었다. `src/main/mcp.ts`·`skills.ts`를 옮겼다.
같은 모양의 스크래치 프로젝트로 재측정 — **3.0 = 1건/1건(동수 달성)**, 요약·설명·토글까지.

규약 셋: ① 끔 목록은 **앱 홈**(`mcp.json`·`skills.json`)에 산다 — 사용자의
`~/.claude.json`·`~/.claude/skills`는 불가침(H2-6로 확인) ② `.mcp.json`·`.claude/skills`를
**조상 폴더까지** 훑고 이름이 겹치면 가까운 쪽이 이긴다(엔진이 그렇게 읽는다 — 단위
테스트로 확인) ③ 정렬은 이름 사전순, 동률이면 출처 순위.

M9의 채팅별 칩(`chat:tooling-get`)과는 **별개로 산다**(저쪽은 실행 중 CLI가 말해 준 것,
이쪽은 실행 없이 디스크). `scripts/poc-mcpskill.mjs`(와이어) **전부 통과** — 그 축의
회귀 없음.

### H4 — Codex 모델 목록

감사는 "picker에 모델이 없다"고 적었지만 **실제로는 비지 않는다** — `Chat.tsx:200`이 빈
목록을 `codexFallback()`(하드코딩 3종)으로 받는다. 진짜 손해는 셋이다: 서버가 새 모델을
내도 영영 안 보이고, `isDefault`를 몰라 기본 표시가 없고, `efforts`를 몰라 effort 사다리가
근거 없이 돈다. **감사의 심각도 서술을 이 방향으로 정정한다.**

`CodexDriver`는 턴 상태기계에 묶여 있어 목록 조회를 태우려면 가짜 턴이 필요하다.
그래서 JSON-RPC **두 줄**(`initialize` → `model/list`)만 주고받고 프로세스를 바로 거둔다.
실측 — 325ms에 **7종**:

```
gpt-5.6-sol(기본) · gpt-5.6-terra · gpt-5.6-luna · gpt-5.5 · gpt-5.4 · gpt-5.4-mini · gpt-5.2
efforts: low/medium/high/xhigh/max/ultra (모델마다 다름)
```

감사가 2.6.2에서 읽은 `gpt-5.6-sol`과 같은 목록이고, **폴백 3종에 없는 4종이 더 있다**
(`gpt-5.5`·`5.4`·`5.4-mini`·`5.2` — 렌더러의 `CODEX_HIDDEN`이 앞 셋을 거르므로 화면
결과는 폴백과 같지만, 이제 그 판단의 원천이 서버다).

캐시 5분, 갱신이 빈 목록이면 **이전 목록을 지킨다**. `CCG_NO_NET`이면 프로세스를 한 번도
안 띄운다(단위 테스트).

---

## 4. 중간 3건

| # | 채널 | 실측 |
|---|---|---|
| M1 | `shortcut:close` | 셸 소유 주입 스크립트 → `ipc_call` → 그 창에 되쏨. Ctrl+W 왕복 **1회 수신** |
| M3 | `ui:open-api-settings` | 추가 채팅 창의 요청이 메인 창의 `ui:api-settings-requested`까지 **1회 도달** |
| M2 | `app:get-initial-dir` | argv 폴더가 그대로 내려온다(콜드 런치 반쪽) |

M1은 Tauri에 `before-input-event`가 없어서(웹뷰 안의 키는 셸에 안 온다) 문서 쪽에 귀를
심었다. 렌더러 이식본은 지금도 이 채널을 **구독만** 하고 방출자만 없었다 —
한 글자도 안 고쳤다. 자세한 규약은 `docs/renderer-divergence.md` §5.2.

---

## 5. 남긴 것과 이유

| # | 무엇 | 왜 안 했나 |
|---|---|---|
| M2 후반 | `app:open-directory`(이미 떠 있는 앱에 폴더가 또 오는 경우) | 유일한 발원지가 **단일 인스턴스 잠금**이다. 3.0에 그 플러그인을 넣는 순간 **격리 홈으로 동시에 여러 벌 띄우는 하네스가 전부 죽는다**(지금 세 갈래가 그렇게 돈다). 설치기가 컨텍스트 메뉴를 등록하는 라운드(M12)와 함께 결정할 일이다 — `app_meta.rs:11`의 원래 판단과 같다 |
| M5 | `git:ai-message` | 2.6.2는 SDK `query()`로 **1턴 실행**을 돌린다(`git.ts:510`). 3.0에서 같은 일을 하려면 채팅에 붙지 않는 일회성 실행 경로가 필요한데, 그건 엔진 계통(T1T2의 `engine:*`)과 설계를 맞춰야 한다. 이번 라운드에서 혼자 만들면 실행 경로가 두 벌이 된다 |
| H3 | 앱 자동 업데이트 | **범위 밖**(사용자 결정 대기 · M12R2가 설계 문서만) |

---

## 6. 병렬 규율 — 이 라운드에 지킨 것

- **남의 미커밋 변경을 건드리지 않았다.** T1T2가 같은 워킹트리에서 `ipc/mod.rs`·
  `engine/mod.rs`·`ipc/system.rs`를 고치는 중이라, 그 셋은 **내 hunk만** 스테이징했다
  (`pub mod parity;` / `pub mod codex_versions;` / `DialogGuard`). `git add -A`는 쓰지
  않았고 `reset`·`checkout`·`stash`도 쓰지 않았다.
- **이름 기반 kill 0회.** 하네스는 자기가 spawn한 PID 트리만 죽이고, 네이티브
  대화상자도 그 PID의 `#32770`에만 `WM_CLOSE`를 보낸다.
- **실계정 토큰 회전 0회.** 하네스는 자격증명을 **복사**하고, 복사 전에 액세스 토큰의
  남은 수명을 확인해 **20분 이상 살아 있는 계정만** 싣는다(`net::access_token`은 로컬
  우선이라 살아 있으면 리프레시 교환이 안 돈다). 이번 주행에서 6계정 전부 72~440분
  잔여였다.
- 격리: `CCG_HOME=.poc-home-t3t4` · CDP 포트 `9421` · `CARGO_TARGET_DIR=target-t3t4`.
- 기준 결과 파일은 덮지 않았다 — 새 산출물은 `docs/critic/parity-t3t4-r1.json` 하나다.

## 7. 실측 요약

| 항목 | 값 |
|---|---|
| `scripts/poc-parity-t3t4.mjs` (격리 홈 + 실 HTTP) | **37 통과 / 0 실패** |
| `scripts/poc-btw-fork.mjs` | 33 / 0 |
| `scripts/poc-limit-resume.mjs` | 39 / 0 |
| `scripts/poc-mcpskill.mjs` (와이어) | 전부 통과 |
| `cargo test --bin agentcodegui` | 98 / 0 (그중 `ipc::parity` **19**) |
| `cargo test -p ccg-auth` | 86 / 0 |
| `cargo test -p ccg-store --lib` | 76 / 0 |
| `cargo test -p ccg-engine --lib` | 63 / 0 |
| `npm run typecheck` + `typecheck:app` | 3종 초록 |

> **알려진 흔들림 1건(내 것이 아니다).** `ccg-store`의
> `migrate_v3::tests::a_torn_boards_index_does_not_take_the_3_0_boards_with_it`이 3회 중
> 1회 `is_migrated()` 전제에서 빨개진다. 이 라운드는 `migrate_v3.rs`를 만지지 않았고
> (내 `ccg-store` 변경은 `ChatHead` 필드 한 칸 + `session_chat_infos`/`hydrate`),
> 실패 지점도 보드 인덱스라 무관하다. 워크스페이스 일괄 주행에서는 `ccg-auth`의
> `m11r4_store_cas`(T1T2가 이번에 추가한 테스트)도 간헐적으로 빨개진다 — 두 건 다
> 소유 갈래에 남긴다.
