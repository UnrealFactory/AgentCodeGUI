// 2.6.2 src/main/lsp/semcache.ts의 bucketDir/keyFor를 그대로 옮겨 3.0 크레이트가 실제로
// 만든 파일 경로와 대조한다. (홈 복사보다 강한 시험 — 두 구현의 '식'을 직접 맞춘다)
const crypto = require('node:crypto'), path = require('node:path'), fs = require('node:fs')
const CACHE_VERSION = 1
const sanitize = (s) => s.replace(/[^\w.\-]/g, '_')
function bucketDir(DIR, cwd) {
  if (!cwd) return path.join(DIR, '_misc')
  const root = path.resolve(cwd)
  const hash = crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16)
  return path.join(DIR, `${sanitize(path.basename(root)) || 'root'}-${hash}`)
}
function keyFor(serverId, absPath, content) {
  const h = crypto.createHash('sha1')
  h.update(`v${CACHE_VERSION}\0${serverId}\0${absPath.toLowerCase()}\0`)
  h.update(content)
  return h.digest('hex')
}
const [home, cwd, rel, serverId] = process.argv.slice(2)
const DIR = path.join(home, 'lsp', 'semcache')
const abs = path.join(cwd, rel)
const content = fs.readFileSync(abs, 'utf8')
const key = keyFor(serverId, abs, content)
const expect = path.join(bucketDir(DIR, cwd), key.slice(0, 2), key + '.json')
// 3.0 크레이트가 실제로 남긴 파일 전부
const found = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : found.push(p) } }
try { walk(DIR) } catch { /* 없음 */ }
const jsons = found.filter((f) => f.endsWith('.json'))
console.log(JSON.stringify({
  bucket262: path.basename(bucketDir(DIR, cwd)),
  key262: key,
  expectPath: expect,
  crateWrote: jsons,
  rootMarkers: found.filter((f) => f.endsWith('.root')),
  MATCH: jsons.some((f) => path.resolve(f).toLowerCase() === path.resolve(expect).toLowerCase()),
  readableAs262: (() => { try { const o = JSON.parse(fs.readFileSync(expect, 'utf8'))
      return Array.isArray(o?.data) && Array.isArray(o?.types) && Array.isArray(o?.mods) ? { ok: true, tokens: o.data.length / 5, types: o.types.length } : { ok: false }
    } catch (e) { return { ok: false, err: String(e.message) } } })()
}, null, 2))
