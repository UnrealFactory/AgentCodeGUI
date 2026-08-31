# SMALL3 R3 확인 크리틱 — `bae5bd7`

> 판정자: 확인 크리틱 R3(이 조각의 셋째 라운드). R1·R2와 같은 규율.
> 오염 없는 트리: `git archive bae5bd7` → `%TEMP%\ccg-small3-crit-r3`,
> `node_modules`는 워크트리를 가리키는 **읽기 전용 정션**(`npm ci`/`install` 0회),
> `CARGO_TARGET_DIR`은 새 디렉터리 둘, `app/dist`는 임베드용 최소 스텁.
> 제품 코드 한 줄도 안 고쳤다 · 돌연변이는 **격리 사본에만** · 끝나고 두 파일 다
> `git hash-object`로 복원 확인 · 사용자 실홈 무접촉 · 이름 기반 kill 0 ·
> **정리할 때 정션을 먼저 끊었다**(워크트리 `node_modules` 412개 무사).

## 판정: **합격 — 이 조각을 종결한다**

**R2가 남긴 셋(EPAIR 중 · R2-D2 낮음 · R2-D3 낮음)이 전부 닫혔다.** 내 손으로 재현했다.
새로 판 구멍 넷 중 셋은 **잡히거나 컴파일이 거부**했고, 남은 하나(EORDER)는 **낮음**이다.

세 라운드에서 제품 결함은 **한 번도 안 나왔다**. 남은 항목은 낮음 하나뿐이고 실질 위험이
제한적이므로(§3), **합격 종결을 선언하고 EORDER는 이월 장부로 넘긴다.**

---

## 0. 빌더 주장 vs 내 실측 — 전부 일치

| 빌더가 말한 것 | 내가 잰 값 | 판정 |
|---|---|---|
| M1 / M2 / M3 → exit 101 | **101 · 101 · 101** (실패한 못 이름까지 일치) | 참 |
| **EPAIRF**(필드 오지목) → exit 101 | **101** — `the_builder_can_only_say_what_labels_gave_it` | 참 |
| **E6**(concat! 밀반입, R2에선 초록) → exit 101 | **101** — 같은 못 | 참 |
| **EPAIRI / EPAIRD**(무해) → exit 0 | **0 · 0** — 거짓 양성 없음 | 참 |
| `agentcodegui` 144/0/1 | **144/0/1** | 참 |
| `ccg-fs` 103/0/2 | **103/0/2** | 참 |
| 릴리즈 경고 0 | **exit 0 · `warning` 0줄**(새 target 디렉터리) | 참 |
| R2 크리틱 도구가 앵커 소멸로 못 쓰게 됐다 | `앵커를 못 찾았다 (M1)` · `(EPAIR)` — **보존된 채 무력** | 참 |
| 하네스 전부 통과 · sweep 58/41 | **exit 0 · 58/41** | 참 |
| 커밋 5파일 · 옆 갈래 미혼입 | `ccg-fs`·보고서·하네스 둘·`dialog.rs`뿐 | 참 |

옆 갈래(LSPDIST)가 같은 트리에서 `.gitignore`·`scripts/tauri-build.mjs`·`tauri.conf.json`·
`crates/ccg-lsp`를 미커밋으로 들고 있는데 **한 파일도 안 섞였다.**

---

## 1. EPAIR이 정말 닫혔는가 → **그렇다. 그리고 덤이 하나 더 있다**

R3는 내가 R2에서 권한 처방 **둘 다** 했다 — 구조체(`DialogLabels`)로 「위치」 개념을
없애고, 그 위에 짝을 글자로 고정하는 못 ②'을 얹었다.

내가 판 새 구멍 넷의 결과:

| 변이 | 무엇 | `cargo` | 하네스 | 결과 |
|---|---|---|---|---|
| **EORDER** | 빌더 `.add_filter` **줄 순서**만 바꿈 | **0 ★** | **0 ★** | **구멍(낮음)** |
| ETWICE | `.set_title`을 **두 번** 부름 | **101** | — | **컴파일이 거부** |
| EKOEN | `t(ko, en)` 두 인자 맞바꿈 | **101** | 1 | 잡힌다 |
| EXFIELD | `labels()` 안에서 `title`↔`filter_all` 값 맞바꿈 | **101** | 1 | 잡힌다 |

**ETWICE는 빌더가 의도하지 않은 수확이다.** `.set_title(l.title).set_title(l.filter_all)`은
뒤엣것이 이기므로 못 ②'의 `contains` 넷을 전부 만족하면서 제목을 갈아치울 수 있어야
하는데, 실제로는 **빌림 검사기가 먼저 막는다**:

