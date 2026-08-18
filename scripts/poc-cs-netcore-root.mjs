/**
 * PoC — UnrealNetCore 합성 스크립트 프로젝트의 C# 서버 루트 결정 검증.
 *
 * 사고: UnrealNetCore의 게임 스크립트(<uproject>/Script/*.cs)는 규약상 곁에 csproj가 없다
 * (합성 csproj는 Intermediate/UnrealNetCore/Script/<Unit>/에만 산다). 기존 csRootFor는
 * csproj 조상이 없으면 UE 루트로 폴백해 솔루션 없는 Roslyn이 misc 문서로만 취급 — BCL만
 * 색이 붙고 플러그인 API·프로젝트 심볼은 무색이었다(ElmwoodOnline 실측). 수정: 유닛
 * csproj의 절대경로 <Compile Include>를 파싱해 파일→유닛 위임(단독 로드), UnrealSharp
 * 특례(UHT 글루·<UE루트>/Script 관리 솔루션)는 제거.
 *
 * 검증(가짜 프로젝트 트리 — 진짜 csRootFor/헬퍼를 esbuild 번들로 구동):
 *  1. Script/Spinner.cs → 유닛 폴더(정확 매치)
 *  2. Script/Sub/Deep.cs → 같은 유닛
 *  3. 편입 전 새 파일(Script/Other/New.cs) → 폴더 조상 워크로 같은 유닛
 *  4. Intermediate/…/ScriptProbeSource/Mover.cs → ScriptProbe 유닛
 *  5. unrealNetCoreScriptUnit(prewarm) — 직속·하위폴더 전용 배치 모두 Script 유닛
 *  6. 합성 프로젝트 미생성 → cwd 폴백(기존 동작)
 *  7. UnrealSharp UHT 글루 특례 제거 확인 → cwd 폴백
 *  8. UE 룰 파일(Build.cs) → 룰 전용 프로젝트 위임(기존 동작 유지)
 *  9. 일반 sln 참조 경로(기존 동작 유지)
 * 10. csprojWatchTargets — 루트 밖 소스 폴더 + HintPath/Analyzer DLL 드랍(플러그인
 *     Binaries/Managed로 접힘) + 소속 프로젝트 이름
 *
 * 실행: node scripts/poc-cs-netcore-root.mjs
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundle = path.join(root, '.poc-cs-root.mjs')

// ── 전자·부수 모듈 스텁 — 루트 결정 로직만 남긴다 ──
const stubs = {
  electron: `import os from 'node:os'
export const app = { getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir() }`,
  '../engine/versions': `import os from 'node:os'
export const APP_HOME = os.tmpdir()`,
  './install': `export const DOWNLOADS = []
export const install = async () => {}
export const installState = () => 'missing'
export const installedBin = () => null
export const uninstall = async () => {}
export const killHolders = () => {}`
}
const stubPlugin = {
  name: 'poc-stubs',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'poc-stub' }))
    build.onResolve({ filter: /^\.\.\/engine\/versions$/ }, (args) => ({ path: args.path, namespace: 'poc-stub' }))
    build.onResolve({ filter: /^\.\/install$/ }, (args) =>
      args.importer.replace(/\\/g, '/').endsWith('src/main/lsp/manager.ts') ? { path: args.path, namespace: 'poc-stub' } : undefined
    )
    build.onLoad({ filter: /.*/, namespace: 'poc-stub' }, (args) => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }))
  }
}

