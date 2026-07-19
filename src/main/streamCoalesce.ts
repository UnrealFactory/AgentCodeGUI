import type { EngineEvent } from '@shared/protocol'

// 스트리밍 이벤트 IPC 배칭 — 엔진은 SDK 텍스트 델타(토큰)마다 이벤트를 하나씩 내고,
// 그대로 흘리면 긴 답변 하나가 수천 건의 webContents.send(각각 구조화 클론 직렬화 +
// 렌더러 디스패치 + 리렌더)가 된다. 여기서 assistant-stream 델타는 이어 붙이고
// thinking은 전체 텍스트 교체라 최신 것만 남겨, FLUSH_MS 간격으로 묶어 보낸다.
// 그 밖의 모든 이벤트는 버퍼를 먼저 비운 뒤 즉시 통과 — 이벤트 순서는 그대로다.
// 16ms(한 프레임)는 공개 애니메이션(SmoothMarkdown)이 어차피 델타를 흘려 보여주므로
// 체감 지연이 없다.
const FLUSH_MS = 16

export function coalesceStream(send: (event: EngineEvent) => void): (event: EngineEvent) => void {
  let queue: EngineEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!queue.length) return
    const q = queue
    queue = []
    for (const e of q) send(e)
  }
  const buffer = (event: EngineEvent): void => {
    queue.push(event)
    if (!timer) timer = setTimeout(flush, FLUSH_MS)
  }
  return (event) => {
    const last = queue[queue.length - 1]
    if (event.type === 'assistant-stream') {
      if (last?.type === 'assistant-stream' && last.runId === event.runId && last.messageId === event.messageId) {
        queue[queue.length - 1] = { ...last, delta: last.delta + event.delta }
      } else buffer(event)
      return
    }
    if (event.type === 'thinking') {
      if (last?.type === 'thinking' && last.runId === event.runId) queue[queue.length - 1] = event
      else buffer(event)
      return
    }
    flush()
    send(event)
  }
}
