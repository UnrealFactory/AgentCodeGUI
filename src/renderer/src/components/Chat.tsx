import { Fragment, memo, useEffect, useRef, useState, type CSSProperties, type ComponentType, type ReactNode } from 'react'
import type {
  ModelId,
  EffortId,
  ModeId,
  UsageInfo,
  ToolLogItem,
  AgentQuestion,
  SkillInfo,
  AgentStatus,
  Todo,
  ChangedFile,
  SubAgentInfo
} from '@shared/protocol'
import type { ThreadItem } from '../store/session'
import { Markdown } from './Markdown'
import { FileBadge } from './fileType'
import { StatusPill, Todos, FileRow, SubAgent } from './AgentPanel'
import { mentionAtCaret, mentionEntries, type MentionEntry } from '../lib/mentions'
import { imageSrc, imageName, filesToImagePaths } from '../lib/images'
import {
  IconClaude,
  IconImage,
  IconChevDown,
  IconCheck,
  IconCopy,
  IconTerminal,
  IconSearch,
  IconEye,
  IconFile,
  IconPencil,
  IconGlobe,
  IconSend,
  IconClose,
  IconAlert,
  IconShieldChk,
  IconClipList,
  IconExpand,
  IconCheckCirc,
  IconBolt,
  IconX2,
  IconPlug,
  IconWrench,
  IconFileText,
  IconCompress,
  IconRefresh,
  IconBook,
  IconFolder,
  IconChevRight,
  IconClock,
  IconList,
  IconBot,
  IconPanelLeft,
  IconKey,
  IconCard,
  IconDollar,
  type IconProps
} from './icons'

const TYPE_SPEED = 12

interface ModelOpt {
  v: string
  id: ModelId
  d: string
  ctx: number
  color: string
}
interface EffortOpt {
  v: string
  id: EffortId
  d: string
  level: number
}
interface ModeOpt {
  v: string
  id: ModeId
  d: string
  color: string
  icon: keyof typeof MODE_ICONS
  warn?: boolean
}

const MODELS: ModelOpt[] = [
  { v: 'Fable 5', id: 'fable', d: '최상위 지능 · 가장 어려운 작업', ctx: 1000, color: 'var(--gold)' },
  { v: 'Opus 4.8', id: 'opus', d: '고성능 · 복잡한 작업', ctx: 1000, color: 'var(--violet)' },
  { v: 'Sonnet 5', id: 'sonnet', d: '균형 · 일상 작업', ctx: 1000, color: 'var(--blue)' },
  { v: 'Haiku 4.5', id: 'haiku', d: '빠른 응답 · 가벼운 작업', ctx: 200, color: 'var(--teal)' }
]
const EFFORTS: EffortOpt[] = [
  { v: '최대', id: 'max', d: '최대 강도', level: 5 },
  { v: '매우 높음', id: 'xhigh', d: '더 깊은 추론', level: 4 },
  { v: '높음', id: 'high', d: '깊은 추론', level: 3 },
  { v: '보통', id: 'medium', d: '보통 추론', level: 2 },
  { v: '낮음', id: 'low', d: '가벼운 추론', level: 1 },
  { v: '최소', id: 'minimal', d: '확장사고 끔', level: 0 }
]
// 모드 + 과금 picker가 함께 쓰는 아이콘 키 (Pick의 icons 렌더링)
const MODE_ICONS = { shield: IconShieldChk, plan: IconClipList, check: IconCheckCirc, bolt: IconBolt, warn: IconAlert, card: IconCard, key: IconKey }
const MODES: ModeOpt[] = [
  { v: '일반', id: 'normal', d: '변경마다 승인 요청', color: 'var(--text-3)', icon: 'shield' },
  { v: '플랜', id: 'plan', d: '계획만 수립, 실행은 승인 후', color: 'var(--blue)', icon: 'plan' },
  { v: '모두 허용', id: 'acceptEdits', d: '파일 편집 자동 수락', color: 'var(--yellow)', icon: 'check' },
  { v: '자동', id: 'auto', d: '도구 실행까지 자동 진행', color: 'var(--violet)', icon: 'bolt' },
  { v: 'Bypass', id: 'bypass', d: '모든 권한 확인 건너뛰기', color: 'var(--red)', icon: 'warn', warn: true }
]

export interface PickerState {
  model: ModelId
  effort: EffortId
  mode: ModeId
}

/** raw SDK model id ('claude-opus-4-8-…') → picker ModelId, or undefined if unknown.
 *  폴백 전환(model-fallback) 시 picker를 따라 바꿀 때 쓴다. */
export function pickerModelOf(raw: string): ModelId | undefined {
  const s = raw.toLowerCase()
  return (['fable', 'opus', 'sonnet', 'haiku'] as const).find((id) => s.includes(id))
}

// A message queued while the agent is busy — auto-sent (in order) once the run ends.
// Captures the text, attachments, and the run settings chosen at schedule time.
export interface ScheduledMsg {
  id: string
  text: string
  images: string[]
  picker: PickerState
}

// next run mode in the picker order — used by the Shift+Tab shortcut
export function nextMode(current: ModeId): ModeId {
  const i = MODES.findIndex((m) => m.id === current)
  return MODES[(i + 1) % MODES.length].id
}

// ── Slash commands ───────────────────────────────────────────
// Commands shown in the "/" palette. Most are real built-in Claude Code commands
// the engine (Claude Agent SDK) runs when sent as the prompt; /clear is intercepted
// in the app (App.runPrompt) and resets the conversation instead of hitting the
// engine — matching Claude Code while staying in sync with the GUI's own message
// list. Skills are appended at runtime (loaded per-project from SKILL.md) and
// marked with the book icon as a distinct group. Every entry genuinely runs.
export interface SlashCmd {
  name: string
  desc: string
  icon: ComponentType<IconProps>
}
export const SLASH_COMMANDS: SlashCmd[] = [
  { name: 'ask', desc: '본 대화와 분리된 임시 질문 · 저장 안 됨', icon: IconBolt },
  { name: 'init', desc: '코드베이스를 분석해 CLAUDE.md 생성', icon: IconFileText },
  { name: 'clear', desc: '대화 기록과 컨텍스트 초기화', icon: IconRefresh },
  { name: 'compact', desc: '대화를 요약해 컨텍스트 절약', icon: IconCompress },
  { name: 'review', desc: '변경 사항 코드 리뷰', icon: IconEye },
  { name: 'security-review', desc: '변경 사항의 보안 취약점 검토', icon: IconShieldChk }
]

// ── Typewriter (used for animated assistant messages) ─────────
function Typewriter({ text }: { text: string }) {
  const [, force] = useState(0)
  const start = useRef(Date.now())
  const textRef = useRef(text)
  if (textRef.current !== text) {
    textRef.current = text
    start.current = Date.now()
  }
  useEffect(() => {
    const id = setInterval(() => force((t) => t + 1), 30)
    return () => clearInterval(id)
  }, [text])
  const n = Math.min(text.length, Math.floor((Date.now() - start.current) / TYPE_SPEED))
  const done = n >= text.length
  return (
    <span>
      {text.slice(0, n)}
      {!done && <span className="caret" />}
    </span>
  )
}

function toolIcon(kind: string, size: number) {
  if (kind === 'search') return <IconSearch size={size} />
  if (kind === 'read') return <IconEye size={size} />
  if (kind === 'write') return <IconFile size={size} />
  if (kind === 'edit') return <IconPencil size={size} />
  if (kind === 'bash') return <IconTerminal size={size} />
  if (kind === 'web') return <IconGlobe size={size} />
  if (kind === 'mcp') return <IconPlug size={size} />
  return <IconWrench size={size} />
}

// result shown on the right: a spinner while running, a red mark on error, the +/-
// line counts for edits (colored), or the tool's text summary otherwise.
function ToolResult({ t }: { t: ToolLogItem }) {
  if (t.status === 'running') return <span className="t-res"><span className="spin" /></span>
  if (t.status === 'error') return <span className="t-res err">오류</span>
  const diff = (t.result ?? '').match(/^\+(\d+) -(\d+)$/)
  if (diff)
    return (
      <span className="t-res">
        <span className="add">+{diff[1]}</span> <span className="del">−{diff[2]}</span>
      </span>
    )
  return <span className="t-res">{t.result ?? ''}</span>
}

