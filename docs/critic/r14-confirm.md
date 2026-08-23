# R14 확인 크리틱 — 렌더러 R2·R3(`ec52c6e`·`c9a2396`) · 배선 R3·R4(`bdabd18`·`5446800`)

**임무**: 네 커밋의 "됐다"를 **빌더 실행을 믿지 않고 독립 재실행**해 확인/불일치를 가르고,
두 라운드가 남긴 「남은 것」 목록이 코드와 맞는지 대조한다(빠진 항목 사냥).
빌더의 산출 JSON은 증거로 안 썼다 — 하네스를 내가 다시 돌려 나온 값만 적는다.

---

## 0. 판정

| 갈래 | 판정 |
|---|---|
| **렌더러 R2·R3**(`ec52c6e`·`c9a2396`) | **확인.** `poc-dial` **43검사 PASS·결함 0**(큐 7·앵커 6·own 9 포함), `critic-mux-attack` **11단계 중 10 green**. 커밋이 X로 신고한 `raise.scroll` 하나만 빨강이고 수치까지 표와 일치(3106→2517 · h 6962→5335). **재현 불일치 0건.** |
| **배선 R3·R4**(`bdabd18`·`5446800`) | **확인.** `ccg-engine 118+2ignored` · `ccg-store 62` · `src-tauri 19` · `poc-live-chat` **8단계 44검사 PASS·결함 0** · `critic-wiring-live A~F` **green(E 1차)** · 이중 전송 재생 **4/4** · 렌더러 `own.auto-fired {spawns:1}`. 귀속 표 방향도 재현(`noglue` Rust Priv **−0.5** · Rust 절대값 **32.4/13.5** · 총합 **434/251**). **재현 불일치 0건.** |

**그러나 재현이 곧 안전은 아니다.** 새 발견 6건은 §4·§5. 값어치 순:

- **F1·F2(치명)** — "재개의 주인을 하나로" 한 그 하나가 **2.6.2보다 관대한 판정자**이고,
  **리셋 시각을 안 읽고 신선 usage 재검증도 안 한다.** 실측: 2.6.2 코퍼스 18종에서 오탐 3건,
  그리고 한도가 안 풀린 상태에서 **30분에 4회** 헛 재개(5시간 창이면 ~46회).
  더 엄격한 렌더러 기계는 이번 라운드가 껐다.
- **F3(높음)** — 되올림 앵커가 **정착 뒤 365px 어긋난다(3/3 결정적)**. poc-dial의 저울이
  `__ccgLandings()`(착지 **기록**)를 읽어 구조적으로 못 본다.
- **F4(높음)** — 채팅 폴더가 사라지면 전송이 **영원히 침묵 정지**한다(40초 실측, 오류 0건).
  사유는 `chat:verdict`로 나가는데 구독자가 **0**이다. 두 목록 어디에도 없다.

---

## 1. 측정 조건

빌더 셋이 동시 작업 중이라 **착수 시점 HEAD를 핀**으로 박고 그 스냅샷만 썼다.

- 핀: **`c9a2396`**(= 판정 대상 4커밋을 모두 담은 조상). 주행 중 메인이 `38098f2`로 갔으나
  **pull하지 않았다.** `git diff c9a2396..38098f2 -- src-tauri crates app scripts bench` = **빈 diff**
  (진행 페이지 문서뿐). 즉 내가 잰 바이너리는 판정 대상과 **코드 동일**하다.
- 메인 워킹트리에는 지금 **다른 라운드(M6·ccg-fs)의 미커밋 편집 10파일**이 떠 있다.
  거기서 빌드하면 판정 대상이 아닌 코드를 재게 된다 — 워크트리를 판 첫 번째 이유다.
- 격리 워크트리: `%TEMP%/ccg-r14-wt`(detached `c9a2396`) + `node_modules` 정션.
  **모든 하네스를 이 워크트리에서 돌렸다** — 하네스가 `REPO`를 자기 위치로 푸는 덕에
  격리 홈·CDP 산출물·`docs/critic/*.json`·`bench/results/*`가 전부 워크트리 안에 떨어진다
  (**메인 레포 수정 0건**, 원복 불필요).
- 빌드: `CARGO_TARGET_DIR=%TEMP%/ccg-r14-tgt npm run tauri:build` → **4,856,320 B**, 2m09s.
  + `ccg-fakecli`(release). 공용 `target/`을 안 써서 exe 잠금·경합을 회피했다.
- `poc-live-chat`은 `--tag=r14`로 돌렸다(격리 홈·포트·산출물 분리). 다른 라운드가 같은 순간
  기본 포트 9361~9366을 쓰면 내 실패가 제품 탓으로 오독된다.

