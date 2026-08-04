import { sameCwd } from '../store/session'

// ── 최근 작업 폴더 (공유) ─────────────────────────────────────────
// 일반·멀티·추가 채팅이 하나의 목록을 공유한다. localStorage는 같은 세션 파티션의
// 모든 창(메인·추가 채팅 창)이 공유하므로, 어디서 폴더를 고르든 다른 화면의
// "작업 폴더" 팝오버(열 때마다 새로 읽음)에 바로 나타난다.
const KEY = 'recent.workdirs'
const CAP = 8

export interface RecentDir {
  p: string // 절대 경로
  t: number // 마지막 사용 시각 (epoch ms)
}

export function loadRecentDirs(): RecentDir[] {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x): x is RecentDir => !!x && typeof x === 'object' && typeof (x as RecentDir).p === 'string' && !!(x as RecentDir).p)
      .map((x) => ({ p: x.p, t: typeof x.t === 'number' ? x.t : 0 }))
      .slice(0, CAP)
  } catch {
    return []
  }
}

// 폴더를 실제로 사용(선택·복원)할 때 호출 — 맨 앞으로 올리고 시각을 갱신한다
export function pushRecentDir(dir: string): void {
  if (!dir) return
  try {
    const next = [{ p: dir, t: Date.now() }, ...loadRecentDirs().filter((x) => !sameCwd(x.p, dir))].slice(0, CAP)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* localStorage 불가 — 이번 창에서만 */
  }
}

// 최근 목록에서 제거 — 팝오버 최근 행의 ✕. 그 폴더를 다시 사용하면 pushRecentDir로 재등장
export function removeRecentDir(dir: string): void {
  if (!dir) return
  try {
    localStorage.setItem(KEY, JSON.stringify(loadRecentDirs().filter((x) => !sameCwd(x.p, dir))))
  } catch {
    /* no-op */
  }
}

// 콜드 스타트 시드 — 한 번도 초기화된 적 없을 때만, 기존 채팅들이 쓰던 폴더로 1회 채운다
// (이 기능 도입 전부터 쓰던 사용자의 팝오버가 빈 채로 시작하지 않게). '비어 있으면'이
// 아니라 '키 자체가 없으면'인 이유: ✕로 모두 지운 목록이 재시작마다 부활하면 안 된다
export function seedRecentDirs(entries: { p: string; t: number }[]): void {
  try {
    if (localStorage.getItem(KEY) !== null) return
    const items: RecentDir[] = []
    for (const e of entries) {
      if (!e.p) continue
      const hit = items.find((x) => sameCwd(x.p, e.p))
      if (hit) hit.t = Math.max(hit.t, e.t)
      else items.push({ p: e.p, t: e.t })
    }
    if (!items.length) return
    items.sort((a, b) => b.t - a.t)
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, CAP)))
  } catch {
    /* no-op */
  }
}

// ── 즐겨찾기 작업 폴더 (공유) ─────────────────────────────────────
// 최근 목록과 별개 저장 — 별을 눌러 고정하면 최근(CAP 8)에서 밀려나도 팝오버
// 상단에 남는다. 최근과 같은 localStorage 공유 규칙(모든 창·화면 공용).
const FAV_KEY = 'fav.workdirs'
const FAV_CAP = 12

export function loadFavDirs(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string' && !!x).slice(0, FAV_CAP)
  } catch {
    return []
  }
}

// 별 토글 — 새 즐겨찾기는 맨 앞에. 반환값 = 이제 즐겨찾기인가
export function toggleFavDir(dir: string): boolean {
  if (!dir) return false
  try {
    const cur = loadFavDirs()
    const has = cur.some((p) => sameCwd(p, dir))
    const next = has ? cur.filter((p) => !sameCwd(p, dir)) : [dir, ...cur].slice(0, FAV_CAP)
    localStorage.setItem(FAV_KEY, JSON.stringify(next))
    return !has
  } catch {
    return false
  }
}
