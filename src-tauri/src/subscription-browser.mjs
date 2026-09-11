// One-shot browser reader using an app-owned profile and a short-lived loopback CDP connection.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) return null
  return Number.isFinite(Date.parse(value)) ? value : null
}
const snapshot = (kind, at = null) => ({ kind, date: date(at) })

export function claudeSubscription(j) {
  if (!j || typeof j !== 'object' || !Object.hasOwn(j, 'status')) return null
  if (j.status === 'past_due' || j.status === 'unpaid') return snapshot('paymentDue', j.next_charge_at ?? j.next_charge_date)
  if (j.status === 'canceled' || j.status === 'expired') return snapshot('ended', j.plan_ending_at ?? j.plan_ending_before)
  if (j.payment_paused_until || j.manual_pause_scheduled_at) return snapshot('paused', j.payment_paused_until ?? j.manual_pause_scheduled_at)
  if (j.status === 'trialing') {
    const trial = typeof j.trial_end_ts === 'number' ? new Date(j.trial_end_ts * 1000) : null
    return snapshot('trial', trial && Number.isFinite(trial.getTime()) ? trial.toISOString() : null)
  }
  // A gift followed by a paid plan is not a cancellation. Scheduled changes need their own UI.
  if (j.gift_details || j.scheduled_downgrade || j.has_schedule) return snapshot('scheduled', j.plan_ending_at ?? j.next_charge_at ?? j.plan_ending_before ?? j.next_charge_date)
  const end = date(j.plan_ending_before ?? j.plan_ending_at)
  const next = date(j.next_charge_date ?? j.next_charge_at)
  if (end && (!next || Date.parse(next) >= Date.parse(end))) return snapshot('cancels', j.plan_ending_at ?? end)
  if (next) return snapshot('renews', j.next_charge_at ?? next)
  if (j.status === 'active') return snapshot('active')
  return snapshot('unknown')
}

export function codexSubscription(body, accountId) {
  // Use the explicit account key, never the browser's `default` account alias.
  const row = body?.accounts?.[accountId]
  if (!row || !row.entitlement) return null
  const e = row.entitlement
  if (e.has_active_subscription === false) return snapshot('none')
  if (date(e.cancels_at)) return snapshot('cancels', e.cancels_at)
  if (e.scheduled_plan_change) return snapshot('scheduled', e.renews_at)
  if (row.last_active_subscription?.will_renew === true && date(e.renews_at)) return snapshot('renews', e.renews_at)
  // `expires_at` can include grace time and is not the billing period end.
  return snapshot(e.has_active_subscription ? 'active' : 'unknown')
}

export class BrowserConnection {
  constructor(child, port) {
    this.child = child
    this.port = port
    this.id = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.ready = this.connect()
  }
  async connect() {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && this.child.exitCode == null) {
      try {
        const r = await fetch('http://127.0.0.1:' + this.port + '/json/version', { signal: AbortSignal.timeout(700) })
        const url = new URL((await r.json()).webSocketDebuggerUrl)
        if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== this.port) throw new Error('endpoint')
        const ws = new WebSocket(url)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')) }, 2000)
          ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
          ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('closed')) }, { once: true })
        })
        this.ws = ws
        ws.addEventListener('message', event => {
          let msg
          try { msg = JSON.parse(event.data) } catch { return }
          if (msg.id) {
            const p = this.pending.get(msg.id)
            if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(new Error('protocol')) : p.resolve(msg.result) }
          } else for (const f of this.listeners) Promise.resolve(f(msg)).catch(() => {})
        })
        ws.addEventListener('close', () => {
          for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')) }
          this.pending.clear()
        })
        return
      } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    throw new Error('browserUnavailable')
  }
  async send(method, params = {}, sessionId, timeout = 10000) {
    await this.ready
    return new Promise((resolve, reject) => {
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  async close() {
    await this.send('Browser.close', {}, undefined, 2000).catch(() => {})
    if (this.child.exitCode == null) {
      await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))])
    }
    if (this.child.exitCode == null) this.child.kill()
    this.ws?.close()
  }
}

export async function launchBrowser(config) {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
  const child = spawn(config.browser, [
    '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + config.profile,
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--new-window', '--window-size=1100,850', ...(config.interactive ? ['--window-position=100,100'] : ['--window-position=-32000,-32000']), 'about:blank'
  ], { stdio: 'ignore', windowsHide: !config.interactive })
  // Consume spawn errors; the connection reports a sanitized error instead of a raw OS path.
  child.on('error', () => {})
  return new BrowserConnection(child, port)
}

