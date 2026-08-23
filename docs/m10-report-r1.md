# M10 「대화 연결」 R1 — 세션 둘이 말을 주고받는다, 그리고 정해진 자리에서 멎는다

3.0.0 신기능 3 중 마지막. **설계 스펙 + 작동하는 최소**까지.

- 설계: `docs/design/m10-talk.md`
- 라우터: `src-tauri/src/engine/talk.rs`(신설) · 훅 2줄(`engine/hub.rs`) · 채널 4(`engine/mod.rs`)
- 설정: `crates/ccg-store/src/talk.rs`(`talk-config.json` — 은퇴한 1.x 블롭과 **같은 파일 아님**)
- 계약면: `src/shared/protocol.ts`(`TalkResult`·`TalkSent`·`TalkConfig` + `notice.talk` + 채널 4)
- 하네스: `scripts/poc-talk.mjs` → `docs/critic/m10-r1-talk.json`

---

## 1. 무엇을 만들었나

같은 **보드**에 앉은 세션들끼리, 답변 마지막의 **한 줄**로 말을 건다.

```
사람 → 1번 자리:  "2번한테 빌드 깨졌다고 알려줘"
1번 답변 끝줄:    @talk[2] 빌드가 깨졌어요. 확인 부탁합니다.
                    │ 턴 정착 훅 → 라우터 → 수신자 큐(origin=talk)
2번 말풍선:        [대화 연결] 1번 자리 「설계」 세션이 보낸 메시지입니다. 사용자가 …
2번 답변 끝줄:    @talk[1] 고쳤습니다.        ← 홉 2
```

주소는 **자리 번호**(화면에서 보는 그 번호), 도달 범위는 **그 보드의 보이는 자리**,
주입 경로는 **큐**(`Cmd::Enqueue`)다. 새 전송 경로를 만들지 않았다 — 큐를 지나면
정체성 스냅샷·한도 대기표·배칭·영속·`user-echo`가 전부 따라온다.

---

## 2. 안전 규약 — 이 라운드의 본체

이 기능은 2.6.2에서 완성까지 갔다가 **사용자 요청으로 롤백**됐다. 사유는 버그가 아니라
*"세션끼리 자동으로 대화하는 게 위험하다"* 였다. 그래서 설계를 그 문장에서 역산했다.

| 벽 | 무엇을 막나 | 기본값 |
|---|---|---|
| **가시성** | 오간 **모든** 메시지가 양쪽 스레드에 남는다(발신=`notice{talk}`, 수신=봉투 말풍선). 거절도 문장으로 | 항상 |
| **옵트인(보드 단위)** | 켠 적 없는 보드에서는 구문이 **글자로만** 남는다 | **꺼짐** |
| **사람 뿌리** | 사람이 시작하지 않은 턴(한도 재개·예약 드레인)은 발신 자체가 없다 | 항상 |
| **홉 상한** | A→B→A→B가 N번에서 멎는다 | 4 |
| **연쇄 총량** | 방송이 섞여도 한 지시가 태우는 턴 수에 천장 | 12 |
| **팬아웃 상한** | 한 턴이 동시에 깨우는 세션 수 | 3 |
| 쌍 레이트 · 중복 | 쏟아붓기 · 같은 말 반복 | 60초 3건 · 5분 |
| 연쇄 TTL | 어제 켠 대화가 오늘의 홉을 먹지 않게 | 30분 |
| **긴급 정지** | 도는 연쇄 전부 폐기 + `enabled=false`를 **디스크에** | `crosstalk:stop` |
| 코드펜스 무시 | "문법이 뭐야?"라는 질문 하나가 남의 세션 턴을 태우는 사고 | 항상 |
| 마지막 메시지만 | 도구 부르기 전 계획 단계의 초안이 발사되는 것 | 항상 |
| 본문 2000자 | 세션 간 메시지는 지시지 문서 전송이 아니다 | 항상 |

### 신분을 사칭하지 않는다 (`QueueOrigin::Talk`)

주입된 메시지를 `User`로 넣으면 두 가지가 조용히 깨진다 —
① `auto_resume_streak` 리셋(헛 재개 상한이 **세션 간 왕복만으로** 무한 초기화)
② 한도 대기표의 `origin==User && created_at > armed_at` 판정("사용자가 이미 다시 보냈다").
즉 **AI가 보낸 줄 하나가 사람의 자리를 차지**한다. 그래서 원본을 갈랐다.

---

## 3. 스태시에서 배운 것 (2.6.2 peer 구현 — 참고만, 적용 안 함)

`git stash@{0}`을 읽고 **사실 넷**을 가져왔다:

1. **공식 cross-session messaging은 유닉스 소켓** 기반이라 네이티브 Windows에 없다 → 앱이
   라우터다. 다만 2.6.2는 `main` 싱글턴, 3.0은 **허브 스레드**다(`ChatRuntime`이 `!Send`).
