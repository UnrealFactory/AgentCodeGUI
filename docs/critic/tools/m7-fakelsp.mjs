// ── M7 크리틱 — 가짜 언어 서버 ────────────────────────────────────────────────
// ccg-lsp의 `Launch::Node{ module: ["typescript-language-server","lib","cli.mjs"] }`가
// `CCG_LSP_MODULES` 아래에서 이 파일을 집는다. 실물 tsserver로는 못 만드는 상황
// (Roslyn식 프로토콜 위반 사망 · 준비 후 급사 · workspace/configuration 요구)을 재현한다.
//
// 환경 스위치
//   FLSP_LOG               JSONL 로그 경로(필수). 한 줄 = 한 사건.
//   FLSP_SYNC              선언할 textDocumentSync.change (1=full, 2=incremental). 기본 2
//   FLSP_DIE_ON_DUP_OPEN   같은 URI에 didOpen이 두 번 오면 즉시 exit(1)  ← Roslyn 실사인
//   FLSP_DIE_ON_FULL_CHANGE  range 없는 didChange가 오면 즉시 exit(1)     ← Roslyn 실사인
//   FLSP_DIE_AFTER_MS      ready 뒤 이만큼 지나면 exit(1)                 ← 서버 급사
//   FLSP_REQ_CONFIG        initialized 뒤 workspace/configuration을 items 2개로 요청하고
//                          응답을 로그에 남긴다(LSP 규약: items 수만큼 원소가 와야 한다)
//   FLSP_TOKENS            semanticTokens/full이 돌려줄 토큰 수(기본 3)
//   FLSP_SLOW_INIT_MS      initialize 응답을 이만큼 늦춘다
import fs from 'node:fs'

const LOG = process.env.FLSP_LOG
const SYNC = Number(process.env.FLSP_SYNC || '2')
const DIE_DUP = process.env.FLSP_DIE_ON_DUP_OPEN === '1'
const DIE_FULL = process.env.FLSP_DIE_ON_FULL_CHANGE === '1'
const DIE_AFTER = Number(process.env.FLSP_DIE_AFTER_MS || '0')
const REQ_CONFIG = process.env.FLSP_REQ_CONFIG === '1'
const NTOK = Number(process.env.FLSP_TOKENS || '3')
const SLOW_INIT = Number(process.env.FLSP_SLOW_INIT_MS || '0')

const t0 = Date.now()
function log(ev, extra) {
  if (!LOG) return
  try {
    fs.appendFileSync(LOG, JSON.stringify({ t: Date.now() - t0, wall: Date.now(), pid: process.pid, ev, ...extra }) + '\n')
  } catch { /* 로그 실패는 무시 */ }
}
log('start', { argv: process.argv.slice(2), cwd: process.cwd() })
process.on('exit', (c) => log('exit', { code: c }))

const TYPES = ['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter',
  'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword',
  'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator']
const MODS = ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary']

let nextId = 1000
const opened = new Map() // uri → count
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function onMessage(m) {
  if (m.method) log('recv', { method: m.method, id: m.id ?? null,
    uri: m.params?.textDocument?.uri ?? null,
    version: m.params?.textDocument?.version ?? null,
    changes: m.params?.contentChanges
      ? m.params.contentChanges.map((c) => ({ hasRange: !!c.range, range: c.range, textLen: (c.text ?? '').length }))
      : undefined })
  else log('reply', { id: m.id, result: m.result === undefined ? null : m.result })

  if (m.method === 'initialize') {
    const answer = () => {
      send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {
        textDocumentSync: { openClose: true, change: SYNC },
        hoverProvider: true,
        definitionProvider: true,
        completionProvider: { triggerCharacters: ['.'], resolveProvider: true },
        semanticTokensProvider: { legend: { tokenTypes: TYPES, tokenModifiers: MODS }, full: true },
        workspaceSymbolProvider: true
      }, serverInfo: { name: 'ccg-critic-fakelsp', version: '1' } } })
    }
    if (SLOW_INIT > 0) setTimeout(answer, SLOW_INIT)
    else answer()
    return
  }
  if (m.method === 'initialized') {
    if (REQ_CONFIG) {
      const id = nextId++
      log('serverRequest', { id, method: 'workspace/configuration', items: 2 })
      send({ jsonrpc: '2.0', id, method: 'workspace/configuration',
        params: { items: [{ section: 'python' }, { section: 'python.analysis' }] } })
    }
    if (DIE_AFTER > 0) setTimeout(() => { log('selfKill', { afterMs: DIE_AFTER }); process.exit(1) }, DIE_AFTER)
    return
  }
  if (m.method === 'textDocument/didOpen') {
    const u = m.params.textDocument.uri
    const n = (opened.get(u) || 0) + 1
    opened.set(u, n)
    log('didOpen', { uri: u, count: n })
    if (n > 1 && DIE_DUP) { log('selfKill', { why: 'duplicate didOpen' }); process.exit(1) }
    return
  }
  if (m.method === 'textDocument/didChange') {
    const bad = (m.params.contentChanges || []).some((c) => !c.range)
    if (bad && SYNC === 2 && DIE_FULL) { log('selfKill', { why: 'rangeless didChange on incremental server' }); process.exit(1) }
    return
  }
  if (m.method === 'textDocument/didClose') { opened.delete(m.params.textDocument.uri); return }
  if (m.id == null) return // 그 밖의 통지

  // 요청 응답
  switch (m.method) {
    case 'textDocument/semanticTokens/full': {
      const data = []
      for (let i = 0; i < NTOK; i++) data.push(i === 0 ? 0 : 1, 0, 4, 12, 0)
      send({ jsonrpc: '2.0', id: m.id, result: { data } })
      break
    }
    case 'textDocument/hover':
      send({ jsonrpc: '2.0', id: m.id, result: { contents: { kind: 'markdown', value: 'fake hover' } } })
      break
    case 'textDocument/definition':
      send({ jsonrpc: '2.0', id: m.id, result: [{ uri: m.params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] })
      break
    case 'textDocument/completion':
      send({ jsonrpc: '2.0', id: m.id, result: { isIncomplete: false, items: [{ label: 'alpha', kind: 5 }, { label: 'beta', kind: 2 }] } })
      break
    case 'completionItem/resolve':
      send({ jsonrpc: '2.0', id: m.id, result: { ...m.params, detail: 'resolved' } })
      break
    case 'workspace/symbol':
      send({ jsonrpc: '2.0', id: m.id, result: [] })
      break
    case 'shutdown':
      send({ jsonrpc: '2.0', id: m.id, result: null })
      break
    default:
      send({ jsonrpc: '2.0', id: m.id, result: null })
  }
}

let buf = Buffer.alloc(0)
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c])
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n')
    if (sep < 0) break
    const head = buf.slice(0, sep).toString('ascii').toLowerCase()
    const m = /content-length:\s*(\d+)/.exec(head)
    if (!m) { buf = buf.slice(sep + 4); continue }
    const len = Number(m[1])
    if (buf.length < sep + 4 + len) break
    const body = buf.slice(sep + 4, sep + 4 + len).toString('utf8')
    buf = buf.slice(sep + 4 + len)
    try { onMessage(JSON.parse(body)) } catch (e) { log('parseError', { err: String(e) }) }
  }
})
process.stdin.on('end', () => { log('stdinEnd', {}); process.exit(0) })
