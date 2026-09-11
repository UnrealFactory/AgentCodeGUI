// Interactive, read-only observation of billing responses in a dedicated browser profile.
// Sign in manually. Headers, cookies, tokens, and raw response bodies are never logged.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Cdp, cdpTargets, REPO, sleep } from '../bench/lib.mjs'

const port = 19422
const profile = path.join(process.env.LOCALAPPDATA, 'AgentCodeGUI', 'subscription-web-probe')
const browser = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p))
if (!browser) throw new Error('Chrome or Edge is required')

function safePath(url) {
  try {
    const parsed = new URL(url)
    if (!['claude.ai', 'chatgpt.com'].includes(parsed.hostname)) return '[external page]'
    return parsed.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
  } catch { return '' }
}
function billingFields(value, prefix = '', depth = 0) {
  if (depth > 8 || value == null || typeof value !== 'object') return []
  const rows = []
  for (const [key, v] of Object.entries(value)) {
    if (/token|secret|cookie|password|payment_method|address|invoice|transaction|card|customer|email|name|uuid|url|(^|_)id$/i.test(key)) continue
    const field = prefix ? `${prefix}.${key}` : key
    if (v && typeof v === 'object') rows.push(...billingFields(v, field, depth + 1))
    else if (/subscription|billing|renew|cancel|period|trial|plan|expires|paid|active|scheduled|next_charge|(^|\.)status$/i.test(field)) {
      if (v == null || typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length < 100 && !/[\r\n]/.test(v))) {
        rows.push({ field, value: v })
      }
    }
    if (rows.length >= 100) break
  }
  return rows.slice(0, 100)
}

try { await cdpTargets(port) } catch {
  spawn(browser, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--new-window',
    'https://claude.ai/settings/billing',
    ...(process.argv.includes('--both') ? ['https://chatgpt.com/#settings/Account'] : [])
  ], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: false }).unref()
}
console.log('SUBSCRIPTION_PROBE: Sign in to Claude in the dedicated browser, then open Settings > Billing.')
const pages = new Map()
const attached = new Set()
const deadline = Date.now() + 30 * 60_000
try {
  while (Date.now() < deadline) {
    let targets
    try { targets = await cdpTargets(port) } catch { await sleep(1000); continue }
    for (const target of targets) {
      if (target.type !== 'page' || attached.has(target.id)) continue
      const c = await Cdp.connect(target.webSocketDebuggerUrl)
      attached.add(target.id)
      pages.set(target.id, c)
      const pending = new Map()
      c.listeners.push(async event => {
        try {
          if (event.method === 'Network.responseReceived') {
            const r = event.params.response
            const u = new URL(r.url)
            if (!['claude.ai', 'chatgpt.com'].includes(u.hostname) || !/^\/(api|backend-api)\//.test(u.pathname)) return
            const endpoint = safePath(r.url)
            if (!/billing|subscription|bootstrap|accounts\/check|account\/check/i.test(endpoint)) return
            console.log(JSON.stringify({ provider: u.hostname, endpoint, status: r.status }))
            if (/json/i.test(r.mimeType)) {
              pending.set(event.params.requestId, { provider: u.hostname, endpoint })
            }
          } else if (event.method === 'Network.loadingFinished') {
            const id = event.params.requestId
            const meta = pending.get(id)
            if (!meta) return
            pending.delete(id)
            const r = await c.send('Network.getResponseBody', { requestId: id })
            const raw = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
            const value = JSON.parse(raw)
            const fields = billingFields(value)
            console.log(JSON.stringify({ ...meta, topLevelKeys: Object.keys(value).slice(0, 35), fields }))
          }
        } catch { /* A page can navigate while a response finishes. Never print response contents on errors. */ }
      })
      await c.send('Network.enable')
      console.log(JSON.stringify({ attached: true, page: safePath(target.url) }))
    }
    await sleep(1000)
  }
} finally {
  for (const c of pages.values()) c.close()
}
