import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiConfigStatus, AppUser, BgTaskRequest, EngineId, RunRequest, SessionPersistPayload, UserProfile, UsageInfo } from '@shared/protocol'

// 백그라운드 셸 컨트롤 — 이 창의 세션 엔진으로 라우팅 (memo된 WorkBar용 고정 함수)
const onBgTaskSession = (req: BgTaskRequest): void => {
  window.api.session?.bgTask(req).catch(() => {})
}
import { getPref, setPref } from '../lib/prefs'
import {
  useAgentSession,
  initialSessionState,
  sameCwd,
  commandOf,
  liveMsgIndex,
  sanitizeSnapshot,
  snapshotForPersist,
  type SessionState
} from '../store/session'
import { extractMentions } from '../lib/mentions'
import {
  ChatHeader,
  ChatFind,
  Composer,
  MessageView,
  WorkingIndicator,
  WelcomeState,
  SelectionToolbar,
  hasRunningBash,
  nextMode,
  pickerModelOf,
  WorkBar,
  PermissionModal,
  QuestionModal,
  useThreadFollow,
  type PickerState,
  type ScheduledMsg
} from './Chat'
import { pushRecentDir } from '../lib/recentDirs'
import { ImageViewer } from './ImageViewer'
import { SubAgentModal } from './AgentPanel'
import { FileModal } from './FileModal'
import { FolderSwitchDialog } from './FolderSwitchDialog'
import { useZoom, ZoomBadge, mergeRefs } from './zoom'
import { MouseGestureLayer, clearGesture, sessionWindowGesture, type GestureAction } from './mouseGesture'
import { IconChevDown } from './icons'

// ── 추가 채팅 (세션 창) ────────────────────────────────────────
// A standalone conversation in its OWN native OS window (freely resizable, movable to a
// second monitor), running on this window's own engine via the `session` channel — fully
// independent of the main window's code/chat/multi work.
//
// 2.0 컨셉(PoC): 사이드바만 없고 본채팅 화면 그대로다 — ChatHeader(폴더 picker·찾기·창
// 컨트롤이 곧 타이틀바), WelcomeState, .thread 스레드, WorkBar, 진짜 Composer, 최근 파일
// 탭, 선택 툴바, 폴더 확인 카드까지 전부 본채팅과 같은 부품·같은 규칙으로 동작한다.
// 기본 작업 폴더는 바탕화면(빈 cwd → 엔진 폴백)이고, 헤더 폴더 칩에서 언제든 바꾼다.

const DEFAULT_PICKER: PickerState = { model: 'opus', effort: 'high', mode: 'auto' }
// 마지막에 고른 모델·effort·모드를 기억한다 → 새 창을 열면 그 값이 기본이 된다.
const PICKER_KEY = 'session.picker'
const MODEL_IDS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORT_IDS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']
const MODE_IDS = ['normal', 'plan', 'acceptEdits', 'auto', 'bypass']
// 저장값이 낡거나 손상됐을 수 있으니 필드마다 검증하고, 이상하면 기본값으로 채운다.
function sanitizePicker(p?: Partial<PickerState> | null): PickerState {
  return {
    model: p?.model && MODEL_IDS.includes(p.model) ? p.model : DEFAULT_PICKER.model,
    effort: p?.effort && EFFORT_IDS.includes(p.effort) ? p.effort : DEFAULT_PICKER.effort,
    mode: p?.mode && MODE_IDS.includes(p.mode) ? p.mode : DEFAULT_PICKER.mode,
    // 실행 엔진 + Codex 모델 — codex가 아니면 필드를 지워 기본(Claude)으로
    engine: p?.engine === 'codex' ? 'codex' : undefined,
    codexModel: typeof p?.codexModel === 'string' && p.codexModel ? p.codexModel : undefined,
    // 실행 계정(이메일) — 형태만 확인 (등록 목록 대조는 picker·엔진이 담당)
    account: typeof p?.account === 'string' && p.account ? p.account : undefined,
    codexAccount: typeof p?.codexAccount === 'string' && p.codexAccount ? p.codexAccount : undefined
  }
}
function loadPicker(): PickerState {
  try {
    const raw = localStorage.getItem(PICKER_KEY)
    if (raw) return sanitizePicker(JSON.parse(raw))
  } catch {
    /* 손상·미지원 → 기본값 */
  }
  return DEFAULT_PICKER
}
const FALLBACK_USER: AppUser = { name: 'User', avatarText: 'U', avatarColor: '#6366F1' }
const EMPTY_USAGE: UsageInfo = { fiveHour: null, weekly: null, weeklyFable: null, extraCredit: null }