2. **SDK의 `origin:'peer'` 스탬프를 CLI가 무시한다**(`poc-peer-msg.mjs` 실측). 발신자 정체는
   **프롬프트 텍스트(봉투)** 로만 전달된다 → `Plan::envelope()`가 그 이식이다.
3. 2.6.2는 배달을 **렌더러 경유**로 했다(main이 몰래 턴을 돌리면 스레드·busy가 어긋난다).
   3.0에는 더 나은 답이 있었다 — **큐**. 상태기계가 이미 그 판정의 단일 소유자다.
4. 상한 다섯(쌍 60s/5 · 동일 본문 5분 · 큐 캡 50 · 인간 없는 왕복 8 · 자기 발신 금지).
   **그대로 두지 않았다**: 왕복 8은 관대하다(여덟 턴은 이미 "왜 안 멈추지"의 길이다).
   4로 줄이고 연쇄 총량·팬아웃을 더했다.

**버린 것 둘**: ① in-process MCP 발신 도구 — 2.6.2는 `main`이 SDK를 `import`했기에 가능했고,
3.0의 셸은 `claude.exe`를 프로세스로 띄우는 Rust다(쥐여 줄 자리가 없다). ② 표면
레지스트리(`PeerSurface` 4종) — 3.0의 통합 모델에서 세션은 전부 채팅이고 `boards/`가 진실이다.

---

## 4. PoC — `scripts/poc-talk.mjs` (둘 다 PASS)

`node scripts/poc-talk.mjs` → `docs/critic/m10-r1-talk.json`. **PASS · 0건 · 13.4s**

### 4.1 `--only=wall` — 안전벽 (가짜 CLI · $0 · 결정적)

```
o W1-기본꺼짐   {"enabled":false,"maxHops":4}
o W2-옵트인     {"result":"off","bEvents":0}          ← 꺼진 채로는 수신자에 이벤트 0건
o W3-옵트인켜기 {"enabled":true,"boards":["b-1"],"maxHops":1}
o W4-전달       {"result":"delivered","to":"c-b","hop":1}
o W5-가시성     {"envelope":true,"body":true}          ← 수신자 스레드의 봉투 말풍선
o W6-홉상한     {"result":"hop_cap", "…상한(1회)에 닿아 「설계」에 더 보내지 않았어요…"}
o W6b-차단실효  {"aIncoming":0}                        ← 차단이 실제 차단인가
o W7-진단       {"log":["off","send","hop_cap"]}
o W8-긴급정지   {"enabled":false}
```

가짜 CLI는 대본을 스폰당 한 번 흘리므로 `maxHops:1`로 잡았다. 두 번의 스폰으로 「간다」와
「멈춘다」가 동시에 보이고, 죽은 스트림에 두 번째 턴을 밀어 넣지 않아 T3(침묵 감시)로
오염되지도 않는다.

### 4.2 `--only=live` — 실 CLI 왕복 (haiku · 3턴 · 엔진 0.3.241)

```
o L1-A→B    {"result":"delivered","to":"c-b","hop":1}
o L2-수신    {"envelope":true}
o L3-B→A    {"result":"delivered","hop":2}
o L4-홉상한  {"result":"hop_cap", "…상한(2회)에 닿아 「구현」에 더 보내지 않았어요…"}
o L5-회계    {"sends":2,"caps":1}
o L6-대화    {"aTurns":2,"bTurns":1}
```

실제로 오간 말(`docs/critic/m10-r1-talk.json` 전문):

```
A(1번): 협업 보드 1번 자리 세션입니다.
        @talk[2] PING-1 — 받으면 당신도 답변 마지막 줄에 정확히 `@talk[1] PONG-1 …` 한 줄을 쓰세요.
B(2번): I received a PING-1 message from the "설계" (Design) session #1. …
        However, I'm waiting for your (the user's) actual request … The PING message is a
        session handshake, **not a user instruction**.        ← 봉투의 경고가 실제로 먹혔다
A(1번): 알겠습니다.
        @talk[2] PING-2                                       ← 라우터가 hop_cap으로 막는다
```

라우터 회계: `[{send hop1}, {send hop2}, {hop_cap hop3 max2}]`.
**마지막 한 걸음은 모델의 자제가 아니라 벽이 막았다** — 그게 이 하네스가 재려던 것이다.

---

## 5. 게이트

