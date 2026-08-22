# R8 수정 확인 크리틱 — 빌더 3인의 green을 믿지 않고 독립 재실행

**판정 대상**: `ee97909`(M3 R2) · `8593244`(M2 R2) · `8a343b6`(M-UI R2)
**대조 계약**: `docs/critic/{m3-r1,m2-r1,mui-r1}.md` · `docs/design/m-logic.md` · `docs/design/ui-glass.md`
**빌더 보고**: `docs/m3-report-r1.md` §8 · `docs/m2-report-r1.md` §R2 · `docs/design/ui-glass.md`

> **이 문서의 규칙**: 빌더가 "돌렸다"고 적은 것은 전부 **내가 다시 돌렸다.** 수치는 내 주행값이고,
> 빌더 값과 다르면 둘 다 적었다. 빌더가 "green이다"라고만 하고 근거 파일이 그 값을 안 담고 있는
> 자리는 **결함으로 셌다**(제품 결함이 아니라 추적성 결함으로 구분해서).

**안전**: 이름 기반 kill 0회. 죽인 PID는 **내가 스폰한 것만**(9148 트리 · 34304 트리 · 프로브가
띄운 앱 3회 · 하네스 자신의 child). 사용자 실앱 `AgentCodeGUI.exe` 6프로세스는 시작·종료 시
동일하고 전부 `%LOCALAPPDATA%\Programs\AgentCodeGUI\`(설치본 2.6.2)다. 실홈은 **읽기/복사만** —
`~/.agentcodegui/chats/index.json` md5 `ab9efd98…` 전·후 동일. 제품 코드 수정 0(뮤테이션은 전부
`git checkout`으로 원복 후 `git status --porcelain crates/` 빈 것 확인). 크리틱 증거 파일
`docs/critic/m2-r1-*.json` 6개는 하네스가 덮은 뒤 `git checkout`으로 복원했다. 실행 후 잔존
프로세스 0(내 트리 소속 `agentcodegui.exe`·`msedgewebview2.exe` 0개 — 남은 WebView2는 전부
SearchHost·Widgets·사용자의 다른 앱).

---

## 0. 세 갈래 판정

| 갈래 | 판정 | 요지 |
|---|---|---|
| **엔진(M3)** | ✅ **확인** | 97 green 재현 · C1 반증이 실제로 붉어짐(5/5) · C2·C3·C6 뮤테이션 3건 전부 지정 테스트 사망 · C3 설계 판정은 §7.2·§7.3·§7.4 문면과 일치. 불일치 2건은 **문서 과장**이지 결함 아님 |
| **스토어(M2)** | ⚠️ **확인 — 단, 새 차단 1건** | 하네스 6종 전부 재현(D6는 빌더 진단대로 하네스 형상 결함이었고 내가 고쳐 green) · 실홈 복사본 PASS 재현 · **`session-wins:changed`가 영속 추가 채팅을 UI에서 지운다(R8-1, 실측)** — 빌더는 "다음 라운드"로 넘겼지만 D7 증상을 클릭 한 번으로 되살린다 |
| **유리(M-UI)** | ✅ **확인** | 폴백 4경로 전부 도달 재현 · 기본값 반전 첫 프레임 A/C 0장·D 186.4ms(문서 187.1) 재현 · 최악 B의 유일한 완화 근거(스플래시 덮기)를 내가 처음 실측해 확정 · knock 8/8 두 경로 · 멀티 게이트 회귀 0(오히려 개선) |

**`CCG_UNIFIED_STORE` 기본값 전환: 아직 불가 — 남은 전제 1건.** 상세 §4.

---

## 1. 엔진 — `crates/ccg-engine`

### 1.1 전체 재현

```
cargo test -p ccg-engine --offline
  lib 13 · frame_coverage 5 · identity_golden 11 · replay 27 · replay_standing 36 · zz_coverage_gate 5
  = 97 green · 0 red · 0 warning   (live_smoke 2 = #[ignore])
```

게이트가 **실행 실적에서** 뽑아 찍은 값(`--nocapture`):

```
─ 전이 커버리지(실행) ........ 60/60 밟음      ─ 안 밟은 전이 ... []
─ 죽인 병리 커버리지 ......... 15/15           ─ 빈 병리 ....... []
─ 합성 픽스처 의존(실측) ..... 29 (그중 `assumed` 등급 1)
─ 실행된 시나리오 ............ 62
```

보고서 §0의 헤드라인 4개(97 · 60/60 · 15/15 · 29/assumed 1)가 **전부 내 주행에서도 같다.**

### 1.2 C1 반증 재실행 — 게이트가 진짜 붉어지는가 ✅

`replay_standing.rs`의 `s25_spawn_timeout`에서 `#[test]`만 떼고 `S25`는 레지스트리에 남겼다
(크리틱 R1 §2.2와 동일 조작).

```
replay_standing: 35 passed          ← 시나리오 하나 줄었다
zz_coverage_gate: 0 passed · 5 FAILED
  every_registered_scen_actually_ran
    레지스트리에만 있고 **실행되지 않은** 시나리오: ["#25 initialize 20s 무응답 → T3"]
  transition_coverage_is_counted_from_runtime_evidence
    ─ 전이 커버리지(실행) ........ 59/60 밟음    ─ 안 밟은 전이 ["T3"]
    커버리지 후퇴: 59 < 베이스라인 60
  every_registered_scen_has_a_test_fn        ["S25(#25 initialize 20s 무응답 → T3)"]
```

R1에서 같은 조작이 **60/60 · 전체 초록**이었던 자리다. **확인.** 원복 후 md5 일치 확인
(`1d8c2842…`).

**빌더가 안 한 추가 검증 — 순서 공격.** 보고서 §8.1은 *"순서가 어긋나도 거짓 초록은 안 난다"*고
적었다. 깨끗한 전체 런으로 실적을 채운 뒤 뮤테이션을 걸고 **게이트만** 돌렸다:

```
cargo test -p ccg-engine --test zz_coverage_gate     ← 시나리오 바이너리 없이
  5 FAILED · "실적이 하나도 없다 — 시나리오 바이너리를 먼저 돌려야 한다"
  전이 커버리지(실행) 0/60
```

`SRC_FP`(`harness/mod.rs` + `replay.rs` + `replay_standing.rs`의 컴파일 시점 FNV)가 바뀌어 지난
실적이 **전부 무효**가 되고 게이트는 큰 소리로 죽는다. 거짓 초록 경로 없음. **주장 성립.**

### 1.3 뮤테이션 3건 — C2 · C3 · C6 (요청은 2건, 3건 다 했다)

| 함정 | 뮤테이션 | R1에서 죽은 것 | **내 R8 주행** | 판정 |
|---|---|---|---|---|
| **C2 ②** | `SystemInit`의 `observed_model` 기준선 제거 | **없음(86 초록)** | **`s39` 사망** — `left: [] / right: [("haiku","sonnet")]` "★ init 기준선 + 별칭 접기 — 둘 중 하나만 무너져도 이 줄이 깨진다" | ✅ |
| **C3** | `HoldCancel`에 `drain_if_possible()` 되돌리기 | (R1은 이게 정상 동작) | **`s04c` 사망** — `left: ["1","2"] / right: ["1"]` "★ 자동 이어서를 끈 클릭이 전송을 유발하면 안 된다(§7.4 L1)" | ✅ |
| **C6** | T12 가드에서 `&& !interrupted` 제거 | (R1은 가드 자체가 없었다) | **`s38` 사망** — `left: Streaming / right: HeldResult` "★ 중단 뒤에는 T12가 안 돈다 — 여기서 Streaming이면 기계가 사용자를 되살린 것" | ✅ |

셋 다 원복 후 `git status --porcelain crates/` 빈 것 확인.

### 1.4 C3 설계 판정 문서 대조 — 빌더가 맞다 ✅

빌더는 *"설계로 판정했다 — 코드가 틀렸다"*며 `HoldCancel`에서 드레인을 뺐다. `m-logic.md`
문면과 대조했다:

| 근거 | 문면(§ 원문) | 빌더 주장 지지 |
|---|---|---|
| **§7.2** 드레인 게이트 | `if hold.is_some() && !hold.ready: return   # 한도 대기 게이트` | ✅ 대기표는 **큐 게이트**다. 게이트를 내리는 것과 드레인을 부르는 것은 별개 |
| **§7.3** 소진 | *"`ready`가 되면 큐 head에 `origin:'limit_resume'` 항목을 삽입한다 … 그리고 §7.2의 일반 드레인이 돈다"* | ✅ 드레인을 여는 hold 경로는 **`ready` 하나뿐** |
| **§7.4** 되돌리기 | *"`queue.restore(token)` … **드레인은 자동으로 돌지 않는다**(사용자가 다시 보내야 한다 — 되돌리기가 곧 전송이면 위험하다)"* | ✅ 같은 계열의 클릭이 전송을 유발하면 안 된다는 규약이 **명문화**돼 있다 |
| **§7.3** 해제 | *"interrupt/stop_all도 해제한다 — 안 그러면 중지했는데 몇 시간 뒤 혼자 이어서 보낸다"* | ✅ 이 병을 문 하나 옆에서 다시 만들지 말라는 근거 |

**정직하게 남는 것**: §7.3의 "해제" 목록에 **`hold.cancel`이라는 명령 자체가 없다**. 즉 설계는
이 명령에 대해 **침묵**하고, 빌더의 판정은 §7.2+§7.4로부터의 **추론**이다. 추론은 건전하고
문면과 충돌하지 않는다 → **판정 지지**. (설계 문서에 `hold.cancel` 한 줄을 명시로 추가하면
다음 사람이 다시 추론하지 않아도 된다.)

### 1.5 내가 추가로 잰 것 — `s04c`가 증명하는 것보다 성질이 강하다

`s04c`는 60분 무전송을 **`StopAll` 뒤에** 단언한다(=큐가 비어 있다). 그래서 "hold를 꺼도 큐가
가만히 있는가"의 장기 거동은 여전히 안 잠겨 있다. `StopAll` 없이 시간만 밀어 봤다(임시 프로브,
실행 후 삭제):

