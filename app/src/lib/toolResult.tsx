// ★3.0 TOOLROW(2026-09-02 사용자 결정) — 도구 행 오른쪽 요약과 클릭 카드의 재료 해석.
//
// 엔진(`wire.rs tool_end`)은 행 오른쪽 요약을 **언어 중립 토큰**으로 보낸다 — `145 lines`·
// `12 hits`·`2 results`·`done`·`new +42`·`3 files +a −d`·`+a −d`. 여기서 표시 언어로 푼다.
// 토큰이 아닌 문자열(Skill/Workflow의 요약 문장, 예전 채팅의 한국어 요약)은 그대로 보인다.
//
// Chat.tsx와 AgentPanel.tsx가 같이 쓴다 — AgentPanel은 Chat이 import하는 쪽이라 Chat에 두면
// 순환이다. 컴포넌트를 import하지 않는 lib에 둔다.
import type { ReactNode } from 'react'
import { t } from './i18n'

/** 행 오른쪽 요약 토큰 → 표시 노드. `+N −N`은 색을 입힌다(ASCII `-`·U+2212 `−` 모두).
 *  말 뒤에 숫자가 붙는 꼴(새 파일 +N · 파일 N개 +a −d)은 ` · `로 가른다 — Bash 행의
 *  「03s · 12줄」과 같은 문법(2026-09-04 사용자: 「새 파일 +33」이 한 덩이로 붙어 보였다). */
export function fmtToolResult(result: string | undefined): ReactNode {
  const r = (result ?? '').trim()
  if (!r) return ''
  let m: RegExpMatchArray | null
  if ((m = r.match(/^\+(\d+) [-−](\d+)$/)))
    return (
      <>
        <span className="add">+{m[1]}</span> <span className="del">−{m[2]}</span>
      </>
    )
  if ((m = r.match(/^new \+(\d+)$/)))
    return (
      <>
        {t('새 파일', 'New file')} · <span className="add">+{m[1]}</span>
      </>
    )
  if ((m = r.match(/^(\d+) files \+(\d+) [-−](\d+)$/)))
    return (
      <>
        {t(`파일 ${m[1]}개`, `${m[1]} files`)} · <span className="add">+{m[2]}</span> <span className="del">−{m[3]}</span>
      </>
    )
  if ((m = r.match(/^(\d+) lines?$/))) return t(`${m[1]}줄`, `${m[1]} lines`)
  if ((m = r.match(/^(\d+) hits?$/))) return t(`${m[1]}건`, `${m[1]} hits`)
  if ((m = r.match(/^(\d+) results?$/))) return t(`${m[1]}개 결과`, `${m[1]} results`)
  if (r === 'done') return t('완료', 'Done')
  return r
}

/** 카드 「요청」 — 엔진이 실은 입력 JSON을 키·값 표로. 파싱이 안 되면(캡에 잘림) 원문 한 덩이. */
export function parseToolArgs(args: string | undefined): { rows: [string, string][] | null; raw: string } {
  const raw = args ?? ''
  if (!raw) return { rows: null, raw }
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { rows: null, raw }
    const rows: [string, string][] = Object.entries(v as Record<string, unknown>).map(([k, x]) => [
      k,
      typeof x === 'string' ? x : JSON.stringify(x, null, 2)
    ])
    return { rows: rows.length ? rows : null, raw }
  } catch {
    return { rows: null, raw }
  }
}

/** MCP 원 이름(`mcp__서버__도구`) → 서버·도구. 서버 이름에 `__`가 있을 수 있어 뒤에서 가른다
 *  (엔진 `mcp_target`과 같은 판정). `mcp__` 접두가 아니면 null. */
export function mcpParts(name: string | undefined): { server: string; tool: string } | null {
  if (!name || !name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const i = rest.lastIndexOf('__')
  return i < 0 ? { server: rest, tool: '' } : { server: rest.slice(0, i), tool: rest.slice(i + 2) }
}

export interface SearchHit {
  path: string
  line?: string // 일치 줄 번호 (Grep 내용 모드)
  text?: string // 일치 줄 본문
}

/**
 * 검색(Grep/Glob) 출력 → 파일 목록. 줄 모양은 셋이다:
 *   `path`           (Glob · Grep files_with_matches)
 *   `path:NN:text`   (Grep content · `-n`)  — 문맥 줄은 `path-NN-text`
 *   `path:NN`        (Grep count)
 * 머리말(`Found N files`)·잘림 안내는 목록에서 뺀다. 파일로 안 읽히는 줄은 `rest`로 남겨
 * 카드가 터미널 웰로 보여 준다. 엔진이 줄 머리의 cwd를 이미 뗐으므로 경로는 대개 상대다.
 */
export function parseSearchOutput(text: string): { hits: SearchHit[]; rest: string[]; truncated: boolean } {
  const hits: SearchHit[] = []
  const rest: string[] = []
  let truncated = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue
    if (/^Found \d+ (files?|matches?|lines?)/i.test(line) || /^Total:/i.test(line)) continue
    if (/^\(Results are truncated/i.test(line)) {
      truncated = true
      continue
    }
    if (/^No (files|matches) found/i.test(line)) continue
    // `path:NN:text` — 경로는 드라이브 콜론(`C:`) 뒤의 첫 `:숫자:`까지
    const m = line.match(/^((?:[a-zA-Z]:)?[^:\n]+?):(\d+)(?:[:-](.*))?$/)
    if (m && looksLikePath(m[1])) {
      hits.push({ path: m[1], line: m[2], text: m[3] })
      continue
    }
    // 문맥 줄 `path-NN-text`(-A/-B/-C) — `-`는 파일명에도 흔해서(`foo-12-bar.h`) 경로가
    // **확장자로 끝날 때만** 문맥 줄로 읽는다. 아니면 통째로 경로다.
    const c = line.match(/^((?:[a-zA-Z]:)?[^:\n]+?\.[A-Za-z0-9]{1,8})-(\d+)-(.*)$/)
    if (c && looksLikePath(c[1])) {
      hits.push({ path: c[1], line: c[2], text: c[3] })
      continue
    }
    if (looksLikePath(line)) {
      hits.push({ path: line })
      continue
    }
    rest.push(line)
  }
  return { hits, rest, truncated }
}

function looksLikePath(s: string): boolean {
  const p = s.trim()
  if (!p || p.length > 500) return false
  if (/[*?"<>|]/.test(p)) return false
  // 드라이브 콜론 말고는 콜론이 없어야 경로다
  const body = /^[a-zA-Z]:/.test(p) ? p.slice(2) : p
  if (body.includes(':')) return false
  return /[\\/]/.test(p) || /\.[A-Za-z0-9]{1,8}$/.test(p)
}
