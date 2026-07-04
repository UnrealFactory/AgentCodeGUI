/* ============================================================
 * 비-Verse 언어 키워드·내장 타입 용어집 — Verse의 VERSE_KEYWORD_GLOSSARY와
 * 같은 개념을 TS/JS · Python · C# · C++/C 로 확장한다. 언어 서버는 예약어
 * (`if`·`for`·`class`…)와 상당수 내장 타입(`int`·`number`…)에 호버를 주지
 * 않으므로, LSP 호버가 비어 있을 때(그리고 서버가 아직 준비 전일 때)의
 * 폴백으로 직접 설명을 단다. 값은 카드에 그대로 렌더되는 마크다운 설명
 * (B안: 칩·이름 없이 설명만)이고, `코드 용어`는 백틱으로 본문과 같은 색.
 *
 * shared에 두는 이유: main(manager.hover 폴백)과 renderer(호버 카드 안
 * 토큰 설명 띠)가 같은 사전을 봐야 두 화면의 설명이 어긋나지 않는다.
 * Keep this file dependency-free (types + const only) — protocol.ts와 동일 규칙.
 * ============================================================ */

type Gloss = Record<string, string>

// ── JavaScript (TypeScript가 그대로 물려받는 공통 어휘) ─────────────────────
const JS_GLOSSARY: Gloss = {
  // 선언
  var: '변수를 선언합니다. 블록이 아니라 함수 단위의 유효 범위를 가집니다.',
  let: '나중에 값을 바꿀 수 있는 변수를 선언합니다. 선언한 블록(`{ }`) 안에서만 살아 있습니다.',
  const: '한 번 정하면 다시 대입할 수 없는 상수를 선언합니다. 객체나 배열이면 내용물 자체는 바뀔 수 있습니다.',
  function: '함수를 정의합니다. 호출하면 동작을 수행하고 값을 돌려줄 수 있습니다.',
  class: '객체를 찍어내는 틀(클래스)을 정의합니다. 필드·메서드·상속을 가질 수 있습니다.',
  extends: '다른 클래스를 상속받아 그 기능을 물려받습니다.',
  constructor: '`new` 로 객체가 만들어질 때 호출되는 초기화 메서드(생성자)입니다.',
  super: '부모 클래스를 가리킵니다. `super()` 는 부모 생성자를, `super.메서드()` 는 부모 메서드를 호출합니다.',
  this: '지금 실행 중인 문맥의 객체 자신을 가리킵니다.',
  new: '클래스(또는 생성자 함수)로부터 새 객체를 만듭니다.',
  static: '인스턴스가 아니라 클래스 자체에 붙는 멤버로 만듭니다. `클래스명.멤버` 로 접근합니다.',
  get: '속성을 읽을 때 실행되는 게터를 정의합니다. 함수지만 `obj.값` 처럼 필드로 읽힙니다.',
  set: '속성에 값을 넣을 때 실행되는 세터를 정의합니다. `obj.값 = x` 처럼 대입하면 호출됩니다.',
  // 흐름 제어
  return: '함수를 끝내고 값을 반환합니다.',
  if: '조건이 참이면 그 안의 코드를 실행합니다.',
  else: '`if` 의 조건이 거짓일 때 대신 실행합니다.',
  for: '반복문입니다. `for…of` 는 원소를, `for…in` 은 키를 하나씩 돌면서 실행합니다.',
  while: '조건이 참인 동안 반복해서 실행합니다.',
  do: '일단 한 번 실행하고, 그다음부터 `while` 조건을 보고 반복합니다.',
  switch: '값이 무엇이냐에 따라 여러 `case` 갈래 중 하나로 나눠 처리합니다.',
  case: '`switch` 에서 값이 일치할 때 실행되는 갈래입니다.',
  default: '`switch` 에서 어느 `case` 에도 해당하지 않을 때 실행되는 갈래입니다. `export default` 에서는 모듈의 기본 내보내기를 뜻합니다.',
  break: '현재 반복문이나 `switch` 를 즉시 빠져나옵니다.',
  continue: '이번 반복은 건너뛰고 다음 반복으로 넘어갑니다.',
  // 예외
  try: '오류가 날 수 있는 코드를 감쌉니다. 오류가 나면 `catch` 로 넘어갑니다.',
  catch: '`try` 안에서 던져진 오류를 받아 처리합니다.',
  finally: '오류가 났든 안 났든 마지막에 반드시 실행됩니다.',
  throw: '오류(예외)를 던져 실행을 중단시킵니다. 가장 가까운 `catch` 가 받습니다.',
  // 연산자류
  typeof: '값의 타입 이름을 문자열로 알려주는 연산자입니다. (`"string"`, `"number"` …)',
  instanceof: '객체가 어떤 클래스(생성자)로 만들어졌는지 검사하는 연산자입니다.',
  in: '객체에 그 키(속성)가 있는지 검사합니다. `for…in` 에서는 키를 하나씩 돕니다.',
  of: '`for…of` 에서 배열·이터러블의 원소를 하나씩 돕니다.',
  delete: '객체에서 속성을 지우는 연산자입니다.',
  void: '뒤의 식을 평가하고 결과 대신 `undefined` 를 돌려주는 연산자입니다.',
  // 비동기
  async: '비동기 함수를 만듭니다. 항상 `Promise` 를 돌려주고, 안에서 `await` 를 쓸 수 있습니다.',
  await: '`Promise` 가 끝날 때까지 기다렸다가 그 결과값을 꺼냅니다. `async` 함수 안에서 씁니다.',
  yield: '제너레이터 함수에서 값을 하나 내보내고 실행을 잠시 멈춥니다. 다음 호출 때 이어서 실행됩니다.',
  // 모듈
  import: '다른 모듈(파일)의 내보낸 값을 가져옵니다.',
  export: '이 모듈의 값을 밖에서 쓸 수 있게 내보냅니다.',
  from: '`import`/`export` 에서 가져올 모듈의 경로를 지정합니다.',
  // 값·특수 이름
  null: '"값이 의도적으로 없음"을 나타내는 값입니다.',
  undefined: '"아직 값이 정해지지 않음"을 나타내는 값입니다. 초기화 안 된 변수의 기본값입니다.',
  true: '참 값입니다.',
  false: '거짓 값입니다.',
  NaN: '"숫자가 아님(Not-a-Number)"을 뜻하는 특수한 숫자 값입니다. 잘못된 수치 연산의 결과로 나옵니다.',
  Infinity: '무한대를 뜻하는 숫자 값입니다.',
  globalThis: '어느 환경(브라우저·Node)에서든 전역 객체를 가리키는 표준 이름입니다.',
  arguments: '함수에 전달된 모든 인자를 담은 유사 배열입니다. 화살표 함수에는 없습니다.'
}

// ── TypeScript = JS + 타입 어휘 ──────────────────────────────────────────────
const TS_GLOSSARY: Gloss = {
  ...JS_GLOSSARY,
  interface: '객체가 갖춰야 할 속성·메서드의 형태를 정의하는 타입입니다. 컴파일 시에만 존재합니다.',
  type: '타입에 별명을 붙입니다. 유니언(`A | B`)·튜플 등 복합 타입을 이름 하나로 다룰 수 있습니다.',
  enum: '이름을 붙인 상수들을 나열한 목록 타입입니다.',
  namespace: '관련 코드를 한 이름 아래 묶습니다. 지금은 대부분 ES 모듈(`import`/`export`)을 대신 씁니다.',
  declare: '"구현은 다른 곳에 있고 타입만 알린다"는 선언입니다. 전역 변수·외부 라이브러리의 형태를 알려줄 때 씁니다.',
  abstract: '직접 인스턴스를 만들 수 없는 추상 클래스/메서드로 만듭니다. 상속받는 쪽이 구현합니다.',
  implements: '클래스가 인터페이스의 형태를 갖추도록 강제합니다.',
  readonly: '읽기 전용으로 만듭니다. 처음 정해진 뒤에는 다시 대입할 수 없습니다.',
  public: '어디서든 접근할 수 있는 멤버입니다. (지정하지 않았을 때의 기본값)',
  private: '그 클래스 안에서만 접근할 수 있는 멤버입니다.',
  protected: '그 클래스와 상속받은 클래스에서만 접근할 수 있는 멤버입니다.',
  override: '부모 클래스의 메서드를 재정의한다는 표시입니다. 부모에 그 메서드가 없으면 오류가 납니다.',
  keyof: '타입의 모든 키를 유니언으로 꺼내는 타입 연산자입니다. (`keyof T` → `"a" | "b"` …)',
  infer: '조건부 타입 안에서 "이 자리의 타입을 추론해서 이름을 붙여 달라"는 표시입니다.',
  as: '값을 다른 타입으로 간주하게 하는 타입 단언입니다. 실제 변환은 일어나지 않습니다.',
  satisfies: '값이 그 타입을 만족하는지 검사만 하고, 추론된 더 구체적인 타입은 그대로 유지합니다.',
  is: '"이 함수가 참을 돌려주면 인자는 이 타입"이라고 알려주는 타입 가드 표기입니다.',
  asserts: '"이 함수가 정상 반환하면 조건이 보장된다"는 단언 함수 표기입니다.',
  // 내장 타입
  any: '모든 값을 허용하고 타입 검사를 하지 않는 타입입니다.',
  unknown: '무엇이든 담을 수 있지만, 타입을 좁혀 확인하기 전에는 사용할 수 없는 타입입니다.',
  never: '"절대 일어나지 않음"을 뜻하는 타입입니다. 항상 예외를 던지거나 끝나지 않는 함수의 반환형입니다.',
  number: '숫자입니다. 정수·소수 구분 없이 하나의 타입입니다.',
  string: '글자들이 이어진 문자열입니다.',
  boolean: '`true` 또는 `false` 둘 중 하나를 담습니다.',
  object: '원시값(숫자·문자열 등)이 아닌 모든 객체를 뜻하는 타입입니다.',
  symbol: '유일함이 보장되는 식별자 값의 타입입니다.',
  bigint: '크기 제한 없는 정수를 담는 타입입니다. 숫자 뒤에 `n` 을 붙여 만듭니다.',
  void: '값이 사실상 없음을 뜻하는 타입입니다. 돌려줄 게 없는 함수의 반환형으로 씁니다.',
  module: '모듈/네임스페이스를 선언하는 옛 표기입니다. 지금은 `namespace` 또는 ES 모듈을 씁니다.'
}

