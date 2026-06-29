import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { FileDiff, FileReadResult, LspLocation, LspSemanticTokens, LspStatus } from '@shared/protocol'
import { Markdown } from './Markdown'
import { CmEditor, type CmEditorHandle } from './CmEditor'
import { highlightCode, highlightToLines } from '../lib/highlight'
import { SEM_CLASS, riderSemClass, type SemSpan, type StructOv } from '../lib/semTokens'
import { useCppStructOv } from '../lib/cppStruct'
import { diffMarksOf, type DiffMarks } from '../lib/cmDiff'
import { getPref, setPref } from '../lib/prefs'
import { isImagePath, imageSrc } from '../lib/images'
import { verseReg } from '../lib/verseRegistry'
import { VERSE_SPECIFIERS, VERSE_ATTRIBUTES } from '../lib/verseKeywords'
import { FileBadge, fileTypeFor, paletteClassFor } from './fileType'
import {
  IconBot,
  IconCheck,
  IconChevDown,
  IconChevLeft,
  IconChevRight,
  IconClose,
  IconCopy,
  IconMax,
  IconPencil,
  IconRestore,
  IconSearch,
  IconSend
} from './icons'
import { useResizableModal, ModalResizeHandles } from './resizableModal'
import { useZoom, ZoomBadge, mergeRefs } from './zoom'

// beyond this size we skip syntax highlighting (highlight.js gets slow on very large
// files) and show plain monospaced text instead — still readable, just uncolored
const HL_LIMIT = 200_000
// hover request debounce — long enough that sweeping the mouse across the code
// doesn't spam the language server
const HOVER_DELAY = 300

// ── path helpers (renderer has no node:path; windows-first, '/'-tolerant) ───
function displayPath(abs: string, cwd: string): string {
  const a = abs.replace(/\//g, '\\')
  const c = cwd.replace(/\//g, '\\').replace(/\\+$/, '')
  if (c && a.toLowerCase().startsWith(c.toLowerCase() + '\\')) return abs.slice(c.length + 1)
  return abs
}
function canonPath(p: string, cwd: string): string {
  const isAbs = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p)
  const full = isAbs ? p : cwd.replace(/[\\/]+$/, '') + '\\' + p
  return full.replace(/\//g, '\\').toLowerCase()
}
function absPath(p: string, cwd: string): string {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p) ? p : cwd.replace(/[\\/]+$/, '') + '\\' + p
}

// SEM_CLASS / riderSemClass moved to ../lib/semTokens (shared with the CodeMirror
// editor so viewer + editor color identifiers from one table). Imported above.

// ── hover card content — 서버 마크다운을 구조화해 IDE 툴팁처럼 ──────────────
// clangd는 '### kind `name`' 헤더 → 메타(→ 반환형 · provided by · Type:) → 본문 →
// 마지막에 시그니처 펜스 순서로, OmniSharp는 시그니처 펜스 → 본문 순서로 보낸다.
// 둘 다 [종류 칩 + 심볼명] → 시그니처 스트립 → 메타 → 본문으로 재배열한다.
// 형식이 안 맞으면(다른 서버·예상 밖 페이로드) 마크다운 그대로 렌더로 폴백.
interface HoverParts {
  kind: string | null
  name: string | null
  mods: string[] // 한정자 칩 — static·const·readonly·get/set… (시그니처에서 추출)
  sig: string | null
  sigLang: string
  /** 구조화 행(이름·반환·매개변수)이 정보를 다 담으면 시그니처 전문은 숨긴다 —
   *  매크로(#define+전개)처럼 시그니처가 본체인 것만 보여준다 */
  showSig: boolean
  // 라벨(return·type·…) + 값(마크다운) + 선택적 설명(@return 문서를 행에 합침)
  metas: { k: string; v: string; doc?: string }[]
  // 매개변수 — 한 줄에 하나씩, @param 문서가 있으면 옆에 설명으로 붙는다
  params: { v: string; doc?: string }[]
  facts: { k: string; v: string }[] // 종류 칩 옆 알약 — clangd 필드의 size/align/offset
  from: { k: string; v: string } | null // 출처 푸터 — clangd 'provided by', C# 'in'
  docs: string
}

// OmniSharp 호버는 시그니처 펜스 + 문서뿐이라(clangd 같은 종류 헤더·출처 없음)
// 시그니처를 파싱해 같은 구조를 만들어 준다. 형태는 세 갈래:
//  · '(매개 변수) string Message'   — VS식 마커(로캘 따라 한글/영문)
//  · 'readonly struct NS.Type'      — 타입 선언 (enum은 ': byte' 같은 기반 타입)
//  · 'void Container.Name(args)'    — 멤버 (메서드/프로퍼티/필드는 괄호·중괄호로 구분)
// 최상위 쉼표로 인자 목록 분리 — 제네릭(<>)·배열([])·중첩 괄호 안의 쉼표는 무시
function splitCsArgs(args: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of args) {
    if (ch === '<' || ch === '(' || ch === '[') depth++
    else if (ch === '>' || ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

function parseCsSig(
  sig: string
): { kind: string; name: string; container: string | null; ret?: string; retLabel?: string; params?: string[]; value?: string } | null {
  let s = sig.replace(/\s+/g, ' ').trim()
  // 확장 메서드: Roslyn이 '(확장)'/'(extension)' 접두사를 붙여 보낸다 — 떼고 일반
  // 멤버처럼 파싱하되 종류를 'extension method'로 분류해, 다른 메서드 호버와 똑같은
  // 카드(종류 칩 + 이름·매개변수·반환) 구조로 만든다.
  const isExt = /^\((확장|extension)\)\s*/.test(s)
  if (isExt) s = s.replace(/^\((확장|extension)\)\s*/, '')
  // ① VS식 마커
  const marker = /^\((매개 변수|parameter|지역 변수|local variable|로컬 변수|상수|constant|필드|field)\)\s*(.*)$/.exec(s)
  if (marker) {
    const KIND: Record<string, string> = {
      '매개 변수': 'parameter', parameter: 'parameter',
      '지역 변수': 'local', '로컬 변수': 'local', 'local variable': 'local',
      '상수': 'const', constant: 'const', '필드': 'field', field: 'field'
    }
    let rest = marker[2]
    // const/field 초기값: 'type Container.Name = value' — 값을 떼어 VALUE로 따로 둔다
    // (안 떼면 끝 토큰인 값이 이름으로, 타입칸엔 'type ...Name ='가 들어가 깨진다)
    let value: string | undefined
    const eq = rest.indexOf(' = ')
    if (eq >= 0) {
      value = rest.slice(eq + 3).trim()
      rest = rest.slice(0, eq).trim()
    }
    const sp = rest.lastIndexOf(' ')
    if (sp < 0) return { kind: KIND[marker[1]], name: rest, container: null, value }
    const qual = rest.slice(sp + 1)
    const dot = qual.lastIndexOf('.')
    // 한정명이 있으면 멤버다 — const는 C++의 'static field'처럼 'const field'로 통일한다
    // (한정명이 없으면 메서드 안 지역 const라 그냥 'const')
    let kindOut = KIND[marker[1]]
    if (kindOut === 'const' && dot >= 0) kindOut = 'const field'
    return {
      kind: kindOut,
      name: dot >= 0 ? qual.slice(dot + 1) : qual,
      container: dot >= 0 ? qual.slice(0, dot) : null,
      ret: rest.slice(0, sp),
      retLabel: 'type',
      value
    }
  }
  // ② 타입/네임스페이스 선언
  const decl = /\b(struct|class|interface|enum|namespace)\s+([\w.]+(?:<[^>]*>)?)(?:\s*:\s*(\w+))?/.exec(s)
  if (decl && !s.includes('(')) {
    const qual = decl[2]
    const dot = qual.lastIndexOf('.')
    return {
      kind: decl[1],
      name: dot >= 0 ? qual.slice(dot + 1) : qual,
      container: dot >= 0 ? qual.slice(0, dot) : null,
      ret: decl[1] === 'enum' && decl[3] ? decl[3] : undefined,
      retLabel: 'type'
    }
  }
  // ③ 멤버 — 'ret Container.Name(args)' / 'ret Container.Name { get; }' / 'ret Container.Name'
  let body = s.replace(/^(?:(?:public|private|protected|internal|static|readonly|virtual|override|sealed|abstract|async|extern|unsafe|new|partial|required|event|delegate)\s+)+/, '')
  const paren = body.indexOf('(')
  // 메서드 괄호가 없을 때의 top-level ' = value'는 초기값이다(enum 멤버 'Foo.Bar = 0',
  // 필드 초기값). 메서드 기본 인자의 '='은 괄호 안이라 건드리지 않는다 — 떼어 둔다.
  let value: string | undefined
  if (paren < 0) {
    const eq = body.indexOf(' = ')
    if (eq >= 0) {
      value = body.slice(eq + 3).trim()
      body = body.slice(0, eq).trim()
    }
  }
  const brace = body.indexOf('{')
  const cut = paren >= 0 ? paren : brace >= 0 ? brace : body.length
  const headPart = body.slice(0, cut).trim()
  const sp = headPart.lastIndexOf(' ')
  if (sp < 0) {
    // 타입 접두사 없는 한정명 + 값 → enum 멤버 ('EEnumTest.A = 0'). clangd의 enumerator와
    // 같은 분류로 구조화한다(이름·값·소속). 값이 없으면 신뢰도가 낮아 raw로 둔다.
    const d = headPart.lastIndexOf('.')
    if (d >= 0 && value !== undefined) {
      return { kind: 'enum member', name: headPart.slice(d + 1), container: headPart.slice(0, d), value }
    }
    return null
  }
  const qual = headPart.slice(sp + 1)
  const dot = qual.lastIndexOf('.')
  if (dot < 0) return null // 한정명이 아니면 신뢰도가 낮다 — 구조화 포기
  const name = qual.slice(dot + 1)
  const container = qual.slice(0, dot)
  const ret = headPart.slice(0, sp)
  const kind =
    paren >= 0
      ? name === container.split('.').pop()
        ? 'constructor'
        : isExt
          ? 'extension method'
          : 'method'
      : brace >= 0
        ? 'property'
        : /\bevent\b/.test(s)
          ? 'event'
          : 'field'
  // 매개변수 — clangd의 'Parameters:' 목록에 해당하는 정보를 시그니처 괄호에서 복원
  let params: string[] | undefined
  if (paren >= 0) {
    const close = body.lastIndexOf(')')
    if (close > paren) params = splitCsArgs(body.slice(paren + 1, close))
  }
  return {
    kind,
    name,
    container,
    // void도 표시한다 — C++(clangd) 카드와 마찬가지로 반환형 줄이 항상 보이게
    ret: ret && kind !== 'constructor' ? ret : undefined,
    retLabel: /method/.test(kind) ? 'return' : 'type',
    params,
    value
  }
}

// Verse 호버는 한 줄 시그니처를 MarkedString(```verse)로 보낸다. parseCsSig의 Verse판 —
// '[var] (/모듈/경로:)이름<지정자…>(매개변수)<효과…>:타입' 꼴을 분해해 같은 카드(종류 칩 ·
// 이름 · specifiers · params · return/type · module 푸터)로 구조화한다. 지정자는 <…>를 살려
// 돌려줘 카드에서도 본문과 같은 Verse 색(지정자=구조체색)으로 칠해지게 한다.
function parseVerseSig(
  sig: string
): { kind: string; name: string; container: string | null; ret?: string; retLabel?: string; params?: string[]; mods?: string[] } | null {
  let s = sig.replace(/\s+/g, ' ').trim()
  const mods: string[] = []
  // <지정자> 묶음 흡수 — <…> 형태를 보존해 카드에서도 Verse 색(지정자=구조체색)으로 칠한다
  const eatSpecs = (): void => {
    let m: RegExpExecArray | null
    while ((m = /^<([^>]*)>/.exec(s))) {
      mods.push('<' + m[1] + '>')
      s = s.slice(m[0].length).trim()
    }
  }
  // 한정자 (/Module/Path:) — 심볼이 속한 모듈/클래스 경로. 흡수하고 경로를 돌려준다.
  const eatQual = (): string | null => {
    const q = /^\((\/[^()]*?):\)\s*/.exec(s)
    if (!q) return null
    s = s.slice(q[0].length)
    return q[1]
  }

  // ① 타입 선언 shape — 종류 키워드가 맨 앞: 'interface (/Verse.org/Verse:)cancelable'.
  // (class/struct/enum/interface/module은 Verse 예약어라 식별자와 충돌하지 않는다)
  const tk = /^(class|struct|enum|interface|module)\b\s*/.exec(s)
  if (tk) {
    s = s.slice(tk[0].length)
    const container = eatQual()
    const nm = /^([A-Za-z_]\w*)/.exec(s)
    if (!nm) return null
    s = s.slice(nm[1].length).trim()
    eatSpecs()
    // an enum/struct VALUE reference comes as `enum (/path:)Type.Value` — the trailing `.Value` is
    // the actual symbol; label it '<kind> value' (e.g. 'enum value') of the type `Type`.
    const dot = /^\.([A-Za-z_]\w*)/.exec(s)
    if (dot && (tk[1] === 'enum' || tk[1] === 'struct'))
      return { kind: tk[1] + ' value', name: dot[1], container: nm[1], retLabel: 'type', mods: mods.length ? mods : undefined }
    return { kind: tk[1], name: nm[1], container, retLabel: 'type', mods: mods.length ? mods : undefined }
  }

  // ② var / function / field shape: '[var] (/path:)Name<specs>(params)<effects>:type'. verse-lsp
  // emits the binding keyword in EITHER order relative to the module qualifier — `var (/path:)Name…`
  // AND `(/path:)var Name…` (the latter is what it sends for a class FIELD) — so strip `var`/`set`
  // both before and after the qualifier. Handling only the first order made `(/path:)var Name:type`
  // read the keyword `var` AS the name → the card showed 'Type `var`' instead of 'Variable `Name`'.
  let bind: string | null = null
  const eatBind = (): void => {
    const kw = /^(var|set)\s+/.exec(s)
    if (kw) {
      bind = kw[1]
      s = s.slice(kw[0].length)
    }
  }
  eatBind()
  const container = eatQual()
  eatBind()
  // 이름 — 보통 식별자, 또는 operator 형식(`operator'<기호>'`). verse-lsp는 연산자/점(.) 접근 등을
  // 이렇게 준다. operator를 안 잡으면 `'…'` 때문에 'operator'에서 멈춰 매개변수도 못 읽고 종류가
  // 'type'으로 깨졌다(예: Entity.GetLocalTransform → 종류 Type · 이름 operator). 연산자 토큰을 통째로
  // 이름으로 잡으면 뒤의 (매개변수):반환형이 정상 파싱돼 함수 카드로 뜬다.
  const opM = /^operator\s*'(?:[^'\\]|\\.)*'/.exec(s)
  const nm = opM ?? /^([A-Za-z_]\w*)/.exec(s)
  if (!nm) return null
  // operator'.Member' (점 멤버 접근) — verse-lsp가 `X.Member` 호출을 이 꼴로 준다(예:
  // operator'.GetLocalTransform'(InEntity:entity)…). 그땐 ① 멤버명만 이름으로 쓰고(→ GetLocalTransform),
  // ② 첫 매개변수인 수신자(receiver, 호출 시의 X)는 진짜 매개변수가 아니라 뒤에서 뺀다. 일반
  // 연산자(operator'+' 등)는 그 토큰을 그대로 이름으로 둔다.
  const opToken = opM ? opM[0].replace(/\s+/g, '') : null
  const dotMember = opToken ? /^operator'\.([A-Za-z_]\w*)'$/.exec(opToken) : null
  const name = dotMember ? dotMember[1] : (opToken ?? nm[1])
  s = s.slice(nm[0].length).trim()
  eatSpecs() // 이름 뒤: 접근/선언 지정자
  // 매개변수 (...) 또는 [...] — `<decides>` 실패형 함수는 verse-lsp가 사용처 호버에서 매개변수
  // 목록을 대괄호로 준다(호출 구문 `f[]`을 그대로 반영). 둘 다 매개변수 목록으로 받아 함수로
  // 분류해야 한다 — 안 그러면 `(`가 아니라 `[`로 시작해 params·ret 둘 다 못 잡고 종류가 'type'으로
  // 깨졌다(예: Entity.GetPlayspaceForEntity[] → 종류 Type). 최상위 쉼표 분리는 splitCsArgs가 처리.
  let params: string[] | undefined
  if (s.startsWith('(') || s.startsWith('[')) {
    const open = s[0]
    const close = open === '(' ? ')' : ']'
    let depth = 0
    let end = -1
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c === open) depth++
      else if (c === close && --depth === 0) {
        end = i
        break
      }
    }
    if (end > 0) {
      params = splitCsArgs(s.slice(1, end))
      s = s.slice(end + 1).trim()
    }
  }
  // 점 멤버 접근(operator'.Member')의 첫 매개변수는 수신자(receiver)이므로 진짜 매개변수에서 뺀다.
  if (dotMember && params?.length) params = params.slice(1)
  eatSpecs() // 매개변수 뒤: 효과 지정자 (<transacts><predicts> 등)
  // 반환형/타입 — 남은 선두 ':'
  let ret: string | undefined
  const rt = /^:\s*(.+)$/.exec(s)
  if (rt) ret = rt[1].trim()
  // 종류 — Verse는 var(가변)와 비-var(불변)가 근본적으로 다르다: var/set→'var'(가변, 핑크),
  // 매개변수 있으면 함수, :타입만 있는 비-var 바인딩은 'constant'(불변 상수, 청록), 셋 다 없으면
  // 타입(키워드 없는 클래스 등). 이렇게 해야 var 변수와 일반 상수/파라미터가 색·라벨로 갈린다.
  const kind = bind ? 'var' : params ? 'function' : ret ? 'constant' : 'type'
  return {
    kind,
    name,
    container,
    ret,
    retLabel: kind === 'function' ? 'return' : 'type',
    params,
    mods: mods.length ? mods : undefined
  }
}