### 안전 장부

| 항목 | 결과 |
|---|---|
| 사용자 실앱(Electron 2.6.2) | 시작·종료 시 **동일한 6 PID**(6644·9840·12924·23792·24836·26924), 시작 시각도 동일. 건드림 0 |
| 이름 기반 kill | **0회.** 하네스가 죽인 것은 자기가 spawn한 PID 트리뿐(`killTree`) |
| 실홈 | 읽기/복사만. `accounts.json`은 **내 첫 부팅(11:27) 전인 11:24**에 이미 바뀌어 있었고(실앱의 토큰 갱신), 주행 내내 mtime 불변. `codex-accounts.json` md5 `695516d1…` — R12 기록과 **동일** |
| 격리 홈 잔존 | **0**(워크트리 안 `.critic-home-*`·`.poc-home-*`·`.bench-home-attrib-*` 전부 회수) |
| 메인 레포 | 이 보고서 한 장 외 **수정 0**. 다른 라운드의 미커밋 10파일은 손대지 않았다 |
| 돈 | 실 CLI 턴: poc-dial(queue 3턴·own 1턴) · mux-attack(mid·foldrun×2) · wiring-live(A~F) · poc-live-chat(live 1턴). 나머지는 가짜 CLI·합성($0) |

---

## 2. 렌더러 재현

### 2.1 `poc-dial` 전체 — **43검사 PASS · 결함 0**

```
[dial] 14   [active] 2   [raise] 6   [own] 9   [bg] 5   [queue] 7      = 43
```

커밋이 내세운 세 축이 전부 그대로 나왔다.

**큐 소유권(7)** — 떠난 사이 예약이 남의 대화로 안 나간다:

```
queue.enqueue ["QOWNER-ALPHA","QOWNER-BETA"] · queue.park · queue.restore(firedAway [])
queue.no-misroute · queue.fired-home {"i1":1,"i2":2} · queue.drained · queue.answered {"ai":3}
```

**앵커 3케이스(6)** — 커밋 표의 값이 그대로 재현된다:

```
raise.anchor-saved     {"fix-multi-session::2":{"id":"p2a14","off":-162.8}}
raise.anchor-land      {"id":"p2a14","want":-163,"got":-162}
raise.same-pixel       {"dTop":0,"beforeTop":3148,"afterTop":3148,"sameW":true,"sameCh":true}
raise.anchor-land-n1   {"id":"p0tg15","want":30,"got":30,
                        "delta":{"dTop":580,"dOff":0,
                          "geom":{"before":{"h":6687,"ch":320,"w":341,"zoom":0.8},
                                  "after":{"h":5335,"ch":752,"w":1078,"zoom":1}}}}
raise.thread-n1 {"msgs":20} · raise.bottom-stays-bottom {"top":3924,"h":4676,"ch":752}
```

> 이 여섯 개는 **재현됐다.** 다만 `raise.anchor-land-n1`이 무엇을 재는지는 §5-F3에서 가른다 —
> 그 초록은 *착지 기록*이고, 정착 뒤 화면은 다른 값이다.

**resumeOwner 상호배제(9)** — 자동 이어서를 켠 채 합성 대기표를 심어도 발화는 한 번:

```
own.signal          {"c-hide":{"resumeOwner":"engine","autoResume":true,"hold":{…,"ready":false}},
                     "c-see": {"resumeOwner":"engine","autoResume":true,"hold":{…,"ready":false}}}
own.bar-managed     {"sub":"약 1분 뒤 자동으로 이어서 계속해요","x":0,"go":0}
own.ready-pill      ["POC 화면 밖 채팅"]
own.offscreen-silent {"id":"c-hide","spawns":0,"hold":{"ready":true,"dueAt":90000},"auto":false,"queued":1}
own.auto-fired      {"spawns":1}          ← 둘이 살아 있었으면 2다
own.press-resume    {"id":"c-hide","spawns":1,"hold":null,"auto":true}
own.win-chip / own.win-close-only(대화 3개 잔존) / own.win-recreate
```

### 2.2 `critic-mux-attack` 11단계 — **10 green**

1차 주행에서 빨강 3개(`foldrun.chip` · `foldrun.sidebadge` · `raise.scroll`).
`foldrun` 둘은 **하네스 흔들림**이고 커밋의 §R3.10이 미리 신고한 그 얼굴이다 — 증거는
하네스가 남긴 자기 값이다:

```
1차: panelLenBeforeFold = 725   (하네스가 기다린 축은 >900 — 접을 때 이미 턴이 끝나 있었다)
2차: panelLenBeforeFold = 948   → foldrun.chip "접힌 자리 실행 1" · foldrun.sidebadge {dot:"run"} green
```

남은 하나가 `raise.scroll`이고, **커밋 표의 수치와 3px 안에서 일치**한다:

| | 커밋 §R3.2 | 내 실측 |
|---|---|---|
| before | `top 3103 · h 6962 · len 2073` | `top 3106 · h 6962 · len 2073` |
| after | `top 2514 · h 5335 · len 2291` | `top 2517 · h 5335 · len 2291` |

### 2.3 "세 갈래 저울" 주장 — **전제 오류 주장은 옳다**(내 판단)

커밋은 *"검사식 `|after.top − before.top| < 40`은 접기 전후 자리 크기가 같다는 전제를 담고
있어 앵커 복원과 동시에 참일 수 없다"*고 했다. 하네스 소스와 내 프로브로 가른다.

- 소스(`critic-mux-attack.mjs:787·791`↔`:812`, 판정은 `:818`): `before`는 **6분할 3번 칸**에서,
  `after`는 **n1 1번 칸**에서 `t.scrollTop`을 잰다. 두 값을 40px로 비교하려면 두 스크롤러의
  레이아웃이 같아야 한다.
- 내 프로브(`.r14-raise.mjs`, 하네스와 **같은 픽스처·같은 파라미터**)가 그 전제를 직접 쟀다:

```
sameScroller true(둘 다 .ma-p-thread scroll)   ← 하네스가 엉뚱한 요소를 잡은 것이 아니다
sameGeometry {sameW:false, sameCh:false, sameH:false, sameZoom:false}
   before w 417 · ch 320 · h 6962 · zoom .8      after w 1067 · ch 752 · h 5335 · zoom 1
```

콘텐츠 높이가 6962→5335로 바뀌므로 **비율 보존(0.35×5335 = 1867)도, 문단 보존(2514)도**
`3103 ± 40`에 들어갈 수 없다. 통과하는 유일한 값은 **픽셀을 그대로 꽂는 것**이고 그건 다른
문단이다. **주장 인정** — 검사식은 이 시나리오에서 참이 될 수 없다.

> 다만 **"그러니 앵커는 옳다"로는 안 넘어간다.** 검사식이 틀렸다는 것과 대체 저울이 옳은
> 것을 재고 있다는 것은 다른 문장이다. 후자는 §5-F3에서 무너진다.

---

## 3. 배선 재현

### 3.1 게이트

| 커밋 주장 | 내 실측 |
|---|---|
| `ccg-engine` 118 green (+2 ignored) | **118 passed / 0 failed / 2 ignored**(34+5+11+0+27+36+5) |
| `ccg-store` 62 green | **62 passed / 0 failed** |
| `src-tauri` 19 green | **19 passed / 0 failed** |
| `poc-live-chat` 8단계 PASS·결함 0 | **PASS · 44검사 · 결함 0** (r81 1 · dialog 4 · winsave 7 · events 12 · error 1 · reload 4 · slots 6 · live 9) |
| `critic-wiring-live` A~F green | **A~F 전부 green**(E는 1차에 붙었다 — R12가 3회 중 1회 실패했던 그 축) |

### 3.2 이중 전송 잠금 — 재생 4건 + 렌더러 1건

```
ccg-engine  a_message_parked_during_the_hold_is_the_resume_no_second_turn   ok
            resume_now_with_a_parked_message_sends_that_message_once        ok
            a_queue_that_predates_the_hold_still_gets_the_nudge             ok
tests/replay s04_queue_plus_limit_hold_resume                               ok
poc-dial     own.auto-fired {"spawns":1}
```

**4/4 + 1/1 재현.** 셋을 걸었다는 주장(`armed_at` 경계 · busy 상승 에지 자기 해제 ·
`resumeOwner` 신호)도 소스에서 확인했다(`queue.rs:114-128` · `runtime.rs:522-548` ·
`lite.rs:80-89` · `useLimitResume.ts:73,138,165,175,188`).

### 3.3 부팅 재장전 · 창 자리 (`reload` · `slots`)

```
B1-재장전   c-hide{queued 1, hold ready:false, auto:false, spawns 0}   ← 재장전은 전송이 아니다
            c-see {queued 1, hold ready:false, auto:true,  spawns 0}
B2-이어서   {spawns:1, dom:true}
B3-화면밖은 대기 {id:"c-hide", hold.ready:true, auto:false, spawns:0}   ← 스펙 ⑤ 기본값
B4-눌러서 이어가기 {id:"c-hide", spawns:1, hold:null, auto:true}
S1-list [] · S2-open · S3-chat:windows · S5-close(창만, msgs 2 잔존) · S6-focus 되만들기 · S7-중복없음
```