// ── Python ───────────────────────────────────────────────────────────────────
const PY_GLOSSARY: Gloss = {
  def: '함수(또는 메서드)를 정의합니다.',
  class: '객체를 찍어내는 틀(클래스)을 정의합니다. 필드·메서드·상속을 가질 수 있습니다.',
  return: '함수를 끝내고 값을 반환합니다. 값이 없으면 `None` 을 돌려줍니다.',
  pass: '아무것도 하지 않는 자리 채움 문장입니다. 비워둘 수 없는 블록에 씁니다.',
  if: '조건이 참이면 그 안의 코드를 실행합니다.',
  elif: '앞의 `if` 가 거짓일 때 다음 조건을 검사합니다. (else if)',
  else: '앞의 조건이 모두 거짓일 때 대신 실행합니다.',
  for: '리스트·range 등 이터러블의 원소를 하나씩 돌면서 실행합니다.',
  while: '조건이 참인 동안 반복해서 실행합니다.',
  break: '현재 반복문을 즉시 빠져나옵니다.',
  continue: '이번 반복은 건너뛰고 다음 반복으로 넘어갑니다.',
  match: '값의 모양에 따라 여러 `case` 갈래로 나눠 처리합니다. (구조 분해 패턴 매칭, 3.10+)',
  case: '`match` 에서 패턴이 일치할 때 실행되는 갈래입니다.',
  import: '다른 모듈을 가져와 사용할 수 있게 합니다.',
  from: '모듈에서 특정 이름만 골라 가져옵니다. (`from os import path`)',
  as: '가져온 모듈이나 예외에 짧은 별명을 붙입니다. (`import numpy as np`)',
  with: '컨텍스트 매니저와 함께 블록을 실행합니다. 블록이 끝나면 파일 닫기 같은 정리가 자동으로 됩니다.',
  try: '오류가 날 수 있는 코드를 감쌉니다. 오류가 나면 `except` 로 넘어갑니다.',
  except: '`try` 안에서 발생한 예외를 받아 처리합니다.',
  finally: '예외가 났든 안 났든 마지막에 반드시 실행됩니다.',
  raise: '예외를 일으켜 실행을 중단시킵니다. 가장 가까운 `except` 가 받습니다.',
  assert: '조건이 참인지 확인하고, 거짓이면 `AssertionError` 를 일으킵니다. 디버깅용 검증에 씁니다.',
  lambda: '이름 없는 한 줄짜리 함수를 만듭니다. (`lambda x: x * 2`)',
  yield: '제너레이터 함수에서 값을 하나 내보내고 실행을 잠시 멈춥니다. 다음 요청 때 이어서 실행됩니다.',
  async: '비동기 함수(코루틴)를 만듭니다. 안에서 `await` 를 쓸 수 있습니다.',
  await: '비동기 작업이 끝날 때까지 기다렸다가 그 결과값을 꺼냅니다. `async` 함수 안에서 씁니다.',
  global: '함수 안에서 모듈 전역 변수에 대입할 수 있게 선언합니다.',
  nonlocal: '중첩 함수 안에서 바깥(감싸는) 함수의 변수에 대입할 수 있게 선언합니다.',
  del: '변수나 객체의 속성·원소를 지웁니다.',
  and: '양쪽이 모두 참이어야 참입니다.',
  or: '한쪽이라도 참이면 참입니다.',
  not: '참과 거짓을 뒤집습니다.',
  is: '두 값이 "같은 객체"인지 검사합니다. 값 비교(`==`)와 다릅니다.',
  // 값·특수 이름
  None: '"값이 없음"을 나타내는 값입니다.',
  True: '참 값입니다.',
  False: '거짓 값입니다.',
  self: '메서드가 속한 인스턴스 자신을 가리키는 관례적 이름입니다. 첫 번째 매개변수로 옵니다.',
  cls: '클래스 메서드에서 클래스 자체를 가리키는 관례적 이름입니다.',
  __init__: '객체가 만들어질 때 호출되는 초기화 메서드(생성자)입니다.',
  // 내장 타입
  int: '크기 제한 없는 정수입니다.',
  float: '소수점이 있는 수입니다.',
  str: '글자들이 이어진 문자열입니다.',
  bool: '`True` 나 `False` 둘 중 하나를 담습니다.',
  list: '여러 값을 순서대로 담는, 크기가 변하는 배열입니다.',
  dict: '키로 값을 찾는 묶음(해시 맵)입니다.',
  tuple: '여러 값을 한 묶음으로 담는, 바꿀 수 없는 나열입니다.',
  set: '중복 없는 값들의 모음입니다.',
  bytes: '바이트(이진 데이터)들의 바꿀 수 없는 나열입니다.'
}

// ── C# ───────────────────────────────────────────────────────────────────────
const CS_GLOSSARY: Gloss = {
  // 타입 선언
  class: '객체 타입(참조 형식)을 정의합니다. 변수에 담아도 복사되지 않고 원본을 가리킵니다.',
  struct: '값 형식을 정의합니다. 대입하거나 넘길 때 전체가 복사됩니다.',
  interface: '어떤 멤버들을 갖춰야 하는지 정해 둔 약속입니다. 클래스/구조체가 이를 구현합니다.',
  enum: '이름을 붙인 정수 상수들을 나열한 목록 타입입니다.',
  record: '값 비교·복사(`with`)가 기본 제공되는 불변 지향 타입입니다.',
  delegate: '메서드를 값처럼 담아 전달할 수 있는 타입입니다.',
  event: '구독/해지(`+=`/`-=`)할 수 있는 알림 멤버입니다. 델리게이트 기반입니다.',
  namespace: '관련 타입들을 한 이름 아래 묶습니다.',
  using: '네임스페이스를 가져오거나(파일 위), `IDisposable` 리소스를 블록이 끝날 때 자동 정리합니다(문장).',
  // 접근·한정자
  public: '어디서든 접근할 수 있습니다.',
  private: '그 타입 안에서만 접근할 수 있습니다. (멤버의 기본값)',
  protected: '그 타입과 상속받은 타입에서만 접근할 수 있습니다.',
  internal: '같은 어셈블리(프로젝트) 안에서만 접근할 수 있습니다.',
  static: '인스턴스가 아니라 타입 자체에 붙는 멤버로 만듭니다.',
  readonly: '생성자에서만 값을 정할 수 있는 읽기 전용 필드로 만듭니다.',
  const: '컴파일 시점에 값이 정해지는 상수를 선언합니다.',
  virtual: '상속받은 클래스가 `override` 로 재정의할 수 있는 멤버로 만듭니다.',
  override: '부모의 `virtual`/`abstract` 멤버를 재정의합니다.',
  abstract: '직접 인스턴스를 만들 수 없는 추상 타입/멤버로 만듭니다. 상속받는 쪽이 구현합니다.',
  sealed: '더 이상 상속(또는 재정의)할 수 없게 봉인합니다.',
  partial: '한 타입의 정의를 여러 파일에 나눠 적을 수 있게 합니다.',
  required: '객체를 만들 때 반드시 초기화해야 하는 멤버로 만듭니다.',
  // 변수·값
  var: '컴파일러가 초기값에서 타입을 추론하는 지역 변수를 선언합니다.',
  new: '새 객체를 만듭니다. 멤버 앞에서는 부모 멤버를 가리는 재선언 표시이기도 합니다.',
  this: '지금 인스턴스 자신을 가리킵니다.',
  base: '부모 클래스를 가리킵니다. `base.메서드()` 로 부모 구현을 호출합니다.',
  null: '참조가 아무 객체도 가리키지 않음을 나타내는 값입니다.',
  true: '참 값입니다.',
  false: '거짓 값입니다.',
  default: '타입의 기본값(참조는 `null`, 숫자는 0…)을 뜻합니다. `switch` 에서는 기본 갈래입니다.',
  value: '`set` 접근자 안에서, 대입하려는 그 값을 가리키는 암시적 이름입니다.',
  nameof: '심볼의 이름을 컴파일 시점 문자열로 바꿉니다.',
  typeof: '타입의 `System.Type` 정보를 얻습니다.',
  sizeof: '값 형식이 차지하는 바이트 수를 얻습니다.',
  // 흐름 제어
  return: '메서드를 끝내고 값을 반환합니다.',
  if: '조건이 참이면 그 안의 코드를 실행합니다.',
  else: '`if` 의 조건이 거짓일 때 대신 실행합니다.',
  for: '초기식·조건·증감식으로 도는 반복문입니다.',
  foreach: '컬렉션의 원소를 하나씩 돌면서 실행합니다.',
  while: '조건이 참인 동안 반복해서 실행합니다.',
  do: '일단 한 번 실행하고, 그다음부터 `while` 조건을 보고 반복합니다.',
  switch: '값이나 패턴에 따라 여러 `case` 갈래로 나눠 처리합니다.',
  case: '`switch` 에서 값/패턴이 일치할 때 실행되는 갈래입니다.',
  break: '현재 반복문이나 `switch` 를 즉시 빠져나옵니다.',
  continue: '이번 반복은 건너뛰고 다음 반복으로 넘어갑니다.',
  yield: '반복기(iterator) 메서드에서 값을 하나 내보내고 다음 요청까지 멈춥니다.',
  lock: '한 번에 한 스레드만 블록을 실행하게 잠급니다.',
  // 예외
  try: '오류가 날 수 있는 코드를 감쌉니다. 예외가 나면 `catch` 로 넘어갑니다.',
  catch: '`try` 안에서 던져진 예외를 받아 처리합니다.',
  finally: '예외가 났든 안 났든 마지막에 반드시 실행됩니다.',
  throw: '예외를 던져 실행을 중단시킵니다.',
  when: '`catch`/`case` 에 추가 조건을 붙이는 필터입니다.',
  // 비동기
  async: '비동기 메서드를 만듭니다. 보통 `Task` 를 돌려주고, 안에서 `await` 를 쓸 수 있습니다.',
  await: '비동기 작업이 끝날 때까지 기다렸다가 결과값을 꺼냅니다. 스레드를 막지 않습니다.',
  // 매개변수 전달
  ref: '변수를 참조로 전달합니다. 메서드 안에서 바꾸면 원본도 바뀝니다.',
  out: '메서드가 값을 내보내는 용도의 매개변수입니다. 메서드가 반드시 값을 채워야 합니다.',
  params: '가변 개수 인자를 배열로 받는 매개변수입니다.',
  is: '값이 어떤 타입/패턴에 맞는지 검사합니다.',
  as: '참조를 다른 타입으로 변환하되, 실패하면 예외 대신 `null` 을 돌려줍니다.',
  in: '읽기 전용 참조로 전달합니다. `foreach` 에서는 컬렉션을 지정합니다.',
  where: '제네릭 타입 매개변수에 제약을 겁니다. (`where T : class`)',
  with: '`record` 를 일부 값만 바꿔 복사합니다.',
  get: '속성을 읽을 때 실행되는 접근자입니다.',
  set: '속성에 값을 넣을 때 실행되는 접근자입니다.',
  init: '객체 초기화 때만 값을 넣을 수 있는 세터입니다. 이후에는 읽기 전용이 됩니다.',
  // 내장 타입
  int: '32비트 정수입니다.',
  long: '64비트 정수입니다.',
  short: '16비트 정수입니다.',
  byte: '8비트 부호 없는 정수(0~255)입니다.',
  sbyte: '8비트 부호 있는 정수입니다.',
  uint: '32비트 부호 없는 정수입니다.',
  ulong: '64비트 부호 없는 정수입니다.',
  ushort: '16비트 부호 없는 정수입니다.',
  float: '32비트 소수(단정밀도)입니다. 리터럴엔 `f` 를 붙입니다.',
  double: '64비트 소수(배정밀도)입니다. 소수 리터럴의 기본 타입입니다.',
  decimal: '금액 계산에 알맞은 고정 정밀도 십진 소수입니다. 리터럴엔 `m` 을 붙입니다.',
  bool: '`true` 나 `false` 둘 중 하나를 담습니다.',
  char: '글자 하나(UTF-16 코드 유닛)를 담습니다.',
  string: '글자들이 이어진 문자열입니다. 내용을 바꿀 수 없는 불변 타입입니다.',
  object: '모든 타입의 뿌리 타입입니다. 무엇이든 담을 수 있습니다.',
  dynamic: '타입 검사를 실행 시점으로 미루는 타입입니다.',
  void: '값이 없음을 뜻합니다. 돌려줄 게 없는 메서드의 반환형으로 씁니다.'
}

