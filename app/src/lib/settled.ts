/* ============================================================
 * 정착 사유 레지스트리 — `chat:run-state.settled[]`를 화면 어휘로.
 *
 * m-logic §5.2 표시 규약: **`Completed`만 "완료"**다. `TurnEnded`·`StreamClosed`·
 * `Watchdog`·`NotifyTimeout`은 "정리됨" + 사유 부제로 그린다. 사용자에게 다른 정보다.
 *
 * 배선 R2가 사유를 실어 보내기 시작했는데(그 전엔 배열이 항상 비어 있었다) 읽는 쪽이
 * 없었다(m3 보고 R3). 없으면 어떤 화면이 되냐면: CLI가 밖에서 죽어도 도구 행의
 * 스피너가 **영원히 돈다** — 합성 result가 busy만 내리고 도구 행은 안 건드리기 때문이다
 * (session.ts `case 'result'`는 running 도구를 정착시키지 않는다).
 *
 * 프롭 드릴 대신 모듈 레지스트리인 이유: 사유의 키는 원장 항목 id(`toolu_…`·requestId·
 * bg task id)이고 **전역 유일**이다. 본채팅·멀티 패널·팝아웃이 같은 표를 보면 되고,
 * memo된 말풍선 트리에 새 prop을 꿰지 않아도 된다(스트리밍 fps 보호).
 * ============================================================ */
import { useSyncExternalStore } from 'react'
import { t } from './i18n'

/** itemId → 정착 사유(와이어 문자열). REPLACE가 아니라 **누적**이다 — 정착은 되돌지 않고,
 *  `settled[]`는 그 틱에 정착한 것만 싣는다(다음 REPLACE에서 사라진다). */
const reasons = new Map<string, string>()
const subs = new Set<() => void>()
let version = 0
// 무한히 자라지 않게 — 한 대화의 원장이 이 수를 넘는 일은 없다(넘으면 오래된 것부터 버린다)
const CAP = 600

function bump(): void {
  version += 1
  for (const fn of [...subs]) fn()
}

/** `chat:run-state.settled[]` 한 벌을 접수한다. 새 사유가 없으면 아무도 안 깨운다. */
export function noteSettled(rows: { id?: string; kind?: string; reason?: string }[] | undefined): void {
  if (!rows?.length) return
  let changed = false
  for (const r of rows) {
    if (!r?.id || typeof r.reason !== 'string') continue
    if (reasons.get(r.id) === r.reason) continue
    reasons.set(r.id, r.reason)
    changed = true
  }
  while (reasons.size > CAP) {
    const first = reasons.keys().next()
    if (first.done) break
    reasons.delete(first.value)
  }
  if (changed) bump()
}

/** 하네스·진단용 — 지금까지 접수한 사유 전부. */
export function settledSnapshot(): Record<string, string> {
  return Object.fromEntries(reasons)
}

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}
function snapshot(): number {
  return version
}

/** 이 원장 항목이 사유와 함께 정착했는가. 없으면 null. */
export function useSettledReason(id: string | undefined | null): string | null {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return (id && reasons.get(id)) || null
}

/** 사유 → 화면 어휘. `completed`는 null(평소의 "완료" 표시를 그대로 쓴다). */
export function settleText(reason: string): { label: string; sub: string } | null {
  if (reason === 'completed') return null
  const cleaned = t('정리됨', 'Cleaned up')
  const stopped = t('중지됨', 'Stopped')
  if (reason === 'failed') return { label: t('실패', 'Failed'), sub: t('도구가 오류로 끝나서', 'the tool ended with an error') }
  if (reason === 'turn_ended') return { label: cleaned, sub: t('턴이 끝나서', 'the turn ended') }
  if (reason === 'cancelled' || reason.startsWith('stopped:'))
    return { label: stopped, sub: t('직접 중지해서', 'you stopped it') }
  if (reason === 'thread_changed') return { label: cleaned, sub: t('대화 스레드가 바뀌어서', 'the thread changed') }
  if (reason.startsWith('identity_changed'))
    return { label: cleaned, sub: t('설정이 바뀌어 새로 시작해서', 'settings changed and it restarted') }
  if (reason.startsWith('watchdog:')) return { label: cleaned, sub: t('응답이 없어서', 'it stopped responding') }
  if (reason === 'notify_timeout') return { label: cleaned, sub: t('완료 통지를 못 받아서', 'no completion notice arrived') }
  if (reason === 'forced_by_user') return { label: cleaned, sub: t('직접 해제해서', 'you cleared it') }
  if (reason.startsWith('stream_closed:')) {
    const cause = reason.slice('stream_closed:'.length)
    const why =
      cause === 'externalkill'
        ? t('엔진(CLI)이 외부에서 종료돼서', 'the engine (CLI) was killed from outside')
        : cause === 'crash'
          ? t('엔진(CLI)이 비정상 종료돼서', 'the engine (CLI) crashed')
          : cause === 'appquit'
            ? t('앱이 종료돼서', 'the app quit')
            : cause === 'spawnfailed'
              ? t('엔진(CLI)을 띄우지 못해서', "the engine (CLI) couldn't start")
              : cause === 'idlereclaim'
                ? t('오래 쉬어서 엔진을 회수해서', 'the idle engine was reclaimed')
                : t('엔진(CLI)이 종료돼서', 'the engine (CLI) exited')
    return { label: cleaned, sub: why }
  }
  return { label: cleaned, sub: reason }
}
