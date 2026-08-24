# ACCT R1 — 계정 UX 4건 (사용자 직접 요청)

명세: `docs/r28-followup.md` §1 · §3 · §3-b · §4.
갈래 경계: `app/src`의 Account 탭·계정 picker·스토어·토스트 · `crates/ccg-auth` ·
`src-tauri/src/ipc`의 usage 캐시/워밍·기본 파생 노출부 · `scripts/poc-*.mjs`.

---

## 0. 한 줄 요약

네 건은 서로 다른 요청이었지만 **같은 자리**를 고친다: 계정을 그리는 세 표면이 각자
자기 캐시를 들고 각자 물어보고 있었다. 그 셋을 스토어 하나로 모으고 나니 —

- **§1** 첫 페인트가 HTTP를 안 기다린다(계정 3개 캐시 경로 **6.19ms**), 두 표면 동시
  오픈의 조회가 **2벌 → 1벌**, 워밍이 **토큰을 회전시키지 않는다**.
- **§3** 「사용 중 · 2번 자리」가 셸의 판정 하나(`ChatStatusLite.account`)로 선다.
- **§3-b** 「현재」가 파랑, 「사용 중」이 주황 — 다른 시각층. 오클릭에 되돌릴 줄 하나.
- **§4** 「기본」이 상태에서 **파생값**이 됐다(목록 맨 위). 옛 값은 맨 위로 옮기고 폐기.

---

## 1. §1 — 한도 조회가 느리거나 안 됨

### 무엇이 문제였나 (구조)

규약이 **1200ms 직렬 × 계정 수 + 실 HTTP**다. 계정이 N개면 첫 숫자까지 N×1.2초를
그냥 기다리고, 429/네트워크면 화면이 그냥 빈다. 규약은 2.6.2 대조라 못 바꾼다 —
바꿀 수 있는 것은 **UI가 그걸 기다리는 것**이다.

### 고친 것

| 자리 | 무엇 |
|---|---|
| `ipc/parity/usage.rs` `accounts_usage(opts)` | 선택 옵션 셋: `cachedOnly`(HTTP 0회) · `priority`(먼저 조회) · `warm`(회전 없는 계정만) |
| 같은 파일 `is_dead`/`note_fail` | 연속 2회 실패 계정은 **3분 건너뛴다** — 직렬 큐를 죽은 계정 하나가 안 막게 |
| `app/src/lib/accounts.ts` (신규) | **단일 스토어** — 목록·한도·인플라이트 합류·60초 갱신 TTL·수동 재시도(`force`) |
| `Settings.tsx` `AccountView` | 자기 `useState` 넷을 버리고 스토어를 본다. 첫 그림은 디스크 보존값 |
| `Settings.tsx` `AccountLimits` | 실패를 「데이터 없음」으로 안 뭉갠다 — 조회 중 / 「한도를 못 불러왔어요 · 다시 시도」 / 낡은 값(숫자 + 「마지막으로 확인한 값」) |
| `Chat.tsx` `PickerChip` | 모듈 캐시 넷 제거 → 같은 스토어 |
| `App.tsx` | 시작 1.5초 뒤 + 창 포커스마다 **선행 워밍**(90초 쿨다운) |

### 왜 `warm`이 따로 있나 — M11 R2 C1의 그 자리

부팅 프리웜을 들어낸 이유는 **오래 논 계정의 리프레시 토큰 회전이 되돌릴 수 없는
부작용**이기 때문이었다. 그래서 워밍은 `claude::account_access_token(email).is_some()`인
계정 — 즉 **로컬 토큰이 아직 살아 있어 교환이 필요 없는 계정** — 만 건드린다.
"앱을 켠 것만으로 토큰이 회전한다"가 코드에서 불가능하다. 사용자가 Account 탭을 직접
열면 `warm:false`라 그때는 옛 규약 그대로다.

### 실측

```
[§1] cachedOnly 6.1861ms = [3행, 전부 stale:true]      ← 첫 페인트(HTTP 0회)
[§1] 워밍이 실제로 물어본 계정 = ["two@acct.test"]      ← 셋 중 토큰이 산 하나만
[TTL] 1분 전 캐시 = weeklyPct 93 (표식 없음)            ← 2분 디스크 TTL 무회귀
[TTL] 3분 전 캐시 = weeklyPct 93 + stale:true
[TTL] 캐시 없음   = 전부 null + unavailable:true
```
(`cargo test -p agentcodegui --features custom-protocol ipc::parity::usage -- --nocapture`)

렌더러 쪽(`node scripts/poc-acct-store.mjs`):

```
D.  쿨다운 안의 두 번째 워밍은 안 나간다 — 실측 1회 / warm:true 실림
D2. 방금 받은 값이 있으면 조회가 안 나간다 — 실측 0회
A.  동시 두 표면 → 실조회 1회 (같은 값 한 벌)
B.  첫 페인트가 실조회를 안 기다린다 — 0ms (실조회 400ms 스텁)
C.  「다시 시도」(force)는 캐시가 아니라 조회 — 1회 · priority 실림
```

### 안 한 것 / 남은 것

- **주기 폴링은 여전히 없다**(usage API 예산). 갱신은 표면을 열 때·워밍·수동 재시도뿐.
- Codex 축은 `cachedOnly`/`warm`이 없다 — 그쪽은 HTTP가 아니라 `app-server` 스폰이라
  실패 모드가 다르고, 사용자 보고도 Anthropic 쪽이었다. 필요해지면 같은 문법으로 뚫는다.

---

## 2. §3 — 계정 「사용 중」 표시

### 판정 소스는 **셸 하나**다

렌더러가 모은 표를 안 쓴 이유: 창이 여럿이다(본채팅·멀티 자리·추가 창·팝아웃이 각자
다른 JS 힙). 자기 창의 자리만 아는 표로는 「다른 곳에서 쓰는 중」을 말할 수 없다.

그래서 `engine/lite.rs`가 `ChatStatusLite`에 두 칸을 얹는다:

| 필드 | 무엇 | 왜 |
|---|---|---|
| `account` | 이 채팅이 물고 있는 구독 계정 | **키가 있으면 살아 있는 런타임**이다 — `status.json`에서 재구성한 행에는 이 키가 없다. 「busy 턴 중이거나 상주 CLI 생존」을 내용이 아니라 **구조**로 판정한다 |
| `panelId` | `${boardId}::${slot}` | 「2번 자리」의 그 번호. panelId↔chatId의 대응은 보드 스토어만 알아 렌더러가 못 잇는다 |

