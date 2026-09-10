import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { ExternalToolClient } from './client.mjs'

const args = process.argv.slice(2)
const value = flag => args.find(a => a.startsWith(flag + '='))?.slice(flag.length + 1)
const appHome = value('--app-home')
const instanceFile = path.join(import.meta.dirname, '.instance-id')
let instanceId
try { instanceId = fs.readFileSync(instanceFile, 'utf8').trim() } catch { instanceId = crypto.randomUUID(); fs.writeFileSync(instanceFile, instanceId) }
const specs = {
  code: { id: 'dev.agentcodegui.lab.code', name: 'CodePad Test', icon: 'code', description: '외부 코드 선택 · 편집 상태 테스트' },
  data: { id: 'dev.agentcodegui.lab.data', name: 'Worktable Test', icon: 'table', description: '표 선택 · 조회 상태 테스트' },
  custom: { id: 'dev.agentcodegui.lab.custom', name: 'Custom Tool Test', icon: 'package', description: '사용자 정의 JSON 데이터 테스트' }
}
const clients = Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, new ExternalToolClient({ ...spec, instanceId: `${instanceId}/${key}`, version: '1.0.0' }, appHome ? { appHome } : {}).start()]))
const token = crypto.randomBytes(24).toString('hex')
const page = fs.readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8')
let origin = ''
let stopping = false

async function shutdown() {
  if (stopping) return
  stopping = true
  await Promise.allSettled(Object.values(clients).map(client => client.close()))
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body))
}
async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 512 * 1024) throw new Error('Request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return respond(res, 403, { error: 'Local test tool only' })
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'self'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` })
    return res.end(page.replaceAll('__LAB_TOKEN__', token))
  }
  if (req.headers['x-lab-token'] !== token) return respond(res, 403, { error: 'Invalid test tool request' })
  try {
    if (req.method === 'GET' && req.url === '/api/status') return respond(res, 200, {
      tools: Object.fromEntries(Object.entries(clients).map(([key, client]) => [key, { manifest: client.manifest, status: client.status, document: client.desired }])),
      icons: clients.code.icons.map(({ id, ko, en }) => ({ id, ko, en }))
    })
    if (req.method === 'POST') {
      const input = await readBody(req)
      if (req.url === '/api/shutdown') { respond(res, 200, { ok: true }); void shutdown(); return }
      const client = clients[input.tool]
      if (!client) return respond(res, 400, { error: 'Unknown test tool' })
      if (req.url === '/api/publish') { await client.publish(input.document); return respond(res, 200, { ok: true }) }
      if (req.url === '/api/icon') { await client.updateManifest({ icon: input.icon }); return respond(res, 200, { ok: true }) }
    }
    respond(res, 404, { error: 'Unknown endpoint' })
  } catch (error) { respond(res, 400, { error: error.message }) }
})
server.requestTimeout = 6000
server.headersTimeout = 6000
server.listen(0, '127.0.0.1', () => {
  origin = `http://127.0.0.1:${server.address().port}`
  console.log(JSON.stringify({ url: origin, pid: process.pid }))
  if (value('--ready-file')) fs.writeFileSync(value('--ready-file'), JSON.stringify({ url: origin, pid: process.pid }))
  if (args.includes('--open')) {
    const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p))
    if (edge) spawn(edge, [`--app=${origin}`, '--new-window'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    else spawn('explorer.exe', [origin], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  }
})
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
