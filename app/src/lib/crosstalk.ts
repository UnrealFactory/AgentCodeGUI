/* ============================================================================
 * 대화 연결(M10) — **렌더러 쪽 창구 + 긴급 정지**.
 *
 * R1은 라우터를 끝까지 만들고 표면을 R2로 미뤘다. 크리틱의 판정이 그 순서를 뒤집었다
 * (D7): *"위험한 절반(라우팅)은 완성됐고, 안전한 절반(사람이 누르는 정지)은 채널만
 * 있다."* — `grep -rn crosstalk app/src`가 **0건**이었다. 이 파일이 그 0을 닫는다.
 *
 * ## 이 파일의 규칙
 *
 *  1. **정지는 언제나 한 번의 동작이어야 한다.** 설정 모달을 열어야 누를 수 있으면
 *     그건 긴급 정지가 아니다 — 그래서 전역 알약 + 전역 단축키(Ctrl+Shift+.)를 둘 다 둔다.
 *  2. **켜져 있을 때만 보인다.** 기본값이 꺼짐인 기능의 정지 버튼을 상시 띄우면
 *     화면만 시끄럽고 "이게 뭐지"가 늘어난다. 꺼져 있으면 위험이 0이므로 자리도 0이다.
 *  3. **상태의 주인은 셸이다.** 여기서 낙관적으로 그리지 않는다 — 정지를 눌렀는데
 *     화면만 꺼지고 실제로는 도는 상황이 이 기능에서 가장 나쁜 거짓말이다.
 *     `crosstalk:state`(REPLACE)가 오면 그때 바뀐다.
 * ========================================================================== */
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { TalkConfig } from '@shared/protocol'

const CONFIG = 'crosstalk:config'
const SET = 'crosstalk:set'
const STOP = 'crosstalk:stop'
const STATE = 'crosstalk:state'

/** 꺼짐 — 채널이 없는 구 빌드에서도 화면이 이 값으로 조용히 산다. */
export const TALK_OFF: TalkConfig = { version: 1, enabled: false, boards: {}, maxHops: 4, maxMsgs: 12, maxFanout: 3, stoppedAt: null }

function asConfig(v: unknown): TalkConfig | null {
  const o = v as (Partial<TalkConfig> & { __unimplemented?: boolean }) | null
  if (!o || o.__unimplemented || typeof o.enabled !== 'boolean') return null
  return {
    version: 1,
    enabled: o.enabled,
    boards: (o.boards ?? {}) as Record<string, true>,
    maxHops: Number(o.maxHops) || TALK_OFF.maxHops,
    maxMsgs: Number(o.maxMsgs) || TALK_OFF.maxMsgs,
    maxFanout: Number(o.maxFanout) || TALK_OFF.maxFanout,
    stoppedAt: typeof o.stoppedAt === 'number' ? o.stoppedAt : null,
    purged: typeof o.purged === 'number' ? o.purged : undefined
  }
}

async function call(channel: string, payload: unknown[]): Promise<TalkConfig | null> {
  try {
    return asConfig(await invoke('ipc_call', { channel, payload }))
  } catch {
    return null
  }
}

export const readTalkConfig = (): Promise<TalkConfig | null> => call(CONFIG, [])
export const setTalkConfig = (patch: Record<string, unknown>): Promise<TalkConfig | null> => call(SET, [patch])
/** 보드 하나의 옵트인. **끄면 키가 사라진다**(false를 남기면 "예전에 켰던 보드"가 쌓인다). */
export const setTalkBoard = (board: string, on: boolean): Promise<TalkConfig | null> => call(SET, [{ board, on }])

/**
 * 긴급 정지 — 도는 연쇄 + **이미 큐에 선 봉투**까지 버리고, 보드 옵트인을 전부 걷는다.
 * 돌려주는 `purged`가 실제로 뽑아낸 봉투 수다(0이어도 성공이다).
 */
export const stopTalk = (): Promise<TalkConfig | null> => call(STOP, [])

/**
 * 설정 전문 구독 + 첫 그림 따라잡기.
 *
 * 구독이 **먼저**다: `listen()`이 붙기 전에 나간 REPLACE를 놓치면 다른 창에서 누른
 * 정지가 이 창에 안 보인다(그 상태가 정확히 "멈춘 줄 알았는데 안 멈춤"이다).
 */
export function useTalkConfig(): { cfg: TalkConfig; refresh: () => void } {
  const [cfg, setCfg] = useState<TalkConfig>(TALK_OFF)
  const alive = useRef(true)
  const refresh = useCallback(() => {
    void readTalkConfig().then((c) => {
      if (c && alive.current) setCfg(c)
    })
  }, [])
  useEffect(() => {
    alive.current = true
    let off: (() => void) | undefined
    void listen<unknown>(STATE, (e) => {
      const c = asConfig(e.payload)
      if (c && alive.current) setCfg(c)
    })
      .then((f) => {
        if (!alive.current) return f()
        off = f
        refresh()
      })
      .catch(() => refresh())
    return () => {
      alive.current = false
      off?.()
    }
  }, [refresh])
  return { cfg, refresh }
}

/**
 * 옵트인 목록을 그리려면 **보드 이름**이 필요하다(`board:get`).
 *
 * 설정 화면에서 부르는 이유: 보드 id만 늘어놓으면 사용자가 어느 보드에 동의하는지
 * 알 수 없고, 동의의 대상을 모르는 옵트인은 옵트인이 아니다. 실패하면 빈 목록 —
 * 그 경우 화면은 "보드가 없어요"라고 말하고, 잘못된 동의를 만들지 않는다.
 */
export async function readTalkBoards(): Promise<{ id: string; title: string }[]> {
  try {
    const v = (await invoke('ipc_call', { channel: 'board:get', payload: [] })) as
      | { boards?: { id?: unknown; title?: unknown }[] }
      | null
    return (v?.boards ?? [])
      .filter((b) => typeof b?.id === 'string' && b.id)
      .map((b) => ({ id: String(b.id), title: String(b.title ?? '').trim() }))
  } catch {
    return []
  }
}

/** 정지 단축키 — 어느 화면에 있든 듣는다(입력창 안에서도). */
export const STOP_HOTKEY = 'Ctrl+Shift+.'
export function isStopHotkey(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '.' || e.key === '>' || e.code === 'Period')
}