### 3.4 귀속 표 — **방향 재현**(`--arm=noglue,nofs --pairs=2`, 8회 부팅)

```
[noglue#1] base   total 435.4/251.0 · rust 32.3/13.3 · rend 185.3/131.9
[noglue#1] noglue total 433.9/251.2 · rust 32.3/13.4 · rend 185.7/133.3
[noglue#2] noglue total 435.6/252.1 · rust 32.7/14.7 · rend 184.4/130.9
[noglue#2] base   total 430.7/247.9 · rust 32.7/13.8 · rend 181.9/129.4
[nofs#1]   base   total 434.1/251.4 · rust 32.5/13.5 · rend 185.4/132.3
[nofs#1]   nofs   total 433.9/251.4 · rust 32.9/13.9 · rend 185.3/133.0
[nofs#2]   nofs   total 434.0/250.5 · rust 32.8/13.7 · rend 185.3/131.1
[nofs#2]   base   total 436.0/253.2 · rust 32.3/13.7 · rend 187.1/133.6

쌍별 Δ 중앙값:  noglue  rustPriv −0.5  totalPriv −2.2   (R4: −0.6 / −1.8)
                nofs    rustPriv −0.2  totalPriv +1.35  (R4: −0.1 / +3.1)
```

| | R4 주장 | 내 실측(2쌍 중앙값) |
|---|---|---|
| Rust 절대값 | 32.6 / **13.6** | **32.4 / 13.5** |
| 렌더러 | 189.8 / 136.6 | 185.3 / 132.1 |
| 총합 | 439.3 / 254.9 | 434.0 / 251.3 |
| 엔진 글루를 통째로 껐을 때 Rust Priv | −0.6 | **−0.5** |

**표의 방향은 그대로다**: 엔진 글루 ≈ 0, Rust 상주분은 총합 251의 **5.4%**뿐이고,
움직이는 질량은 렌더러 + WebView2다. 절대값이 R4보다 3~4MB 낮은 것은 R4가 §R4.2-5에
적은 그 분산 안이다(같은 바이너리 234~257).

> 곁다리: `noglue` 팔의 `flags`가 **null**이다. `engine::boot()`이 그 팔에서 곧장 return하므로
> 증거를 내는 `engine:debug` 자체가 없다. R4는 *"`flags`는 이 주행이 정말 그 팔이었나의
> 유일한 증거"*라고 적었는데, **가장 중요한 팔에서 그 증거가 없다**(허브가 죽은 것으로
> 간접 확인은 된다). 다음 라운드가 이 팔을 다시 쓸 거면 `flags`를 부팅 전에 한 번 찍어 두는 편이 싸다.

---

## 4. 「남은 것」 목록 대조 — 코드로

### 4.1 렌더러 §R3.9 — **1~6 전부 정확**

| # | 항목 | 대조 |
|---|---|---|
| 1 | `saveAttachmentData` 미배선 | ✅ `src-tauri`에 핸들러 0(주석만 `win.rs:164`). `IPC` 상수·Electron main·shim 폴백만 존재 |
| 2 | `ccg-page` 미구현 | ✅ `ipc/mod.rs:123`이 스스로 인정. `src-tauri`에 스킴 등록 없음 |
| 3 | `cancel-hold` op 없음 | ✅ `hub.rs:522-544`의 op = `restore/remove/reorder/clear`(+`enqueue`·`resume`는 `mod.rs:394,400`). 취소 없음 |
| 4 | `resumeOwner`/`autoResume`가 계약면에 없음 | ✅ `src/shared/protocol.ts:1359-1372` `ChatStatusLite`에 두 필드 없음 |
| 5 | 추가 채팅 창·멀티 패널이 `managed`를 안 봄 | ✅ `managed`를 넘기는 곳은 `App.tsx:598` **한 곳**. `MultiAgent.tsx:1945-1950`(6슬롯)·`PanelWindow.tsx:289`·`SessionWindow.tsx:648`은 안 넘긴다 |
| 6 | 앵커는 패널에만 | ✅ `useThreadAnchor` 호출은 `MultiAgent`·`PanelWindow`뿐 |

### 4.2 배선 §R4.9 「렌더러 몫」 — **5건 중 4건이 이미 닫혔다(stale)**

배선 R4는 **10:47**, 렌더러 R3은 **11:21**에 커밋됐다. 표는 그 34분을 모른다.