API 키 실행은 구독 한도를 안 태우므로 `account`를 안 싣는다. 빈 이메일도 안 싣는다
(실으면 목록에 없는 계정 하나가 모든 자리를 문 것처럼 보인다).

`app/src/lib/accounts.ts`가 그 배열에 이름표만 붙인다: 멀티 자리는 `panelId`에서 번호를
뜨고, 본채팅·추가 창은 이 창이 등록한 이름표(`putSlotNames('chats'|'wins', …)`)를 쓴다.

### UI

- picker 행 오른쪽 주황 칩(`.pp-warn`) — 「사용 중 · 2번 자리」 / 「사용 중 · 2곳」 /
  이름을 모르면 「사용 중 · 다른 자리」. **선택 차단은 안 한다.**
- 설정 ▸ Account 행에도 같은 문구(`set-badge warn`).
- **자기 자리뿐이면 칩이 없다** — 그건 §3-b의 「현재」가 이미 말한 사실이다.

### 알려진 한계 (정직하게)

역인덱스를 먹이는 `chat:status` 구독은 **메인 창에만** 있다. 추가 채팅 창은 자기
chatId를 렌더러에서 모르기도 해서, 그 창의 picker에는 칩이 **안 뜬다**(거짓 칩 대신
침묵). 반대 방향은 산다 — 추가 창이 물고 있는 계정을 **메인 창에서** 열면 「사용 중 ·
추가 창」이 뜬다.

---

## 3. §3-b — 「현재」 강조 + 실수 전환 복구

- `.pp-row.cur` — 파랑 계열 왼쪽 선 + 배경 + 「현재」 알약(`.pp-now`). §3의 주황과
  **다른 시각층**이라 한 줄에 둘이 같이 서도 안 헷갈린다.
- `.acct-undo` — 「lmg56632 → junelius 전환됨 · 되돌리기」. 12초 뒤 자동 소멸 + ✕.
  **팝오버가 아니라 칩에** 붙는다: 실수를 알아채는 건 보통 팝오버를 닫은 뒤라,
  팝오버 안에 두면 필요해질 때 이미 사라져 있다.
- 되돌리기는 `pickerRef.current` 위에 **계정 칸만** 되돌린다 — 그 사이 바꾼 모델·모드가
  함께 되감기지 않게(클로저에 박힌 옛 picker를 쓰면 그렇게 된다).
- 같은 계정을 다시 고르면 줄을 안 세운다(되돌릴 게 없다).

Anthropic·Codex 두 축 모두 같은 경로(`switchAccount('account'|'codexAccount', …)`).

---

## 4. §4 — 「기본 계정」 개념 제거

**기본 = 설정 ▸ Account의 사용자 정렬 맨 위**(파생값). `defaultEmail`은 더 이상 안 읽는다.

| 자리 | 전 | 후 |
|---|---|---|
| `claude::default_account_email` / `codex::` | `defaultEmail` → 없으면 첫 계정 | **첫 계정** |
| `claude::list_accounts` / `codex::` | `email == defaultEmail` | **`i == 0`** |
| `ipc/system.rs` 두 목록의 `isDefault` | `defaultEmail` 우선 | **`emails.first()`** |
| `engine/ident.rs` (실행 정체성 · Codex 축 포함) | `defaultEmail` | **`accounts[0].email`** |
| 설정 버튼 | 「기본으로」 | **「맨 위로」** |
| 배지 | 「기본」 | 「기본 · 맨 위」(인덱스 0의 파생 표시) |
| `auth:set-default-account` | 필드 쓰기 | **「맨 위로 이동」과 동치**(채널은 유지 — 동결 2.6.2 렌더러가 아직 부른다) |
| `codex-auth:set-default-account` | 필드 쓰기 | 3.0 화면은 안 부른다(`reorderAccounts`로 같은 결과 저장) |

### 마이그레이션과 그 함정

`migrate_default_to_top()` — 옛 `defaultEmail`이 3번째를 가리켰으면 **그 계정을 맨 위로
옮긴 뒤** 우리는 그 필드를 안 읽는다. 옮기지 않고 무시만 하면 그 사용자의 새 채팅이
말없이 1번째로 갈아탄다(프롬프트 캐시가 식고 남의 한도를 태운다). 프로세스당 한 번,
**옮길 게 있을 때만** 쓴다.

★ 함정(테스트가 지킨다): 정렬·「맨 위로」가 옛 `defaultEmail`을 그대로 들고 저장하면
**다음 부팅의 마이그레이션이 사용자의 정렬을 되돌린다.** 그래서 순서를 바꾸는 세 경로가
전부 `default_email = None`으로 쓴다(`reorder_accounts` · `move_account_to_top` · codex 짝).

파일에서 필드가 사라지지는 않는다 — `render_store(_, None)`이 맨 위 계정으로 다시
채우기 때문이고, 그래서 같은 홈을 2.6.2로 열어도 기본 계정이 그대로다(값이 언제나
「맨 위」와 같아질 뿐).

★ **2.6.2와의 의도적 분기**라 `docs/renderer-divergence.md` §6.5에 기록했다
(§6.6이 §3·§3-b, §6.7이 §1의 채널 옵션).

---

## 5. 검증

| 무엇 | 결과 |
|---|---|
| `cargo test -p ccg-auth` | **82 + 14 + 2 + 1 통과** (새 3건: 파생값·마이그레이션 왕복·정렬 무회귀) |
| `cargo test -p agentcodegui --features custom-protocol` | **133 통과** (새 4건: cachedOnly·priority·warm·격리) |
| `node scripts/poc-acct-store.mjs` | ~~**16 항목 전부 통과**~~ (신규 하네스) |
| `npm run typecheck` · `typecheck:app` | 3종 초록 |

★ **이 표에 틀린 수가 둘 있다**(확인 크리틱 R1이 잡았다. 지우지 않고 남긴다 — 어떤 식으로
틀렸는지가 다음 라운드의 재료다): `ccg-auth`는 `tests/t1_list_edit_race.rs` 1건이 빠져
합계가 **100**이었고, `poc-acct-store.mjs`는 `ok` 줄이 16이 아니라 **18**이었다.
`ccg-store` 크레이트(76)는 아예 안 셌다. R2의 검증표는 크레이트별로 따로 센다.

**격리**: Rust 테스트는 전부 `ccg_store::testhome::take()` 증표 안. 실계정 토큰은
한 번도 안 읽었고 실 HTTP는 0건이다(`CCG_NO_NET=1` + 합성 계정).
공용 `target/`이 다른 갈래에 잠겨 있어 `CARGO_TARGET_DIR=target-acct`로 돌렸다.

