import { resumeHold } from '../api/unified'
import { useChatStatus } from './accounts'
import { engineHoldOf, engineOwnsResume } from './resumeOwner'
import { useLimitResume, type LimitResumeSurface } from './useLimitResume'

/** The engine owns quota timers across panels and detached windows. */
export function useManagedLimitResume(options: LimitResumeSurface, address: string) {
  const status = useChatStatus(address)
  const managed = engineOwnsResume(status)
  const local = useLimitResume({ ...options, managed })
  const managedHold = engineHoldOf(status)
  return {
    ...local,
    managedHold,
    waiting: !!managedHold || !!local.hold,
    resumeNow: () => {
      if (managed && status) void resumeHold(status.chatId)
      else local.resumeNow()
    }
  }
}
