# M8 R1 — 남은 창 표면 3종: 팝아웃 · 토스트 · 트레이

라운드 R17 · 2026-08-23 · 브랜치 `feature/3.0.0-beta`

3.0의 창 표면은 R16까지 **메인 창 + 추가 채팅 창** 둘뿐이었다. 렌더러(`app/`)에는 나머지
셋이 이미 이식돼 있었지만 — `PanelWindow.tsx`(`#mapanel`) · `toast.ts`(`toast.html`) ·
`tray.ts`(`tray.html`) — **셸 쪽이 통째로 비어 있었다.** 그래서 팝아웃 버튼을 눌러도 창이
안 뜨고(`ma:panel-*` 7채널 전부 `{__unimplemented:true}`), 알림 토스트가 안 뜨고
(`notify:*` 4채널), 트레이 아이콘이 없었다(`traymenu:*` 3채널 + `X = 종료`).
A/B 인벤토리에서 `panel-window`·`toast-single`·`toast-aggregate`가 **도달 실패**로
남아 있던 이유이기도 하다.

이 라운드가 그 셋을 세웠다. 자기 채점은 하지 않는다 — 무엇을 만들었고, 무엇이 관측됐고,
무엇이 아직 없는지의 기록이다.

**측정 조건**: 이 세션 내내 다른 두 라운드(M7 LSP · M4 Codex)가 같은 워크스페이스를
컴파일하고 있었다. 아래 시간 값(창 생성 157~169ms 등)은 그 부하 위에서 잰 것이고,
**메모리는 재지 않았다**(동시 주행 노이즈 — 리드가 따로 잰다). 창당 비용은 노이즈에
둔감한 **프로세스 회계**로만 적는다.

---

## 0. 한 문단 요약

창 표면 3종이 전부 뜨고, 일하고, 사라진다. 팝아웃은 **열기 157ms → 그 창에서 턴 진행 →
같은 이벤트가 그리드에도 미러(6건) → 닫기 → 그리드 복귀**가 CDP로 관측됐고, 그 왕복에
**엔진은 한 번만 떴다**(`spawns=1`, `session=POP-1` 불변) — 3.0에서 팝아웃은 2.6.2의
사본 이전이 아니라 **뷰 이동**이다. 토스트는 포커스 중엔 안 뜨고, 비포커스에서 160ms에
뜨고, 작업 영역 우하단(2192,1239 / 2560×1392)에 앉고, **포커스를 한 순간도 안 뺏고**
(`document.hasFocus()=false`), 본창이 포커스를 되찾으면 스스로 사라진다. 트레이는 X를
숨김으로 바꾸고(프로세스 생존 · 가시 창 0), **같은 홈으로 두 번째 실행하면 113ms에 물러나며
369ms 만에 기존 창이 다시 뜬다**(M1 §7-3 이월 완료). 창 종류를 셋 다 열어도 **WebView2
프로세스는 5개 그대로**다(문서만 1→4). 유리·크래시 방어는 팝아웃 창까지 걸린다(백드롭 3 ·
렌더러 크래시 뒤 두 창 모두 재마운트). 게이트 `poc-live-chat` 6단계 전부 PASS 유지.
**개통 못 한 것 하나**: 2.6.2의 트레이 풍선 안내(Tauri 트레이 API에 대응물 없음, §7).

---

## 1. 무엇을 세웠나 — 파일과 채널

| 파일 | 역할 | 원본(2.6.2) |
|---|---|---|
| `src-tauri/src/popout.rs` (신설 · 320줄) | 멀티 패널 팝아웃 창 + 레지스트리 | `src/main/index.ts:660-743`, `:1295-1320` |
| `src-tauri/src/notify.rs` (신설 · 300줄) | 포커스 밖 알림 토스트 창 | `src/main/notifyToast.ts` (203줄) |
| `src-tauri/src/tray.rs` (신설 · 330줄) | 트레이 아이콘 · 우클릭 메뉴 창 · X 정책 · 두 번째 인스턴스 | `src/main/index.ts:745-890`, `:930-955` |
| `src-tauri/src/win.rs` | 세 모듈 매달기 · X=숨김 · 창 포커스→토스트 소멸 · 복구 리셋 | — |
| `src-tauri/src/ipc/windows.rs` | 채널 14개 배선 + 진단 채널 1개 | — |
| `src-tauri/src/crash.rs` | 팝아웃 창을 재생성 대상에 편입 | — |
| `src-tauri/src/main.rs` (3줄) | 두 번째 인스턴스 → `raise_existing()` | `index.ts` second-instance |
| `src-tauri/Cargo.toml` | tauri feature `tray-icon` · `image-png` | — |
| `scripts/poc-winsurface.mjs` (신설) | 5단계 실증 하네스 | — |

**모듈을 `win.rs`의 자식으로 매단 이유**는 `glass.rs`와 같다: `main.rs`는 다른 라운드가
소유한 파일이라 한 줄 추가도 충돌을 만든다. 부수 효과가 하나 더 있는데, 창을 만드는
유일한 경로인 `shared_env`가 **이 세 모듈에서만 보인다** — 창당 비용 규약이 모듈 경계로
강제된다.

### 채널 14 + 1

| 묶음 | 채널 | 구현 |
|---|---|---|
| 팝아웃 (7) | `ma:panel-open` `-hydrate` `-persist` `-focus` `-close` `-states` `-leftover-clear` | ✅ `win::popout` |
| 팝아웃 이벤트 (1) | `ma:panel-closed` (main→메인 창) | ✅ 닫힘 통지 + flush 동봉 |
| 토스트 (4+2) | `notify:event` `-open` `-close` `-resize` / `notify:show` `notify:jump` | ✅ `win::notify` |
| 트레이 메뉴 (2+1) | `traymenu:resize` `-action` / `traymenu:show` | ✅ `win::tray` |
| 진단 (1) | `win:surface-debug` — 계약면 밖. 하네스가 창 회계를 읽는다 | ✅ |

`ma:event` **미러 팬아웃은 코드가 0줄이다.** 2.6.2는 `sendMaEvent`가 손으로 두 번 보냈지만
(`index.ts:368-374`), 3.0의 `engine/hub.rs:401`은 `app.emit(MA_EVENT, …)` = 전 창
브로드캐스트다. 그래서 이번 라운드는 **`engine/`을 한 줄도 만지지 않았다.**

---

## 2. 팝아웃 — 소유권 모델이 2.6.2와 다르다

### 2.1 무엇이 달라졌나

2.6.2의 팝아웃은 **사본 이전**이었다. 엔진이 `maEngines: Map<panelId, EngineRouter>`
(`index.ts:358-367`)라 실행이 자리 번호에 매달려 있었고, 초안·큐·메타는 창으로 옮겨 가고
(그리드는 유령) 닫힐 때 마지막 페르시스트가 되돌아왔다.

3.0은 `panelId`가 **보드의 자리 번호**일 뿐이다. 실행은 `engine/mod.rs:206`
`panel_id_to_chat()`이 보드에서 읽어 낸 **chatId가 소유**한다:

```
panelId "22a27cba-…::0"  ──boards/22a27cba-….json.slots[0]──▶  chatId "ma-22a27cba-…-0"
                                                                        │
                                                              ChatRuntime (hub.rs)
```

