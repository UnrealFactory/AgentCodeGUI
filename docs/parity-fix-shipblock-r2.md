# R28f SHIPBLOCK R2 — 「취소」가 화면을 푼다

대상: R1 확인 크리틱(`90765ad`)이 남긴 **★최대 격차** 하나.

> codex 로그인 「취소」가 `.cmd` 셰임 경로에서 화면을 안 푼다 — 최대 5분간 계정 탭 전체가
> 얼어붙고 손자 프로세스가 앱 종료 뒤에도 산다.

크리틱의 판정 자체는 **옳았다**. 반박하지 않는다 — 내 계기로 내 대조군 exe에서 그대로
재현했다(§2). 이 문서는 그 재현과, 처방과, 처방이 **왜 트리 전체를 죽이지 않는가**의
실측 근거다.

결론 먼저:

| 픽스처 | 대조군(HEAD, `59b743ec…`) | R2(`7a6eccf9…`) |
|---|---|---|
| `.cmd` 셰임 — 취소 후 스피너 | **90초 내내 `spin=1`**(안 풀림) | **518ms에 `spin=0`** |
| 〃 「계정 추가」 / Anthropic 축 「삭제」 | `disabled=[true]` / `[true,true]` | `[false,false]` / `[false,false]` |
| 〃 래퍼 안의 CLI(손자) | 취소 후 생존 · **앱 종료 후에도 생존** | 취소 즉시 0 · 종료 후 0 |
| 네이티브 `.exe` — 취소 후 스피너 | 508ms | 516ms (**파리티**) |
| 깊이 2 「브라우저」 — 취소 후 | 생존(CLI도 같이 생존) | **생존**(CLI만 죽는다) |
| 목록·다른 쓰기 | 2행 유지 · `reorderAccounts` resolve | 동일 |

---

## 1. 안전 규약 — 무엇을 하지 않았나

- 사용자 실홈(`%USERPROFILE%\.agentcodegui`)의 `accounts.json`·`codex-accounts.json`을
  **읽지도 복사하지도** 않았다. 격리 홈(`C:\Temp\ccg-r28f-ship\home-r2-*`)을 계기가 처음부터
  만들고, 계정은 전부 합성(`r2-one@r2.invalid`·`r2-two@r2.invalid`)이다.
- **실 OAuth 왕복은 하지 않았다** — 로그인은 전부 내가 쓴 가짜 CLI다(§2.1).
  브라우저는 한 번도 안 열렸다. → 실 ChatGPT OAuth 왕복은 이 라운드에서도 **미검증**이다.
- 이름 기반 kill 없음. 계기는 자기가 spawn한 PID와, **자기 스텁이 만든 커맨드라인 지문**으로
  찾은 PID만 죽인다. (측정 중 이웃 갈래의 앱이 `*target-r2*` 와일드카드에 걸릴 뻔했다 —
  `target-r28f-m10-crit`가 그 접두사에 걸린다. 지문을 좁혀 다시 쟀다.)
- 이웃 갈래가 워킹트리를 고치는 중이라(`ReloadHold`의 필드 둘이 한동안 안 맞아
  `cargo test`가 `agentcodegui`에서 **컴파일 실패**했다) 빌드·테스트·측정은 전부 **격리
  트리**에서 했다: `git archive HEAD` → `C:\Temp\ccg-r28f-ship\{ctlsrc-r2,fixsrc-r2}` +
  내 파일만 덮어쓰기. 남의 미커밋 변경은 `reset`·`checkout`·`stash` 하지 않았다.
- 대조군과 판정 대상은 **각각 새 `CARGO_TARGET_DIR`**(`target-r2ctl` / `target-r2fix`).
  sha256이 다르고(`59b743ec…` ≠ `7a6eccf9…`) 두 로그 다 `Compiling agentcodegui`가 있다.

## 2. 재현 — 크리틱이 옳았다

### 2.1 계기

`C:\Temp\ccg-r28f-ship\tools-r2\{lib.mjs,cancel.mjs}` — 레포 밖에 새로 썼다.
크리틱의 `tools/`도 R1의 `scripts/poc-shipblock.mjs`도 쓰지 않았다.
가짜 codex CLI 세 갈래(전부 내가 씀):

| `--kind` | 모양 | 무엇을 모델하나 |
|---|---|---|
| `cmd` | `codex.cmd`가 URL을 뱉고 `ping -n 577`로 버틴다 | 전역 npm 셰임 = `cmd /C` 경유 |
| `exe` | 네이티브 `codex.exe`(내가 컴파일)가 URL을 뱉고 600초 잔다 | 앱 관리 설치본 = 직접 스폰 |
| `browser` | `codex.cmd` → `codexcore.exe`(깊이 1) → `ping -n 579`(깊이 2) | 셰임이 CLI를 부르고, **CLI가 브라우저를 연다** |

누르는 순서는 크리틱과 같다: 설정 ▸ Account → OpenAI 「계정 추가」 → 6초 → 「취소」 →
90초 동안 0.5초마다 `.set-spin` 개수를 읽는다.

### 2.2 대조군에서 그대로 났다