function parseHover(md: string): HoverParts | null {
  // Roslyn은 줄바꿈을 CRLF로 보낸다 — 펜스 정규식(```lang\n)이 \r에 막혀 구조화에
  // 실패하고 raw 마크다운으로 떨어지면 카드 디자인이 깨진다. 먼저 LF로 정규화한다.
  let rest = md.replace(/\r\n?/g, '\n').trim()
  let kind: string | null = null
  let name: string | null = null
  const head = /^###\s+([^\n`]+?)\s*`([^`\n]+)`\s*\n?/.exec(rest)
  if (head) {
    kind = head[1].trim()
    name = head[2]
    rest = rest.slice(head[0].length)
    // clangd는 C++ static 데이터 멤버를 'static-property'라 부른다 — 인스턴스 멤버
    // (field)·C#(static field)과 용어를 맞춘다
    if (kind === 'static-property') kind = 'static field'
    // clangd 종류는 'static-method'처럼 하이픈을 쓴다 — C#('static method')과 통일해
    // 칩이 'STATIC-METHOD'가 아니라 'STATIC METHOD'로 뜨게 하이픈을 공백으로 바꾼다
    kind = kind.replace(/-/g, ' ')
  }
  let sig: string | null = null
  let sigLang = ''
  const lead = /^```(\w*)\n([\s\S]*?)```\s*/.exec(rest) // 선두 펜스 (OmniSharp)
  const tail = /```(\w*)\n([\s\S]*?)```\s*$/.exec(rest) // 말미 펜스 (clangd)
  const m = lead ?? tail
  if (m) {
    sigLang = m[1]
    sig = m[2].replace(/\n$/, '')
    rest = lead ? rest.slice(m[0].length) : rest.slice(0, m.index)
  }
  if (!head && !sig) return null
  if (sig) sig = sig.replace(/^\/\/ In .+\n/, '') // 소속 클래스 주석 — 헤더의 한정명과 중복
  // Roslyn은 오버로드가 있으면 시그니처 끝에 '(+ 1 오버로드)'/'(+ 2 overloads)'를 붙여
  // — parseCsSig의 타입/멤버 판별을 깨뜨리므로 떼어낸다 (메서드 인자 괄호는 '+'로 시작 안 함)
  if (sig) sig = sig.replace(/\s*\(\+[^)]*\)\s*$/, '')
  // 메타 줄은 '→ `bool`' 같은 기호 대신 라벨(return·type·value)로. 출처(provided
  // by/in)는 푸터로, clangd가 본문에 풀어 쓰는 'Parameters:' 불릿은 구조화된
  // 매개변수 목록으로 끌어올린다 — RETURN과 같은 격자에서 줄맞춰 보이게.
  const metas: { k: string; v: string; doc?: string }[] = []
  let params: { v: string; doc?: string }[] = []
  const facts: { k: string; v: string }[] = []
  let from: { k: string; v: string } | null = null
  const sigMods: string[] = [] // Verse 지정자(parseVerseSig)처럼 시그니처 파서가 끌어낸 한정자
  // 독시젠/문서 태그 — 본문에 '@param x …'로 날 것으로 두지 않고 스펙 행에 합친다
  const paramDocs = new Map<string, string>()
  let returnDoc = ''
  const docLines: string[] = []
  const lines = rest.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '---') continue
    if (t.startsWith('→')) metas.push({ k: 'return', v: t.slice(1).trim() })
    else if (/^Type:/.test(t)) metas.push({ k: 'type', v: t.replace(/^Type:\s*/, '') })
    else if (/^Value =/.test(t)) metas.push({ k: 'value', v: t.replace(/^Value =\s*/, '') })
    else if (/^provided by\b/.test(t)) from = { k: 'provided by', v: t.replace(/^provided by\s*/, '') }
    else if (/^Offset:\s*\d+\s*byte/.test(t)) {
      // clangd 필드 메모리 정보 — 'Offset: 0 bytes' → 종류 칩 옆 알약으로
      const m = /^Offset:\s*(\d+)\s*byte/.exec(t)
      if (m) facts.push({ k: 'offset', v: m[1] + 'B' })
    } else if (/^Size:\s*\d+\s*byte/.test(t)) {
      // 'Size: 12 bytes (+4 bytes padding), alignment 4 bytes'
      const sz = /^Size:\s*(\d+)\s*byte/.exec(t)
      const pad = /\(\+(\d+)\s*bytes? padding\)/.exec(t)
      const al = /alignment\s+(\d+)\s*byte/.exec(t)
      if (sz) facts.push({ k: 'size', v: sz[1] + 'B' + (pad ? '+' + pad[1] : '') })
      if (al) facts.push({ k: 'align', v: al[1] + 'B' })
    }
    else if (/^Parameters:\s*$/.test(t)) {
      while (i + 1 < lines.length) {
        const b = lines[i + 1].trim()
        if (!b) {
          i++
          continue
        }
        const item = /^[-*]\s+(.+)$/.exec(b)
        if (!item) break
        params.push({ v: item[1] })
        i++
      }
    } else if (/^[@\\]param(?:\[[^\]]*\])?\s+\w+/.test(t)) {
      const m = /^[@\\]param(?:\[[^\]]*\])?\s+(\w+)\s+(.+)$/.exec(t)
      if (m) paramDocs.set(m[1], m[2])
      else docLines.push(lines[i])
    } else if (/^[@\\]returns?\s+\S/.test(t)) {
      returnDoc = t.replace(/^[@\\]returns?\s+/, '')
    } else if (/^[@\\]brief\s+\S/.test(t)) {
      docLines.push(t.replace(/^[@\\]brief\s+/, '')) // 태그만 벗기고 본문으로
    } else docLines.push(lines[i])
  }
  // 종류 헤더가 없는 서버(OmniSharp C#, Verse)는 시그니처에서 종류·이름·반환형·매개변수·소속을
  // 끌어낸다. Verse는 ```verse 펜스라 sigLang으로 구분해 전용 파서를 쓴다.
  if (!kind && sig) {
    const isVerse = sigLang === 'verse'
    const e = isVerse ? parseVerseSig(sig) : parseCsSig(sig)
    if (e) {
      kind = e.kind
      name = e.name
      if (e.ret) metas.unshift({ k: e.retLabel ?? 'type', v: '`' + e.ret + '`' })
      if ('value' in e && e.value) metas.push({ k: 'value', v: '`' + e.value + '`' }) // const/field 초기값
      if (e.params?.length) params = e.params.map((q) => ({ v: '`' + q + '`' }))
      if ('mods' in e && e.mods?.length) sigMods.push(...e.mods) // Verse 지정자 → access 칩
      if (e.container && !from) {
        // Verse: 한정자는 모듈/클래스 경로 → 'module'. C#/C++: 타입은 namespace, 멤버는 in.
        const isType = /^(struct|class|interface|enum|delegate|namespace)$/.test(e.kind)
        from = { k: isVerse ? 'module' : isType ? 'namespace' : 'in', v: '`' + e.container + '`' }
      }
    }
  }
  // @param/@return 문서를 스펙 행에 붙인다 — 코드 조각의 마지막 식별자가 매개변수 이름
  if (paramDocs.size || returnDoc) {
    const nameOf = (v: string): string => {
      const code = v.replace(/`/g, '').replace(/\(aka[^)]*\)\s*$/, '').trim()
      const m = /([A-Za-z_]\w*)\s*$/.exec(code)
      return m ? m[1] : ''
    }
    for (const q of params) {
      const d = paramDocs.get(nameOf(q.v))
      if (d) q.doc = d
    }
    if (returnDoc) {
      const r = metas.find((m) => m.k === 'return')
      if (r) r.doc = returnDoc
      else metas.push({ k: 'return', v: '', doc: returnDoc }) // void인데 @return만 있는 경우
    }
  }
  // 한정자 — 시그니처 전문을 치우면 잃기 쉬운 정보(static·const·접근자·Verse 지정자…)만 칩으로 승격
  const mods: string[] = [...sigMods]
  if (sig) {
    const flat = sig.replace(/\s+/g, ' ')
    const lead =
      /^(?:template\s*<[^>]*>\s*)?((?:(?:public|private|protected|internal|static|virtual|override|abstract|readonly|async|sealed|partial|inline|constexpr|explicit|unsafe|friend|mutable)\b:?\s*)+)/.exec(
        flat
      )
    if (lead) mods.push(...lead[1].replace(/:/g, ' ').trim().split(/\s+/))
    if (/\)\s*const\b/.test(flat)) mods.push('const')
    if (/\{\s*get;/.test(flat)) mods.push('get')
    if (/\bset;\s*\}/.test(flat)) mods.push('set')
  }
  const kindWords = (kind ?? '').toLowerCase()
  const dedupMods = [...new Set(mods)].filter((m) => !kindWords.includes(m))
  // 매크로의 #define/전개처럼 시그니처가 본체인 경우만 전문을 남긴다
  const sigIsBody = !!sig && /#define|\/\/ Expands to/.test(sig)
  const showSig = !!sig && (!(kind && name) || sigIsBody || /macro/.test(kindWords))
  return { kind, name, mods: dedupMods, sig, sigLang, showSig, metas, params, facts, from, docs: docLines.join('\n').trim() }
}

// 종류 칩 색 — 코드 본문과 같은 팔레트(메서드 초록, 클래스 보라, 매크로 파랑…).
// 본문에서 기본색인 변수·파라미터도 칩에서는 색을 가진다(회색 칩 없음 — 사용자 피드백):
// 변수는 핑크(--code-num), 파라미터는 탄(--code-str), 그 외 미분류는 앱 액센트.
function hoverKindClass(kind: string): string {
  const k = kind.toLowerCase()
  // Verse 지정자/속성 용어집 카드 — 코드에서 <지정자>가 갖는 구조체색 칩으로 통일
  if (/access|effect|specifier|attribute/.test(k)) return 'k-type2'
  if (/method|function|constructor|destructor|operator/.test(k)) return 'k-fn'
  if (/struct|enum|union|delegate/.test(k)) return 'k-type2'
  if (/class|interface|namespace|type|concept|module/.test(k)) return 'k-type'
  if (/macro/.test(k)) return 'k-kw'
  if (/field|property|event|const/.test(k)) return 'k-member'
  if (/variable|local|\bvar\b/.test(k)) return 'k-var'
  if (/param/.test(k)) return 'k-param'
  return 'k-plain'
}

// Verse 종류 칩 색 — 사용자 선호대로 Constant Variable ↔ Variable 색을 맞바꾸고, enum/struct 값은
// 그 타입색(연보라)으로. 그 외는 공용 hoverKindClass.
function verseKindClass(kind: string, display: string | null): string {
  if (display === 'Enum Value' || display === 'Struct Value') return 'k-type2'
  if (kind === 'constant') return 'k-var' // (was k-member) ↔ swapped
  if (kind === 'var') return 'k-member' // (was k-var) ↔ swapped
  // @attribute → its own coral chip (--verse-attr, same as the code body), NOT the struct colour
  // (k-type2) — otherwise the attribute chip clashes with struct/enum cards.
  if (kind === 'attribute') return 'k-attr'
  return hoverKindClass(kind)
}

// Verse 지정자(<…>)는 의미가 갈린다 — 접근(가시성)·효과(계산 효과)·그 외 선언 지정자.
// 카드에서 한 줄로 뭉치지 않고 access · effects · specifiers 세 줄로 나눠 보여 준다.
const VERSE_ACCESS = new Set(['public', 'private', 'protected', 'internal', 'epic_internal'])
const VERSE_EFFECT = new Set([
  'transacts', 'computes', 'reads', 'writes', 'decides', 'varies',
  'converges', 'suspends', 'no_rollback', 'allocates', 'predicts'
])
// Every name that is a genuine `<specifier>` (access · effect · declaration modifier). Built from the
// SAME list that drives `<…>` completion (verseKeywords), so the two never drift. @attributes
// (`@editable`, `@import_as`, …) are metadata, NOT specifiers — but verse-lsp folds them into its
// hover's `<…>` too, so anything folded that ISN'T in this set is an attribute (see splitVerseSpecs).
const VERSE_KNOWN_SPEC = new Set(VERSE_SPECIFIERS.map((s) => s.name))
// '<public>' / '<getter(GetX)>' → 'public' / 'getter'
function verseSpecName(spec: string): string {
  const m = /^<\s*([A-Za-z_]\w*)/.exec(spec)
  return m ? m[1] : spec.replace(/[<>]/g, '')
}

// 호버 카드 안의 토큰(<지정자>·@속성)·종류 칩에 "이게 뭔지" 네이티브 툴팁(title)을 달아 준다 —
// 코드에서 그 토큰을 직접 호버했을 때 뜨는 글로서리와 같은 설명. 출처는 완성과 동일한
// verseKeywords(VERSE_SPECIFIERS·VERSE_ATTRIBUTES)라 설명이 한 곳에서만 관리된다.
const VERSE_TOK_DESC = new Map<string, string>()
for (const s of [...VERSE_SPECIFIERS, ...VERSE_ATTRIBUTES]) if (s.doc) VERSE_TOK_DESC.set(s.name, s.doc)
// 토큰(`<override>` / `<getter(GetX)>` / `@editable`)의 설명. @editable_* 계열은 editable로 폴백.
function verseTokDesc(tok: string): string | undefined {
  const n = verseSpecName(tok).replace(/^@/, '')
  return VERSE_TOK_DESC.get(n) ?? (n.startsWith('editable_') ? VERSE_TOK_DESC.get('editable') : undefined)
}
// 종류 칩(STRUCT·VARIABLE·ATTRIBUTE…)의 설명 — p.kind(원형) 기준.
const VERSE_KIND_DESC: Record<string, string> = {
  class: '객체 타입입니다. 상속·메서드를 가질 수 있고, 담아도 복사되지 않고 원본을 가리킵니다.',
  struct: '데이터를 묶는 값 타입입니다. 넘기거나 대입할 때 전체가 복사됩니다.',
  enum: '이름을 붙인 값들을 나열한 목록 타입입니다.',
  interface: '구현해야 할 메서드들을 정해 둔 약속입니다. 클래스가 이를 구현합니다.',
  module: '관련 코드를 묶는 단위입니다. 경로(`/My.com/Game`)로 구분됩니다.',
  var: '값을 바꿀 수 있는 변수입니다. `set` 으로 새 값을 넣습니다.',
  constant: '한 번 정해지면 바뀌지 않는 값(상수)입니다.',
  function: '호출하면 동작을 수행하고 값을 돌려줄 수 있는 함수입니다.',
  attribute: '심볼에 부가 정보를 다는 `@`속성입니다.',
  type: '타입입니다.'
}
function verseKindDesc(kind: string | null): string | undefined {
  if (!kind) return undefined
  const k = kind.toLowerCase()
  if (k.includes('enum value')) return '`enum` 에 나열된 값 중 하나입니다.'
  if (k.includes('struct value')) return '`struct` 의 멤버 값입니다.'
  if (k.includes('param')) return '함수에 전달되는 매개변수입니다.'
  if (k.includes('local')) return '블록 안에서만 쓰이는 지역 변수입니다.'
  return VERSE_KIND_DESC[k]
}
// 내장(원시) 타입 설명 — 본문 글로서리(main/lsp/verse.ts)와 같은 내용의 작은 미러. 카드 안 코드
// (파라미터/반환형)에 나온 `char`·`float`·`void` 같은 타입에 가까이 댔을 때 설명을 띄우는 데 쓴다.
const VERSE_BUILTIN_TYPE_DESC: Record<string, string> = {
  int: '정수입니다.',
  float: '소수점이 있는 수입니다.',
  logic: '참이나 거짓 둘 중 하나를 담습니다.',
  string: '글자들이 이어진 문자열입니다.',
  void: '값이 사실상 없음을 뜻하는 타입입니다. 돌려줄 게 없는 함수의 반환형으로 씁니다.',
  char: '글자 하나를 담습니다.',
  char32: '유니코드 코드포인트 하나를 담는 글자입니다.',
  char8: 'UTF-8 바이트 하나를 담는 글자입니다.',
  rational: '오차 없이 정확한 분수를 담습니다.',
  any: '모든 타입을 다 받는 가장 위쪽 타입입니다.',
  comparable: '서로 같은지 비교할 수 있는 타입입니다.',
  tuple: '여러 값을 한 묶음으로 담습니다.',
  array: '여러 값을 순서대로 담는 배열입니다.',
  map: '키로 값을 찾는 묶음입니다.',
  weak_map: '영속 저장에 주로 쓰는 특수한 맵입니다.',
  type: '타입 자체를 값처럼 다룹니다.',
  subtype: '어떤 타입이거나 그 자식 타입이면 받아 주는 제약입니다.'
}
// 카드 안 코드 토큰(단어) 하나의 설명 — 지정자/속성 → 내장 타입 → (레지스트리로 아는) 사용자/엔진
// 타입의 종류 순으로 찾는다. 없으면 undefined(설명 안 띄움).
function verseWordDesc(word: string): string | undefined {
  const tok = VERSE_TOK_DESC.get(word) ?? (word.startsWith('editable_') ? VERSE_TOK_DESC.get('editable') : undefined)
  if (tok) return tok
  if (VERSE_BUILTIN_TYPE_DESC[word]) return VERSE_BUILTIN_TYPE_DESC[word]
  const reg = verseReg()
  if (reg.docs[word]) return reg.docs[word] // 그 타입(class/struct/enum)의 실제 주석(#/@doc) 우선
  const k = reg.kind[word]
  return k ? VERSE_KIND_DESC[k] : undefined // 주석이 없을 때만 종류 일반 설명으로 폴백
}
// 지정자 묶음을 access → specifiers(그 외) → effects 순의 (비어있지 않은) 행들로 가른다.
// `kind`를 받아: ① 접근지시자가 없으면 Verse 기본값 `internal`을 명시해 보여 주고,
// ② `var`는 읽기/쓰기 접근이 갈리므로 'read access'·'write access'로 나눠 보여 준다.
function splitVerseSpecs(mods: string[], kind?: string, write?: string): { k: string; items: string[] }[] {
  const access: string[] = []
  const effects: string[] = []
  const attrs: string[] = []
  const other: string[] = []
  for (const m of mods) {
    const n = verseSpecName(m)
    if (VERSE_ACCESS.has(n)) access.push(m)
    else if (VERSE_EFFECT.has(n)) effects.push(m)
    else if (VERSE_KNOWN_SPEC.has(n)) other.push(m) // a genuine declaration specifier → specifiers row
    else attrs.push('@' + n) // not a known specifier → it's a folded @attribute (<import_as(…)> → @import_as)
  }
  // A DATA member with no access specifier defaults to `internal` — surface it so the card is
  // unambiguous. Only for data/callable members (var/constant/function); type DEFINITIONS
  // (class/struct/enum/interface) don't get the injected default (and synthesized param/local
  // cards, whose kind is capitalised like 'Parameter', never match here either).
  const isMemberDecl = !!kind && /^(var|constant|function)$/.test(kind)
  if (!access.length && isMemberDecl) access.push('<internal>')
  const rows: { k: string; items: string[] }[] = []
  if (kind === 'var') {
    // a `var`'s name-specifier is its READ (get) access; the WRITE (set) access is the explicit
    // `var<…>` setter (`write`, looked up from the registry since verse-lsp drops it) and only
    // falls back to the read access when no setter was specified.
    const read = access[0] ?? '<internal>'
    rows.push({ k: 'read access', items: [read] })
    rows.push({ k: 'write access', items: [write ? `<${write}>` : read] })
  } else if (access.length) {
    rows.push({ k: 'access', items: access })
  }
  if (other.length) rows.push({ k: 'specifiers', items: other })
  if (effects.length) rows.push({ k: 'effects', items: effects })
  if (attrs.length) rows.push({ k: 'attributes', items: attrs })
  return rows
}

// 세션 동안 배운 식별자→색 누적 사전 — 호버 시그니처가 참조하는 타입(TArray 등)이
// "지금 열린 파일"에는 안 나와도, 전에 연 파일에서 배웠으면 칠할 수 있게 한다
const sessionSemDict = new Map<string, string>()

// C++ struct 구분 보정(cppRecordIsStruct/cppFieldOfStruct + 프로브)은 ../lib/cppStruct
// (useCppStructOv 훅)로 옮겨 뷰어·CM이 공유한다.

// UE 명명규칙 폴백 (C++ 전용) — 사전 어디에도 없는 이름이면 접두사로 추정:
// F/U/A/S/T/I+대문자 → 타입 보라, E+대문자 → enum 연보라. 사전이 항상 우선이라
// TEXT 같은 매크로는 본문 토큰(파랑)이 이긴다.
const UE_TYPE_RE = /^[FUASTIE][A-Z]\w*$/

// 호버 시그니처에 본문과 같은 시맨틱 색 입히기 — 시그니처 텍스트 조각은 LSP로
// 분석할 수 없으니, 문서 토큰으로 만든 식별자→색 사전을 텍스트 매칭으로 적용한다.
// hljs 토큰의 텍스트 노드를 쪼개 안쪽에 스팬을 끼우는 방식은 decorateLine과 동일;
// 문자열·주석 안은 건드리지 않는다.
function decorateIdents(html: string, resolve: (name: string) => string | null): string {
  const root = document.createElement('div')
  root.innerHTML = html
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) nodes.push(n)
  for (const node of nodes) {
    let skip = false
    for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
      if (/hljs-(string|comment)/.test(el.className)) {
        skip = true
        break
      }
    }
    if (skip) continue
    const text = node.data
    const hits: { start: number; end: number; cls: string }[] = []
    const re = /[A-Za-z_][A-Za-z0-9_]*/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const cls = resolve(m[0])
      if (cls) hits.push({ start: m.index, end: m.index + m[0].length, cls })
    }
    let cur = node
    let offset = 0
    for (const h of hits) {
      const piece = h.start > offset ? cur.splitText(h.start - offset) : cur
      const tail = piece.splitText(h.end - h.start)
      const span = document.createElement('span')
      span.className = h.cls
      piece.parentNode?.replaceChild(span, piece)
      span.appendChild(piece)
      cur = tail
      offset = h.end
    }
  }
  return root.innerHTML
}

// exported so the CodeMirror editor (CmEditor) renders the identical hover card.
// It's a function declaration → hoisted, so the FileModal↔CmEditor import cycle is safe.
export function HoverContent({
  md,
  lang,
  dict,
  extraMods
}: {
  md: string
  lang: string
  dict: Map<string, string> | null
  extraMods?: string[] // C# 정의 줄에서 보강한 한정자 (시그니처 추출분과 합집합)
}) {
  const p = useMemo(() => parseHover(md), [md])
  // static은 ACCESS 행이 아니라 종류 칩에 합친다 — 'STATIC METHOD'처럼 한눈에
  const allMods = useMemo(() => [...new Set([...(p?.mods ?? []), ...(extraMods ?? [])])], [p, extraMods])
  const kindDisplay = useMemo(() => {
    if (!p?.kind) return null
    if (allMods.includes('static') && !/static/i.test(p.kind)) return 'static ' + p.kind
    // Verse: label by the CONTAINER's kind when the hovered symbol is a member of an enum/struct
    // ('Enum Value' / 'Struct Value'); otherwise make data-member labels unambiguous — a non-`var`
    // binding is an immutable 'Constant Variable', a `var` binding is a (mutable) 'Variable'.
    if (lang === 'verse') {
      // the dotted-value form (`enum (/…:)Type.Value`) already resolved to '<kind> value'
      if (p.kind === 'enum value') return 'Enum Value'
      if (p.kind === 'struct value') return 'Struct Value'
      // otherwise: if the hover qualifier's last segment is itself an enum/struct, the symbol is a
      // member of it (a use-site field/value). (The type itself has container = its module.)
      const container = (p.from?.v ?? '').replace(/`/g, '').split('/').filter(Boolean).pop()
      const ck = container ? verseReg().kind[container] : undefined
      if (ck === 'enum' || ck === 'struct') return ck === 'enum' ? 'Enum Value' : 'Struct Value'
      if (p.kind === 'constant') return 'Constant Variable'
      if (p.kind === 'var') return 'Variable'
    }
    return p.kind
  }, [p, allMods, lang])
  const mods = useMemo(() => {
    if (!p) return []
    const kindWords = (p.kind ?? '').toLowerCase()
    return allMods.filter((m) => m !== 'static' && !kindWords.includes(m))
  }, [p, allMods])
  // Verse: the hovered symbol's OWN name is rendered as an isolated `Player` token, so the registry
  // highlighter can't see it's a binding and promotes any name matching a type (UEFN asset classes are
  // PascalCase, e.g. a project `Player` class) to the type colour — even when the card already knows
  // it's a parameter/local/variable/constant. Force those names to the plain identifier colour so a
  // `for (Player : …)` loop var or `(Player:player)` param doesn't read purple. Real types/functions
  // keep the highlighter's colour.
  const namePlain = useMemo(
    () => lang === 'verse' && /^(parameter|local variable|variable|constant|var)$/i.test(p?.kind ?? ''),
    [p, lang]
  )
  // a Verse `var`'s SETTER (write) access — verse-lsp's hover drops it, so look it up from the
  // registry by the member's container (the hover qualifier's last path segment) + name.
  const verseWrite = useMemo(() => {
    if (lang !== 'verse' || p?.kind !== 'var' || !p.name) return undefined
    const container = (p.from?.v ?? '').replace(/`/g, '').split('/').filter(Boolean).pop()
    return container ? verseReg().setters[container]?.[p.name] : undefined
  }, [p, lang])
  // Verse: when the container is a TYPE, label the footer with the owner's KIND (struct/enum/class)
  // and show its name — e.g. an Enum Value reads 'enum `weapon_kind`', a struct field 'struct
  // `vector_pair`' — instead of the raw "module: /…/Type" path.
  const verseFrom = useMemo(() => {
    if (lang !== 'verse' || !p?.from) return p?.from
    const owner = p.from.v.replace(/`/g, '').split('/').filter(Boolean).pop()
    const ck = owner ? verseReg().kind[owner] : undefined
    return ck ? { k: ck, v: '`' + owner + '`' } : p.from
  }, [p, lang])
  // 카드 안의 모든 코드(시그니처·메타 칩·본문 인라인/펜스·푸터)는 본문과 같은
  // 파이프라인 하나로: hljs 베이스 + 언어 팔레트 + 시맨틱 색 사전(decorate).
  // 색 우선순위: 이 파일 사전 → 세션 누적 사전 → UE 명명규칙(C++만)
  const deco = useMemo(() => {
    const cpp = lang === 'cpp' || lang === 'c'
    const resolve = (name: string): string | null => {
      const own = dict?.get(name) ?? sessionSemDict.get(name)
      if (own) return own
      if (cpp && UE_TYPE_RE.test(name)) return name[0] === 'E' ? 'sem-type2' : 'sem-type'
      return null
    }
    return (html: string): string => decorateIdents(html, resolve)
  }, [dict, lang])
  const sigHtml = useMemo(() => {
    if (!p?.sig) return ''
    const base = highlightCode(p.sig, p.sigLang || lang)
    return deco ? deco(base) : base
  }, [p, lang, deco])
  // 카드 안 토큰(<지정자>·@속성·파라미터/반환형의 타입·종류 칩)에 가까이 대면 그게 뭔지 설명을 카드
  // "하단 띠"에 보여 준다. 떠다니는 말풍선(깜빡임·흰 공·위치 깨짐) 대신 카드에 붙은 고정 영역이라 차분하다.
  // 이벤트는 위임(델리게이션)으로 받아 char·color·void 같은 코드 안 타입까지 한 번에 처리한다.
  // 설명은 카드 "바로 아래"(자리 없으면 위)에 한 곳에 떠서, 어느 토큰을 훑든 위치는 그대로 두고 글자만
  // 바뀐다 — 토큰마다 새로 떴다 사라지지 않으니(요소를 계속 띄워 둠) 깜빡임·흰 공이 없다. 카드 밖에 있어
  // 카드가 위로 떠도/스크롤돼도 안 가린다.
  const [tip, setTip] = useState<{ text: string; left: number; top?: number; bottom?: number } | null>(null)
  const tipHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showTokDesc = (text: string, anchor: HTMLElement): void => {
    if (tipHideTimer.current) {
      clearTimeout(tipHideTimer.current)
      tipHideTimer.current = null
    }
    // 호버한 그 토큰 위치에 — 토큰 바로 위(가운데 정렬), 위 공간이 없으면 아래. 디자인은 검정 카드(.lh-tokdesc).
    const r = anchor.getBoundingClientRect()
    const left = Math.min(Math.max(r.left + r.width / 2, 176), window.innerWidth - 176)
    const above = r.top > 92
    const top = above ? undefined : r.bottom + 9
    const bottom = above ? window.innerHeight - r.top + 9 : undefined
    // 위치까지 비교 — 텍스트가 같아도(예: READ/WRITE 둘 다 <internal>) 다른 토큰이면 그 위치로 옮긴다.
    // (같은 토큰 안에서의 중복 호출만 그대로 둬서 불필요한 리렌더를 막는다)
    setTip((cur) =>
      cur && cur.text === text && cur.left === left && cur.top === top && cur.bottom === bottom
        ? cur
        : { text, left, top, bottom }
    )
  }
  const scheduleTokHide = (): void => {
    if (tipHideTimer.current) clearTimeout(tipHideTimer.current)
    tipHideTimer.current = setTimeout(() => setTip(null), 160)
  }
  const onTokOver = (e: React.MouseEvent): void => {
    const t = e.target as HTMLElement
    const tagged = t.closest?.('[data-tip]') as HTMLElement | null
    if (tagged?.dataset.tip) return showTokDesc(tagged.dataset.tip, tagged)
    // 코드 토큰(잎 스팬)의 단어로 설명을 찾는다 — 파라미터/반환형 안의 타입(char·color·void…)까지
    if (t.childElementCount === 0 && lang === 'verse') {
      const w = (t.textContent ?? '').trim()
      if (/^[A-Za-z_]\w*$/.test(w)) {
        const d = verseWordDesc(w)
        if (d) return showTokDesc(d, t)
      }
    }
    scheduleTokHide()
  }
  useEffect(() => () => void (tipHideTimer.current && clearTimeout(tipHideTimer.current)), [])
  if (!p) return <Markdown text={md} codeLang={lang} decorate={deco} />
  return (
    <div
      className="lh-body"
      onMouseOver={lang === 'verse' ? onTokOver : undefined}
      onMouseLeave={lang === 'verse' ? scheduleTokHide : undefined}
    >
      {p.kind && (
        <div className="lh-head lh-kindrow">
          <span
            className={'lh-kind ' + (lang === 'verse' ? verseKindClass(p.kind, kindDisplay) : hoverKindClass(p.kind))}
            data-tip={(lang === 'verse' && verseKindDesc(p.kind)) || undefined}
          >
            {kindDisplay}
          </span>
        </div>
      )}
      {/* 메모리 정보 알약 — 종류 칩 아래 별도 줄, 아래에 전폭 밑줄로 단을 가른다 */}
      {p.facts.length > 0 && (
        <div className="lh-head lh-factrow">
          {p.facts.map((f) => (
            <span key={f.k} className="lh-fact">
              <span className="k">{f.k}</span>
              <span className="v">{f.v}</span>
            </span>
          ))}
        </div>
      )}
      {p.showSig && p.sig && (
        <div className="lh-sig">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: sigHtml }} />
        </div>
      )}
      {/* 스펙 행 — NAME → ACCESS(접근지시자) → PARAMS → RETURN 순서, 한 줄에 하나씩 */}
      {(p.name || mods.length > 0 || p.params.length > 0 || p.metas.length > 0 || (lang === 'verse' && verseFrom)) && (
        <div className="lh-spec">
          {/* NAME·ACCESS도 PARAMS·RETURN과 같은 코드 칩으로 — 행 전체가 한 결 */}
          {p.name && (
            <>
              <span className="lh-spec-k">name</span>
              <div className={'lh-spec-v lh-name-row' + (namePlain ? ' nm-plain' : '')}>
                <Markdown text={'`' + p.name + '`'} codeLang={lang} decorate={deco} />
              </div>
            </>
          )}
          {/* Verse: 지정자를 access · specifiers · effects 로 갈라 각각 한 줄씩 */}
          {lang === 'verse'
            ? splitVerseSpecs(mods, p.kind ?? undefined, verseWrite).map((row) => (
                <Fragment key={row.k}>
                  <span className="lh-spec-k">{row.k}</span>
                  {/* 토큰마다 따로 칩 — 가까이 대면 native title로 "뭔지" 설명이 뜬다(글로서리와 동일) */}
                  <div className="lh-spec-v">
                    <div className="lh-spec-toks">
                      {row.items.map((m, i) => {
                        const d = verseTokDesc(m)
                        return (
                          <span key={i} className="lh-spec-tok" data-tip={d || undefined}>
                            <Markdown text={'`' + m + '`'} codeLang={lang} decorate={deco} />
                          </span>
                        )
                      })}
                    </div>
                  </div>
                </Fragment>
              ))
            : mods.length > 0 && (
                <>
                  <span className="lh-spec-k">access</span>
                  <div className="lh-spec-v">
                    <Markdown text={mods.map((m) => '`' + m + '`').join(' ')} codeLang={lang} decorate={deco} />
                  </div>
                </>
              )}
          {p.params.length > 0 && (
            <>
              <span className="lh-spec-k">params</span>
              <div className="lh-spec-v">
                {p.params.map((q, i) => (
                  <div key={i} className="lh-pline">
                    <Markdown text={q.v} codeLang={lang} decorate={deco} />
                    {q.doc && <span className="lh-pdoc">{q.doc}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
          {p.metas.map((m, i) => (
            <Fragment key={i}>
              <span className="lh-spec-k">{m.k}</span>
              <div className="lh-spec-v">
                <div className="lh-pline">
                  {m.v && <Markdown text={m.v} codeLang={lang} decorate={deco} />}
                  {m.doc && <span className="lh-pdoc">{m.doc}</span>}
                </div>
              </div>
            </Fragment>
          ))}
          {/* Verse: 소속 타입(struct/enum/class …)을 별도 구분선 footer가 아니라 스펙 그리드의
              마지막 행으로 — name·access 와 같은 결로 한 줄 더 붙인다 */}
          {lang === 'verse' && verseFrom && (
            <>
              <span className="lh-spec-k">{verseFrom.k}</span>
              <div className="lh-spec-v">
                <Markdown text={verseFrom.v} codeLang={lang} decorate={deco} />
              </div>
            </>
          )}
        </div>
      )}
      {p.docs && (
        <div className="lh-docs">
          <Markdown text={p.docs} codeLang={lang} decorate={deco} />
        </div>
      )}
      {lang !== 'verse' && verseFrom && (
        <div className="lh-from">
          <span className="lh-spec-k">{verseFrom.k}</span>
          <Markdown text={verseFrom.v} codeLang={lang} decorate={deco} />
        </div>
      )}
      {/* 토큰 설명 — 카드 밖(아래/위)에 한 곳에 떠서 글자만 바뀐다. body 포털이라 카드 위(z)에 뜬다 */}
      {tip &&
        createPortal(
          <div className="lh-tokdesc" style={{ left: tip.left, top: tip.top, bottom: tip.bottom }}>
            {tip.text}
          </div>,
          document.body
        )}
    </div>
  )
}

// Wrap [char, char+len) ranges of a line's text in classed spans. Wraps are applied
// to text nodes (split at the boundaries), so a semantic span always ends up as the
// innermost element and its color wins over the surrounding hljs token's.
function decorateLine(html: string, spans: SemSpan[]): string {
  const root = document.createElement('div')
  root.innerHTML = html
  for (const { char, len, cls } of spans) {
    const targets: { node: Text; start: number; end: number }[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let pos = 0
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const s = Math.max(char, pos)
      const e = Math.min(char + len, pos + n.data.length)
      if (s < e) targets.push({ node: n, start: s - pos, end: e - pos })
      pos += n.data.length
      if (pos >= char + len) break
    }
    for (const t of targets) {
      const piece = t.start > 0 ? t.node.splitText(t.start) : t.node
      if (t.end - t.start < piece.data.length) piece.splitText(t.end - t.start)
      const span = document.createElement('span')
      span.className = cls
      piece.parentNode?.replaceChild(span, piece)
      span.appendChild(piece)
    }
  }
  return root.innerHTML
}

// DiffMarks / diffMarksOf moved to ../lib/cmDiff (shared with the CM editor). Imported above.

// where the mouse is, in LSP document coordinates (0-based line/character).
// caretRangeFromPoint gives the text node + offset under the cursor; the character
// is that offset plus the lengths of the line's earlier text nodes.
function posAtPoint(x: number, y: number): { line: number; character: number } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const lineEl = el?.closest?.('[data-ln]') as HTMLElement | null
  if (!lineEl) return null
  const ln = Number(lineEl.dataset.ln)
  if (!ln) return null
  const range = document.caretRangeFromPoint(x, y)
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || !lineEl.contains(range.startContainer)) return null
  let ch = range.startOffset
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === range.startContainer) return { line: ln - 1, character: ch }
    ch += n.textContent?.length ?? 0
  }
  return null
}

