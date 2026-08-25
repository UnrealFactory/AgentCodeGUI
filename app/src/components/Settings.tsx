import { Fragment, useEffect, useRef, useState } from 'react'
import type {
  EngineVersionEntry,
  EngineVersionState,
  SkillInfo,
  SkillScope,
  McpServerInfo,
  LspServerInfo,
  ApiConfigStatus,
  AccountUsage,
  CodexAccountUsage
} from '@shared/protocol'
import { FileBadge } from './fileType'
// ★R28 ACCT §1·§3·§4 — 계정 목록·한도의 단일 스토어 + 「사용 중」 역인덱스.
import {
  ensureAccounts,
  ensureCodexAccounts,
  inUseLabel,
  invalidateAccounts,
  primeUsageFromDisk,
  putAccounts,
  putCodexAccounts,
  refreshCodexUsage,
  refreshUsage,
  updateAccounts,
  updateCodexAccounts,
  useAccounts
} from '../lib/accounts'
import { getPref, setPref } from '../lib/prefs'
import { applyGlass, GLASS_DEFAULT, GLASS_PREF } from '../lib/glass'
import {
  SIDEBAR_AUTOHIDE,
  SIDEBAR_AUTOHIDE_TRIGGER,
  AUTOHIDE_DEFAULT,
  AUTOHIDE_TRIGGER_DEFAULT,
  AUTOHIDE_TRIGGER_MIN,
  AUTOHIDE_TRIGGER_MAX,
  SIDEBAR_AUTOHIDE_EVENT,
  SIDEBAR_AUTOHIDE_TRIGGER_PREVIEW_EVENT
} from '../lib/sidebarAutohide'
import {
  IconClose,
  IconServer,
  IconBook,
  IconRefresh,
  IconBot,
  LogoClaude,
  LogoOpenAI,
  IconChevDown,
  IconChevRight,
  IconAlert,
  IconCheck,
  IconTrash,
  IconCode,
  IconKey,
  IconUser,
  IconCard,
  IconPlus,
  IconPencil,
  IconFilter,
  IconX2,
  IconSearch,
  IconMouse,
  IconContrast,
  IconGlobe,
  IconMessage,
  type IconProps
} from './icons'
import { getLang, isEn, setLang, t, type UiLang } from '../lib/i18n'
// ★M10 R2 — 대화 연결(크로스톡)의 설정 창구. 채널 문자열은 이 모듈 하나가 안다.
import { STOP_HOTKEY, readTalkBoards, setTalkBoard, setTalkConfig, stopTalk, useTalkConfig } from '../lib/crosstalk'
import { stopSaid } from './TalkStop'
import { GestureGlyph, GESTURE_DEFAULTS, MouseGestureLayer, scrollGestures } from './mouseGesture'
import { remainTone } from './Chat'
import {
  DEFAULT_HIDE_DIRS,
  DEFAULT_HIDE_FILES,
  getHideDirs,
  getHideEnabled,
  getHideFiles,
  setHideDirs,
  setHideEnabled,
  setHideFiles
} from '../lib/hideDirs'

export type SettingsView = 'profile' | 'account' | 'version' | 'api' | 'mcp' | 'skill' | 'lsp' | 'explorer' | 'gesture' | 'display' | 'language' | 'talk'
type View = SettingsView

// 레일 — PoC 재해석: 그룹 라벨(사용자/엔진/확장/환경) 아래 항목. keys는 검색어(한국어·영어 동의어).
// 그룹 라벨이 언어를 따라가야 해서 상수가 아닌 함수 — 렌더 때 t()가 평가된다.
function navGroups(): { label: string; items: { id: View; label: string; Icon: (p: IconProps) => React.ReactElement; keys: string }[] }[] {
  return [
    {
      label: t('사용자', 'User'),
      items: [
        { id: 'profile', label: 'Profile', Icon: IconUser, keys: '프로필 닉네임 아바타 이름 색 profile nickname avatar name color' },
        { id: 'account', label: 'Account', Icon: IconCard, keys: '계정 로그인 구독 기본 한도 openai chatgpt account login subscription default limit' }
      ]
    },
    {
      label: t('엔진', 'Engine'),
      items: [
        { id: 'version', label: 'Engine', Icon: IconBot, keys: '엔진 claude code codex cli 버전 업데이트 설치 engine version update install' },
        { id: 'api', label: 'API', Icon: IconKey, keys: 'api 키 예산 과금 비용 key budget billing cost' }
      ]
    },
    {
      label: t('확장', 'Extensions'),
      items: [
        { id: 'mcp', label: 'MCP', Icon: IconServer, keys: 'mcp 서버 도구 server tool' },
        { id: 'skill', label: 'Skill', Icon: IconBook, keys: '스킬 명령 슬래시 skill command slash' },
        // ★M10 R2 — 대화 연결. R1은 라우터를 끝까지 만들고 이 자리를 안 만들었다:
        // 켜는 문도 끄는 문도 없어 사용자가 존재를 알 방법이 없었다(크리틱 D7).
        { id: 'talk', label: 'Talk', Icon: IconMessage, keys: '대화 연결 세션 협업 정지 crosstalk talk session collaboration stop 긴급' }
      ]
    },
    {
      label: t('환경', 'Environment'),
      items: [
        { id: 'display', label: 'Display', Icon: IconContrast, keys: '화면 유리 투명 아크릴 벽지 비침 배경 glass 알림 토스트 notification display transparent acrylic wallpaper background toast sidebar' },
        { id: 'language', label: 'Language', Icon: IconGlobe, keys: '언어 한국어 영어 한글 korean english 번역 language translation' },
        { id: 'lsp', label: 'Code', Icon: IconCode, keys: '코드 언어 서버 lsp 하이라이트 심볼 code language server highlight symbol' },
        { id: 'explorer', label: 'Explorer', Icon: IconFilter, keys: '탐색기 숨김 필터 폴더 explorer hide filter folder' },
        { id: 'gesture', label: 'Gestures', Icon: IconMouse, keys: '제스처 마우스 우클릭 gesture mouse right click' }
      ]
    }
  ]
}

// numeric semver-ish compare: <0 if a is older than b
function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

// ── Profile (닉네임 + 아바타 색 — 사이드바 하단·채팅 첫 인사의 내 표시.
//    말풍선의 ava/meta는 2.0 리뉴얼 CSS가 숨겨 채팅 본문엔 안 나온다) ────────────
// 저장 즉시 메인 창에 반영 — App이 ccg-profile-changed 커스텀 이벤트를 구독.
// 추가 채팅 창(SessionWindow)은 별도 OS 창이라 이 이벤트가 닿지 않음 — 창을 열 때 getProfile로 로드.
// PoC 문법: 히어로 카드(큰 아바타 미리보기) + 필드, 스와치는 체크 대신 링.
// 20색 = 스와치 줄(한 줄 10개)에 정확히 두 줄. 색상환 순서로 돌되 [0]은 기본색
// 인디고 고정(App의 DEFAULT_USER와 동일), 끝은 브라운·뉴트럴로 마무리.
const AVA_SWATCHES = [
  '#6366F1', '#7C3AED', '#9333EA', '#C026D3', '#DB2777',
  '#E11D48', '#DC2626', '#EA580C', '#D97706', '#CA8A04',
  '#65A30D', '#16A34A', '#059669', '#0D9488', '#0891B2',
  '#0EA5E9', '#2563EB', '#92400E', '#64748B', '#000000'
]
function ProfileView(): React.ReactElement {
  const [nick, setNick] = useState('')
  const [color, setColor] = useState(AVA_SWATCHES[0])
  useEffect(() => {
    window.api
      .getProfile()
      .then((p) => {
        if (p) {
          setNick(p.nickname)
          setColor(p.color || AVA_SWATCHES[0])
        }
      })
      .catch(() => {})
  }, [])
  // 빈 닉네임은 저장하지 않는다 — App도 빈 이름은 무시하므로 마지막 유효값이 유지된다
  const apply = (nickname: string, c: string): void => {
    if (!nickname.trim()) return
    const profile = { nickname: nickname.trim(), color: c }
    window.api.saveProfile(profile).catch(() => {})
    window.dispatchEvent(new CustomEvent('ccg-profile-changed', { detail: profile }))
  }
  const shown = nick.trim() || 'User'
  return (
    <>
      <div className="set-h1">Profile</div>
      <div className="set-h1-sub">
        {t(
          '사이드바와 채팅 첫 인사에 보이는 내 이름과 아바타예요 — 바꾸면 바로 반영돼요.',
          'Your name and avatar in the sidebar and the chat greeting — changes apply right away.'
        )}
      </div>
      <div className="sc2 hero2">
        <div className="set-bigava" style={{ background: color }}>{shown.charAt(0).toUpperCase()}</div>
        <div>
          <div className="n">{shown}</div>
          <div className="s">{t('사이드바에 이 이름과 색으로 보여요', 'Shown in the sidebar with this name and color')}</div>
        </div>
      </div>
      <div className="set-field">
        <label>{t('닉네임', 'Nickname')}</label>
        <input
          className="set-input"
          value={nick}
          maxLength={20}
          placeholder="User"
          onChange={(e) => {
            setNick(e.target.value)
            apply(e.target.value, color)
          }}
        />
      </div>
      <div className="set-field">
        <label>{t('아바타 색', 'Avatar color')}</label>
        <div className="set-swatches">
          {AVA_SWATCHES.map((c) => (
            <button
              key={c}
              className={'set-swatch' + (c === color ? ' on' : '')}
              style={{ background: c }}
              aria-label={t('아바타 색 ', 'Avatar color ') + c}
              onClick={() => {
                setColor(c)
                apply(nick, c)
              }}
            />
          ))}
        </div>
      </div>
    </>
  )
}

// 배열 원소 이동(from → to) — 꾹-드래그 재정렬의 낙관 갱신용
function arrMove<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice()
  const [it] = next.splice(from, 1)
  next.splice(to, 0, it)
  return next
}

// ── 계정 카드 꾹-드래그 재정렬 ──────────────────────────────────────────────
// 카드를 0.35초 꾹 누르면 집힌다(버튼 위 프레스는 제외 — 삭제/기본 클릭과 충돌 없음).
// 집힌 뒤 세로 드래그로 목록이 즉시 재배열(move)되고, 놓으면 drop이 순서를 저장한다.
// 홀드 전에 6px 이상 움직이거나 먼저 떼면 그냥 클릭 — 드래그로 승격하지 않는다.
function useHoldReorder(
  count: number,
  move: (from: number, to: number) => void,
  drop: () => void
): { drag: number | null; press: (i: number) => (e: React.PointerEvent<HTMLDivElement>) => void } {
  const [drag, setDrag] = useState<number | null>(null)
  const press =
    (i: number) =>
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0 || count < 2) return
      if ((e.target as HTMLElement).closest('button, a, input')) return
      const el = e.currentTarget
      const pid = e.pointerId
      const startX = e.clientX
      const startY = e.clientY
      // 한 칸 이동 거리 = 행 높이 + 카드 간격(.sc2 + .sc2 의 8px) — 계정 카드 높이는 균일
      const step = el.offsetHeight + 8
      let active = false
      let cur = i
      const cleanup = (): void => {
        window.clearTimeout(timer)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        document.body.style.userSelect = ''
        try {
          el.releasePointerCapture(pid)
        } catch {
          /* 캡처 전 종료 */
        }
      }
      const timer = window.setTimeout(() => {
        active = true
        setDrag(i)
        // 프레스 중 시작된 텍스트 선택을 걷어내고, 드래그 동안 새 선택을 막는다
        window.getSelection()?.removeAllRanges()
        document.body.style.userSelect = 'none'
        try {
          el.setPointerCapture(pid)
        } catch {
          /* ignore */
        }
      }, 350)
      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== pid) return
        if (!active) {
          if (Math.abs(ev.clientX - startX) > 6 || Math.abs(ev.clientY - startY) > 6) cleanup()
          return
        }
        // 프레스 지점 대비 이동량을 칸 수로 환산 — 배열이 이미 재배열돼도 기준은 원래 자리(i)
        const to = Math.max(0, Math.min(count - 1, i + Math.round((ev.clientY - startY) / step)))
        if (to !== cur) {
          move(cur, to)
          cur = to
          setDrag(to)
        }
      }
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== pid) return
        cleanup()
        if (active) {
          setDrag(null)
          if (cur !== i) drop()
        }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    }
  return { drag, press }
}

// ── Account 정렬 — 초기화 임박순 / 한도 적게 남은순 ─────────────────────────────
// 클릭 = 그 기준으로 "저장 순서 자체"를 재배열하고 저장한다(꾹-드래그로 옮긴 것과 동일
// 경로 — reorderAccounts). 순간 뷰 정렬이던 초판은 화면을 벗어나면 도로 흐트러지고
// 드래그까지 잠갔는데, 사용자가 원한 건 "누르면 그 순서로 굳는" 쪽(실사용 피드백) —
// 그래서 뷰 모드·영속 pref('account.sort')·드래그 잠금을 전부 걷었다. 정렬 결과는 채팅
// 계정 picker에도 그대로 반영되고, 이후 꾹-드래그로 언제든 다시 다듬을 수 있다.
type AcctSort = 'reset' | 'left'
// 라벨은 ko/en 필드 + 렌더 시 isEn() 분기 — 모듈 스코프 t() 금지(언어 전환이 못 따라옴)
const ACCT_SORTS: { id: AcctSort; ko: string; en: string }[] = [
  { id: 'reset', ko: '초기화 임박순', en: 'Resets soonest' },
  { id: 'left', ko: '한도 적게 남은순', en: 'Least limit left' }
]
// 정렬 키 — 초기화(reset)는 주간류(Fable·주간) 창 중 가장 이른 시각: 5시간 창은 어느
// 계정이든 엇비슷하게 곧 돌아와("1시간 안팎") 섞으면 정렬을 지배해버린다(실측 — 주간
// 12시간 남은 계정이 1일 22시간 계정 뒤로 밀림). 주간류가 없을 때만 5시간으로 폴백.
// 잔여(left)는 모든 창 중 가장 적게 남은 % — 가장 급한 창이 계정을 대표한다. 조회 못 한
// 계정(토큰 만료·아직 로딩 전)은 Infinity로 맨 뒤 — 동률 비교의 NaN은 sort 규약상 0 취급.
type AcctSortKeys = { reset: number; left: number }
function antSortKeys(u?: AccountUsage): AcctSortKeys {
  const weekly = [u?.fableResetsAt, u?.weeklyResetsAt].filter((x): x is number => x != null)
  const resets = weekly.length ? weekly : [u?.fiveHourResetsAt].filter((x): x is number => x != null)
  const lefts = [u?.fiveHourPct, u?.fablePct, u?.weeklyPct].filter((x): x is number => x != null).map((p) => 100 - p)
  return { reset: resets.length ? Math.min(...resets) : Infinity, left: lefts.length ? Math.min(...lefts) : Infinity }
}
function cxSortKeys(u?: CodexAccountUsage): AcctSortKeys {
  const wins = u?.windows ?? []
  // 시간 단위 창('5시간' 등) 제외 — 주간/일 단위 창이 하나도 없을 때만 전체로 폴백
  const long = wins.filter((w) => !/^\d+시간$/.test(w.label))
  const resets = (long.length ? long : wins).map((w) => w.resetsAt).filter((x): x is number => x != null)
  const lefts = wins.map((w) => 100 - w.usedPct)
  return { reset: resets.length ? Math.min(...resets) : Infinity, left: lefts.length ? Math.min(...lefts) : Infinity }
}
// 키로 정렬한 사본 — Array.sort는 안정 정렬이라 동률(둘 다 조회 전 등)은 기존 순서를 지킨다.
function sortAccounts<T>(list: T[], sort: AcctSort, keys: (a: T) => AcctSortKeys): T[] {
  return list
    .map((a) => ({ a, k: keys(a) }))
    .sort((x, y) => (sort === 'reset' ? x.k.reset - y.k.reset : x.k.left - y.k.left))
    .map((x) => x.a)
}

// ── ★M11 한도 소진 시 계정 자동 전환 (설정 옵션 · 기본 꺼짐) ────────────────────
//
// 이 자리에 두는 이유: 값이 사는 곳이 여기다. 바로 위 정렬 버튼에 이미
// 「초기화 임박순」이 있고, 그게 이 기능의 판정식과 **같은 규칙**이다 — 곧 리셋될 창의
// 잔량은 버려질 잔량이라 먼저 태우는 쪽이 총량에서 이득이다. 토글을 한도 화면이 아니라
// 계정 목록 바로 위에 두면 "무엇들 사이에서 고르는가"가 문장 없이 보인다.
//
// **전달은 `ui-prefs.json`으로** 한다(IPC 채널을 늘리지 않는다 — §6.1 32채널).
// 셸의 `engine/acct_switch.rs`가 같은 키를 3초 TTL로 읽고, 꺼져 있으면 후보 탐색
// 워커를 깨우지도 않는다 = 꺼짐이면 계정 조회 HTTP 0건.
//
// 계정이 2개 미만이면 **행 자체를 안 그린다**: 갈아탈 데가 없는데 스위치를 보여 주면
// 켜 놓고 "왜 안 되지"를 묻게 된다(계정 picker가 구독+계정≥2일 때만 뜨는 것과 같은 규약).
//
// ★R2(C5) — 여기서 세는 것은 **Claude(Anthropic) 구독 계정뿐**이다. R1은 Codex 계정까지
// 더해서(`accounts + cxAccounts`) 셌는데, 판정식(`ccg-auth::switch::plan`)은 Claude
// 구독 축만 본다. 클로드 1 + Codex 1이면 **켤 수 있는데 영원히 안 되는 스위치**가
// 그려졌고, 켜는 순간 워커가 도는 것은 덤이었다.
const AUTO_SWITCH_KEY = 'limitSwitch.on'
function AutoAccountSwitchRow({ count }: { count: number }): React.ReactElement | null {
  const [on, setOn] = useState<boolean>(() => getPref<boolean>(AUTO_SWITCH_KEY, false))
  if (count < 2) return null
  return (
    <div className="sc2 tgl" style={{ marginBottom: 14 }}>
      <div>
        <div className="em">{t('한도 소진 시 계정 자동 전환', 'Switch accounts when the limit runs out')}</div>
        <div className="meta">
          {on
            ? t(
                '한도에 걸리면 기다리지 않고 노는 계정으로 갈아타 이어가요 — 초기화가 임박한 계정부터 씁니다(곧 사라질 잔량이니까요). 지금 다른 대화가 쓰고 있는 계정과 여유가 거의 없는 계정은 건너뛰고, 갈아탈 곳이 없으면 평소처럼 기다려요.',
                'On hitting the limit this chat moves to an idle account instead of waiting — soonest-to-reset first, since that headroom is about to be thrown away. Accounts another chat is burning, and accounts with almost nothing left, are skipped; with no candidate it waits as before.'
              )
            : t(
                '한도에 걸리면 풀릴 때까지 기다려요(지금 동작). 켜면 노는 계정으로 갈아타 바로 이어갑니다.',
                'The chat waits for the limit to lift (current behavior). Turn this on to move to an idle account and keep going.'
              )}
        </div>
      </div>
      <span className="sp" />
      <button
        className={'sw2' + (on ? ' on' : '')}
        role="switch"
        aria-checked={on}
        aria-label={on ? t('자동 전환 끄기', 'Turn off auto-switch') : t('자동 전환 켜기', 'Turn on auto-switch')}
        onClick={() => {
          const next = !on
          setOn(next)
          setPref(AUTO_SWITCH_KEY, next)
        }}
      />
    </div>
  )
}

