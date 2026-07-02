// Verse의 `<지정자>`·`@속성` 정적 어휘 — 이름·분류·한국어 설명의 단일 소스.
// verse-lsp는 이 문법 토큰들을 완성 목록에 싣지 않고 호버도 주지 않으므로 우리가 직접 채운다:
//   · renderer(CmEditor.verseComplete)  — @/< 자동완성 목록 + info 텍스트
//   · renderer(verseLang.ts)            — `<…>` 지정자 색칠 regex (VERSE_SPECIFIER_NAMES)
//   · main(lsp/verse.ts)                — 호버 용어집(지정자는 <…> 안, 속성은 @ 컨텍스트에서만)
// 설명(doc)은 호버 카드에 마크다운으로 렌더되므로 `코드 용어`에 백틱을 쓴다 — 완성 info는
// 플레인 텍스트라 사용처(CmEditor)에서 백틱만 벗겨 쓴다. (전에는 백틱 유무만 다른 사본이
// main/renderer에 하나씩 있었다 — 이제 이 파일 하나만 고치면 두 화면이 같이 맞는다.)

export type VerseKwGroup = 'access' | 'effect' | 'decl' | 'attr'

export interface VerseKw {
  name: string
  group: VerseKwGroup
  doc?: string
  /** Takes a parenthesised argument (`<getter(Fn)>`, `@doc("…")`) → completion scaffolds the call. */
  arg?: boolean
  /** Grammar-only / engine-internal — still coloured + hover-documented, but NOT offered in completion. */
  internal?: boolean
}