// ── C 공통 코어 (C++가 물려받는 어휘) ────────────────────────────────────────
const C_CORE: Gloss = {
  struct: '여러 값을 하나로 묶는 타입을 정의합니다.',
  union: '여러 멤버가 같은 메모리 공간을 공유하는 타입을 정의합니다. 한 번에 한 멤버만 유효합니다.',
  enum: '이름을 붙인 정수 상수들을 나열한 목록 타입입니다.',
  typedef: '타입에 새 이름(별명)을 붙입니다.',
  const: '값을 바꿀 수 없게 만듭니다.',
  static: '전역이나 함수에 붙이면 이 파일 안에서만 보이게 하고, 지역 변수에 붙이면 함수가 끝나도 값이 유지되게 합니다.',
  extern: '정의가 다른 파일에 있다고 알리는 선언입니다.',
  inline: '함수 호출을 그 자리에 코드로 대체할 수 있음을 컴파일러에 알리는 지시자입니다.',
  volatile:
    '이 값이 하드웨어나 다른 실행 흐름에 의해 언제든 바뀔 수 있음을 알립니다. 컴파일러가 읽기/쓰기를 최적화로 생략하지 못하게 됩니다.',
  return: '함수를 끝내고 값을 반환합니다.',
  if: '조건이 참이면 그 안의 코드를 실행합니다.',
  else: '`if` 의 조건이 거짓일 때 대신 실행합니다.',
  for: '초기식·조건식·증감식을 가진 반복문입니다.',
  while: '조건이 참인 동안 반복해서 실행합니다.',
  do: '먼저 한 번 실행한 뒤, `while` 조건을 확인하며 반복합니다.',
  switch: '정수 값에 따라 여러 `case` 갈래 중 하나로 나눠 처리합니다.',
  case: '`switch` 에서 값이 일치할 때 실행되는 갈래입니다.',
  default: '`switch` 에서 어느 `case` 에도 해당하지 않을 때 실행되는 갈래입니다.',
  break: '현재 반복문이나 `switch` 를 즉시 빠져나옵니다.',
  continue: '이번 반복을 건너뛰고 다음 반복으로 넘어갑니다.',
  goto: '같은 함수 안의 라벨 위치로 실행을 옮깁니다.',
  sizeof: '타입이나 값이 메모리에서 차지하는 크기(바이트 수)를 알려줍니다.',
  // 내장 타입
  void: '값이 없음을 뜻하는 타입입니다. 반환값이 없는 함수의 반환형이나, 어떤 타입이든 가리킬 수 있는 포인터(`void*`)에 사용합니다.',
  int: '기본 정수 타입입니다. 대부분의 환경에서 32비트입니다.',
  long: '`int` 보다 크거나 같은 정수 타입입니다. `long long` 은 최소 64비트를 보장합니다.',
  short: '작은 정수 타입입니다. (최소 16비트)',
  char: '문자 하나(1바이트)를 담습니다. 가장 작은 정수 타입으로도 사용합니다.',
  float: '32비트(단정밀도) 실수입니다.',
  double: '64비트(배정밀도) 실수입니다. 실수 리터럴의 기본 타입입니다.',
  unsigned: '음수 없이 0 이상의 값만 담는 정수로 만듭니다.',
  signed: '음수도 담을 수 있는(부호 있는) 정수로 만듭니다. (기본값)',
  bool: '`true` 또는 `false` 둘 중 하나를 담습니다.',
  true: '참 값입니다.',
  false: '거짓 값입니다.'
}

// ── C ────────────────────────────────────────────────────────────────────────
const C_GLOSSARY: Gloss = {
  ...C_CORE,
  register: '변수를 CPU 레지스터에 배치하도록 요청하는 최적화 힌트입니다. 현대 컴파일러는 이 힌트를 무시합니다.',
  restrict: '해당 메모리에 이 포인터로만 접근한다는 것을 컴파일러에 알리는 한정자입니다.',
  NULL: '아무것도 가리키지 않는 포인터 값입니다.'
}

