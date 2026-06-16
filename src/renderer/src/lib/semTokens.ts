import type { LspSemanticTokens } from '@shared/protocol'
import { paletteClassFor } from '../components/fileType'

// ── semantic highlighting (LSP semanticTokens over the hljs base) ───────────
// Shared by the read-only viewer (FileModal) and the CodeMirror editor so both color
// identifiers from exactly the same table — no second palette to keep in sync.
//
// LSP token type → viewer color class. Identifier kinds only — keywords, strings,
// comments etc. stay with highlight.js, which already colors them consistently.
// IntelliJ-palette languages (TS·Python …) use this shared table.
export const SEM_CLASS: Record<string, string> = {
  class: 'sem-type',
  struct: 'sem-type',
  interface: 'sem-type',
  enum: 'sem-type',
  type: 'sem-type',
  typeParameter: 'sem-type',
  delegateName: 'sem-type',
  moduleName: 'sem-type',
  concept: 'sem-type',
  method: 'sem-fn',
  function: 'sem-fn',
  extensionMethodName: 'sem-fn',
  property: 'sem-member',
  field: 'sem-member',
  fieldName: 'sem-member',
  event: 'sem-member',
  enumMember: 'sem-const',
  enumConstant: 'sem-const',
  constant: 'sem-const',
  constantName: 'sem-const',
  macro: 'sem-const',
  decorator: 'sem-const',
  parameter: 'sem-param'
}

// Rider-palette languages (C#·C++): 토큰 분류를 Rider 2025.3의 실제 스킴(Rider
// Islands Dark / Rider Light)과 1:1로 맞춘 매핑 — Rider 설치본의 스킴 XML과
// ReSharper 하이라이터 등록(fallback 체인)에서 직접 추출·검증한 값이다.
//  · struct/enum/union/delegate는 클래스(--code-type)와 다른 연보라(--code-type-2)
//  · C# enum 멤버는 ReSharper가 '상수'로 분류(볼드 시안), C++ enumerator는 연보라
//  · event는 핑크, 매크로는 키워드 색, C++ 의존 이름(dependent name)은 민트
//  · 파라미터·지역변수는 기본 텍스트색(이탤릭 아님) — hljs의 잘못된 추측도 덮는다
//  · clangd의 'comment' 토큰은 비활성 전처리 분기(#if 0 …)에만 나온다
//  · 'unknown'(미해석 이름)은 칠하지 않는다 — compile_commands.json 없는 프로젝트
//    (예: UE)에선 미해석 식별자마다 dependentName이 붙어 와서, 색을 주면 UE_LOG 같은
//    매크로까지 의존-이름 민트로 오염된다. 진짜 템플릿 의존 타입은 'type'으로 온다.
// 한계: clangd는 C++ struct/union도 'class'로 보고하므로 Rider의 struct 연보라
// 구분은 C++에선 불가능하다(둘 다 클래스 보라로 칠해짐).
export function riderSemClass(type: string, modBits: number, modNames: string[], cpp: boolean): string | null {
  const has = (name: string): boolean => {
    const i = modNames.indexOf(name)
    return i >= 0 && (modBits & (1 << i)) !== 0
  }
  switch (type) {
    case 'type': // C++ typedef/alias — Rider도 클래스 보라. 단 typename T::x는 의존 이름
      return cpp && has('dependentName') ? 'sem-dep' : 'sem-type'
    case 'class':
    case 'interface':
    case 'typeParameter':
    case 'namespace':
    case 'moduleName':
      return 'sem-type'
    case 'struct':
    case 'enum':
    case 'delegateName':
      return 'sem-type2'
    case 'enumMember':
    case 'enumConstant':
      return cpp ? 'sem-type2' : 'sem-const'
    case 'constant':
    case 'constantName':
      return 'sem-const'
    case 'method':
    case 'function':
    case 'extensionMethodName':
    case 'operatorOverloaded':
      return 'sem-fn'
    case 'operator': // C++ 사용자 정의 연산자 호출만 메서드 색 — 그 외 연산자는 기본색
      return cpp && has('userDefined') ? 'sem-fn' : null
    case 'property':
    case 'field':
    case 'fieldName':
      return 'sem-member'
    case 'variable': // C++ static 멤버는 'variable'+classScope로 온다 → 필드 색
      return cpp && has('classScope') ? 'sem-member' : 'sem-plain'
    case 'parameter':
      return 'sem-plain'
    case 'event':
      return 'sem-event'
    case 'macro':
    case 'preprocessorKeyword': // OmniSharp: #region·#if 같은 C# 지시문 — Rider는 키워드 파랑
      return 'sem-kw'
    case 'concept': // Rider는 concept을 기본 식별자 색으로 둔다 (Default Identifier fallback)
      return 'sem-plain'
    case 'stringEscapeCharacter':
      return 'sem-esc'
    case 'comment': // clangd: 비활성 전처리 분기만 — 진짜 주석은 토큰으로 안 온다
      return cpp ? 'sem-inactive' : null
    case 'excludedCode': // OmniSharp: C#의 #if 비활성 분기
      return 'sem-inactive'
    default:
      return null
  }
}

export interface SemSpan {
  char: number
  len: number
  cls: string
}

// C++ struct 보정 결과 — 연보라(sem-type2)로 재분류할 타입/필드 이름들 (useCppStructOv).
export interface StructOv {
  types: Set<string>
  fields: Set<string>
}

// LSP semantic tokens → per-line color spans, mapped to the same classes the viewer
// uses. Rider 언어(C#·C++)는 modifier까지 보는 전용 매핑, 나머지는 공용 IntelliJ 테이블.
// structOv(+ text)가 주어지면 C++ struct/union·그 필드를 연보라로 재분류한다 — clangd가
// struct를 'class'로 보고하므로 hover 프로브로 알아낸 이름 집합을 여기서 덮어쓴다.
export function semByLine(
  sem: LspSemanticTokens,
  lang: string,
  structOv?: StructOv | null,
  text?: string
): Map<number, SemSpan[]> | null {
  if (!sem.data.length) return null
  const rider = !!paletteClassFor(lang)
  const cpp = lang === 'cpp' || lang === 'c'
  const srcLines = structOv && text ? text.split('\n') : null
  const m = new Map<number, SemSpan[]>()
  for (let i = 0; i < sem.data.length; i += 5) {
    const type = sem.types[sem.data[i + 3]] ?? ''
    let cls = rider ? riderSemClass(type, sem.data[i + 4], sem.mods, cpp) : SEM_CLASS[type]
    if (!cls) continue
    if (srcLines && structOv && (type === 'class' || type === 'property')) {
      const tx = (srcLines[sem.data[i]] ?? '').substr(sem.data[i + 1], sem.data[i + 2])
      if (type === 'class' ? structOv.types.has(tx) : structOv.fields.has(tx)) cls = 'sem-type2'
    }
    const line = sem.data[i]
    let arr = m.get(line)
    if (!arr) m.set(line, (arr = []))
    arr.push({ char: sem.data[i + 1], len: sem.data[i + 2], cls })
  }
  return m.size ? m : null
}