즉 팝아웃 창이 `ma:run`을 보내도 그리드가 보내던 것과 **같은 `ChatRuntime`**에 붙는다 —
엔진 재스폰도 resume id 재발급도 없다(ux-chat-unify §1.2 불변식 3 · §3). 이 모듈이 나르는
것은 **렌더러 로컬 상태뿐**이다: 초안·이미지·예약 큐·패널 메타·스레드 스냅샷.

### 2.2 실증 — `poc-winsurface.mjs --only=popout`

격리 홈 · 가짜 CLI(`ccg-fakecli.exe`, $0 · 네트워크 없음) · 멀티 모드 기동.
사용자 경로 그대로 몬다: F2로 패널 이름 → 그리드 컴포저에 초안 → 팝아웃 버튼 →
**창의 컴포저에서 Enter** → 창 닫기.

| # | 관측 | 값 |
|---|---|---|
| P0 | 보드가 자리에 채팅을 앉혔다 | `22a27cba…::0 → ma-22a27cba-…-0` |
| P1 | 팝아웃 창 생성 → CDP 타깃 | **157ms** |
| P1 | 그 창에 `PanelView` 마운트 | `.sw.pwin .pw-body .ma-panel` ✓ |
| P2 | 그리드에 팝아웃 유령 셀 | `.ma-panel.ma-ghost.pop` ✓ |
| P3 | **초안 소유권 이전** | 그리드에 심은 `"팝아웃으로 넘어갈 초안"`이 창의 컴포저에 있다 |
| P3 | `ma:panel-hydrate` | 부트 페이로드 반환(panelId 포함) |
| P4 | **그 창에서 대화 계속** | 창 컴포저 Enter → 창 DOM에 답변 `"팝아웃 창에서 답한 줄"` |
| P5 | **미러 팬아웃** | 메인 창이 같은 panelId 이벤트 **6건** 수신: `status·session·assistant-done·context·result` |
| P6 | **엔진 재스폰 없음** | `spawns=1` · 런타임 1개 · `session=POP-1` (`engine:debug`) |
| P7 | 복귀분에 이번 턴이 실림 | 페르시스트 대기 **124ms** → `flushes=[{panelId, messages:2}]` |
| P7 | 창 닫힘 → CDP 타깃 소멸 | ✓ |
| P7 | 그리드 유령 해제 | ✓ |
| P8 | **그리드 복귀(fold-back)** | 창에서 돈 스레드가 그리드 셀에 있다 |
| P9 | leftover 회계 | 라이브 회수 → 잔여 사본 0 |

산출물 `docs/critic/m8-r1-winsurface.json`(단계별 원시값 포함).

### 2.3 크래시 복구에 편입 — 그리고 `hydrate`의 의미를 하나 바꿨다

`crash.rs recreate_windows()`는 창을 전부 부수고 메인 + 추가 채팅 N개만 되만들었다.
팝아웃 창은 그 목록에 없었으므로 **브라우저 사망 한 번에 팝아웃의 초안·스레드가 통째로
사라졌다**(그리드로 접히지도 않는다 — 메인 창도 같이 죽으니 `ma:panel-closed`를 받을
이가 없다). 창을 부수기 **직전**에 각 창의 최신 상태를 떠 두고(`snapshot_for_recreate`),
재생성 뒤 다시 만든다(`recreate_pending`).

`ma:panel-hydrate`는 이제 **마지막 페르시스트가 있으면 그쪽**을 돌려준다(없으면 부트).
`reload_all()` 경로는 창을 안 부수고 문서만 다시 세우는데, 부트만 돌려주면 재로드 직전까지의
초안·스레드가 통째로 한 세대 낡는다. 2.6.2에는 이 경로 자체가 없었다(개발 중 리로드는
"패널 정보를 찾지 못했어요" 안내로 끝).

---

## 3. 토스트 — 수명과 "포커스를 안 뺏는다"

### 3.1 규약(2.6.2 그대로)

- 표시 판정은 **셸**이 한다: 그 채팅이 사는 창이 비포커스일 때만. 렌더러는 전이만 알린다.
- **자동 닫힘 없음**(사용자 결정, `notifyToast.ts:13`). 소멸 경로 셋: ① 그 창이 포커스를
  되찾음 ② 카드 클릭(점프) ③ ✕. 목록이 비면 **창을 부순다** — 숨은 창이 앱 종료를 막는
  부류의 사고를 구조적으로 없앤다.
- 멀티 패널이 팝아웃돼 있으면 **소유 창은 팝아웃**이다: 표시 판정·소멸·클릭 점프 전부
  그 창 기준(`owner_label()`). 이벤트를 보내는 건 상태 소유자인 메인 창이라, 이걸 안 하면
  두 방향 다 틀린다.

### 3.2 포커스 불가 — `WS_EX_NOACTIVATE`

Electron은 `focusable:false`로 했다. Tauri/tao에는 대응 빌더 옵션이 없어서 창을 만든 뒤
`WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`를 직접 얹는다(그게 Electron이 하는 일이기도 하다).
실측: 토스트가 떠 있는 동안 `document.hasFocus() === false`.

### 3.3 실증 — `--only=toast`

| # | 관측 | 값 |
|---|---|---|
| T1 | **포커스 중엔 안 뜬다** | 이벤트를 보내도 `toast.html` 타깃 없음 · `notify.count=0` |
| T2 | 최소화 후 이벤트 → 창 생성 | **160ms** |
| T2 | 단건 상세 카드 | `"AGENTCODEGUI ✕ 답변 도착 벤치 채팅 첫 번째 턴이 끝났어요."` |
| T3 | **포커스 탈취 없음** | `document.hasFocus()=false` |
| T4 | 두 번째 알림 → 집계 행 | `.t-agg .t-row` **2행** |
| T4 | 앉은 자리 | `360×138 @ (2192,1239)` / 작업 영역 `2560×1392` = **우하단** |
| T5 | 행 클릭 → 본창 포커스 + 점프 | `notify:jump = {surface:'single', id:'c-two'}` · 본창 가시 |
| T6 | 본창 포커스 회복 → 자동 소멸 | 타깃 소멸 · `pending=0` |

### 3.4 밟은 함정 — **첫 REPLACE가 구독자보다 이르다**

첫 주행에서 **단건 카드가 빈 화면으로 굳었다**(두 번째 알림이 와야 그려짐). 원인은
`ipc/windows.rs`가 `chat:status`(F12)에 이미 적어 둔 것과 같은 자리다: 페이지 `load`
시점에 모듈 스크립트는 이미 돌았지만, 심의 `subscribe`는 Tauri `listen()`(**비동기 등록**)
이라 아주 잠깐의 공백이 있다. 그 공백에 `notify:show` REPLACE가 떨어지면 아무도 안 받는다.
같은 처방으로 닫았다 — 180 / 500 / 1200ms 재송신(REPLACE라 두 번 받아도 무해).
`traymenu:show`도 같은 구조라 같이 고쳤다.

같은 스레드에 안전망을 하나 더 붙였다: 창은 `notify:resize`가 와야 보여지는데 페이지가
그걸 못 보내면 **보이지 않는 창이 앱에 남는다**(알림을 못 보는 것보다 나쁘다). 마지막
시도에서 기본 높이로 앉힌다.

