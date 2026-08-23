/* ============================================================
 * `chat:verdict` — **거부·큐잉 사유를 사람의 문장으로**.
 *
 * 왜 이 파일이 생겼나(크리틱 R14 §4.3-M2 · §5-F4): 셸의 `hub::ensure()`는 정체성
 * 정규화가 실패하면(`CwdMissing` · `AccountUnavailable`) 사유를 `chat:verdict`로 뿌리고
 * 호출에는 `null`을 돌려준다. 그 채널의 **구독자가 0**이었다 — 그래서 채팅 폴더를 지운
 * 상태로 한 줄 보내면 사용자 말풍선이 그려지고 나레이션이 돌고 중지 버튼이 살아 있는데
 * **40초가 지나도 오류가 0건**이었다(실측). 런타임이 없으니 T3(20초 침묵 감시)도 없다 —
 * m-logic P8("영구 정지 + 침묵") 그 자체다.
 *
 * 두 가지를 여기서 정한다:
 *   ① **정규화** — 와이어의 `reason`이 두 어휘로 온다. 상태기계 경로는 snake_case 코드
 *      (`cwd_missing`·`no_card`…)이고, `ensure` 경로는 Rust의 `{e:?}`라
 *      `CwdMissing("C:\\경로")`처럼 **Debug 문자열**이다(셸 소관이라 이 라운드가 못 고친다).
 *      둘을 같은 코드 + 상세값으로 접는다.
 *   ② **무엇을 보일 것인가** — `dispatch`는 **모든** 명령에 판정을 방출한다
 *      (`runtime.rs:723` — `accepted`까지). 전부 그리면 화면이 판정 로그가 된다.
 *      거부는 언제나, 큐잉·예약은 **사용자가 방금 누른 것**일 때만 문장을 만든다.
 * ============================================================ */
import { t } from './i18n'

/** 셸이 싣는 모양 — `hub.rs verdict_wire()`. `reason`은 코드 문자열이거나 Debug 덤프다. */
export interface VerdictWire {
  kind?: string
  cmd?: string
  reason?: string | null
  /** ★ 셸이 **사람의 문장을 직접 만들어 스레드로 내보내는** 판정에만 실린다(`reject_spawn`).
   *  있으면 저자는 셸이다 — 렌더러가 같은 사실을 한 번 더 쓰면 두 벌이 된다. */
  message?: string | null
}

/**
 * 이 판정의 **문장 저자가 셸인가**.
 *
 * R5의 `hub::reject_spawn`은 스폰 불가 사유를 `status{analyzing}` → `error{message}` →
 * `status{error}` 세 이벤트로 **스레드에 직접** 낸다(그 대화를 보고 있는 창·배경 수집기가
 * 받는다). 그때도 `chat:verdict`는 그대로 나오는데, 셸 주석이 적은 대로 그건 *"구독자가
 * 붙는 날의 기계 판독용"* 이다. 여기서 그 뜻을 지킨다 — 저자가 둘이면 같은 사고를 두
 * 문장으로 말하게 된다(전송 1회에 판정 2건이던 배선 R1 F6과 같은 계열).
 *
 * `message`가 없는 판정(상태기계 거부 — `ended`·`no_card`·`hold_not_ready`·큐잉…)은
 * 셸이 아무 문장도 안 내므로 **여전히 렌더러가 유일한 화자**다.
 */
export function shellAuthored(v: VerdictWire | null | undefined): boolean {
  return typeof v?.message === 'string' && v.message.trim() !== ''
}

export interface VerdictNote {
  /** 진단·하네스 키 — `${cmd}:${kind}:${code}` */
  key: string
  /** 정규화된 사유 코드 (`cwd_missing` 등). 모르면 `unknown`. */
  code: string
  /** Debug 덤프에 실려 온 값(경로·계정) — 있으면 문장 아래 한 줄로 보여 준다. */
  detail: string
  /** 카드/토스트의 제목 */
  title: string
  /** 본문 한 줄 */
  text: string
  /** 이 판정이 **전송을 막았나**. 막았으면 화면의 busy를 되감아야 한다(D7 침묵 no-op 금지). */
  blocked: boolean
}

/** 이 명령들의 판정은 "사용자가 방금 누른 것"이라 큐잉·예약도 문장을 만든다. */
const USER_SEND = new Set(['send', 'ensure', 'run'])

/**
 * `CwdMissing("C:\\x")` · `cwd_missing` 둘 다 → `{ code:'cwd_missing', detail:'C:\\x' }`.
 * 모양을 모르면 원문을 코드로 두고 상세는 비운다 — 지어내지 않는다.
 */
export function normalizeReason(raw: string | null | undefined): { code: string; detail: string } {
  const s = (raw ?? '').trim()
  if (!s) return { code: 'unknown', detail: '' }
  // Debug 덤프: `Ident("값")` / `Ident { .. }` / `Ident`
  const m = /^([A-Z][A-Za-z0-9]*)\s*(?:\(([\s\S]*)\)|\{([\s\S]*)\})?$/.exec(s)
  if (m) {
    const code = m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    let detail = (m[2] ?? m[3] ?? '').trim()
    // Rust의 Debug는 문자열을 따옴표 + 역슬래시 이스케이프로 낸다 — 사람이 읽는 경로로 되돌린다
    if (/^".*"$/s.test(detail)) detail = detail.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"')
    return { code, detail }
  }
  return { code: s.toLowerCase(), detail: '' }
}