```
[ctl-cmd/procDuring]        ["21412:PING.EXE"]
[ctl-cmd/spinTrail]         ["0s:spin=1","10s:spin=1", … ,"81s:spin=1"]
[ctl-cmd/spinnerClearedMs]  null
[ctl-cmd/afterCancel]       addDisabled:[true] · delDisabled:[true,true]
[ctl-cmd/procAfterCancel]   ["21412:PING.EXE"]
[ctl-cmd/orphansAfterAppExit] ["21412:PING.EXE"]
```

크리틱의 표(`spin=1` 90초 · `addDisabled=true` · `PING.EXE` 앱 종료 뒤 생존)와 **한 칸도 안 다르다.**
셸 자체는 안 막혔다는 것도 같이 확인했다 — 취소 뒤 `reorderAccounts`가 `resolve(n=2)`다.

## 3. 기전 — 완료 신호가 **하나뿐**이었다

`pump_login`은 자식의 stdout/stderr를 읽기 스레드로 옮기고, 루프에서
`rx.recv_timeout(deadline까지)`로 잔다. 완료 판정은 **`Disconnected`(= 파이프 둘 다 닫힘)**
하나였다. 그런데 파이프의 쓰기 끝을 쥔 것은 자식만이 아니라 **자식의 후손 전부**다.

```
codex-auth:login ──> cmd.exe (우리 자식, 파이프 상속)
                        └── PING.EXE (손자, 같은 파이프를 상속)
「취소」 → LoginSlot::cancel() → cmd.exe만 kill
        → 손자가 파이프를 쥔 채 산다 → EOF 안 옴 → recv_timeout이 5분(deadline)까지 잔다
        → codex-auth:login IPC가 안 돌아온다 → busy='codex-login' 고정
        → 계정 탭의 **두 축** 버튼이 전부 disabled
```

`busy`가 두 축을 같이 묶는 것은 2.6.2와 같은 모양이라 그대로 뒀다(그 자체는 병이 아니다 —
병은 「취소를 눌러도 안 풀린다」였다).

## 4. 처방 둘

### 4.1 완료 신호를 **둘**로 (`LoginSlot::owns`)

루프가 150ms(`CANCEL_POLL`)마다 깨어 「슬롯에 아직 **내** 자식이 앉아 있는가」를 묻는다.
`cancel()`이 자식을 꺼내 가면 `false` → 즉시 빠져나온다. 「다음 로그인이 시작됐다」도 같은
신호로 덮인다(R1은 그 판에서도 EOF를 기다렸다). 5분 상한의 정확도는 안 흔들린다 —
상한은 `deadline`으로 따로 재고 폴 주기는 `left.min(CANCEL_POLL)`이다.

**이 하나만으로 화면은 풀린다.** 손자를 못 죽이는 판이 또 와도(우리가 예상 못 한 셸 모양)
IPC는 안 선다. 아래 4.2가 실패해도 되는 구조로 둔 것이 요점이다.

### 4.2 죽이는 대상은 「래퍼 + **직속** 자식」 (`kill_wrapped_child`)

`codex_command`가 `cmd /C`를 썼는지를 **한 비트**로 돌려주고(`(Command, bool)`), 그 비트가
자식과 함께 `LoginSlot`에 앉는다. 래퍼 갈래에서 취소는 —

1. `direct_children(cmd.exe의 pid)`를 스냅샷으로 찾고(부모가 **아직 살아 있을 때**),
2. 그것들을 `TerminateProcess`하고,
3. 그 다음 `cmd.exe`를 죽인다.

**왜 트리 전체(`taskkill /T`)가 아닌가.** 로그인 CLI는 브라우저를 **자기가 연다**
(`login()` 헤더의 실측 — "Opening browser to sign in…"). 그 브라우저는 CLI의 자식이므로
트리째 죽이면 사용자가 방금 연 브라우저 창이 같이 죽는다(그때 처음 뜬 인스턴스면 창이
통째로 사라진다). 그리고 네이티브 `.exe` 갈래는 `Child::kill()`이 CLI만 죽이고 브라우저는
안 건드린다 — `cmd /C`는 **우리 구현의 사정**이지 사용자의 것이 아니므로, 두 갈래가
대칭이 되는 지점이 정확히 **깊이 1**이다.

이 선택을 문장이 아니라 실측으로 세웠다 — §5의 마지막 줄.

`codex logout`의 상한 초과 경로(`wait_or_kill`)도 같은 규칙을 쓴다.

## 5. 실측 — 네 갈래

| 주행 | spinnerClearedMs | addDisabled | delDisabled | 손자(취소 후) | 앱 종료 후 |
|---|---|---|---|---|---|
| `ctl` `.cmd` | **null**(90초) | `[true]` | `[true,true]` | `PING.EXE` 생존 | `PING.EXE` 생존 |
| **`fix` `.cmd`** | **518** | `[false,false]` | `[false,false]` | **0** | **0** |
| `ctl` `.exe` | 508 | `[false,false]` | `[false,false]` | 0 | 0 |
| **`fix` `.exe`** | **516** | `[false,false]` | `[false,false]` | 0 | 0 |
| `ctl` `browser` | **null**(90초) | `[true]` | `[true,true]` | `codexcore.exe` 생존 | CLI·브라우저 둘 다 생존 |
| **`fix` `browser`** | **512** | `[false,false]` | `[false,false]` | **CLI 0** | **브라우저만 생존** |

