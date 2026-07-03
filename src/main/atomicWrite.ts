import fs from 'node:fs'

// Write-then-rename so a crash mid-write can never leave a half-written JSON on disk.
// (The renderer's persisted snapshots are exactly what's being saved when a heavy run
// OOMs — a truncated blob then breaks the next launch.) rename() on the same volume
// replaces the target atomically, on Windows too (MoveFileEx + REPLACE_EXISTING).
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}
