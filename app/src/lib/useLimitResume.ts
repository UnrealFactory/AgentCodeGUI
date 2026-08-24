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
import {
  carriedAttempts,
  classifyLimitError,
  blockedResetsAt,
  codexBlockedResetsAt,
  codexUsageUnavailable,
  holdDelayMs,
  resumeVerdict,
  usageUnavailable,
  type LimitHold,
  type TurnItem
} from './limitResume'

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
  /**
   * ★ 3.0 M-UX R3 — **엔진(Rust)이 이 채팅의 대기표를 들고 있다.**
   *
   * 배선 R3가 부팅 재장전(`reload_state`/`ReloadHold`/`auto_resume`)을 넣으면서 한
   * 채팅에 재개 주체가 **둘**이 될 수 있게 됐다(R2 §R2.9가 미리 적어 둔 접점):
   * 렌더러의 이 훅과 엔진의 `check_hold`. 둘 다 살아 있으면 리셋 시각에 **전송이 두 번**
   * 나간다. 진실 하나를 고른다 — `chat:status.hold`가 실려 오면(= 엔진이 그 채팅의
   * 대기표를 재장전했다) **렌더러는 손을 뗀다**: 장전도, 타이머도, 소진도 하지 않는다.
   * 표시와 「이어가기」 버튼은 그 신호를 그대로 그린다(LimitHoldBar `managed`).
   *
   * 신호가 없으면(옛 셸·통합 스토어 꺼짐) 값은 false이고 동작은 2.6.2와 글자 그대로 같다.
   */
  managed?: boolean
}

export interface LimitResumeHandle {
  hold: LimitHold | null
  // 큐 드레인 가드가 같은 커밋에서 동기적으로 읽는 미러 (state 반영은 다음 렌더라 늦다)
  holdRef: MutableRefObject<LimitHold | null>
  setHold: (h: LimitHold | null) => void // 취소(✕)·재시작 복원(본채팅) 공용
  /** ★R28c RCAP — 사용자가 누른 「이어가기」(`LimitHoldBar`의 비-`managed` 갈래).
   *  엔진 `ChatRuntime::resume_now`의 짝이다: 표를 걷고 그 자리에서 보내되,
   *  **재발사 계수를 0으로 되돌린다** — 사람이 누른 재개는 몇 번이든 사람의 판단이고
   *  자동 상한이 세는 대상이 아니다(엔진 `consume_hold(auto=false)`와 같은 규약). */
  resumeNow: () => void
}