// A bash row's captured output, in the install-log idiom (--inset block, mono 11px).
// Collapsed it's a single ghost line (last output line — n줄) as quiet as the tool
// rows; click to expand the scrollable log. Failures open expanded on their own —
// the error text is the very thing the user needs to read next.
function BashOutput({ t }: { t: ToolLogItem }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const failed = t.status === 'error'
  useEffect(() => {
    if (failed) setOpen(true)
  }, [failed])
  if (!t.output) return null
  // same feedback idiom as 설정 → 브리지의 CopyRow: 복사 → 복사됨 (1.2s)
  const copy = (): void => {
    navigator.clipboard
      ?.writeText(t.output ?? '')
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  const lines = t.output.split('\n')
  const last = [...lines].reverse().find((l) => l.trim()) ?? ''
  // tint only lines that read as errors, and only on a failed run — success
  // output stays fully achromatic like the install log
  const errLine = (ln: string): boolean => failed && /(^|\s)(error|err!|fatal|exception|failed)\b/i.test(ln)
  if (!open)
    return (
      <div className="bo-ghost" onClick={() => setOpen(true)}>
        <span className="bo-tick">└</span>
        <span className={'bo-pv' + (failed ? ' err' : '')}>{last}</span>
        <span className="bo-n">— {lines.length}줄</span>
      </div>
    )
  return (
    <div className={'bo-block' + (failed ? ' fail' : '')}>
      <div className="bo-log scroll">
        {lines.map((ln, i) => (
          <div key={i} className={'bo-ln' + (errLine(ln) ? ' err' : '')}>
            {ln || ' '}
          </div>
        ))}
      </div>
      <div className="bo-foot">
        <span>{lines.length}줄</span>
        <span className="bo-sp" />
        <button className={copied ? 'bo-copied' : ''} onClick={copy}>
          {copied ? '복사됨' : '복사'}
        </button>
        <button onClick={() => setOpen(false)}>접기</button>
      </div>
    </div>
  )
}

// 링크의 도메인 (www. 제거) — 표시·파비콘 조회 공용
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// 사이트 파비콘 — 구글 s2 서비스에서 도메인 아이콘을 가져오고, 실패(오프라인·아이콘
// 없음)하면 지구본 폴백으로 조용히 내려앉는다
function WebFavicon({ host }: { host: string }) {
  const [err, setErr] = useState(false)
  if (!host || err)
    return (
      <span className="wl-fav wl-fav-fb">
        <IconGlobe size={10} />
      </span>
    )
  return (
    <img
      className="wl-fav"
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
      alt=""
      loading="lazy"
      onError={() => setErr(true)}
    />
  )
}

// Web 행 (WebSearch/WebFetch): 검색이 찾은 페이지 목록(links)이 실려 오면 행을 클릭해
// 목록을 펼치고, 각 항목은 OS 브라우저로 연다(target=_blank → 메인의 shell.openExternal
// 경유). links 없이 target 자체가 URL인 행(WebFetch)은 클릭하면 그 페이지를 바로 연다.
// 펼침 목록은 배시 출력 블록과 같은 --inset 카드 이디엄: 파비콘 · 제목 · 도메인.
function WebRow({ t }: { t: ToolLogItem }) {
  const [open, setOpen] = useState(false)
  const links = t.links ?? []
  const direct = !links.length && /^https?:\/\//i.test(t.target) ? t.target : null
  const clickable = links.length > 0 || !!direct
  return (
    <>
      <div
        className={'t-row ' + t.kind + ' ' + t.status + (clickable ? ' openable' : '')}
        onClick={links.length ? () => setOpen((o) => !o) : direct ? () => window.open(direct) : undefined}
      >
        <span className="t-ic">{toolIcon(t.kind, 14)}</span>
        <span className="t-verb">{t.verb}</span>
        <span className="t-sep">·</span>
        <span
          className={'t-target' + (clickable ? ' has-tip' : '')}
          data-tip={links.length ? (open ? '접기' : '찾은 페이지 보기') : direct ? '브라우저에서 열기' : undefined}
        >
          {t.target}
        </span>
        <ToolResult t={t} />
      </div>
      {open && links.length > 0 && (
        <div className="wl-list scroll">
          {links.map((l) => (
            <a key={l.url} className="wl-item" href={l.url} target="_blank" rel="noreferrer">
              <WebFavicon host={hostOf(l.url)} />
              <span className="wl-title">{l.title}</span>
              <span className="wl-host">{hostOf(l.url)}</span>
            </a>
          ))}
        </div>
      )}
    </>
  )
}

// tools the assistant ran, blended into the message flow as quiet lines (no card):
// colored type icon · verb · target (wraps in full) · result on the right.
// File rows (read/write/edit) are clickable to open the file.
//
// `lead` = this group opens the assistant's turn (it ran a tool before writing any
// text, so there's no preceding message to carry the avatar). In that case we drop
// the Claude avatar into the 42px gutter so the turn still reads as Claude's — like
// a normal message block — instead of floating header-less. Done with an absolute
// avatar rather than a `.msg` wrapper so tool groups stay out of the message
// virtualization (which would otherwise clip the "파일 열기" hover tooltip).
function ToolGroup({
  item,
  onOpenFile,
  lead
}: {
  item: Extract<ThreadItem, { kind: 'toolgroup' }>
  onOpenFile?: (path: string) => void
  lead?: boolean
}) {
  if (!item.tools.length) return null
  return (
    <div className={'toollog' + (lead ? ' lead' : '')}>
      {lead && (
        <>
          <div className="ava ai lead-ava">
            <IconClaude size={16} />
          </div>
          <div className="lead-meta">
            <span className="name">Claude</span>
            {item.time && <span className="time">{item.time}</span>}
          </div>
        </>
      )}
      {item.tools.map((t) => {
        if (t.kind === 'web') return <WebRow t={t} key={t.id} />
        const openable = !!onOpenFile && (t.kind === 'read' || t.kind === 'write' || t.kind === 'edit') && !!t.target
        return (
          <Fragment key={t.id}>
            <div
              className={'t-row ' + t.kind + ' ' + t.status + (openable ? ' openable' : '')}
              onClick={openable ? () => onOpenFile!(t.target) : undefined}
            >
              <span className="t-ic">{toolIcon(t.kind, 14)}</span>
              <span className="t-verb">{t.verb}</span>
              <span className="t-sep">·</span>
              {/* 툴팁은 넓은 행 전체가 아니라 파일명에 달아, 파일명 바로 아래에 뜨게 한다 */}
              <span className={'t-target' + (openable ? ' has-tip' : '')} data-tip={openable ? '파일 보기' : undefined}>
                {t.target}
              </span>
              <ToolResult t={t} />
            </div>
            {t.kind === 'bash' && t.output && <BashOutput t={t} />}
          </Fragment>
        )
      })}
    </div>
  )
}

// Smoothly reveals streamed text as a continuous flow instead of in raw SDK
// chunks. A fractional cursor advances by (time × rate) each frame, where rate
// scales with the unshown buffer — so the cursor trails slightly behind during
// streaming (steady trickle, no stop-and-go) and drains the tail when it ends.
// 글자 수가 이 한도를 넘는 답변은 부드러운 공개 애니메이션을 생략한다 (아래 주석 참고)
const REVEAL_LIMIT = 24_000

function SmoothMarkdown({ text, running }: { text: string; running: boolean }) {
  const [shown, setShown] = useState(() => (running ? 0 : text.length))
  const targetRef = useRef(text)
  targetRef.current = text
  const curRef = useRef(shown) // fractional cursor
  const velRef = useRef(0) // current reveal velocity (chars/sec), eased
  const lastT = useRef(0)

  useEffect(() => {
    let raf = 0
    let alive = true
    const tick = (now: number): void => {
      if (!alive) return
      if (lastT.current === 0) lastT.current = now
      const dt = Math.min(0.05, (now - lastT.current) / 1000) // clamp big gaps (tab switch)
      lastT.current = now
      const target = targetRef.current.length
      let cur = curRef.current
      if (target > REVEAL_LIMIT) {
        // 초장문: 매 프레임 markdown을 처음부터 다시 파싱하는 비용이 글 길이에 비례해
        // 커진다(수십 KB부터 프레임을 잡아먹음) — 애니메이션을 접고 즉시 전부 보여준다
        if (cur < target) {
          curRef.current = target
          setShown(target)
        }
      } else if (cur < target) {
        const buffer = target - cur
        // desired speed scales with how far behind we are, with a steady floor so
        // it never crawls during model pauses
        const targetVel = buffer * 3.2 + 18
        // ease the actual velocity toward it (~280ms) so speed changes are gradual
        // — removes the little hitch when a chunk lands and the rate would jump
        velRef.current += (targetVel - velRef.current) * Math.min(1, dt * 3.5)
        cur = Math.min(target, cur + velRef.current * dt)
        curRef.current = cur
        setShown(Math.floor(cur))
      } else {
        velRef.current = 0
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [])

  // colorize only once the run finished AND the reveal caught up (avoids flicker)
  const plain = running || shown < text.length
  return <Markdown text={text.slice(0, shown)} plain={plain} />
}

// memoized so typing in the composer (which re-renders the app) doesn't re-parse
// markdown for every existing message — only messages whose props actually change
// re-render
// Image attachments inside a sent message, shown as a matted "photo card". A single
// image is one framed card; multiple images collapse into a stacked deck (the first
// image on top, blank cards peeking behind) with a "N장" count badge. Either way a
// click opens the viewer — at the first image; the viewer's filmstrip browses the rest.
function MessageImages({ images, onOpen }: { images: string[]; onOpen?: (images: string[], index: number) => void }) {
  const count = images.length
  const multi = count > 1
  const first = images[0]
  return (
    <div className={'msg-imgs' + (multi ? ' deck' : '')}>
      {multi && (
        <>
          <span className="msg-img-stack s2" aria-hidden="true" />
          <span className="msg-img-stack s1" aria-hidden="true" />
        </>
      )}
      <button
        className="msg-img"
        onClick={() => onOpen?.(images, 0)}
        aria-label={multi ? `이미지 ${count}장` : imageName(first)}
        title={multi ? `이미지 ${count}장` : imageName(first)}
      >
        <img src={imageSrc(first)} alt={imageName(first)} draggable={false} loading="lazy" />
        {multi && (
          <span className="msg-img-count">
            <IconImage size={13} />
            {count}장
          </span>
        )}
      </button>
    </div>
  )
}

// 안내(notice) 텍스트의 `백틱`으로 감싼 구간을 색 강조 span으로 바꾼다. 백틱이 없으면
// 문자열 그대로 반환. 안내문은 엔진이 만든 신뢰 텍스트라 이 정도 가벼운 파싱이면 충분하다.
function renderNoticeText(text: string): ReactNode {
  if (!text.includes('`')) return text
  return text.split('`').map((seg, i) => (i % 2 === 1 ? <span key={i} className="notice-kw">{seg}</span> : seg))
}

export const MessageView = memo(function MessageView({
  item,
  userInitial,
  userColor,
  userName,
  live,
  running,
  lead,
  onOpenFile,
  onOpenImage
}: {
  item: ThreadItem
  userInitial: string
  userColor: string
  userName: string
  live?: boolean // this is the latest assistant message (smooth-reveal it)
  running?: boolean // a run is in progress (start the reveal from empty)
  lead?: boolean // toolgroup that opens the assistant's turn (carry the avatar)
  onOpenFile?: (path: string) => void // open a file referenced by a tool-log row
  onOpenImage?: (images: string[], index: number) => void // open the image viewer at an index
}) {
  if (item.kind === 'toolgroup') return <ToolGroup item={item} onOpenFile={onOpenFile} lead={lead} />
  if (item.kind === 'cmdresult') return <CmdResultCard item={item} />
  if (item.kind === 'notice') {
    // 시스템 경고 줄 — 정책 거부로 모델이 자동 전환됐을 때, API 과금 안내 등.
    // 텍스트의 `백틱`으로 감싼 부분은 색을 넣어 강조한다(예: 하단 '과금' 토글).
    return (
      <div className="notice-row">
        <span className="notice-ic">
          <IconAlert size={15} />
        </span>
        <div className="notice-text">{renderNoticeText(item.text)}</div>
        <span className="notice-time">{item.time}</span>
      </div>
    )
  }
  if (item.kind === 'thinking') {
    return (
      <div className="msg ai-msg">
        <div className="ava ai">
          <IconClaude size={16} />
        </div>
        <div className="msg-main">
          <div className="thinking">
            <span>{item.text}</span>
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      </div>
    )
  }
  const isUser = item.role === 'user'
  return (
    <div className={'msg ' + (isUser ? 'user' : 'ai-msg') + (item.error ? ' error' : '')}>
      <div className={'ava ' + (isUser ? 'user' : 'ai')} style={isUser ? { background: userColor, color: '#fff' } : undefined}>
        {isUser ? userInitial : <IconClaude size={16} />}
      </div>
      <div className="msg-main">
        <div className="meta">
          <span className="name">{isUser ? userName : 'Claude'}</span>
          <span className="time">{item.time}</span>
        </div>
        <div className="content">
          {item.kind === 'msg' && item.images && item.images.length > 0 && (
            <MessageImages images={item.images} onOpen={onOpenImage} />
          )}
          {item.text &&
            (isUser || item.error ? (
              <p>{item.animate ? <Typewriter text={item.text} /> : item.text}</p>
            ) : live ? (
              <SmoothMarkdown text={item.text} running={!!running} />
            ) : (
              <Markdown text={item.text} />
            ))}
        </div>
      </div>
    </div>
  )
})

// Completion card for a finished slash command (/init·/compact·/review·/security-review).
// Skills and /clear never reach here — only commands tracked in SLASH_COMMANDS.
function CmdResultCard({ item }: { item: Extract<ThreadItem, { kind: 'cmdresult' }> }) {
  const Ic = SLASH_COMMANDS.find((c) => c.name === item.name)?.icon ?? IconTerminal
  return (
    <div className={'cmd-card' + (item.running ? ' running' : '') + (item.failed ? ' failed' : '')}>
      <span className="cmd-card-ic">
        <Ic size={16} />
      </span>
      <div className="cmd-card-body">
        <div className="cmd-card-head">
          <span className="cmd-card-badge">/{item.name}</span>
          <span className="cmd-card-title">{item.title}</span>
          {item.running ? <span className="cmd-card-spin" /> : <span className="cmd-card-time">{item.time}</span>}
        </div>
        {item.sub && <div className="cmd-card-sub">{item.sub}</div>}
        {item.stats && <div className="cmd-card-stats">{item.stats}</div>}
      </div>
    </div>
  )
}

// Playful rotating labels (Claude Code style) shown while busy when there's no
// explicit thinking summary.
const WORKING_PHRASES = [
  '골똘히 생각하는 중',
  '머리 굴리는 중',
  '코드 들여다보는 중',
  '곰곰이 따져보는 중',
  '차근차근 정리하는 중',
  '이리저리 탐색하는 중',
  '퍼즐 맞추는 중',
  '묘수를 찾는 중',
  '조합해보는 중',
  '꼼지락거리는 중',
  '뇌를 가동하는 중',
  '반짝이는 수를 고르는 중',
  '마법 부리는 중',
  '고민에 고민을 더하는 중',
  '한 땀 한 땀 엮는 중',
  '열심히 만지작거리는 중',
  '실마리를 푸는 중',
  '머릿속 회로 돌리는 중',
  '생각의 실타래 푸는 중',
  '코드를 음미하는 중',
  '점들을 잇는 중',
  '깊이 파고드는 중',
  '톱니바퀴 돌리는 중',
  '단서를 모으는 중',
  '가능성을 저울질하는 중',
  '머리를 쥐어짜는 중',
  '아이디어 굽는 중',
  '생각을 졸이는 중',
  '차분히 헤아리는 중',
  '경우의 수를 세는 중',
  '논리를 다듬는 중',
  '빈칸을 채우는 중',
  '흐름을 따라가는 중',
  '맥락을 읽는 중',
  '큰 그림 그리는 중',
  '설계도를 펼치는 중',
  '발상을 굴리는 중',
  '묘안을 짜내는 중',
  '차곡차곡 쌓는 중',
  '슬슬 시동 거는 중',
  '손가락 푸는 중',
  '커피 한 모금 하는 중',
  '심호흡 하는 중',
  '정신 집중하는 중',
  '두뇌 풀가동 중',
  '코드 숲을 헤매는 중',
  '보물 찾는 중',
  '매듭을 푸는 중',
  '톡톡 두드려보는 중',
  '영감을 부르는 중'
]

// Persistent "working" indicator shown in the chat while the agent is busy, so
// the user can always tell it's running (not stuck). Shows the latest thinking
// summary when available, otherwise a rotating playful label.
export function WorkingIndicator({ text }: { text: string | null }) {
  const [i, setI] = useState(() => Math.floor(Math.random() * WORKING_PHRASES.length))
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>
    function schedule(): void {
      // random 5~20s before switching to a new (non-repeating) phrase
      id = setTimeout(
        () => {
          setI((n) => {
            if (WORKING_PHRASES.length < 2) return 0
            let next = Math.floor(Math.random() * WORKING_PHRASES.length)
            if (next === n) next = (next + 1) % WORKING_PHRASES.length
            return next
          })
          schedule()
        },
        5000 + Math.random() * 15000
      )
    }
    schedule()
    return () => clearTimeout(id)
  }, [])
  const label = text || WORKING_PHRASES[i]
  return (
    <div className="msg ai-msg">
      <div className="ava ai">
        <IconClaude size={16} />
      </div>
      <div className="msg-main">
        <div className="thinking">
          <span key={label} style={{ animation: 'fade .35s ease' }}>
            {label}
          </span>
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </div>
  )
}

// status/elapsed are optional — only the code(agent) mode passes them, so the
// 대기중/작업중 pill rides the header's top-right (where the agent panel used to
// show it). 채팅 모드는 안 넘기므로 칩이 뜨지 않는다.
// explorerHidden/onToggleExplorer: 탐색기를 접으면 레일을 남기지 않고 완전히 사라지므로,
// 단축키(Ctrl/⌘+F)를 모르는 사람도 다시 열 수 있게 헤더 좌상단에 토글 버튼을 둔다.
export function ChatHeader({
  title,
  status,
  elapsed,
  explorerHidden,
  onToggleExplorer
}: {
  title: string
  status?: AgentStatus
  elapsed?: number
  explorerHidden?: boolean
  onToggleExplorer?: () => void
}) {
  return (
    <div className="chat-head">
      {explorerHidden && onToggleExplorer && (
        <button className="chat-head-toggle has-tip" data-tip="탐색기 열기" aria-label="탐색기 열기" onClick={onToggleExplorer}>
          <IconPanelLeft size={17} />
        </button>
      )}
      {title && <span className="h-title">{title}</span>}
      <span className="spacer" />
      {status && <StatusPill status={status} elapsed={elapsed ?? 0} />}
    </div>
  )
}

// Floating toolbar for a text selection inside the chat thread. 복사 copies the
// highlighted text; 더 자세히 quotes it into the composer so the user can ask Claude to
// expand on it. It appears on right-click (contextmenu) over a non-empty selection scoped
// to the chat — never on a plain drag — anchored at the mouse cursor like a context menu,
// flipping at the viewport edges. Dismisses on Esc / mousedown / when the selection
// collapses out of view on scroll.
export function SelectionToolbar({
  scrollRef,
  onElaborate
}: {
  scrollRef: React.RefObject<HTMLElement | null>
  onElaborate: (text: string) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number; text: string } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    // the chat selection's text, or null if there's nothing usable
    // (collapsed, empty, or reaching outside the chat thread)
    const readSel = (): string | null => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
      const text = sel.toString().trim()
      if (!text) return null
      if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return null
      return text
    }

    // 새 드래그/클릭이 시작되는 순간(mousedown) 이전 툴바를 즉시 내린다 —
    // 낡은 툴바가 남아 있으면 반응이 한 박자 늦게 느껴진다. 단, 우클릭 자체는
    // 곧바로 contextmenu에서 다시 띄우므로 무시한다.
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 2) return // 우클릭 → contextmenu가 처리
      if (barRef.current?.contains(e.target as Node)) return
      setPos(null)
    }
    // 드래그(선택)만으로는 뜨지 않고, 선택 위에서 우클릭할 때만 — 마우스 커서 위치에 띄운다
    const onContextMenu = (e: MouseEvent): void => {
      if (barRef.current?.contains(e.target as Node)) return
      const text = readSel()
      if (!text) return // 선택이 없으면 기본 메뉴를 막지 않는다
      e.preventDefault()
      setPos({ x: e.clientX, y: e.clientY, text })
      setCopied(false)
    }
    // 스크롤하면 선택이 화면에서 벗어날 수 있으니, 선택이 사라지면 내린다
    const onScroll = (): void => setPos((p) => (p && readSel() ? p : null))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPos(null)
    }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('contextmenu', onContextMenu)
    container.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('contextmenu', onContextMenu)
      container.removeEventListener('scroll', onScroll)
      window.removeEventListener('keydown', onKey)
    }
  }, [scrollRef])

  if (!pos) return null
  // 커서 오른쪽 아래에 붙이되(컨텍스트 메뉴 느낌), 화면 가장자리에선 반대쪽으로 뒤집는다
  const BAR_W = 188
  const BAR_H = 40
  const flipX = pos.x + BAR_W + 6 > window.innerWidth
  const flipY = pos.y + BAR_H + 10 > window.innerHeight
  const style: CSSProperties = {
    left: flipX ? pos.x - 6 : pos.x + 6,
    top: flipY ? pos.y - 8 : pos.y + 8,
    transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`
  }
  const copy = (): void => {
    navigator.clipboard?.writeText(pos.text).then(() => setCopied(true), () => {})
  }
  const elaborate = (): void => {
    onElaborate(pos.text)
    setPos(null)
    window.getSelection()?.removeAllRanges()
  }
  return (
    <div
      className="sel-bar"
      ref={barRef}
      style={style}
      // keep the highlight alive when a button is pressed (mousedown would otherwise
      // collapse the selection before our click handler reads it)
      onMouseDown={(e) => e.preventDefault()}
    >
      <button className="sel-act" onClick={copy}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        <span>{copied ? '복사됨' : '복사'}</span>
      </button>
      <span className="sel-div" />
      <button className="sel-act" onClick={elaborate}>
        <IconSearch size={14} />
        <span>더 자세히</span>
      </button>
    </div>
  )
}

// 에이전트(코드) 모드 — 코드베이스를 직접 다루는 작업 위주
const WELCOME_SUGGESTIONS: { icon: typeof IconPencil; label: string }[] = [
  { icon: IconEye, label: '이 프로젝트의 구조를 설명해줘' },
  { icon: IconSearch, label: '버그를 찾아서 고쳐줘' },
  { icon: IconBolt, label: '성능을 개선할 부분을 찾아줘' },
  { icon: IconPencil, label: '테스트 코드를 작성해줘' }
]

// 순수 채팅(대화) 모드 — 작업 폴더가 없어 코드 작업이 아니라 설명·아이디어·상의 위주
const CHAT_SUGGESTIONS: { icon: typeof IconPencil; label: string }[] = [
  { icon: IconBook, label: '어려운 개념을 쉽게 설명해줘' },
  { icon: IconBolt, label: '아이디어를 함께 브레인스토밍해줘' },
  { icon: IconWrench, label: '기술 선택이나 설계 방향을 같이 고민해줘' },
  { icon: IconPencil, label: '글이나 문서 초안을 작성해줘' }
]

const WELCOME_COPY = {
  agent: {
    sub: '코드 작성과 리뷰부터 버그 수정, 리팩터링까지 — 아래에 바로 입력하거나 추천으로 시작해보세요.',
    suggestions: WELCOME_SUGGESTIONS
  },
  chat: {
    sub: '가볍게 대화로 시작해보세요 — 궁금한 걸 묻거나 아이디어를 함께 정리해보세요.',
    suggestions: CHAT_SUGGESTIONS
  }
} as const

// shown in the chat area when the active conversation is empty (first launch / new chat).
// variant='chat'은 작업 폴더 없는 순수 대화 모드용 — 대화 중심 추천을 보여준다.
export function WelcomeState({
  userName,
  onPick,
  variant = 'agent'
}: {
  userName: string
  onPick: (text: string) => void
  variant?: 'agent' | 'chat'
}) {
  const copy = WELCOME_COPY[variant]
  return (
    <div className="welcome">
      <div className="wc-mark">
        <IconClaude size={26} />
      </div>
      <div className="wc-title">무엇을 도와드릴까요{userName ? `, ${userName}님` : ''}?</div>
      <div className="wc-sub">{copy.sub}</div>
      <div className="wc-grid">
        {copy.suggestions.map((s) => (
          <button key={s.label} className="wc-card" onClick={() => onPick(s.label)}>
            <span className="wc-ic">
              <s.icon size={16} />
            </span>
            <span className="wc-lbl">{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Bars({ level }: { level: number }) {
  return (
    <span className="bars">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={'bar' + (i <= level ? ' on' : '')} style={{ height: 4 + i * 2 + 'px' }} />
      ))}
    </span>
  )
}

interface PickProps<O extends { v: string; d?: string }> {
  label: string
  value: string
  options: O[]
  onChange: (v: string) => void
  align?: 'right'
  dots?: boolean
  bars?: boolean
  icons?: boolean
  tip?: string
}
function Pick<O extends { v: string; d?: string; color?: string; level?: number; icon?: keyof typeof MODE_ICONS; warn?: boolean }>({
  label,
  value,
  options,
  onChange,
  align,
  dots,
  bars,
  icons,
  tip
}: PickProps<O>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const sel = options.find((o) => o.v === value)
  const ModeIc = (key?: keyof typeof MODE_ICONS) => {
    if (!key) return null
    const C = MODE_ICONS[key]
    return <C size={14} />
  }
  return (
    <div className="pick" ref={ref}>
      <button
        className={'pick-btn' + (tip ? ' has-tip' : '') + (open ? ' active' : '') + (icons && sel?.warn ? ' warnbtn' : '')}
        data-tip={tip}
        onClick={() => setOpen((o) => !o)}
      >
        {icons && sel ? (
          <span className="pick-mode-ic" style={{ color: sel.color }}>
            {ModeIc(sel.icon)}
          </span>
        ) : dots && sel ? (
          <span className="pick-dot" style={{ background: sel.color }} />
        ) : bars && sel ? (
          <Bars level={sel.level ?? 3} />
        ) : null}
        <span className="pick-lbl">{label}</span>
        <span className="pick-val">{value}</span>
        <IconChevDown size={11} className="pick-chev" />
      </button>
      {open && (
        <div className={'pick-menu' + (align === 'right' ? ' right' : '')}>
          <div className="pick-menu-h">{label}</div>
          {options.map((o) => (
            <div key={o.v}>
              {o.warn && <span className="pick-sep" />}
              <button
                className={'pick-opt' + (o.v === value ? ' on' : '') + (o.warn ? ' warn' : '')}
                onClick={() => {
                  onChange(o.v)
                  setOpen(false)
                }}
              >
                {icons && (
                  <span className="po-mode-ic" style={{ color: o.color }}>
                    {ModeIc(o.icon)}
                  </span>
                )}
                {dots && (o.warn ? <IconAlert size={14} className="po-warn-ic" /> : <span className="po-dot" style={{ background: o.color }} />)}
                {bars && <Bars level={o.level ?? 3} />}
                <span className="po-text">
                  <span className="po-main">{o.v}</span>
                  {o.d && <span className="po-desc">{o.d}</span>}
                </span>
                {o.v === value && <IconCheck size={14} className="po-check" />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 과금(구독/API) picker — 메인 컴포저·채팅·멀티 패널·/ask가 같은 컨트롤을 공유한다.
// onChange(next): next=true(API)를 고르면 호출자가 키 유무를 확인하고, 없으면 설정을 연다.
export function BillingPick({
  apiMode,
  apiReady,
  onChange,
  align
}: {
  apiMode: boolean
  apiReady: boolean
  onChange: (next: boolean) => void
  align?: 'right'
}) {
  return (
    <Pick
      label="과금"
      value={apiMode ? 'API' : '구독'}
      options={[
        // --accent는 다크 테마에서 무채색(근백색)이라 아이콘이 하얗게 죽는다.
        // 골드는 Fable 모델 티어 색과 겹쳐서 제외 — 모델 색(골드/바이올렛/블루/틸)·API 그린과
        // 모두 구분되면서 양쪽 테마에서 색을 유지하는 로즈로 칠한다
        { v: '구독', d: 'Claude 구독(정액)으로 실행', color: 'var(--rose)', icon: 'card' as const },
        {
          v: 'API',
          d: apiReady ? '저장된 API 키로 종량 과금' : 'API 키 필요 — 선택하면 설정이 열려요',
          color: 'var(--green)',
          icon: 'key' as const
        }
      ]}
      onChange={(v) => onChange(v === 'API')}
      align={align}
      icons
      tip="과금 방식 — 구독(정액) vs API 키(종량)"
    />
  )
}

// The model · effort · mode picker row, factored out of the Composer so the
// multi-agent panels (and their expand modal) reuse the exact same controls.
export function RunPickers({
  picker,
  setPicker,
  align,
  apiMode = false,
  apiReady = false,
  onApiModeChange
}: {
  picker: PickerState
  setPicker: (p: PickerState) => void
  align?: 'right' // open the mode menu leftward when the panel hugs the right edge
  apiMode?: boolean // 과금 picker 상태 (전역 구독/API) — onApiModeChange가 있을 때만 표시
  apiReady?: boolean
  onApiModeChange?: (next: boolean) => void
}) {
  const modelOpt = MODELS.find((m) => m.id === picker.model) ?? MODELS[0]
  const effortOpt = EFFORTS.find((e) => e.id === picker.effort) ?? EFFORTS[2]
  const modeOpt = MODES.find((m) => m.id === picker.mode) ?? MODES[0]
  return (
    <>
      <Pick
        label="모델"
        value={modelOpt.v}
        options={MODELS}
        onChange={(v) => setPicker({ ...picker, model: (MODELS.find((m) => m.v === v) ?? MODELS[0]).id })}
        dots
        tip="모델 — 응답 품질·속도"
      />
      <Pick
        label="Effort"
        value={effortOpt.v}
        options={EFFORTS}
        onChange={(v) => setPicker({ ...picker, effort: (EFFORTS.find((m) => m.v === v) ?? EFFORTS[2]).id })}
        bars
        tip="추론 강도 — 깊이 vs 속도"
      />
      <Pick
        label="모드"
        value={modeOpt.v}
        options={MODES}
        onChange={(v) => setPicker({ ...picker, mode: (MODES.find((m) => m.v === v) ?? MODES[0]).id })}
        align={align}
        icons
        tip="실행 모드 — 변경 승인 방식"
      />
      {onApiModeChange && <BillingPick apiMode={apiMode} apiReady={apiReady} onChange={onApiModeChange} align={align} />}
    </>
  )
}

// the real context-window size for a model id (tokens) — falls back to the model's
// nominal window when the SDK hasn't reported one yet. Shared by the composer strip
// and the multi-agent panels' context gauge.
export function windowTokensFor(model: ModelId, contextWindow: number | null): number {
  const opt = MODELS.find((m) => m.id === model) ?? MODELS[0]
  return contextWindow ?? opt.ctx * 1000
}

export function fmtWindow(k: number): string {
  return k >= 1000 ? (k % 1000 === 0 ? k / 1000 + 'M' : (k / 1000).toFixed(1) + 'M') : k + 'K'
}
export function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'K'
  return String(n)
}
// USD 표시 (API 모드 비용) — 소액은 셋째 자리까지, 그 외 둘째 자리까지
export function fmtUsd(v: number): string {
  return '$' + (v > 0 && v < 1 ? v.toFixed(3) : v.toFixed(2))
}
function resetText(resetsAt: number | null, useDays: boolean): string {
  if (resetsAt == null) return '초기화 시간 미상'
  const rem = resetsAt - Math.floor(Date.now() / 1000)
  if (rem <= 0) return '곧 초기화'
  const mins = Math.floor(rem / 60)
  let h = Math.floor(mins / 60)
  const m = mins % 60
  if (useDays && h >= 24) {
    const d = Math.floor(h / 24)
    h = h % 24
    return `${d}일 ${h}시간 후 초기화`
  }
  return h > 0 ? `${h}시간 ${m}분 후 초기화` : `${m}분 후 초기화`
}

function ContextStrip({
  winTokens,
  contextTokens,
  usage,
  apiMode = false,
  chatSpentUsd = 0,
  budgetUsd = null,
  totalSpentUsd = 0
}: {
  winTokens: number
  contextTokens: number | null
  usage: UsageInfo
  apiMode?: boolean // true → 구독 한도 대신 API 비용을 보여준다 (WorkBar와 동일한 규칙)
  chatSpentUsd?: number
  budgetUsd?: number | null
  totalSpentUsd?: number
}) {
  const ctxPct = contextTokens != null && winTokens > 0 ? Math.min(100, Math.round((contextTokens / winTokens) * 100)) : 0
  const items: { label: string; pct: number | null; usd?: boolean; val?: string; detail: string }[] = [
    {
      label: '현재 컨텍스트',
      pct: ctxPct,
      detail: `${contextTokens != null ? fmtTok(contextTokens) : 0} / ${fmtWindow(Math.round(winTokens / 1000))} 토큰`
    },
    ...(apiMode
      ? [
          // 비용 행은 링 대신 달러 배지(usd) — "한도의 몇 %"가 아니라 금액 자체라서
          { label: '이번 대화 비용', pct: null, usd: true, val: fmtUsd(chatSpentUsd), detail: 'API 모드 실행의 누적 비용' },
          budgetUsd != null
            ? {
                label: '남은 예산',
                pct: Math.min(100, Math.round((totalSpentUsd / budgetUsd) * 100)),
                val: fmtUsd(Math.max(0, budgetUsd - totalSpentUsd)),
                detail: `예산 ${fmtUsd(budgetUsd)} 중 ${fmtUsd(totalSpentUsd)} 사용`
              }
            : { label: '누적 사용액', pct: null, usd: true, val: fmtUsd(totalSpentUsd), detail: '전체 워크스페이스 합산' }
        ]
      : [
          {
            label: '5시간 한도',
            pct: usage.fiveHour?.pct ?? null,
            detail: usage.fiveHour ? resetText(usage.fiveHour.resetsAt, false) : '데이터 없음'
          },
          {
            label: '주간 한도',
            pct: usage.weekly?.pct ?? null,
            detail: usage.weekly ? resetText(usage.weekly.resetsAt, true) : '데이터 없음'
          },
          // Fable 5 전용 주간 한도 — 플랜에 없으면(null) 칩 자체를 숨긴다
          ...(usage.weeklyFable
            ? [{ label: 'Fable 주간 한도', pct: usage.weeklyFable.pct as number | null, detail: resetText(usage.weeklyFable.resetsAt, true) }]
            : [])
        ])
  ]
  return (
    <div className="ctx-strip">
      {items.map((c, i) => (
        <div className="ctx-chip" key={i}>
          {c.usd ? (
            <span className="cc-usd">
              <IconDollar size={11} />
            </span>
          ) : (
            <span className="cc-ring" style={{ ['--p']: c.pct ?? 0 } as CSSProperties} />
          )}
          <span className="cc-text">
            <span className="cc-top">
              <span className="cc-label">{c.label}</span>
              <span className="cc-pct">{c.val ?? (c.pct != null ? c.pct + '%' : '—')}</span>
            </span>
            <span className="cc-detail">{c.detail}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

type WorkTab = 'todo' | 'sub' | 'file' | 'ctx'

// 코드(에이전트) 모드의 "작업 바" — 컴포저 바로 위 한 줄. 할 일·서브에이전트·변경된
// 파일·컨텍스트를 알약 칩으로 두고, 누르면 그 칩 위로 팝오버가 떠 내용을 보여준다
// (한 번에 하나, Esc·바깥 클릭으로 닫힘). 예전 오른쪽 에이전트 패널(.agent)을 대체해
// 대화 칼럼을 넓힌다. App이 매 틱 리렌더해도 컴포저 타이핑과 분리되도록 memo.
export const WorkBar = memo(function WorkBar({
  status,
  todos,
  files,
  subagents,
  usage,
  contextTokens,
  contextWindow,
  model,
  apiMode = false,
  chatSpentUsd = 0,
  budgetUsd = null,
  totalSpentUsd = 0,
  onOpenFile,
  onOpenSubagent
}: {
  status: AgentStatus
  todos: Todo[]
  files: ChangedFile[]
  subagents: SubAgentInfo[]
  usage: UsageInfo
  contextTokens: number | null
  contextWindow: number | null
  model: ModelId
  apiMode?: boolean // true → 컨텍스트 팝오버가 구독 한도 대신 API 비용을 보여준다
  chatSpentUsd?: number // 이 대화의 API 모드 누적 비용
  budgetUsd?: number | null // 설정 → API의 예산 (null = 미설정)
  totalSpentUsd?: number // 전체 워크스페이스의 API 모드 누적 사용액
  onOpenFile: (f: ChangedFile) => void
  onOpenSubagent: (a: SubAgentInfo) => void
}) {
  const [open, setOpen] = useState<WorkTab | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const busy = status === 'analyzing' || status === 'working'

  // 팝오버는 Esc / 바깥 클릭으로 닫는다 (네이티브 다이얼로그 금지 — 카드 패턴 유지)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const winTokens = windowTokensFor(model, contextWindow)
  const ctxPct = contextTokens != null && winTokens > 0 ? Math.min(100, Math.round((contextTokens / winTokens) * 100)) : 0
  const todoDone = todos.filter((t) => t.status === 'done').length
  const runningSub = subagents.filter((a) => a.status === 'running').length
  const doneSub = subagents.filter((a) => a.status === 'done').length

  // 컨텍스트 팝오버 — 구독 모드는 예전 컴포저 스트립과 같은 3줄(현재 컨텍스트·5시간·주간),
  // API 모드는 한도가 의미 없으니 비용으로 바꾼다(이번 대화 비용 + 남은 예산/누적 사용액).
  // val: pct 자리(%)에 대신 보여줄 텍스트 — 비용 행은 %가 없어 금액을 그대로 띄운다.
  // usd: 링 대신 달러 배지 — 금액은 "한도의 몇 %"가 아니라 진행률 링이 어울리지 않는다.
  const ctxItems: { label: string; pct: number | null; usd?: boolean; val?: string; detail: string }[] = [
    {
      label: '현재 컨텍스트',
      pct: ctxPct,
      detail: `${contextTokens != null ? fmtTok(contextTokens) : 0} / ${fmtWindow(Math.round(winTokens / 1000))} 토큰`
    },
    ...(apiMode
      ? [
          { label: '이번 대화 비용', pct: null, usd: true, val: fmtUsd(chatSpentUsd), detail: 'API 모드 실행의 누적 비용' },
          budgetUsd != null
            ? {
                label: '남은 예산',
                pct: Math.min(100, Math.round((totalSpentUsd / budgetUsd) * 100)),
                val: fmtUsd(Math.max(0, budgetUsd - totalSpentUsd)),
                detail: `예산 ${fmtUsd(budgetUsd)} 중 ${fmtUsd(totalSpentUsd)} 사용`
              }
            : { label: '누적 사용액', pct: null, usd: true, val: fmtUsd(totalSpentUsd), detail: '전체 워크스페이스 · 설정 → API에서 예산 입력 가능' }
        ]
      : [
          { label: '5시간 한도', pct: usage.fiveHour?.pct ?? null, detail: usage.fiveHour ? resetText(usage.fiveHour.resetsAt, false) : '데이터 없음' },
          { label: '주간 한도', pct: usage.weekly?.pct ?? null, detail: usage.weekly ? resetText(usage.weekly.resetsAt, true) : '데이터 없음' },
          // Fable 5 전용 주간 한도 — 플랜에 없으면(null) 행 자체를 숨긴다
          ...(usage.weeklyFable
            ? [{ label: 'Fable 주간 한도', pct: usage.weeklyFable.pct as number | null, detail: resetText(usage.weeklyFable.resetsAt, true) }]
            : [])
        ])
  ]

  const toggle = (t: WorkTab): void => setOpen((o) => (o === t ? null : t))

  // 칩 면(面)은 예전 컨텍스트 스트립과 똑같은 결 — 왼쪽 링/아이콘 + 2줄 텍스트(라벨·값
  // 위, 디테일 아래). 4칸이 폭을 똑같이 나눠(flex:1) 가지런히 채운다. 누르면 그 칸 위로
  // 팝오버가 떠 상세 목록을 보여준다.
  const todoTotal = todos.length
  const todoPct = todoTotal ? Math.round((todoDone / todoTotal) * 100) : 0
  const subTotal = subagents.length
  const totalAdd = files.reduce((n, f) => n + (f.add || 0), 0)
  const totalDel = files.reduce((n, f) => n + (f.del || 0), 0)

  const chips: { key: WorkTab; ring?: number; icon?: ReactNode; label: string; value: string; detail: string; tip: string; align?: 'r' }[] = [
    { key: 'todo', icon: <IconList size={14} />, label: '할 일', value: `${todoDone}/${todoTotal || 0}`, detail: todoTotal ? `${todoPct}% 완료` : busy ? '계획 수립 중' : '없음', tip: 'Claude가 세운 작업 계획 — 누르면 할 일 목록' },
    { key: 'sub', icon: <IconBot size={14} />, label: '서브에이전트', value: `${doneSub}/${subTotal || 0}`, detail: runningSub > 0 ? `${runningSub}개 실행 중` : subTotal ? '모두 완료' : '없음', tip: 'Claude가 띄운 보조 에이전트의 진행 상황 — 누르면 목록' },
    { key: 'file', icon: <IconFile size={14} />, label: '변경된 파일', value: `${files.length}`, detail: files.length ? `+${totalAdd} −${totalDel}` : '없음', tip: '이번 작업에서 생성·수정된 파일 — 누르면 목록·diff' },
    { key: 'ctx', ring: ctxPct, label: '컨텍스트', value: `${ctxPct}%`, detail: ctxItems[0].detail, tip: apiMode ? '대화의 컨텍스트 사용량·API 비용 — 누르면 자세히' : '대화의 컨텍스트 사용량·사용 한도 — 누르면 자세히', align: 'r' }
  ]

  const popBody = (key: WorkTab): ReactNode => {
    if (key === 'todo')
      return (
        <>
          <div className="wb-pop-h">
            <span className="t">할 일</span>
            <span className="c">
              {todoDone}/{todoTotal || 0}
            </span>
          </div>
          {todoTotal ? <Todos todos={todos} /> : <div className="ag-none">{busy ? '계획을 수립하는 중…' : '아직 할 일이 없어요'}</div>}
        </>
      )
    if (key === 'sub')
      return (
        <>
          <div className="wb-pop-h">
            <span className="t">서브에이전트</span>
            <span className="c">{runningSub > 0 ? runningSub + ' 실행 중' : doneSub + '/' + (subTotal || 0)}</span>
          </div>
          {subTotal ? (
            <div className="wb-pop-list">
              {subagents.map((a) => (
                <SubAgent
                  key={a.id}
                  a={a}
                  onOpen={(x) => {
                    setOpen(null)
                    onOpenSubagent(x)
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="ag-none">아직 서브에이전트가 없어요</div>
          )}
        </>
      )
    if (key === 'file')
      return (
        <>
          <div className="wb-pop-h">
            <span className="t">변경된 파일</span>
            <span className="c">{files.length}</span>
          </div>
          {files.length ? (
            <div className="wb-pop-list">
              {files.map((f) => (
                <FileRow
                  key={f.path}
                  f={f}
                  onOpen={(x) => {
                    setOpen(null)
                    onOpenFile(x)
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="ag-none">아직 변경된 파일이 없어요</div>
          )}
        </>
      )
    return (
      <>
        <div className="wb-pop-h">
          <span className="t">{apiMode ? '컨텍스트 · API 비용' : '컨텍스트 · 사용 한도'}</span>
        </div>
        <div className="wb-ctx-list">
          {ctxItems.map((c, i) => (
            <div className="ctx-chip" key={i}>
              {c.usd ? (
                <span className="cc-usd">
                  <IconDollar size={11} />
                </span>
              ) : (
                <span className="cc-ring" style={{ ['--p']: c.pct ?? 0 } as CSSProperties} />
              )}
              <span className="cc-text">
                <span className="cc-top">
                  <span className="cc-label">{c.label}</span>
                  <span className="cc-pct">{c.val ?? (c.pct != null ? c.pct + '%' : '—')}</span>
                </span>
                <span className="cc-detail">{c.detail}</span>
              </span>
            </div>
          ))}
        </div>
      </>
    )
  }

  return (
    <div className="workbar-wrap">
      <div className="workbar" ref={ref}>
        {chips.map((c) => (
          <div className="wb-cell" key={c.key}>
            <button
              className={'wb-chip' + (open === c.key ? ' on' : ' has-tip')}
              data-tip={c.tip}
              onClick={() => toggle(c.key)}
            >
              {c.ring != null ? (
                <span className="cc-ring" style={{ ['--p']: c.ring } as CSSProperties} />
              ) : (
                <span className="wb-ic">{c.icon}</span>
              )}
              <span className="cc-text">
                <span className="cc-top">
                  <span className="cc-label">{c.label}</span>
                  <span className="cc-pct">{c.value}</span>
                </span>
                <span className="cc-detail">{c.detail}</span>
              </span>
            </button>
            {open === c.key && <div className={'wb-pop' + (c.align === 'r' ? ' r' : '')}>{popBody(c.key)}</div>}
          </div>
        ))}
      </div>
    </div>
  )
})

// distinct colors for the option number badges (1-8), cycled by position
const Q_NUM_COLORS = [
  'var(--blue)',
  'var(--green)',
  'var(--violet)',
  'var(--rose)',
  'var(--teal)',
  'var(--accent-2)',
  'var(--cyan)',
  'var(--red)'
]

// The agent's AskUserQuestion, shown as a centered modal (same overlay/card pattern
// as the Settings/SubAgent dialogs). Options are numbered and selectable with the
// 1-9 keys. A single single-select question answers on click/keypress; otherwise
// selections build up and 확인 submits. Esc / backdrop / ✕ skip (agent uses defaults).
export function QuestionModal({
  question,
  onAnswer,
  onDismiss,
  hotkeys = true,
  onExpand
}: {
  question: { requestId: string; questions: AgentQuestion[] } | null
  onAnswer: (answers: string[][]) => void
  onDismiss: () => void
  // 멀티 패널 — 카드가 여러 패널에 동시에 떠 있어도 키보드(숫자·화살표·Esc)는
  // 포커스된 패널의 카드만 받는다. 단일 채팅/ask 모달은 기본 true.
  hotkeys?: boolean
  // 좁은 그리드 패널에서 다단계 질문이 답답할 때 — 헤더의 크게 보기 버튼으로
  // 패널 확장과 연결한다 (제공될 때만 버튼을 그린다)
  onExpand?: () => void
}) {
  if (!question) return null
  // keyed on requestId so each new question gets a fresh dialog (resets selections)
  return (
    <QuestionDialog
      key={question.requestId}
      questions={question.questions}
      onAnswer={onAnswer}
      onDismiss={onDismiss}
      hotkeys={hotkeys}
      onExpand={onExpand}
    />
  )
}

// the three permission choices — rendered as numbered cards (same look as the question
// modal's options) and pickable with the 1·2·3 keys. Colors read semantically.
const PERM_CHOICES = [
  { key: 'allow', label: '허용', desc: '이번 한 번만 실행을 허용해요', color: 'var(--green)' },
  { key: 'allow_always', label: '항상 허용', desc: '이번 세션 동안 이 도구를 자동 허용해요', color: 'var(--accent)' },
  { key: 'deny', label: '거부', desc: '이 작업을 실행하지 않아요', color: 'var(--red)' }
] as const

// The agent's tool-permission request, shown as a centered modal (same overlay/card
// language as the question modal). The choices are numbered cards: 1 허용 / 2 항상 허용
// (allow + stop asking for this tool this session) / 3 거부. Keys 1·2·3 pick; Esc denies.
export function PermissionModal({
  permission,
  onRespond,
  hotkeys = true
}: {
  permission: { requestId: string; toolName: string; summary: string } | null
  onRespond: (behavior: 'allow' | 'allow_always' | 'deny') => void
  // 멀티 패널 — 두 패널이 동시에 승인을 요청해도 1·2·3/Esc는 포커스된 패널의
  // 카드만 받는다 (안 그러면 키 한 번이 모든 요청에 동시 응답된다)
  hotkeys?: boolean
}) {
  useEffect(() => {
    if (!permission || !hotkeys) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onRespond('deny')
        return
      }
      const n = parseInt(e.key, 10)
      if (Number.isInteger(n) && n >= 1 && n <= PERM_CHOICES.length) {
        e.preventDefault()
        onRespond(PERM_CHOICES[n - 1].key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [permission, onRespond, hotkeys])

  if (!permission) return null
  return (
    <div className="q-overlay">
      <div className="perm-modal" role="dialog" aria-modal="true">
        <div className="perm-head">
          <span className="perm-ic">
            <IconShieldChk size={28} />
          </span>
          <div className="perm-htext">
            <span className="perm-title">도구 사용 승인 요청</span>
            <span className="perm-sub">Claude가 다음 작업을 실행하려고 합니다</span>
          </div>
          {permission.toolName && <span className="perm-tool">{permission.toolName}</span>}
        </div>
        {permission.summary && <div className="perm-sum">{permission.summary}</div>}
        <div className="q-opts">
          {PERM_CHOICES.map((c, i) => (
            <button key={c.key} className="q-opt" onClick={() => onRespond(c.key)}>
              <span className="q-num" style={{ background: c.color, color: 'var(--on-accent)' }}>
                {i + 1}
              </span>
              <span className="q-opt-text">
                <span className="q-opt-label">{c.label}</span>
                <span className="q-opt-desc">{c.desc}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="perm-foot">숫자 키로 선택 · Esc 거부</div>
      </div>
    </div>
  )
}

function QuestionDialog({
  questions,
  onAnswer,
  onDismiss,
  hotkeys = true,
  onExpand
}: {
  questions: AgentQuestion[]
  onAnswer: (answers: string[][]) => void
  onDismiss: () => void
  hotkeys?: boolean
  onExpand?: () => void
}) {
  const [sel, setSel] = useState<string[][]>(() => questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => '')) // 기타 free text
  const [other, setOther] = useState<boolean[]>(() => questions.map(() => false)) // 기타 active
  const [step, setStep] = useState(0)
  // 잠깐 내려두기 — 답을 잃지 않고 우하단 알약으로 접어, 뒤 대화를 확인한 뒤 다시 펼쳐
  // 답한다. QuestionModal이 requestId로 키를 걸어, 새 질문이 오면 펼친 상태로 다시 뜬다.
  const [minimized, setMinimized] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const customRef = useRef<HTMLInputElement>(null)
  const multi = questions.length > 1
  const cur = questions[step]
  const last = step === questions.length - 1

  // a question's resolved answer: its checked options plus, when 기타 is active and
  // filled, the free-text value. Single-select 기타 replaces the option choice.
  const answerAt = (i: number, s = sel, c = custom, o = other): string[] => {
    const extra = o[i] && c[i].trim() ? [c[i].trim()] : []
    return questions[i].multiSelect ? [...s[i], ...extra] : o[i] ? extra : s[i]
  }
  const finalAnswers = (s = sel, c = custom, o = other): string[][] => questions.map((_, i) => answerAt(i, s, c, o))
  const curChosen = answerAt(step).length > 0
  const allAnswered = questions.every((_, i) => answerAt(i).length > 0)

  // pick a listed option. Single-select clears 기타 and auto-advances (or submits on
  // the last question); multi-select toggles and waits for the 다음/완료 button.
  const choose = (label: string): void => {
    const nextSel = sel.map((a) => a.slice())
    if (cur.multiSelect) {
      const i = nextSel[step].indexOf(label)
      if (i >= 0) nextSel[step].splice(i, 1)
      else nextSel[step].push(label)
    } else {
      nextSel[step] = [label]
    }
    setSel(nextSel)
    let nextOther = other
    if (!cur.multiSelect && other[step]) {
      nextOther = other.slice()
      nextOther[step] = false
      setOther(nextOther)
    }
    if (!cur.multiSelect) {
      if (last) onAnswer(finalAnswers(nextSel, custom, nextOther))
      else setStep(step + 1)
    }
  }
  // pick the auto-appended 기타 (직접 입력) option → reveal the text field
  const chooseOther = (): void => {
    const nextOther = other.slice()
    if (cur.multiSelect) {
      nextOther[step] = !nextOther[step]
    } else {
      nextOther[step] = true
      const nextSel = sel.map((a) => a.slice())
      nextSel[step] = []
      setSel(nextSel)
    }
    setOther(nextOther)
  }
  const setCustomAt = (i: number, val: string): void =>
    setCustom((prev) => {
      const n = prev.slice()
      n[i] = val
      return n
    })
  // advance to the next question, or submit on the last one (when all answered)
  const proceed = (): void => {
    if (!curChosen) return
    if (last) {
      if (allAnswered) onAnswer(finalAnswers())
    } else setStep(step + 1)
  }

  // focus the modal on open AND whenever it's restored from the pill, so the composer
  // textarea behind it doesn't swallow the number-key shortcuts. hotkeys가 없는(포커스
  // 안 된 패널) 카드는 포커스를 훔치지 않는다 — 다른 패널에서 입력 중일 수 있다.
  useEffect(() => {
    if (!minimized && hotkeys) modalRef.current?.focus()
  }, [minimized, hotkeys])
  // focus the free-text field whenever 기타 becomes active for the current question
  useEffect(() => {
    if (other[step]) customRef.current?.focus()
  }, [other, step])

  // Keyboard: Esc 잠깐 내려두기(한 번 더 Esc면 건너뛰기) — 작성 중에도; ←/↑ ·→/↓ move
  // between questions, number keys 1-8 pick an option (the last is 직접 입력), Enter advances/
  // submits. The arrows/numbers/Enter are skipped while focus is in a text field.
  useEffect(() => {
    if (!hotkeys) return // 포커스 안 된 패널의 카드 — 클릭으로만 답한다
    const onKey = (e: KeyboardEvent): void => {
      // 내려둔 동안엔 대화를 자유롭게 보도록 키를 가로채지 않는다. Esc 한 번 더면
      // 건너뛰기 — 펼치기는 알약/✕ 옆 버튼 클릭으로 (ask 모달의 Esc·Esc와 동일)
      if (minimized) {
        if (e.key === 'Escape') {
          e.preventDefault()
          onDismiss()
        }
        return
      }
      // 펼친 상태의 Esc는 건너뛰기 대신 잠깐 내려둔다 — 답을 잃지 않고 대화를 확인
      if (e.key === 'Escape') {
        e.preventDefault()
        setMinimized(true)
        return
      }
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        setStep((s) => Math.max(0, s - 1))
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        setStep((s) => Math.min(questions.length - 1, s + 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        proceed()
        return
      }
      const n = parseInt(e.key, 10)
      if (!Number.isInteger(n) || n < 1) return
      if (n <= cur.options.length) {
        e.preventDefault()
        choose(cur.options[n - 1].label)
      } else if (n === cur.options.length + 1) {
        e.preventDefault()
        chooseOther()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel, custom, other, step, onDismiss, minimized, hotkeys])

  const otherIdx = cur.options.length // 직접 입력's position → its number / keyboard shortcut
  const footBtn = cur.multiSelect || other[step] // single-select options auto-advance; these need a button

  // 내려둔 상태 — q-overlay 대신 우하단 알약으로 접어 뒤 대화를 그대로 보며 스크롤할 수
  // 있게 한다. 클릭(또는 펼치기 버튼)이면 다시 질문이 뜨고, ✕는 건너뛰기.
  if (minimized) {
    return (
      <div className="q-mini" onClick={() => setMinimized(false)}>
        <div className="q-mini-orb">
          <IconClipList size={17} />
        </div>
        <div className="mini-text">
          <div className="mini-title">질문이 기다리고 있어요</div>
          <div className="mini-sub">{multi ? `질문 ${questions.length}개 · 펼쳐서 답하기` : '펼쳐서 답하기'}</div>
        </div>
        <span className="mini-spacer" />
        <button className="mini-btn has-tip" data-tip="펼치기" aria-label="펼치기" onClick={() => setMinimized(false)}>
          <IconExpand size={15} />
        </button>
        <button
          className="mini-btn close has-tip"
          data-tip="건너뛰기"
          aria-label="건너뛰기"
          onClick={(e) => {
            e.stopPropagation()
            onDismiss()
          }}
        >
          <IconClose size={16} />
        </button>
      </div>
    )
  }

  return (
    // The agent is blocked waiting on this answer, so — unlike the other modals — a
    // backdrop click does NOT dismiss it (too easy to lose the prompt by accident).
    // Closing is a deliberate action: answer it, ✕ to skip, or 내려두기(⌄·Esc)로 잠깐
    // 접어 대화를 확인한 뒤 다시 펼쳐 답한다.
    <div className="q-overlay">
      <div className="q-modal" ref={modalRef} tabIndex={-1}>
        <div className="q-modal-head">
          <span className="qm-title">질문</span>
          {multi && (
            <span className="qm-step-count">
              {step + 1} / {questions.length}
            </span>
          )}
          <span className="qm-spacer" />
          {/* 좁은 패널에서만 제공 — 패널 확장으로 넘어가면 카드가 리마운트돼 지금까지의
              선택이 초기화되므로, 답을 고르기 전에 누르는 걸 상정한다 */}
          {onExpand && (
            <button className="qm-min" onClick={onExpand} aria-label="크게 보기" title="크게 보기">
              <IconExpand size={16} />
            </button>
          )}
          <button className="qm-min" onClick={() => setMinimized(true)} aria-label="내려두기" title="내려두기 (Esc)">
            <IconChevDown size={18} />
          </button>
          <button className="qm-close" onClick={onDismiss} aria-label="건너뛰기" title="건너뛰기">
            <IconClose size={18} />
          </button>
        </div>

        {multi && (
          <div className="q-steps">
            {questions.map((q, i) => {
              const done = answerAt(i).length > 0
              // namespaced so the upcoming-step class doesn't collide with the global
              // `.todo` (task-list item) rule, which would clamp the chip to 8px radius
              const state = i === step ? 'q-cur' : done ? 'q-done' : 'q-todo'
              return (
                <button
                  key={i}
                  className={'q-step ' + state}
                  onClick={() => setStep(i)}
                  title={done ? answerAt(i).join(', ') : undefined}
                >
                  <span className="q-step-n">{done && i !== step ? <IconCheck size={12} /> : i + 1}</span>
                  <span className="q-step-lbl">{q.header || `질문 ${i + 1}`}</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="q-modal-body scroll">
          <div className="q-block">
            <div className="q-head">
              {cur.header && <span className="q-chip">{cur.header}</span>}
              <span className="q-q">{cur.question}</span>
            </div>
            <div className="q-opts">
              {cur.options.map((o, oi) => {
                const on = sel[step].includes(o.label)
                return (
                  <button key={oi} className={'q-opt' + (on ? ' on' : '')} onClick={() => choose(o.label)}>
                    <span className="q-num" style={{ background: Q_NUM_COLORS[oi % Q_NUM_COLORS.length], color: 'var(--on-accent)' }}>
                      {oi + 1}
                    </span>
                    <span className="q-opt-text">
                      <span className="q-opt-label">{o.label}</span>
                      {o.description && <span className="q-opt-desc">{o.description}</span>}
                    </span>
                    {on && <IconCheck size={15} className="q-check" />}
                  </button>
                )
              })}
              {/* every question gets an auto-appended free-text option, like the real tool */}
              <button className={'q-opt q-opt-other' + (other[step] ? ' on' : '')} onClick={chooseOther}>
                <span className="q-num" style={{ background: Q_NUM_COLORS[otherIdx % Q_NUM_COLORS.length], color: 'var(--on-accent)' }}>
                  {otherIdx + 1}
                </span>
                <span className="q-opt-text">
                  <span className="q-opt-label">직접 입력</span>
                  <span className="q-opt-desc">원하는 답을 직접 작성해요</span>
                </span>
                {other[step] && <IconCheck size={15} className="q-check" />}
              </button>
              {other[step] && (
                <div className="q-custom-wrap">
                  <IconPencil size={14} className="q-custom-ic" />
                  <input
                    ref={customRef}
                    className="q-custom"
                    placeholder="원하는 답을 직접 입력…"
                    value={custom[step]}
                    onChange={(e) => setCustomAt(step, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        proceed()
                      }
                    }}
                  />
                  <button
                    className="q-custom-go"
                    disabled={!custom[step].trim()}
                    onClick={proceed}
                    title={last ? '완료' : '다음'}
                    aria-label={last ? '완료' : '다음'}
                  >
                    <IconSend size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="q-modal-foot">
          <span className="q-hint">숫자 키로 선택{cur.multiSelect ? ' · 여러 개 가능' : ''} · Esc 내려두기</span>
          {footBtn && (
            <button className="q-submit" disabled={!curChosen} onClick={proceed}>
              {last ? '완료' : '다음'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function Composer({
  value,
  onChange,
  history,
  onSend,
  onStop,
  onSchedule,
  queued,
  onRemoveQueued,
  busy,
  started,
  picker,
  setPicker,
  apiMode = false,
  apiReady = false,
  onApiModeChange,
  chatSpentUsd = 0,
  budgetUsd = null,
  totalSpentUsd = 0,
  images,
  onPickImages,
  onAddImagePaths,
  onRemoveImage,
  onOpenImage,
  contextTokens,
  contextWindow,
  usage,
  showContext = true,
  cwd,
  mentionBase,
  inputRef
}: {
  value: string
  onChange: (v: string) => void
  history: string[] // 내가 보낸 메시지(오래된→최신) — ↑/↓로 다시 불러오기
  onSend: () => void
  onStop: () => void
  onSchedule: () => void // queue the current draft while the agent is busy
  queued: ScheduledMsg[] // messages waiting to auto-send when the run ends
  onRemoveQueued: (id: string) => void
  busy: boolean
  started: boolean
  picker: PickerState
  setPicker: (p: PickerState) => void
  apiMode?: boolean // true → 실행이 구독 대신 API 키로 과금 (과금 picker 상태)
  apiReady?: boolean // 설정 → API에 키가 저장돼 있는지 (없으면 API 선택이 설정을 연다)
  onApiModeChange?: (next: boolean) => void // 제공될 때만 과금 picker를 그린다
  chatSpentUsd?: number // 이 대화의 API 모드 누적 비용 — ContextStrip(API 모드)용
  budgetUsd?: number | null // 설정 → API의 예산
  totalSpentUsd?: number // 전체 워크스페이스 API 누적 사용액
  images: string[]
  onPickImages: () => void
  onAddImagePaths: (paths: string[]) => void
  onRemoveImage: (i: number) => void
  onOpenImage?: (images: string[], index: number) => void
  contextTokens: number | null
  contextWindow: number | null // real window from the SDK; null → use the model default
  usage: UsageInfo
  showContext?: boolean // 코드 모드는 작업 바가 컨텍스트를 보여주므로 컴포저 안 스트립을 끈다(기본 true)
  cwd: string // project dir — scopes which skills the "/" palette loads
  mentionBase?: string // @ 멘션이 파일을 뜨우는 기준 폴더(탐색기가 보는 폴더). 없으면 cwd
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
}) {
  const [focus, setFocus] = useState(false)
  // true while an image is being dragged over the composer → shows the drop hint overlay.
  // a counter, not a bool: dragenter/leave fire per child element, so a plain flag flickers
  const dragDepth = useRef(0)
  const [dragOver, setDragOver] = useState(false)
  const modelOpt = MODELS.find((m) => m.id === picker.model) ?? MODELS[0]
  // prefer the SDK's real context window; fall back to the model's nominal size
  const winTokens = contextWindow ?? modelOpt.ctx * 1000
  const effortOpt = EFFORTS.find((e) => e.id === picker.effort) ?? EFFORTS[2]
  const modeOpt = MODES.find((m) => m.id === picker.mode) ?? MODES[0]

  const grow = (el: HTMLTextAreaElement | null): void => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  // 작성칸 높이를 항상 현재 value에 맞춘다. 전송하면 부모가 value를 비우지만 그건
  // onChange를 거치지 않아, 이 effect가 없으면 긴 메시지를 보낸 뒤에도 칸이 커진 채
  // 다음 타이핑 전까지 유지된다(예약·히스토리·초안 복원 같은 외부 변경도 함께 보정).
  useEffect(() => {
    grow(inputRef?.current ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // ── 보낸 메시지 히스토리 (셸처럼 ↑/↓로 복구) ────────────────────
  // histIdx: 현재 history 위치(null = 직접 작성 중인 초안). histDraft: 히스토리
  // 탐색을 시작할 때 잠시 보관해 둔 초안 — ↓로 끝까지 내려오면 그대로 되돌린다.
  const [histIdx, setHistIdx] = useState<number | null>(null)
  const histDraft = useRef('')

  // 히스토리 항목/초안을 작성칸에 채우고 커서를 끝으로 보낸다
  const applyHistory = (text: string): void => {
    onChange(text)
    requestAnimationFrame(() => {
      const el = inputRef?.current
      if (!el) return
      el.focus()
      const n = el.value.length
      el.setSelectionRange(n, n)
      setCaret(n)
      grow(el)
    })
  }

  // ── "/" command palette ────────────────────────────────────
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [slashIdx, setSlashIdx] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const slashRef = useRef<HTMLDivElement>(null)
  const skillsCwd = useRef<string | null>(null)

  // the leading "/token" being typed (no space/newline yet), else null. 실행 중에도 연다 —
  // /ask는 즉시 실행되고(스케줄 경로가 가로챔), 나머지 명령/스킬은 예약돼 런이 끝나면 나간다.
  const slashQuery = value.startsWith('/') && !/\s/.test(value) ? value.slice(1).toLowerCase() : null

  // lazily load this project's skills the first time the palette is summoned
  useEffect(() => {
    if (slashQuery === null || skillsCwd.current === cwd) return
    skillsCwd.current = cwd
    window.api.skill
      .list(cwd)
      .then(setSkills)
      .catch(() => setSkills([]))
  }, [slashQuery, cwd])

  // every change to the query restarts the highlight; clearing the "/" un-dismisses
  useEffect(() => {
    setSlashIdx(0)
    if (slashQuery === null) setSlashDismissed(false)
  }, [slashQuery])

  // match the command/skill NAME only — not the description, so typing "cl" doesn't
  // surprise-match /init via its "…CLAUDE.md…" blurb
  const cmdHits = slashQuery === null ? [] : SLASH_COMMANDS.filter((c) => c.name.includes(slashQuery))
  const skillHits =
    slashQuery === null ? [] : skills.filter((s) => s.enabled && s.name.toLowerCase().includes(slashQuery))
  // command names first, then skill names — the flat order keyboard nav walks
  const slashNames = [...cmdHits.map((c) => c.name), ...skillHits.map((s) => s.name)]
  const slashOpen = slashQuery !== null && !slashDismissed && slashNames.length > 0
  const activeIdx = Math.min(slashIdx, slashNames.length - 1)

  // keep the highlighted row in view while arrowing through a long list
  useEffect(() => {
    if (!slashOpen) return
    slashRef.current?.querySelector(`[data-i="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, slashOpen])

  const pickSlash = (name: string): void => {
    onChange('/' + name + ' ') // fill the command + a space (closes the menu); user adds args / hits Enter
    requestAnimationFrame(() => {
      const el = inputRef?.current
      if (!el) return
      el.focus()
      const n = el.value.length
      el.setSelectionRange(n, n)
      grow(el)
    })
  }

  // ── "@" file mention palette ───────────────────────────────
  // Same command-palette chrome as "/", but triggers on the `@token` the caret sits
  // in (anywhere in the text, not just the start) and inserts a project-relative path.
  const [files, setFiles] = useState<string[]>([])
  const [caret, setCaret] = useState(0)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const mentionRef = useRef<HTMLDivElement>(null)
  const filesBaseRef = useRef<string | null>(null)

  // @ 멘션 기준 폴더 — 탐색기가 보고 있는 폴더(참고 폴더 포함), 없으면 작업 폴더. 작업
  // 폴더와 다르면(cwd 밖) 고른 파일은 에이전트가 Read 할 수 있게 절대 경로로 넣는다.
  const base = mentionBase || cwd
  const basePosix = base.replace(/\\/g, '/').replace(/\/+$/, '')
  const cwdPosix = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const baseIsMain = !mentionBase || basePosix.toLowerCase() === cwdPosix.toLowerCase()
  const baseName = basePosix.slice(basePosix.lastIndexOf('/') + 1)

  // the mention token under the caret — suppressed while busy or when "/" owns the menu
  const mentionTok = !busy && slashQuery === null ? mentionAtCaret(value, caret) : null
  const mentionActive = mentionTok !== null

  // lazily load the base folder's file list when a mention is summoned, and re-load
  // whenever the base changes (메인↔참고 폴더 전환 등)
  useEffect(() => {
    if (!mentionActive || filesBaseRef.current === base) return
    filesBaseRef.current = base
    window.api
      .listFiles(base)
      .then(setFiles)
      .catch(() => setFiles([]))
  }, [mentionActive, base])

  // restart the highlight on each query change; clearing the mention un-dismisses
  useEffect(() => {
    setMentionIdx(0)
    if (!mentionActive) setMentionDismissed(false)
  }, [mentionTok?.query, mentionActive])

  // browse the current folder (folders first) — or, once a name segment is typed,
  // recursively search files under it
  const mention = mentionTok ? mentionEntries(files, mentionTok.query) : null
  const mentionHits = mention?.entries ?? []
  const mentionOpen = mentionActive && !mentionDismissed && mentionHits.length > 0
  const activeMentionIdx = Math.min(mentionIdx, mentionHits.length - 1)
  // 팔레트 헤더에 보여줄 위치 — 참고 폴더 기준이면 그 폴더 이름을 앞에 붙여, 메인/참고
  // 중 어디서 찾는지 분명히 한다
  const mLocRel = mention?.base ? mention.base.replace(/\/$/, '') : ''
  const mLocFull = mLocRel
    ? baseIsMain
      ? mLocRel
      : baseName + '/' + mLocRel
    : baseIsMain
      ? '프로젝트 루트'
      : baseName

  useEffect(() => {
    if (!mentionOpen) return
    mentionRef.current?.querySelector(`[data-i="${activeMentionIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeMentionIdx, mentionOpen])

  // picking a folder drills in (insert "dir/", no space → palette re-opens one level
  // deeper); picking a file commits it (insert "path ", trailing space closes the menu)
  const pickMention = (entry: MentionEntry): void => {
    const tok = mentionAtCaret(value, caret)
    if (!tok) return
    const before = value.slice(0, tok.start)
    const after = value.slice(tok.end)
    // 폴더 = 한 단계 더 드릴(기준 폴더 상대 경로 유지) · 파일 = 확정. cwd 밖(참고 폴더)의
    // 파일은 상대경로로는 에이전트가 못 찾으니 절대 경로로 넣는다.
    const insert =
      entry.kind === 'dir'
        ? '@' + entry.full + '/'
        : '@' + (baseIsMain ? entry.full : basePosix + '/' + entry.full) + ' '
    const pos = (before + insert).length
    onChange(before + insert + after)
    setCaret(pos) // keep caret state in sync this render so the palette re-resolves cleanly
    requestAnimationFrame(() => {
      const el = inputRef?.current
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
    // 팔레트가 닫혀 있을 때만: ↑/↓로 내가 보낸 메시지를 셸처럼 다시 불러온다.
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
      // while the agent is busy, Enter queues the draft instead of sending it
      if (busy) onSchedule()
      else onSend()
    }
  }

  // ── image drag-and-drop + paste ────────────────────────────
  const dragHasFile = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.items || []).some((it) => it.kind === 'file')

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    dragDepth.current = 0
    setDragOver(false)
    if (!e.dataTransfer.files?.length) return
    e.preventDefault()
    const paths = await filesToImagePaths(e.dataTransfer.files)
    if (paths.length) onAddImagePaths(paths)
  }

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const imgs = Array.from(e.clipboardData.files || []).filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    e.preventDefault() // a pasted screenshot becomes an attachment, not pasted text
    const paths = await filesToImagePaths(imgs)
    if (paths.length) onAddImagePaths(paths)
  }

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {showContext && (
          <ContextStrip
            winTokens={winTokens}
            contextTokens={contextTokens}
            usage={usage}
            apiMode={apiMode}
            chatSpentUsd={chatSpentUsd}
            budgetUsd={budgetUsd}
            totalSpentUsd={totalSpentUsd}
          />
        )}

        {queued.length > 0 && (
          <div className="sched">
            <div className="sched-head">
              <span className="sched-title">
                <IconClock size={14} />
                예약된 메시지 {queued.length}
              </span>
              <span className="sched-hint">작업이 끝나면 순서대로 전송돼요</span>
            </div>
            <div className="sched-list">
              {queued.map((m, i) => (
                <div className="sched-item" key={m.id}>
                  <span className="sched-num">{i + 1}</span>
                  <span className="sched-text">
                    {m.text.trim() || (m.images.length ? `이미지 ${m.images.length}장` : '')}
                  </span>
                  {m.images.length > 0 && (
                    <span className="sched-img" title={`이미지 ${m.images.length}장`}>
                      <IconImage size={14} />
                    </span>
                  )}
                  <button
                    className="sched-x has-tip"
                    aria-label="예약 취소"
                    data-tip="예약 취소"
                    onClick={() => onRemoveQueued(m.id)}
                  >
                    <IconX2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div
          className={'composer' + (focus ? ' focus' : '') + (dragOver ? ' drag' : '') + (busy ? ' scheduling' : '')}
          onDragEnter={(e) => {
            if (!dragHasFile(e)) return
            dragDepth.current += 1
            setDragOver(true)
          }}
          onDragOver={(e) => {
            if (!dragHasFile(e)) return
            e.preventDefault() // mark the composer a valid drop target (enables the drop)
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
              <IconImage size={24} />
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
                      e.preventDefault() // keep focus in the textarea
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
                    <span>‘{mention.term}’ 검색{!baseIsMain || mLocRel ? ' · ' + mLocFull : ''}</span>
                  </>
                ) : (
                  <>
                    <IconFolder size={11} />
                    <span>
                      {mLocFull}
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
                    ev.preventDefault() // keep focus in the textarea
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
            <div className="img-tray">
              {images.map((p, i) => (
                <div className="img-thumb" key={p + i}>
                  <button
                    type="button"
                    className="img-thumb-open"
                    onClick={() => onOpenImage?.(images, i)}
                    aria-label={imageName(p)}
                    title={imageName(p)}
                  >
                    <img src={imageSrc(p)} alt={imageName(p)} draggable={false} />
                  </button>
                  <button className="img-thumb-x has-tip" onClick={() => onRemoveImage(i)} aria-label="제거" data-tip="제거">
                    <IconX2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            placeholder={busy ? '다음 메시지를 예약하세요… (작업 후 자동 전송)' : started ? '메세지를 입력하세요.' : '오늘 어떤 도움을 드릴까요?'}
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
              setHistIdx(null) // 직접 타이핑하면 히스토리 탐색에서 빠져나온다
              grow(e.target)
            }}
            // track caret moves (arrows, clicks) so the "@" palette follows the token under it
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={handleKey}
            onPaste={onPaste}
            onFocus={() => {
              setFocus(true)
              setSlashDismissed(false)
              setMentionDismissed(false)
            }}
            onBlur={() => {
              setFocus(false)
              setSlashDismissed(true) // clicking away closes the palette
              setMentionDismissed(true)
            }}
          />
          <div className="composer-bar">
            <button className="cm-icon has-tip" aria-label="이미지 첨부" data-tip="이미지 첨부" onClick={onPickImages}>
              <IconImage size={16} />
            </button>
            <Pick
              label="모델"
              value={modelOpt.v}
              options={MODELS}
              onChange={(v) => setPicker({ ...picker, model: (MODELS.find((m) => m.v === v) ?? MODELS[0]).id })}
              dots
              tip="모델 — 응답 품질·속도"
            />
            <span className="pick-div" />
            <Pick
              label="Effort"
              value={effortOpt.v}
              options={EFFORTS}
              onChange={(v) => setPicker({ ...picker, effort: (EFFORTS.find((m) => m.v === v) ?? EFFORTS[2]).id })}
              bars
              tip="추론 강도 — 깊이 vs 속도"
            />
            <span className="pick-div" />
            <Pick
              label="모드"
              value={modeOpt.v}
              options={MODES}
              onChange={(v) => setPicker({ ...picker, mode: (MODES.find((m) => m.v === v) ?? MODES[0]).id })}
              align="right"
              icons
              tip="실행 모드 — 변경 승인 방식"
            />
            {onApiModeChange && (
              <>
                <span className="pick-div" />
                <BillingPick apiMode={apiMode} apiReady={apiReady} onChange={onApiModeChange} align="right" />
              </>
            )}
            <span className="cm-spacer" />
            {busy ? (
              value.trim() || images.length > 0 ? (
                <button className="send schedule has-tip" aria-label="예약" data-tip="작업 후 전송 예약 (Enter)" onClick={onSchedule}>
                  <IconClock size={17} />
                </button>
              ) : (
                <button className="send stop has-tip" aria-label="중지" data-tip="실행 중지" onClick={onStop}>
                  <IconClose size={17} />
                </button>
              )
            ) : (
              <button className="send has-tip" aria-label="보내기" data-tip="보내기 (Enter)" disabled={!value.trim() && images.length === 0} onClick={onSend}>
                <IconSend size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