```
HoldCancel 직후                : sent=["1"]  qlen=2
StopAll 없이 60분 경과          : sent=["1"]  qlen=2      ← 혼자 나가지 않는다
(대조) 사용자가 손수 1건 전송   : sent=["1","2"] → 턴 종료 후 sent=["1","2","3"]  ← FIFO 정상
```

**제품은 옳다** — 오히려 테스트가 약속하는 것보다 강하다. `s04c`의 60분 구간에서 `StopAll`을
빼면 그 성질까지 잠긴다(제안, 이번 라운드 밖).

### 1.6 불일치 2건 (문서 과장 — 제품 결함 아님)

| # | 내용 |
|---|---|
| **R8-M3-a** | 보고서 §8.2·§8.6의 뮤테이션 표에 붙은 *"(+ 게이트)"* 연쇄는 **`--no-fail-fast`일 때만** 일어난다. 기본 `cargo test`는 첫 실패 바이너리에서 멈춰 `zz_coverage_gate`를 **아예 안 돈다**(C2 ② 주행에서 실측: `replay_standing` FAILED 후 게이트 미실행). 표의 괄호를 빼거나 재현 명령에 `--no-fail-fast`를 박아야 문장과 실행이 같아진다 |
| **R8-M3-b** | 실제 뮤테이션을 걸면 `r1_refutation_is_now_caught_l2_static`이 커버리지 메시지가 아니라 **자기 needle 실종 메시지**(*"s25_spawn_timeout 의 `#[test]` 바로 아래 줄 형태가 바뀌었다"*)로 죽고, `…_l1_runtime`도 *"#25가 T3를 밟고 있어야 한다"*로 죽는다. 붉어지긴 하나 **진단이 원인을 가리킨다고 보기 어렵다**(진짜 진단은 다른 두 테스트가 낸다). 소스 텍스트를 대상으로 삼는 자기참조 테스트의 구조적 한계 |

