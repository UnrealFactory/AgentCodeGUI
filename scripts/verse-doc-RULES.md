# Verse API 주석 → 한국어 번역 규칙 (termbase)

번역 단계에서 각 LLM 작업자에게 그대로 주는 규칙. 결과는 코드 에디터 호버 카드에
마크다운으로 렌더된다. **목표: 포트나이트/UEFN을 처음 만지는 사람도 카드만 읽고
이해할 수 있는, 자연스럽고 쉬운 한국어.** 직역투('경험의 필요에 따라' 같은)는 실패다.

## 절대 규칙
1. **백틱(`` ` ``) 안의 내용은 절대 번역/변형하지 않는다.** 백틱째 그대로 보존한다.
   예: `` `vector3` ``, `` `Progress >= RequiredCount` ``, `` `agent` ``.
2. **코드는 글자 하나 바꾸지 않는다** — 식별자·타입명·함수/파라미터명·Verse 키워드·지정자·
   경로(`/Verse.org/...`)·숫자·연산자, 그리고 **코드 줄 전체**(`X := class...` 목록,
   시그니처, `OnA -> OnB` 식 식별자 트리, `====` 구분선 줄). 산문(설명 문장)만 번역한다.
   (구분선 제거·코드 펜스 감싸기는 앱의 표시 포맷터가 하므로 여기선 손대지 않는다.)
3. **의미를 바꾸거나 내용을 발명하지 않는다.** 단, 아래 '전문용어 풀이'의 짧은 괄호 풀이는
   허용된다 — 그것도 원문 의미의 풀이일 뿐, 새 정보를 덧붙이는 게 아니다.
4. **목록 구조는 유지한다** — 줄 앞의 `*`/`-` 불릿과 그 들여쓰기는 그대로.

## 문단 재구성 (가독성)
- 영어 원문은 줄 폭 때문에 문장 중간에서 하드랩(강제 줄바꿈)돼 있다 — **따라가지 말 것.**
  산문은 자연스러운 한국어 문단으로 다시 묶는다: 이어지는 문장들은 한 문단(한 덩어리)으로,
  문단 사이에만 빈 줄 하나. 한 문단 안에서는 줄바꿈 없이 이어 쓴다.
- 한 문단 = 한 생각. 원문 문단 구조가 자연스러우면 그대로, 어색하게 쪼개져 있으면 묶는다.
- 문장은 짧고 명확하게. 관계절이 겹겹이면 두 문장으로 나눈다.

## 톤
- 평서형 설명체. `~합니다` / `~입니다` 로 끝낸다.
- `<decides>` 함수의 "Succeeds if/when ..." → "~(하)면 성공합니다." / "Fails if ..." → "~(하)면 실패합니다."
- "Returns ..." → "~를 반환합니다." / "Gets ..." → "~를 가져옵니다." / "Sets ..." → "~로 설정합니다."
- "Used to ..." → "~하는 데 사용합니다." / "Makes a `X` ..." → "~하여 `X` 를 만듭니다."
- "Deprecated, use `X` instead." → "더 이상 사용되지 않습니다. 대신 `X` 를 사용하세요."
- "clamped between A and B" → "A 과 B 사이로 제한됩니다." (A, B 가 숫자면 백틱으로)
- "Signaled when/each time ..." → "~할 때(마다) 신호를 보냅니다."

## 전문용어 — 쉬운 풀이 병기
한 블록 안에서 **처음 나올 때만** 짧은 괄호 풀이를 붙이고, 그다음부턴 용어만 쓴다.
풀이는 원문 의미의 요약일 뿐 새 설명을 지어내지 않는다.
- normalized → 정규화된(길이를 1로 맞춘)
- transaction / rolls back → 트랜잭션(실패하면 그동안 한 일을 되돌리는 묶음 실행)
- simulation → 시뮬레이션(게임 세계의 실행)
- derive / subclass → ~에서 파생(상속)합니다 / 자식 클래스
- instance → 인스턴스(실제로 만들어진 객체)
- lifetime → 수명(만들어져 사라질 때까지의 과정)
- callback → 콜백(나중에 대신 호출되는 함수)
- clamp → 범위 제한
- interpolation → 보간(두 값 사이를 부드럽게 채움)
- concurrency / concurrent → 동시 실행
- serialization → 직렬화(저장/전송 가능한 형태로 변환)
- deprecated → 더 이상 사용되지 않음(제거 예정)
- immutable → 불변(만든 뒤 바꿀 수 없음)
- octree / quadtree 등 자료구조 → 음차 + (공간을 나눠 빠르게 찾는 구조) 식 한 줄 풀이
- experience → **체험(제작 중인 콘텐츠/맵)** — '경험'으로 직역 금지
- island → 섬 · creative device → 창작 디바이스 · playspace → 플레이 공간

## 핵심 용어 백틱 (색상 강조)
산문 속에 코드 식별자(타입/클래스/함수/지정자 이름)가 **맨몸으로** 나오면 백틱으로 감싼다 —
카드에서 코드 색으로 칠해지고 설명 툴팁이 붙는다. 예: light_component → `light_component`,
OnBeginSimulation → `OnBeginSimulation`, final_super 지정자 → `<final_super>`.
일반 명사(엔티티, 컴포넌트 같은 음차어)는 백틱 없이 그대로.

## 용어집 (음차/번역 통일 — 단, 백틱 코드 토큰이면 그대로 둔다)
device→디바이스 · agent→에이전트 · entity→엔티티 · component→컴포넌트 · inventory→인벤토리 ·
widget→위젯 · slot→슬롯 · vehicle→차량 · turret→터렛 · sentry→센트리 · guard→가드 ·
spawn→스폰 · team→팀 · player→플레이어 · trace→트레이스 · collision→충돌 · specular→스페큘러 ·
highlight→하이라이트 · rotation→회전 · vector→벡터 · emote→이모트 · hologram→홀로그램 ·
mood→기분 · pawn→폰 · near plane→니어 평면 · world space→월드 공간 · centimeters→센티미터 ·
seconds→초 · quest→퀘스트 · sidekick→사이드킥 · volume→볼륨 · score→점수 ·
scene→씬 · building block→구성 요소 · gameplay→게임플레이

게임 전용 표현은 음차+괄호 원문 병기 가능. 예: "down but not out" → "다운되었지만 탈락하지 않은(down but not out)".

## 입력 / 출력
- 입력: `{ key, src, decl, en }` 객체 배열. `decl`(선언 시그니처)·`src`(출처)는 **맥락 참고용**일
  뿐 번역하지 않는다. `en` 만 번역.
- 기존 번역(`src/main/lsp/verse-doc-ko.json`, key로 조회)이 있으면 **참고만** 한다 — 품질 기준이
  올라갔으므로 그대로 복사하지 말고 이 규칙에 맞춰 다시 쓴다.
- 출력: `{ "<key>": "<한국어 번역>" }` JSON 객체 하나. 입력의 모든 `key` 포함. JSON 외 텍스트 금지.
