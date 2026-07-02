import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AppUser, AgentStatus, UsageInfo, MultiRunRequest, EngineEvent, SkillInfo } from '@shared/protocol'
import {
  useAgentSession,
  initialSessionState,
  snapshotForPersist,
  sameCwd,
  commandOf,
  commandTitleOf,
  type SessionState
} from '../store/session'
import {
  MessageView,
  WorkingIndicator,
  RunPickers,
  PermissionModal,
  QuestionModal,
  SelectionToolbar,
  windowTokensFor,
  fmtTok,
  fmtWindow,
  SLASH_COMMANDS,
  pickerModelOf,
  type PickerState,
  type ScheduledMsg
} from './Chat'
import { Sidebar, type ChatSummary, type WorkspaceMode } from './Sidebar'
import { FolderSwitchDialog } from './FolderSwitchDialog'
import { PromptModal } from './PromptModal'
import { PanelFolderMenu } from './PanelFolderMenu'
import { FileModal } from './FileModal'
import { imageSrc, imageName, filesToImagePaths } from '../lib/images'
import { mentionAtCaret, mentionEntries, extractMentions, type MentionEntry } from '../lib/mentions'
import { FileBadge } from './fileType'
import {
  IconGrid,
  IconSend,
  IconClock,
  IconClose,
  IconExpand,
  IconFolder,
  IconChevDown,
  IconChevRight,
  IconCode,
  IconImage,
  IconX2,
  IconBook,
  IconSearch,
  IconSpark
} from './icons'

// the "/" palette in a panel: the same built-in commands as single mode, minus /ask
// (a single-mode side conversation that has no place inside a panel)
const PANEL_SLASH_COMMANDS = SLASH_COMMANDS.filter((c) => c.name !== 'ask')

// A multi-agent SESSION is a group of N panels that work together. The recent-tasks
// list shows one entry per session (not per panel); "새 작업" opens a fresh session and
// the panels are part of it. Each session owns SLOT_COUNT panels, each an independent
// Claude Code engine addressed by `${sessionId}::${slot}` — unique per session, so two
// sessions never collide on the shared event channel, and a session's runs keep going
// in the background after you switch away (events resync when you come back).
const SLOT_COUNT = 6
const SLOTS = [0, 1, 2, 3, 4, 5]

// grid columns per visible-panel count (matches the reference layouts: 4 → 2×2, 6 → 3×2)
const COLS: Record<number, number> = { 2: 2, 3: 3, 4: 2, 5: 3, 6: 3 }
const COUNT_OPTIONS = [2, 3, 4, 5, 6]

const STATUS_META: Record<AgentStatus, { label: string; cls: string }> = {
  idle: { label: '대기', cls: 'idle' },
  analyzing: { label: '분석 중', cls: 'analyzing' },
  working: { label: '작업 중', cls: 'working' },
  done: { label: '완료', cls: 'done' },
  error: { label: '오류', cls: 'error' }
}

// multi-agent panels default to bypass — autonomous parallel work shouldn't stop on
// per-tool approvals across several panels at once (changeable per panel in the picker)
const DEFAULT_PICKER: PickerState = { model: 'opus', effort: 'xhigh', mode: 'bypass' }

const MULTI_VERSION = 2

// one panel's live state within a session (input + images + queue are draft-only, not persisted)
interface PanelMeta {
  title: string
  custom: boolean // user-renamed → keep the title instead of deriving it from the prompt
  cwd: string // this panel's working dir
  picker: PickerState
  input: string
  images: string[] // attached image paths, sent with the next message
  queue: ScheduledMsg[] // messages queued while this panel is busy — auto-sent in order when its run ends
  sysPrompt?: string // 패널별 프롬프트 — 매 실행마다 시스템 프롬프트에 append (없으면 미설정)
}
// what we persist for one panel (its meta + the frozen session thread)
interface PersistedPanel {
  title: string
  custom: boolean
  cwd: string
  picker: PickerState
  snapshot?: SessionState
  sysPrompt?: string
}
// a whole multi-agent session: a title (for the recent list) + its panel layout
interface PersistedSession {
  id: string
  title: string
  custom: boolean
  count: number
  panels: PersistedPanel[] // length SLOT_COUNT
}
interface MultiPersist {
  version: number
  activeSessionId: string
  sessions: PersistedSession[]
}
// the active session's panels reported up for persistence
interface CommitPayload {
  count: number
  panels: PersistedPanel[]
}

function freshPanel(): PanelMeta {
  return { title: '', custom: false, cwd: '', picker: { ...DEFAULT_PICKER }, input: '', images: [], queue: [] }
}
function blankSession(id: string, count = 4): PersistedSession {
  return {
    id,
    title: '',
    custom: false,
    count,
    panels: SLOTS.map(() => ({ title: '', custom: false, cwd: '', picker: { ...DEFAULT_PICKER } }))
  }
}
function clampCount(n: unknown): number {
  const v = typeof n === 'number' ? n : 4
  return Math.max(2, Math.min(SLOT_COUNT, Math.round(v)))
}
function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}
let sessSeq = 0
function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  sessSeq += 1
  return `ms-${sessSeq}-${Date.now().toString(36)}`
}
// the engine/event channel for one panel — unique per (session, slot)
function chan(sessionId: string, slot: number): string {
  return `${sessionId}::${slot}`
}
// aggregate of a session's panel statuses, for the recent-list dot
function aggregateStatus(sts: AgentStatus[]): AgentStatus {
  if (sts.some((s) => s === 'working')) return 'working'
  if (sts.some((s) => s === 'analyzing')) return 'analyzing'
  if (sts.some((s) => s === 'error')) return 'error'
  if (sts.some((s) => s === 'done')) return 'done'
  return 'idle'
}

// stable callback identity that always calls the latest closure (memoized panels skip
// re-render on a sibling's keystroke without stale closures)
function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useRef((...args: A) => ref.current(...args)).current
}
// stable per-panel subscribe (read once by the session hook on mount)
function subFor(channel: string) {
  return (cb: (e: EngineEvent) => void): (() => void) => window.api.multi?.onEvent?.(channel, cb) ?? (() => {})
}

