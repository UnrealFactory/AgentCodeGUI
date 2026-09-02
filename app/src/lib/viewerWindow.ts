// 파일 뷰어 독립 창 — 호스트(메인·추가 채팅·팝아웃 창) 쪽의 얇은 배관.
//
// "파일을 어디로 열지"는 클릭 순간에 **동기**로 알아야 한다(카드 뷰어는 클릭 즉시 뜬다 —
// 그 경로에 왕복을 끼우지 않는다). 그래서 끈적한 모드(`viewer:state`)를 여기 캐시에 두고,
// 부팅 때 한 번 읽고(부팅 페이로드라 왕복 없음) 이후는 main의 브로드캐스트(`viewer:mode`)로
// 따라간다 — 어느 창이 모드를 바꿨든 모든 창의 다음 클릭이 같은 답을 낸다.
//
// 페이로드는 "그 파일 하나에 필요한 것만"이다: 세션 전체 diffs 대신 그 파일의 diff 하나.
// (뷰어 창은 대화를 갖지 않는다 — 질문 전송·「창 안으로」는 main이 원래 창으로 되돌린다.)
import type { FileDiff, ViewerOpenPayload } from '@shared/protocol'

let mode = false
let inited = false

/** 부팅 때 한 번(loadPrefs와 같은 자리) — 캐시 채우기 + 브로드캐스트 구독. */
export async function initViewerWindow(): Promise<void> {
  if (inited) return
  inited = true
  const api = window.api.viewer
  if (!api) return // 동결 2.6.2 preload — 뷰어 창 없음(카드 뷰어만)
  try {
    mode = !!(await api.state())?.window
  } catch {
    mode = false
  }
  api.onMode((m) => {
    mode = !!m?.window
  })
}

/** 지금 파일 열기가 독립 창으로 가야 하는가(동기). */
export function viewerWindowMode(): boolean {
  return mode
}

/** 모드 전환 — 이 창은 즉시, 다른 창은 main 브로드캐스트로 따라온다. */
export function setViewerWindowMode(on: boolean): void {
  mode = on
  void window.api.viewer?.setMode(on).catch(() => {})
}

/** 카드 뷰어의 prop 묶음 → 뷰어 창 페이로드(그 파일의 diff 하나만 추린다). */
export function viewerPayload(p: {
  path: string
  cwd: string
  diffs?: Record<string, FileDiff>
  override?: ViewerOpenPayload['override']
  askable?: boolean
}): ViewerOpenPayload {
  // 카드 뷰어의 조회 규칙과 같다(FileModal: diffs[effPath.replace(/\\/g, '/')])
  const diff = p.diffs?.[p.path.replace(/\\/g, '/')] ?? null
  return { path: p.path, cwd: p.cwd, diff, override: p.override ?? null, askable: !!p.askable }
}

/** 뷰어 창의 diffs prop — 페이로드의 diff 하나를 카드 뷰어의 조회 키로 되돌린다. */
export function diffsOf(p: ViewerOpenPayload): Record<string, FileDiff> | undefined {
  return p.diff ? { [p.path.replace(/\\/g, '/')]: p.diff } : undefined
}

/**
 * 파일 하나를 독립 창으로. `false`면 창을 못 세운 것이고 호출 창은 **카드 뷰어로 물러난다**
 * (모드는 그대로 — 다음 클릭이 다시 창을 노린다). 모드가 꺼져 있으면 부르지 말 것
 * (`viewerWindowMode()`로 먼저 가른다 — 그 판정이 동기여야 카드가 클릭 즉시 뜬다).
 */
export async function openInViewerWindow(p: Parameters<typeof viewerPayload>[0]): Promise<boolean> {
  const api = window.api.viewer
  if (!api) return false
  try {
    return await api.open(viewerPayload(p))
  } catch {
    return false
  }
}
