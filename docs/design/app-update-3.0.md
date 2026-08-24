# 3.0 앱 자동 업데이트 — 설계안 (**구현 전 · 사용자 결정 대기**)

작성: M12 R2 · 2026-08-24 · `feature/3.0.0-beta`
상태: **설계만.** 코드는 한 줄도 넣지 않았다. 아래 §6의 결정 세 개가 나오기 전에는
어느 쪽으로도 못 간다 — 특히 서명은 **돈이 드는 결정**이라 대신 고를 수 없다.

근거: `docs/critic/final-parity-r1.md` §3.2 H3 · §4.5 · `docs/m12-report-r1.md` §7-8 ·
`src/main/updater.ts`(2.6.2 구현) · `tauri-plugin-updater` 2.10.1 소스 실측.

---

## 0. 지금 상태 — 화면은 다 있는데 뒤가 비었다

| 층 | 2.6.2 | 3.0 |
|---|---|---|
| 렌더러 카드 | `AppUpdateGate` (사이드바 하단 유리 카드) | **그대로 이식됨** (`app/src/components/AppUpdateGate.tsx`) |
| 계약면 | `app:update-status` · `app:update-check` · `app:update-install` · `app:update-event` | **네 채널 다 선언돼 있다**(`src/shared/protocol.ts:1227-1233`) |
| 백엔드 | `electron-updater` (`src/main/updater.ts`, GitHub 릴리즈 피드) | **없다.** `ipc/app_meta.rs:18`이 항상 `phase:"idle"`을 돌려준다 |
| 적용 중 화면 | PowerShell + WPF 스플래시(앱 밖 프로세스) | 없다 |

즉 **UI와 계약은 이미 서 있고 백엔드만 비었다.** 어느 방식을 고르든 렌더러는
`UpdateStatus{phase, version, percent, log, error}` 다섯 필드를 채워 주면 그대로 산다.
이건 방식 선택의 자유도를 넓혀 주는 사실이라 먼저 적어 둔다.

> 배포하면 사용자에게 **갱신 경로가 없다**(R1 §3.2 H3). 3.0을 정식으로 내보내기 전에
> 반드시 닫아야 하는 구멍이고, 그래서 이 문서가 있다.

---

## 1. 갈래 A — `tauri-plugin-updater` (공식)

### 1.1 무엇이 필요한가

```jsonc
// src-tauri/tauri.conf.json
"bundle": { "createUpdaterArtifacts": true },      // 산출물마다 .sig 를 같이 만든다
"plugins": {
  "updater": {
    "endpoints": ["https://…/latest.json"],
    "pubkey": "<minisign 공개키>",
    "windows": { "installMode": "passive" }        // 기본값
  }
}
```
빌드 때 `TAURI_SIGNING_PRIVATE_KEY`(+ `_PASSWORD`) 환경변수로 **minisign 개인키**를 준다.
`Cargo.toml`에 `tauri-plugin-updater = "2"`를 더하고 `main.rs`에서 플러그인을 등록한다.

엔드포인트가 돌려주는 매니페스트:

```jsonc
{ "version": "3.0.1", "notes": "…", "pub_date": "…",
  "platforms": { "windows-x86_64": { "signature": "<.sig 내용>", "url": "https://…/AgentCodeGUI3_3.0.1_x64-setup.exe" } } }
```

### 1.2 실측으로 확인한 좋은 소식 — **2.6.2의 detached 함정이 여기엔 없다**

2.6.2가 밟은 사고(메모리에도 남아 있는 「update-splash detached powershell 함정」):

```
· detached: true  → DETACHED_PROCESS(콘솔 없음). powershell.exe는 콘솔 앱이라 기동 자체를 못 한다
· detached 없음   → libuv job object(KILL_ON_JOB_CLOSE)가 앱 종료와 함께 자식을 죽인다
해결: cmd /c 한 다리 → 손자 PS가 SILENT_BREAKAWAY_OK로 job 밖에 남는다 (src/main/updater.ts:210-223)
```

`tauri-plugin-updater`는 설치기를 **`ShellExecuteW`로 띄운다**(`updater.rs:855`, `SW_SHOW`).
`CreateProcess`/`spawn`이 아니라 셸에 위임하는 호출이라 **job object에도 프로세스 트리에도
묶이지 않는다.** 그 직후 `std::process::exit(0)`으로 앱이 내려간다(`updater.rs:865`).
→ 같은 함정을 다시 밟을 일이 없다. Rust에는 애초에 libuv job도 없다.

NSIS 인자도 실측했다(`config.rs:37-45`, `updater.rs:801-816`):

