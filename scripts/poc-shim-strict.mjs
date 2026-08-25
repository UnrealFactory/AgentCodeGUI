// R28f SHIPBLOCK N1(3) — 심의 **미구현 처리**를 스텁 하네스로 잰다.
//
//   node scripts/poc-shim-strict.mjs
//
// 왜 스텁인가: 다섯 채널이 배선된 지금 살아 있는 앱에서는 이 갈래가 **안 돈다**(전부
// 구현됐으니까). 그런데 이 라운드가 닫는 병의 뿌리는 채널 다섯이 아니라 **구조**였다 —
// "미구현이면 안전값을 resolve한다"가 목록 setter 바로 앞에 앉아 있었고, 그래서 실패가
// 「빈 목록」으로 번역돼 아무 문구 없이 화면의 계정이 사라졌다(감사 R2 §N1).
// 그 구조가 진짜로 바뀌었는지는 `invoke`를 스텁으로 갈아끼워야만 잴 수 있다.
//
// 재는 것:
//   A. 조회 채널(listAccounts·accountsUsage)은 여전히 **안전값으로 resolve**한다(회귀 없음).
//   B. 쓰기 채널(codexAuth 넷 · auth 넷)은 **reject**한다 = 호출부의 catch가 돈다.
//   C. 그 reject는 어느 채널이었는지 들고 온다(ShimUnavailableError.channel).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// 대조군을 위한 두 손잡이 — `--repo=<트리> --entry=<상대경로>`로 **옛 심**을 그대로 잰다
//   git show HEAD:app/src/api/shim.ts > <트리>/app/src/api/shim.head.ts
//   node scripts/poc-shim-strict.mjs --repo=<트리> --entry=app/src/api/shim.head.ts
const argv = process.argv.slice(2)
const arg = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`))
  return a ? a.slice(k.length + 3) : d
}
const REPO = path.resolve(arg('repo', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')))
const ENTRY = path.join(REPO, arg('entry', 'app/src/api/shim.ts'))
const OUT = path.join(os.tmpdir(), `ccg-shim-strict-${Date.now()}.mjs`)

// `@tauri-apps/api/*`와 브라우저 전용 곁가지(창 크롬·유리 폴백)를 스텁으로 갈아끼운다.
const stub = {
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: /^@tauri-apps\/api\// }, (a) => ({ path: a.path, namespace: 'stub' }))
    b.onResolve({ filter: /\.\/(chrome|glassFallback)$/ }, (a) => ({ path: a.path, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
      if (a.path.endsWith('/core')) {
        return {
          contents: `
            export const invoke = (cmd, args) => {
              globalThis.__calls.push(args.channel)
              const r = globalThis.__reply(args.channel)
              return r === 'THROW' ? Promise.reject(new Error('ipc dead')) : Promise.resolve(r)
            }`,
          loader: 'js'
        }
      }
      if (a.path.endsWith('/event')) return { contents: `export const listen = async () => () => {}`, loader: 'js' }
      if (a.path.endsWith('/window')) return { contents: `export const getCurrentWindow = () => ({ label: 'main' })`, loader: 'js' }
      if (a.path.endsWith('chrome')) return { contents: `export const initWindowChrome = () => {}`, loader: 'js' }
      return { contents: `export const initGlassFallback = () => {}`, loader: 'js' }
    })
  }
}

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: OUT,
  plugins: [stub],
  tsconfig: path.join(REPO, 'app', 'tsconfig.json'),
  logLevel: 'silent'
})

globalThis.window = globalThis
globalThis.console.warn = () => {} // 심의 채널당 1회 경고는 이 하네스의 관심사가 아니다
globalThis.__calls = []
globalThis.__reply = () => ({ __unimplemented: true })
await import('file://' + OUT.replace(/\\/g, '/'))
const api = globalThis.api

const rows = []
async function probe(label, fn) {
  globalThis.__calls = []
  try {
    const v = await fn()
    rows.push({ label, outcome: 'resolve', value: Array.isArray(v) ? `array:${v.length}` : JSON.stringify(v)?.slice(0, 60), channel: globalThis.__calls[0] })
  } catch (e) {
    rows.push({ label, outcome: 'reject', name: e?.name, channel: e?.channel, msg: String(e?.message).slice(0, 60) })
  }
}

// A. 조회 — 안전값으로 resolve해야 한다(설정 화면이 통째로 죽지 않는 그 계약)
await probe('codexAuth.listAccounts', () => api.codexAuth.listAccounts())
await probe('codexAuth.accountsUsage', () => api.codexAuth.accountsUsage())
await probe('auth.listAccounts', () => api.auth.listAccounts())
await probe('auth.login', () => api.auth.login(false)) // 반환값에 error가 실리는 유일한 쓰기
// B. 쓰기 — reject해야 한다
await probe('codexAuth.login', () => api.codexAuth.login())
await probe('codexAuth.logout', () => api.codexAuth.logout('x@y.z'))
await probe('codexAuth.setDefaultAccount', () => api.codexAuth.setDefaultAccount('x@y.z'))
await probe('codexAuth.reorderAccounts', () => api.codexAuth.reorderAccounts(['x@y.z']))
await probe('auth.logout', () => api.auth.logout('x@y.z'))
await probe('auth.setDefaultAccount', () => api.auth.setDefaultAccount('x@y.z'))
await probe('auth.removeAccount', () => api.auth.removeAccount('x@y.z'))
await probe('auth.reorderAccounts', () => api.auth.reorderAccounts(['x@y.z']))
// C. invoke 자체가 던지는 판(셸이 죽었다)도 같은 결론이어야 한다
globalThis.__reply = () => 'THROW'
await probe('codexAuth.reorderAccounts(ipc dead)', () => api.codexAuth.reorderAccounts(['x@y.z']))
await probe('codexAuth.listAccounts(ipc dead)', () => api.codexAuth.listAccounts())

const reads = rows.filter((r) => /listAccounts|accountsUsage|auth\.login/.test(r.label))
const writes = rows.filter((r) => !reads.includes(r))
const verdict = {
  readsAllResolve: reads.every((r) => r.outcome === 'resolve'),
  writesAllReject: writes.every((r) => r.outcome === 'reject' && r.name === 'ShimUnavailableError' && !!r.channel)
}
console.log(JSON.stringify({ rows, verdict }, null, 2))
try { fs.unlinkSync(OUT) } catch { /* ignore */ }
process.exit(verdict.readsAllResolve && verdict.writesAllReject ? 0 : 1)
