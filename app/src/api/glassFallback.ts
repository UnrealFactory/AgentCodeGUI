/* ============================================================
 * 유리 폴백 수신 — 셸(src-tauri/src/glass.rs)이 "이 OS에서는 아크릴을 못 그린다"고
 * 알려 오면, 렌더러를 **의도된 불투명 다크 배경**으로 갈아탄다.
 *
 * ## 왜 이게 필요한가
 *
 * 사이드바에는 자체 배경이 없다 — body의 `--panel`(rgba(21,21,21,.70)) 틴트가 DWM이
 * 그린 아크릴 위에 얹혀 있을 뿐이다(styles.css :root 주석). 3.0의 창은 그 위에
 * `transparent(true)`까지 걸려 있어서, 재질이 사라지면 **벽지가 블러 없이 생으로 비친다**
 * — 글자 뒤로 사진·아이콘이 지나가 읽을 수 없게 된다(scripts/poc-glass/repro.ps1 실측:
 * 백드롭을 NONE으로 내려도 사이드바 픽셀이 벽지 띠를 그대로 따라간다, 스윙 23).
 *
 * 셸은 먼저 백드롭을 재단언해 되살리려 한다.
 *
 * ## R2 — 기본값 반전: **"살아 있음을 증명해야 투명"**
 *
 * R1까지는 *꺼짐을 증명해야* 폴백이 켜졌고, 그래서 두 구멍이 남았다 —
 *  (1) 통지가 닿지 않는 문서(`location.reload()` 후 · 부팅 뒤 연 추가 채팅 창 ·
 *      크래시 복구 재생성 창은 `__ccgGlass.events === 0`이었다),
 *  (2) 셸이 "꺼짐"을 증명하지 못하는 실패(값은 3인데 DWM이 안 그리는 상태).
 * 둘 다 결과가 **최악**(글자 뒤로 벽지가 생으로 지나감)이었다.
 *
 * R2는 판정을 뒤집는다. 폴백은 **셸이 문서 생성 시점에 심는 부트스트랩**
 * (src-tauri/src/glass.rs `boot_script`)이 기본으로 걸고, 스냅샷이 `ok:true`를
 * 증명한 때에만 걷는다. 이 파일은 그 뒤의 **변화**를 받는다:
 *  - 부팅 스냅샷(`window.__CCG_BOOT['ui-glass:state']`)을 구독보다 **먼저** 먹고,
 *  - 이후 `ui-glass:state`로 오는 상태를 그대로 반영한다(멱등).
 * 스냅샷이 없거나 `ok`가 boolean이 아니면 **폴백 쪽에 남는다** — 모르는 것은 꺼진 것이다.
 *
 * ## 왜 클래스 주입인가 (styles.css 무수정 규약)
 *
 * `src/renderer/src/styles.css`는 2.6.2 원본이고 **한 글자도 고치지 않는 것**이 파리티
 * 담보 방식이다(docs/renderer-divergence.md). 그래서 여기서는 스타일시트를 고치는 대신
 *  1) `<html>`에 `ccg-glass-off` 클래스를 걸고,
 *  2) 그 클래스에만 걸리는 규칙을 담은 `<style>` 하나를 문서에 넣는다.
 * 폴백이 걷히면 클래스만 떼면 되고, 원본 CSS는 그대로 남는다.
 *
 * ## 왜 `!important`인가
 *
 * 설정 › Display의 '벽지 비침' 슬라이더(app/src/lib/glass.ts)는 값이 기본(50)이 아닐 때
 * `--panel`·`--chat-bg`를 **documentElement의 인라인 스타일**로 덮어쓴다. 인라인은 어떤
 * 셀렉터보다 세서, `!important` 없이는 폴백이 슬라이더에 그대로 진다 — 유리가 죽었는데
 * 사용자가 비침을 100으로 올려 둔 채팅은 벽지가 더 크게 비치는 최악이 된다.
 * 폴백이 켜져 있는 동안에는 슬라이더가 의미를 잃는 게 맞다(비칠 유리가 없다).
 * ============================================================ */
import { listen } from '@tauri-apps/api/event'

/** 셸 → 렌더러 단방향 브로드캐스트. 사용자 슬라이더 채널(`ui-glass:changed`)과 다른 것이다. */
const CHANNEL = 'ui-glass:state'
const CLASS = 'ccg-glass-off'
const STYLE_ID = 'ccg-glass-fallback'
/** 다음 문서(재로드)에 마지막 판정을 물려주는 자리. glass.rs `BOOT_JS`가 읽는다. */
const SS_KEY = 'ccg.glass.last'

