import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ComponentType, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type {
  ModelId,
  EffortId,
  ModeId,
  EngineId,
  UsageInfo,
  UsageWindow,
  ExtraCreditInfo,
  CodexAccountInfo,
  CodexAccountUsage,
  CodexModelInfo,
  ToolLogItem,
  AgentQuestion,
  SkillInfo,
  Todo,
  ChangedFile,
  SubAgentInfo,
  BgTask,
  BgTaskRequest,
  AccountInfo,
  AccountUsage,
  TokenTally,
  WorkflowState
} from '@shared/protocol'
import { t, useLang } from '../lib/i18n'
import { sameCwd, type ThreadItem } from '../store/session'
import { loadRecentDirs, loadFavDirs, toggleFavDir, removeRecentDir } from '../lib/recentDirs'
import { relTime } from './Sidebar'
import { Markdown } from './Markdown'
import { FileBadge } from './fileType'
import { MouseGestureLayer, scrollGestures } from './mouseGesture'
import { Todos, FileRow, SubAgent } from './AgentPanel'
import { WinControls } from './TitleBar'
import { mentionAtCaret, mentionEntries, type MentionEntry } from '../lib/mentions'
import { imageSrc, imageName, filesToAttachmentPaths, isImagePath, isAttachablePath } from '../lib/images'
import {
  IconPlus,
  IconPaperclip,
  IconChevDown,
  IconCheck,
  IconStar,
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
  IconExpand,
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
  IconChevLeft,
  IconClock,
  IconList,
  IconBot,
  IconMascot,
  IconMascotDraw,
  IconPanelRight,
  IconSquare,
  type IconProps
} from './icons'

const TYPE_SPEED = 12

interface ModelOpt {
  v: string
  id: ModelId
  d: string
  ctx: number
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
}

// 표시 문자열이 든 목록은 상수가 아니라 함수 — 모듈 스코프 상수로 두면 import 시점
// 언어로 박제된다(렌더 때 평가해야 언어 전환이 즉시 따라온다)
function modelOpts(): ModelOpt[] {
  return [
    { v: 'Fable 5', id: 'fable', d: t('최상위 지능 · 가장 어려운 작업', 'Top intelligence · hardest work'), ctx: 1000 },
    { v: 'Opus 5', id: 'opus', d: t('고성능 · 복잡한 작업', 'High performance · complex work'), ctx: 1000 },
    { v: 'Sonnet 5', id: 'sonnet', d: t('균형 · 일상 작업', 'Balanced · everyday work'), ctx: 1000 },
    { v: 'Haiku 4.5', id: 'haiku', d: t('빠른 응답 · 가벼운 작업', 'Fast · light work'), ctx: 200 }
  ]
}
function effortOpts(): EffortOpt[] {
  return [
    { v: t('최대', 'Max'), id: 'max', d: t('최대 강도', 'Maximum intensity'), level: 5 },
    { v: t('매우 높음', 'Very high'), id: 'xhigh', d: t('더 깊은 추론', 'Deeper reasoning'), level: 4 },
    { v: t('높음', 'High'), id: 'high', d: t('깊은 추론', 'Deep reasoning'), level: 3 },
    { v: t('보통', 'Medium'), id: 'medium', d: t('보통 추론', 'Standard reasoning'), level: 2 },
    { v: t('낮음', 'Low'), id: 'low', d: t('가벼운 추론', 'Light reasoning'), level: 1 },
    { v: t('최소', 'Minimal'), id: 'minimal', d: t('확장사고 끔', 'Extended thinking off'), level: 0 }
  ]
}
// 모드 순서·이름 = PoC 확정: 일반→플랜→부분 허용→자동 허용→모두 허용, 색 특별취급 없음
function modeOpts(): ModeOpt[] {
  return [
    { v: t('일반', 'Normal'), id: 'normal', d: t('변경마다 승인 요청', 'Ask before every change') },
    { v: t('플랜', 'Plan'), id: 'plan', d: t('계획만 수립, 실행은 승인 후', 'Plan only, run after approval') },
    { v: t('부분 허용', 'Accept edits'), id: 'acceptEdits', d: t('파일 편집 자동 수락', 'Auto-accept file edits') },
    { v: t('자동 허용', 'Auto'), id: 'auto', d: t('도구 실행까지 자동 진행', 'Auto-run tools too') },
    { v: t('모두 허용', 'Allow all'), id: 'bypass', d: t('모든 권한 확인 건너뛰기', 'Skip all permission prompts') }
  ]
}
// 배열 순서와 무관하게 폴백 기본값은 항상 '일반'
function modeFallback(): ModeOpt {
  const ms = modeOpts()
  return ms.find((m) => m.id === 'normal') ?? ms[0]
}

export interface PickerState {
  model: ModelId
  effort: EffortId
  mode: ModeId
  // 실행 엔진 — 'claude'(기본) 또는 'codex'(OpenAI Codex CLI)
  engine?: EngineId
  // engine==='codex'일 때의 GPT 모델 id (예: gpt-5.6-terra)
  codexModel?: string
  // 이 채팅의 실행 계정(등록 계정 이메일) — 없으면 기본 계정을 따른다. 과금이
  // '구독'일 때만 의미가 있다(API 모드 실행에선 엔진이 무시).
  account?: string
  // engine==='codex'일 때의 OpenAI 계정 바인딩 — 없으면 Codex 기본 계정을 따른다
  codexAccount?: string
}

// ── Codex(OpenAI) 모델 — app-server model/list를 한 번 받아 캐시, 실패 시 정적 폴백
// (실측 0.144.3: gpt-5.6-terra/luna · gpt-5.5 · gpt-5.4-mini) ──
export interface CodexModelOpt {
  v: string
  id: string
  d: string
}
// model/list 실측(0.144, 2026-07) 순서 그대로 — 서버 영어 설명의 한국어 번역이
// codexDescKo를 통해 실제 목록에도 입혀진다 (여기 없는 새 모델만 영어 원문)
function codexFallback(): CodexModelOpt[] {
  return [
    { v: 'GPT-5.6-Sol', id: 'gpt-5.6-sol', d: t('최신 프론티어 · 가장 어려운 작업', 'Newest frontier · hardest work') },
    { v: 'GPT-5.6-Terra', id: 'gpt-5.6-terra', d: t('균형 에이전트 코딩 · 일상 작업', 'Balanced agentic coding · everyday work') },
    { v: 'GPT-5.6-Luna', id: 'gpt-5.6-luna', d: t('빠르고 경제적 · 가벼운 작업', 'Fast and economical · light work') }
  ]
}
// 구세대(5.5·5.4) 모델은 picker에서 숨긴다(유저 결정) — 서버 목록에 있어도 걸러낸다.
// 모르는 새 모델(예: 5.7)은 그대로 통과해 목록에 뜬다.
const CODEX_HIDDEN = new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'])
// 엔진을 codex로 바꿀 때의 기본 모델 — 서버 기본(sol)이 아니라 균형형(terra)을 유지
export const CODEX_DEFAULT_MODEL = 'gpt-5.6-terra'
// 캐시는 서버 원본(raw)으로 둔다 — 표시 목록(설명)은 읽는 순간 만들어야 언어 전환이 따라온다
let codexModelCache: CodexModelInfo[] | null = null
let codexModelFetch: Promise<CodexModelOpt[]> | null = null
// 서버(model/list)의 영어 설명 → 한국어. 아는 모델은 codexFallback()의 한국어 설명을
// 그대로 쓰고, 모르는 새 모델만 서버 원문으로 남긴다.
function codexDescKo(id: string, desc?: string, isDefault?: boolean): string {
  return codexFallback().find((f) => f.id === id)?.d ?? desc ?? (isDefault ? t('기본 모델', 'Default model') : '')
}
// 서버 원본 목록 → picker 표시 옵션 (숨김 모델 제외 + 설명 번역)
function codexOptsOf(list: CodexModelInfo[]): CodexModelOpt[] {
  return list
    .filter((m) => !CODEX_HIDDEN.has(m.id))
    .map((m) => ({ v: m.label, id: m.id, d: codexDescKo(m.id, m.desc, m.isDefault) }))
}
function fetchCodexModels(): Promise<CodexModelOpt[]> {
  if (codexModelCache) return Promise.resolve(codexOptsOf(codexModelCache))
  if (codexModelFetch) return codexModelFetch
  codexModelFetch = window.api
    .codexModels()
    .then((list) => {
      const opts = codexOptsOf(list)
      if (opts.length) codexModelCache = list
      return opts.length ? opts : codexFallback()
    })
    .catch(() => codexFallback())
    .finally(() => {
      codexModelFetch = null
    })
  return codexModelFetch
}

function engineOpts(): { v: string; id: EngineId; d: string }[] {
  return [
    { v: 'Anthropic', id: 'claude', d: t('Claude Code CLI로 실행', 'Runs on the Claude Code CLI') },
    { v: 'OpenAI', id: 'codex', d: t('Codex CLI로 실행', 'Runs on the Codex CLI') }
  ]
}

/** OpenAI 모델 목록 훅 — 엔진을 codex로 두면 그때 받아온다 (실패 시 정적 폴백). */
function useCodexModels(engine: EngineId): CodexModelOpt[] {
  const [, bump] = useState(0)
  useEffect(() => {
    if (engine !== 'codex') return
    let on = true
    fetchCodexModels().then(() => {
      if (on) bump((n) => n + 1)
    })
    return () => {
      on = false
    }
  }, [engine])
  // 목록은 state가 아니라 렌더마다 캐시에서 만든다 — state에 담아두면 그때 언어가 박제된다
  return codexModelCache ? codexOptsOf(codexModelCache) : codexFallback()
}

/** raw SDK model id ('claude-opus-5-…') → picker ModelId, or undefined if unknown.
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

// next run mode — used by the Shift+Tab shortcut. 배열이 PoC 순서(일반→…→모두 허용)라
// 정방향으로 걸으면 기존 순환(일반→플랜→부분→자동→모두→일반)이 그대로 유지된다.
export function nextMode(current: ModeId): ModeId {
  const ms = modeOpts()
  const i = ms.findIndex((m) => m.id === current)
  return ms[(i + 1) % ms.length].id
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
export function slashCommands(): SlashCmd[] {
  return [
    { name: 'init', desc: t('코드베이스를 분석해 CLAUDE.md 생성', 'Analyze the codebase and create CLAUDE.md'), icon: IconFileText },
    { name: 'clear', desc: t('대화 기록과 컨텍스트 초기화', 'Clear the conversation and context'), icon: IconRefresh },
    { name: 'compact', desc: t('대화를 요약해 컨텍스트 절약', 'Summarize the conversation to save context'), icon: IconCompress },
    { name: 'review', desc: t('변경 사항 코드 리뷰', 'Code-review the changes'), icon: IconEye },
    { name: 'security-review', desc: t('변경 사항의 보안 취약점 검토', 'Check the changes for security issues'), icon: IconShieldChk }
  ]
}

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
    // 다 그려진 뒤에도 30ms 강제 재렌더가 영구 상주하지 않게 — 완료를 본 틱에서 스스로 멈춘다
    // (현재 Typewriter 사용처는 user+animate뿐이라 도달 불가지만, 조건이 바뀌는 회귀의 보험)
    const id = setInterval(() => {
      if (Math.floor((Date.now() - start.current) / TYPE_SPEED) >= textRef.current.length) clearInterval(id)
      force((t) => t + 1)
    }, 30)
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

// 턴 마무리 줄 (PoC .worked) — '42초 동안 작업함' / '1분 12초 동안 작업함'
function fmtWorked(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return t(`${s}초 동안 작업함`, `Worked for ${s}s`)
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? t(`${m}분 ${r}초 동안 작업함`, `Worked for ${m}m ${r}s`) : t(`${m}분 동안 작업함`, `Worked for ${m}m`)
}

// 작업 중 인디케이터의 라이브 경과 — 마무리 줄(fmtWorked)과 같은 한국어 단위라
// 턴이 끝나는 순간 'N초 동안 작업함'으로 자연스럽게 이어진다
function fmtElapsedKo(s: number): string {
  if (s < 60) return t(`${s}초`, `${s}s`)
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? t(`${m}분 ${r}초`, `${m}m ${r}s`) : t(`${m}분`, `${m}m`)
}

// result shown on the right: a spinner while running, a red mark on error, the +/-
// line counts for edits (colored), or the tool's text summary otherwise.
// Bash는 '✓' 대신 실행 시간 · 출력 줄수 — 다른 도구의 '10줄'과 같은 문법.
// prop 이름 t는 i18n의 t()를 가리므로 안에서는 tl(tool log)로 받는다
function ToolResult({ t: tl }: { t: ToolLogItem }) {
  if (tl.status === 'running') return <span className="t-res"><span className="spin" /></span>
  if (tl.status === 'error') return <span className="t-res err">{t('오류', 'Error')}</span>
  if (tl.kind === 'bash') {
    const parts = [
      tl.durationMs != null ? fmtDur(tl.durationMs) : '',
      tl.output ? t(`${tl.output.split('\n').length}줄`, `${tl.output.split('\n').length} lines`) : ''
    ].filter(Boolean)
    if (parts.length) return <span className="t-res">{parts.join(' · ')}</span>
  }
  const diff = (tl.result ?? '').match(/^\+(\d+) -(\d+)$/)
  if (diff)
    return (
      <span className="t-res">
        <span className="add">+{diff[1]}</span> <span className="del">−{diff[2]}</span>
      </span>
    )
  return <span className="t-res">{tl.result ?? ''}</span>
}

// 실패 출력에서 에러로 읽히는 줄만 붉게 — 성공 출력은 설치 로그처럼 완전 무채색 유지
function bashErrLine(failed: boolean, ln: string): boolean {
  return failed && /(^|\s)(error|err!|fatal|exception|failed)\b/i.test(ln)
}

// Bash 전체 로그 모달 — 인라인 펼침은 좁아서 읽기 어렵다는 피드백으로 교체.
// '명령'과 '출력'을 섹션으로 나눠 요청/결과가 한눈에 읽힌다. 채팅 스크롤러/가상화
// 밖(body 포털)에 그려서 어느 화면(메인·멀티 패널·추가 채팅)에서 열어도 안전하다.
// prop 이름 t는 i18n의 t()를 가리므로 안에서는 tl(tool log)로 받는다
function BashLogModal({ t: tl, onClose }: { t: ToolLogItem; onClose: () => void }) {
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
  const failed = tl.status === 'error'
  const lines = (tl.output ?? '').split('\n')
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
      <div className="dc-card" ref={setCard} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dc-head">
          <div className="dc-tile">
            <IconTerminal size={19} />
          </div>
          <div className="dc-tt">
            <span className="dc-title mono">{tl.target}</span>
            <div className="dc-sub">
              {t('Bash · 일회성 실행', 'Bash · one-off run')}
              {tl.durationMs != null ? ` · ${fmtDur(tl.durationMs)}` : ''}
            </div>
          </div>
          <span className={'dc-badge' + (failed ? ' err' : '')}>
            <span className="d" />
            {failed ? t('오류', 'Error') : t('완료', 'Done')}
          </span>
          <button className="dc-close" onClick={onClose} aria-label={t('닫기', 'Close')}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dc-body scroll">
          <div className="dc-sec">
            <span>{t('명령', 'Command')}</span>
            <i className="dc-ln" />
            <button className={'dc-copy' + (copied === 'cmd' ? ' on' : '')} onClick={() => copy('cmd', tl.target)}>
              <IconCopy size={12} />
              {copied === 'cmd' ? t('복사됨 ✓', 'Copied ✓') : t('명령 복사', 'Copy command')}
            </button>
          </div>
          <div className="dc-cmd">{tl.target}</div>
          <div className="dc-sec">
            <span>{t('출력', 'Output')}</span>
            <i className="dc-ln" />
            <button className={'dc-copy' + (copied === 'out' ? ' on' : '')} onClick={() => copy('out', tl.output ?? '')}>
              <IconCopy size={12} />
              {copied === 'out' ? t('복사됨 ✓', 'Copied ✓') : t('출력 복사', 'Copy output')}
            </button>
          </div>
          <div className="dc-term">
            <div className="dc-term-body">
            {lines.map((ln, i) => (
              <div key={i} className={'bo-ln' + (bashErrLine(failed, ln) ? ' err' : '')}>
                {/* 빈 줄은 NBSP로 높이 유지 — 일반 공백은 collapse돼 줄이 사라진다 */}
                {ln || '\u00A0'}
              </div>
            ))}
            </div>
          </div>
        </div>
        <div className="dc-foot">
          {tl.durationMs != null && (
            <span className="dc-stat">
              {t('소요', 'Took')} <b>{fmtDur(tl.durationMs)}</b>
            </span>
          )}
          {/* 엔진이 끝 200줄/16KB만 실어 보내는 캡은 '끝부분 200줄'로 알린다 */}
          <span className="dc-stat">
            {t('출력', 'Output')}{' '}
            <b>
              {lines.length >= 200
                ? t('끝부분 200줄', 'last 200 lines')
                : t(`${lines.length}줄`, `${lines.length} lines`)}
            </b>
          </span>
        </div>
      </div>
      <MouseGestureLayer
        target={card}
        actions={[
          ...scrollGestures(() => card?.querySelector('.dc-body')),
          { pattern: 'DR', label: t('창 닫기', 'Close window'), run: onClose }
        ]}
      />
    </div>,
    document.body
  )
}