---

## 4. 트레이 — X = 숨김, 두 번째 실행 = 전면

### 4.1 세 조각

1. **아이콘** — `TrayIconBuilder`. PNG를 `include_bytes!`로 **exe에 박는다**: 3.0은
   `bundle.active=false`(설치본 없음)라 `resources/icon.ico` 같은 런타임 경로가 없고,
   레포 상대 경로는 벤치가 exe를 복사해 돌리는 순간 깨진다.
2. **메뉴** — 2.6.2와 같은 **커스텀 팝업 창**(`tray.html`). 네이티브 Win32 트레이 메뉴는
   구형 서식이라 창=카드로 직접 그린다. 창을 못 만들면 네이티브 `Menu`로 떨어진다
   (한 번 떨어지면 그 뒤로는 OS가 알아서 띄우므로 카드 시도를 막는다 — `NATIVE_FALLBACK`).
3. **X 정책** — 메인 창 `CloseRequested`가 `tray::hide_on_close()`를 묻는다.
   설정 `tray.closeToTray`(기본 on) + **트레이가 실제로 살아 있을 때만** 숨긴다.
   트레이 생성이 실패했으면 종전대로 진짜 닫기 — 숨긴 창을 되찾을 길이 없는데 숨기면
   그게 유령이다. `CCG_NO_TRAY=1`이 그 팔을 만든다.

`crash.rs`의 복구는 `w.destroy()`를 쓰므로 `CloseRequested`를 안 거친다 — 복구가
"숨기기"로 새지 않는다(확인함).

### 4.2 단일 인스턴스 두 번째 실행 (M1 §7-3 이월)

R1까지는 홈 잠금 실패 시 **조용히 물러났다**. 트레이에 숨어 있으면 사용자는 "아이콘을
눌렀는데 아무 일도 안 일어나는" 앱을 본다. 이제 물러나기 전에 **등록 윈도우 메시지**를
브로드캐스트하고(`RegisterWindowMessageW("CCG_RAISE_<앱홈 FNV1a 해시>")` →
`PostMessageW(HWND_BROADCAST, …)`), 먼저 뜬 인스턴스의 메인 창 subclass가 그걸 받아
창을 앞으로 올린다.

- **이름에 앱 홈 경로 해시가 들어간다** → 격리 홈(dev·벤치)끼리는 서로를 안 건드린다.
- glass.rs도 같은 hwnd에 subclass를 걸지만 **ID가 달라 체인으로 공존**한다.
- 폴링 스레드가 아니라 메시지라 유휴 비용이 0이다.

### 4.3 실증 — `--only=tray` (OS 층 · Win32 `EnumWindows`)

| # | 관측 | 값 |
|---|---|---|
| R1 | 트레이 아이콘 생성 | `tray=true` · `hideOnClose=true` |
| R2 | **X = 숨김** (`win:close` = 타이틀바 X와 같은 경로) | 프로세스 **생존** · 가시 창 **0** (`1336×889 "AgentCodeGUI3"` invisible) |
| R3 | 두 번째 인스턴스가 물러남 | `exit=0` · **113ms** |
| R3 | **기존 창 전면** | **369ms** 만에 가시 창 복귀 |
| R4 | 우클릭 메뉴 창 | `["AgentCodeGUI 열기","완전히 종료"]` · `218×87 @ (1947,805)` |
| R4 | Esc = 닫기 | 타깃 소멸 |
| R5 | **'완전히 종료' = 진짜 종료** | 프로세스 사망 |

> **하네스 주의**: 알림 영역 우클릭은 셸(Explorer)의 OS 이벤트라 CDP로 합성할 수 없다
> (A/B `tray-menu` 화면이 **두 앱 모두** skip인 이유). 하네스는 진입 함수를 진단 채널
> `win:surface-debug ["traymenu-open"]`로 직접 부른다 — **그 뒤 경로는 실제 우클릭과
> 같은 코드**다(같은 `show_menu(app,x,y)`). 아이콘 우클릭 자체의 배선(`TrayIconEvent::
> Click{button:Right}`)은 코드 대조로만 남는다.

### 4.4 밟은 함정 — **창이 태어나자마자 자기를 부순다**

메뉴 창이 "안 뜨는" 증상이 있었다. 로그를 박아 보니 `build()`는 **성공**하는데 2.5초 뒤
`get_webview_window("traymenu")`가 `None`이고 CDP 타깃도 없었다. 원인: 창을
`visible(false)`로 만들면 tao가 생성 직후 포커스 전이를 한 벌 흘리는데, 그
`Focused(false)`를 blur=닫기 규칙이 그대로 받았다. 오류도 로그도 없이 사라진다.
`.focused(false)`로 만들고, blur 소멸은 **`menu_resize`가 실제로 보여준 뒤부터**
(`MENU_SHOWN`) 걸게 고쳤다.

---

## 5. 창당 비용 — 프로세스 회계 (`--only=cost`)

**MB는 재지 않았다**(§맨 위 측정 조건). 재는 것은 "창 종류를 추가하면 WebView2 프로세스가
느는가" = `shared_env`가 성립하는가다.

| 단계 | 프로세스 | 문서(페이지) | 역할 |
|---|---|---|---|
| 메인 창만 | **5** | 1 | browser ×2 · crashpad-handler · renderer · utility |
| + 팝아웃 창 | **5** (Δ0) | 2 | 〃 |
| + 토스트 창 | **5** (Δ0) | 3 | 〃 |
| + 트레이 메뉴 창 | **5** (Δ0) | 3\* | 〃 |

`\*` 트레이 메뉴 창은 blur=닫기라 스냅샷(2.5s 정착) 전에 스스로 닫힌 회차다. 같은 하네스의
직전 주행에서는 4페이지로 찍혔고, **프로세스 수는 두 회차 모두 5로 불변**이다.

즉 창 하나가 데려오는 것은 **그 문서의 DOM/힙뿐**이고 브라우저·GPU·유틸 프로세스는
공유된다. 세 모듈 전부 `shared_env`를 거치는 게 그 이유다 — 빠뜨리면 창마다
`CreateCoreWebView2EnvironmentWithOptions`가 새로 돌아 런타임이 통째로 복제된다
(그게 2.6.2의 창당 110.7MB 자리).

---

## 6. 방어 계약 — 새 창 종류에 유리·크래시가 걸리나 (`--only=defense`)

계약은 "모든 창은 `shared_env` + 방어 대상"이다. 넷을 나눠서 적는다.

| 창 | `shared_env` | 유리(glass) | 크래시(crash) | 근거 |
|---|---|---|---|---|
| 메인 | ✅ | `arm` + 부팅 스냅샷 | `arm` + `note_page_load` | 기존 |
| 추가 채팅 | ✅ | `arm` + `note_document` | `arm` | 기존 |
| **팝아웃** | ✅ | **`arm` + `note_document` + 부팅 스냅샷** | **`arm` + 재생성 편입** | 아래 D1·D2·D4 |
| **토스트 / 트레이 메뉴** | ✅ | ✗ (불투명 카드 — 아크릴을 안 건다) | ✗ **의도적 예외** | 아래 |