export interface GlassState {
  /** 아크릴이 **살아 있음이 증명됐는가**. true가 아니면 폴백이다(모름 = 꺼짐) */
  ok: boolean
  /** 'effects-off' | 'remote-session' | 'assert-failed' | 'not-verified' | 'unproven' | '' */
  reason: string
  /* 아래는 진단 — 셸이 발신 시점 값으로 채운다. `drifts`가 늘면 그 자체가 발신 사유라
     R1처럼 부팅 숫자에 얼지 않는다(크리틱 §3.3). */
  reasserts?: number
  drifts?: number
  lastDrift?: number
  assertFails?: number
  windows?: number
  seq?: number
  mono?: number
  /** 부팅 스냅샷에만 있다(win.rs boot_payload_script) */
  boot?: boolean
  /** 부팅 스냅샷의 `glass::health()` 전문 */
  health?: Record<string, unknown>
  /**
   * 셸 부트스트랩(glass.rs `BOOT_JS`)이 **실제로 내린 판정**. `ok`(창을 만든 순간의 값)와
   * 직전 문서가 남긴 sessionStorage 판정을 AND 한 결과라, 재로드에서는 `ok`보다 이 값이
   * 옳다. 이걸 안 보고 raw `ok`만 보면 부트스트랩의 보수적 판정을 렌더러가 되돌린다.
   */
  resolvedOk?: boolean
}

/* 불투명 폴백 팔레트.
 *
 * 값을 고른 근거: 아크릴이 살아 있을 때의 실측 사이드바 밝기가 어두운 벽지에서 32/255
 * 언저리였고(scripts/poc-glass repro), 토큰 주석이 말하는 단차 문법이 "바탕 18 ↔ 카드
 * 21(+3) ↔ 팝오버 28(+10)"이다. 그래서 폴백도 **위계를 지킨 두 단**으로만 잡는다 —
 * 사이드바(29)가 본문(20)보다 밝다. 아크릴 때와 같은 순서라 눈이 다시 배우지 않아도 된다.
 * '아무 회색'이 아니라 이 앱의 무채색 언어 안에 있는 값이라는 게 요점이다.
 *
 * **src-tauri/src/glass.rs의 FALLBACK_CSS와 같은 값이어야 한다.** 두 벌인 이유는 시점이
 * 다르기 때문이다 — 셸 쪽은 document-start(첫 픽셀보다 먼저)에, 이쪽은 번들이 선 뒤에
 * 돈다. 갈라지면 `ensureStyle()`이 이 값으로 덮는다. */
const PANEL_OPAQUE = '#1d1d1d'
const CHAT_OPAQUE = '#141414'

function styleText(): string {
  return `
/* 유리 폴백 — 셸이 "아크릴 불가"를 통지했을 때만 걸린다 (api/glassFallback.ts) */
html.${CLASS}{
  /* 창 자체가 투명하므로 루트에도 불투명 바닥을 깐다 — body가 못 덮는 1px 틈으로
     벽지가 새는 것까지 막는다(라운드 코너 안쪽) */
  background: var(--desktop, #101010) !important;
}
html.${CLASS} body{
  --panel: ${PANEL_OPAQUE} !important;
  --chat-bg: ${CHAT_OPAQUE} !important;
  /* 죽은 평면이 되지 않게 아크릴의 광량 낙차만 흉내 낸다 — 색은 없고 밝기만,
     좌상단에서 아주 옅게. background-color(--panel)는 그대로 두고 이미지만 얹는다. */
  background-image:
    radial-gradient(1180px 640px at 10% -10%, rgba(255,255,255,.042), rgba(255,255,255,0) 62%),
    linear-gradient(180deg, rgba(255,255,255,.013), rgba(255,255,255,0) 34%) !important;
}
/* 인라인 변수(슬라이더)를 이기려면 :root에도 같은 값을 !important로 박아야 한다 */
html.${CLASS}{
  --panel: ${PANEL_OPAQUE} !important;
  --chat-bg: ${CHAT_OPAQUE} !important;
}
`
}

let styleEl: HTMLStyleElement | null = null

/**
 * 스타일 하나를 보장한다.
 *
 * 보통은 **셸이 이미 심어 두었다**(glass.rs `boot_script` — document-start, 같은 id).
 * 그때는 그대로 쓴다. 다만 두 벌이 조용히 갈라지면(한쪽만 고친 경우) 폴백 색이 창마다
 * 달라지므로, 심어진 텍스트에 팔레트 두 값이 들어 있는지 검사하고 없으면 **이쪽 정본으로
 * 덮는다**. 이 검사가 두 벌을 묶어 두는 유일한 장치다.
 */
