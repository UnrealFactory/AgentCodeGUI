import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useSyncExternalStore } from 'react'
import { EXTERNAL_CONTEXT_MAX_BYTES, type ExternalContextItem, type ExternalContextSnapshot } from '@shared/externalTools'
import { t } from '../lib/i18n'

export interface ExternalBinding {
  chatId: string
  enabled: boolean
  includeSelection: boolean
}
export interface ExternalClient {
  id: string
  manifest: { id: string; name: string; instanceId: string; version: string; icon: string; description?: unknown }
  document: { items: ExternalContextItem[]; state: unknown }
  bindings: ExternalBinding[]
  online: boolean
  revision: number
}
export type ExternalSessionClient = ExternalClient & ExternalBinding
export interface BridgeSnapshot {
  protocolVersion: number
  version: number
  url: string | null
  discoveryPath?: string
  error?: string | null
  clients: ExternalClient[]
}
export async function bridgeCall<T>(operation: string, argument: Record<string, unknown> = {}): Promise<T> {
  const value = await invoke('ipc_call', { channel: `bridge:${operation}`, payload: [argument] }) as { ok?: boolean; error?: string; __unimplemented?: boolean } | null
  if (!value || value.__unimplemented || value.ok === false) throw new Error(value?.error || t('외부 도구 연결을 사용할 수 없습니다.', 'External tool connections are unavailable.'))
  return value as T
}

let snapshot: BridgeSnapshot = { protocolVersion: 1, version: 0, url: null, clients: [] }
const subscribers = new Set<() => void>()
const addresses = new Map<string, number>()
const resolved = new Map<string, string>()
const resolving = new Set<string>()
const captureErrors = new Map<string, string>()
let storeVersion = 0
let stop: (() => void) | undefined
let refreshing = false
let again = false
function notify(): void { storeVersion++; for (const fn of subscribers) fn() }

async function resolveAddress(address: string): Promise<void> {
  if (resolving.has(address)) return
  resolving.add(address)
  try {
    const value = await bridgeCall<{ chatId: string }>('resolve-chat', { address })
    if (resolved.get(address) !== value.chatId) { resolved.set(address, value.chatId); notify() }
  } catch { /* A starting/recovering window will try again on the next refresh. */ }
  finally { resolving.delete(address) }
}

async function refresh(): Promise<void> {
  if (refreshing) { again = true; return }
  refreshing = true
  try {
    const next = await bridgeCall<BridgeSnapshot & { unchanged?: boolean }>('snapshot', { version: snapshot.version })
    if (!next.unchanged && next.version >= snapshot.version) { snapshot = next; captureErrors.clear(); notify() }
    // A chat can move to another panel without changing the panel address.
    await Promise.allSettled([...addresses.keys()].map(resolveAddress))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (snapshot.error !== message) { snapshot = { ...snapshot, version: 0, error: message }; notify() }
  } finally {
    refreshing = false
    if (again && subscribers.size) { again = false; void refresh() }
  }
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  if (subscribers.size === 1) {
    let dead = false
    const offs: (() => void)[] = []
    let debounce: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      if (debounce) return
      debounce = setTimeout(() => { debounce = undefined; void refresh() }, 70)
    }
    for (const channel of ['bridge:changed', 'chat:windows', 'chat:status']) {
      void listen(channel, schedule).then(off => { if (dead) off(); else { offs.push(off); schedule() } }).catch(schedule)
    }
    const timer = setInterval(schedule, 3000)
    stop = () => { dead = true; offs.forEach(off => off()); clearInterval(timer); clearTimeout(debounce) }
    void refresh()
  }
  return () => { subscribers.delete(fn); if (!subscribers.size) { stop?.(); stop = undefined } }
}

function clientsForChat(chatId: string): ExternalSessionClient[] {
  if (!chatId) return []
  return snapshot.clients.flatMap(client => {
    const binding = client.bindings.find(b => b.chatId === chatId)
    return binding ? [{ ...client, ...binding }] : []
  })
}

export function useExternalSession(address?: string) {
  useSyncExternalStore(subscribe, () => storeVersion)
  useEffect(() => {
    if (!address) return
    addresses.set(address, (addresses.get(address) || 0) + 1)
    void resolveAddress(address)
    return () => { const count = (addresses.get(address) || 1) - 1; if (count) addresses.set(address, count); else addresses.delete(address) }
  }, [address])
  const chatId = address ? resolved.get(address) || (!address.includes('::') ? address : '') : ''
  const clients = clientsForChat(chatId)
  return { snapshot, chatId, clients, captureError: captureErrors.get(address || '') }
}

/** Freeze exactly what the session's context tray currently displays. A queued
 * request keeps this snapshot even when a tool, draft, or active session changes. */
export function captureExternalContext(address: string): ExternalContextSnapshot | null | false {
  try {
    const chatId = resolved.get(address) || (!address.includes('::') ? address : '')
    if (!chatId) {
      if (snapshot.clients.some(c => c.online && c.bindings.some(b => b.enabled))) throw new Error(t('세션 연결을 확인하고 있어요. 잠시 후 다시 보내주세요.', 'The session connection is still being checked. Try again shortly.'))
      return null
    }
    const clients = clientsForChat(chatId).filter(c => c.enabled && c.online)
    if (!clients.length) return null
    if (snapshot.error) throw new Error(snapshot.error)
    const value: ExternalContextSnapshot = {
      protocolVersion: 1, chatId, capturedAt: Date.now(),
      sources: clients.map(c => ({ clientId: c.id, toolId: c.manifest.id, name: c.manifest.name, icon: c.manifest.icon,
        revision: c.revision, items: c.includeSelection ? c.document.items : [], state: c.document.state }))
    }
    const encoded = JSON.stringify(value)
    if (new TextEncoder().encode(encoded).length > EXTERNAL_CONTEXT_MAX_BYTES) throw new Error(t('전달할 내용이 너무 큽니다. 선택 범위를 줄이거나 쓰지 않는 도구를 꺼주세요. (최대 96KB)', 'The context is too large. Select a smaller portion or turn off an unused tool. (96 KiB maximum)'))
    captureErrors.delete(address)
    return JSON.parse(encoded) as ExternalContextSnapshot
  } catch (e) {
    captureErrors.set(address, e instanceof Error ? e.message : String(e)); notify()
    return false
  }
}

export async function updateExternalTool(operation: string, argument: Record<string, unknown>): Promise<void> {
  await bridgeCall(operation, argument)
  const next = await bridgeCall<BridgeSnapshot>('snapshot')
  if (next.version >= snapshot.version) { snapshot = next; captureErrors.clear(); notify() }
}