---

## 2. 스토어 — `crates/ccg-store` + 별칭 계층

### 2.1 재현 결과 (전부 내 주행)

| 하네스 | 빌더 R2 주장 | **내 R8 재현** | 판정 |
|---|---|---|---|
| `cargo test -p ccg-store` | 54 | **54 green · 0 red** | ✅ |
| `critic-m2-migrate` | ok:true / 0 | **ok:true · findings 0** | ✅ |
| `critic-m2-damage` | preserved 14 · reported-drop 1 · 조용 0 | **preserved 14 · reported-drop 1 · silent-* 0 · crash 0** | ✅ |
| `critic-m2-kill` | oldDirs ✔ · neverPartial ✔ · tornCommitSeen [] · rerun ✔ | **넷 다 동일.** 추가 관측: `saveKill.tmpLeftovers 0`(R1은 `chat-0150.json.tmp` 1개) | ✅ |
| `critic-m2-semantics` | ok:true / 0 | **ok:true · findings 0** | ✅ |
| `critic-m2-tauri` | findings 1(형상) | 고치기 전 **1** → 하네스 수정 후 **ok:true · 0** | ✅ |
| `critic-m2-api` | findings 1(같은 항목) | 고치기 전 **1** → 하네스 수정 후 **ok:true · 0** | ✅ |
| `poc-chat-unify-migrate --clone-from-real` | PASS | **PASS** (아래) | ✅ |

교체된 눈으로 실홈 복사본 1회:

```
채팅 5(본채팅 1 + 패널 4) · 메시지 333 → 333 · 마이그레이션 (61ms대)
디스크 기준 before: notInIndex 0 · unreadable 0 · missingFiles 0    after: orphanFiles 0 · missingFiles 0
리프 전수 감사 chatsWithLoss 0        정체성 1차 0/5 불일치 · 2차 0/5 불일치 · unresolved 0
멱등: ids ✔ · contentHash ✔          재마이그레이션 clobbered:false · keptV3 5
부팅 재장전: status.json 삭제 후에도 동일(D12)  ·  set-active 디스크 즉시 반영
롤백: 옛 3디렉터리 바이트 동일 ✔ · 스테이징 잔여물 0 · backup-2.6.2-* 존재 ✔
판정: PASS
```

> 메시지 수가 빌더의 316이 아니라 **333**인 것은 사용자가 계속 쓰는 실홈이라 그렇다(R1 크리틱도
> 같은 사유로 312였다). 전·후가 같다는 것이 판정이므로 무해.

### 2.2 D6 — "하네스 형상 결함"이라는 빌더 주장: **내가 독립 확인했고, 맞다** ✅

빌더는 남은 1건이 제품이 아니라 하네스 탓이라 주장했다. 그 주장을 **하네스 밖에서** 3칸으로
재현했다(같은 Electron 바이너리, 같은 암호문, `Local State`만 다르게):

```
[1] 3.0이 쓴 v10 / 시드 없는 프로필              → FAIL "Error while decrypting the ciphertext…"
[2] 같은 암호문   / 설치본 Local State 시드      → OK   sk-ant-critic-m2-0000-TEST-9999
[3] Electron 자신의 v10(시드 프로필 산) / 시드 없음 → FAIL (같은 에러)   ← 형상 증명
3.0 암호문 접두 = "v10" (R1은 01000000 = DPAPI blob)
```

