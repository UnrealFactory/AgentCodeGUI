import { Fragment, memo, useEffect, useRef, useState, type CSSProperties, type ComponentType, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type {
  ModelId,
  EffortId,
  ModeId,
  UsageInfo,
  UsageWindow,
  ExtraCreditInfo,
  ToolLogItem,
  AgentQuestion,
  SkillInfo,
  AgentStatus,
  Todo,
  ChangedFile,
  SubAgentInfo,
  BgTask,
  BgTaskRequest,
  AccountInfo,
  AccountUsage
} from '@shared/protocol'
import type { ThreadItem } from '../store/session'
import { Markdown } from './Markdown'
import { FileBadge } from './fileType'
import { MouseGestureLayer, scrollGestures } from './mouseGesture'
import { StatusPill, Todos, FileRow, SubAgent } from './AgentPanel'
import { mentionAtCaret, mentionEntries, type MentionEntry } from '../lib/mentions'
import { imageSrc, imageName, filesToAttachmentPaths, isImagePath, isAttachablePath } from '../lib/images'
import {
  IconClaude,
  IconImage,
  IconPaperclip,
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
  IconUser,
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
// 모드 + 과금 + 계정 picker가 함께 쓰는 아이콘 키 (Pick의 icons 렌더링)
const MODE_ICONS = { shield: IconShieldChk, plan: IconClipList, check: IconCheckCirc, bolt: IconBolt, warn: IconAlert, card: IconCard, key: IconKey, user: IconUser }
// 드롭다운 표시는 가장 위험한 것부터(우회→일반). 폴백·순환 방향은 아래 MODE_FALLBACK·nextMode가 보정.
const MODES: ModeOpt[] = [
  // 우회는 위험 모드지만 텍스트는 다른 모드와 동일하게(흰색·한국어) — 빨간 경고 삼각형으로만 위험 표시
  { v: '우회', id: 'bypass', d: '모든 권한 확인 건너뛰기', color: 'var(--red)', icon: 'warn' },
  { v: '자동', id: 'auto', d: '도구 실행까지 자동 진행', color: 'var(--violet)', icon: 'bolt' },
  { v: '모두 허용', id: 'acceptEdits', d: '파일 편집 자동 수락', color: 'var(--yellow)', icon: 'check' },
  { v: '플랜', id: 'plan', d: '계획만 수립, 실행은 승인 후', color: 'var(--blue)', icon: 'plan' },
  { v: '일반', id: 'normal', d: '변경마다 승인 요청', color: 'var(--text-3)', icon: 'shield' }
]
// 배열 순서와 무관하게 폴백 기본값은 항상 '일반'
const MODE_FALLBACK = MODES.find((m) => m.id === 'normal') ?? MODES[MODES.length - 1]

export interface PickerState {
  model: ModelId
  effort: EffortId
  mode: ModeId
  // 이 채팅의 실행 계정(등록 계정 이메일) — 없으면 전역 활성 계정을 따른다. 과금이
  // '구독'일 때만 의미가 있다(API 모드 실행에선 엔진이 무시).
  account?: string
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

// next run mode — used by the Shift+Tab shortcut. 배열은 위험한 것부터라(우회→일반)
// 역방향으로 걸어 기존 순환 순서(일반→플랜→모두 허용→자동→우회→일반)를 유지한다.
export function nextMode(current: ModeId): ModeId {
  const i = MODES.findIndex((m) => m.id === current)
  return MODES[(i - 1 + MODES.length) % MODES.length].id
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

// 실행 시간 표시 (bash 행 요약·모달) — 10초 미만은 소수 한 자리, 1분 넘으면 m s
function fmtDur(ms: number): string {
  const s = ms / 1000
  if (s < 10) return s.toFixed(1) + 's'
  if (s < 60) return Math.round(s) + 's'
  return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's'
}

// result shown on the right: a spinner while running, a red mark on error, the +/-
// line counts for edits (colored), or the tool's text summary otherwise.
// Bash는 '✓' 대신 실행 시간 · 출력 줄수 — 다른 도구의 '10줄'과 같은 문법.
function ToolResult({ t }: { t: ToolLogItem }) {
  if (t.status === 'running') return <span className="t-res"><span className="spin" /></span>
  if (t.status === 'error') return <span className="t-res err">오류</span>
  if (t.kind === 'bash') {
    const parts = [
      t.durationMs != null ? fmtDur(t.durationMs) : '',
      t.output ? `${t.output.split('\n').length}줄` : ''
    ].filter(Boolean)
    if (parts.length) return <span className="t-res">{parts.join(' · ')}</span>
  }
  const diff = (t.result ?? '').match(/^\+(\d+) -(\d+)$/)
  if (diff)
    return (
      <span className="t-res">
        <span className="add">+{diff[1]}</span> <span className="del">−{diff[2]}</span>
      </span>
    )
  return <span className="t-res">{t.result ?? ''}</span>
}

// 실패 출력에서 에러로 읽히는 줄만 붉게 — 성공 출력은 설치 로그처럼 완전 무채색 유지
function bashErrLine(failed: boolean, ln: string): boolean {
  return failed && /(^|\s)(error|err!|fatal|exception|failed)\b/i.test(ln)
}

// Bash 전체 로그 모달 — 인라인 펼침은 좁아서 읽기 어렵다는 피드백으로 교체.
// '명령'과 '출력'을 섹션으로 나눠 요청/결과가 한눈에 읽힌다. 채팅 스크롤러/가상화
// 밖(body 포털)에 그려서 어느 화면(메인·멀티 패널·추가 채팅)에서 열어도 안전하다.
function BashLogModal({ t, onClose }: { t: ToolLogItem; onClose: () => void }) {
  // 복사 피드백 — 명령/출력 어느 쪽을 복사했는지 구분 (복사 → 복사됨 1.2s, 설정 CopyRow 이디엄)
  const [copied, setCopied] = useState<'cmd' | 'out' | null>(null)
  // 마우스 제스처(↑/↓ 출력 스크롤 · ↓→ 닫기) 대상 — 카드 엘리먼트를 state로 추적
  const [card, setCard] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Ctrl+W — main이 앱 종료를 삼키고 보내는 신호(shortcut:close). 코드 뷰어와 같은 규칙.
    const offCloseShortcut = window.api.onCloseShortcut(onClose)
    return () => {
      document.removeEventListener('keydown', onKey)
      offCloseShortcut()
    }
  }, [onClose])
  const failed = t.status === 'error'
  const lines = (t.output ?? '').split('\n')
  const copy = (which: 'cmd' | 'out', text: string): void => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(which)
        setTimeout(() => setCopied(null), 1200)
      })
      .catch(() => {})
  }
  return createPortal(
    <div className="sa-overlay" onMouseDown={onClose}>
      <div className="bm-card" ref={setCard} onMouseDown={(e) => e.stopPropagation()}>
        <div className="bm-head">
          <span className={'bm-ic' + (failed ? ' err' : '')}>
            <IconTerminal size={16} />
          </span>
          <div className="bm-title">Bash</div>
          <span className={'bm-status' + (failed ? ' err' : '')}>{failed ? '실패' : '완료'}</span>
          <button className="sa-card-close" onClick={onClose} aria-label="닫기">
            <IconClose size={18} />
          </button>
        </div>
        <div className="bm-body">
          <div className="bm-lbl">
            <span>명령</span>
            <span className="bo-sp" />
            <button className={'bm-copy' + (copied === 'cmd' ? ' on' : '')} onClick={() => copy('cmd', t.target)}>
              {copied === 'cmd' ? '복사됨' : '복사'}
            </button>
          </div>
          <div className="bm-cmd scroll">{t.target}</div>
          <div className="bm-lbl">
            <span>출력</span>
            <span className="bo-sp" />
            <button className={'bm-copy' + (copied === 'out' ? ' on' : '')} onClick={() => copy('out', t.output ?? '')}>
              {copied === 'out' ? '복사됨' : '복사'}
            </button>
          </div>
          <div className="bm-log scroll">
            {lines.map((ln, i) => (
              <div key={i} className={'bo-ln' + (bashErrLine(failed, ln) ? ' err' : '')}>
                {/* 빈 줄은 NBSP로 높이 유지 — 일반 공백은 collapse돼 줄이 사라진다 */}
                {ln || '\u00A0'}
              </div>
            ))}
          </div>
        </div>
        <div className="bm-foot">
          {/* 실행 시간 · 줄수 — 엔진이 끝 200줄/16KB만 실어 보내는 캡은 '끝부분 200줄'로 알린다 */}
          <span>
            {t.durationMs != null ? `${fmtDur(t.durationMs)} · ` : ''}
            {lines.length >= 200 ? '끝부분 200줄' : `${lines.length}줄`}
          </span>
        </div>
      </div>
      <MouseGestureLayer
        target={card}
        actions={[...scrollGestures(() => card?.querySelector('.bm-log')), { pattern: 'DR', label: '창 닫기', run: onClose }]}
      />
    </div>,
    document.body
  )
}