// ── Account (구독 로그인 Anthropic·OpenAI — 앱 등록 계정만, 전환 개념 없음) ───────
// 로그인/로그아웃 전부 격리 CONFIG_DIR(main/auth.ts) — 전역 ~/.claude 불가침.
// PoC 문법: 계정 카드(아바타·이메일·기본 배지·플랜) + 잔여 한도 미니 게이지 + 점선 추가 행.
function AccountView(): React.ReactElement {
  // 'login' | 'codex-login' | <email>(삭제 중) | 'codex'(OpenAI 삭제 중) | null
  const [busy, setBusy] = useState<string | null>(null)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // ★R28 ACCT §1 — 목록·한도의 주인은 **단일 스토어**다(`lib/accounts.ts`).
  //
  // R1까지 이 화면은 자기 `useState` 넷을 들고 탭을 열 때마다 `accountsUsage()`를 새로
  // 쐈다. 그런데 채팅 계정 picker도 자기 모듈 캐시로 같은 조회를 쐈다 — 두 표면을 같은
  // 순간에 열면 **HTTP가 두 벌**이었고, 그 규약은 1200ms 직렬이라 계정 수만큼 곱해졌다.
  // 이제 조회는 한 벌이고, 첫 그림은 디스크에 보존된 마지막 값이다(HTTP 0회).
  const acct = useAccounts()
  const accounts = acct.accounts
  const usage = acct.usage
  const cxAccounts = acct.cxAccounts
  const cxUsage = acct.cxUsage

  // 목록이 바뀐 뒤(로그인·삭제·순서 저장 실패) — 목록은 강제로 다시 뜨고, 한도도
  // 새 목록 기준으로 다시 묻는다(계정이 늘거나 줄었으니 TTL을 넘는 게 맞다).
  const reload = (): void => {
    invalidateAccounts()
    void ensureAccounts(true).then((list) => {
      if (list.length) void refreshUsage({ priority: list[0]?.email, force: true })
    })
    void ensureCodexAccounts(true).then((list) => {
      if (list.length) void refreshCodexUsage()
    })
  }
  // 탭을 열면 ① 디스크 캐시로 **즉시** 그리고 ② 뒤에서 갱신한다(stale-while-revalidate).
  // 주기 폴링은 없다 — usage API 예산이 빡빡해서(429) 호출을 아낀다. 우선 조회 대상은
  // 맨 위(=기본) 계정이다: 사용자가 제일 먼저 보는 숫자가 제일 먼저 갱신되게.
  // 429 백오프 재시도가 큐 안에서 끝나면 그 시점에 화면이 갱신된다(늦게 도착해도 반영).
  useEffect(() => {
    void primeUsageFromDisk()
    void ensureAccounts().then((list) => {
      if (list.length) void refreshUsage({ priority: list[0]?.email })
    })
    void ensureCodexAccounts().then((list) => {
      if (list.length) void refreshCodexUsage()
    })
  }, [])
  useEffect(() => window.api.auth.onLoginUrl(setLoginUrl), [])
  // 스토어에 앉히는 두 문 — 배열을 그대로 놓거나(`put`), 최신 값을 재료로 갱신하거나
  // (`update`, 드래그 재정렬이 쓰는 함수형 갱신). 이름을 옛 setState와 같게 두면
  // 아래 코드가 통째로 그대로 산다.
  const setAccounts = putAccounts
  const setCxAccounts = putCodexAccounts

  const addAccount = async (): Promise<void> => {
    setBusy('login')
    setLoginUrl(null)
    setNote(null)
    try {
      const res = await window.api.auth.login(false)
      if (!res.ok) setNote(res.error ?? t('로그인이 완료되지 않았어요', 'Sign-in was not completed'))
    } catch {
      /* ignore */
    }
    setBusy(null)
    setLoginUrl(null)
    reload()
  }
  // ★R28f SHIPBLOCK N1(3) — 계정 쓰기의 **실패는 화면에 보인다**.
  //
  // R1까지 이 화면의 catch는 대부분 `/* ignore */`였고, 그래도 티가 안 났던 이유는 심이
  // **실패를 안 던졌기** 때문이다(미구현 채널이 안전값 `[]`로 resolve → 목록이 빈 배열로
  // 갈아끼워짐 → 아무 문구도 없음 — 최종 파리티 감사 R2 §N1). 이제 쓰기 채널은 reject하고
  // (`api/shim.ts`의 `callStrict`), 그 reject가 도착하는 자리는 예외 없이 이 문구를 세운다.
  // 셸이 사람이 읽는 사유를 실어 보냈으면(`ShimUnavailableError.detail` — 예: "codex 실행
  // 파일을 찾지 못했어요") 그걸 그대로 보여 준다. 없으면 일반 문구.
  const failNote = (e?: unknown): void =>
    setNote(
      (e as { detail?: string } | null)?.detail ??
        t(
          '요청이 실패했어요 — 앱을 재시작한 뒤 다시 시도해 주세요(계정 목록은 그대로 둡니다)',
          'The request failed — restart the app and try again (the account list is left untouched)'
        )
    )
  // 삭제 = 그 계정 토큰 해지(서버) + 등록 제거 — 다시 쓰려면 재로그인
  const doDelete = async (email: string): Promise<void> => {
    setBusy(email)
    setNote(null)
    try {
      setAccounts(await window.api.auth.logout(email))
    } catch (e) {
      failNote(e)
    }
    setBusy(null)
    reload()
  }
  // ★R28 ACCT §4 — 「기본으로」가 **「맨 위로」**가 됐다.
  //
  // 사용자 요청: *"계정의 「기본」 개념을 삭제하고, 항상 정렬 기준 맨 위 계정이 선택되게.
  // 괜히 복잡하다."* 그래서 기본은 저장된 상태가 아니라 **이 목록의 0번**이고, 이 버튼은
  // 순서를 바꾸는 일만 한다(셸에서도 `auth:set-default-account` = 「맨 위로 이동」).
  // 낙관 갱신도 배지 이동이 아니라 **배열 이동**이다 — 그래야 화면과 판정이 같은 규칙을 쓴다.
  const doMoveTop = async (email: string): Promise<void> => {
    setNote(null)
    updateAccounts((prev) => {
      const i = prev?.findIndex((a) => a.email === email) ?? -1
      return prev && i > 0 ? arrMove(prev, i, 0) : prev
    })
    try {
      setAccounts(await window.api.auth.setDefaultAccount(email))
    } catch {
      setNote(t('순서를 바꾸지 못했어요 — 앱을 재시작한 뒤 다시 시도해 주세요', 'Could not change the order — restart the app and try again'))
      reload()
    }
  }
  // OpenAI(Codex) — Anthropic과 같은 동작 3종 (추가/삭제/맨 위로)
  const doCodexLogin = async (): Promise<void> => {
    setBusy('codex-login')
    setLoginUrl(null)
    setNote(null)
    try {
      setCxAccounts(await window.api.codexAuth.login())
    } catch (e) {
      failNote(e)
    }
    setBusy(null)
    setLoginUrl(null)
    reload()
  }
  const doCodexDelete = async (email: string): Promise<void> => {
    setBusy('cx:' + email)
    setNote(null)
    try {
      setCxAccounts(await window.api.codexAuth.logout(email))
    } catch (e) {
      failNote(e)
    }
    setBusy(null)
  }
  // ★R28 ACCT §4 — Codex 축의 「맨 위로」.
  //
  // ★R28f SHIPBLOCK N1 — 이 자리가 R1까지 `reorderAccounts`를 부른 이유는 *"셸에 이
  // 채널의 핸들러가 없으므로"*였고, 그래서 주석의 *"실제로 저장된다"*는 **거짓이었다**
  // (재정렬 채널에도 핸들러가 없었다 — 두 채널 다 `{__unimplemented}`). 이제 다섯 채널이
  // 전부 셸에 있고, Anthropic 축의 `doMoveTop`과 **같은 채널**을 쓴다(`setDefaultAccount`
  // = 「맨 위로 이동」 — `ipc/accounts.rs`·장부 §6.5).
  const doCodexMoveTop = async (email: string): Promise<void> => {
    setNote(null)
    updateCodexAccounts((prev) => {
      const i = prev?.findIndex((a) => a.email === email) ?? -1
      return prev && i > 0 ? arrMove(prev, i, 0) : prev
    })
    try {
      setCxAccounts(await window.api.codexAuth.setDefaultAccount(email))
    } catch {
      setNote(t('순서를 바꾸지 못했어요 — 앱을 재시작한 뒤 다시 시도해 주세요', 'Could not change the order — restart the app and try again'))
      reload()
    }
  }
  const planLabel = (ty?: string): string =>
    ty ? ty.charAt(0).toUpperCase() + ty.slice(1) + t(' 플랜', ' plan') : t('구독', 'Subscription')

  // ── 꾹-드래그 재정렬 — 스토어 배열 순서가 곧 표시 순서(채팅 계정 picker 공통)라 로컬을
  // 즉시 재배열(낙관)하고, 놓을 때 최종 순서를 저장한다(실패하면 reload로 서버 순서 복원).
  // drop의 함수형 setState는 저장 시점에 "마지막 move까지 반영된" 배열을 읽기 위한 것.
  // 저장 실패는 **조용히 넘어가지 않는다** — 서버 순서로 되돌리고(reload) 문구를 세운다.
  const orderFailed = (): void => {
    setNote(t('순서를 저장하지 못했어요 — 앱을 재시작한 뒤 다시 시도해 주세요', 'Could not save the order — restart the app and try again'))
    reload()
  }
  const antDrag = useHoldReorder(
    accounts?.length ?? 0,
    (from, to) => updateAccounts((prev) => (prev ? arrMove(prev, from, to) : prev)),
    () =>
      updateAccounts((prev) => {
        if (prev) void window.api.auth.reorderAccounts(prev.map((a) => a.email)).then(setAccounts).catch(orderFailed)
        return prev
      })
  )
  const cxDrag = useHoldReorder(
    cxAccounts?.length ?? 0,
    (from, to) => updateCodexAccounts((prev) => (prev ? arrMove(prev, from, to) : prev)),
    () =>
      updateCodexAccounts((prev) => {
        if (prev) void window.api.codexAuth.reorderAccounts(prev.map((a) => a.email)).then(setCxAccounts).catch(orderFailed)
        return prev
      })
  )

  // 정렬 버튼 = 저장 순서 재배열 — 꾹-드래그의 drop과 같은 경로(낙관 재배열 → reorder 저장,
  // 실패하면 reload로 서버 순서 복원). 두 엔진 목록에 한 번에 적용하고, 이미 그 순서면
  // (안정 정렬이 같은 배열을 내면) 저장을 건너뛴다. 함수형 setState라 드래그 직후의
  // 마지막 배열을 그대로 재료로 쓴다.
  const applySort = (sort: AcctSort): void => {
    updateAccounts((prev) => {
      if (!prev || prev.length < 2) return prev
      const next = sortAccounts(prev, sort, (a) => antSortKeys(usage[a.email]))
      if (next.every((a, i) => a === prev[i])) return prev
      void window.api.auth.reorderAccounts(next.map((a) => a.email)).then(setAccounts).catch(orderFailed)
      return next
    })
    updateCodexAccounts((prev) => {
      if (!prev || prev.length < 2) return prev
      const next = sortAccounts(prev, sort, (a) => cxSortKeys(cxUsage[a.email]))
      if (next.every((a, i) => a === prev[i])) return prev
      void window.api.codexAuth.reorderAccounts(next.map((a) => a.email)).then(setCxAccounts).catch(orderFailed)
      return next
    })
  }

  return (
    <>
      <div className="set-h1">Account</div>
      <div className="set-h1-sub">
        {/* ★R28 ACCT §4 — 「기본」이라는 별도 상태가 사라졌다. 안 고른 채팅이 쓰는 계정은
            **이 목록의 맨 위**다. 설명도 그 규칙 하나만 말한다(옛 문구는 「기본」 배지·버튼을
            가리켰는데 그 둘이 이제 없다). */}
        {isEn() ? (
          <>
            Subscription sign-in — managed per engine. Runs only use accounts registered here — each chat can pick
            its own account, and chats without one run on the <strong>account at the top of this list</strong>.
            Press and hold a card to drag it into a different order; the sort buttons reorder and{' '}
            <strong>save</strong> that order (the chat account picker follows it).
          </>
        ) : (
          <>
            구독 계정 로그인 — 엔진별로 따로 관리돼요. 실행에는 여기 등록된 계정만 쓰여요 — 채팅마다 계정을 따로
            고를 수 있고, 안 고른 채팅은 <strong>이 목록 맨 위</strong> 계정으로 실행돼요. 계정 카드는 꾹 눌러 끌어
            순서를 바꾸고, 정렬 버튼은 그 기준으로 순서를 <strong>저장</strong>까지 해요(채팅 계정 picker도 이
            순서를 따라요).
          </>
        )}
      </div>

      {/* 정렬 버튼 — 클릭 = 그 기준으로 저장 순서 재배열(두 엔진 목록 함께) */}
      <div className="set-sortrow" role="group" aria-label={t('정렬', 'Sort')}>
        <span className="sl">{t('정렬', 'Sort')}</span>
        {ACCT_SORTS.map((o) => (
          <button key={o.id} className="set-chipbtn" onClick={() => applySort(o.id)}>
            {isEn() ? o.en : o.ko}
          </button>
        ))}
      </div>

      <AutoAccountSwitchRow count={accounts?.length ?? 0} />

      <div className="set-sec">Anthropic</div>
      {accounts == null ? (
        <div className="sc2 acct">
          <div className="meta">
            <span className="set-spin" /> {t('불러오는 중…', 'Loading…')}
          </div>
        </div>
      ) : (
        <>
          {accounts.map((a, i) => {
            return (
            <div
              className={'sc2 acct' + (antDrag.drag === i ? ' drag' : '')}
              key={a.email}
              onPointerDown={busy == null ? antDrag.press(i) : undefined}
            >
              <div className="ava2" style={{ background: AVA_SWATCHES[i % AVA_SWATCHES.length] }}>
                {a.email.charAt(0).toUpperCase()}
              </div>
              <div className="who">
                <div className="em">
                  <span className="emt">{a.email}</span>
                  {/* ★R28 ACCT §4 — 배지는 **인덱스 0의 파생 표시**다(저장된 상태가 아니다).
                      셸도 같은 규칙으로 `isDefault`를 싣는다 — 진실이 두 곳이 되지 않게 그 값을 쓴다. */}
                  {a.isDefault && <span className="set-badge">{t('기본 · 맨 위', 'Default · top')}</span>}
                  {/* ★R28 ACCT §3 — 다른 자리가 이 계정으로 **지금 돌고 있다**(주황).
                      선택을 막지 않는다 — 사용자가 알고 쓰는 건 존중하고, 모르고 겹치는 것만 막는다. */}
                  {inUseLabel(a.email) && <span className="set-badge warn">{inUseLabel(a.email)}</span>}
                  {/* ★M11 R3(F2) — 토큰 교환이 실패한 계정. R2까지 이 사실은 stderr 한 줄로만
                      남았고, 사용자는 갈아탄 자리에서 로그인 창을 보고서야 알았다. 자동 전환은
                      이미 이 계정을 후보에서 뺐다(격리) — 그 판정을 여기서도 말한다.
                      ★R4(G2) — R3의 문구는 "삭제하고 다시 로그인하면 풀립니다"였는데, 401이
                      난 그 순간 계정이 스토어에 없었으면(로그아웃 = 토큰 해지라 흔한 판)
                      표식에 지문이 안 적혀 **어떤 재로그인으로도 안 풀렸다**. 이제 해제 경로가
                      셋이고(조회 성공 · 재로그인 · 크리덴셜 복귀) 문구도 그 셋을 말한다. */}
                  {a.needsLogin && <span className="set-badge warn">{t('재로그인 필요할 수 있어요', 'May need sign-in')}</span>}
                </div>
                <div className="meta">
                  {a.needsLogin
                    ? t(
                        '토큰 갱신이 실패해 자동 전환 후보에서 잠시 빠졌어요. 한도 조회가 한 번 성공하거나 다시 로그인하면 자동으로 풀려요.',
                        'Token refresh failed, so this account is held out of auto-switch for now. It clears itself once a usage check succeeds, or after you sign in again.'
                      )
                    : planLabel(a.subscriptionType)}
                </div>
              </div>
              <AccountLimits
                u={usage[a.email]}
                loading={acct.loading}
                // 수동 재시도는 TTL을 넘는다 — 사용자가 「다시 시도」를 눌렀는데 캐시가
                // 나오면 그 버튼은 아무 일도 안 하는 버튼이다.
                onRetry={() => void refreshUsage({ priority: a.email, force: true })}
              />
              <div className="acts">
                {!a.isDefault && (
                  <button className="set-chipbtn" disabled={busy != null} onClick={() => void doMoveTop(a.email)}>
                    {t('맨 위로', 'Move to top')}
                  </button>
                )}
                <button className="set-chipbtn danger" disabled={busy != null} onClick={() => void doDelete(a.email)}>
                  {busy === a.email ? t('삭제 중…', 'Deleting…') : t('삭제', 'Delete')}
                </button>
              </div>
            </div>
            )
          })}
          {busy === 'login' ? (
            <div className="sc2 acct">
              <div className="ava2" style={{ background: 'rgba(255,255,255,.12)' }}>
                <span className="set-spin" />
              </div>
              <div className="who">
                <div className="em">{t('로그인 진행 중…', 'Signing in…')}</div>
                <div className="meta">{t('브라우저에서 로그인을 완료하세요', 'Complete the sign-in in your browser')}</div>
              </div>
              <button className="set-chipbtn" onClick={() => window.api.auth.cancelLogin().catch(() => {})}>
                {t('취소', 'Cancel')}
              </button>
            </div>
          ) : (
            <button className="set-addrow" disabled={busy != null} onClick={() => void addAccount()}>
              <IconPlus size={12} /> {t('계정 추가', 'Add account')}
            </button>
          )}
        </>
      )}

      <div className="set-sec">OpenAI</div>
      {cxAccounts == null ? (
        <div className="sc2 acct">
          <div className="meta">
            <span className="set-spin" /> {t('불러오는 중…', 'Loading…')}
          </div>
        </div>
      ) : (
        <>
          {cxAccounts.map((a, i) => {
            return (
            <div
              className={'sc2 acct' + (cxDrag.drag === i ? ' drag' : '')}
              key={a.email}
              onPointerDown={busy == null ? cxDrag.press(i) : undefined}
            >
              <div className="ava2" style={{ background: AVA_SWATCHES[(i + 6) % AVA_SWATCHES.length] }}>
                {a.email.charAt(0).toUpperCase()}
              </div>
              <div className="who">
                <div className="em">
                  <span className="emt">{a.email}</span>
                  {/* ★R28 ACCT §4 — Anthropic과 같은 규칙(맨 위 = 기본, 파생값) */}
                  {a.isDefault && <span className="set-badge">{t('기본 · 맨 위', 'Default · top')}</span>}
                </div>
                {/* 플랜은 rateLimits의 planType이 최신(구독 변경 즉시 반영) — 도착 전엔 id_token 값 */}
                <div className="meta">{chatgptPlan(cxUsage[a.email]?.planType ?? a.plan)}</div>
              </div>
              <CodexLimits u={cxUsage[a.email]} />
              <div className="acts">
                {!a.isDefault && (
                  <button className="set-chipbtn" disabled={busy != null} onClick={() => void doCodexMoveTop(a.email)}>
                    {t('맨 위로', 'Move to top')}
                  </button>
                )}
                <button className="set-chipbtn danger" disabled={busy != null} onClick={() => void doCodexDelete(a.email)}>
                  {busy === 'cx:' + a.email ? t('삭제 중…', 'Deleting…') : t('삭제', 'Delete')}
                </button>
              </div>
            </div>
            )
          })}
          {busy === 'codex-login' ? (
            <div className="sc2 acct">
              <div className="ava2" style={{ background: 'rgba(255,255,255,.12)' }}>
                <span className="set-spin" />
              </div>
              <div className="who">
                <div className="em">{t('로그인 진행 중…', 'Signing in…')}</div>
                <div className="meta">{t('브라우저에서 ChatGPT 로그인을 완료하세요', 'Complete the ChatGPT sign-in in your browser')}</div>
              </div>
              <button className="set-chipbtn" onClick={() => window.api.codexAuth.cancelLogin().catch(() => {})}>
                {t('취소', 'Cancel')}
              </button>
            </div>
          ) : (
            <button className="set-addrow" disabled={busy != null} onClick={() => void doCodexLogin()}>
              <IconPlus size={12} /> {t('계정 추가', 'Add account')}
            </button>
          )}
        </>
      )}

      {note && <div className="set-note2">{note}</div>}
      {(busy === 'login' || busy === 'codex-login') && loginUrl && (
        <div className="set-note2">
          {t('브라우저가 안 열렸나요?', 'Browser didn’t open?')}{' '}
          <a href={loginUrl} target="_blank" rel="noreferrer">
            {t('이 링크로 로그인', 'Sign in with this link')}
          </a>
        </div>
      )}
      <div className="set-note2">
        {isEn() ? (
          <>
            All account credentials are stored <b>encrypted (DPAPI)</b> in <code>~/.agentcodegui</code>. They are
            fully separate from your terminal Claude Code (<code>~/.claude</code>) and codex (<code>~/.codex</code>)
            logins — neither affects the other.
          </>
        ) : (
          <>
            계정 크리덴셜은 모두 <code>~/.agentcodegui</code>에 <b>암호화(DPAPI)</b>되어 저장돼요. 터미널 Claude Code(
            <code>~/.claude</code>)·codex(<code>~/.codex</code>)의 로그인과는 완전히 분리돼 서로 영향을 주지 않아요.
          </>
        )}
      </div>
    </>
  )
}