| installMode | NSIS 인자 | 화면 |
|---|---|---|
| `passive`(기본) | `/P /R` + `/UPDATE /ARGS …` | **진행 막대만 뜬다**(마법사 없음) · `/R` = 설치 후 앱 재시작 |
| `quiet` | `/S /R` | 아무것도 안 뜬다 |
| `basicUi` | (없음) | 마법사 |

**따라서 2.6.2의 PowerShell+WPF 스플래시는 3.0에서 필요 없을 수 있다.** `passive`가
NSIS 자체 진행창을 띄우고 `/R`이 다시 켜 주므로, 「화면이 몇 초 비는」 문제가 처음부터
안 생긴다. 그 스플래시는 `/S`(완전 무음) 때문에 생긴 구멍을 메우려고 만든 것이었다.
디자인을 맞추고 싶다면 `on_before_exit` 훅(`updater.rs:288`)이 그 자리를 준다 —
다만 **그때만** 만들자. 안 만들면 8191자 커맨드라인 한계·EncodedCommand 7.1k 같은
2.6.2의 부채를 통째로 안 물려받는다.

### 1.3 대가

- **키가 하나 더 생긴다.** minisign 개인키는 Authenticode 인증서와 **별개**다. 잃어버리면
  기존 설치본은 이후 어떤 업데이트도 못 받는다(공개키가 exe에 박혀 있다). 보관 계획이 필요하다.
- 매니페스트를 어딘가에 둬야 한다(GitHub 릴리즈 asset · Pages · 아무 정적 호스팅).
- 플러그인이 프로세스·capability를 더한다 — 이번 라운드의 메모리 목표와 부딪히는지는
  붙여 보고 재야 한다(예상 영향은 작다: 다운로드 시에만 도는 코드다).

---

## 2. 갈래 B — 자체 구현 (계약면 네 채널을 Rust로 채운다)

`app:update-check`가 GitHub Releases API를 읽고, `app:update-event`로 진행을 흘리고,
`app:update-install`이 내려받은 `-setup.exe`를 `ShellExecuteW`로 띄우고 종료한다.

**장점**
- 새 의존성 0, 새 키 0. 무결성은 릴리즈에 같이 올린 **SHA-256**으로 본다.
- 피드 형식을 2.6.2와 나란히 둘 수 있어(§4) 이행기 제어가 쉽다.
- `phase`/`percent`/`log`를 우리가 직접 만드니 카드 문구를 정확히 맞춘다.

**단점 — 정직하게**
- SHA-256은 **변조 방지가 아니다.** 목록과 파일을 같은 곳에서 받으면 그 곳을 잡은
  공격자는 둘 다 바꾼다. 서명(minisign이든 Authenticode든)이 있어야 진짜다.
- 재시도·부분 다운로드·디스크 부족·안티바이러스 격리 같은 잔가지를 전부 우리가 짠다.
  `tauri-plugin-updater`가 이미 겪은 것들이다.
- **갈래 A로 나중에 옮기기 어렵다**: 이미 나간 설치본에 공개키가 없으면, 그 설치본들은
  A 방식 업데이트를 검증할 수 없다. 「일단 B, 나중에 A」는 **한 번의 수동 재설치 요청**을
  동반한다.

---

## 3. 서명 — 두 가지가 얽혀 있다 (섞어 부르지 말 것)

| | 무엇을 지키나 | 없으면 | 비용 |
|---|---|---|---|
| **Authenticode**(코드 서명) | Windows가 exe의 게시자를 확인 | **SmartScreen 「알 수 없는 게시자」** 경고. 배포마다 새 해시라 평판이 안 쌓인다 | OV 인증서 연 십수만 원~ · EV는 더 · 최근엔 하드웨어 토큰 요구 |
| **minisign**(업데이트 서명) | 업데이트 **패키지**가 우리가 만든 것임을 앱이 확인 | 갈래 A 자체가 불가(플러그인이 요구) | 0원(키만 만들면 된다) |

현재 실측(M12 R1 §7-8):

```
AgentCodeGUI3.exe (3.0 설치본)  NotSigned
AgentCodeGUI.exe  (2.6.2 설치본) NotSigned   ← 2.6.2도 원래 서명이 없었다
```

**그래서 SmartScreen은 3.0이 새로 만든 문제가 아니다.** 다만 3.0은 제품명·바이너리
이름이 바뀌어(`AgentCodeGUI3`) 2.6.2가 쌓아 둔 평판을 **승계하지 못한다** — 있었다면.
평판이 파일 해시 단위라 사실상 승계할 것도 없었다(R1 §4.5).

> 정리: **minisign(0원)과 Authenticode(유료)는 별개 결정이다.** 갈래 A를 고르는 것이
> 인증서 구입을 뜻하지 않는다. 반대로 인증서를 사더라도 갈래 A의 minisign 키는 따로 있어야 한다.