마지막 두 줄이 §4.2의 근거다:

```
[fix-browser/procDuring]         ["23468:cmd.exe","12656:codexcore.exe"]   ← 래퍼 + CLI
[fix-browser/browserDuring]      ["27476:PING.EXE"]                        ← CLI가 연 「브라우저」
[fix-browser/procAfterCancel]    []                                        ← 래퍼·CLI 죽음
[fix-browser/browserAfterCancel] ["27476:PING.EXE"]                        ← ★브라우저는 산다
```

목록·다른 쓰기·폴백 링크는 여섯 주행 모두 정상이다
(`rows=[r2-one,r2-two]` · `stillWorks=resolve(n=2)` · `loginUrls=[…stub]` ·
`stubLog=["login|<격리홈>\codex\login"]` — `CODEX_HOME`이 격리 홈 아래인 것도 매 주행 확인).

산출물: `C:\Temp\ccg-r28f-ship\r2-cancel-{ctl,fix}-{cmd,exe,browser}.json`.

## 6. 회귀 테스트 — 그리고 그 테스트가 **한 번 거짓으로 초록이었다**

`ipc/accounts.rs`에 셋을 더했다(`the_wrapper_bit_travels_with_the_command`,
`cancelling_a_wrapped_login_kills_the_program_inside_the_wrapper`,
`cancelling_an_unwrapped_login_leaves_what_the_cli_launched_alone`).

첫 판은 **처방을 무력화해도 통과했다.** 두 함정을 밟았고 둘 다 픽스처의 문제였다:

1. 파이프를 `Child`에 그대로 둔 채 취소하면 `Child` 드롭이 **읽기 끝을 닫아** 손자가 첫
   출력에서 죽는다. 제품 경로는 파이프를 읽기 스레드로 옮기므로, 테스트도 옮겨야 한다.
2. `CREATE_NO_WINDOW`라도 `cmd.exe`는 **conhost.exe를 먼저** 자식으로 단다. 첫 스냅샷을
   바로 찍으면 그 하나만 잡히고(정작 `ping`은 아직 안 떴다) conhost는 부모와 함께 죽으므로
   두 테스트가 **둘 다** 거짓으로 통과한다.

고친 뒤 이빨을 확인했다 — `kill_wrapped_child`를 `if !wrapped || true` 로 무력화하면
`cancelling_a_wrapped_login…`이 `★래퍼 안의 프로그램이 살아남았다: [24004, 41136]`로 **실패**한다.

## 7. 무회귀

- `cargo test --workspace` — 대조군 트리 **776 passed / 0 failed**(`agentcodegui` 154),
  판정 트리 **779 passed / 0 failed**(`agentcodegui` 157). 늘어난 3이 정확히 내가 더한 셋이고
  줄어든 칸은 없다. (크리틱의 771은 `521221d` 기준이다 — 그 뒤 이웃 셋이 커밋해 기준선이
  올라갔다. 그래서 「771 대비」가 아니라 **같은 HEAD의 대조군 776 대비**로 적는다.)
- `npm run typecheck:node` · `typecheck:web` · `typecheck:app` — 3종 exit 0.
- 렌더러는 **한 줄도 안 고쳤다**. 두 exe는 같은 `app/dist`를 물고 있고, 갈리는 것은
  Rust 셸뿐이다.

## 8. 남은 것 (정직하게)

1. **실 OAuth 왕복 미검증** — §1. 이 라운드도 가짜 CLI로만 왕복했다.
2. **취소를 안 누르면 여전히 최대 5분이다.** 자연 완료를 기다리는 상한은 2.6.2와 같은
   값이고, 사용자가 브라우저에서 로그인을 끝내는 시간을 앱이 짧게 자를 수는 없다.
   탈출구는 「취소」이고, 이제 그것이 **518ms에** 듣는다.
3. **`busy`는 여전히 두 축을 같이 묶는다**(로그인 중에는 Anthropic 축 버튼도 disabled).
   2.6.2와 같은 모양이라 이 라운드에서 안 건드렸다.
4. **요구 3의 뒷절반은 안 닫혔다** — strict 가드(`callStrict`/`callList`)는 계정 쓰기 8채널
   전용이고, 미구현 13채널은 여전히 침묵으로 번역된다. 내 손으로 다시 센 목록(HEAD 기준,
   243채널 중 13):
   `talk:{run,cancel,permission-respond,question-respond,bg-task,event}`(**M10 소유**) ·
   `lsp:{pick-verse-server,set-verse-path,clear-verse-path}` ·
   `app:{update-check,update-install,update-event,open-directory}`.
   크리틱이 든 예(`lsp:pick-verse-server`가 `resolve(null)`로 「Verse 서버 고르기」를
   무반응으로 만든다)는 사실이다. 이 라운드는 ★최대 격차 하나에 집중했다.
