import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { ApiConfigStatus, BgTaskRequest, PanelPopState, UsageInfo } from '@shared/protocol'
import type { EngineId } from '@shared/protocol'
import { useAgentSession, initialSessionState, sameCwd, commandOf, sanitizeSnapshot, snapshotForPersist, type SessionState } from '../store/session'
import { getPref, setPref } from '../lib/prefs'
import { t, useLang } from '../lib/i18n'
import { extractMentions } from '../lib/mentions'
import { pushRecentDir } from '../lib/recentDirs'
import { useLimitResume } from '../lib/useLimitResume'
import { useZoom, ZoomBadge } from './zoom'
import { WinControls } from './TitleBar'
import { FolderSwitchDialog } from './FolderSwitchDialog'
import { SubAgentModal } from './AgentPanel'
import { ImageViewer } from './ImageViewer'
import type { PickerState, ScheduledMsg } from './Chat'
import {
  PanelView,
  EMPTY_USAGE,
  freshPanel,
  deriveTitle,
  defaultTag,
  nextTag,
  sanitizePanelPicker,
  sanitizeRefDirs,
  sanitizeTag,
  useEvent,
  type PanelMeta
} from './MultiAgent'
const FileModal = lazy(() => import('./FileModal').then((m) => ({ default: m.FileModal }))) // CodeMirror 청크 지연 로드

// ── 패널 팝아웃 창 (#mapanel) — 멀티 패널 하나를 독립 OS 창으로 ─────────────────
// 크게 보기 카드의 창 버전: 같은 PanelView(expanded)를 별도 BrowserWindow에 그린다.
// 엔진은 메인 프로세스의 패널 풀(panelId) 그대로 — 이 창은 그 panelId의 maEvent를 구독해
// 그리는 두 번째 뷰라서, 창을 여닫아도 실행·백그라운드·resume은 끊기지 않는다.
// 초안·예약 큐·메타의 소유권은 떠 있는 동안 이 창에 있고(그리드엔 유령), 변화는 600ms
// 디바운스로 메인에 페르시스트 → 창이 닫히면 그 마지막 상태가 그리드로 복귀한다.

function metaFromBoot(b: PanelPopState): PanelMeta {
  return {
    ...freshPanel(),
    title: typeof b.title === 'string' ? b.title : '',
    custom: !!b.custom,
    locked: !!b.locked,
    color: sanitizeTag(b.color),
    cwd: typeof b.cwd === 'string' ? b.cwd : '',
    refDirs: sanitizeRefDirs(b.refDirs),
    picker: sanitizePanelPicker(b.picker as Partial<PickerState> | null),
    api: !!b.api,
    input: typeof b.input === 'string' ? b.input : '',
    images: Array.isArray(b.images) ? b.images.filter((x): x is string => typeof x === 'string') : [],
    queue: Array.isArray(b.queue) ? (b.queue as ScheduledMsg[]).filter((q) => q && typeof q.text === 'string') : []
  }
}

export function PanelWindow(): React.ReactElement {
  const [boot, setBoot] = useState<PanelPopState | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    window.api.multi
      ?.panelHydrate?.()
      .then((b) => (b ? setBoot(b) : setMissing(true)))
      .catch(() => setMissing(true))
  }, [])
  if (missing) {
    // 부트 페이로드가 없다 — 비정상 기동(개발 중 리로드 등). 빈 창으로 두느니 안내만.
    return (
      <div className="sw pwin">
        <div className="pw-head">
          <span className="pw-drag" />
          <WinControls />
        </div>
        <div className="ma-hydrate">
          <span className="ma-foot-hint">{t('패널 정보를 찾지 못했어요 — 창을 닫고 다시 열어주세요', 'Panel state not found — close this window and pop it out again')}</span>
        </div>
      </div>
    )
  }
  if (!boot) {
    return (
      <div className="sw pwin">
        <div className="pw-head">
          <span className="pw-drag" />
          <WinControls />
        </div>
        <div className="ma-hydrate">
          <span className="ma-hydrate-spin" />
        </div>
      </div>
    )
  }
  return <PanelHost boot={boot} />
}