// ── C++ = C 코어 + C++ 어휘 ──────────────────────────────────────────────────
const CPP_GLOSSARY: Gloss = {
  ...C_CORE,
  class: '데이터(멤버 변수)와 그 데이터를 다루는 함수(멤버 함수)를 하나로 묶은 객체 타입을 정의합니다. 상속과 가상 함수를 가질 수 있습니다.',
  namespace: '관련 코드를 한 이름 아래로 묶어 이름 충돌을 막습니다.',
  template: '타입이나 값을 매개변수로 받아, 여러 타입에 두루 동작하는 코드(템플릿)를 만듭니다.',
  typename: '템플릿 매개변수가 타입임을 나타냅니다. 템플릿 안에서 어떤 이름이 타입이라는 것을 알릴 때도 사용합니다.',
  using: '타입에 별명을 붙이거나(`using T = …`), 다른 네임스페이스의 이름을 가져와 짧게 사용할 수 있게 합니다.',
  auto: '초기값으로부터 컴파일러가 타입을 추론하게 합니다.',
  decltype: '어떤 식의 타입을 그대로 가져오는 타입 연산자입니다.',
  constexpr: '컴파일 시점에 값이 계산될 수 있는 상수나 함수로 만듭니다.',
  consteval: '반드시 컴파일 시점에 실행되는 함수로 만듭니다. (C++20)',
  constinit: '정적 변수가 컴파일 시점에 초기화된다는 것을 보장합니다. (C++20)',
  virtual:
    '이 함수를 가상 함수로 만듭니다. 가상 함수는 상속받은 클래스가 자신에게 맞게 다시 정의할 수 있고, 부모 타입의 포인터나 참조로 호출해도 실제 객체의 타입에 맞는 함수가 실행됩니다.',
  override:
    '부모 클래스에서 `virtual` 로 선언된 함수를, 상속받은 클래스에서 다시 정의한다는 것을 명시하는 지정자입니다. 부모 클래스에 일치하는 가상 함수가 없으면 컴파일 오류가 발생합니다.',
  final:
    '클래스 이름 뒤에 붙이면 그 클래스를 더 이상 상속할 수 없게 하고, 가상 함수 뒤에 붙이면 상속받은 클래스에서 그 함수를 다시 정의할 수 없게 합니다.',
  explicit:
    '생성자나 변환 연산자가 자동 형 변환(암시적 변환)에 사용되지 않게 막습니다. 해당 변환은 코드에 명시적으로 적었을 때만 일어납니다.',
  friend: '지정한 함수나 클래스가 이 클래스의 `private` 멤버에 접근할 수 있게 허용합니다.',
  mutable: '`const` 객체 안에서도 값을 바꿀 수 있는 멤버로 만듭니다.',
  operator: '이 타입에 대한 연산자(`+`, `==` …)의 동작을 직접 정의합니다.',
  this: '지금 멤버 함수를 실행 중인 객체 자신을 가리키는 포인터입니다.',
  new: '힙(자유 저장소)에 객체를 만들고 그 포인터를 돌려줍니다.',
  delete: '`new` 로 만든 객체를 메모리에서 해제합니다. 함수 선언 뒤의 `= delete` 는 그 함수의 사용을 금지합니다.',
  public: '어디서든 접근할 수 있는 구역을 시작합니다. (`struct` 의 기본값)',
  private: '이 클래스 안에서만 접근할 수 있는 구역을 시작합니다. (`class` 의 기본값)',
  protected: '이 클래스와 상속받은 클래스에서만 접근할 수 있는 구역을 시작합니다.',
  try: '오류가 날 수 있는 코드를 감쌉니다. 예외가 발생하면 `catch` 로 넘어갑니다.',
  catch: '`try` 안에서 던져진 예외를 받아 처리합니다.',
  throw: '예외를 던져 실행을 중단시킵니다. 가장 가까운 `catch` 가 받습니다.',
  noexcept: '이 함수가 예외를 던지지 않는다고 선언합니다. 그럼에도 예외가 밖으로 나가면 프로그램이 종료됩니다.',
  nullptr: '아무것도 가리키지 않는 포인터 값(널 포인터 리터럴)입니다.',
  static_cast: '컴파일 시점에 검사되는 일반적인 형 변환입니다.',
  dynamic_cast:
    '상속 관계가 맞는지 실행 시점에 확인하며 변환합니다. 실패하면 포인터는 `nullptr` 가 되고, 참조는 예외를 던집니다.',
  const_cast: '`const` 를 벗기거나 붙이는 형 변환입니다.',
  reinterpret_cast: '메모리의 비트를 그대로 다른 타입으로 재해석하는 저수준 형 변환입니다.',
  concept: '템플릿 인자가 갖춰야 할 조건에 이름을 붙인 것입니다. (C++20)',
  requires: '템플릿 인자에 제약(concept)을 붙입니다. (C++20)',
  co_await: '코루틴에서 비동기 작업이 끝날 때까지 기다립니다.',
  co_yield: '코루틴에서 값을 하나 내보내고 잠시 멈춥니다. 다음 요청이 오면 이어서 실행됩니다.',
  co_return: '코루틴을 끝내고 값을 반환합니다.',
  wchar_t: '와이드 문자 하나를 담습니다.',
  char8_t: 'UTF-8 코드 유닛 하나를 담습니다. (C++20)',
  char16_t: 'UTF-16 코드 유닛 하나를 담습니다.',
  char32_t: 'UTF-32 코드 포인트 하나를 담습니다.'
}

// ══════════════════════════════════════════════════════════════════════════════
// Unreal Engine C++ — UE 프로젝트(.uproject 조상)의 C++ 파일에서만 활성화되는 전용 어휘.
// Verse가 <지정자>·내장 타입을 전용 사전으로 다루는 것과 같은 위치의 기능이다.
//  · UE_CPP_TYPES  — int32·FString·TArray… (clangd가 침묵할 때의 폴백 + 카드 안 토큰 설명)
//  · UE_CPP_MACROS — UPROPERTY·UCLASS·GENERATED_BODY… (clangd의 `#define …` 전개 카드는
//    정보가 없으므로 LSP보다 먼저 우리 설명으로 답한다 — Verse 내장 타입 덮어쓰기와 동일)
//  · UE_SPECIFIERS — 매크로 괄호 안 지정자(EditAnywhere·BlueprintCallable…). 언리얼 헤더 툴
//    (UHT)만 아는 토큰이라 clangd는 아무것도 못 준다. `UPROPERTY(…)` 괄호 안일 때만 답해
//    같은 이름의 일반 식별자와 충돌하지 않는다(Verse specAt와 같은 컨텍스트 게이트).
// ══════════════════════════════════════════════════════════════════════════════