export function useLimitResume(o: LimitResumeSurface): LimitResumeHandle {
  const [hold, holdState] = useState<LimitHold | null>(null)
  const holdRef = useRef<LimitHold | null>(null)

  // ★R28c RCAP — **눈감고 쏜 재개의 연속 횟수.** 엔진 `ChatRuntime::auto_resume_streak`의
  // 짝이고, 표에 실려 가는 값이 `LimitHold.attempts`다.
  //
  // 왜 ref인가: 대기표는 **발사와 함께 걷힌다**(소진 effect가 `setHold(null)` 후 보낸다).
  // 그 턴이 같은 한도로 또 죽어 새 표가 설 때, 물려줄 값을 들고 있는 자리가 표 바깥에
  // 하나 필요하다. R28b에는 그 자리가 없어서 새 표가 늘 백지로 섰고, 상한이 한 대기표
  // 안에서만 살아 5시간에 27회를 쐈다(RVERD 확인 크리틱 R1 §3.1).
  const firesRef = useRef(0)
  // ★R28d WCAP — **직전에 쏜 표의 리셋 시각.** 엔진 `ChatRuntime::auto_resume_at`의 짝이고,
  // 구분자 ①(창이 진짜로 넘어갔나 — `windowRolled`)이 읽는 유일한 값이다. `firesRef`와
  // 같은 이유로 표 바깥에 있다: 표는 발사와 함께 걷히는데, 비교할 상대는 그 걷힌 표다.
  // 늘 `firesRef`와 **함께** 쓰인다 — 따로 놓이면 "계수는 2인데 비교할 시각은 어제 것"이 된다.
  const fireResetsRef = useRef<number | null>(null)

  const setHold = (h: LimitHold | null): void => {
    // ★R28c RCAP — **표가 사라지면 재발사 연쇄도 사라진다.** ✕(대기 취소)·/clear·폴더
    // 변경·다른 계정으로 갈아탐·사용자의 직접 전송이 전부 이 문 하나를 지나고, 전부
    // "사람 손이 닿았다"는 뜻이다(엔진 `enqueue`의 `origin == User → streak = 0` 짝).
    // 예외는 **자동 발사** 하나뿐이고, 그 두 자리(소진 effect · `resumeNow`)는 이 줄
    // **뒤에** 계수를 자기 값으로 다시 놓는다 — 순서가 계약이다.
    if (!h) {
      firesRef.current = 0
      fireResetsRef.current = null
    }
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
    // ★R28c RCAP — 판정을 두 단으로 나눈다. 앞단은 "방금 돌던 턴이 **착지했나**"이고,
    // 그 착지가 한도가 **아니면** 재발사 연쇄를 끊는다(엔진 `runtime.rs`의
    // `!limited && hold.is_none() → auto_resume_streak = 0`과 같은 자리). 안 끊으면
    // 어제 쌓인 계수 2가 오늘 처음 서는 대기표를 태어나자마자 「자동 멈춤」으로 만든다.
    const ran = prev === 'analyzing' || prev === 'working'
    const landed = o.state.status !== 'analyzing' && o.state.status !== 'working'
    if (!ran || !landed) return
    const msgs = o.state.messages
    const last = msgs[msgs.length - 1]
    const found =
      o.state.status === 'error' && last && last.kind === 'msg' && last.error ? classifyLimitError(last.text) : null
    if (!found?.hit) {
      firesRef.current = 0
      fireResetsRef.current = null
      return
    }
    if (o.apiMode || o.state.interrupted) return
    // ★ R3 — 엔진이 이 채팅의 대기표를 들고 있으면 렌더러는 장전하지 않는다(재개 주체 하나)
    if (o.managed) return
    // 재전송 폴백 — 세션이 만들어지기 전에 죽은 첫 턴은 '이어서'로 재개할 세션이 없다
    let lastPrompt = ''
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.kind === 'msg' && m.role === 'user' && m.text.trim()) {
        lastPrompt = m.text
        break
      }
    }
    // ★R28d WCAP — **물려받을지 말지를 여기서 가른다.** RCAP의 계승은 "한도로 죽은
    // 착지마다 +1"이라 5시간을 꽉 채워 일하고 다음 창에서 막힌 재개까지 헛발질로 셌다.
    // 시각을 아는 판은 시계가(창이 넘어갔나), 모르는 판은 일한 흔적이 판정한다 —
    // 엔진 `arm_hold`가 같은 자리에서 같은 둘을 같은 순서로 본다(`carriedAttempts` 주석).
    // ref도 같이 놓는다: 다음 소진이 `(attempts ?? 0) + 1`로 다시 만들지만, 표가 취소·
    // 재장전으로 갈리는 사이 둘이 어긋나 있으면 읽는 사람이 어느 쪽을 믿을지 모른다.
    const nowSec = Math.floor(Date.now() / 1000)
    const carried = carriedAttempts(
      firesRef.current,
      fireResetsRef.current,
      found.resetsAt,
      msgs as readonly TurnItem[],
      nowSec
    )
    firesRef.current = carried
    const next: LimitHold = {
      key: o.holdKey,
      engine: o.engine,
      account: o.account,
      resetsAt: found.resetsAt,
      fable: o.fable,
      lastPrompt,
      at: Date.now(),
      // ★R28c RCAP — **이전 표의 재발사 계수를 물려받는다**(엔진 `arm_hold`가
      // `auto_resume_streak`를 표에 싣는 것과 같다). 이 한 줄이 없으면 상한은 한
      // 대기표 안에서만 살아 있고, 쏜 턴이 또 죽을 때마다 백지 표가 다시 서서 주기가
      // 영원히 돈다. 0은 안 싣는다 — 영속 형태를 R28b와 같게 두려는 것이다.
      ...(carried > 0 ? { attempts: carried } : {})
    }
    setHold(next) // ref가 즉시 갱신돼 큐 드레인 가드가 이번 커밋에서 본다
    // 리셋 시각 정제 — 신선 usage 조회로 "막고 있는 창"의 해제 시각을 얻는다 (문구
    // 꼬리보다 정확하고, 꼬리 없는 배너형 문구엔 이것만이 유일한 시각 소스다)
    const refine = (at: number | null): void => {
      if (at == null || holdRef.current?.at !== next.at) return
      setHold({ ...holdRef.current, resetsAt: at })
    }
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
    // ★R28c RCAP — 대기표가 **아직 서 있는데** 새 실행이 떴다 = 사람이 직접 보냈다
    // (자동 재발사는 표를 먼저 걷고 쏘므로 이 자리에 오지 않는다). 계수는 `setHold(null)`이
    // 끊는다 — 위 그 문에 규칙 하나로 모여 있다.
    if (holdRef.current && holdRef.current.key === o.holdKey) setHold(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.busy])

  // 발화 — 장전 시점 판단을 믿지 않고 신선 usage로 재검증한다(엔진 armHoldIdle 규약).
  // 착지는 셋이다(`resumeVerdict`): 아직 막혔다 → 그 해제 시각으로 재장전 / **못 물어봤다
  // → 유지하고 다시 묻는다** / 풀렸다 → ready 표시만(전송은 아래 소진 effect가 한다).
  //
  // ★3.0 — 가운데 갈래가 확인 크리틱 R1 실패1의 자리다. 조회가 실패하면 창 넷이 전부
  // `null`인 값이 오는데 R1까지는 그걸 「막는 창 없음 = 풀렸다」로 읽어 **눈감고 전송**
  // 했다(실측: `CCG_NO_NET=1` + 살아 있는 계정 → ready=true). 실패는 "풀렸다"가 아니다.
  const fire = async (armedAt: number): Promise<void> => {
    const cur = holdRef.current
    if (!cur || cur.at !== armedAt || !oRef.current.enabled || oRef.current.managed) return
    const nowSec = Math.floor(Date.now() / 1000)
    let still: number | null = null
    let unavailable = true // 물어보기 전에는 근거가 0이다 — 던지는 경로도 여기로 착지한다
    try {
      if (cur.engine === 'claude') {
        const u = await window.api.getUsage(true, cur.account)
        unavailable = usageUnavailable(u)
        // +60s: 1분 안에 풀릴 창은 풀린 셈 — 경계에서 재장전이 진동하지 않게
        still = blockedResetsAt(u, cur.fable, nowSec + 60)
      } else {
        const list = await window.api.codexAuth.accountsUsage()
        const acct = cur.account ? list.find((a) => a.email === cur.account) : list[0]
        unavailable = codexUsageUnavailable(acct?.windows)
        still = codexBlockedResetsAt(acct?.windows, nowSec + 60)
      }
    } catch {
      unavailable = true // 조회가 던졌다 = 물어보지 못했다(심은 던지지 않지만 계약은 아니다)
    }
    if (holdRef.current?.at !== cur.at) return // 재검증 사이 지워졌거나 새로 장전됨
    const v = resumeVerdict(cur, still, unavailable, nowSec)
    // 타이머 effect가 새 시각(또는 재확인 간격)으로 다시 건다
    if (v.kind === 'hold') setHold({ ...cur, resetsAt: v.resetsAt, probes: v.probes, at: Date.now() })
    // ★R28c RCAP — `paused`면 `ready`는 켜되 소진 effect는 쏘지 않는다(엔진 `auto_paused`).
    //   타이머 effect도 `ready`에서 멎으므로 이 표는 **아무것도 태우지 않고** 버튼만 기다린다.
    else setHold({ ...cur, ready: true, ...(v.paused ? { autoPaused: true } : {}) })
  }

  // 대기표 타이머 — 리셋 시각(+90s 여유)에 발화, 시각 미상이면 10분 간격 프로브,
  // 조회 실패로 재장전된 표는 15초부터 배로 늘어나는 재확인 간격(`holdDelayMs`).
  // 대기표 갱신(정제·재장전)이나 토글 해제가 이전 타이머를 걷는다.
  useEffect(() => {
    if (!hold || hold.ready || !o.enabled || o.managed) return
    const id = window.setTimeout(() => void fire(hold.at), holdDelayMs(hold, Date.now()))
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold, o.enabled, o.managed])

  // ready 소진 — 소유 키가 일치하고(본채팅: 그 채팅으로 돌아옴) idle이고 화면별 가드를
  // 통과할 때 전송. 세션이 있으면 '이어서'(resume이 문맥 보유), 없으면 원문 재전송.
  useEffect(() => {
    const cur = hold
    // ★R28c RCAP — `autoPaused`는 **여기서** 막는다. 표는 `ready`(사용자가 누를 수 있다)
    //   지만 자동 발사는 접힌 상태다 — 엔진이 `auto_paused`로 예약분까지 잠그는 것과 같은
    //   착지이고, 이 줄이 5시간에 27회 쏘던 주기의 마지막 문이다.
    if (!cur?.ready || cur.autoPaused || !o.enabled || o.busy || o.managed) return
    if (cur.key !== o.holdKey) return
    if (o.canSend && !o.canSend(cur)) return
    setHold(null)
    const prompt = o.state.session ? contPrompt() : cur.lastPrompt
    if (!prompt) return
    // 눈감고 쏘는 재개 한 발 — 표는 방금 걷혔으니 계수는 ref가 나른다(다음 장전이 물려받는다).
    firesRef.current = (cur.attempts ?? 0) + 1
    // ★R28d WCAP — 함께 나르는 두 번째 값: **이 표가 걸려 있던 리셋 시각.** 다음 한도
    // 문구의 시각이 이보다 뒤면 창이 진짜로 넘어간 것이다(구분자 ①). `setHold(null)`이
    // 방금 둘 다 0/null로 놓았으므로 이 두 줄의 순서가 계약이다(위 `setHold` 주석).
    fireResetsRef.current = cur.resetsAt
    o.send(prompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold, o.enabled, o.busy, o.holdKey, o.managed, o.readyDep])

  // ★ R3 — 엔진이 대기표를 들고 있다는 신호가 **나중에** 왔다(렌더러가 먼저 장전한 뒤
  // 재시작 재장전이 도착하는 순서). 그러면 같은 사실을 두 벌 들고 있는 것이므로 렌더러
  // 사본을 접는다 — 안 그러면 배너가 두 벌이고, `managed`가 꺼지는 순간 낡은 표가 발화한다.
  useEffect(() => {
    if (!o.managed) return
    if (holdRef.current && holdRef.current.key === o.holdKey) setHold(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.managed, o.holdKey])

  // ★R28c RCAP — 사용자가 누르는 출구. 자동이 접힌 표(`autoPaused`)의 **유일한** 발사구다.
  //
  // 계수를 0으로 되돌리는 것이 요점이다: 안 되돌리면 이 발사가 또 한도로 죽었을 때 새 표가
  // `attempts:3`으로 서서 **누르자마자 다시 자동 멈춤**이 되고, 버튼은 한 번 쓰고 버리는
  // 것이 된다. 엔진도 같은 이유로 사람이 누른 재개는 세지 않는다(`consume_hold(auto=false)`).
  const resumeNow = (): void => {
    const cur = holdRef.current
    const oc = oRef.current
    if (!cur || oc.busy || oc.managed) return
    setHold(null) // 계수는 여기서 0이 된다(위 `setHold`) — 누른 재개는 세지 않는다
    const prompt = oc.state.session ? contPrompt() : cur.lastPrompt
    if (prompt) oc.send(prompt)
  }

  // 카운트다운 틱은 여기 없다 — 표시 갱신은 LimitHoldBar(Chat.tsx)가 자기 30초 틱으로
  // 스스로 재렌더한다 (멀티 패널은 memo라 호스트 재렌더가 배너까지 닿지 않는다)

  return { hold, holdRef, setHold, resumeNow }
}
