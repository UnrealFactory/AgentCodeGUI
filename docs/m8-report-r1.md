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