/** UE 기본 타입·컨테이너·핵심 클래스 — 폴백 호버와 카드 안 토큰 설명에 쓴다. */
export const UE_CPP_TYPES: Gloss = {
  int8: '8비트 부호 있는 정수입니다. 플랫폼에 관계없이 크기가 고정됩니다.',
  int16: '16비트 부호 있는 정수입니다. 플랫폼에 관계없이 크기가 고정됩니다.',
  int32: '32비트 부호 있는 정수입니다. 플랫폼에 관계없이 크기가 고정됩니다.',
  int64: '64비트 부호 있는 정수입니다. 플랫폼에 관계없이 크기가 고정됩니다.',
  uint8: '8비트 부호 없는 정수입니다. 블루프린트에 노출할 수 있는 가장 작은 정수 타입입니다.',
  uint16: '16비트 부호 없는 정수입니다. 플랫폼에 관계없이 크기가 고정됩니다.',
  uint32: '32비트 부호 없는 정수입니다. 플랫폼에 관계없이 크기가 고정됩니다.',
  uint64: '64비트 부호 없는 정수입니다. 플랫폼에 관계없이 크기가 고정됩니다.',
  TCHAR: '플랫폼에 맞는 문자 타입입니다. 문자열 리터럴은 `TEXT("…")` 매크로로 감쌉니다.',
  FString: '수정 가능한 문자열입니다. 이어 붙이기·자르기 등 문자열 조작에 사용합니다.',
  FName: '빠른 비교를 위한 불변 식별자 문자열입니다. 대소문자를 구분하지 않으며, 이름·태그에 사용합니다.',
  FText: '표시용 텍스트입니다. 현지화(번역)를 지원하며 UI에 보여줄 문자열에 사용합니다.',
  FVector: '3차원 벡터(X·Y·Z)입니다. 위치·방향·크기를 나타냅니다.',
  FVector2D: '2차원 벡터(X·Y)입니다.',
  FRotator: '오일러 각 회전(Pitch·Yaw·Roll)입니다.',
  FQuat: '쿼터니언 회전입니다. 짐벌 락이 없어 회전 보간·합성에 사용합니다.',
  FTransform: '위치·회전·스케일을 하나로 묶은 변환입니다.',
  FColor: '채널당 8비트 정수로 표현하는 색(RGBA)입니다.',
  FLinearColor: '채널당 실수로 표현하는 선형 색(RGBA)입니다.',
  TArray: '크기가 변하는 동적 배열입니다.',
  TMap: '키로 값을 찾는 연관 컨테이너입니다.',
  TSet: '중복 없는 값들의 집합입니다.',
  TSubclassOf: '지정한 클래스와 그 자식 클래스만 담을 수 있는 클래스 참조입니다.',
  TObjectPtr: '`UObject` 를 가리키는 포인터 래퍼입니다. 멤버 변수 선언에서 원시 포인터를 대신합니다.',
  TWeakObjectPtr: '가비지 컬렉션을 막지 않는 약한 `UObject` 참조입니다. 대상이 파괴되면 무효가 됩니다.',
  TSoftObjectPtr: '애셋을 경로로 가리키는 참조입니다. 대상이 아직 로드되지 않았을 수 있으며, 필요할 때 로드합니다.',
  TSharedPtr: '비-`UObject` 객체를 공유 소유하는 스마트 포인터입니다. 마지막 소유자가 사라지면 해제됩니다.',
  TSharedRef: '항상 유효한 객체를 가리키는 공유 참조입니다. `TSharedPtr` 와 달리 비어 있을 수 없습니다.',
  TUniquePtr: '비-`UObject` 객체를 단독 소유하는 스마트 포인터입니다.',
  // ── 핵심 클래스 (공식 문서 기준 설명) ──────────────────────────────────────
  UObject:
    '모든 언리얼 오브젝트의 기본 클래스입니다. 리플렉션·직렬화·가비지 컬렉션·네트워크 복제 등 오브젝트 시스템의 기능을 제공하며, 타입 정보는 `UClass` 로 표현됩니다.',
  AActor:
    '레벨에 배치하거나 스폰할 수 있는 오브젝트의 기본 클래스입니다. 이동·렌더링 등 실제 기능은 부착된 액터 컴포넌트들이 담당하며, 네트워크 플레이에서 프로퍼티와 함수 호출이 복제되는 단위가 됩니다.',
  APawn: '플레이어나 AI가 빙의(possess)해 조종할 수 있는 액터의 기본 클래스입니다. 레벨 안에서 플레이어와 캐릭터의 물리적 표현이 됩니다.',
  ACharacter:
    '스켈레탈 메시·콜리전·이동 로직이 내장된 폰입니다. `UCharacterMovementComponent` 를 통해 걷기·점프·비행·수영을 지원하며, 기본 네트워킹과 입력 모델을 구현합니다.',
  AController: '폰에 빙의해 그 행동을 제어하는 비물리적 액터입니다. `APlayerController` 와 `AAIController` 의 공통 부모입니다.',
  APlayerController: '사람 플레이어가 폰을 조종하는 데 사용하는 컨트롤러입니다. 플레이어의 입력을 받아 동작으로 옮기며, 네트워크 플레이에서 각 클라이언트를 대표합니다.',
  AAIController: '폰을 AI로 조종하는 컨트롤러입니다. 비헤이비어 트리·내비게이션 시스템과 함께 사용합니다.',
  AGameModeBase: '게임의 규칙(플레이어 입장·스폰·승패 판정 등)을 정의합니다. 서버에만 존재하며 클라이언트로 복제되지 않습니다.',
  AGameStateBase: '게임 전체의 상태를 담고 모든 클라이언트로 복제됩니다. 서버 전용인 게임 모드와 달리 모두가 볼 수 있습니다.',
  APlayerState: '이름·점수 등 각 플레이어의 상태를 담고 모든 클라이언트로 복제됩니다.',
  UGameInstance: '게임 실행 전체 동안 유지되는 관리 오브젝트입니다. 레벨을 이동해도 파괴되지 않아 레벨 사이에 공유할 데이터를 두는 곳입니다.',
  UWorld: '맵을 나타내는 최상위 오브젝트입니다. 액터와 컴포넌트가 존재하고 렌더링되는 공간이며, 레벨들을 담습니다.',
  // ── 컴포넌트 ────────────────────────────────────────────────────────────
  UActorComponent: '액터에 추가해 재사용 가능한 동작을 정의하는 컴포넌트의 기본 클래스입니다. 트랜스폼은 갖지 않습니다.',
  USceneComponent: '트랜스폼(위치·회전·스케일)과 계층 부착을 지원하는 컴포넌트입니다. 자체 렌더링이나 콜리전은 없습니다.',
  UPrimitiveComponent: '렌더링되거나 콜리전으로 사용될 지오메트리를 가지는 씬 컴포넌트입니다. 메시·셰이프 컴포넌트의 공통 부모입니다.',
  UStaticMeshComponent: '스태틱 메시(변형되지 않는 지오메트리)의 인스턴스를 렌더링하는 컴포넌트입니다.',
  USkeletalMeshComponent: '스켈레톤(뼈대)으로 애니메이션되는 스켈레탈 메시를 렌더링하는 컴포넌트입니다.',
  UCharacterMovementComponent: '캐릭터의 걷기·달리기·점프·비행·수영 이동을 처리하는 컴포넌트입니다. 네트워크 이동 동기화를 지원합니다.',
  UCameraComponent: '카메라 시점을 제공하는 컴포넌트입니다.',
  USpringArmComponent: '자식(주로 카메라)을 일정 거리에 유지하고, 장애물에 막히면 거리를 자동으로 줄이는 붐(팔) 컴포넌트입니다.',
  UBoxComponent: '박스 모양의 콜리전 컴포넌트입니다. 오버랩·충돌 판정에 사용합니다.',
  USphereComponent: '구 모양의 콜리전 컴포넌트입니다. 오버랩·충돌 판정에 사용합니다.',
  UCapsuleComponent: '캡슐 모양의 콜리전 컴포넌트입니다. 캐릭터의 기본 콜리전으로도 사용됩니다.',
  UInputComponent: '입력(키·축) 바인딩을 처리하는 컴포넌트입니다.',
  UUserWidget: 'UMG 위젯의 기본 클래스입니다. 블루프린트로 UI를 만들 때 부모로 사용합니다.',
  // ── Enhanced Input ──────────────────────────────────────────────────────
  UInputAction: "엔핸스드 인풋의 입력 액션 애셋입니다. '점프'·'이동' 같은 행동 하나를 나타내며, 게임플레이 코드는 이 액션의 이벤트에 바인딩합니다.",
  UInputMappingContext: '엔핸스드 인풋의 매핑 컨텍스트 애셋입니다. 키(하드웨어 입력)를 입력 액션에 묶는 목록이며, 우선순위를 두고 여러 개를 겹쳐 적용할 수 있습니다.',
  UEnhancedInputComponent: '엔핸스드 인풋용 입력 컴포넌트입니다. 입력 액션을 델리게이트 함수에 바인딩합니다.',
  FInputActionValue: '입력 액션의 현재 값을 담는 구조체입니다. bool·1축·2축·3축 값을 담을 수 있고, `Get<T>()` 로 원하는 타입으로 꺼냅니다.',
  UEnhancedInputLocalPlayerSubsystem: '로컬 플레이어별 엔핸스드 인풋 서브시스템입니다. 매핑 컨텍스트를 추가·제거할 때 사용합니다.',
  // ── 자주 쓰는 구조체 ─────────────────────────────────────────────────────
  FHitResult: '충돌·트레이스 결과(맞은 액터·컴포넌트·위치·노멀 등)를 담는 구조체입니다.',
  FTimerHandle: '등록한 타이머를 식별하는 핸들입니다. 타이머 매니저로 타이머를 시작·정지할 때 사용합니다.',
  FObjectInitializer: '생성자 인자로 전달되는 UObject 생성 헬퍼입니다. 서브오브젝트 생성 방식 등 생성 과정을 설정할 때 사용합니다.',
  FLifetimeProperty: '네트워크 복제 대상으로 등록된 프로퍼티 하나를 나타내는 구조체입니다. `GetLifetimeReplicatedProps` 에서 등록합니다.'
}

/** UE 리플렉션 매크로 — clangd의 매크로 전개 카드에는 정보가 없으므로 LSP보다 먼저 답한다. */
export const UE_CPP_MACROS: Gloss = {
  UCLASS:
    '클래스를 언리얼 오브젝트 시스템에 등록하는 매크로입니다. 리플렉션·가비지 컬렉션·블루프린트 노출이 가능해지며, 괄호 안에 지정자를 붙여 동작을 설정합니다.',
  USTRUCT:
    '구조체를 리플렉션 시스템에 등록하는 매크로입니다. 값으로 복사되는 데이터 묶음에 사용하며, 멤버 변수는 `UPROPERTY` 로 노출할 수 있지만 `UFUNCTION` 함수는 가질 수 없습니다. `UObject` 와 달리 가비지 컬렉션의 대상이 아닙니다.',
  UENUM: '열거형을 리플렉션 시스템에 등록하는 매크로입니다.',
  UINTERFACE: '언리얼 인터페이스를 선언하는 매크로입니다. 실제 함수는 짝이 되는 `I접두사` 클래스에 선언합니다.',
  UFUNCTION:
    '함수를 리플렉션 시스템에 등록하는 매크로입니다. 블루프린트 호출·네트워크 RPC 등의 지정자를 붙일 수 있습니다.',
  UPROPERTY:
    '멤버 변수를 리플렉션 시스템에 등록하는 매크로입니다. 에디터 노출·블루프린트 접근·네트워크 복제 등의 지정자를 붙일 수 있으며, 등록된 `UObject` 포인터는 가비지 컬렉션이 추적합니다.',
  UPARAM: '함수 매개변수에 지정자를 붙이는 매크로입니다. (`UPARAM(ref)` 등)',
  UMETA: '열거형 값에 메타데이터를 붙이는 매크로입니다. (`UMETA(DisplayName="…")` 등)',
  GENERATED_BODY: '언리얼 헤더 툴(UHT)이 생성한 코드를 이 자리에 삽입하는 매크로입니다. `UCLASS`/`USTRUCT` 본문의 첫 줄에 필요합니다.',
  GENERATED_USTRUCT_BODY: '언리얼 헤더 툴(UHT)이 생성한 코드를 구조체 본문에 삽입하는 매크로입니다. (`GENERATED_BODY` 의 옛 표기)',
  UE_LOG: '로그를 출력하는 매크로입니다. 카테고리, 상세 수준, 형식 문자열 순으로 적습니다.',
  TEXT: '문자열 리터럴을 플랫폼에 맞는 `TCHAR` 문자열로 만드는 매크로입니다. 언리얼 문자열 리터럴은 항상 이걸로 감쌉니다.',
  // 유틸·어서션 매크로
  FORCEINLINE: '함수를 강제로 인라인하도록 컴파일러에 지시하는 매크로입니다.',
  FORCENOINLINE: '이 함수를 인라인하지 않도록 컴파일러에 지시하는 매크로입니다.',
  FORCEINLINE_DEBUGGABLE: '강제 인라인하되, 디버깅이 쉬운 빌드에서는 인라인하지 않는 매크로입니다.',
  UE_DEPRECATED: '심볼이 폐기 예정임을 표시하는 매크로입니다. 사용하는 곳에 버전과 안내 메시지가 담긴 컴파일 경고가 나옵니다.',
  DOREPLIFETIME: '프로퍼티를 네트워크 복제 대상으로 등록하는 매크로입니다. `GetLifetimeReplicatedProps` 안에서 사용합니다.',
  DOREPLIFETIME_CONDITION: '프로퍼티를 조건부 네트워크 복제 대상으로 등록하는 매크로입니다. (`COND_OwnerOnly` 등 복제 조건을 함께 지정)',
  DOREPLIFETIME_WITH_PARAMS: '프로퍼티를 네트워크 복제 대상으로 등록하면서, 복제 조건·푸시 모델 여부 등 세부 설정(`FDoRepLifetimeParams`)을 함께 지정하는 매크로입니다.',
  DOREPLIFETIME_WITH_PARAMS_FAST: '프로퍼티를 네트워크 복제 대상으로 등록하는 고속 매크로입니다. 복제 조건·푸시 모델 여부 등 세부 설정(`FDoRepLifetimeParams`)을 함께 지정하며, 리플렉션 조회를 줄인 등록 경로를 사용합니다.',
  MARK_PROPERTY_DIRTY: '푸시 모델에서 프로퍼티 값이 바뀌었음을 네트워크 시스템에 알리는 매크로입니다. 이렇게 표시된 프로퍼티만 복제 검사 대상이 됩니다.',
  MARK_PROPERTY_DIRTY_FROM_NAME: '푸시 모델에서 프로퍼티 값이 바뀌었음을 네트워크 시스템에 알리는 매크로입니다. 클래스와 프로퍼티 이름으로 지정합니다.',
  UE_NET_DECLARE_SERIALIZER: 'Iris 리플리케이션의 커스텀 넷시리얼라이저를 선언하는 매크로입니다. 헤더에 두고, 구현은 `UE_NET_IMPLEMENT_SERIALIZER` 로 짝을 맞춥니다.',
  UE_NET_IMPLEMENT_SERIALIZER: 'Iris 리플리케이션의 커스텀 넷시리얼라이저 구현을 등록하는 매크로입니다.',
  UE_NET_GET_SERIALIZER: '등록된 Iris 넷시리얼라이저를 가져오는 매크로입니다.',
  INDEX_NONE: '"찾지 못했음"을 뜻하는 인덱스 상수(-1)입니다.',
  check: '조건이 거짓이면 실행을 중단(어서션)하는 매크로입니다. Shipping 빌드에서는 검사와 식 평가가 모두 제거됩니다.',
  checkf: '조건이 거짓이면 실행을 중단(어서션)하고, 형식 문자열로 만든 메시지를 함께 출력하는 매크로입니다. Shipping 빌드에서는 제거됩니다.',
  checkSlow: '조건이 거짓이면 실행을 중단(어서션)하는 매크로입니다. 디버그 빌드에서만 검사하고, 그 외 빌드에서는 제거됩니다.',
  ensure: '조건이 거짓이면 중단하지 않고 오류를 보고한 뒤 계속 실행하는 매크로입니다. 세션당 한 번만 보고하며, 디버거가 붙어 있으면 그 자리에서 멈춥니다.',
  ensureMsgf: '조건이 거짓이면 중단하지 않고 오류를 보고한 뒤 계속 실행하는 매크로입니다. 실패 시 형식 문자열로 만든 메시지를 함께 보고합니다.',
  ensureAlways: '조건이 거짓이면 중단하지 않고 오류를 보고한 뒤 계속 실행하는 매크로입니다. 세션당 한 번이 아니라 실패할 때마다 보고합니다.',
  verify: '조건식을 항상 실행하고, 거짓이면 실행을 중단하는 매크로입니다. Shipping 빌드에서도 식 자체는 실행됩니다.',
  verifyf: '조건식을 항상 실행하고, 거짓이면 실행을 중단하는 매크로입니다. 실패 시 형식 문자열로 만든 메시지를 함께 출력합니다.'
}

