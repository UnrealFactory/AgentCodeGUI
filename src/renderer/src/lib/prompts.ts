// ── 저장 프롬프트 (공유) ─────────────────────────────────────────
// 자주 쓰는 프롬프트를 저장해 두고 복사해 쓰는 라이브러리(사이드바 '프롬프트').
// localStorage는 같은 세션 파티션의 모든 창이 공유하므로(최근 폴더와 같은 규칙),
// 어느 창에서 고쳐도 모달이 열릴 때 새로 읽어 최신이 보인다.
const KEY = 'prompt.library'

export interface SavedPrompt {
  id: string
  title: string // 비워둘 수 있다 — 목록에선 본문 첫 줄로 대신 표시
  text: string
  t: number // 마지막 수정 시각 (epoch ms)
}

export function loadPrompts(): SavedPrompt[] {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(arr)) return []
    return arr
      .filter(
        (x): x is SavedPrompt =>
          !!x && typeof x === 'object' && typeof (x as SavedPrompt).id === 'string' && typeof (x as SavedPrompt).text === 'string'
      )
      .map((x) => ({
        id: x.id,
        title: typeof x.title === 'string' ? x.title : '',
        text: x.text,
        t: typeof x.t === 'number' ? x.t : 0
      }))
  } catch {
    return []
  }
}

export function savePrompts(list: SavedPrompt[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* localStorage 불가 — 이번 창에서만 */
  }
}