---

## 4. ★ 이행기의 진짜 함정 — 2.6.2가 3.0을 「업데이트」로 먹으면

2.6.2는 `electron-updater`로 GitHub 릴리즈(`UnrealFactory/AgentCodeGUI`)의 **`latest.yml`**을
읽고, 새 버전이 보이면 **자동으로 내려받아**(`autoDownload = true`, `updater.ts:58`) 카드를 띄운다.

같은 저장소에 3.0 릴리즈를 올리면서 `latest.yml`을 갱신하면:

1. 사용자의 2.6.2가 3.0 설치본을 자동으로 받는다.
2. 「업데이트」 버튼을 누르면 3.0 NSIS가 `/S`로 돈다.
3. 3.0은 제품명·설치 폴더가 **다르므로** 2.6.2를 덮지 않고 **옆에 깔린다**.
4. 결과: 앱이 둘이 되고, 2.6.2는 자기가 최신이라고 믿으며 계속 그 자리에 남는다.
   게다가 3.0 설치본에는 `latest.yml`이 없으니 2.6.2는 **매 실행마다 같은 것을 또 받는다.**

**처방(구현 전이라도 지금 정해 둘 것)**
- 3.0은 **다른 릴리즈 채널**에 올린다(별도 저장소 / 다른 태그 접두사 / 릴리즈 asset 이름 분리).
  적어도 `latest.yml`은 **2.6.2 계열 버전만** 가리키게 유지한다.
- 2.6.2 → 3.0 이행은 **자동 업데이트가 아니라 안내**여야 한다. 3.0은 큰 이사고(§패치노트
  3.0.0 참조), 무엇보다 사용자가 **둘을 나란히 두고 천천히 옮기도록** 이번 라운드가
  아이콘·메뉴 글자·설치 폴더·레지스트리 키를 전부 갈라 뒀다. 자동 업데이트는 그 설계와 충돌한다.
- 3.0 정식이 안정되고 나서, 2.6.2에 **마지막 패치 한 번**(안내 카드 + 수동 링크)을 내는 편이
  자동 치환보다 안전하다. → 이것도 사용자 결정이다.

---

## 5. 어느 쪽이든 공통으로 필요한 것

1. `ipc/app_meta.rs`의 `phase:"idle"` 상수를 실제 상태 기계로 교체(채널 4개 배선).
2. 백그라운드 자동 다운로드 + `app:update-event` 진행 스트림(카드의 게이지가 그걸 그린다).
3. **종료 시 자동 설치는 켜지 않는다.** 2.6.2가 이미 껐다(`autoInstallOnAppQuit = false`,
   `updater.ts:65`) — 「보이지 않는 설치기 도중 PC가 꺼지면 앱이 삭제되는 사고」가 이유다.
   3.0도 같은 규칙을 이어야 한다.
4. 10분 주기 재확인이 작업 중에 카드를 되띄우지 않게(카드가 이미 그 규칙을 안다 —
   `AppUpdateGate.tsx` 헤더 주석).
5. 하네스: A/B 목록의 `app-update-gate`·`update-splash`는 지금 `skip`이다
   (`bench/screens.mjs`). 백엔드가 서면 **가짜 매니페스트를 가리키는 격리 엔드포인트**로
   `available → downloading → downloaded` 세 화면을 찍을 수 있다. 실 서버를 두드리지 않는다.

---

## 6. 사용자 결정 요청 (셋)

| # | 질문 | 기본 추천 | 왜 |
|---|---|---|---|
| **D1** | 갈래 A(tauri-updater) vs B(자체) | **A** | 설치기 기동 방식이 이미 `ShellExecuteW`라 2.6.2의 함정을 안 밟고, `passive` 모드가 스플래시 부채까지 없앤다. 재시도·검증을 남이 이미 겪었다 |
| **D2** | Authenticode 인증서를 살 것인가 | **지금은 아니다** | 2.6.2도 서명이 없었고 사용자가 그 상태로 써 왔다. 배포 규모가 커질 때 사도 늦지 않다. 단 SmartScreen 경고는 첫 설치마다 나온다는 걸 알고 내보내야 한다 |
| **D3** | 2.6.2 사용자를 자동으로 3.0으로 올릴 것인가 | **아니다(안내만)** | §4 — 자동으로 올리면 두 앱이 공존한 채 2.6.2가 같은 파일을 무한히 다시 받는다. 이번 라운드가 「나란히 두고 천천히」로 설계를 정해 뒀다 |

D1이 A로 결정되면 그 다음 순서는 ① minisign 키 생성·보관 장소 결정 → ② 매니페스트 호스팅
위치 결정 → ③ 배선 + 격리 엔드포인트 하네스다. **결정 전에는 시작하지 않는다.**