// 소문자 어서션 매크로 — 사용자 변수 이름과 충돌할 수 있으므로 `check(…)` 처럼
// 바로 뒤에 '('가 붙은 호출 형태일 때만 답한다 (Verse specAt 식 컨텍스트 게이트).
const UE_CALL_ONLY = new Set(['check', 'checkf', 'checkSlow', 'ensure', 'ensureMsgf', 'ensureAlways', 'verify', 'verifyf'])

// 접두사 계열 매크로 — DECLARE_DELEGATE_OneParam 처럼 접미사가 붙는 패밀리를 접두사로 잡는다.
const UE_MACRO_PREFIX: [string, string][] = [
  ['DECLARE_DYNAMIC_MULTICAST_DELEGATE', '블루프린트에서 바인딩할 수 있는 동적 멀티캐스트 델리게이트 타입을 선언하는 매크로입니다. 여러 곳에서 구독할 수 있고, `UPROPERTY(BlueprintAssignable)` 프로퍼티로 노출합니다. 접미사(`_OneParam` …)는 매개변수 개수를 나타냅니다.'],
  ['DECLARE_DYNAMIC_DELEGATE', '블루프린트에서 바인딩할 수 있는 동적 델리게이트 타입을 선언하는 매크로입니다. 접미사(`_OneParam` …)는 매개변수 개수를 나타냅니다.'],
  ['DECLARE_MULTICAST_DELEGATE', '여러 곳에서 구독할 수 있는 C++ 전용 멀티캐스트 델리게이트 타입을 선언하는 매크로입니다. 접미사(`_OneParam` …)는 매개변수 개수를 나타냅니다.'],
  ['DECLARE_DELEGATE', '하나의 함수만 바인딩하는 C++ 전용 델리게이트 타입을 선언하는 매크로입니다. 접미사(`_OneParam` …)는 매개변수 개수를 나타냅니다.'],
  ['DECLARE_EVENT', '선언한 클래스만 발동(Broadcast)할 수 있는 이벤트 타입을 선언하는 매크로입니다.'],
  // Iris / 네트워크 계열 — 변형(접미사)이 많아 접두사로 커버 (핵심 항목은 위 사전이 우선)
  ['UE_NET_DECLARE_', 'Iris 리플리케이션의 넷시리얼라이저 선언 계열 매크로입니다.'],
  ['UE_NET_IMPLEMENT_', 'Iris 리플리케이션의 넷시리얼라이저 구현/등록 계열 매크로입니다.'],
  ['UE_NET_REGISTER_', 'Iris 리플리케이션의 넷시리얼라이저 등록 매크로입니다.'],
  ['UE_NET_UNREGISTER_', 'Iris 리플리케이션의 넷시리얼라이저 등록을 해제하는 매크로입니다.'],
  ['MARK_PROPERTY_DIRTY', '푸시 모델에서 프로퍼티 값이 바뀌었음을 네트워크 시스템에 알리는 매크로입니다.'],
  ['DOREPLIFETIME', '프로퍼티를 네트워크 복제 대상으로 등록하는 매크로 계열입니다. `GetLifetimeReplicatedProps` 안에서 사용합니다.']
]

// 모듈 내보내기 매크로 — MYGAME_API·ENGINE_API 처럼 모듈마다 이름이 달라 패턴으로 잡는다.
const UE_API_DOC = '이 심볼을 모듈 밖으로 내보내는(export) 매크로입니다. 다른 모듈이 이 심볼에 링크할 수 있게 합니다.'

/** 매크로 괄호 안 지정자 하나 — 어떤 매크로들에서 유효한지(macros)와, 인자가 필요한 경우의
 *  완성 스니펫(snippet, `${}` 자리에 커서)을 함께 든다. */
export interface UeSpecEntry {
  name: string
  doc: string
  macros: string[] // 이 지정자가 유효한 매크로 이름들 (UPROPERTY·UFUNCTION·UCLASS…)
  snippet?: string // 인자형 지정자의 삽입 형태 — 없으면 이름 그대로
}