[3]이 결정적이다 — 시드 없는 프로필은 **Electron 자신이 만든 v10조차** 못 푼다. 그 형상으로
재던 것은 제품이 아니라 하네스다. 그리고 에러 문구가 *"does not appear to be encrypted"*(포맷
거부) → *"Error while decrypting"*(키 불일치)로 바뀐 것이 D6 수정의 지표라는 빌더 설명도 맞다.

**하네스를 고쳐 커밋했다**(`docs/critic/tools/`는 크리틱 소유):

- `critic-m2-lib.mjs` — `seedLocalState()`를 **공용으로 승격** + 위 3행 실측을 주석에 박았다
  (§B만 쓰고 §C·§5b가 안 쓰던 비대칭이 재발하지 않게).
- `critic-m2-api.mjs` §C — 시드해서 재고, **대조군 `bareProfile`을 같이 남긴다**(두 갈래가
  구별되게). 설치본 `Local State`가 없으면 "못 읽는다"가 아니라 **판정 보류**로 낸다.
- `critic-m2-tauri.mjs` §5b — 같은 시드 + `scheme` 필드 추가.

수정 후: `tauriToElectron {scheme:'v10', localStateSeededFromInstall:true, electronDecrypts:true,
electronKeyTail:'9999', bareProfile:{decrypts:false}}` · `electronCompat {matches:true}`.

### 2.3 R8-M2-a (추적성) — 보고서가 대는 근거 파일이 그 값을 안 담고 있다

`docs/m2-report-r1.md` §R2.0 표는 R2 수치의 근거로 `docs/critic/m2-r1-{migrate,damage,kill,
semantics,tauri,api}.json`을 지목한다. **HEAD의 그 파일들은 아직 R1 결과다** — 마지막으로
건드린 커밋이 `4f6d33e`(M2 R1 크리틱)이고, 내용도 R1 값이다:

```
m2-r1-damage.json   at=2026-08-22T16:28:46Z  summary={silent-skip:2, silent-drop:4, preserved:7,
                                                       silent-leaf-drop:1, silent-value-flip:1}
m2-r1-migrate.json  at=2026-08-22T16:25:10Z  findings=[{… clobbered:true}]
m2-r1-semantics.json at=2026-08-22T16:36:12Z findings=9
```

즉 `8593244`만 보고는 R2 green을 **확인할 수 없다**. (제품 결함 아님 — 내가 재실행해서 값은 전부
맞다는 것을 확인했다. 다만 "판정은 크리틱 하네스로만 했다"는 커밋 메시지의 신뢰 근거가 레포에
남아 있지 않다.) 다음 라운드는 결과 JSON을 `*-r2.json`처럼 **회차별 파일로** 남기는 편이 낫다.

### 2.4 R8-M2-b (하네스 형상 — 내가 고쳤다) + D8 실앱 확인

`critic-m2-kill.mjs`의 torn-commit 블록은 **고쳐진 지금도 R1과 글자 하나 안 다른 출력**을 낸다:

```
torn-commit: {"isMigratedStillTrue":true, "readBoards":null, "maGetNull":true,
              "lightMarkers":349, "lightWithSnapshot":1, "manualRerunFixesBoards":true}
```

원인 둘:
1. `isMigratedStillTrue`는 Rust `is_migrated()`가 아니라 **`index.json`의 `migratedAt` 키**를
   읽는다. 그 키는 수정과 무관하게 항상 있다.
2. `read-boards`·`alias-ma-get`을 부르는 `ccg-migrate.exe`에는 **`ensure_migrated()` 훅이 없다**
   (그 훅은 `src-tauri/src/ipc/unified.rs:114`에만 있다). CLI로는 앱의 자동 복구를 원리적으로 못 본다.

그리고 보고서 §R2.7이 D8 근거로 든 `tornCommitSeen: []`는 **R1에서도 이미 `[]`였다**(그 필드는
"5개 kill 타이밍에서 찢어진 커밋이 자연발생했는가"라 D8과 무관하다).

**그래서 실앱으로 직접 쟀다**(임시 프로브, 실행 후 삭제. 격리 홈 + 실홈 복사본):

```
1차 부팅  → chats-v3 ✔ · boards/index.json ✔ · migratedAt ✔
찢기      → rm -rf boards/            (rename 둘 사이에서 죽은 상태)
2차 부팅  → boards/index.json 복원 ✔ (파일 3개) · ma.get() = 세션 1 · 패널 6 ·
            메시지 [134, 81, 83, 35] · 로그에 재시도 흔적 ✔
verdict: RECOVERED          (R1 증상이던 "349개가 마커 · ma:get null"이 사라졌다)
```

**D8은 실물에서 닫혔다.** 하네스는 내가 고쳤다 — `markerPresent` / `isMigratedPredicate`
(Rust와 같은 규칙: `migratedAt` ∧ `boards/index.json`) / `appAutoRecovers`(=CLI로는 측정 불가라고
명시)로 셋으로 갈라, 다음 라운드가 이 출력을 "D8 미수정"으로 오독하지 않게 했다. 수정 후 출력:

```
torn-commit: {"markerPresent":true, "isMigratedPredicate":false,        ← 앱이 재시도한다는 뜻
              "appAutoRecovers":"CLI로는 측정 불가 — ensure_migrated() 훅이 없다(실앱 프로브 소관)",
              "manualRerunFixesBoards":true}
```

