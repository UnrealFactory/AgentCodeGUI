// Mirrors RookissAi-WorkSpace's avatar color logic so a person's avatar matches
// the color they picked in the workspace (explicit `color` wins; otherwise a
// stable hash of their id). Keep in sync with the workspace's avatarColor.ts.

export const AVATAR_PALETTE = [
  '#6366F1', // indigo
  '#0EA5E9', // sky
  '#059669', // emerald
  '#D97706', // amber
  '#DC2626', // red
  '#DB2777', // pink
  '#7C3AED', // violet
  '#0891B2', // cyan
  '#2563EB', // blue
  '#16A34A', // green
  '#EA580C', // orange
  '#9333EA' // purple
]

/** Resolve a person's avatar color: explicit value wins, else a stable hash of the seed. */
export function avatarColor(seed: string | null | undefined, explicit?: string | null): string {
  if (explicit) return explicit
  const s = (seed ?? '').trim()
  if (!s) return '#A3A3A3'
  let h = 0
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length] ?? '#A3A3A3'
}
