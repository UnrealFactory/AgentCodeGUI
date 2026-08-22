// 수동 Git 추적 — 자동 발견(main gitRepos: 위 1곳 + 깊이 3 걷기)이 못 미치는 깊은 저장소를
// 탐색기 우클릭 '이 폴더 Git 추적'으로 프로젝트별(prefs)로 기억한다. 스트립·Git 카드가
// discoverGitRepos 한 곳으로 자동+수동을 합쳐 본다.
import { getPref, setPref } from './prefs'
import type { GitRepoInfo } from '@shared/protocol'

// 경로 정규화 — 포워드 슬래시·꼬리 슬래시 제거. 비교는 소문자(윈도우 대소문자 무시).
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const keyOf = (cwd: string): string => `git.extra:${norm(cwd).toLowerCase()}`

export function gitExtras(cwd: string): string[] {
  return getPref<string[]>(keyOf(cwd), [])
}

export function isGitExtra(cwd: string, root: string): boolean {
  const r = norm(root).toLowerCase()
  return gitExtras(cwd).some((x) => x.toLowerCase() === r)
}

export function addGitExtra(cwd: string, root: string): void {
  const r = norm(root)
  if (!isGitExtra(cwd, r)) setPref(keyOf(cwd), [...gitExtras(cwd), r])
}

export function removeGitExtra(cwd: string, root: string): void {
  const r = norm(root).toLowerCase()
  setPref(
    keyOf(cwd),
    gitExtras(cwd).filter((x) => x.toLowerCase() !== r)
  )
}

/** 자동 발견 + 수동 추적 합치기 — 탐색기 스트립과 Git 카드가 같은 목록을 본다.
 *  더 이상 저장소가 아닌 수동 항목은 소비자의 status(repo:false) 필터가 걸러낸다. */
export async function discoverGitRepos(cwd: string): Promise<GitRepoInfo[]> {
  const auto = await window.api.git.repos(cwd).catch(() => [] as GitRepoInfo[])
  const seen = new Set(auto.map((r) => norm(r.root).toLowerCase()))
  const base = norm(cwd)
  const out = [...auto]
  for (const root of gitExtras(cwd)) {
    if (seen.has(root.toLowerCase())) continue
    seen.add(root.toLowerCase())
    const rel = root.toLowerCase().startsWith(base.toLowerCase() + '/') ? root.slice(base.length + 1) : ''
    out.push({ root, rel })
  }
  return out
}