function PanelHost({ boot }: { boot: PanelPopState }): React.ReactElement {
  useLang() // 언어 전환 브로드캐스트 재렌더 (메인 창 설정에서 바꿔도 따라온다)
  const panelId = boot.panelId
  const slot = boot.slot
  const { state, elapsed, busy, begin, clearPermission, clearQuestion, answerQuestion, load, interruptTurn } = useAgentSession(
    (cb) => window.api.multi?.onEvent?.(panelId, cb) ?? (() => {})
  )
  const [meta, setMeta] = useState<PanelMeta>(() => metaFromBoot(boot))
  const patch = useEvent((p: Partial<PanelMeta>) => setMeta((m) => ({ ...m, ...p })))
  const [renaming, setRenaming] = useState(false)

  // 연 순간의 스냅샷 복원 — 이후는 panelId 구독이 라이브로 잇는다 (그리드 복원과 같은 규칙)
  useEffect(() => {
    if (boot.snapshot) load(sanitizeSnapshot(boot.snapshot as SessionState))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 창 타이틀(OS 작업 표시줄) — 패널 제목을 따라간다
  useEffect(() => {
    const title = meta.title || t('패널', 'Panel') + ' ' + boot.num
    document.title = `${title} — AgentCodeGUI`
  }, [meta.title, boot.num])

  // ── 페르시스트 — 초안·메타·스냅샷을 메인에 600ms 디바운스로. 창이 닫히면 이 마지막
  // 상태가 maPanelClosed로 그리드에 복귀한다(첫 페르시스트 전 닫힘은 부트 상태가 복귀분).
  const buildRef = useRef<() => PanelPopState>(() => boot)
  buildRef.current = () => ({
    panelId,
    slot,
    num: boot.num,
    title: meta.title,
    custom: meta.custom,
    locked: meta.locked,
    color: meta.color,
    cwd: meta.cwd,
    refDirs: meta.refDirs,
    picker: meta.picker,
    api: meta.api,
    input: meta.input,
    images: meta.images,
    queue: meta.queue,
    snapshot: snapshotForPersist(state)
  })
  const sig = state.status + ':' + state.messages.length
  useEffect(() => {
    const timer = setTimeout(() => window.api.multi?.panelPersist?.(buildRef.current()).catch(() => {}), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, sig])
  // 닫히는 순간의 최종 상태도 최선으로 — invoke가 프로세스 종료 전에 닿으면 마지막
  // 600ms의 타이핑까지 복귀분에 실린다 (못 닿아도 직전 디바운스분이 있다)
  useEffect(() => {
    const flush = (): void => void window.api.multi?.panelPersist?.(buildRef.current()).catch(() => {})
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  // ── 과금·계정 사용량 (SessionWindow와 같은 규칙) ──
  const [apiCfg, setApiCfg] = useState<ApiConfigStatus | null>(null)
  const [autoResume, setAutoResume] = useState<boolean>(() => getPref<boolean>('limitResume.on', false))
  const onAutoResumeChange = (on: boolean): void => {
    setPref('limitResume.on', on)
    setAutoResume(on)
  }
  useEffect(() => {
    const refresh = (): void => {
      setAutoResume(getPref<boolean>('limitResume.on', false))
      window.api.apiConfig
        .get()
        .then(setApiCfg)
        .catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const [usage, setUsage] = useState<UsageInfo>(EMPTY_USAGE)
  const fetchUsage = useEvent((fresh: boolean) => {
    window.api
      .getUsage(fresh, meta.picker.account || undefined)
      .then(setUsage)
      .catch(() => {})
  })
  useEffect(() => {
    fetchUsage(false)
    // 계정 바인딩이 바뀌면 그 계정의 한도로 갈아끼운다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.picker.account])
  // 실행이 끝날 때마다 강제 새로고침 — 방금 소비가 컨텍스트 팝오버에 바로 반영되게
  const prevBusyRef = useRef(busy)
  useEffect(() => {
    const was = prevBusyRef.current
    prevBusyRef.current = busy
    if (was && !busy) fetchUsage(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  // ── 전송 (ActiveSession.sendPanel의 단일 패널판 — panelId 고정) ──
  const send = useEvent(async (opts?: { text: string; images: string[]; picker: PickerState }) => {
    const text = (opts?.text ?? meta.input).trim()
    const imgs = opts?.images ?? meta.images
    const pk = opts?.picker ?? meta.picker
    if ((!text && imgs.length === 0) || busy) return
    if (text === '/clear') {
      window.api.multi?.cancel(panelId).catch(() => {})
      load(initialSessionState)
      patch({ ...(meta.locked ? {} : { title: '', custom: false }), ...(opts ? {} : { input: '', images: [] }) })
      limitResume.setHold(null)
      return
    }
    const cmd = commandOf(text)
    let dir = meta.cwd || ''
    if (!dir && state.session) dir = state.session.cwd
    const folderSwitched = !!state.session && state.messages.length > 0 && !sameCwd(state.session.cwd, dir)
    if (folderSwitched) load(initialSessionState)
    begin(text, cmd, imgs)
    const title = deriveTitle(text)
    patch({
      ...(opts ? {} : { input: '', images: [] }),
      title: meta.locked && meta.title ? meta.title : meta.custom && !folderSwitched ? meta.title : title,
      custom: meta.locked ? meta.custom : folderSwitched ? false : meta.custom
    })
    let promptForEngine = text
    if (!cmd) {
      const notes: string[] = []
      const mentions = extractMentions(text)
      if (mentions.length)
        notes.push(
          `${t('[멘션된 파일 — 필요하면 Read 도구로 확인하세요]', '[Mentioned files — read them with the Read tool if needed]')}\n${mentions.map((p) => '- ' + p).join('\n')}`
        )
      if (imgs.length)
        notes.push(`${t('[첨부 파일 — Read 도구로 확인하세요]', '[Attached files — check them with the Read tool]')}\n${imgs.map((p) => '- ' + p).join('\n')}`)
      if (notes.length) promptForEngine = `${text}\n\n${notes.join('\n\n')}`
    }
    const extraDirs = meta.refDirs.filter((p) => !sameCwd(p, dir))
    window.api.multi
      ?.run({
        panelId,
        prompt: promptForEngine,
        model: pk.model,
        effort: pk.effort,
        mode: pk.mode,
        engine: pk.engine,
        codexModel: pk.codexModel,
        cwd: dir,
        addDirs: extraDirs.length ? extraDirs : undefined,
        resume: state.session && sameCwd(state.session.cwd, dir) ? state.session.sessionId : undefined,
        useApi: meta.api || undefined,
        account: pk.account,
        codexAccount: pk.codexAccount
      })
      .catch(() => {})
  })

  // ── 한도 자동 이어서 — 팝아웃 동안엔 이 창이 대기표를 굴린다 (그리드 미러는 게이트로
  // 잠김). 큐 드레인 effect보다 먼저 선언 — 장전(ref 동기 갱신)이 같은 커밋의 드레인
  // 가드에 보이는 순서 보장 (그리드 ActiveSession과 같은 규칙).
  const engine: EngineId = meta.picker.engine === 'codex' ? 'codex' : 'claude'
  const limitResume = useLimitResume({
    state,
    busy,
    enabled: autoResume,
    apiMode: meta.api,
    engine,
    account: engine === 'codex' ? meta.picker.codexAccount : meta.picker.account,
    fable: engine === 'claude' && meta.picker.model === 'fable',
    holdKey: `pop:${panelId}`,
    send: (p) => void send({ text: p, images: [], picker: meta.picker })
  })

  // 예약 큐 — 이 창이 소유(그리드 쪽 큐는 팝아웃 때 비워짐). 드레인 규칙은 그리드와 동일.
  const schedule = useEvent(() => {
    if (!busy || (!meta.input.trim() && meta.images.length === 0)) return
    const id = crypto.randomUUID ? crypto.randomUUID() : `q-${Date.now()}-${meta.queue.length}`
    setMeta((m) => ({ ...m, input: '', images: [], queue: [...m.queue, { id, text: m.input, images: m.images, picker: m.picker }] }))
  })
  const drainingRef = useRef(false)
  const busyEdgeRef = useRef(busy)
  useEffect(() => {
    const was = busyEdgeRef.current
    busyEdgeRef.current = busy
    if (busy || !was || drainingRef.current || limitResume.holdRef.current) return
    const q = meta.queue
    let clears = 0
    while (clears < q.length && q[clears].text.trim() === '/clear') clears++
    const items = q.slice(0, Math.min(clears + 1, q.length))
    if (!items.length) return
    drainingRef.current = true
    setMeta((m) => ({ ...m, queue: m.queue.slice(items.length) }))
    void (async () => {
      try {
        for (const next of items) await send({ text: next.text, images: next.images, picker: next.picker })
      } finally {
        drainingRef.current = false
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, meta])

  // ── 중지·비우기·카드 응답 (그리드의 단일 패널판) ──
  const stop = useEvent(() => {
    if (busy) {
      interruptTurn()
      window.api.multi?.interrupt?.(panelId).catch(() => {})
    } else {
      for (const w of state.workflows) if (w.status === 'running') window.api.multi?.bgTask?.(panelId, { action: 'stop', id: w.id }).catch(() => {})
    }
    setMeta((m) => (m.queue.length ? { ...m, queue: [] } : m))
  })
  const clearConversation = useEvent(() => {
    if (busy) return
    window.api.multi?.cancel(panelId).catch(() => {})
    load(initialSessionState)
    patch({ ...(meta.locked ? {} : { title: '', custom: false }), input: '', images: [] })
    limitResume.setHold(null)
  })
  const onPermission = useEvent((behavior: 'allow' | 'allow_always' | 'deny') => {
    if (!state.pendingPermission) return
    window.api.multi?.respondPermission({ panelId, requestId: state.pendingPermission.requestId, behavior }).catch(() => {})
    clearPermission()
  })
  const onAnswer = useEvent((answers: string[][]) => {
    if (!state.pendingQuestion) return
    window.api.multi?.respondQuestion({ panelId, requestId: state.pendingQuestion.requestId, answers }).catch(() => {})
    answerQuestion(answers)
  })
  const onDismissQuestion = useEvent(() => {
    if (!state.pendingQuestion) return
    window.api.multi?.respondQuestion({ panelId, requestId: state.pendingQuestion.requestId, answers: null }).catch(() => {})
    clearQuestion()
  })

  // ── 작업 폴더·참조 폴더 (그리드와 같은 확인 카드 흐름) ──
  const [pendingFolder, setPendingFolder] = useState<string | null>(null)
  const curCwd = meta.cwd || state.session?.cwd || ''
  const requestFolder = useEvent((cwd: string) => {
    if (!cwd || !curCwd || sameCwd(cwd, curCwd) || state.messages.length === 0) {
      patch({ cwd })
      if (cwd) pushRecentDir(cwd)
      return
    }
    if (busy) return
    setPendingFolder(cwd)
  })
  const confirmFolder = useEvent(() => {
    if (!pendingFolder) return
    patch({ cwd: pendingFolder, ...(meta.locked ? {} : { title: '', custom: false }) })
    load(initialSessionState)
    limitResume.setHold(null)
    pushRecentDir(pendingFolder)
    setPendingFolder(null)
  })
  const pickFolder = useEvent(async () => {
    if (busy) return
    const dir = await window.api.pickDirectory()
    if (dir) requestFolder(dir)
  })
  const addRefDirPath = useEvent((dir: string) => {
    if (!dir) return
    setMeta((m) => {
      const cur = m.cwd || state.session?.cwd || ''
      if ((cur && sameCwd(dir, cur)) || m.refDirs.some((p) => sameCwd(p, dir)) || m.refDirs.length >= 8) return m
      return { ...m, refDirs: [...m.refDirs, dir] }
    })
  })
  const addRefDir = useEvent(async () => {
    const dir = await window.api.pickDirectory()
    if (dir) addRefDirPath(dir)
  })

  // ── 뷰어·모달 (그리드와 동일 부품, 이 창 스코프) ──
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [openSub, setOpenSub] = useState<string | null>(null)
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null)

  // 읽기 배율 — 크게 보기 카드와 같은 표면(multi.expand.zoom)을 쓴다
  const zoom = useZoom('multi.expand.zoom', true, 1)

  // Esc = 실행 중지 (그리드 패널 Esc와 같은 의미) — 열린 카드/모달이 있으면 그쪽에 양보
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (!busy && !state.workflows.some((w) => w.status === 'running')) return
      if (document.querySelector('.q-overlay, .q-mini, .wf-card, .set-dialog-overlay, .pr-overlay, .fv-overlay, .iv-overlay, .sa-overlay, .ctx-menu, .sel-bar, .hpop')) return
      e.preventDefault()
      stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, state.workflows])

  return (
    <div className="sw pwin">
      <div className="blurwarm" />
      {/* 창 드래그 띠 + 창 컨트롤 — 패널 헤더는 버튼이 많아 드래그 면으로 못 쓴다 */}
      <div className="pw-head">
        <span className="pw-drag" />
        <WinControls />
      </div>
      <div className="pw-body" ref={zoom.ref}>
        <PanelView
          slot={slot}
          num={boot.num}
          meta={meta}
          state={state}
          busy={busy}
          elapsed={elapsed}
          focused
          expanded
          usage={usage}
          budgetUsd={apiCfg?.budgetUsd ?? null}
          totalSpentUsd={apiCfg?.spentUsd ?? 0}
          zoom={zoom.zoom}
          onInput={(_s, text) => patch({ input: text })}
          onAddImages={(_s, paths) => setMeta((m) => ({ ...m, images: Array.from(new Set([...m.images, ...paths])) }))}
          onRemoveImage={(_s, i) => setMeta((m) => ({ ...m, images: m.images.filter((_, j) => j !== i) }))}
          onSend={() => void send()}
          onSchedule={() => schedule()}
          onRemoveQueued={(_s, id) => setMeta((m) => ({ ...m, queue: m.queue.filter((q) => q.id !== id) }))}
          onStop={() => stop()}
          onClear={() => clearConversation()}
          onPicker={(_s, p) => patch({ picker: p })}
          apiReady={!!apiCfg?.hasKey}
          apiReadyCodex={!!apiCfg?.hasOpenaiKey}
          onApiMode={(_s, next, eng) => {
            const ready = eng === 'codex' ? !!apiCfg?.hasOpenaiKey : !!apiCfg?.hasKey
            if (next && !ready) {
              window.api.openApiSettings?.().catch(() => {})
              return
            }
            patch({ api: next })
          }}
          limitHold={limitResume.hold}
          autoResume={autoResume}
          onCancelHold={() => limitResume.setHold(null)}
          onAutoResume={onAutoResumeChange}
          onPickFolder={() => void pickFolder()}
          onSelectFolder={(_s, p) => requestFolder(p)}
          onAddRefDir={() => void addRefDir()}
          onAddRefDirPath={(_s, p) => addRefDirPath(p)}
          onRemoveRefDir={(_s, p) => setMeta((m) => ({ ...m, refDirs: m.refDirs.filter((x) => !sameCwd(x, p)) }))}
          onOpenFile={(_s, rel) => setOpenFile(rel)}
          onOpenSubagent={(_s, id) => setOpenSub(id)}
          onOpenImage={(imgs, index) => setViewer({ images: imgs, index })}
          onBgTask={(_s, req: BgTaskRequest) => void window.api.multi?.bgTask?.(panelId, req).catch(() => {})}
          onRefreshUsage={() => fetchUsage(true)}
          onFocusPanel={() => {}}
          onToggleExpand={() => window.api.win.close()}
          renaming={renaming}
          onStartRename={() => setRenaming(true)}
          onRename={(_s, title, custom) => {
            setRenaming(false)
            if (title !== null) patch({ title, custom })
          }}
          onToggleLock={() => setMeta((m) => ({ ...m, locked: !m.locked }))}
          onCycleColor={() => setMeta((m) => ({ ...m, color: nextTag(m.color || defaultTag(slot)) }))}
          onPermission={(_s, b) => onPermission(b)}
          onAnswer={(_s, a) => onAnswer(a)}
          onDismissQuestion={() => onDismissQuestion()}
        />
      </div>
      <ZoomBadge pct={zoom.pct} show={zoom.flash} />

      {pendingFolder && (
        <FolderSwitchDialog from={curCwd} to={pendingFolder} onCancel={() => setPendingFolder(null)} onConfirm={confirmFolder} />
      )}
      {openFile && (
        <Suspense fallback={null}>
          <FileModal path={openFile} cwd={curCwd} diffs={state.diffs} onClose={() => setOpenFile(null)} />
        </Suspense>
      )}
      <SubAgentModal agent={openSub ? (state.subagents.find((a) => a.id === openSub) ?? null) : null} onClose={() => setOpenSub(null)} />
      {viewer && (
        <ImageViewer
          images={viewer.images}
          index={viewer.index}
          onIndexChange={(i) => setViewer((v) => (v ? { ...v, index: i } : v))}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  )
}
