import { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import { imageSrc } from './images'

/** Convert a Markdown file destination to the path expected by the file viewer. */
export function markdownFilePath(href: string): string | null {
  const url = href.trim()
  if (!url || /^[#?]/.test(url) || url.startsWith('//')) return null

  let path: string
  if (/^file:/i.test(url)) {
    try {
      const file = new URL(url)
      path = (file.hostname ? `//${file.hostname}` : '') + file.pathname
    } catch {
      return null
    }
  } else {
    // Markdown URI-encodes backslashes before this hook (C:\dir -> C:%5Cdir).
    // A Windows drive is a path, even though URL parsers see its letter as a scheme.
    if (!/^[a-z]:(?:[\\/]|%5c|%2f)/i.test(url) && /^[a-z][a-z\d+.-]*:/i.test(url)) return null
    path = url.split(/[?#]/, 1)[0]
  }

  // References such as file.ts:42:3 and file.ts#L42 must still open the actual file.
  path = path.replace(/:\d+(?::\d+)?$/, '')
  try {
    path = decodeURIComponent(path)
  } catch {
    // A literal percent sign in a filename need not be a valid URI escape.
  }
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return null
  return path.replace(/^\/([a-z]:[\\/])/i, '$1').replace(/\\/g, '/')
}

/** Resolve inline image paths against the owning chat (or Markdown file) directory. */
export function markdownImageSource(src: string, cwd?: string): { src: string; path: string | null } {
  const local = markdownFilePath(src)
  if (local === null) return { src: defaultUrlTransform(src), path: null }
  const path = /^(?:[a-z]:\/|\/)/i.test(local)
    ? local
    : cwd ? `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${local}` : null
  return { src: path ? imageSrc(path) : '', path }
}

// Local images are rendered by MarkdownImage over the app's image protocol.
// Other destinations retain react-markdown's default URL safety checks.
export const markdownImageUrlTransform: UrlTransform = (url, key, node) =>
  key === 'src' && node.tagName === 'img' && markdownFilePath(url) !== null ? url : defaultUrlTransform(url)

// Local anchors are retained only when the caller supplies its file viewer.
export const markdownUrlTransform: UrlTransform = (url, key, node) =>
  key === 'href' && node.tagName === 'a' && markdownFilePath(url) !== null ? url : markdownImageUrlTransform(url, key, node)
