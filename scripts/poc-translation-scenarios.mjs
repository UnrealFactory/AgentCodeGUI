import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sleep } from '../bench/lib.mjs'

export async function testTranslation({ evaluate, until, clickText, cdp, home, selected, claude, write, frames }) {
  const original = '공식 점수는 6.1점으로 올랐습니다.\n기존 균형과 보완 내용을 유지합니다.'
  const english = 'The official score increased to 6.1.\nThe existing balance and improvements are preserved.'
  const french = 'Le score officiel est passé à 6,1.\nL’équilibre existant et les améliorations sont préservés.'
  const clickAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const select = async (selector, value) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await until(`!!document.querySelector(".select-menu-popover")`)
    const point = await evaluate(`(()=>{const item=[...document.querySelectorAll(".select-menu-option")].find(el=>el.dataset.value===${JSON.stringify(value)});item.scrollIntoView({block:"nearest"});const r=item.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await cdp.send("Input.dispatchMouseEvent", {type:"mousePressed",...point,button:"left",buttons:1,clickCount:1})
    await cdp.send("Input.dispatchMouseEvent", {type:"mouseReleased",...point,button:"left",clickCount:1})
    await until(`!document.querySelector(".select-menu-popover")`)
  }
  const reply = (text, afterMs = 0) => frames([
    { emit: { method: 'item/completed', params: { threadId: 'git-thread', item: { type: 'agentMessage', phase: 'final_answer', text } } }, afterMs },
    { emit: { method: 'turn/completed', params: { threadId: 'git-thread', turn: { status: 'completed' } } } }
  ])
  const mount = async (text, session = { panelId: 'translation-board::0' }) => {
    await evaluate(`(async()=>{
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedText=text}}});
      const source=await (await fetch('/src/components/Chat.tsx')).text();
      const {default:React}=await import(source.match(/from "([^"]*react[.]js[^"]*)"/)[1]);
      const {SelectionToolbar}=await import('/src/components/Chat.tsx');
      function Fixture(){const a=React.useRef(null),b=React.useRef(null);return React.createElement('div',{style:{padding:40,color:'white'}},
        React.createElement('div',{ref:a,style:{width:700}},React.createElement('p',{id:'selection-source',style:{whiteSpace:'pre-wrap',fontSize:16,lineHeight:2,userSelect:'text'}},${JSON.stringify(text)})),
        React.createElement('div',{ref:b},React.createElement('p',null,'UNSELECTED PANEL CONTENT')),
        React.createElement(SelectionToolbar,{scrollRef:a,session:${JSON.stringify(session)},onElaborate:text=>{window.__elaborated=text}}),
        React.createElement(SelectionToolbar,{scrollRef:b,session:{panelId:'translation-board::1'},onElaborate:()=>{throw Error('Wrong panel')}}));}
      window.__gitRoot.render(React.createElement(Fixture));
    })()`)
    await until(`document.querySelector('#selection-source')?.textContent===${JSON.stringify(text)}`)
  }
  const drag = async () => {
    const b = await evaluate(`(()=>{const node=document.querySelector('#selection-source').firstChild;const r=document.createRange();r.setStart(node,0);r.setEnd(node,1);const a=r.getBoundingClientRect();r.setStart(node,node.length-1);r.setEnd(node,node.length);const b=r.getBoundingClientRect();return {x:a.left+1,y:a.top+a.height/2,endX:b.right+2,endY:b.top+b.height/2}})()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.endX, y: b.endY, button: 'left', buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.endX, y: b.endY, button: 'left', clickCount: 1 })
    await until(`document.querySelectorAll('.sel-bar').length===1`)
  }
  const shot = async name => cdp.send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(path.join(home, name + '.png'), Buffer.from(r.data, 'base64')))
  const turn = () => fs.readFileSync(path.join(home, 'codex-input.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(v => v.method === 'turn/start').at(-1).params
  const thread = () => fs.readFileSync(path.join(home, 'codex-input.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(v => v.method === 'thread/start').at(-1).params
  const modelControl = '.translation-provider-setting[data-engine="codex"] [role="combobox"]'
  const effortControl = '[aria-label="OpenAI translation effort"]'
  const speedControl = '[aria-label="OpenAI translation speed"]'
  await evaluate(`(async()=>{const source=await (await fetch('/src/components/Chat.tsx')).text();const {default:React}=await import(source.match(/from "([^"]*react[.]js[^"]*)"/)[1]);const {SettingsModal}=await import('/src/components/Settings.tsx');window.__gitRoot.render(React.createElement(SettingsModal,{initialView:'translation',onClose:()=>{}}));})()`)
  await until(`document.querySelector('.translation-settings fieldset')?.disabled===false`)
  assert(await evaluate(`[...document.querySelectorAll('.set-ni')].some(b=>b.textContent.trim()==='Translation')`))
  await select('.translation-language-setting [role="combobox"]', 'fr')
  await select('.translation-provider-setting[data-engine="claude"] [role="combobox"]', 'haiku')
  await select(effortControl, 'high')
  await select(speedControl, 'priority')
  assert(await evaluate(`(()=>{const labels=document.querySelector('.translation-setting-fields').children;return labels[1].getBoundingClientRect().left>labels[0].getBoundingClientRect().right})()`), 'Model and effort fields should not overlap')
  await shot('translation-settings')
  await sleep(350)
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'ui-prefs.json'), 'utf8'))['translation.settings']
  assert.equal(saved.targetLanguage, 'fr'); assert.equal(saved.models.claude.model, 'haiku'); assert.equal(saved.models.codex.effort, 'high')
  assert.equal(saved.models.codex.codexTier, 'priority')
  console.log('PASS: Translation settings tab saves target, per-provider model/effort and GPT speed')

  // Open every dropdown: collapsed controls alone missed the native white-menu regression.
  const escape = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }
  assert.equal(await evaluate(`document.querySelectorAll('.translation-settings [role="combobox"]').length`), 6)
  for (let i = 0; i < 6; i++) {
    await evaluate(`document.querySelectorAll('.translation-settings [role="combobox"]')[${i}].click()`)
    await until(`!!document.querySelector('.select-menu-popover')`)
    assert(await evaluate(`[...document.querySelectorAll('.select-menu-option')].every(el=>el.textContent.trim()&&el.getBoundingClientRect().height>0)`))
    assert.equal(await evaluate(`document.querySelectorAll('.translation-settings [title], .select-menu-popover [title]').length`), 0)
    await shot(`translation-dropdown-${i}`)
    await escape()
    await until(`!document.querySelector('.select-menu-popover')`)
    assert(await evaluate(`!!document.querySelector('.translation-settings')`), 'Escape closes only the menu')
  }
  console.log('PASS: all six settings menus show readable options without native hover tooltips and close independently')
  const key = async (name, code) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, windowsVirtualKeyCode: code })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, windowsVirtualKeyCode: code })
  }
  await evaluate(`document.querySelector('.translation-language-setting [role="combobox"]').click()`)
  await until(`!!document.querySelector('.select-menu-popover')`)
  await key('Home', 36); await key('ArrowDown', 40); await key('Enter', 13)
  await until(`document.querySelector('.translation-language-setting [role="combobox"]').value==='ko'`)
  assert(await evaluate(`!!document.querySelector('.translation-settings')`))
  await select('.translation-language-setting [role="combobox"]', 'fr')
  console.log('PASS: keyboard navigation selects and saves an option without closing Settings')

  reply(french)
  await mount(original); await drag()
  assert.equal(await evaluate('window.getSelection().toString().trim()'), original)
  await clickText('.sel-act', 'Copy'); assert.equal(await evaluate('window.__copiedText'), original)
  await clickText('.sel-act', 'Tell me more'); assert.equal(await evaluate('window.__elaborated'), original)
  await drag(); await clickText('.sel-act', 'Translate')
  await until(`document.querySelector('.translation-output')?.textContent===${JSON.stringify(french)}`)
  assert(await evaluate(`(()=>{const el=document.querySelector('.translation-popover');return getComputedStyle(el).position==='fixed'&&el.getBoundingClientRect().width<600})()`), 'Translation must be a compact floating card')
  assert.equal(await evaluate(`document.querySelectorAll('.ai-request-picker').length`), 0)
  assert.equal(await evaluate(`document.querySelectorAll('.translation-session, [aria-label="Translate again"]').length`), 0)
  assert(!(await evaluate(`document.querySelector('.translation-popover').textContent`)).includes(selected))
  assert(path.basename(fs.readFileSync(path.join(home, 'codex-home.txt'), 'utf8').trim()).startsWith('selected_openai.test-'))
  assert.equal(await evaluate(`document.querySelector('.translation-controls [role="combobox"]').value`), 'fr')
  assert.equal(turn().model, 'gpt-5.6-terra'); assert.equal(turn().effort, 'high')
  assert.equal(thread().serviceTier, 'priority'); assert.equal(turn().serviceTier, 'priority')
  assert.equal(await evaluate(`document.querySelector('.translation-speed').textContent`), 'Fast')
  assert.equal(await evaluate(`document.querySelectorAll('.translation-popover [title]').length`), 0)
  assert(turn().input[0].text.includes('"targetLanguage":"French"'))
  assert(turn().input[0].text.includes(JSON.stringify(original)) && !turn().input[0].text.includes('UNSELECTED'))
  await clickText('.translation-copy', 'Copy'); assert.equal(await evaluate('window.__copiedText'), french)
  assert.equal(await evaluate(`document.querySelector('#selection-source').textContent`), original)
  await shot('translation-popover')
  await evaluate(`document.querySelector('.translation-controls [role="combobox"]').click()`)
  await until(`!!document.querySelector('.select-menu-popover')`)
  await shot('translation-popup-language-menu')
  await escape()
  assert(await evaluate(`!!document.querySelector('.translation-popover')`), 'Escape should not close the translation when its menu is open')
  console.log('PASS: one-click translation uses the source panel account, not the default; original text and copy work')

  await evaluate(`document.querySelector('[aria-label="Translation settings"]').click()`)
  await until(`document.querySelector('.translation-settings fieldset')?.disabled===false`)
  await select('.translation-language-setting [role="combobox"]', 'en')
  await select(modelControl, 'gpt-5.6-sol')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(speedControl)}).value`), 'priority')
  await select(effortControl, 'low')
  await select(speedControl, 'ultrafast')
  await shot('translation-settings-ultrafast')
  reply(english)
  await evaluate(`[...document.querySelectorAll('.set-modal .set-x')].at(-1).click()`)
  await until(`document.querySelector('.translation-output')?.textContent===${JSON.stringify(english)}`)
  assert.equal(turn().model, 'gpt-5.6-sol'); assert.equal(turn().effort, 'low')
  assert.equal(thread().serviceTier, 'ultrafast'); assert.equal(turn().serviceTier, 'ultrafast')
  assert.equal(await evaluate(`document.querySelector('.translation-speed').textContent`), 'Ultrafast')
  console.log('PASS: Fast and Ultrafast reach native thread/start and turn/start and appear in the result')

  await evaluate(`document.querySelector('[aria-label="Translation settings"]').click()`)
  await until(`document.querySelector('.translation-settings fieldset')?.disabled===false`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(speedControl)}).value`), 'ultrafast')
  await select(modelControl, 'gpt-5.6-terra')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(speedControl)}).value`), '')
  await select(speedControl, 'priority')
  await select(modelControl, 'gpt-5.6-luna')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(speedControl)}).value`), '')
  await evaluate(`document.querySelector(${JSON.stringify(speedControl)}).click()`)
  await until(`!!document.querySelector('.select-menu-popover')`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.select-menu-option')].map(el=>el.textContent.trim())`), ['Standard'])
  await escape()
  reply('Standard speed translation')
  await evaluate(`[...document.querySelectorAll('.set-modal .set-x')].at(-1).click()`)
  await until(`document.querySelector('.translation-output')?.textContent==='Standard speed translation'`)
  assert.equal(thread().serviceTier, undefined); assert.equal(turn().serviceTier, undefined)
  assert.equal(await evaluate(`document.querySelectorAll('.translation-speed').length`), 0)
  console.log('PASS: changing to models without the chosen tier clears the saved speed; Standard omits serviceTier')
  reply('公式スコアは6.1になりました。')
  await select('.translation-controls [role="combobox"]', 'ja')
  await until(`document.querySelector('.translation-output')?.textContent==='公式スコアは6.1になりました。'`)
  assert(turn().input[0].text.includes('"targetLanguage":"Japanese"'))
  console.log('PASS: gear opens Translation settings directly; changed settings and target language retranslate')

  write('claude.jsonl', [{ emit: { type: 'result', result: english, is_error: false } }, { exit: 0 }].map(JSON.stringify).join('\n'))
  await mount(original, { chatId: 'translation-claude' }); await drag(); await clickText('.sel-act', 'Translate')
  await until(`document.querySelector('.translation-output')?.textContent===${JSON.stringify(english)}`)
  assert(!(await evaluate(`document.querySelector('.translation-popover').textContent`)).includes(claude))
  assert(fs.readFileSync(path.join(home, 'claude-argv.json'), 'utf8').includes('haiku'))
  write('claude.jsonl', [{ emit: { type: 'result', subtype: 'error_during_execution', result: 'Synthetic translation limit', is_error: true } }, { exit: 0 }].map(JSON.stringify).join('\n'))
  await select('.translation-controls [role="combobox"]', 'ko')
  await until(`document.querySelector('.translation-error')?.textContent.includes('Synthetic translation limit')`)
  assert.equal(await evaluate(`document.querySelector('.translation-copy').disabled`), true)
  const rejected = request => evaluate(`(async()=>{const {translateText}=await import('/src/api/translation.ts');const {getTranslationSettings}=await import('/src/lib/translationSettings.ts');return translateText({models:getTranslationSettings().models,session:{chatId:'translation-openai'},...${JSON.stringify(request)}}).then(()=>false,()=>true)})()`)
  assert(await rejected({ text: '', targetLanguage: 'ko' })); assert(await rejected({ text: 'x'.repeat(50001), targetLanguage: 'ko' }))
  assert(await rejected({ text: 'Text', targetLanguage: 'bad' })); assert(await rejected({ text: 'Text', targetLanguage: 'en', session: { chatId: 'missing-chat' } }))
  console.log('PASS: detached chat address uses its Claude account/preset; missing sessions and generation errors fail without account fallback')

  reply('API session translation')
  await mount(original, { chatId: 'translation-api' }); await drag(); await clickText('.sel-act', 'Translate')
  await until(`document.querySelector('.translation-output')?.textContent==='API session translation'`)
  assert.equal(fs.readFileSync(path.join(home, 'codex-home.txt'), 'utf8').trim(), path.join(home, 'codex/api-key'))
  assert(!(await evaluate(`document.querySelector('.translation-popover').textContent`)).includes('synthetic-openai-key'))
  console.log('PASS: API sessions keep their API billing instead of consuming a subscription account')

  const inside = await evaluate(`(()=>{const r=document.querySelector('.translation-output').getBoundingClientRect();return {x:r.left+20,y:r.top+20}})()`)
  await clickAt(inside.x, inside.y)
  assert(await evaluate(`!!document.querySelector('.translation-popover')`), 'Clicking the translation text keeps the card open')
  await evaluate(`document.querySelector('.translation-controls [role="combobox"]').click()`)
  await until(`!!document.querySelector('.select-menu-popover')`)
  await clickAt(20, 20)
  await until(`!document.querySelector('.translation-popover, .select-menu-popover')`)
  console.log('PASS: clicks inside preserve the translation; clicking outside closes the card and its language menu')

  await mount(original); await drag()
  await evaluate(`document.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:innerWidth-3,clientY:innerHeight-3}))`)
  reply('Late result', 700)
  await clickText('.sel-act', 'Translate'); await until(`!!document.querySelector('.translation-state')`); await sleep(60)
  assert(await evaluate(`(()=>{const r=document.querySelector('.translation-popover').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`))
  await clickAt(20, 20); await sleep(1000)
  assert.equal(await evaluate(`document.querySelectorAll('.translation-popover').length`), 0)
  assert.equal(await evaluate(`document.querySelector('#selection-source').textContent`), original)
  console.log('PASS: result stays in the viewport; closing ignores late responses')
}