| # | R4가 "열림"으로 적은 것 | 지금 |
|---|---|---|
| R6 | 구독 직후 `chat:status` 당겨 오기 | **닫힘** — 렌더러 R3 ③(`sub(onReady)` · `updatedAt` 병합) |
| R7 | `win:chat-*`·`chat:windows`를 쓰는 화면 | **닫힘** — 렌더러 R3 ④(창 칩·「창 닫기」 메뉴·되만들기) |
| R8 | `ready` 대기표를 눌러 이어가는 UI | **닫힘** — 렌더러 R3 ⑤(`resumeHold`, `unified.ts:152`) |
| R9 | `chat:queue-mutate`로 예약을 옮기기 | **열림**(정확) — `app/src`에 `chat:queue` 구독 **0** |
| R10 | `useLimitResume`을 `resumeOwner==='engine'`이면 끄기 | **닫힘** — 렌더러 R3 ⑦ |

목록 자체는 **쓰인 시점엔 참**이었다. 문제는 다음 라운드가 두 보고서를 **합쳐** 읽는다는
것이고, 그러면 R6·R7·R8·R10을 이미 있는데 다시 쫓는다. 갱신이 필요하다.
그 밖 항목(`allow_always` C · 유휴 Priv P · 워치독 ⑥ O17 · 재장전 90초 · `chat:flush-req` 구독자)은
전부 **정확**하다(코드로 확인).

### 4.3 두 목록 어디에도 없는 것 — **3건**

| # | 빠진 항목 | 등급 |
|---|---|---|
| **M1** | **`user-echo` 구독자 없음.** 셸이 `hub.rs:823`에서 내고 R4 §R4.3이 *"3.0 화면은 이 값으로 예약이 나간 자리를 그린다"*고 적었는데, `app/src` 전체 검색 결과 **0건**. `session.ts:1060`의 `default:`로 조용히 흘러간다 → **엔진이 연 턴(한도 재개·재장전 드레인)에 사용자 말풍선이 없다.** `poc-live-chat B2`의 `dom:true`는 *답장* 문자열만 본다 | 중간 |
| **M2** | **`chat:verdict` 구독자 없음.** `hub.rs:263`은 **정규화 실패**(`CwdMissing`·`AccountUnavailable`)의 **유일한 사유 통로**인데 구독자 0이고, 호출은 `answer(Value::Null)`로 돌아간다(`hub.rs:377`). 실측 결과는 §5-F4 | **높음** |
| **M3** | **`chat:identity` 구독자 없음.** 정체성 드리프트·폴백 유지(`driftedFields`·`keptByFallback`)를 아무도 안 그린다 | 낮음 |

---

## 5. 새 발견

### F1 [치명] "재개의 주인 하나"로 고른 그 하나가 **2.6.2보다 관대하다** — 오탐 3/18

R4 §R4.4는 *"진실 하나를 고른다"*며 Rust를 소유자로 세웠고, 렌더러 R3 ⑦은
`managed`로 자기 기계를 **장전·타이머·재검증·소진까지 전부** 껐다(`useLimitResume.ts:73,138,165,175`).
`resumeOwner:"engine"`은 대기표 유무와 무관하게 **런타임이 있는 모든 채팅**에 실린다
(`lite.rs:89`) — 즉 한 번이라도 보낸 채팅은 그 순간부터 렌더러 판정자가 죽는다.

그런데 두 판정자가 같지 않다.

```rust
// crates/ccg-engine/src/frames.rs:317-325 — 주석은 "2.6.2 classifyLimitError의 Rust 이식"
(t.contains("limit") && (t.contains("reached") || t.contains("exceed") || t.contains("reset")))
    || t.contains("usage limit") || t.contains("rate limit") || t.contains("한도")
```

```ts
// app/src/lib/limitResume.ts:41-58 — 원본
if (/usage limit/i.test(s)) return { hit: true, resetsAt: parseEpoch(s) }
if (/context|token|output|length/i.test(s)) return { hit: false, resetsAt: null }   // ★ 오탐 차단벽
```

이식이 **차단벽을 안 옮겼고**, 2.6.2가 *"일시 과부하는 CLI가 자체 재시도하므로 잡지 않는다"*고
명시한 `rate limit`을 **추가**했다. 2.6.2 PoC의 자기 코퍼스
(`scripts/poc-limit-resume.mjs` A절 — HITS 9 · MISSES 9)를 Rust 함수에 그대로 먹였다:

```
HITS 9 / MISSES 9 / 불일치 3
  FALSE-POSITIVE "context limit reached: conversation too long"
  FALSE-POSITIVE "output token limit exceeded"
  FALSE-POSITIVE "rate limited; retry shortly"
```

세 건 다 2.6.2 원본이 *"오탐으로 남의 에러를 조용히 재전송하는 쪽이 놓침보다 훨씬 나쁘다"*고
주석에 적어 둔 바로 그 부류다. **이 라운드가 만든 코드는 아니다**(`098814a`). 이 라운드가 한 것은
**더 엄격한 판정자를 끈 것**이고, 그래서 오늘부터 관대한 쪽이 유일한 판정자다.

### F2 [치명] 리셋 시각을 안 읽고, 신선 usage 재검증도 없다 → **6.5분마다 헛 재개**

`arm_hold`는 문구 경로에서 **항상 `None`**을 받는다(`runtime.rs:2337`) — 에러 원문의
`…|1755150000` 꼬리를 아무도 파싱하지 않는다. 그러면 `resets_at = now + 5분`으로 놓고
(`runtime.rs:2385-2389`) `due_at = resets_at + 90s`에 **바로 소진**한다(`check_hold` → `consume_hold`).
`check_hold` 어디에도 usage 조회가 없다 — 2.6.2 `fire()`는 *"장전 시점 판단을 믿지 않고
신선 usage로 재검증"* 하고 아직 막혔으면 **재장전만** 했다.

가상 시계 + 스텁 CLI(한도 에러만 돌려주는)로 쟀다:

```
hold.resets_at = Some(1301000)   ← 장전(1001000) + 5분.  문구의 1755150000(초)은 무시됐다
due_at         = Some(1391000)
30분 동안 spawns 1 → 5 · 보낸 사용자 텍스트 5건:
  ["첫 턴", "이어서 진행해 주세요", "이어서 진행해 주세요", "이어서 진행해 주세요", "이어서 진행해 주세요"]
```

**30분에 4회.** 실제 5시간 창이면 **~46회** — 매번 CLI를 띄우고, 스레드에 「이어서 진행해
주세요」와 오류 말풍선을 한 쌍씩 쌓는다. 화면도 거짓말한다: `LimitHoldBar managed`가
`hold.resetAt`을 그대로 그리므로 5시간 한도에 **"약 5분 뒤 자동으로 이어서 계속해요"**가 뜬다
(poc-dial `own.bar-managed`가 그 문장을 초록으로 찍는다 — 값이 합성이라 안 걸린 것뿐이다).

F1과 겹치면 최악이 된다: 컨텍스트 초과 에러 하나가 **영원히** 6.5분마다 재전송된다
(그 에러는 리셋으로 풀리지 않는다).

> 재현: `%TEMP%/ccg-r14-wt/crates/ccg-engine/tests/r14_limit_loop.rs`
> (`cargo test -p ccg-engine --test r14_limit_loop -- --nocapture`), 코퍼스 대조는
> 같은 위치의 `tests/r14_limit_parity.rs`. 둘 다 제품 코드 무수정 · 워크트리에만 있다.

### F3 [높음] 되올림 앵커가 **정착 뒤 365px 어긋난다**(3/3) — 저울이 그 순간을 안 본다

poc-dial의 `raise.anchor-land-n1`은 `__ccgLandings()`를 읽는다(`poc-dial.mjs:784-789`).
그것은 **유지 루프가 마지막으로 돈 순간**의 값이지 리플로가 끝난 화면이 아니다.
`__panelTop().off`는 "뷰포트 맨 위 행"이라 앵커 행이 아니고(같은 파일 `:638-642`),
커밋 스스로 그 저울을 못 믿는다고 적었다. 즉 **B 케이스의 초록은 착지 기록 하나가 진다.**

같은 픽스처에 poc-dial과 같은 파라미터(6분할 · `frac 0.42` · 정착 1800ms)로 프로브를 붙여
앵커 행을 **텍스트 지문**으로 추적했다. 3회 전부 같은 값:

```
savedOff = -331   row "패널 2 · 구간 4 검토 결과 세대…"
착지 기록  want -331 → got -331   (scrollTop 2059)        ← poc-dial이 초록으로 읽는 값
정착 후    scrollTop 2647 · 그 행의 off = -696            ← 실제 화면
오차 -365px  ·  +1.2s / +2.6s / +5s / +9s 전부 동일  ·  3/3 결정적
```

