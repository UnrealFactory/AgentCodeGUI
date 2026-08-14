// 한도 자동 이어서 — 대화 하나(세션 리듀서 하나)에 붙는 상태 머신 훅. 본채팅·멀티
// 패널(슬롯당 1개)·추가 채팅 창이 같은 기계를 공유한다. 판정 자체는 lib/limitResume
// (순수 — PoC: scripts/poc-limit-resume.mjs)이고, 여기는 React 배선만 둔다.
//
// 기계의 생애: 장전(방금 돌던 턴이 한도 에러로 종결) → 타이머(리셋+90s, 미상이면 10분
// 프로브) → 발화 재검증(신선 usage로 "정말 풀렸나" — 아직이면 재장전) → ready →
// 소진(그 대화가 소유 키 일치·idle·화면별 가드 통과일 때 전송). 새 실행이 시작되면
// (busy 상승 에지, 소유 키 일치) 대기표는 자동 해제된다 — 수동 재전송도 같은 착지점.
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { t } from './i18n'
import type { SessionState } from '../store/session'
import { classifyLimitError, blockedResetsAt, codexBlockedResetsAt, resumeDelayMs, type LimitHold } from './limitResume'

// 재개 프롬프트 — 세션(resume)이 대화 문맥을 다 알고 있는 경우의 '이어서'
const contPrompt = (): string =>
  t('사용 한도가 초기화됐어. 직전에 하던 작업을 이어서 계속해줘.', 'The usage limit has reset — continue the work you were doing.')

export interface LimitResumeSurface {
  state: SessionState
  busy: boolean
  enabled: boolean // 자동 이어서 토글(전역 pref) — 꺼져 있으면 장전은 하되 타이머·전송 안 함
  apiMode: boolean // API 과금 실행이면 장전 안 함 — 구독 한도와 무관한 사고들이다
  engine: 'claude' | 'codex'
  account?: string // 실행 계정(이메일) — 재검증 usage 조회도 이 계정 기준
  fable: boolean // 실행 모델이 Fable — Fable 주간 창을 게이트로 볼지
  holdKey: string // 소유 식별자 — 본채팅: activeChatId(전환되는 단일 리듀서), 그 외: 고정값
  send: (prompt: string) => void // 풀렸을 때 전송 (초안을 지우지 않는 경로여야 한다)
  canSend?: (hold: LimitHold) => boolean // 화면별 추가 가드 (본채팅: 스냅샷 로드 완료)
  readyDep?: unknown // canSend가 보는 외부 상태 — ready 소진 effect의 재평가 트리거
}

export interface LimitResumeHandle {
  hold: LimitHold | null
  // 큐 드레인 가드가 같은 커밋에서 동기적으로 읽는 미러 (state 반영은 다음 렌더라 늦다)
  holdRef: MutableRefObject<LimitHold | null>
  setHold: (h: LimitHold | null) => void // 취소(✕)·재시작 복원(본채팅) 공용
}

