import type { EngineEvent, EngineEventV3 } from './protocol'

export interface ConnectionRetry {
  phase: 'retry' | 'fallback'
  attempt?: number
  maxAttempts?: number
}

export interface DiagnosticLog {
  group: 'connection' | 'stderr'
  runId?: string
  state: 'active' | 'resumed' | 'history'
  entries: { text: string; time: string; count: number }[]
  total: number
  omitted: number
}

interface ThreadNode {
  kind: string
  id: string
  role?: string
  text?: string
  time?: string
  diagnostics?: DiagnosticLog
  action?: string
  silent?: boolean
}

// These are engine-owned notice formats, never arbitrary warnings or chat text.
// Also recognize old snapshots so an upgrade folds their accumulated notices.
export function classifyDiagnostic(text: string): { group: DiagnosticLog['group']; retry?: ConnectionRetry } | null {
  if (/^\[stderr\]/.test(text)) return { group: 'stderr' }
  if (!/^Codex: /.test(text)) return null
  if (/^Codex: Falling back from WebSockets to HTTPS transport\b/i.test(text))
    return { group: 'connection', retry: { phase: 'fallback' } }
  const attempt = /^Codex: Reconnecting\.{0,3}\s+(\d+)\/(\d+)\b/i.exec(text)
  if (attempt || / — (?:다시 시도하는 중이에요\.|retrying\.)$/.test(text))
    return { group: 'connection', retry: { phase: 'retry', ...(attempt ? { attempt: +attempt[1], maxAttempts: +attempt[2] } : {}) } }
  return null
}

// Bounded independently of the 500-item thread limit. Repeated adjacent lines use
// a counter; old distinct entries beyond the limit are explicitly counted below.
export const DIAGNOSTIC_ENTRY_LIMIT = 100
function addEntry(log: DiagnosticLog, text: string, time: string): DiagnosticLog {
  const entries = log.entries.slice()
  const last = entries[entries.length - 1]
  if (last?.text === text) entries[entries.length - 1] = { ...last, time, count: last.count + 1 }
  else entries.push({ text, time, count: 1 })
  let omitted = log.omitted
  while (entries.length > DIAGNOSTIC_ENTRY_LIMIT) omitted += entries.shift()!.count
  return { ...log, entries, total: log.total + 1, omitted }
}

export function appendDiagnostic<T extends ThreadNode>(
  messages: T[], item: T & { text: string; time: string }, group: DiagnosticLog['group'], runId?: string, active = false
): T[] {
  const next = messages.slice()
  for (let i = next.length - 1; i >= 0; i--) {
    const prior = next[i]
    if (prior.kind === 'msg' && prior.role === 'user') break
    const log = prior.diagnostics
    if (log?.group !== group || log.runId !== runId) continue
    next[i] = { ...prior, diagnostics: addEntry({ ...log, state: active ? 'active' : log.state }, item.text, item.time) }
    return next
  }
  return [...next, { ...item, text: '', diagnostics: addEntry({
    group, runId, state: active ? 'active' : 'history', entries: [], total: 0, omitted: 0
  }, item.text, item.time) }]
}

export function settleDiagnostics<T extends ThreadNode>(messages: T[], state: 'resumed' | 'history'): T[] {
  let changed = false
  const next = messages.map((m) => {
    if (m.diagnostics?.state !== 'active') return m
    changed = true
    return { ...m, diagnostics: { ...m.diagnostics, state } }
  })
  return changed ? next : messages
}

export function clearRetryState<T extends ThreadNode, S extends { messages: T[]; connectionRetry?: ConnectionRetry | null; apiRetry?: unknown }>(
  state: S, outcome: 'resumed' | 'history'
): S {
  if (!state.connectionRetry && !state.apiRetry) return state
  return { ...state, connectionRetry: null, apiRetry: null, messages: settleDiagnostics(state.messages, outcome) }
}

// Status heartbeats, child tools and previous tool completions are not evidence
// that the main model request has recovered. Check the run boundary before use.
export function retryOutcome(e: EngineEvent | EngineEventV3): 'resumed' | 'history' | null {
  switch (e.type) {
    case 'thinking': case 'assistant-done': return e.text.trim() ? 'resumed' : null
    case 'assistant-stream': return e.delta.trim() ? 'resumed' : null
    case 'tool-start': return e.tool.parentToolId ? null : 'resumed'
    case 'permission-request': case 'question-request': return 'resumed'
    case 'result': case 'error': return 'history'
    case 'status': return ['done', 'error', 'idle'].includes(e.status) ? 'history' : null
    default: return null
  }
}

export function restoreDiagnostics<T extends ThreadNode>(messages: T[]): T[] {
  let next: T[] = []
  // Old notices have no runId; give each persisted turn a separate grouping key.
  let turn = 0
  for (const m of messages) {
    if ((m.kind === 'msg' && m.role === 'user') || m.kind === 'worked' || m.kind === 'interrupted') turn++
    if (m.kind !== 'notice' || m.action || m.silent) { next.push(m); continue }
    const log = m.diagnostics
    if (log && (log.group === 'connection' || log.group === 'stderr') && Array.isArray(log.entries)) {
      const entries = log.entries.filter((e) => e && typeof e.text === 'string' && typeof e.time === 'string')
        .map((e) => ({ ...e, count: Number.isSafeInteger(e.count) && e.count > 0 ? e.count : 1 }))
      const dropped = entries.slice(0, -DIAGNOSTIC_ENTRY_LIMIT).reduce((n, e) => n + e.count, 0)
      const omitted = (Number.isSafeInteger(log.omitted) && log.omitted >= 0 ? log.omitted : 0) + dropped
      const kept = entries.slice(-DIAGNOSTIC_ENTRY_LIMIT)
      next.push({ ...m, diagnostics: { ...log, entries: kept, omitted, total: omitted + kept.reduce((n, e) => n + e.count, 0), state: log.state === 'resumed' ? 'resumed' : 'history' } })
      continue
    }
    const match = typeof m.text === 'string' ? classifyDiagnostic(m.text) : null
    if (match) next = appendDiagnostic(next, { ...m, text: m.text!, time: m.time ?? '' }, match.group, `restored-${turn}`)
    else next.push({ ...m, diagnostics: undefined })
  }
  return next
}