function ensureStyle(): void {
  if (styleEl && styleEl.isConnected && styleEl.dataset.src === 'renderer') return
  const found = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  const t = found?.textContent ?? ''
  if (found && t.includes(PANEL_OPAQUE) && t.includes(CHAT_OPAQUE)) {
    styleEl = found
    return
  }
  styleEl = found ?? document.createElement('style')
  styleEl.id = STYLE_ID
  styleEl.dataset.src = 'renderer'
  styleEl.textContent = styleText()
  if (!styleEl.isConnected) document.head.appendChild(styleEl)
}

/** 폴백 on/off. 멱등이라 셸이 같은 상태를 여러 번 쏴도 무해하다(문서마다 재발신한다). */
export function applyGlassFallback(s: GlassState): void {
  const off = !s.ok
  // 스타일은 **켜질 때만이 아니라 언제나** 보장한다. 나중에 유리가 죽으면 그때는
  // 클래스 토글 한 번이면 끝나야 한다(그 순간 스타일시트를 파싱하면 한 프레임 늦는다).
  ensureStyle()
  document.documentElement.classList.toggle(CLASS, off)
  diag.state = s
  diag.appliedAt = Date.now()
  // 다음 문서에 물려준다. 셸의 부팅 스냅샷은 **창을 만든 순간**의 값이라 같은 웹뷰를
  // 다시 세우는 재로드(크래시 복구 1순위 경로)에서는 낡아 있다 — 그 자리를 이게 메운다.
  // 읽는 쪽은 셸의 document-start 부트스트랩(glass.rs `BOOT_JS`)이고, 둘을 AND 한다.
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify({ ok: s.ok, at: Date.now() }))
  } catch {
    /* 저장소가 막혀 있으면(사설 모드·정책) 스냅샷만으로 간다 */
  }
}

/** 진단 — `window.__ccgGlass` (chrome.ts의 `__ccgChrome`와 같은 규약) */
const diag: {
  state: GlassState | null
  appliedAt: number
  events: number
  /** 부팅 스냅샷을 먹었나 · 셸 부트스트랩이 이 문서에 돌았나 */
  boot: GlassState | null
  bootstrap: boolean
} = {
  state: null,
  appliedAt: 0,
  events: 0,
  boot: null,
  bootstrap: false
}

/**
 * 심이 세워질 때 한 번 부른다(shim.ts 끝).
 *
 * 순서가 중요하다 — **구독보다 먼저 부팅 스냅샷을 먹는다.** `listen()`은 비동기 등록이라
 * 공백이 있고, 셸의 부팅 3연발은 **프로세스당 1회**라 이 문서에 오지 않을 수 있다
 * (재로드·나중에 연 창·크래시 복구 재생성 창). 스냅샷은 win.rs `boot_payload_script`가
 * 문서 생성 시점에 같은 채널 키로 실어 보낸 값이다.
 *
 * 스냅샷이 없으면 **아무것도 되돌리지 않는다** — 셸 부트스트랩이 이미 걸어 둔 폴백이
 * 그대로 남는 것이 R2의 기본값이다(모르는 것은 꺼진 것).
 */
export function initGlassFallback(): void {
  const w = window as unknown as {
    __CCG_BOOT?: Record<string, GlassState>
    __ccgGlassBoot?: GlassState
    __ccgGlass?: typeof diag
  }
  const bs = w.__ccgGlassBoot
  diag.bootstrap = !!bs
  const snap = w.__CCG_BOOT?.[CHANNEL] ?? bs
  // 부트스트랩이 이미 판정을 내렸으면 **그 판정**을 쓴다(raw `ok`가 아니라).
  // 그러지 않으면 재로드에서 부트스트랩의 보수적 AND를 여기서 되돌린다 —
  // 실측으로 밟았다: 문서가 6ms에 폴백으로 섰다가 45ms에 투명으로 돌아갔다.
  const resolved = typeof bs?.resolvedOk === 'boolean' ? bs.resolvedOk : snap?.ok
  if (snap && typeof resolved === 'boolean') {
    diag.boot = snap
    applyGlassFallback({ ...snap, ok: resolved })
  } else {
    // 스냅샷이 없다 = 증명이 없다. 폴백을 확실히 세워 두고 셸의 통지를 기다린다.
    applyGlassFallback({ ok: false, reason: 'unproven' })
  }
  void listen<GlassState>(CHANNEL, (ev) => {
    diag.events++
    const p = ev.payload
    if (!p || typeof p.ok !== 'boolean') return
    applyGlassFallback(p)
  })
  w.__ccgGlass = diag
}
