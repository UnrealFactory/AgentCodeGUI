// 메인 프로세스 표시 언어 — 렌더러 lib/i18n.ts와 같은 t(ko, en) 문법.
// 사용자에게 닿는 문자열(IPC로 돌려주는 에러·설치 진행 로그·네이티브 메뉴·업데이트
// 스플래시)만 대상이고, 개발 로그·주석은 한국어 그대로 둔다.
// 값은 ui-prefs('ui.lang')가 원본 — 시작 때 한 번 읽고, uiPrefsSave 핸들러가 저장마다
// setUiLang으로 캐시를 갱신한다(파일 재읽기 없음).

export type UiLang = 'ko' | 'en'

let cur: UiLang = 'ko'

export function setUiLang(v: unknown): void {
  cur = v === 'en' ? 'en' : 'ko'
}
export function uiLang(): UiLang {
  return cur
}
export function isEn(): boolean {
  return cur === 'en'
}
export function t(ko: string, en: string): string {
  return cur === 'en' ? en : ko
}