// Bash 행 — Read/Edit 행이 파일을 열듯 명령(t-target)을 클릭하면 전체 로그 모달이
// 열린다(호버 툴팁 '결과 보기'). 인라인 출력은 성공·실패 모두 없음 — 실패도 우측
// '오류' 요약만 남기고, 내용은 다른 도구들과 똑같이 클릭해서 모달로 읽는다.
// prop 이름 t는 i18n의 t()를 가리므로 안에서는 tl(tool log)로 받는다
function BashRow({ t: tl }: { t: ToolLogItem }) {
  const [open, setOpen] = useState(false)
  const clickable = !!tl.output
  return (
    <>
      <div
        className={'t-row bash ' + tl.status + (clickable ? ' openable' : '')}
        onClick={clickable ? () => setOpen(true) : undefined}
      >
        <span className="t-ic">{toolIcon('bash', 14)}</span>
        <span className="t-verb">{tl.verb}</span>
        <span
          className={'t-target' + (clickable ? ' has-tip' : '')}
          data-tip={clickable ? t('결과 보기', 'View output') : undefined}
        >
          <span className="t-txt">{tl.target}</span>
        </span>
        <ToolResult t={tl} />
      </div>
      {open && tl.output && <BashLogModal t={tl} onClose={() => setOpen(false)} />}
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
// prop 이름 t는 i18n의 t()를 가리므로 안에서는 tl(tool log)로 받는다
function WebRow({ t: tl }: { t: ToolLogItem }) {
  const [open, setOpen] = useState(false)
  const links = tl.links ?? []
  const direct = !links.length && /^https?:\/\//i.test(tl.target) ? tl.target : null
  const clickable = links.length > 0 || !!direct
  return (
    <>
      <div
        className={'t-row ' + tl.kind + ' ' + tl.status + (clickable ? ' openable' : '')}
        onClick={links.length ? () => setOpen((o) => !o) : direct ? () => window.open(direct) : undefined}
      >
        <span className="t-ic">{toolIcon(tl.kind, 14)}</span>
        <span className="t-verb">{tl.verb}</span>
        <span
          className={'t-target' + (clickable ? ' has-tip' : '')}
          data-tip={
            links.length
              ? open
                ? t('접기', 'Collapse')
                : t('찾은 페이지 보기', 'View found pages')
              : direct
                ? t('브라우저에서 열기', 'Open in browser')
                : undefined
          }
        >
          <span className="t-txt">{tl.target}</span>
        </span>
        <ToolResult t={tl} />
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
// 그룹당 화면에 펼치는 툴 행 상한 — 스토어 캡(그룹당 400)을 전부 DOM에 그리면 장기
// 자율 턴에서 이 로그가 스레드 무게의 주범이 된다(500항목 × 400행 최악). 최근 행만
// 보이고, 이전 행은 클릭으로 전부 펼친다(스트리밍 중엔 창이 자연히 최신을 따라간다).
const TOOLLOG_VISIBLE_ROWS = 60

function ToolGroup({
  item,
  onOpenFile
}: {
  item: Extract<ThreadItem, { kind: 'toolgroup' }>
  onOpenFile?: (path: string) => void
}) {
  const [showAll, setShowAll] = useState(false)
  if (!item.tools.length) return null
  const hidden = showAll ? 0 : Math.max(0, item.tools.length - TOOLLOG_VISIBLE_ROWS)
  const rows = hidden > 0 ? item.tools.slice(hidden) : item.tools
  return (
    <div className="toollog">
      {hidden > 0 && (
        <button className="t-more" onClick={() => setShowAll(true)}>
          {t(`이전 도구 ${hidden}개 펼치기`, `Show ${hidden} earlier tools`)}
        </button>
      )}
      {/* map 인자 이름이 t면 i18n의 t()를 가려서 tl(tool log)로 받는다 */}
      {rows.map((tl) => {
        if (tl.kind === 'web') return <WebRow t={tl} key={tl.id} />
        if (tl.kind === 'bash') return <BashRow t={tl} key={tl.id} />
        const openable =
          !!onOpenFile && (tl.kind === 'read' || tl.kind === 'write' || tl.kind === 'edit') && !!tl.target
        return (
          <Fragment key={tl.id}>
            <div
              className={'t-row ' + tl.kind + ' ' + tl.status + (openable ? ' openable' : '')}
              onClick={openable ? () => onOpenFile!(tl.target) : undefined}
            >
              <span className="t-ic">{toolIcon(tl.kind, 14)}</span>
              <span className="t-verb">{tl.verb}</span>
              {/* 툴팁은 넓은 행 전체가 아니라 파일명에 달아, 파일명 바로 아래에 뜨게 한다 */}
              <span
                className={'t-target' + (openable ? ' has-tip' : '')}
                data-tip={openable ? t('파일 보기', 'View file') : undefined}
              >
                <span className="t-txt">{tl.target}</span>
              </span>
              <ToolResult t={tl} />
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
  const lastCommit = useRef(0) // 마지막으로 setShown을 커밋한 시각 (파싱 스로틀)

  useEffect(() => {
    // 다 드러난 메시지는 루프를 아예 세운다 — 따라잡은 뒤에도 rAF를 재예약하면 화면의
    // 말풍선 수만큼 60fps 루프가 유휴 중에도 상주해(멀티 6패널이면 7개) 렌더러가 idle에
    // 못 들어가고 GC 기회를 잃는다. 새 청크는 [text] 재실행이 루프를 재기동한다.
    if (curRef.current >= text.length) {
      velRef.current = 0
      return
    }
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
        velRef.current = 0
        return // 다 보였다 — 루프 정지, 다음 청크가 재기동
      }
      if (cur < target) {
        const buffer = target - cur
        // desired speed scales with how far behind we are, with a steady floor so
        // it never crawls during model pauses
        const targetVel = buffer * 3.2 + 18
        // ease the actual velocity toward it (~280ms) so speed changes are gradual
        // — removes the little hitch when a chunk lands and the rate would jump
        velRef.current += (targetVel - velRef.current) * Math.min(1, dt * 3.5)
        cur = Math.min(target, cur + velRef.current * dt)
        curRef.current = cur
        // 커밋(setShown)마다 지금까지 보인 전체 텍스트를 remark가 처음부터 재파싱한다 —
        // 그 비용은 글 길이에 비례하므로, 길어질수록 커밋 간격을 넓혀(6.4천자까지는 매
        // 프레임, 이후 점점 늘어 최대 50ms) 프레임당 파싱 비용에 상한을 둔다. 커서는
        // 매 프레임 전진하므로 공개 총 시간은 그대로고 한 커밋에 드러나는 글자만 커진다.
        // 따라잡은 순간엔 즉시 커밋 — plain→하이라이트 전환이 스로틀에 걸리지 않게.
        if (cur >= target || now - lastCommit.current >= Math.min(50, cur / 400)) {
          lastCommit.current = now
          setShown(Math.floor(cur))
        }
        raf = requestAnimationFrame(tick)
        return
      }
      velRef.current = 0 // caught up — park; the next chunk's [text] effect re-arms
    }
    raf = requestAnimationFrame(tick)
    return () => {
      alive = false
      lastT.current = 0
      cancelAnimationFrame(raf)
    }
  }, [text])

  // colorize only once the run finished AND the reveal caught up (avoids flicker)
  const plain = running || shown < text.length
  return <Markdown text={text.slice(0, shown)} plain={plain} />
}

// memoized so typing in the composer (which re-renders the app) doesn't re-parse
// markdown for every existing message — only messages whose props actually change
// re-render
// Attachments inside a sent message. A single image is one quiet thumbnail; multiple
// images collapse into a flat deck (the first image on top, hairline blank cards peeking
// upper-right) with a "N장" count badge — a click opens the viewer at the first image
// (the filmstrip and ←/→ gestures browse the rest). Text/doc attachments show as
// filename chips (file-type icon + name); a click opens the in-app file viewer.
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
  return (
    <>
      {/* 메시지 안 첨부물엔 호버 툴팁(has-tip) 금지 — .thread > .msg의 content-visibility:auto가
          contain:paint를 내포해 말풍선 상자 밖 페인트를 자른다(첨부는 말풍선 맨 위라 툴팁이
          위로 튀어나옴 → 잘린 흰 조각만 남는 실측). 정보는 배지·뷰어 상단 바가 대신한다. */}
      {imgs.length === 1 && (
        <div className="msg-imgs">
          <button className="msg-img" onClick={() => onOpen?.(imgs, 0)} aria-label={imageName(imgs[0])}>
            <img src={imageSrc(imgs[0])} alt={imageName(imgs[0])} draggable={false} loading="lazy" />
          </button>
        </div>
      )}
      {imgs.length > 1 && (
        // 여러 장은 한 덱으로 묶는다 — 첫 장만 보이고 뒤에 빈 카드 두 장이 오른쪽 위로
        // 비껴 겹침 + 'N장' 배지. 구 덱을 폐기시킨 무게(그림자·매트 액자·떠오르는 호버)는
        // 되살리지 않는다: 전부 헤어라인+표면색, 호버는 명도만
        <div className="msg-imgs">
          <button
            className="msg-deck"
            onClick={() => onOpen?.(imgs, 0)}
            aria-label={t(`사진 ${imgs.length}장 보기`, `View ${imgs.length} photos`)}
          >
            <span className="msg-deck-card c2" aria-hidden="true" />
            <span className="msg-deck-card c1" aria-hidden="true" />
            <span className="msg-deck-top">
              <img src={imageSrc(imgs[0])} alt={imageName(imgs[0])} draggable={false} loading="lazy" />
              <span className="msg-deck-n">{t(`${imgs.length}장`, `${imgs.length}`)}</span>
            </span>
          </button>
        </div>
      )}
      {docs.length > 0 && (
        <div className="msg-docs">
          {docs.map((p, i) => (
            <button key={p + i} className="msg-doc" onClick={() => onOpenFile?.(p)} aria-label={imageName(p)}>
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
  live,
  running,
  onOpenFile,
  onOpenImage
}: {
  item: ThreadItem
  live?: boolean // this is the latest assistant message (smooth-reveal it)
  running?: boolean // a run is in progress (start the reveal from empty)
  onOpenFile?: (path: string) => void // open a file referenced by a tool-log row
  onOpenImage?: (images: string[], index: number) => void // open the image viewer at an index
}) {
  useLang() // 언어 전환 재렌더 구독 (memo 컴포넌트라 루트 재렌더가 여기까지 오지 않는다)
  if (item.kind === 'toolgroup') return <ToolGroup item={item} onOpenFile={onOpenFile} />
  if (item.kind === 'cmdresult') return <CmdResultCard item={item} />
  // 턴 마무리 줄 — 답변 바로 위의 'N초 동안 작업함' (PoC .worked)
  if (item.kind === 'worked') return <div className="worked">{fmtWorked(item.ms)}</div>
  // 중단 마커 — Esc/중지로 턴을 끊은 자리. 흔적(말풍선·부분 답변·도구 로그)은 그대로
  // 위에 남는다 (클로드 코드의 'Interrupted' 문법)
  if (item.kind === 'interrupted') {
    return (
      <div className="stopline">
        <IconSquare size={9} />
        <span>{t('중단함', 'Interrupted')}</span>
      </div>
    )
  }
  // 문답 흔적 (PoC .qa) — Q 마커+질문(흐림) 아래 ✓+답(볼드). 박스 없이 대화에 남는다
  if (item.kind === 'qa') {
    return (
      <div className="qa">
        {item.pairs.map((p, i) => (
          <div key={i}>
            <div className="qq2">
              <span className="qm">Q{i + 1}</span>
              <span className="qt2">{p.q}</span>
            </div>
            {p.a.map((a, k) => (
              <div className="qa2" key={k}>
                <IconCheck size={14} />
                <span>{a}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    )
  }
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
          <IconMascotDraw size={25} />
        </span>
        <span className="working-label">{item.text}</span>
      </div>
    )
  }
  // 오류 — 맨몸 빨간 텍스트 대신 고유 카드 (노란 안내 notice-row와 같은 문법의 빨간 판).
  // 리듀서가 붙인 '오류: ' 접두는 카드 제목이 그 역할이라 본문에서 걷는다
  if (item.error) {
    return (
      <div className="error-row">
        <span className="error-ic">
          <IconX2 size={15} />
        </span>
        <div className="error-body">
          <div className="error-head">
            <span className="error-title">{t('오류', 'Error')}</span>
            <span className="error-time">{item.time}</span>
          </div>
          {/* 리듀서가 붙인 접두는 언어에 따라 '오류: '/'Error: ' 둘 다 올 수 있다 */}
          <div className="error-text">{item.text.replace(/^(오류|Error):\s*/, '')}</div>
        </div>
      </div>
    )
  }
  const isUser = item.role === 'user'
  return (
    <div className={'msg ' + (isUser ? 'user' : 'ai-msg')}>
      <div className="msg-main">
        <div className="content">
          {item.kind === 'msg' && item.images && item.images.length > 0 && (
            <MessageAttachments images={item.images} onOpen={onOpenImage} onOpenFile={onOpenFile} />
          )}
          {item.text &&
            (isUser ? (
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
  const Ic = slashCommands().find((c) => c.name === item.name)?.icon ?? IconTerminal
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
// 표시 문자열이라 상수가 아니라 함수 — 모듈 스코프에서 t()를 부르면 import 시점 언어로 박제된다
function workingPhrases(): string[] {
  return [
    // 생각·궁리
    t('골똘히 생각하는 중', 'Thinking hard'),
    t('머리 굴리는 중', 'Racking my brain'),
    t('곰곰이 따져보는 중', 'Mulling it over'),
    t('차근차근 정리하는 중', 'Sorting it out step by step'),
    t('고민에 고민을 더하는 중', 'Overthinking, then some'),
    t('차분히 헤아리는 중', 'Weighing it calmly'),
    t('곱씹어보는 중', 'Chewing it over'),
    t('요모조모 뜯어보는 중', 'Picking it apart'),
    t('하나하나 짚어보는 중', 'Going through it one by one'),
    t('갈피를 잡는 중', 'Getting my bearings'),
    t('감을 잡는 중', 'Getting a feel for it'),
    t('머릿속을 정돈하는 중', 'Tidying up my head'),
    t('생각을 가다듬는 중', 'Collecting my thoughts'),
    t('생각의 갈래를 나누는 중', 'Branching out the ideas'),
    t('핵심만 골라내는 중', 'Picking out the essentials'),
    t('앞뒤를 맞춰보는 중', 'Lining up the pieces'),
    t('정신 집중하는 중', 'Focusing up'),
    t('맥락을 읽는 중', 'Reading the context'),
    t('흐름을 따라가는 중', 'Following the flow'),
    // 두뇌·회로
    t('뇌를 가동하는 중', 'Booting up the brain'),
    t('머릿속 회로 돌리는 중', 'Spinning up mental circuits'),
    t('톱니바퀴 돌리는 중', 'Turning the gears'),
    t('두뇌 풀가동 중', 'Brain at full throttle'),
    t('두뇌 예열중', 'Warming up the brain'),
    t('회로 점검중', 'Checking the circuits'),
    t('두뇌 엔진 데우는 중', 'Heating the brain engine'),
    t('기어를 올리는 중', 'Shifting up a gear'),
    t('생각 회로에 불 켜는 중', 'Lighting up the thought circuits'),
    t('두뇌 터빈 돌리는 중', 'Spinning the brain turbine'),
    t('뉴런 총출동 중', 'All neurons on deck'),
    t('시냅스 달구는 중', 'Firing up the synapses'),
    t('뉴런을 깨우는 중', 'Waking the neurons'),
    t('시냅스 연결하는 중', 'Wiring the synapses'),
    t('뇌세포 소집하는 중', 'Rallying the brain cells'),
    t('회로도를 따라가는 중', 'Tracing the schematic'),
    t('배선을 정리하는 중', 'Tidying the wiring'),
    t('신호를 추적하는 중', 'Tracking the signal'),
    t('머릿속 주판 튕기는 중', 'Clicking the mental abacus'),
    t('머릿속 칠판에 적는 중', 'Writing on the mental chalkboard'),
    t('머릿속 서랍을 뒤지는 중', 'Rummaging through mental drawers'),
    t('기억의 책장을 넘기는 중', 'Flipping through memory'),
    t('머릿속 실험실 가동 중', 'Running the mind lab'),
    // 추리·수사
    t('단서를 모으는 중', 'Gathering clues'),
    t('실마리를 푸는 중', 'Unraveling the thread'),
    t('돋보기 들이대는 중', 'Holding up the magnifier'),
    t('발자국 따라가는 중', 'Following the footprints'),
    t('수수께끼를 푸는 중', 'Solving the riddle'),
    t('단서를 맞춰보는 중', 'Matching up the clues'),
    t('흩어진 단서를 줍는 중', 'Picking up scattered clues'),
    t('추리를 이어가는 중', 'Carrying on the deduction'),
    t('진상을 파헤치는 중', 'Digging for the truth'),
    t('범인을 좁혀가는 중', 'Narrowing down the culprit'),
    t('버그 자취를 쫓는 중', "Chasing the bug's trail"),
    t('안개를 걷어내는 중', 'Clearing the fog'),
    t('촉을 세우는 중', 'Trusting my instincts'),
    // 탐험·발굴
    t('이리저리 탐색하는 중', 'Poking around'),
    t('코드 숲을 헤매는 중', 'Wandering the code forest'),
    t('보물 찾는 중', 'Hunting for treasure'),
    t('지도를 펼치는 중', 'Unfolding the map'),
    t('미궁을 헤치는 중', 'Working through the labyrinth'),
    t('미로에서 길 찾는 중', 'Finding a way out of the maze'),
    t('깊이 파고드는 중', 'Digging in deep'),
    t('지름길을 찾는 중', 'Looking for a shortcut'),
    t('샛길을 살피는 중', 'Scouting the side paths'),
    t('갈림길에서 고르는 중', 'Choosing at the fork'),
    t('코드 바다를 항해하는 중', 'Sailing the sea of code'),
    t('깊은 곳까지 잠수하는 중', 'Diving all the way down'),
    t('광맥을 캐는 중', 'Mining the vein'),
    t('원석을 캐는 중', 'Digging out the raw gems'),
    t('점들을 잇는 중', 'Connecting the dots'),
    t('별자리를 잇는 중', 'Drawing constellations'),
    // 퍼즐·엮기
    t('퍼즐 맞추는 중', 'Assembling the puzzle'),
    t('조합해보는 중', 'Trying combinations'),
    t('생각의 실타래 푸는 중', 'Untangling the thoughts'),
    t('매듭을 푸는 중', 'Undoing the knot'),
    t('빈칸을 채우는 중', 'Filling in the blanks'),
    t('한 땀 한 땀 엮는 중', 'Stitching it together'),
    t('차곡차곡 쌓는 중', 'Stacking it up neatly'),
    t('딱 맞는 조각 찾는 중', 'Finding the piece that fits'),
    t('틀을 짜는 중', 'Framing it out'),
    t('촘촘히 엮는 중', 'Weaving it tight'),
    // 코드·논리
    t('코드 들여다보는 중', 'Peering into the code'),
    t('코드를 음미하는 중', 'Savoring the code'),
    t('논리를 다듬는 중', 'Polishing the logic'),
    t('경우의 수를 세는 중', 'Counting the cases'),
    t('가능성을 저울질하는 중', 'Weighing the possibilities'),
    t('코드 결을 살피는 중', 'Reading the grain of the code'),
    t('코드 행간을 읽는 중', 'Reading between the lines'),
    t('로직을 굴려보는 중', 'Turning the logic over'),
    t('실행 흐름을 짚는 중', 'Tracing the execution'),
    t('흐름을 거슬러 올라가는 중', 'Walking the flow backwards'),
    t('변수를 저울질하는 중', 'Weighing the variables'),
    t('변수를 하나씩 소거하는 중', 'Eliminating variables one by one'),
    t('논리를 갈고닦는 중', 'Sharpening the logic'),
    t('가설을 세우는 중', 'Forming a hypothesis'),
    t('가설을 검증하는 중', 'Testing the hypothesis'),
    t('반례를 찾아보는 중', 'Hunting for counterexamples'),
    t('허점을 메우는 중', 'Patching the holes'),
    t('빈틈을 살피는 중', 'Checking for gaps'),
    t('방정식을 푸는 중', 'Solving the equation'),
    // 설계·구축
    t('큰 그림 그리는 중', 'Sketching the big picture'),
    t('설계도를 펼치는 중', 'Rolling out the blueprints'),
    t('청사진을 그리는 중', 'Drawing the blueprint'),
    t('밑그림 그리는 중', 'Sketching the outline'),
    t('뼈대를 세우는 중', 'Raising the skeleton'),
    t('주춧돌 놓는 중', 'Laying the cornerstone'),
    t('판을 짜는 중', 'Setting the stage'),
    t('수순을 정하는 중', 'Deciding the order of moves'),
    t('벽돌을 한 장씩 쌓는 중', 'Laying bricks one by one'),
    t('징검다리 놓는 중', 'Placing stepping stones'),
    t('첫 단추를 끼우는 중', 'Buttoning the first button'),
    // 수읽기·승부
    t('묘수를 찾는 중', 'Looking for the brilliant move'),
    t('반짝이는 수를 고르는 중', 'Picking a sparkling move'),
    t('묘안을 짜내는 중', 'Cooking up a clever idea'),
    t('다음 수를 읽는 중', 'Reading the next move'),
    t('몇 수 앞을 내다보는 중', 'Looking a few moves ahead'),
    t('판세를 읽는 중', 'Reading the board'),
    t('포석을 놓는 중', 'Setting up the opening'),
    t('외통수를 찾는 중', 'Searching for checkmate'),
    t('승부수를 고르는 중', 'Choosing the winning move'),
    t('묘수풀이 하는 중', 'Working out the killer move'),
    t('패를 맞춰보는 중', 'Matching up the cards'),
    // 생각 요리·숙성 — 생각/아이디어/답이 주어로 오는 것만
    t('아이디어 굽는 중', 'Baking the ideas'),
    t('생각을 졸이는 중', 'Simmering the thoughts down'),
    t('생각을 우려내는 중', 'Steeping the thoughts'),
    t('아이디어 반죽하는 중', 'Kneading the idea dough'),
    t('답을 숙성시키는 중', 'Aging the answer'),
    t('노릇하게 굽는 중', 'Baking it golden brown'),
    t('갓 구운 답 꺼내는 중', 'Pulling out a fresh-baked answer'),
    t('생각을 뜸 들이는 중', 'Letting the thoughts steam'),
    t('생각을 재우는 중', 'Letting the thoughts marinate'),
    t('생각을 체에 거르는 중', 'Sifting the thoughts'),
    t('생각을 증류하는 중', 'Distilling the thoughts'),
    t('아이디어를 발효시키는 중', 'Fermenting the ideas'),
    t('아이디어를 배양하는 중', 'Culturing the ideas'),
    t('발상을 버무리는 중', 'Tossing the ideas together'),
    t('발상을 굴리는 중', 'Rolling the idea around'),
    t('답을 빚는 중', 'Shaping the answer'),
    // 영감·마법
    t('마법 부리는 중', 'Working some magic'),
    t('영감을 부르는 중', 'Summoning inspiration'),
    t('번뜩임 기다리는 중', 'Waiting for the spark'),
    t('아이디어에 불씨 지피는 중', 'Kindling the idea'),
    t('영감의 안테나 세우는 중', 'Raising the inspiration antenna'),
    t('마법진을 그리는 중', 'Drawing the magic circle'),
    t('주문을 외는 중', 'Chanting the incantation'),
    // 몸풀기
    t('슬슬 시동 거는 중', 'Getting the engine going'),
    t('손가락 푸는 중', 'Limbering up my fingers'),
    t('열심히 만지작거리는 중', 'Fiddling away'),
    t('톡톡 두드려보는 중', 'Tapping around'),
    t('머리를 쥐어짜는 중', 'Squeezing my brain')
  ]
}

// 멘트 shimmer 색 추첨 — 화이트 90%, 단색 19종이 9.7%를 나눔(각 ≈0.51%), 그라디언트는
// 남는 0.3%: rainbow만 0.01%(1만분의 1 잭팟), 나머지 5종이 0.29%를 나눔(각 0.058%).
// 단색은 wc-* 클래스가 base/hi 색만 바꾸고, 그라디언트는 wc-flow가 색 띠를 계속 흘린다(styles.css).
const PHRASE_SOLID_COLORS = ['orange', 'gold', 'lemon', 'lime', 'green', 'mint', 'teal', 'aqua', 'sky', 'blue', 'indigo', 'lavender', 'purple', 'magenta', 'pink', 'rose', 'coral', 'red', 'mocha']
const PHRASE_FLOW_COLORS = ['rainbow', 'sunset', 'ocean', 'aurora', 'fire', 'neon']
const PHRASE_SOLID_EACH = 9.7 / PHRASE_SOLID_COLORS.length
const PHRASE_RAINBOW = 0.01
const PHRASE_FLOW_EACH = (0.3 - PHRASE_RAINBOW) / (PHRASE_FLOW_COLORS.length - 1)
function rollPhraseColor(): string {
  let r = Math.random() * 100
  if ((r -= 90) < 0) return ''
  for (const c of PHRASE_SOLID_COLORS) if ((r -= PHRASE_SOLID_EACH) < 0) return 'wc wc-' + c
  for (const c of PHRASE_FLOW_COLORS) if ((r -= c === 'rainbow' ? PHRASE_RAINBOW : PHRASE_FLOW_EACH) < 0) return 'wc-flow wc-' + c
  return ''
}

// Persistent "working" indicator shown in the chat while the agent is busy, so
// the user can always tell it's running (not stuck). 컨셉: 마스코트(선부터 그려지는
// 루프) + 우리 커스텀 회전 문구 + 경과 초. 모델의 raw 사고 텍스트(Claude 한국어 산문·
// Codex 영어 요약)는 여기 절대 넣지 않는다 — 두 엔진 모두 같은 브랜드 문구로 통일한다.
// elapsed(초)는 useAgentSession 훅에서 내려온다 — 질문/승인 카드나 답변 스트리밍으로
// 인디케이터가 잠시 언마운트돼도 훅이 계속 세고 있어 리셋되지 않는다
export function WorkingIndicator({ elapsed }: { elapsed: number }) {
  useLang() // 언어 전환 재렌더 구독 — 회전 문구가 즉시 따라온다
  const [i, setI] = useState(() => Math.floor(Math.random() * workingPhrases().length))
  const [color, setColor] = useState(rollPhraseColor)
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>
    function schedule(): void {
      // random 5~20s before switching to a new (non-repeating) phrase
      id = setTimeout(
        () => {
          setI((n) => {
            const len = workingPhrases().length
            if (len < 2) return 0
            let next = Math.floor(Math.random() * len)
            if (next === n) next = (next + 1) % len
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
  const label = workingPhrases()[i]
  // 라이브 인디케이터 — 마스코트가 선부터 그려지는 루프(머리→귀→더듬이→점) + shimmer 문구.
  return (
    <div className="working-line">
      <span className="working-spark">
        <IconMascotDraw size={25} />
      </span>
      <span key={label} className={'working-label' + (color ? ' ' + color : '')}>
        {label}
      </span>
      {/* 경과 시간 — 문구 span과 형제(문구는 key={label}로 리마운트되며 shimmer가
          도는데, 초가 그 안에 있으면 매초 리마운트로 shimmer가 리셋된다).
          랜덤멘트에 색이 와도 시간은 항상 조용한 회색(--text-4) */}
      <span className="working-time">
        <span className="dot">·</span>
        {fmtElapsedKo(elapsed)}
      </span>
    </div>
  )
}

// 헤더 폴더 picker의 한 행 — App이 최근 채팅들의 폴더에서 뽑아 넘긴다
// ── 작업 폴더 picker 팝오버 — 본채팅 헤더·멀티 패널 칩·추가 채팅 헤더 공용 ─────
// 목록은 공유 최근 폴더(lib/recentDirs — localStorage라 모든 창이 공유)를 마운트
// (=열림) 시점에 새로 읽는다: 다른 화면/창에서 방금 고른 폴더가 바로 보인다.
export function FolderPop({
  cwd,
  onSelect,
  onBrowse,
  onClose,
  right,
  refDirs,
  onAddRef,
  onAddRefPath,
  onRemoveRef
}: {
  cwd?: string // 현재 폴더 — 맨 위 '지금' + 체크로 표시
  onSelect: (path: string) => void // 목록에서 선택 — 호스트의 requestFolder(확인 카드 흐름)
  onBrowse: () => void // 찾아보기 — OS 폴더 선택
  onClose: () => void
  right?: boolean // 오른쪽 끝 칩용 — 팝오버 오른쪽 정렬 (.wb-pop.r)
  // 참조 폴더(--add-dir) — onAddRef를 넘긴 호스트만 섹션이 보인다. 작업 폴더와 달리
  // 선택이 아니라 목록 관리(추가/제거)라 행 클릭은 없다.
  refDirs?: string[]
  onAddRef?: () => void // OS 픽커로 참조 폴더 추가
  onAddRefPath?: (path: string) => void // 즐겨찾기/최근 행의 + — 그 폴더를 참조로 바로 추가
  onRemoveRef?: (path: string) => void
}) {
  // 바깥 클릭/Esc로 닫기 — 안쪽 클릭은 호스트의 .hfold 래퍼가 전파를 막는다
  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  // 즐겨찾기가 있으면 목록을 "즐겨찾기 / 최근" 섹션(캡션+밑줄)으로 나눈다. 별 토글과
  // 최근 ✕는 라이브 재구성 — 별을 달면 그 행이 즐겨찾기 섹션으로 올라가고, ✕를 누르면
  // 그 자리에서 사라지는 게 눈에 보인다.
  const [rev, setRev] = useState(0)
  const { curRow, favRows, recRows, favList } = useMemo(() => {
    const favs = loadFavDirs()
    const shared = loadRecentDirs()
    const tOf = (p: string): number => shared.find((x) => sameCwd(x.p, p))?.t ?? 0
    const notCur = (p: string): boolean => !cwd || !sameCwd(p, cwd)
    return {
      favList: favs,
      // 지금 폴더는 섹션 위에 따로 핀 — 즐겨찾기여도 중복해서 다시 안 그린다
      curRow: cwd ? { path: cwd, t: tOf(cwd), current: true } : null,
      favRows: favs.filter(notCur).map((p) => ({ path: p, t: tOf(p), current: false })),
      recRows: shared
        .filter((x) => notCur(x.p) && !favs.some((f) => sameCwd(f, x.p)))
        .map((x) => ({ path: x.p, t: x.t, current: false, rec: true }))
        .slice(0, 6)
    }
  }, [cwd, rev])
  const baseOf = (p: string): string => p.split(/[\\/]+/).filter(Boolean).pop() ?? p
  // 별 토글 — 팝오버는 닫지 않는다 (행 클릭의 폴더 선택과 분리, stopPropagation)
  const onStar = (e: React.MouseEvent, path: string): void => {
    e.stopPropagation()
    toggleFavDir(path)
    setRev((r) => r + 1)
  }
  const renderRow = (f: { path: string; t: number; current: boolean; rec?: boolean }): React.ReactNode => {
    const fav = favList.some((p) => sameCwd(p, f.path))
    const ref = (refDirs ?? []).some((p) => sameCwd(p, f.path))
    return (
      <button
        key={f.path}
        className="wb-prow hprow"
        onClick={() => {
          onClose()
          if (!f.current) onSelect(f.path)
        }}
      >
        <span className="grow">
          {baseOf(f.path)}
          <span className="sub">{f.path}</span>
        </span>
        {(f.current || f.t > 0) && <span className="end">{f.current ? t('지금', 'Now') : relTime(f.t)}</span>}
        {f.current && (
          <span className="pcheck">
            <IconCheck size={12} stroke={2.4} />
          </span>
        )}
        {/* 즐겨찾기 별 — 켜지면 항상 표시, 꺼진 행은 호버에만. 최근에서 밀려나도
            즐겨찾기 섹션에 남는다 (버튼 안 span이라 role만 — 행 클릭과 분리) */}
        <span
          className={'hstar' + (fav ? ' on' : '')}
          role="button"
          aria-label={fav ? t('즐겨찾기 해제', 'Remove from favorites') : t('즐겨찾기', 'Add to favorites')}
          onClick={(e) => onStar(e, f.path)}
        >
          <IconStar size={12} />
        </span>
        {/* 참조 토글 — 행 클릭(작업 폴더로)과 별개로, 이 폴더를 참조 폴더로 얹고 뺀다.
            현재 폴더는 이미 루트라 참조가 될 수 없어 숨긴다. 켜지면 ✓(액센트) 상시 표시 */}
        {onAddRefPath && !f.current && (
          <span
            className={'hstar htg' + (ref ? ' on' : '')}
            role="button"
            aria-label={
              ref ? t('참조 폴더에서 제거', 'Remove from reference folders') : t('참조 폴더로 추가', 'Add as reference folder')
            }
            onClick={(e) => {
              e.stopPropagation()
              if (ref) onRemoveRef?.(f.path)
              else onAddRefPath(f.path)
            }}
          >
            {ref ? <IconCheck size={12} stroke={2.4} /> : <IconPlus size={12} />}
          </span>
        )}
        {/* 최근에서 제거 ✕ — 최근 섹션 행에만 (즐겨찾기는 별 해제, 현재 폴더는 대상 아님).
            다시 그 폴더를 사용하면 최근에 재등장한다 */}
        {f.rec && (
          <span
            className="hstar hx"
            role="button"
            aria-label={t('최근 목록에서 제거', 'Remove from recent list')}
            onClick={(e) => {
              e.stopPropagation()
              removeRecentDir(f.path)
              setRev((r) => r + 1)
            }}
          >
            <IconClose size={11} />
          </span>
        )}
      </button>
    )
  }
  return (
    <div className={'wb-pop hpop' + (right ? ' r' : '')}>
      <div className="wb-pop-h">
        <span className="t">{t('작업 폴더', 'Working folder')}</span>
      </div>
      <div className="wb-pop-list">
        {curRow && renderRow(curRow)}
        {/* 즐겨찾기가 있을 때만 섹션 캡션(라벨+밑줄)으로 나눈다 — 없으면 예전처럼 최근만 평평하게 */}
        {favRows.length > 0 && (
          <>
            <div className="hsec">{t('즐겨찾기', 'Favorites')}</div>
            {favRows.map(renderRow)}
          </>
        )}
        {recRows.length > 0 && favRows.length > 0 && <div className="hsec">{t('최근', 'Recent')}</div>}
        {recRows.map(renderRow)}
        {/* 참조 폴더 — 작업 폴더 외에 엔진이 함께 인식할 폴더(--add-dir). 행은 선택이
            아니라 관리 대상이라 클릭 없음 + 호버에 제거 ✕만 */}
        {onAddRef && (
          <>
            <div className="hsec">{t('참조 폴더', 'Reference folders')}</div>
            {(refDirs ?? []).map((p) => (
              <div key={p} className="wb-prow hprow href">
                <span className="grow">
                  {baseOf(p)}
                  <span className="sub">{p}</span>
                </span>
                <span
                  className="hstar hx"
                  role="button"
                  aria-label={t('참조 폴더 제거', 'Remove reference folder')}
                  onClick={() => onRemoveRef?.(p)}
                >
                  <IconClose size={11} />
                </span>
              </div>
            ))}
            <button
              className="wb-prow hprow"
              onClick={() => {
                onClose()
                onAddRef()
              }}
            >
              <span className="grow">
                {t('참조 폴더 추가…', 'Add reference folder…')}
                <span className="sub">{t('작업 폴더 외에 함께 인식할 폴더', 'Extra folders the engine can see')}</span>
              </span>
            </button>
          </>
        )}
        {(curRow || favRows.length > 0 || recRows.length > 0) && <div className="wb-psep" />}
        <button
          className="wb-prow hprow"
          onClick={() => {
            onClose()
            onBrowse()
          }}
        >
          <span className="grow">
            {t('폴더 찾아보기…', 'Browse folders…')}
            <span className="sub">{t('목록에 없는 폴더 선택', 'Pick a folder not in the list')}</span>
          </span>
        </button>
      </div>
    </div>
  )
}

// PoC .ch 그대로: [제목][폴더 칩(모노 필 → 작업 폴더 팝오버)][sp][돋보기][탐색기 토글][구분선][창 컨트롤].
// 상태 필은 2.0에서 제거 — 진행 상태는 사이드바 점·스레드 인디케이터·WorkBar가 이미 말한다.
// explorerHidden/onToggleExplorer: 탐색기를 접으면 레일을 남기지 않고 완전히 사라지므로,
// 단축키를 모르는 사람도 다시 열 수 있게 토글 버튼을 둔다.
export function ChatHeader({
  title,
  cwd,
  placeholder = t('폴더 선택', 'Select folder'),
  onSelectFolder,
  onBrowseFolder,
  refDirs,
  onAddRefDir,
  onAddRefDirPath,
  onRemoveRefDir,
  explorerHidden,
  onToggleExplorer
}: {
  title: string
  cwd?: string
  placeholder?: string // 폴더 미지정일 때 칩 라벨 — 추가 채팅은 기본 폴더가 '바탕화면'
  onSelectFolder?: (path: string) => void // 목록에서 선택 — App의 requestFolder(확인 카드 흐름)
  onBrowseFolder?: () => void // 찾아보기 — OS 폴더 선택
  refDirs?: string[] // 참조 폴더(--add-dir) — 팝오버 관리 섹션 + 칩 +N 배지
  onAddRefDir?: () => void
  onAddRefDirPath?: (path: string) => void // 즐겨찾기/최근 행의 + — 경로 직접 추가
  onRemoveRefDir?: (path: string) => void
  explorerHidden?: boolean
  onToggleExplorer?: () => void
}) {
  const [fpop, setFpop] = useState(false)
  // 돋보기 켜짐 표시 — ChatFind가 알리는 열림 상태를 구독한다
  const [findOn, setFindOn] = useState(false)
  useEffect(() => {
    const onState = (e: Event): void => setFindOn(!!(e as CustomEvent).detail)
    window.addEventListener('ccg:chat-find-state', onState)
    return () => window.removeEventListener('ccg:chat-find-state', onState)
  }, [])
  return (
    <div className="chat-head">
      {title && <span className="h-title">{title}</span>}
      {onBrowseFolder && (
        <span className="hfold" onMouseDown={(e) => e.stopPropagation()}>
          {/* 앱 공통 커스텀 툴팁(has-tip) — 네이티브 title은 OS 서식이라 튄다 (유저 결정).
              말줄임은 안쪽 span 몫 — 버튼에 overflow:hidden을 두면 ::after 툴팁째 잘린다.
              팝오버가 열려 있는 동안은 has-tip을 떼어 툴팁이 팝오버와 겹치지 않게 한다 */}
          <button
            className={'tag mono fsel' + (fpop ? '' : ' has-tip')}
            data-tip={
              refDirs?.length
                ? t(
                    `작업 폴더 — 누르면 변경 · 참조 폴더 ${refDirs.length}개`,
                    `Working folder — click to change · ${refDirs.length} reference folders`
                  )
                : t('작업 폴더 — 누르면 변경', 'Working folder — click to change')
            }
            onClick={() => setFpop((o) => !o)}
          >
            <span className="fsel-txt">{cwd || placeholder}</span>
            {/* 참조 폴더가 있으면 +N — 이 채팅이 폴더 여러 개를 물고 있다는 표시 */}
            {(refDirs?.length ?? 0) > 0 && <span className="fsel-ref">+{refDirs!.length}</span>}
          </button>
          {fpop && (
            <FolderPop
              cwd={cwd}
              onSelect={(p) => onSelectFolder?.(p)}
              onBrowse={onBrowseFolder}
              onClose={() => setFpop(false)}
              refDirs={refDirs}
              onAddRef={onAddRefDir}
              onAddRefPath={onAddRefDirPath}
              onRemoveRef={onRemoveRefDir}
            />
          )}
        </span>
      )}
      <span className="spacer" />
      <button
        className={'h-ic has-tip' + (findOn ? ' on' : '')}
        data-tip={t('대화에서 찾기 (Ctrl+F)', 'Find in chat (Ctrl+F)')}
        aria-label={t('대화에서 찾기', 'Find in chat')}
        onClick={() => window.dispatchEvent(new Event('ccg:chat-find'))}
      >
        <IconSearch size={15} />
      </button>
      {onToggleExplorer && (
        <button
          className={'h-ic has-tip' + (explorerHidden ? '' : ' on')}
          data-tip={
            explorerHidden
              ? t('파일 탐색기 — 왼쪽 목록과 전환 (`)', 'File explorer — swap the left list (`)')
              : t('채팅 목록으로 (`)', 'Back to chat list (`)')
          }
          aria-label={t('파일 탐색기', 'File explorer')}
          onClick={onToggleExplorer}
        >
          <IconPanelRight size={15} />
        </button>
      )}
      <span className="vsep" />
      <WinControls />
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
        <span>{copied ? t('복사됨', 'Copied') : t('복사', 'Copy')}</span>
      </button>
      <span className="sel-div" />
      <button className="sel-act" onClick={elaborate}>
        <IconSearch size={14} />
        <span>{t('더 자세히', 'Tell me more')}</span>
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
const CF_BLOCKING = '.fv-overlay, .set-overlay, .gitm-overlay, .iv-overlay, .sa-overlay, .set-dialog-overlay'

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
  panel = false,
  onOpenChange
}: {
  scrollRef: React.RefObject<HTMLElement | null>
  active?: boolean // Ctrl+F에 반응할지 — 멀티 모드에선 포커스/확대된 패널만 true
  panel?: boolean // 멀티 패널 안(작은 폭)에 뜨는 변형
  onOpenChange?: (open: boolean) => void // 열림/닫힘 통지 — 스레드 윈도잉이 열릴 때 전체를 펼친다
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

  // 열기 공통 경로 — Ctrl+F와 헤더 돋보기(ccg:chat-find 이벤트)가 같이 쓴다.
  // active 인스턴스만, Ctrl+F를 스스로 갖는 오버레이가 없고 이 채팅 표면이
  // 실제로 화면에 떠 있을 때만 반응한다. 이미 열려 있으면 입력 재선택.
  const openFind = (): void => {
    if (!active) return
    const root = scrollRef.current
    if (!root || root.offsetParent === null) return
    if (document.querySelector(CF_BLOCKING)) return
    if (open) {
      inputRef.current?.select()
      return
    }
    // 짧은 한 줄 선택이 있으면 초기 검색어로 (브라우저 Ctrl+F 관례)
    const sel = window.getSelection()?.toString().trim() ?? ''
    setQuery(sel && sel.length <= 80 && !sel.includes('\n') ? sel : '')
    setOpen(true)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f')) return
      if (!active) return
      const root = scrollRef.current
      if (!root || root.offsetParent === null) return
      if (document.querySelector(CF_BLOCKING)) return
      e.preventDefault()
      openFind()
    }
    // 헤더 돋보기는 토글 — 열려 있으면 닫는다 (Ctrl+F는 관례대로 입력 재선택)
    const onOpenEvent = (): void => {
      if (open) close()
      else openFind()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('ccg:chat-find', onOpenEvent)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('ccg:chat-find', onOpenEvent)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open, scrollRef])

  // 헤더 돋보기의 켜짐 표시 — 열림/닫힘을 창 이벤트로 알린다 (ChatHeader가 구독)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ccg:chat-find-state', { detail: open }))
    onOpenChange?.(open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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
        placeholder={t('채팅 내 검색…', 'Search chat…')}
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
      <span className="cnt">{total ? `${cur + 1}/${total}` : query ? t('0개', '0/0') : ''}</span>
      <button
        className="has-tip"
        data-tip={t('이전 (Shift+Enter)', 'Previous (Shift+Enter)')}
        aria-label={t('이전 결과', 'Previous match')}
        onClick={() => step(-1)}
        disabled={!total}
      >
        <IconChevDown size={14} style={{ transform: 'rotate(180deg)' }} />
      </button>
      <button
        className="has-tip"
        data-tip={t('다음 (Enter)', 'Next (Enter)')}
        aria-label={t('다음 결과', 'Next match')}
        onClick={() => step(1)}
        disabled={!total}
      >
        <IconChevDown size={14} />
      </button>
      <button className="has-tip" data-tip={t('닫기 (Esc)', 'Close (Esc)')} aria-label={t('검색 닫기', 'Close search')} onClick={close}>
        <IconClose size={14} />
      </button>
    </div>
  )
}

// 에이전트(코드) 모드 — 코드베이스를 직접 다루는 작업 위주
// ── 스레드 바닥 따라가기 — 본채팅·추가 채팅이 공유하는 스크롤 규칙 ─────────────
// 매 프레임 위치 비교가 아니라 의도 래치: 스트리밍 스냅이 프레임마다 도는 동안 위치
// 비교는 작은 위 스크롤을 즉시 무효화하므로, 휠 업 = 따라가기 OFF(이벤트 고유의
// deltaY라 스냅과 경합하지 않음), 바닥 정착 + 150ms 가드 = 다시 ON 으로 읽는다.
const FOLLOW_BOTTOM_EPSILON = 60 // 이 안쪽이면 "바닥에 있다"로 판정
const FOLLOW_JUMP_SHOW_PX = 240 // 바닥에서 이만큼 멀어지면 "맨 아래로" 점프 버튼 표시
export function useThreadFollow(scrollEl: HTMLElement | null, busy: boolean) {
  const stickRef = useRef(true)
  const lastWheelUpRef = useRef(-Infinity) // timeStamp of the most recent upward wheel
  const lastTopRef = useRef(0) // 마지막 스크롤 위치 — 뷰 왕복으로 스크롤 영역이 재생성될 때 복원용
  const sbDragRef = useRef(false) // 세로 스크롤바를 잡고 있는 동안 true — 드래그 중 재고정 금지
  const [showJump, setShowJump] = useState(false)

  useEffect(() => {
    const el = scrollEl
    if (!el) return
    // 뷰 왕복은 스크롤 영역을 재생성해 scrollTop이 0(맨 위)에서 시작한다 — 바닥을
    // 따라가던 중이면 맨 아래로, 위를 읽던 중이면 마지막으로 보던 위치로 복원
    el.scrollTop = stickRef.current ? el.scrollHeight : lastTopRef.current
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > FOLLOW_JUMP_SHOW_PX)
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return // ctrl+wheel is zoom (handled elsewhere), not a scroll
      if (e.deltaY < 0) {
        stickRef.current = false // scrolling up → stop following
        lastWheelUpRef.current = e.timeStamp
      }
    }
    const onScroll = (e: Event): void => {
      lastTopRef.current = el.scrollTop
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowJump(fromBottom > FOLLOW_JUMP_SHOW_PX)
      // resume only while paused, settled at the bottom, and not in the middle of an
      // upward gesture — the time guard stops a near-bottom scroll-up from instantly
      // re-arming the follow (which would trap the user in the bottom band)
      if (
        !stickRef.current &&
        !sbDragRef.current &&
        fromBottom <= FOLLOW_BOTTOM_EPSILON &&
        e.timeStamp - lastWheelUpRef.current > 150
      )
        stickRef.current = true
    }
    // 스크롤바 드래그도 휠 업과 같은 '따라가기 OFF' 의도 — 드래그는 wheel 없이 scroll만
    // 내서, 잡는 순간 래치를 안 풀면 스트리밍 rAF가 매 프레임 바닥으로 도로 끌어내려
    // 썸을 위로 끌 수 없다(실측: 490px 끌어도 fromBottom 26px 고정). 네이티브 스크롤바
    // 클릭은 target=스크롤러 자신 + offsetX가 clientWidth(스크롤바 제외 폭) 바깥으로
    // 온다(실측 994/989). 드래그 중엔 바닥을 스쳐도 재고정하지 않고, 놓는 순간 바닥이면
    // 휠 복귀와 같은 규칙으로 다시 따라간다.
    const onSbDown = (e: MouseEvent): void => {
      if (e.button !== 0 || e.target !== el || e.offsetX < el.clientWidth) return
      sbDragRef.current = true
      stickRef.current = false
    }
    const onSbUp = (e: MouseEvent): void => {
      if (!sbDragRef.current) return
      sbDragRef.current = false
      // '바닥에 놓았나'는 스크롤 위치가 아니라 포인터 y로 판정한다 — 스트리밍 성장이
      // 드래그 중 scroll 이벤트를 계속 만들고(리매핑도 scrollTop을 1~8px씩 움직임 —
      // 실측) 놓는 순간의 fromBottom도 성장에 밀려나 있어 둘 다 신뢰할 수 없다.
      // 썸을 트랙 끝까지 내리면 포인터는 바닥에서 썸 높이(최소 36px) 안에 남는다.
      const nearBottom = el.getBoundingClientRect().bottom - e.clientY <= 48
      if (nearBottom || el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_EPSILON)
        stickRef.current = true
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('mousedown', onSbDown)
    // mouseup은 창 전역에서 — 썸을 잡은 채 포인터가 스크롤러 밖에서 놓일 수 있다
    window.addEventListener('mouseup', onSbUp)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('mousedown', onSbDown)
      window.removeEventListener('mouseup', onSbUp)
    }
  }, [scrollEl])

  // while a run streams, follow the smooth text reveal every frame so it reads as
  // a continuous flow (not a jump on each delta). Paused while the latch is off.
  useEffect(() => {
    if (!busy || !scrollEl) return
    let raf = 0
    let alive = true
    const stick = (): void => {
      if (!alive) return
      if (stickRef.current) scrollEl.scrollTop = scrollEl.scrollHeight
      raf = requestAnimationFrame(stick)
    }
    raf = requestAnimationFrame(stick)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [busy, scrollEl])

  // 전송 = 따라가기 재개 (스냅은 메시지 추가 effect가 수행)
  const pin = useCallback(() => {
    stickRef.current = true
  }, [])
  // 채팅 전환/열기 — 항상 바닥부터 (호출측의 메시지 로드 effect보다 먼저 실행되게 배치)
  const reset = useCallback(() => {
    stickRef.current = true
    setShowJump(false)
  }, [])
  // 새 메시지/생각 갱신 시 호출 — 래치가 켜져 있을 때만 바닥으로
  const snapIfStuck = useCallback(() => {
    if (scrollEl && stickRef.current) scrollEl.scrollTop = scrollEl.scrollHeight
  }, [scrollEl])
  // "맨 아래로" 버튼·↓ 제스처 — 다시 고정하고 부드럽게 내려간다
  const jumpBottom = useCallback(() => {
    stickRef.current = true
    scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' })
  }, [scrollEl])
  // ↑ 제스처 — 스트리밍 rAF가 도로 끌어내리지 않게 고정을 풀고(재고정 가드 무장) 맨 위로
  const scrollTop = useCallback(() => {
    stickRef.current = false
    lastWheelUpRef.current = performance.now()
    scrollEl?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [scrollEl])
  return { showJump, pin, reset, snapIfStuck, jumpBottom, scrollTop }
}

// ── 스레드 꼬리 윈도잉 ────────────────────────────────────────────
// 긴 세션은 메시지 DOM이 수만 노드로 쌓여 상주 메모리와 매 델타 재조정 비용을 키운다
// (content-visibility는 페인트만 건너뛰고 노드는 전부 살아 있다). 렌더만 꼬리 N개로
// 자르고 데이터(state.messages)는 그대로 둔다 — 검색·resume·peek이 데이터를 본다.
// 위로 올라가 센티널에 닿으면 STEP씩 넓히고, 바닥으로 돌아오면 도로 꼬리로 줄인다.
const THREAD_TAIL = 60 // 기본 렌더 꼬리 (메시지 수)
const THREAD_STEP = 60 // 맨 위 도달 시 위로 넓히는 폭
const THREAD_TRIM_SLACK = 40 // 바닥 복귀 시 꼬리보다 이만큼 넘게 커져 있어야 트림 (널뛰기 방지)

export function useThreadWindow(scrollEl: HTMLElement | null, total: number, resetKey?: unknown) {
  const [start, setStart] = useState(() => Math.max(0, total - THREAD_TAIL))
  const startRef = useRef(start)
  startRef.current = start
  const totalRef = useRef(total)
  totalRef.current = total
  const elRef = useRef(scrollEl)
  elRef.current = scrollEl
  // 확장/트림 직전의 스크롤 기하 — 렌더 반영 후 높이 델타만큼 scrollTop을 되돌려
  // 보던 위치를 고정한다 (위에 내용이 생기거나 사라져도 화면이 점프하지 않게)
  const compRef = useRef<{ top: number; height: number } | null>(null)

  const shiftTo = useCallback((next: number): void => {
    if (next === startRef.current) return
    const el = elRef.current
    if (el) compRef.current = { top: el.scrollTop, height: el.scrollHeight }
    setStart(next)
  }, [])

  // 채팅 전환 — 새 스레드는 꼬리부터 (렌더 중 상태 조정 패턴: 전환 프레임에 바로 반영)
  const [prevKey, setPrevKey] = useState(resetKey)
  if (prevKey !== resetKey) {
    setPrevKey(resetKey)
    compRef.current = null
    setStart(Math.max(0, total - THREAD_TAIL))
  } else if (start > total) {
    // /clear 등으로 스레드가 통째로 줄었을 때 — 범위 밖 인덱스 방지
    compRef.current = null
    setStart(Math.max(0, total - THREAD_TAIL))
  }

  // 스크롤 보정 — 커밋 직후·페인트 전에 실행돼 사용자는 이동을 보지 못한다.
  // 절댓값 대입이라 브라우저 자체 scroll anchoring과 겹쳐도 이중 보정되지 않는다.
  useLayoutEffect(() => {
    const c = compRef.current
    if (!c) return
    compRef.current = null
    const el = elRef.current
    if (el) el.scrollTop = c.top + (el.scrollHeight - c.height)
  }, [start])

  // 맨 위 센티널 — 보이면(200px 여유) 위로 STEP만큼 넓힌다. start=0이면 렌더 안 됨.
  const [sentEl, setSentEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!sentEl || !scrollEl) return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        const s = startRef.current
        if (s > 0) shiftTo(Math.max(0, s - THREAD_STEP))
      },
      { root: scrollEl, rootMargin: '200px 0px 0px 0px' }
    )
    io.observe(sentEl)
    return () => io.disconnect()
  }, [sentEl, scrollEl, shiftTo])

  // 바닥 복귀 = 히스토리 다 읽었다는 신호 — 넓힌 윈도를 도로 꼬리로 (히스테리시스).
  // 스트리밍 중 rAF 바닥 고정이 scroll을 계속 내므로 긴 실행에서도 윈도가 유계로 유지된다.
  useEffect(() => {
    const el = scrollEl
    if (!el) return
    const onScroll = (): void => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight > FOLLOW_BOTTOM_EPSILON) return
      const tail = Math.max(0, totalRef.current - THREAD_TAIL)
      if (tail - startRef.current > THREAD_TRIM_SLACK) shiftTo(tail)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollEl, shiftTo])

  // 전부 렌더 — '맨 위로' 제스처용. 보정 없이 펼친다 (호출측이 곧장 맨 위로 스크롤)
  const showAll = useCallback((): void => {
    compRef.current = null
    setStart(0)
  }, [])
  // 전부 렌더(보정 있음) — 찾기(Ctrl+F)가 열릴 때. DOM 검색이라 잘린 메시지는 매치가
  // 안 잡히므로 펼치되, 보던 위치는 그대로 둔다. 닫혀도 되감지 않는다 — 바닥 복귀 트림이 회수.
  const reveal = useCallback((): void => {
    if (startRef.current > 0) shiftTo(0)
  }, [shiftTo])

  return { start, sentinelRef: setSentEl, showAll, reveal }
}

// 표시 문자열이라 상수가 아니라 함수 — 모듈 스코프 t()는 import 시점 언어로 박제된다
function welcomeSuggestions(): { icon: typeof IconPencil; label: string }[] {
  return [
    { icon: IconEye, label: t('이 프로젝트의 구조를 설명해줘', 'Explain how this project is structured') },
    { icon: IconSearch, label: t('버그를 찾아서 고쳐줘', 'Find a bug and fix it') },
    { icon: IconBolt, label: t('성능을 개선할 부분을 찾아줘', 'Find things worth optimizing') },
    { icon: IconPencil, label: t('테스트 코드를 작성해줘', 'Write tests for this code') }
  ]
}

// 순수 채팅(대화) 모드 — 작업 폴더가 없어 코드 작업이 아니라 설명·아이디어·상의 위주
function chatSuggestions(): { icon: typeof IconPencil; label: string }[] {
  return [
    { icon: IconBook, label: t('어려운 개념을 쉽게 설명해줘', 'Explain a hard concept simply') },
    { icon: IconBolt, label: t('아이디어를 함께 브레인스토밍해줘', 'Brainstorm ideas with me') },
    { icon: IconWrench, label: t('기술 선택이나 설계 방향을 같이 고민해줘', 'Think through a tech or design choice') },
    { icon: IconPencil, label: t('글이나 문서 초안을 작성해줘', 'Draft a document or some writing') }
  ]
}

function welcomeCopy(variant: 'agent' | 'chat'): { sub: string; suggestions: { icon: typeof IconPencil; label: string }[] } {
  return variant === 'chat'
    ? {
        sub: t(
          '가볍게 대화로 시작해보세요 — 궁금한 걸 묻거나 아이디어를 함께 정리해보세요.',
          'Start with a chat — ask anything, or sort out an idea together.'
        ),
        suggestions: chatSuggestions()
      }
    : {
        sub: t(
          '코드 작성과 리뷰부터 버그 수정, 리팩터링까지 — 아래에 바로 입력하거나 추천으로 시작해보세요.',
          'From writing and reviewing code to fixing bugs and refactoring — type below, or start from a suggestion.'
        ),
        suggestions: welcomeSuggestions()
      }
}

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
  const copy = welcomeCopy(variant)
  return (
    <div className="welcome">
      {/* 정지 마스코트 — 그려지는(draw-loop) 로봇은 "작업 중" 인디케이터 전용, 대기
          화면은 공식 로봇 아이콘 그대로 (유저 결정) */}
      <div className="wc-mark">
        <IconMascot size={46} />
      </div>
      <div className="wc-title">
        {t(
          `무엇을 도와드릴까요${userName ? `, ${userName}님` : ''}?`,
          `What can I help with${userName ? `, ${userName}` : ''}?`
        )}
      </div>
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

// ── 계정 목록 캐시 (계정 picker 공용) ─────────────────────────
// listAccounts는 메인이 CLI 프로세스를 하나 띄워 상태를 묻는다(auth status) — picker
// 마운트마다 부르면 무겁다. 모듈 캐시 + TTL로 화면의 여러 picker(컴포저·패널들)가
// 한 번의 조회를 나눠 쓴다. 계정 목록은 설정에서만 바뀌니 1분이면 충분히 신선하다.
let acctCache: { at: number; list: AccountInfo[] } | null = null
let acctInflight: Promise<AccountInfo[]> | null = null
const ACCT_TTL = 60_000

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

// 잔량 톤 — 남은 한도 40% 이하 주황(warn), 10% 이하 빨강(crit). 설정 Account 게이지·
// 컨텍스트 팝오버·계정 드롭다운이 같은 경계를 쓴다. ''는 평상시 — 클래스 없이 그린다.
export function remainTone(left: number): '' | 'warn' | 'crit' {
  return left <= 10 ? 'crit' : left <= 40 ? 'warn' : ''
}

// "남음 5시간 63% · 주간 8%" 한 줄 — 맨숫자는 방향(남은량/소모량)을 못 말해줘 "남음"을
// 접두 한 번으로 밝힌다. 항목마다 붙이면 줄이 길어져 '주간'이 잘린다(플랜 접두 실측과
// 같은 제약). 잔량 톤에 걸린 항목만 색으로 도드라진다.
function usageLineNode(parts: { label: string; left: number }[]): ReactNode {
  return (
    <>
      {t('남음 ', 'Left ')}
      {parts.map((p, i) => {
        const tone = remainTone(p.left)
        const text = `${p.label} ${p.left}%`
        return (
          <Fragment key={p.label}>
            {i > 0 && ' · '}
            {tone ? <span className={tone}>{text}</span> : text}
          </Fragment>
        )
      })}
    </>
  )
}

// 계정 옵션의 잔여 한도 줄 — 앱 전체 관례(잔여 % = 100 − 사용률, 설정 → Account와 동일).
// 조회 못 한 항목은 조용히 빠진다(저장 토큰 만료 등 — 실행하면 CLI가 리프레시한다).
function acctUsageLine(u?: AccountUsage): ReactNode {
  if (!u) return null
  const parts: { label: string; left: number }[] = []
  if (u.fiveHourPct != null) parts.push({ label: t('5시간', '5h'), left: 100 - u.fiveHourPct })
  if (u.fablePct != null) parts.push({ label: 'Fable', left: 100 - u.fablePct })
  if (u.weeklyPct != null) parts.push({ label: t('주간', 'Weekly'), left: 100 - u.weeklyPct })
  if (!parts.length) return null
  return usageLineNode(parts)
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

// Codex(OpenAI) 계정 목록 — Anthropic과 같은 모듈 캐시 문법 (설정에서만 바뀌니 1분 TTL)
let cxAcctCache: { at: number; list: CodexAccountInfo[] } | null = null
let cxAcctInflight: Promise<CodexAccountInfo[]> | null = null
function fetchCodexAccounts(): Promise<CodexAccountInfo[]> {
  if (cxAcctCache && Date.now() - cxAcctCache.at < ACCT_TTL) return Promise.resolve(cxAcctCache.list)
  if (cxAcctInflight) return cxAcctInflight
  cxAcctInflight = window.api.codexAuth
    .listAccounts()
    .then((list: CodexAccountInfo[]) => {
      cxAcctCache = { at: Date.now(), list }
      cxAcctInflight = null
      return list
    })
    .catch(() => {
      cxAcctInflight = null
      return cxAcctCache?.list ?? []
    })
  return cxAcctInflight
}
// ChatGPT 플랜 표기 — 'plus' → 'ChatGPT Plus'
function chatgptPlanLabel(plan: string | null): string {
  return 'ChatGPT' + (plan ? ' ' + plan.charAt(0).toUpperCase() + plan.slice(1) : '')
}

// Codex(OpenAI) 계정별 잔여 한도 — Anthropic accountsUsage와 같은 모듈 캐시 문법.
// 계정마다 app-server를 한 번 띄워 조회하므로(무겁다) TTL을 나눠 쓴다.
let cxUsageCache: { at: number; map: Record<string, CodexAccountUsage> } | null = null
let cxUsageInflight: Promise<Record<string, CodexAccountUsage>> | null = null
function fetchCodexUsage(): Promise<Record<string, CodexAccountUsage>> {
  if (cxUsageCache && Date.now() - cxUsageCache.at < ACCT_TTL) return Promise.resolve(cxUsageCache.map)
  if (cxUsageInflight) return cxUsageInflight
  cxUsageInflight = window.api.codexAuth
    .accountsUsage()
    .then((us: CodexAccountUsage[]) => {
      const map = Object.fromEntries(us.map((u) => [u.email, u]))
      cxUsageCache = { at: Date.now(), map }
      cxUsageInflight = null
      return map
    })
    .catch(() => {
      cxUsageInflight = null
      return cxUsageCache?.map ?? {}
    })
  return cxUsageInflight
}
// Codex 계정 옵션의 잔여 한도 줄 — Anthropic acctUsageLine과 같은 관례(잔여 % = 100 − 사용률)
function cxUsageLine(u?: CodexAccountUsage): ReactNode {
  if (!u || !u.windows.length) return null
  return usageLineNode(u.windows.map((w) => ({ label: w.label, left: Math.max(0, 100 - Math.round(w.usedPct)) })))
}

// 지금 유효한 Codex 계정(바인딩 ?? 기본 계정)의 잔여 한도 — 컨텍스트 팝오버·스트립이
// Codex 엔진일 때 Anthropic 한도 행 대신 이걸 그린다. active=false면 조회하지 않는다.
function useCodexUsage(engine: EngineId | undefined, codexAccount: string | undefined, active: boolean): CodexAccountUsage | null {
  const [u, setU] = useState<CodexAccountUsage | null>(null)
  useEffect(() => {
    if (engine !== 'codex' || !active) return
    let on = true
    Promise.all([fetchCodexAccounts(), fetchCodexUsage()]).then(([accts, map]) => {
      if (!on) return
      const email = codexAccount ?? accts.find((a) => a.isDefault)?.email ?? accts[0]?.email
      setU(email ? (map[email] ?? null) : null)
    })
    return () => {
      on = false
    }
  }, [engine, codexAccount, active])
  return engine === 'codex' ? u : null
}

// ── 통합 picker 팝오버 (PoC 확정) ─────────────────────────────
// 컴포저의 칩 하나("Fable 5 · 매우 높음 · 자동 허용")로 연다:
// [Anthropic|OpenAI] 엔진 세그먼트 → 모델 목록(선택한 모델 아래로 추론 슬라이더가
// 슬라이드 오픈) → 모드 → 과금(구독/API) → 계정. 점/아이콘 없는 플레인 텍스트+체크.

// 추론 슬라이더 — 6단계 스냅 (최소~최대, EFFORTS.level 0~5)
function EffortSlide({ effort, onChange }: { effort: EffortId; onChange: (e: EffortId) => void }) {
  const cur = effortOpts().find((e) => e.id === effort) ?? effortOpts()[2]
  const pct = cur.level * 20
  const snap = (clientX: number, el: HTMLDivElement): void => {
    const r = el.getBoundingClientRect()
    const idx = Math.min(5, Math.max(0, Math.round(((clientX - r.left) / r.width) * 5)))
    const opt = effortOpts().find((x) => x.level === idx)
    if (opt && opt.id !== effort) onChange(opt.id)
  }
  return (
    <div className="eslide">
      <span className="elabel">{t('추론', 'Reasoning')}</span>
      <div className="etrack" onClick={(e) => snap(e.clientX, e.currentTarget)}>
        <i className="efill" style={{ width: pct + '%' }} />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className="etick" style={{ left: i * 20 + '%' }} />
        ))}
        <b className="eknob" style={{ left: pct + '%' }} />
      </div>
      <span className="ecur">{cur.v}</span>
    </div>
  )
}

function PPRow({ sel, main, sub, onClick }: { sel: boolean; main: string; sub?: ReactNode; onClick: () => void }) {
  return (
    <button className={'pp-row' + (sel ? ' sel' : '')} onClick={onClick}>
      <span className="pp-grow">
        {main}
        {sub && <span className="pp-sub">{sub}</span>}
      </span>
      {sel && (
        <span className="pp-check">
          <IconCheck size={12} stroke={2.4} />
        </span>
      )}
    </button>
  )
}

export function PickerChip({
  picker,
  setPicker,
  apiMode = false,
  apiReady = false,
  apiReadyCodex = false,
  engineLocked = false,
  onApiModeChange
}: {
  picker: PickerState
  setPicker: (p: PickerState) => void
  apiMode?: boolean
  apiReady?: boolean // Anthropic API 키 존재 여부
  apiReadyCodex?: boolean // OpenAI API 키 존재 여부 — Codex 엔진의 과금 섹션이 쓴다
  // 대화가 시작된 채팅은 엔진 전환 잠금 — 상대 엔진은 이 대화를 이어받을 수 없어서
  // (세션 resume 포맷이 서로 다름) 화면만 이어져 보이는 기억 상실이 된다. 모델·추론·
  // 모드·계정은 그대로 자유. /clear·폴더 변경으로 대화가 리셋되면 다시 풀린다.
  engineLocked?: boolean
  onApiModeChange?: (next: boolean, engine?: EngineId) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const engine: EngineId = picker.engine === 'codex' ? 'codex' : 'claude'
  const codexModels = useCodexModels(engine)
  const codexId = picker.codexModel ?? CODEX_DEFAULT_MODEL
  const codexOpt = codexModels.find((m) => m.id === codexId) ?? codexModels[0] ?? codexFallback()[0]
  const modelOpt = modelOpts().find((m) => m.id === picker.model) ?? modelOpts()[0]
  const effortOpt = effortOpts().find((e) => e.id === picker.effort) ?? effortOpts()[2]
  const modeOpt = modeOpts().find((m) => m.id === picker.mode) ?? modeFallback()

  // 계정 목록 — 마운트 시 한 번(캐시) + 팝오버를 열 때 갱신 (구독 실행에만 의미)
  const [accounts, setAccounts] = useState<AccountInfo[]>(() => acctCache?.list ?? [])
  const [aUsage, setAUsage] = useState<Record<string, AccountUsage>>(() => usageCache?.map ?? {})
  const [cxAccounts, setCxAccounts] = useState<CodexAccountInfo[]>(() => cxAcctCache?.list ?? [])
  const [cxUsage, setCxUsage] = useState<Record<string, CodexAccountUsage>>(() => cxUsageCache?.map ?? {})
  useEffect(() => {
    let on = true
    if (engine === 'claude') {
      fetchAccounts().then((l) => {
        if (on) setAccounts(l)
      })
      if (open)
        fetchAccountsUsage().then((m) => {
          if (on) setAUsage(m)
        })
    } else {
      fetchCodexAccounts().then((l) => {
        if (on) setCxAccounts(l)
      })
      if (open)
        fetchCodexUsage().then((m) => {
          if (on) setCxUsage(m)
        })
    }
    return () => {
      on = false
    }
  }, [open, engine])
  const defaultEmail = accounts.find((a) => a.isDefault)?.email
  const effective = picker.account ?? defaultEmail
  const cxDefaultEmail = cxAccounts.find((a) => a.isDefault)?.email
  const cxEffective = picker.codexAccount ?? cxDefaultEmail

  // 주간 한도를 다 쓴(잔여 0%) 계정은 목록에서 숨긴다 — 골라도 실행이 거부될 뿐이다.
  // 5시간 창 소진은 곧 풀리고 Fable 창 소진은 다른 모델로 쓸 수 있어 숨기지 않는다.
  // 단 지금 유효한 계정은 소진돼도 남긴다 — 선택 표시가 있어야 다른 계정으로 벗어난다.
  const usableAccounts = accounts.filter((a) => a.email === effective || (aUsage[a.email]?.weeklyPct ?? 0) < 100)
  const cxUsableAccounts = cxAccounts.filter((a) => {
    if (a.email === cxEffective) return true
    // 주간 창 판별은 라벨 규약('주간'/'Weekly') — Settings LimRow와 같은 방식
    const wk = cxUsage[a.email]?.windows.find((w) => w.label === '주간' || w.label === 'Weekly')
    return !wk || wk.usedPct < 100
  })

  // 칩 라벨 = 모델·추론·모드 + 계정. 계정은 항상 표시(기본 계정 포함) — API 모드면
  // 계정 대신 'API'. 계정 목록이 아직 안 왔으면(유효 계정 미상) 꼬리표를 생략한다.
  const modelLabel = engine === 'claude' ? modelOpt.v : codexOpt.v
  let extra = ''
  if (apiMode) {
    extra = ' · API'
  } else if (engine === 'claude') {
    if (effective) extra = ' · ' + effective.split('@')[0]
  } else if (cxEffective) {
    extra = ' · ' + cxEffective.split('@')[0]
  }
  const label = `${modelLabel} · ${effortOpt.v} · ${modeOpt.v}${extra}`

  return (
    <span className="cw" ref={ref}>
      {/* 네이티브 title 툴팁 없음 — 칩 라벨이 이미 내용을 다 말한다 (유저 결정) */}
      <button className={'model-chip' + (open ? ' on' : '')} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <div className="picker-pop scroll">
          {/* 엔진 세그먼트 — 영어 표기 (PoC). 대화가 시작되면 잠긴다 (prop 주석 참고) */}
          <div className="pprov">
            {engineOpts().map((en) => (
              <button
                key={en.id}
                className={engine === en.id ? 'on' : ''}
                disabled={engineLocked && engine !== en.id}
                onClick={() =>
                  setPicker({
                    ...picker,
                    engine: en.id === 'codex' ? 'codex' : undefined,
                    ...(en.id === 'codex' && !picker.codexModel ? { codexModel: CODEX_DEFAULT_MODEL } : {})
                  })
                }
              >
                {en.v}
              </button>
            ))}
          </div>
          {engineLocked && (
            <div className="pp-lock">{t('대화가 시작된 채팅은 엔진을 바꿀 수 없어요', "You can't switch engines once a chat has started")}</div>
          )}
          <div className="pp-h4">{t('모델', 'Model')}</div>
          {engine === 'claude'
            ? modelOpts().map((m) => (
                <Fragment key={m.id}>
                  <PPRow sel={m.id === picker.model} main={m.v} sub={m.d} onClick={() => setPicker({ ...picker, model: m.id })} />
                  <div className={'edrawer' + (m.id === picker.model ? ' open' : '')}>
                    {m.id === picker.model && (
                      <EffortSlide effort={picker.effort} onChange={(id) => setPicker({ ...picker, effort: id })} />
                    )}
                  </div>
                </Fragment>
              ))
            : codexModels.map((m) => (
                <Fragment key={m.id}>
                  <PPRow sel={m.id === codexId} main={m.v} sub={m.d} onClick={() => setPicker({ ...picker, codexModel: m.id })} />
                  <div className={'edrawer' + (m.id === codexId ? ' open' : '')}>
                    {m.id === codexId && (
                      <EffortSlide effort={picker.effort} onChange={(id) => setPicker({ ...picker, effort: id })} />
                    )}
                  </div>
                </Fragment>
              ))}
          <div className="pp-sep" />
          <div className="pp-h4">{t('모드', 'Mode')}</div>
          {modeOpts().map((m) => (
            <PPRow key={m.id} sel={m.id === picker.mode} main={m.v} sub={m.d} onClick={() => setPicker({ ...picker, mode: m.id })} />
          ))}
          {/* 과금 — 두 엔진 모두: API 모드면 Anthropic은 Anthropic 키, Codex는 OpenAI 키로 과금 */}
          {onApiModeChange && (
            <>
              <div className="pp-sep" />
              <div className="pp-h4">{t('과금', 'Billing')}</div>
              <PPRow
                sel={!apiMode}
                main={t('구독', 'Subscription')}
                sub={t(
                  (engine === 'codex' ? 'ChatGPT' : 'Claude') + ' 구독(정액)으로 실행',
                  'Run on your ' + (engine === 'codex' ? 'ChatGPT' : 'Claude') + ' subscription (flat rate)'
                )}
                onClick={() => onApiModeChange(false, engine)}
              />
              <PPRow
                sel={apiMode}
                main="API"
                sub={
                  (engine === 'codex' ? apiReadyCodex : apiReady)
                    ? t('저장된 API 키로 종량 과금', 'Pay per use with your saved API key')
                    : t('API 키 필요 — 설정 → API에서 등록', 'API key required — add one in Settings → API')
                }
                onClick={() => onApiModeChange(true, engine)}
              />
            </>
          )}
          {/* 계정 — 구독 실행에만 (API 모드는 키로 과금되니 계정 선택이 무의미) */}
          {engine === 'claude' && !apiMode && (usableAccounts.length > 0 || picker.account) && (
            <>
              <div className="pp-sep" />
              <div className="pp-h4">{t('계정', 'Account')}</div>
              {usableAccounts.map((a) => (
                <PPRow
                  key={a.email}
                  sel={a.email === effective}
                  main={a.email.split('@')[0]}
                  // 잔여 한도가 본문 — 플랜 접두를 붙이면 줄이 길어져 '주간'이 잘린다(실측).
                  // 한도가 아직 안 왔을 때만 플랜으로 대신한다.
                  sub={
                    acctUsageLine(aUsage[a.email]) ||
                    (a.subscriptionType
                      ? t(`${a.subscriptionType} 구독`, `${a.subscriptionType} subscription`)
                      : t('등록된 계정', 'Signed-in account'))
                  }
                  // 기본 계정을 고르면 바인딩을 푼다(기본을 따라감) — 다른 계정은 이 채팅에 고정
                  onClick={() => setPicker({ ...picker, account: a.isDefault ? undefined : a.email })}
                />
              ))}
            </>
          )}
          {/* OpenAI 계정 — Anthropic과 동일한 문법 (Codex 엔진 실행이 소비할 계정) */}
          {engine === 'codex' && !apiMode && (cxUsableAccounts.length > 0 || picker.codexAccount) && (
            <>
              <div className="pp-sep" />
              <div className="pp-h4">{t('계정', 'Account')}</div>
              {cxUsableAccounts.map((a) => (
                <PPRow
                  key={a.email}
                  sel={a.email === cxEffective}
                  main={a.email.split('@')[0]}
                  // Anthropic과 같은 문법 — 잔여 한도(5시간·주간)가 본문, 조회 전엔 플랜
                  sub={
                    cxUsageLine(cxUsage[a.email]) ||
                    t(chatgptPlanLabel(a.plan) + ' 구독', chatgptPlanLabel(a.plan) + ' subscription')
                  }
                  onClick={() => setPicker({ ...picker, codexAccount: a.isDefault ? undefined : a.email })}
                />
              ))}
            </>
          )}
        </div>
      )}
    </span>
  )
}

// the real context-window size for a model id (tokens) — falls back to the model's
// nominal window when the SDK hasn't reported one yet. Shared by the composer strip
// and the multi-agent panels' context gauge.
export function windowTokensFor(model: ModelId, contextWindow: number | null): number {
  const opt = modelOpts().find((m) => m.id === model) ?? modelOpts()[0]
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
// 추가 사용 크레딧 행 (작업 바 컨텍스트 팝오버) — claude.ai에서 켠 사용자에게만 행이
// 뜬다 (꺼져 있으면 잔액도 한도도 없어 보여줄 게 없다). 잔액이 소진된 상태(켰지만
// 0원)도 보여준다 — "다 떨어짐"이야말로 알아야 할 정보다.
export function extraCreditVisible(x: ExtraCreditInfo | null | undefined): x is ExtraCreditInfo {
  return !!x && (x.enabled || x.outOfCredits)
}
function resetText(resetsAt: number | null, useDays: boolean): string {
  if (resetsAt == null) return t('초기화 시간 미상', 'Reset time unknown')
  const rem = resetsAt - Math.floor(Date.now() / 1000)
  if (rem <= 0) return t('곧 초기화', 'Resets soon')
  const mins = Math.floor(rem / 60)
  let h = Math.floor(mins / 60)
  const m = mins % 60
  if (useDays && h >= 24) {
    const d = Math.floor(h / 24)
    h = h % 24
    return t(`${d}일 ${h}시간 후 초기화`, `Resets in ${d}d ${h}h`)
  }
  return h > 0 ? t(`${h}시간 ${m}분 후 초기화`, `Resets in ${h}h ${m}m`) : t(`${m}분 후 초기화`, `Resets in ${m}m`)
}

// WorkBar 컨텍스트 팝오버 행 (PoC .prow 문법) — 라벨+부제, 오른쪽 "남음 n%"(굵게),
// 행 아래 진행 바(bar)도 같은 남은 비율을 가리킨다. 부제는 목업의 절대시각 대신
// 실데이터의 초기화 남은 시간.
type CtxRow = { label: string; sub: string; end: ReactNode; bar: number | null; tone?: '' | 'warn' | 'crit' }
function limitRow(label: string, w: UsageWindow | null, useDays: boolean): CtxRow {
  const rem = w ? Math.max(0, 100 - Math.round(w.pct)) : null
  return {
    label,
    sub: w ? resetText(w.resetsAt, useDays) : t('데이터 없음', 'No data'),
    end:
      rem != null ? (
        <>
          <b>{rem}%</b> {t('남음', 'left')}
        </>
      ) : (
        '—'
      ),
    bar: rem,
    tone: rem != null ? remainTone(rem) : ''
  }
}
function extraCreditRow(x: ExtraCreditInfo): CtxRow {
  if (!x.enabled && x.outOfCredits)
    return {
      label: t('추가 크레딧', 'Extra credits'),
      sub: t('크레딧 소진 — claude.ai에서 충전해야 다시 쓸 수 있어요', 'Out of credits — top up at claude.ai to keep using them'),
      end: (
        <>
          <b>{fmtCredit(0, x.currency)}</b> {t('남음', 'left')}
        </>
      ),
      bar: 0,
      tone: 'crit'
    }
  const left = x.pct != null ? Math.max(0, 100 - Math.round(x.pct)) : null
  return {
    label: t('추가 크레딧', 'Extra credits'),
    sub: t(
      `이번 달 ${fmtCredit(x.used ?? 0, x.currency)} 사용${x.cap != null ? ` · 월 한도 ${fmtCredit(x.cap, x.currency)}` : ''}`,
      `${fmtCredit(x.used ?? 0, x.currency)} used this month${x.cap != null ? ` · ${fmtCredit(x.cap, x.currency)} monthly cap` : ''}`
    ),
    end:
      x.balance != null ? (
        <>
          <b>{fmtCredit(x.balance, x.currency)}</b> {t('남음', 'left')}
        </>
      ) : (
        '—'
      ),
    bar: left,
    tone: left != null ? remainTone(left) : ''
  }
}

type WorkTab = 'todo' | 'sub' | 'sh' | 'file' | 'ctx'

// 셸의 상태 문구 — stopped는 사유까지: 사용자가 누른 중지 / Claude(모델)가 끊음 /
// 턴이 끝나며 CLI가 같이 정리함은 다른 사건이다 (sleep이 완료된 걸로 오해하기 쉬운 지점).
// 인자 이름은 tk — i18n의 t()를 가리지 않게 (원래 t였다)
function bgStatusLabel(tk: BgTask): string {
  switch (tk.status) {
    case 'running':
      return t('실행 중', 'Running')
    case 'completed':
      return t('완료', 'Done')
    case 'failed':
      return t('실패', 'Failed')
    default:
      if (tk.byUser) return t('중지됨 — 직접 중지', 'Stopped — by you')
      if (tk.teardown) return t('턴 종료로 정리됨', 'Cleaned up when the turn ended')
      return t('중지됨 — Claude가 중지', 'Stopped — by Claude')
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

// 백그라운드 셸 한 줄 — PoC .prow: 상태 아이콘(스피너/✓/✕) + 설명/서브, 실행 중이면
// 끝에 중지 알약. 행을 누르면 출력(라이브 테일 포함) 카드가 열린다.
// prop 이름은 t 그대로, 안에서는 tk로 받는다 — i18n의 t()를 가리지 않게
function BgTaskRow({ t: tk, onOpen, onStop }: { t: BgTask; onOpen: (id: string) => void; onStop?: (id: string) => void }) {
  const running = tk.status === 'running'
  // 완료=흐림+초록 ✓ · 실패/직접 중지=빨간 ✕ · 턴 정리는 중립 회색 ✕ (사고 아님)
  const rowCls = tk.status === 'completed' ? ' done' : tk.status === 'failed' || (tk.status === 'stopped' && !tk.teardown) ? ' err' : ''
  return (
    <div className={'wb-prow act' + rowCls} onClick={() => onOpen(tk.id)}>
      <span className="ic">
        {running ? <span className="spin" /> : tk.status === 'completed' ? <IconCheck size={12} /> : <IconClose size={12} />}
      </span>
      <span className="grow">
        {tk.description || tk.id}
        <span className="sub">
          {bgStatusLabel(tk)}
          {/* 요약이 설명과 같은 문장으로 오는 경우(중지 통지)가 있어 중복이면 생략 */}
          {tk.status !== 'running' && tk.summary && tk.summary !== tk.description ? ` — ${tk.summary}` : ''}
        </span>
      </span>
      {running && onStop && (
        <button
          className="wb-stop"
          onClick={(e) => {
            e.stopPropagation()
            onStop(tk.id)
          }}
        >
          {t('중지', 'Stop')}
        </button>
      )}
    </div>
  )
}

// 셸 카드 상태 배지 — PoC .stbadge: 실행 중=중립+스피너, 완료=초록, 실패/중지=빨강,
// 턴 종료 정리는 중립(사고가 아니라 수명 종료)
// 인자 이름은 tk — i18n의 t()를 가리지 않게 (원래 t였다)
function bgBadge(tk: BgTask): ReactNode {
  if (tk.status === 'running')
    return (
      <span className="dc-badge n">
        <span className="spin" />
        {t('실행 중', 'Running')}
      </span>
    )
  if (tk.status === 'completed')
    return (
      <span className="dc-badge">
        <span className="d" />
        {t('완료', 'Done')}
      </span>
    )
  if (tk.status === 'failed')
    return (
      <span className="dc-badge err">
        <span className="d" />
        {t('실패', 'Failed')}
      </span>
    )
  return tk.teardown ? (
    <span className="dc-badge n">
      <span className="d" />
      {t('정리됨', 'Cleaned up')}
    </span>
  ) : (
    <span className="dc-badge err">
      <span className="d" />
      {t('중지됨', 'Stopped')}
    </span>
  )
}

// 백그라운드 셸 상세 카드 — PoC 상세 카드 문법(.dc-*): 터미널 타일 + 모노 명령 제목,
// 본문은 터미널(경로 스트립 + 라이브 테일). 실행 중이면 출력 파일(엔진이 유도한 경로)을
// 1.2초마다 다시 읽어 테일을 보여준다. readFile IPC는 절대경로를 그대로 받고, 파일이
// 아직 없으면 에러를 돌려줘 조용히 대기한다.
// prop 이름은 t 그대로, 안에서는 tk로 받는다 — i18n의 t()를 가리지 않게
function BgTaskModal({ t: tk, onStop, onClose }: { t: BgTask | null; onStop?: (id: string) => void; onClose: () => void }) {
  const [out, setOut] = useState<{ text: string | null; err: string | null }>({ text: null, err: null })
  // 본문(.dc-body)이 유일한 스크롤러 — 테일 따라가기도 이 엘리먼트를 내린다
  const bodyRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  // 마우스 제스처(U/D 스크롤·DR 닫기)의 대상 카드 엘리먼트
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const file = tk?.outputFile
  const running = tk?.status === 'running'
  useEffect(() => {
    if (!tk) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [tk, onClose])
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
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [out.text])
  if (!tk) return null
  const tail = out.text ? out.text.split('\n').slice(-400).join('\n').trimEnd() : ''
  const copyPath = (): void => {
    if (!file) return
    navigator.clipboard
      ?.writeText(file)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  return createPortal(
    <div className="sa-overlay" onMouseDown={onClose}>
      <div className="dc-card" ref={setCardEl} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dc-head">
          <div className="dc-tile">
            <IconTerminal size={19} />
          </div>
          <div className="dc-tt">
            <span className="dc-title mono">{tk.description || tk.id}</span>
            <div className="dc-sub">
              {t('백그라운드 셸', 'Background shell')} · {bgStatusLabel(tk)}
            </div>
          </div>
          {bgBadge(tk)}
          {running && onStop && (
            <button className="dc-stop" onClick={() => onStop(tk.id)}>
              {t('중지', 'Stop')}
            </button>
          )}
          <button className="dc-close" onClick={onClose} aria-label={t('닫기', 'Close')}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dc-body scroll" ref={bodyRef}>
          {!running && tk.summary && tk.summary !== tk.description && (
            <>
              <div className="dc-sec">
                <span>{t('요약', 'Summary')}</span>
                <i className="dc-ln" />
              </div>
              <div className="dc-box">
                <div className="dc-md">{tk.summary}</div>
              </div>
            </>
          )}
          <div className="dc-sec">
            <span>
              {t('출력', 'Output')}
              {running ? t(' — 실시간', ' — live') : ''}
            </span>
            <i className="dc-ln" />
          </div>
          <div className="dc-term">
            {file && (
              <div className="dc-term-head">
                <span className="pth" title={file}>
                  {file}
                </span>
                <button className={'dc-copy' + (copied ? ' on' : '')} onClick={copyPath}>
                  <IconCopy size={12} />
                  {copied ? t('복사됨 ✓', 'Copied ✓') : t('경로 복사', 'Copy path')}
                </button>
              </div>
            )}
            <div className="dc-term-body">
              {tail ? (
                <pre className="dc-term-pre">{tail}</pre>
              ) : (
                <div className="ag-none">
                  {running
                    ? t('아직 출력이 없어요 (쌓이는 대로 여기 보여요)', 'No output yet (it shows up here as it arrives)')
                    : t('출력 결과가 없어요', 'No output')}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="dc-foot">
          {/* 테일은 끝 400줄만 유지 — 캡에 닿았으면 전체가 아니라 끝부분임을 밝힌다 */}
          <span className="dc-stat">
            {t('출력', 'Output')}{' '}
            <b>
              {tail
                ? tail.split('\n').length >= 400
                  ? t('끝부분 400줄', 'last 400 lines')
                  : t(`${tail.split('\n').length}줄`, `${tail.split('\n').length} lines`)
                : t('0줄', '0 lines')}
            </b>
          </span>
          {running && <span className="dc-stat">{t('하단 따라가는 중', 'Following the tail')}</span>}
        </div>
      </div>
      {/* 우클릭 드래그 제스처 — 뷰어와 같은 문법. 스크롤러는 본문(.dc-body) 하나 */}
      <MouseGestureLayer
        target={cardEl}
        actions={[
          ...scrollGestures(() => cardEl?.querySelector('.dc-body')),
          { pattern: 'DR', label: t('카드 닫기', 'Close card'), run: onClose }
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
  tokenTotals = {},
  busy = false,
  canSkipWait = false,
  engine,
  codexAccount,
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
  tokenTotals?: Record<string, TokenTally> // 이 대화의 모델별 실측 토큰 누적 (팝오버 맨 아래 행)
  busy?: boolean // 실행 중 여부
  canSkipWait?: boolean // 막고 있는 포그라운드 Bash가 있는지 — 건너뛰기 버튼은 이때만 노출
  engine?: EngineId // 'codex'면 컨텍스트 팝오버가 Anthropic 한도 대신 OpenAI 한도를 그린다
  codexAccount?: string // Codex 실행 계정 바인딩 — 없으면 기본 계정 기준
  onOpenFile: (f: ChangedFile) => void
  onOpenSubagent: (a: SubAgentInfo) => void
  onBgTask?: (req: BgTaskRequest) => void // 셸 중지 / 포그라운드 도구 백그라운드화
  onRefreshUsage?: () => void // 컨텍스트 팝오버를 열 때 사용량 강제 새로고침
}) {
  useLang() // memo 컴포넌트 — 언어 전환에 재렌더로 반응하도록 구독
  const [open, setOpen] = useState<WorkTab | null>(null)
  // 셸 행 클릭 → 출력 카드. id로 들고 있어야 라이브 갱신(REPLACE·정착 통지)이 카드에 흐른다.
  const [openBgId, setOpenBgId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // 팝오버 가로 배치 — "클릭한 칩 왼쪽 정렬 + 바 범위 클램프"를 페인트 전에 인라인으로.
  // CSS만으론 못 한다: 멀티 패널은 좁은 패널 클리핑 방지로 앵커가 칩이 아니라 바 전체라
  // (.wb-cell{position:static}) left:0이 "바 왼쪽 끝"이 돼, 넓은 패널에서 오른쪽 칩을
  // 눌러도 팝오버가 왼쪽 끝에 떴다. 단일 모드(앵커=칩)에서도 같은 식이 성립해 공통 적용
  // — 클램프 덕에 오른쪽 끝 칩(.r의 right:0)과 같은 착지가 된다. 배율(zoom .9) 보정 포함.
  useLayoutEffect(() => {
    const pop = popRef.current
    const bar = ref.current
    const parent = pop?.offsetParent as HTMLElement | null
    if (!open || !pop || !bar || !parent) return
    const cell = pop.parentElement as HTMLElement // .wb-cell (칩의 셀)
    const parentRect = parent.getBoundingClientRect()
    const barRect = bar.getBoundingClientRect()
    // getBoundingClientRect는 시각(배율 적용) px, style.left는 로컬 CSS px — 배율로 환산
    const scale = parent.offsetWidth ? parentRect.width / parent.offsetWidth : 1
    const want = cell.getBoundingClientRect().left - parentRect.left
    const min = barRect.left - parentRect.left
    const max = barRect.right - parentRect.left - pop.getBoundingClientRect().width
    pop.style.left = `${Math.max(min, Math.min(want, max)) / scale}px`
    pop.style.right = 'auto'
  }, [open])

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

  // 컨텍스트 팝오버 — PoC 문법 그대로: 헤더 오른쪽에 토큰 수, 행 아래 4px 진행 바,
  // 첫 행(현재 컨텍스트) 뒤 구분선. 현재 컨텍스트 바는 사용분, 한도 바는 남은 비율 —
  // 오른쪽 "남음 n%" 텍스트와 바가 같은 것을 가리키게. API 모드는 한도가 의미 없으니
  // 비용 행으로 바꾼다(이번 대화 비용 + 남은 예산/누적 사용액 — 진행 바는 예산 행만).
  const ctxDetail = t(
    `${contextTokens != null ? fmtTok(contextTokens) : 0} / ${fmtWindow(Math.round(winTokens / 1000))} 토큰`,
    `${contextTokens != null ? fmtTok(contextTokens) : 0} / ${fmtWindow(Math.round(winTokens / 1000))} tokens`
  )
  // Codex 엔진이면 Anthropic 한도(5시간·Fable·주간) 대신 이 계정의 OpenAI 한도를 그린다.
  // 조회는 팝오버가 열렸을 때만 (계정마다 app-server 1회 — 무거운 조회)
  const cxU = useCodexUsage(engine, codexAccount, open === 'ctx')
  const ctxRows: CtxRow[] = [
    {
      label: t('현재 컨텍스트', 'Current context'),
      sub: t('이 대화가 차지하는 컨텍스트 창', 'How much of the context window this chat takes'),
      end: <b>{ctxPct}%</b>,
      bar: ctxPct
    },
    ...(engine === 'codex'
      ? apiMode
        ? [
            {
              label: t('API 과금', 'API billing'),
              sub: t(
                'Codex는 실행 비용을 보고하지 않아요 — 사용액은 platform.openai.com에서',
                'Codex does not report run costs — check your spend at platform.openai.com'
              ),
              end: <b>—</b>,
              bar: null
            }
          ]
        : (cxU?.windows ?? []).map((w) => {
            const rem = Math.max(0, 100 - Math.round(w.usedPct))
            return {
              label: t(`${w.label} 한도`, `${w.label} limit`),
              sub: t('ChatGPT 구독 사용량 기준', 'Based on ChatGPT subscription usage'),
              end: (
                <>
                  <b>{rem}%</b> {t('남음', 'left')}
                </>
              ),
              bar: rem,
              tone: remainTone(rem)
            }
          })
      : apiMode
        ? [
            {
              label: t('이번 대화 비용', 'This chat’s cost'),
              sub: t('API 모드 실행의 누적 비용', 'Total cost of API-mode runs'),
              end: <b>{fmtUsd(chatSpentUsd)}</b>,
              bar: null
            },
            budgetUsd != null
              ? (() => {
                  const left = Math.max(0, 100 - Math.round((totalSpentUsd / budgetUsd) * 100))
                  return {
                    label: t('남은 예산', 'Budget left'),
                    sub: t(
                      `예산 ${fmtUsd(budgetUsd)} 중 ${fmtUsd(totalSpentUsd)} 사용`,
                      `${fmtUsd(totalSpentUsd)} of the ${fmtUsd(budgetUsd)} budget used`
                    ),
                    end: (
                      <>
                        <b>{fmtUsd(Math.max(0, budgetUsd - totalSpentUsd))}</b> {t('남음', 'left')}
                      </>
                    ),
                    bar: left,
                    tone: remainTone(left)
                  }
                })()
              : {
                  label: t('누적 사용액', 'Total spend'),
                  sub: t('전체 워크스페이스 · 설정 → API에서 예산 입력 가능', 'All workspaces · set a budget in Settings → API'),
                  end: <b>{fmtUsd(totalSpentUsd)}</b>,
                  bar: null
                }
          ]
        : [
            limitRow(t('5시간 한도', '5h limit'), usage.fiveHour, false),
            // Fable 5 전용 주간 한도 — 플랜에 없으면(null) 행 자체를 숨긴다 (행 순서는 PoC와 동일)
            ...(usage.weeklyFable ? [limitRow(t('Fable 주간 한도', 'Fable weekly limit'), usage.weeklyFable, true)] : []),
            limitRow(t('주간 한도', 'Weekly limit'), usage.weekly, true),
            // 추가 사용 크레딧 (claude.ai 설정 → 사용 크레딧) — 켜져 있거나 소진 상태일 때만
            ...(extraCreditVisible(usage.extraCredit) ? [extraCreditRow(usage.extraCredit)] : [])
          ])
  ]
  // 이번 대화가 지금까지 소모한 실측 토큰(모델별 누적) — 팝오버 맨 아래 참고 섹션.
  // 한도 차감은 모델 단가·캐시 가중이라 이 수치와 정비례하지 않는다: '사용 토큰' 실측만
  // 말하고 한도 환산을 주장하지 않는다. 캐시는 읽기+쓰기 합산 한 칸. 아직 보고가 없는
  // 새 대화도 0으로 항상 보여준다(행이 생겼다 없어졌다 하지 않게) — 모델별 내역 행만
  // 실제 보고가 쌓인 뒤(2개 모델 이상) 붙는다.
  // 인자 이름은 tk — i18n의 t()를 가리지 않게 (원래 t였다)
  const tokBk = (tk: TokenTally): string =>
    t(
      `입력 ${fmtTok(tk.inTok)} · 출력 ${fmtTok(tk.outTok)} · 캐시 ${fmtTok(tk.cacheRead + tk.cacheWrite)}`,
      `In ${fmtTok(tk.inTok)} · Out ${fmtTok(tk.outTok)} · Cache ${fmtTok(tk.cacheRead + tk.cacheWrite)}`
    )
  const tokEntries = Object.entries(tokenTotals)
    .map(([m, t]) => ({ model: m, tally: t, total: t.inTok + t.outTok + t.cacheRead + t.cacheWrite }))
    .filter((t) => t.total > 0)
    .sort((a, b) => b.total - a.total)
  const tokGrand: TokenTally = tokEntries.reduce(
    (s, t) => ({ inTok: s.inTok + t.tally.inTok, outTok: s.outTok + t.tally.outTok, cacheRead: s.cacheRead + t.tally.cacheRead, cacheWrite: s.cacheWrite + t.tally.cacheWrite }),
    { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 }
  )
  const tokRows: CtxRow[] = [
    {
      // 대화 팝오버 안이라 '이번 대화' 수식은 군더더기 — 스코프는 위치가 이미 말한다
      label: t('토큰 사용량', 'Token usage'),
      // 모델이 하나면 헤더 한 줄로 끝낸다(내역 행과 완전히 겹치므로) — 모델명을 부제에
      sub: tokEntries.length === 1 ? `${tokEntries[0].model} · ${tokBk(tokEntries[0].tally)}` : tokBk(tokGrand),
      end: <b>{fmtTok(tokEntries.reduce((n, t) => n + t.total, 0))}</b>,
      bar: null
    },
    ...(tokEntries.length > 1 ? tokEntries.map((t) => ({ label: t.model, sub: tokBk(t.tally), end: <>{fmtTok(t.total)}</> as ReactNode, bar: null })) : [])
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
    { key: 'todo', icon: <IconList size={14} />, label: t('할 일', 'To-dos'), value: `${todoDone}/${todoTotal || 0}`, detail: todoTotal ? t(`${todoPct}% 완료`, `${todoPct}% done`) : t('없음', 'None'), tip: t('Claude가 세운 작업 계획 — 누르면 할 일 목록', 'The task plan Claude made — click for the to-do list') },
    { key: 'sub', icon: <IconBot size={14} />, label: t('서브에이전트', 'Subagents'), value: `${doneSub}/${subTotal || 0}`, detail: runningSub > 0 ? t(`${runningSub}개 실행 중`, `${runningSub} running`) : subTotal ? t('모두 완료', 'All done') : t('없음', 'None'), tip: t('Claude가 띄운 보조 에이전트의 진행 상황 — 누르면 목록', 'Progress of the helper agents Claude spawned — click for the list') },
    { key: 'sh', icon: <IconTerminal size={14} />, label: t('백그라운드 셸', 'Background shells'), value: `${endedBg}/${bgTasks.length || 0}`, detail: runningBg > 0 ? t(`${runningBg}개 실행 중`, `${runningBg} running`) : bgTasks.length ? t('모두 종료', 'All ended') : t('없음', 'None'), tip: t('Claude가 백그라운드로 돌리는 셸 — 누르면 목록·중지', 'Shells Claude runs in the background — click to view or stop') },
    { key: 'file', icon: <IconFile size={14} />, label: t('변경된 파일', 'Changed files'), value: `${files.length}`, detail: files.length ? `+${totalAdd} −${totalDel}` : t('없음', 'None'), tip: t('이번 작업에서 생성·수정된 파일 — 누르면 목록·diff', 'Files created or edited in this run — click for the list and diffs') },
    { key: 'ctx', ring: ctxPct, label: t('컨텍스트', 'Context'), value: `${ctxPct}%`, detail: ctxDetail, tip: apiMode ? t('대화의 컨텍스트 사용량·API 비용 — 누르면 자세히', 'Context use and API cost for this chat — click for details') : t('대화의 컨텍스트 사용량·사용 한도 — 누르면 자세히', 'Context use and rate limits for this chat — click for details'), align: 'r' }
  ]

  const popBody = (key: WorkTab): ReactNode => {
    if (key === 'todo')
      return (
        <>
          <div className="wb-pop-h">
            <span className="t">{t('할 일', 'To-dos')}</span>
            <span className="c">
              {todoDone}/{todoTotal || 0}
              {todoTotal ? t(` · ${todoPct}% 완료`, ` · ${todoPct}% done`) : ''}
            </span>
          </div>
          {/* 실행 중이어도 "계획 수립 중"이라고 추측하지 않는다 — 간단한 작업은 할 일
              목록을 아예 만들지 않으므로, 없으면 그냥 없다고 말하는 게 정직하다 */}
          {todoTotal ? <Todos todos={todos} /> : <div className="ag-none">{t('아직 할 일이 없어요', 'No to-dos yet')}</div>}
        </>
      )
    if (key === 'sub')
      return (
        <>
          <div className="wb-pop-h">
            <span className="t">{t('서브에이전트', 'Subagents')}</span>
            <span className="c">
              {runningSub > 0 ? t(runningSub + ' 실행 중', runningSub + ' running') : doneSub + '/' + (subTotal || 0)}
            </span>
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
            <div className="ag-none">{t('아직 서브에이전트가 없어요', 'No subagents yet')}</div>
          )}
        </>
      )
    if (key === 'sh')
      return (
        <>
          <div className="wb-pop-h">
            <span className="t">{t('백그라운드 셸', 'Background shells')}</span>
            <span className="c">
              {runningBg > 0 ? t(runningBg + ' 실행 중', runningBg + ' running') : `${endedBg}/${bgTasks.length || 0}`}
            </span>
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
            <div className="ag-none">{t('아직 백그라운드 셸이 없어요', 'No background shells yet')}</div>
          )}
          {/* 터미널 Ctrl+B 패리티 — 지금 막고 있는 포그라운드 Bash(빌드 등)를 백그라운드로
              보내고 턴을 계속 진행시킨다. 건너뛸 명령이 실제로 있을 때만 보여준다. */}
          {busy && canSkipWait && onBgTask && (
            <button
              className="wb-bg-all has-tip tip-wrap"
              data-tip={t(
                '막고 있는 포그라운드 명령을 백그라운드로 보내고 Claude가 다음 작업을 계속하게 합니다 (터미널의 Ctrl+B)',
                'Send the blocking foreground command to the background so Claude can keep going (Ctrl+B in the terminal)'
              )}
              onClick={() => onBgTask({ action: 'background' })}
            >
              {t('기다리는 명령 건너뛰고 계속하기', 'Skip the waiting command and continue')}
            </button>
          )}
        </>
      )
    if (key === 'file')
      return (
        <>
          <div className="wb-pop-h">
            <span className="t">{t('변경된 파일', 'Changed files')}</span>
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
            <div className="ag-none">{t('아직 변경된 파일이 없어요', 'No changed files yet')}</div>
          )}
        </>
      )
    return (
      <>
        <div className="wb-pop-h">
          <span className="t">{t('컨텍스트', 'Context')}</span>
          <span className="c">{ctxDetail}</span>
        </div>
        {ctxRows.map((r, i) => (
          <Fragment key={i}>
            <div className={'wb-prow' + (r.tone ? ' ' + r.tone : '')}>
              <span className="grow">
                {r.label}
                <span className="sub">{r.sub}</span>
              </span>
              <span className="end">{r.end}</span>
            </div>
            {r.bar != null && (
              <div className={'wb-pbar' + (r.tone ? ' ' + r.tone : '')}>
                <i style={{ width: r.bar + '%' }} />
              </div>
            )}
            {i === 0 && <div className="wb-psep" />}
          </Fragment>
        ))}
        {/* 토큰 사용량(대화 누적) — 맨 아래 참고 섹션 (엔진·API 모드 불문 실측, 새 대화는 0) */}
        <div className="wb-psep" />
        {tokRows.map((r, i) => (
          <div className="wb-prow" key={'tok' + i}>
            <span className="grow">
              {r.label}
              <span className="sub">{r.sub}</span>
            </span>
            <span className="end">{r.end}</span>
          </div>
        ))}
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
                // PoC 컨텍스트 칩 링 — 둘레 31.4(r=5)의 얇은 스트로크, dashoffset으로 사용분만큼 채움
                <svg className="ring" viewBox="0 0 13 13">
                  <circle className="bgc" cx="6.5" cy="6.5" r="5" fill="none" strokeWidth="1.8" />
                  <circle
                    className="fgc"
                    cx="6.5"
                    cy="6.5"
                    r="5"
                    fill="none"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    style={{ strokeDashoffset: 31.4 * (1 - c.ring / 100) }}
                  />
                </svg>
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
            {open === c.key && <div ref={popRef} className={'wb-pop' + (c.align === 'r' ? ' r' : '')}>{popBody(c.key)}</div>}
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

// The agent's AskUserQuestion — PoC 'Claude의 질문' 카드(qcard 문법): 마스코트 헤더,
// 한 번에 한 질문(방향 슬라이드·이전 질문), 플랫 선택지 + 인라인 직접 입력. 숫자 키로
// 선택, Esc는 내려두기(알약), 알약의 ✕가 건너뛰기 (agent uses defaults).
export function QuestionModal({
  question,
  onAnswer,
  onDismiss,
  hotkeys = true,
  onExpand
}: {
  question: { requestId: string; questions: AgentQuestion[]; engine?: EngineId } | null
  onAnswer: (answers: string[][]) => void
  onDismiss: () => void
  // 멀티 패널 — 카드가 여러 패널에 동시에 떠 있어도 키보드(숫자·화살표·Esc)는
  // 포커스된 패널의 카드만 받는다. 단일 채팅은 기본 true.
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
      engine={question.engine}
      onAnswer={onAnswer}
      onDismiss={onDismiss}
      hotkeys={hotkeys}
      onExpand={onExpand}
    />
  )
}

// the three permission choices — flat qcard options picked with the 1·2·3 keys.
// 표시 문자열이 있어 모듈 상수로 두면 언어가 박제된다 — 렌더 때 평가되게 함수로.
function permChoices(): { key: 'allow' | 'allow_always' | 'deny'; label: string; desc: string }[] {
  return [
    { key: 'allow', label: t('허용', 'Allow'), desc: t('이번 한 번만 실행을 허용해요', 'Allow this action just once') },
    {
      key: 'allow_always',
      label: t('항상 허용', 'Always allow'),
      desc: t('이번 세션 동안 이 도구를 자동 허용해요', 'Auto-allow this tool for the rest of the session')
    },
    { key: 'deny', label: t('거부', 'Deny'), desc: t('이 작업을 실행하지 않아요', 'Do not run this action') }
  ]
}

// The agent's tool-permission request — 질문 카드와 같은 qcard 문법: 마스코트 헤더
// ('Claude/GPT의 승인 요청' + 도구 칩) + 볼드 질문 + 모노 명령 웰 + 플랫 선택지.
// Keys 1·2·3 pick; Esc denies. 선택지는 누르는 즉시 응답한다(단일 선택 질문과 동일).
export function PermissionModal({
  permission,
  onRespond,
  hotkeys = true
}: {
  permission: { requestId: string; toolName: string; summary: string; engine?: EngineId } | null
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
      const choices = permChoices()
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
        e.preventDefault()
        onRespond(choices[n - 1].key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [permission, onRespond, hotkeys])

  if (!permission) return null
  return (
    <div className="q-overlay">
      <div className="qcard scroll" role="dialog" aria-modal="true">
        <div className="qhead">
          <IconMascot size={17} />
          <span className="qhl">
            {permission.engine === 'codex'
              ? t('GPT의 승인 요청', 'GPT’s permission request')
              : t('Claude의 승인 요청', 'Claude’s permission request')}
          </span>
          <span className="qsp" />
          {permission.toolName && <span className="qtool">{permission.toolName}</span>}
        </div>
        <div className="qwrap">
          <div className="qbt">{t('이 작업을 실행할까요?', 'Run this action?')}</div>
          {permission.summary && <div className="qsum">{permission.summary}</div>}
          <div className="qopts">
            {permChoices().map((c) => (
              <button key={c.key} className={'qopt' + (c.key === 'deny' ? ' qopt-deny' : '')} onClick={() => onRespond(c.key)}>
                <span className="ql">{c.label}</span>
                <span className="qd">{c.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function QuestionDialog({
  questions,
  engine,
  onAnswer,
  onDismiss,
  hotkeys = true,
  onExpand
}: {
  questions: AgentQuestion[]
  engine?: EngineId // 질문을 던진 엔진 — 헤더 표기('Claude의 질문'/'GPT의 질문')
  onAnswer: (answers: string[][]) => void
  onDismiss: () => void
  hotkeys?: boolean
  onExpand?: () => void
}) {
  const [sel, setSel] = useState<string[][]>(() => questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => '')) // 직접 입력 free text
  // 단일 선택에서 직접 입력을 답으로 확정(Enter)했는지 — 뒤로 왔을 때 입력줄 체크 복원용.
  // 다중 선택은 확정 절차가 없다: 입력이 비어있지 않으면 그 자체로 답에 포함된다.
  const [other, setOther] = useState<boolean[]>(() => questions.map(() => false))
  const [step, setStep] = useState(0)
  // 질문 전환 방향 — qwrap 슬라이드(qstep 앞으로/qstep-b 뒤로). 첫 등장은 카드 rise에
  // 맡기고(null), 접기/펼치기 리마운트 때 재생되지 않게 그때도 null로 되돌린다.
  const [dir, setDir] = useState<'fwd' | 'back' | null>(null)
  // 잠깐 내려두기 — 답을 잃지 않고 하단 알약으로 접어, 뒤 대화를 확인한 뒤 다시 펼쳐
  // 답한다. QuestionModal이 requestId로 키를 걸어, 새 질문이 오면 펼친 상태로 다시 뜬다.
  const [minimized, setMinimizedRaw] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const freeRef = useRef<HTMLInputElement>(null)
  const multi = questions.length > 1
  const cur = questions[step]
  const last = step === questions.length - 1

  const setMinimized = (v: boolean): void => {
    setDir(null)
    setMinimizedRaw(v)
  }
  const goTo = (next: number, d: 'fwd' | 'back'): void => {
    setDir(d)
    setStep(next)
  }

  // a question's resolved answer: multi-select = checked options + the free text when
  // filled; single-select = the confirmed free text, or the picked option.
  const answerAt = (i: number, s = sel, c = custom, o = other): string[] => {
    const free = c[i].trim()
    if (questions[i].multiSelect) return free ? [...s[i], free] : s[i]
    return o[i] ? (free ? [free] : []) : s[i]
  }
  const finalAnswers = (s = sel, c = custom, o = other): string[][] => questions.map((_, i) => answerAt(i, s, c, o))
  const curChosen = answerAt(step).length > 0
  const allAnswered = questions.every((_, i) => answerAt(i).length > 0)
  // 직접 입력 줄의 선택 표시 — 내용이 있고, 단일 선택이라면 Enter로 확정까지 된 상태
  const freeOn = custom[step].trim().length > 0 && (cur.multiSelect || other[step])

  // pick a listed option. Single-select clears the 직접 입력 확정 and auto-advances (or
  // submits on the last question); multi-select toggles and waits for the 다음/완료 button.
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
      else goTo(step + 1, 'fwd')
    }
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
    } else goTo(step + 1, 'fwd')
  }
  // Enter in the 직접 입력 row — 단일 선택은 입력한 텍스트를 답으로 확정하고 진행,
  // 다중 선택은 입력이 이미 답에 포함되므로 그냥 다음/완료로 진행한다.
  const pickFree = (): void => {
    if (cur.multiSelect) {
      proceed()
      return
    }
    if (!custom[step].trim()) return
    const nextOther = other.slice()
    nextOther[step] = true
    setOther(nextOther)
    const nextSel = sel.map((a) => a.slice())
    nextSel[step] = []
    setSel(nextSel)
    if (last) onAnswer(finalAnswers(nextSel, custom, nextOther))
    else goTo(step + 1, 'fwd')
  }

  // focus the modal on open AND whenever it's restored from the pill, so the composer
  // textarea behind it doesn't swallow the number-key shortcuts. hotkeys가 없는(포커스
  // 안 된 패널) 카드는 포커스를 훔치지 않는다 — 다른 패널에서 입력 중일 수 있다.
  useEffect(() => {
    if (!minimized && hotkeys) modalRef.current?.focus()
  }, [minimized, hotkeys])

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
        if (step > 0) goTo(step - 1, 'back')
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        if (step < questions.length - 1) goTo(step + 1, 'fwd')
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
        // 마지막 번호 = 직접 입력 줄 — 포커스만 옮긴다 (답은 Enter로 확정)
        e.preventDefault()
        freeRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel, custom, other, step, onDismiss, minimized, hotkeys])

  // 내려둔 상태 — q-overlay 대신 하단 중앙 알약(PoC qmini)으로 접어 뒤 대화를 그대로
  // 보며 스크롤할 수 있게 한다. 클릭이면 다시 질문이 뜨고, ✕는 건너뛰기.
  if (minimized) {
    return (
      <div className="q-mini" onClick={() => setMinimized(false)}>
        <IconMascot size={15} />
        <span className="qmt">
          {multi
            ? t(`질문 ${questions.length}개 대기 중 — 클릭해서 답하기`, `${questions.length} questions waiting — click to answer`)
            : t('질문 대기 중 — 클릭해서 답하기', 'A question is waiting — click to answer')}
        </span>
        <button
          className="qmx has-tip"
          data-tip={t('건너뛰기', 'Skip')}
          aria-label={t('건너뛰기', 'Skip')}
          onClick={(e) => {
            e.stopPropagation()
            onDismiss()
          }}
        >
          <IconClose size={13} />
        </button>
      </div>
    )
  }

  return (
    // The agent is blocked waiting on this answer, so — unlike the other modals — a
    // backdrop click does NOT dismiss it (too easy to lose the prompt by accident).
    // 건너뛰기는 내려두기(⌄·Esc) 뒤 알약의 ✕ — PoC 문법대로 헤더에는 접기만 남긴다.
    <div className="q-overlay">
      <div className="qcard scroll" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true">
        <div className="qhead">
          <IconMascot size={17} />
          <span className="qhl">{engine === 'codex' ? t('GPT의 질문', 'GPT’s question') : t('Claude의 질문', 'Claude’s question')}</span>
          <span className="qsp" />
          {/* 좁은 패널에서만 제공 — 패널 확장으로 넘어가면 카드가 리마운트돼 지금까지의
              선택이 초기화되므로, 답을 고르기 전에 누르는 걸 상정한다 */}
          {onExpand && (
            <button className="qmin has-tip" onClick={onExpand} aria-label={t('크게 보기', 'Expand')} data-tip={t('크게 보기', 'Expand')}>
              <IconExpand size={14} />
            </button>
          )}
          <button
            className="qmin has-tip"
            onClick={() => setMinimized(true)}
            aria-label={t('접어두기', 'Collapse')}
            data-tip={t('접어두기 (Esc)', 'Collapse (Esc)')}
          >
            <IconChevDown size={15} />
          </button>
        </div>

        {/* 한 번에 한 질문 — key=step 리마운트로 방향 슬라이드가 재생된다 */}
        <div key={step} className={'qwrap' + (dir === 'fwd' ? ' qstep' : dir === 'back' ? ' qstep-b' : '')}>
          <div className="qbl">
            <span>{t(`질문 ${step + 1}/${questions.length}`, `Question ${step + 1}/${questions.length}`)}</span>
            <span className="qsp" />
            {step > 0 && (
              <button className="qback" onClick={() => goTo(step - 1, 'back')}>
                <IconChevLeft size={11} />
                {t('이전 질문', 'Previous question')}
              </button>
            )}
          </div>
          <div className="qbt">{cur.question}</div>
          <div className="qopts">
            {cur.options.map((o, oi) => {
              const on = sel[step].includes(o.label)
              return (
                <button key={oi} className={'qopt' + (on ? ' on' : '')} onClick={() => choose(o.label)}>
                  <span className="ql">{o.label}</span>
                  {o.description && <span className="qd">{o.description}</span>}
                  <span className="qck">
                    <IconCheck size={13} />
                  </span>
                </button>
              )
            })}
            {/* 직접 입력 — 항상 마지막 줄의 인라인 입력 (PoC qopt-free). Enter로 답한다 */}
            <div className={'qopt qopt-free' + (freeOn ? ' on' : '')} onClick={() => freeRef.current?.focus()}>
              <input
                ref={freeRef}
                placeholder={t('원하는 답을 직접 입력… (Enter)', 'Type your own answer… (Enter)')}
                value={custom[step]}
                onChange={(e) => setCustomAt(step, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    pickFree()
                  }
                }}
              />
              <span className="qck">
                <IconCheck size={13} />
              </span>
            </div>
          </div>
          {/* 다중 선택만 진행 버튼이 필요하다 — 단일 선택은 고르는 즉시 넘어간다 */}
          {cur.multiSelect && (
            <div className="qfoot">
              <span className="qhint">{t('여러 개 선택 가능', 'You can pick more than one')}</span>
              <button className="qgo" disabled={!curChosen} onClick={proceed}>
                {last ? t('완료', 'Done') : t('다음', 'Next')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── 워크플로 도크 — 상주 워크플로의 알약(q-mini 문법) ↔ 펼침 카드(qcard 문법) ──
   running인 워크플로만 뜬다. 여러 개가 동시에 돌면 하단 중앙 도크에 알약이 가로로
   늘어서고, 클릭한 알약만 카드로 펼친다(카드 헤더의 번호 탭으로 다른 워크플로 전환).
   정착하면 그 알약이 사라지고 흔적+정리 턴이 대화에 남는다.
   카드는 CLI /workflows와 같은 2열(단계 레일 클릭 전환 + 그 단계의 에이전트 행) 구조. */
export function WorkflowDock({ wfs, onStop }: { wfs: WorkflowState[]; onStop?: (id: string) => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const running = wfs.filter((w) => w.status === 'running')
  // 펼쳐둔 워크플로가 정착해 사라지면 카드도 자연히 접힌다 (openId만 남고 대상 없음)
  const openWf = openId ? (running.find((w) => w.id === openId) ?? null) : null
  const cardOpen = !!openWf
  // Esc = 내려두기 (질문 카드의 Esc=접기와 같은 기대). 캡처 단계에서 삼켜야 각 표면의
  // Esc=실행취소 핸들러(App·멀티·세션 창)가 같은 키로 워크플로를 죽이지 않는다.
  useEffect(() => {
    if (!cardOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      setOpenId(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cardOpen])
  if (!running.length) return null

  if (openWf) {
    return (
      <WorkflowCard
        key={openWf.id}
        wf={openWf}
        peers={running}
        onSwitch={setOpenId}
        onMin={() => setOpenId(null)}
        onStop={onStop ? () => onStop(openWf.id) : undefined}
      />
    )
  }

  return (
    <div className="wf-dock">
      {running.map((w) => {
        const doneAll = w.agents.filter((a) => a.state === 'done').length
        const phases = [...w.phases].sort((a, b) => a.index - b.index)
        // 진행 단계 = 아직 안 끝난 에이전트가 있는 가장 앞 단계 (전부 끝났으면 마지막 = 정리 중)
        const curPhase =
          phases.find((p) => w.agents.some((a) => a.phase === p.index && a.state !== 'done'))?.index ??
          phases[phases.length - 1]?.index ??
          1
        return (
          <div
            key={w.id}
            className="wf-mini has-tip tip-wrap"
            onClick={() => setOpenId(w.id)}
            role="button"
            data-tip={w.summary || t('워크플로 카드 펼치기', 'Expand workflow card')}
            aria-label={t('워크플로 카드 펼치기', 'Expand workflow card')}
          >
            <span className="st run" />
            <span className="wt">{t('워크플로', 'Workflow')}</span>
            <span className="ws">
              {(phases.find((p) => p.index === curPhase)?.title || t('진행 중', 'In progress')) + ` · ${doneAll}/${w.agents.length}`}
            </span>
            <span className="wx">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="m18 15-6-6-6 6" />
              </svg>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function WorkflowCard({
  wf,
  peers,
  onSwitch,
  onMin,
  onStop
}: {
  wf: WorkflowState
  peers: WorkflowState[]
  onSwitch: (id: string) => void
  onMin: () => void
  onStop?: () => void
}) {
  // null = 진행 중인 단계를 따라간다 — 단계를 클릭하면 고정, 진행 단계를 다시 클릭하면 복귀
  const [selPhase, setSelPhase] = useState<number | null>(null)
  // 카드 위 우클릭 드래그 ↓→(닫기 문법) = 내려두기 — 크게 보기 카드와 같은 제스처
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)

  const phases = [...wf.phases].sort((a, b) => a.index - b.index)
  const agents = wf.agents
  const doneAll = agents.filter((a) => a.state === 'done').length
  // 진행 단계 = 아직 안 끝난 에이전트가 있는 가장 앞 단계 (전부 끝났으면 마지막 = 정리 중)
  const curPhase =
    phases.find((p) => agents.some((a) => a.phase === p.index && a.state !== 'done'))?.index ??
    phases[phases.length - 1]?.index ??
    1
  const sel = selPhase ?? curPhase
  const selTitle = phases.find((p) => p.index === sel)?.title ?? ''
  const selAgents = agents.filter((a) => a.phase === sel)
  const inPhase = (idx: number): { d: number; t: number } => {
    const list = agents.filter((a) => a.phase === idx)
    return { d: list.filter((a) => a.state === 'done').length, t: list.length }
  }
  const mins = Math.floor(wf.durationMs / 60_000)
  const elapsed =
    mins > 0
      ? t(`${mins}분 ${Math.floor((wf.durationMs % 60_000) / 1000)}초`, `${mins}m ${Math.floor((wf.durationMs % 60_000) / 1000)}s`)
      : t(`${Math.floor(wf.durationMs / 1000)}초`, `${Math.floor(wf.durationMs / 1000)}s`)

  return (
    <div className="wf-card scroll" ref={setCardEl}>
      <MouseGestureLayer target={cardEl} actions={[{ pattern: 'DR', label: t('내려두기', 'Minimize'), run: onMin }]} />
      <div className="wf-head">
        <span className="st run" />
        <span className="whl">{t('워크플로', 'Workflow')}</span>
        {peers.length > 1 && (
          <span className="wf-tabs">
            {peers.map((w, i) => (
              <button
                key={w.id}
                className={'has-tip tip-wrap' + (w.id === wf.id ? ' on' : '')}
                data-tip={w.summary || t('워크플로 전환', 'Switch workflow')}
                onClick={() => onSwitch(w.id)}
              >
                {i + 1}
              </button>
            ))}
          </span>
        )}
        <span className="wsum has-tip tip-wrap" data-tip={wf.summary}>
          {wf.summary}
        </span>
        <span className="wmeta">
          {doneAll}/{agents.length} · {elapsed}
          {wf.totalTokens >= 1000 ? ` · ${fmtTok(wf.totalTokens)} tok` : ''}
        </span>
        <button className="wmin has-tip" onClick={onMin} aria-label={t('내려두기', 'Minimize')} data-tip={t('내려두기 (Esc)', 'Minimize (Esc)')}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      <div className="wf-title">
        {selTitle ? t(`${sel}단계 ${selTitle}`, `Phase ${sel} — ${selTitle}`) : t('준비 중', 'Getting ready')}
        {selAgents.length > 0
          ? t(` — 에이전트 ${inPhase(sel).d}/${inPhase(sel).t}`, ` · Agents ${inPhase(sel).d}/${inPhase(sel).t}`)
          : ''}
      </div>
      <div className="wf-prog">
        <div className="bar">
          <i style={{ width: `${agents.length ? Math.max(4, Math.round((doneAll / agents.length) * 100)) : 4}%` }} />
        </div>
        <span className="n">
          {doneAll}/{agents.length}
        </span>
      </div>

      <div className="wf-cols">
        <div className="wf-rail">
          {phases.map((p) => {
            const c = inPhase(p.index)
            const done = c.t > 0 && c.d === c.t && p.index < curPhase
            return (
              <button
                key={p.index}
                className={`wf-ph${p.index === sel ? ' sel' : ''}`}
                onClick={() => setSelPhase(p.index === curPhase ? null : p.index)}
              >
                <span className="no">{p.index}</span>
                <span className="pn">{p.title}</span>
                <span className="pc">
                  {done ? '✓' : c.t > 0 ? `${c.d}/${c.t}` : t('대기', 'Queued')}
                </span>
              </button>
            )
          })}
        </div>
        <div className="wf-agents">
          {selAgents.length === 0 && <div className="wf-empty">{t('앞 단계가 끝나면 시작돼요', 'Starts once the previous phase finishes')}</div>}
          {selAgents.map((a, i) => (
            <div className="wf-ag" key={`${a.phase}-${i}`}>
              <span className={`st ${a.state === 'done' ? 'ok' : a.state === 'error' ? 'err' : a.state === 'queued' ? 'wait' : 'run'}`} />
              <span className="nm has-tip tip-wrap" data-tip={a.note || a.label}>
                {a.label}
              </span>
              {a.model && <span className="mt">{a.model}</span>}
              <span className="rt">
                {typeof a.tokens === 'number' && a.tokens >= 1000 ? `${fmtTok(a.tokens)} tok` : ''}
                {typeof a.toolCalls === 'number' && a.toolCalls > 0 ? t(` · 도구 ${a.toolCalls}`, ` · ${a.toolCalls} tools`) : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="wf-foot">
        <span className="wf-hint">
          {t(
            '결과가 나오면 대화로 정리해 드려요 — 그동안에도 대화는 계속할 수 있어요.',
            'We’ll summarize the results in the chat — you can keep chatting in the meantime.'
          )}
        </span>
        {onStop && (
          <button className="wf-stop" onClick={onStop}>
            {t('중지', 'Stop')}
          </button>
        )}
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
  apiReadyCodex = false,
  onApiModeChange,
  images,
  onPickImages,
  onAddImagePaths,
  onRemoveImage,
  onOpenImage,
  cwd,
  mentionBase,
  commands = slashCommands(),
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
  apiReady?: boolean // 설정 → API에 Anthropic 키가 저장돼 있는지 (없으면 API 선택이 설정을 연다)
  apiReadyCodex?: boolean // OpenAI 키 존재 여부 — Codex 엔진의 과금 선택이 쓴다
  onApiModeChange?: (next: boolean, engine?: EngineId) => void // 제공될 때만 과금 picker를 그린다
  images: string[]
  onPickImages: () => void
  onAddImagePaths: (paths: string[]) => void
  onRemoveImage: (i: number) => void
  onOpenImage?: (images: string[], index: number) => void
  cwd: string // project dir — scopes which skills the "/" palette loads
  mentionBase?: string // @ 멘션이 파일을 뜨우는 기준 폴더(탐색기가 보는 폴더). 없으면 cwd
  commands?: SlashCmd[] // "/" 팔레트의 내장 명령 목록 (기본: slashCommands() 전체)
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
}) {
  const [focus, setFocus] = useState(false)
  // true while an image is being dragged over the composer → shows the drop hint overlay.
  // a counter, not a bool: dragenter/leave fire per child element, so a plain flag flickers
  const dragDepth = useRef(0)
  const [dragOver, setDragOver] = useState(false)

  // 입력이 두 줄 이상이면 컴포저가 자동 두 줄로 승격 — 입력칸이 첫 줄 전체를 차지하고
  // [+ · 칩 · 보내기]가 아래 줄로 내려간다. 긴 요약 칩(GPT 모델·계정)이 입력칸 폭을
  // 잠식해 모든 줄이 일찍 꺾이던 문제의 해법 (한 줄일 땐 기존 고스트 필 그대로).
  // 클래스 이름은 'multi'가 아니라 'two-line' — 멀티 채팅 화면 루트(.multi)의 전역 규칙
  // (flex-direction:column 등)이 같은 이름을 타고 컴포저 행을 덮쳐, 승격 순간 컨트롤이
  // 오른쪽에 세로로 쌓이는 거대 컴포저가 되던 실사고.
  const [multi, setMulti] = useState(false)
  const grow = (el: HTMLTextAreaElement | null): void => {
    if (!el) return
    // 승격 판정은 항상 '한 줄 레이아웃(칩이 옆에 있는 좁은 폭)'에서 잰다 — 승격 후의
    // 넓은 폭으로 재판정하면 좁혀서 두 줄 ↔ 넓혀서 한 줄이 서로를 뒤집는 진동이 생긴다.
    const row = el.parentElement // .composer-row
    row?.classList.remove('two-line')
    el.style.height = 'auto'
    // 빈 입력은 무조건 한 줄 — placeholder도 scrollHeight에 계상돼서(Chromium), 좁은 폭
    // (멀티 패널·세션 창·확대 배율)에서 긴 busy placeholder가 줄바꿈되면 빈 칸인데도
    // 승격 판정이 나고, 판정은 늘 한 줄 폭에서 재므로 전송 후에도 영영 안 풀렸다.
    const empty = el.value === ''
    const wraps = !empty && el.scrollHeight > 32 // 한 줄 높이 ≈26px(13px×1.55+패딩 6), 두 줄 ≈46px
    row?.classList.toggle('two-line', wraps)
    el.style.height = 'auto'
    el.style.height = (empty ? 26 : Math.min(el.scrollHeight, 160)) + 'px'
    // 상한(160px)을 넘기 전엔 스크롤을 잠근다 — 분수 zoom(멀티 패널 .9 등)에선 반올림
    // 오차로 1px 유령 오버플로가 생겨 빈 입력에도 스크롤바가 튀어나올 수 있다
    el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden'
    setMulti(wraps) // 재렌더의 className이 방금 손댄 classList와 일치하도록 동기화
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
  // 명령/스킬은 예약돼 런이 끝나면 나간다.
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
  const cmdHits = slashQuery === null ? [] : commands.filter((c) => c.name.includes(slashQuery))
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
      ? t('프로젝트 루트', 'Project root')
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
    // 진입은 입력창이 비어 있을 때만 — 초안을 쓰는 중의 ↑는 줄 이동/캐럿 이동으로 남긴다.
    // (이미 히스토리를 넘기는 중이면 계속 ↑/↓로 탐색)
    if (history.length > 0 && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const pos = e.currentTarget.selectionStart ?? value.length
      const onFirstLine = !value.slice(0, pos).includes('\n')
      const onLastLine = !value.slice(pos).includes('\n')
      if (e.key === 'ArrowUp' && onFirstLine && (histIdx !== null || !value.trim())) {
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
        {queued.length > 0 && (
          <div className="sched">
            <div className="sched-head">
              <span className="sched-pulse" />
              <span className="sched-title">
                {t('예약된 메시지', 'Queued messages')}
                <span className="sched-count">{queued.length}</span>
              </span>
              <span className="sched-hint">{t('작업이 끝나면 순서대로 전송돼요', 'They’ll be sent in order when the run ends')}</span>
            </div>
            <div className="sched-list">
              {queued.map((m, i) => (
                <div className="sched-item" key={m.id}>
                  <span className="sched-num">{i + 1}</span>
                  <span className="sched-text">
                    {m.text.trim() || (m.images.length ? t(`첨부 ${m.images.length}개`, `${m.images.length} attachments`) : '')}
                  </span>
                  {m.images.length > 0 && (
                    <span className="sched-img has-tip" data-tip={t(`첨부 ${m.images.length}개`, `${m.images.length} attachments`)}>
                      <IconPaperclip size={13} />
                    </span>
                  )}
                  <button
                    className="sched-x has-tip"
                    aria-label={t('예약 취소', 'Remove from queue')}
                    data-tip={t('예약 취소', 'Remove from queue')}
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
              <IconPaperclip size={15} />
              <span>{t('파일을 여기에 놓으세요', 'Drop files here')}</span>
            </div>
          )}
          {slashOpen && (
            <div className="slash-menu scroll" ref={slashRef} role="listbox">
              {cmdHits.length > 0 && <div className="slash-sec">{t('명령어', 'Commands')}</div>}
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
              {skillHits.length > 0 && <div className="slash-sec">{t('스킬', 'Skills')}</div>}
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
                    <span className="slash-desc">{s.description || t('설명이 없습니다.', 'No description.')}</span>
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
                      {t(`‘${mention.term}’ 검색`, `Search ‘${mention.term}’`)}
                      {!baseIsMain || mLocRel ? ' · ' + mLocFull : ''}
                    </span>
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
                        <span className="slash-desc">{e.dir ? e.dir.replace(/\/$/, '') : t('루트', 'root')}</span>
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
                    <button className="img-thumb-x has-tip" onClick={() => onRemoveImage(i)} aria-label={t('제거', 'Remove')} data-tip={t('제거', 'Remove')}>
                      <IconX2 size={11} />
                    </button>
                  </div>
                ) : (
                  <div className="img-thumb doc has-tip tip-path" data-tip={p} key={p + i}>
                    <span className="img-thumb-open">
                      <FileBadge path={p} size={15} />
                      <span className="doc-name">{imageName(p)}</span>
                    </span>
                    <button className="img-thumb-x has-tip" onClick={() => onRemoveImage(i)} aria-label={t('제거', 'Remove')} data-tip={t('제거', 'Remove')}>
                      <IconX2 size={11} />
                    </button>
                  </div>
                )
              )}
            </div>
          )}
          {/* 한 줄 고스트 필 (PoC): [+ 첨부] [입력] [모델 칩 → 통합 팝오버] [보내기]
              — 입력이 여러 줄이면 two-line이 서서 입력칸 전체 폭 + 컨트롤 아랫줄로 승격 */}
          <div className={'composer-row' + (multi ? ' two-line' : '')}>
            <button
              className="plus has-tip"
              aria-label={t('파일 첨부', 'Attach files')}
              data-tip={t('파일 첨부 (이미지·텍스트)', 'Attach files (images · text)')}
              onClick={onPickImages}
            >
              <IconPlus size={11} stroke={2.2} />
            </button>
            <textarea
              ref={inputRef}
              rows={1}
              placeholder={
                busy
                  ? t('다음 메시지를 예약하세요… (작업 후 자동 전송)', 'Queue your next message… (sent when the run ends)')
                  : started
                    ? t('메세지를 입력하세요.', 'Type a message.')
                    : t('오늘 어떤 도움을 드릴까요?', 'How can I help you today?')
              }
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
            <PickerChip
              picker={picker}
              setPicker={setPicker}
              apiMode={apiMode}
              apiReady={apiReady}
              apiReadyCodex={apiReadyCodex}
              engineLocked={started}
              onApiModeChange={onApiModeChange}
            />
            {busy ? (
              value.trim() || images.length > 0 ? (
                <button
                  className="send schedule has-tip"
                  aria-label={t('예약', 'Queue')}
                  data-tip={t('작업 후 전송 예약 (Enter)', 'Queue to send after the run (Enter)')}
                  onClick={onSchedule}
                >
                  <IconClock size={15} />
                </button>
              ) : (
                <button className="send stop has-tip" aria-label={t('중지', 'Stop')} data-tip={t('실행 중지', 'Stop the run')} onClick={onStop}>
                  <IconClose size={15} />
                </button>
              )
            ) : (
              <button className="send has-tip" aria-label={t('보내기', 'Send')} data-tip={t('보내기 (Enter)', 'Send (Enter)')} disabled={!value.trim() && images.length === 0} onClick={onSend}>
                <IconSend size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
