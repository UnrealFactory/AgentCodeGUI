import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface WebSubscription {
  provider: 'claude' | 'codex'
  email: string
  connected: boolean
  phase: 'idle' | 'queued' | 'connecting' | 'refreshing' | 'wrongAccount'
  error: string | null
  data: { kind: 'renews' | 'cancels' | 'ended' | 'paused' | 'trial' | 'scheduled' | 'active' | 'none' | 'unknown' | 'paymentDue'; date: string | null; checkedAt: number } | null
}
let snapshot: WebSubscription[] = []
let flight: Promise<void> | null = null
let reload = false
let refreshAfterFlight = false
let generation = 0
let listener: Promise<UnlistenFn> | null = null
const subscribers = new Set<() => void>()

async function load(refresh = false): Promise<void> {
  if (flight) { reload = true; refreshAfterFlight ||= refresh; return flight }
  flight = invoke<WebSubscription[]>('ipc_call', { channel: 'subscriptions:list', payload: [{ refresh }] })
    .then(rows => { if (Array.isArray(rows)) { snapshot = rows; subscribers.forEach(f => f()) } })
    .catch(() => {})
    .finally(() => {
      flight = null
      if (reload) { const refresh = refreshAfterFlight; reload = false; refreshAfterFlight = false; void load(refresh) }
    })
  return flight
}
function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  if (subscribers.size === 1) {
    const current = ++generation
    listener = listen('subscriptions:updated', () => { void load() })
    void listener.then(() => { if (generation === current) void load(true) }).catch(() => { void load(true) })
  }
  return () => {
    subscribers.delete(fn)
    if (!subscribers.size) {
      generation++
      void listener?.then(stop => stop()).catch(() => {})
      listener = null
    }
  }
}
export function useWebSubscription(provider: WebSubscription['provider'], email: string): WebSubscription | undefined {
  const rows = useSyncExternalStore(subscribe, () => snapshot)
  return rows.find(r => r.provider === provider && r.email === email)
}
export async function subscriptionAction(action: 'connect' | 'refresh' | 'cancel' | 'disconnect', provider: WebSubscription['provider'], email: string): Promise<void> {
  const result = await invoke<WebSubscription | { error: string }>('ipc_call', { channel: `subscriptions:${action}`, payload: [{ provider, email }] })
  if (!('provider' in result)) throw new Error(result.error || 'unavailable')
  await load()
}
