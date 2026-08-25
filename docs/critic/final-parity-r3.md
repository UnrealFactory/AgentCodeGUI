# 최종 파리티 감사 R3 — 정정 라운드. 「역전」은 내려간다. 그 칸이 잰 것은 앱이 아니라 **어느 주행이 조회에 성공했는가**였다

판정자: 최종 파리티 감사 R3(정정 라운드) · 2026-08-25 · `feature/3.0.0-beta`
대상: 내가 쓴 `docs/critic/final-parity-r2.md`(커밋 `953b847` · 잔손질 `e9ddb57`)
지시: `docs/critic/r28e-audit-critic-r1.md`(확인 크리틱 R1 — 감사 자체는 **통과**, 세 칸 정정 + 숙제 넷)

> 이 라운드는 **새 격차를 찾는 라운드가 아니다.** 크리틱이 짚은 네 칸을 내리고, 숙제 넷을
> 실측으로 닫는다. **코드는 한 줄도 안 고쳤다** — 감사자는 보고만 한다.

---

## 0. 무엇으로 쟀나

| 항목 | 값 |
|---|---|
| 판정 트리 | `git archive HEAD`(**`1078718`**) → `C:\Temp\ccg-r28f-audit\wt` (`git worktree` 미등록 · 공유 `.git` 무변) |
| 의존성 | `node_modules` **정션만** (`npm ci`·`npm install` **0회**) |
| 프론트 | `npm run app:build` (vite 2.22s) |
| 셸 | `cargo build --release --features custom-protocol` · `CARGO_TARGET_DIR=C:\Temp\ccg-r28f-audit\target` (**새 디렉터리** — 함정 11 회피) · 2m22s · **경고 0** |
| 산출 exe | `C:\Temp\ccg-r28f-audit\target\release\agentcodegui.exe` · **6,545,408 B** · sha256 `526c70273a7819c1…` |
| 2.6.2 | `node_modules/electron/dist/electron.exe` + 커밋된 `out/`(읽기만) |
| 홈 | 주행마다 격리(`C:\Temp\ccg-r28f-audit\home-*` · 18개) |
| CDP 포트 | 10530~10534 (배정표 준수) |
| 프로세스 | 이름 기반 kill **0회** — 내가 스폰한 PID만(`killTree`) |

> **이 보고서의 모든 줄 번호는 판정 트리(`1078718` 사본)의 것이다.** 워킹트리에서는
> 옆 갈래가 지금 이 순간에도 같은 파일을 고치고 있어서(측정 중 `app/src/components/Settings.tsx`의
> 줄이 실제로 밀렸다) 라이브 줄 번호를 인용하면 다음 독자가 못 찾는다.

**측정 중에 HEAD가 두 번 움직였다**(옆 갈래): `78ecfab`(리드 · progress) · `be308fa`(M10 R6).
이 보고서의 수치는 **전부 `1078718`의 트리**에서 나왔다. 도구가 남기는 `gitHead` 필드는
**실레포의 현재 HEAD**를 찍으므로(`critic-r28e-channels.mjs:107`이 `cwd: REPO`) 산출
JSON 하나에 `be308fa`가 적혀 있다 — 스캔 대상은 `--tree`(=`1078718` 사본)이고 그 파일들은
안 움직였다. 값은 유효하고, 라벨만 오해를 부른다(→ §9 숙제).

### 0.1 안전 규약 — 이번 라운드가 R2보다 **좁게** 간 자리

R2는 `bench/fixture.mjs`가 복사한 실홈 `accounts.json`을 그대로 들고 앱을 켰다. 그 파일이
홈에 있으면 `usage:get` → `net::access_token` → (액세스 토큰 만료 시) **리프레시 교환**으로
갈 수 있고, 그게 함정 5가 말하는 회전이다. 그래서 이 라운드는 **픽스처를 만든 직후,
앱을 켜기 전에** `accounts.json`·`codex-accounts.json`을 지웠다. 심은 것은
`usage-cache.json`(퍼센트만 · 토큰 없음) 하나뿐이다.

주행 수를 정확히 적는다(합 20회):

| 앱 | 주행 | 자격증명 |
|---|---|---|
| 3.0 | 스모크 1 · `limit-pop` 6 · `explorer` 2 · `rawprobe` 1 = **10** | 10회 모두 `accounts.json` 삭제 후 기동. `acctCount`를 기록한 **7회(limit-pop 6 + rawprobe 1)에서 전부 0** |
| 2.6.2 | 스모크 2 · `limit-pop` 6 · `explorer` 2 = **10** | **첫 스모크 1회만** `USERPROFILE`을 안 돌려 실홈 계정 6개를 읽었다(→ §2.5, 이 라운드 최대 발견의 계기). **나머지 9회는 `USERPROFILE`까지 격리**했고, `acctCount`를 기록한 6회에서 전부 0 |

- `usage:get`이 조회를 못 나가므로 **회전 경로가 아예 안 열린다.**
- 실 HTTP: **의도된 주행 19회에서 0건.** 예외는 위 스모크 1회뿐이고, 그 1회의 성격
  (실홈 원본을 읽고 실홈에 되쓰는 경로라 사본 회전 → 되싱크와는 반대 방향)도 §2.5에 그대로 적었다.

### 0.2 증거 파일 (전부 이 라운드 산출)