> **내가 처음에 같은 병을 밟았다**(정직하게 적는다): `isMigratedPredicate`를 재실행 **뒤에** 쟀더니
> `true`가 나왔다 — 재실행이 이미 `boards`를 되세운 뒤였기 때문이다. 재실행 **전에** 재도록
> 고쳤고, 그 이유를 코드 주석에 박았다. 측정 시점이 곧 측정 대상이 되는 자리는 이 하네스에
> 하나가 아닐 수 있다.

### 2.5 R8-1 (차단) — `session-wins:changed`가 영속 추가 채팅을 화면에서 지운다

빌더 스스로 §R2.8에 *"남은 구멍"*으로 적고 **다음 라운드**로 넘긴 항목이다. 위험도가 과소평가돼
있다고 판단해 실측했다.

구조:
- `win.rs:382 broadcast_sessions()` → `session_list()`는 **열린 창만** 싣는다(`:377`에 `"open": true` 고정).
- 반면 `session-wins:list`는 통합 별칭이 가로채 **영속 + 열린 창**을 합쳐 준다(D7 수정).
- 렌더러 `App.tsx:219-220`:
  ```ts
  window.api.sessionWindows.list().then(setSessionWins)
  return window.api.sessionWindows.onChanged(setSessionWins)   // ← 통째 교체(REPLACE)
  ```

실측(합성 홈: 영속 추가 채팅 2 · 열린 창 0 · `CCG_UNIFIED_STORE=1` · 격리 홈):

```
부팅 직후 list()            : ["sc-alpha", "sc-beta"]          ← D7 수정 정상
추가 채팅 창 1개 열기        : changed 페이로드 = ["s-2632-1"]   ← 영속 2개가 빠졌다
그 직후 list()              : ["s-2632-1", "sc-alpha", "sc-beta"]  ← 채널 자체는 옳다
persistedLostInBroadcast    : ["sc-alpha", "sc-beta"]
```

**결과**: 사용자가 추가 채팅 창을 **하나 열거나 닫는 순간** 사이드바에서 마이그레이션된 추가
채팅이 전부 사라지고, 컴포넌트가 다시 마운트해 `list()`를 부를 때까지 안 돌아온다. 2.6.2에서는
보이던 대화다. 크리틱 R1이 D7에 대해 쓴 *"사용자 눈에는 대화 증발과 구분되지 않는다"*가
**다른 문으로 그대로 재발**한다. 게다가 도달 경로가 엣지 케이스가 아니라 **평범한 클릭 하나**다.

→ 그래서 이것은 "다음 라운드 후속"이 아니라 **기본값 전환의 전제**다(§4).

제안(개념):
```rust
// win.rs — 브로드캐스트도 list와 같은 원천을 쓴다(별칭이 켜져 있으면 영속과 합친다)
pub fn broadcast_sessions(app: &AppHandle) {
    let _ = app.emit_to(MAIN, ch::SESSION_WINS_CHANGED, crate::ipc::unified::session_list_merged());
}
```
`unified.rs`에 이미 `list` 별칭이 쓰는 병합 함수가 있으므로 새 자료구조는 필요 없다.
(대안: 렌더러가 `onChanged`를 REPLACE로 안 쓰고 `open` 플래그만 갱신 — 다만 진실을 셸에
두는 3.0 규약과 어긋난다.)

---

## 3. 유리 — `src-tauri/src/glass.rs` + 렌더러 폴백

빌드: `npm run tauri:build` → `Finished release in 58.18s` · `target/release/agentcodegui.exe`
4,142,080 B (03:25). 잠금 없음(실행 중인 `AgentCodeGUI.exe`는 전부 설치본 경로).

### 3.1 폴백 4경로 — 전부 도달 ✅

격리 홈 `.r8-home` · `CCG_GLASS_FORCE_OFF=1` · CDP 9333 · 내가 스폰한 PID 9148.

| # | 경로 | R1(고치기 전) | **내 R8 실측** |
|---|---|---|---|
| 1 | 부팅 창 | `ccg-glass-off` · events 3 | `cls=ccg-glass-off` · `style=true` · `--panel #1d1d1d` · `ev 15` |
| 2 | `location.reload()` 후 | **클래스 없음 · `rgba(21,21,21,.7)` · events 0** | `ccg-glass-off` · `#1d1d1d` · **`prev {ok:false}`** · `ev 12` |
| 3 | 부팅 뒤 연 추가 채팅 창 | **클래스 없음 · events 0** | `ccg-glass-off` · `#1d1d1d` · `ev 9` |
| 4a | 크래시 복구 `reload_all`(renderer 18552 kill) | 미측정 | 메인 `ccg-glass-off`·`#1d1d1d`·`ev 17` / 추가 채팅 창 `ccg-glass-off`·`#1d1d1d`·`ev 17` |
| 4b | 크래시 복구 `recreate_windows`(browser 31428 kill) | 미측정 | 메인 `ccg-glass-off`·`#1d1d1d`·`ev 18` / 추가 채팅 창 `ccg-glass-off`·`#1d1d1d`·`ev 18` |

