#!/usr/bin/env node
// M3 R1 크리틱 — claude.exe 번들에서 workflow_agent emitter 키 집합을 **독립 추출**한다.
// 빌더 보고(docs/m3-report-r1.md §5)의 "effort 없음 · fallbackModel 있음"을 대조하는 것이 목적.
//
// 1차 시도(넓은 창)는 이웃한 **에이전트 정의** 코드(`we?.effort`·`bashCommandClamp`)를 같이 긁어
// `effort=true`라는 거짓 양성을 냈다. 그래서 여기서는 `type:"workflow_agent"`를 품은
// **객체 리터럴 하나**를 중괄호 균형으로 잘라내고, 그 객체의 **최상위 키만** 센다.
//
// 읽기 전용 — 사용자 실홈을 건드리지 않는다.
import fs from 'node:fs';
import path from 'node:path';

const CLI = process.argv[2] ??
  'C:/Users/User/.agentcodegui/engines/0.3.239/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe';
const OUT = process.argv[3] ?? 'bench/results/critic-m3-wfkeys.json';

const buf = fs.readFileSync(CLI);
const size = buf.length;

/** `type:"workflow_agent"` (따옴표/공백 변형 허용) 전수 위치 */
function findTypedSites() {
  const sites = [];
  const needle = Buffer.from('workflow_agent', 'latin1');
  let i = 0;
  for (;;) {
    const at = buf.indexOf(needle, i);
    if (at < 0) break;
    i = at + 1;
    // 바로 앞이 type:" 인가
    const pre = buf.toString('latin1', Math.max(0, at - 24), at);
    if (/type\s*:\s*["']$/.test(pre)) sites.push(at);
  }
  return sites;
}

/** at 위치를 감싸는 **가장 안쪽** 객체 리터럴의 [start,end] (중괄호 균형, 문자열 인지) */
function enclosingObject(at, maxBack = 4000, maxFwd = 6000) {
  const from = Math.max(0, at - maxBack);
  const to = Math.min(size, at + maxFwd);
  const t = buf.toString('latin1', from, to);
  const rel = at - from;

  // 뒤로 가며 깊이 0에서 여는 `{` 찾기
  let depth = 0, start = -1;
  for (let p = rel; p >= 0; p--) {
    const c = t[p];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) { start = p; break; }
      depth--;
    }
  }
  if (start < 0) return null;

  // 앞으로 가며 짝 `}` 찾기 (문자열 리터럴 건너뜀)
  let d = 0, end = -1, q = null;
  for (let p = start; p < t.length; p++) {
    const c = t[p];
    if (q) {
      if (c === '\\') { p++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) { end = p; break; } }
  }
  if (end < 0) return null;
  return { start: from + start, end: from + end + 1, text: t.slice(start, end + 1) };
}

/** 객체 리터럴 문자열의 **최상위 키**만 (깊이 1, 문자열/괄호 인지) */
function topLevelKeys(src) {
  const keys = [];
  let d = 0, q = null, br = 0, par = 0;
  let tokStart = -1;
  for (let p = 0; p < src.length; p++) {
    const c = src[p];
    if (q) { if (c === '\\') { p++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') {
      if (d === 1 && br === 0 && par === 0 && tokStart < 0) tokStart = p;
      q = c; continue;
    }
    if (c === '{') { d++; continue; }
    if (c === '}') { d--; continue; }
    if (c === '[') { br++; continue; }
    if (c === ']') { br--; continue; }
    if (c === '(') { par++; continue; }
    if (c === ')') { par--; continue; }
    if (d !== 1 || br !== 0 || par !== 0) continue;
    if (c === ',') { tokStart = -1; continue; }
    if (c === ':') {
      if (tokStart >= 0) {
        const raw = src.slice(tokStart, p).trim().replace(/^["'`]|["'`]$/g, '');
        if (/^[A-Za-z_$][\w$]*$/.test(raw)) keys.push(raw);
      }
      tokStart = -1;
      // 값 부분은 건너뛴다(다음 콤마까지는 위 루프가 깊이로 처리)
      continue;
    }
    if (tokStart < 0 && /[A-Za-z_$]/.test(c)) tokStart = p;
  }
  return [...new Set(keys)];
}

const sites = findTypedSites();
const objs = [];
const seen = new Set();
for (const at of sites) {
  const o = enclosingObject(at);
  if (!o) continue;
  const id = `${o.start}:${o.end}`;
  if (seen.has(id)) continue;
  seen.add(id);
  objs.push({ at, ...o, keys: topLevelKeys(o.text) });
}

const union = new Set();
for (const o of objs) for (const k of o.keys) union.add(k);

const EFFORTISH = ['effort', 'reasoningEffort', 'reasoning_effort', 'effortLevel', 'thinkingEffort'];
const effortKeys = [...union].filter((k) => EFFORTISH.includes(k));

// effort 문자열이 emitter **객체 본문 안**에 아예 등장하는가(키가 아니어도)
const effortInBody = objs
  .map((o, i) => {
    const idx = o.text.indexOf('effort');
    return idx < 0 ? null : { i, at: o.at, snippet: o.text.slice(Math.max(0, idx - 100), idx + 140) };
  })
  .filter(Boolean);

const out = {
  tool: 'critic-m3-wfkeys',
  method: 'brace-matched enclosing object of `type:"workflow_agent"`, top-level keys only',
  cli: CLI,
  cliBytes: size,
  typedSites: sites.length,
  distinctEmitterObjects: objs.length,
  emitters: objs.map((o) => ({ at: o.at, bytes: o.end - o.start, keys: o.keys })),
  unionKeys: [...union].sort(),
  effortKeysFound: effortKeys,
  hasEffort: effortKeys.length > 0,
  hasFallbackModel: union.has('fallbackModel'),
  hasModel: union.has('model'),
  effortStringInsideEmitterBody: effortInBody,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log(`type:"workflow_agent" 사이트 = ${sites.length}`);
console.log(`서로 다른 emitter 객체      = ${objs.length}`);
console.log(`최상위 키 합집합            = ${union.size}개`);
console.log(`  effort 계열               = ${JSON.stringify(effortKeys)}  → hasEffort=${out.hasEffort}`);
console.log(`  fallbackModel             = ${out.hasFallbackModel}`);
console.log(`  model                     = ${out.hasModel}`);
console.log(`emitter 본문에 'effort' 문자열 = ${effortInBody.length}건`);
console.log(`\n합집합:\n  ${[...union].sort().join(' · ')}`);
console.log(`\n→ ${OUT}`);