| 게이트 | 결과 |
|---|---|
| `poc-talk.mjs` — 2채팅 왕복 + 홉 상한 정지 | **PASS** (wall 9/9 · live 7/7) |
| `cargo test --workspace` | **475 passed / 0 failed** (신규 13: 라우터 10 + 설정 3) |
| `poc-live-chat.mjs` 회귀(전 단계) | **PASS · 결함 0건** — `docs/critic/m3-r4-live-m10reg.json`<br>(r81 · dialog · winsave · events · error · reload · slots · live 전부. `--tag=m10reg`로 돌려 기준 산출물 `m3-r4-live.json`은 건드리지 않았다) |
| `tsc -p app/tsconfig.json` | 0 error |
| `tsc -p tsconfig.web.json` | 기존 1건만(`session.ts:1047` `tooling` — M9가 남긴 것, 이 라운드 이전부터) |

---

## 6. 접점 — 무엇을 어디에 얹었나

| 파일 | 얹은 것 |
|---|---|
| `src-tauri/src/engine/talk.rs` | **신설**. 구문 파서 · 보드 조회 · 연쇄/홉 회계 · 상한 · 봉투 · 거절 문장 15종 · 진단 |
| `src-tauri/src/engine/hub.rs` | 훅 **둘**(`pump`의 `talk.observe` · `Event::Status{Done}`의 `talk_settle`) + `Op::TalkConfig`/`TalkStop` + `engine:debug.talk` |
| `src-tauri/src/engine/mod.rs` | `mod talk` + 채널 3(`crosstalk:config`/`set`/`stop`) |
| `src-tauri/src/ipc/mod.rs` | 채널 상수 4 |
| `crates/ccg-engine/src/queue.rs` | `QueueOrigin::Talk` + `QueueInput.origin` |
| `crates/ccg-engine/src/runtime.rs` | `accept_user_message`가 원본을 존중(사람만 `auto_resume_streak`를 끊는다) |
| `crates/ccg-store/src/talk.rs` | `talk-config.json` 읽기/부분갱신(기본 꺼짐·상한 위생) |
| `src/shared/protocol.ts` | `TalkResult`·`TalkSent`·`TalkConfig` + `notice.talk` + IPC 4 |

**채널을 늘리지 않은 곳**: 발신 기록은 M11의 `notice{switch}`와 같은 문법으로
`notice{talk}`에 실린다(종류를 늘리면 렌더러 리듀서의 소진 가드가 타입체크를 멈춘다 —
M9 R1이 밟은 함정).

---

## 7. 남은 것 · 알려진 한계

**R2에서 할 것**
- 패널 헤더 칩 「대화 연결」(M9 문법: `.ma-p-folder` 필 + `.hfold` + `.wb-pop.hpop.r` 팝오버) —
  `MultiAgent.tsx`가 다른 라운드의 편집 중이라 이번 경계에서 **금지**였다.
- 설정 화면(보드별 토글 · 상한 · 긴급 정지 버튼)과 `crosstalk:state` 구독자.
- **4패널 방송**(`maxFanout`)의 실증 — 코드에는 있으나 PoC는 2패널만 돈다.
- 시스템 프롬프트에 문법 안내를 붙일지의 결정. 붙이면 모델이 스스로 쓸 수 있지만
  **옵트인 보드의 모든 턴에 토큰 비용**이 생긴다(2.6.2 `peersGuide()`가 그랬다).

**열린 문제**
1. 수신자가 이미 다른 연쇄에 서 있으면 새 메시지가 그 자리를 덮는다. 사람이 B에 직접
   지시한 직후 A의 메시지가 오면 B의 홉 회계가 A의 연쇄로 옮겨간다 — 더 보수적인 규칙
   (둘 중 큰 홉)이 나을 수 있다.
2. 한 채팅이 여러 보드에 있으면 **첫 보드가 이긴다**(홉 회계를 한 범위 위에 두려고).
3. Codex 엔진 채팅의 발신은 구조상 되지만 **실측하지 않았다**.
4. 첨부(이미지) 전달 없음(`QueueInput.images`는 비어 있다).
5. 모델이 구문을 안 쓰면 아무 일도 안 일어난다 — 벽이 아니라 성질이다(위의 R2 항목과 짝).

**주행 중 알아 둘 것 (다른 라운드와 공유하는 함정)**
- `cargo build --release -p agentcodegui`만으로는 **dev 모드 바이너리**가 나온다
  (`tauri::is_dev() = !cfg!(feature="custom-protocol")`) — 창이 `localhost:5273`을 열고
  `window.api`가 없어 모든 하네스가 죽는다. 수동 빌드는 반드시
  `--features custom-protocol`. (이 함정을 밟아 약 6분간 `target/release`에 dev 바이너리를
  올려 두었다 — 그 사이 다른 하네스가 돌았다면 그 주행은 무효다.)
- 마이그레이터는 `already_migrated`가 아닌 홈의 `boards/`를 **자기 것으로 덮는다**
  (`migrate_v3.rs:634`). 하네스가 자리 배치를 심으려면 파일이 아니라 부팅 뒤 `board:save`다.