### 못 한 것

- **실 exe A/B는 안 돌렸다.** `poc-account-switch.mjs`·`poc-limit-resume.mjs`는 릴리즈
  exe + fakecli + auth-probe 빌드가 전제인데, 이 라운드 동안 공용 `target/`을 다른
  두 갈래가 계속 쓰고 있었다(`limit_probe.rs`가 미완 상태로 컴파일 실패하던 구간 포함).
  대신 그 두 하네스가 지키던 계약을 **크레이트 테스트로** 확인했다:
  자동 전환(`engine::acct_switch` 7건)·한도 재검증(`engine::limit_probe`)·usage 캐시가
  전부 초록이고, 그 경로들이 읽는 「기본 계정」은 이제 전부 `default_account_email()`
  한 함수를 지난다(파급 전수 §4 표).
- 추가 채팅 창의 §3 칩(위 §2 「알려진 한계」).

---

## 6. 만진 파일

**Rust**
- `crates/ccg-auth/src/claude.rs` — §4 파생값·마이그레이션·`move_account_to_top` + 테스트 3
- `crates/ccg-auth/src/codex.rs` — 같은 규약(Codex 축)
- `src-tauri/src/ipc/parity/usage.rs` — §1 옵션 셋 + 죽은 계정 격리 + 테스트 4
- `src-tauri/src/ipc/parity/mod.rs` — 채널에 opts 전달(1줄)
- `src-tauri/src/ipc/system.rs` — 두 목록의 `isDefault` 파생
- `src-tauri/src/ipc/accounts.rs` — 채널 주석(§4 동치 선언)
- `src-tauri/src/engine/ident.rs` — 실행 정체성의 기본 계정 파생(Anthropic·Codex)
- `src-tauri/src/engine/lite.rs` — §3 `account`·`panelId`

**렌더러**
- `app/src/lib/accounts.ts` (신규) — 단일 스토어 + 역인덱스
- `app/src/components/Chat.tsx` — picker(§1 스토어·§3 칩·§3-b 「현재」·되돌리기), 모듈 캐시 4개 제거
- `app/src/components/Settings.tsx` — Account 탭(§1 스토어·상태 분리·재시도, §3 칩, §4 「맨 위로」)
- `app/src/components/MultiAgent.tsx` — 자리 식별자 1줄
- `app/src/App.tsx` — `chat:status` → 역인덱스, 자리 이름표, 선행 워밍
- `app/src/api/shim.ts` — `accountsUsage(opts?)`
- `app/src/styles.css` — `.pp-row.cur`·`.pp-now`·`.pp-warn`·`.acct-undo`·`.lim-state`

**계약면 / 문서 / 하네스**
- `src/shared/protocol.ts` — `AccountsUsageOpts`, `AccountUsage.stale|unavailable`,
  `ChatStatusLite.account|panelId`, `isDefault` 의미 갱신
- `src/shared/api.ts` — 같은 자리의 주석·시그니처
- `docs/renderer-divergence.md` — §6.5·§6.6·§6.7
- `scripts/poc-acct-store.mjs` (신규)
- `docs/parity-fix-acct-r1.md` (이 문서)

**경계 밖**: `src-tauri/src/engine/lite.rs`·`ident.rs`(엔진 글루). §3의 판정 소스와
§4의 파급 전수라 명세(`r28-followup.md` §3 「필요시 Rust 세션 상태 노출」·§4 「파급 확인」)가
가리킨 자리다. 각각 hunk 하나씩이고 다른 갈래의 변경과 겹치지 않는다.

---

# R2 — 확인 크리틱 R1 수정 (2차 독립 패스 판정 반영)

판정문: `docs/critic/r28b-acct-critic-r1.md`(1차 + 「2차 독립 패스」절).
불합격 사유 다섯(F1·F2·F3·F4·F5) + 양쪽 판정이 못 본 둘(N1·N2).

## 0. 한 줄 요약

R1이 틀린 방식은 하나였다: **성질을 주석에 적고 코드로는 안 세웠다.**
「키가 있으면 살아 있는 런타임」도, 「워밍은 회전을 유발할 수 없다」도, 「두 표면 중복
0」도 문장이었지 불변식이 아니었다. R2는 그 문장 셋을 각각 **강제하는 자리**에 옮겨
심고, 그 자리가 실제로 있는지를 **프로세스 경계 밖에서**(실 exe) 다시 쟀다.

## 1. F1 — 「사용 중」이 재시작 뒤 영원히 켜져 있다

**기제**: `status::set()`이 `lite::build`의 결과를 통째로 메모리 맵에 넣고 `flush()`가 그
맵을 그대로 썼다 → `chats-v3/status.json`에 `account`·`panelId`가 영속되고, `load_boot`는
`busy`·`ask`·`bgActive`·`status`·`unread`만 강제해 두 키를 **그대로 되살렸다**. 턴을 한 번이라도
돌린 채팅은 이후 **모든 부팅**에서 그 계정을 「사용 중」으로 만들었다.

**고친 자리 넷** — 크리틱 지시 (1)(2)(3) 그대로:

| # | 자리 | 무엇 |
|---|---|---|
| ⑴ | `ccg_store::status::flush` | `RUNTIME_ONLY_KEYS`(=`account`·`panelId`)를 **디스크 직렬화에서 뺀다**(재발 금지). 메모리 맵에는 남는다 — §3 브로드캐스트가 그 값을 싣는 게 기능이다 |
| ⑴' | `ccg_store::status::load_boot` | **읽을 때도 걷어낸다**. R1이 이미 써 둔 홈의 답이다(쓰기만 막으면 그 홈은 영원히 문다) |
| ⑵ | `hub::Op::Dispose` → `status::clear_runtime` | 런타임을 거두면 **마지막 lite를 계정 없이 다시 앉힌다**. 상태(`done`)는 남긴다(사이드바 점 색) |
| ⑵' | `engine/lite.rs::holds_account` | 생존 판정 = *busy 턴 중 **이거나** 상주 CLI 생존*. 밖에서 죽은 상주 CLI는 계정을 안 싣는다. 턴 사이의 정상 `Idle`은 시체가 아니다(기본 정책이 `OnIdle`이라 그것까지 접으면 칩이 턴 중에만 깜빡인다) |