function userFromProfile(p: UserProfile): AppUser {
  const name = p.nickname.trim()
  return { name: name || 'User', avatarText: (name.slice(0, 1) || 'U').toUpperCase(), avatarColor: p.color }
}

// 이 창의 작업 폴더는 마지막에 고른 값을 기억한다(창을 다시 열어도 유지). 빈 값이면 엔진이
// 바탕화면으로 폴백하므로, '' = 바탕화면(기본)을 뜻한다. 최근 폴더 목록은 일반·멀티
// 채팅과 공유하는 lib/recentDirs — 헤더 팝오버(FolderPop)가 직접 읽는다.
const CWD_KEY = 'session.cwd'

export function SessionWindow(): React.ReactElement {
  const { state, busy, begin, clearPermission, clearQuestion, answerQuestion, load } = useAgentSession((cb) =>
    window.api.session?.onEvent?.(cb) ?? (() => {})
  )
  const [max, setMax] = useState(false)
  // 이 창의 작업 폴더('' = 바탕화면 기본). 폴더를 지정하면 실행·@멘션이 모두 그 폴더 기준.
  const [cwd, setCwd] = useState('')
  const [user, setUser] = useState<AppUser>(FALLBACK_USER)
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [queue, setQueue] = useState<ScheduledMsg[]>([])
  // 새 창은 마지막에 고른 모델·effort·모드로 시작한다(localStorage 복원, 손상 시 기본값)
  const [picker, setPicker] = useState<PickerState>(loadPicker)
  // Shift+Tab 순환처럼 등록 시점이 고정된 핸들러가 최신 picker를 읽기 위한 ref
  const pickerRef = useRef(picker)
  pickerRef.current = picker
  // 피커를 바꾸면 다음 새 창의 기본값이 되도록 저장한다
  const savePicker = (p: PickerState): void => {
    setPicker(p)
    try {
      localStorage.setItem(PICKER_KEY, JSON.stringify(p))
    } catch {
      /* localStorage 불가 — 이번 창에서만 유지 */
    }
  }
  // Fable 5 정책 거부(claude)·모델 수용량 초과(codex) → 엔진이 폴백 모델로 전환·재시도한
  // 경우 이 창의 picker도 따라 바꾼다 (메인 채팅과 같은 규칙 — 안 바꾸면 매번 반복).
  // 엔진 주도 변경이라 setPicker — 다음 새 창의 기본값(localStorage)은 안 건드린다.
  useEffect(
    () =>
      window.api.session?.onEvent?.((e) => {
        if (e.type !== 'model-fallback') return
        if (e.engine === 'codex') {
          setPicker((p) => (p.codexModel === e.toModel ? p : { ...p, codexModel: e.toModel }))
          return
        }
        const next = pickerModelOf(e.toModel)
        if (next) setPicker((p) => (p.model === next ? p : { ...p, model: next }))
      }) ?? undefined,
    []
  )
  const [usage, setUsage] = useState<UsageInfo>(EMPTY_USAGE)
  // 과금(구독/API) — 메인과 같은 전역 pref(api.mode)에서 시작한다. 이 창엔 설정 모달이
  // 없어서 키 없이 API를 고르면 IPC로 메인 창의 설정 → API 탭을 대신 연다. 키 존재/예산은
  // 창 포커스마다 다시 읽어 메인에서 방금 등록/삭제한 키를 따라잡는다.
  const [apiMode, setApiMode] = useState<boolean>(() => getPref<boolean>('api.mode', false))
  const [apiCfg, setApiCfg] = useState<ApiConfigStatus | null>(null)
  useEffect(() => {
    const refresh = (): void => {
      window.api.apiConfig
        .get()
        .then((s) => {
          setApiCfg(s)
          // 두 엔진 키가 모두 사라졌을 때만 API 모드를 끈다 (메인과 동일 가드)
          if (!s.hasKey && !s.hasOpenaiKey) {
            setApiMode((on) => {
              if (on) setPref('api.mode', false)
              return false
            })
          }
        })
        .catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const onApiModeChange = (next: boolean, engine?: EngineId): void => {
    const ready = engine === 'codex' ? !!apiCfg?.hasOpenaiKey : !!apiCfg?.hasKey
    if (next && !ready) {
      // ?. 가드: HMR로 렌더러만 갈린 구 preload엔 이 함수가 없을 수 있다 (App과 동일)
      window.api.openApiSettings?.().catch(() => {})
      return
    }
    setApiMode(next)
    setPref('api.mode', next)
  }
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null)
  const [openWorkFile, setOpenWorkFile] = useState<string | null>(null)
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null)
  const openSubagent = openSubagentId ? state.subagents.find((a) => a.id === openSubagentId) ?? null : null
  // 작업 폴더 변경 확인 카드 — 본채팅과 동일한 규칙(잃을 대화가 있으면 확인 후 리셋)
  const [pendingFolder, setPendingFolder] = useState<string | null>(null)
  // 저장본 복원이 끝났는지 — 끝나기 전엔 보고/persist를 막아 저장된 대화를 빈 상태로 덮지 않는다
  const [hydrated, setHydrated] = useState(false)
  const hydratedRef = useRef(false)
  // 마지막 활동(프롬프트 전송) 시각 — persist에 실어 사이드바 상대 시간이 된다
  const lastActiveRef = useRef<number | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 스크롤 뷰포트를 state로도 추적 — follow 훅·제스처 레이어가 재바인딩되도록 (App과 동일)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // Ctrl+휠 글자 크기 — 추가 채팅 전용 배율(session.zoom): 본채팅(chat.zoom)·멀티
  // (multi.zoom)와 독립이라 창마다 다른 읽기 크기를 유지할 수 있다
  const chatZoom = useZoom('session.zoom')
  const swScrollRef = useMemo(() => mergeRefs(scrollRef, setScrollEl, chatZoom.ref), [chatZoom.ref])
  // 턴을 막고 있는 포그라운드 Bash가 있을 때만 셸 팝오버에 "건너뛰기"(Ctrl+B) 버튼을 노출
  const canSkipWait = useMemo(() => hasRunningBash(state.messages), [state.messages])
  // 스레드 바닥 따라가기 — 본채팅과 같은 래치·점프 버튼·스트리밍 rAF 고정 (공용 훅)
  const follow = useThreadFollow(scrollEl, busy)

  const started = state.messages.length > 0
  const onRefreshUsage = (): void => {
    window.api.getUsage(true, picker.account).then(setUsage).catch(() => {})
  }

  // 실행이 끝나면 API 누적 사용액을 다시 읽는다 — 작업 바의 남은 예산이 바로 맞아떨어지게
  useEffect(() => {
    if (state.status === 'done' || state.status === 'error') {
      window.api.apiConfig.get().then(setApiCfg).catch(() => {})
    }
  }, [state.status])

  // ── 작업 폴더 — 본채팅과 같은 확인 카드 흐름 ─────────────────────
  const persistCwd = (dir: string): void => {
    try {
      localStorage.setItem(CWD_KEY, dir)
    } catch {
      /* localStorage 불가 — 이번 창에서만 유지 */
    }
  }
  // 이 창의 폴더 사용(선택·복원)을 공유 최근 폴더 목록에 반영 — 일반·멀티 채팅과 공유
  useEffect(() => {
    if (cwd) pushRecentDir(cwd)
  }, [cwd])
  // 세션 ID는 폴더에 묶여 있어(본채팅과 동일) 다른 폴더로는 대화를 이어갈 수 없다 —
  // 잃을 대화가 있으면 확인 카드를 먼저 띄우고, 같은 폴더 재선택/빈 대화는 조용히 적용한다.
  const requestFolder = (dir: string): void => {
    if (!dir) return
    const cur = cwd || state.session?.cwd || ''
    if (!cur || sameCwd(dir, cur) || state.messages.length === 0) {
      setCwd(dir)
      persistCwd(dir)
      return
    }
    if (busy) return // 진행 중 턴은 이 폴더에서 작업한다 — 끝나거나 중지한 뒤에
    setPendingFolder(dir)
  }
  // 변경 — 스레드/예약 큐를 비우고 새 폴더에서 새 대화 (본채팅의 confirmFolder)
  const confirmFolder = (): void => {
    if (!pendingFolder) return
    load(initialSessionState)
    setQueue([])
    setCwd(pendingFolder)
    persistCwd(pendingFolder)
    setPendingFolder(null)
  }
  const pickFolder = async (): Promise<void> => {
    if (busy) return // 실행 중 폴더 변경은 어차피 막힌다 — 픽커도 열지 않는다
    const dir = await window.api.pickDirectory()
    if (dir) requestFolder(dir)
  }

  // 내가 보낸 메시지(오래된→최신) — 작성칸에서 ↑/↓로 다시 불러오기 (채팅과 동일)
  const sentHistory = useMemo(
    () =>
      state.messages
        .filter((m): m is Extract<SessionState['messages'][number], { kind: 'msg' }> => m.kind === 'msg' && m.role === 'user')
        .map((m) => m.text)
        .filter((t) => t.trim().length > 0),
    [state.messages]
  )

  // 메인 창 사이드바 '추가 채팅' 목록용 보고 — 첫 프롬프트에서 딴 제목 + 진행 상태.
  // 복원 전 보고는 저장된 제목을 ''로 덮으므로 hydrated 이후에만 보낸다.
  // ?. 가드: HMR로 렌더러만 갈린 구 preload엔 report가 없을 수 있다 (openApiSettings와 동일)
  const winTitle = sentHistory[0]?.trim().slice(0, 80) ?? ''
  useEffect(() => {
    if (!hydrated) return
    window.api.session?.report?.({ title: winTitle, status: state.status }).catch(() => {})
  }, [hydrated, winTitle, state.status])

  // ── 영속화 (persist) ────────────────────────────────────────
  // 메인 채팅과 같은 규칙(600ms 디바운스) — 대화·폴더·picker·초안을 채팅 레코드로 저장해
  // 창을 닫아도, 앱을 재시작해도 사이드바 '추가 채팅'에서 이 대화를 다시 연다.
  // persistNowRef: 닫기 직전의 flush(최종 스냅샷)와 디바운스 저장이 같은 최신 상태를
  // 읽도록 매 렌더 갱신되는 ref로 둔다.
  const persistNowRef = useRef<() => void>(() => {})
  persistNowRef.current = () => {
    if (!hydratedRef.current) return
    const payload: SessionPersistPayload = {
      title: winTitle,
      status: state.status,
      cwd,
      snapshot: snapshotForPersist(state),
      picker,
      draft: input,
      draftImages: images,
      empty: state.messages.length === 0,
      updatedAt: lastActiveRef.current
    }
    window.api.session?.persist?.(payload).catch(() => {})
  }
  useEffect(() => {
    if (!hydrated) return
    const t = setTimeout(() => persistNowRef.current(), 600)
    return () => clearTimeout(t)
  }, [hydrated, state, cwd, picker, input, images])
  // 닫기 flush — 메인이 창을 정리하기 직전 마지막 스냅샷을 요청한다 (닫기=저장 후 정리)
  useEffect(() => window.api.session?.onFlushRequest?.(() => persistNowRef.current()) ?? (() => {}), [])

  // avatar/name from the shared saved profile; usage for the composer strip
  useEffect(() => {
    window.api.getProfile().then((p) => p && setUser(userFromProfile(p))).catch(() => {})
  }, [])
  // 사용량은 이 창의 실행 계정 기준 — 계정 picker로 바꾸면 한도도 그 계정 것으로 갱신
  useEffect(() => {
    window.api.getUsage(false, picker.account).then(setUsage).catch(() => {})
  }, [picker.account])

  // ── 복원 (hydrate) ──────────────────────────────────────────
  // 사이드바에서 다시 연 채팅이면 저장본(대화·폴더·picker·초안)을 되살리고, 새 창이면
  // 마지막에 고른 작업 폴더만 복원한다. 폴더는 그 사이 지워졌을 수 있으니 존재를 확인
  // 하고, 없으면 바탕화면으로. 대화 이어가기는 스냅샷의 session.sessionId resume이 담당.
  // ?. 가드: HMR로 렌더러만 갈린 구 preload엔 hydrate가 없을 수 있다 (report와 동일)
  useEffect(() => {
    let alive = true
    ;(async () => {
      const h = (await window.api.session?.hydrate?.().catch(() => null)) ?? null
      if (!alive) return
      if (h) {
        load(sanitizeSnapshot(h.snapshot))
        // picker는 사용자 조작이 아니므로 setPicker — 새 창 기본값(localStorage)은 안 건드린다
        if (h.picker) setPicker(sanitizePicker(h.picker as Partial<PickerState>))
        if (typeof h.draft === 'string' && h.draft) setInput(h.draft)
        if (Array.isArray(h.draftImages)) setImages(h.draftImages.filter((x): x is string => typeof x === 'string'))
      }
      let dir = h?.cwd || ''
      if (!dir) {
        try {
          dir = localStorage.getItem(CWD_KEY) || ''
        } catch {
          /* localStorage 불가 */
        }
      }
      if (!dir) return
      const ok = await window.api.dirExists(dir).catch(() => false)
      if (!alive) return
      if (ok) setCwd(dir)
      else if (!h) {
        try {
          localStorage.removeItem(CWD_KEY)
        } catch {
          /* no-op */
        }
      }
    })().finally(() => {
      // 실패해도 hydrated는 세운다 — 아니면 persist가 영원히 막혀 새 대화도 저장이 안 된다
      if (alive) {
        hydratedRef.current = true
        setHydrated(true)
      }
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [])

  // 마우스 제스처 RU(최대화 토글) 라벨용 — 이 창의 네이티브 최대화 상태
  useEffect(() => window.api.onWinState((s) => setMax(s.maximized)), [])
  useEffect(() => {
    window.api.win.isMaximized().then(setMax)
  }, [])

  // Enter (from anywhere outside a field) jumps into the composer; Shift+Tab cycles the
  // run mode — same as the main app. A permission/question card owns the keyboard while up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('.q-overlay, .q-mini, .pr-overlay')) return
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        const p = pickerRef.current
        savePicker({ ...p, mode: nextMode(p.mode) })
        return
      }
      if (e.shiftKey || e.key !== 'Enter') return
      const ae = document.activeElement as HTMLElement | null
      const interactive =
        !!ae && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(ae.tagName) || ae.isContentEditable)
      if (!interactive) {
        e.preventDefault()
        composerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc = 실행 중지 (본채팅과 동일) — 열린 모달/메뉴가 있으면 그쪽의 Esc에 양보한다
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !busy) return
      if (
        document.querySelector(
          '.q-overlay, .q-mini, .set-dialog-overlay, .pr-overlay, .fv-overlay, .iv-overlay, .sa-overlay, .ctx-menu, .sel-bar'
        )
      )
        return
      e.preventDefault()
      window.api.session?.cancel().catch(() => {})
      setQueue([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy])

  // 새 메시지/생각 갱신 — 래치가 켜져 있을 때만 바닥 고정 (본채팅과 동일)
  useEffect(() => {
    follow.snapIfStuck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.messages, state.thinkingText])

  // ── attachments (same as 채팅) ───────────────────────────────
  const addImagePaths = (paths: string[]): void => {
    if (paths.length) setImages((prev) => Array.from(new Set([...prev, ...paths])))
  }
  const addImagesFromPicker = async (): Promise<void> => {
    addImagePaths(await window.api.pickAttachments())
  }
  const openViewer = (imgs: string[], index: number): void => setViewer({ images: imgs, index })

  // 툴 로그/WorkBar에서 연 파일 — 뷰어로
  const onOpenToolFile = (path: string): void => setOpenWorkFile(path)

  // /clear — reset this window's conversation (client command, same as 본채팅).
  // 컴포저의 /clear와 스레드의 ↑↓ 제스처가 같은 착지점을 쓴다.
  const clearConversation = (): void => {
    if (busy) return
    load(initialSessionState)
    setInput('')
    setImages([])
    setQueue([])
  }

  const runPrompt = (text: string, opts?: { images?: string[]; picker?: PickerState; keepDraft?: boolean }): void => {
    const imgs = opts?.images ?? images
    const pk = opts?.picker ?? picker
    if ((!text.trim() && imgs.length === 0) || busy) return
    if (text.trim() === '/clear') {
      clearConversation()
      return
    }
    // 내장 슬래시 명령(/init·/compact·/review…) — 본채팅처럼 요약 카드로 렌더되게 추적
    const cmd = commandOf(text)
    // 전송 = 따라가기 재개 — 위를 읽던 중이어도 내 메시지와 답이 시야로 들어온다
    follow.pin()
    lastActiveRef.current = Date.now() // 사이드바 상대 시간의 기준 — 프롬프트 전송 시각
    begin(text, cmd, imgs)
    // fold mention/attachment notes into the prompt so the engine reads them (same as 채팅)
    let promptForEngine = text
    if (!cmd) {
      const notes: string[] = []
      const mentions = extractMentions(text)
      if (mentions.length) notes.push(`[멘션된 파일 — 필요하면 Read 도구로 확인하세요]\n${mentions.map((p) => '- ' + p).join('\n')}`)
      if (imgs.length) notes.push(`[첨부 파일 — Read 도구로 확인하세요]\n${imgs.map((p) => '- ' + p).join('\n')}`)
      if (notes.length) promptForEngine = `${text}\n\n${notes.join('\n\n')}`
    }
    const req: RunRequest = {
      prompt: promptForEngine,
      model: pk.model,
      effort: pk.effort,
      mode: pk.mode,
      // 실행 엔진(claude/codex) + Codex GPT 모델 — 생략하면 Claude
      engine: pk.engine,
      codexModel: pk.codexModel,
      cwd, // 지정한 작업 폴더. 빈 값이면 엔진이 바탕화면으로 폴백
      resume: state.session?.sessionId,
      // 과금 모드 — API를 골랐으면 이 창의 실행도 API 키로 과금 (메인과 같은 전역 설정)
      useApi: apiMode || undefined,
      // 실행 계정 — 클로드는 격리 CLAUDE_CONFIG_DIR, Codex는 격리 CODEX_HOME (미지정=기본 계정)
      account: pk.account,
      codexAccount: pk.codexAccount
    }
    if (!opts?.keepDraft) {
      setInput('')
      setImages([])
    }
    window.api.session?.run(req).catch(() => {})
  }

  // queue a draft while busy → auto-send when the run ends (same as 채팅)
  const scheduleMessage = (): void => {
    if (!busy || (!input.trim() && images.length === 0)) return
    const id = crypto.randomUUID ? crypto.randomUUID() : `q-${queue.length}-${state.messages.length}`
    setQueue((q) => [...q, { id, text: input, images, picker }])
    setInput('')
    setImages([])
    composerRef.current?.focus()
  }
  const prevBusyRef = useRef(busy)
  useEffect(() => {
    const was = prevBusyRef.current
    prevBusyRef.current = busy
    if (busy || !was || queue.length === 0) return
    const next = queue[0]
    setQueue((q) => q.slice(1))
    runPrompt(next.text, { images: next.images, picker: next.picker, keepDraft: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue])

  // "더 자세히" — 본채팅과 동일: 선택한 글을 <selection> 태그로 감싸 컴포저에 붙인다
  const onElaborateSelection = (text: string): void => {
    const base = `<selection>\n${text.trim()}\n</selection>\n\n이 부분 더 자세히 설명해줘`
    setInput((cur) => (cur.trim() ? cur + '\n\n' + base : base))
    requestAnimationFrame(() => {
      const el = composerRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    })
  }

  // 파일 뷰어의 질문 패널 — 경로·줄 범위가 붙은 <selection> 블록과 함께 즉시 전송
  // (대화 진행 중이면 예약 큐로). 컴포저 초안은 건드리지 않는다. (본채팅과 동일)
  const onAskSelection = (p: { path: string; text: string; from: number | null; to: number | null; question: string }): void => {
    const lines = p.from != null && p.to != null ? ` lines="${Math.min(p.from, p.to)}-${Math.max(p.from, p.to)}"` : ''
    const prompt = `<selection file="${p.path}"${lines}>\n${p.text}\n</selection>\n\n${p.question}`
    setOpenWorkFile(null)
    if (busy) {
      const id = crypto.randomUUID ? crypto.randomUUID() : `q-${queue.length}-${state.messages.length}`
      setQueue((q) => [...q, { id, text: prompt, images: [], picker }])
    } else {
      runPrompt(prompt, { images: [], keepDraft: true })
    }
  }

  const onPermission = (behavior: 'allow' | 'allow_always' | 'deny'): void => {
    if (!state.pendingPermission) return
    window.api.session?.respondPermission({ requestId: state.pendingPermission.requestId, behavior }).catch(() => {})
    clearPermission()
  }
  const onAnswer = (answers: string[][]): void => {
    if (!state.pendingQuestion) return
    window.api.session?.respondQuestion({ requestId: state.pendingQuestion.requestId, answers }).catch(() => {})
    answerQuestion(answers) // 카드를 닫으며 문답 흔적을 스레드에 남긴다
  }
  const onDismissQuestion = (): void => {
    if (!state.pendingQuestion) return
    window.api.session?.respondQuestion({ requestId: state.pendingQuestion.requestId, answers: null }).catch(() => {})
    clearQuestion()
  }

  const lastMsg = state.messages[state.messages.length - 1]
  const streamingAnswer = lastMsg?.kind === 'msg' && lastMsg.role === 'assistant' && !lastMsg.error
  const showWorking =
    (state.thinkingText != null || !streamingAnswer) && !state.pendingQuestion && !state.pendingCommand

  // ↑←는 여기서도 창을 하나 더 연다. ↑/↓는 본채팅과 같은 래치 규칙(맨 위로/맨 아래로),
  // ↑↓는 컴포저 /clear와 같은 대화 비우기. →↑는 최대화 토글(라벨은 현재 상태를 따라감),
  // ↓→ 닫기 — 대화는 저장돼 사이드바 '추가 채팅'에 남는다(실행 중이면 턴을 마저 돌리고
  // 정리, 삭제는 사이드바 X). 그래서 확인 없이 닫는다.
  const gestures: GestureAction[] = [
    { pattern: 'U', label: '맨 위로', run: () => follow.scrollTop() },
    { pattern: 'D', label: '맨 아래로', run: () => follow.jumpBottom() },
    sessionWindowGesture(),
    clearGesture(clearConversation),
    { pattern: 'RU', label: max ? '이전 크기로' : '창 최대화', run: () => window.api.win.toggleMaximize() },
    { pattern: 'DR', label: '창 닫기', run: () => window.api.win.close() }
  ]

  return (
    <div className="sw">
      <div className="blurwarm" />
      {/* 본채팅 화면 그대로(사이드바만 없음) — ChatHeader가 곧 이 창의 타이틀바
          (전체 드래그 + 폴더 picker + 찾기 + 창 컨트롤). 창 컨트롤은 메인 프로세스가
          호출 창(webContents) 기준으로 이 창을 제어한다. */}
      <div className="chat chat--code">
        <ChatHeader
          title={winTitle || '추가 채팅'}
          cwd={cwd || state.session?.cwd || ''}
          placeholder="바탕화면"
          onSelectFolder={requestFolder}
          onBrowseFolder={pickFolder}
        />
        <ZoomBadge pct={chatZoom.pct} show={chatZoom.flash} />
        <div className="chat-scroll scroll" ref={swScrollRef}>
          {!started && !busy ? (
            <WelcomeState
              userName={user.name}
              variant={cwd ? 'agent' : 'chat'}
              onPick={(t) => {
                setInput(t)
                composerRef.current?.focus()
              }}
            />
          ) : (
            <div className="thread" style={{ zoom: chatZoom.zoom, '--z': chatZoom.zoom } as React.CSSProperties}>
              {state.messages.map((m, idx) => (
                <MessageView
                  key={m.id}
                  item={m}
                  live={idx === liveMsgIndex(state.messages) && m.kind === 'msg' && m.role === 'assistant' && !m.error}
                  running={busy}
                  onOpenFile={onOpenToolFile}
                  onOpenImage={openViewer}
                />
              ))}
              {busy && showWorking && <WorkingIndicator text={state.thinkingText} />}
            </div>
          )}
          {follow.showJump && (
            <div className="jump-bottom-wrap">
              <button className="jump-bottom has-tip" data-tip="맨 아래로" aria-label="맨 아래로" onClick={follow.jumpBottom}>
                <IconChevDown size={17} />
              </button>
            </div>
          )}
        </div>
        <SelectionToolbar scrollRef={scrollRef} onElaborate={onElaborateSelection} />
        <ChatFind scrollRef={scrollRef} />
        <MouseGestureLayer target={scrollEl} actions={gestures} />
        <WorkBar
          todos={state.todos}
          files={state.files}
          subagents={state.subagents}
          bgTasks={state.bgTasks}
          busy={busy}
          canSkipWait={canSkipWait}
          onBgTask={onBgTaskSession}
          usage={usage}
          contextTokens={state.result?.contextTokens ?? null}
          contextWindow={state.result?.contextWindow ?? null}
          model={picker.model}
          apiMode={apiMode}
          chatSpentUsd={state.spentUsd ?? 0}
          budgetUsd={apiCfg?.budgetUsd ?? null}
          totalSpentUsd={apiCfg?.spentUsd ?? 0}
          tokenTotals={state.tokenTotals}
          engine={picker.engine}
          codexAccount={picker.codexAccount}
          onOpenFile={(f) => onOpenToolFile(f.path)}
          onOpenSubagent={(a) => setOpenSubagentId(a.id)}
          onRefreshUsage={onRefreshUsage}
        />
        <Composer
          value={input}
          onChange={setInput}
          history={sentHistory}
          onSend={() => runPrompt(input)}
          onStop={() => {
            window.api.session?.cancel().catch(() => {})
            setQueue([])
          }}
          onSchedule={scheduleMessage}
          queued={queue}
          onRemoveQueued={(id) => setQueue((q) => q.filter((m) => m.id !== id))}
          busy={busy}
          started={started}
          picker={picker}
          setPicker={savePicker}
          apiMode={apiMode}
          apiReady={!!apiCfg?.hasKey}
          apiReadyCodex={!!apiCfg?.hasOpenaiKey}
          onApiModeChange={onApiModeChange}
          images={images}
          onPickImages={addImagesFromPicker}
          onAddImagePaths={addImagePaths}
          onRemoveImage={(i) => setImages((a) => a.filter((_, idx) => idx !== i))}
          onOpenImage={openViewer}
          contextTokens={state.result?.contextTokens ?? null}
          contextWindow={state.result?.contextWindow ?? null}
          usage={usage}
          showContext={false}
          cwd={cwd}
          mentionBase={cwd}
          inputRef={composerRef}
        />
      </div>

      <PermissionModal permission={state.pendingPermission} onRespond={onPermission} />
      <QuestionModal question={state.pendingQuestion} onAnswer={onAnswer} onDismiss={onDismissQuestion} />

      {pendingFolder && (
        <FolderSwitchDialog
          from={cwd || state.session?.cwd || ''}
          to={pendingFolder}
          onCancel={() => setPendingFolder(null)}
          onConfirm={confirmFolder}
        />
      )}

      {/* 작업 바/툴 로그에서 연 파일 뷰어 — cwd는 엔진이 실제로 쓴 폴더(세션 보고값) */}
      {openWorkFile && (
        <FileModal
          path={openWorkFile}
          cwd={state.session?.cwd ?? cwd}
          diffs={state.diffs}
          onClose={() => setOpenWorkFile(null)}
          onAskSelection={onAskSelection}
        />
      )}
      <SubAgentModal agent={openSubagent} onClose={() => setOpenSubagentId(null)} />

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
