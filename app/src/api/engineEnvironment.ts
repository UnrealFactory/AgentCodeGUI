import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { EngineId } from '@shared/protocol'

export interface EngineEnvironment {
  mode: 'managed' | 'system'
  cliPath: string
  configDir: string
}
export interface EngineEnvironmentView extends EngineEnvironment {
  activeMode: 'managed' | 'system'
  detectedCliPath: string | null
  detectedConfigDir: string
  resolvedCliPath: string | null
  resolvedConfigDir: string
  error: string | null
  detectionError: string | null
  restartRequired: boolean
}
export interface EngineEnvironments {
  claude: EngineEnvironmentView
  codex: EngineEnvironmentView
  restartRequired: boolean
}
let snapshot: EngineEnvironments | null = null
let pending: Promise<EngineEnvironments> | null = null
const subscribers = new Set<() => void>()
function publish(next: EngineEnvironments): EngineEnvironments {
  snapshot = next
  subscribers.forEach(fn => fn())
  return next
}
async function call(channel: string, payload: unknown[]): Promise<EngineEnvironments> {
  const result = await invoke<EngineEnvironments & { error?: string; __unimplemented?: boolean }>('ipc_call', { channel, payload })
  if (result.error || result.__unimplemented) throw new Error(result.error || 'Execution environment settings are unavailable')
  return publish(result)
}
export function loadEngineEnvironments(fresh = false): Promise<EngineEnvironments> {
  if (!fresh && snapshot) return Promise.resolve(snapshot)
  if (pending) return pending
  pending = call('engine-environment:get', []).finally(() => { pending = null })
  return pending
}
export function saveEngineEnvironment(engine: EngineId, environment: EngineEnvironment): Promise<EngineEnvironments> {
  return call('engine-environment:save', [{ engine, environment }])
}
export async function pickEngineEnvironmentPath(kind: 'cliPath' | 'configDir', defaultPath: string): Promise<string | null> {
  const result = await invoke<string | null | { error?: string }>('ipc_call', {
    channel: 'engine-environment:pick-path', payload: [{ kind, defaultPath }]
  })
  if (result === null || typeof result === 'string') return result
  throw new Error(result.error || 'Path selection is unavailable')
}
function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}
export function useEngineEnvironments(): EngineEnvironments | null {
  return useSyncExternalStore(subscribe, () => snapshot)
}
export function systemEnvironment(engine: EngineId): boolean {
  return snapshot?.[engine].activeMode === 'system'
}