**R1의 실패 모드(`__ccgGlass.events === 0` · 클래스 없음)가 네 경로 어디에도 없다.** 죽인 PID는
전부 내 트리(9148) 안에서 `procTreeMem(..., {role:true})`로 역할을 확인한 뒤 단독 지정했다.

### 3.2 기본값 반전 — 첫 프레임 실측

`scripts/poc-glass/poc-glass-flash.mjs` · 격리 홈 `.r8-home2` · CDP 9334 · **FORCE_OFF 없음**(정상 유리).

| 경우 | 문서(빌더 R2) | **내 R8** | 판정 |
|---|---|---|---|
| A 정상(부팅) | tOn 6.2 → tOff 6.3 · **0.1ms** · firstRaf 27.6 | tOn 6.5 → tOff 6.6 · **0.1ms** · firstRaf 25.7 | ✅ `tOff < firstRaf` → **불투명 프레임 0장** |
| C 정상(재로드) | 6.5 → 6.6 · **0.1ms** · firstRaf 27.4 | 11.0 → 11.1 · **0.1ms** · firstRaf 27.4 | ✅ **0장** |
| B 최악 · 메인 창 | onAt 11.9 → offAt 52.5 · **40.6ms** · firstRaf 33.3 | 8.8 → 62.6 · **53.8ms** · firstRaf 33.2 (2회차 8.5 → 54.6 · 46.1ms) | ⚠️ 같은 체제, 값은 13~33% 높음 |
| D 최악 · 추가 채팅 창 | 7.3 → 194.4 · **187.1ms** · firstRaf 19.4 | 8.1 → 194.5 · **186.4ms** · firstRaf 21.1 | ✅ 사실상 일치 |

A·C·D **확인**. B는 §3.3 참조.

### 3.3 B의 유일한 완화 근거를 내가 처음 실측했다 — 성립 ✅

문서는 B에서 프레임이 난다는 것을 인정하면서 *"스플래시 오버레이(불투명 #151515)가 그 구간을
덮는다"*로 완화를 주장한다. 그런데 표에 실린 `__ccgSplashPaintAt`는 **rAF 2회 뒤에 찍히는 진단
표식**(`splash.js:108,141-142`)이라 "오버레이가 언제 DOM에 붙었나"가 아니다 — 내 1회차 주행에서는
`splashPaintAt(64) > offAt(62.6)`이라 **표식만 보면 완화가 성립하지 않는다.**

그래서 document-start MutationObserver로 **오버레이가 붙은 시각과 그때의 계산 스타일**을 직접 쟀다:

```
onAt      = 8.5ms         (폴백 클래스 걸림)
splashAt  = 8.9ms         bg=rgb(21,21,21)  opacity=1     ← 폴백 0.4ms 뒤에 이미 붙어 있다
firstRaf  = 31.0ms        그 시점 오버레이 = {bg:rgb(21,21,21), op:1, pos:fixed,
                                            z:2147483647, w:1320, h:880}   ← 전체 뷰포트
offAt     = 54.6ms        (불투명 구간 46.1ms)
```

**합성된 모든 프레임에서 불투명 전체화면 오버레이가 위에 있다.** 완화 주장은 참이다.
(다만 문서가 근거로 `__ccgSplashPaintAt`를 쓰면 안 된다 — 그 표식은 오버레이 설치 시각보다
한참 늦다. `splashAt`류의 값을 싣는 편이 정직하다.)

### 3.4 knock 8/8 ✅

`glass.ps1 -Action knock -TargetPid 34304 -Backdrop 1 -Seconds 8 -IntervalMs 25` (내가 스폰한 PID).

| 경로 | 문서(R2) | **내 R8** |
|---|---|---|
| 조용한 드리프트(폴링만) | 8/8 · 309.8ms(219~372) / 표 359ms | **8/8 · avg 321.9ms · min 282 · max 441** |
| 메시지 경로(`-Nudge`) | 8/8 · 74.6ms(62~102) / 표 72ms | **8/8 · avg 72.8ms · min 61 · max 92** |

둘 다 `recovered: 8/8`, `readBackAfterKnock: 1`(걷어차기가 실제로 먹었다는 대조). 넛지는 자릿수까지
일치, 폴링은 같은 체제 안. `-IntervalMs 25`가 필수라는 문서 경고도 그대로 유효하다.

### 3.5 멀티 게이트 1회 — 회귀 0 ✅

`node bench/multi.mjs tauri --repeats=1` (arm=`default`, panels 4).

| 지표 | R1 크리틱 | R2 빌더 | **R8 나** |
|---|---|---|---|
| idleGrid WS MB | 426.8 | 421.7 | **418.6** |
| idleGrid Priv MB | 241.6 | 238.4 | **237.0** |
| idleGrid procs | 5 | 5 | **5** |
| idleWithWindows WS MB | 473.7 | 469.5 | **468.0** |
| idleWithWindows Priv MB | 250.8 | 248.3 | **247.4** |
| wsMB/window | 23.4 | 23.9 | **24.7** |
| procsAdded | 0 | 0 | **0** |
| scrollInPanel avgFps / p95 / drop% | 57.7 / 22.6 / 0 | 56.8 / 22.3 / 0 | **59.1 / 19.1 / 0** |
| scrollAllPanels avgFps / p95 | 59.4 / 17.4 | 59.4 / 17.0 | **59.6 / 17.8** |