**토스트·트레이 메뉴에 `crash::arm`을 안 거는 이유**는 둘이고, 둘 다 적어 둔다:
1. 오버레이의 올바른 복구는 "다시 세운다"가 아니라 **"치운다"**이다.
2. `note_page_load`를 그 창에서 부르면 **토스트 로드가 메인 창의 복구 검증을 통과시킨다**
   (crash.rs의 2순위 신호 오염). 대신 `win::reset_shown()`이 복구 시작 시 이 창들을
   파기·정리 대상에 넣는다.

### 실측

| # | 관측 | 값 |
|---|---|---|
| D1 | 팝아웃 창 문서에 유리 부팅 스냅샷이 실린다 | `{ok:true, windows:1, backdrops:[3]}` |
| D2 | **DWM 백드롭 실측**(`DwmGetWindowAttribute(38)`) | `"패널 — AgentCodeGUI"` → **3** · `"AgentCodeGUI3"` → **3** (= `DWMSBT_TRANSIENTWINDOW`) |
| D3 | 팝아웃 창을 띄운 채 `Page.crash` → 복구 | 로그: `process-failed ×2 → recover-begin → reloaded ×2 → page-load ×2 → mounted → recover-done` |
| D4 | 복구 뒤 팝아웃 창 생존 | `#mapanel` 타깃 존재 |

`reloaded ×2` = 두 창 모두 문서를 다시 세웠다. 이 경로에서 팝아웃은 `hydrate`가
**마지막 페르시스트**를 돌려주므로 재로드가 스레드를 한 세대 되돌리지 않는다(§2.3).

---

## 7. A/B 캡처 — 도달 실패였던 것들 개통

`node bench/ab.mjs <app> --only=multi-panel-ghost-popped,panel-window,toast-single,toast-aggregate --merge`

| 화면 id | 2.6.2 | 3.0.0-beta.1 |
|---|---|---|
| `multi-panel-ghost-popped` | OK 1764ms | **OK 1801ms** |
| `panel-window` | OK 3796ms | **OK 3774ms** |
| `toast-single` | **FAIL** — `toast 창 미생성` (diag `focus:false, vis:visible`) | **OK 4319ms** |
| `toast-aggregate` | **FAIL** — `waitForWindow timeout: toast.html` | **OK 5569ms** |

- 3.0 인벤토리: **48 → 52 성공**(시도 51 · 실패 3 = `viewer-image`·`viewer-html-preview`·
  `viewer-svg-preview` — M6 영역, 이 라운드 범위 밖).
- **토스트는 픽셀 쌍이 없다.** 2.6.2 쪽이 같은 하네스에서 토스트를 못 띄운다(위 diag를
  `bench/shots/electron/report.json`에 그대로 남겼다). 원인 추적은 2.6.2 소스 영역이라
  이 라운드에서 하지 않았다 — **3.0 단독 캡처**로만 남긴다.
- 두 report.json 모두 `--merge`로 **추가만** 됐다(기존 항목 제거 0 · 판정 뒤집힘 0, 확인함).

---

## 8. 게이트 — `poc-live-chat` 유지

같은 exe로 $0 단계 6개 전부 재실행:

| 단계 | 판정 |
|---|---|
| `r81` (session-wins 브로드캐스트 원천) | PASS |
| `dialog` (폴백 확인 카드) | PASS |
| `winsave` (추가 채팅 창 영속) | PASS |
| `events` + `error` (EngineEvent 9종 · 오류 말풍선) | PASS |
| `reload` (부팅 재장전 · 한도 이어서) | PASS |
| `slots` (`win:chat-*` 4채널 + `chat:windows`) | PASS |

산출물 `docs/critic/m3-r4-live-m8-*.json`.

---

## 9. 하네스 — `scripts/poc-winsurface.mjs` (신설)

```
node scripts/poc-winsurface.mjs                 # 전부
node scripts/poc-winsurface.mjs --only=popout|toast|tray|cost|defense
node scripts/poc-winsurface.mjs --tag[=s]       # 동시 주행(홈·포트 9381~9385·산출물 분리)
node scripts/poc-winsurface.mjs --exe=…         # 고정 바이너리(같은 레포에서 다른 라운드가
                                                #  exe를 다시 굽는 중이어도 안 흔들린다)
```

- 안전 규칙 준수: **이름 기반 kill 금지**(spawn한 PID 트리만) · 실홈은 읽기/복사만
  (engines 정션 없음 — 가짜 CLI를 격리 홈에 직접 꽂는다) · `CCG_HOME` 격리 ·
  OS 입력(`EnumWindows`/foreground)은 우리가 띄운 hwnd에만.
- `--only=tray`는 Win32 `EnumWindows`로 **창의 가시성**을 직접 읽는다 — "숨었다"를
  렌더러 말이 아니라 OS 사실로 판정하기 위해서다.
- 산출물 `docs/critic/m8-r1-winsurface.json`.

---

## 10. 아직 없는 것 (다음 라운드 재료)

| # | 무엇 | 무게 | 사정 |
|---|---|---|---|
| 1 | **트레이 풍선 안내** — 2.6.2는 처음 숨을 때 `tray.displayBalloon("앱이 트레이에서 계속 실행돼요")`를 한 번 띄운다 | 중 | Tauri `TrayIcon`에 대응 API가 없다(`tray_icon` 크레이트에도). `Shell_NotifyIcon(NIM_MODIFY, NIF_INFO)`를 직접 부르려면 트레이 hwnd/uID가 필요한데 `with_inner_tray_icon()`이 그걸 안 준다. **X가 종료가 아니게 된 것을 사용자에게 알리는 유일한 안내가 지금 없다.** |
| 2 | **설정 UI 토글** — `tray.closeToTray`는 Rust가 읽지만 Settings에 스위치가 없다 | 중 | app/은 이번 라운드 "진입 최소 수정" 범위. 값은 `ui-prefs.json`에 손으로 넣으면 먹는다(기본 on) |
| 3 | **팝아웃 창은 앱 재시작을 넘지 않는다** | 낮음 | 2.6.2도 같다. 보드가 자리를 기억하므로 되만드는 경로는 열려 있다 |
| 4 | **턴 종료 600ms 안에 창을 닫으면 복귀분이 부트 상태** | 낮음 | 2.6.2부터의 규약(창의 페르시스트가 디바운스). 관측면은 만들어 뒀다 — `win:surface-debug.popout.flushes[].messages` |
| 5 | **A/B `tray-menu`** 화면은 여전히 skip | 낮음 | OS 이벤트 합성 불가(두 앱 공통). 대신 `--only=tray` R4가 같은 창을 실측한다 |
| 6 | **A/B `panel-window-viewer`** 여전히 skip | 낮음 | 팝아웃 창엔 탐색기가 없어 파일 진입점이 스레드의 파일 링크뿐 — 그 링크를 만들려면 그 패널에서 실행 턴이 필요 |
| 7 | **토스트 A/B 픽셀 쌍 없음** | 낮음 | §7 — 2.6.2 쪽 하네스 도달 실패 |
| 8 | **트레이 아이콘 우클릭 자체**는 코드 대조 | 낮음 | §4.3 주의 참고 |
| 9 | **다중 모니터 DPI 혼합**에서 토스트 자리 | 낮음 | 작업 영역은 커서 모니터의 배율로, 창 크기는 그 창의 배율로 환산한다. 배율이 다른 두 모니터를 오갈 때의 오차는 안 쟀다 |