export async function readSubscription(config, { signal, onProgress = () => {} } = {}) {
  if (signal?.aborted) return { error: 'cancelled' }
  if (!['claude', 'codex'].includes(config.provider) || !config.identity) return { error: 'identityMissing' }
  const pipe = await launchBrowser(config)
  onProgress({ browserPid: pipe.child.pid })
  const sessions = new Set()
  const pending = new Map()
  let result, resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const finish = value => { if (!result) { result = value; resolveDone() } }
  const cancelled = () => finish({ error: 'cancelled' })
  signal?.addEventListener('abort', cancelled, { once: true })
  const deadline = setTimeout(() => finish({ error: 'needsLogin' }), config.interactive ? 300000 : 45000)
  const wrong = () => {
    onProgress({ state: 'wrongAccount' })
    if (!config.interactive) finish({ error: 'wrongAccount' })
  }
  try {
    pipe.child.once('exit', () => finish({ error: 'closed' }))
    pipe.child.once('error', () => finish({ error: 'browserMissing' }))
    pipe.listeners.add(async msg => {
      if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'page') await attach(msg.params.targetInfo.targetId)
      if (!sessions.has(msg.sessionId)) return
      const p = msg.params
      const key = msg.sessionId + ':' + p?.requestId
      if (msg.method === 'Network.responseReceived') {
        const u = new URL(p.response.url)
        const claude = config.provider === 'claude' && u.origin === 'https://claude.ai' && /^\/api\/organizations\/[^/]+\/subscription_details$/.test(u.pathname)
        const codex = config.provider === 'codex' && u.origin === 'https://chatgpt.com' && /^\/backend-api\/accounts\/check\//.test(u.pathname)
        if (!claude && !codex) return
        if (p.response.status !== 200) return
        if (claude && u.pathname.split('/')[3] !== config.identity) { wrong(); return }
        pending.set(key, claude ? 'claude' : 'codex')
      } else if (msg.method === 'Network.loadingFinished') {
        const provider = pending.get(key)
        if (!provider) return
        pending.delete(key)
        const response = await pipe.send('Network.getResponseBody', { requestId: p.requestId }, msg.sessionId)
        const raw = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body
        const j = JSON.parse(raw)
        if (provider === 'codex' && !j?.accounts?.[config.identity]) { wrong(); return }
        const value = provider === 'claude' ? claudeSubscription(j) : codexSubscription(j, config.identity)
        if (value) finish({ data: { ...value, checkedAt: Math.floor(Date.now() / 1000) } })
        else finish({ error: 'unavailable' })
      } else if (msg.method === 'Network.loadingFailed') pending.delete(key)
    })
    const attaching = new Map()
    async function attach(id) {
      if (attaching.has(id)) return attaching.get(id)
      const task = (async () => {
        const { sessionId } = await pipe.send('Target.attachToTarget', { targetId: id, flatten: true })
        sessions.add(sessionId)
        await pipe.send('Network.enable', { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024, maxPostDataSize: 0 }, sessionId)
        await pipe.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId)
        return sessionId
      })()
      attaching.set(id, task)
      return task
    }
    await pipe.send('Target.setDiscoverTargets', { discover: true })
    const targets = await pipe.send('Target.getTargets')
    const target = targets.targetInfos.find(t => t.type === 'page') ?? (await pipe.send('Target.createTarget', { url: 'about:blank' }))
    const session = await attach(target.targetId)
    await pipe.send('Page.navigate', { url: config.provider === 'claude' ? 'https://claude.ai/settings/billing' : 'https://chatgpt.com/#settings/Account' }, session)
    if (signal?.aborted) cancelled()
    await done
    return result
  } catch {
    return result ?? { error: 'unavailable' }
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', cancelled)
    await pipe.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = createInterface({ input: process.stdin })
  const abort = new AbortController()
  let started = false
  input.on('close', () => abort.abort())
  input.on('line', async line => {
    if (started) { abort.abort(); return }
    started = true
    try {
      const result = await readSubscription(JSON.parse(line), { signal: abort.signal, onProgress: value => process.stdout.write(JSON.stringify(value) + '\n') })
      process.stdout.write(JSON.stringify(result) + '\n')
    } catch { process.stdout.write('{"error":"unavailable"}\n') }
    input.close()
  })
}