**⑶ 실 exe 회귀 못**(`scripts/poc-acct-live.mjs` A) — 크리틱이 요구한 그 순서:

```
살아 있는 런타임 = {"chatId":"c-a","status":"done","account":"one@ccg.test","panelId":null}
설정 ▸ Account 배지 = ["기본 · 맨 위","사용 중 · 첫 채팅"]
종료 뒤 status.json(209B) = "account" 0건
★ 그 파일에 account·panelId를 도로 끼워 넣어 **R1이 써 둔 홈**을 만든 뒤 재기동:
   재기동 status = [{"chatId":"c-a","status":"done","account":null,"panelId":null}]
   재기동 배지   = ["기본 · 맨 위"]   ← 「사용 중」 0건 (오염된 입력 = true)
```

## 2. F2 — 되돌리기가 화면만 되돌린다

**기제**(에코 가드의 구조적 비대칭): `legacy_bridge::renderer_authored`는 *"셸이 마지막으로
**투영한** 지문과 다른가"*로 판정했다. 되돌리기가 복원하는 값은 정의상 마지막 투영값과
같아서 **에코로 분류**됐다 — 전환(A→B)은 지문이 달라 통과하는데 되돌리기(B→A)만 막힌다.

**고친 것**: `PROJECTED`의 뜻을 *"마지막으로 내보낸 값"* → *"마지막으로 **합의한** 값"*으로
넓힌다. 흡수도 합의이므로 `absorb_legacy`가 채택한 지문을 되적는다(한 줄).
셸이 저자인 턴 중 폴백은 흡수를 안 거쳐 `PROJECTED`를 안 건드리므로 R2 가드(P3 재발)는 그대로다.

**★ 회귀 못의 모양** — 크리틱이 별표로 못 박은 조건을 그대로 지켰다: `chats:get`이 준
**사본을 그대로 되보낸다**(`legacy_bridge_tests.rs`
`undoing_an_account_switch_reaches_the_identity_not_just_the_screen`).
손으로 만든 payload는 지문이 애초에 달라 에코 가드를 늘 통과하므로 **이 결함을 영원히 못 잡는다**.

못이 진짜인지 이 패스에서 직접 확인했다(고친 줄만 잠시 끄고 재실행):

```
[F2] 되돌린 뒤 디스크 identity(수정 끔) = billing.account = "two@ccg.test"
     assertion failed: ★ 되돌리기가 화면만 되돌렸다 — 재시작하면 실수한 계정으로 실행된다
[F2] 수정 켬 → "u0@x.com"(원 계정)
```

실 exe(B 시나리오): 전환 → 되돌리기 → **턴 없이** 재시작 → `RAN-one_ccg.test`(원 계정).

## 3. F3 — 마이그레이션이 첫 세션에 안 보인다 (크기 정정 반영)

R1은 이관을 `ccg_auth`의 `list_accounts`/`default_account_email`이 지날 때만 돌렸는데, 화면
목록(`ipc/system.rs`)과 실행 정체성(`engine/ident.rs::defaults`)은 `accounts.json`을 **직접**
읽어 그 문을 안 지난다. R2는 셋을 함께 잠근다: `main()`이 창·IPC보다 **먼저**
`ensure_default_migrated()`(양 축) + 두 목록·`defaults()`도 읽기 직전에 같은 문(프로세스당 1회 CAS).

크리틱의 크기 정정(「첫 세션 내내」가 아니라 「부팅 후 최대 60초 창」)은 **판정으로 받는다** —
자기 치유가 있어도 그 60초에 사용자가 새 채팅을 열면 남의 한도를 태우고 프롬프트 캐시가 식는다.

실 exe(C 시나리오, `defaultEmail`=3번째): 스토어 순서·**그 세션의** 목록·새 채팅 칩·실제 실행
넷 다 `three@ccg.test`.

## 4. F4 — 본채팅이 「1번 자리」로 나온다

마이그레이션이 만드는 `default` 보드는 `count:1`일 때 `chrome:"ide"`(=본채팅 화면)이고 그
슬롯 0이 본채팅을 문다. R1은 **라우팅용** `panel_id_for_chat`을 표시에도 써서 본채팅의
`panelId`가 `default::0`이었고, 렌더러가 자리 번호를 이름표보다 먼저 고르므로 칩이
「사용 중 · 1번 자리」였다 — 멀티 첫 자리와 문구가 충돌하고 `MAIN_SLOT_NAME`은 도달 불가.

**고친 것**: **표시용** `engine::panel_seat_for_chat`(`chrome:"ide"` 보드는 자리로 안 센다).
라우팅(`ma:event` 봉투)은 **일부러 안 건드렸다** — 그쪽 질문은 "이 봉투를 누가 듣나"라 판정이 다르다.

하네스가 R1에서 통과했던 이유도 적어 뒀다(`poc-acct-store.mjs` E절 주석): 본채팅 픽스처가
`panelId: null`이었는데 **실 셸은 그런 행을 안 냈다**. 이제 실 exe가 그 값을 잰다(A: `panelId = null`).

## 5. F5 — 격리 3분 동안 「다시 시도」가 무동작

`skip = cached_only || is_dead(&email) || …`에 사람이 눌렀다는 사실을 실을 인자가 없었다
(`refreshUsage`가 보낸 건 `{priority, warm}`뿐 — `force`는 렌더러 TTL만 넘었다).

**고친 것**: `AccountsUsageOpts.retry` 신설 → 셸이 그 계정의 격리를 **먼저 푼다**.
격리는 벌이 아니라 큐 보호용 우회이므로 사람이 기다리기로 한 조회까지 막을 이유가 없다.
`cachedOnly`와 함께 오면 캐시 팔이 이긴다(HTTP 0회의 계약이 더 강하다).
렌더러 짝: **수동 재시도는 워밍·자동 갱신에 합류하지 않는다**(그 답에는 사용자가 보려는
계정이 비어 있다). 재시도끼리는 그대로 합류한다.

```
[F5] 표식 없는 조회 뒤 fails = Some(2)   ← 격리라 안 나갔다(큐 보호 유지)
[F5] 재시도 뒤 fails = Some(1)           ← 실제로 나갔고 사다리를 처음부터 센다
실 exe(D): 「다시 시도」 클릭 → 조회 3건 → 4건, 마지막 봉투 = {"priority":"one@ccg.test","retry":true}
```

## 6. N1 — 「두 표면 중복 0」은 한 창 안에서만 참이었다 (크리틱 신규 · 최대 격차)