**회귀 없음** — 메모리 전 지표가 오히려 낮고 스크롤도 같거나 낫다.
기준 파일 복원: 하네스가 쓴 것은 `bench/results/multi-tauri-3.0.0-default.json`(추적 대상)이라
`git checkout`으로 복원했고, 미추적 기준 `bench/results/multi-tauri-3.0.0.json`은 **건드리지
않았다**(백업과 diff 일치 확인).

---

## 4. `CCG_UNIFIED_STORE` 기본값 전환 — 가/불가

크리틱 R1 §6이 세운 **기본값 ON 게이트** 7칸을 내 재현값으로 채점한다.

| 게이트 | 상태 | 내 근거 |
|---|---|---|
| □ D1 별칭 저자 에코 판별 | ✅ | `critic-m2-semantics` findings 0 · `cargo test` `a_stale_renderer_copy_cannot_revert_the_runtime_identity` + 역방향 `a_real_picker_edit_still_lands` |
| □ D2 prune 안전판 | ✅ | semantics findings 0 · damage 2번 `preserved` · 손상 index 뒤 저장에도 파일 생존 |
| □ D3 재마이그레이션 보존 | ✅ | migrate findings 0 · poc `clobbered:false · keptV3 5` |
| □ D6 v10 쓰기 | ✅ | 독립 3칸 프로브 — 시드 프로필에서 평문 복호 성공 |
| □ **session-wins 별칭 + 추가 채팅 도달성** | ❌ **미달** | `list` ✔(`reachableInUi: 2`) 이지만 **`changed`가 영속 2건을 지운다**(R8-1 실측) |
| □ D12 status 회귀 복구 | ✅ | poc `bootReload.afterStatusJsonDeleted == withFile` · damage/E2 재현 |
| □ 위 전부를 잠그는 `cargo test` | ✅ | 13 → **54** green, 핵심 4모듈 커버 |

### 판정: **아직 불가 — 남은 전제 1건**

> **전제(필수)**: `session-wins:changed` 브로드캐스트가 `session-wins:list`와 **같은 원천**을
> 싣도록 고칠 것(`win.rs broadcast_sessions`). 지금 상태로 기본값을 켜면 추가 채팅 창을
> **한 번 열거나 닫는 것만으로** 마이그레이션된 추가 채팅이 사이드바에서 사라진다 —
> D7 게이트 항목이 막으려던 바로 그 증상이고, 도달 경로가 엣지가 아니라 평범한 클릭이다.
> 빌더는 이것을 "다음 라운드"로 분류했는데, **게이트 항목의 절반만 닫힌 상태**로 보는 것이 옳다.

그 한 줄이 닫히면 나머지 6칸은 내 독립 재현으로 전부 확인됐으므로 **전환 가능**하다.

### 전환 **후속**(전제가 아님 — 판정 근거 명시)

| # | 항목 | 왜 전제가 아닌가 |
|---|---|---|
| **D15** 종료 flush 미배선 | `status::flush()` 호출부는 `ccg_migrate.rs` 하나뿐이지만, **`status::set` 호출부가 레포 전체에 0개**다(내가 grep 확인). 비울 것이 없으므로 지금은 무해. `status::set`이 처음 불리는 라운드에 **같이** 배선하면 된다 |
| **D17** 두 크레이트의 `api_key` 바이트 모양 차이 | `ccg-engine`이 아직 스토어에 **배선돼 있지 않다**(M3 보고 §1 8단계 = 범위 밖). 플래그와 무관. 단 **M3 배선 라운드의 전제**다 — `to_raw()` 저장이 시작되는 순간 1차 비교가 거짓 불일치를 낸다 |
| 1000단 중첩 원본 보존 | `reported-drop` + `quarantine/` + 옛 3디렉터리 + `backup-2.6.2-*` = 복구 경로 3개, 조용하지 않음. 크래시 0 우선이라는 빌더 판단에 동의 |
| `origin` 폐기(별칭이 넘겨준 id 집합으로) | 현재 기본값 `unknown`으로 구멍 둘 다 닫혔다. 정리 작업 |

---

## 5. 결함 목록 (이번 라운드 신규)

| # | 심각도 | 결함 | 근거 |
|---|---|---|---|
| **R8-1** | **높음(전환 차단)** | `session-wins:changed`가 열린 창만 실어, 브로드캐스트 한 번에 영속 추가 채팅이 UI에서 사라진다. 렌더러는 REPLACE로 받는다 | §2.5 실측 |
| **R8-M2-a** | 중 | 보고서 §R2.0이 대는 근거 파일 6개가 **R1 값**을 담고 있다 — 커밋만으로 R2 green 확인 불가 | §2.3 |
| **R8-M2-b** | 중 | `critic-m2-kill`의 torn-commit 블록이 Rust 술어가 아니라 JSON 키를 읽고, CLI에 `ensure_migrated` 훅이 없어 **고쳐져도 R1과 같은 출력**. 보고서가 D8 근거로 든 `tornCommitSeen: []`는 R1에서도 `[]`였다 | §2.4 — **내가 하네스를 고쳤다** |
| **R8-M3-a** | 하 | §8.2·§8.6의 *"(+ 게이트)"* 연쇄는 `--no-fail-fast`에서만 일어난다 | §1.6 |
| **R8-M3-b** | 하 | `r1_refutation_is_now_caught_l2_static`/`…_l1_runtime`이 실제 뮤테이션에서 **자기 needle 실종 메시지**로 죽는다(붉어지긴 함) | §1.6 |
| **R8-UI-a** | 하 | ui-glass.md 첫 프레임 표의 B가 `__ccgSplashPaintAt`(rAF 2회 뒤 진단 표식)에 기대면 완화가 증명되지 않는다. 실제 근거는 오버레이 설치 시각(8.9ms)이다. B 값 40.6ms도 1회 주행값(내 2회 = 53.8 / 46.1) | §3.3 |