/** 사유 코드 → 사람이 읽는 한 줄. 모르는 코드는 원문을 그대로 보여 준다(침묵 금지). */
function reasonText(code: string, raw: string): string {
  switch (code) {
    case 'cwd_missing':
      return t(
        '이 채팅의 작업 폴더가 없어요(지워졌거나 옮겨졌어요). 폴더를 다시 고르면 이어서 보낼 수 있어요.',
        "This chat's working folder is gone (deleted or moved). Pick the folder again to keep sending."
      )
    case 'account_unavailable':
      return t(
        '이 채팅에 지정된 계정으로 로그인되어 있지 않아요. 설정에서 다시 로그인하거나 다른 계정을 고르세요.',
        'The account this chat is pinned to is not signed in. Sign in again or pick another account in Settings.'
      )
    case 'api_key_missing':
      return t(
        'API 과금 모드인데 저장된 API 키가 없어요. 설정 → API에서 키를 넣어 주세요.',
        'API billing is on but no API key is stored. Add one in Settings → API.'
      )
    case 'engine_switch_needs_model':
      return t('엔진을 바꾸려면 그 엔진의 모델도 함께 골라야 해요.', 'Switching engines needs a model for that engine too.')
    case 'ended':
      return t('이 대화의 엔진이 이미 끝났어요. 다시 보내면 새로 시작해요.', 'This chat’s engine has already ended. Send again to start fresh.')
    case 'engine_unavailable':
      return t('그 엔진을 지금 쓸 수 없어요.', 'That engine is unavailable right now.')
    case 'chat_gone':
      return t('그 대화가 이미 사라졌어요.', 'That conversation is already gone.')
    case 'hold_not_ready':
      return t('아직 한도가 안 풀렸어요 — 풀리면 이어서 계속해요.', 'The limit has not lifted yet — it will continue once it does.')
    case 'nothing_running':
      return t('지금 도는 실행이 없어요.', 'Nothing is running right now.')
    case 'already_interrupting':
    case 'interrupting':
      return t('이미 중단하는 중이에요.', 'Already stopping.')
    case 'already_ending':
    case 'ending':
      return t('이 대화의 엔진이 정리되는 중이에요 — 잠시 뒤 다시 시도해 주세요.', 'This chat’s engine is shutting down — try again in a moment.')
    case 'no_card':
      return t('답할 카드가 이미 닫혔어요.', 'That card is already closed.')
    case 'wrong_card_kind':
      return t('그 카드의 종류가 달라요 — 응답이 짝을 못 찾았어요.', 'That card is a different kind — the response found no match.')
    case 'no_item':
      return t('그 예약 항목이 이미 없어요.', 'That queued item is already gone.')
    case 'no_pending':
      return t('취소할 예약 설정이 없어요.', 'There is no pending setting to cancel.')
    case 'no_revision':
      return t('되돌릴 이력이 없어요.', 'There is no revision to go back to.')
    case 'undo_expired':
      return t('되돌리기 시간이 지났어요.', 'The undo window has passed.')
    case 'no_stream':
    case 'no_foreground_tool':
      return t('그 작업이 이미 끝났어요.', 'That task has already finished.')
    default:
      return t(`엔진이 거절했어요 — 사유: ${raw}`, `The engine refused — reason: ${raw}`)
  }
}

/**
 * 이 판정을 화면에 낼 것인가, 낸다면 무엇이라고 할 것인가.
 * 낼 게 없으면 `null`(정상 수락·미러 갱신은 조용하다).
 */
export function verdictNote(v: VerdictWire | null | undefined): VerdictNote | null {
  const kind = v?.kind ?? ''
  const cmd = v?.cmd ?? ''
  const { code, detail } = normalizeReason(v?.reason)
  if (kind === 'rejected') {
    // 전송을 막은 거부만 busy를 되감는다 — 승인 카드 응답이 튕긴 것으로 도는 턴을 죽이면
    // 그게 새 사고다. `ensure`는 런타임 자체를 못 만든 것이라 **무엇을 하려 했든** 막혔다.
    const blocked = USER_SEND.has(cmd)
    return {
      key: `${cmd}:rejected:${code}`,
      code,
      detail,
      title: blocked ? t('메시지를 보내지 못했어요', "Couldn't send the message") : t('요청이 거절됐어요', 'Request refused'),
      text: reasonText(code, v?.reason ?? ''),
      blocked
    }
  }
  if (kind === 'queued' && USER_SEND.has(cmd))
    return {
      key: `${cmd}:queued:`,
      code: '',
      detail: '',
      title: t('예약으로 넣었어요', 'Queued instead'),
      text: t(
        '지금 도는 작업이 있어 이 메시지를 예약으로 넣었어요 — 턴이 끝나면 바로 나가요.',
        'A run is in flight, so this message was queued — it goes out as soon as the turn ends.'
      ),
      blocked: false
    }
  if (kind === 'deferred' && cmd === 'identity_set')
    return {
      key: `${cmd}:deferred:${code}`,
      code,
      detail: '',
      title: t('설정을 예약했어요', 'Setting scheduled'),
      text: t('지금 도는 턴이 끝나면 이 설정을 적용해요.', 'This setting applies when the current turn ends.'),
      blocked: false
    }
  return null
}

/** 카드·토스트 한 줄로 접은 문장(제목 + 본문 + 상세). */
export function verdictLine(n: VerdictNote): string {
  return n.detail ? `${n.title} — ${n.text}\n${n.detail}` : `${n.title} — ${n.text}`
}