**기제**: `#session`(추가 채팅 창)·`#mapanel`(팝아웃)은 같은 번들의 **다른 OS 창 = 다른 JS
힙**이라 `lib/accounts.ts`를 한 벌씩 들고, 그 창들도 picker를 그린다. 셸
`accounts_usage`에는 인플라이트 합류가 없고 디스크 캐시를 루프 **앞에서 한 번**만 읽는다 →
두 창이 겹치면 ⑴ 조회가 **계정 수 × 2벌**(분당 1~2건이 예산인 엔드포인트다),
⑵ 나중에 끝난 쪽의 `write_usage_cache`가 자기 **낡은 스냅샷**으로 상대의 신선한 값을 덮는다.

**고친 것 — 합류의 진실을 셸로 내린다.** 렌더러에는 창 밖을 세는 방법이 구조적으로 없다.

| 자리 | 무엇 |
|---|---|
| `ipc/parity/usage.rs::sweep_lane` | 계정별 레인. 다른 창의 훑기가 그 계정을 도는 중이면 **줄을 선다**(`net`의 토큰 레인과 다른 축 — 저쪽은 이중 회전, 여기는 조회 중복) |
| 같은 파일 `fresh_on_disk` | 레인에서 깨어나 **디스크를 다시 본다** → 앞 주자의 값이 신선하면 HTTP 0회 |
| `ccg_auth::usage::merge_usage_cache` | 캐시가 **줄 단위 병합**이 됐다. 더 오래된 `at`이 새 값을 덮지 않는다. `write_usage_cache`(통째 쓰기)는 초기화·시드 전용으로 남는다 |
| `engine/acct_switch.rs` | 같은 파일에 쓰는 **또 하나의 주체**(M11 자동 전환 워커)도 병합으로 바꿨다 — 이쪽만 두면 같은 사고가 남는다 |
| `lib/accounts.ts` 주석 | 「중복 0」의 **경계**를 적었다: 이 합류는 IPC 왕복을 아끼는 앞단이고, HTTP 한 벌의 근거는 셸 레인이다 |

**실측(레인을 잠시 끄고 잰 대조군)** — 계정 3개 × 두 창 동시 훑기:

```
레인 없음: 6회  ["one","one","two","two","three","three"]   ← 크리틱이 코드로 짚은 그 값
레인 있음: 3회  (계정당 정확히 1회, 두 훑기 다 stale 표식 없는 신선한 값을 받는다)
```
(`ipc::parity::usage::tests::two_windows_sweeping_at_once_ask_each_account_only_once`
 — 하네스 조회기를 쓰는 이유는 `CCG_NO_NET`을 켜면 조회가 전부 **실패**해 캐시가 안 생기고,
 그러면 합류를 통째로 걷어내도 초록이라 못이 못이 아니게 되기 때문이다.)

덮어쓰기 쪽 못은 `ccg_auth::usage::tests::merging_the_cache_keeps_the_other_sweeps_fresh_rows`:
같은 재료로 **통째 쓰기 대조군**을 만들어 "그건 실제로 지운다"까지 같은 테스트 안에 남겼다.

렌더러 쪽에는 반대 방향의 못을 박았다(`poc-acct-store.mjs` C4): **모듈을 한 벌 더 들면 조회도
한 벌 더 나간다**(실측 2회). 「창끼리도 합쳐진다」고 적으면 셸 레인을 걷어내도 초록이 된다.

## 7. N2 — 「워밍은 회전을 유발할 수 없다」가 사실보다 셌다 (크리틱 신규)

`warm`의 문은 **로컬 만료 시각만** 본다. *"시간상 살아 있는데 서버가 이미 죽인"* 토큰은 그
문을 통과하고, `fetch_account_usage`가 401/403 → `force_refresh` → `rotate`로 간다. 성공하면
그 순간 옛 refresh 토큰이 **서버에서 죽는다** — 사용자가 한 일은 앱을 켠 것뿐이다.

**고친 것**: `ccg_auth::rotation` — **스레드 로컬 회전 금지 구역**. 회전으로 가는 문
**둘 다**(`access_token`·`force_refresh`)가 같은 관문(`rotation_gate`)을 지나
`NetError::RotateForbidden`으로 착지한다. 호출부마다 인자를 늘리는 방식은 하나를 빠뜨리는
순간 성질이 조용히 사라져서, 구역으로 팠다. 워밍 조회만 그 구역 안에서 돈다
(`ipc/parity/usage.rs::fetch_one`).

스레드 로컬인 이유: 사용자가 Account 탭을 직접 열어 부른 조회는 **구역 밖**이라 옛 규약대로
교환까지 간다. 거기까지 막으면 만료된 계정의 게이지가 영영 안 낫는다.

```
[N2] 구역 밖                = Some(Disabled)                   ← 교환을 *시도*했다(전송에서 거절)
[N2] 구역 안                = Some(RotateForbidden("warm@x"))  ← 시작조차 안 한다
[N2] force_refresh(구역 안) = Some(RotateForbidden("warm@x"))  ← 401 경로도 같은 관문
[N2] 워밍 훑기   = [("two@acct.test", banned=true)]            ← 셸 배선
[N2] 사용자 조회 = 세 계정 전부 banned=false
```
못 둘: `ccg_auth::net::tests::a_no_rotate_scope_stops_the_exchange_before_it_starts`
(`--features net`) · `ipc::parity::usage::tests::only_the_warm_sweep_fetches_inside_the_no_rotate_scope`.
정책 자체(중첩·패닉·스레드 로컬)의 못은 `ccg_auth::rotation::tests`에 따로 있다(기본 빌드).

## 8. 검증 — 크레이트별로 따로 셈

| 무엇 | 결과 |
|---|---|
| `npm run typecheck`(node·web) + `typecheck:app` | **3종 초록** |
| `cargo test -p ccg-auth` (기본) | **102 통과 · 0 실패** (lib 84 + 0 + 0 + 14 + 2 + 1 + 1 + 0). 크리틱의 「100」이 이 라운드 전 값이고, 늘어난 둘이 `rotation`·`merge_usage_cache` |
| `cargo test -p ccg-auth --features net` | **119 통과 · 0 실패** (lib 94 + 1 + 6 + 14 + 2 + 1 + 1). N2의 net 못이 여기 있다 — 기본 빌드에는 `net.rs`가 컴파일조차 안 된다 |
| `cargo test -p ccg-store` | **79 통과 · 0 실패** (크리틱 기준 76 + F1 2건 + F2 1건) |
| `cargo test -p agentcodegui` | **143 통과 · 0 실패** (크리틱 기준 133 + F4·F5·N1·N2 등. 이 라운드 중 다른 갈래가 착지해 그쪽 몫도 섞여 있다) |
| `node scripts/poc-acct-store.mjs` | **25 항목 전부 통과**(`ok` 줄 카운트). R1 보고서의 「16」은 틀렸다 — 크리틱이 잡은 그대로다 |
| `node scripts/poc-limit-resume.mjs` | **164 통과 · 0 실패** (M11 경로 무회귀) |
| `node scripts/poc-store-fanout.mjs` | **10 항목 전부 통과** |
| `node scripts/poc-acct-live.mjs`(**실 exe**) | **16 항목 전부 통과** — A(F1·F4) 6 · B(F2) 3 · C(F3) 4 · D(F5) 3 |