```
error[E0382]: use of moved value: `l.filter_all`
```

구조체 필드가 빌더로 **move**되므로 같은 필드를 두 번 못 쓴다. 즉 R3의 구조체 전환은
「위치로 섞기」만 없앤 게 아니라 **「값을 두 번 쓰기」까지 타입 체계가 막게** 만들었다.
보고서가 이 성질을 안 적었는데, 적어 둘 값어치가 있다(§11.3 표의 다섯째 줄이 될 자리다).

**EKOEN·EXFIELD가 잡히는 것**은 R3가 못 둘을 **이름 기준**으로 바꾼 덕이다.
런타임 못은 자식이 `필드=문구`로 찍고, 2.6.2 대조 못은 대응표
(`title↔[0] · filter_all↔[1] · filter_images↔[2] · filter_docs↔[3]`)로 조회한다.
그래서 **무해한 초기화·선언 순서 바꿈에는 안 걸리고**(EPAIRI·EPAIRD 초록) **진짜 어긋남만**
잡는다 — 거짓 양성과 거짓 음성을 동시에 피한 설계다. 빌더의 "의도한 값" 주장은 참이다.

---

## 2. 결함

### 치명 · 중 — **없다**

### 낮음

**R3-D1. 짝 못은 「존재」만 보고 「순서」를 안 본다(EORDER).**

못 ②'과 하네스의 짝 검사는 둘 다 `contains`/`includes`다 — 네 짝이 **있는가**만 본다.
그래서 빌더의 세 `.add_filter` 줄을 **재배열**하면 넷이 전부 그대로 존재하므로 통과한다:

```rust
        .set_title(l.title)
        // 순서가 곧 대화상자의 기본 필터다 — 2.6.2와 같이 「첨부 가능한 파일」이 첫 줄.
        .add_filter(l.filter_images, &IMAGE)   // ← 이미지가 첫 줄로 올라왔다
        .add_filter(l.filter_all, &all)
        .add_filter(l.filter_docs, &TEXT)
```

**`cargo test` exit 0 · 하네스 exit 0** — 레포의 자동 검사 전부가 초록이다.
바로 위 줄의 주석이 *"순서가 곧 대화상자의 기본 필터다"* 라고 경고하는데 **그 규약은
주석으로만 존재한다.** 레포 전체를 훑어도 필터 순서를 재는 **실행 가능한 검사는 0건**이고
(`dialog.rs:55` 문서 주석 · `:87` 인라인 주석이 전부), 순서를 보던 유일한 검사였던
내 R1 계기의 `필터 첫 줄 = 첨부 가능한 파일` 줄은 R2/R3의 앵커 변경으로 **옛 커밋에
고정된 채 HEAD를 안 지킨다**.

제품 영향: 첨부 대화상자의 **기본 선택 필터가 「이미지」**가 된다 → 사용자가 「＋」를 누르면
`.md`·`.txt`·소스 파일이 **처음에 안 보인다**(필터를 손으로 바꿔야 나온다). 2.6.2 규약
위반이기도 하다.

**왜 낮음인가**(중이 아닌 이유를 분명히 적는다):
- 못 ②'이 **라벨↔확장자 배열의 짝을 잠갔으므로**(`l.filter_images`는 언제나 `&IMAGE`와
  간다) 대화상자가 **틀린 이름을 붙이는 일은 없다**. 바뀌는 것은 기본 선택뿐이다.
- 사용자가 세션 안에서 필터 드롭다운으로 즉시 회복한다. 데이터 손실도, 잘못된 문구도 없다.
- R2의 EPAIR(중)은 **제목 표시줄에 틀린 문구**가 ko·en 양쪽에서 떴다 — 그것과 급이 다르다.

**한 줄이면 닫힌다**(다음에 이 파일을 여는 사람에게):
```rust
assert!(builder.find(".add_filter(l.filter_all") < builder.find(".add_filter(l.filter_images"),
        "★첫 필터가 「첨부 가능한 파일」이 아니다 — 2.6.2 규약(크리틱 R3 EORDER)");
```

### 결함이 아닌 것(확인만)

- **R2-D2(E3·E6) 닫힘**: 빌더 밖 상수에 `concat!`·유니코드 이스케이프로 한국어를 숨기는
  우회가 **exit 101**이다. 못 ②'이 빌더의 표현을 넷으로 못 박아 `.set_title(SNEAK)` 자체가
  짝에서 어긋나기 때문이다. R2에서 `cargo test`가 초록이던 자리가 실제로 닫혔다.
