// CI 릴리즈 전용: SignPath에서 서명받은 설치기를 dist/에 되돌려 넣고,
// 서명으로 바뀐 파일 해시에 맞춰 blockmap과 latest.yml을 재생성한다.
// 이 단계를 빼먹으면 electron-updater가 sha512 불일치로 업데이트를 전부 거부한다.
// 사용: node scripts/patch-latest-yml.cjs <signed-dir> <dist-dir>
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const yaml = require('js-yaml')

const signedDir = process.argv[2] || 'signed'
const distDir = process.argv[3] || 'dist'

const latestPath = path.join(distDir, 'latest.yml')
const latest = yaml.load(fs.readFileSync(latestPath, 'utf8'))
const exeName = latest.path
const signedExe = path.join(signedDir, exeName)
if (!fs.existsSync(signedExe)) {
  console.error(`signed installer not found: ${signedExe}`)
  process.exit(1)
}
const distExe = path.join(distDir, exeName)
fs.copyFileSync(signedExe, distExe)

const appBuilder = require('app-builder-bin').appBuilderPath
const out = JSON.parse(
  execFileSync(appBuilder, ['blockmap', '--input', distExe, '--output', `${distExe}.blockmap`], {
    encoding: 'utf8'
  })
)

latest.sha512 = out.sha512
for (const f of latest.files || []) {
  if (f.url === exeName) {
    f.sha512 = out.sha512
    f.size = out.size
  }
}
fs.writeFileSync(latestPath, yaml.dump(latest, { lineWidth: -1 }))
console.log(`patched ${latestPath}: size=${out.size} sha512=${out.sha512}`)