**격리**: `CCG_HOME`은 전부 `%TEMP%/ccg-acct-live-r2` · `CCG_NO_NET=1` + 합성 계정
(`ccg-auth-probe seed`) → **실 HTTP 0건 · 실계정 토큰 열람 0회** · 종료는 자기가 spawn한 PID
트리만(`killTree`) — 이름 기반 kill 0회 · `CARGO_TARGET_DIR=target-acct`(이 갈래 전용) ·
CDP 포트 9486~9491(다른 갈래와 겹치지 않게) · 기준 결과 파일은 하나도 안 덮었다
(새 파일 `docs/critic/acct-live-r2.json`).

### 하네스 자체의 결함도 하나 고쳤다

R1의 `poc-acct-live.mjs`는 계측(`window.__ipc`)을 `Runtime.evaluate` **한 방**으로 심었다.
부팅 직후엔 `true`인데 측정 시점엔 사라져 있었다 — 그 사이 문서가 한 번 갈린다.
`Page.addScriptToEvaluateOnNewDocument` + 측정 직전 `ensureIpc()`로 고쳤고,
`armStatus`도 `__TAURI_INTERNALS__`가 뜬 뒤에 구독하도록 바꿨다. (첫 주행에서 A·D
시나리오가 **제품이 아니라 하네스 때문에** 죽었다 — 그걸 「실패」로 적었으면 오경보고,
안 돌리고 「초록」이라 적었으면 두 번째 헛초록이었다.)

## 9. 남은 리스크

- **두 창 동시 조회를 실 exe로는 재현 못 했다.** 셸 레인의 실측은 프로세스 안 두 스레드다
  (크리틱의 N1도 「코드 확정」이었다). 창을 실제로 둘 띄우는 하네스가 다음 라운드의 값이다.
- **N2의 401 경로는 실 서버 없이 재현 불가**다. 여기서 잰 것은 *"교환을 시작하는가"*이고
  (구역 밖 `Disabled` = 전송까지 갔다 / 구역 안 `RotateForbidden` = 그 앞에서 멈췄다),
  401 응답 자체는 안 만들었다. 실 HTTP 0건 규율과 맞바꾼 자리다.
- **추가 채팅 창(`SessionWindow`)의 §3 칩은 여전히 없다**(R1의 「알려진 한계」 그대로).
  그 창은 자기 chatId를 렌더러에서 모른다 — 거짓 칩 대신 침묵을 고른 선택이고, 고치려면
  창별 chatId 노출이 먼저다.
- `RotateForbidden`은 `acct_switch::transient`에서 **일시 실패**로 센다. 그 워커는 구역 안에서
  안 돌아 실제로는 도달 불가지만, 도달하면 다음 tick에 다시 묻는다(= 조용히 안 사라진다).
- 조회 성공마다 `usage-cache.json`을 한 번씩 쓴다(훑기당 최대 계정 수). 원자 저장 + 수백 바이트라
  1200ms 게이트 옆에서는 무시할 비용이지만, 통째 쓰기 1회에서 늘어난 것은 사실이다 —
  즉시 쓰지 않으면 레인 뒤의 훑기가 그 값을 못 본다(그게 N1의 합류다).

## 10. R2에서 만진 파일

**Rust**
- `crates/ccg-auth/src/rotation.rs` (신규) — N2 회전 금지 구역 + 정책 못
- `crates/ccg-auth/src/net.rs` — `RotateForbidden` + `rotation_gate`(회전 문 둘 다) + N2 못
- `crates/ccg-auth/src/usage.rs` — `merge_usage_cache` + N1 못
- `crates/ccg-auth/src/{claude,codex}.rs` — `ensure_default_migrated` 공개(F3)
- `crates/ccg-auth/src/lib.rs` — 모듈 등록
- `crates/ccg-store/src/status.rs` — F1 `RUNTIME_ONLY_KEYS`·`clear_runtime` + 못 2
- `crates/ccg-store/src/legacy_bridge.rs`(+`_tests.rs`) — F2 합의 지문 + 못 1
- `src-tauri/src/ipc/parity/usage.rs` — F5 `retry` · N1 레인·병합 · N2 배선 + 못 3
- `src-tauri/src/engine/acct_switch.rs` — N1 병합 쓰기 · `transient` 새 변형
- `src-tauri/src/engine/lite.rs` — F1 `holds_account` · F4 표시용 자리 + 못 3
- `src-tauri/src/engine/mod.rs` — F4 `panel_seat_for_chat` + 못 1
- `src-tauri/src/engine/hub.rs` — F1 `Dispose`에서 계정 뗌
- `src-tauri/src/engine/ident.rs` · `src-tauri/src/ipc/system.rs` · `src-tauri/src/main.rs` — F3

**렌더러 / 계약면**
- `app/src/lib/accounts.ts` — F5 재시도 합류 규칙 · N1 경계 주석
- `src/shared/protocol.ts` — `retry` 옵션 · `account`/`panelId`의 뜻 갱신

**문서 / 하네스**
- `docs/renderer-divergence.md` — §6.5·§6.6·§6.7에 R2 정정 5건
- `scripts/poc-acct-store.mjs` — C4(합류의 경계)
- `scripts/poc-acct-live.mjs` (신규) — 실 exe 회귀 못 4 시나리오
- `docs/parity-fix-acct-r1.md` (이 절)

---

# R3 — 확인 크리틱 R2 수정 (G1 하나)

판정문: `docs/critic/r28b-acct-critic-r2.md`(불합격 · 경계선).
일곱 중 여섯(F1·F2·F3·F4·F5·N1·N2)은 크리틱이 실 exe로 재현해 **초록**으로 확인했다.
남은 하나가 **G1**이고, 이 라운드는 그것만 고친다.

