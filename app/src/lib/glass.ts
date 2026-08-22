// 유리(벽지 비침) 조절 — 설정 › Display의 슬라이더(0~100)가 아크릴 위 틴트 두 토큰의
// 알파를 바꾼다. 창의 유리 느낌은 body(--panel 사이드바 기조)와 본문(.chat/.multi/.sw의
// --chat-bg)이 아크릴을 얼마나 가리느냐가 전부라, 이 둘만 만지고 카드/모달(--bg)은
// 가독성 때문에 그대로 둔다(PoC '사실상 불투명' 확정).
//
// 50 = styles.css의 확정값 그대로 — 이때는 인라인 오버라이드를 걷어 스타일시트가
// 원본으로 남는다. 0 = 완전 불투명(유리 없음), 100 = 비침 최대. 앵커 알파(at50)는
// styles.css의 --panel(.70)/--chat-bg(.70)와 짝 — 토큰을 바꾸면 여기도 함께 바꿔야 한다.
//
// 벽지 유리(벽지를 캔버스에 구워 html 배경으로 까는 Mica 방식)는 시도 후 롤백 —
// 라이브 벽지 앱(Wallpaper Engine) 사용자는 실제 배경과 다른 OS 벽지가 비쳐 어색하다.
import { getPref, patchPref } from './prefs'

export const GLASS_PREF = 'ui.glass'
export const GLASS_DEFAULT = 50

// 앵커: 0 → 불투명 · 50 → 확정값 · 100 → 비침 최대(본문은 확 열고, 사이드바는
// 기조를 지키느라 덜 — 레일이 너무 비치면 텍스트 위계가 무너진다)
const PANEL = { rgb: '21,21,21', at0: 1, at50: 0.7, at100: 0.52 }
const CHAT = { rgb: '16,16,16', at0: 1, at50: 0.7, at100: 0.35 }

// 두 앵커 구간(0↔50, 50↔100)을 잇는 꺾은선 보간 — 기본값을 정확히 통과한다
function alphaAt(a: { at0: number; at50: number; at100: number }, g: number): number {
  return g <= 50 ? a.at0 + (a.at50 - a.at0) * (g / 50) : a.at50 + (a.at100 - a.at50) * ((g - 50) / 50)
}

/** 유리 값(0~100)을 :root 인라인 변수로 반영한다. 기본값이면 오버라이드를 걷는다. */
export function applyGlass(g: number): void {
  const v = Math.max(0, Math.min(100, Math.round(g)))
  const st = document.documentElement.style
  if (v === GLASS_DEFAULT) {
    st.removeProperty('--panel')
    st.removeProperty('--chat-bg')
    return
  }
  st.setProperty('--panel', `rgba(${PANEL.rgb},${alphaAt(PANEL, v).toFixed(3)})`)
  st.setProperty('--chat-bg', `rgba(${CHAT.rgb},${alphaAt(CHAT, v).toFixed(3)})`)
}

/** 시작 시 저장값 적용 + 다른 창의 변경 구독. loadPrefs 후·첫 렌더 전에 한 번 부른다. */
export function initGlass(): void {
  applyGlass(getPref(GLASS_PREF, GLASS_DEFAULT))
  // 어느 창의 설정에서 바꾸든 전 창이 받는다(바꾼 창 자신도 — 재적용은 멱등이라 무해)
  window.api.onUiGlassChanged((v) => {
    patchPref(GLASS_PREF, v)
    applyGlass(v)
  })
}
