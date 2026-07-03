import type { ChildProcess } from 'node:child_process'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface RpcMessage {
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

/**
 * Minimal JSON-RPC 2.0 client over a child process's stdio, speaking the LSP base
 * protocol (Content-Length framed messages). Request/response correlation,
 * server→client requests, and notifications — nothing more.
 */
export class StdioRpc {
  private buf: Buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, Pending>()
  private dead: Error | null = null

  /** Answers server→client requests (workspace/configuration …). Must not throw. */
  onRequest: (method: string, params: unknown) => unknown = () => null

  /** Observes server→client notifications (progress, projectInitializationComplete …). */
  onNotify: (method: string, params: unknown) => void = () => {}

  constructor(private child: ChildProcess) {
    child.stdout?.on('data', (chunk: Buffer) => this.feed(chunk))
    // A server that died mid-conversation surfaces EPIPE/EOF *asynchronously* as an
    // 'error' event on its stdio streams (the try/catch in write() only sees sync
    // throws). Without these listeners Node re-raises that as an uncaughtException —
    // one crashed clangd/verse-lsp/Roslyn then takes the whole app down with it.
    // Swallow: in-flight requests already fail via timeout, and the child's 'exit'
    // handler dispose()s this rpc right after.
    child.stdin?.on('error', () => {})
    child.stdout?.on('error', () => {})
  }

  request<T>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
    return this.requestId<T>(method, params, timeoutMs).promise
  }

  /**
   * Like request(), but also hands back the request id so the caller can later cancel(id) it.
   * Used by interactive-while-typing requests (completion): a newer keystroke obsoletes the
   * in-flight request, and cancelling it stops the server churning through a stale backlog.
   */
  requestId<T>(method: string, params: unknown, timeoutMs = 15000): { id: number; promise: Promise<T> } {
    if (this.dead) return { id: -1, promise: Promise.reject(this.dead) }
    const id = this.nextId++
    this.write({ jsonrpc: '2.0', id, method, params })
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP 요청 시간 초과: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    })
    return { id, promise }
  }

  /**
   * Abandon an in-flight request: tell the server to stop ($/cancelRequest) and settle our
   * pending entry as null (a cancelled completion is "no result", not an error). A late
   * response then finds no pending entry and is dropped. No-op for an invalid/settled id.
   */
  cancel(id: number): void {
    if (id < 0) return
    const p = this.pending.get(id)
    if (p) {
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.resolve(null)
    }
    if (!this.dead) this.notify('$/cancelRequest', { id })
  }

  notify(method: string, params: unknown): void {
    if (this.dead) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Rejects everything in flight; later calls fail fast. */
  dispose(reason: string): void {
    if (this.dead) return
    this.dead = new Error(reason)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(this.dead)
    }
    this.pending.clear()
  }

  private write(msg: Record<string, unknown>): void {
    try {
      const body = Buffer.from(JSON.stringify(msg), 'utf8')
      this.child.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`)
      this.child.stdin?.write(body)
    } catch {
      /* a dying process closes stdin — requests then fail by timeout/dispose */
    }
  }

  private feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n')
      if (sep < 0) return
      const header = this.buf.subarray(0, sep).toString('ascii')
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) {
        this.buf = this.buf.subarray(sep + 4)
        continue
      }
      const len = parseInt(m[1], 10)
      const end = sep + 4 + len
      if (this.buf.length < end) return
      const body = this.buf.subarray(sep + 4, end).toString('utf8')
      this.buf = this.buf.subarray(end)
      try {
        this.dispatch(JSON.parse(body) as RpcMessage)
      } catch {
        /* malformed frame — skip it */
      }
    }
  }

  private dispatch(msg: RpcMessage): void {
    if (msg.method && msg.id != null) {
      // server → client request: always answer, or the server may stall waiting
      Promise.resolve()
        .then(() => this.onRequest(msg.method!, msg.params))
        .then(
          (result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null }),
          (e) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } })
        )
      return
    }
    if (msg.method) {
      // notification (diagnostics, logs, progress, projectInitializationComplete)
      try {
        this.onNotify(msg.method, msg.params)
      } catch {
        /* observer must not break the read loop */
      }
      return
    }
    if (msg.id == null) return
    const p = this.pending.get(Number(msg.id))
    if (!p) return
    this.pending.delete(Number(msg.id))
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(msg.error.message || 'LSP 오류'))
    else p.resolve(msg.result)
  }
}