## 0. 한 줄 요약

R2가 틀린 방식은 R1과 달랐다: 문장을 코드로는 만들었는데 **그 코드가 놓인 자리가
사용자의 삭제 경로가 아니었다.** 「사용 중」을 걷는 문을 `Op::Dispose`에 달았지만,
본채팅 삭제는 그 문을 **아예 안 지나고**(목록 REPLACE 저장 하나로 끝난다), 유일하게
지나는 경로마저 **행을 먼저 지운 뒤** 문을 두드려 `false`를 받았다. 문은 태어날 때부터
닫혀 있었다. R3은 문을 **값을 지우는 자리**로 옮긴다.

## 1. G1 — 채팅을 지워도 「사용 중」이 안 걷힌다

**크리틱 실측**(실 exe · 2회 주행 2회 동일): 같은 계정(`one@`)을 문 채팅 둘 중 `c-a`를
사이드바에서 지우면 —

```
디스크  chats-v3/index.json = {"order":["c-b"]}       ← 삭제·prune은 됐다
디스크  chats-v3/status.json = c-b 한 줄
 ★     chat:status = [{c-a, done, account:one@}, {c-b, …}]   ← 지운 채팅이 계정을 문다
 ★     picker 칩   = "사용 중 · 다른 자리"                    ← 이름표까지 잃은 유령
+12초 무입력  브로드캐스트 7 → 7건 (0건)                       ← 스스로 안 낫는다
```

**기제**(코드로 확정):

1. 본채팅 삭제는 `chats:save`(목록 REPLACE) → `legacy_bridge::chats_save` →
   `chats_v3::write_chats` → `status::retain(&order)`뿐이다. **`Op::Dispose`가 안 나간다** —
   `engine::dispose_chat`의 호출자는 `win.rs` `session_close`(추가 채팅 창 삭제) 하나였다.
2. 그 유일한 호출자마저 `chats_v3::remove_chat(id)`를 **먼저** 부르고, 그 안의
   `status::forget_one(id)`가 행을 지운다. 뒤이어 오는 `status::clear_runtime(&chat)`은
   **맵에 없는 키**를 만나 `false`를 돌려주고, R2가 그 반환값에 매단
   `emit_all(CHAT_STATUS, …)`이 영원히 안 나간다.

실제로 값을 지우는 것은 `retain`/`forget_one`인데 **그 둘이 브로드캐스트를 안 했다.**
렌더러의 `liveRows`는 REPLACE로만 갱신되므로(설계 그대로) 마지막 페이로드를 계속 든다.

### 고친 것 — 「값의 주인이 브로드캐스트도 책임진다」

| 자리 | 무엇 | 왜 |
|---|---|---|
| `ccg_store::status::retain` → `Vec<String>` | 지운 채팅 **이름들**을 돌려준다 | 지운 자만이 무엇이 사라졌는지 안다 |
| `ccg_store::status::forget_one` → `bool` | 「실제로 지웠나」 | 지운 게 없으면 헛 브로드캐스트를 안 만든다 |
| 둘 다 `#[must_use]` | 반환을 버리면 컴파일 경고 | 다음 호출자가 조용히 반쪽만 부르는 것을 막는다 |
| `chats_v3::write_chats` → `Vec<String>` | 이번 저장이 목록에서 지운 채팅들 | 기준선 = *저장 전 `index.order`* ∪ *걷힌 상태 행* |
| `legacy_bridge::{chats_save, ma_save}` → `Vec<String>` | 같은 값을 셸까지 올린다 | 멀티 세션/자리 삭제도 같은 결함을 갖고 있었다 |
| `engine::dispose_removed_chats(app, &removed)` (신규) | ①`Op::Dispose` 던지기 → ②허브 FIFO **배리어** → ③늦은 전이 청소 → ④`chat:status` 한 번 | 아래 |
| `ipc/unified.rs` `CHATS_SAVE`·`MA_SAVE` · `win.rs` `session_close` | 세 삭제 경로가 전부 그 함수를 지난다 | 경로가 셋인데 문이 하나였던 것이 R2의 실패다 |

**기준선을 둘로 합친 이유**: `index.order` 차이만 보면 인덱스가 깨진 판(D2 — 못 읽으면
아무것도 안 지운다)에서 놓치고, 걷힌 상태 행만 보면 **턴을 한 번도 안 돈 채팅**을 놓친다.
후자는 상태 행이 없을 뿐 상주 CLI가 붙어 있을 수 있어 회수 대상이다.

**배리어가 필요한 이유**: `Op::Dispose`는 cast(응답 없음)라, 던지자마자 브로드캐스트하면
허브가 슬롯을 거두기 **전**의 값을 실을 수 있고, 거두는 사이 늦은 `status::set`이 행을
되앉히면 유령이 그대로 돌아온다. 허브는 잡을 FIFO로 처리하므로 마지막 Dispose 뒤에
답이 오는 잡(`Op::Debug`)을 하나 걸면 그 답이 곧 "전부 거뒀다"의 증표다. 허브가 없으면
`send_job`이 실패해 **즉시** Null이 온다(3초를 기다리지 않는다).

**겸사로 닫힌 것 — 본채팅 삭제 경로에 런타임 회수가 아예 없었다.** 상주 CLI가 붙어
있으면 지운 대화의 프로세스가 남는다. 크리틱이 §3 밖의 사실이라 결함으로 안 셌지만
같은 자리다 — 아래 대조군에서 실측으로 드러난다(`["c-a","c-b"]`).

`dispose_chat(chat)` 한 줄짜리 함수는 **없앴다.** 호출자가 하나뿐이었고 그 하나가
회수만 하고 통지는 안 해서 G1이 났다 — 갈라 부를 수 있는 모양을 남기면 다음 호출자가
또 반쪽만 부른다.

## 2. 회귀 못 — **삭제 축**을 새로 판다

크리틱의 지적 그대로다: `poc-acct-live` A는 *재시작* 축만 밟아 이 결함을 **100% 통과한다**
(프로세스를 죽이면 유령도 죽으므로, 프로세스를 안 죽이는 축으로만 보인다).

- **실 exe**: `poc-acct-live.mjs` 시나리오 **E** — 같은 계정을 문 채팅 둘에 턴을 한 번씩 →
  사이드바 **우클릭 → 삭제 → 확인**(사용자가 닿는 그 경로 그대로) → **턴을 안 보내고**
  picker를 연다. 8항목(두 자리 전제 · 삭제 전 칩 · 삭제 조작 · 디스크 · 브로드캐스트 수 ·
  유령 행 · 유령 칩 · 런타임 회수).