// ChatGPT 플랜 표기 — Anthropic의 "Max 플랜"과 같은 문법
function chatgptPlan(plan: string | null | undefined): string {
  return 'ChatGPT' + (plan ? ' ' + plan.charAt(0).toUpperCase() + plan.slice(1) : '') + t(' 플랜', ' plan')
}

// 한도 초기화 절대 시각 — '7/18 (토) 15:00'. 표시는 남은 시간(fmtResetIn)이 맡고,
// 이건 그 칸의 호버 툴팁으로만 남는다(정확한 시각이 궁금할 때).
function fmtResetAt(ts?: number | null): string | null {
  if (!ts) return null
  const d = new Date(ts * 1000)
  const day = isEn()
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
    : ['일', '월', '화', '수', '목', '금', '토'][d.getDay()]
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${d.getMonth() + 1}/${d.getDate()} (${day}) ${hm}`
}
// 초기화까지 남은 시간 — '2시간 10분 뒤', 하루를 넘기면 '7일 3시간 뒤'. 주간류 긴 창도
// 절대 날짜('8/21 (금) 15:00')보다 "얼마나 남았나"가 유용하다는 실사용 피드백으로 전 창 통일.
function fmtResetIn(ts?: number | null): string | null {
  if (!ts) return null
  const diff = ts * 1000 - Date.now()
  if (diff <= 0) return t('곧', 'soon')
  const m = Math.max(1, Math.round(diff / 60000))
  if (m < 60) return t(`${m}분 뒤`, `in ${m}m`)
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h < 24) return mm ? t(`${h}시간 ${mm}분 뒤`, `in ${h}h ${mm}m`) : t(`${h}시간 뒤`, `in ${h}h`)
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh ? t(`${d}일 ${hh}시간 뒤`, `in ${d}d ${hh}h`) : t(`${d}일 뒤`, `in ${d}d`)
}

// 한도 게이지 한 행 — 라벨 · 잔여 바 · "n% 남음" · 초기화까지 남은 시간. 맨숫자는 방향(남은량/
// 소모량)을 못 말해줘 "남음"을 숫자마다 붙인다(컨텍스트 팝오버와 같은 표기). 잔량이
// 낮으면(잔량 톤) 바·숫자가 색으로 도드라진다.
// 시간 칸은 창 길이와 무관하게 남은 시간('7일 3시간 뒤') — 절대 시각은 호버 툴팁.
// 초기화 시각을 모르는 항목(구 캐시 등)도 빈 칸을 그려 열 정렬을 유지한다.
function LimRow({ label, left, resetsAt }: { label: string; left: number; resetsAt?: number | null }): React.ReactElement {
  const tone = remainTone(left)
  return (
    <div className={'lim' + (tone ? ' ' + tone : '')}>
      <span className="ll">{label}</span>
      <div className="g2">
        <i style={{ width: left + '%' }} />
      </div>
      <span className="lv">
        <b>{left}%</b> {t('남음', 'left')}
      </span>
      <span className="lr" title={fmtResetAt(resetsAt) ?? undefined}>
        {fmtResetIn(resetsAt)}
      </span>
    </div>
  )
}

// OpenAI 계정 카드의 잔여 한도 미니 게이지 — rateLimits의 윈도(5시간·주간 등)를
// Anthropic 카드와 같은 게이지 문법(잔여 % = 100 − 사용률)으로.
// 창 라벨은 메인이 한국어('n시간'·'주간'·'n일'·'한도')로 만든다 — 표시 지점에서만 영어로 변환.
function cxWindowLabel(label: string): string {
  if (!isEn()) return label
  const h = /^(\d+)시간$/.exec(label)
  if (h) return `${h[1]}h`
  if (label === '주간') return 'Weekly'
  const d = /^(\d+)일$/.exec(label)
  if (d) return `${d[1]}d`
  if (label === '한도') return 'Limit'
  return label
}
function CodexLimits({ u }: { u?: CodexAccountUsage }): React.ReactElement | null {
  if (!u || u.windows.length === 0) return null
  return (
    <div className="limits">
      {u.windows.map((w) => (
        <LimRow key={w.label} label={cxWindowLabel(w.label)} left={100 - w.usedPct} resetsAt={w.resetsAt} />
      ))}
    </div>
  )
}

// 계정 카드의 잔여 한도 미니 게이지 — 앱 전체 관례(잔여 % = 100 − 사용률). 조회 못 한
// 항목은 조용히 빠진다(저장 토큰 만료 등 — 실행하면 CLI가 리프레시한다).
// 행 순서는 컨텍스트 팝오버와 동일: 5시간 → Fable → 주간.
/**
 * 계정 한 줄의 한도 게이지.
 *
 * ★R28 ACCT §1 — **실패를 「데이터 없음」으로 뭉개지 않는다.**
 *
 * R1까지 이 컴포넌트는 값이 없으면 `null`을 돌려줬다. 그래서 429 한 번, 네트워크 한 번에
 * 그 자리가 그냥 **빈 칸**이 됐고, 사용자에게는 "안 된다"와 "그 계정엔 그런 한도가 없다"가
 * 구별되지 않았다(사용자 보고의 그 증상). 이제 셋을 나눠 말한다:
 *
 *  - 조회 중(`loading`이고 값이 없다) → 스피너
 *  - 물어보지 못했다(`unavailable`) → 「조회 실패 · 다시 시도」
 *  - 낡은 값(`stale`) → 숫자는 그대로 그리고 표식만 얹는다(값이 있으면 그게 마지막 실측이다)
 */
function AccountLimits({
  u,
  loading,
  onRetry
}: {
  u?: AccountUsage
  loading?: boolean
  onRetry?: () => void
}): React.ReactElement | null {
  const rows: { label: string; left: number; resetsAt?: number | null }[] = []
  if (u?.fiveHourPct != null) rows.push({ label: t('5시간', '5h'), left: 100 - u.fiveHourPct, resetsAt: u.fiveHourResetsAt })
  if (u?.fablePct != null) rows.push({ label: 'Fable', left: 100 - u.fablePct, resetsAt: u.fableResetsAt })
  if (u?.weeklyPct != null) rows.push({ label: t('주간', 'Weekly'), left: 100 - u.weeklyPct, resetsAt: u.weeklyResetsAt })
  if (!rows.length) {
    if (loading) {
      return (
        <div className="limits lim-state">
          <span className="set-spin" /> {t('한도 조회 중…', 'Checking limits…')}
        </div>
      )
    }
    if (!u || u.unavailable) {
      return (
        <div className="limits lim-state">
          <span className="lim-fail">{t('한도를 못 불러왔어요', 'Couldn’t load limits')}</span>
          {onRetry && (
            <button className="set-chipbtn" onClick={onRetry}>
              {t('다시 시도', 'Retry')}
            </button>
          )}
        </div>
      )
    }
    return null // 값은 왔는데 창이 하나도 없다 = 그 플랜엔 표시할 한도가 없다
  }
  return (
    <div className="limits">
      {rows.map((r) => (
        <LimRow key={r.label} label={r.label} left={r.left} resetsAt={r.resetsAt} />
      ))}
      {u?.stale && <div className="lim-stale">{t('마지막으로 확인한 값', 'Last known value')}</div>}
    </div>
  )
}

// ── Engine (PoC 문법) — 엔진 CLI 버전 관리 카드. Claude Code와 Codex CLI가 같은
// api 표면(state/listAvailable/install/…)을 받아 완전히 같은 UI로 관리된다.
type EngineApi = (typeof window.api)['engine']

// ── Claude Code 출력 스타일 — CLI 내장 스타일(2.1.237 실측) + '기본' ─────────────
// 스타일명은 CLI 고유명이라 영문 그대로, 설명은 CLI의 공식 설명을 옮긴 것. '기본'은
// 아무것도 주입하지 않아 사용자의 ~/.claude 설정(있다면)이 그대로 적용된다. 값은
// ui-prefs('claude.outputStyle')에 저장되고 main(claude/engine.ts)이 실행 스폰마다 읽어
// --settings의 outputStyle로 넣는다 — 다음 메시지부터 적용.
// 라벨/설명은 ko/en 필드 + 렌더 시 isEn() 분기 — 모듈 스코프 t() 금지(언어 전환이 못 따라옴)
const CLAUDE_STYLE_KEY = 'claude.outputStyle'
const CLAUDE_STYLES: { id: string; label: string; ko: string; en: string }[] = [
  { id: 'default', label: '', ko: '클로드 코드 기본 스타일이에요', en: "Claude Code's default style" },
  {
    id: 'Concise',
    label: 'Concise',
    ko: '결과부터 짧게 답해요 — 서론·과정 내레이션은 건너뛰어요',
    en: 'Responds tersely, leading with results and skipping preamble and narration'
  },
  {
    id: 'Explanatory',
    label: 'Explanatory',
    ko: '구현 선택과 코드베이스 패턴을 설명하며 진행해요',
    en: 'Explains its implementation choices and codebase patterns'
  },
  {
    id: 'Learning',
    label: 'Learning',
    ko: '잠깐씩 멈춰 작은 코드를 직접 써 보게 해요 — 실습용',
    en: 'Pauses and asks you to write small pieces of code for hands-on practice'
  },
  {
    id: 'Proactive',
    label: 'Proactive',
    ko: '계획·확인보다 즉시 실행을 우선해요',
    en: 'Executes immediately, minimizes interruptions, and prefers action over planning'
  }
]

function ClaudeStyleCard(): React.ReactElement {
  const [style, setStyle] = useState<string>(() => getPref<string>(CLAUDE_STYLE_KEY, 'default'))
  const pick = (id: string): void => {
    setStyle(id)
    setPref(CLAUDE_STYLE_KEY, id)
  }
  const cur = CLAUDE_STYLES.find((s) => s.id === style) ?? CLAUDE_STYLES[0]
  return (
    <div className="sc2 tgl" style={{ flexWrap: 'wrap', rowGap: 9 }}>
      <div style={{ minWidth: 200, flex: '1 1 0' }}>
        <div className="em">{t('출력 스타일', 'Output style')}</div>
        <div className="meta">
          {isEn() ? cur.en : cur.ko} · {t('다음 메시지부터 적용돼요', 'Applies from the next message')}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label={t('출력 스타일', 'Output style')}>
        {CLAUDE_STYLES.map((s) => (
          // 설명 툴팁은 앱 커스텀(has-tip/data-tip) — 네이티브 title은 윈도우 기본 툴팁이 떠서 이질적
          <button
            key={s.id}
            className={'set-chipbtn has-tip tip-wrap' + (style === s.id ? ' on' : '')}
            role="radio"
            aria-checked={style === s.id}
            data-tip={isEn() ? s.en : s.ko}
            onClick={() => pick(s.id)}
          >
            {s.label || t('기본', 'Default')}
          </button>
        ))}
      </div>
    </div>
  )
}

function EngineView(): React.ReactElement {
  // 두 엔진 공통 자동 업데이트 — null=아직 조회 전(토글 비활성), 낙관 갱신 후 서버 값으로 확정
  const [auto, setAuto] = useState<boolean | null>(null)
  useEffect(() => {
    window.api.engineAutoUpdate().then(setAuto).catch(() => {})
  }, [])
  const toggleAuto = (): void => {
    if (auto == null) return
    const next = !auto
    setAuto(next)
    window.api.engineAutoUpdate(next).then(setAuto).catch(() => {})
  }
  return (
    <>
      <div className="set-h1">Engine</div>
      <div className="set-h1-sub">
        {t(
          '엔진마다 CLI가 따로 설치돼요 — 채팅의 엔진 선택(Anthropic/OpenAI)이 여기서 관리하는 CLI로 실행돼요. 버전을 고르면 전용 폴더에 설치되고, 시스템에 전역 설치된 CLI는 건드리지 않아요.',
          'Each engine installs its own CLI — the chat’s engine choice (Anthropic/OpenAI) runs on the CLI managed here. Picked versions install into a dedicated folder and never touch a globally installed CLI.'
        )}
      </div>
      <div className="set-sec">Anthropic</div>
      <EngineCard name="Claude Code" tile={<LogoClaude size={20} />} fallback={t('번들', 'bundled')} api={window.api.engine} />
      {/* 출력 스타일 — Claude Code 실행의 응답 결(Concise 등). Codex엔 대응 개념이 없어 여기만 */}
      <ClaudeStyleCard />
      <div className="set-sec">OpenAI</div>
      <EngineCard name="Codex CLI" tile={<LogoOpenAI size={20} />} fallback={t('전역 설치', 'global install')} api={window.api.codexEngine} />
      <div className="set-sec">{t('공통', 'Common')}</div>
      <div className="sc2 tgl" style={{ marginTop: 0 }}>
        <div>
          <div className="em">{t('자동 업데이트', 'Auto-update')}</div>
          <div className="meta">{t('새 버전이 나오면 조용히 설치해서 사용해요 — 두 엔진 모두', 'Quietly installs and uses new versions — both engines')}</div>
        </div>
        <span className="sp" />
        <button className={'sw2' + (auto ? ' on' : '')} aria-label={t('자동 업데이트', 'Auto-update')} disabled={auto == null} onClick={toggleAuto} />
      </div>
      <div className="set-note2">
        {t('설치 위치', 'Install location')}: <code>~/.agentcodegui/engines</code> · <code>~/.agentcodegui/codex-engines</code>
      </div>
    </>
  )
}

function EngineCard({
  name,
  tile,
  fallback,
  api
}: {
  name: string
  tile: React.ReactNode // 공식 로고 (LogoClaude/LogoOpenAI) — 두 엔진 모두 중립 타일(색감 통일)
  fallback: string // 설치·고정본이 없을 때 실제로 도는 것 — '번들'(claude) / '전역 설치'(codex)
  api: EngineApi
}): React.ReactElement {
  const [state, setState] = useState<EngineVersionState | null>(null)
  const [available, setAvailable] = useState<EngineVersionEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // version currently installing
  const [dialog, setDialog] = useState<{
    title: string
    message: string
    tone?: 'danger' | 'warn' | 'ok' // ok = 결과 알림 (체크 아이콘, 확인만)
    confirm?: { label: string; action: () => void }
  } | null>(null)
  const [cleaning, setCleaning] = useState(false) // 이전 버전 정리 진행 중
  const [install, setInstall] = useState<{
    version: string
    log: string[]
    status: 'running' | 'done' | 'error'
    error?: string
  } | null>(null)
  const [open, setOpen] = useState(false)
  const pickRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const refreshState = (): void => {
    api.state().then(setState).catch(() => {})
  }
  const refreshList = (): void => {
    setLoading(true)
    setListError(null)
    api
      .listAvailable()
      .then((r) => {
        setAvailable(r.versions)
        // ★CRIT R1 — **사유를 값으로 읽는다.** 3.0은 실패를 던지지 않고
        // `{latest:null, versions:[], error}`로 내리는데(`ccg-engine/src/versions.rs:57`),
        // 여기가 `r.versions`만 읽어 `listError`가 영영 `null`이었다. 그래서 npm(Node.js)이
        // 없는 컴퓨터에서 **목록 0개 + 오류 문구 0줄**이 됐다(R28 T1T2 확인 크리틱 R2 §5.2
        // 실측: 2.6.2는 같은 판에서 274개를 그린다). 값이 왔으면 사유는 안 띄운다 —
        // 부분 실패(한쪽 채널만 죽음)에서 목록을 지우는 쪽이 더 나쁘다.
        setListError(r.versions.length === 0 ? (r.error ?? null) : null)
      })
      .catch((e: unknown) => setListError(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    refreshState()
    refreshList()
    return api.onInstallProgress((p) => {
      if (p.line) setInstall((c) => (c ? { ...c, log: [...c.log, p.line as string] } : c))
    })
  }, [])

  // keep the log scrolled to the latest line
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [install?.log])

  // close the dropdown on a click outside the picker / Escape.
  // capture phase so the settings modal's stopPropagation doesn't swallow it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const apply = async (version: string, installed: boolean): Promise<void> => {
    if (installed) {
      // already installed → just switch (quick); surface failures as a small dialog
      try {
        await api.setActive(version)
      } catch (e) {
        setDialog({ title: t('전환 실패', 'Switch failed'), message: String((e as Error)?.message ?? e) })
      }
      refreshState()
      return
    }
    setBusy(version)
    setInstall({ version, log: [t('설치를 준비하는 중…', 'Preparing the install…')], status: 'running' })
    try {
      const r = await api.install(version)
      if (r.ok) {
        await api.setActive(version) // 설치하면 바로 그 버전을 사용
        setInstall((c) => (c ? { ...c, status: 'done' } : c))
      } else {
        setInstall((c) =>
          c
            ? {
                ...c,
                status: 'error',
                error: r.error ?? t('알 수 없는 오류로 설치에 실패했습니다.', 'The install failed with an unknown error.')
              }
            : c
        )
      }
    } catch (e) {
      setInstall((c) => (c ? { ...c, status: 'error', error: String((e as Error)?.message ?? e) } : c))
    } finally {
      setBusy(null)
      refreshState()
    }
  }

  const doRemove = async (version: string): Promise<void> => {
    try {
      await api.uninstall(version)
    } catch (e) {
      setDialog({ title: t('삭제 실패', 'Delete failed'), message: String((e as Error)?.message ?? e) })
      return
    }
    refreshState()
  }
  const askDelete = (version: string): void => {
    setOpen(false)
    setDialog({
      title: t('버전 삭제', 'Delete version'),
      message: t(
        `${version} 버전을 삭제할까요? ~/.agentcodegui 에서 제거됩니다.`,
        `Delete version ${version}? It will be removed from ~/.agentcodegui.`
      ),
      confirm: { label: t('삭제', 'Delete'), action: () => void doRemove(version) }
    })
  }

  // "current" = the version installed & selected in ~/.agentcodegui (null until one is installed)
  const current = state?.active ?? null

  // 이전 버전 일괄 정리 — 최신 설치본(installed[0], 내림차순 정렬)만 남긴다
  const newest = state?.installed[0] ?? null
  const oldCount = Math.max(0, (state?.installed.length ?? 0) - 1)
  const doCleanup = async (): Promise<void> => {
    setCleaning(true)
    try {
      const r = await api.cleanup()
      setDialog({
        title: t('정리 완료', 'Cleanup complete'),
        tone: 'ok',
        message:
          t(
            `이전 버전 ${r.removed.length}개를 삭제했습니다`,
            `Deleted ${r.removed.length} older version${r.removed.length === 1 ? '' : 's'}`
          ) +
          (r.freedBytes > 0 ? t(` (${fmtBytes(r.freedBytes)} 확보)`, ` (${fmtBytes(r.freedBytes)} freed)`) : '') +
          '.' +
          (r.activeSwitched && r.kept
            ? t(` 사용 버전이 ${r.kept}(으)로 전환되었습니다.`, ` The version in use switched to ${r.kept}.`)
            : '')
      })
    } catch (e) {
      setDialog({ title: t('정리 실패', 'Cleanup failed'), message: String((e as Error)?.message ?? e) })
    } finally {
      setCleaning(false)
      refreshState()
    }
  }
  const askCleanup = (): void => {
    if (!newest || oldCount === 0) return
    // 사용 중인 버전이 최신이 아니면 그것도 삭제 대상 — 전환된다는 걸 미리 알린다
    const activeIsOld = !!current && current !== newest
    setDialog({
      title: t('이전 버전 정리', 'Clean up old versions'),
      message:
        t(
          `최신 ${newest} 버전만 남기고 이전 버전 ${oldCount}개를 삭제할까요? `,
          `Keep only the latest ${newest} and delete ${oldCount} older version${oldCount === 1 ? '' : 's'}? `
        ) +
        t(`~/.agentcodegui/engines 에서 제거됩니다.`, `They will be removed from ~/.agentcodegui/engines.`) +
        (activeIsOld
          ? t(
              ` 사용 중인 ${current}도 삭제 대상이라, 정리 후 ${newest}(으)로 전환됩니다.`,
              ` ${current} is in use but also gets deleted, so it will switch to ${newest} afterwards.`
            )
          : ''),
      confirm: { label: t('삭제', 'Delete'), action: () => void doCleanup() }
    })
  }

  const onPick = (v: EngineVersionEntry): void => {
    setOpen(false)
    if (v.version === current) return
    const installed = state?.installed.includes(v.version) ?? false
    // older than the version in use → ask before applying
    if (current && cmpVer(v.version, current) < 0) {
      // already installed → just switch, not reinstall
      const verb = installed ? t('사용', 'Use') : t('설치', 'Install')
      setDialog({
        title: t('과거 버전 선택', 'Older version'),
        message: t(
          `현재 사용 중인 ${current}보다 낮은 ${v.version} 버전입니다. 그래도 ${verb}할까요?`,
          `${v.version} is older than ${current}, the version in use. ${installed ? 'Use' : 'Install'} it anyway?`
        ),
        tone: 'warn',
        confirm: { label: verb, action: () => void apply(v.version, installed) }
      })
      return
    }
    void apply(v.version, installed)
  }

  // registry list + any installed versions not on it (newest first)
  const rows: EngineVersionEntry[] = (() => {
    const base = (available ?? []).slice(0, 30)
    const seen = new Set(base.map((e) => e.version))
    const extra = (state?.installed ?? [])
      .filter((v) => !seen.has(v))
      .map((v) => ({ version: v, date: null, latest: false }))
    return [...extra, ...base]
  })()

  // 카드 상단 배지 — 지금 도는 버전(고정본 > 번들/전역 폴백)이 레지스트리 최신과 같은가
  const latest = (available ?? []).find((v) => v.latest)?.version ?? null
  const shownVer = current ?? (state?.bundled && state.bundled !== 'unknown' ? state.bundled : null)
  const upToDate = latest != null && shownVer != null && cmpVer(shownVer, latest) >= 0
  return (
    <>
      <div className="sc2 row2 eng">
        <div className="set-tile">{tile}</div>
        <div>
          <div className="em">
            {name}
            {latest &&
              shownVer &&
              (upToDate ? (
                <span className="set-badge">{t('최신', 'Latest')}</span>
              ) : (
                <span className="set-badge warn">{t(`v${latest} 있음`, `v${latest} available`)}</span>
              ))}
          </div>
          <div className="meta">
            {busy
              ? t('설치 중…', 'Installing…')
              : shownVer
                ? `v${shownVer}${current ? '' : ` (${fallback})`} · CLI`
                : t('미설치 — 버전을 골라 설치하세요', 'Not installed — pick a version to install')}
          </div>
        </div>
        <span className="sp" />
        <div className="vpick" ref={pickRef}>
              <button
                className={'vpick-btn' + (open ? ' open' : '')}
                onClick={() => setOpen((o) => !o)}
                disabled={!!busy}
              >
                <span className="vpick-cur">
                  {busy ? t('설치 중…', 'Installing…') : current ?? t('버전 선택', 'Select version')}
                </span>
                <IconChevDown className="vpick-chev" size={15} />
              </button>

              {open && (
                <div className="vpick-menu">
                  <div className="vpick-head">
                    <span>{t('버전 선택', 'Select version')}</span>
                    <button
                      className="vpick-refresh"
                      onClick={refreshList}
                      disabled={loading}
                      aria-label={t('새로고침', 'Refresh')}
                    >
                      <IconRefresh size={13} />
                    </button>
                  </div>
                  <div className="vpick-list scroll">
                    {loading && rows.length === 0 ? (
                      <div className="vpick-msg">
                        <span className="set-spin" /> {t('불러오는 중…', 'Loading…')}
                      </div>
                    ) : listError && rows.length === 0 ? (
                      // ★CRIT R1 — 제목 아래 **사유 한 줄**. 「목록을 불러오지 못했습니다」만
                      // 있으면 npm이 없는 컴퓨터의 사용자는 무엇을 해야 할지 영영 모른다.
                      <div className="vpick-msg err">
                        <div>{t('목록을 불러오지 못했습니다', 'Could not load the list')}</div>
                        <div className="vpick-why">{listError}</div>
                      </div>
                    ) : (
                      rows.map((v) => {
                        const installed = state?.installed.includes(v.version) ?? false
                        const isCur = v.version === current
                        return (
                          <button
                            key={v.version}
                            className={'vpick-opt' + (isCur ? ' on' : '')}
                            onClick={() => onPick(v)}
                          >
                            <span className="vpo-v">{v.version}</span>
                            {v.latest && <span className="vtag latest">{t('최신', 'Latest')}</span>}
                            {/* 정식(latest)보다 높은 프리뷰(next 채널) — 자동 업데이트가 안 가는 게 정상임을 배지로 */}
                            {v.preview && <span className="vtag next">{t('프리뷰', 'Preview')}</span>}
                            {isCur && <span className="vtag cur">{t('현재', 'Current')}</span>}
                            {installed && !isCur && <span className="vtag inst">{t('설치됨', 'Installed')}</span>}
                            <span className="vpo-right">
                              <span className="vpo-act">
                                {isCur ? t('사용 중', 'In use') : installed ? t('사용', 'Use') : t('설치', 'Install')}
                              </span>
                              {installed && !isCur && (
                                <span
                                  className="vpo-del"
                                  role="button"
                                  tabIndex={-1}
                                  aria-label={t('삭제', 'Delete')}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    askDelete(v.version)
                                  }}
                                >
                                  <IconTrash size={13} />
                                </span>
                              )}
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
        </div>
      </div>

      {oldCount > 0 && (
        <div className="sc2 row2">
          <div>
            <div className="em">{t('이전 버전 정리', 'Clean up old versions')}</div>
            <div className="meta">
              {t(
                `최신 ${newest}만 남기고 이전 버전 ${oldCount}개를 삭제해요`,
                `Keeps the latest ${newest} and deletes ${oldCount} older version${oldCount === 1 ? '' : 's'}`
              )}
            </div>
          </div>
          <span className="sp" />
          <button className="set-chipbtn" disabled={cleaning || !!busy} onClick={askCleanup}>
            {cleaning ? t('정리 중…', 'Cleaning up…') : t('정리', 'Clean up')}
          </button>
        </div>
      )}

      {install && (
        <div
          className="set-dialog-overlay"
          onMouseDown={() => {
            if (install.status !== 'running') setInstall(null)
          }}
        >
          <div className="install-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ic-head">
              <span className={'ic-hic ' + install.status}>
                {install.status === 'running' ? (
                  <span className="set-spin" />
                ) : install.status === 'done' ? (
                  <IconCheck size={16} />
                ) : (
                  <IconAlert size={16} />
                )}
              </span>
              <span className="ic-title">
                {install.status === 'running'
                  ? t('버전 설치 중', 'Installing version')
                  : install.status === 'done'
                    ? t('설치 완료', 'Install complete')
                    : t('설치 실패', 'Install failed')}
              </span>
              <span className="ic-ver">{install.version}</span>
            </div>
            <div className="ic-log scroll" ref={logRef}>
              {install.log.map((l, i) => (
                <div className="ic-ln" key={i}>
                  {l}
                </div>
              ))}
              {install.status === 'error' && install.error && <div className="ic-ln err">{install.error}</div>}
            </div>
            <div className="ic-foot">
              <span className={'ic-status ' + install.status}>
                {install.status === 'running'
                  ? t('설치하는 중…', 'Installing…')
                  : install.status === 'done'
                    ? t('설치가 완료되었습니다', 'The install finished')
                    : t('설치에 실패했습니다', 'The install failed')}
              </span>
              {install.status === 'error' && (
                <button
                  className="sd-cancel"
                  onClick={() => {
                    const v = install.version
                    setInstall(null)
                    void apply(v, false)
                  }}
                >
                  {t('다시 시도', 'Retry')}
                </button>
              )}
              <button className="sd-go" onClick={() => setInstall(null)} disabled={install.status === 'running'}>
                {t('확인', 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog && (
        <div className="set-dialog-overlay" onMouseDown={() => setDialog(null)}>
          <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className={'sd-ic' + (dialog.tone === 'warn' ? ' warn' : dialog.tone === 'ok' ? ' ok' : '')}>
              {dialog.tone === 'ok' ? <IconCheck size={22} /> : <IconAlert size={22} />}
            </div>
            <div className="sd-title">{dialog.title}</div>
            <div className="sd-msg">{dialog.message}</div>
            <div className="sd-btns">
              <button className="sd-cancel" onClick={() => setDialog(null)}>
                {dialog.confirm ? t('취소', 'Cancel') : t('닫기', 'Close')}
              </button>
              {dialog.confirm && (
                <button
                  className={'sd-go' + (dialog.tone === 'warn' ? '' : ' danger')}
                  onClick={() => {
                    const a = dialog.confirm!.action
                    setDialog(null)
                    a()
                  }}
                >
                  {dialog.confirm.label}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// USD 표시 — 소액(토큰 과금)은 셋째 자리까지, 그 외 둘째 자리까지
function fmtUsd(v: number): string {
  return '$' + (v > 0 && v < 1 ? v.toFixed(3) : v.toFixed(2))
}
// 정리로 확보한 디스크 용량 — 엔진 폴더는 수십 MB~GB 단위라 KB 아래는 뭉갠다
function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}
function ApiView() {
  const [st, setSt] = useState<ApiConfigStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.apiConfig.get().then(setSt).catch(() => {})
  }, [])

  // 키·예산 조작 한 벌 — Anthropic·OpenAI 카드(ProviderApiCard)가 provider만 달리해 공유
  const saveKey = async (provider: 'anthropic' | 'openai', key: string): Promise<boolean> => {
    if (!key.trim()) return false
    setBusy(true)
    try {
      setSt(await window.api.apiConfig.setKey(key.trim(), provider))
      return true
    } catch {
      return false
    } finally {
      setBusy(false)
    }
  }
  const removeKey = async (provider: 'anthropic' | 'openai'): Promise<void> => {
    setBusy(true)
    try {
      setSt(await window.api.apiConfig.clearKey(provider))
    } catch {
      /* ignore */
    } finally {
      setBusy(false)
    }
  }
  // 예산은 Anthropic 전용 — Codex는 실행 비용을 보고하지 않아 차감이 불가능하다
  const saveBudget = async (usd: number | null): Promise<void> => {
    try {
      setSt(await window.api.apiConfig.setBudget(usd))
    } catch {
      /* ignore */
    }
  }
  // 초기화(0원) — 예산을 지우고 누적 사용액도 0으로 (재충전 후 새 기준)
  const doResetBudget = async (): Promise<void> => {
    try {
      setSt(await window.api.apiConfig.resetBudget())
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <div className="set-h1">API</div>
      <div className="set-h1-sub">
        {isEn() ? (
          <>
            Register an API key and the composer’s <strong>API toggle</strong> switches run billing between your
            subscription (OAuth) and API credits. In API mode, Anthropic runs bill to the Anthropic key and OpenAI
            (Codex) runs bill to the OpenAI key.
          </>
        ) : (
          <>
            API 키를 등록하면 채팅 컴포저의 <strong>API 토글</strong>로 실행 과금을 구독(OAuth) ↔ API 크레딧 사이에서
            전환할 수 있습니다. API 모드에선 Anthropic 실행은 Anthropic 키로, OpenAI(Codex) 실행은 OpenAI 키로 과금돼요.
          </>
        )}
      </div>

      <div className="set-sec">Anthropic</div>
      <ProviderApiCard
        provider="anthropic"
        st={st}
        busy={busy}
        onSaveKey={(k) => saveKey('anthropic', k)}
        onClearKey={() => void removeKey('anthropic')}
        onSaveBudget={saveBudget}
        onResetBudget={doResetBudget}
      />
      <div className="set-note2">
        {isEn() ? (
          <>
            In API mode, <strong>Claude Code engine</strong> runs bill to this key. Get one at platform.claude.com —
            it is encrypted (DPAPI), never leaves this computer, and is handed only to the engine process at run
            time. There is no balance API, so the cost reported per run (<code>total_cost_usd</code>) is added up and
            subtracted from your budget — after topping up, hit <strong>Reset</strong> (budget and spend back to
            zero) and enter a new budget.
          </>
        ) : (
          <>
            API 모드에서 <strong>Claude Code 엔진</strong> 실행이 이 키로 과금돼요. 키는 platform.claude.com에서 발급 —
            암호화(DPAPI)돼 이 컴퓨터에만 저장되고, 실행할 때 엔진 프로세스에만 전달돼요. 잔액 조회 API가 없어 실행마다
            보고되는 비용(<code>total_cost_usd</code>)을 누적해 예산에서 차감합니다 — 재충전했으면{' '}
            <strong>초기화</strong>(예산·누적 0원) 후 새 예산을 입력하세요.
          </>
        )}
      </div>

      <div className="set-sec">OpenAI</div>
      <ProviderApiCard
        provider="openai"
        st={st}
        busy={busy}
        onSaveKey={(k) => saveKey('openai', k)}
        onClearKey={() => void removeKey('openai')}
      />
      <div className="set-note2">
        {isEn() ? (
          <>
            In API mode, <strong>Codex engine</strong> runs bill to this key. Get one at platform.openai.com — stored
            encrypted the same way. Codex doesn’t report run costs, so the app can’t track spend — check
            platform.openai.com for that.
          </>
        ) : (
          <>
            API 모드에서 <strong>Codex 엔진</strong> 실행이 이 키로 과금돼요. 키는 platform.openai.com에서 발급 — 같은
            방식으로 암호화돼 저장돼요. Codex는 실행 비용을 보고하지 않아 앱에서 사용액을 추적할 수 없어요 —
            platform.openai.com에서 확인해 주세요.
          </>
        )}
      </div>
    </>
  )
}

// 엔진별 API 카드 한 장 — PoC 문법: 키 줄(배지·변경·삭제) + 마스킹 모노 필 + 예산 줄 +
// 얇은 잔여 게이지. 키는 등록 전/변경 중엔 입력으로, 예산은 연필을 눌러 인라인 편집.
// 예산 UI는 Anthropic 전용 — Codex는 비용을 보고하지 않아 예산 개념 자체를 두지 않는다.
function ProviderApiCard({
  provider,
  st,
  busy,
  onSaveKey,
  onClearKey,
  onSaveBudget,
  onResetBudget
}: {
  provider: 'anthropic' | 'openai'
  st: ApiConfigStatus | null
  busy: boolean
  onSaveKey: (key: string) => Promise<boolean>
  onClearKey: () => void
  onSaveBudget?: (usd: number | null) => Promise<void> // Anthropic 카드만 전달
  onResetBudget?: () => Promise<void>
}): React.ReactElement {
  const oa = provider === 'openai'
  const has = st == null ? null : oa ? st.hasOpenaiKey : st.hasKey
  const tail = (oa ? st?.openaiKeyTail : st?.keyTail) ?? '????'
  const budget = oa ? null : (st?.budgetUsd ?? null)
  const spent = st?.spentUsd ?? 0

  const [keyInput, setKeyInput] = useState('')
  const [editKey, setEditKey] = useState(false) // 등록된 키의 '변경' 모드
  const [budInput, setBudInput] = useState('')
  const [editBud, setEditBud] = useState(false)

  const saveKeyNow = async (): Promise<void> => {
    if (await onSaveKey(keyInput)) {
      setKeyInput('')
      setEditKey(false)
    }
  }
  const startBud = (): void => {
    setBudInput(budget != null ? String(budget) : '')
    setEditBud(true)
  }
  const saveBudNow = async (): Promise<void> => {
    const n = parseFloat(budInput)
    await onSaveBudget?.(isFinite(n) && n > 0 ? n : null)
    setEditBud(false)
  }
  const resetBudNow = async (): Promise<void> => {
    await onResetBudget?.()
    setBudInput('')
    setEditBud(false)
  }

  const remain = budget != null ? budget - spent : null
  const remainPct = remain != null && budget ? Math.max(0, Math.min(100, (remain / budget) * 100)) : null
  const canReset = budget != null || spent > 0

  return (
    <div className="sc2 api">
      <div className="aphead">
        <span className="apn">{t('API 키', 'API key')}</span>
        {has != null &&
          (has ? (
            <span className="set-badge">{t('등록됨', 'Registered')}</span>
          ) : (
            <span className="set-badge off">{t('미등록', 'Not set')}</span>
          ))}
        <span className="sp" />
        {has && !editKey && (
          <>
            <button
              className="set-chipbtn"
              disabled={busy}
              onClick={() => {
                setKeyInput('')
                setEditKey(true)
              }}
            >
              {t('변경', 'Change')}
            </button>
            <button className="set-chipbtn danger" disabled={busy} onClick={onClearKey}>
              {t('삭제', 'Delete')}
            </button>
          </>
        )}
      </div>

      {has && !editKey ? (
        <div className="apkey">{(oa ? 'sk-' : 'sk-ant-') + '••••••••' + tail}</div>
      ) : (
        <div className="apform">
          <input
            className="set-input"
            type="password"
            placeholder={oa ? 'sk-proj-…' : 'sk-ant-api03-…'}
            value={keyInput}
            spellCheck={false}
            autoFocus={editKey}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKeyNow()
              if (e.key === 'Escape' && editKey) {
                setEditKey(false)
                setKeyInput('')
              }
            }}
          />
          <button className="set-chipbtn" disabled={busy || !keyInput.trim()} onClick={() => void saveKeyNow()}>
            {t('저장', 'Save')}
          </button>
          {editKey && (
            <button
              className="set-chipbtn"
              onClick={() => {
                setEditKey(false)
                setKeyInput('')
              }}
            >
              {t('취소', 'Cancel')}
            </button>
          )}
        </div>
      )}

      {!oa && (
        <div className="apbud">
          {editBud ? (
            <>
              <input
                className="set-input num"
                type="number"
                min={0}
                step={1}
                placeholder={t('예: 20', 'e.g. 20')}
                value={budInput}
                autoFocus
                onChange={(e) => setBudInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveBudNow()
                  if (e.key === 'Escape') setEditBud(false)
                }}
              />
              <button className="set-chipbtn" onClick={() => void saveBudNow()}>
                {t('저장', 'Save')}
              </button>
              <button className="set-chipbtn" disabled={!canReset} onClick={() => void resetBudNow()}>
                {t('초기화', 'Reset')}
              </button>
              <span className="sp" />
              <button className="set-chipbtn" onClick={() => setEditBud(false)}>
                {t('취소', 'Cancel')}
              </button>
            </>
          ) : budget != null ? (
            <>
              <span>
                {t('누적 ', 'Spent ')}
                <b>{fmtUsd(spent)}</b>
                {t(' / 예산 ', ' / budget ')}
                {fmtUsd(budget)}
              </span>
              <button className="apedit" aria-label={t('예산 수정', 'Edit budget')} onClick={startBud}>
                <IconPencil size={11} />
              </button>
              <span className="sp" />
              {remain != null &&
                (remain <= 0 ? (
                  <span className="over">{t('예산 초과', 'Over budget')}</span>
                ) : (
                  <span>{t(`남음 ${Math.round(remainPct ?? 0)}%`, `${Math.round(remainPct ?? 0)}% left`)}</span>
                ))}
            </>
          ) : (
            <>
              <span>{t('예산 없음 — 정해두면 남은 예산이 표시돼요', 'No budget — set one to track what’s left')}</span>
              <span className="sp" />
              <button className="set-chipbtn" onClick={startBud}>
                {t('예산 설정', 'Set budget')}
              </button>
            </>
          )}
        </div>
      )}
      {!oa && budget != null && <div className="g2 big">{<i style={{ width: (remainPct ?? 0) + '%' }} />}</div>}
    </div>
  )
}

// 라벨이 언어를 따라가야 해서 상수가 아닌 함수 — 렌더 때 t()가 평가된다
function scopeTabs(): { id: 'all' | SkillScope; label: string }[] {
  return [
    { id: 'all', label: t('전체', 'All') },
    { id: 'global', label: t('전역', 'Global') },
    { id: 'local', label: t('로컬', 'Local') }
  ]
}

function SkillView({ cwd }: { cwd: string }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [scope, setScope] = useState<'all' | SkillScope>('all')
  const [busy, setBusy] = useState<string | null>(null) // skill name currently toggling

  const refresh = (): void => {
    window.api.skill
      .list(cwd)
      .then(setSkills)
      .catch(() => setSkills([]))
  }
  useEffect(refresh, [cwd])

  const toggle = async (s: SkillInfo): Promise<void> => {
    const next = !s.enabled
    setBusy(s.name)
    // optimistic — a name can appear in both scopes, so flip every matching row
    setSkills((cur) => cur?.map((x) => (x.name === s.name ? { ...x, enabled: next } : x)) ?? cur)
    try {
      await window.api.skill.setEnabled(s.name, next)
    } catch {
      refresh() // revert to the persisted truth on failure
    } finally {
      setBusy(null)
    }
  }

  const counts = {
    all: skills?.length ?? 0,
    global: skills?.filter((s) => s.scope === 'global').length ?? 0,
    local: skills?.filter((s) => s.scope === 'local').length ?? 0
  }
  const rows = (skills ?? []).filter((s) => scope === 'all' || s.scope === scope)

  return (
    <>
      <div className="set-h1">Skill</div>
      <div className="set-h1-sub">
        {t(
          '에이전트가 쓸 수 있는 Skill을 범위별로 보고, 여기서 바로 켜고 끌 수 있습니다.',
          'See the Skills the agent can use by scope, and turn them on or off right here.'
        )}
      </div>

      <div className="set-sec">{t('스킬', 'Skills')}</div>
      <div className="set-tabs">
        {/* tab — 지역변수 t는 i18n t()를 가리므로 이름을 피한다 */}
        {scopeTabs().map((tab) => (
          <button
            key={tab.id}
            className={'set-tab' + (scope === tab.id ? ' on' : '')}
            onClick={() => setScope(tab.id)}
          >
            {tab.label}
            <span className="n">{counts[tab.id]}</span>
          </button>
        ))}
        <button className="set-iconbtn" onClick={refresh} aria-label={t('새로고침', 'Refresh')}>
          <IconRefresh size={13} />
        </button>
      </div>

      {skills == null ? (
        <div className="sc2 hint">
          <span className="set-spin" /> {t('불러오는 중…', 'Loading…')}
        </div>
      ) : rows.length === 0 ? (
        <div className="sc2 hint">
          {scope === 'local'
            ? cwd
              ? t('이 프로젝트의 .claude/skills 에 Skill이 없습니다.', 'No Skills in this project’s .claude/skills.')
              : t(
                  '연결된 프로젝트가 없어 로컬 Skill을 찾을 수 없습니다.',
                  'No project is open, so local Skills can’t be found.'
                )
            : scope === 'global'
              ? t('~/.claude/skills 에 Skill이 없습니다.', 'No Skills in ~/.claude/skills.')
              : t('설치된 Skill이 없습니다.', 'No Skills installed.')}
        </div>
      ) : (
        rows.map((s) => (
          <div className={'sc2 row2' + (s.enabled ? '' : ' off')} key={s.scope + ':' + s.name}>
            <div className="set-tile">/</div>
            <div className="rmain has-tip tip-wrap" data-tip={s.description || t('설명이 없습니다.', 'No description.')}>
              <div className="em">
                {s.name}
                <span className="set-badge off">
                  {s.scope === 'global' ? t('전역', 'Global') : t('로컬', 'Local')}
                </span>
              </div>
              <div className="meta">{s.description || t('설명이 없습니다.', 'No description.')}</div>
            </div>
            <button
              className={'sw2' + (s.enabled ? ' on' : '')}
              role="switch"
              aria-checked={s.enabled}
              aria-label={t(
                s.name + (s.enabled ? ' 끄기' : ' 켜기'),
                (s.enabled ? 'Turn off ' : 'Turn on ') + s.name
              )}
              disabled={busy === s.name}
              onClick={() => void toggle(s)}
            />
          </div>
        ))
      )}

      <div className="set-note2">
        {isEn() ? (
          <>
            Global: <code>~/.claude/skills</code> · Local: <code>&lt;project&gt;/.claude/skills</code> · Turning one
            off keeps the agent from using that Skill on later runs.
          </>
        ) : (
          <>
            전역: <code>~/.claude/skills</code> · 로컬: <code>&lt;프로젝트&gt;/.claude/skills</code> · 끄면 이후 실행부터
            에이전트가 그 Skill을 사용하지 않습니다.
          </>
        )}
      </div>
    </>
  )
}

function McpView({ cwd }: { cwd: string }) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)
  const [scope, setScope] = useState<'all' | 'global' | 'local'>('all')
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = (): void => {
    window.api.mcp
      .list(cwd)
      .then(setServers)
      .catch(() => setServers([]))
  }
  useEffect(refresh, [cwd])

  const toggle = async (s: McpServerInfo): Promise<void> => {
    const next = !s.enabled
    setBusy(s.name)
    setServers((cur) => cur?.map((x) => (x.name === s.name ? { ...x, enabled: next } : x)) ?? cur)
    try {
      await window.api.mcp.setEnabled(s.name, next)
    } catch {
      refresh()
    } finally {
      setBusy(null)
    }
  }

  const counts = {
    all: servers?.length ?? 0,
    global: servers?.filter((s) => s.scope === 'global').length ?? 0,
    local: servers?.filter((s) => s.scope === 'local').length ?? 0
  }
  const rows = (servers ?? []).filter((s) => scope === 'all' || s.scope === scope)
  // 카드 타일 이니셜 — PoC 문법(context7 → C7): 영숫자만 남겨 앞 두 글자
  const tileTxt = (name: string): string => name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?'

  return (
    <>
      <div className="set-h1">MCP</div>
      <div className="set-h1-sub">
        {t(
          '에이전트가 쓸 수 있는 MCP 서버를 범위별로 보고, 여기서 바로 켜고 끌 수 있습니다.',
          'See the MCP servers the agent can use by scope, and turn them on or off right here.'
        )}
      </div>

      <div className="set-sec">{t('서버', 'Servers')}</div>
      <div className="set-tabs">
        {/* tab — 지역변수 t는 i18n t()를 가리므로 이름을 피한다 */}
        {scopeTabs().map((tab) => (
          <button
            key={tab.id}
            className={'set-tab' + (scope === tab.id ? ' on' : '')}
            onClick={() => setScope(tab.id)}
          >
            {tab.label}
            <span className="n">{counts[tab.id]}</span>
          </button>
        ))}
        <button className="set-iconbtn" onClick={refresh} aria-label={t('새로고침', 'Refresh')}>
          <IconRefresh size={13} />
        </button>
      </div>

      {servers == null ? (
        <div className="sc2 hint">
          <span className="set-spin" /> {t('불러오는 중…', 'Loading…')}
        </div>
      ) : rows.length === 0 ? (
        <div className="sc2 hint">
          {scope === 'local'
            ? cwd
              ? t(
                  '이 프로젝트(.mcp.json·로컬)에 등록된 MCP 서버가 없습니다.',
                  'No MCP servers registered in this project (.mcp.json or local).'
                )
              : t(
                  '연결된 프로젝트가 없어 로컬 MCP 서버를 찾을 수 없습니다.',
                  'No project is open, so local MCP servers can’t be found.'
                )
            : scope === 'global'
              ? t('~/.claude.json 에 등록된 전역 MCP 서버가 없습니다.', 'No global MCP servers in ~/.claude.json.')
              : t('등록된 MCP 서버가 없습니다.', 'No MCP servers registered.')}
        </div>
      ) : (
        rows.map((s) => (
          <div className={'sc2 row2' + (s.enabled ? '' : ' off')} key={s.origin + ':' + s.name}>
            <div className="set-tile">{tileTxt(s.name)}</div>
            <div className="rmain has-tip tip-wrap" data-tip={s.detail || t('연결 정보가 없습니다.', 'No connection details.')}>
              <div className="em">
                {s.name}
                <span className="set-badge off">
                  {s.scope === 'global' ? t('전역', 'Global') : t('로컬', 'Local')}
                </span>
              </div>
              <div className="meta mono">
                {(s.transport !== 'unknown' ? s.transport + ' · ' : '') +
                  (s.detail || t('연결 정보가 없습니다.', 'No connection details.'))}
              </div>
            </div>
            <button
              className={'sw2' + (s.enabled ? ' on' : '')}
              role="switch"
              aria-checked={s.enabled}
              aria-label={t(
                s.name + (s.enabled ? ' 끄기' : ' 켜기'),
                (s.enabled ? 'Turn off ' : 'Turn on ') + s.name
              )}
              disabled={busy === s.name}
              onClick={() => void toggle(s)}
            />
          </div>
        ))
      )}

      <div className="set-note2">
        {isEn() ? (
          <>
            Global: <code>~/.claude.json</code> · Project: <code>&lt;project&gt;/.mcp.json</code> · Turning one off
            keeps the agent from using that server on later runs.
          </>
        ) : (
          <>
            전역: <code>~/.claude.json</code> · 프로젝트: <code>&lt;프로젝트&gt;/.mcp.json</code> · 끄면 이후 실행부터
            에이전트가 그 서버를 사용하지 않습니다.
          </>
        )}
      </div>
    </>
  )
}

// a representative filename per server id → the same FileBadge the rest of the app
// uses, so the languages are recognizable at a glance
const LSP_BADGE: Record<string, string> = { ts: 'a.ts', py: 'a.py', cs: 'a.cs', cpp: 'a.cpp', verse: 'a.verse' }

// the install/remove progress card (엔진 설치와 같은 카드 모달) — one op at a time
interface LspCard {
  id: string // server id the op belongs to (routes progress events)
  op: '설치' | '삭제' | '준비'
  label: string
  log: string[]
  status: 'running' | 'done' | 'error'
  error?: string
  percent: number | null
}
// op은 로직 값이라 한국어 그대로 두고(카드 분기가 이 값을 쓴다) 표기만 언어를 탄다
function opNoun(op: LspCard['op']): string {
  return t(op, op === '설치' ? 'Install' : op === '삭제' ? 'Removal' : 'Setup')
}
function opVerbing(op: LspCard['op']): string {
  return t(op, op === '설치' ? 'Installing' : op === '삭제' ? 'Removing' : 'Preparing')
}

function LspView() {
  const [servers, setServers] = useState<LspServerInfo[] | null>(null)
  const [pct, setPct] = useState<Record<string, number | null>>({})
  const [confirm, setConfirm] = useState<LspServerInfo | null>(null)
  const [card, setCard] = useState<LspCard | null>(null)
  // Verse 공식 문서 호버 언어 — 'ko'(기본, 한국어 번역) / 'en'(원문). 메인은 ui-prefs 저장 IPC에서 이 값을 읽어 호버 번역을 켜고 끈다.
  const [verseKo, setVerseKo] = useState<boolean>(() => getPref<string>('verseDocLang', 'ko') !== 'en')
  // Verse 행 펼침 — 클릭하면 '공식 문서 한국어' 등 Verse 전용 옵션이 행 아래로 펼쳐진다.
  const [verseOpen, setVerseOpen] = useState(false)
  // UE C++ 공식 주석 호버 언어 — 'ko'(기본) / 'en'. C/C++ 행을 펼치면 토글이 보인다.
  const [ueKo, setUeKo] = useState<boolean>(() => getPref<string>('ueDocLang', 'ko') !== 'en')
  const [cppOpen, setCppOpen] = useState(false)

  const refresh = (): void => {
    window.api.lsp
      .servers()
      .then(setServers)
      .catch(() => setServers([]))
  }
  useEffect(() => {
    refresh()
    return window.api.lsp.onInstallProgress((p) => {
      setPct((c) => ({ ...c, [p.server]: p.done ? null : p.percent }))
      // stream download lines + percent into the open card (only the matching op's)
      setCard((c) =>
        c && c.id === p.server && c.status === 'running'
          ? { ...c, log: p.line ? [...c.log, p.line] : c.log, percent: p.percent ?? c.percent }
          : c
      )
      if (p.done) refresh()
    })
  }, [])

  const doInstall = (s: LspServerInfo): void => {
    setCard({
      id: s.id,
      op: '설치',
      label: s.langs,
      log: [t('설치를 준비하는 중…', 'Preparing the install…')],
      status: 'running',
      percent: null
    })
    // optimistic: the row flips to 설치 중 right away; progress events drive the %
    setServers((cur) => cur?.map((x) => (x.id === s.id ? { ...x, state: 'installing' } : x)) ?? cur)
    window.api.lsp
      .installServer(s.id)
      .then((r) =>
        setCard((c) =>
          c && c.id === s.id
            ? r.ok
              ? {
                  ...c,
                  status: 'done',
                  percent: 100,
                  log: [
                    ...c.log,
                    t(
                      '설치가 끝났어요. 파일을 열면 바로 심볼 탐색이 켜집니다.',
                      'Install finished. Open a file and symbol navigation turns on right away.'
                    )
                  ]
                }
              : { ...c, status: 'error', error: r.error || t('설치에 실패했습니다.', 'The install failed.') }
            : c
        )
      )
      .catch(() =>
        setCard((c) =>
          c && c.id === s.id ? { ...c, status: 'error', error: t('설치에 실패했습니다.', 'The install failed.') } : c
        )
      )
      .finally(refresh)
  }
  const doRemove = (s: LspServerInfo): void => {
    setCard({
      id: s.id,
      op: '삭제',
      label: s.langs,
      log: [
        t('실행 중인 분석 서버를 중지하는 중…', 'Stopping the running language server…'),
        t('설치된 파일을 삭제하는 중…', 'Deleting the installed files…')
      ],
      status: 'running',
      percent: null
    })
    window.api.lsp
      .uninstallServer(s.id)
      .then((r) =>
        setCard((c) =>
          c && c.id === s.id
            ? r.ok
              ? {
                  ...c,
                  status: 'done',
                  log: [
                    ...c.log,
                    t(
                      '삭제가 끝났어요. 필요하면 언제든 다시 설치할 수 있어요.',
                      'Removed. You can install it again whenever you need it.'
                    )
                  ]
                }
              : { ...c, status: 'error', error: r.error || t('삭제하지 못했어요.', 'Could not remove it.') }
            : c
        )
      )
      .catch(() =>
        setCard((c) =>
          c && c.id === s.id ? { ...c, status: 'error', error: t('삭제하지 못했어요.', 'Could not remove it.') } : c
        )
      )
      .finally(refresh)
  }
  // Verse(external): the user picks their Verse.vsix / verse-lsp.exe; we extract+prepare it.
  //
  // ★R28f SHIPBLOCK R2 — 이 버튼이 **말없이 끝나던** 자리다(확인 크리틱 「요구 3의 뒷절반」).
  // `pickVerseServer()`의 `null`에는 뜻이 둘 있었다: 「사용자가 대화상자를 취소했다」(조용한
  // 게 맞다)와 「셸에 그 채널이 없다」(말해야 한다). 심의 안전값이 후자를 전자로 번역했고,
  // 그래서 `if (!p) return`이 아무 흔적 없이 삼켰다 — 이 라운드가 닫은 N1과 같은 모양이다.
  // 이제 심이 「없다」를 reject로 올리고(`callPathOrNull`), 그 사유가 카드로 선다.
  const doVersePick = async (): Promise<void> => {
    let p: string | null
    try {
      p = await window.api.lsp.pickVerseServer()
    } catch (e) {
      setCard({
        id: 'verse',
        op: '준비',
        label: 'Verse',
        log: [],
        status: 'error',
        percent: null,
        error:
          (e as { detail?: string } | null)?.detail ??
          t('요청이 실패했어요 — 잠시 뒤 다시 시도해 주세요.', 'The request failed — please try again shortly.')
      })
      return
    }
    if (!p) return // 사용자가 대화상자를 취소했다 — 이건 정상이고, 조용한 게 맞다
    setCard({
      id: 'verse',
      op: '준비',
      label: 'Verse',
      log: [t(`선택: ${p}`, `Selected: ${p}`), t('verse-lsp.exe 준비 중…', 'Preparing verse-lsp.exe…')],
      status: 'running',
      percent: null
    })
    const r = await window.api.lsp
      .setVersePath(p)
      .catch(() => ({ ok: false as const, error: t('설정에 실패했습니다.', 'Setup failed.') }))
    setCard((c) =>
      c && c.id === 'verse'
        ? r.ok
          ? {
              ...c,
              status: 'done',
              log: [
                ...c.log,
                t(
                  '준비 완료. .verse 파일을 열면 정의 이동·호버·심볼이 켜집니다.',
                  'Ready. Open a .verse file for go-to-definition, hover, and symbols.'
                )
              ]
            }
          : { ...c, status: 'error', error: r.error || t('설정에 실패했습니다.', 'Setup failed.') }
        : c
    )
    refresh()
  }
  const doVerseClear = async (): Promise<void> => {
    await window.api.lsp.clearVersePath().catch(() => {})
    refresh()
  }
  const toggleVerseKo = (): void => {
    setVerseKo((on) => {
      const next = !on
      setPref('verseDocLang', next ? 'ko' : 'en') // 메인이 다음 호버부터 적용
      return next
    })
  }
  const toggleUeKo = (): void => {
    setUeKo((on) => {
      const next = !on
      setPref('ueDocLang', next ? 'ko' : 'en') // 메인이 다음 호버부터 적용
      return next
    })
  }

  return (
    <>
      <div className="set-h1">Code</div>
      <div className="set-h1-sub">
        {t(
          '파일 뷰어의 심볼 탐색(호버 타입 정보 · Ctrl+클릭 정의 이동)을 언어별 분석 서버가 제공합니다.',
          'Symbol navigation in the file viewer (hover types, Ctrl+click go-to-definition) comes from a language server per language.'
        )}
      </div>

      <div className="set-sec">{t('언어 서버', 'Language servers')}</div>
      {servers == null ? (
        <div className="sc2 hint">
          <span className="set-spin" /> {t('불러오는 중…', 'Loading…')}
        </div>
      ) : (
        servers.map((s) => {
          const installing = s.state === 'installing'
          const p = pct[s.id]
          // 펼치는 디스클로저 행: Verse(external)는 '공식 문서 한국어' 등 Verse 옵션을,
          // C/C++는 'Unreal Engine 공식 문서 한국어' 옵션을 행 아래에 담는다.
          const isVerse = s.kind === 'external'
          const isCpp = s.id === 'cpp'
          const disc = isVerse || isCpp
          const open = isVerse ? verseOpen : cppOpen
          const toggleOpen = isVerse ? () => setVerseOpen((o) => !o) : () => setCppOpen((o) => !o)
          return (
            <Fragment key={s.id}>
              <div
                className={'sc2 row2' + (disc ? ' disc' + (open ? ' open' : '') : '')}
                role={disc ? 'button' : undefined}
                aria-expanded={disc ? open : undefined}
                onClick={disc ? toggleOpen : undefined}
              >
                {disc && (
                  <span className="chev" aria-hidden>
                    <IconChevRight size={15} />
                  </span>
                )}
                <div className="set-tile">
                  <FileBadge path={LSP_BADGE[s.id] ?? 'a.txt'} size={24} />
                </div>
                <div className="rmain">
                  <div className="em">
                    {s.langs}
                    {s.state === 'bundled' && <span className="set-badge">{t('앱 내장', 'Bundled')}</span>}
                    {s.kind !== 'external' && s.state === 'installed' && (
                      <span className="set-badge">{t('설치됨', 'Installed')}</span>
                    )}
                    {s.kind === 'external' &&
                      (s.state === 'installed' ? (
                        <span className="set-badge">{t('지정됨', 'Set')}</span>
                      ) : (
                        <span className="set-badge off">{t('미지정', 'Not set')}</span>
                      ))}
                    {/* Verse의 요구사항·경로·문서 언어는 행을 펼치면 보인다 — 접힌 행은
                        다른 서버들과 같은 2줄 높이를 유지한다 */}
                    {!isVerse && s.requires && <span className="set-badge off">{s.requires}</span>}
                  </div>
                  <div className="meta mono">{s.exts}</div>
                </div>
                {s.kind === 'download' &&
                  (s.state === 'installed' ? (
                    <button
                      className="set-chipbtn danger"
                      onClick={(e) => {
                        e.stopPropagation() // C/C++ 디스클로저 행 토글에 안 걸리게
                        setConfirm(s)
                      }}
                    >
                      {t('삭제', 'Delete')}
                    </button>
                  ) : (
                    <button
                      className="set-chipbtn"
                      disabled={installing}
                      onClick={(e) => {
                        e.stopPropagation()
                        doInstall(s)
                      }}
                    >
                      {installing
                        ? t(`설치 중…${p != null ? ` ${p}%` : ''}`, `Installing…${p != null ? ` ${p}%` : ''}`)
                        : t('설치', 'Install')}
                    </button>
                  ))}
                {s.kind === 'external' &&
                  (s.state === 'installed' ? (
                    <button
                      className="set-chipbtn danger"
                      onClick={(e) => {
                        e.stopPropagation()
                        doVerseClear()
                      }}
                    >
                      {t('삭제', 'Delete')}
                    </button>
                  ) : (
                    <button
                      className="set-chipbtn"
                      onClick={(e) => {
                        e.stopPropagation()
                        doVersePick()
                      }}
                    >
                      {t('설정', 'Set up')}
                    </button>
                  ))}
              </div>
              {/* Verse 펼침 — 연결 안내·지정 경로·문서 언어가 행 아래 들여쓴 카드로 이어진다 */}
              {isVerse && verseOpen && (
                <>
                  <div className="sc2 sub">
                    <div className="sn">{t('Epic verse-lsp 연결', 'Connect Epic verse-lsp')}</div>
                    <div className="sd">
                      {isEn() ? (
                        <>
                          Point this at the <code>Verse.vsix</code> (or <code>verse-lsp.exe</code>) from
                          UEFN/Fortnite and go-to-definition, hover, and symbols turn on. Source and digest folders
                          are found automatically from the project’s <code>.vproject</code>; until a path is set,
                          only syntax highlighting works.
                        </>
                      ) : (
                        <>
                          UEFN/포트나이트의 <code>Verse.vsix</code>(또는 <code>verse-lsp.exe</code>) 경로를 지정하면 정의
                          이동·호버·심볼이 켜집니다. 소스·디제스트 폴더는 프로젝트의 <code>.vproject</code>에서 자동으로
                          찾고, 지정 전에는 구문 강조만 동작해요.
                        </>
                      )}
                    </div>
                    {s.path && (
                      <div className="spath">
                        <IconCheck size={12} />
                        <code>{s.path}</code>
                      </div>
                    )}
                  </div>
                  <div className="sc2 sub row2">
                    <div className="rmain">
                      <div className="sn">{t('공식 문서를 한국어로 보기', 'Show official docs in Korean')}</div>
                      <div className="sd">
                        {isEn() ? (
                          <>
                            Shows <code>/Verse.org</code> · <code>/UnrealEngine.com</code> ·{' '}
                            <code>/Fortnite.com</code> API doc comments in Korean on hover. Turn it off for the
                            English originals. (Untranslated entries and your own comments stay as written.)
                          </>
                        ) : (
                          <>
                            <code>/Verse.org</code> · <code>/UnrealEngine.com</code> · <code>/Fortnite.com</code> API 주석
                            설명을 호버에서 한국어로 보여줍니다. 끄면 영어 원문으로 표시합니다. (번역에 없는 항목이나 내 코드
                            주석은 원문 그대로)
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      className={'sw2' + (verseKo ? ' on' : '')}
                      role="switch"
                      aria-checked={verseKo}
                      aria-label={
                        verseKo
                          ? t('Verse 한국어 문서 끄기', 'Turn off Korean Verse docs')
                          : t('Verse 한국어 문서 켜기', 'Turn on Korean Verse docs')
                      }
                      onClick={toggleVerseKo}
                    />
                  </div>
                </>
              )}
              {/* C/C++ 펼침 — 언리얼 프로젝트의 엔진 공식 주석(clangd 호버) 한국어 번역 토글 */}
              {isCpp && cppOpen && (
                <div className="sc2 sub row2">
                  <div className="rmain">
                    <div className="sn">
                      {t('Unreal Engine 공식 문서를 한국어로 보기', 'Show Unreal Engine official docs in Korean')}
                    </div>
                    <div className="sd">
                      {isEn() ? (
                        <>
                          Shows the engine’s official comments that ride along with C++ hovers in an Unreal project
                          (<code>.uproject</code>) — descriptions of core types like <code>AActor</code> and{' '}
                          <code>TObjectPtr</code> — in Korean. Turn it off for the English originals. (Untranslated
                          entries and your own comments stay as written.)
                        </>
                      ) : (
                        <>
                          언리얼 프로젝트(<code>.uproject</code>)의 C++ 호버에 실리는 엔진 공식 주석(<code>AActor</code>·
                          <code>TObjectPtr</code> 같은 핵심 타입 설명)을 한국어로 보여줍니다. 끄면 영어 원문으로
                          표시합니다. (번역에 없는 항목이나 내 코드 주석은 원문 그대로)
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    className={'sw2' + (ueKo ? ' on' : '')}
                    role="switch"
                    aria-checked={ueKo}
                    aria-label={
                      ueKo
                        ? t('Unreal Engine 한국어 문서 끄기', 'Turn off Korean Unreal Engine docs')
                        : t('Unreal Engine 한국어 문서 켜기', 'Turn on Korean Unreal Engine docs')
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleUeKo()
                    }}
                  />
                </div>
              )}
            </Fragment>
          )
        })
      )}

      <div className="set-note2">
        {isEn() ? (
          <>
            Bundled servers work right away; the C# and C++ servers download once into{' '}
            <code>~/.agentcodegui/lsp</code>. Click the Verse row for its connection and doc-language options, or the
            C · C++ row for the Unreal Engine doc-language option.
          </>
        ) : (
          <>
            내장 서버는 바로 사용할 수 있고, C#·C++ 서버는 최초 1회 내려받아 <code>~/.agentcodegui/lsp</code> 에
            설치됩니다. Verse 연결·문서 언어 옵션은 Verse 행을, Unreal Engine 문서 언어 옵션은 C·C++ 행을 클릭하면
            펼쳐집니다.
          </>
        )}
      </div>

      {confirm && (
        <div className="set-dialog-overlay" onMouseDown={() => setConfirm(null)}>
          <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="sd-ic">
              <IconAlert size={22} />
            </div>
            <div className="sd-title">{t('분석 서버 삭제', 'Delete language server')}</div>
            <div className="sd-msg">
              {t(
                `${confirm.langs} 분석 서버를 삭제할까요? 필요하면 언제든 다시 설치할 수 있어요.`,
                `Delete the ${confirm.langs} language server? You can install it again whenever you need it.`
              )}
            </div>
            <div className="sd-btns">
              <button className="sd-cancel" onClick={() => setConfirm(null)}>
                {t('취소', 'Cancel')}
              </button>
              <button
                className="sd-go danger"
                onClick={() => {
                  const s = confirm
                  setConfirm(null)
                  doRemove(s)
                }}
              >
                {t('삭제', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {card && (
        <div
          className="set-dialog-overlay"
          onMouseDown={() => {
            if (card.status !== 'running') setCard(null)
          }}
        >
          <div className="install-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ic-head">
              <span className={'ic-hic ' + card.status}>
                {card.status === 'running' ? (
                  <span className="set-spin" />
                ) : card.status === 'done' ? (
                  <IconCheck size={16} />
                ) : (
                  <IconAlert size={16} />
                )}
              </span>
              <span className="ic-title">
                {card.status === 'running'
                  ? t(`분석 서버 ${card.op} 중`, `${opVerbing(card.op)} language server`)
                  : card.status === 'done'
                    ? t(`${card.op} 완료`, `${opNoun(card.op)} complete`)
                    : t(`${card.op} 실패`, `${opNoun(card.op)} failed`)}
              </span>
              <span className="ic-ver">{card.label}</span>
            </div>
            <div className="ic-log scroll">
              {card.log.map((l, i) => (
                <div className="ic-ln" key={i}>
                  {l}
                </div>
              ))}
              {card.status === 'error' && card.error && <div className="ic-ln err">{card.error}</div>}
            </div>
            <div className="ic-foot">
              <span className={'ic-status ' + card.status}>
                {card.status === 'running'
                  ? card.op === '설치'
                    ? t(
                        `내려받는 중…${card.percent != null ? ` ${card.percent}%` : ''}`,
                        `Downloading…${card.percent != null ? ` ${card.percent}%` : ''}`
                      )
                    : card.op === '준비'
                      ? t('준비하는 중…', 'Preparing…')
                      : t('삭제하는 중…', 'Deleting…')
                  : card.status === 'done'
                    ? t(`${card.op}가 완료되었습니다`, `${opNoun(card.op)} finished`)
                    : t(`${card.op}에 실패했습니다`, `${opNoun(card.op)} failed`)}
              </span>
              <button className="sd-go" onClick={() => setCard(null)} disabled={card.status === 'running'}>
                {t('확인', 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── 탐색기 (숨길 폴더·파일 관리) ───────────────────────────────────
// 파일 탐색기 트리에서 감출 이름을 전역으로 관리한다. 저장은 두 벌(폴더 목록·파일 목록)이지만
// 화면은 세 섹션이다: Folders(폴더만) / Files(파일 이름) / Extensions(*.확장자 패턴) — 파일
// 목록 안의 항목을 '모양'으로 갈라 보여줄 뿐, 매칭·저장은 그대로 파일 목록 하나를 쓴다.
// 대소문자 무시·어느 깊이든 매칭되고, 저장 즉시 lib/hideDirs가 이벤트를 쏴 열려 있는 탐색기가
// 트리를 다시 읽는다. 탐색기 트리 우클릭 '숨김 목록에 추가'도 같은 목록으로 들어온다.

// '*.확장자' 꼴인가 — Extensions 섹션으로 분류하는 기준 (다른 글롭·일반 이름은 Files에 남는다)
function isExtPattern(s: string): boolean {
  return /^\*\.[^\\/*?]+$/.test(s)
}

// 우클릭 드래그 제스처 — 켜고 끄기 + 동작 목록 + 감도(시작 거리·획 길이).
// 값은 prefs에 저장되고 MouseGestureLayer가 제스처 시작 시점마다 읽으므로 즉시 반영된다.
// 동작 매핑은 각 화면에 고정(FileModal 5종 · Bash 로그 3종 · Git 카드 닫기 · 설정창 ↑/↓/↓→ ·
// 대화 스레드 ↑/↓/↑←/↑↓ · 추가 채팅 창은 →↑ 최대화·↓→ 닫기 · 멀티 패널은 →↑ 크게 보기,
// 크게 보기 카드는 ↓→ 닫기) — 여기 목록과 함께 바꿔야 한다.
// 이름·설명이 언어를 따라가야 해서 상수가 아닌 함수 — 렌더 때 t()가 평가된다
function gestureList(): { pattern: string; name: string; desc: string }[] {
  return [
    {
      pattern: 'L',
      name: t('이전 파일', 'Previous file'),
      desc: t('정의 점프로 떠나온 파일로 돌아가요 — 파일 뷰어', 'Back to the file you jumped from — file viewer')
    },
    {
      pattern: 'R',
      name: t('다음 파일', 'Next file'),
      desc: t('뒤로 갔던 길을 다시 앞으로 — 파일 뷰어', 'Forward again after going back — file viewer')
    },
    { pattern: 'U', name: t('맨 위로', 'To the top'), desc: t('본문·대화를 처음으로', 'Jump to the start of the content or thread') },
    { pattern: 'D', name: t('맨 아래로', 'To the bottom'), desc: t('본문·대화를 끝으로', 'Jump to the end of the content or thread') },
    {
      pattern: 'UL',
      name: t('추가 채팅 열기', 'Open extra chat'),
      desc: t('독립 창으로 새 대화를 하나 더 — 대화 화면 어디서나', 'One more chat in its own window — anywhere in a thread')
    },
    {
      pattern: 'UD',
      name: t('대화 비우기', 'Clear the thread'),
      desc: t('지금 보는 대화를 백지로 — /clear와 같아요', 'Wipes the thread you’re looking at — same as /clear')
    },
    {
      pattern: 'RU',
      name: t('최대화/크게 보기', 'Maximize / focus view'),
      desc: t(
        '추가 채팅 창은 최대화(다시 그으면 원래대로), 멀티 패널은 크게 보기',
        'Maximizes an extra chat window (draw again to restore); opens the focus view for a multi panel'
      )
    },
    {
      pattern: 'DR',
      name: t('창 닫기', 'Close window'),
      desc: t(
        '카드·추가 채팅 창·크게 보기를 닫아요 — 저장 안 한 변경이 있으면 물어봐요',
        'Closes a card, an extra chat window, or the focus view — asks first if there are unsaved changes'
      )
    }
  ]
}

function GestureView(): React.ReactElement {
  const [enabled, setEnabled] = useState<boolean>(() => getPref('gesture.enabled', true))
  const [start, setStart] = useState<number>(() => getPref('gesture.start', GESTURE_DEFAULTS.start))
  const [stroke, setStroke] = useState<number>(() => getPref('gesture.stroke', GESTURE_DEFAULTS.stroke))
  const toggle = (): void => {
    const next = !enabled
    setEnabled(next)
    setPref('gesture.enabled', next)
  }

  return (
    <>
      <div className="set-h1">Gestures</div>
      <div className="set-h1-sub">
        {isEn() ? (
          <>
            In the file viewer, Bash logs, Git cards, and chat threads, <b>hold right-click and drag</b> to draw a
            gesture. A short drag is just a normal right-click, so the usual context menus still work.
          </>
        ) : (
          <>
            파일 뷰어·Bash 로그·Git 카드와 대화 스레드에서 <b>우클릭을 누른 채 드래그</b>하면 제스처예요. 짧게 그으면
            평범한 우클릭이라 기존 우클릭 메뉴는 그대로 동작해요.
          </>
        )}
      </div>

      <div className="sc2 tgl" style={{ marginTop: 20 }}>
        <div>
          <div className="em">{t('마우스 제스처', 'Mouse gestures')}</div>
          <div className="meta">
            {enabled
              ? t('우클릭 드래그로 뷰어를 조작해요', 'Right-click drag drives the viewer')
              : t('꺼짐 — 우클릭은 메뉴만 열어요', 'Off — right-click only opens menus')}
          </div>
        </div>
        <span className="sp" />
        <button
          className={'sw2' + (enabled ? ' on' : '')}
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? t('제스처 끄기', 'Turn off gestures') : t('제스처 켜기', 'Turn on gestures')}
          onClick={toggle}
        />
      </div>

      <div className={'dim2' + (enabled ? '' : ' off')}>
        {/* 제스처 목록 — 획 모양 글리프는 인식 버블과 같은 컴포넌트라 실물과 늘 일치 */}
        <div className="set-sec">{t('제스처', 'Gestures')}</div>
        <div className="set-grid3">
          {gestureList().map((g) => (
            <div key={g.pattern} className="sc2 ges">
              <div className="gtile">
                <GestureGlyph pattern={g.pattern} size={22} />
              </div>
              <div>
                <div className="em">{g.name}</div>
                <div className="meta">{g.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* 감도 — 시작 거리(제스처 vs 우클릭 판정)와 획 길이(방향 한 획 판정) */}
        <div className="set-sec">{t('감도', 'Sensitivity')}</div>
        <div className="sc2">
          <PxSlider
            label={t('시작 거리', 'Start distance')}
            desc={t(
              '이만큼 움직여야 제스처로 봐요 — 그 전에 떼면 평범한 우클릭',
              'Move this far before it counts as a gesture — release earlier and it’s a plain right-click'
            )}
            min={8}
            max={30}
            def={GESTURE_DEFAULTS.start}
            value={start}
            onChange={(v) => {
              setStart(v)
              setPref('gesture.start', v)
            }}
          />
          <PxSlider
            label={t('획 길이', 'Stroke length')}
            desc={t(
              '방향 한 획으로 인정하는 최소 이동 — ↓→ 같은 꺾임 인식에 영향',
              'Shortest move that counts as one stroke — affects corners like ↓→'
            )}
            min={12}
            max={48}
            def={GESTURE_DEFAULTS.stroke}
            value={stroke}
            onChange={(v) => {
              setStroke(v)
              setPref('gesture.stroke', v)
            }}
          />
        </div>
      </div>

      <div className="set-note2">
        {t(
          '제스처 중에는 궤적과 인식된 동작이 화면에 표시돼요. 그리다 만 모양이 어떤 동작과도 안 맞으면 아무 일도 일어나지 않아요 — 메뉴도 안 열려요. 낮은 감도 값일수록 예민하게 반응해요.',
          'While you draw, the trail and the matched action show on screen. A half-drawn shape that matches nothing does nothing at all — no menu either. Lower values react more eagerly.'
        )}
      </div>
    </>
  )
}

// 값 슬라이더 한 줄 — 현재 값 표시 + 기본값에서 벗어나면 되돌리기 칩 (단위 기본 px)
function PxSlider({
  label,
  desc,
  min,
  max,
  def,
  value,
  unit = 'px',
  onChange
}: {
  label: string
  desc: string
  min: number
  max: number
  def: number
  value: number
  unit?: string
  onChange: (v: number) => void
}): React.ReactElement {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="sld">
      <div className="sld-head">
        <span className="sld-l">{label}</span>
        <span className="sld-d">{desc}</span>
        {value !== def && (
          <button className="sld-reset" onClick={() => onChange(def)}>
            {t(`기본값 ${def}${unit}`, `Default ${def}${unit}`)}
          </button>
        )}
        <span className="sld-v">
          {value}
          {unit}
        </span>
      </div>
      <input
        className="rng2"
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        style={{ ['--fill' as never]: pct + '%' }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

// ── 화면 (유리 — 아크릴 벽지 비침) ───────────────────────────────────
// 슬라이더 0~100 하나가 창 뒤가 비치는 정도를 정한다. 값은 ui.glass로 저장되고 lib/glass가
// :root 인라인 변수(--panel/--chat-bg)로 반영 — 50이 styles.css의 PoC 확정값(스타일시트 원본).
// 추가 채팅 창은 저장 시 uiGlassChanged 브로드캐스트로 따라온다(드래그 중엔 이 창만 즉시).
/* ═══════════════════════════════════════════════════════════════════════════
 * 대화 연결(M10) — **켜는 문과 끄는 문**.
 *
 * R1은 라우터·상한·옵트인을 전부 세우고 표면을 R2로 미뤘다. 크리틱은 그 순서를
 * 뒤집으라고 판정했다(D7): 위험한 절반은 완성됐는데 사람이 누를 자리가 0이었다.
 *
 * 이 화면의 규칙 셋.
 *  ① **옵트인은 2단이다** — 전역 스위치 ∧ 보드별 동의. 전역만 켜도 아무것도 안 나간다.
 *  ② **끄면 키가 사라진다** — false를 남기면 "예전에 켰던 보드" 목록이 쌓이고,
 *     그게 쌓이면 전역 스위치 한 번이 전원 재무장이 된다(크리틱 D3).
 *  ③ **정지 뒤에는 정지라고 말한다** — 그냥 꺼짐과 정지는 디스크에서 같은
 *     `enabled:false`지만 사용자에게 할 말이 정반대다(D4).
 * ══════════════════════════════════════════════════════════════════════════ */
function TalkView(): React.ReactElement {
  const { cfg, refresh } = useTalkConfig()
  const [boards, setBoards] = useState<{ id: string; title: string }[]>([])
  const [said, setSaid] = useState('')
  // ★R3 — 켜기 전에 뜨는 **1회 고지 카드**(네이티브 다이얼로그 금지 — 앱 규약).
  const [confirmOn, setConfirmOn] = useState(false)
  useEffect(() => {
    void readTalkBoards().then(setBoards)
  }, [])
  const say = (m: string): void => {
    setSaid(m)
    window.setTimeout(() => setSaid(''), 6000)
  }
  const stoppedAt = cfg.stoppedAt ?? null
  const turnOn = (): void => {
    void setTalkConfig({ enabled: true, noticeAck: true }).then(refresh)
    setConfirmOn(false)
  }
  return (
    <>
      <div className="set-h1">{t('대화 연결', 'Cross-talk')}</div>
      <div className="set-h1-sub">
        {t(
          '같은 보드에 앉은 세션끼리 답변 마지막 줄의 @talk[자리] 한 줄로 서로에게 말을 겁니다. 사람의 지시에서만 시작하고, 홉·총량·팬아웃 상한에서 스스로 멎어요. 기본값은 꺼짐이고, 켜는 행위 자체가 동의입니다.',
          'Sessions on the same board message each other with a single @talk[slot] line at the end of a reply. A chain only ever starts from your instruction and stops at the hop / total / fan-out caps. Off by default — turning it on is the consent.'
        )}
      </div>

      {/* ★R3 — **고지를 스위치보다 앞에 둔다.** R2는 이 내용이 화면 맨 아래 작은 글씨
          한 문단이었다(켜는 스위치보다 뒤에, 더 작게). 크리틱 권고 ①②의 순서 뒤집기다.
          문장은 **실측으로** 쓴다 — 세 번 중 세 번 따른 형태가 있었다는 사실을 적는다. */}
      <div className="set-note2" style={{ borderColor: 'var(--amber, #c9922e)', marginBottom: 14 }}>
        {t(
          '먼저 알아야 할 것: 받은 메시지는 인용 블록에 갇히고 그 턴의 권한은 아래 하한까지 낮아지지만, 이건 완화이지 차단이 아닙니다 — 실제 시험에서 세 번 중 세 번 지시를 그대로 따른 형태가 있었습니다(그 형태는 막았지만 다음 형태를 막았다는 뜻은 아닙니다). 되돌릴 수 없는 일을 하는 보드(배포·마이그레이션·rm)에서는 켜지 마세요.',
          'Read this first: an incoming message is walled inside a quoted block and that turn runs under the floor you set below — but this is a mitigation, not a block. In real testing there was a shape the receiver obeyed three times out of three (that shape is closed now; that does not mean the next one is). Do not enable this on boards that do irreversible work (deploys, migrations, rm).'
        )}
        {/* ★R4 — 크리틱 권고 ③. **실측 숫자 그대로** 적는다: 읽기 누수는 하한이 막지
            않는 축이고(쓰기만 막는다), 회신 전용의 수명은 R4에서 규칙이 바뀌었다. */}
        <div style={{ marginTop: 8 }}>
          {t(
            '· 읽기는 막지 않습니다. 받은 세션이 읽어서 알아낸 것(작업 폴더 경로·파일 목록·파일 내용)을 회신에 실어 보낼 수 있고, 시험 21회 중 2회 실제로 상대 세션까지 갔습니다(같은 문장이 다른 회차엔 거절됐습니다 — 재량이라 회차마다 갈립니다).',
            '· Reading is not blocked. What the receiving session learns by reading (working-folder path, file listing, file contents) can ride back in its reply — in testing that reached the other session 2 times out of 21 (the same sentence was refused on other runs; it is discretion, so it varies).'
          )}
        </div>
        <div style={{ marginTop: 6 }}>
          {t(
            '· 회신 전용은 이 채팅에 말을 걸어도 풀리지 않습니다(R3까지는 한 마디면 풀렸어요). 다른 자리로 옮기려면 사용자가 프롬프트에 @talk[자리] 한 줄을 직접 써야 하고, 그 줄을 쓰는 순간 그 채팅의 홉·총량 예산도 새로 시작합니다.',
            '· Reply-only no longer lifts when you type into that chat (until R3 a single word lifted it). To relay elsewhere you must write an @talk[slot] line in your own prompt — and that line also restarts the hop / total budget for that chat.'
          )}
        </div>
      </div>

      {stoppedAt != null && (
        <div className="set-note2" style={{ borderColor: 'var(--red)', marginBottom: 14 }}>
          {t(
            '긴급 정지가 걸려 있어요. 도는 연쇄와 대기 중이던 메시지는 버려졌고, 보드 동의도 전부 해제됐습니다 — 다시 쓰려면 아래에서 켜고 보드마다 다시 동의해 주세요.',
            'An emergency stop is in effect. Running chains and queued messages were dropped and every board opt-in was revoked — turn it back on below and re-consent per board.'
          )}
        </div>
      )}

      <div className="set-sec">{t('전역', 'Global')}</div>
      <div className="sc2 tgl">
        <div>
          <div className="em">{t('대화 연결 사용', 'Enable cross-talk')}</div>
          <div className="meta">
            {cfg.enabled
              ? t('아래에서 동의한 보드에서만 오갑니다', 'Messages flow only on the boards you consented to below')
              : t('꺼져 있으면 @talk 구문은 답변에 글자로만 남아요', 'While off, an @talk line stays plain text in the reply')}
          </div>
        </div>
        <span className="sp" />
        <button
          className={'sw2' + (cfg.enabled ? ' on' : '')}
          role="switch"
          aria-checked={cfg.enabled}
          aria-label={cfg.enabled ? t('대화 연결 끄기', 'Turn off cross-talk') : t('대화 연결 켜기', 'Turn on cross-talk')}
          onClick={() => {
            // 끄는 것은 즉시. **켜는 것**은 처음 한 번 확인 카드를 지난다(★R3 권고 ①).
            if (cfg.enabled) {
              void setTalkConfig({ enabled: false }).then(refresh)
              return
            }
            if (cfg.noticeAckAt == null) setConfirmOn(true)
            else turnOn()
          }}
        />
      </div>

      {/* 1회 확인 카드 — 네이티브 다이얼로그를 쓰지 않는다(스레드를 막고 한글 IME를
          망가뜨린다 — 앱 규약). 표식은 홈에 남아 창을 옮겨도 다시 뜨지 않는다. */}
      {confirmOn && (
        <div className="set-dialog" style={{ marginTop: 10 }}>
          <div className="em">{t('대화 연결을 켤까요?', 'Turn cross-talk on?')}</div>
          <div className="meta" style={{ marginTop: 6, lineHeight: 1.65 }}>
            {t(
              '켜면 이 보드의 세션들이 서로에게 지시를 보냅니다. 앱이 하는 일: ① 받은 메시지를 인용 블록에 가두고 ② 그 턴만 권한을 낮추고(기본: 읽기 전용) ③ 받은 세션의 발신을 보낸 세션 하나로 묶고 ④ 홉·총량·팬아웃에서 멎게 하고 ⑤ 거절 회신을 앱이 정한 한 문장으로 다시 씁니다(받은 글의 문자열이 회신에 실려 나가지 않게).',
              'Once on, the sessions on this board send each other instructions. What the app does: (1) walls the incoming text in a quoted block, (2) lowers that one turn’s permissions (default: read-only), (3) pins the receiver’s sends to the sender alone, (4) stops it at the hop / total / fan-out caps, and (5) rewrites a refusal reply to one fixed sentence so nothing from the incoming text rides back out.'
            )}
          </div>
          <div className="meta" style={{ marginTop: 8, lineHeight: 1.65 }}>
            {t(
              '앱이 못 하는 일: 받은 글이 시키는 대로 모델이 따르는 것 자체는 막지 못합니다. 실제 시험에서 세 번 중 세 번 따른 형태가 있었고(봉투의 표식을 답에 옮겨 쓰게 하는 형태), 그 형태는 닫았지만 다음 형태를 닫았다는 보장은 없습니다 — 바로 다음 라운드에 「거절하면서 인용하게 하는」 형태가 세 번 중 한 번 통했습니다. 그래서 하한을 「읽기 전용」으로 두면 따르더라도 파일을 고치거나 명령을 돌릴 수단이 그 턴에 없습니다.',
              'What the app cannot do: it cannot stop the model from complying with what the text asks. In real testing one shape was obeyed three times out of three (getting the receiver to echo the envelope markers). That shape is closed; the next one was not — a “refuse, but quote what you were asked for” shape landed 1 time out of 3 the very next round. That is why the read-only floor matters — even if it complies, that turn has no way to edit files or run commands.'
            )}
          </div>
          <div className="meta" style={{ marginTop: 8, lineHeight: 1.65 }}>
            {t(
              '그리고 두 가지를 미리 아셔야 합니다. ① 읽기는 막지 않습니다 — 받은 세션이 읽어서 알아낸 것(경로·파일 목록·파일 내용)을 회신에 실을 수 있고, 시험 21회 중 2회 실제로 상대 세션까지 갔습니다. ② 회신 전용은 그 채팅에 말을 걸어도 유지되고, 사용자가 프롬프트에 @talk[자리] 한 줄을 직접 쓸 때만 풀립니다.',
              'Two more things up front. (1) Reading is not blocked — what the receiver learns by reading (paths, file listings, file contents) can ride back in its reply; that reached the other session 2 times out of 21 in testing. (2) Reply-only survives you typing into that chat; it lifts only when you write an @talk[slot] line in your own prompt.'
            )}
          </div>
          <div className="set-dialog-row" style={{ marginTop: 12 }}>
            <button className="btn2" onClick={() => setConfirmOn(false)}>
              {t('안 켤래요', 'Cancel')}
            </button>
            <button className="btn2 pri" onClick={turnOn}>
              {t('읽고 켭니다', 'I read it — turn it on')}
            </button>
          </div>
        </div>
      )}

      <div className="set-sec" style={{ marginTop: 26 }}>
        {t('보드별 동의', 'Per-board consent')}
      </div>
      <div className="set-note2">
        {t(
          '전역 스위치만으로는 아무것도 나가지 않아요 — 이 목록에서 켠 보드의 보이는 자리끼리만 서로를 볼 수 있습니다.',
          'The global switch alone sends nothing — only the visible slots of the boards you enable here can reach each other.'
        )}
      </div>
      {boards.length === 0 ? (
        <div className="sc2 meta">{t('보드가 없어요.', 'No boards yet.')}</div>
      ) : (
        boards.map((b) => {
          const on = cfg.boards?.[b.id] === true
          return (
            <div className="sc2 tgl" key={b.id} style={{ marginTop: 8 }}>
              <div>
                <div className="em">{b.title || b.id}</div>
                <div className="meta">{b.id}</div>
              </div>
              <span className="sp" />
              <button
                className={'sw2' + (on ? ' on' : '')}
                role="switch"
                aria-checked={on}
                aria-label={b.title || b.id}
                onClick={() => {
                  void setTalkBoard(b.id, !on).then(refresh)
                }}
              />
            </div>
          )
        })
      )}

      {/* ★R3 C1 — **봉투 턴의 권한 하한.** 이게 이 기능에서 유일하게 "재량이 아닌" 축이다. */}
      <div className="set-sec" style={{ marginTop: 26 }}>
        {t('받은 메시지가 만든 턴', 'Turns created by an incoming message')}
      </div>
      <div className="set-note2">
        {t(
          '받은 글이 무엇을 시키든, 그 턴이 실제로 할 수 있는 일의 천장입니다. 봉투(인용 블록·경고 문구)는 모델의 판단에 기대는 완화라 뚫릴 수 있어요 — 뚫렸을 때 남는 것이 이 설정입니다.',
          'Whatever the incoming text asks for, this is the ceiling on what that turn can actually do. The envelope (quoted block + warnings) leans on the model’s judgement and can be beaten — this setting is what is left when it is.'
        )}
      </div>
      <div className="sc2 tgl">
        <div>
          <div className="em">{t('읽기 전용으로 돌리기', 'Run it read-only')}</div>
          <div className="meta">
            {cfg.injectPolicy !== 'ask'
              ? t(
                  '그 턴만 계획 모드로 돕니다 — 파일 수정·명령 실행의 수단이 아예 없어요(허용 목록에 넣어 둔 도구도 그 턴에는 안 돕니다). 권장.',
                  'That one turn runs in plan mode — it has no way at all to edit files or run commands (not even tools you already allow-listed).'
                )
              : t(
                  '자동승인 모드일 때만 승인 필수로 낮춥니다. 주의: 이미 허용 목록에 넣어 둔 도구는 승인 없이 그대로 실행돼요.',
                  'Only downgrades auto-approving modes to ask-first. Note: tools you already allow-listed still run without asking.'
                )}
          </div>
        </div>
        <span className="sp" />
        <button
          className={'sw2' + (cfg.injectPolicy !== 'ask' ? ' on' : '')}
          role="switch"
          aria-checked={cfg.injectPolicy !== 'ask'}
          aria-label={t('받은 메시지 턴을 읽기 전용으로', 'Run incoming-message turns read-only')}
          onClick={() => {
            void setTalkConfig({ injectPolicy: cfg.injectPolicy === 'ask' ? 'readonly' : 'ask' }).then(refresh)
          }}
        />
      </div>

      <div className="set-sec" style={{ marginTop: 26 }}>
        {t('상한', 'Caps')}
      </div>
      <div className="set-note2">
        {t(
          `한 번의 지시가 태울 수 있는 크기예요 — 지금 값이면 최대 ${cfg.maxMsgs}개의 세션 턴입니다. 상한은 「시도」에서 깎으므로 거절된 건도 예산을 씁니다.`,
          `How large one instruction can grow — at these values, at most ${cfg.maxMsgs} session turns. Budget is spent on the attempt, so refused sends count too.`
        )}
      </div>
      <div className="sc2">
        <PxSlider
          label={t('전달 횟수(홉)', 'Hops')}
          desc={t('A→B→A→B… 가 이 횟수에서 멎어요', 'A→B→A→B… stops after this many hand-offs')}
          min={1}
          max={12}
          def={4}
          unit=""
          value={cfg.maxHops}
          onChange={(v) => {
            void setTalkConfig({ maxHops: v }).then(refresh)
          }}
        />
      </div>
      <div className="sc2" style={{ marginTop: 10 }}>
        <PxSlider
          label={t('연쇄 총량', 'Total per chain')}
          desc={t('한 지시에서 뻗어 나온 메시지의 총 개수', 'Total messages that can branch from one instruction')}
          min={1}
          max={24}
          def={12}
          unit=""
          value={cfg.maxMsgs}
          onChange={(v) => {
            void setTalkConfig({ maxMsgs: v }).then(refresh)
          }}
        />
      </div>
      <div className="sc2" style={{ marginTop: 10 }}>
        <PxSlider
          label={t('한 턴의 상대 수(팬아웃)', 'Fan-out')}
          desc={t('한 턴이 동시에 깨우는 세션 수 — 방송 한 줄의 값이 여기서 정해져요', 'How many sessions one turn can wake at once — this is what a broadcast line costs')}
          min={1}
          max={5}
          def={3}
          unit=""
          value={cfg.maxFanout}
          onChange={(v) => {
            void setTalkConfig({ maxFanout: v }).then(refresh)
          }}
        />
      </div>

      <div className="set-sec" style={{ marginTop: 26 }}>
        {t('긴급 정지', 'Emergency stop')}
      </div>
      <div className="set-note2">
        {t(
          `연쇄를 버리고, 다른 세션의 대기 줄에 서 있는 메시지를 뽑아내고, 이미 시작된 「받은 메시지 턴」에 중단을 보내고, 보드 동의를 전부 해제합니다. 메인 창·추가 채팅 창·팝아웃 패널 어디서든 ${STOP_HOTKEY} 로도 눌러요. 사용자가 직접 시킨 턴은 건드리지 않습니다.`,
          `Drops chains, pulls back messages queued in other sessions, interrupts incoming-message turns that already started, and revokes every board opt-in. ${STOP_HOTKEY} works in the main window, extra chat windows and popped-out panels alike. Turns you started yourself are left alone.`
        )}
      </div>
      <div className="sc2" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          className="talk-stop"
          onClick={() => {
            void stopTalk().then((c) => {
              refresh()
              // ★R3 C2 — 알약과 **같은 문장**을 쓴다(한 소스). R2는 여기서 `purged`만
              // 세어 「정지했어요」라고 했고, 그때 도는 턴은 끝까지 갔다.
              say(stopSaid(c))
            })
          }}
        >
          <span className="talk-stop-dot" />
          {t('지금 멈추기', 'Stop now')}
        </button>
        {said && <span className="meta">{said}</span>}
      </div>

      <div className="set-note2" style={{ marginTop: 22 }}>
        {t(
          '남은 위험(정직하게): ① 봉투는 완화입니다 — 모델이 받은 글을 따르는 것 자체는 못 막습니다. ② 「읽기 전용」을 끄면 이미 허용 목록에 넣어 둔 도구는 승인 없이 실행됩니다. ③ 정지는 이미 도는 턴에 중단을 보내지만 CLI가 안 받으면 몇 초 뒤 스트림을 접는 방식이라 그 사이에 한 일은 남습니다(정지 알약은 8초 뒤 실제 결과로 문장을 정정합니다). ④ 받은 턴이 답으로 남기는 글은 여전히 자유 문장이라, 경로 같은 정보를 옮겨 적는 누수는 남습니다 — 앱이 되쓰는 것은 상대에게 나가는 회신뿐이고, 그 세션 자기 화면의 답변은 못 고칩니다(고치면 사용자가 보는 답과 실제가 갈립니다).',
          'Remaining risk, honestly: (1) the envelope is a mitigation — it cannot stop the model from complying with what it reads. (2) With read-only off, tools you already allow-listed run without asking. (3) Stop interrupts a running turn, but if the CLI ignores the interrupt the stream is torn down a few seconds later — whatever happened in between stands (the stop pill corrects its own wording 8 seconds later with the measured result). (4) The reply is still free text, so a leak that merely quotes a path remains possible — the app only rewrites what goes out to the other session; it never edits the answer shown in that session’s own thread (that would split what you read from what happened).'
        )}
      </div>
    </>
  )
}

function DisplayView(): React.ReactElement {
  const [glass, setGlass] = useState<number>(() => getPref(GLASS_PREF, GLASS_DEFAULT))
  // 사이드바 자동 숨김 — 값을 바꾸면 이벤트로 메인 창이 즉시 다시 읽어 반영한다(applyGlass와 같은 결).
  const [autohide, setAutohide] = useState<boolean>(() => getPref<boolean>(SIDEBAR_AUTOHIDE, AUTOHIDE_DEFAULT))
  const [trigger, setTrigger] = useState<number>(() =>
    getPref<number>(SIDEBAR_AUTOHIDE_TRIGGER, AUTOHIDE_TRIGGER_DEFAULT)
  )
  // 포커스 밖 알림(토스트) — 기본 켬. 저장되면 메인 프로세스가 uiPrefsSave에서 캐시를 갱신한다.
  const [notify, setNotify] = useState<boolean>(() => getPref<boolean>('notify.toast', true))
  const emitAutohide = (): void => {
    window.dispatchEvent(new CustomEvent(SIDEBAR_AUTOHIDE_EVENT))
  }
  // 감지 폭 미리보기 — 슬라이더를 만지는 동안 메인 창 가장자리에 그 폭 띠를 띄운다.
  const previewTrigger = (active: boolean, value: number): void => {
    window.dispatchEvent(
      new CustomEvent(SIDEBAR_AUTOHIDE_TRIGGER_PREVIEW_EVENT, { detail: { active, value } })
    )
  }
  // 모달이 슬라이더 위에서 닫혀도 띠가 남지 않게 — 언마운트 시 미리보기 끔.
  useEffect(() => () => previewTrigger(false, 0), [])
  return (
    <>
      <div className="set-h1">Display</div>
      <div className="set-h1-sub">
        {t(
          '창은 DWM 아크릴 유리 위에 얹혀 있어요. 뒤가 얼마나 비칠지 여기서 조절해요 — 본채팅·추가 채팅 창 모두에 함께 적용돼요.',
          'The window sits on DWM acrylic glass. Set how much shows through here — it applies to the main window and every extra chat window.'
        )}
      </div>

      <div className="set-sec">{t('유리', 'Glass')}</div>
      <div className="sc2">
        <PxSlider
          label={t('벽지 비침', 'Wallpaper show-through')}
          desc={t(
            '0 = 완전 불투명 · 클수록 창 뒤가 잘 비쳐요 — 끌면 바로 보여요',
            '0 = fully opaque · higher lets more of the desktop through — drag to preview live'
          )}
          min={0}
          max={100}
          def={GLASS_DEFAULT}
          unit="%"
          value={glass}
          onChange={(v) => {
            setGlass(v)
            setPref(GLASS_PREF, v)
            applyGlass(v)
          }}
        />
      </div>

      <div className="set-note2">
        {t(
          '아크릴 재질은 창이 활성일 때만 살아나요 — 비활성 창이 잠시 불투명해지는 건 Windows 사양이에요. 재질이 없는 Windows 10에서는 값과 무관하게 늘 불투명해요.',
          'Acrylic is only alive while the window is focused — an unfocused window turning opaque is Windows behavior. On Windows 10, which has no such material, the window is always opaque regardless of this value.'
        )}
      </div>

      <div className="set-sec" style={{ marginTop: 26 }}>
        {t('사이드바', 'Sidebar')}
      </div>
      <div className="sc2 tgl">
        <div>
          <div className="em">{t('자동 숨김', 'Auto-hide')}</div>
          <div className="meta">
            {autohide
              ? t(
                  '평소엔 접어 두고, 왼쪽 가장자리에 마우스를 대면 슥 펼쳐져요 — 본채팅·멀티 모두',
                  'Stays collapsed and slides out when the pointer reaches the left edge — main chat and multi alike'
                )
              : t('사이드바를 늘 펼쳐 둬요', 'Keeps the sidebar open at all times')}
          </div>
        </div>
        <span className="sp" />
        <button
          className={'sw2' + (autohide ? ' on' : '')}
          role="switch"
          aria-checked={autohide}
          aria-label={autohide ? t('자동 숨김 끄기', 'Turn off auto-hide') : t('자동 숨김 켜기', 'Turn on auto-hide')}
          onClick={() => {
            const next = !autohide
            setAutohide(next)
            setPref(SIDEBAR_AUTOHIDE, next)
            emitAutohide()
          }}
        />
      </div>
      {autohide && (
        <div
          className="sc2"
          style={{ marginTop: 10 }}
          onPointerEnter={() => previewTrigger(true, trigger)}
          onPointerLeave={() => previewTrigger(false, trigger)}
        >
          <PxSlider
            label={t('감지 폭', 'Trigger width')}
            desc={t(
              '왼쪽 가장자리에서 이만큼 안쪽까지 마우스가 오면 펼쳐져요 — 만지면 창 가장자리에 범위가 보여요',
              'The sidebar opens once the pointer comes this far in from the left edge — touch the slider to see the band on the window'
            )}
            min={AUTOHIDE_TRIGGER_MIN}
            max={AUTOHIDE_TRIGGER_MAX}
            def={AUTOHIDE_TRIGGER_DEFAULT}
            unit="px"
            value={trigger}
            onChange={(v) => {
              setTrigger(v)
              setPref(SIDEBAR_AUTOHIDE_TRIGGER, v)
              emitAutohide()
              previewTrigger(true, v)
            }}
          />
        </div>
      )}

      <div className="set-sec" style={{ marginTop: 26 }}>
        {t('알림', 'Notifications')}
      </div>
      <div className="sc2 tgl">
        <div>
          <div className="em">{t('포커스 밖 알림', 'Out-of-focus alerts')}</div>
          <div className="meta">
            {notify
              ? t(
                  '다른 창을 보는 사이 답변이 오거나 AI가 기다리면, 마우스가 있는 모니터에 토스트로 알려요',
                  'While you’re in another window, a reply or a waiting question pops a toast on the monitor your pointer is on'
                )
              : t('창이 포커스를 잃어도 알리지 않아요', 'Stays quiet even when the window loses focus')}
          </div>
        </div>
        <span className="sp" />
        <button
          className={'sw2' + (notify ? ' on' : '')}
          role="switch"
          aria-checked={notify}
          aria-label={
            notify
              ? t('포커스 밖 알림 끄기', 'Turn off out-of-focus alerts')
              : t('포커스 밖 알림 켜기', 'Turn on out-of-focus alerts')
          }
          onClick={() => {
            const next = !notify
            setNotify(next)
            setPref('notify.toast', next)
          }}
        />
      </div>
      <div className="set-note2">
        {t(
          '토스트는 클릭하면 해당 채팅으로 바로 이동하고, 닫기 전까지 남아 있어요 — 앱 창을 다시 보면 스스로 사라져요.',
          'Click a toast to jump straight to that chat; it stays until dismissed and clears itself once you return to the app.'
        )}
      </div>
    </>
  )
}

// ── 언어 (UI 표시 언어 — 한국어/English) ───────────────────────────────
// 고르는 즉시 이 창은 t() 재평가(루트 useLang 재렌더), 다른 창은 main의 uiLangChanged
// 브로드캐스트로 따라온다. AI 답변 언어는 대화에서 쓰는 언어를 따르므로 여기와 무관.
const LANG_OPTIONS: { id: UiLang; name: string; native: string; tile: string }[] = [
  { id: 'ko', name: '한국어', native: 'Korean', tile: '한' },
  { id: 'en', name: 'English', native: '영어', tile: 'A' }
]
function LanguageView(): React.ReactElement {
  const [lang, setCur] = useState<UiLang>(() => getLang())
  const pick = (l: UiLang): void => {
    setCur(l)
    setLang(l)
  }
  return (
    <>
      <div className="set-h1">Language</div>
      <div className="set-h1-sub">
        {t(
          '앱 화면에 보이는 언어를 골라요 — 바꾸는 즉시 모든 창에 적용돼요.',
          'Choose the language of the app interface — applied to every window instantly.'
        )}
      </div>
      <div className="set-sec">{t('표시 언어', 'Display language')}</div>
      {LANG_OPTIONS.map((o) => (
        <div
          key={o.id}
          className={'sc2 row2 pick' + (lang === o.id ? ' on' : '')}
          role="radio"
          aria-checked={lang === o.id}
          tabIndex={0}
          onClick={() => pick(o.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') pick(o.id)
          }}
        >
          <div className="set-tile">{o.tile}</div>
          <div className="rmain">
            <div className="em">
              {o.name}
              {lang === o.id && <span className="set-badge">{t('사용 중', 'In use')}</span>}
            </div>
            <div className="meta">{o.native}</div>
          </div>
          <span className={'pick-dot' + (lang === o.id ? ' on' : '')} aria-hidden="true" />
        </div>
      ))}
      <div className="set-note2">
        {t(
          '패치노트를 포함해 앱이 보여주는 모든 문구가 따라와요. AI 답변의 언어는 설정과 무관하게 대화에서 쓰는 언어를 따라요.',
          'Everything the app displays follows this choice, patch notes included. The AI replies in whatever language you write in, regardless of this setting.'
        )}
      </div>
    </>
  )
}

function ExplorerView(): React.ReactElement {
  const [enabled, setEnabled] = useState<boolean>(() => getHideEnabled())
  const [dirs, setDirs] = useState<string[]>(() => getHideDirs())
  const [files, setFiles] = useState<string[]>(() => getHideFiles())
  const toggle = (): void => {
    const next = !enabled
    setEnabled(next)
    setHideEnabled(next)
  }
  // 파일 목록을 화면용으로 두 갈래로 — 커밋은 다른 갈래를 보존한 채 합쳐서 한 목록으로 저장
  const plainFiles = files.filter((f) => !isExtPattern(f))
  const extFiles = files.filter(isExtPattern)
  const commitFiles = (l: string[]): void => {
    setFiles(l)
    setHideFiles(l) // 저장 + 탐색기에 알림
  }

  return (
    <>
      <div className="set-h1">Explorer</div>
      <div className="set-h1-sub">
        {isEn() ? (
          <>
            Manage the folders and files hidden in the file explorer tree. Tuck away build output like{' '}
            <code>bin</code> and <code>obj</code>, plus files like <code>Thumbs.db</code> and{' '}
            <code>*.uasset</code>, to keep your eyes on the source.
          </>
        ) : (
          <>
            파일 탐색기 트리에서 숨길 폴더·파일을 관리해요. <code>bin</code>·<code>obj</code> 같은 빌드·생성물 폴더와{' '}
            <code>Thumbs.db</code>·<code>*.uasset</code> 같은 파일을 감춰 소스에 집중할 수 있어요.
          </>
        )}
      </div>

      {/* 위: 마스터 토글 하나 — 폴더·파일 목록에 함께 적용 */}
      <div className="sc2 tgl" style={{ marginTop: 20 }}>
        <div>
          <div className="em">{t('빌드·생성물 숨기기', 'Hide build output')}</div>
          <div className="meta">
            {enabled
              ? t('아래 목록의 폴더·파일을 탐색기에서 감춰요', 'Hides the folders and files listed below')
              : t('모든 폴더·파일을 그대로 보여줘요', 'Shows every folder and file as is')}
          </div>
        </div>
        <span className="sp" />
        <button
          className={'sw2' + (enabled ? ' on' : '')}
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? t('숨김 끄기', 'Turn off hiding') : t('숨김 켜기', 'Turn on hiding')}
          onClick={toggle}
        />
      </div>

      {/* 아래: Folders / Files / Extensions 세 카드 — 같은 UI 한 벌(추가 + 찾기 + 칩 목록)을 공유 */}
      <div className={'dim2' + (enabled ? '' : ' off')}>
        <HideListSection
          title="Folders"
          sub={t('폴더 이름 — 같은 이름의 파일은 그대로', 'Folder names — files with the same name stay visible')}
          placeholder={t('폴더 이름 추가 (예: Logs)', 'Add a folder name (e.g. Logs)')}
          unit={t('폴더', 'folders')}
          defaults={DEFAULT_HIDE_DIRS}
          list={dirs}
          onCommit={(l) => {
            setDirs(l)
            setHideDirs(l) // 저장 + 탐색기에 알림
          }}
        />
        <HideListSection
          title="Files"
          sub={t('파일 이름 — 폴더는 그대로', 'File names — folders stay visible')}
          placeholder={t('파일 이름 추가 (예: Thumbs.db)', 'Add a file name (e.g. Thumbs.db)')}
          unit={t('파일', 'files')}
          defaults={DEFAULT_HIDE_FILES}
          list={plainFiles}
          onCommit={(l) => commitFiles([...l, ...extFiles])}
        />
        <HideListSection
          title="Extensions"
          sub={t('*.확장자 — 그 확장자의 파일 전부', '*.ext — every file with that extension')}
          placeholder={t('확장자 추가 (예: uasset)', 'Add an extension (e.g. uasset)')}
          unit={t('확장자', 'extensions')}
          defaults={[]}
          list={extFiles}
          onCommit={(l) => commitFiles([...plainFiles, ...l])}
          // 'uasset'·'.uasset'·'*.uasset' 어느 꼴로 넣어도 저장 형태(*.확장자)로 정규화
          normalize={(raw) => {
            const s = raw.replace(/[\\/\s]/g, '').replace(/^\*?\./, '').replace(/[*?]/g, '')
            return s ? '*.' + s : ''
          }}
        />
      </div>

      <div className="set-note2">
        {isEn() ? (
          <>
            Names match <b>case-insensitively</b> at <b>any depth</b> in the tree — the Folders list hides{' '}
            <b>folders only</b>, and the Files and Extensions lists hide <b>files only</b>. Hidden files still exist
            and the agent can still reach them — this only tidies the view. You can also add entries by{' '}
            <b>right-clicking a file or folder → Add to hidden list</b> in the explorer, and toggle hiding quickly
            with the <IconFilter size={11} /> button in the explorer header.
          </>
        ) : (
          <>
            이름은 <b>대소문자 구분 없이</b>, 트리의 <b>어느 깊이에서든</b> 매칭돼요 — Folders 목록은 <b>폴더만</b>,
            Files·Extensions 목록은 <b>파일만</b> 숨겨요. 숨겨도 파일은 남아 있고 에이전트는 접근할 수 있어요 — 보기만
            정리하는 거예요. 탐색기에서 파일·폴더를 <b>우클릭 → 숨김 목록에 추가</b>로도 넣을 수 있고, 탐색기 헤더의{' '}
            <IconFilter size={11} /> 버튼으로 빠르게 켜고 끌 수 있어요.
          </>
        )}
      </div>
    </>
  )
}

// 숨김 목록 한 벌 — 카드 하나에 제목 줄(개수·기본값 복원), 추가 입력 + 목록 안 찾기
// (프리셋이 수십 개라 스크롤보다 검색이 빠르다), 숨김 패턴 칩(클릭으로 제거).
// Folders/Files/Extensions 세 카드가 이 컴포넌트를 공유한다.
function HideListSection({
  title,
  sub,
  placeholder,
  unit,
  defaults,
  list,
  onCommit,
  normalize
}: {
  title: string
  sub: string
  placeholder: string
  unit: string // 개수 표기 단위 — '폴더'·'파일'·'확장자'
  defaults: string[]
  list: string[]
  onCommit: (l: string[]) => void
  normalize?: (raw: string) => string // 섹션별 입력 정규화 — 기본은 경로 구분자 제거
}): React.ReactElement {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')

  const add = (): void => {
    // '이름'(또는 * ? 패턴)만 받는다 — 정규화 후 비면 무시, 이미 있으면(대소문자 무시) 무시
    const name = (normalize ?? ((s: string) => s.replace(/[\\/]/g, '')))(input.trim())
    if (!name) return
    setInput('')
    if (list.some((d) => d.toLowerCase() === name.toLowerCase())) return
    onCommit([...list, name])
  }
  const isDefault = list.length === defaults.length && list.every((d, i) => d === defaults[i])
  const q = query.trim().toLowerCase()
  const shown = q ? list.filter((d) => d.toLowerCase().includes(q)) : list

  return (
    <div className="sc2">
      <div className="exh">
        <span className="t2">{title}</span>
        <span className="d2">{sub}</span>
        <span className="sp" />
        <span className="cnt">
          {q
            ? t(`${shown.length}/${list.length}개 ${unit}`, `${shown.length}/${list.length} ${unit}`)
            : t(`${list.length}개 ${unit}`, `${list.length} ${unit}`)}
        </span>
        {/* 기본값이 아예 없는 섹션(Extensions)에선 '복원'이 '모두 지우기'가 돼버려 안 보여준다 */}
        {defaults.length > 0 && (
          <button className="restore" disabled={isDefault} onClick={() => onCommit([...defaults])}>
            {t('기본값 복원', 'Restore defaults')}
          </button>
        )}
      </div>
      <div className="exadd">
        <input
          className="ain"
          placeholder={placeholder}
          value={input}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <button className="set-chipbtn" disabled={!input.trim()} onClick={add}>
          {t('추가', 'Add')}
        </button>
        <div className="exfind">
          <IconSearch size={11} />
          <input
            placeholder={t(unit + ' 찾기', 'Find ' + unit)}
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {query && (
            <button aria-label={t('찾기 지우기', 'Clear search')} onClick={() => setQuery('')}>
              <IconX2 size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="chips2 scroll">
        {list.length === 0 ? (
          <div className="exempty">
            {t('숨길 목록이 비어 있어요 — 위에서 추가하세요', 'Nothing hidden yet — add an entry above')}
          </div>
        ) : shown.length === 0 ? (
          <div className="exempty">
            {t(`‘${query.trim()}’와 일치하는 항목이 없어요`, `Nothing matches ‘${query.trim()}’`)}
          </div>
        ) : (
          shown.map((d) => (
            <button
              className="xchip"
              key={d}
              title={t(d + ' 제거', 'Remove ' + d)}
              aria-label={t(d + ' 제거', 'Remove ' + d)}
              onClick={() => onCommit(list.filter((x) => x !== d))}
            >
              {d}
              <IconX2 size={9} />
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export function SettingsModal({
  cwd,
  onClose,
  initialView
}: {
  cwd: string
  onClose: () => void
  initialView?: SettingsView // 특정 탭으로 바로 열기 (예: 컴포저 API 토글 → 'api')
}) {
  const [view, setView] = useState<View>(initialView ?? 'profile')
  // 마우스 제스처(↑/↓ 본문 스크롤 · ↓→ 닫기) 대상 — 카드 루트를 state로 추적
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  // 레일 검색 — 라벨+keys(한국어 동의어)로 항목을 거르고, 빈 그룹은 라벨째 숨긴다
  const [navQ, setNavQ] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const q = navQ.trim().toLowerCase()
  const groups = navGroups().map((g) => ({
    ...g,
    items: g.items.filter((it) => !q || (it.label + ' ' + it.keys).toLowerCase().includes(q))
  })).filter((g) => g.items.length > 0)

  return (
    <div className="set-overlay" onMouseDown={onClose}>
      <MouseGestureLayer
        target={cardEl}
        actions={[
          ...scrollGestures(() => cardEl?.querySelector('.set-main')),
          { pattern: 'DR', label: t('창 닫기', 'Close window'), run: onClose }
        ]}
      />
      <div className="set-modal" ref={setCardEl} onMouseDown={(e) => e.stopPropagation()}>
        <button className="smh-close set-x" onClick={onClose} aria-label={t('닫기', 'Close')}>
          <IconClose size={16} />
        </button>
        <div className="set-body">
          <nav className="set-nav scroll">
            <div className="set-title">{t('설정', 'Settings')}</div>
            <div className="set-search">
              <IconSearch size={12} />
              <input
                value={navQ}
                onChange={(e) => setNavQ(e.target.value)}
                placeholder={t('설정 검색', 'Search settings')}
              />
            </div>
            {groups.map((g) => (
              <Fragment key={g.label}>
                <div className="set-grp">{g.label}</div>
                {g.items.map(({ id, label, Icon }) => (
                  <button key={id} className={'set-ni' + (view === id ? ' on' : '')} onClick={() => setView(id)}>
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </Fragment>
            ))}
          </nav>
          <main className="set-main scroll">
            <div className="set-inner">
              {view === 'profile' && <ProfileView />}
              {view === 'account' && <AccountView />}
              {view === 'version' && <EngineView />}
              {view === 'api' && <ApiView />}
              {view === 'mcp' && <McpView cwd={cwd} />}
              {view === 'skill' && <SkillView cwd={cwd} />}
              {view === 'talk' && <TalkView />}
              {view === 'display' && <DisplayView />}
              {view === 'language' && <LanguageView />}
              {view === 'lsp' && <LspView />}
              {view === 'explorer' && <ExplorerView />}
              {view === 'gesture' && <GestureView />}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
