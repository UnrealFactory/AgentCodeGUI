import { memo, useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightCode } from '../lib/highlight'
import { paletteClassFor } from './fileType'

// flatten a hast node to its raw text (used to pull code out of a <pre>)
function nodeText(node: unknown): string {
  const n = node as { value?: string; children?: unknown[] }
  if (!n) return ''
  if (typeof n.value === 'string') return n.value
  if (Array.isArray(n.children)) return n.children.map(nodeText).join('')
  return ''
}

// fenced code block — render straight from the node so language + raw text are
// reliable (covers no-language blocks too). `plain` skips syntax highlighting,
// used during streaming to avoid re-running highlight.js every frame.
// `decorate`는 하이라이트 결과 HTML의 후처리 훅 — 호버 카드가 시맨틱 색 사전을
// 끼워 넣는 데 쓴다.
function makePre(plain: boolean, decorate?: (html: string) => string): Components['pre'] {
  return function Pre({ node }) {
    const codeNode = (node as { children?: { properties?: { className?: unknown } }[] })?.children?.[0]
    const cls = codeNode?.properties?.className
    const langClass = Array.isArray(cls) ? cls.find((c) => String(c).startsWith('language-')) : undefined
    const lang = langClass ? String(langClass).replace('language-', '') : ''
    const text = nodeText(codeNode).replace(/\n$/, '')
    const html = plain ? null : (decorate ?? ((h: string) => h))(highlightCode(text, lang))
    return (
      <div className={'codeblock' + paletteClassFor(lang)}>
        <div className="cb-head">
          <span className="lang">{lang || 'code'}</span>
        </div>
        <pre>
          {html == null ? <code className="hljs">{text}</code> : <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />}
        </pre>
      </div>
    )
  }
}

// Map markdown elements onto the app's existing content styles.
const baseComponents: Components = {
  // inline code (block code is handled in `pre`)
  code: ({ children }) => <code className="inline">{children}</code>,
  ul: ({ children }) => <ul className="bullets">{children}</ul>,
  ol: ({ children }) => <ol className="md-ol">{children}</ol>,
  h1: ({ children }) => <div className="md-h md-h1">{children}</div>,
  h2: ({ children }) => <div className="md-h md-h2">{children}</div>,
  h3: ({ children }) => <div className="md-h md-h3">{children}</div>,
  h4: ({ children }) => <div className="md-h md-h4">{children}</div>,
  h5: ({ children }) => <div className="md-h md-h4">{children}</div>,
  h6: ({ children }) => <div className="md-h md-h4">{children}</div>,
  hr: () => <div className="md-hr" />,
  blockquote: ({ children }) => <blockquote className="md-quote">{children}</blockquote>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table className="md-table">{children}</table>
    </div>
  )
}

const componentsHighlighted: Components = { ...baseComponents, pre: makePre(false) }
const componentsPlain: Components = { ...baseComponents, pre: makePre(true) }

// memo — remark 파싱은 글 길이에 비례하는 동기 작업이라, props가 그대로면(완료된
// 메시지·뷰어의 .md 본문) 부모 리렌더에 파싱이 따라 돌지 않게 여기서 한 번 더 막는다
export const Markdown = memo(function Markdown({
  text,
  plain,
  codeLang,
  decorate
}: {
  text: string
  plain?: boolean
  /** 인라인 코드까지 이 언어로 신택스 하이라이트 (호버 카드 — 칩이 코드 색을 입는다) */
  codeLang?: string
  /** 하이라이트 HTML 후처리 — 호버 카드의 시맨틱 색 사전 주입 지점 */
  decorate?: (html: string) => string
}) {
  const components = useMemo<Components>(() => {
    if (!codeLang && !decorate) return plain ? componentsPlain : componentsHighlighted
    const inline: Components['code'] = ({ children }) => {
      const txt = Array.isArray(children) ? children.join('') : String(children ?? '')
      const html = (decorate ?? ((h: string) => h))(highlightCode(txt, codeLang ?? ''))
      return <code className="inline hljs" dangerouslySetInnerHTML={{ __html: html }} />
    }
    return { ...baseComponents, code: inline, pre: makePre(!!plain, decorate) }
  }, [plain, codeLang, decorate])
  // remark 파싱도 동기 작업이다 — 아주 큰 본문(거대한 .md 파일, 초장문 답변)은 파싱
  // 자체가 프레임을 통째로 잡아먹으므로 구조 없이 원문 그대로 보여준다
  if (text.length > MD_PARSE_LIMIT) return <pre className="md-overflow">{text}</pre>
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  )
})

const MD_PARSE_LIMIT = 150_000
