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
| `node scripts/poc-acct-store.mjs` | **16 항목 전부 통과** (신규 하네스) |
| `npm run typecheck` · `typecheck:app` | 3종 초록 |

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