---

## 6. 가장 큰 격차 하나

> **세 빌더 중 둘은 "고쳤다"를 증명했고, 하나는 "고쳤다"의 경계를 넘겼다.**

M3는 크리틱의 반증 조작을 **테스트로 박아** 다음 라운드가 같은 구멍을 다시 열 수 없게 했고,
M-UI는 자기 완화 주장을 실측 표로 냈다(다만 근거 표식을 잘못 골랐다). 두 갈래 모두 내가 조작을
직접 가했을 때 **정확히 지정된 테스트가 죽었다** — 이건 진짜 잠금이다.

M2도 제품 수정 자체는 12건 전부 재현됐다. 문제는 **판정의 경계**다. D8은 하네스가 원리적으로 볼
수 없는 자리를 근거로 삼았고(§2.4), D7은 조회만 닫고 **통지를 다음 라운드로 넘기면서 게이트
항목에는 ✔를 남겼다**(§2.5). 둘 다 "고친 방향은 맞는데, 고쳤다고 말하는 근거가 그 사실을 못
본다"는 같은 형태다 — 공교롭게도 M3 크리틱 R1이 §10에서 지목한 격차(*"선언·이름·주석은 그렇게
말하는데 기계는 확인하지 않는다"*)와 **같은 병**이 스토어 쪽에 남아 있다.

M3는 게이트 입력을 실적으로 바꿔 그 병을 구조적으로 닫았다. M2에도 같은 처방이 필요하다:
**하네스가 무엇을 못 보는지를 하네스가 스스로 적게 하는 것**(내가 `appAutoRecovers: 'CLI로는
측정 불가'`를 심은 이유다). 그리고 게이트 항목의 ✔는 **사용자 동선 한 번**으로 검증해야 한다 —
R8-1은 클릭 하나에 드러났다.

---

## 7. 재현

```bash
# 엔진
cargo test -p ccg-engine --offline                                     # 97 green
cargo test -p ccg-engine --offline --test zz_coverage_gate -- --nocapture
#  C1 반증: replay_standing.rs의 s25_spawn_timeout에서 #[test] 제거 → 게이트 5/5 RED (원복)
#  뮤테이션(전부 --no-fail-fast로): runtime.rs SystemInit 기준선 제거→s39 /
#    HoldCancel에 drain_if_possible() 복원→s04c / T12 가드 !interrupted 제거→s38

# 스토어
cargo build -p ccg-store --features cli --offline
cargo test  -p ccg-store --offline                                     # 54 green
node docs/critic/tools/critic-m2-{migrate,damage,kill,semantics,tauri,api}.mjs
node scripts/poc-chat-unify-migrate.mjs --clone-from-real
#  ※ m2-r1-*.json 6개는 실행이 덮는다 — 확인 후 git checkout 으로 복원할 것

# 유리 (사용자 실앱은 설치본이라 target/release 잠금 없음을 먼저 확인)
npm run tauri:build
powershell -NoProfile -File docs/critic/tools/mui-spawn.ps1 -HomeDir .r8-home -ForceOff 1 \
  -CdpPort 9333 -PidFile docs/critic/tools/.r8-pid
bash scripts/poc-glass/poc-glass-paths.sh 9333 "R8-FORCE-OFF"          # 경로 1~3
#  경로 4: procTreeMem(<내 PID>,{role:true})로 renderer / browser 를 찾아 그 PID만 taskkill
powershell -NoProfile -File docs/critic/tools/mui-spawn.ps1 -HomeDir .r8-home2 -CdpPort 9334 \
  -PidFile docs/critic/tools/.r8-pid2
node scripts/poc-glass/poc-glass-flash.mjs 9334
powershell -NoProfile -File scripts/poc-glass/glass.ps1 -Action knock -TargetPid <PID> \
  -Backdrop 1 -Seconds 8 -IntervalMs 25 [-Nudge]
node bench/multi.mjs tauri --repeats=1
#  ※ bench/results/multi-tauri-3.0.0-default.json 은 추적 대상 — git checkout 으로 복원
```

**임시 프로브 4종은 실행 후 삭제했다**(레포에 안 남긴다): safeStorage 3칸 · 찢어진 커밋 실앱
복구 · 스플래시 덮기 · session-wins 브로드캐스트. 각 프로브가 무엇을 어떻게 쟀는지는 §2.2·§2.4·
§3.3·§2.5의 코드 블록에 값과 함께 적어 뒀다.
