import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AccountInfo,
  AccountUsage,
  EffortId,
  FileDiff,
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitFileStatus,
  GitStatus,
  ModelId
} from '@shared/protocol'
import { relTime } from './Sidebar'
import { getPref, setPref } from '../lib/prefs'
import { MouseGestureLayer, type GestureAction } from './mouseGesture'
import {
  IconCheck,
  IconChevLeft,
  IconClock,
  IconClose,
  IconDiff,
  IconGitBranch,
  IconPlus,
  IconRotate,
  IconSearch,
  IconSpark,
  IconUndo,
  IconX2
} from './icons'

/** 뷰어(FileModal)로 넘기는 일회성 diff/스냅샷 — App이 override prop으로 전달한다. */
export interface GitViewerOverride {
  content: string | null // 커밋 시점 스냅샷 (null = 디스크에서 읽음, LSP 유지)
  diff: FileDiff | null // 세션 diffs 대신 마킹에 쓸 일회성 diff
  label: string | null // 헤더의 커밋 해시 칩
}

// 확인 카드 — 되돌리기(파괴적) / 변경 있는 채 브랜치 전환
type Confirm = { kind: 'discard'; file: GitFileStatus } | { kind: 'switch'; name: string }

// 히스토리 날짜 그룹 라벨 — 오늘/어제/그 외 'M월 D일' (해가 다르면 연도 포함)
function dayLabel(unix: number): string {
  const d = new Date(unix * 1000)
  const now = new Date()
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (diff === 0) return '오늘'
  if (diff === 1) return '어제'
  const y = d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}년 ` : ''
  return `${y}${d.getMonth() + 1}월 ${d.getDate()}일`
}

function fullTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 경로 표시 — 폴더 부분을 흐리게 (.fn .dir)
function FnPath({ p }: { p: string }) {
  const cut = p.lastIndexOf('/')
  return (
    <span className="fn">
      {cut >= 0 && <span className="dir">{p.slice(0, cut + 1)}</span>}
      {p.slice(cut + 1)}
    </span>
  )
}

const LOG_PAGE = 100

// AI 커밋 메시지 카드의 선택지 — 컴포저 picker와 같은 축(모델·effort)
const AI_MODELS: { id: ModelId; label: string }[] = [
  { id: 'fable', label: 'Fable 5' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' }
]
const AI_EFFORTS: { id: EffortId; label: string }[] = [
  { id: 'minimal', label: '최소' },
  { id: 'low', label: '낮음' },
  { id: 'medium', label: '중간' },
  { id: 'high', label: '높음' },
  { id: 'xhigh', label: '매우 높음' },
  { id: 'max', label: '최대' }
]

// 계정 행의 한도 요약 — "남은 %"로 말한다 (이 카드의 존재 이유가 남은 한도 비교라서).
// 경고 장식 없이 숫자만 — 판단은 숫자가 이미 말해준다 (⚠는 실측 후 제거).
function usageDesc(u: AccountUsage | undefined, loading: boolean): string {
  if (!u) return loading ? '한도 확인 중…' : '한도 정보를 못 가져왔어요'
  const parts: string[] = []
  const push = (label: string, pct: number | null): void => {
    if (pct == null) return
    parts.push(`${label} ${Math.max(0, Math.round(100 - pct))}% 남음`)
  }
  push('5시간', u.fiveHourPct)
  push('주간', u.weeklyPct)
  push('Fable', u.fablePct)
  return parts.length ? parts.join(' · ') : '한도 정보 없음'
}

/**
 * Git 카드 — 탐색기 하단 상태 스트립으로 여는 Fork식 3분할 모달(내비·목록·상세).
 * 파일 클릭은 전부 기존 뷰어(FileModal)의 override(일회성 diff·커밋 스냅샷·해시 칩)로
 * 이어진다 — 뷰어가 z 60이라 이 카드(z 55) 위에 뜬다. 스테이징 용어는 UI에 없다:
 * 체크박스가 "커밋에 담기"고 기본 전부 체크다. 파괴적 동작(되돌리기·더티 전환)은
 * 네이티브 confirm 금지 규약대로 .set-dialog 카드로 확인한다.
 */
export function GitModal({
  cwd,
  refreshKey,
  onClose,
  onOpenFile
}: {
  cwd: string
  refreshKey: number // 턴 종료 → 에이전트가 만든 변경을 다시 읽는다
  onClose: () => void
  onOpenFile: (path: string, override: GitViewerOverride) => void // 절대 경로(포워드 슬래시)
}) {
  const [st, setSt] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [view, setView] = useState<'changes' | 'history'>('changes')
  // 체크 = 커밋에 담기. 기본 전부 체크라 "해제한 것"만 기억한다 — 새 파일은 자동 체크.
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState<'' | 'fetch' | 'pull' | 'push' | 'commit' | 'ai' | 'branch' | 'discard'>('')
  const [err, setErr] = useState<string | null>(null)
  const [log, setLog] = useState<GitCommit[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [logLoading, setLogLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [selHash, setSelHash] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [creating, setCreating] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  // AI 메시지 2단계 카드 — 1: 계정(남은 한도 보고 결정), 2: 모델·effort. 매번 묻는 게
  // 의도다: 계정마다 남은 한도가 달라 "어느 계정으로 돌릴지"가 실사용 결정이라서.
  const [aiStep, setAiStep] = useState<0 | 1 | 2>(0)
  const [aiAccounts, setAiAccounts] = useState<AccountInfo[] | null>(null)
  const [aiUsage, setAiUsage] = useState<Map<string, AccountUsage> | null>(null)
  const [aiAccount, setAiAccount] = useState<string>(() => getPref('git.ai.account', ''))
  const [aiModel, setAiModel] = useState<ModelId>(() => getPref<ModelId>('git.ai.model', 'sonnet'))
  const [aiEffort, setAiEffort] = useState<EffortId>(() => getPref<EffortId>('git.ai.effort', 'low'))
  // 비동기 응답이 낡은 폴더/닫힌 카드에 내려앉지 않게
  const genRef = useRef(0)
  // 우클릭 마우스 제스처(뷰어와 동일) — ↓→ 창 닫기, ←/→ 변경↔히스토리 전환
  const [cardEl, setCardEl] = useState<HTMLElement | null>(null)

  const notifyGit = (): void => {
    window.dispatchEvent(new CustomEvent('ccg-git-changed')) // 탐색기 스트립 갱신
  }

  const refresh = async (): Promise<void> => {
    const gen = genRef.current
    const [s, br] = await Promise.all([
      window.api.git.status(cwd).catch(() => null),
      window.api.git.branches(cwd).catch(() => [] as GitBranch[])
    ])
    if (gen !== genRef.current) return
    if (s) setSt(s)
    setBranches(br)
    // 히스토리를 이미 봤다면 첫 페이지를 다시 — 방금 커밋/전환이 바로 보이게 (페이징은 리셋)
    if (log !== null) void loadLog(true, gen)
  }

  const loadLog = async (reset: boolean, gen = genRef.current): Promise<void> => {
    setLogLoading(true)
    const skip = reset ? 0 : log?.length ?? 0
    const r = await window.api.git.log(cwd, LOG_PAGE, skip).catch(() => ({ commits: [], hasMore: false }))
    if (gen !== genRef.current) return
    setLog((prev) => (reset ? r.commits : [...(prev ?? []), ...r.commits]))
    setHasMore(r.hasMore)
    setLogLoading(false)
  }

  // 폴더 변경·턴 종료 → 전체 재조회 (폴더가 바뀌면 화면 상태도 처음으로)
  useEffect(() => {
    genRef.current += 1
    setSt(null)
    setLog(null)
    setSelHash(null)
    setDetail(null)
    setUnchecked(new Set())
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])
  useEffect(() => {
    if (refreshKey > 0) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // 파일 목록이 바뀌면 사라진 파일의 체크 해제 기억을 청소
  useEffect(() => {
    if (!st) return
    const have = new Set(st.files.map((f) => f.path))
    setUnchecked((prev) => {
      const next = new Set([...prev].filter((p) => have.has(p)))
      return next.size === prev.size ? prev : next
    })
  }, [st])

  // 히스토리 탭을 처음 열 때 로드
  useEffect(() => {
    if (view === 'history' && log === null && !logLoading) void loadLog(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // Esc — 확인 카드 → 카드만, 뷰어가 떠 있으면 뷰어가 주인, 아니면 모달 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (aiStep > 0) {
        setAiStep(0)
        return
      }
      if (confirm) {
        setConfirm(null)
        return
      }
      if (document.querySelector('.fv-overlay, .iv-overlay')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, aiStep, onClose])

  const rootFs = (st?.root ?? cwd).replace(/\\/g, '/')
  const absOf = (rel: string): string => rootFs.replace(/\/+$/, '') + '/' + rel
  const checkedFiles = useMemo(
    () => (st?.files ?? []).filter((f) => !unchecked.has(f.path)).map((f) => f.path),
    [st, unchecked]
  )

  // ── 동작들 — 전부 {ok,error} 계약: 실패는 헤더 gitm-err 한 줄로 ──────────────
  const run = async (kind: typeof busy, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    if (busy) return false
    setBusy(kind)
    setErr(null)
    const r = await fn().catch((e) => ({ ok: false, error: e instanceof Error ? e.message : '실패했어요' }))
    setBusy('')
    if (!r.ok) {
      setErr(r.error ?? '실패했어요')
      return false
    }
    notifyGit()
    await refresh()
    return true
  }

  const doFetch = (): void => void run('fetch', () => window.api.git.fetch(cwd))
  const doPull = (): void => void run('pull', () => window.api.git.pull(cwd))
  const doPush = (): void => void run('push', () => window.api.git.push(cwd))
  const doCommit = (): void =>
    void run('commit', () => window.api.git.commit(cwd, checkedFiles, subject, body)).then((ok) => {
      if (ok) {
        setSubject('')
        setBody('')
      }
    })

  // AI 메시지 버튼 → 카드 1단계. 계정 목록은 바로, 한도는 조회되는 대로 채운다
  // (계정별 usage 일괄 조회는 네트워크라 몇 초 걸릴 수 있다 — 목록을 기다리게 하지 않는다)
  const openAiFlow = (): void => {
    if (busy || checkedFiles.length === 0) return
    setAiStep(1)
    setAiAccounts(null)
    setAiUsage(null)
    window.api.auth
      .listAccounts()
      .then(setAiAccounts)
      .catch(() => setAiAccounts([]))
    window.api.auth
      .accountsUsage()
      .then((list) => setAiUsage(new Map(list.map((u) => [u.email, u]))))
      .catch(() => setAiUsage(new Map()))
  }
  const pickAiAccount = (email: string): void => {
    setAiAccount(email)
    setPref('git.ai.account', email)
    setAiStep(2)
  }
  const startAi = (): void => {
    setPref('git.ai.model', aiModel)
    setPref('git.ai.effort', aiEffort)
    setAiStep(0)
    void doAi({ account: aiAccount, model: aiModel, effort: aiEffort })
  }

  const doAi = async (opts: { account: string; model: ModelId; effort: EffortId }): Promise<void> => {
    if (busy || checkedFiles.length === 0) return
    setBusy('ai')
    setErr(null)
    const r = await window.api.git
      .aiMessage(cwd, checkedFiles, opts)
      .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : 'AI 메시지 생성에 실패했어요' }))
    setBusy('')
    if (!r.ok) {
      setErr(r.error ?? 'AI 메시지 생성에 실패했어요')
      return
    }
    setSubject(r.subject ?? '')
    setBody(r.body ?? '')
  }

  const doDiscard = (f: GitFileStatus): void => {
    setConfirm(null)
    void run('discard', () => window.api.git.discard(cwd, f.path, !!f.untracked))
  }

  const doSwitch = (name: string): void => {
    setConfirm(null)
    void run('branch', () => window.api.git.switchBranch(cwd, name)).then((ok) => {
      if (ok) {
        setSelHash(null)
        setDetail(null)
      }
    })
  }
  const askSwitch = (b: GitBranch): void => {
    if (b.current || busy) return
    if ((st?.files.length ?? 0) > 0) setConfirm({ kind: 'switch', name: b.name })
    else doSwitch(b.name)
  }
  const doCreate = (): void => {
    const name = newBranch.trim()
    if (!name) {
      setCreating(false)
      return
    }
    void run('branch', () => window.api.git.createBranch(cwd, name)).then((ok) => {
      if (ok) {
        setCreating(false)
        setNewBranch('')
      }
    })
  }

  // ── 뷰어 연결 — 워킹트리 diff / 커밋 스냅샷 ────────────────────────────────
  const openWorkFile = async (f: GitFileStatus): Promise<void> => {
    const r = await window.api.git.fileDiff(cwd, f.path).catch(() => null)
    if (r?.headContent != null) {
      // 디스크에서 지워진 파일 — HEAD 스냅샷으로 "뭘 잃는지"를 보여준다
      onOpenFile(absOf(f.path), { content: r.headContent, diff: null, label: 'HEAD · 삭제됨' })
      return
    }
    onOpenFile(absOf(f.path), { content: null, diff: r?.diff ?? null, label: null })
  }

  const pickCommit = async (c: GitCommit): Promise<void> => {
    setSelHash(c.hash)
    setDetail(null)
    const gen = genRef.current
    const d = await window.api.git.commitDetail(cwd, c.hash).catch(() => null)
    if (gen === genRef.current) setDetail(d)
  }

  const openCommitFile = async (hash: string, shortHash: string, rel: string): Promise<void> => {
    const r = await window.api.git.commitFileDiff(cwd, hash, rel).catch(() => null)
    if (!r) return
    onOpenFile(absOf(rel), { content: r.content ?? '', diff: r.diff, label: shortHash })
  }

  // 히스토리 필터(제목·해시·작성자) + 날짜 그룹
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = (log ?? []).filter(
      (c) =>
        !q ||
        c.subject.toLowerCase().includes(q) ||
        c.shortHash.startsWith(q) ||
        c.author.toLowerCase().includes(q)
    )
    const out: { label: string; items: GitCommit[] }[] = []
    for (const c of list) {
      const label = dayLabel(c.time)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(c)
      else out.push({ label, items: [c] })
    }
    return out
  }, [log, filter])

  const copyHash = (): void => {
    if (detail) void navigator.clipboard.writeText(detail.hash)
  }

  // 우클릭 드래그 제스처 — 뷰어와 같은 문법: ↓→ 닫기, ←/→는 이 카드의 두 보기 전환
  const gestures: GestureAction[] = [
    { pattern: 'L', label: '변경 보기', run: () => setView('changes') },
    { pattern: 'R', label: '히스토리 보기', run: () => setView('history') },
    { pattern: 'DR', label: '창 닫기', run: onClose }
  ]

  return (
    <div
      className="gitm-overlay"
      onMouseDown={(e) => {
        // 왼클릭 배경만 닫기 — 우클릭은 제스처 시작이라 닫으면 안 된다
        if (e.button === 0 && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="gitm-modal" ref={setCardEl}>
        {/* 헤더 — 정체(⎇ Git)·브랜치 칩·저장소 경로 ─ 에러·원격 동작·닫기 */}
        <div className="gitm-head">
          <span className="gitm-ic">
            <IconGitBranch size={16} />
          </span>
          <span className="gitm-name">Git</span>
          {st && (
            <span className="gitm-br has-tip" data-tip={st.upstream ? `업스트림 ${st.upstream}` : '업스트림 없음 — 첫 푸시 전'}>
              {st.branch}
              {st.ahead > 0 && <em className="ab">↑{st.ahead}</em>}
              {st.behind > 0 && <em className="ab bh">↓{st.behind}</em>}
            </span>
          )}
          <span className="gitm-path">{st?.root ?? cwd}</span>
          <span className="sp" />
          {err && (
            <span className="gitm-err has-tip tip-wrap" data-tip={err}>
              {err}
            </span>
          )}
          <button
            className="gitm-btn has-tip"
            disabled={!!busy || !st?.hasRemote}
            onClick={doFetch}
            data-tip="원격 상태 갱신 (fetch) — 받을·보낼 커밋 수를 새로 읽어요"
          >
            {busy === 'fetch' ? <span className="spin" /> : <IconRotate size={12} />}
            갱신하기
          </button>
          <button
            className="gitm-btn has-tip"
            disabled={!!busy || !st?.hasRemote}
            onClick={doPull}
            data-tip="원격의 새 커밋을 받아와요 (pull)"
          >
            {busy === 'pull' && <span className="spin" />}
            당겨오기{st && st.behind > 0 ? ` ↓${st.behind}` : ''}
          </button>
          <button
            className="gitm-btn has-tip"
            disabled={!!busy || !st?.hasRemote}
            onClick={doPush}
            data-tip="커밋을 원격에 올려요 (push) — 업스트림 없으면 origin에 만들어요"
          >
            {busy === 'push' && <span className="spin" />}
            올리기{st && st.ahead > 0 ? ` ↑${st.ahead}` : ''}
          </button>
          <button className="gitm-btn has-tip" onClick={onClose} aria-label="닫기" data-tip="닫기 (Esc)">
            <IconClose size={12} />
          </button>
        </div>

        <div className="gitm-body">
          {/* 좌측 내비 — 보기 전환 + 브랜치 */}
          <div className="gitm-nav scroll">
            <div className="gitm-sec">보기</div>
            <button className={'gitm-item' + (view === 'changes' ? ' on' : '')} onClick={() => setView('changes')}>
              <span className="ic">
                <IconDiff size={13} />
              </span>
              변경
              {(st?.files.length ?? 0) > 0 && <span className="n warn">{st?.files.length}</span>}
            </button>
            <button className={'gitm-item' + (view === 'history' ? ' on' : '')} onClick={() => setView('history')}>
              <span className="ic">
                <IconClock size={13} />
              </span>
              히스토리
            </button>

            <div className="gitm-sec line">브랜치</div>
            {branches.map((b) => (
              <button
                key={b.name}
                className="gitm-item"
                onClick={() => askSwitch(b)}
              >
                <span className="ic">
                  <IconGitBranch size={12} />
                </span>
                <span className="nm">{b.name}</span>
                {b.current ? (
                  <span className="cur">
                    <IconCheck size={11} stroke={2.4} />
                  </span>
                ) : (
                  <span className="n">{relTime(b.time * 1000)}</span>
                )}
              </button>
            ))}
            {creating ? (
              <div className="gitm-item static">
                <span className="ic">
                  <IconPlus size={12} />
                </span>
                <input
                  className="gitm-newbr"
                  autoFocus
                  placeholder="새 브랜치 이름"
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') doCreate()
                    else if (e.key === 'Escape') {
                      e.stopPropagation()
                      setCreating(false)
                      setNewBranch('')
                    }
                  }}
                  onBlur={() => {
                    if (!newBranch.trim()) setCreating(false)
                  }}
                />
              </div>
            ) : (
              <button className="gitm-item" onClick={() => setCreating(true)}>
                <span className="ic">
                  <IconPlus size={12} />
                </span>
                새 브랜치…
              </button>
            )}
          </div>

          {/* 가운데 — 변경(파일+커밋 컴포저) 또는 히스토리(커밋 리스트) */}
          <div className={'gitm-list' + (view === 'changes' ? ' wide' : '')}>
            {st === null ? (
              <div className="gitm-state">
                <span className="spin" />
                읽는 중…
              </div>
            ) : view === 'changes' ? (
              <>
                <div className="gitm-sec row" style={{ padding: '11px 18px 5px' }}>
                  변경된 파일 {st.files.length}
                  {st.files.length > 0 && (
                    <button
                      className="lnk"
                      onClick={() =>
                        setUnchecked(checkedFiles.length === st.files.length ? new Set(st.files.map((f) => f.path)) : new Set())
                      }
                    >
                      {checkedFiles.length === st.files.length ? '모두 해제' : '모두 담기'}
                    </button>
                  )}
                </div>
                <div className="gitm-scroll scroll">
                  {st.files.length === 0 ? (
                    <div className="gitm-state small">작업 트리가 깨끗해요 — 모든 변경이 커밋됐어요</div>
                  ) : (
                    st.files.map((f) => (
                      <button
                        key={f.path}
                        className={'gitm-file' + (unchecked.has(f.path) ? '' : ' ckd')}
                        onClick={() => void openWorkFile(f)}
                      >
                        <span
                          className="ck"
                          role="checkbox"
                          aria-checked={!unchecked.has(f.path)}
                          onClick={(e) => {
                            e.stopPropagation()
                            setUnchecked((prev) => {
                              const next = new Set(prev)
                              if (next.has(f.path)) next.delete(f.path)
                              else next.add(f.path)
                              return next
                            })
                          }}
                        >
                          <IconCheck size={9} stroke={3.2} />
                        </span>
                        <span className={'gitm-st ' + f.status.toLowerCase()}>{f.status}</span>
                        <FnPath p={f.path} />
                        <span
                          className="undo"
                          role="button"
                          aria-label="변경 되돌리기"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirm({ kind: 'discard', file: f })
                          }}
                        >
                          <IconUndo size={11} />
                        </span>
                      </button>
                    ))
                  )}
                </div>
                <div className="gitm-compose">
                  <input
                    placeholder="커밋 메시지 (Ctrl+Enter로 커밋)"
                    value={subject}
                    spellCheck={false}
                    onChange={(e) => setSubject(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit()
                    }}
                  />
                  <textarea
                    rows={2}
                    placeholder="본문 (선택)"
                    value={body}
                    spellCheck={false}
                    onChange={(e) => setBody(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit()
                    }}
                  />
                  <div className="row">
                    <button
                      className="gitm-btn claude has-tip tip-wrap"
                      disabled={!!busy || checkedFiles.length === 0}
                      onClick={openAiFlow}
                      data-tip="계정(남은 한도)·모델·사고 수준을 골라 diff로 메시지를 써줘요"
                    >
                      {busy === 'ai' ? <span className="spin" /> : <IconSpark size={12} />}
                      {busy === 'ai' ? 'diff 읽는 중…' : 'AI 메시지'}
                    </button>
                    <span className="sp" />
                    <button
                      className="gitm-btn pri"
                      disabled={!!busy || checkedFiles.length === 0 || !subject.trim()}
                      onClick={doCommit}
                    >
                      {busy === 'commit' && <span className="spin" />}
                      {checkedFiles.length === 0 ? '커밋할 파일 없음' : `${checkedFiles.length}개 파일 커밋`}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="gitm-filter">
                  <IconSearch size={11} />
                  <input
                    placeholder="커밋 검색 (제목·해시·작성자)"
                    value={filter}
                    spellCheck={false}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  {filter && (
                    <button className="x" aria-label="검색 지우기" onClick={() => setFilter('')}>
                      <IconX2 size={10} />
                    </button>
                  )}
                </div>
                <div className="gitm-scroll scroll">
                  {log === null ? (
                    <div className="gitm-state">
                      <span className="spin" />
                      불러오는 중…
                    </div>
                  ) : grouped.length === 0 ? (
                    <div className="gitm-state small">
                      {filter ? `'${filter.trim()}'에 맞는 커밋이 없어요` : '아직 커밋이 없어요'}
                    </div>
                  ) : (
                    grouped.map((g) => (
                      <Fragment key={g.label + g.items[0]?.hash}>
                        <div className="gitm-day">{g.label}</div>
                        {g.items.map((c) => (
                          <button
                            key={c.hash}
                            className={
                              'gitm-commit' + (c.unpushed ? '' : ' pushed') + (selHash === c.hash ? ' sel' : '')
                            }
                            onClick={() => void pickCommit(c)}
                          >
                            <span className="c-rail">
                              <span className="c-dot" />
                              <span className="c-line" />
                            </span>
                            <span className="c-main">
                              <span className="c-msg">
                                <span className="t">{c.subject}</span>
                                {c.refs.slice(0, 3).map((r) => (
                                  <span className="c-tag" key={r}>
                                    {r}
                                  </span>
                                ))}
                              </span>
                              <span className="c-meta">
                                <span className="c-hash">{c.shortHash}</span>
                                <span>{c.author}</span>
                                <span>{relTime(c.time * 1000)}</span>
                                {c.unpushed && <span className="c-unp">푸시 안 됨</span>}
                              </span>
                            </span>
                          </button>
                        ))}
                      </Fragment>
                    ))
                  )}
                  {log !== null && hasMore && !filter && (
                    <button className="gitm-loadmore" disabled={logLoading} onClick={() => void loadLog(false)}>
                      {logLoading ? '불러오는 중…' : '이전 커밋 더 보기'}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* 우측 상세 — 히스토리에서 고른 커밋의 메타 + 바뀐 파일 */}
          {view === 'history' && (
            <div className="gitm-detail scroll">
              {selHash === null ? (
                <div className="gitm-state">커밋을 고르면 상세가 여기 보여요</div>
              ) : detail === null ? (
                <div className="gitm-state">
                  <span className="spin" />
                  읽는 중…
                </div>
              ) : (
                <>
                  <div className="gd-pad">
                    <div className="gd-msg">{detail.subject}</div>
                    {detail.body && <div className="gd-desc">{detail.body}</div>}
                    <div className="gd-meta">
                      <span className="gd-av">{(detail.author || '?').slice(0, 1).toUpperCase()}</span>
                      <span className="gd-who">
                        <b>{detail.author}</b>
                        <i>{fullTime(detail.time)}</i>
                      </span>
                      <button className="gd-hash has-tip" onClick={copyHash} data-tip="전체 해시 복사">
                        {detail.shortHash}
                      </button>
                    </div>
                  </div>
                  <div className="gitm-sec" style={{ padding: '4px 18px 5px' }}>
                    바뀐 파일 {detail.files.length}
                  </div>
                  {detail.files.map((f) => (
                    <button
                      key={f.path}
                      className="gitm-file"
                      onClick={() => void openCommitFile(detail.hash, detail.shortHash, f.path)}
                    >
                      <span className={'gitm-st ' + f.status.toLowerCase()}>{f.status}</span>
                      <FnPath p={f.path} />
                    </button>
                  ))}
                  <div className="gitm-hint">
                    파일을 클릭하면 그 커밋 시점의 내용이 뷰어로 열려요 — 헤더의 해시 칩이 스냅샷임을 알려줘요.
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 우클릭 드래그 제스처 — 뷰어(FileModal)와 동일한 레이어. 확인/AI 카드 중엔 쉼 */}
      <MouseGestureLayer target={cardEl} actions={gestures} disabled={!!confirm || aiStep > 0} />

      {/* AI 커밋 메시지 카드 — 1) 계정(남은 한도 비교) 2) 모델·effort → 작성.
          매번 묻는 게 의도: 계정마다 남은 한도가 달라 그때그때 고르는 게 이 앱의 문법 */}
      {aiStep > 0 &&
        createPortal(
          <div
            className="set-dialog-overlay"
            onMouseDown={(e) => {
              if (e.button === 0 && e.target === e.currentTarget) setAiStep(0)
            }}
          >
            <div className="qcard">
              <div className="qhead">
                <IconSpark size={15} />
                <span className="qhl">AI 커밋 메시지</span>
                <span className="qsp" />
                <button className="qmin" aria-label="닫기" onClick={() => setAiStep(0)}>
                  <IconClose size={14} />
                </button>
              </div>
              {aiStep === 1 ? (
                <div className="qwrap qstep-b" key="ai1">
                  <div className="qbl">1 / 2 — 계정</div>
                  <div className="qbt">어떤 계정으로 작성할까요?</div>
                  <div className="qopts">
                    {aiAccounts === null ? (
                      <div className="gitm-state small">
                        <span className="spin" />
                        계정 목록 읽는 중…
                      </div>
                    ) : aiAccounts.length === 0 ? (
                      <div className="gitm-state small">등록된 계정이 없어요 — 설정 → Account에서 로그인해 주세요</div>
                    ) : (
                      aiAccounts.map((a) => (
                        <button
                          key={a.email}
                          className={'qopt' + (a.email === aiAccount ? ' on' : '')}
                          onClick={() => pickAiAccount(a.email)}
                        >
                          <span className="ql">
                            {a.email}
                            {a.isDefault ? ' · 기본' : ''}
                          </span>
                          <span className="qd">{usageDesc(aiUsage?.get(a.email), aiUsage === null)}</span>
                          <span className="qck">
                            <IconCheck size={14} />
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <div className="qwrap qstep" key="ai2">
                  <div className="qbl">
                    <button className="qback" onClick={() => setAiStep(1)}>
                      <IconChevLeft size={11} />
                      계정 다시 고르기
                    </button>
                    <span className="qsp" />2 / 2 — 모델 · 사고 수준
                  </div>
                  <div className="qbt">무엇으로 작성할까요?</div>
                  <div className="gai-lab">모델</div>
                  <div className="gai-seg">
                    {AI_MODELS.map((m) => (
                      <button key={m.id} className={aiModel === m.id ? 'on' : ''} onClick={() => setAiModel(m.id)}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <div className="gai-lab">사고 수준 (effort)</div>
                  <div className="gai-seg">
                    {AI_EFFORTS.map((ef) => (
                      <button key={ef.id} className={aiEffort === ef.id ? 'on' : ''} onClick={() => setAiEffort(ef.id)}>
                        {ef.label}
                      </button>
                    ))}
                  </div>
                  <div className="qfoot">
                    <span className="qhint">
                      {aiAccount} · 담긴 파일 {checkedFiles.length}개의 diff로 작성해요
                    </span>
                    <button className="qgo" onClick={startAi}>
                      작성
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}

      {/* 확인 카드 — 파괴적 동작(되돌리기)·더티 브랜치 전환. 네이티브 confirm 금지 규약 */}
      {confirm &&
        createPortal(
          <div
            className="set-dialog-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setConfirm(null)
            }}
          >
            <div className="set-dialog">
              {confirm.kind === 'discard' ? (
                <>
                  <div className="sd-ic">
                    <IconUndo size={22} />
                  </div>
                  <div className="sd-title">이 파일의 변경을 되돌릴까요?</div>
                  <div className="sd-msg">
                    <b>{confirm.file.path}</b>
                    <br />
                    {confirm.file.untracked
                      ? '아직 커밋된 적 없는 새 파일이에요 — 휴지통으로 이동해요 (복구 가능).'
                      : '마지막 커밋 상태로 돌아가요. 이 변경은 어디에도 저장되지 않고 사라져요.'}
                  </div>
                  <div className="sd-btns">
                    <button className="sd-cancel" onClick={() => setConfirm(null)}>
                      취소
                    </button>
                    <button className="sd-go danger" onClick={() => doDiscard(confirm.file)}>
                      되돌리기
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="sd-ic warn">
                    <IconGitBranch size={22} />
                  </div>
                  <div className="sd-title">변경이 있는 채 전환할까요?</div>
                  <div className="sd-msg">
                    커밋 안 한 변경 {st?.files.length ?? 0}개를 든 채 <b>{confirm.name}</b>(으)로 전환해요. git이
                    변경을 가져갈 수 있으면 그대로 가져가고, 충돌하면 전환을 거부해요 — 그땐 커밋하거나 되돌린 뒤
                    다시 시도해 주세요.
                  </div>
                  <div className="sd-btns">
                    <button className="sd-cancel" onClick={() => setConfirm(null)}>
                      취소
                    </button>
                    <button className="sd-go" onClick={() => doSwitch(confirm.name)}>
                      전환
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