export const UE_SPECIFIERS: UeSpecEntry[] = [
  // ── UPROPERTY: 에디터 노출 ────────────────────────────────────────────────
  { name: 'EditAnywhere', macros: ['UPROPERTY'], doc: '에디터 프로퍼티 창에서 이 값을 편집할 수 있게 합니다. 클래스 기본값과 배치된 인스턴스 모두에서 편집됩니다.' },
  { name: 'EditDefaultsOnly', macros: ['UPROPERTY'], doc: '클래스 기본값(디폴트)에서만 편집할 수 있게 합니다. 배치된 인스턴스에서는 편집할 수 없습니다.' },
  { name: 'EditInstanceOnly', macros: ['UPROPERTY'], doc: '배치된 인스턴스에서만 편집할 수 있게 합니다. 클래스 기본값에서는 편집할 수 없습니다.' },
  { name: 'VisibleAnywhere', macros: ['UPROPERTY'], doc: '에디터 프로퍼티 창에 값이 보이지만 편집할 수는 없습니다. 클래스 기본값과 인스턴스 모두에서 보입니다.' },
  { name: 'VisibleDefaultsOnly', macros: ['UPROPERTY'], doc: '클래스 기본값(디폴트)에서만 값이 보이고, 편집할 수 없습니다.' },
  { name: 'VisibleInstanceOnly', macros: ['UPROPERTY'], doc: '배치된 인스턴스에서만 값이 보이고, 편집할 수 없습니다.' },
  { name: 'AdvancedDisplay', macros: ['UPROPERTY'], doc: '에디터 상세 패널의 "고급" 접힘 영역에 표시합니다.' },
  { name: 'EditFixedSize', macros: ['UPROPERTY'], doc: '배열의 원소는 편집할 수 있지만, 원소 개수는 에디터에서 바꿀 수 없게 합니다.' },
  // ── UPROPERTY: 블루프린트 ─────────────────────────────────────────────────
  { name: 'BlueprintReadOnly', macros: ['UPROPERTY'], doc: '블루프린트에서 이 값을 읽을 수 있게 합니다. 쓰기는 할 수 없습니다.' },
  { name: 'BlueprintReadWrite', macros: ['UPROPERTY'], doc: '블루프린트에서 이 값을 읽고 쓸 수 있게 합니다.' },
  { name: 'BlueprintAssignable', macros: ['UPROPERTY'], doc: '블루프린트에서 이 멀티캐스트 델리게이트에 이벤트를 바인딩할 수 있게 합니다.' },
  { name: 'BlueprintCallable', macros: ['UPROPERTY', 'UFUNCTION'], doc: '블루프린트에서 호출할 수 있게 합니다. 델리게이트 프로퍼티에 붙이면 블루프린트에서 그 델리게이트를 실행할 수 있습니다.' },
  // ── UPROPERTY: 저장·복제 ──────────────────────────────────────────────────
  { name: 'Transient', macros: ['UPROPERTY', 'UCLASS'], doc: '저장(직렬화) 대상에서 제외합니다. 로드 시 0으로 초기화됩니다.' },
  { name: 'Config', macros: ['UPROPERTY'], doc: '이 값을 설정 파일(ini)에서 읽어 옵니다. 클래스에 `Config` 지정(설정 파일 이름)이 필요합니다.' },
  { name: 'Config', macros: ['UCLASS'], snippet: 'Config=${}', doc: '이 클래스의 `Config` 프로퍼티들을 저장하고 읽어 올 설정 파일(ini) 이름을 지정합니다. (`Config=Game` → DefaultGame.ini)' },
  { name: 'SaveGame', macros: ['UPROPERTY'], doc: '세이브 게임 직렬화에 이 값을 포함합니다.' },
  { name: 'Replicated', macros: ['UPROPERTY'], doc: '이 값을 네트워크로 복제합니다. (서버 → 클라이언트)' },
  { name: 'ReplicatedUsing', macros: ['UPROPERTY'], snippet: 'ReplicatedUsing=${}', doc: '이 값을 네트워크로 복제하고, 복제된 값이 도착하면 지정한 함수(RepNotify)를 호출합니다.' },
  { name: 'NotReplicated', macros: ['UPROPERTY'], doc: '이 값을 복제에서 제외합니다. 복제되는 구조체의 멤버에 사용합니다.' },
  { name: 'DuplicateTransient', macros: ['UPROPERTY'], doc: '오브젝트를 복제(복사)할 때 이 값을 복사하지 않습니다.' },
  { name: 'Instanced', macros: ['UPROPERTY'], doc: '이 `UObject` 참조를 공유하지 않고, 소유자마다 별도의 인스턴스로 만듭니다.' },
  { name: 'Category', macros: ['UPROPERTY', 'UFUNCTION'], snippet: 'Category="${}"', doc: '에디터 상세 패널과 블루프린트 팔레트에서 이 항목이 속할 분류 이름을 지정합니다.' },
  { name: 'meta', macros: ['UPROPERTY', 'UFUNCTION', 'UCLASS', 'USTRUCT', 'UENUM'], snippet: 'meta=(${})', doc: '추가 메타데이터를 지정합니다. 표시 이름(`DisplayName`), 값 범위(`ClampMin`/`ClampMax`) 등을 넣습니다.' },
  // ── UFUNCTION ────────────────────────────────────────────────────────────
  { name: 'BlueprintPure', macros: ['UFUNCTION'], doc: '블루프린트에서 실행 핀 없이 값을 읽는 순수 노드로 만듭니다. 상태를 바꾸지 않는 함수에 사용합니다.' },
  { name: 'BlueprintImplementableEvent', macros: ['UFUNCTION'], doc: '구현을 C++이 아니라 블루프린트에서 작성하는 이벤트로 만듭니다. C++ 쪽 본문은 작성하지 않습니다.' },
  { name: 'BlueprintNativeEvent', macros: ['UFUNCTION'], doc: 'C++ 기본 구현(`함수명_Implementation`)을 두고, 블루프린트가 원하면 재정의할 수 있는 이벤트로 만듭니다.' },
  { name: 'CallInEditor', macros: ['UFUNCTION'], doc: '에디터 상세 패널에 이 함수를 실행하는 버튼을 만듭니다.' },
  { name: 'Exec', macros: ['UFUNCTION'], doc: '게임 콘솔 명령으로 이 함수를 호출할 수 있게 합니다.' },
  { name: 'Server', macros: ['UFUNCTION'], doc: '클라이언트에서 호출하면 서버에서 실행되는 RPC로 만듭니다. `Reliable` 또는 `Unreliable` 지정이 필요합니다.' },
  { name: 'Client', macros: ['UFUNCTION'], doc: '서버에서 호출하면 소유 클라이언트에서 실행되는 RPC로 만듭니다. `Reliable` 또는 `Unreliable` 지정이 필요합니다.' },
  { name: 'NetMulticast', macros: ['UFUNCTION'], doc: '서버에서 호출하면 서버와 모든 클라이언트에서 실행되는 RPC로 만듭니다. `Reliable` 또는 `Unreliable` 지정이 필요합니다.' },
  { name: 'Reliable', macros: ['UFUNCTION'], doc: 'RPC가 반드시 도착하도록 보장합니다.' },
  { name: 'Unreliable', macros: ['UFUNCTION'], doc: 'RPC의 도착을 보장하지 않습니다. 빈번하고 일부 유실돼도 되는 호출에 사용합니다.' },
  { name: 'WithValidation', macros: ['UFUNCTION'], doc: 'RPC 실행 전에 검증 함수(`함수명_Validate`)를 먼저 호출하게 합니다.' },
  { name: 'BlueprintAuthorityOnly', macros: ['UFUNCTION'], doc: '네트워크 권한(서버)이 있을 때만 실행되게 합니다.' },
  // ── UCLASS / USTRUCT / UENUM ─────────────────────────────────────────────
  { name: 'Blueprintable', macros: ['UCLASS'], doc: '이 클래스를 부모로 하는 블루프린트를 만들 수 있게 합니다.' },
  { name: 'NotBlueprintable', macros: ['UCLASS'], doc: '이 클래스로 블루프린트를 만들 수 없게 합니다.' },
  { name: 'BlueprintType', macros: ['UCLASS', 'USTRUCT', 'UENUM'], doc: '이 타입을 블루프린트에서 변수로 사용할 수 있게 합니다.' },
  { name: 'Abstract', macros: ['UCLASS'], doc: '이 클래스의 인스턴스를 직접 만들 수 없게 합니다. 상속 전용 기반 클래스에 사용합니다.' },
  { name: 'DefaultToInstanced', macros: ['UCLASS'], doc: '이 클래스에 대한 참조가 기본적으로 `Instanced` 로 취급되게 합니다.' },
  { name: 'EditInlineNew', macros: ['UCLASS'], doc: '이 클래스의 인스턴스를 에디터 프로퍼티 창에서 바로 생성할 수 있게 합니다.' },
  { name: 'Placeable', macros: ['UCLASS'], doc: '이 클래스를 레벨에 배치할 수 있게 합니다.' },
  { name: 'NotPlaceable', macros: ['UCLASS'], doc: '이 클래스를 레벨에 배치할 수 없게 합니다.' },
  { name: 'MinimalAPI', macros: ['UCLASS'], doc: '다른 모듈에 최소한의 심볼만 내보내 컴파일 시간을 줄입니다.' },
  { name: 'HideCategories', macros: ['UCLASS'], snippet: 'HideCategories=(${})', doc: '지정한 분류를 에디터 상세 패널에서 숨깁니다.' },
  { name: 'ClassGroup', macros: ['UCLASS'], snippet: 'ClassGroup=(${})', doc: '에디터의 컴포넌트 추가 목록 등에서 이 클래스가 속할 그룹을 지정합니다.' },
  // ── UMETA / UPARAM ───────────────────────────────────────────────────────
  { name: 'DisplayName', macros: ['UMETA', 'UPARAM'], snippet: 'DisplayName="${}"', doc: '에디터와 블루프린트에 표시될 이름을 지정합니다.' },
  { name: 'Hidden', macros: ['UMETA'], doc: '이 값을 에디터와 블루프린트에서 숨깁니다.' },
  { name: 'ref', macros: ['UPARAM'], doc: '블루프린트에서 이 참조 매개변수를 출력 핀이 아니라 입력 핀으로 표시합니다.' }
]

// 이름(소문자 키) → 지정자 항목(들). UHT 지정자는 대소문자를 구분하지 않는다 — 엔진 코드는
// `config=Game`·`hidecategories=…`처럼 소문자로도 쓴다. 같은 이름이 매크로별로 다른 항목일
// 수 있어 배열로 든다 (Config: UPROPERTY용/UCLASS용).
const UE_SPEC_BY_NAME = new Map<string, UeSpecEntry[]>()
for (const s of UE_SPECIFIERS) {
  const key = s.name.toLowerCase()
  const arr = UE_SPEC_BY_NAME.get(key)
  if (arr) arr.push(s)
  else UE_SPEC_BY_NAME.set(key, [s])
}

/** 소문자 이름으로 지정자 항목 조회 — recolor(하이라이트)와 호버가 같은 규칙을 쓴다. */
export function ueSpecEntriesFor(word: string): UeSpecEntry[] | undefined {
  return UE_SPEC_BY_NAME.get(word.toLowerCase())
}

/** 커서 줄이 어떤 UE 매크로의 괄호 안인지 — `UPROPERTY(EditAnywhere, |` → 'UPROPERTY'. 아니면 null.
 *  한 줄 판정(선언 매크로는 관례상 한 줄에 쓴다). 마지막 매크로 호출의 '(' 부터 괄호 깊이를 세
 *  `meta=(…)` 같은 중첩 그룹이 닫힌 '뒤'의 지정자(`…, meta=(…), MinimalAPI`)도 잡는다.
 *  문자열 안의 괄호는 세지 않는다. */
