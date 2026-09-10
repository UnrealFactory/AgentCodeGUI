import { useEffect, useId, useRef, useState } from 'react'
import { externalContextSnapshot, type ExternalContextSnapshot } from '@shared/externalTools'
import { updateExternalTool, useExternalSession, type ExternalClient } from '../api/bridge'
import { t, useLang } from '../lib/i18n'
import { ExternalToolIcon } from './ExternalToolIcon'
import { HeaderPopover } from './HeaderPopover'
import { IconChevDown, IconPlug, IconPlus, IconX2 } from './icons'
import './externalTools.css'

const pretty = (value: unknown): string => JSON.stringify(value ?? null, null, 2)
const toolDescription = (client: ExternalClient): string => typeof client.manifest.description === 'string' ? client.manifest.description : ''
const selectionLabel = (client: ExternalClient): string => {
  const item = client.document.items[0]
  const title = item?.title.trim() || ''
  const detail = item?.kind.startsWith('code/') ? title.replace(/\s*:\s*(\d+)\s*[–—-]\s*(\d+)$/, ' $1:$2') : title
  return detail ? `${client.manifest.name} - ${detail}` : client.manifest.name
}

/** The header owns connection management; context stays beside the composer. */
export function ExternalToolChip({ address, onOpen }: { address?: string; onOpen?: () => void }) {
  useLang()
  const { snapshot, chatId, clients } = useExternalSession(address)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const anchor = useRef<HTMLButtonElement>(null)
  const enabled = clients.filter(c => c.enabled && c.online)
  const first = enabled[0] || clients[0]
  const available = snapshot.clients.filter(c => !c.bindings.some(b => b.chatId === chatId) && c.online)
  useEffect(() => { setOpen(false); setError('') }, [address])
  const act = async (clientId: string, operation: string, args: Record<string, unknown>): Promise<void> => {
    setPending(clientId); setError('')
    try { await updateExternalTool(operation, { clientId, address, ...args }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setPending('') }
  }
  return <span className="hfold external-chip" onMouseDown={e => e.stopPropagation()}>
    <button ref={anchor} type="button" className={`ma-p-folder ext-chip${open ? ' on' : ' has-tip'}`}
      data-tip={t(`이 세션의 외부 도구 · ${enabled.length}개 사용 중`, `External tools in this session · ${enabled.length} active`)}
      aria-label={t('외부 도구 연결', 'External tool connections')} aria-expanded={open}
      onClick={() => { if (!open) onOpen?.(); setOpen(v => !v) }}>
      {first ? <ExternalToolIcon icon={first.manifest.icon} size={12} /> : <IconPlug size={12} />}
      <span className="ext-chip-name">{first?.manifest.name || t('도구 연결', 'Connect tools')}</span>
      {clients.length > 1 && <span className="ext-chip-count">+{clients.length - 1}</span>}
      {clients.length > 0 && <i className={`ext-dot${enabled.length ? ' on' : ''}`} />}
      <IconChevDown size={10} />
    </button>
    {open && <HeaderPopover anchor={anchor} onClose={() => setOpen(false)} className="ext-popover" width={332} maxHeight={420} label={t('이 세션의 외부 도구', 'External tools in this session')}>
      <header className="ext-pop-head"><span>{t('이 세션의 연결', 'Session connections')}</span><small>{t(`${enabled.length}개 사용 중`, `${enabled.length} active`)}</small></header>
      <div className="ext-pop-body">
        {clients.map(client => <div className={`ext-tool-row${!client.enabled ? ' off' : ''}`} key={client.id} data-client-id={client.id}>
          <ExternalToolIcon icon={client.manifest.icon} size={16} />
          <div className="ext-tool-name"><strong>{client.manifest.name}</strong><small>{!client.online ? t('연결 끊김 · 도구 실행 시 다시 연결', 'Offline · reconnects when the tool starts') : !client.enabled ? t('사용 중지 · 연결 유지', 'Paused · connection retained') : t('선택 내용과 상태를 함께 사용', 'Selection and tool state connected')}</small></div>
          <button type="button" className={`sw2 ext-switch${client.enabled ? ' on' : ''}`} role="switch" aria-checked={client.enabled}
            aria-label={t(`${client.manifest.name} 사용`, `Use ${client.manifest.name}`)} disabled={!!pending}
            onClick={() => { void act(client.id, 'set-enabled', { enabled: !client.enabled }) }} />
          <button type="button" className="ext-remove has-tip" data-tip={t('이 세션에서 연결 해제', 'Disconnect from this session')} aria-label={t(`${client.manifest.name} 연결 해제`, `Disconnect ${client.manifest.name}`)} disabled={!!pending}
            onClick={() => { void act(client.id, 'disconnect', {}) }}><IconX2 size={12} /></button>
        </div>)}
        {!clients.length && <div className="ext-empty"><IconPlug size={20} /><strong>{t('작업할 도구를 연결하세요', 'Connect a tool to your session')}</strong><p>{t('도구에서 선택한 내용과 현재 상태를 이 대화에서 함께 사용합니다.', 'Use your tool’s selection and current state in this conversation.')}</p></div>}
        {available.length > 0 && <><div className="ext-section-label">{t('연결 가능한 도구', 'Available tools')}</div>{available.map(client => <div className="ext-tool-row available" key={client.id} data-client-id={client.id}>
          <ExternalToolIcon icon={client.manifest.icon} size={16} /><div className="ext-tool-name"><strong>{client.manifest.name}</strong><small>{client.bindings.length ? t(`다른 ${client.bindings.length}개 세션에 연결됨`, `Connected to ${client.bindings.length} other sessions`) : toolDescription(client) || t('연결 준비됨', 'Ready to connect')}</small></div>
          <button type="button" className="ext-connect-button" disabled={!chatId || !!pending} onClick={() => { void act(client.id, 'bind', { address }) }}>
            <IconPlus size={11} />{t('연결', 'Connect')}
          </button></div>)}</>}
        {(error || snapshot.error) && <p className="ext-error" role="alert">{error || snapshot.error}</p>}
      </div>
    </HeaderPopover>}
  </span>
}

export function ExternalContextTray({ address }: { address?: string }) {
  const { clients, captureError } = useExternalSession(address)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const active = clients.filter(c => c.enabled && c.online)
  useEffect(() => { setExpanded(null); setError(''); setPending(null) }, [address])
  const toggleInclude = async (client: typeof clients[number]): Promise<void> => {
    setPending(client.id); setError('')
    try { await updateExternalTool('set-include', { clientId: client.id, address, includeSelection: !client.includeSelection }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setPending(null) }
  }
  if (!clients.length && !captureError) return null
  return <div className="external-context-tray">
    {active.length ? active.map(client => <div className="ext-context-source" key={client.id} data-client-id={client.id}>
      <div className="ext-context-row">
        <button type="button" className="ext-context-summary" aria-expanded={expanded === client.id} onClick={() => setExpanded(v => v === client.id ? null : client.id)}>
          <ExternalToolIcon icon={client.manifest.icon} size={13} />
          <span className="ext-context-label">{selectionLabel(client)}</span>
          {client.document.items.length > 1 && <small>+{client.document.items.length - 1}</small>}
        </button>
        {client.document.items.length > 0 && <button type="button" role="switch" className={`ext-include${client.includeSelection ? ' on' : ''}`}
          aria-checked={client.includeSelection} aria-label={t(`${client.manifest.name} 선택 내용 다음 메시지에 포함`, `Include ${client.manifest.name} selection in the next message`)}
          disabled={pending !== null} onClick={() => { void toggleInclude(client) }}>
          <span>{t('다음 메시지에 포함', 'Include in next message')}</span><span className={`sw2 ext-include-switch${client.includeSelection ? ' on' : ''}`} aria-hidden="true" />
        </button>}
      </div>
      {expanded === client.id && <div className="ext-context-preview">
        {client.document.items.map(item => <div key={item.id}><div className="ext-preview-title">{item.title}<small>{item.kind}</small></div><pre>{item.text ?? pretty(item.data)}</pre></div>)}
        {client.document.state != null && <details><summary>{t('함께 전달할 도구 상태', 'Tool state included with the message')}</summary><pre>{pretty(client.document.state)}</pre></details>}
      </div>}
    </div>) : <div className="ext-context-idle"><IconPlug size={12} />{clients.some(c => c.enabled) ? t('연결된 도구의 응답을 기다리는 중', 'Waiting for the connected tool') : t('연결된 도구가 꺼져 있어요', 'Connected tools are turned off')}</div>}
    {(error || captureError) && <p className="ext-error" role="alert">{error || captureError}</p>}
  </div>
}

/** Immutable metadata is part of the sent message, including restored/echoed turns. */
export function ExternalContextAttachments({ capture }: { capture?: ExternalContextSnapshot }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const detailId = useId()
  capture = externalContextSnapshot(capture)
  if (!capture || !capture.sources.length) return null
  const toggle = (clientId: string): void => setExpanded(current => {
    const next = new Set(current)
    if (next.has(clientId)) next.delete(clientId)
    else next.add(clientId)
    return next
  })
  return <div className="ext-sent-context">
    <div className="ext-sent-chips">
      {capture.sources.map((source, index) => <button type="button" className="ext-sent-chip" key={source.clientId}
        aria-expanded={expanded.has(source.clientId)} aria-controls={`${detailId}-${index}`} onClick={() => toggle(source.clientId)}>
        <ExternalToolIcon icon={source.icon} size={12} /><span>{source.name}</span><small>{source.items.length ? source.items[0].title : t('도구 상태', 'Tool state')}</small>
      </button>)}
    </div>
    {capture.sources.map((source, index) => expanded.has(source.clientId) && <div className="ext-sent-detail" id={`${detailId}-${index}`} key={source.clientId}>
      <div className="ext-sent-detail-heading"><strong>{source.name}</strong><span>{t('이 메시지를 보낼 때의 내용', 'Snapshot captured for this message')}</span></div>
      {source.items.map(item => <div key={item.id}><div className="ext-preview-title">{item.title}</div><pre>{item.text ?? pretty(item.data)}</pre></div>)}
      {source.state != null && <details open={!source.items.length}><summary>{t('함께 전달한 도구 상태', 'Tool state included with the message')}</summary><pre>{pretty(source.state)}</pre></details>}
    </div>)}
  </div>
}