---

## 11. 경계 준수

만진 파일: `src-tauri/src/{popout,notify,tray}.rs`(신설) · `win.rs` · `crash.rs` ·
`ipc/windows.rs` · `main.rs`(3줄) · `src-tauri/Cargo.toml` ·
`scripts/poc-winsurface.mjs`(신설) · `docs/m8-report-r1.md` ·
`docs/critic/m8-r1-winsurface.json` + `m3-r4-live-m8-*.json`(게이트 증거) ·
`bench/shots/{tauri,electron}/report.json`(병합).

캡처 PNG 4장(`panel-window`·`toast-single`·`toast-aggregate`·`multi-panel-ghost-popped`)은
**커밋에 없다** — `bench/shots/**.png`는 `.gitignore` 대상이다(레포 정책). 디스크에는
`bench/shots/{tauri,electron}/`에 있고, `report.json`에 성공·소요 시간이 남는다.

`Cargo.lock`도 **커밋에 없다.** 지금 워킹 트리의 lock에는 M7(LSP)의 `ccg-lsp` 항목이 섞여
있어서 내 hunk만 떼어낼 수 없다. tauri feature 추가분(`tray-icon`·`image-png` → `image`·
`png`·`tray-icon` 등)은 다음 빌드가 lock에 채운다(`--locked` 빌드는 이 커밋 단독으로는
실패한다는 뜻 — 다음 커밋자가 lock을 함께 올린다). 같은 이유로 `src-tauri/Cargo.toml`은
**내 hunk만 스테이징**했다(M7의 `ccg-lsp` 의존 줄은 워킹 트리에 그대로 남겨 뒀다).

**`app/`은 한 줄도 안 고쳤다.** 렌더러의 팝아웃·토스트·트레이 배선이 이미 완전했기
때문이다 — 이번 라운드에서 고칠 것이 없었다는 사실 자체가 관측 결과다.

`crates/` · `engine/` · `ipc/mod.rs`는 만지지 않았다. `main.rs`는 경계 목록에 없지만
3줄을 고쳤다: 홈 잠금 실패 분기가 그 파일에 있어서(§4.2), 두 번째 인스턴스 신호를
보낼 자리가 거기밖에 없다. 추가만 하는 diff다.

> 이 라운드 내내 M7(LSP)·M4(Codex)가 같은 워크스페이스를 편집하고 있었고, 그쪽의 과도
> 상태로 **빌드가 3회 막혔다**(`ccg_lsp` 미링크 · `IdentityDefaults` 필드 불일치).
> 그때마다 기다렸다 다시 빌드했고, 측정은 내 코드가 들어간 스냅샷 exe
> (`target/release/agentcodegui-m8.exe`)로 고정해서 돌렸다.

---

# §R2 — 크리틱 판정 대응 (2026-08-23)

크리틱 `docs/critic/m8-r1.md`의 판정은 **조건부 확인**이었다: 세 표면은 서고 32/32 재현되지만,
행복 경로 바로 옆에 **완료된 답변이 조용히·영구히 사라지는 자리**가 하나 있고(S1),
X가 종료가 아니게 됐는데 **알릴 수단도 끌 수단도 없다**(S2 → 무게 「상」).
자기 채점은 하지 않는다. 아래 수치는 전부 **크리틱의 도구**(`docs/critic/tools/critic-m8-attack.mjs`)와
**보강한 내 하네스**(`scripts/poc-winsurface.mjs`)의 출력이다.

측정: 격리 워크트리 + 격리 `CARGO_TARGET_DIR`, `npm run tauri:build`.
작업 중 HEAD가 `39e119d` → **`a6fcdba`**(M4 R2 · M-UI 크리틱 · M7 R2 착지)로 움직였다.
`git diff 39e119d..a6fcdba -- src-tauri/src/{win,popout,notify,tray}.rs ipc/windows.rs main.rs
app/src/components/{MultiAgent,PanelWindow}.tsx app/src/{toast,tray}.ts` = **`main.rs` 6줄뿐**
(M7의 `ipc::boot_prewarm()` 호출) — M8 면은 그 사이 안 바뀌었다. 그래도 **최종 수치는 전부
`a6fcdba` + 내 diff로 다시 빌드해 다시 쟀다**(`%TEMP%\ccg-m8r2b-wt`).
실 레포의 기준 산출물은 **한 개도 안 건드렸다**(R2 결과는 `m8-r2-*.json`).

## R2-0. 결과 한 장

| 항목 | R1 | R2 |
|---|---|---|
| **S1** 팝아웃 닫기 = 답변 소실 | 4/4 소실(디스크 확인) | **소실 0** — 화면·디스크 모두 마커 3/3 보존 |
| **S2/X** X=숨김 안내 | 없음 | 첫 숨김 안내 카드(클릭=복원 · 포커스 안 뺏음 · ko/en) |
| **S2** 다이얼 축소 시 팝아웃 고아 | `popStillOpen=true, ghostAfter=false` | `popStillOpen=false` — 관문이 창을 접는다 |
| **S3** 종료 뒤 트레이 아이콘 잔존 | `OnceLock` = drop 불가 | `tray_icon_app` 히든 창 **1 → 0** 실측(= `NIM_DELETE` 발송) |
| **S4** 트레이만 한국어 | `"lang"` 오독 | `ui.lang=en` → `["Open AgentCodeGUI","Quit completely"]` |
| **S5** `traymenu:resize` 발신자 무검증 | 없음 | 본창이 불러도 메뉴 자리 불변(bounds 동일) |
| **S6** 메뉴 재송신 예산 얇음 | 180/500 두 번 | 180/500/1200 + 마지막 폴백(토스트와 동일) |
| **증거 결함** T6·T4·D3·D1 | 4건 | 4건 전부 눈금 교체 |
| 게이트 `poc-winsurface` | 32/32 | **전 항목 통과 · findings 0**(소실 0 검사 신설 포함) |
| 게이트 크리틱 공격 A1~A9 | 미충족 6건 | **"공격 전부 방어" · findings 0** (`a6fcdba` 최종 회차) |
| 게이트 `poc-live-chat` | PASS | **PASS 6/6 · 결함 0** |

산출물: `docs/critic/m8-r2-winsurface.json`(findings 0) · `docs/critic/m8-r2-attack-recheck.json` ·
`docs/critic/m8-r2-live-gate.json`.

## R2-1. S1 — 팝아웃을 닫아도 답변이 안 사라진다 (치명 · 디스크까지 확인)

두 겹으로 막았다. **한 겹만으로는 규약이 반쪽**이기 때문이다.

**① 복귀분이 라이브를 덮지 못한다** (`app/src/components/MultiAgent.tsx` `applyPanelFlush`).
그리드는 팝아웃이 떠 있는 동안에도 같은 `panelId`의 `ma:event`를 계속 리듀스하는데
(`hub.rs`의 `app.emit` = 전 창 브로드캐스트), 창의 페르시스트는 600ms 디바운스다.
즉 **복귀분의 스레드는 항상 같거나 더 낡았다.** 스냅샷 길이가 라이브보다 짧으면 적용하지
않는다 — 창이 나르는 진짜 값(초안·이미지·큐·메타)은 그대로 적용하고, **스레드는 라이브가 이긴다.**