| 파일 | 무엇 |
|---|---|
| `docs/critic/final-parity-r3-limitpop-{tauri,electron}-{seeded,bare}.json` | `limit-pop` 반복 측정 4벌 × 3회 = **12주행** |
| `docs/critic/final-parity-r3-observations.json` | 한도 축 **모든 관측 27건**(R1·R2·R3 전부, 기계 수집) |
| `docs/critic/final-parity-r3-explorer.json` | `explorer-tree` 같은 시각·같은 트리 2라운드 |
| `docs/critic/final-parity-r3-rawprobe.json` | baseline exe 원시 채널 프로브 23건 |
| `docs/critic/final-parity-r3-channels.json` | 계약면 216채널 재대조(`1078718` 트리) |

도구(신규 · `docs/critic/tools/`): `critic-r28f-limitpop.mjs` · `critic-r28f-observations.mjs` ·
`critic-r28f-explorer-count.mjs` · `critic-r28f-rawprobe.mjs`

---

## 1. 한 문단 결론

**크리틱이 요구한 세 칸을 전부 내린다.** ① T3의 「역전 · 3.0 승」과 §5 블라인드 칸은
**근거 불충분**이다 — 그 칸이 잰 것은 앱이 아니라 **그 주행의 usage 조회가 성공했는가**였고,
증거 파일의 관측 27건을 다 늘어놓으면 극성이 라운드마다 통째로 뒤집힌다(R1: 3.0 0승 ·
2.6.2 2승 / R2: 3.0 4승 · 2.6.2 0승). ② N3(`app:open-directory`)은 **중간 → 높음**.
③ T1의 「클로드 축 닫힘」은 **「채널·화면 확인 · 로그인/로그아웃 왕복 미검증」**으로 고쳐 적는다.
④ 헤드라인 99.2%에는 **통짜 73.6%**를 나란히 싣는다.

**그리고 정정하러 들어갔다가 더 큰 것을 밟았다.** 2.6.2 `src/main/auth.ts:76`은
`APP_HOME = path.join(os.homedir(), '.agentcodegui')`로 **하드코딩**돼 있어 `CCG_HOME`을
무시한다. 즉 지금까지의 모든 A/B에서 **2.6.2는 계정도 `usage-cache.json`도 사용자 실홈에서
읽고 있었다.** 격리 홈에 `accounts.json`이 0바이트인데 2.6.2 화면이 **6계정을 그렸다**(실측).
`needsAccount: true`인 화면의 A/B는 애초에 **3.0(격리 홈) vs 2.6.2(실홈)** 비교였다 —
앱 비교가 아니다. `USERPROFILE`까지 돌려 진짜로 대칭을 맞추자 **12/12 주행이 완전히 같은
값**으로 붙었다.

**출하 판정은 그대로 유지한다: 치명 2 · 출하 불가.** 다만 그 둘(N1·N2)은 **SHIPBLOCK 갈래가
지금 고치고 있다** — 해소 확인은 그 갈래 크리틱 소관이고, 나는 안 건드렸다. **그 둘을 뺀
나머지에서 이번 라운드가 실측으로 찾은 새 치명은 0이다.**

---

## 2. 정정 ① — T3의 「역전」·「3.0 승」·§5 블라인드 칸을 내린다

### 2.1 숙제 (b) — 증거 파일의 **모든 관측**을 싣는다

크리틱의 지적은 사실이다. R2 §2.1은 `limit-pop`을 「같은 픽스처·같은 시각대」라 적고
**한 쌍만** 실었는데, 같은 홈에서 **75초 먼저** 돈 주행이 정반대를 기록해 두었고 그것도
보고서가 N1 근거로 직접 인용하는 파일이다. 이번엔 사람이 고르지 않게 **기계로 수집**했다
(`critic-r28f-observations.mjs` — `press` · `apiprobe` · A/B `found`를 한 표로).

**한도 축 관측 전량 — 27건**(`final-parity-r3-observations.json`):

| # | 시각(UTC) | 앱 | 축 | prows/found | 데이터 | 출처 |
|---|---|---|---|---|---|---|
| 1 | 08-24 03:16:49 | 3.0 | `usage.get` | — | ✗ nulls | `final-parity-r1-apiprobe-tauri.json` |
| 2 | 08-24 03:16:53 | 2.6.2 | `usage.get` | — | ✅ 실값(Fable 有) | `final-parity-r1-apiprobe-electron.json` |
| 3 | 08-24 03:21:47 | 3.0 | A/B `found` | **4** | ✗ | `bench/shots/tauri/report.json` |
| 4 | 08-24 03:24:05 | 2.6.2 | A/B `found` | **5** | ✅ | `bench/shots/electron/report.json` |
| 5 | 08-25 06:12:55 | 2.6.2 | A/B `found` | **4** | ✗ | `bench/shots/electron-r28e/report.json` |
| 6 | 08-25 06:16:50 | 3.0 | A/B `found` | **5** | ✅ | `bench/shots/tauri-r28e/report.json` |
| 7 | 08-25 06:21:24 | 3.0 | `usage.get` | — | ✅ 실값(Fable 有) | `final-parity-r2-apiprobe-tauri.json` |
| 8 | 08-25 06:22:08 | 2.6.2 | `usage.get` | — | ✗ nulls | `final-parity-r2-apiprobe-electron.json` |
| 9 | 08-25 06:22:33 | 3.0 | `usage.get` `CCG_NO_NET=1` | — | ✗ nulls+**unavailable** | `final-parity-r2-apiprobe-tauri-nonet.json` |
| 10 | 08-25 06:23:29 | 3.0 | `limit-pop` press | **4** | ✗ | `final-parity-r2-press-tauri.json` |
| 11 | 08-25 06:24:45 | 3.0 | `limit-pop` press(**같은 홈**) | **5** | ✅ | `final-parity-r2-press-tauri-eb.json` |
| 12 | 08-25 06:25:21 | 2.6.2 | `limit-pop` press | **4** | ✗ | `final-parity-r2-press-electron-eb.json` |
| 13 | 08-25 06:27:49 | 2.6.2 | `limit-pop` press | **4** | ✗ | `final-parity-r2-press-electron-limit2.json` |
| 14 | 08-25 06:29:42 | 3.0 | A/B `found`(통짜 2회차) | **5** | ✅ | `bench/shots/tauri-r28e2/report.json` |
| 15 | 08-25 06:35:59 | 3.0 | A/B `found`(격리 재현) | **4** | ✗ | `bench/shots/tauri-r28ex/report.json` |
| 16–21 | 08-25 07:45~07:47 | **3.0 ×6** | `limit-pop`(R3 seeded 3 · bare 3) | **4 ×6** | ✗ ×6 | `final-parity-r3-limitpop-tauri-*.json` |
| 22–27 | 08-25 07:45~07:47 | **2.6.2 ×6** | `limit-pop`(R3 seeded 3 · bare 3 · USERPROFILE 격리) | **4 ×6** | ✗ ×6 | `final-parity-r3-limitpop-electron-*.json` |

