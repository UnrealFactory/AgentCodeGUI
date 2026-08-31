# SMALL3 R1 — 장부에 남은 소품 2건

> 대상: `feature/3.0.0-beta`. 지시가 준 자리는 둘이다.
> ① `decisions-3.0.md` §3.4-B가 잡은 **첨부 대화상자 문구 한국어 고정**을 ko/en으로 연다.
> ② `parity-fix-updater-r1.md` §10.1이 센 **`CROSSTALK_*` 미사용 상수 경고 넷**을 없앤다.
>
> **결론 한 줄**: ①은 실제 결함이었고 고쳤다(못 하나 신설 + 하네스 하나). ②는 **이미 닫혀
> 있었다** — 내가 지울 코드가 0줄이었고, 이 라운드가 한 일은 그것을 **실측으로 확인한 것**이다.

---

## 0. 한눈에

| | 결함 | 처방 | 실측 |
|---|---|---|---|
| ① 첨부 대화상자 i18n | `dialog.rs`가 제목·필터 이름 넷을 한국어 리터럴로 박음 → `ui.lang=en`에서도 네이티브 창만 한국어 | `labels()`로 넷을 떼고 `ccg_fs::t(ko, en)` 감쌈. en 문자열은 2.6.2에서 글자 그대로 | 격리 홈 3벌 실행 캡처(en=영어 · ko=한국어 · 설정없음=한국어). 못을 되돌리면 **부러진다**(§2.4) |
| ② `CROSSTALK_*` 경고 4 | **없음** — 2026-08-28 커밋 `698257b`이 이미 걷었다 | 없음(코드 변경 0) | 릴리즈 빌드 경고 **0** · 산 참조 **0**(묘비 주석 5줄만) |

**바뀐 파일 3개**
`src-tauri/src/ipc/parity/dialog.rs`(+96/−5) · `crates/ccg-fs/src/lib.rs`(주석 정정 한 문단) ·
`scripts/poc-small3-dialog-i18n.mjs`(신설).

---

## 1. ② 먼저 — **고칠 것이 없었다**

지시는 "grep으로 위치를 찾고, 사용처가 정말 0인지 확인한 뒤 삭제"라고 했다. grep이 낸 것:

```
src/shared/protocol.ts:1346,1507-1509   ← 묘비 주석
src-tauri/src/ipc/mod.rs:283            ← 묘비 주석
```

**상수 넷은 이미 없다.** `git log -S`가 자리를 짚는다 — `698257b`
(*"M10 계약면 뒷정리 — 기능을 들어낸 자리에 채널 넷과 타입 넷이 남아 경고를 내고 있었다"*,
2026-08-28)가 `CROSSTALK_CONFIG`·`_SET`·`_STOP`·`_STATE`를 지우고 그 자리에 묘비 주석을
남겼다. `git merge-base --is-ancestor 698257b HEAD` = 참(현재 브랜치 조상).

### 1.1 왜 장부가 어긋나 보였나

`parity-fix-updater-r1.md` §10.1의 "경고 4 → 4"는 **`971e3f7`(2026-08-27) 시점의 수치**다.
그 라운드는 `ipc/mod.rs`를 **소유하지 않아** 못 만졌고(그 사실을 §10.1이 적어 뒀다),
다음 날 `698257b`이 소유권이 풀린 뒤 걷었다. 즉 **장부가 틀린 게 아니라 하루 늦은
스냅샷**이다. 지시서가 그 스냅샷을 읽고 항목을 세운 것.

### 1.2 그래서 이 라운드가 실제로 한 것 = 재측정

| 잰 것 | 값 |
|---|---|
| 산 참조(`crosstalk`·`CROSSTALK`·`TalkSent`·`TalkResult`·`TalkConfig`, `.rs`/`.ts`/`.tsx`/`.json`, `docs/`·`target*` 제외) | **0** — 위 묘비 주석 5줄이 전부 |
| `cargo build --release --features custom-protocol` (`CARGO_TARGET_DIR=target-small3`) | **경고 0 · exit 0** |

**기록 문서는 안 건드렸다** — `docs/m10-report-*.md`, `docs/parity-fix-m10-removal-r1.md`,
`docs/HANDOFF-3.0.md`의 M10 철회 문단, `scripts/poc-m10-*.mjs` 전부 그대로다.
`talkGet`/`talkSave`(1.x의 은퇴한 "채팅 모드" 블롭)도 그대로 남겼다 — 이름만 닮았을 뿐
M10과 무관한 파리티 항목이고, `698257b`의 묘비 주석이 그 구분을 이미 적어 뒀다.