export function useLimitResume(o: LimitResumeSurface): LimitResumeHandle {
  const [hold, holdState] = useState<LimitHold | null>(null)
  const holdRef = useRef<LimitHold | null>(null)
  const setHold = (h: LimitHold | null): void => {
    holdRef.current = h
    holdState(h)
  }
  // 최신 옵션 미러 — 타이머·비동기 재검증이 낡은 렌더의 클로저를 읽지 않게
  const oRef = useRef(o)
  oRef.current = o

  // 장전 — 방금 돌던 턴(prev-busy 가드)이 에러로 끝났고 스레드 끝이 그 에러 말풍선일 때.
  // 가드 없이 status=error만 보면 복원·전환으로 error인 채 로드된 옛 대화를 여는 것만으로
  // 재장전돼 자동 전송되는 사고가 난다.
  const prevStatusRef = useRef(o.state.status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = o.state.status
    if (o.state.status !== 'error' || (prev !== 'analyzing' && prev !== 'working')) return
    if (o.apiMode || o.state.interrupted) return
    const msgs = o.state.messages
    const last = msgs[msgs.length - 1]
    if (!last || last.kind !== 'msg' || !last.error) return
    const found = classifyLimitError(last.text)
    if (!found.hit) return
    // 재전송 폴백 — 세션이 만들어지기 전에 죽은 첫 턴은 '이어서'로 재개할 세션이 없다
    let lastPrompt = ''
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.kind === 'msg' && m.role === 'user' && m.text.trim()) {
        lastPrompt = m.text
        break
      }
    }
    const next: LimitHold = {
      key: o.holdKey,
      engine: o.engine,
      account: o.account,
      resetsAt: found.resetsAt,
      fable: o.fable,
      lastPrompt,
      at: Date.now()
    }
    setHold(next) // ref가 즉시 갱신돼 큐 드레인 가드가 이번 커밋에서 본다
    // 리셋 시각 정제 — 신선 usage 조회로 "막고 있는 창"의 해제 시각을 얻는다 (문구
    // 꼬리보다 정확하고, 꼬리 없는 배너형 문구엔 이것만이 유일한 시각 소스다)
    const refine = (at: number | null): void => {
      if (at == null || holdRef.current?.at !== next.at) return
      setHold({ ...holdRef.current, resetsAt: at })
    }
    const nowSec = Math.floor(Date.now() / 1000)
    if (next.engine === 'claude')
      window.api
        .getUsage(true, next.account)
        .then((u) => refine(blockedResetsAt(u, next.fable, nowSec)))
        .catch(() => {})
    else
      window.api.codexAuth
        .accountsUsage()
        .then((list) => {
          const acct = next.account ? list.find((a) => a.email === next.account) : list[0]
          refine(codexBlockedResetsAt(acct?.windows, nowSec))
        })
        .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.state.status])

  // 이 대화(소유 키 일치)에서 새 실행이 시작되면 대기표 해제 — 수동 재전송이든 자동
  // 재개든, 이번 실행이 또 막히면 그때 새 표가 장전된다. 본채팅에서 다른 채팅(키
  // 불일치)으로 전환해 보낸 실행은 이 표를 건드리지 않는다.
  const prevBusyRef = useRef(o.busy)
  useEffect(() => {
    const was = prevBusyRef.current
    prevBusyRef.current = o.busy
    if (!o.busy || was) return
    if (holdRef.current && holdRef.current.key === o.holdKey) setHold(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.busy])

  // 발화 — 장전 시점 판단을 믿지 않고 신선 usage로 재검증한다(엔진 armHoldIdle 규약).
  // 아직 막혀 있으면 그 해제 시각으로 재장전, 풀렸으면 ready 표시만 — 전송은 아래
  // 소진 effect가 조건이 맞을 때 수행한다.
  const fire = async (armedAt: number): Promise<void> => {
    const cur = holdRef.current
    if (!cur || cur.at !== armedAt || !oRef.current.enabled) return
    const nowSec = Math.floor(Date.now() / 1000)
    try {
      let still: number | null = null
      if (cur.engine === 'claude') {
        // +60s: 1분 안에 풀릴 창은 풀린 셈 — 경계에서 재장전이 진동하지 않게
        still = blockedResetsAt(await window.api.getUsage(true, cur.account), cur.fable, nowSec + 60)
      } else {
        const list = await window.api.codexAuth.accountsUsage()
        const acct = cur.account ? list.find((a) => a.email === cur.account) : list[0]
        still = codexBlockedResetsAt(acct?.windows, nowSec + 60)
      }
      if (still != null) {
        if (holdRef.current?.at !== cur.at) return // 재검증 사이 지워졌거나 새로 장전됨
        setHold({ ...cur, resetsAt: still, at: Date.now() }) // 타이머 effect가 새 시각으로 다시 건다
        return
      }
    } catch {
      // 조회 실패 — 풀린 것으로 두고 진행. 아직 한도면 에러가 새 대기표를 장전한다
    }
    if (holdRef.current?.at !== cur.at) return
    setHold({ ...cur, ready: true })
  }

  // 대기표 타이머 — 리셋 시각(+90s 여유)에 발화, 시각 미상이면 10분 간격 프로브.
  // 대기표 갱신(정제·재장전)이나 토글 해제가 이전 타이머를 걷는다.
  useEffect(() => {
    if (!hold || hold.ready || !o.enabled) return
    const id = window.setTimeout(() => void fire(hold.at), resumeDelayMs(hold.resetsAt, Date.now()))
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold, o.enabled])

  // ready 소진 — 소유 키가 일치하고(본채팅: 그 채팅으로 돌아옴) idle이고 화면별 가드를
  // 통과할 때 전송. 세션이 있으면 '이어서'(resume이 문맥 보유), 없으면 원문 재전송.
  useEffect(() => {
    const cur = hold
    if (!cur?.ready || !o.enabled || o.busy) return
    if (cur.key !== o.holdKey) return
    if (o.canSend && !o.canSend(cur)) return
    setHold(null)
    const prompt = o.state.session ? contPrompt() : cur.lastPrompt
    if (prompt) o.send(prompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold, o.enabled, o.busy, o.holdKey, o.readyDep])

  // 카운트다운 틱은 여기 없다 — 표시 갱신은 LimitHoldBar(Chat.tsx)가 자기 30초 틱으로
  // 스스로 재렌더한다 (멀티 패널은 memo라 호스트 재렌더가 배너까지 닿지 않는다)

  return { hold, holdRef, setHold }
}
