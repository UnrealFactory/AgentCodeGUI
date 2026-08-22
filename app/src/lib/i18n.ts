// UI 언어(한국어/영어) — 설정 › Language에서 고르고, 앱의 모든 표시 문자열이 따라간다.
// 사전 파일 없이 콜사이트 인라인 2인자 t(ko, en) 한 벌: 번역이 쓰는 자리 옆에 살아
// 누락·불일치가 구조적으로 안 생기고, 템플릿 리터럴 보간도 그대로 된다.
//
// 반응성: 전환은 리로드 없이 즉시 — App/SessionWindow 루트가 useLang()으로 재렌더를
// 태우고(비-memo 트리는 루트 재렌더로 충분), memo 컴포넌트는 각자 useLang()을 한 줄
// 물어 구독한다. 규칙: 모듈 스코프에서 t()로 "상수"를 만들지 말 것 — import 시점 언어로
// 박제된다. 상수가 필요하면 함수(() => [...])로 늦춰 렌더 때 평가한다.
//
// 저장: ui-prefs('ui.lang') + localStorage 미러('ccg.lang'). 미러는 모듈 로드 시점
// (loadPrefs 전)에도 동기로 맞는 언어를 주는 안전벨트다. 다른 창은 main이 glass와 같은
// 경로(uiLangChanged 브로드캐스트)로 맞춰 준다. 메인 프로세스 문자열은 src/main/lang.ts.
import { useEffect, useReducer } from 'react'
import { getPref, patchPref, setPref } from './prefs'

export type UiLang = 'ko' | 'en'
export const LANG_PREF = 'ui.lang'
export const LANG_EVENT = 'ccg-lang-changed'
const MIRROR = 'ccg.lang'

let cur: UiLang = localStorage.getItem(MIRROR) === 'en' ? 'en' : 'ko'

export function getLang(): UiLang {
  return cur
}
export function isEn(): boolean {
  return cur === 'en'
}

/** 표시 문자열 한 개 — 현재 언어의 것을 돌려준다. JSX가 필요하면 isEn() 삼항으로. */
export function t(ko: string, en: string): string {
  return cur === 'en' ? en : ko
}

function apply(l: UiLang): void {
  if (l === cur) return
  cur = l
  try {
    localStorage.setItem(MIRROR, l)
  } catch {
    /* 미러 실패는 치명적이지 않다 — 다음 시작 때 loadPrefs가 맞춘다 */
  }
  window.dispatchEvent(new CustomEvent(LANG_EVENT))
}

/** 설정에서 언어를 바꾼다 — 이 창은 즉시, 다른 창은 main 브로드캐스트로 따라온다. */
export function setLang(l: UiLang): void {
  apply(l)
  setPref(LANG_PREF, l)
}

/** 시작 시 저장값 반영 + 다른 창의 변경 구독. loadPrefs 후·첫 렌더 전에 한 번 부른다. */
export function initLang(): void {
  const saved = getPref<string>(LANG_PREF, cur)
  cur = saved === 'en' ? 'en' : 'ko'
  try {
    localStorage.setItem(MIRROR, cur)
  } catch {
    /* ignore */
  }
  window.api.onUiLangChanged((l) => {
    patchPref(LANG_PREF, l) // 이 창의 다음 flush가 낡은 언어로 되돌려 쓰지 않게
    apply(l === 'en' ? 'en' : 'ko')
  })
}

/** 언어 구독 훅 — memo 컴포넌트·언어에 반응해야 하는 곳은 이 한 줄이면 된다. */
export function useLang(): UiLang {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const on = (): void => force()
    window.addEventListener(LANG_EVENT, on)
    return () => window.removeEventListener(LANG_EVENT, on)
  }, [])
  return cur
}