- **단위**: `status::removing_a_row_reports_what_it_removed`(지운 이름/여부의 계약) ·
  `chats_v3::a_save_that_deletes_a_chat_says_which_one`(삭제 축 + 헛 브로드캐스트 금지) ·
  `chats_v3::deleting_a_chat_that_never_ran_still_counts`(상태 행 없는 삭제).

### 대조군 — 못이 헛못이 아니다

크리틱이 남긴 **수정 전 빌드**(`target-critacct2/release/agentcodegui.exe`, 커밋 `6891372`)에
같은 시나리오 E를 그대로 겨눴다. 레포·`.git` 무접촉, 읽기만 했다.

```
수정 전(6891372)   X E-브로드캐스트  7 → 7 (0건)
                   X E-유령 행      [{c-a, done, account:one@}, {c-b, …}]
                   X E-유령 칩      ["사용 중 · 다른 자리"]
                   X E-런타임 회수  ["c-a","c-b"]                ← 좀비 CLI까지 재현
                   ❌ FAIL — 4건

수정 후(R3)        o E-브로드캐스트  7 → 8
                   o E-유령 행      [{c-b, done, account:one@}]
                   o E-유령 칩      []
                   o E-런타임 회수  ["c-b"]
                   ✅ PASS — 8/8
```

크리틱이 손으로 쟀던 「7 → 7 · 사용 중 · 다른 자리」가 **글자 그대로 재현**됐다.

## 3. 검증 — 크레이트별로 따로 셈

| 무엇 | 결과 |
|---|---|
| `npm run typecheck`(node·web) + `typecheck:app` | **3종 초록** |
| `cargo test -p ccg-store` | **82 통과 · 0 실패** (R2의 79 + 이번 못 3) |
| `cargo test -p agentcodegui` | **143 통과 · 0 실패** (무회귀) |
| `cargo test -p ccg-auth` (기본) | **102 통과 · 0 실패** (84+0+0+14+2+1+1) |
| `cargo test -p ccg-auth --features net` | **119 통과 · 0 실패** (94+1+6+14+2+1+1) |
| `cargo test --workspace` | **704 통과 · 0 실패** (테스트 바이너리 29개 합계) |
| `node scripts/poc-acct-live.mjs`(**실 exe**) | **24 항목 전부 통과** — A 6 · B 3 · C 4 · D 3 · **E 8** |
| `node scripts/poc-acct-store.mjs` | **`ok` 25줄 전부 통과** |
| `node scripts/poc-limit-resume.mjs` | **164 통과 · 0 실패** (M11 훅 무회귀) |
| `node scripts/poc-store-fanout.mjs` | **`ok:` 34줄 전부 통과** (크리틱의 인용 정정을 반영한 수) |
| `node scripts/poc-account-switch.mjs` | **시나리오 6개 PASS** (M11 자동 전환 무회귀) |

**격리**: `CARGO_TARGET_DIR=target-acctr3`(이 갈래 전용 · 남의 트리 무접촉) ·
`CCG_HOME`은 전부 `%TEMP%/ccg-acct-live-r3*` · `CCG_NO_NET=1` + 합성 계정
(`ccg-auth-probe seed`) → **실 HTTP 0건 · 실계정 토큰 열람 0회** · CDP **9560~9575**
(크리틱 9541~9556 · 남의 갈래 9481~9499와 안 겹친다) · 종료는 자기가 spawn한 PID 트리만
(`killTree`) — **이름 기반 kill 0회**(주행 전후로 사용자 실앱 `Programs\AgentCodeGUI` 5개
프로세스 그대로 · 주행 뒤 내 exe 고아 0건) · 기준 결과 파일은 하나도 안 덮었다
(새 파일 `docs/critic/acct-live-r3.json`·`acct-live-r3ctrl.json`·`m11-r1-switch-acctr3.json`).

## 4. 남은 리스크

- **`chats:save`가 삭제를 실을 때만** 허브 배리어(`Op::Debug`)를 기다린다. 허브가 다른 긴
  잡을 물고 있으면 그 저장이 최대 3초(`REPLY_TIMEOUT`) 늦어진다. 평상시 저장은 이 길을
  안 지나고(지운 것이 없으면 즉시 반환), 삭제는 사용자가 한 번 누르는 조작이라 골랐다.
  대안(cast만 던지고 바로 브로드캐스트)은 G1을 좁은 레이스로 되살린다.
- **2.6.2 스토어 경로**(`CCG_UNIFIED_STORE=0`)는 그대로다. 그쪽 `chats::write_chats`는
  애초에 `status::retain`을 안 부르므로 이 축이 없다 — 기본값이 통합 스토어(켬)라
  사용자가 닿는 경로가 아니고, 그 판에서 상태 행을 걷는 규약 자체가 미정이다.
- **추가 채팅 창(`SessionWindow`)의 §3 칩 부재**는 R2의 한계 그대로다
  (`renderer-divergence.md` §6.6). 이번 라운드가 건드린 자리가 아니다.
- 크리틱이 「위험으로만 적는다」고 남긴 F2의 대가(`PROJECTED`를 합의값으로 넓히면 셸이
  *되돌림*과 *낡은 사본*을 원리적으로 구분 못 한다)는 **그대로 남아 있다.** 재현식이
  없어 이번에도 손대지 않았다.

## 5. R3에서 만진 파일

- `crates/ccg-store/src/status.rs` — `retain`/`forget_one`의 반환 계약 + 못 1
- `crates/ccg-store/src/chats_v3.rs` — `write_chats`가 지운 채팅을 돌려준다 + 못 2
- `crates/ccg-store/src/legacy_bridge.rs`(+`_tests.rs`) — `chats_save`·`ma_save` 전파
- `src-tauri/src/engine/mod.rs` — `dispose_removed_chats`(회수 + 배리어 + 브로드캐스트),
  `dispose_chat` 흡수
- `src-tauri/src/ipc/unified.rs` — `chats:save`·`ma:save` 배선
- `src-tauri/src/win.rs` — `session_close` 배선
- `scripts/poc-acct-live.mjs` — 시나리오 **E**(삭제 축) + `seedHome`의 다중 채팅 · `call` 헬퍼
- `docs/renderer-divergence.md` §6.6 — ★R3 정정(문이 `Op::Dispose`가 아니었다)
- `docs/parity-fix-acct-r1.md` (이 절)
