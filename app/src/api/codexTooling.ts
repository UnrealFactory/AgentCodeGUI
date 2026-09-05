import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import type { ChatTooling, McpLive, SkillLive } from '@shared/protocol'

export interface CodexToolingContext {
  cwd: string
  account?: string | null
  apiMode?: boolean
}
export interface CodexTooling extends ChatTooling {
  engine: 'codex'
  account: string | null
  apiMode: boolean
  mcp: (McpLive & { scope?: 'local' | 'global'; configKey?: string })[]
  skills: (SkillLive & { path: string })[]
  errors: string[]
}
const cache = new Map<string, { at: number; promise: Promise<CodexTooling> }>()
function key(c: CodexToolingContext): string {
  return JSON.stringify([c.cwd, c.account ?? null, !!c.apiMode])
}
async function call<T>(channel: string, args: unknown): Promise<T> {
  const result = await invoke<T & { error?: string; __unimplemented?: boolean }>('ipc_call', { channel, payload: [args] })
  if (result.error || result.__unimplemented) throw new Error(result.error || 'This app version does not support Codex tooling')
  return result
}
export function getCodexTooling(context: CodexToolingContext, fresh = false): Promise<CodexTooling> {
  const k = key(context)
  const prev = cache.get(k)
  if (!fresh && prev && Date.now() - prev.at < 30_000) return prev.promise
  const promise = call<CodexTooling>('codex:tooling', context)
  cache.set(k, { at: Date.now(), promise })
  void promise.catch(() => { if (cache.get(k)?.promise === promise) cache.delete(k) })
  return promise
}
export async function setCodexToolEnabled(context: CodexToolingContext, kind: 'mcp' | 'skill', name: string, enabled: boolean): Promise<void> {
  await call('codex:tooling-set-enabled', { ...context, kind, name, enabled })
  cache.clear()
}
export function useCodexTooling(context: CodexToolingContext, active: boolean) {
  const [state, setState] = useState<{ key: string; data?: CodexTooling; error?: string; loading: boolean }>({ key: '', loading: false })
  const [revision, setRevision] = useState(0)
  const k = key(context)
  useEffect(() => {
    let dead = false
    const off = listen('codex:tooling-changed', () => {
      cache.clear()
      if (!dead) setRevision(v => v + 1)
    })
    return () => { dead = true; void off.then(f => f()) }
  }, [])
  useEffect(() => {
    if (!active) return
    let alive = true
    setState({ key: k, loading: true })
    void getCodexTooling(context).then(data => {
      if (alive) setState({ key: k, data, loading: false })
    }).catch(error => {
      if (alive) setState({ key: k, error: String(error), loading: false })
    })
    return () => { alive = false }
  }, [k, active, revision])
  return { ...(state.key === k ? state : { data: undefined, error: undefined, loading: active }), refresh: () => {
    cache.delete(k)
    setRevision(v => v + 1)
  } }
}
