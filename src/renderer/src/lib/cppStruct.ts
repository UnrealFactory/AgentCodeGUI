import { useEffect, useState } from 'react'
import type { LspSemanticTokens } from '@shared/protocol'
import type { StructOv } from './semTokens'
import { paletteClassFor } from '../components/fileType'

// ── C++ struct 구분 보정 ─────────────────────────────────────────────────────
// clangd 시맨틱 토큰은 struct/union을 'class'로 합쳐 보내 Rider의 연보라 구분이
// 사라진다 (workspace/symbol·documentSymbol도 마찬가지 — 직접 확인). 종류가
// 살아있는 유일한 통로는 hover라서, 화면의 고유 이름당 한 번씩 그 위치에 hover를
// 보내 '### struct …' 헤더로 종류를 배운다. 이미 파싱된 TU 안의 위치라 ms 단위.
// 필드는 hover 시그니처의 '// In <소속타입>'으로 소속을 알아내 struct 소속이면
// 연보라. 결과는 세션 캐시 — 같은 이름은 다시 묻지 않는다.
const cppRecordIsStruct = new Map<string, boolean>() // 타입 이름 → struct/union 여부
const cppFieldOfStruct = new Map<string, boolean>() // 필드 이름 → struct 소속 여부

// FileModal(뷰어)과 CmEditor가 함께 쓰는 훅 — sem 토큰 + hover 프로브로 이 파일에서
// 연보라(sem-type2)로 재분류할 타입/필드 이름 집합을 만든다. 엔진 무관하게 한 번만
// 계산되도록 FileModal에서 호출해 양쪽에 prop으로 내려준다.
export function useCppStructOv(
  sem: LspSemanticTokens | null,
  lang: string,
  text: string,
  cwd: string,
  path: string
): StructOv | null {
  const [structOv, setStructOv] = useState<StructOv | null>(null)
  useEffect(() => {
    setStructOv(null)
    const cpp = lang === 'cpp' || lang === 'c'
    if (!sem || !sem.data.length || !cpp || !paletteClassFor(lang)) return
    const srcLines = text.split('\n')
    // 이름별 첫 등장 위치 — hover 프로브를 쏠 좌표
    const typePos = new Map<string, { line: number; character: number }>()
    const fieldPos = new Map<string, { line: number; character: number }>()
    for (let i = 0; i < sem.data.length; i += 5) {
      const type = sem.types[sem.data[i + 3]] ?? ''
      if (type !== 'class' && type !== 'property') continue
      const t = (srcLines[sem.data[i]] ?? '').substr(sem.data[i + 1], sem.data[i + 2])
      if (!/^[A-Za-z_]\w*$/.test(t)) continue
      const m = type === 'class' ? typePos : fieldPos
      if (!m.has(t)) m.set(t, { line: sem.data[i], character: sem.data[i + 1] })
    }
    if (!typePos.size && !fieldPos.size) return
    let alive = true
    const apply = (): void => {
      if (!alive) return
      const types = new Set([...typePos.keys()].filter((n) => cppRecordIsStruct.get(n) === true))
      const fields = new Set([...fieldPos.keys()].filter((n) => cppFieldOfStruct.get(n) === true))
      setStructOv(types.size || fields.size ? { types, fields } : null)
    }
    const needTypes = [...typePos.keys()].filter((n) => !cppRecordIsStruct.has(n))
    const needFields = [...fieldPos.keys()].filter((n) => !cppFieldOfStruct.has(n))
    if (!needTypes.length && !needFields.length) {
      apply()
      return
    }
    // hover 헤더의 종류 단어와, 시그니처의 '// In <소속>' 을 뽑는다
    const probe = async (pos: { line: number; character: number }): Promise<{ kind: string; container: string } | null> => {
      const r = await window.api.lsp.hover(cwd, path, pos).catch(() => null)
      const head = /^###\s+([\w-]+)/.exec(r?.contents ?? '')
      if (!head) return null
      const cont = /\/\/ In ([\w:]+)/.exec(r?.contents ?? '')
      return { kind: head[1].toLowerCase(), container: cont?.[1]?.split('::').pop() ?? '' }
    }
    const CHUNK = 6
    void (async () => {
      // 타입 먼저 — 필드의 소속 판정이 이 결과(cppRecordIsStruct)를 쓴다
      for (let i = 0; i < needTypes.length && alive; i += CHUNK) {
        await Promise.all(
          needTypes.slice(i, i + CHUNK).map(async (n) => {
            const p = await probe(typePos.get(n)!)
            if (!p) return // 응답 없음(서버 바쁨 등) — 캐시하지 않고 다음 기회에
            if (p.kind === 'struct' || p.kind === 'union') cppRecordIsStruct.set(n, true)
            else if (p.kind === 'class') cppRecordIsStruct.set(n, false)
          })
        )
      }
      for (let i = 0; i < needFields.length && alive; i += CHUNK) {
        await Promise.all(
          needFields.slice(i, i + CHUNK).map(async (n) => {
            const p = await probe(fieldPos.get(n)!)
            if (!p || p.kind !== 'field' || !p.container) return
            const st = cppRecordIsStruct.get(p.container)
            if (st !== undefined) cppFieldOfStruct.set(n, st) // 소속 종류를 모르면 보류
          })
        )
      }
      apply()
    })()
    return () => {
      alive = false
    }
  }, [sem, lang, text, cwd, path])
  return structOv
}