function posAt(e: React.MouseEvent): { line: number; character: number } | null {
  return posAtPoint(e.clientX, e.clientY)
}

// 본문에서 드래그한 코드 → 그 자리에서 복사하거나 Claude에게 바로 질문하는 플로팅 바.
// 채팅의 SelectionToolbar와 같은 패턴이고, 코드 뷰의 [data-ln] 줄 번호가 잡히면
// 선택 범위(시작·끝 줄)도 함께 전달해 질문에 정확한 위치가 실리게 한다.
function SelectionAskBar({
  root,
  onAsk
}: {
  root: HTMLElement | null
  onAsk: (text: string, from: number | null, to: number | null) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  // 드래그를 마친 마우스 좌표(x·y)에 앵커 — rectTop/Left는 당시 선택 rect의 스냅샷으로,
  // 스크롤 시 선택이 움직인 만큼만 바를 따라 옮기는 기준이 된다
  const [pos, setPos] = useState<{
    x: number
    y: number
    rectTop: number
    rectLeft: number
    text: string
    from: number | null
    to: number | null
  } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!root) return
    const lineOf = (node: Node | null): number | null => {
      const el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement)
      const ln = el?.closest?.('[data-ln]') as HTMLElement | null
      const n = ln ? Number(ln.dataset.ln) : NaN
      return Number.isFinite(n) && n > 0 ? n : null
    }
    const read = (): { rect: DOMRect; text: string; from: number | null; to: number | null } | null => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
      const text = sel.toString().trim()
      if (!text) return null
      // 본문(코드/마크다운) 안에서 시작하고 끝난 선택만 — 헤더의 경로 드래그 등은 제외
      const inBody = (n: Node | null): boolean => {
        const el = n && (n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : n.parentElement)
        // .cm-content = CodeMirror 편집기 본문도 본문으로 인정 (줄 번호는 data-ln이 없어
        // null로 — 선택 텍스트만 질문에 실린다)
        return !!el?.closest?.('.fv-code, .fv-md, .cm-content') && root.contains(n)
      }
      if (!inBody(sel.anchorNode) || !inBody(sel.focusNode)) return null
      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      return { rect, text, from: lineOf(range.startContainer), to: lineOf(range.endContainer) }
    }
    // 새 드래그/클릭이 시작되는 순간(mousedown) 이전 툴바를 즉시 내린다 —
    // mouseup까지 낡은 툴바가 남아 있으면 반응이 한 박자 늦게 느껴진다
    const onMouseDown = (e: MouseEvent): void => {
      if (barRef.current?.contains(e.target as Node)) return
      setPos(null)
    }
    // 드래그(선택)만으론 안 띄우고, 선택 위에서 우클릭했을 때만 툴바를 연다(사용자 요청).
    // 본문 선택이 없으면 막지 않고 기본 동작에 맡긴다.
    const onContextMenu = (e: MouseEvent): void => {
      if (barRef.current?.contains(e.target as Node)) return
      const r = read()
      if (!r) return
      e.preventDefault()
      setPos({
        x: e.clientX || r.rect.right,
        y: e.clientY || r.rect.bottom,
        rectTop: r.rect.top,
        rectLeft: r.rect.left,
        text: r.text,
        from: r.from,
        to: r.to
      })
      setCopied(false)
    }
    // 스크롤은 캡처로 받아 내부 스크롤 페인(.fv-code 등)의 이동도 따라가게 한다 —
    // 선택 rect가 움직인 변위만큼 마우스 앵커도 함께 이동
    const onScroll = (): void =>
      setPos((p) => {
        if (!p) return p
        const r = read()
        if (!r) return null
        return { ...p, x: p.x + (r.rect.left - p.rectLeft), y: p.y + (r.rect.top - p.rectTop), rectTop: r.rect.top, rectLeft: r.rect.left }
      })
    // Esc는 툴바만 접는다 — 뷰어의 Esc(카드 닫기)는 .sel-bar가 없을 때만 동작
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPos(null)
        window.getSelection()?.removeAllRanges()
      }
      // Ctrl/⌘+C — 본문 선택을 클립보드로 복사하고 툴바는 내린다. 동기식
      // execCommand가 1순위, 실패하면 clipboard API 폴백. read()가 null이면
      // 본문 밖 선택(입력창·헤더)이니 네이티브 동작에 맡긴다.
      // e.code(물리 키)로 본다 — 한글 IME에선 e.key가 'ㅊ'으로 와서 'c' 비교가 새는다.
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyC' || e.key.toLowerCase() === 'c')) {
        const r = read()
        if (r) {
          let ok = false
          try {
            ok = document.execCommand('copy')
          } catch {
            /* execCommand 미지원 — 아래 폴백 */
          }
          if (!ok) {
            const raw = window.getSelection()?.toString()
            navigator.clipboard?.writeText(raw || r.text).catch(() => {})
          }
          setPos(null) // 복사했으면 툴바는 임무 종료
        }
      }
    }
    // 선택이 어디서든 사라지면(F12 점프의 removeAllRanges, 프로그램적 해제 등)
    // 툴바도 같이 내려간다 — 마우스 이벤트만 보고 있으면 키보드 경로를 놓친다
    const onSelChange = (): void => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setPos(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('contextmenu', onContextMenu)
    root.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', onKey)
    document.addEventListener('selectionchange', onSelChange)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('contextmenu', onContextMenu)
      root.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('selectionchange', onSelChange)
    }
  }, [root])

  if (!pos) return null
  // 커서 오른쪽 아래가 기본 자리 — 화면 가장자리에 닿으면 반대쪽으로 뒤집는다
  const BAR_W = 240
  const BAR_H = 44
  const flipX = pos.x + 14 + BAR_W > window.innerWidth - 8
  const flipY = pos.y + 16 + BAR_H > window.innerHeight - 8
  const style: CSSProperties = {
    left: Math.max(8, flipX ? pos.x - 10 : pos.x + 14),
    top: Math.max(8, flipY ? pos.y - 12 : pos.y + 16),
    transform: [flipX ? 'translateX(-100%)' : '', flipY ? 'translateY(-100%)' : ''].join(' ').trim() || undefined
  }
  const copy = (): void => {
    navigator.clipboard?.writeText(pos.text).then(
      () => {
        setCopied(true)
        setTimeout(() => setPos(null), 500) // '복사됨'을 한 박자 보여주고 내린다
      },
      () => {}
    )
  }
  const ask = (): void => {
    onAsk(pos.text, pos.from, pos.to)
    setPos(null)
    window.getSelection()?.removeAllRanges()
  }
  // 포털로 body에 띄운다 — 오버레이의 backdrop-filter가 fixed 좌표의 기준을 바꿔
  // 바가 엉뚱한 위치에 뜨던 문제를 원천 차단 (body 기준 = 진짜 뷰포트 좌표)
  return createPortal(
    <div
      className="sel-bar"
      ref={barRef}
      style={style}
      // keep the highlight alive when a button is pressed (mousedown would otherwise
      // collapse the selection before our click handler reads it)
      onMouseDown={(e) => e.preventDefault()}
    >
      <button className="sel-act" onClick={copy}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        <span>{copied ? '복사됨' : '복사'}</span>
      </button>
      <span className="sel-div" />
      <button className="sel-act" onClick={ask}>
        <IconBot size={14} />
        <span>Claude에게 질문</span>
      </button>
    </div>,
    document.body
  )
}