---

## 2. ① 첨부 대화상자 — 실제 결함

### 2.1 못이 있던 자리

`src-tauri/src/ipc/parity/dialog.rs:45-49`(수정 전):

```rust
.set_title("첨부할 파일 선택")
.add_filter("첨부 가능한 파일", &all)
.add_filter("이미지", &IMAGE)
.add_filter("텍스트·문서", &TEXT)
```

2.6.2는 같은 자리(`src/main/index.ts:1355-1360`)에서 넷 다 `t(ko, en)`으로 감싼다.
결과: **UI 언어를 en으로 둔 사용자에게 네이티브 파일 선택 창의 제목과 필터 이름만
한국어로 남았다.** 화면 안이 전부 영어인데 OS가 띄운 창만 한국어 — M8 크리틱 S4
(「UI 언어가 en인데 트레이 메뉴만 한국어」)와 같은 계열이다.

### 2.2 처방 — 4줄 + **못을 박을 자리 하나**

지시(와 `decisions-3.0.md` §3.5-B)는 "4줄이면 닫힌다"고 했다. 문자열 4줄은 맞다.
다만 그대로 인라인으로 감싸면 **검증할 방법이 없다** — `pick_attachments`는 네이티브
창을 여는 블로킹 호출이라 테스트가 못 부른다. 그래서 문구 넷만 함수로 뺐다:

```rust
fn labels() -> [String; 4] {
    [
        ccg_fs::t("첨부할 파일 선택", "Choose files to attach"),
        ccg_fs::t("첨부 가능한 파일", "Attachable files"),
        ccg_fs::t("이미지", "Images"),
        ccg_fs::t("텍스트·문서", "Text & documents"),
    ]
}
```

호출부는 `let [title, f_all, f_img, f_txt] = labels();` 한 줄이 늘고 빌더가 그 값을 받는다.
**순서가 곧 빌더 순서**이므로 필터 첫 줄이 「첨부 가능한 파일」이라는 2.6.2 규약도 그대로다.

en 문자열 넷은 지어내지 않고 2.6.2 `index.ts:1355-1360`에서 **글자 그대로** 옮겼다.
하네스가 그 동일성을 매번 다시 잰다(§2.3-A).

**규약 준수 확인**: 인라인 `t(ko, en)` · 사전 파일 없음 · 모듈 스코프 `t()` 아님
(`labels()`는 **호출 시점**에 평가된다 — `const`였다면 프로세스 첫 언어로 박제됐을 자리다).

### 2.3 실측 — `scripts/poc-small3-dialog-i18n.mjs`

두 갈래로 잰다.

**A. 정적** — `dialog.rs`의 `labels()`가 내는 (ko, en) 넷 vs 2.6.2 `pickAttachments`의 넷.
그리고 **빌더가 정말 `labels()`를 먹는지**(안 그러면 "아무도 안 쓰는 함수"를 재는 셈이다).

```
  ok   3.0 labels()의 t() 콜사이트 4개 — 실제 4
  ok   2.6.2 pickAttachments의 t() 콜사이트 4개 — 실제 4
  ok   넷이 (ko, en) 글자까지 같다
  ok   en 인자에 한글이 없다
  ok   ko와 en이 같은 칸이 없다
  ok   pick_attachments가 labels()를 부른다
  ok   set_title/add_filter 넷이 labels()의 값을 그대로 받는다
  ok   빌더 구간에 한국어 리터럴 0
```

**B. 실측** — 격리 홈(`CCG_HOME`)에 `ui-prefs.json` 한 장만 놓고 `labels()`가 **실제로
뱉는 문자열**을 받아 온다. 사용자 실홈은 읽지도 복사하지도 않는다.

```
  ui.lang=en   → Choose files to attach | Attachable files | Images | Text & documents
  ui.lang=ko   → 첨부할 파일 선택 | 첨부 가능한 파일 | 이미지 | 텍스트·문서
  설정 없음     → 첨부할 파일 선택 | 첨부 가능한 파일 | 이미지 | 텍스트·문서
전부 통과 (exit 0)
```

세 번째 줄이 **ko 기본 동작 무변**의 증거다 — 언어를 한 번도 안 고른 홈은 예전과 같다.

