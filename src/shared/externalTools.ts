/** External Tools v1. Open data vocabulary, independent of an editor or engine. */
export interface ExternalContextItem {
  id: string
  kind: string
  title: string
  text?: string
  data?: unknown
  [key: string]: unknown
}

export interface ExternalContextSource {
  clientId: string
  toolId: string
  name: string
  icon: string
  revision: number
  items: ExternalContextItem[]
  state: unknown
}

/** Frozen at Send/Queue time for both the visible attachment and engine input. */
export interface ExternalContextSnapshot {
  protocolVersion: 1
  chatId: string
  capturedAt: number
  sources: ExternalContextSource[]
}

export const EXTERNAL_CONTEXT_MAX_BYTES = 96 * 1024

/** Older or damaged chat files must not make attachment rendering throw. */
export function externalContextSnapshot(value: unknown): ExternalContextSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Partial<ExternalContextSnapshot>
  if (v.protocolVersion !== 1 || typeof v.chatId !== 'string' || typeof v.capturedAt !== 'number' || !Array.isArray(v.sources) || v.sources.length > 32) return undefined
  if (!v.sources.every(s => s && typeof s.clientId === 'string' && typeof s.name === 'string' && typeof s.toolId === 'string'
    && Array.isArray(s.items) && s.items.length <= 32 && s.items.every(i => i && typeof i.id === 'string' && typeof i.title === 'string' && typeof i.kind === 'string'))) return undefined
  return value as ExternalContextSnapshot
}