export function ueMacroContext(line: string, col: number): string | null {
  const before = line.slice(0, col)
  const re = /\b(UPROPERTY|UFUNCTION|UCLASS|USTRUCT|UENUM|UINTERFACE|UMETA|UPARAM)\s*\(/g
  let m: RegExpExecArray | null
  let name: string | null = null
  let open = -1
  while ((m = re.exec(before))) {
    name = m[1]
    open = m.index + m[0].length - 1
  }
  if (!name) return null
  let depth = 0
  let q: string | null = null
  for (let i = open; i < before.length; i++) {
    const c = before[i]
    if (q) {
      if (c === '\\') i++
      else if (c === q) q = null
    } else if (c === '"' || c === "'") q = c
    else if (c === '(') depth++
    else if (c === ')') depth--
  }
  return depth >= 1 ? name : null
}

/** UE 매크로/지정자 우선 호버 — LSP보다 먼저 답한다. 매크로 이름 자체(clangd의 `#define` 전개
 *  카드는 무의미)와, 매크로 괄호 안의 지정자(UHT 전용 토큰이라 clangd가 침묵)만. 아니면 null. */
export function ueCppPriorityDoc(line: string, col: number): string | null {
  if (!line) return null
  const word = ueWordAt(line, col)
  if (!word) return null
  if (inStringOrComment('cpp', line, col)) return null
  if (hasOwn(UE_CPP_MACROS, word)) {
    // 소문자 어서션(check·ensure…)은 같은 이름의 사용자 변수가 있을 수 있다 —
    // `check(…)` 처럼 바로 뒤가 '('인 호출 형태일 때만 매크로로 답한다.
    if (UE_CALL_ONLY.has(word)) {
      let b = col
      while (b < line.length && /[A-Za-z0-9_]/.test(line[b])) b++
      if (line[b] !== '(') return null
    }
    return UE_CPP_MACROS[word]
  }
  // 델리게이트 선언 패밀리(접미사 가변) · 모듈 내보내기(*_API) — 패턴으로 잡는다
  for (const [pre, doc] of UE_MACRO_PREFIX) if (word.startsWith(pre)) return doc
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_API$/.test(word)) return UE_API_DOC
  const macro = ueMacroContext(line, col)
  if (macro) {
    const entries = ueSpecEntriesFor(word)
    const hit = entries?.find((e) => e.macros.includes(macro)) ?? entries?.[0]
    if (hit) return hit.doc
  }
  return null
}

/** UE 타입 폴백 호버 — clangd가 침묵했을 때(미설치·인덱싱 중 포함) int32·FString… 를 설명한다. */
export function ueCppFallbackDoc(line: string, col: number): string | null {
  if (!line) return null
  const word = ueWordAt(line, col)
  if (!word || !hasOwn(UE_CPP_TYPES, word)) return null
  if (inStringOrComment('cpp', line, col)) return null
  return UE_CPP_TYPES[word]
}

// UE 어휘용 wordAt — 아래 공용 wordAt과 동일 규칙(선언 위치 무관 단어 추출)
function ueWordAt(line: string, col: number): string | null {
  if (col < 0 || col > line.length) return null
  let a = col
  let b = col
  const isW = (c: string): boolean => /[A-Za-z0-9_]/.test(c)
  while (a > 0 && isW(line[a - 1])) a--
  while (b < line.length && isW(line[b])) b++
  const w = line.slice(a, b)
  return /^[A-Za-z_]\w*$/.test(w) ? w : null
}

/** 렌더러 카드 안 토큰 설명용 — UE 타입·매크로를 한 사전으로 (cpp/c 카드에서만 조회). */
export const UE_CPP_WORD_DOCS: Gloss = { ...UE_CPP_TYPES, ...UE_CPP_MACROS }

/** 렌더러 언어 id(fileType.lang) → 용어집. main 쪽은 LSP languageId를 같은 키로 매핑해 쓴다. */
export const LANG_GLOSSARY: Record<string, Gloss> = {
  typescript: TS_GLOSSARY,
  javascript: JS_GLOSSARY,
  python: PY_GLOSSARY,
  csharp: CS_GLOSSARY,
  cpp: CPP_GLOSSARY,
  c: C_GLOSSARY
}

// Object.hasOwn은 ES2022 — 렌더러 tsconfig lib이 그보다 낮아 hasOwnProperty.call로 간다.
// 'toString'·'constructor' 같은 프로토타입 키가 용어집 항목으로 오인되지 않게 하는 가드.
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** 이 언어에 용어집이 있는가 — 렌더러가 "서버 준비 전에도 호버를 물어볼지" 게이트로 쓴다. */
export function hasGlossary(lang: string): boolean {
  return hasOwn(LANG_GLOSSARY, lang)
}

/** 단어 하나의 설명 (없으면 undefined). */
export function glossaryDoc(lang: string, word: string): string | undefined {
  const g = LANG_GLOSSARY[lang]
  return g && hasOwn(g, word) ? g[word] : undefined
}

// the identifier under a column, or null — verse.ts의 wordAt과 동일한 규칙
function wordAt(line: string, col: number): string | null {
  if (col < 0 || col > line.length) return null
  let a = col
  let b = col
  const isW = (c: string): boolean => /[A-Za-z0-9_]/.test(c)
  while (a > 0 && isW(line[a - 1])) a--
  while (b < line.length && isW(line[b])) b++
  const w = line.slice(a, b)
  return /^[A-Za-z_]\w*$/.test(w) ? w : null
}

// 줄 안에서 col이 문자열/주석 안인지 — 라인 로컬 스캔(여러 줄 문자열·블록 주석은 못 본다,
// 폴백 카드가 코드 아닌 곳에서 뜨는 흔한 경우만 막는 가벼운 가드). 언어별 규칙:
// 따옴표(ts/js는 백틱 포함)와 라인 주석 토큰(// 또는 #)만 본다.
function inStringOrComment(lang: string, line: string, col: number): boolean {
  const quotes = lang === 'typescript' || lang === 'javascript' ? `"'\`` : `"'`
  const hashComment = lang === 'python'
  let q: string | null = null
  for (let i = 0; i < col && i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '\\' && lang !== 'python') i++
      else if (c === '\\') i++ // python도 \" 이스케이프는 같다
      else if (c === q) q = null
    } else if (quotes.includes(c)) q = c
    else if (hashComment && c === '#') return true
    else if (!hashComment && c === '/' && line[i + 1] === '/') return true
  }
  return q != null
}

/**
 * (line, col)의 토큰이 이 언어의 키워드/내장 타입이면 우리 설명(마크다운)을 돌려준다 —
 * LSP 호버가 비어 있을 때의 폴백이므로, 서버가 진짜 심볼(같은 이름의 사용자 변수 등)에
 * 호버를 주는 경우는 여기까지 오지 않는다. 문자열/주석 안(라인 로컬 판정)은 답하지 않는다.
 */
export function glossaryLineDoc(lang: string, line: string, col: number): string | null {
  const g = LANG_GLOSSARY[lang]
  if (!g || !line) return null
  const word = wordAt(line, col)
  if (!word || !hasOwn(g, word)) return null
  if (inStringOrComment(lang, line, col)) return null
  return g[word]
}

// ── 예약어 우선(LSP보다 먼저) ─────────────────────────────────────────────────
// clangd/Roslyn은 키워드 위치에서 침묵하지 않는다 — `override` 는 무의미한 지정자 카드를,
// `virtual` 은 감싸는 함수의 카드를 돌려줘, "LSP가 비었을 때만" 폴백으로는 키워드 설명이
// 영영 나오지 않는다. 예약어는 사용자 식별자가 될 수 없으므로 Verse와 같은 규칙으로 LSP보다
// 먼저 답한다. 단 아래 둘은 우선 대상에서 빼고 폴백으로만 답한다:
//  · 문맥 키워드/식별자 — 같은 이름의 심볼이 있을 수 있다 (C# value·get·record…, Python
//    match·case·int…, TS number·string…) → 심볼 호버를 가리면 안 된다
//  · LSP가 더 나은 정보를 주는 키워드 — C++ `auto`(추론된 타입)·`this`(타입), C# `var` 등
const NON_PRIORITY: Record<string, Set<string>> = {
  cpp: new Set(['auto', 'decltype', 'this']),
  c: new Set<string>(),
  csharp: new Set([
    'var', 'dynamic', 'async', 'await', 'get', 'set', 'init', 'value', 'yield', 'when', 'where',
    'with', 'record', 'required', 'nameof', 'partial', 'base', 'this'
  ]),
  typescript: new Set([
    'this', 'as', 'is', 'asserts', 'satisfies', 'keyof', 'infer', 'type', 'module', 'namespace',
    'declare', 'get', 'set', 'of', 'from', 'async', 'await', 'undefined', 'NaN', 'Infinity',
    'globalThis', 'arguments', 'number', 'string', 'boolean', 'object', 'symbol', 'bigint',
    'any', 'unknown', 'never'
  ]),
  javascript: new Set([
    'this', 'get', 'set', 'of', 'from', 'async', 'await', 'undefined', 'NaN', 'Infinity',
    'globalThis', 'arguments'
  ]),
  python: new Set([
    'match', 'case', 'self', 'cls', '__init__',
    'int', 'float', 'str', 'bool', 'list', 'dict', 'tuple', 'set', 'bytes'
  ])
}

/** 예약어 우선 호버 — 용어집 항목 중 "진짜 예약어"만, LSP 요청 전에 답한다. 아니면 null. */
export function keywordPriorityDoc(lang: string, line: string, col: number): string | null {
  const g = LANG_GLOSSARY[lang]
  if (!g || !line) return null
  const word = wordAt(line, col)
  if (!word || !hasOwn(g, word)) return null
  if (NON_PRIORITY[lang]?.has(word)) return null
  if (inStringOrComment(lang, line, col)) return null
  return g[word]
}