await esbuild.build({
  entryPoints: [path.join(root, 'src/main/lsp/manager.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: { '@shared': path.join(root, 'src/shared') },
  plugins: [stubPlugin],
  logLevel: 'silent'
})
const { csRootFor, unrealNetCoreUnitFor, unrealNetCoreScriptUnit, csprojWatchTargets } = await import(pathToFileURL(bundle).href)
fs.rmSync(bundle, { force: true })

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}
const eq = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-cs-root-'))
const mk = (rel, content = '') => {
  const abs = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}
// 합성 csproj — 실물(ElmwoodOnline)과 같은 골격: 절대경로 Compile include(슬래시 표기),
// HintPath DLL 참조, Analyzer DLL
const unitCsproj = (files, dlls = [], analyzers = []) =>
  `<Project Sdk="Microsoft.NET.Sdk">\n<ItemGroup>\n` +
  files.map((f) => `\t<Compile Include="${f.replace(/\\/g, '/')}" Link="${path.basename(f)}" />\n`).join('') +
  dlls.map((d) => `\t<Reference Include="X"><HintPath>${d.replace(/\\/g, '/')}</HintPath><Private>false</Private></Reference>\n`).join('') +
  analyzers.map((a) => `\t<Analyzer Include="${a.replace(/\\/g, '/')}" />\n`).join('') +
  `</ItemGroup>\n</Project>\n`

// ── proj1: UnrealNetCore 표준 배치 (Script 유닛 + ScriptProbe 유닛 + 플러그인 드랍) ──
const p1 = path.join(tmp, 'proj1')
mk('proj1/Game.uproject')
const spinner = mk('proj1/Script/Spinner.cs')
const deep = mk('proj1/Script/Sub/Deep.cs')
mk('proj1/Script/Other/.keep') // New.cs의 폴더만 실존(파일은 편입 전 상태를 흉내)
const mover = mk('proj1/Intermediate/UnrealNetCore/ScriptProbeSource/Mover.cs')
mk('proj1/Plugins/NetCorePlugin/NetCorePlugin.uplugin')
const dll1 = mk('proj1/Plugins/NetCorePlugin/Binaries/Managed/UnrealNetCore.Runtime/UnrealNetCore.Runtime.dll')
const dll2 = mk('proj1/Plugins/NetCorePlugin/Binaries/Managed/Unreal.Core/Unreal.Core.dll')
const gen = mk('proj1/Plugins/NetCorePlugin/Binaries/Managed/UnrealNetCore.SourceGenerators/UnrealNetCore.SourceGenerators.dll')
const unit1 = path.join(p1, 'Intermediate/UnrealNetCore/Script/Script')
mk('proj1/Intermediate/UnrealNetCore/Script/Script/Script.csproj', unitCsproj([spinner, deep], [dll1, dll2], [gen]))
const unitProbe = path.join(p1, 'Intermediate/UnrealNetCore/Script/ScriptProbe')
mk('proj1/Intermediate/UnrealNetCore/Script/ScriptProbe/ScriptProbe.csproj', unitCsproj([mover]))
// UE 루트의 UBT C++ 솔루션(csproj 참조 없음) — 이게 잘못 잡히면 안 된다
mk('proj1/Game.sln', 'Project("{X}") = "Game", "Intermediate\\ProjectFiles\\Game.vcxproj", "{Y}"\n')

check('1. Script 직속 파일 → 유닛 폴더', eq(csRootFor(spinner, p1), unit1), csRootFor(spinner, p1))
check('2. Script 하위폴더 파일 → 같은 유닛', eq(csRootFor(deep, p1), unit1), csRootFor(deep, p1))
check('3. 편입 전 새 파일 → 폴더 조상 워크로 같은 유닛', eq(csRootFor(path.join(p1, 'Script/Other/New.cs'), p1), unit1))
check('4. ScriptProbeSource → ScriptProbe 유닛', eq(csRootFor(mover, p1), unitProbe), csRootFor(mover, p1))
check('5a. prewarm: Script 소유 유닛', eq(unrealNetCoreScriptUnit(p1) ?? '', unit1), unrealNetCoreScriptUnit(p1))
check('5b. unrealNetCoreUnitFor 정확 매치', eq(unrealNetCoreUnitFor(p1, spinner) ?? '', unit1))

// ── proj2: Script에 직속 파일 없이 하위폴더만 — prewarm이 그래도 유닛을 찾아야 한다 ──
const p2 = path.join(tmp, 'proj2')
mk('proj2/Game.uproject')
const only = mk('proj2/Script/Gameplay/Only.cs')
const unit2 = path.join(p2, 'Intermediate/UnrealNetCore/Script/Script')
mk('proj2/Intermediate/UnrealNetCore/Script/Script/Script.csproj', unitCsproj([only]))
check('5c. prewarm: 하위폴더 전용 배치', eq(unrealNetCoreScriptUnit(p2) ?? '', unit2), unrealNetCoreScriptUnit(p2))

// ── proj3: 합성 프로젝트 미생성(클론 직후) → cwd 폴백 ──
const p3 = path.join(tmp, 'proj3')
mk('proj3/Game.uproject')
const orphan = mk('proj3/Script/Foo.cs')
check('6. 합성 미생성 → cwd 폴백', eq(csRootFor(orphan, p3), p3), csRootFor(orphan, p3))

// ── proj4: UnrealSharp UHT 글루 특례가 제거됐는지 — 옛 위임 목적지가 있어도 cwd 폴백 ──
const p4 = path.join(tmp, 'proj4')
mk('proj4/Game.uproject')
const glue = mk('proj4/Plugins/P/Intermediate/UnrealSharp/UHT/G.cs')
mk('proj4/Plugins/P/Managed/UnrealSharp/UnrealSharp/UnrealSharp.csproj', '<Project/>')
check('7. UnrealSharp UHT 특례 제거 → cwd 폴백', eq(csRootFor(glue, p4), p4), csRootFor(glue, p4))

// ── proj5: UE 룰 파일 → 룰 전용 프로젝트 위임(기존 동작 유지) ──
const p5 = path.join(tmp, 'proj5')
mk('proj5/Game.uproject')
const rules = path.join(p5, 'Intermediate/Build/BuildRulesProjects/GameRules')
mk('proj5/Intermediate/Build/BuildRulesProjects/GameRules/GameRules.csproj', '<Project/>')
const buildCs = mk('proj5/Source/Game/Game.Build.cs')
check('8. Build.cs → 룰 프로젝트(기존 유지)', eq(csRootFor(buildCs, p5), rules), csRootFor(buildCs, p5))

// ── proj6: 일반 sln 참조 경로(기존 동작 유지) ──
const p6 = path.join(tmp, 'proj6')
const appCs = mk('proj6/App/Program.cs')
mk('proj6/App/App.csproj', '<Project/>')
mk('proj6/My.sln', 'Project("{X}") = "App", "App\\App.csproj", "{Y}"\n')
check('9. 일반 sln 참조 → 솔루션 폴더(기존 유지)', eq(csRootFor(appCs, p6), p6), csRootFor(appCs, p6))

// ── 10: csprojWatchTargets — 단독 로드 루트의 감시 대상 ──
const t1 = csprojWatchTargets(unit1)
const drop = path.join(p1, 'Plugins/NetCorePlugin/Binaries/Managed')
check(
  '10a. 소스 폴더: Script + Script/Sub',
  t1.srcDirs.length === 2 && t1.srcDirs.some((d) => eq(d, path.join(p1, 'Script'))) && t1.srcDirs.some((d) => eq(d, path.join(p1, 'Script/Sub'))),
  t1.srcDirs
)
check('10b. DLL 드랍: 플러그인 Binaries/Managed 하나로 접힘', t1.dllDrops.length === 1 && eq(t1.dllDrops[0], drop), t1.dllDrops)
check('10c. 소속 프로젝트 이름', t1.ownNames.size === 1 && t1.ownNames.has('script'), [...t1.ownNames])

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed}개 실패` : '\n전부 통과')
process.exit(failed ? 1 : 0)