// <…> specifiers — access level, effect, and declaration modifiers. ORDER MATTERS: it feeds
// verseLang's `<(?:a|b|…)>` regex, where longer variants must precede their prefixes
// (final_super_base → final_super → final) so the alternation matches the whole token.
export const VERSE_SPECIFIERS: VerseKw[] = [
  { name: 'native_callable', group: 'decl', doc: '엔진이나 블루프린트에서 호출할 수 있게 열어 둡니다.' },
  { name: 'native', group: 'decl', doc: '실제 동작이 엔진 쪽에 구현돼 있습니다.' },
  { name: 'public', group: 'access', doc: '어디서나 사용할 수 있습니다.' },
  { name: 'private', group: 'access', doc: '선언한 클래스나 모듈 안에서만 보이고, 그 밖에서는 사용할 수 없습니다.' },
  { name: 'protected', group: 'access', doc: '선언한 클래스와 그 자식 클래스에서만 사용할 수 있습니다.' },
  { name: 'internal', group: 'access', doc: '같은 모듈 안에서만 사용할 수 있습니다.' },
  { name: 'epic_internal', group: 'access', internal: true, doc: 'Epic 내부에서만 사용하며 일반 코드에서는 사용할 수 없습니다.' },
  { name: 'transacts', group: 'effect', doc: '도중에 실패하면 그동안 바꾼 값을 자동으로 되돌립니다.' },
  { name: 'computes', group: 'effect', doc: '같은 입력에는 항상 같은 결과를 주고, 함수 밖의 값은 읽지도 바꾸지도 않습니다.' },
  { name: 'reads', group: 'effect', doc: '함수 밖의 값(다른 객체나 변수)을 읽습니다.' },
  { name: 'writes', group: 'effect', doc: '함수 밖의 값(다른 객체나 변수)을 바꿉니다.' },
  { name: 'decides', group: 'effect', doc: '성공하거나 실패할 수 있는 식이고, 실패하면 그 자리에서 멈춥니다. `if` 나 `for` 같은 곳에서만 사용할 수 있습니다.' },
  { name: 'varies', group: 'effect', doc: '같은 입력이어도 호출할 때마다 결과가 달라질 수 있습니다.' },
  { name: 'converges', group: 'effect', doc: '반드시 끝나며 무한히 도는 일이 없습니다.' },
  { name: 'suspends', group: 'effect', doc: '실행을 잠시 멈췄다 나중에 이어서 합니다. 비동기 작업에 붙습니다.' },
  { name: 'no_rollback', group: 'effect', doc: '여기서 한 일은 실패하더라도 되돌릴 수 없습니다.' },
  { name: 'allocates', group: 'effect', doc: '호출할 때마다 새 객체를 만들어, 매번 다른 값으로 취급됩니다.' },
  { name: 'override', group: 'decl', doc: '부모 클래스의 메서드를 새로 덮어써 다시 정의합니다.' },
  { name: 'final_super_base', group: 'decl', doc: '`<final_super>` 의 베이스 버전으로, 상속 구조의 맨 아래에서 상위 호출 체인을 고정합니다.' },
  { name: 'final_super', group: 'decl', doc: '상위 클래스로 이어지는 호출 체인을 더 이상 바꿀 수 없게 고정합니다.' },
  { name: 'final', group: 'decl', doc: '더 이상 덮어쓰거나 상속할 수 없게 합니다. 클래스에 붙이면 자식 클래스를, 필드·메서드에 붙이면 재정의를 막습니다.' },
  { name: 'abstract', group: 'decl', doc: '이것만으로는 만들 수 없고 자식 클래스가 나머지를 구현해야 합니다. 본문 없는 메서드를 선언할 수 있습니다.' },
  { name: 'unique', group: 'decl', doc: '인스턴스마다 고유해서, 두 값이 같은 객체인지 비교할 수 있습니다.' },
  { name: 'concrete', group: 'decl', doc: '모든 항목에 기본값이 있어 값을 채우지 않아도 바로 만들 수 있습니다.' },
  { name: 'open', group: 'decl', doc: '다른 모듈에서 멤버를 더 추가할 수 있습니다.' },
  { name: 'closed', group: 'decl', doc: '다른 모듈에서 멤버를 더 추가할 수 없습니다.' },
  { name: 'castable', group: 'decl', doc: '실행 중에 타입을 확인하거나 바꿀 수 있습니다.' },
  { name: 'constructor', group: 'decl', doc: '객체를 만들어 주는 함수입니다.' },
  { name: 'getter', group: 'decl', arg: true, doc: '프로퍼티 값을 읽는 통로입니다.' },
  { name: 'setter', group: 'decl', arg: true, doc: '프로퍼티 값을 바꾸는 통로입니다.' },
  { name: 'predicts', group: 'effect', doc: '서버가 확정하기 전에 클라이언트가 먼저 실행합니다.' },
  { name: 'persistable', group: 'decl', doc: '게임을 꺼도 저장되어 남을 수 있는 타입입니다. 보통 `<final>` 과 함께 사용합니다.' },
  { name: 'persistent', group: 'decl', doc: '게임을 꺼도 저장되어 남는 데이터입니다. 보통 `<final>` 과 함께 사용합니다.' },
  { name: 'localizes', group: 'decl', doc: '여러 언어로 번역되는 글자나 메시지를 만듭니다.' },
  { name: 'uht_comparable', group: 'decl', internal: true, doc: 'UnrealHeaderTool(UHT)에서 비교 가능한 타입으로 다루도록 표시하는 엔진 내부 지정자입니다. 일반 코드에서 직접 쓸 일은 거의 없습니다.' },
  { name: 'scoped', group: 'access', doc: '어느 범위에서 사용할 수 있는지 직접 지정하는 세밀한 접근 지정자입니다. 정해진 단계 대신 허용 범위를 명시적으로 지정합니다.' },
  { name: 'module_scoped_var_weak_map_key', group: 'decl', internal: true, doc: '`weak_map` 의 키로 쓰이는 모듈 범위 변수를 표시하는 엔진 내부 지정자입니다. 일반 코드에서 직접 쓸 일은 거의 없습니다.' },
  { name: 'mesh_part_field', group: 'decl', internal: true, doc: '메시 파트와 연결되는 필드를 표시하는 엔진 내부 지정자입니다. 일반 코드에서 직접 쓸 일은 거의 없습니다.' }
]