// ── a panel's composer — textarea + "/" command palette + image attachments ───────
function PanelComposer({
  value,
  history,
  images,
  busy,
  cwd,
  onChange,
  onAddImages,
  onRemoveImage,
  onSend,
  onSchedule,
  onStop,
  onFocus
}: {
  value: string
  history: string[] // 이 패널에서 보낸 메시지(오래된→최신) — ↑/↓로 다시 불러오기
  images: string[]
  busy: boolean
  cwd: string // scopes which skills the "/" palette loads
  onChange: (text: string) => void
  onAddImages: (paths: string[]) => void
  onRemoveImage: (i: number) => void
  onSend: () => void
  onSchedule: () => void // queue the current draft while the panel is busy
  onStop: () => void
  onFocus: () => void
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const slashRef = useRef<HTMLDivElement>(null)
  const skillsCwd = useRef<string | null>(null)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [slashIdx, setSlashIdx] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const dragDepth = useRef(0)
  const [dragOver, setDragOver] = useState(false)
  // "@" file mention palette
  const [caret, setCaret] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [mentionIdx, setMentionIdx] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const mentionRef = useRef<HTMLDivElement>(null)
  const filesCwd = useRef<string | null>(null)

  const grow = (el: HTMLTextAreaElement | null): void => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 132) + 'px'
  }

  // ── 보낸 메시지 히스토리 (셸처럼 ↑/↓로 복구) ────────────────────
  // histIdx: 현재 history 위치(null = 직접 작성 중인 초안). histDraft: 탐색을
  // 시작할 때 잠시 보관해 둔 초안 — ↓로 끝까지 내려오면 그대로 되돌린다.
  const [histIdx, setHistIdx] = useState<number | null>(null)
  const histDraft = useRef('')
  const applyHistory = (text: string): void => {
    onChange(text)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      const n = el.value.length
      el.setSelectionRange(n, n)
      setCaret(n)
      grow(el)
    })
  }

  // the leading "/token" being typed (no space yet, not mid-run), else null
  const slashQuery = !busy && value.startsWith('/') && !/\s/.test(value) ? value.slice(1).toLowerCase() : null
  useEffect(() => {
    if (slashQuery === null || skillsCwd.current === cwd) return
    skillsCwd.current = cwd
    window.api.skill
      .list(cwd)
      .then(setSkills)
      .catch(() => setSkills([]))
  }, [slashQuery, cwd])
  useEffect(() => {
    setSlashIdx(0)
    if (slashQuery === null) setSlashDismissed(false)
  }, [slashQuery])

  const cmdHits = slashQuery === null ? [] : PANEL_SLASH_COMMANDS.filter((c) => c.name.includes(slashQuery))
  const skillHits =
    slashQuery === null ? [] : skills.filter((s) => s.enabled && s.name.toLowerCase().includes(slashQuery))
  const slashNames = [...cmdHits.map((c) => c.name), ...skillHits.map((s) => s.name)]
  const slashOpen = slashQuery !== null && !slashDismissed && slashNames.length > 0
  const activeIdx = Math.min(slashIdx, slashNames.length - 1)
  useEffect(() => {
    if (!slashOpen) return
    slashRef.current?.querySelector(`[data-i="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, slashOpen])

  const pickSlash = (name: string): void => {
    onChange('/' + name + ' ')
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      const n = el.value.length
      el.setSelectionRange(n, n)
      grow(el)
    })
  }

  // the "@token" the caret sits in — suppressed while busy or when "/" owns the menu
  const mentionTok = !busy && slashQuery === null ? mentionAtCaret(value, caret) : null
  const mentionActive = mentionTok !== null
  useEffect(() => {
    if (!mentionActive || filesCwd.current === cwd) return
    filesCwd.current = cwd
    window.api
      .listFiles(cwd)
      .then(setFiles)
      .catch(() => setFiles([]))
  }, [mentionActive, cwd])
  useEffect(() => {
    setMentionIdx(0)
    if (!mentionActive) setMentionDismissed(false)
  }, [mentionTok?.query, mentionActive])
  const mention = mentionTok ? mentionEntries(files, mentionTok.query) : null
  const mentionHits = mention?.entries ?? []
  const mentionOpen = mentionActive && !mentionDismissed && mentionHits.length > 0
  const activeMentionIdx = Math.min(mentionIdx, mentionHits.length - 1)
  useEffect(() => {
    if (!mentionOpen) return
    mentionRef.current?.querySelector(`[data-i="${activeMentionIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeMentionIdx, mentionOpen])

  // picking a folder drills in (insert "dir/", palette re-opens deeper); a file commits it
  const pickMention = (entry: MentionEntry): void => {
    const tok = mentionAtCaret(value, caret)
    if (!tok) return
    const before = value.slice(0, tok.start)
    const after = value.slice(tok.end)
    const insert = entry.kind === 'dir' ? '@' + entry.full + '/' : '@' + entry.full + ' '
    const pos = (before + insert).length
    onChange(before + insert + after)
    setCaret(pos)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(pos, pos)
      grow(el)
    })
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIdx((i) => (Math.min(i, mentionHits.length - 1) + 1) % mentionHits.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIdx((i) => (Math.min(i, mentionHits.length - 1) - 1 + mentionHits.length) % mentionHits.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickMention(mentionHits[activeMentionIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionDismissed(true)
        return
      }
    }
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx((i) => (Math.min(i, slashNames.length - 1) + 1) % slashNames.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx((i) => (Math.min(i, slashNames.length - 1) - 1 + slashNames.length) % slashNames.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickSlash(slashNames[activeIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    // 팔레트가 닫혀 있을 때만: ↑/↓로 이 패널에서 보낸 메시지를 셸처럼 다시 불러온다.
    // 커서가 첫 줄/마지막 줄 끝에 있을 때만 가로채서 여러 줄 편집의 줄 이동은 방해하지 않는다.
    if (history.length > 0 && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const pos = e.currentTarget.selectionStart ?? value.length
      const onFirstLine = !value.slice(0, pos).includes('\n')
      const onLastLine = !value.slice(pos).includes('\n')
      if (e.key === 'ArrowUp' && onFirstLine) {
        e.preventDefault()
        if (histIdx === null) histDraft.current = value // 작성 중이던 초안을 잠시 보관
        const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1)
        setHistIdx(next)
        applyHistory(history[next])
        return
      }
      if (e.key === 'ArrowDown' && onLastLine && histIdx !== null) {
        e.preventDefault()
        if (histIdx >= history.length - 1) {
          setHistIdx(null)
          applyHistory(histDraft.current) // 최신보다 더 내려오면 보관해 둔 초안으로 복귀
        } else {
          const next = histIdx + 1
          setHistIdx(next)
          applyHistory(history[next])
        }
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!value.trim() && images.length === 0) return
      setHistIdx(null) // 보내고 나면 히스토리 위치를 초기화
      // while the panel is busy, Enter queues the draft instead of sending it
      if (busy) onSchedule()
      else onSend()
      requestAnimationFrame(() => grow(taRef.current))
    }
  }

  const pickImages = async (): Promise<void> => {
    const paths = await window.api.pickImages()
    if (paths.length) onAddImages(paths)
  }
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const imgs = Array.from(e.clipboardData.files || []).filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    e.preventDefault() // a pasted screenshot becomes an attachment, not pasted text
    const paths = await filesToImagePaths(imgs)
    if (paths.length) onAddImages(paths)
  }
  const dragHasFile = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.items || []).some((it) => it.kind === 'file')
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    dragDepth.current = 0
    setDragOver(false)
    if (!e.dataTransfer.files?.length) return
    e.preventDefault()
    const paths = await filesToImagePaths(e.dataTransfer.files)
    if (paths.length) onAddImages(paths)
  }

  return (
    <div
      className={'ma-p-composer' + (busy ? ' busy' : '') + (dragOver ? ' drag' : '')}
      onDragEnter={(e) => {
        if (!dragHasFile(e)) return
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragOver={(e) => {
        if (!dragHasFile(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="drop-hint">
          <IconImage size={22} />
          <span>이미지를 여기에 놓으세요</span>
        </div>
      )}
      {slashOpen && (
        <div className="slash-menu scroll" ref={slashRef} role="listbox">
          {cmdHits.length > 0 && <div className="slash-sec">명령어</div>}
          {cmdHits.map((c, i) => {
            const Ic = c.icon
            return (
              <button
                key={'cmd:' + c.name}
                data-i={i}
                role="option"
                aria-selected={i === activeIdx}
                className={'slash-opt' + (i === activeIdx ? ' on' : '')}
                onMouseEnter={() => setSlashIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pickSlash(c.name)
                }}
              >
                <span className="slash-ic">
                  <Ic size={15} />
                </span>
                <span className="slash-name">{c.name}</span>
                <span className="slash-desc">{c.desc}</span>
              </button>
            )
          })}
          {skillHits.length > 0 && <div className="slash-sec">스킬</div>}
          {skillHits.map((s, i) => {
            const gi = cmdHits.length + i
            return (
              <button
                key={'skill:' + s.scope + ':' + s.name}
                data-i={gi}
                role="option"
                aria-selected={gi === activeIdx}
                className={'slash-opt' + (gi === activeIdx ? ' on' : '')}
                onMouseEnter={() => setSlashIdx(gi)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pickSlash(s.name)
                }}
              >
                <span className="slash-ic skill">
                  <IconBook size={15} />
                </span>
                <span className="slash-name">{s.name}</span>
                <span className="slash-desc">{s.description || '설명이 없습니다.'}</span>
              </button>
            )
          })}
        </div>
      )}
      {mentionOpen && mention && (
        <div className="slash-menu scroll" ref={mentionRef} role="listbox">
          <div className="slash-sec mention-loc">
            {mention.mode === 'search' ? (
              <>
                <IconSearch size={11} />
                <span>
                  ‘{mention.term}’ 검색{mention.base ? ' · ' + mention.base.replace(/\/$/, '') : ''}
                </span>
              </>
            ) : (
              <>
                <IconFolder size={11} />
                <span>
                  {mention.base ? mention.base.replace(/\/$/, '') : '프로젝트 루트'}
                  {mention.term ? ' · ‘' + mention.term + '’' : ''}
                </span>
              </>
            )}
          </div>
          {mentionHits.map((e, i) => (
            <button
              key={e.kind + ':' + e.full}
              data-i={i}
              role="option"
              aria-selected={i === activeMentionIdx}
              className={'slash-opt' + (i === activeMentionIdx ? ' on' : '')}
              onMouseEnter={() => setMentionIdx(i)}
              onMouseDown={(ev) => {
                ev.preventDefault()
                pickMention(e)
              }}
            >
              {e.kind === 'dir' ? (
                <>
                  <span className="slash-ic folder">
                    <IconFolder size={16} />
                  </span>
                  <span className="slash-name">{e.name}</span>
                  <span className="slash-desc into">
                    <IconChevRight size={15} />
                  </span>
                </>
              ) : (
                <>
                  <span className="slash-ic ft">
                    <FileBadge path={e.full} size={22} />
                  </span>
                  <span className="slash-name path">{e.name}</span>
                  {mention.mode === 'search' && (
                    <span className="slash-desc">{e.dir ? e.dir.replace(/\/$/, '') : '루트'}</span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="img-tray ma-img-tray">
          {images.map((p, i) => (
            <div className="img-thumb" key={p + i}>
              <span className="img-thumb-open">
                <img src={imageSrc(p)} alt={imageName(p)} draggable={false} />
              </span>
              <button className="img-thumb-x has-tip" onClick={() => onRemoveImage(i)} aria-label="제거" data-tip="제거">
                <IconX2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="ma-p-composer-row">
        <button className="ma-attach has-tip" data-tip="이미지 첨부" aria-label="이미지 첨부" onClick={pickImages}>
          <IconImage size={16} />
        </button>
        <textarea
          ref={taRef}
          rows={1}
          placeholder={busy ? '다음 메시지를 예약하세요… (작업 후 자동 전송)' : '메시지…  ( / 명령어 · @ 파일 )'}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setCaret(e.target.selectionStart ?? e.target.value.length)
            grow(e.target)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onFocus={() => {
            onFocus()
            setSlashDismissed(false)
            setMentionDismissed(false)
          }}
          onBlur={() => {
            setSlashDismissed(true)
            setMentionDismissed(true)
          }}
          onKeyDown={handleKey}
          onPaste={onPaste}
        />
        {busy ? (
          value.trim() || images.length > 0 ? (
            <button className="ma-send schedule has-tip" data-tip="작업 후 전송 예약 (Enter)" aria-label="예약" onClick={onSchedule}>
              <IconClock size={16} />
            </button>
          ) : (
            <button className="ma-send stop has-tip" data-tip="실행 중지" aria-label="중지" onClick={onStop}>
              <IconClose size={16} />
            </button>
          )
        ) : (
          <button
            className="ma-send has-tip"
            data-tip="보내기 (Enter)"
            aria-label="보내기"
            disabled={!value.trim() && images.length === 0}
            onClick={onSend}
          >
            <IconSend size={16} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── one panel's chat (presentational; its session is owned by ActiveSession) ──────
interface PanelViewProps {
  slot: number
  meta: PanelMeta
  state: SessionState
  busy: boolean
  elapsed: number
  expanded: boolean
  focused: boolean
  user: AppUser
  onInput: (slot: number, text: string) => void
  onAddImages: (slot: number, paths: string[]) => void
  onRemoveImage: (slot: number, i: number) => void
  onSend: (slot: number) => void
  onSchedule: (slot: number) => void // queue the draft while the panel is busy
  onRemoveQueued: (slot: number, id: string) => void
  onStop: (slot: number) => void
  onPicker: (slot: number, p: PickerState) => void
  onPickFolder: (slot: number) => void
  onOpenFile: (slot: number, rel: string) => void // 폴더 팝오버에서 고른 파일을 뷰어로 연다
  onFocusPanel: (slot: number) => void
  onExpand: (slot: number | null) => void
  onPermission: (slot: number, behavior: 'allow' | 'allow_always' | 'deny') => void
  onAnswer: (slot: number, answers: string[][]) => void
  onDismissQuestion: (slot: number) => void
  onOpenPrompt: (slot: number) => void // 패널별 프롬프트 설정 모달 열기
}

const PanelView = memo(function PanelView({
  slot,
  meta,
  state,
  busy,
  elapsed,
  expanded,
  focused,
  user,
  onInput,
  onAddImages,
  onRemoveImage,
  onSend,
  onSchedule,
  onRemoveQueued,
  onStop,
  onPicker,
  onPickFolder,
  onOpenFile,
  onFocusPanel,
  onExpand,
  onPermission,
  onAnswer,
  onDismissQuestion,
  onOpenPrompt
}: PanelViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // 폴더 칩에서 펼쳐지는 파일 트리 팝오버(시안 B) — 칩 사각형을 기준으로 띄운다
  const [folderRect, setFolderRect] = useState<DOMRect | null>(null)

  const cwd = meta.cwd || ''
  // 폴더를 고르지 않으면 엔진이 바탕화면에서 동작한다 — 라벨로 그 기본값을 알린다
  const cwdLabel = meta.cwd ? basename(meta.cwd) : '바탕화면'

  const status = STATUS_META[state.status]
  const winTokens = windowTokensFor(meta.picker.model, state.result?.contextWindow ?? null)
  const ctxTokens = state.result?.contextTokens ?? null
  const ctxPct = ctxTokens != null && winTokens > 0 ? Math.min(100, Math.round((ctxTokens / winTokens) * 100)) : 0
  const started = state.messages.length > 0

  // 이 패널에서 내가 보낸 메시지(오래된→최신) — 작성칸에서 ↑/↓로 셸처럼 다시 불러온다
  const sentHistory = useMemo(
    () =>
      state.messages
        .filter((m): m is Extract<SessionState['messages'][number], { kind: 'msg' }> => m.kind === 'msg' && m.role === 'user')
        .map((m) => m.text)
        .filter((t) => t.trim().length > 0),
    [state.messages]
  )

  // "더 자세히" — 채팅에서 선택한 글을 <selection> 태그로 감싸 이 패널의 작성칸에 붙인다
  // (단일 모드와 동일). 작성칸에 이미 글이 있으면 아래에 이어 붙인다.
  const onElaborate = (text: string): void => {
    const sel = `<selection>\n${text.trim()}\n</selection>\n\n이 부분 더 자세히 설명해줘`
    onInput(slot, meta.input.trim() ? meta.input + '\n\n' + sel : sel)
    onFocusPanel(slot)
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `.ma-panel[data-slot="${slot}"] .ma-p-composer textarea`
      ) as HTMLTextAreaElement | null
      if (!el) return
      el.focus()
      const n = el.value.length
      el.setSelectionRange(n, n)
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 132) + 'px'
    })
  }

  // pin the thread to the newest message / working line as it streams
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.messages, state.thinkingText, busy])

  const lastMsg = state.messages[state.messages.length - 1]
  const streamingAnswer = lastMsg?.kind === 'msg' && lastMsg.role === 'assistant' && !lastMsg.error
  const showWorking = (state.thinkingText != null || !streamingAnswer) && !state.pendingQuestion && !state.pendingCommand

  return (
    <div
      className={'ma-panel' + (expanded ? ' expanded' : '') + (focused ? ' focused' : '')}
      data-slot={slot}
      onMouseDown={() => onFocusPanel(slot)}
    >
      <div className="ma-p-head">
        <div className="ma-p-row1">
          <span className={'ma-p-num' + (focused ? ' on' : '')}>{slot + 1}</span>
          <span className={'ma-p-dot ' + status.cls} />
          <span className="ma-p-title">{meta.title || '새 작업'}</span>
          <span className="ma-spacer" />
          {expanded && (
            <button className="ma-p-act has-tip" data-tip="닫기 (Esc)" aria-label="닫기" onClick={() => onExpand(null)}>
              <IconClose size={15} />
            </button>
          )}
          <span className={'ma-status ' + status.cls}>
            {busy && <span className="ma-status-spin" />}
            <span>{status.label}</span>
            {busy && <span className="ma-status-time">{fmtElapsed(elapsed)}</span>}
          </span>
        </div>
        <div className="ma-p-row2">
          <button
            className={'ma-p-folder has-tip' + (folderRect ? ' on' : '')}
            data-tip={meta.cwd ? meta.cwd + ' · 클릭해 파일 탐색' : '바탕화면 · 클릭해 폴더 선택'}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setFolderRect((cur) => (cur ? null : r))
            }}
          >
            <IconFolder size={13} />
            <span className="ma-p-folder-name">{cwdLabel}</span>
            <IconChevDown size={11} />
          </button>
          <button
            className={'ma-p-prompt has-tip' + (meta.sysPrompt ? ' on' : '')}
            data-tip={meta.sysPrompt ? '프롬프트 설정됨' : '이 패널의 프롬프트 설정'}
            onClick={() => onOpenPrompt(slot)}
          >
            <IconSpark size={11} stroke={2.4} />
            <span>프롬프트</span>
          </button>
        </div>
      </div>

      <div className="ma-p-ctx">
        <span className="ma-ctx-ring" style={{ ['--p']: ctxPct } as CSSProperties} />
        <span className="ma-ctx-label">컨텍스트</span>
        <span className="ma-ctx-detail">
          {ctxTokens != null ? fmtTok(ctxTokens) : 0} / {fmtWindow(Math.round(winTokens / 1000))} 토큰
        </span>
        <span className="ma-spacer" />
        <span className="ma-ctx-pct">{ctxPct}%</span>
      </div>

      <div className="ma-p-body">
        {!expanded && (
          <button className="ma-p-zoom" onClick={() => onExpand(slot)} aria-label="크게 보기">
            <IconExpand size={13} />
            <span>크게 보기</span>
          </button>
        )}
        <div className="ma-p-thread scroll" ref={scrollRef}>
          {!started && !busy ? (
            <div className="ma-p-empty">
              <div className="ma-p-empty-ic">
                <IconCode size={20} />
              </div>
              <div className="ma-p-empty-text">메시지를 입력해 작업을 시작하세요</div>
            </div>
          ) : (
            <div className="ma-p-thread-inner">
              {state.messages.map((m, idx) => {
                const prev = state.messages[idx - 1]
                const prevIsAiBlock =
                  !!prev && (prev.kind === 'toolgroup' || (prev.kind === 'msg' && prev.role === 'assistant'))
                return (
                  <MessageView
                    key={m.id}
                    item={m}
                    userInitial={user.avatarText}
                    userColor={user.avatarColor}
                    userName={user.name}
                    live={idx === state.messages.length - 1 && m.kind === 'msg' && m.role === 'assistant' && !m.error}
                    running={busy}
                    lead={m.kind === 'toolgroup' && !prevIsAiBlock}
                  />
                )
              })}
              {busy && showWorking && <WorkingIndicator text={state.thinkingText} />}
            </div>
          )}
        </div>
      </div>

      <SelectionToolbar scrollRef={scrollRef} onElaborate={onElaborate} />

      <div className="ma-p-foot">
        {meta.queue.length > 0 && (
          <div className="sched ma-sched">
            <div className="sched-head">
              <span className="sched-title">
                <IconClock size={13} />
                예약된 메시지 {meta.queue.length}
              </span>
              <span className="sched-hint">작업이 끝나면 순서대로 전송돼요</span>
            </div>
            <div className="sched-list">
              {meta.queue.map((m, i) => (
                <div className="sched-item" key={m.id}>
                  <span className="sched-num">{i + 1}</span>
                  <span className="sched-text">
                    {m.text.trim() || (m.images.length ? `이미지 ${m.images.length}장` : '')}
                  </span>
                  {m.images.length > 0 && (
                    <span className="sched-img" title={`이미지 ${m.images.length}장`}>
                      <IconImage size={13} />
                    </span>
                  )}
                  <button
                    className="sched-x has-tip"
                    aria-label="예약 취소"
                    data-tip="예약 취소"
                    onClick={() => onRemoveQueued(slot, m.id)}
                  >
                    <IconX2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="ma-p-pickers">
          <RunPickers picker={meta.picker} setPicker={(p) => onPicker(slot, p)} align="right" />
        </div>
        <PanelComposer
          value={meta.input}
          history={sentHistory}
          images={meta.images}
          busy={busy}
          cwd={cwd}
          onChange={(t) => onInput(slot, t)}
          onAddImages={(paths) => onAddImages(slot, paths)}
          onRemoveImage={(i) => onRemoveImage(slot, i)}
          onSend={() => onSend(slot)}
          onSchedule={() => onSchedule(slot)}
          onStop={() => onStop(slot)}
          onFocus={() => onFocusPanel(slot)}
        />
      </div>

      {folderRect && (
        <PanelFolderMenu
          anchor={folderRect}
          cwd={meta.cwd}
          changed={state.files}
          refreshKey={state.messages.length}
          onOpenFile={(rel) => {
            setFolderRect(null)
            onOpenFile(slot, rel)
          }}
          onPickFolder={() => {
            setFolderRect(null)
            onPickFolder(slot)
          }}
          onClose={() => setFolderRect(null)}
        />
      )}

      <PermissionModal permission={state.pendingPermission} onRespond={(b) => onPermission(slot, b)} />
      <QuestionModal
        question={state.pendingQuestion}
        onAnswer={(a) => onAnswer(slot, a)}
        onDismiss={() => onDismissQuestion(slot)}
      />
    </div>
  )
})

function fmtElapsed(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// small usage pill in the workspace header (5시간 / 주간 한도)
function UsagePill({ label, pct }: { label: string; pct: number | null }) {
  return (
    <span className="ma-usage">
      <span className="ma-usage-ring" style={{ ['--p']: pct ?? 0 } as CSSProperties} />
      <span className="ma-usage-label">{label}</span>
      <span className="ma-usage-pct">{pct != null ? pct + '%' : '—'}</span>
    </span>
  )
}

// ── one active multi-agent session: its panel grid + header (keyed by sessionId in the
//    workspace, so switching sessions cleanly remounts a fresh set of 6 panel hooks) ──
function ActiveSession({
  sessionId,
  initial,
  user,
  usage,
  onFirstPrompt,
  onStatus,
  onCommit
}: {
  sessionId: string
  initial: PersistedSession
  user: AppUser
  usage: UsageInfo
  onFirstPrompt: (sessionId: string, prompt: string) => void
  onStatus: (sessionId: string, status: AgentStatus) => void
  onCommit: (sessionId: string, payload: CommitPayload) => void
}) {
  // every slot's session — six fixed hook calls, subscribed for this session's lifetime
  const s0 = useAgentSession(subFor(chan(sessionId, 0)))
  const s1 = useAgentSession(subFor(chan(sessionId, 1)))
  const s2 = useAgentSession(subFor(chan(sessionId, 2)))
  const s3 = useAgentSession(subFor(chan(sessionId, 3)))
  const s4 = useAgentSession(subFor(chan(sessionId, 4)))
  const s5 = useAgentSession(subFor(chan(sessionId, 5)))
  const sessions = [s0, s1, s2, s3, s4, s5]

  const [count, setCount] = useState(() => clampCount(initial.count))
  const [metas, setMetas] = useState<PanelMeta[]>(() =>
    SLOTS.map((i) => {
      const p = initial.panels?.[i]
      return p
        ? {
            title: p.title ?? '',
            custom: !!p.custom,
            cwd: p.cwd ?? '',
            picker: p.picker ?? { ...DEFAULT_PICKER },
            input: '',
            images: [],
            queue: [],
            sysPrompt: p.sysPrompt || undefined
          }
        : freshPanel()
    })
  )
  const [expandedSlot, setExpandedSlot] = useState<number | null>(null)
  const [focusedSlot, setFocusedSlot] = useState<number | null>(null)
  // 프롬프트 설정 모달이 열린 패널 슬롯 (헤더의 프롬프트 칩 클릭)
  const [promptSlot, setPromptSlot] = useState<number | null>(null)
  // a folder change that would reset panel conversation(s), parked here until the user
  // confirms it in the card modal (변경) or backs out (취소)
  const [pendingFolder, setPendingFolder] = useState<
    { kind: 'panel'; slot: number; cwd: string } | { kind: 'batch'; dir: string } | null
  >(null)
  // 폴더 팝오버에서 연 파일 — 그 패널의 cwd·diffs로 코드 뷰어를 띄운다 (패널 안이 아니라
  // 여기서 한 번만 렌더해야 .fv-overlay(absolute)가 확대 오버레이에 갇히지 않는다)
  const [openFile, setOpenFile] = useState<{ slot: number; path: string } | null>(null)

  // restore each panel's saved thread into its live session, once on mount
  useEffect(() => {
    initial.panels?.forEach((p, i) => {
      if (p?.snapshot && i < SLOT_COUNT) sessions[i].load({ ...initialSessionState, ...p.snapshot })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fable 5 정책 거부 → 엔진이 폴백 모델로 전환·재시도한 패널은 picker도 따라 바꾼다
  // (안 바꾸면 그 패널은 매번 거부→전환을 반복). 경고 배너는 스레드에 표시된다.
  useEffect(() => {
    const offs = SLOTS.map(
      (slot) =>
        window.api.multi?.onEvent?.(chan(sessionId, slot), (e) => {
          if (e.type !== 'model-fallback') return
          const next = pickerModelOf(e.toModel)
          if (next)
            setMetas((prev) =>
              prev.map((m, i) => (i === slot && m.picker.model !== next ? { ...m, picker: { ...m.picker, model: next } } : m))
            )
        }) ?? (() => {})
    )
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // cheap signature of every panel session (status + message count)
  const sig = sessions.map((s) => s.state.status + ':' + s.state.messages.length).join('|')

  // report aggregate status up for the recent-list dot
  const aggStatus = aggregateStatus(sessions.map((s) => s.state.status))
  useEffect(() => {
    onStatus(sessionId, aggStatus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggStatus])

  // build the persistable form of this session (latest closure kept in a ref so the
  // unmount commit captures the final state)
  const buildRef = useRef<() => CommitPayload>(() => ({ count, panels: [] }))
  buildRef.current = () => ({
    count,
    panels: SLOTS.map((i) => {
      const m = metas[i]
      return {
        title: m.title,
        custom: m.custom,
        cwd: m.cwd,
        picker: m.picker,
        snapshot: snapshotForPersist(sessions[i].state),
        sysPrompt: m.sysPrompt
      }
    })
  })
  // commit (debounced) on any change, and immediately on unmount (session switch)
  useEffect(() => {
    const t = setTimeout(() => onCommit(sessionId, buildRef.current()), 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, metas, sig])
  useEffect(() => {
    return () => onCommit(sessionId, buildRef.current())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Panel keyboard control (only while focus isn't in a field):
  //  · 1‥N        jump straight into that panel's composer (selects it + focuses the input)
  //  · Enter      drop the cursor into the selected panel's composer (e.g. after a click)
  //  · Esc        close the expanded panel, else release the panel selection
  // A permission/question card owns the keyboard while open, so we always stand down then.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // a question card — or the folder-switch confirm / 프롬프트 modal / 파일 뷰어 / 폴더
      // 팝오버 — owns the keyboard while open
      if (document.querySelector('.q-overlay, .set-dialog-overlay, .pr-overlay, .fv-overlay, .pfm')) return
      const ae = document.activeElement as HTMLElement | null
      const typing = !!ae && (['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName) || ae.isContentEditable)

      if (e.key === 'Escape') {
        if (expandedSlot != null) {
          e.preventDefault()
          setExpandedSlot(null)
        } else if (focusedSlot != null) {
          e.preventDefault()
          setFocusedSlot(null)
          if (typing) ae?.blur()
        }
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing) return

      if (e.key === 'Enter' && !e.shiftKey) {
        const scope = expandedSlot != null ? '.ma-expand-card' : '.ma-panel.focused'
        const ta = document.querySelector(`${scope} .ma-p-composer textarea`) as HTMLTextAreaElement | null
        if (ta) {
          e.preventDefault()
          ta.focus()
        }
        return
      }
      const n = parseInt(e.key, 10)
      if (Number.isInteger(n) && n >= 1 && n <= count) {
        e.preventDefault()
        const slot = n - 1
        setExpandedSlot(null)
        setFocusedSlot(slot)
        // jump straight into that panel's composer (next frame, once the grid is settled)
        requestAnimationFrame(() => {
          const ta = document.querySelector(
            `.ma-grid .ma-panel[data-slot="${slot}"] .ma-p-composer textarea`
          ) as HTMLTextAreaElement | null
          ta?.focus()
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expandedSlot, focusedSlot, count])

  // ── stable per-panel handlers ──
  const patchMeta = useEvent((slot: number, patch: Partial<PanelMeta>) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, ...patch } : m)))
  )
  const onInput = useEvent((slot: number, text: string) => patchMeta(slot, { input: text }))
  const onAddImages = useEvent((slot: number, paths: string[]) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, images: Array.from(new Set([...m.images, ...paths])) } : m)))
  )
  const onRemoveImage = useEvent((slot: number, idx: number) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, images: m.images.filter((_, j) => j !== idx) } : m)))
  )
  const onPicker = useEvent((slot: number, picker: PickerState) => patchMeta(slot, { picker }))
  const onFocusPanel = useEvent((slot: number) => setFocusedSlot(slot))
  const onOpenPrompt = useEvent((slot: number) => setPromptSlot(slot))
  const onOpenPanelFile = useEvent((slot: number, rel: string) => setOpenFile({ slot, path: rel }))

  // ── panel working-folder changes ──
  // A panel's folder is panel-scoped, and its session id is folder-scoped — moving a
  // panel with a conversation to another folder can't continue it. Folder changes funnel
  // through requestPanelFolder, which confirms via the card modal before wiping.
  const panelCwd = (slot: number): string => metas[slot].cwd || sessions[slot].state.session?.cwd || ''
  const requestPanelFolder = (slot: number, cwd: string): void => {
    const cur = panelCwd(slot)
    // same folder / nothing to lose → just rebind, no ceremony
    if (!cwd || !cur || sameCwd(cwd, cur) || sessions[slot].state.messages.length === 0) {
      patchMeta(slot, { cwd })
      return
    }
    if (sessions[slot].busy) return // the running turn works in this folder
    setPendingFolder({ kind: 'panel', slot, cwd })
  }
  const onPickFolder = useEvent(async (slot: number) => {
    if (sessions[slot].busy) return // blocked mid-run anyway — don't even open the picker
    const dir = await window.api.pickDirectory()
    if (dir) requestPanelFolder(slot, dir)
  })
  const onExpand = useEvent((slot: number | null) => setExpandedSlot(slot))

  // `opts` lets a queued message replay with the text/attachments/run settings it was
  // scheduled with (instead of the live draft, which the user may be typing in — a
  // replay never consumes it); interactive sends omit it.
  const sendPanel = useEvent(async (slot: number, opts?: { text: string; images: string[]; picker: PickerState }) => {
    const m = metas[slot]
    const sess = sessions[slot]
    const text = (opts?.text ?? m.input).trim()
    const imgs = opts?.images ?? m.images
    const pk = opts?.picker ?? m.picker
    // an image-only message (attachments, no text) is allowed
    if ((!text && imgs.length === 0) || sess.busy) return
    // /clear is a client command — reset just this panel's conversation (never sent to the engine)
    if (text === '/clear') {
      sess.load(initialSessionState)
      patchMeta(slot, { title: '', custom: false, ...(opts ? {} : { input: '', images: [] }) })
      return
    }
    // a built-in slash command (/init·/compact·/review·/security-review) → tracked so it
    // renders a summary card instead of a raw bubble; null for a normal prompt / skill
    const cmd = commandOf(text)
    const firstInSession = sessions.every((s) => s.state.messages.length === 0)
    let dir = m.cwd || ''
    if (!dir) {
      dir = (await window.api.pickDirectory()) ?? ''
      if (!dir) return
    }
    // folder changed since this panel's conversation began → a different project, and the
    // session can't continue here (a session id is folder-scoped). Reset the panel's thread
    // so it matches the fresh engine session instead of showing stale messages.
    const folderSwitched =
      !!sess.state.session && sess.state.messages.length > 0 && !sameCwd(sess.state.session.cwd, dir)
    if (folderSwitched) sess.load(initialSessionState)
    sess.begin(text, cmd, imgs)
    const title = cmd ? commandTitleOf(cmd) : text.slice(0, 80) || '이미지 첨부'
    if (firstInSession) onFirstPrompt(sessionId, title)
    setMetas((prev) =>
      prev.map((pm, i) =>
        i === slot
          ? {
              ...pm,
              // a queued replay keeps the draft being typed; an interactive send consumes it
              ...(opts ? {} : { input: '', images: [] }),
              cwd: dir,
              title: pm.custom && !folderSwitched ? pm.title : title,
              custom: folderSwitched ? false : pm.custom
            }
          : pm
      )
    )
    // commands take no extras; for a normal prompt, list mentions + attachments so the
    // engine reads them reliably (the Agent SDK doesn't auto-expand "@" / images the way the CLI does)
    let promptForEngine = text
    if (!cmd) {
      const notes: string[] = []
      const mentions = extractMentions(text)
      if (mentions.length)
        notes.push(`[멘션된 파일 — 필요하면 Read 도구로 확인하세요]\n${mentions.map((p) => '- ' + p).join('\n')}`)
      if (imgs.length)
        notes.push(`[첨부 이미지 — Read 도구로 확인하세요]\n${imgs.map((p) => '- ' + p).join('\n')}`)
      if (notes.length) promptForEngine = `${text}\n\n${notes.join('\n\n')}`
    }
    const req: MultiRunRequest = {
      panelId: chan(sessionId, slot),
      prompt: promptForEngine,
      model: pk.model,
      effort: pk.effort,
      mode: pk.mode,
      cwd: dir,
      // 패널별 프롬프트 — 매 실행 시스템 프롬프트에 append (없으면 생략)
      systemPrompt: m.sysPrompt,
      // resume only while still in the session's original folder (a session id is scoped
      // to its project — resuming it after a folder change errors "No conversation found")
      resume: sess.state.session && sameCwd(sess.state.session.cwd, dir) ? sess.state.session.sessionId : undefined
    }
    window.api.multi?.run(req).catch(() => {})
  })

  // queue the panel's draft (while it's busy) to auto-send when its run ends
  const schedulePanel = useEvent((slot: number) => {
    const m = metas[slot]
    if (!sessions[slot].busy || (!m.input.trim() && m.images.length === 0)) return
    const id = crypto.randomUUID ? crypto.randomUUID() : `q-${Date.now()}-${m.queue.length}`
    setMetas((prev) =>
      prev.map((pm, i) =>
        i === slot
          ? { ...pm, input: '', images: [], queue: [...pm.queue, { id, text: pm.input, images: pm.images, picker: pm.picker }] }
          : pm
      )
    )
  })
  const onRemoveQueued = useEvent((slot: number, id: string) =>
    setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, queue: m.queue.filter((q) => q.id !== id) } : m)))
  )

  // drain each panel's queue one message at a time on its busy→idle transition. The
  // `was` guard (only act when that slot was busy and now isn't) prevents a double-send:
  // dequeuing changes `metas` and re-runs this effect before the next run's busy flips on.
  const busySig = sessions.map((s) => (s.busy ? '1' : '0')).join('')
  const prevBusyRef = useRef(busySig)
  useEffect(() => {
    const was = prevBusyRef.current
    prevBusyRef.current = busySig
    SLOTS.forEach((slot) => {
      if (busySig[slot] === '1' || was[slot] !== '1') return
      // 런을 시작하지 않는 클라이언트 명령(/clear)은 busy 전환이 다시 오지 않아 뒤 항목이
      // 영영 갇힌다 — 앞쪽의 /clear 들을 연달아 소진하고, 엔진 런을 시작할 첫 일반 항목까지
      // 한 번에 내보낸다(그 런이 끝나면 다음 idle 전환이 나머지를 이어받는다).
      const q = metas[slot].queue
      let clears = 0
      while (clears < q.length && q[clears].text.trim() === '/clear') clears++
      const items = q.slice(0, Math.min(clears + 1, q.length))
      if (!items.length) return
      setMetas((prev) => prev.map((m, i) => (i === slot ? { ...m, queue: m.queue.slice(items.length) } : m)))
      // 예약 메시지는 자체 텍스트/첨부/설정으로 재생 — 실행 중에 새로 쓰던 초안은 건드리지 않는다
      for (const next of items) void sendPanel(slot, { text: next.text, images: next.images, picker: next.picker })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busySig, metas])

  const stopPanel = useEvent((slot: number) => {
    // stopping the run also abandons anything queued behind it (mirrors single mode)
    window.api.multi?.cancel(chan(sessionId, slot)).catch(() => {})
    setMetas((prev) => prev.map((m, i) => (i === slot && m.queue.length ? { ...m, queue: [] } : m)))
  })
  const onPermission = useEvent((slot: number, behavior: 'allow' | 'allow_always' | 'deny') => {
    const sess = sessions[slot]
    if (!sess.state.pendingPermission) return
    window.api.multi
      ?.respondPermission({ panelId: chan(sessionId, slot), requestId: sess.state.pendingPermission.requestId, behavior })
      .catch(() => {})
    sess.clearPermission()
  })
  const onAnswer = useEvent((slot: number, answers: string[][]) => {
    const sess = sessions[slot]
    if (!sess.state.pendingQuestion) return
    window.api.multi
      ?.respondQuestion({ panelId: chan(sessionId, slot), requestId: sess.state.pendingQuestion.requestId, answers })
      .catch(() => {})
    sess.clearQuestion()
  })
  const onDismissQuestion = useEvent((slot: number) => {
    const sess = sessions[slot]
    if (!sess.state.pendingQuestion) return
    window.api.multi
      ?.respondQuestion({ panelId: chan(sessionId, slot), requestId: sess.state.pendingQuestion.requestId, answers: null })
      .catch(() => {})
    sess.clearQuestion()
  })

  // batch working folder: set every panel's cwd at once. Panels whose conversation is
  // anchored to a different folder would be reset by the move — confirm those first.
  const batchAffected = (dir: string): number[] =>
    SLOTS.filter((i) => sessions[i].state.messages.length > 0 && !sameCwd(panelCwd(i), dir))
  const applyBatchFolder = useEvent((dir: string) => {
    // wipe the panels that can't follow the folder (same shape as a panel /clear). A busy
    // panel keeps streaming untouched — its send-time folder check still covers it later.
    const wipe = batchAffected(dir).filter((i) => !sessions[i].busy)
    wipe.forEach((i) => sessions[i].load(initialSessionState))
    setMetas((prev) =>
      prev.map((m, i) => (wipe.includes(i) ? { ...m, cwd: dir, title: '', custom: false } : { ...m, cwd: dir }))
    )
  })
  const onBatchFolder = useEvent(async () => {
    const dir = await window.api.pickDirectory()
    if (!dir) return
    if (batchAffected(dir).length === 0) applyBatchFolder(dir)
    else setPendingFolder({ kind: 'batch', dir })
  })

  // 변경 — apply the parked folder change and start the affected conversation(s) fresh
  const confirmFolder = useEvent(() => {
    const p = pendingFolder
    if (!p) return
    if (p.kind === 'panel') {
      patchMeta(p.slot, { cwd: p.cwd, title: '', custom: false })
      sessions[p.slot].load(initialSessionState)
    } else {
      applyBatchFolder(p.dir)
    }
    setPendingFolder(null)
  })

  const cols = COLS[count] ?? 3

  const renderPanel = (slot: number, expanded: boolean): React.ReactNode => {
    const sess = sessions[slot]
    return (
      <PanelView
        key={slot}
        slot={slot}
        meta={metas[slot]}
        state={sess.state}
        busy={sess.busy}
        elapsed={sess.elapsed}
        expanded={expanded}
        focused={focusedSlot === slot && !expanded}
        user={user}
        onInput={onInput}
        onAddImages={onAddImages}
        onRemoveImage={onRemoveImage}
        onSend={sendPanel}
        onSchedule={schedulePanel}
        onRemoveQueued={onRemoveQueued}
        onStop={stopPanel}
        onPicker={onPicker}
        onPickFolder={onPickFolder}
        onOpenFile={onOpenPanelFile}
        onFocusPanel={onFocusPanel}
        onExpand={onExpand}
        onPermission={onPermission}
        onAnswer={onAnswer}
        onDismissQuestion={onDismissQuestion}
        onOpenPrompt={onOpenPrompt}
      />
    )
  }

  return (
    <>
      <section className="multi">
        <div className="ma-head">
          <span className="ma-head-ic">
            <IconGrid size={17} />
          </span>
          <span className="ma-head-title">멀티 에이전트</span>
          <span className="ma-spacer" />
          <button className="ma-batch has-tip" data-tip="모든 패널 작업 폴더 설정" onClick={onBatchFolder}>
            <IconFolder size={14} />
            <span>일괄 폴더</span>
            <IconChevDown size={11} />
          </button>
          <UsagePill label="5시간 한도" pct={usage.fiveHour?.pct ?? null} />
          <UsagePill label="주간 한도" pct={usage.weekly?.pct ?? null} />
          {usage.weeklyFable && <UsagePill label="Fable 주간 한도" pct={usage.weeklyFable.pct} />}
          <div className="ma-count" role="tablist" aria-label="패널 수">
            {COUNT_OPTIONS.map((n) => (
              <button
                key={n}
                role="tab"
                aria-selected={count === n}
                className={'ma-count-btn' + (count === n ? ' on' : '')}
                onClick={() => setCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="ma-grid scroll" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {SLOTS.slice(0, count).map((slot) =>
            expandedSlot === slot ? <div key={slot} className="ma-panel ma-placeholder" /> : renderPanel(slot, false)
          )}
        </div>
      </section>

      {/* rendered as a sibling of the section (a direct child of .win-body) so the
          backdrop blur covers the whole workspace — sidebar included — not just the grid */}
      {expandedSlot != null && (
        <div className="ma-expand-overlay" onMouseDown={() => setExpandedSlot(null)}>
          <div className="ma-expand-card" onMouseDown={(e) => e.stopPropagation()}>
            {renderPanel(expandedSlot, true)}
          </div>
        </div>
      )}

      {pendingFolder && (
        <FolderSwitchDialog
          from={pendingFolder.kind === 'panel' ? panelCwd(pendingFolder.slot) : ''}
          to={pendingFolder.kind === 'panel' ? pendingFolder.cwd : pendingFolder.dir}
          multi={pendingFolder.kind === 'batch'}
          onCancel={() => setPendingFolder(null)}
          onConfirm={confirmFolder}
        />
      )}

      {promptSlot != null && (
        <PromptModal
          target={metas[promptSlot].title || '새 작업'}
          scope={`패널 ${promptSlot + 1}에만 적용`}
          noun="패널"
          value={metas[promptSlot].sysPrompt ?? ''}
          onSave={(text) => patchMeta(promptSlot, { sysPrompt: text || undefined })}
          onClose={() => setPromptSlot(null)}
        />
      )}

      {/* 폴더 팝오버에서 연 파일 — 그 패널의 cwd·diffs로 코드 뷰어. 패널이 아니라 여기서
          한 번만 렌더해 .fv-overlay(absolute inset:0)가 .win-body 전체를 덮게 한다 */}
      {openFile && (
        <FileModal
          path={openFile.path}
          cwd={metas[openFile.slot].cwd}
          diffs={sessions[openFile.slot].state.diffs}
          onClose={() => setOpenFile(null)}
        />
      )}
    </>
  )
}

// ── the multi-agent workspace: sidebar (session list) + the active session ────────
export function MultiWorkspace({
  user,
  usage,
  onOpenSettings,
  mode,
  onModeChange
}: {
  user: AppUser
  usage: UsageInfo
  onOpenSettings: () => void
  mode: WorkspaceMode
  onModeChange: (m: WorkspaceMode) => void
}) {
  // full data for every session (active one is folded in on commit / unmount). A ref,
  // not state — the live thread lives in ActiveSession's hooks, this is only for persist.
  const dataRef = useRef<Record<string, PersistedSession>>({})
  const [order, setOrder] = useState<string[]>([]) // session ids, most recent first
  const [activeId, setActiveId] = useState<string>('')
  const [titles, setTitles] = useState<Record<string, { title: string; custom: boolean }>>({})
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [chatQuery, setChatQuery] = useState('')
  const [hydrated, setHydrated] = useState(false)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const doSave = useEvent(() => {
    const blob: MultiPersist = {
      version: MULTI_VERSION,
      activeSessionId: activeId,
      sessions: order
        .map((id) => {
          const d = dataRef.current[id]
          if (!d) return null
          const t = titles[id]
          return { ...d, title: t?.title ?? d.title, custom: t?.custom ?? d.custom }
        })
        .filter(Boolean) as PersistedSession[]
    }
    window.api.multi?.saveState?.(blob).catch(() => {})
  })
  const scheduleSave = useEvent(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      if (hydrated) doSave()
    }, 700)
  })

  // restore the saved sessions on mount, or seed one fresh session
  useEffect(() => {
    let alive = true
    const seed = (): void => {
      const id = newSessionId()
      dataRef.current[id] = blankSession(id)
      setOrder([id])
      setTitles({ [id]: { title: '', custom: false } })
      setStatuses({ [id]: 'idle' })
      setActiveId(id)
    }
    window.api.multi
      ?.getState?.()
      .then((raw) => {
        if (!alive) return
        const data = raw as MultiPersist | null
        if (data && Array.isArray(data.sessions) && data.sessions.length) {
          const ord = data.sessions.map((s) => s.id)
          data.sessions.forEach((s) => (dataRef.current[s.id] = s))
          setOrder(ord)
          setTitles(Object.fromEntries(data.sessions.map((s) => [s.id, { title: s.title ?? '', custom: !!s.custom }])))
          setStatuses(
            Object.fromEntries(
              data.sessions.map((s) => [s.id, aggregateStatus((s.panels ?? []).map((p) => p?.snapshot?.status ?? 'idle'))])
            )
          )
          setActiveId(data.activeSessionId && ord.includes(data.activeSessionId) ? data.activeSessionId : ord[0])
        } else {
          seed()
        }
      })
      .catch(() => {
        if (alive) seed()
      })
      .finally(() => {
        if (alive) setHydrated(true)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // persist whenever the session list / titles / active selection changes
  useEffect(() => {
    if (hydrated) scheduleSave()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, order, titles, activeId])

  // ── reports from the active session ──
  const onCommit = useEvent((sid: string, payload: CommitPayload) => {
    const prev = dataRef.current[sid]
    dataRef.current[sid] = {
      id: sid,
      title: prev?.title ?? '',
      custom: prev?.custom ?? false,
      count: payload.count,
      panels: payload.panels
    }
    scheduleSave()
  })
  const onFirstPrompt = useEvent((sid: string, prompt: string) => {
    setTitles((t) => {
      const cur = t[sid]
      if (cur?.custom || (cur && cur.title)) return t // already named
      return { ...t, [sid]: { title: prompt.slice(0, 80) || '멀티 세션', custom: false } }
    })
  })
  const onStatus = useEvent((sid: string, status: AgentStatus) =>
    setStatuses((s) => (s[sid] === status ? s : { ...s, [sid]: status }))
  )

  // the active session is "empty" (no title, idle) → 새 작업 just stays on it
  const activeEmpty = (statuses[activeId] ?? 'idle') === 'idle' && !titles[activeId]?.title

  const newSession = useEvent(() => {
    if (activeEmpty) return
    const curCount = dataRef.current[activeId]?.count ?? 4
    const id = newSessionId()
    dataRef.current[id] = blankSession(id, curCount)
    setOrder((o) => [id, ...o])
    setTitles((t) => ({ ...t, [id]: { title: '', custom: false } }))
    setStatuses((s) => ({ ...s, [id]: 'idle' }))
    setActiveId(id)
  })
  const selectSession = useEvent((id: string) => {
    if (id !== activeId) setActiveId(id)
  })
  const renameSession = useEvent((id: string, name: string) => {
    setTitles((t) => ({ ...t, [id]: { title: name, custom: true } }))
    const d = dataRef.current[id]
    if (d) {
      d.title = name
      d.custom = true
    }
  })
  const deleteSession = useEvent((id: string) => {
    // release the session's panel engines
    SLOTS.forEach((i) => window.api.multi?.dispose(chan(id, i)).catch(() => {}))
    delete dataRef.current[id]
    const next = order.filter((x) => x !== id)
    setTitles((t) => {
      const n = { ...t }
      delete n[id]
      return n
    })
    setStatuses((s) => {
      const n = { ...s }
      delete n[id]
      return n
    })
    if (id === activeId) {
      if (next.length === 0) {
        const nid = newSessionId()
        dataRef.current[nid] = blankSession(nid)
        setTitles((t) => ({ ...t, [nid]: { title: '', custom: false } }))
        setStatuses((s) => ({ ...s, [nid]: 'idle' }))
        setOrder([nid])
        setActiveId(nid)
      } else {
        setOrder(next)
        setActiveId(next[0])
      }
    } else {
      setOrder(next)
    }
  })

  // recent-tasks list = sessions that actually have content. A fresh blank session
  // (no message sent yet) stays hidden — like single mode, where a new chat doesn't
  // appear in the list until it's used, so the list opens on "아직 채팅이 없어요".
  const chats: ChatSummary[] = useMemo(
    () =>
      order
        .map((id) => ({ id, title: titles[id]?.title ?? '', status: statuses[id] ?? ('idle' as AgentStatus) }))
        .filter((c) => c.title !== ''),
    [order, titles, statuses]
  )

  return (
    <>
      <Sidebar
        user={user}
        chats={chats}
        activeChatId={activeId}
        busy={false}
        chatQuery={chatQuery}
        onChatQuery={setChatQuery}
        onNewChat={newSession}
        onSelectChat={selectSession}
        onRenameChat={renameSession}
        onDeleteChat={deleteSession}
        onOpenSettings={onOpenSettings}
        mode={mode}
        onModeChange={onModeChange}
        listLabel="최근 작업"
        newLabel="새 작업"
        newTip="새로운 작업을 시작해요"
        searchLabel="작업 검색…"
      />

      {!hydrated || !activeId ? (
        <section className="multi">
          <div className="ma-hydrate">
            <span className="ma-hydrate-spin" />
          </div>
        </section>
      ) : (
        <ActiveSession
          key={activeId}
          sessionId={activeId}
          initial={dataRef.current[activeId] ?? blankSession(activeId)}
          user={user}
          usage={usage}
          onFirstPrompt={onFirstPrompt}
          onStatus={onStatus}
          onCommit={onCommit}
        />
      )}
    </>
  )
}