// Bash 행 — Read/Edit 행이 파일을 열듯 명령(t-target)을 클릭하면 전체 로그 모달이
// 열린다(호버 툴팁 '결과 보기'). 인라인 출력은 성공·실패 모두 없음 — 실패도 우측
// '오류' 요약만 남기고, 내용은 다른 도구들과 똑같이 클릭해서 모달로 읽는다.
function BashRow({ t }: { t: ToolLogItem }) {
  const [open, setOpen] = useState(false)
  const clickable = !!t.output
  return (
    <>
      <div
        className={'t-row bash ' + t.status + (clickable ? ' openable' : '')}
        onClick={clickable ? () => setOpen(true) : undefined}
      >
        <span className="t-ic">{toolIcon('bash', 14)}</span>
        <span className="t-verb">{t.verb}</span>
        <span className="t-sep">·</span>
        <span className={'t-target' + (clickable ? ' has-tip' : '')} data-tip={clickable ? '결과 보기' : undefined}>
          {t.target}
        </span>
        <ToolResult t={t} />
      </div>
      {open && t.output && <BashLogModal t={t} onClose={() => setOpen(false)} />}
    </>
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
        if (t.kind === 'bash') return <BashRow t={t} key={t.id} />
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
// Attachments inside a sent message. Images show as a matted "photo card" — a single
// image is one framed card; multiple images collapse into a stacked deck (the first
// image on top, blank cards peeking behind) with a "N장" count badge; a click opens the
// viewer at the first image (the filmstrip browses the rest). Text/doc attachments show
// as filename chips (file-type icon + name); a click opens the in-app file viewer.
function MessageAttachments({
  images,
  onOpen,
  onOpenFile
}: {
  images: string[] // 모든 첨부 경로 (필드명은 저장 호환을 위해 images 유지)
  onOpen?: (images: string[], index: number) => void
  onOpenFile?: (path: string) => void
}) {
  const imgs = images.filter(isImagePath)
  const docs = images.filter((p) => !isImagePath(p))
  const count = imgs.length
  const multi = count > 1
  const first = imgs[0]
  return (
    <>
      {count > 0 && (
        // 툴팁은 래퍼에 — .msg-img 버튼은 overflow:hidden이라 ::after가 잘린다
        <div className={'msg-imgs has-tip' + (multi ? ' deck' : '')} data-tip={multi ? `이미지 ${count}장` : imageName(first)}>
          {multi && (
            <>
              <span className="msg-img-stack s2" aria-hidden="true" />
              <span className="msg-img-stack s1" aria-hidden="true" />
            </>
          )}
          <button className="msg-img" onClick={() => onOpen?.(imgs, 0)} aria-label={multi ? `이미지 ${count}장` : imageName(first)}>
            <img src={imageSrc(first)} alt={imageName(first)} draggable={false} loading="lazy" />
            {multi && (
              <span className="msg-img-count">
                <IconImage size={13} />
                {count}장
              </span>
            )}
          </button>
        </div>
      )}
      {docs.length > 0 && (
        <div className="msg-docs">
          {docs.map((p, i) => (
            <button key={p + i} className="msg-doc has-tip tip-path" data-tip={p} onClick={() => onOpenFile?.(p)} aria-label={imageName(p)}>
              <FileBadge path={p} size={15} />
              <span className="msg-doc-name">{imageName(p)}</span>
            </button>
          ))}
        </div>
      )}
    </>
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
      <div className="working-line">
        <span className="working-spark">
          <IconClaude size={17} />
        </span>
        <span className="working-label">{item.text}</span>
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
            <MessageAttachments images={item.images} onOpen={onOpenImage} onOpenFile={onOpenFile} />
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
  // 생각·궁리
  '골똘히 생각하는 중',
  '머리 굴리는 중',
  '곰곰이 따져보는 중',
  '차근차근 정리하는 중',
  '고민에 고민을 더하는 중',
  '차분히 헤아리는 중',
  '곱씹어보는 중',
  '요모조모 뜯어보는 중',
  '하나하나 짚어보는 중',
  '갈피를 잡는 중',
  '감을 잡는 중',
  '머릿속을 정돈하는 중',
  '생각을 가다듬는 중',
  '생각의 갈래를 나누는 중',
  '핵심만 골라내는 중',
  '앞뒤를 맞춰보는 중',
  '정신 집중하는 중',
  '맥락을 읽는 중',
  '흐름을 따라가는 중',
  // 두뇌·회로
  '뇌를 가동하는 중',
  '머릿속 회로 돌리는 중',
  '톱니바퀴 돌리는 중',
  '두뇌 풀가동 중',
  '두뇌 예열중',
  '회로 점검중',
  '두뇌 엔진 데우는 중',
  '기어를 올리는 중',
  '생각 회로에 불 켜는 중',
  '두뇌 터빈 돌리는 중',
  '뉴런 총출동 중',
  '시냅스 달구는 중',
  '뉴런을 깨우는 중',
  '시냅스 연결하는 중',
  '뇌세포 소집하는 중',
  '회로도를 따라가는 중',
  '배선을 정리하는 중',
  '신호를 추적하는 중',
  '머릿속 주판 튕기는 중',
  '머릿속 칠판에 적는 중',
  '머릿속 서랍을 뒤지는 중',
  '기억의 책장을 넘기는 중',
  '머릿속 실험실 가동 중',
  // 추리·수사
  '단서를 모으는 중',
  '실마리를 푸는 중',
  '돋보기 들이대는 중',
  '발자국 따라가는 중',
  '수수께끼를 푸는 중',
  '단서를 맞춰보는 중',
  '흩어진 단서를 줍는 중',
  '추리를 이어가는 중',
  '진상을 파헤치는 중',
  '범인을 좁혀가는 중',
  '버그 자취를 쫓는 중',
  '안개를 걷어내는 중',
  '촉을 세우는 중',
  // 탐험·발굴
  '이리저리 탐색하는 중',
  '코드 숲을 헤매는 중',
  '보물 찾는 중',
  '지도를 펼치는 중',
  '미궁을 헤치는 중',
  '미로에서 길 찾는 중',
  '깊이 파고드는 중',
  '지름길을 찾는 중',
  '샛길을 살피는 중',
  '갈림길에서 고르는 중',
  '코드 바다를 항해하는 중',
  '깊은 곳까지 잠수하는 중',
  '광맥을 캐는 중',
  '원석을 캐는 중',
  '점들을 잇는 중',
  '별자리를 잇는 중',
  // 퍼즐·엮기
  '퍼즐 맞추는 중',
  '조합해보는 중',
  '생각의 실타래 푸는 중',
  '매듭을 푸는 중',
  '빈칸을 채우는 중',
  '한 땀 한 땀 엮는 중',
  '차곡차곡 쌓는 중',
  '딱 맞는 조각 찾는 중',
  '틀을 짜는 중',
  '촘촘히 엮는 중',
  // 코드·논리
  '코드 들여다보는 중',
  '코드를 음미하는 중',
  '논리를 다듬는 중',
  '경우의 수를 세는 중',
  '가능성을 저울질하는 중',
  '코드 결을 살피는 중',
  '코드 행간을 읽는 중',
  '로직을 굴려보는 중',
  '실행 흐름을 짚는 중',
  '흐름을 거슬러 올라가는 중',
  '변수를 저울질하는 중',
  '변수를 하나씩 소거하는 중',
  '논리를 갈고닦는 중',
  '가설을 세우는 중',
  '가설을 검증하는 중',
  '반례를 찾아보는 중',
  '허점을 메우는 중',
  '빈틈을 살피는 중',
  '방정식을 푸는 중',
  // 설계·구축
  '큰 그림 그리는 중',
  '설계도를 펼치는 중',
  '청사진을 그리는 중',
  '밑그림 그리는 중',
  '뼈대를 세우는 중',
  '주춧돌 놓는 중',
  '판을 짜는 중',
  '수순을 정하는 중',
  '벽돌을 한 장씩 쌓는 중',
  '징검다리 놓는 중',
  '첫 단추를 끼우는 중',
  // 수읽기·승부
  '묘수를 찾는 중',
  '반짝이는 수를 고르는 중',
  '묘안을 짜내는 중',
  '다음 수를 읽는 중',
  '몇 수 앞을 내다보는 중',
  '판세를 읽는 중',
  '포석을 놓는 중',
  '외통수를 찾는 중',
  '승부수를 고르는 중',
  '묘수풀이 하는 중',
  '패를 맞춰보는 중',
  // 생각 요리·숙성 — 생각/아이디어/답이 주어로 오는 것만
  '아이디어 굽는 중',
  '생각을 졸이는 중',
  '생각을 우려내는 중',
  '아이디어 반죽하는 중',
  '답을 숙성시키는 중',
  '노릇하게 굽는 중',
  '갓 구운 답 꺼내는 중',
  '생각을 뜸 들이는 중',
  '생각을 재우는 중',
  '생각을 체에 거르는 중',
  '생각을 증류하는 중',
  '아이디어를 발효시키는 중',
  '아이디어를 배양하는 중',
  '발상을 버무리는 중',
  '발상을 굴리는 중',
  '답을 빚는 중',
  // 영감·마법
  '마법 부리는 중',
  '영감을 부르는 중',
  '번뜩임 기다리는 중',
  '아이디어에 불씨 지피는 중',
  '영감의 안테나 세우는 중',
  '마법진을 그리는 중',
  '주문을 외는 중',
  // 몸풀기
  '슬슬 시동 거는 중',
  '손가락 푸는 중',
  '열심히 만지작거리는 중',
  '톡톡 두드려보는 중',
  '머리를 쥐어짜는 중'
]

// 멘트 shimmer 색 추첨 — 화이트 59%, 단색 19종 각 2%(합 38%), 그라디언트 6종 각 0.5%(합 3%).
// 단색은 wc-* 클래스가 base/hi 색만 바꾸고, 그라디언트는 wc-flow가 색 띠를 계속 흘린다(styles.css).
const PHRASE_SOLID_COLORS = ['orange', 'gold', 'lemon', 'lime', 'green', 'mint', 'teal', 'aqua', 'sky', 'blue', 'indigo', 'lavender', 'purple', 'magenta', 'pink', 'rose', 'coral', 'red', 'mocha']
const PHRASE_FLOW_COLORS = ['rainbow', 'sunset', 'ocean', 'aurora', 'fire', 'neon']
function rollPhraseColor(): string {
  let r = Math.random() * 100
  if ((r -= 59) < 0) return ''
  for (const c of PHRASE_SOLID_COLORS) if ((r -= 2) < 0) return 'wc wc-' + c
  for (const c of PHRASE_FLOW_COLORS) if ((r -= 0.5) < 0) return 'wc-flow wc-' + c
  return ''
}

// Persistent "working" indicator shown in the chat while the agent is busy, so
// the user can always tell it's running (not stuck). Shows the latest thinking
// summary when available, otherwise a rotating playful label.
export function WorkingIndicator({ text }: { text: string | null }) {
  const [i, setI] = useState(() => Math.floor(Math.random() * WORKING_PHRASES.length))
  const [color, setColor] = useState(rollPhraseColor)
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
          setColor(rollPhraseColor())
          schedule()
        },
        5000 + Math.random() * 15000
      )
    }
    schedule()
    return () => clearTimeout(id)
  }, [])
  const label = text || WORKING_PHRASES[i]
  // claude.ai 스타일 미니멀: 아바타 상자·점 없이 [스파크(펄스+회전) + shimmer 문구]만.
  // 색은 랜덤멘트에만 — thinking 요약은 항상 기본 화이트.
  return (
    <div className="working-line">
      <span className="working-spark">
        <IconClaude size={17} />
      </span>
      <span key={label} className={'working-label' + (text || !color ? '' : ' ' + color)}>
        {label}
      </span>
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

// ── 채팅 내 검색 (Ctrl+F) ────────────────────────────────────
// 파일 뷰어의 FindBar와 같은 CSS Custom Highlight API로 스레드 텍스트에 매치를 칠한다 —
// DOM(innerHTML)을 건드리지 않아 마크다운·스트리밍 렌더와 충돌하지 않는다. 하이라이트
// 키(chatfind)는 CSS ::highlight() 선택자와 묶여 고정이라, 한 번에 한 검색 바만 열려
// 있어야 한다 — 멀티 모드에선 active(포커스/확대된 패널)만 반응하고 나머지는 스스로 닫는다.
interface CFHighlightCtor {
  new (...r: Range[]): unknown
}
const CF_HL = (globalThis as unknown as { Highlight?: CFHighlightCtor }).Highlight
const CF_REG = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
// Ctrl+F를 스스로 처리하는 오버레이(파일 뷰어·설정·깃 등)가 떠 있으면 채팅 검색은 비켜선다
const CF_BLOCKING = '.fv-overlay, .set-overlay, .gitm-overlay, .ask-overlay, .iv-overlay, .sa-overlay, .set-dialog-overlay'

// 스크롤 컨테이너 안 텍스트 노드를 훑어 q(대소문자 무시)의 매치마다 Range를 만든다.
// 컨테이너 전체를 한 블록으로 스캔해 마크다운 span 으로 쪼개진 텍스트 경계를 넘는 매치도 잡는다.
function collectChatRanges(root: HTMLElement, q: string): Range[] {
  const query = q.toLowerCase()
  if (!query) return []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const offs: number[] = []
  let text = ''
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push(n)
    offs.push(text.length)
    text += n.data
  }
  if (!text) return []
  const low = text.toLowerCase()
  // pos(전체 문자 오프셋) → 그 글자가 든 텍스트 노드와 노드 내 오프셋
  const locate = (pos: number, isEnd: boolean): { n: Text; o: number } => {
    const p = isEnd ? pos - 1 : pos
    let i = offs.length - 1
    while (i > 0 && offs[i] > p) i--
    return { n: nodes[i], o: pos - offs[i] }
  }
  const out: Range[] = []
  let idx = low.indexOf(query)
  while (idx >= 0 && out.length < 2000) {
    const s = locate(idx, false)
    const e = locate(idx + query.length, true)
    try {
      const r = document.createRange()
      r.setStart(s.n, s.o)
      r.setEnd(e.n, e.o)
      out.push(r)
    } catch {
      /* 경계 계산이 어긋난 매치는 건너뛴다 */
    }
    idx = low.indexOf(query, idx + Math.max(query.length, 1))
  }
  return out
}