// @attributes — metadata annotations on the line above a definition. Conservative, curated set so we
// never suggest one that doesn't exist; internal(엔진/컴파일러 내장)은 완성 목록에선 빠지고 호버
// 설명에만 쓰인다.
export const VERSE_ATTRIBUTES: VerseKw[] = [
  { name: 'editable', group: 'attr', doc: '에디터에서 값을 직접 바꿀 수 있게 노출합니다.' },
  { name: 'doc', group: 'attr', arg: true, doc: '심볼에 설명 글을 답니다.' },
  { name: 'available', group: 'attr', doc: '어느 버전부터 사용할 수 있는지 표시합니다.' },
  { name: 'deprecated', group: 'attr', doc: '더 이상 권장하지 않는 기능입니다. 앞으로 제거될 수 있으니 대체 기능으로 옮기는 것이 좋습니다.' },
  { name: 'experimental', group: 'attr', doc: '아직 실험 단계라 나중에 바뀔 수 있습니다.' },
  { name: 'import_as', group: 'attr', internal: true, doc: '이 심볼을 원래 어느 경로·이름으로 가져왔는지 기록하는 엔진 내부 속성입니다. 주로 엔진 API 정의에 나타나며, 일반 코드에서 직접 쓸 일은 거의 없습니다.' },
  { name: 'vm_no_effect_token', group: 'attr', internal: true, doc: '가상 머신(VM)이 이 함수를 이펙트 토큰 전달 없이 호출하도록 표시하는 엔진 내부 속성입니다. 일반 코드에서 직접 쓸 일은 거의 없습니다.' },
  { name: 'rtfm_always_open', group: 'attr', internal: true, doc: '생성되는 Verse API 문서에서 이 항목을 항상 펼친 상태로 보이게 하는 엔진 내부 문서화 속성입니다.' },
  // 속성을 "정의"할 때 붙이는 메타 속성 — `@editable` 같은 속성의 정의 위에 달린다. 엔진 API
  // 정의엔 문서 주석이 없어 직접 설명한다(일반 코드에서 새로 만들 일은 거의 없어 완성에선 제외).
  { name: 'attribscope_class', group: 'attr', internal: true, doc: '정의 중인 속성을 클래스 멤버에 붙일 수 있게 허용하는 적용 범위 표시입니다.' },
  { name: 'attribscope_struct', group: 'attr', internal: true, doc: '정의 중인 속성을 구조체 멤버에 붙일 수 있게 허용하는 적용 범위 표시입니다.' },
  { name: 'attribscope_data', group: 'attr', internal: true, doc: '정의 중인 속성을 데이터 정의에 붙일 수 있게 허용하는 적용 범위 표시입니다.' },
  { name: 'attribscope_enum', group: 'attr', internal: true, doc: '정의 중인 속성을 `enum` 에 붙일 수 있게 허용하는 적용 범위 표시입니다.' },
  { name: 'attribscope_interface', group: 'attr', internal: true, doc: '정의 중인 속성을 인터페이스에 붙일 수 있게 허용하는 적용 범위 표시입니다.' },
  { name: 'attribscope_module', group: 'attr', internal: true, doc: '정의 중인 속성을 모듈에 붙일 수 있게 허용하는 적용 범위 표시입니다.' },
  { name: 'customattribhandler', group: 'attr', internal: true, doc: '이 속성을 엔진이 전용 로직으로 처리한다는 표시입니다. `@editable` 같은 내장 속성을 정의할 때 씁니다.' }
]

// Just the names, in declaration order — verseLang.ts joins these into its `<…>` specifier regex.
export const VERSE_SPECIFIER_NAMES: string[] = VERSE_SPECIFIERS.map((s) => s.name)
