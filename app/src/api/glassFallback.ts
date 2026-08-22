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
 * 셸은 먼저 백드롭을 재단언해 되살리려 하고, **전역 투명 효과가 꺼져 있어 되살릴 수
 * 없을 때만** 이 이벤트를 보낸다.
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

export interface GlassState {
  /** 아크릴을 그릴 수 있는가. false면 폴백을 켠다 */
  ok: boolean
  /** 'effects-off' | 'remote-session' | 'assert-failed' | '' */
  reason: string
  reasserts?: number
  drifts?: number
}

/* 불투명 폴백 팔레트.
 *
 * 값을 고른 근거: 아크릴이 살아 있을 때의 실측 사이드바 밝기가 어두운 벽지에서 32/255
 * 언저리였고(scripts/poc-glass repro), 토큰 주석이 말하는 단차 문법이 "바탕 18 ↔ 카드
 * 21(+3) ↔ 팝오버 28(+10)"이다. 그래서 폴백도 **위계를 지킨 두 단**으로만 잡는다 —
 * 사이드바(29)가 본문(20)보다 밝다. 아크릴 때와 같은 순서라 눈이 다시 배우지 않아도 된다.
 * '아무 회색'이 아니라 이 앱의 무채색 언어 안에 있는 값이라는 게 요점이다. */
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

function ensureStyle(): void {
  if (styleEl && styleEl.isConnected) return
  styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (styleEl) return
  styleEl = document.createElement('style')
  styleEl.id = STYLE_ID
  styleEl.textContent = styleText()
  document.head.appendChild(styleEl)
}

/** 폴백 on/off. 멱등이라 셸이 같은 상태를 여러 번 쏴도 무해하다(부팅 직후 3회 반복 발신). */
export function applyGlassFallback(s: GlassState): void {
  const off = !s.ok
  if (off) ensureStyle()
  document.documentElement.classList.toggle(CLASS, off)
  diag.state = s
  diag.appliedAt = Date.now()
}

/** 진단 — `window.__ccgGlass` (chrome.ts의 `__ccgChrome`와 같은 규약) */
const diag: { state: GlassState | null; appliedAt: number; events: number } = {
  state: null,
  appliedAt: 0,
  events: 0
}

/**
 * 심이 세워질 때 한 번 부른다(shim.ts 끝). 셸은 부팅 직후 250ms·1s·3s에 현재 상태를
 * **무조건** 한 번씩 쏘므로, 구독이 조금 늦게 붙어도 첫 화면이 틀린 채로 남지 않는다
 * (Tauri의 listen()은 비동기 등록이라 구독 직후 공백이 있다 — shim.ts subscribe 주석과 같은 함정).
 */
export function initGlassFallback(): void {
  void listen<GlassState>(CHANNEL, (ev) => {
    diag.events++
    const p = ev.payload
    if (!p || typeof p.ok !== 'boolean') return
    applyGlassFallback(p)
  })
  ;(window as unknown as { __ccgGlass: typeof diag }).__ccgGlass = diag
}