export function ChatFind({
  scrollRef,
  active = true,
  panel = false
}: {
  scrollRef: React.RefObject<HTMLElement | null>
  active?: boolean // Ctrl+F에 반응할지 — 멀티 모드에선 포커스/확대된 패널만 true
  panel?: boolean // 멀티 패널 안(작은 폭)에 뜨는 변형
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cur, setCur] = useState(0)
  const [total, setTotal] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])
  const queryRef = useRef(query)
  queryRef.current = query

  const clearHl = (): void => {
    CF_REG?.delete('chatfind')
    CF_REG?.delete('chatfind-cur')
  }
  // 닫기 — 하이라이트까지 걷어낸다
  const close = (): void => {
    setOpen(false)
    setQuery('')
    setCur(0)
    setTotal(0)
    clearHl()
  }

  // Ctrl+F: 열기(이미 열려 있으면 입력 재선택). active 인스턴스만, Ctrl+F를 스스로 갖는
  // 오버레이가 없고 이 채팅 표면이 실제로 화면에 떠 있을 때만 반응한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f')) return
      if (!active) return
      const root = scrollRef.current
      if (!root || root.offsetParent === null) return
      if (document.querySelector(CF_BLOCKING)) return
      e.preventDefault()
      if (open) {
        inputRef.current?.select()
        return
      }
      // 짧은 한 줄 선택이 있으면 초기 검색어로 (브라우저 Ctrl+F 관례)
      const sel = window.getSelection()?.toString().trim() ?? ''
      setQuery(sel && sel.length <= 80 && !sel.includes('\n') ? sel : '')
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, open, scrollRef])

  // 비활성(멀티 모드에서 포커스를 잃은 패널)이 되면 닫아 한 번에 하나만 열리게 한다
  useEffect(() => {
    if (!active && open) close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // 언마운트 시 하이라이트 정리
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => clearHl(), [])

  // 열리면 입력에 포커스(초기 검색어가 있으면 전체 선택해 바로 덮어쓰기 쉽게)
  useEffect(() => {
    if (open) inputRef.current?.select()
  }, [open])

  // 쿼리/본문 변화 → 매치 재수집 + 전체 하이라이트. 스트리밍으로 스레드가 바뀌면
  // MutationObserver로 다시 칠한다(아래에서 150ms로 묶어 과도한 재계산을 막는다).
  useEffect(() => {
    if (!open) return
    const root = scrollRef.current
    if (!root) return
    const run = (reset: boolean): void => {
      const rs = collectChatRanges(root, queryRef.current)
      rangesRef.current = rs
      setTotal(rs.length)
      // 새 검색어면 첫 매치로(reset), 스트리밍 재계산이면 현재 위치를 최대한 유지(clamp)
      setCur((c) => (rs.length ? (reset ? 0 : Math.min(c, rs.length - 1)) : 0))
      CF_REG?.delete('chatfind')
      if (rs.length && CF_HL && CF_REG) CF_REG.set('chatfind', new CF_HL(...rs))
      if (!rs.length) CF_REG?.delete('chatfind-cur')
    }
    run(true)
    // 스트리밍 중엔 characterData가 초당 여러 번 바뀐다 — 150ms로 묶어 재계산 부담을 던다
    let timer: ReturnType<typeof setTimeout> | null = null
    const obs = new MutationObserver(() => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        run(false)
      }, 150)
    })
    obs.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      obs.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [open, query, scrollRef])

  // 현재 매치 강조 + (화면 밖일 때만) 가운데로 스크롤 — 스트리밍 재계산에 화면이 튀지 않게
  useEffect(() => {
    if (!open) return
    CF_REG?.delete('chatfind-cur')
    const r = rangesRef.current[cur]
    if (!r) return
    if (CF_HL && CF_REG) CF_REG.set('chatfind-cur', new CF_HL(r))
    const el = r.startContainer.nodeType === Node.TEXT_NODE ? r.startContainer.parentElement : (r.startContainer as Element)
    const cont = scrollRef.current
    if (el && cont) {
      const er = el.getBoundingClientRect()
      const cr = cont.getBoundingClientRect()
      if (er.top < cr.top + 8 || er.bottom > cr.bottom - 8) el.scrollIntoView({ block: 'center' })
    }
  }, [cur, total, open, scrollRef])

  const step = (d: number): void => {
    const n = rangesRef.current.length
    if (!n) return
    setCur((c) => (c + d + n) % n)
  }

  if (!open) return null
  return (
    <div className={'fv-find chat-find' + (panel ? ' chat-find--panel' : '')}>
      <IconSearch size={13} />
      <input
        ref={inputRef}
        autoFocus
        value={query}
        placeholder="채팅 내 검색…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
      />
      <span className="cnt">{total ? `${cur + 1}/${total}` : query ? '0개' : ''}</span>
      <button className="has-tip" data-tip="이전 (Shift+Enter)" aria-label="이전 결과" onClick={() => step(-1)} disabled={!total}>
        <IconChevDown size={14} style={{ transform: 'rotate(180deg)' }} />
      </button>
      <button className="has-tip" data-tip="다음 (Enter)" aria-label="다음 결과" onClick={() => step(1)} disabled={!total}>
        <IconChevDown size={14} />
      </button>
      <button className="has-tip" data-tip="닫기 (Esc)" aria-label="검색 닫기" onClick={close}>
        <IconClose size={14} />
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
  valueLabel?: string // 버튼에 표시할 짧은 값 (없으면 value 그대로) — 긴 이메일 등
  options: O[]
  onChange: (v: string) => void
  align?: 'right'
  dots?: boolean
  bars?: boolean
  icons?: boolean
  tip?: string
}
function Pick<O extends { v: string; d?: string; d2?: string; color?: string; level?: number; icon?: keyof typeof MODE_ICONS; warn?: boolean }>({
  label,
  value,
  valueLabel,
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
        <span className="pick-val">{valueLabel ?? value}</span>
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
                  {o.d2 && <span className="po-desc">{o.d2}</span>}
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

// ── 계정 목록 캐시 (계정 picker 공용) ─────────────────────────
// listAccounts는 메인이 CLI 프로세스를 하나 띄워 상태를 묻는다(auth status) — picker
// 마운트마다 부르면 무겁다. 모듈 캐시 + TTL로 화면의 여러 picker(컴포저·패널들)가
// 한 번의 조회를 나눠 쓴다. 계정 목록은 설정에서만 바뀌니 1분이면 충분히 신선하다.
let acctCache: { at: number; list: AccountInfo[] } | null = null
let acctInflight: Promise<AccountInfo[]> | null = null
const ACCT_TTL = 60_000
// 계정별 아이콘 색 — 등록 순서대로 배정해 어디서 열어도 같은 계정 = 같은 색.
// 컴포저에서 설정 가능한 것들과 색이 겹치면 안 된다: 모델(골드·바이올렛·블루·틸),
// 모드(블루·옐로·바이올렛·레드), 과금(로즈·그린), 경고(레드)가 이미 점유 → 계정은
// 전용 팔레트(시안·라임·오렌지·마젠타, 로즈에서 먼 순)를 쓴다.
const ACCT_COLORS = ['var(--cyan)', 'var(--lime)', 'var(--orange)', 'var(--magenta)']

// 계정별 한도 사용률(5시간·주간·Fable) — 설정 → Account와 같은 조회를 나눠 쓴다.
// 계정마다 네트워크 요청이 나가므로 계정 목록과 같은 방식의 모듈 캐시 + TTL.
let usageCache: { at: number; map: Record<string, AccountUsage> } | null = null
let usageInflight: Promise<Record<string, AccountUsage>> | null = null
function fetchAccountsUsage(): Promise<Record<string, AccountUsage>> {
  if (usageCache && Date.now() - usageCache.at < ACCT_TTL) return Promise.resolve(usageCache.map)
  if (usageInflight) return usageInflight
  usageInflight = window.api.auth
    .accountsUsage()
    .then((us: AccountUsage[]) => {
      const map = Object.fromEntries(us.map((u) => [u.email, u]))
      usageCache = { at: Date.now(), map }
      usageInflight = null
      return map
    })
    .catch(() => {
      usageInflight = null
      return usageCache?.map ?? {}
    })
  return usageInflight
}

// 계정 옵션의 잔여 한도 줄 — 앱 전체 관례(잔여 % = 100 − 사용률, 설정 → Account와 동일).
// 조회 못 한 항목은 조용히 빠진다(저장 토큰 만료 등 — 실행하면 CLI가 리프레시한다).
function acctUsageLine(u?: AccountUsage): string {
  if (!u) return ''
  const parts: string[] = []
  if (u.fiveHourPct != null) parts.push(`5시간 ${100 - u.fiveHourPct}%`)
  if (u.weeklyPct != null) parts.push(`주간 ${100 - u.weeklyPct}%`)
  if (u.fablePct != null) parts.push(`Fable ${100 - u.fablePct}%`)
  return parts.length ? `남음 ${parts.join(' · ')}` : ''
}
function fetchAccounts(): Promise<AccountInfo[]> {
  if (acctCache && Date.now() - acctCache.at < ACCT_TTL) return Promise.resolve(acctCache.list)
  if (acctInflight) return acctInflight
  acctInflight = window.api.auth
    .listAccounts()
    .then((list: AccountInfo[]) => {
      acctCache = { at: Date.now(), list }
      acctInflight = null
      return list
    })
    .catch(() => {
      acctInflight = null
      return acctCache?.list ?? []
    })
  return acctInflight
}

// 계정 picker — 과금이 '구독'일 때 이 채팅의 실행 계정을 고른다(등록 계정이 2개 이상일
// 때만 표시 — 하나뿐이면 고를 게 없다). '기본'은 전역 활성 계정을 그대로 따라가고,
// 특정 계정을 고르면 이 채팅의 실행만 그 계정(격리 CLAUDE_CONFIG_DIR)으로 돈다.
export function AccountPick({
  account,
  onChange,
  align,
  divider
}: {
  account?: string
  onChange: (email?: string) => void
  align?: 'right'
  divider?: boolean // 컴포저 바처럼 pick 사이에 구분선을 쓰는 곳 — 숨을 때 같이 숨도록 내부에서 그린다
}) {
  const [accounts, setAccounts] = useState<AccountInfo[]>(() => acctCache?.list ?? [])
  // 계정별 잔여 한도 — 목록과 별도로 나중에 도착해 옵션 설명 줄을 채운다(네트워크 조회)
  const [usage, setUsage] = useState<Record<string, AccountUsage>>(() => usageCache?.map ?? {})
  useEffect(() => {
    let on = true
    fetchAccounts().then((l) => {
      if (on) setAccounts(l)
    })
    fetchAccountsUsage().then((m) => {
      if (on) setUsage(m)
    })
    return () => {
      on = false
    }
  }, [])
  // 계정이 하나뿐이면 picker 자체가 소음 — 단, 이 채팅이 이미 다른 계정을 고른 상태면
  // (목록이 줄었어도) 그 사실이 보여야 하니 그대로 그린다.
  if (accounts.length < 2 && !account) return null
  const activeEmail = accounts.find((a) => a.active)?.email
  // '기본' 같은 추상 항목 없이 항상 실제 계정을 보여준다 — 아직 안 골랐으면 지금 실행에
  // 실제로 쓰일 전역 활성 계정이 값이다. 하나를 고르면 이 채팅에 고정된다.
  const effective = account ?? activeEmail
  // 버튼엔 이메일 로컬파트만 짧게 — 로컬파트가 겹치는 계정이 있으면 전체 이메일로 구분
  const short = (email: string): string => {
    const lp = email.split('@')[0]
    return accounts.some((a) => a.email !== email && a.email.split('@')[0] === lp) ? email : lp
  }
  const options = [
    ...accounts.map((a, i) => ({
      v: a.email,
      d: a.active ? '현재 활성 계정' : a.subscriptionType ? `${a.subscriptionType} 구독` : '등록된 계정',
      // 잔여 한도(5시간·주간·Fable)를 둘째 설명 줄로 — 어느 계정이 여유 있는지 보고 고른다
      d2: acctUsageLine(usage[a.email]) || undefined,
      // 계정마다 다른 색 — 어느 채팅이 어느 계정인지 아이콘 색만으로 구분되게
      color: ACCT_COLORS[i % ACCT_COLORS.length],
      icon: 'user' as const
    })),
    // 저장 목록에서 사라진 계정을 여전히 가리키는 채팅 — 실행이 실패할 수 있음을 알리고
    // 다른 값으로 바꿀 수 있게 목록에 남겨 보여준다
    ...(account && !accounts.some((a) => a.email === account)
      ? [{ v: account, d: '저장 목록에 없음 — 설정 → Account에서 다시 추가하세요', color: 'var(--red)', icon: 'warn' as const, warn: true }]
      : [])
  ]
  return (
    <>
      {divider && <span className="pick-div" />}
      <Pick
        label="계정"
        value={effective ?? ''}
        valueLabel={effective ? short(effective) : '—'}
        options={options}
        onChange={(v) => onChange(v)}
        align={align}
        icons
        tip="실행 계정 — 이 채팅을 어느 구독 계정으로 돌릴지"
      />
    </>
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
  const modeOpt = MODES.find((m) => m.id === picker.mode) ?? MODE_FALLBACK
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
        label="추론"
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
        onChange={(v) => setPicker({ ...picker, mode: (MODES.find((m) => m.v === v) ?? MODE_FALLBACK).id })}
        align={align}
        icons
        tip="실행 모드 — 변경 승인 방식"
      />
      {onApiModeChange && <BillingPick apiMode={apiMode} apiReady={apiReady} onChange={onApiModeChange} align={align} />}
      {/* 구독일 때만: 이 채팅의 실행 계정 (API 모드는 과금 주체가 키라 계정이 무의미).
          과금 picker가 없는 창(추가 채팅의 /ask 등)도 구독 실행이므로 계정은 고를 수 있다. */}
      {!apiMode && (
        <AccountPick account={picker.account} onChange={(email) => setPicker({ ...picker, account: email })} align={align} />
      )}
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
// 추가 크레딧 금액 — USD는 $ 기호, 그 외 통화는 코드를 병기
export function fmtCredit(v: number, currency: string): string {
  return currency === 'USD' ? fmtUsd(v) : v.toFixed(2) + ' ' + currency
}
// 구독 한도 행 (컴포저 스트립·작업 바 팝오버 공용) — 링은 사용률, 큰 값은 "남은" %.
// 구독엔 잔액 API가 없어 창별 사용률·리셋 시각이 전부 — 남은 크레딧은 100−사용률로 보여준다
// (API 모드의 "남은 예산" 행과 같은 문법: 링=사용분, 값=잔여분).
function limitItem(
  label: string,
  w: UsageWindow | null,
  useDays: boolean
): { label: string; pct: number | null; val?: string; detail: string } {
  return {
    label,
    pct: w?.pct ?? null,
    val: w ? `${Math.max(0, 100 - Math.round(w.pct))}% 남음` : undefined,
    detail: w ? resetText(w.resetsAt, useDays) : '데이터 없음'
  }
}
// 추가 사용 크레딧 행 (작업 바 컨텍스트 팝오버) — claude.ai에서 켠 사용자에게만 행이
// 뜬다 (꺼져 있으면 잔액도 한도도 없어 보여줄 게 없다). 잔액이 소진된 상태(켰지만
// 0원)도 보여준다 — "다 떨어짐"이야말로 알아야 할 정보다. 값=현재 잔액, 링·디테일=월
// 지출 한도 대비 사용분 (API 모드 "남은 예산" 행과 같은 문법).
export function extraCreditVisible(x: ExtraCreditInfo | null | undefined): x is ExtraCreditInfo {
  return !!x && (x.enabled || x.outOfCredits)
}
function extraCreditItem(x: ExtraCreditInfo): { label: string; pct: number | null; val?: string; detail: string } {
  if (!x.enabled && x.outOfCredits)
    return {
      label: '추가 크레딧',
      pct: x.pct,
      val: `${fmtCredit(0, x.currency)} 남음`,
      detail: '크레딧 소진 — claude.ai에서 충전해야 다시 쓸 수 있어요'
    }
  return {
    label: '추가 크레딧',
    pct: x.pct,
    val: x.balance != null ? `${fmtCredit(x.balance, x.currency)} 남음` : undefined,
    detail: `이번 달 ${fmtCredit(x.used ?? 0, x.currency)} 사용${x.cap != null ? ` · 월 한도 ${fmtCredit(x.cap, x.currency)}` : ''}`
  }
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
          limitItem('5시간 한도', usage.fiveHour, false),
          limitItem('주간 한도', usage.weekly, true),
          // Fable 5 전용 주간 한도 — 플랜에 없으면(null) 칩 자체를 숨긴다
          ...(usage.weeklyFable ? [limitItem('Fable 주간 한도', usage.weeklyFable, true)] : [])
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

type WorkTab = 'todo' | 'sub' | 'sh' | 'file' | 'ctx'

// 셸의 상태 문구 — stopped는 사유까지: 사용자가 누른 중지 / Claude(모델)가 끊음 /
// 턴이 끝나며 CLI가 같이 정리함은 다른 사건이다 (sleep이 완료된 걸로 오해하기 쉬운 지점).
function bgStatusLabel(t: BgTask): string {
  switch (t.status) {
    case 'running':
      return '실행 중'
    case 'completed':
      return '완료'
    case 'failed':
      return '실패'
    default:
      if (t.byUser) return '중지됨 — 직접 중지'
      if (t.teardown) return '턴 종료로 정리됨'
      return '중지됨 — Claude가 중지'
  }
}

// 색은 서브에이전트와 같은 문법 — 실행 중 스피너, 완료 초록 ✓, 중지/실패 빨간 ✕.
// 중지의 사유 구분은 색이 아니라 위 라벨 텍스트가 맡는다.

// 지금 턴을 막고 있는 포그라운드 Bash가 있는지 — "기다리는 명령 건너뛰고 계속하기"는
// 건너뛸 대상이 실제로 있을 때만 보여준다 (백그라운드로 넘어간 Bash는 즉시 done이 된다).
export function hasRunningBash(messages: ThreadItem[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'toolgroup' && m.tools.some((t) => t.kind === 'bash' && t.status === 'running')) return true
  }
  return false
}

// 백그라운드 셸 한 줄 — 설명 + 상태, 실행 중이면 중지 버튼. 행을 누르면 출력(라이브
// 테일 포함) 카드가 열린다.
function BgTaskRow({ t, onOpen, onStop }: { t: BgTask; onOpen: (id: string) => void; onStop?: (id: string) => void }) {
  return (
    <div className={'bgtask ' + t.status} onClick={() => onOpen(t.id)}>
      <span className="bg-ic">
        <IconTerminal size={14} />
      </span>
      <div className="bg-main">
        <div className="bg-desc">{t.description || t.id}</div>
        <div className="bg-sub">
          {bgStatusLabel(t)}
          {/* 요약이 설명과 같은 문장으로 오는 경우(중지 통지)가 있어 중복이면 생략 */}
          {t.status !== 'running' && t.summary && t.summary !== t.description ? ` — ${t.summary}` : ''}
        </div>
      </div>
      {t.status === 'running' ? (
        <>
          <span className="spin" />
          {onStop && (
            <button
              className="bg-stop"
              onClick={(e) => {
                e.stopPropagation()
                onStop(t.id)
              }}
            >
              중지
            </button>
          )}
        </>
      ) : t.status === 'completed' ? (
        <span className="sa-check">
          <IconCheck size={12} />
        </span>
      ) : (
        <span className="bg-x">
          <IconClose size={12} />
        </span>
      )}
    </div>
  )
}

// 백그라운드 셸 상세 카드 — 서브에이전트 카드와 같은 시각 언어(.sa-card). 핵심은 출력:
// 실행 중이면 출력 파일(엔진이 유도한 경로)을 1.2초마다 다시 읽어 라이브 테일을 보여준다.
// readFile IPC는 절대경로를 그대로 받고, 파일이 아직 없으면 에러를 돌려줘 조용히 대기한다.
function BgTaskModal({ t, onStop, onClose }: { t: BgTask | null; onStop?: (id: string) => void; onClose: () => void }) {
  const [out, setOut] = useState<{ text: string | null; err: string | null }>({ text: null, err: null })
  const preRef = useRef<HTMLPreElement>(null)
  // 마우스 제스처(U/D 스크롤·DR 닫기)의 대상 카드 엘리먼트
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const file = t?.outputFile
  const running = t?.status === 'running'
  useEffect(() => {
    if (!t) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [t, onClose])
  useEffect(() => {
    setOut({ text: null, err: null })
    if (!file) return
    let alive = true
    const load = (): void => {
      window.api
        .readFile('', file)
        .then((r) => {
          if (!alive) return
          if (r.content != null) setOut({ text: r.content, err: null })
          else setOut((p) => (p.text != null ? p : { text: null, err: r.error ?? null }))
        })
        .catch(() => {})
    }
    load()
    if (!running) {
      return () => {
        alive = false
      }
    }
    const iv = setInterval(load, 1200)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [file, running])
  // 새 출력이 붙으면 테일로 따라간다 (터미널처럼)
  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [out.text])
  if (!t) return null
  const tail = out.text ? out.text.split('\n').slice(-400).join('\n').trimEnd() : ''
  return createPortal(
    <div className="sa-overlay" onMouseDown={onClose}>
      <div className="sa-card" ref={setCardEl} onMouseDown={(e) => e.stopPropagation()}>
        <div className="sa-card-head">
          <span className={'sa-card-ic bg-card-ic ' + t.status}>
            <IconTerminal size={18} />
          </span>
          <div className="sa-card-titles">
            <div className="sa-card-name">{t.description || t.id}</div>
            <div className="sa-card-role">백그라운드 셸</div>
          </div>
          <span className={'bg-chip ' + t.status}>{bgStatusLabel(t)}</span>
          {running && onStop && (
            <button className="bg-stop-chip" onClick={() => onStop(t.id)}>
              중지
            </button>
          )}
          <button className="sa-card-close" onClick={onClose} aria-label="닫기">
            <IconClose size={18} />
          </button>
        </div>
        <div className="sa-card-body scroll">
          {!running && t.summary && t.summary !== t.description && (
            <div className="sa-card-sec">
              <div className="sa-card-lbl">요약</div>
              <div className="content">{t.summary}</div>
            </div>
          )}
          <div className="sa-card-sec">
            <div className="sa-card-lbl">출력{running ? ' — 실시간' : ''}</div>
            {tail ? (
              <pre className="bg-out" ref={preRef}>
                {tail}
              </pre>
            ) : (
              <div className="ag-none">{running ? '아직 출력이 없어요 (쌓이는 대로 여기 보여요)' : '출력 결과가 없어요'}</div>
            )}
          </div>
          {file && (
            <div className="bg-out-path" title={file}>
              {file}
            </div>
          )}
        </div>
      </div>
      {/* 우클릭 드래그 제스처 — 뷰어와 같은 문법. 스크롤은 출력(pre)이 있으면 그쪽을 우선 */}
      <MouseGestureLayer
        target={cardEl}
        actions={[
          ...scrollGestures(() => cardEl?.querySelector('.bg-out') ?? cardEl?.querySelector('.sa-card-body')),
          { pattern: 'DR', label: '카드 닫기', run: onClose }
        ]}
      />
    </div>,
    document.body
  )
}

// 코드(에이전트) 모드의 "작업 바" — 컴포저 바로 위 한 줄. 할 일·서브에이전트·변경된
// 파일·컨텍스트를 알약 칩으로 두고, 누르면 그 칩 위로 팝오버가 떠 내용을 보여준다
// (한 번에 하나, Esc·바깥 클릭으로 닫힘). 예전 오른쪽 에이전트 패널(.agent)을 대체해
// 대화 칼럼을 넓힌다. App이 매 틱 리렌더해도 컴포저 타이핑과 분리되도록 memo.
export const WorkBar = memo(function WorkBar({
  todos,
  files,
  subagents,
  bgTasks = [],
  usage,
  contextTokens,
  contextWindow,
  model,
  apiMode = false,
  chatSpentUsd = 0,
  budgetUsd = null,
  totalSpentUsd = 0,
  busy = false,
  canSkipWait = false,
  onOpenFile,
  onOpenSubagent,
  onBgTask,
  onRefreshUsage
}: {
  todos: Todo[]
  files: ChangedFile[]
  subagents: SubAgentInfo[]
  bgTasks?: BgTask[] // 백그라운드 셸 등 — 셸 칩·팝오버(중지/Ctrl+B)
  usage: UsageInfo
  contextTokens: number | null
  contextWindow: number | null
  model: ModelId
  apiMode?: boolean // true → 컨텍스트 팝오버가 구독 한도 대신 API 비용을 보여준다
  chatSpentUsd?: number // 이 대화의 API 모드 누적 비용
  budgetUsd?: number | null // 설정 → API의 예산 (null = 미설정)
  totalSpentUsd?: number // 전체 워크스페이스의 API 모드 누적 사용액
  busy?: boolean // 실행 중 여부
  canSkipWait?: boolean // 막고 있는 포그라운드 Bash가 있는지 — 건너뛰기 버튼은 이때만 노출
  onOpenFile: (f: ChangedFile) => void
  onOpenSubagent: (a: SubAgentInfo) => void
  onBgTask?: (req: BgTaskRequest) => void // 셸 중지 / 포그라운드 도구 백그라운드화
  onRefreshUsage?: () => void // 컨텍스트 팝오버를 열 때 사용량 강제 새로고침
}) {
  const [open, setOpen] = useState<WorkTab | null>(null)
  // 셸 행 클릭 → 출력 카드. id로 들고 있어야 라이브 갱신(REPLACE·정착 통지)이 카드에 흐른다.
  const [openBgId, setOpenBgId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

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
  const runningBg = bgTasks.filter((t) => t.status === 'running').length
  const endedBg = bgTasks.length - runningBg

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
          limitItem('5시간 한도', usage.fiveHour, false),
          limitItem('주간 한도', usage.weekly, true),
          // Fable 5 전용 주간 한도 — 플랜에 없으면(null) 행 자체를 숨긴다
          ...(usage.weeklyFable ? [limitItem('Fable 주간 한도', usage.weeklyFable, true)] : []),
          // 추가 사용 크레딧 (claude.ai 설정 → 사용 크레딧) — 켜져 있거나 소진 상태일 때만
          ...(extraCreditVisible(usage.extraCredit) ? [extraCreditItem(usage.extraCredit)] : [])
        ])
  ]

  const toggle = (t: WorkTab): void => {
    // 컨텍스트 팝오버를 여는 순간 사용량을 새로 받아온다 — 추가 크레딧 잔액이 열 때마다 최신이게
    if (t === 'ctx' && open !== 'ctx') onRefreshUsage?.()
    setOpen((o) => (o === t ? null : t))
  }

  // 칩 면(面)은 예전 컨텍스트 스트립과 똑같은 결 — 왼쪽 링/아이콘 + 2줄 텍스트(라벨·값
  // 위, 디테일 아래). 4칸이 폭을 똑같이 나눠(flex:1) 가지런히 채운다. 누르면 그 칸 위로
  // 팝오버가 떠 상세 목록을 보여준다.
  const todoTotal = todos.length
  const todoPct = todoTotal ? Math.round((todoDone / todoTotal) * 100) : 0
  const subTotal = subagents.length
  const totalAdd = files.reduce((n, f) => n + (f.add || 0), 0)
  const totalDel = files.reduce((n, f) => n + (f.del || 0), 0)

  const chips: { key: WorkTab; ring?: number; icon?: ReactNode; label: string; value: string; detail: string; tip: string; align?: 'r' }[] = [
    // 빈 목록은 실행 중에도 "계획 수립 중"이라 추측하지 않는다 — 팝오버 문구와 같은 이유
    { key: 'todo', icon: <IconList size={14} />, label: '할 일', value: `${todoDone}/${todoTotal || 0}`, detail: todoTotal ? `${todoPct}% 완료` : '없음', tip: 'Claude가 세운 작업 계획 — 누르면 할 일 목록' },
    { key: 'sub', icon: <IconBot size={14} />, label: '서브에이전트', value: `${doneSub}/${subTotal || 0}`, detail: runningSub > 0 ? `${runningSub}개 실행 중` : subTotal ? '모두 완료' : '없음', tip: 'Claude가 띄운 보조 에이전트의 진행 상황 — 누르면 목록' },
    { key: 'sh', icon: <IconTerminal size={14} />, label: '백그라운드 셸', value: `${endedBg}/${bgTasks.length || 0}`, detail: runningBg > 0 ? `${runningBg}개 실행 중` : bgTasks.length ? '모두 종료' : '없음', tip: 'Claude가 백그라운드로 돌리는 셸 — 누르면 목록·중지' },
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
          {/* 실행 중이어도 "계획 수립 중"이라고 추측하지 않는다 — 간단한 작업은 할 일
              목록을 아예 만들지 않으므로, 없으면 그냥 없다고 말하는 게 정직하다 */}
          {todoTotal ? <Todos todos={todos} /> : <div className="ag-none">아직 할 일이 없어요</div>}
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
    if (key === 'sh')
      return (
        <>
          <div className="wb-pop-h">
            <span className="t">백그라운드 셸</span>
            <span className="c">{runningBg > 0 ? runningBg + ' 실행 중' : `${endedBg}/${bgTasks.length || 0}`}</span>
          </div>
          {bgTasks.length ? (
            <div className="wb-pop-list">
              {bgTasks.map((t) => (
                <BgTaskRow
                  key={t.id}
                  t={t}
                  onOpen={(id) => {
                    setOpen(null)
                    setOpenBgId(id)
                  }}
                  onStop={onBgTask ? (id) => onBgTask({ action: 'stop', id }) : undefined}
                />
              ))}
            </div>
          ) : (
            <div className="ag-none">아직 백그라운드 셸이 없어요</div>
          )}
          {/* 터미널 Ctrl+B 패리티 — 지금 막고 있는 포그라운드 Bash(빌드 등)를 백그라운드로
              보내고 턴을 계속 진행시킨다. 건너뛸 명령이 실제로 있을 때만 보여준다. */}
          {busy && canSkipWait && onBgTask && (
            <button
              className="wb-bg-all has-tip tip-wrap"
              data-tip="막고 있는 포그라운드 명령을 백그라운드로 보내고 Claude가 다음 작업을 계속하게 합니다 (터미널의 Ctrl+B)"
              onClick={() => onBgTask({ action: 'background' })}
            >
              기다리는 명령 건너뛰고 계속하기
            </button>
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
      {openBgId && (
        <BgTaskModal
          t={bgTasks.find((t) => t.id === openBgId) ?? null}
          onStop={onBgTask ? (id) => onBgTask({ action: 'stop', id }) : undefined}
          onClose={() => setOpenBgId(null)}
        />
      )}
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
  const effortOpt = EFFORTS.find((e) => e.id === picker.effort) ?? EFFORTS[2]
  // prefer the SDK's real context window; fall back to the model's nominal size
  const winTokens = contextWindow ?? modelOpt.ctx * 1000
  const modeOpt = MODES.find((m) => m.id === picker.mode) ?? MODE_FALLBACK

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

  // ── attachment drag-and-drop + paste (images + readable text files) ─────────
  const dragHasFile = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.items || []).some((it) => it.kind === 'file')

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    dragDepth.current = 0
    setDragOver(false)
    if (!e.dataTransfer.files?.length) return
    e.preventDefault()
    const paths = await filesToAttachmentPaths(e.dataTransfer.files)
    if (paths.length) onAddImagePaths(paths)
  }

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    // a copied FILE (screenshot, or a txt/md/… from the OS) becomes an attachment;
    // plain text pastes have no clipboard files and stay ordinary text
    const files = Array.from(e.clipboardData.files || []).filter(
      (f) => f.type.startsWith('image/') || isAttachablePath(f.name)
    )
    if (!files.length) return
    e.preventDefault()
    const paths = await filesToAttachmentPaths(files)
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
                    {m.text.trim() || (m.images.length ? `첨부 ${m.images.length}개` : '')}
                  </span>
                  {m.images.length > 0 && (
                    <span className="sched-img has-tip" data-tip={`첨부 ${m.images.length}개`}>
                      <IconPaperclip size={14} />
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
              <IconPaperclip size={24} />
              <span>파일을 여기에 놓으세요</span>
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
              {/* 툴팁은 래퍼(.img-thumb)에 — 안쪽 .img-thumb-open은 overflow:hidden이라 ::after가 잘린다 */}
              {images.map((p, i) =>
                isImagePath(p) ? (
                  <div className="img-thumb has-tip" data-tip={imageName(p)} key={p + i}>
                    <button
                      type="button"
                      className="img-thumb-open"
                      onClick={() => {
                        // 뷰어는 이미지 전용 — 문서 첨부를 뺀 목록과 그 안에서의 위치로 연다
                        const imgs = images.filter(isImagePath)
                        onOpenImage?.(imgs, imgs.indexOf(p))
                      }}
                      aria-label={imageName(p)}
                    >
                      <img src={imageSrc(p)} alt={imageName(p)} draggable={false} />
                    </button>
                    <button className="img-thumb-x has-tip" onClick={() => onRemoveImage(i)} aria-label="제거" data-tip="제거">
                      <IconX2 size={11} />
                    </button>
                  </div>
                ) : (
                  <div className="img-thumb doc has-tip tip-path" data-tip={p} key={p + i}>
                    <span className="img-thumb-open">
                      <FileBadge path={p} size={15} />
                      <span className="doc-name">{imageName(p)}</span>
                    </span>
                    <button className="img-thumb-x has-tip" onClick={() => onRemoveImage(i)} aria-label="제거" data-tip="제거">
                      <IconX2 size={11} />
                    </button>
                  </div>
                )
              )}
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
            <button className="cm-icon has-tip" aria-label="파일 첨부" data-tip="파일 첨부 (이미지·텍스트)" onClick={onPickImages}>
              <IconPaperclip size={16} />
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
              label="추론"
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
              onChange={(v) => setPicker({ ...picker, mode: (MODES.find((m) => m.v === v) ?? MODE_FALLBACK).id })}
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
            {/* 구독일 때만: 이 채팅의 실행 계정 (RunPickers와 같은 규칙 — 과금 picker가
                없는 추가 채팅 창도 구독 실행이므로 계정은 고를 수 있다) */}
            {!apiMode && (
              <AccountPick
                account={picker.account}
                onChange={(email) => setPicker({ ...picker, account: email })}
                align="right"
                divider
              />
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