**R2 보고서가 실은 것은 이 중 #11과 #12·#13뿐이다.** #10(같은 홈·75초 전·정반대) ·
#14 · #15는 한 줄도 인용되지 않았다. **내 잘못이고, 그 인용은 대표성이 없다.**

**실계정이 있던 관측만 추려 라운드별로 세면**(#1~#8, #10~#15 · #9는 킬 스위치 대조군 제외):

| 라운드 | 3.0 「값 있음」 | 3.0 「데이터 없음」 | 2.6.2 「값 있음」 | 2.6.2 「데이터 없음」 |
|---|---|---|---|---|
| R1 (08-24) | **0** | **2** | **2** | **0** |
| R2 (08-25) | **4** | **2** | **0** | **4** |
| 합 | 4 | 4 | 2 | 4 |

3.0은 같은 라운드 안에서 **4번 성공 · 2번 실패**했다(#6·#7·#11·#14 성공 / #10·#15 실패).
**같은 앱이 같은 날 같은 픽스처로 두 극성을 다 냈다.** 이런 지표로 승패를 매길 수 없다.

**고른 이유를 한 줄로**(숙제 b의 요구): 이 표에서 결론에 쓰는 관측은 **#9 하나**다 —
`CCG_NO_NET=1`에서 `unavailable:true` 표식이 붙는 것은 3.0에만 있는 **결정적 성질**이라
환경에 안 흔들린다(내 12주행에서도 3.0만 `unavailable:true`, 2.6.2는 그냥 nulls).
나머지 26건은 **전부 「승패 근거 아님」으로 분류**한다.

### 2.2 이 지표가 왜 앱을 안 재는가 — `prows` 4↔5의 기전

팝오버 행은 두 앱이 **글자 그대로 같은 조건식**으로 그린다:

```
app/src/components/Chat.tsx:4142           ...(usage.weeklyFable ? [limitRow(t('Fable 주간 한도', …))] : []),
src/renderer/src/components/Chat.tsx:3322  ...(usage.weeklyFable ? [limitRow(t('Fable 주간 한도', …))] : []),
```

즉 `prows` = 1(현재 컨텍스트) + 1(5시간) + **[Fable 주간 ← `weeklyFable != null`일 때만]**
+ 1(주간) + 1(토큰 사용량). **4 ↔ 5의 차이는 `usage.weeklyFable`이 왔는가 하나뿐이다** —
관측 #11의 텍스트(`… Fable 주간 한도 1일 7시간 후 초기화 67% 남음 …`)가 그대로 증명한다.
그리고 `weeklyFable`은 **그 계정 플랜의 성질**이지 앱의 성질이 아니다.

### 2.3 숙제 (a)의 처방 그대로 — 캐시를 심고 **각 3회 이상** 다시 쟀다

| 팔 | 홈에 심은 것 | 계정 | 3.0 (3회) | 2.6.2 (3회) |
|---|---|---|---|---|
| `seeded` | 실홈 `usage-cache.json` 사본 **1,682 B** | 0 | `prows=4` · `hasNoData=true` **×3** | `prows=4` · `hasNoData=true` **×3** |
| `bare` | (없음) | 0 | `prows=4` · `hasNoData=true` **×3** | `prows=4` · `hasNoData=true` **×3** |

`usage:get` 응답까지 같이 남겼다:

```
3.0    {"fiveHour":null,"weekly":null,"weeklyFable":null,"extraCredit":null,"unavailable":true}   ×6
2.6.2  {"fiveHour":null,"weekly":null,"weeklyFable":null,"extraCredit":null}                      ×6
```

**두 앱이 완전히 같다**(3.0에만 `unavailable` 표식이 더 붙는데, 그건 T3에서 이미 「닫힘」의
근거로 쓴 3.0의 개선점이다 — §2.1 #9). 12/12 주행에서 `hasNoData`가 **안 흔들렸다.**

### 2.4 ★그런데 그 처방은 이 화면에 **닿지 않는다** — 두 앱 다

크리틱의 처방(「`usage-cache.json`을 심은 뒤 재라」)은 이 화면에 대해 **구조적으로 무효**다.
`usage-cache.json`은 **설정 ▸ Account의 계정별 목록**(`auth:accounts-usage`)만 먹인다.
워크바 팝오버가 읽는 `usage:get`은 **두 앱 다 메모리 캐시만** 본다:

| | 3.0 | 2.6.2 |
|---|---|---|
| 진입 | `app/src/App.tsx:526`·`:1836` `window.api.getUsage(...)` | `src/renderer/src/App.tsx:398`·`:418` 같은 호출 |
| 캐시 | `ipc/parity/usage.rs:103 cache()` = 프로세스 메모리 `HashMap` | `src/main/index.ts:1006 usageCache` = 프로세스 메모리 `Map` |
| 실패 폴백 | `usage.rs:129 stale()` — **메모리 캐시만** | `index.ts:1050` `usageCache.get(cacheKey)?.data ?? empty` — **메모리 캐시만** |
| 디스크 `usage-cache.json` | 이 경로에서 **안 읽는다** | 이 경로에서 **안 읽는다** |

그러니 이 화면을 세우는 것은 오직 **팝오버를 여는 순간 나가는 실 HTTP 1회**
(`GET https://api.anthropic.com/api/oauth/usage`)뿐이고, 그 엔드포인트에 대해 레포 자신의
주석이 이렇게 적는다:

```
crates/ccg-auth/src/usage.rs:27
/// usage API는 세게 레이트리밋된다(실측: 같은 IP의 병렬 2건 중 1건이 429, 짧은 연속 호출도 429).
```

**R2가 이미 캐시를 심어 두고도 못 봤다.** `final-parity-r2-apiprobe-{tauri,electron}.json`은
둘 다 `seededUsageCache: true`인데 2.6.2 쪽 `usage.get`은 그대로 nulls였다(관측 #8).
캐시는 심었지만 그 캐시가 이 문에 안 닿는다는 사실이 그때 이미 파일에 적혀 있었다.

### 2.5 ★새 발견 — 2.6.2는 `CCG_HOME`을 무시한다. 이 축의 A/B는 **애초에 대칭이 아니었다**

이 라운드의 첫 스모크에서 잡혔다. 격리 홈에서 `accounts.json`을 **지우고** 2.6.2를 켰는데
화면이 **6계정**을 그렸다:

```
[electron/seeded 1/1] prows=5 hasNoData=false acct=6
  usage={"fiveHour":{"pct":0,...},"weekly":{"pct":100,...},"weeklyFable":{"pct":33,...}}
        ↑ 격리 홈의 accounts.json = 없음. 그런데 실계정 6개가 보이고 실값이 온다.
```

원인은 한 줄이다:

```
src/main/auth.ts:76        const APP_HOME = path.join(os.homedir(), '.agentcodegui')   ← CCG_HOME 무시
src/main/codex/auth.ts:20  같음      src/main/codex/versions.ts:17  같음
   ↔  crates/ccg-store/src/lib.rs:107 app_home()  — 3.0은 CCG_HOME이 있으면 **무조건** 그 경로
```

`auth.ts`가 잡는 것은 `accounts.json`(:77) · `accounts/`(:210) · `shared/`(:211) ·
**`usage-cache.json`(:514)** · `login/`(:618)이다. 그래서 **`CCG_HOME`만 준 2.6.2는 계정 축과
한도 캐시를 통째로 사용자 실홈에서 읽는다.** 결과:

1. R1·R2의 `workbar-context-pop`·계정 관련 A/B는 **3.0(격리 사본) vs 2.6.2(실홈 원본)** 비교였다.
   3.0 쪽은 「사본의 액세스 토큰이 아직 살아 있나」에, 2.6.2 쪽은 「실홈이 방금 갱신했나」에
   각각 좌우된다 — **두 축의 온도가 아예 다르다.**
2. `bench/fixture.mjs`가 복사하는 `accounts.json`은 **3.0만 읽는다.** 2.6.2 쪽에는 아무 효과가 없다.
3. **그 1회 스모크는 실홈 계정으로 실 조회를 냈다.** 이 경로의 회전은 결과가 **실홈에 그대로
   되쓰인다**(격리 사본이 아니라 원본을 갱신한다) — 함정 5가 말하는 「사본 회전 → 실앱 되싱크」와는
   반대 방향이라 되싱크는 안 생긴다. 그래도 의도한 조작이 아니었으므로 **그 뒤 모든 2.6.2 주행에
   `USERPROFILE`을 돌려** 실홈에 다시는 안 닿게 했다(아래).

`os.homedir()`는 Windows에서 `USERPROFILE`을 먼저 본다. 자식 프로세스의 `USERPROFILE`을
`C:\Temp\ccg-r28f-audit\uprof`로 돌리자 2.6.2도 그제야 격리됐다:

```
[electron/seeded 1/1] prows=4 hasNoData=true acct=0   ← 같은 픽스처 · USERPROFILE만 돌림
```

**이게 이 축에서 두 앱을 대칭으로 세우는 유일한 손잡이다.** §2.3의 12주행은 전부 이 손잡이를
쓴 것이고, 그래서 두 앱이 붙었다.

> 이건 **2.6.2 쪽 성질**이지 3.0의 회귀가 아니다. 회귀 목록에 넣지 않는다. 다만
> **하네스 숙제**이고(§9-1), R1·R2의 계정·한도 화면 판정을 **전부 다시 봐야 하는 이유**다.

### 2.6 판정 — `limit-pop`·`workbar-context-pop`은 **환경 의존 화면**이다 (숙제 a)

`settings-engine-confirm`과 같은 잣대를 적용한다(R2 §6.1-6).

| 항목 | 판정 |
|---|---|
| T3 「닫힘」 | **유지.** `usage:get`이 실값을 준다(#7) · `accounts-usage(cachedOnly)`가 네트워크 0회로 6행(#7) · `CCG_NO_NET=1`에서 `unavailable:true`(#9 · 내 12주행 재현). 이 셋은 환경에 안 흔들린다 |
| T3 「**역전**」 | ⛔ **철회.** 재현되지 않는 관측이고, 같은 라운드·같은 홈에 반대 관측이 있다 |
| T3 「이 화면은 이제 **3.0 승**」 | ⛔ **철회** |
| §5 「블라인드에서 UI가 지지 않는가 → 지지 않는다」 | ⛔ **근거 불충분으로 내림.** 이 칸의 유일한 근거였던 값이 승패 근거가 못 된다. 픽셀 근거도 R2 §3.4가 이미 「근거 불가」라 적었다 → **이 라운드 판정: 「미판정 — 근거 없음」** |
| 화면 분류 | `limit-pop` · `workbar-context-pop` = **환경 의존**(실 usage 조회 성공 여부에 좌우 · 레이트리밋 대상 · 2.6.2는 `CCG_HOME` 격리도 안 된다). A/B에서 `found` 차이를 **앱 차이로 세지 말 것** |

**출하 판정에는 영향이 없다**(크리틱과 같은 결론).

---

## 3. 정정 ② — N3(`app:open-directory`) 중간 → **높음**

격차 자체는 R2가 적은 그대로고, 내 baseline exe에서도 재현됐다
(`final-parity-r3-rawprobe.json`):

```
raw:app:open-directory("C:\Code")   → {"__unimplemented": true}
raw:app:get-initial-dir             → null            (콜드 경로는 산다)
shim:app.onOpenDirectory            → "function"      (렌더러는 구독 중 · 방출자가 0)
```

**등급을 올리는 근거 둘 — 둘 다 「예외 상황」이 아니라 「기본 상태」다.**

1. **배포 경로에 이미 붙었다.** `src-tauri/nsis/hooks.nsh:26`(`!define CCG3_DIRSHELL
   "Software\Classes\Directory\shell\AgentCodeGUI3"`)가 `NSIS_HOOK_POSTINSTALL`에서
   `HKCU`에 「AgentCodeGUI3으로 열기」를 쓴다(커밋 `60022e0`). **설치한 사용자에게 이미
   보이는 메뉴다.** 미구현 채널이 아니라 **이미 광고된 기능**이 조용히 안 되는 자리다.
2. **「이미 떠 있는 앱」이 정상 상태다.** 3.0은 X를 눌러도 종료가 아니라 트레이로 숨는다 —
   `src-tauri/src/win.rs`의 `CloseRequested`가 `tray::hide_on_close()`를 보고 `api.prevent_close()`
   하는데, 그 함수(`src-tauri/src/tray.rs:139-143`)는
   `read_ui_prefs().get("tray.closeToTray") != Some(false)` 즉 **기본 켜짐**이다.
   그러니 사용자의 통상 상태에서 그 메뉴를 누르면 `main.rs:171-177`이
   `win::tray::raise_existing()` 후 **`return`** — **창만 앞으로 오고 폴더는 조용히 사라진다.**
   오류도 안내도 토스트도 없다.

**「콜드 실행은 된다」는 완화가 안 된다.** 게다가 2.6.2도 X는 트레이로 숨는다
(`src/main/index.ts:201-202` — *"메인 창의 X는 종료가 아니라 여기로 최소화된다"*).
즉 **2.6.2 사용자가 매일 쓰던 경로가 정확히 그 「이미 떠 있는 앱」 경로**이고,
2.6.2는 거기서 `second-instance` → `send(IPC.openDirectory, dir)`로 폴더를 넘긴다
(`index.ts:1907-1916`). 3.0에서 그게 사라진다.

**N3 = 높음.** (출하를 막지는 않는다 — 치명은 아니다.)

---

## 4. 정정 ③ — T1은 「닫힘」이 아니라 「채널·화면 확인 · **로그인/로그아웃 왕복 미검증**」

R1이 T1에 치명을 매긴 이유는 「새 사용자는 3.0에서 **로그인할 방법이 없다**」였다.
R2가 실측한 것은 셋이고 **셋 다 로그인 왕복이 아니다**:

| R2가 확인한 것 | 이번 라운드 재확인(baseline exe) | 왕복인가 |
|---|---|---|
| 채널이 `__unimplemented`가 아니다 | `raw:auth:login-cancel` → `null` · `raw:auth:reorder-accounts` → `[]` | ✗ (도는 로그인이 없을 때의 no-op) |
| no-op 재정렬이 6행을 준다 | 계정 0 홈이라 `[]` — R2의 6행은 계정 6개 홈의 값 | △ **no-op 쓰기 왕복 1건은 진짜다** |
| 화면에 버튼이 그려진다 | 설정 ▸ Account에 「계정 추가」 2 · 「삭제」 6 · 「맨 위로」 5 (R2 실측) | ✗ |

**한 번도 안 부른 것**: `auth:login`(브라우저 왕복 → 계정 추가) · `auth:logout`(= **서버 토큰
해지**) · `auth:remove-account` · `auth:set-default-account`. R2 §0이 스스로
*「로그아웃 · 설치 · 정리 · 업데이트 · Codex 로그인은 한 번도 부르지 않았다」* 고 적는다.

**안 부른 것은 안전 규약상 옳다.** 문제는 그것을 「닫힘」이라고 쓴 것이다. 표기를 고친다:

> **T1 = 부분 닫힘 · 클로드 축 「채널·화면 확인 · 로그인/로그아웃 왕복 미검증」 / Codex 축 ⛔ 미구현(N1)**

**잣대 비대칭도 인정한다.** 나는 Codex 축에는 「눌러도 아무 일이 없다」로 치명을 매기고,
클로드 축에는 「채널이 있다」로 닫았다. 같은 잣대가 아니다. 다만 **Codex 축의 결론 자체는
옳다** — 그쪽은 Rust에 핸들러가 **0개**여서(§7 재현) 채널 존재 여부라는 더 낮은 문턱조차
못 넘는다. 즉 비대칭은 **표기의 문제**이지 판정을 뒤집지 않는다.

**왕복 검증은 이 감사 라인의 안전 규약 안에서는 못 한다**(실계정 토큰 해지·회전을 부른다).
다음 라운드는 둘 중 하나로 닫아야 한다 — ① 계정 축 갈래(CASX2)의 라이브 실측을 인용하거나,
② **합성 OAuth 스텁**으로 로그인/로그아웃 왕복을 재는 하네스를 만든다(→ §9-3).

---

## 5. 정정 ④ — 헤드라인 99.2%에 **통짜 73.6%**를 나란히 싣는다

99.2%는 **병합본**의 수치다. 파일이 말하는 것:

| 리포트 | 성격 | 수치 |
|---|---|---|
| `bench/shots/tauri-r28e/report.json` | **병합본**(`mergedFrom 05:51:35Z`) | ok 120 / 121 = **99.2%** |
| `bench/shots/tauri-r28e2/report.json` | **통짜 2회차**(병합 없음) | ok **89** / 121 = **73.6%** · failed 32 |
| `bench/shots/electron-r28e/report.json` | **병합본**(`mergedFrom 05:55:18Z`) | ok 119 / 121 = **98.3%** |

원인은 3.0의 회귀가 아니라 **하네스의 느슨한 매칭**이다(R2 §3.4 · 크리틱도 재현).
`clickText`가 부분 문자열로 첫 요소를 고르는데, 3.0이 T4를 고쳐 생긴 「BTW - …」 창 행이
먼저 걸려 채팅이 안 바뀌고 그 뒤 31화면이 조용히 죽는다.

**§1 결론과 §5 표에는 이렇게 적어야 한다:**

> 화면 도달 **통짜 73.6%(89/121) · 병합 99.2%(120/121)** — 통짜의 32실패는 전부
> 하네스 결함(§6.1-1) 한 자리에서 나온 연쇄이고, 재주행에서 전부 초록이다.

**같이 실어야 할 정직한 단서 하나 더**: 2.6.2 쪽 **통짜 원수치는 파일에 안 남아 있다.**
`--merge`가 `electron-r28e/report.json`을 제자리에서 덮었기 때문이다(`mergedFrom` 타임스탬프만
남는다). 그래서 **통짜 대 통짜**의 대등 비교는 이 라운드에 불가능하다 — 3.0 쪽만 2회차가
따로 저장돼 있어 수치가 있는 것이다(→ §9-2 숙제).

---

## 6. 숙제 (c) — `explorer-tree` T=103 / E=105는 **픽스처 노이즈**였다

R2의 A/B는 3.0(05:51Z)과 2.6.2(05:55Z)를 **4분 떨어뜨려** 돌았다. 그 사이 옆 갈래들이
레포 루트에 `target-*` 디렉터리를 만든다(이 라운드 시작 시 루트에 **61개**가 있었다).

`critic-r28f-explorer-count.mjs`로 **두 앱을 동시에 띄워 같은 순간**에 쟀다
(`final-parity-r3-explorer.json`):

| 라운드 | 기동 순서 | 3.0 `found` | 2.6.2 `found` | 두 eval 사이 간격 | 루트 항목 수(전/후) |
|---|---|---|---|---|---|
| 1 | tauri → electron | **114** | **114** | 1,367 ms | 119 → **120** |
| 2 | electron → tauri | **114** | **114** | 1,376 ms | 120 → 120 |

행 **라벨 차집합도 양쪽 0건**(`onlyInTauri: []` · `onlyInElectron: []`). 그리고 라운드 1
도중에 루트가 **119 → 120으로 늘었다** — 내가 재는 그 몇십 초 사이에도 트리가 자란다는
직접 증거다(내 `CARGO_TARGET_DIR`는 `C:\Temp`라 내가 만든 게 아니다).

**판정: 앱 차이 아님. R2의 103 vs 105는 측정 시각 4분 차이다.** 인벤토리에 격차로 올리지
않는다. 다만 **A/B는 두 앱을 같은 시각에 재야 한다**(→ §9-2).

---

## 7. 숙제 (d) — N1의 처방에 **실패 통지**를 넣어라 (수정은 SHIPBLOCK 갈래)

### 7.1 기전 — `catch`가 영원히 안 돈다

내 baseline exe(`1078718`)에서 그대로 재현된다(`final-parity-r3-rawprobe.json`):

```
raw:codex-auth:login              → {"__unimplemented":true}
raw:codex-auth:logout             → {"__unimplemented":true}
raw:codex-auth:login-cancel       → {"__unimplemented":true}
raw:codex-auth:reorder-accounts   → {"__unimplemented":true}
raw:codex-auth:set-default-account→ {"__unimplemented":true}

shim:codexAuth.reorderAccounts([]) → []      ← **resolve**한다 (reject 아님)
shim:codexAuth.login()             → []      ← 같음
shim:codexAuth.logout(…)           → []      ← 같음
console: [shim] codex-auth:{reorder-accounts,login,logout} — 백엔드 미구현 채널 (3.0 M1: 안전값 반환)
```

`app/src/api/shim.ts:91`의 `call()`이 미구현을 **던지지 않고 fallback을 resolve**한다
(`:101-103` — `isUnimplemented(res) → warnOnce → return fallback`). 그래서:

```
Settings.tsx:537   setCxAccounts(await window.api.codexAuth.reorderAccounts(order))   ← [] 가 앉는다
Settings.tsx:538-540   } catch { setNote('순서를 바꾸지 못했어요 …') }                  ← **영원히 안 돈다**
```

사용자에게 남는 것은 「눌렀더니 OpenAI 계정이 전부 없어졌다」 하나다. **실패가 「빈 결과」로
번역돼 호출부에 도착한다** — 이게 이 구조의 본질이고, 채널 배선만으로는 안 없어진다.

### 7.2 같은 사고를 낼 수 있는 다른 자리 (구조 문제라는 증거)

`call()`의 안전값이 **호출부가 화면 상태에 그대로 앉히는 값**인 자리는 전부 같은 위험이다.
현재 미구현 18채널 중 심 안전값이 **목록/상태를 갈아끼우는** 것:

| 채널 | 심 안전값 | 앉는 자리 | 사용자가 보는 것 |
|---|---|---|---|
| `codex-auth:login` | `[]` | `setCxAccounts` | 계정 목록 증발 · 안내 0 |
| `codex-auth:logout` | `[]` | `setCxAccounts` | 같음 |
| `codex-auth:reorder-accounts` | `[]` | `setCxAccounts` | 같음(실측 확인) |
| `codex-auth:set-default-account` | `[]` | `setCxAccounts` | 같음 |
| `app:open-directory` | no-op | (방출자 없음) | 아무 일도 안 일어남 · 안내 0 (§3) |

### 7.3 처방 (감사자의 요구 — 구현은 SHIPBLOCK 갈래)

1. **채널 배선**(N1의 본체): `codex-auth:{login,logout,login-cancel,reorder-accounts}` 4개를
   Rust에 붙인다. 도메인은 이미 있다(`crates/ccg-auth/src/codex.rs:305 reorder_accounts`) —
   셸이 안 부를 뿐이다.
2. **★실패 통지**(이번 라운드가 더하는 것): **쓰기 채널은 미구현/실패를 구분 가능한 결과로
   올려야 한다.** `call()`이 조용히 fallback을 resolve하는 한, 호출부가 이미 갖고 있는
   `try/catch`(`Settings.tsx:538`·`:496`)는 **영원히 죽은 코드**다. 최소 조건 셋:
   - 목록을 **갈아끼우는** 채널(위 표)은 `__unimplemented`를 **reject**로 올린다.
   - 조회 채널은 지금대로 `call()`로 둔다 — 거기까지 넓히면 목록 하나가 없다고 설정 화면이
     통째로 죽는다(그게 M1이 `call`을 만든 이유다).
   - 배선이 끝난 뒤에도 **네트워크 실패·취소**가 같은 자리로 떨어지므로, `setNote` 경로는
     채널이 생긴 뒤에도 살아 있어야 한다.
3. **회귀 방지**: 「미구현 채널의 안전값이 목록 setter에 그대로 앉는가」를 **A/B 화면 정의로**
   잡는다. 지금 하네스는 이 사고를 **한 번도 못 잡았다** — 화면이 안 죽고 목록만 비기 때문이다.

> **수정은 SHIPBLOCK 갈래 소관이고 나는 안 건드렸다.** 참고로 내 baseline(`1078718`) 이후
> 그 갈래의 **미커밋** 작업이 워킹트리에 있고(`app/src/api/shim.ts`에 `callStrict` ·
> `ShimUnavailableError`가 보인다), 방향은 위 2와 같다. **해소 확인은 그 갈래 크리틱의 일**이며
> 이 보고서는 그것을 검증하지 않았다(내 exe에는 그 변경이 안 들어 있다).

---

## 8. 출하 판정

| 사용자 기준 | 수치 | 판정 |
|---|---|---|
| 기존 기능을 화면 단위로 하나도 빠뜨리지 않았는가 | 화면 도달 **통짜 73.6%(89/121) · 병합 99.2%(120/121)**(원인: 하네스 §6.1-1) · 계약면 **216 / impl 198 / missing 18**, 그중 실격차 **5**(`1078718` 트리 재대조 — R2와 목록까지 동일) | **거의. 다만 아니다** — 남은 5채널 중 4개가 「Codex 계정」 한 축이라 그 엔진을 **시작할 수 없다** |
| 블라인드에서 UI가 지지 않는가 | **미판정 — 근거 없음.** 유일한 근거였던 `workbar-context-pop`은 **환경 의존**(§2) · 픽셀 대조는 잔존 상태 비대칭으로 근거 불가(R2 §3.4) | ⚠ **다음 라운드로 이월**(§9-4) |
| 치명 0인가 | **2** — N1(Codex 계정 축 5채널) · N2(에러 안전망 부팅 루프) | ⛔ **출하 불가** |
| 그 둘을 빼면 | 높음 **1**(N3 · 이번 라운드 승격) · 중간 **0** · 낮음 **2**(N4·N5) | 나머지는 출하를 막지 않는다 |

**N1·N2는 SHIPBLOCK 갈래가 지금 고치고 있다 — 해소 확인은 그 갈래 크리틱 소관이다.**
나는 그 둘을 안 고쳤고, 이 보고서로 닫지도 않는다.

**그 둘을 뺀 나머지에서 이번 라운드가 실측으로 찾은 새 치명은 0이다.** 근거:

- 계약면 216채널 재대조(`1078718` 트리) — `missing 18` · 목록이 R2·크리틱과 **완전히 동일**.
  새로 죽은 채널 **0개**.
- `WindowApi` 184잎 전수 — `app/src/api/shim.ts` 누락 **0**(순수 트리에서 재실행).
- baseline exe 원시 프로브 23건 — T2(`engine.listAvailable().latest="0.3.245"` · 277버전) ·
  T4(`raw:btw:open` → `null`) · M1(`raw:shortcut:close` → `null`) ·
  M3(`raw:ui:open-api-settings` → `null`) · M5(`git.aiMessage` → `{ok:false,"Git 저장소가 아니에요"}`) ·
  M6(`engine.state.bundled="unknown"` · active `0.3.245`) · T3의 `unavailable:true` 표식 —
  **전부 그대로 산다.**
- `explorer-tree`의 유일하게 안 짚힌 `found` 차이(103/105)는 **앱 차이가 아니었다**(§6).

**R2 대비 이동**: 치명 2 → **2**(둘 다 SHIPBLOCK 수정 중) · 높음 0 → **1**(N3 승격) ·
중간 1 → **0**(N3가 올라갔다) · 낮음 2 → **2**. **정정 4건 · 신규 격차 0건.**

---

## 9. 다음 라운드 숙제

1. **★계정·한도 축의 A/B는 `USERPROFILE`까지 돌려야 한다.** 2.6.2 `auth.ts:76`·
   `codex/auth.ts:20`·`codex/versions.ts:17`이 `os.homedir()`를 하드코딩해 `CCG_HOME`을 무시한다.
   `bench/lib.mjs`의 `electronProfile`에 그 손잡이를 넣고, **넣기 전에 잰 계정·한도 화면 판정은
   전부 다시 떠라**(R1·R2 양쪽). 지금은 3.0=격리 사본 vs 2.6.2=실홈을 비교하고 있다.
2. **두 앱을 같은 시각에 재라.** `explorer-tree`가 4분 차이로 103↔105를 냈다(§6). 그리고
   `--merge`는 통짜 원수치를 **제자리에서 덮는다** — 병합본 옆에 통짜 리포트를 따로 남겨라
   (3.0은 `tauri-r28e2`가 우연히 남아 §5를 쓸 수 있었다).
3. **로그인/로그아웃 왕복을 재는 길을 만들어라.** 실계정으로는 못 한다(토큰 해지·회전).
   합성 OAuth 스텁(로컬 콜백 + 가짜 토큰)으로 `auth:login`→계정 추가→`auth:logout` 왕복을
   격리 홈에서 닫아야 T1의 「왕복 미검증」이 없어진다(§4).
4. **블라인드 칸을 다시 세워라.** 지금 이 칸은 **근거가 없다.** 환경 의존 화면
   (`limit-pop`·`workbar-context-pop`·`settings-engine-confirm`)을 블라인드 표본에서 빼고,
   잔존 상태를 대칭으로 맞춘 뒤 픽셀 대조를 다시 떠라(R2 §6.1-3).
5. **환경 의존 화면에 표시를 달아라.** 하네스 화면 정의에 `envDependent: true`를 두고
   리포트 요약에서 성공률 계산과 `found` 비교에서 **자동으로 빼라**. 지금은 사람이 각주로
   기억해야 하고, R2에서 정확히 그게 실패했다.
6. 도구 위생: `critic-r28e-channels.mjs:107`의 `gitHead`가 `--tree`가 아니라 **실레포 HEAD**를
   찍는다(§0). `--tree`를 준 주행에서는 그 트리의 증표(예: 사본 sha)를 남겨라.
7. (R2에서 이월 · 미해소) N5 다이얼 1~6 vs 모달 2~6 — 사용자 결정 대기. 크리틱 R1이
   *「1은 3.0이 새로 더한 값이고 2.6.2 다이얼은 [2..6]」* 이라 정정했다(`src/renderer/src/components/MultiAgent.tsx:63`).

---

## 부록 A — R2 보고서에서 **고쳐 읽어야 할 줄**

| R2 위치 | 원문 | 정정 |
|---|---|---|
| §2.1 T1 판정 | 「**클로드 축 닫힘**」 | 「클로드 축 **채널·화면 확인 · 로그인/로그아웃 왕복 미검증**」(§4) |
| §2.1 T3 판정 | 「**닫힘 + 역전**」 | 「**닫힘**」만 유지. 「역전」 철회(§2) |
| §2.1 T3 실측 블록 | 3.0 `prows=5` vs 2.6.2 `prows=4` 한 쌍 | 관측 **27건 전량** 표로 대체(§2.1). 이 지표는 **환경 의존** |
| §2.1 각주 | 「이 화면은 이제 **3.0 승**」 | ⛔ 철회 |
| §2.3 M2 / §4 N3 | 「⚠ 반만 닫힘」 · **중간** | **높음**(§3) |
| §3.1·§5 표 | 「120/121 = 99.2%」 | 「**통짜 73.6%(89/121) · 병합 99.2%(120/121)**」(§5) |
| §4 끝 `explorer-tree` | (언급 없음) | 103 vs 105 = **픽스처 노이즈** · 앱 차이 아님(§6) |
| §5 「블라인드에서 UI가 지지 않는가」 | 「**지지 않는다**」 | **미판정 — 근거 없음**(§2.6) |
| §5 「치명 0인가」 | 「**2** ⛔ 출하 불가」 | **유지.** 단 「N1·N2 = SHIPBLOCK 갈래 수정 중 · 해소 확인은 그 갈래 크리틱 소관」을 병기 |
| §0 안전 규약 | 「픽스처 홈은 실홈 `accounts.json`을 복사한다」 | 그 사본은 **3.0만 읽는다.** 2.6.2는 `CCG_HOME`을 무시하고 실홈을 읽는다(§2.5) |