> **왜 프로세스를 가르나.** `ccg_fs::t`의 언어 판정(`is_en`)은 **2초 TTL의 프로세스 전역
> 원자 캐시**다. 첫 읽기로 굳으므로 한 프로세스 안에서 `CCG_HOME`을 번갈아 바꾸면
> 순서에 따라 답이 갈린다(스레드로 도는 테스트에서는 조용한 거짓 통과가 된다).
> 그래서 언어마다 자식 프로세스를 새로 띄운다 — `ccg-auth` T4가 쓰는 자기 재실행 수법과 같다.

같은 못이 **크레이트 안에도** 있다(하네스가 없어도 회귀가 잡히게):
`ipc::parity::dialog::tests::the_dialog_labels_follow_ui_lang`.
짝이 되는 `child_prints_the_dialog_labels`는 `#[ignore]`라 평소 주행에서 건너뛴다
(부모가 격리 홈과 함께 직접 띄운다).

### 2.4 **못이 무는가** — 고친 것을 되돌려 봤다

`labels()`의 `ccg_fs::t(...)`를 `"…".to_string()`으로 임시 되돌리고 그대로 돌렸다:

```
test ipc::parity::dialog::tests::the_dialog_labels_follow_ui_lang ... FAILED
assertion `left == right` failed: ★ui.lang=en인데 영어가 아니다
  left:  ["첨부할 파일 선택", "첨부 가능한 파일", "이미지", "텍스트·문서"]
 right:  ["Choose files to attach", "Attachable files", "Images", "Text & documents"]
```

하네스도 같이 부러졌다(3건 실패 · exit 1) — B의 `ui.lang=en` 줄이 한국어를 뱉었다.
**즉 §3.4-B의 회귀를 그대로 재현했고**, 못이 그것을 잡는다. 되돌린 조각은 되살렸다.

> 한 가지 약점을 적어 둔다: 되돌린 상태에서도 A의 "빌더 구간에 한국어 리터럴 0"은
> **통과했다**. 리터럴이 `labels()` 안으로 옮겨 갔기 때문이다. 그 검사는 초판 모양의
> 재발만 막고, 문구가 진짜 번역되는지는 **B가** 잰다. 둘을 같이 봐야 한다.

### 2.5 곁다리 하나 — `ccg-fs`의 주석이 틀려졌다

`crates/ccg-fs/src/lib.rs`의 `t()` 주석은 *"`t()`는 실패 경로에서만 불리므로"* 라고 적고
그 위에 TTL 캐시의 비용 논증을 세워 뒀다. 이제 첨부 대화상자가 **성공 경로**에서 부른다.
회계 자체는 그대로다(창을 여는 순간 넷이 같은 2초 창에 들어가므로 디스크 읽기 최대 1회)
— 틀린 것은 **전제 문장**이라 그 문단만 정정하고, 캐시가 프로세스 전역이라는 성질
(§2.3의 함정)을 같이 적었다. **동작 변경 0줄.**

---

## 3. 빌드·테스트 수치

| 잰 것 | 값 |
|---|---|
| `cargo build --release --features custom-protocol`(`CARGO_TARGET_DIR=target-small3`) | **exit 0 · 경고 0** (§10.1의 4 → **0**) |
| `cargo test -p agentcodegui --features custom-protocol` | **142 통과 · 0 실패 · 1 무시 · exit 0** |
| 같은 명령, **신설 둘을 뺀 값**(`--skip`) | **141 통과 · 0 실패 · exit 0** = 기존 못 전수 무후퇴 |
| `node scripts/poc-small3-dialog-i18n.mjs` | **전부 통과 · exit 0** |
| 되돌림 대조군(§2.4) | cargo test **exit 101** · 하네스 **exit 1** |

`1 무시`는 신설한 자식 테스트다(설계상 부모만 띄운다). 즉 **+1 통과 · +1 무시**의 순증가.

**경고 0을 어떻게 확정했나.** 증분 빌드는 새로 안 도는 유닛의 경고를 재생만 하므로,
마지막에 `dialog.rs`를 `touch`해 **`agentcodegui`를 강제로 다시 컴파일**하고 stdout·stderr를
한 파일로 받아 셌다 — `Compiling agentcodegui` → `Finished ... in 1m 32s`, `^warning` **0줄**,
exit 0. (중간에 한 번 옆 갈래 때문에 빌드가 죽었다가 살아난 자리가 있다 — §5-5.)

