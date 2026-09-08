// Fast regression checks: node scripts/test-blazor.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import hljs from 'highlight.js/lib/common'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const result = await build({
  stdin: {
    contents: "export * from './src/shared/fileNesting'; export * from './src/shared/lspSemantic'; export * from './src/shared/razorLanguage'",
    resolveDir: root, loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'cjs', write: false
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, mod, mod.exports)
const { nestFileRows, razorParentName, extendSemanticLegend, razor } = mod.exports
const file = (name, dir = false) => ({ name, dir })
const entries = [
  file('Pages', true), file('A.razor'), file('A.razor.cs'), file('A.razor.css'),
  file('A.razor.js'), file('A.razor.ts'), file('A.cs'), file('B.razor.cs'),
  file('Index.cshtml'), file('Index.cshtml.cs')
]
const collapsed = nestFileRows(entries, new Set())
assert.deepEqual(collapsed.map((r) => r.entry.name), ['Pages', 'A.razor', 'A.cs', 'B.razor.cs', 'Index.cshtml'])
assert.equal(collapsed[1].children.length, 4)
const expanded = nestFileRows(entries, new Set(['A.razor', 'Index.cshtml']))
assert.deepEqual(expanded.map((r) => r.entry.name), entries.map((e) => e.name))
assert.equal(expanded[2].parent, 'A.razor')
assert.equal(expanded[2].entry, entries[2], 'file operations retain the real entry')
assert.equal(razorParentName('Pages/A.razor.js'), 'Pages/A.razor')
assert.equal(razorParentName('A.razor.backup'), null)
assert.equal(nestFileRows(entries.filter((e) => e.name !== 'A.razor'), new Set()).length, 8, 'removed/hidden parents leave visible companions')
assert.equal(nestFileRows([file('A.razor', true), file('A.razor.cs')], new Set()).length, 2)
assert.equal(nestFileRows([file('A.RAZOR'), file('A.RAZOR.CS')], new Set()).length, 1)
const host = { types: ['class', 'property'], mods: ['static'] }
const registration = (types, mods = host.mods) => ({ registrations: [
  { method: 'textDocument/semanticTokens', registerOptions: { legend: { tokenTypes: types, tokenModifiers: mods } } }
] })
const merged = extendSemanticLegend(host, registration([...host.types, 'razorDirective']))
assert.deepEqual(merged.types, ['class', 'property', 'razorDirective'])
assert.equal(extendSemanticLegend(host, registration(['property', 'class'])), host, 'never remap C# token indices')
assert.equal(extendSemanticLegend(host, registration(host.types, ['deprecated'])), host)

hljs.registerLanguage('razor', razor)
const source = fs.readFileSync(path.join(root, 'scripts/fixtures/blazor/Counter.razor'), 'utf8')
const highlight = (text) => {
  const result = hljs.highlight(text, { language: 'razor' })
  assert.equal(result.illegal, false)
  const roundtrip = result.value.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
  assert.equal(roundtrip, text, 'highlighting must preserve the source')
  return result.value
}
const html = highlight(source)
assert.match(html, /hljs-keyword[^>]*>@page/)
assert.match(html, /hljs-keyword[^>]*>private/)
assert.match(html, /hljs-built_in[^>]*>string/)
assert.match(html, /hljs-name[^>]*>h1/)
assert.match(highlight('@* <p>@Ignored</p> *@'), /hljs-comment/)
assert.match(highlight('<p>@(Count + 1)</p>'), /hljs-number[^>]*>1/)
assert.match(highlight('@code { void Go() { if (true) { Go(); } } }\n<p>after</p>'), /hljs-name[^>]*>p/)
assert.match(highlight('@code { class Inner { public string Text => "}"; } }\n<p>after</p>'), /hljs-name[^>]*>p/)
assert.match(highlight('<style>@media (min-width: 10px) { p { color: red; } }</style>'), /language-css/)
assert.match(highlight('<script>const email = "a@b.test";</script>'), /language-javascript/)
highlight('@@page\n<button @bind-Value="Count" @onclick="Increment">Go</button>')
highlight('@foreach (var item in Items) {\n  <p>@item.Name</p>\n}')
console.log('Blazor: file nesting, semantic legend compatibility and Razor highlighting passed.')
