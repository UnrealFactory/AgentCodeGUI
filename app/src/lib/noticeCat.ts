/* ============================================================
 * 스레드 안내(`kind:'notice'`)의 **분류** — 2026-09-04 디자인 결정.
 *
 * 왜 생겼나: 시스템이 하는 말 대부분(한도 · 계정 · 엔진 수명 · 프로세스 종료 · 중지 ·
 * 예약 · 거절 · CLI 원문)이 **노란 ⚠ band 하나**로 나가 노랑이 아무 뜻도 없어졌다.
 * 형태(band)는 그대로 두고 **주제**로 갈라 색 하나 · 글리프 하나 · 라벨 하나씩 준다.
 * 라벨(작은 태그)은 색·글리프를 외우기 전까지의 다리다. 카탈로그:
 * `~/Desktop/agentcodegui-notify-catalog.html` (현행/제안 토글 · 색 후보 picker).
 *
 * 분류는 **문장으로** 한다. 엔진(`Event::Notice(String)`)·셸·렌더러 세 저자가 같은 와이어
 * (`{type:'notice', text}`)로 보내고, 문장은 전부 우리 코드에 박힌 고정 문자열이라 여기
 * 표가 곧 목록이다(엔진 이벤트에 종류를 싣는 건 크레이트 셋 + 테스트 20여 곳을 흔든다 —
 * 디자인 패스에서 할 일이 아니다). 표에 없는 문장은 **남의 문장**(CLI 배너)으로 본다 —
 * 심각도를 지어내지 않고 무채색 ⓘ로 낸다. 옛 스냅샷(`cat` 없음)도 같은 표로 다시 읽는다.
 * ============================================================ */
import { t } from './i18n'

export type NoticeCat =
  | 'limit' // 한도 대기 — 막혀 기다리는 중 · 재확인 · 자동 재개 멈춤
  | 'lifted' // 한도 풀림
  | 'account' // 계정 자동 전환 · 계정 바꿔 대기표 취소
  | 'model' // 모델 폴백 전환 · 폴백 취소
  | 'life' // 수명(감시) — 무응답 · 빈 응답 · 유휴 정리 · 백그라운드 표시 정리 · 무음 턴
  | 'exit' // 프로세스 종료
  | 'respawn' // 새 프로세스에서 시작
  | 'stop' // 중지 — 작업 중지 · 중지로 예약 버림
  | 'queue' // 예약 — 설정 예약(메시지 예약 문장은 2026-09-04 제거: 예약 독이 이미 보여준다)
  | 'reject' // 판정 거절 — 못 보냈어요 · 요청 거절
  | 'billing' // API 과금
  | 'cli' // CLI stderr 원문(모노)
  | 'info' // 그 밖의 남의 문장(CLI 배너) — 무채색 ⓘ

/** 색조 클래스 접미(styles.css `.ntf-t-*`)와 라벨. 글리프는 Chat.tsx가 아이콘으로 짝짓는다. */
export const NOTICE_CAT: Record<NoticeCat, { tone: string; tag: () => string }> = {
  limit: { tone: 'limit', tag: () => t('한도', 'Limit') },
  lifted: { tone: 'lifted', tag: () => t('풀림', 'Lifted') },
  account: { tone: 'account', tag: () => t('계정', 'Account') },
  model: { tone: 'model', tag: () => t('모델', 'Model') },
  life: { tone: 'life', tag: () => t('수명', 'Watchdog') },
  exit: { tone: 'neutral', tag: () => t('종료', 'Exited') },
  respawn: { tone: 'neutral', tag: () => t('재시작', 'Restart') },
  stop: { tone: 'stop', tag: () => t('중지', 'Stopped') },
  queue: { tone: 'queue', tag: () => t('예약', 'Scheduled') },
  reject: { tone: 'reject', tag: () => t('거절', 'Refused') },
  billing: { tone: 'billing', tag: () => t('과금', 'Billing') },
  cli: { tone: 'neutral', tag: () => 'CLI' },
  info: { tone: 'neutral', tag: () => t('알림', 'Notice') }
}

/** 문장 → 분류. 순서가 곧 우선순위다(앞이 이긴다). 출처는 각 줄의 주석. */
const RULES: [NoticeCat, RegExp][] = [
  ['cli', /^\[stderr\]/], // runtime.rs on_stderr
  ['lifted', /^사용 한도가 풀렸어요/], // runtime.rs 964 · 4075
  ['limit', /^사용 한도에 걸려 대기합니다|^확인해 보니 아직 한도가|^한도가 풀렸는지|자동 재개를 멈췄어요/], // emit_hold_notice · check_hold
  ['account', /계정으로 바꿔 이어갑니다|^계정을 바꿔서 대기표를 취소했어요/], // hub.rs AccountSwitched · runtime.rs 1778
  ['model', /^폴백을 취소했어요/], // hub.rs Respond(cancel)
  ['respawn', /새 프로세스에서 시작했|started in a new process/], // runtime.rs respawn_text
  ['exit', /^엔진\(CLI\)이 .*종료|^오래 조용한 엔진을 정리했어요|^중단 응답이 없어 엔진을 강제로|^엔진을 시작하지 못했어요/], // wire.rs stream_closed · runtime.rs 1990
  ['life', /^엔진이 20초 안에|^응답이 비어 있어|^6시간 조용한 엔진|^백그라운드 진행 상태를 알 수 없어|^이번 턴이 응답 없이 끝났어요|^This turn ended without a reply/], // runtime.rs T3·T11·T32·watchdog_loop · session.ts silent
  ['stop', /^작업 \d+개를 중지했어요|^중지해서 예약된 메시지/], // runtime.rs 2533 · hub.rs QueueCleared
  ['queue', /^설정을 예약했어요|^Setting scheduled|^예약으로 넣었어요|^Queued instead/], // verdict.ts deferred (+ 옛 스냅샷의 queued)
  ['reject', /^메시지를 보내지 못했어요|^요청이 거절됐어요|^Couldn't send the message|^Request refused/], // verdict.ts rejected
  ['billing', /과금 중이에요|과금 중입니다|^Billing to/] // session.ts api-billing
]

/** 옛 스냅샷·힌트 — 항목에 이미 박힌 사실이 문장보다 먼저다(지어내지 않는다). */
export function classifyNotice(text: string, hint?: { action?: string; silent?: boolean }): NoticeCat {
  if (hint?.action === 'revert') return 'account'
  if (hint?.action === 'billing-off') return 'billing'
  if (hint?.silent) return 'life'
  for (const [cat, re] of RULES) if (re.test(text)) return cat
  return 'info'
}