---

## 4. 경계 — 손댄 것과 안 댄 것

**손댄 것(3개)**

| 파일 | 무엇 |
|---|---|
| `src-tauri/src/ipc/parity/dialog.rs` | `labels()` 신설 + 빌더 배선 + 못 둘 + 모듈 주석 |
| `crates/ccg-fs/src/lib.rs` | `t()` 주석 정정(§2.5). **코드 0줄** |
| `scripts/poc-small3-dialog-i18n.mjs` | 신설 하네스 |

**안 댄 것**: 동결 구역(`src/`·`out/`·`dist/`·`main`) · `crates/ccg-lsp` · `tauri.conf.json`
(옆 갈래 LSPDIST 소유) · `docs/`의 M10 기록 문서 전부 · `ipc/mod.rs`·`protocol.ts`의 묘비 주석.

`src/main/index.ts`와 `src/shared/attachments.ts`는 **읽기만** 했다(하네스의 기준값 출처).

**실행 안전**: 이름 기반 프로세스 kill 0. 띄운 프로세스는 하네스가 스폰한 테스트
바이너리 자식 셋뿐이고 전부 자연 종료했다. 홈은 `%TEMP%` 아래 새로 만들고 지웠다 —
사용자 실홈(`%USERPROFILE%\.agentcodegui`)은 읽지도 복사하지도 않았다.
빌드는 전부 `CARGO_TARGET_DIR=target-small3`(공용 `target/` 미접촉).
`npm ci`/`npm install` 0회.

---

## 5. 남은 것 · 다음 사람에게

1. **§3.4-A는 그대로 열려 있다.** 호스트(Rust) 문자열의 `t()` 콜사이트가
   3.0 **54** vs 2.6.2 **238**이다. 이 라운드는 그중 **넷**만 닫았다. 나머지의 대응 여부는
   여전히 미결이고(비용 큼 · 체감 작음), 한 줄씩 맞춰 본 사람은 아직 없다.
2. **네이티브 창 자체는 안 찍었다.** 잰 것은 창에 넘어가는 **문자열**이다
   (`labels()` → `set_title`/`add_filter`는 정적으로 확인). Win32 창 제목을 실제로 읽는
   캡처는 안 했다 — 사용자 실앱이 떠 있는 동안 블로킹 모달을 띄우고 닫는 자동화는
   위험이 이득보다 컸다. 남은 구멍은 `tauri-plugin-dialog`가 우리가 준 문자열을
   그대로 안 쓰는 경우 하나뿐인데, 그건 이 레포의 결함이 아니다.
3. **`--include-ignored` 의존.** 자식 테스트를 `#[ignore]`로 숨겼으므로, 나중에 누가
   테스트 러너를 바꾸면서 그 플래그를 못 넘기면 부모가 *"자식이 라벨을 안 찍었다"*로
   죽는다. 죽는 쪽이 조용히 통과하는 쪽보다 낫다고 보고 그대로 뒀다.
4. **하네스는 빌드하지 않는다.** `target-small3/debug/deps`의 테스트 exe를 **찾아 쓴다**.
   먼저 `cargo test -p agentcodegui --features custom-protocol`을 한 번 돌리거나
   `--exe=<경로>`로 지목해라.
5. **옆 갈래와 부딪힌 자리(기록용).** 이 라운드 막바지에 같은 워크트리의 LSPDIST 갈래가
   `crates/ccg-lsp`(`launch.rs`·`server.rs`·`spec.rs`)를 반쯤 고친 상태였고, 그 상태로
   `cargo build`가 `error[E0063]: missing extra_modules`로 죽었다. **내 변경과 무관하다**
   — 몇 분 뒤 그 갈래가 자기 편집을 마치자 `ccg-lsp`·`ccg-fs`·`agentcodegui`가 그대로
   다시 컴파일되고 exit 0으로 끝났고, §3의 강제 재컴파일 수치는 **그 이후**에 잰 것이다.
   다음 사람에게: 같은 트리 병렬 작업에서 **`git stash`를 쓰지 마라** — 옆 갈래의
   미커밋 파일을 쓸어 담는다. `git commit`에 pathspec을 반드시 주는 것과 **같은 계열의
   사고**다. 이 라운드는 기준선 측정을 stash 대신 `--skip`으로 우회했다(§3의 141행).