원인은 코드가 이미 알던 함정 (c)다. 유지 루프의 이탈 조건이
`|scrollTop − p.set| > 2 → stop()`인데(`Chat.tsx:2188`, `:2239`의 `onScroll`),
**브라우저 scroll anchoring이 스스로 움직인 scrollTop도 scroll 이벤트를 낸다.**
주석은 *"앵커 모드는 anchoring 보정이 앵커를 제자리에 두므로 다음 패스가 no-op"*이라고
가정했지만(`Chat.tsx:2186-2187`), 실측에서 보정은 제자리에 못 두고(365px 밀림) 루프는
**그 보정을 사용자 스크롤로 읽고 즉시 무장해제**한다 — 바닥 모드에는 의사 신호를 따로
둬서 막은 그 사고를, 앵커 모드에서는 안 막았다.

공평하게: **항상 틀리는 것은 아니다.** 크리틱 하네스의 파라미터(`frac 0.35` · 700ms)로는
저장 오프셋이 −44~−47로 작고, 3회 전부 **오차 0**이었다. 갈리는 축은 "앵커 행이 뷰포트
위로 얼마나 밀려 있었나"로 보인다. 그래도 **poc-dial이 초록으로 신고하는 그 케이스가
틀리는 쪽**이라는 사실은 남는다.

> 재현: `%TEMP%/ccg-r14-wt/docs/critic/tools/.r14-raise.mjs`
> `node .r14-raise.mjs --frac=0.42 --pre=1800 --tag=pocdial` / `--frac=0.35 --pre=700 --tag=harness`
> 산출 `docs/critic/r14-raise-{pocdial,harness}.json`(워크트리). 제품·빌더 하네스 무수정.
> ※ poc-dial의 B 케이스는 A 케이스를 먼저 돌기 때문에 DOM 상태가 내 프로브와 완전히
> 같지는 않다(그쪽 저장 오프셋은 30, 내 쪽은 −331). 내가 주장하는 것은 "같은 픽스처·같은
> 파라미터에서 정착 후 365px 어긋난다"와 "poc-dial의 검사식은 그 순간을 볼 수 없다" 둘이다.

### F4 [높음] 채팅 폴더가 사라지면 **영원히 침묵 정지** — 두 목록에 없다

`hub::ensure()`가 `ChatRuntime::new`에 실패하면(`IdentityError::CwdMissing` ·
`AccountUnavailable`) 사유를 `chat:verdict`로 뿌리고 `answer(Value::Null)`을 돌려준다.
**`chat:verdict` 구독자는 0이고**(§4.3-M2), 런타임이 없으니 **T3(20초 침묵 감시)도 없다.**

폴더를 없는 경로로 바꾼 채팅에서 한 줄 보내고 40초를 봤다($0 · CLI 0회):

```
 +3s  hasProbe true · stopBtn 1 · "징검다리 놓는 중 ·3초"   · errMsgs []
+10s  … "징검다리 놓는 중 ·10초"                            · errMsgs []
+25s  … "안개를 걷어내는 중 ·25초"                          · errMsgs []   ← T3(20s) 지났다
+40s  … "퍼즐 맞추는 중 ·40초"                              · errMsgs []
```

사용자 말풍선은 그려졌고, 나레이션은 계속 돌고, 중지 버튼이 살아 있고, **오류·안내는 0건**이다.
이것이 m-logic P8("영구 정지 + 침묵") 그 자체다 — 3.0이 죽이겠다고 선언한 증상이 **폴더를
지우는 것만으로** 살아 있다. 계정 오버라이드를 로그아웃한 채팅(`AccountUnavailable`)도 같은 문이다.

> 재현: `%TEMP%/ccg-r14-wt/docs/critic/tools/.r14-cwdgone.mjs` → `docs/critic/r14-cwdgone.json`
> 고치는 법은 둘 중 하나다. ⑴ `chat:verdict`에 구독자를 붙여 `kind:"rejected"`를 오류
> 말풍선으로 그린다 ⑵ `answer(Value::Null)` 대신 거부 verdict를 **호출 반환값**으로 돌려
> 보내고 렌더러가 그것으로 `begin`을 되감는다. ⑵가 침묵 no-op 금지(D7)에 더 가깝다.

### F5 [중간] `user-echo`를 아무도 안 그린다 (§4.3-M1)

R4가 신설한 이벤트인데 소비자가 없다. 영향은 **엔진이 스스로 연 턴에 사용자 말풍선이
없는 것** — `begin_run`은 `{type:"status", status:"analyzing"}`만 낸다(`wire.rs:402`).
한도 재개(F2의 그 나팔)와 재장전 드레인이 그 경로다. 오늘 F2가 살아 있는 동안은
"말풍선이 없어서 오히려 덜 지저분한" 상태라 눈에 안 띈다 — F2를 고치면 드러난다.