**② 닫기 전 마지막 저장 요청** (`src-tauri/src/popout.rs` `flush_before_close`).
`ipc/windows.rs:22`의 `chat:flush-req`(★R4)가 추가 채팅 창에 세워 둔 규약을 팝아웃에도 건다:
`CloseRequested` → `prevent_close()` → 그 창에 저장 요청 → **140ms 뒤 무조건 `destroy()`**.
수신자는 이미 있다 — `PanelWindow.tsx:146-150`의 `beforeunload` 플러시를 셸이 직접 깨운다
(`app/`은 이번 라운드 경계 밖이라 새 채널·새 렌더러 코드를 만들지 않았다).
**새 실패 모드는 안 만든다**: 유예는 라벨당 한 번(`CLOSING`), 응답을 기다리지 않는 고정 타이머,
종료·크래시 복구 중에는 가로채지 않는다.

실측(크리틱 도구 `--only=a1-mid,a1-end`, 대본이 한 턴을 세 조각으로 뱉는다):

| 회차 | 닫은 시점 | R1 최종 그리드 | R1 디스크 | **R2 최종 그리드** | **R2 디스크** |
|---|---|---|---|---|---|
| a1-end | `MARK-THREE`+`result` 직후 | `ONE · TWO` | `["MARK-ONE","MARK-TWO"]` | **ONE · TWO · THREE** | **ONE · TWO · THREE** |
| a1-mid | `MARK-TWO` 도착 직후(<600ms) | `ONE · THREE`(가운데 구멍) | `["MARK-ONE","MARK-THREE"]` | **ONE · TWO · THREE** | **ONE · TWO · THREE** |

내 하네스에도 같은 검사를 **신설**했다(`--only=loss`, 마커는 `LOSS-*`). 홈 전체(`chats-v3/`·
`chats/`·`boards/`)를 훑어 디스크를 본다.

```
L-end-소실0    { grid: [LOSS-ONE, LOSS-TWO, LOSS-THREE], disk: [LOSS-ONE, LOSS-TWO, LOSS-THREE] }
L-end-flushReq { flushReqs: 1, closeMs: 158 }
L-mid-소실0    { grid: [LOSS-ONE, LOSS-TWO, LOSS-THREE], disk: [LOSS-ONE, LOSS-TWO, LOSS-THREE] }
L-mid-flushReq { flushReqs: 1, closeMs: 158 }
```

`closeMs 158`이 유예의 대가다. 창이 응답을 못 해도 그 타이머가 만료되면 닫힌다 —
"응답 못 하면 안 닫힌다"는 새 실패 모드는 코드에 없다.

> **관측 하나(내 책임 밖, 그러나 남긴다).** a1-end를 R2에서 6회 돌려 5회 통과, 1회
> `MARK-ONE` 누락. 그 회차의 기록은 `popTextAtClose: ["MARK-TWO","MARK-THREE"]`
> — **팝아웃 창 자신이 닫히기 전부터 MARK-ONE을 안 갖고 있었다**(그리고 그 값이 디스크로 갔다).
> 즉 되감기(fold-back) 경로가 아니라 **턴 첫 조각이 렌더러 스레드에 안 들어간** 회차다
> (`gridMsgCount: 4`로 메시지 노드 수는 맞다 = 텍스트가 빈 말풍선). 부하가 걸린 회차였다
> (`closeMs 1029` vs 평시 158). M8 표면이 아니라 이벤트 팬아웃/구독 쪽이라 여기서 고치지 않고
> 사실만 적는다 — 재현 조건: 세 조각 대본 + 동시 빌드 부하.

## R2-2. X = 숨김 안내 (무게 「상」)

`win.rs`의 `CloseRequested`가 `hide()` 직후 `tray::note_first_hide()`를 부른다.
**처음 한 번만**(ui-prefs `tray.noticeShown`), 작업 영역 우하단에 카드가 뜬다.

```
R6-안내           { card: { size: "352x96", title: "안내 — AgentCodeGUI" }, shown: true }
R6-문구           ["앱이 트레이에서 계속 실행돼요 — 눌러서 다시 열기", "완전히 종료"]
R6-포커스탈취없음  { w: 336, h: 87, x: 4776, y: 1290, availLeft: 2560 }   ← hasFocus() = false
R6-복원           첫 행 클릭 → 본창(1336×889) 복귀
R6-소멸           창이 돌아오는 순간 카드가 스스로 사라진다
R6-일회성         두 번째 X에는 안 뜬다
G2-안내언어        ui.lang=en → ["AgentCodeGUI is still running in the tray — click to reopen", "Quit completely"]
```

