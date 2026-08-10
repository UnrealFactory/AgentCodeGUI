/* ============================================================
 * EngineRouter — 채널 하나(chat/talk/ma/session)의 실행을
 * RunRequest.engine에 따라 ClaudeEngine 또는 CodexEngine으로 보낸다.
 *
 * 렌더러는 엔진을 모른 채 같은 EngineEvent 스트림/응답 채널만 쓴다.
 *  - run: engine 필드로 라우팅. 다른 엔진이 돌고 있으면 먼저 취소해
 *    한 채널에 두 스트림이 섞이지 않게 한다.
 *  - respondPermission/Question/bgTask: id는 엔진별로 유일하므로
 *    둘 다에 배달 — 모르는 id는 각 엔진이 조용히 무시한다.
 * ============================================================ */
import { ClaudeEngine } from './claude/engine'
import { CodexEngine } from './codex/engine'
import type { BgTaskRequest, EngineEvent, PermissionResponse, QuestionResponse, RunRequest } from '@shared/protocol'

type Emit = (event: EngineEvent) => void
type ApiUsageSource = 'chat' | 'talk' | 'ma'

export class EngineRouter {
  private claude: ClaudeEngine
  private codex: CodexEngine | null = null
  private emitFn: Emit
  private active: 'claude' | 'codex' = 'claude'

  constructor(emit: Emit, source: ApiUsageSource = 'chat') {
    this.emitFn = emit
    this.claude = new ClaudeEngine(emit, source)
  }

  private codexEngine(): CodexEngine {
    if (!this.codex) this.codex = new CodexEngine(this.emitFn)
    return this.codex
  }

  async run(req: RunRequest): Promise<string> {
    const target = req.engine === 'codex' ? 'codex' : 'claude'
    if (this.active !== target) {
      // 채널당 활성 스트림은 하나 — 반대편 엔진이 돌고 있으면 정리하고 넘어간다
      await (this.active === 'claude' ? this.claude.cancel() : this.codex?.cancel())
    }
    this.active = target
    return target === 'codex' ? this.codexEngine().run(req) : this.claude.run(req)
  }

  async cancel(): Promise<void> {
    await Promise.all([this.claude.cancel(), this.codex?.cancel()])
  }

  /** Esc/중지의 소프트 중단 — 클로드는 턴만 끊고 CLI·백그라운드 상주를 지킨다.
   *  Codex는 상주 주입 모델이 아니라 기존 cancel 그대로(동작 변화 없음). */
  async interruptTurn(): Promise<void> {
    await Promise.all([this.claude.interruptTurn(), this.codex?.cancel()])
  }

  respondPermission(res: PermissionResponse): void {
    this.claude.respondPermission(res)
    this.codex?.respondPermission(res)
  }

  respondQuestion(res: QuestionResponse): void {
    this.claude.respondQuestion(res)
    this.codex?.respondQuestion(res)
  }

  async bgTask(req: BgTaskRequest): Promise<void> {
    await Promise.all([this.claude.bgTask(req), this.codex?.bgTask(req)])
  }

  /** 유휴 회수(스윕) 판단 — 턴이 진행 중이거나 클로드 상주 스트림(백그라운드 셸·워크플로·
   *  에이전트 보유)이 살아 있으면 true. codex의 상시 app-server는 회수해도 스레드가
   *  디스크에 남아 다음 run의 resume으로 이어지므로 busy에 넣지 않는다(= 회수 대상). */
  get busy(): boolean {
    return this.claude.hasLiveStream || (this.codex?.isRunning ?? false)
  }

  /** 유휴 codex app-server 회수 — 상주 프로세스가 마지막 사용 후 ttl 이상 놀면 거둔다.
   *  스레드는 디스크에 남아 다음 run의 resume으로 이어지고, 엔진은 재생성된다(투명). */
  sweepIdleCodex(ttl: number): void {
    const cx = this.codex
    if (!cx || cx.isRunning) return
    if (Date.now() - cx.lastUsedAt < ttl) return
    this.codex = null
    cx.dispose()
  }

  dispose(): void {
    this.claude.dispose()
    this.codex?.dispose()
  }
}
