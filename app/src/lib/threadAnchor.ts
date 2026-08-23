/* ============================================================
 * 읽던 자리 앵커 — **메시지 id**로 저장하는 스레드 스크롤 위치.
 *
 * 왜 픽셀이 아닌가(크리틱 M-UX R1 §2-⑧ `raise.scroll`, R2 §R2.7의 설계):
 * 접힌 자리는 렌더 대상에서 빠져 **언마운트**되고, 되올릴 때 그 대화가 앉는 자리는
 * 대개 **다른 크기**다(6분할의 3번 칸 → n1 전폭 IDE 크롬). 실측으로 같은 대화의
 * `scrollHeight`가 6962 → 4676으로 바뀐다 — 폭이 넓어져 줄바꿈이 줄고, 스크롤러의
 * `zoom`도 .8 → 1로 바뀐다(`.ma-grid .ma-panel .ma-p-thread{zoom:.8}` ↔
 * `.ma-grid.n1 …{zoom:1}`). 옛 `scrollTop`을 그대로 꽂으면 **다른 문단**에 착지한다.
 * 숫자만 보는 하네스는 통과하겠지만 사용자에게는 거짓이다.
 *
 * 그래서 저장하는 것은 두 가지다:
 *   · `id`  — 뷰포트 맨 위에 걸쳐 있던 **메시지의 id**(꼬리 윈도잉 좌표계와 무관하다)
 *   · `off` — 그 메시지 상단이 뷰포트 상단에서 몇 px 위/아래였나(**시각 px**)
 * 되올릴 때는 그 메시지를 다시 찾아 같은 `off`에 놓는다. 창 크기·zoom·윈도 시작
 * 인덱스가 전부 달라져도 "읽던 문단이 그 자리에 있다"는 사실만 보존된다.
 *
 * 모듈 레지스트리인 이유는 settled.ts와 같다: 앵커의 임자는 **언마운트된 컴포넌트**라
 * 자기 state에 둘 수 없다. 키는 자리 정체성(`chan(sessionId, slot)`)이다.
 * ============================================================ */

export interface ThreadAnchor {
  /** 뷰포트 맨 위에 걸쳐 있던 메시지 id */
  id: string
  /** 그 메시지 상단의 뷰포트 상단 대비 오프셋(시각 px, 보통 ≤ 0) */
  off: number
  /** 저장 시각 — 오래된 앵커는 버린다(같은 자리에 다른 대화가 앉았을 수 있다) */
  at: number
}

/** 자리 하나에 하나. 자리는 최대 6 + 창 몇 개라 상한은 넉넉하다. */
const store = new Map<string, ThreadAnchor>()
const CAP = 64
/** 이보다 오래된 앵커는 안 쓴다 — 접었다 한참 뒤에 되올리면 그 사이 대화가 자랐다. */
const MAX_AGE_MS = 30 * 60_000

export function putAnchor(key: string, a: ThreadAnchor | null): void {
  if (!key) return
  if (!a) {
    store.delete(key)
    return
  }
  store.delete(key) // 삽입 순서를 갱신해 CAP 회수가 LRU가 되게
  store.set(key, a)
  while (store.size > CAP) {
    const first = store.keys().next()
    if (first.done) break
    store.delete(first.value)
  }
}

/** 읽고 **소비**한다 — 한 번 착지한 앵커로 두 번 착지하지 않게. */
export function takeAnchor(key: string): ThreadAnchor | null {
  if (!key) return null
  const a = store.get(key)
  if (!a) return null
  store.delete(key)
  return Date.now() - a.at > MAX_AGE_MS ? null : a
}

/** 하네스·진단용 — 소비하지 않고 들여다본다. */
export function peekAnchor(key: string): ThreadAnchor | null {
  return (key && store.get(key)) || null
}

/** 하네스·진단용 — 지금 들고 있는 앵커 전부. */
export function anchorSnapshot(): Record<string, ThreadAnchor> {
  return Object.fromEntries(store)
}

/**
 * **착지 기록** — 복원이 그 메시지를 실제로 어디에 놓았나.
 *
 * 화면 위 "뷰포트 맨 위 문단"으로 재는 것은 못 믿는다: `.thread > .msg`에
 * `content-visibility:auto`가 걸려 있어 **같은 메시지의 높이가 마운트마다 다르다**
 * (아직 안 그려진 항목은 `contain-intrinsic-size` 자리표시자다). 실측에서 앵커 메시지가
 * 계약대로 −163px에 놓였는데도, 그 메시지의 높이가 163→147로 줄어 "맨 위 문단"은 다음
 * 항목이 됐다. 계약은 **그 메시지의 상단 오프셋**이므로 저울도 그것이어야 한다.
 */
export interface ThreadLanding {
  id: string
  /** 저장했던 오프셋 */
  want: number
  /** 실제로 놓인 오프셋 */
  got: number
  /** 그때의 scrollTop(자리 크기가 같은 되올림이면 저장 때와 같아야 한다) */
  top: number
  at: number
}
const landings = new Map<string, ThreadLanding>()

export function noteLanding(key: string, l: ThreadLanding): void {
  if (!key) return
  landings.set(key, l)
  while (landings.size > CAP) {
    const first = landings.keys().next()
    if (first.done) break
    landings.delete(first.value)
  }
}
export function landingSnapshot(): Record<string, ThreadLanding> {
  return Object.fromEntries(landings)
}

// 하네스 창구 — `window.__ccgChatEv`(api/unified.ts)와 같은 규약의 읽기 전용 진단.
// 이게 없으면 "되올렸는데 자리가 틀리다"의 원인이 저장인지 복원인지 못 가른다.
if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __ccgAnchors?: () => Record<string, ThreadAnchor>
    __ccgLandings?: () => Record<string, ThreadLanding>
  }
  w.__ccgAnchors = anchorSnapshot
  w.__ccgLandings = landingSnapshot
}