- **R2-D3(TTL) 닫힘**: `lang_fresh`를 순수 함수로 뗀 뒤 경계 못이 **양방향으로** 문다 —
  `2000→60000`은 `★2.000초에 만료된다`에서, `2000→1000`은 `1.999초는 아직 신선하다`에서
  붉어진다. 시계 역행(`saturating_sub`)의 거동도 못 안에 **적어 뒀다**(감추지 않았다).
- **보고서 §11.3이 과장하지 않는다**: *"EPAIR 부류 전체가 원리적으로 사라졌다고 말하면
  거짓말이다"* 라고 스스로 적고 사라진 형태와 남은 형태를 갈라 놨다. 내 실측과 일치한다.
  다만 그 표에 **다섯째 줄(빌더 줄 순서)이 빠졌다** — 그게 R3-D1이다.
- **R2 크리틱 도구를 지우지 않고 보존**한 것도 규율에 맞다(앵커가 죽어 무력하지만,
  무엇을 어떻게 쟀는지가 기록의 값어치다).

---

## 3. 남은 가장 큰 격차 (하나) · 그리고 종결 판단

> **필터 「순서」 축 — 짝은 잠겼고 값도 잠겼는데, 세 줄의 배열만 아무도 안 본다.**

세 라운드를 거치며 이 조각의 방어는 이렇게 쌓였다:

| 축 | 무엇이 지키나 |
|---|---|
| 번역이 도는가(`ui.lang`) | 런타임 못(자식 프로세스 3벌) |
| 문구가 2.6.2와 같은가 | 동결 원문 대조 못(이름 기준) |
| 빌더가 딴 말을 하는가 | 못 ②(리터럴 0) + ③(한국어 출처 하나) |
| 값이 제 짝에 갔는가 | 구조체(위치 개념 소멸) + 못 ②'(짝 글자 고정) + 빌림 검사기(중복 사용 거부) |
| **줄의 순서(기본 필터)** | **아무도 안 본다** ← 남은 하나 |

**종결 판단**: 남은 것은 **낮음 하나**이고, 성질이 「틀린 문구」가 아니라 「기본 선택」이며,
못 ②'이 라벨↔배열 짝을 잠가 둔 덕에 **더 나쁜 형태로 번지지 않는다.** 지시가 준 종결
조건(잔여가 낮음뿐이고 실질 위험 없음)에 해당하므로 **이 조각을 합격으로 종결**하고,
EORDER는 위의 한 줄 처방과 함께 **이월 장부**로 넘긴다.

> **이월 장부(이 조각 밖)**: 제품 영향이 가장 큰 미결은 여전히 **§3.4-A**(호스트 `t()`
> 58 vs 2.6.2 238 · 미포장 사용자 가시 문자열 60~70)이고, 실물 세 자리
> (`ipc/lsp.rs:160 VERSE_OUT_OF_SCOPE` · `system.rs pick_directory`의 잃어버린 제목과
> 부모 창 · `win.rs:390` 창 제목)는 보고서 §10이 정확히 이월해 뒀다. 그 라운드를 열 때
> 이 조각이 세운 모양(`labels()` 구조체 + 못 넷)을 그대로 재사용하면 된다.

---

## 4. 재현 방법

```bash
git archive bae5bd7 | tar -x -C %TEMP%\ccg-small3-crit-r3
mklink /J %TEMP%\ccg-small3-crit-r3\node_modules C:\Code\AgentCodeGUI\node_modules
set CARGO_TARGET_DIR=C:\Temp\target-small3-crit-r3
cargo test -p agentcodegui --features custom-protocol     # 144/0/1
cargo test -p ccg-fs                                      # 103/0/2
cargo build --release --features custom-protocol          # exit 0 · warning 0

# 빌더의 열
node scripts/poc-small3-mutate.mjs <격리트리> M1|M2|M3|EPAIRF|E6|EPAIRI|EPAIRD|restore
# 크리틱이 새로 판 축
node docs/critic/tools/critic-small3-r3-mutate.mjs <격리트리> EORDER|ETWICE|EKOEN|EXFIELD|restore

# 정리: 정션을 **먼저** 끊는다 (안 그러면 워크트리 node_modules가 지워진다)
rmdir %TEMP%\ccg-small3-crit-r3\node_modules
```

계기·증거: `docs/critic/tools/critic-small3-r3-mutate.mjs` ·
`docs/critic/critic-small3-r3-mutations.json`.
앞선 두 라운드: `docs/critic/small3-critic-r1.md` · `small3-critic-r2.md`
(계기 `critic-small3-r1.mjs` · `critic-small3-mutate.mjs` · `critic-small3-r2-mutate.mjs` —
뒤 둘은 R3의 앵커 변경으로 **무력하지만 기록으로 보존**).
