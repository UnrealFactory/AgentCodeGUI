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

/**
 * a renderable src for a local image path, served by the shell over the `ccg-img` scheme.
 *
 * ★ 3.0 M-UX R3 — **리터럴 `ccg-img://`가 아니다.** WebView2는 비표준 스킴을 못 받아서
 * wry가 커스텀 스킴을 `http://<scheme>.localhost/…`로 바꿔 필터를 건다
 * (`wry webview2/mod.rs` `attach_custom_protocol_handler` → `work_around_uri_prefix`).
 * 2.6.2가 쓰던 `ccg-img://local/?p=…`는 그 필터에 **안 걸리고** 그냥 로드 실패한다
 * → `<img onError>` → 뷰어가 "이미지를 표시할 수 없어요"(M6 보고 §5-A: 뷰어 이미지·
 * SVG 미리보기가 3.0에서만 못 뜨던 한 뿌리). 이 문자열은 Tauri
 * `convertFileSrc(p, 'ccg-img')`가 만드는 것과 같고, 셸(`ccg_fs::serve::path_from_uri`)은
 * 두 모양(`?p=` · `/<encoded>`)을 다 받으므로 어느 쪽으로 와도 같은 바이트를 낸다.
 */
export function imageSrc(p: string): string {
  return 'http://ccg-img.localhost/' + encodeURIComponent(p)
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
