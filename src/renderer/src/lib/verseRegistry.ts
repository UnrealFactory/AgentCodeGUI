import type { VerseRegistry } from '@shared/protocol'

// Accurate Verse type registry (kinds / supers / members / enum values), fetched from main and
// merged here (engine digests are shared across projects; user-type collisions are rare).
// recolorVerse / verseScopes read it SYNCHRONOUSLY; it's populated async on file open, and a version
// bump notifies open editors to re-decorate when it arrives.
// 수명: "프로젝트당 1회"가 아니라 세대(rev) 비교 — 파일을 열 때마다 마지막으로 받은 rev를
// 보내고, 메인이 그 사이 무효화(UEFN 재빌드·.verse 저장·문서 언어 토글)를 겪었을 때만 새
// 레지스트리를 보내온다(안 바뀌었으면 reg=null의 초소형 응답). 전에는 fetch 1회 후 앱을 껐다
// 켤 때까지 낡은 채로 남았다.
let reg: VerseRegistry = { kind: {}, supers: {}, members: {}, methods: {}, enumValues: {}, setters: {}, docs: {} }
let version = 0
const fetchedRev = new Map<string, number>() // cwd(lower) → 마지막으로 적용한 레지스트리 세대
const listeners = new Set<() => void>()

export function verseReg(): VerseRegistry {
  return reg
}
export function verseRegVersion(): number {
  return version
}
/** Subscribe to registry arrivals (editors re-decorate). Returns an unsubscribe fn. */
export function onVerseRegChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Fetch + merge a project's Verse registry — rev가 그대로면 초소형 no-op 응답으로 끝난다.
 *  (non-Verse file / no project → 마크 없이 반환해 다음 Verse 파일이 재시도.) */
export async function ensureVerseRegistry(cwd: string, relPath: string): Promise<void> {
  const key = cwd.toLowerCase()
  const snap = await window.api.lsp.verseRegistry(cwd, relPath, fetchedRev.get(key)).catch(() => null)
  if (!snap) return // non-Verse file or no project yet — leave unmarked so a later Verse file retries
  fetchedRev.set(key, snap.rev)
  const r = snap.reg
  if (!r) return // unchanged since the rev we already merged
  reg = {
    kind: { ...reg.kind, ...r.kind },
    supers: { ...reg.supers, ...r.supers },
    members: { ...reg.members, ...r.members },
    methods: { ...reg.methods, ...r.methods },
    enumValues: { ...reg.enumValues, ...r.enumValues },
    setters: { ...reg.setters, ...r.setters },
    docs: { ...reg.docs, ...r.docs }
  }
  version++
  for (const fn of listeners) fn()
}

/** Members of `typeName` incl. inherited (walk supers), from the registry. Bounded against cycles. */
export function verseInheritedMembers(typeName: string, out: Set<string> = new Set(), seen: Set<string> = new Set()): Set<string> {
  if (seen.has(typeName)) return out
  seen.add(typeName)
  for (const m of reg.members[typeName] ?? []) out.add(m)
  for (const s of reg.supers[typeName] ?? []) verseInheritedMembers(s, out, seen)
  return out
}

/** Methods (function members) of `typeName` incl. inherited — coloured as functions, not data members. */
export function verseInheritedMethods(typeName: string, out: Set<string> = new Set(), seen: Set<string> = new Set()): Set<string> {
  if (seen.has(typeName)) return out
  seen.add(typeName)
  for (const m of reg.methods[typeName] ?? []) out.add(m)
  for (const s of reg.supers[typeName] ?? []) verseInheritedMethods(s, out, seen)
  return out
}