### F6 [정보] 하네스 두 가지

- **`critic-wiring-live` 부분 주행이 이전 findings를 이어받는다.** `--only=A,B,C,D`만 돌렸더니
  A~D 전부 초록인데 판정이 `FAIL · 결함 3건`이었고, 그 3건은 커밋된 파일에 있던 R1의
  `E-정착`·`E-사유`·`F-정착`이었다. R12 §R-1이 지적한 것과 **반대 방향**이라(초록을 남기는
  게 아니라 빨강을 남긴다) 안전하긴 하나, 부분 주행 판정 줄을 그대로 인용하면 안 된다.
  `critic-mux-attack`은 같은 병합을 하되 **재주행한 step의 옛 findings를 지운다**(`:915`) — 그쪽이 옳은 모양이다.
- **`attrib`의 `noglue` 팔은 `flags`가 null이다**(§3.4 곁다리).

---

## 6. 재현 명령

```bash
# 핀 (다른 라운드와 격리 — 메인 워킹트리에 남의 미커밋 편집이 있다)
git worktree add --detach %TEMP%/ccg-r14-wt c9a2396
cd %TEMP%/ccg-r14-wt && cmd //c "mklink /J node_modules C:\Code\AgentCodeGUI\node_modules"
CARGO_TARGET_DIR=%TEMP%/ccg-r14-tgt npm run tauri:build
CARGO_TARGET_DIR=%TEMP%/ccg-r14-tgt cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release
cp %TEMP%/ccg-r14-tgt/release/{agentcodegui,ccg-fakecli}.exe target/release/   # 하네스는 경로 고정

# 렌더러
node scripts/poc-dial.mjs                                   # 43검사
node docs/critic/tools/critic-mux-attack.mjs                # 11단계
node docs/critic/tools/critic-mux-attack.mjs --only=foldrun # ★ 흔들림 — 2회 이상
node docs/critic/tools/.r14-raise.mjs --frac=0.42 --pre=1800 --tag=pocdial   # ★ F3
node docs/critic/tools/.r14-raise.mjs --frac=0.35 --pre=700  --tag=harness

# 배선
CARGO_TARGET_DIR=%TEMP%/ccg-r14-tgt cargo test -p ccg-engine -p ccg-store
(cd src-tauri && CARGO_TARGET_DIR=%TEMP%/ccg-r14-tgt cargo test)
node scripts/poc-live-chat.mjs --tag=r14                    # 8단계 44검사
node docs/critic/tools/critic-wiring-live.mjs --only=A,B,C,D
node docs/critic/tools/critic-wiring-live.mjs --only=E,F     # ※ 부분 주행 판정 줄은 못 믿는다(F6)
node bench/attrib.mjs --arm=noglue,nofs --pairs=2 --tag=r14 --port=9411

# 새 발견
CARGO_TARGET_DIR=%TEMP%/ccg-r14-tgt cargo test -p ccg-engine --test r14_limit_parity -- --nocapture  # F1
CARGO_TARGET_DIR=%TEMP%/ccg-r14-tgt cargo test -p ccg-engine --test r14_limit_loop   -- --nocapture  # F2
node docs/critic/tools/.r14-cwdgone.mjs                                                              # F4
```

산출물은 전부 격리 워크트리 안에 남겼다(`%TEMP%/ccg-r14-wt/docs/critic/`:
`m-ux-r3-dial.json` · `m-ux-r1-attack.json` · `m3-r4-live-r14.json` · `wiring-r1-attacks.json` ·
`r14-raise-{pocdial,harness}.json` · `r14-cwdgone.json`, 그리고
`bench/results/attrib-tauri-3.0.0-r14.json`). 새 하네스 셋도 거기 있다
(`tools/.r14-raise.mjs` · `tools/.r14-cwdgone.mjs` · `crates/ccg-engine/tests/r14_limit_{parity,loop}.rs`).
**메인 레포에는 이 보고서 한 장만 더한다** — 공용 기준 파일을 한 바이트도 안 건드리기 위해서다.

---

## 7. 유휴 Priv 게이트

**판정하지 않았다**(리드 지시 — 동시 주행 노이즈). 다만 귀속 표 재현(§3.4)에서 나온
기본 팔 8회 값은 남긴다: `total 430.7 ~ 436.0 WS / 247.9 ~ 253.2 Priv`.
게이트(≤253)를 걸치는 구간이고, 이 레포에서 라운드 셋이 도는 동안은 이 수치로 합불을
말할 수 없다는 R4 §R4.2-5의 진술과 같은 결이다.
