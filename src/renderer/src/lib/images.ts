// Attachments (images + text/doc files): helpers shared by the composer, the
// message bubbles and the viewer. 이미지가 아닌 첨부는 썸네일 대신 파일명 칩으로
// 렌더되고, 엔진에는 이미지와 똑같이 경로 노트로 전달돼 Read 도구가 읽는다.
import { ATTACH_IMAGE_EXTS, ATTACH_TEXT_EXTS } from '@shared/attachments'

function extOfPath(p: string): string {
  return /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase() ?? ''
}

/** does this path/name look like an image we can show? */
export function isImagePath(p: string): boolean {
  return ATTACH_IMAGE_EXTS.includes(extOfPath(p))
}

/** a text/doc file the engine can read as-is (md, txt, html, code, …) */
export function isTextAttachmentPath(p: string): boolean {
  return ATTACH_TEXT_EXTS.includes(extOfPath(p))
}

/** anything the composer accepts as an attachment */
export function isAttachablePath(p: string): boolean {
  return isImagePath(p) || isTextAttachmentPath(p)
}

/** the just-the-filename tail of a path (handles both slash styles) */
export function imageName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** a renderable src for a local image path, served by the main process over ccg-img:// */
export function imageSrc(p: string): string {
  return 'ccg-img://local/?p=' + encodeURIComponent(p)
}

// pathless File (pasted/browser-dragged)의 저장 확장자 추정 — 이름 → MIME 순
const TEXT_MIME_EXT: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'text/css': 'css',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml'
}
function extOf(file: File): string {
  const fromName = extOfPath(file.name)
  if (fromName) return fromName
  const fromType = /image\/([a-z0-9.+-]+)/i.exec(file.type)?.[1]
  if (fromType) return (fromType === 'svg+xml' ? 'svg' : fromType === 'jpeg' ? 'jpg' : fromType).toLowerCase()
  const fromText = TEXT_MIME_EXT[file.type.toLowerCase()]
  if (fromText) return fromText
  return file.type.startsWith('text/') ? 'txt' : 'png'
}

/**
 * Normalize a drop/paste/picker set of File objects to absolute attachment paths
 * (images + readable text files; anything else is skipped).
 * A File that exists on disk (dragged from the OS) resolves to its path directly;
 * one without a path (a pasted screenshot, a file dragged from a browser) has its
 * bytes written to a temp file by the main process so it too gets a path.
 */
export async function filesToAttachmentPaths(files: Iterable<File>): Promise<string[]> {
  const out: string[] = []
  for (const file of files) {
    const attachable = file.type.startsWith('image/') || file.type.startsWith('text/') || isAttachablePath(file.name)
    if (!attachable) continue
    let p = ''
    try {
      p = window.api.pathForFile(file)
    } catch {
      p = ''
    }
    if (p && isAttachablePath(p)) {
      out.push(p)
      continue
    }
    try {
      const bytes = await file.arrayBuffer()
      out.push(await window.api.saveAttachmentData(bytes, extOf(file)))
    } catch {
      /* unreadable blob — skip it */
    }
  }
  return out
}
