const fs = require('fs')
const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
const names = process.argv.slice(3)
for (const n of names) {
  const re = new RegExp('^(export )?declare type ' + n + '\\b')
  const i = lines.findIndex((l) => re.test(l))
  if (i < 0) { console.log('### ' + n + ' NOT FOUND'); continue }
  let st = i
  while (st > 0 && (lines[st - 1].trim().startsWith('*') || lines[st - 1].trim().startsWith('/**'))) st--
  let depth = 0, j = i, started = false
  for (; j < lines.length; j++) {
    for (const ch of lines[j]) { if (ch === '{') { depth++; started = true } else if (ch === '}') depth-- }
    if (started && depth <= 0) break
    if (!started && lines[j].trimEnd().endsWith(';')) break
  }
  console.log('### ' + n + '  (' + file + ':' + (i + 1) + ')')
  console.log(lines.slice(st, j + 1).join('\n'))
  console.log()
}
