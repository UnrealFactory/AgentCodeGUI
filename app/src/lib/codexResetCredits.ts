import type { CodexResetCreditResult } from '@shared/protocol'
import { putCodexUsage } from './accounts'

// 응답 유실 후 창을 닫거나 앱을 다시 열어도 같은 논리적 사용 시도를 재시도한다.
const storageKey = (email: string): string => `ccg-codex-reset-attempt:${encodeURIComponent(email)}`
const flights = new Map<string, Promise<CodexResetCreditResult>>()

export function pendingCodexReset(email: string): string | null {
  try { return localStorage.getItem(storageKey(email)) } catch { return null }
}

export function consumeCodexReset(email: string): Promise<CodexResetCreditResult> {
  const flight = flights.get(email)
  if (flight) return flight
  const run = async (): Promise<CodexResetCreditResult> => {
    const key = pendingCodexReset(email) ?? crypto.randomUUID()
    // 키를 보존할 수 없으면 서버를 호출하지 않는다.
    localStorage.setItem(storageKey(email), key)
    const result = await window.api.codexAuth.consumeResetCredit(email, key)
    if (result.outcome !== 'error') {
      if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(result.outcome) || result.usage?.email !== email) {
        throw new Error('Unexpected reset response')
      }
      localStorage.removeItem(storageKey(email))
      putCodexUsage(email, result.usage)
    } else {
      putCodexUsage(email)
    }
    return result
  }
  const promise = run().catch((error: unknown) => {
    putCodexUsage(email)
    throw error
  }).finally(() => flights.delete(email))
  flights.set(email, promise)
  return promise
}
