// ccg-lsp의 SHA-1이 Node crypto와 **바이트 동일**한지 교차 확인 (semcache 공유의 전제).
import crypto from 'node:crypto'
const h = crypto.createHash('sha1')
h.update('v1\u0000ts\u0000c:\u005cx.ts\u0000')
h.update('hello')
console.log('node key   ', h.digest('hex'))
console.log('node abc   ', crypto.createHash('sha1').update('abc').digest('hex'))
const root = 'C:\u005cCode\u005cAgentCodeGUI'
console.log('node bucket', crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16))
