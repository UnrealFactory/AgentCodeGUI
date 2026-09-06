import { defaultUrlTransform, type UrlTransform } from 'react-markdown'

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

// Keep local destinations only for anchors handled by our file viewer. Images and
// all other schemes retain react-markdown's default URL safety checks.
export const markdownUrlTransform: UrlTransform = (url, key, node) =>
  key === 'href' && node.tagName === 'a' && markdownFilePath(url) !== null ? url : defaultUrlTransform(url)
