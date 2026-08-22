// Scan the (unstripped) Claude Code native binary for source-string context.
//   node .bingrep.cjs <needle> [maxHits] [window]
const fs = require('fs')
const BIN = process.env.CCG_CLI || 'C:/Users/User/.agentcodegui/engines/0.3.239/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
const needle = process.argv[2]
const maxHits = Number(process.argv[3] ?? 3)
const win = Number(process.argv[4] ?? 500)
const fd = fs.openSync(BIN, 'r')
const size = fs.fstatSync(fd).size
const CH = 8 * 1024 * 1024
const buf = Buffer.alloc(CH)
let pos = 0, carry = '', hits = 0
while (pos < size && hits < maxHits) {
  const n = fs.readSync(fd, buf, 0, Math.min(CH, size - pos), pos)
  const s = carry + buf.subarray(0, n).toString('latin1')
  let i = 0
  while ((i = s.indexOf(needle, i)) >= 0 && hits < maxHits) {
    console.log('--- @' + (pos + i))
    console.log(s.slice(Math.max(0, i - win), i + win).replace(/[^\x20-\x7e\n]/g, '.'))
    hits++
    i += needle.length
  }
  carry = s.slice(-1024)
  pos += n
}
fs.closeSync(fd)
if (!hits) console.log('NOT FOUND')