// ── 파일 내 검색 (Ctrl+F) ────────────────────────────────────
// CSS Custom Highlight API로 본문 텍스트에 매치를 칠한다 — DOM(innerHTML)을 건드리지
// 않아 구문 강조·시맨틱 토큰과 충돌하지 않는다. 코드 뷰는 줄([data-ln]) 단위로,
// 마크다운/플레인 뷰는 본문 전체를 한 블록으로 스캔해 하이라이트 span 으로 쪼개진
// 텍스트 노드 경계를 넘는 매치도 잡는다.
interface HighlightCtor {
  new (...r: Range[]): unknown
}
const HL = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight
const hlReg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights

function FindBar({ root, contentKey, onClose }: { root: HTMLElement | null; contentKey: string; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [cur, setCur] = useState(0)
  const [total, setTotal] = useState(0)
  const ranges = useRef<Range[]>([])

  // 닫힐 때 하이라이트도 같이 걷어낸다
  useEffect(
    () => () => {
      hlReg?.delete('fvfind')
      hlReg?.delete('fvfind-cur')
    },
    []
  )

  // 이미 열려 있는 상태에서 Ctrl+F를 또 누르면 입력으로 재포커스 (전체 선택)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 쿼리/본문이 바뀌면 매치를 다시 수집해 전체 하이라이트를 칠한다
  useEffect(() => {
    ranges.current = []
    hlReg?.delete('fvfind')
    hlReg?.delete('fvfind-cur')
    const body = root?.querySelector('.fv-code, .fv-md')
    const q = query.toLowerCase()
    if (!body || !q) {
      setTotal(0)
      setCur(0)
      return
    }
    const out: Range[] = []
    const scan = (block: Element): void => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      const offs: number[] = []
      let text = ''
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        nodes.push(n)
        offs.push(text.length)
        text += n.data
      }
      if (!text) return
      const low = text.toLowerCase()
      // pos(블록 내 문자 오프셋) → 그 글자가 든 텍스트 노드와 노드 내 오프셋
      const locate = (pos: number, isEnd: boolean): { n: Text; o: number } => {
        const p = isEnd ? pos - 1 : pos
        let i = offs.length - 1
        while (i > 0 && offs[i] > p) i--
        return { n: nodes[i], o: pos - offs[i] }
      }
      let idx = low.indexOf(q)
      while (idx >= 0 && out.length < 1500) {
        const s = locate(idx, false)
        const e = locate(idx + q.length, true)
        try {
          const r = document.createRange()
          r.setStart(s.n, s.o)
          r.setEnd(e.n, e.o)
          out.push(r)
        } catch {
          /* 경계 계산이 어긋난 매치는 건너뛴다 */
        }
        idx = low.indexOf(q, idx + Math.max(q.length, 1))
      }
    }
    const lines = body.querySelectorAll('[data-ln]')
    if (lines.length) lines.forEach(scan)
    else scan(body)
    ranges.current = out
    setTotal(out.length)
    setCur(0)
    if (out.length && HL && hlReg) hlReg.set('fvfind', new HL(...out))
  }, [query, root, contentKey])

  // 현재 매치 강조 + 화면 중앙으로 스크롤
  useEffect(() => {
    hlReg?.delete('fvfind-cur')
    const r = ranges.current[cur]
    if (!r) return
    if (HL && hlReg) hlReg.set('fvfind-cur', new HL(r))
    const el = r.startContainer.nodeType === Node.TEXT_NODE ? r.startContainer.parentElement : (r.startContainer as Element)
    el?.scrollIntoView({ block: 'center' })
  }, [cur, total, query])

  const step = (d: number): void => {
    if (total) setCur((c) => (c + d + total) % total)
  }

  return (
    <div className="fv-find">
      <IconSearch size={13} />
      <input
        ref={inputRef}
        autoFocus
        value={query}
        placeholder="파일 내 검색…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      />
      <span className="cnt">{total ? `${cur + 1}/${total}` : query ? '0개' : ''}</span>
      <button className="has-tip" data-tip="이전 (Shift+Enter)" aria-label="이전 결과" onClick={() => step(-1)} disabled={!total}>
        <IconChevDown size={14} style={{ transform: 'rotate(180deg)' }} />
      </button>
      <button className="has-tip" data-tip="다음 (Enter)" aria-label="다음 결과" onClick={() => step(1)} disabled={!total}>
        <IconChevDown size={14} />
      </button>
      <button className="has-tip" data-tip="닫기 (Esc)" aria-label="검색 닫기" onClick={onClose}>
        <IconClose size={14} />
      </button>
    </div>
  )
}