**크리틱 권장안(A: 토스트 창 재활용)과 다른 페이지를 쓴 이유.** 권장안의 값
(불투명 카드 · 항상 위 · 포커스 안 뺏음 · 클릭=복원 · 창을 되찾으면 스스로 소멸)은 **그대로**
가져왔지만, 렌더링은 `toast.html`이 아니라 `tray.html`로 했다. `toast.html`의
`kindLabel()`은 **채팅 알림 4종의 문구를 하드코딩**한다(`app/src/toast.ts:11-16`) —
시스템 안내를 넣으려면 `NotifyKind`에 `info`를 더해야 하고(크리틱도 "이 한 줄만 `app/`
경계를 넘는다"고 적었다), 이번 라운드는 `app/`이 **M-UI 크리틱의 읽기 대상**이라
`MultiAgent.tsx`의 팝아웃 접점 말고는 손대지 말라는 지시를 받았다. `tray.html`은 문구가
**전부 셸에서 온다**(셸이 준 행 목록을 그리는 것이 전부인 페이지) — `app/` 한 글자 없이 같은 값을 얻는다.
부수 효과로 **2.6.2 풍선보다 낫다**: 풍선은 눌러도 아무 일이 없지만 이 카드는 첫 행이 복원,
둘째 행이 '완전히 종료'다 — 크리틱 §4.1의 *"완전히 종료에 도달하는 정상 경로가 겉보기엔 0개"*를
카드 한 장이 닫는다.

수명은 넷 중 먼저 오는 것: 행 클릭 · 본창 복귀(`show_main`) · 트레이 메뉴 열기(`show_menu`) ·
15초(2.6.2 풍선의 자동 소멸 자리 — 카드에 ✕이 없고 포커스가 없어 Esc도 못 받으므로
아무것도 안 눌린 회차에 **항상 위 카드가 영영 남지 않게** 한다).

`R2-숨김` 판정도 바꿨다. 이제 첫 X에 카드가 하나 뜨므로 "가시 창 0"이 아니라
**"가시 본창 0"**이 규약이다 — `{ alive: true, mainVisible: 0, otherVisible: 1 }`.

**설정 토글은 목록만 한다**(R2-7 #1): `tray.closeToTray`의 Settings 스위치는 `app/` 작업이라
이번 경계 밖이다. 대신 진단면에 값을 실어 뒀다(`win:surface-debug.tray.closeToTray`).

## R2-3. S2 — 다이얼을 줄여도 팝아웃 창이 고아가 안 된다

`reconcileChatRefs`(고아 UI 정리 관문)에 **팝아웃 OS 창**을 등록했다. 자리가 접히면 그 자리의
창도 닫는다 — 닫힘 → `ma:panel-closed` → 복귀분은 접힌 자리로 정상 적용되고(`slotOfPanelId`는
접힘을 안 본다), 그 닫기도 R2-1의 저장 요청을 타므로 **데이터는 잃지 않는다.**

```
A2-자리정리 { popStillOpen: false, ghostAfter: false }        (R1: true / false = 고아)
A2-닫은뒤   { leftovers: [], windows: ["main"] }
A2-되올림   titles ["새 작업","축소 대상","새 작업","새 작업"]    ← 되올리면 그 자리가 그대로 돌아온다
```

## R2-4. S3 — 종료 전에 트레이 아이콘을 실제로 놓는다

`static TRAY: OnceLock<TrayIcon>` → `Mutex<Option<TrayIcon>>`. 그런데 **그것만으로는 안 된다** —
실측으로 확인했다: 우리 static만 비웠을 때 `present()`는 false로 떨어졌지만
`tray_icon_app` 히든 창은 **그대로 살아 있었다**(= `NIM_DELETE` 미발송). 참조가 둘이기 때문이다.
`release_icon(app)`은 둘 다 놓는다 — 우리 static + `app.remove_tray_by_id("ccg-tray")`
(tauri가 `manager.tray.icons`에 쥔 사본).

부르는 자리는 `main.rs`의 `RunEvent::ExitRequested`(정상 종료 갈래) **하나**다.
`quit()`에서 부르지 않는 이유: `menu_action`은 `ipc_call`(async 커맨드) = tokio 워커이고,
`TrayIcon::drop`은 `Shell_NotifyIcon(NIM_DELETE)` **다음에 `DestroyWindow(자기 히든 창)`**를
부르는데 그 호출은 창을 만든 스레드에서만 성공한다(tray-icon 0.24 `windows/mod.rs:305-318`).
`ExitRequested` 핸들러가 그 스레드다.

관측면(프로세스가 죽은 뒤에는 알림 영역을 볼 수 없으므로, **살아 있는 동안** 종료가 부르는
바로 그 함수를 진단 채널 `win:surface-debug ["tray-release"]`로 태운다):

```
R7-아이콘해제 { trayIconWindows: "1 → 0", before: true }
```

클래스 `tray_icon_app` 창이 사라졌다 = `Drop`이 `DestroyWindow`까지 돌았다 = 그 바로 앞줄인
`NIM_DELETE`가 나갔다. 열거만 하는 관측이다(explorer 메모리 접근·클릭 합성 없음).

## R2-5. S4 · S5 · S6

- **S4 — `ui.lang`**: `tray.rs`가 읽던 `"lang"`은 3.0 어디에도 없는 키였다. `en_ui()` 한 함수로
  묶어 `"ui.lang"`을 읽는다(라벨이 늘어도 키가 두 벌이 되지 않게). `A7-언어`·`G1-메뉴언어`
  둘 다 `["Open AgentCodeGUI","Quit completely"]`.
- **S5 — 발신자 검증**: `traymenu:resize`에 2.6.2 `index.ts:853`의 가드를 복원했다. 두 카드 창이
  같은 페이지를 쓰므로 **라벨로 갈라** 각자에게 보낸다(`MENU_WIN` → `menu_resize`,
  `NOTICE_WIN` → `notice_resize`, 그 외 무시). 회귀 감시로 `traymenu:action`도 함께 잰다.
  `R4-발신자가드`: 본창이 `resize(640)`을 불러도 메뉴 bounds `218×87 @(4323,1217)` 불변.
  `R4-액션가드`: 본창의 `action('quit')`으로 앱이 안 죽는다.
- **S6 — 재송신 예산**: 트레이 메뉴 `traymenu:show`를 토스트와 같은 예산으로 맞췄다
  (180/500 → **180/500/1200 + 마지막 시도 폴백**). 폴백이 없으면 페이지가 높이를 못 보낸 회차에
  **보이지 않는 창**이 남는다 = '완전히 종료'로 가는 유일한 문이 막힌 상태다.
  `A9-메뉴 { rounds: 12, maxRowMs: 187 }` — 빈 카드 0회.

## R2-6. 증거 결함 4건 + 크리틱 하네스가 새로 잡아낸 것

크리틱 §6이 지적한 넷을 `poc-winsurface`에서 **눈금째** 교체했다.

| # | R1이 잰 것 | R2가 재는 것 |
|---|---|---|
| T6 | 바로 앞 T5의 클릭이 목록을 이미 비운 뒤라 **포커스 소멸 경로가 한 번도 안 돌았다** | 클릭 뒤 **새 알림 2건을 다시 넣고**, 클릭 없이 본창만 복원해서 잰다 → `T6-포커스소멸 { before: 2, pending: 0 }` (클릭 소멸은 `T5-클릭소멸`로 분리) |
| T4 | `screenX`(가상 좌표) vs `availWidth`(모니터 폭) → 보조 모니터에서 항상 실패 | `screen.availLeft/availTop`으로 **모니터 로컬 좌표** 환산 → `x:4752 availLeft:2560 → local.x:2192`, `2192+360 ≤ 2560` ✓ |
| D3 | `findTarget('index.html')`이 **팝아웃**을 집었다(메인 URL엔 `.html`이 없다) | `mainTarget()` = URL에 `.html`이 없는 페이지 |
| D1 | 부팅 스냅샷 `windows:1`은 `glass::arm`보다 **앞**에서 찍혀 아무것도 증명 못 한다 | 팝아웃을 **둘** 열고 두 번째 창의 스냅샷을 본다 → `D1b-유리arm { pop1: 1, pop2: 2, backdrops: [3,3] }` |

하나 더 갈았다(크리틱 목록 밖, 같은 종류의 결함이라 남긴다): **`T1-포커스억제`가
`document.hasFocus()`로 판정했다.** 제품이 쓰는 술어는 셸의 `w.is_focused()`
(= `GetForegroundWindow`)인데 둘이 어긋나는 회차가 실제로 있었다(페이지 true / 셸 false →
토스트가 정상적으로 떴는데 검사만 "억제 실패"). 진단면에 `win:surface-debug.mainFocused`를
열고 **제품이 보는 값**을 폴링하도록 바꿨다. 덤으로, 최소화 창 복원이 CDP
`Page.bringToFront`만으로는 회차에 따라 안 먹어 `Focused(true)` 에지가 안 나는 문제도
`restoreMain`(우리 hwnd에만 `ShowWindow(SW_RESTORE)` + `SetForegroundWindow`)으로 없앴다.

**크리틱 하네스가 새로 잡아낸 것 — `notify::ensure` 경합(고쳤다).**
크리틱 §3.5는 *"`push()→ensure()` 경합은 코드상 존재하지만 4가지 지연으로 밀어도 재현되지
않았다 — 결함으로 세지 않는다"*고 적었다. **R2 회차에 실제로 터졌다.** `notify:event`는
async 커맨드라 10건이 **동시에** 들어오고, `ensure()`의 "창이 있나?"와 `build()` 사이가 벌어져
같은 라벨로 창이 둘 만들어진다. tauri 레지스트리에는 나중 것만 남고 먼저 것은 **아무도 모르는
고아 창**이 된다 — 항상 위 · 빈 카드 · `notify:show`를 영영 못 받고 · 목록이 비어도 안 부서진다.

```
(고치기 전) A4-행수 ✗ 10건인데 행이 0개   ·  A4-포커스소멸 ✗    ← 셸 회계는 count:10 window:true loaded:true
            bounds { w:360, h:120, x:268, y:261 }               ← 기본 크기·기본 자리 = resize를 한 번도 안 받은 창
(고친 뒤)   A4-행수 ✓ { rows: 10 }        ·  A4-포커스소멸 ✓ { pending: 0 }    3/3 재현
```

`push()` 전체를 한 자물쇠 아래로 넣었다(`notify.rs PUSH_LOCK`). 같은 종류의 경합이 카드 창
쪽에도 있어 `show_menu`에도 걸었다(`tray.rs SHOW_LOCK`). 회귀 감시는 내 하네스 `T7`이다 —
폭주 10건에 **문서가 하나인가**(`T7-창하나`)까지 센다.

**주의 — 크리틱 A4-자리는 커서 위치에 따라 흔들린다(제품이 아니라 눈금이).**
최종 회차는 "공격 전부 방어"(findings 0)로 끝났지만, 중간 회차에서 `A4-자리`가 두 번 ✗로
찍혔다. 크리틱이 자기 리포트 §6-3에 *"내 하네스도 같은 실수를 했고 §3.5에서 정정"*이라고
적어 둔 바로 그 자리인데 **코드에는 정정이 안 들어갔다**. 같은 창을 두 눈금으로 잰 값이다:

```
커서가 보조 모니터(DISPLAY1, x=2560~)에 있는 회차
  크리틱 A4 : { w:360, h:410, x:4752, y:967, availW:2560, availH:1392 }      → ✗ (x + w − availW = 2552)
  내   T7  : { w:360, h:410, x:4752, y:967, availW:2560, availH:1392,
               availLeft:2560 } → local { x:2192, y:967 }                    → ✓ (2192 + 360 = 2552 ≤ 2560)
커서가 주 모니터에 있는 회차
  크리틱 A4 : { x:2192, availLeft:0 }                                        → ✓  (최종 회차가 이것)
```

**같은 픽셀**이다. `screenX`는 가상 데스크톱 좌표, `availWidth`는 그 모니터의 폭이라
보조 모니터에서는 항상 어긋난다. 제품의 자리 계산은 두 모니터 모두에서 맞고, 내 `T4`·`T7`은
`availLeft/availTop`으로 환산해 **커서가 어디 있든** 같은 답을 낸다.

## R2-7. 남은 것

| # | 무엇 | 무게 | 사정 |
|---|---|---|---|
| 1 | **설정 › 트레이 스위치**(`tray.closeToTray`) UI | 중 | 안내와 옵트아웃은 한 쌍이라는 크리틱 §4.2 지적이 맞다. `app/`이 이번 경계 밖(M-UI 크리틱 진행 중)이라 **목록화만** 한다. 값은 지금도 `ui-prefs.json`으로 먹고 진단면에도 실린다 |
| 2 | **`crash::teardown_and_exit`의 아이콘 해제** | 낮음 | 그 경로는 `std::process::exit(0)`이라 `ExitRequested`를 안 탄다 → 아이콘이 남는다. `crash.rs`가 이번 경계 밖이라 한 줄을 못 넣었다(크래시 포기 경로 전용) |
| 3 | **`win:surface-debug` 채널 잠금** | 낮음 | 크리틱 §5.3 — 계약면 밖 진단 채널인데 게이트가 없다. `["tray-release"]`가 하나 늘었다(하네스 전용). `CCG_*`나 디버그 빌드로 잠그는 게 맞다 |
| 4 | **`toast.html`의 시스템 안내 문법** | 낮음 | `NotifyKind`에 `info`가 생기면 안내를 토스트로 합칠 수 있다(카드 두 종류가 하나로). `app/` 라운드의 재료 |
| 5 | **턴 첫 조각이 렌더러에 안 들어간 회차** | 중 | R2-1 말미의 관측(6회 중 1회). M8 표면이 아니라 이벤트 팬아웃/구독 쪽 |
| 6 | **`notify::ensure`의 "파기 대기 중" 갈래** | 낮음 | `PUSH_LOCK`이 막은 것은 **동시 생성**이다. 크리틱이 원래 지목한 *"파기가 이벤트 루프로 넘어간 사이 `ensure`가 '있다'고 조기 반환"*은 여전히 코드상 가능하다(R1·R2 모두 미재현) |
| 7 | 다중 모니터 **DPI 혼합** | 낮음 | R1 §10 #9 그대로. 배율이 다른 두 모니터를 오갈 때의 오차는 안 쟀다(이번 기계는 두 모니터 DPI 동일) |

## R2-8. 경계 준수

만진 파일: `src-tauri/src/{tray,notify,popout,win}.rs` · `src-tauri/src/ipc/windows.rs` ·
`src-tauri/src/main.rs`(2줄: `|_app|`→`|app|`, `release_icon(app)`) ·
`app/src/components/MultiAgent.tsx`(**팝아웃 접점 2곳만** — `applyPanelFlush` 길이 가드,
`reconcileChatRefs` 팝아웃 등록) · `scripts/poc-winsurface.mjs` · `docs/m8-report-r1.md`(이 절) ·
`docs/critic/m8-r2-*.json`(신규 3개).

- `crates/` · `engine/` · `crash.rs` · `ipc/mod.rs` · **다른 `app/` 파일** 수정 0.
- 크리틱의 기준 산출물(`docs/critic/m8-r1.md` · `m8-r1-winsurface.json` · `m8-r1-attack.json` ·
  `tools/critic-m8-attack.mjs`) **미변경** — 모든 실행은 격리 워크트리에서 했고, 결과는
  `m8-r2-*.json`으로 따로 떨어뜨렸다.
- 안전: 이름 기반 kill 0회(죽인 것은 `killTree(child.pid)`뿐) · `CCG_HOME` 전부 격리 ·
  실홈 무접촉 · OS 입력(`ShowWindow`/`SetForegroundWindow`)은 **우리가 띄운 hwnd에만**
  (하네스 `restoreMain`이 제목으로 우리 본창을 찾아 건다) · 알림 영역은 **EnumWindows 열거만**.
- `npm ci`를 돌리지 않았다. `node_modules`는 실 레포 것을 정션으로 걸어 썼다.
- 메모리는 재지 않았다(동시 주행 노이즈 — R1과 같은 규약).

> 이 라운드에도 M7(LSP)·M4(Codex)가 같은 워크스페이스를 편집 중이라 실 워킹 트리가 한 번
> 컴파일 불가 상태였다(`ccg-lsp`의 `hover`/`definition` 시그니처 과도기 — `lib.rs`가 아직
> 3인자였다). 그래서 **모든 빌드·측정을 격리 워크트리**에서 했다. 착수 핀(`39e119d`)
> 워크트리에서는 M7이 새로 만든 `ipc::boot_prewarm()` 호출만 빌드용으로 걷어 냈고
> (내 경계 밖 줄 — 실 레포 파일은 손대지 않았다), 그쪽이 착지한 뒤에는 **`a6fcdba` 워크트리에서
> 그 줄까지 포함해 그대로 빌드**해 세 게이트를 다시 돌렸다. 위 수치는 전부 후자다.