// an image file's body: the bitmap centered on a checkerboard, scaled to fit the card
// (never upscaled) and then multiplied by the viewer's Ctrl+휠 zoom. The width is
// computed in pixels (natural size × fit × zoom) so centering and overflow scrolling
// stay exact; a corner chip reports the natural size and the effective scale.
function ImageView({ src, alt, zoom }: { src: string; alt: string; zoom: number }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [fit, setFit] = useState(1)
  const [err, setErr] = useState(false)

  // fit-to-pane scale, re-measured when the (resizable) card changes size
  useEffect(() => {
    const el = boxRef.current
    if (!el || !nat) return
    const measure = (): void => {
      const availW = Math.max(50, el.clientWidth - 40)
      const availH = Math.max(50, el.clientHeight - 40)
      setFit(Math.min(1, availW / nat.w, availH / nat.h))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [nat])

  if (err) return <div className="fv-empty">이미지를 표시할 수 없어요</div>
  const scale = fit * zoom
  return (
    <div className="fv-imgview">
      <div className="fv-imgbody scroll" ref={boxRef}>
        <img
          className="fv-imgel"
          src={src}
          alt={alt}
          draggable={false}
          style={nat ? { width: Math.max(1, Math.round(nat.w * scale)) } : { visibility: 'hidden' }}
          onLoad={(e) => {
            const img = e.currentTarget
            // an SVG without intrinsic dimensions reports 0×0 — give it a sane canvas
            setNat({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 })
          }}
          onError={() => setErr(true)}
        />
      </div>
      {nat && (
        <div className="fv-img-meta">
          {nat.w} × {nat.h}
          {Math.round(scale * 100) !== 100 ? ` · ${Math.round(scale * 100)}%` : ''}
        </div>
      )}
    </div>
  )
}

// the file's body: markdown files render as formatted markdown; everything else is
// shown as line-numbered, syntax-highlighted source. When LSP is ready the code gets
// hover type info and Ctrl+클릭 go-to-definition.
function CodeView({
  path,
  content,
  zoom,
  cwd,
  lsp,
  sem,
  structOv,
  jump,
  marks,
  mdSource,
  onNavigate
}: {
  path: string
  content: string
  zoom: number
  cwd: string
  lsp: boolean
  sem: LspSemanticTokens | null
  structOv: StructOv | null // C++ struct 연보라 보정 (FileModal에서 한 번 계산해 내려줌)
  jump: { line: number; tick: number } | null
  marks: DiffMarks | null // changed-file decorations (null = plain viewing)
  mdSource?: boolean // markdown with a diff opens as source so the marks are visible
  onNavigate: (loc: LspLocation) => void
}) {
  const t = fileTypeFor(path)
  const scrollRef = useRef<HTMLDivElement>(null)
  // defMods: C#용 한정자 보강 — OmniSharp 호버 시그니처엔 public/static이 안 실려서
  // 정의 줄을 읽어 따로 채운다 (도착하면 카드의 ACCESS 행이 늦게 나타날 수 있음)
  const [hover, setHover] = useState<{ x: number; y: number; below: boolean; md: string; defMods?: string[] } | null>(
    null
  )
  // Ctrl(정의 모드) 커서 표시는 React 상태가 아니라 DOM 클래스 직접 토글 —
  // Control 키만 눌러도 일어나던 재렌더가 코드 줄의 텍스트 노드를 갈아끼워
  // 선택(더블클릭 단어)을 파괴했고, 그 탓에 Ctrl+C 복사가 항상 빈손이었다.
  const preRef = useRef<HTMLPreElement>(null)
  const setCtrl = useCallback((on: boolean): void => {
    preRef.current?.classList.toggle('lsp-ctrl', on)
  }, [])
  const [flash, setFlash] = useState<number | null>(null) // 1-based line to spotlight
  // 오버뷰 룰러는 "스크롤해야 보이는 변경을 한눈에"가 목적이라 스크롤이 생길 때만 의미가
  // 있다 — 파일이 화면에 다 들어오면 숨긴다. 카드 크기/본문/줌 변화에 다시 잰다.
  const [rulerOverflows, setRulerOverflows] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverSeq = useRef(0)
  // F12(정의로 이동)의 대상 — 마지막 일반 클릭 위치(IDE의 캐럿), 없으면 현재 마우스 위치
  const lastClickPos = useRef<{ line: number; character: number } | null>(null)
  const mousePt = useRef<{ x: number; y: number } | null>(null)
  // 떠 있는 호버 카드 엘리먼트 — 커서가 카드(와 그 길목) 안에 있는지 실측으로 판단
  const hoverCardRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    lastClickPos.current = null
    mousePt.current = null
  }, [path])

  const isMd = t.lang === 'markdown' && !mdSource
  // drop a single trailing newline so the gutter and the rendered code agree on the
  // line count (otherwise the final "\n" adds a phantom unnumbered line)
  const body = isMd ? '' : content.replace(/\n$/, '')

  // semantic tokens grouped per line, mapped to color classes (skipping kinds we
  // leave to hljs) — recomputed only when a new token set arrives. Rider 언어(C#·C++)는
  // modifier까지 보는 전용 매핑, 나머지는 공용 IntelliJ 테이블. C++의 class/property
  // 토큰은 struct 보정(structOv)을 거쳐 연보라로 재분류될 수 있다.
  const semByLine = useMemo(() => {
    if (!sem || !sem.data.length) return null
    const rider = !!paletteClassFor(t.lang)
    const cpp = t.lang === 'cpp' || t.lang === 'c'
    const srcLines = structOv ? body.split('\n') : null
    const m = new Map<number, SemSpan[]>()
    for (let i = 0; i < sem.data.length; i += 5) {
      const type = sem.types[sem.data[i + 3]] ?? ''
      let cls = rider ? riderSemClass(type, sem.data[i + 4], sem.mods, cpp) : SEM_CLASS[type]
      if (!cls) continue
      if (srcLines && (type === 'class' || type === 'property')) {
        const text = (srcLines[sem.data[i]] ?? '').substr(sem.data[i + 1], sem.data[i + 2])
        if (type === 'class' ? structOv!.types.has(text) : structOv!.fields.has(text)) cls = 'sem-type2'
      }
      const line = sem.data[i]
      let arr = m.get(line)
      if (!arr) m.set(line, (arr = []))
      arr.push({ char: sem.data[i + 1], len: sem.data[i + 2], cls })
    }
    return m.size ? m : null
  }, [sem, t.lang, body, structOv])
  // 식별자 텍스트 → 색 클래스 사전 — 호버 카드의 시그니처를 본문과 같은 색으로
  // 칠하는 데 쓴다. 같은 이름이 여러 분류로 나오면 다수결.
  const semDict = useMemo(() => {
    if (!sem || !sem.data.length) return null
    const rider = !!paletteClassFor(t.lang)
    const cpp = t.lang === 'cpp' || t.lang === 'c'
    const srcLines = body.split('\n')
    const counts = new Map<string, Map<string, number>>()
    for (let i = 0; i < sem.data.length; i += 5) {
      const type = sem.types[sem.data[i + 3]] ?? ''
      let cls = rider ? riderSemClass(type, sem.data[i + 4], sem.mods, cpp) : SEM_CLASS[type]
      if (!cls) continue
      const text = (srcLines[sem.data[i]] ?? '').substr(sem.data[i + 1], sem.data[i + 2])
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) continue // 연산자·괄호 토큰 제외
      // struct 보정 — 본문과 호버가 같은 색을 말하게
      if (structOv && (type === 'class' || type === 'property')) {
        if (type === 'class' ? structOv.types.has(text) : structOv.fields.has(text)) cls = 'sem-type2'
      }
      let byCls = counts.get(text)
      if (!byCls) counts.set(text, (byCls = new Map()))
      byCls.set(cls, (byCls.get(cls) ?? 0) + 1)
    }
    const dict = new Map<string, string>()
    for (const [text, byCls] of counts) {
      let best = ''
      let bn = 0
      for (const [cls, n] of byCls)
        if (n > bn) {
          bn = n
          best = cls
        }
      dict.set(text, best)
      sessionSemDict.set(text, best) // 다른 파일의 호버에서도 이 이름을 칠할 수 있게 누적
    }
    return dict.size ? dict : null
  }, [sem, t.lang, body, structOv])
  const lines = useMemo(() => {
    if (isMd || body.length > HL_LIMIT) return null
    const base = highlightToLines(body, t.lang)
    if (!semByLine) return base
    return base.map((h, i) => {
      const spans = semByLine.get(i)
      return spans ? decorateLine(h, spans) : h
    })
  }, [isMd, body, t.lang, semByLine])

  const clearHover = useCallback((): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    hoverSeq.current++
    setHover(null)
  }, [])

  // Ctrl/⌘ turns the pointer into "definition mode" — tracked globally so pressing
  // the key without moving the mouse still updates the cursor
  useEffect(() => {
    if (!lsp) return
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Control' || e.key === 'Meta') {
        setCtrl(true)
        clearHover() // 정의 모드 진입 — 떠 있던/예약된 호버 카드 정리
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Control' || e.key === 'Meta') setCtrl(false)
    }
    const blur = (): void => setCtrl(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      setCtrl(false)
    }
  }, [lsp, clearHover, setCtrl])

  const goToDefinition = useCallback(
    (pos: { line: number; character: number }): void => {
      clearHover()
      window.api.lsp
        .definition(cwd, path, pos)
        .then((locs) => {
          if (locs?.[0]) onNavigate(locs[0])
        })
        .catch(() => {})
    },
    [cwd, path, clearHover, onNavigate]
  )

  // F12 = 정의로 이동 (IDE 관례) — 직전에 클릭한 심볼, 클릭이 없었으면 마우스가
  // 가리키는 심볼로 점프한다. 입력창에 포커스가 있을 땐 끼어들지 않는다.
  useEffect(() => {
    if (!lsp) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F12' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const pos = lastClickPos.current ?? (mousePt.current ? posAtPoint(mousePt.current.x, mousePt.current.y) : null)
      if (!pos) return
      e.preventDefault()
      goToDefinition(pos)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lsp, goToDefinition])

  // a definition jump landed in this document — scroll the line into view + flash it.
  // 긴 줄이면 scrollIntoView가 가로를 오른쪽 끝까지 끌고 가서 불편하다 — 세로만
  // 가운데로 맞추고 가로는 항상 줄 시작(왼쪽)으로 되돌린다
  useEffect(() => {
    if (!jump || !lines) return
    const el = scrollRef.current?.querySelector(`[data-ln="${jump.line}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', inline: 'nearest' })
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
    setFlash(jump.line)
    const timer = setTimeout(() => setFlash(null), 1500)
    return () => clearTimeout(timer)
  }, [jump, lines])

  // 스크롤 가능 여부를 재서 오버뷰 룰러 표시를 토글한다. 카드 크기 변화(최대화/복원·창
  // 리사이즈)는 ResizeObserver로, 본문·줌 변화는 deps 재실행으로 다시 잰다.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setRulerOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [lines, body, zoom])

  const onMove = (e: React.MouseEvent): void => {
    mousePt.current = { x: e.clientX, y: e.clientY }
    setCtrl(e.ctrlKey || e.metaKey)
    // Ctrl/⌘(정의 모드)에서는 호버 카드를 띄우지 않는다 — 점프하려는 참에 카드가
    // 시야와 클릭 대상을 가리지 않게
    if (e.ctrlKey || e.metaKey) {
      clearHover()
      return
    }
    // 텍스트 선택 중/선택돼 있는 동안엔 호버를 띄우지 않는다 — 더블클릭 단어 선택,
    // 드래그 선택과 카드·선택 툴바가 겹치며 싸우던 문제(IDE들도 같은 규칙)
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) {
      clearHover()
      return
    }
    // 떠 있는 카드는 커서가 앵커 지점에서 벗어나는 즉시 치운다 — 다음 LSP 응답이
    // 올 때까지(디바운스+왕복) 낡은 카드가 끈적하게 남아 따라다니던 느낌 제거.
    // 단, 카드 쪽으로 가는 중이면 살려둔다(복사하러 들어가는 길) — 카드 실측 영역
    // + 여유 28px 안에 커서가 있으면 닫지 않는다.
    setHover((h) => {
      if (!h) return h
      const card = hoverCardRef.current
      if (card) {
        const r = card.getBoundingClientRect()
        const m = 28
        if (e.clientX >= r.left - m && e.clientX <= r.right + m && e.clientY >= r.top - m && e.clientY <= r.bottom + m)
          return h
      }
      const dx = e.clientX - h.x
      const dy = e.clientY - h.y
      return dx * dx + dy * dy > 26 * 26 ? null : h
    })
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    const seq = ++hoverSeq.current
    hoverTimer.current = setTimeout(() => {
      // 디바운스 사이에 선택이 생겼으면(더블클릭 등) 카드를 띄우지 않는다
      const s2 = window.getSelection()
      if (s2 && !s2.isCollapsed) return
      const pos = posAt(e)
      if (!pos) {
        if (seq === hoverSeq.current) setHover(null)
        return
      }
      window.api.lsp
        .hover(cwd, path, pos)
        .then((r) => {
          if (seq !== hoverSeq.current) return // stale — the mouse moved on
          if (!r || !r.contents) return setHover(null)
          const s3 = window.getSelection()
          if (s3 && !s3.isCollapsed) return // 응답 오는 사이 선택됨 — 양보
          setHover({ x: e.clientX, y: e.clientY, below: e.clientY < window.innerHeight * 0.55, md: r.contents })
          // C#: 시그니처에 접근지시자가 없다 — 정의 선언 줄을 읽어 ACCESS를 보강.
          // (메타데이터 전용 심볼은 파일이 안 읽혀 조용히 생략된다)
          if (t.lang === 'csharp') {
            void window.api.lsp
              .definition(cwd, path, pos)
              .then(async (locs) => {
                const loc = locs?.[0]
                if (!loc || seq !== hoverSeq.current) return
                const f = await window.api.readFile(cwd, loc.path).catch(() => null)
                const line = f?.content?.split('\n')[loc.line]
                if (!line) return
                const m =
                  /^\s*((?:(?:public|private|protected|internal|static|readonly|virtual|override|sealed|abstract|async|partial|extern|unsafe|required|new|const|event)\s+)+)/.exec(
                    line
                  )
                if (!m) return
                const mods = [...new Set(m[1].trim().split(/\s+/))]
                if (seq === hoverSeq.current) setHover((h) => (h ? { ...h, defMods: mods } : h))
              })
              .catch(() => {})
          }
        })
        .catch(() => {})
    }, HOVER_DELAY)
  }

  // 코드 영역을 떠날 때 — 호버 카드는 body 포털(별개 요소)이라 카드로 건너가는
  // 것도 mouseleave다. 카드(또는 그 길목)로 들어가는 중이면 치우지 않는다.
  const onLeavePre = (e: React.MouseEvent): void => {
    const card = hoverCardRef.current
    if (card) {
      const rt = e.relatedTarget
      if (rt instanceof Node && card.contains(rt)) return
      const r = card.getBoundingClientRect()
      const m = 28
      if (e.clientX >= r.left - m && e.clientX <= r.right + m && e.clientY >= r.top - m && e.clientY <= r.bottom + m)
        return
    }
    clearHover()
  }

  const onClick = (e: React.MouseEvent): void => {
    if (!(e.ctrlKey || e.metaKey)) {
      // 일반 클릭 = F12의 대상 지정 (IDE의 캐럿 역할) — 빈 곳 클릭은 대상 해제
      lastClickPos.current = posAt(e)
      return
    }
    const pos = posAt(e)
    if (!pos) return
    e.preventDefault()
    goToDefinition(pos)
  }

  // decorations apply only while the diff's new side still matches the file on disk
  // (per-line views only — the un-numbered plain block for huge files can't be marked);
  // a file changed outside the agent after the diff was taken simply shows unmarked.
  const lineCount = isMd ? 0 : body.split('\n').length
  const deco = !isMd && lines != null && marks && marks.newCount === lineCount ? marks : null

  // a changed file opens at its first change — the edit may sit deep in a long file,
  // and nothing else hints where it is. Once per opened file (not again when semantic
  // tokens re-render the lines).
  const hasDeco = deco != null
  useEffect(() => {
    if (!hasDeco || !deco) return
    let first = Infinity
    deco.added.forEach((n) => (first = Math.min(first, n)))
    deco.delAfter.forEach((b) => (first = Math.min(first, Math.max(1, Math.min(b + 1, lineCount)))))
    if (!Number.isFinite(first)) return
    scrollRef.current?.querySelector(`[data-ln="${first}"]`)?.scrollIntoView({ block: 'center' })
    if (scrollRef.current) scrollRef.current.scrollLeft = 0 // 긴 줄이 가로를 끌고 가지 않게
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, hasDeco])

  if (isMd) {
    return (
      <div className="fv-md scroll">
        <div className="content" style={{ zoom }}>
          <Markdown text={content} />
        </div>
      </div>
    )
  }

  const decoCls = (i: number): string => (deco?.added.has(i + 1) ? ' dadd' : '')
  const jumpToLine = (n: number): void => {
    // scrollIntoView(smooth)는 긴 줄에서 가로까지 끌고 간다 — 세로만 직접 계산해
    // 부드럽게 이동하고 가로는 줄 시작(왼쪽)으로 고정
    const sc = scrollRef.current
    const el = sc?.querySelector(`[data-ln="${Math.max(1, Math.min(n, lineCount))}"]`)
    if (!sc || !el) return
    const top =
      sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight / 2
    sc.scrollTo({ top, left: 0, behavior: 'smooth' })
  }

  // 거터와 본문을 같은 순서로 함께 쌓는다 — 삭제된 코드는 그 경계 자리에 "고스트
  // 줄"(빨간 틴트 + 옛 줄 번호)로 끼워 넣어 지워진 내용도 보인다. data-ln이 없는
  // 표시 전용 행이라 LSP 호버·정의 이동·검색·줄 범위 선택 어디에도 잡히지 않고,
  // 실제 줄 번호 매김도 흔들리지 않는다.
  const gutterCells: React.ReactNode[] = []
  const codeRows: React.ReactNode[] | null = lines != null ? [] : null
  if (codeRows) {
    const pushGhosts = (b: number): void => {
      const gs = deco?.ghosts.get(b)
      if (!gs) return
      for (const g of gs) {
        gutterCells.push(
          <span key={`g${b}:${g.n}`} className="gdel">
            {g.n}
          </span>
        )
        codeRows.push(
          t.lang ? (
            <div
              key={`g${b}:${g.n}`}
              className="fvl gdel"
              dangerouslySetInnerHTML={{ __html: highlightCode(g.text || ' ', t.lang) }}
            />
          ) : (
            <div key={`g${b}:${g.n}`} className="fvl gdel">
              {g.text || ' '}
            </div>
          )
        )
      }
    }
    pushGhosts(0)
    lines!.forEach((h, i) => {
      gutterCells.push(
        <span key={i} className={decoCls(i).trim() || undefined}>
          {i + 1}
        </span>
      )
      codeRows.push(
        <div
          key={i}
          className={'fvl' + (flash === i + 1 ? ' flash' : '') + decoCls(i)}
          data-ln={i + 1}
          dangerouslySetInnerHTML={{ __html: h }}
        />
      )
      pushGhosts(i + 1)
    })
    // 변경된 파일: 마지막 줄이 추가면 그 초록 틴트를 카드 아래 빈 높이까지 잇는 채움 행을
    // 둔다 — 짧은 파일에서 풀폭 틴트가 뚝 끊겨 '검은 밑줄'처럼 보이던 경계를 없앤다.
    // 표시 전용(data-ln 없음)이라 호버·검색·정의 이동엔 잡히지 않는다.
    if (deco) {
      const tailCls = decoCls(lines!.length - 1) // 마지막 줄이 추가면 ' dadd', 아니면 ''
      gutterCells.push(<span key="fill" className={'fv-fill' + tailCls} aria-hidden="true" />)
      codeRows.push(<div key="fill" className={'fvl fv-fill' + tailCls} aria-hidden="true" />)
    }
  } else {
    for (let i = 0; i < lineCount; i++)
      gutterCells.push(<span key={i}>{i + 1}</span>)
  }

  return (
    <div className="fv-wrap">
      <div className={'fv-code scroll' + paletteClassFor(t.lang)} ref={scrollRef} onScroll={lsp ? clearHover : undefined}>
        <div className="fv-inner" style={{ zoom }}>
          <div className="fv-gutter" aria-hidden="true">
            {gutterCells}
          </div>
          <pre
            ref={preRef}
            className={'fv-pre hljs' + (deco ? ' has-fill' : '')}
            onMouseMove={lsp ? onMove : undefined}
            onMouseLeave={lsp ? onLeavePre : undefined}
            // 코드에 마우스를 누르는 순간 카드를 치운다 — 더블클릭/드래그 선택이
            // 떠 있는 카드와 겹쳐 엉키지 않게 (카드 안에서의 클릭·복사는 그대로)
            onMouseDown={lsp ? clearHover : undefined}
            onClick={lsp ? onClick : undefined}
          >
            {codeRows ?? <code className="hljs">{body}</code>}
          </pre>
        </div>
      </div>
      {/* overview ruler — one clickable mark per changed block, mapped onto the file's
          full height, so edits deep in a long file are visible without scrolling */}
      {deco && deco.blocks.length > 0 && rulerOverflows && (
        <div className="diff-ruler">
          {deco.blocks.map((b, i) => (
            <button
              key={i}
              className={'mark ' + b.type}
              style={{
                top: `${((Math.min(b.start, deco.newCount) - 1) / deco.newCount) * 100}%`,
                height: `${((b.end - b.start + 1) / deco.newCount) * 100}%`
              }}
              onClick={() => jumpToLine(b.start)}
              aria-label={`${b.start}번째 줄 변경으로 이동`}
            />
          ))}
        </div>
      )}
      {hover &&
        // 포털로 body에 띄운다 — 오버레이(backdrop-filter)/모달 안에서는 fixed 좌표의
        // 기준이 뷰포트가 아니게 되어 카드가 커서에서 어긋난 곳에 떴다 (sel-bar와 동일 원인)
        createPortal(
          <div
            ref={hoverCardRef}
            // 팔레트 클래스를 같이 — body 포털이라 뷰어 컨테이너의 언어 팔레트가 닿지
            // 않으면 칩·시그니처가 기본(IntelliJ) 색으로 떨어진다
            className={'lsp-hover' + paletteClassFor(t.lang)}
            style={{
              // 카드 최대 폭(920px 또는 화면-48px) + 여백이 화면 오른쪽에 들어가게 당긴다
              left: Math.max(
                8,
                Math.min(hover.x + 14, window.innerWidth - Math.min(920, window.innerWidth - 48) - 16)
              ),
              ...(hover.below ? { top: hover.y + 18 } : { bottom: window.innerHeight - hover.y + 14 })
            }}
            // 카드 안으로 들어오면 유지 — 시그니처/문서를 긁어 복사할 수 있다.
            // 진입 시 대기 중인 호버 갱신을 취소해 읽는 도중 카드가 바뀌지 않게 한다.
            onMouseEnter={() => {
              if (hoverTimer.current) clearTimeout(hoverTimer.current)
              hoverTimer.current = null
              hoverSeq.current++
            }}
            onMouseLeave={clearHover}
          >
            <HoverContent md={hover.md} lang={t.lang} dict={semDict} extraMods={hover.defMods} />
          </div>,
          document.body
        )}
    </div>
  )
}

// a Ctrl+클릭 definition jump that left the originally opened file; 뒤로 unwinds these
interface NavEntry {
  path: string
}
interface ViewState {
  root: string | null // the path prop this state belongs to
  stack: NavEntry[] // 뒤로 트레일(정의 점프로 떠나온 파일들)
  fwd: NavEntry[] // 앞으로 트레일(뒤로 가며 빠져나온 파일들 — 새 점프 시 비워진다)
  jump: { line: number; tick: number } | null
}

// Card-style confirm for closing the viewer with unsaved CM edits — replaces the native
// window.confirm (which both broke the card language and, by blocking the thread, left the
// editor's IME/contentEditable wedged so typing died after a cancel). Esc/Enter both pick
// the safe default (계속 편집): nothing is lost by mistake, and a real discard needs a click.
function CloseConfirmDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  useEffect(() => {
    // capture + stopPropagation so the viewer's own window Esc handler stands down — this
    // card owns Esc while it's open. Enter falls through to the autofocused 취소 button.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onStay()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onStay, onLeave])

  return (
    <div className="set-dialog-overlay" onMouseDown={onStay}>
      <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sd-ic">
          <IconPencil size={22} />
        </div>
        <div className="sd-title">저장하지 않고 닫을까요?</div>
        <div className="sd-msg">
          아직 <b>저장하지 않은 변경</b>이 있어요. 그대로 닫으면 이 변경 내용은 사라집니다.
        </div>
        <div className="sd-btns">
          <button className="sd-cancel" onClick={onStay} autoFocus>
            계속 편집
          </button>
          <button className="sd-go danger" onClick={onLeave}>
            저장 안 함
          </button>
        </div>
      </div>
    </div>
  )
}

// A read-only file preview shown as a centered card (same overlay/card language as
// the diff & settings dialogs) instead of handing the file to the OS. Loads the
// content over IPC on open; renders it with syntax highlighting / markdown. Code
// files get LSP-powered hover + go-to-definition once the project's language server
// is warm (TS/JS for now).
export function FileModal({
  path,
  cwd,
  diffs,
  override,
  onClose,
  onAskSelection,
  onViewFile
}: {
  path: string | null
  cwd: string
  // 이 실행에서 에이전트가 바꾼 파일들의 누적 diff — 보고 있는 파일의 것이 있으면
  // 코드 위에 변경 마킹(추가 줄 틴트·삭제 헤어라인·오버뷰 룰러)을 얹는다
  diffs?: Record<string, FileDiff>
  // Git 카드에서 연 파일 — content가 있으면 그 시점(커밋) 내용을 그대로 보여주고
  // (디스크와 다를 수 있으니 LSP는 끔), 없으면 평소처럼 디스크에서 읽는다(LSP 유지).
  // diff는 세션 diffs 대신 마킹에 쓰는 일회성 diff, label은 헤더의 커밋 해시 칩.
  override?: { content: string | null; diff: FileDiff | null; label: string | null } | null
  onClose: () => void
  // 드래그 선택 → 뷰어 안 질문 패널에서 작성한 질문을 선택 텍스트·파일·줄 범위와 함께 전송
  onAskSelection?: (p: { path: string; text: string; from: number | null; to: number | null; question: string }) => void
  // Ctrl+클릭 정의 이동으로 다른 파일에 들어갔을 때 — 최근 파일 탭에 기록용
  onViewFile?: (relPath: string) => void
}) {
  const [res, setRes] = useState<FileReadResult | null>(null)
  // lspStatus는 색칠·hover·정의이동 게이트 + 파일별 "심볼 분석 중" 칩 판정에 쓴다.
  // (설치는 설정에서 — 코드창엔 분석 중 칩만 두고 ready/error/설치 칩은 안 둔다)
  const [lspStatus, setLspStatus] = useState<LspStatus>('unsupported')
  const [sem, setSem] = useState<LspSemanticTokens | null>(null)
  const [noSem, setNoSem] = useState(false) // 서버가 이 파일엔 시맨틱 토큰이 없다고 알림 → 분석칩 끔
  const [anPct, setAnPct] = useState<number | null>(null) // 분석 진행률(프로젝트 인덱싱 %)
  const [vs, setVs] = useState<ViewState>({ root: path, stack: [], fwd: [], jump: null })
  // an SVG can be viewed both ways — as the rendered image (default) or as markup
  const [svgCode, setSvgCode] = useState(false)
  // a changed markdown file opens as marked-up source (so the diff is visible);
  // this flips it to the rendered document
  const [mdPreview, setMdPreview] = useState(false)
  // 편집 가능한 코드 파일은 CodeMirror 편집기로 연다(아래 cmEligible). 마크다운·이미지·
  // git 스냅샷·잘린 파일은 읽기 전용 CodeView 유지.
  const [cmDirty, setCmDirty] = useState(false) // CM 버퍼에 미저장 변경이 있는가
  const [cmSaved, setCmSaved] = useState(false) // 방금 저장됨 — 잠깐 '저장됨' 표시
  const [cmMode, setCmMode] = useState<'read' | 'edit'>('read') // 변경 파일은 읽기(diff)로 열고 '편집' 눌러 수정
  // 읽기 모드의 변경 tint(초록/빨강) 표시 — Ctrl+D로 일반 보기와 토글. 선택한 보기는
  // 파일·네비게이션을 넘어 전역으로 유지하고 디스크에도 남긴다(prefs).
  const [diffView, setDiffViewState] = useState(() => getPref('viewer.diffView', true))
  const setDiffView = useCallback((next: boolean | ((v: boolean) => boolean)): void => {
    setDiffViewState((v) => {
      const nv = typeof next === 'function' ? next(v) : next
      if (nv !== v) setPref('viewer.diffView', nv)
      return nv
    })
  }, [])
  const cmRef = useRef<CmEditorHandle>(null)
  // 정의 이동 시 떠나는 파일의 캐럿 위치를 기억 → 뒤로가기로 돌아오면 그 자리로 복원 (CM)
  const posMap = useRef(new Map<string, number>())
  // 파일 내 검색(Ctrl+F) 열림 + 선택-질문 패널 (선택 텍스트·줄 범위와 질문 입력)
  const [findOpen, setFindOpen] = useState(false)
  const [ask, setAsk] = useState<{ text: string; from: number | null; to: number | null } | null>(null)
  const [askText, setAskText] = useState('')
  const askInputRef = useRef<HTMLTextAreaElement>(null)
  // a freshly opened file discards any definition-jump trail from the previous one
  // (render-time state sync — avoids one frame of the stale document)
  if (vs.root !== path) {
    setVs({ root: path, stack: [], fwd: [], jump: null })
    if (svgCode) setSvgCode(false)
    if (mdPreview) setMdPreview(false)
    if (findOpen) setFindOpen(false)
    if (ask) setAsk(null)
    if (askText) setAskText('')
    if (cmDirty) setCmDirty(false)
    if (cmSaved) setCmSaved(false)
    // 네비게이션 세션 종료(닫기/다른 파일 열기) — 저장된 캐럿 위치를 비운다. 안 그러면
    // 재오픈 때 복원 effect가 다시 돌며 이전 위치를 또 깜빡인다. (세션 내 뒤로가기는
    // path가 안 바뀌어 여기 안 걸리므로 그대로 복원·깜빡임 유지)
    posMap.current.clear()
  }
  const effPath = vs.stack.length ? vs.stack[vs.stack.length - 1].path : path
  const isSvg = !!effPath && /\.svg$/i.test(effPath)
  const isImg = !!effPath && isImagePath(effPath) && !(isSvg && svgCode)
  // 정의 이동으로 다른 파일에 들어가면 override는 원래 파일의 것 — 적용하지 않는다
  const ov = vs.stack.length === 0 ? override ?? null : null
  const ovContent = ov?.content ?? null
  // the viewed file's accumulated diff (keys are slash-relative paths; the definition-
  // jump stack stores backslash ones) — drives the change marks and the header stats.
  // Git 카드에서 온 일회성 diff(ov.diff)가 있으면 세션 diff 대신 그걸 쓴다.
  const diff = ov ? ov.diff : (effPath && diffs?.[effPath.replace(/\\/g, '/')]) || null
  const marks = useMemo(() => (diff ? diffMarksOf(diff) : null), [diff])
  // 파일이 바뀔 때마다 항상 읽기 모드로 연다(파일 종류 무관 일관). 편집은 Ctrl+E로.
  // diff/일반 보기(diffView)는 여기서 리셋하지 않는다 — 사용자가 Ctrl+D로 고른 보기를
  // 파일·네비게이션을 넘어 전역으로 유지한다.
  useEffect(() => {
    setCmMode('read')
  }, [effPath])
  const isMdFile = !!effPath && fileTypeFor(effPath).lang === 'markdown'
  // CM PoC applies to non-markdown code files only (markdown keeps its render/source
  // toggle for now). Computed here so the header toggle and the body swap agree.
  const fLang = effPath ? fileTypeFor(effPath).lang : ''
  // CM editing writes to the live file, so it's used only for real, fully-loaded on-disk
  // files — not git-snapshot overrides (would overwrite the working copy with old content)
  // and not truncated previews (saving would drop everything past the read cap).
  const cmEligible = !isImg && !isMdFile && res != null && res.content != null && !res.truncated && !ov
  // C++ struct 연보라 보정 — 엔진(뷰어/CM) 무관하게 한 번 계산해 양쪽에 내려준다
  const structOv = useCppStructOv(sem, fLang, res?.content ?? '', cwd, effPath ?? '')
  // diff(변경 tint) 보기 토글 — 읽기 모드의 초록/빨강 diff를 Ctrl+D로 켜고 끈다(편집과 분리).
  // 마크다운은 자체 '미리보기/변경사항' 토글이 있으니 제외. 끄면 marks를 안 내려보내 diff·
  // 오버뷰 룰러가 모두 사라지고 평범한(잠긴) 뷰가 된다.
  const canToggleDiff = !!marks && !isMdFile
  // diff가 실제로 그려지는 맥락에서만 버튼·단축키가 의미 있다: 비-CM 읽기 뷰어이거나, CM 코드
  // 파일을 읽기 모드로 보는 중일 때(편집 모드는 어차피 diff를 끄므로 토글이 무의미).
  const diffVisibleCtx = canToggleDiff && (!cmEligible || cmMode === 'read')
  const effMarks = canToggleDiff && !diffView ? null : marks

  const rz = useResizableModal('viewer.size', path != null, { defaultMaximized: true })
  const z = useZoom('viewer.zoom', path != null)
  // 선택 툴바가 "본문 안의 선택"을 판별하려면 카드 엘리먼트가 필요 — 상태 콜백 ref로 추적
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const modalRef = useMemo(() => mergeRefs(rz.ref, z.ref, setCardEl), [rz.ref, z.ref])
  // a backdrop click closes the card — but only when the *press* also started on the
  // backdrop. Without this, selecting text inside the card and dragging out past its
  // edge fires a `click` on the overlay (the common ancestor of down/up) and closes it.
  const downOnOverlay = useRef(false)

  // closing with unsaved CM edits asks first (Esc / backdrop / X / mouse-back all route
  // through here). cmDirtyRef mirrors state so the keydown/mouse closures see it live.
  const cmDirtyRef = useRef(false)
  cmDirtyRef.current = cmDirty
  // 미저장 변경이 있으면 곧장 닫지 않고 카드형 확인을 띄운다(네이티브 confirm 대신). 확인이
  // 떠 있는 동안엔 뷰어의 Esc/단축키가 물러나고(아래 closeConfirmRef 가드), 취소하면 편집기로
  // 포커스를 돌려준다 — confirm이 스레드를 막아 IME가 엉키던 "취소 후 입력 불가"도 함께 해소.
  const [closeConfirm, setCloseConfirm] = useState(false)
  const closeConfirmRef = useRef(false)
  closeConfirmRef.current = closeConfirm
  const requestClose = useCallback((): void => {
    if (cmDirtyRef.current) {
      setCloseConfirm(true)
      return
    }
    onClose()
  }, [onClose])
  // 파일이 바뀌면(다른 파일 열기/뒤로) 떠 있던 확인 카드는 의미가 없어지므로 닫는다
  useEffect(() => {
    setCloseConfirm(false)
  }, [effPath])

  // Ctrl+W — main이 앱 종료를 막고 보내는 신호. 코드 뷰어가 열려 있으면 닫는다 (Esc와 동일)
  useEffect(() => {
    if (!path) return
    return window.api.onCloseShortcut(requestClose)
  }, [path, requestClose])

  // (re)load whenever the viewed path changes; `alive` guards against a stale
  // response landing after the user already switched files or closed the card.
  // Images skip the text read entirely — their bytes are served over ccg-img://.
  useEffect(() => {
    setRes(null)
    if (!effPath || isImg) return
    // Git 카드가 건넨 커밋 시점 내용 — 디스크를 읽지 않고 그대로 보여준다
    if (ovContent != null) {
      setRes({ path: effPath, content: ovContent, truncated: false })
      return
    }
    let alive = true
    window.api
      .readFile(cwd, effPath)
      .then((r) => alive && setRes(r))
      .catch(() => alive && setRes({ path: effPath, content: null, truncated: false, error: '파일을 열 수 없어요' }))
    return () => {
      alive = false
    }
  }, [effPath, cwd, isImg, ovContent])

  // code-intelligence status for the viewed file — drives only the feature gate
  // (lsp={ready} below). The first ask lazily spawns the project's server, so poll
  // while it warms up ('starting'/'installing'). 상태 칩은 코드창에 없다(폴더 배지로 이동).
  useEffect(() => {
    setLspStatus('unsupported')
    // 커밋 시점 내용은 디스크와 다를 수 있다 — LSP 좌표가 거짓이 되므로 끈다
    if (!effPath || isImg || ovContent != null) return
    let alive = true
    let tries = 0
    const tick = (): void => {
      window.api.lsp
        .status(cwd, effPath)
        .then((st) => {
          if (!alive) return
          setLspStatus(st)
          // 촘촘히 폴링(400ms)해서 ready 감지 지연을 줄인다 — 그래야 ready 직후 색이
          // 폴더 배지가 사라지기 전에/같이 들어온다. 워밍은 길 수 있어 창을 넓게(≈8분).
          if ((st === 'starting' || st === 'installing') && tries++ < 1200) setTimeout(tick, 400)
        })
        .catch(() => alive && setLspStatus('error'))
    }
    tick()
    return () => {
      alive = false
    }
  }, [effPath, cwd, isImg, ovContent])

  // instant paint: on open, ask the disk cache for this file's last-known tokens
  // (keyed by content hash — no server spawn) and paint immediately. The live
  // fetch below upgrades them once the server answers. This is what makes a
  // relaunch feel instant instead of waiting out the server warm-up every time.
  // 커밋 시점 내용(ovContent)은 디스크와 달라 LSP 좌표가 거짓이 되므로 캐시도 끈다.
  useEffect(() => {
    setSem(null)
    setNoSem(false)
    if (!effPath || isImg || ovContent != null || res?.content == null) return
    let alive = true
    window.api.lsp
      .cachedTokens(cwd, effPath)
      .then((t) => {
        // 캐시는 라이브 토큰이 아직 없을 때만 채운다(prev ?? t). 서버가 prewarm으로 빨리
        // ready돼 라이브(완성본)가 먼저 도착했는데, 늦게 끝난 캐시(옛/부분일 수 있음)가
        // 그걸 덮어써 "완료인데 색이 부분만" 되던 레이스를 막는다. 라이브는 항상 우선.
        if (alive && t && t.data.length) setSem((prev) => prev ?? t)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [effPath, cwd, res, isImg, ovContent])

  // semantic highlighting: ask once the server is ready. Right after the server
  // turns ready it may still be settling (OmniSharp keeps associating documents
  // for a while after the solution loads) and answer with nothing — keep retrying
  // for a generous window. Re-asks when the viewed file (or its content) changes.
  // Doesn't reset sem — the cache paint above stays visible until live arrives.
  useEffect(() => {
    if (!effPath || lspStatus !== 'ready' || res?.content == null) return
    let alive = true
    let tries = 0
    const fetchTokens = (): void => {
      window.api.lsp
        .semanticTokens(cwd, effPath)
        .then((t) => {
          if (!alive) return
          if (t && t.data.length) setSem(t)
          else if (t && tries++ < 75) setTimeout(fetchTokens, 800)
          else if (t === null) setNoSem(true) // 이 서버는 시맨틱 토큰 없음 → 분석칩 끔, hljs만
        })
        .catch(() => {})
    }
    fetchTokens()
    return () => {
      alive = false
    }
  }, [effPath, cwd, lspStatus, res])

  // 파일별 "심볼 분석 중" 판정 — 색 토큰을 기다리는 동안만 true(서버 워밍 또는 토큰 페치 중).
  // 캐시/라이브 색이 들어오면(sem) · 시맨틱 토큰 없는 서버면(noSem) · 미지원/에러면 사라진다.
  const isCodeView = !!effPath && !isImg && ovContent == null && res?.content != null
  const analyzing =
    isCodeView && sem == null && !noSem && (lspStatus === 'starting' || lspStatus === 'installing' || lspStatus === 'ready')
  // 분석 중에만 프로젝트 인덱싱 %를 가볍게 폴링해 칩에 보여준다(없으면 % 없이 '심볼 분석 중')
  useEffect(() => {
    if (!analyzing || !cwd) {
      setAnPct(null)
      return
    }
    let alive = true
    const tick = (): void => {
      window.api.lsp
        .projectStatus(cwd)
        .then((s) => alive && setAnPct(s.state === 'analyzing' ? s.percent : null))
        .catch(() => {})
    }
    tick()
    const iv = setInterval(tick, 800)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [analyzing, cwd])

  // Esc는 안쪽 레이어부터 차례로 접는다: 선택 툴바 → 질문 패널 → 파일 내 검색 → 카드
  const askOpenRef = useRef(false)
  askOpenRef.current = ask != null
  const findOpenRef = useRef(false)
  findOpenRef.current = findOpen
  useEffect(() => {
    if (!path) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (closeConfirmRef.current) return // 닫기 확인 카드가 떠 있으면 그 카드가 Esc를 가진다
      if (document.querySelector('.sel-bar')) return // 선택 툴바가 먼저 접힌다
      if (document.querySelector('.cm-host .cm-find')) return // CM 검색 바가 열려 있으면 그게 먼저 닫힌다
      if (askOpenRef.current) {
        setAsk(null)
        return
      }
      if (findOpenRef.current) {
        setFindOpen(false)
        return
      }
      requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [path, requestClose])

  // Ctrl/⌘+F → 파일 내 검색 (카드가 열려 있는 동안은 탐색기 검색보다 우선).
  // CM 편집기가 켜진 코드 파일에선 CM 자체 검색(가상화 대응)에 양보한다.
  useEffect(() => {
    if (!path) return
    const onKey = (e: KeyboardEvent): void => {
      if (!((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f')) return
      if (closeConfirmRef.current) return // 확인 카드가 떠 있으면 단축키는 물러난다
      e.preventDefault()
      // CM 편집기 코드 파일은 CM 검색 패널(가상화 대응)을, 그 외엔 기존 FindBar를 연다
      if (cmEligible) cmRef.current?.openSearch()
      else setFindOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [path, cmEligible])

  // Ctrl/⌘+E → 읽기 ↔ 편집 모드 토글. 편집 가능한 코드 파일이면 어디서나(토글 버튼과 동일 조건).
  // capture로 잡아 CM 키맵보다 먼저 처리하고, 편집 모드 진입 시 포커스는 CmEditor가 잡는다.
  useEffect(() => {
    if (!path || !cmEligible) return
    const onKey = (e: KeyboardEvent): void => {
      if (!((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'e')) return
      if (closeConfirmRef.current) return // 확인 카드가 떠 있으면 모드 토글을 막는다
      e.preventDefault()
      e.stopPropagation()
      setCmMode((m) => (m === 'read' ? 'edit' : 'read'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [path, cmEligible])

  // Ctrl/⌘+D → diff(변경 tint) 보기 ↔ 일반(무색) 보기 토글. diff가 그려지는 맥락에서만 동작.
  // capture로 CM 키맵보다 먼저 잡고, IME가 켜져 있어도 잡히게 물리 키(e.code)도 함께 본다.
  useEffect(() => {
    if (!path || !diffVisibleCtx) return
    const onKey = (e: KeyboardEvent): void => {
      if (!((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyD' || e.key.toLowerCase() === 'd')))
        return
      if (closeConfirmRef.current) return // 확인 카드가 떠 있으면 보기 토글을 막는다
      e.preventDefault()
      e.stopPropagation()
      setDiffView((v) => !v)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [path, diffVisibleCtx])

  // 질문 패널이 열리면 바로 입력에 포커스
  useEffect(() => {
    if (ask) askInputRef.current?.focus()
  }, [ask])

  // 정의 점프 트레일을 떠나기 전에 현재 파일 캐럿을 기억 — 뒤로/앞으로 돌아오면 그 자리로 복원
  const effPathRef = useRef(effPath)
  effPathRef.current = effPath
  const rememberCaret = useCallback((): void => {
    const leaving = cmRef.current?.getCaret()
    if (leaving != null && effPathRef.current) posMap.current.set(canonPath(effPathRef.current, cwd), leaving)
  }, [cwd])
  // 뒤로 = 스택 한 단계 빼서 앞으로(fwd) 스택에 쌓기 / 앞으로 = 그 반대. 둘 다 캐럿 복원용으로 저장.
  const goBack = useCallback((): void => {
    rememberCaret()
    setVs((v) => (v.stack.length ? { ...v, stack: v.stack.slice(0, -1), fwd: [...v.fwd, v.stack[v.stack.length - 1]], jump: null } : v))
  }, [rememberCaret])
  const goForward = useCallback((): void => {
    rememberCaret()
    setVs((v) => (v.fwd.length ? { ...v, stack: [...v.stack, v.fwd[v.fwd.length - 1]], fwd: v.fwd.slice(0, -1), jump: null } : v))
  }, [rememberCaret])

  // 마우스 옆 버튼: 뒤로(X1=button 3) / 앞으로(X2=button 4) — 브라우저·IDE 관례. 더 갈 곳이
  // 없으면 아무것도 안 한다(실수로 코드창 닫히는 게 싫다는 피드백 — 닫기는 Esc·X·Ctrl+W로만).
  useEffect(() => {
    if (!path) return
    const onUp = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault()
        goBack()
      } else if (e.button === 4) {
        e.preventDefault()
        goForward()
      }
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [path, goBack, goForward])

  // Ctrl+클릭 definition target: same document → just jump; another file → stack it
  // (with the jump), so 뒤로 can unwind. 새 점프는 앞으로(fwd) 기록을 무효화한다(브라우저처럼).
  const handleNavigate = useCallback(
    (loc: LspLocation) => {
      // 점프 직전의 텍스트 선택(더블클릭 단어 등)은 도착지에서 무의미한데 선택
      // 툴바까지 끌고 와 남는다 — 항해 시점에 정리
      window.getSelection()?.removeAllRanges()
      rememberCaret() // 떠나는 파일(CM) 캐럿 저장 — 뒤로/앞으로로 돌아오면 복원
      const target = displayPath(loc.path, cwd)
      // 다른 파일로의 점프는 최근 파일 탭에도 기록 (앱 공통 키 형식인 슬래시 rel 경로로)
      const cur = effPathRef.current
      if (onViewFile && cur && canonPath(target, cwd) !== canonPath(cur, cwd)) {
        onViewFile(target.replace(/\\/g, '/'))
      }
      setVs((v) => {
        if (v.root == null) return v
        const current = v.stack.length ? v.stack[v.stack.length - 1].path : v.root
        const jump = { line: loc.line + 1, tick: (v.jump?.tick ?? 0) + 1 }
        if (canonPath(current, cwd) === canonPath(target, cwd)) return { ...v, jump, fwd: [] }
        return { ...v, stack: [...v.stack, { path: target }], jump, fwd: [] }
      })
    },
    [cwd, onViewFile, rememberCaret]
  )

  if (!path || !effPath) return null
  const name = effPath.split(/[\\/]/).pop() || effPath
  const dir = effPath.slice(0, effPath.length - name.length)

  return (
    <div
      className="fv-overlay"
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnOverlay.current && e.target === e.currentTarget) requestClose()
      }}
    >
      <div className="fv-modal rzm" ref={modalRef} style={rz.modalStyle}>
        <div className="diff-head" onDoubleClick={rz.onHeaderDoubleClick}>
          {vs.stack.length > 0 && (
            <button className="dclose htip fv-back" onClick={goBack} aria-label="뒤로" data-tip="이전 파일로 (마우스 뒤로 버튼)">
              <IconChevLeft size={15} />
            </button>
          )}
          {vs.fwd.length > 0 && (
            <button className="dclose htip fv-back" onClick={goForward} aria-label="앞으로" data-tip="다음 파일로 (마우스 앞으로 버튼)">
              <IconChevRight size={15} />
            </button>
          )}
          <FileBadge path={effPath} size={22} />
          <span className="dpath">
            <span className="dir">{dir}</span>
            {name}
          </span>
          {ov?.label && <span className="fv-glabel">{ov.label}</span>}
          {diff && (
            <>
              <span className={'tag ' + (diff.tag === 'new' ? 'new' : 'edit')}>{diff.tag === 'new' ? 'NEW' : 'EDIT'}</span>
              <span className="dstat">
                {diff.add ? <span className="add">+{diff.add}</span> : null}
                {diff.del ? <span className="del">−{diff.del}</span> : null}
              </span>
            </>
          )}
          {res?.truncated && <span className="fv-trunc">일부만 표시</span>}
          {isMdFile && diff && (
            <button
              className="fv-lsp install htip"
              onClick={() => setMdPreview((v) => !v)}
              data-tip={mdPreview ? '변경 마킹이 표시된 소스로 보기' : '렌더링된 문서로 보기'}
            >
              {mdPreview ? '변경 사항' : '미리보기'}
            </button>
          )}
          {isSvg && (
            <button
              className="fv-lsp install htip"
              onClick={() => setSvgCode((v) => !v)}
              data-tip={svgCode ? '렌더링된 이미지로 보기' : 'SVG 마크업을 소스로 보기'}
            >
              {svgCode ? '미리보기' : '코드 보기'}
            </button>
          )}
          {cmEligible && (
            <button
              className={'fv-lsp cm-mode htip ' + cmMode}
              onClick={() => setCmMode((m) => (m === 'read' ? 'edit' : 'read'))}
              data-tip={cmMode === 'read' ? '편집 모드로 전환 (Ctrl+E)' : '읽기 모드로 전환 (Ctrl+E)'}
            >
              {cmMode === 'read' ? '읽기' : '편집'}
            </button>
          )}
          {diffVisibleCtx && (
            <button
              className={'fv-lsp cm-diff htip ' + (diffView ? 'on' : 'off')}
              onClick={() => setDiffView((v) => !v)}
              data-tip={diffView ? '일반 보기로 전환 (Ctrl+D)' : '변경 보기로 전환 (Ctrl+D)'}
            >
              {diffView ? '변경' : '일반'}
            </button>
          )}
          {cmEligible && cmDirty && (
            <button
              className="fv-lsp install htip"
              onClick={() => cmRef.current?.save()}
              data-tip="저장 (Ctrl+S)"
            >
              ● 저장
            </button>
          )}
          {cmEligible && !cmDirty && cmSaved && <span className="fv-lsp ready">저장됨</span>}
          {/* 파일별 심볼 분석 중 — 색 토큰이 들어오면 사라진다. ready/error/설치 칩은 없음 */}
          {analyzing && (
            <span className="fv-lsp starting">
              <span className="spin" /> 심볼 분석 중{anPct != null ? ` ${anPct}%` : ''}
            </span>
          )}
          <span className="dspacer" />
          <button
            className="dclose htip"
            onClick={rz.toggleMaximize}
            aria-label={rz.maximized ? '이전 크기로' : '최대화'}
            data-tip={rz.maximized ? '이전 크기로' : '최대화'}
          >
            {rz.maximized ? <IconRestore size={15} /> : <IconMax size={13} />}
          </button>
          <button className="dclose htip" onClick={requestClose} aria-label="닫기" data-tip="닫기 (Esc)">
            <IconClose size={16} />
          </button>
        </div>
        {!rz.maximized && <ModalResizeHandles onStart={rz.startResize} />}
        {isImg ? (
          <ImageView key={effPath} src={imageSrc(absPath(effPath, cwd))} alt={name} zoom={z.zoom} />
        ) : res == null ? (
          <div className="fv-loading">
            <span className="spin" />
          </div>
        ) : res.error || res.content == null ? (
          <div className="fv-empty">{res.error || '내용이 없어요'}</div>
        ) : cmEligible ? (
          <CmEditor
            key={effPath}
            ref={cmRef}
            content={res.content}
            lang={fLang}
            path={effPath}
            cwd={cwd}
            sem={sem}
            structOv={structOv}
            marks={effMarks}
            readOnly={cmMode === 'read'}
            zoom={z.zoom}
            lsp={lspStatus === 'ready'}
            jump={vs.jump}
            initialPos={posMap.current.get(canonPath(effPath, cwd))}
            onNavigate={handleNavigate}
            onDirtyChange={setCmDirty}
            onSaved={() => {
              setCmSaved(true)
              window.setTimeout(() => setCmSaved(false), 1400)
            }}
          />
        ) : (
          <CodeView
            path={effPath}
            content={res.content}
            zoom={z.zoom}
            cwd={cwd}
            lsp={lspStatus === 'ready'}
            sem={sem}
            structOv={structOv}
            jump={vs.jump}
            marks={effMarks}
            mdSource={isMdFile && !!diff && !mdPreview}
            onNavigate={handleNavigate}
          />
        )}
        <ZoomBadge pct={z.pct} show={z.flash} />

        {findOpen && !isImg && (
          <FindBar
            root={cardEl}
            contentKey={effPath + ':' + (res?.content?.length ?? -1)}
            onClose={() => setFindOpen(false)}
          />
        )}

        {ask && onAskSelection && (
          <div className="fv-ask">
            <div className="fv-ask-head">
              <FileBadge path={effPath} size={16} />
              <span className="fv-ask-path">{name}</span>
              {ask.from != null && ask.to != null && (
                <span className="fv-ask-lines">
                  {Math.min(ask.from, ask.to)}–{Math.max(ask.from, ask.to)}줄
                </span>
              )}
              <span className="fv-ask-spacer" />
              <button className="fv-ask-x has-tip" data-tip="닫기 (Esc)" onClick={() => setAsk(null)} aria-label="질문 패널 닫기">
                <IconClose size={14} />
              </button>
            </div>
            <pre className="fv-ask-code scroll">{ask.text}</pre>
            <div className="fv-ask-row">
              <textarea
                ref={askInputRef}
                value={askText}
                rows={1}
                placeholder="선택한 코드에 대해 물어보세요…  (Enter 전송)"
                onChange={(e) => setAskText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (askText.trim()) {
                      onAskSelection({ path: effPath, ...ask, question: askText.trim() })
                      setAsk(null)
                      setAskText('')
                    }
                  } else if (e.key === 'Escape') {
                    e.stopPropagation()
                    setAsk(null)
                  }
                }}
              />
              <button
                className="send has-tip"
                data-tip="Claude에게 보내기 (Enter)"
                aria-label="질문 보내기"
                disabled={!askText.trim()}
                onClick={() => {
                  if (!askText.trim()) return
                  onAskSelection({ path: effPath, ...ask, question: askText.trim() })
                  setAsk(null)
                  setAskText('')
                }}
              >
                <IconSend size={15} />
              </button>
            </div>
          </div>
        )}
      </div>
      {onAskSelection && !isImg && !ask && (
        <SelectionAskBar root={cardEl} onAsk={(text, from, to) => setAsk({ text, from, to })} />
      )}
      {closeConfirm && (
        <CloseConfirmDialog
          onStay={() => {
            setCloseConfirm(false)
            cmRef.current?.focus() // 편집기로 포커스 복귀 — 곧바로 이어서 타이핑되도록
          }}
          onLeave={onClose}
        />
      )}
    </div>
  )
}
