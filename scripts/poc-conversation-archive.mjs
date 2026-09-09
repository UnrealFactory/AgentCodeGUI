// End-to-end archive check using a real Tauri window, an isolated app home and
// fake engine protocol frames. No real accounts, requests, or workspace edits.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  connectMainPage,
  Cdp,
  cdpTargets,
  killTree,
  quietHome,
  REPO,
  sleep,
} from "../bench/lib.mjs";

const exe = path.resolve(
  process.argv.find((a) => a.startsWith("--exe="))?.slice(6) ||
    "target/debug/agentcodegui.exe",
);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-archive-native-"));
const work = path.join(home, "work");
const port = 19491;
const write = (name, value) => {
  const p = path.join(home, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    typeof value === "string" ? value : JSON.stringify(value),
  );
};
quietHome(home);
fs.mkdirSync(work);
const artifact = path.join(work, "result.html");
const before = "<!doctype html>\r\n<h1>Before archive edit</h1>\r\n";
const after =
  '<!doctype html>\n<html lang="ko"><h1>보관된 결과물 🧪</h1></html>\n';
const formattedReply = [
  "대화와 파일 변경을 확인했습니다.",
  "",
  "## 저장 결과",
  "",
  "- `desktop.ini`: **Windows 설정 파일**",
  "- 대화 기록을 세션별로 보관합니다.",
  "  - 파일 변경 전후도 확인할 수 있습니다.",
  "",
  "3. 첫 번째 확인",
  "4. 두 번째 확인",
  "",
  "> 기록된 파일의 원본을 그대로 보관합니다.",
  "",
  "| 파일 | 상태 |",
  "| :--- | ---: |",
  "| result.html | 완료 |",
  "",
  "```typescript",
  "const archived = true;",
  `const longLine = "${"x".repeat(220)}";`,
  "```",
  "",
  "생성된 HTML과 도구 출력 원문이 기록에 보관됩니다.",
].join("\n");
fs.writeFileSync(artifact, before);
const longOutput =
  "도구 출력 원문 — UTF-8 🧪\n".repeat(12000) + "ARCHIVE-OUTPUT-END";
const engine =
  "engines/fake/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
write(engine, "");
fs.copyFileSync(
  path.join(REPO, "target/release/ccg-fakecli.exe"),
  path.join(home, engine),
);
write("config.json", { activeVersion: "fake" });
write("engines/fake/node_modules/@anthropic-ai/claude-agent-sdk/package.json", {
  name: "@anthropic-ai/claude-agent-sdk",
  version: "fake",
});
execFileSync(
  path.join(REPO, "target/debug/ccg-auth-probe.exe"),
  ["seed", "archive@example.test"],
  {
    windowsHide: true,
    env: { ...process.env, CCG_HOME: home, CCG_NO_NET: "1" },
    stdio: "pipe",
  },
);
write("ui-prefs.json", {
  "ui.lang": "ko",
  "workspace.mode": "multi",
  "tray.closeToTray": false,
  "whatsnew.seenVersion": fs
    .readFileSync(path.join(REPO, "Cargo.toml"), "utf8")
    .match(/^version = "([^"]+)"/m)[1],
});
write("profile.json", { nickname: "Archive verification" });
write("multi-agent/index.json", {
  version: 2,
  order: ["archive-board"],
  activeSessionId: "archive-board",
});
write("multi-agent/archive-board.json", {
  id: "archive-board",
  title: "기록 기능 검증",
  count: 1,
  panels: [
    {
      title: "대화 기록",
      cwd: work,
      refDirs: [],
      api: false,
      picker: { model: "haiku", effort: "minimal", mode: "normal" },
      snapshot: { messages: [] },
    },
  ],
});
const assistant = (content) => ({
  type: "assistant",
  session_id: "ARCHIVE-SESSION",
  parent_tool_use_id: null,
  message: { role: "assistant", model: "claude-haiku-4", content },
});
write(
  "script.jsonl",
  [
    {
      afterMs: 100,
      emit: {
        type: "control_response",
        response: { subtype: "success", request_id: "init-1", response: {} },
      },
    },
    {
      emit: {
        type: "system",
        subtype: "init",
        session_id: "ARCHIVE-SESSION",
        model: "claude-haiku-4",
        cwd: work,
        tools: ["Write", "Bash"],
      },
    },
    {
      emit: assistant([
        { type: "text", text: "파일을 수정하고 실행 결과를 확인하겠습니다." },
      ]),
    },
    {
      afterMs: 250,
      emit: assistant([
        {
          type: "tool_use",
          id: "archive-write",
          name: "Write",
          input: { file_path: artifact, content: after },
        },
      ]),
    },
    {
      afterMs: 1600,
      emit: {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "archive-write",
              content: "File written successfully.",
            },
          ],
        },
      },
    },
    {
      emit: assistant([
        {
          type: "tool_use",
          id: "archive-shell",
          name: "Bash",
          input: {
            command: "echo archive verification",
            description: "긴 출력 검증",
          },
        },
      ]),
    },
    {
      afterMs: 100,
      emit: {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "archive-shell",
              content: longOutput,
            },
          ],
        },
      },
    },
    {
      emit: assistant([
        {
          type: "text",
          text: formattedReply,
        },
      ]),
    },
    {
      emit: {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "ARCHIVE-SESSION",
        result: "ARCHIVE-COMPLETE",
        duration_ms: 2050,
        num_turns: 1,
        total_cost_usd: 0,
      },
    },
  ]
    .map((v) => JSON.stringify(v))
    .join("\n"),
);
let cdp;
const launch = () =>
  spawn(exe, [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CCG_HOME: home,
      CCG_NO_NET: "1",
      CCG_FAKECLI_SCRIPT: path.join(home, "script.jsonl"),
      CCG_FAKECLI_IN: path.join(home, "input.jsonl"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
let app = launch();
try {
  cdp = await connectMainPage(port);
  const evaluate = (expr) =>
    cdp.eval(`(async()=>(${expr}))()`, { awaitPromise: true });
  const until = async (expr, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(expr)) return;
      await sleep(100);
    }
    throw new Error(
      `Timeout: ${expr}\n${await evaluate("document.body.innerText.slice(-2500)")}`,
    );
  };
  const screenshot = async (name) => {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(home, name + ".png"),
      Buffer.from(shot.data, "base64"),
    );
  };
  const openLibrary = async () => {
    await until('!!document.querySelector(".sb-archive")');
    await evaluate('document.querySelector(".sb-archive").click()');
    await until(
      '!!document.querySelector(".arc-dialog") && document.querySelector(".arc-session-list")?.getAttribute("aria-busy")==="false"',
    );
  };
  await until('!!document.querySelector(".ma-panel .composer textarea")');
  await evaluate(
    '(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="시작하기");if(b)b.click()})()',
  );
  await until(
    '!!document.querySelector(".archive-chip") && !!document.querySelector(".ma-panel .composer textarea")',
  );
  assert(
    await evaluate(
      'document.querySelector(".sb-archive")?.previousElementSibling?.textContent.includes("프롬프트")',
    ),
  );
  await openLibrary();
  assert.equal(
    await evaluate('document.querySelectorAll(".arc-session").length'),
    0,
    "Empty archive opens without a current chat binding",
  );
  await evaluate('document.querySelector(".arc-close").click()');
  // A v1 session may have thousands of raw events before its first message.
  // Seed a committed index in the isolated home so the session-wide viewer must
  // cross an empty filtered page automatically without a user clicking Next.
  const seedDir = path.join(
    home,
    "conversation-archive",
    "chats",
    "ma-archive-board-0",
  );
  fs.mkdirSync(seedDir, { recursive: true });
  const seedData = [],
    seedHeaders = [];
  const seedCount = 4003;
  const seedIndex = Buffer.alloc(seedCount * 16);
  let dataOffset = 0,
    headerOffset = 0;
  const seedAt = Date.now();
  for (let i = 0; i < seedCount; i++) {
    const payload =
      i === 4001
        ? {
            type: "coverage-gap",
            text: "ARCHIVE-CAPTURE-GAP: file changed while saving",
          }
        : i === 4002
          ? {
              type: "capture-error",
              error: "ARCHIVE-CAPTURE-ERROR: file was unreadable",
            }
          : {
              type: "protocol-note",
              text: "Raw protocol before conversation",
            };
    const envelope = {
      version: 1,
      seq: i + 1,
      at: seedAt,
      source: i >= 4001 ? "file" : "protocol-in",
      kind: payload.type,
      preview: payload.text || payload.error || "Raw protocol",
      turnId: null,
      payload,
    };
    const data = Buffer.from(JSON.stringify(envelope) + "\n");
    const header = Buffer.from(
      JSON.stringify({
        seq: i + 1,
        at: seedAt,
        source: envelope.source,
        kind: envelope.kind,
        preview: envelope.preview,
        turnId: null,
        offset: dataOffset,
        length: data.length,
        payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
      }) + "\n",
    );
    seedIndex.writeBigUInt64LE(BigInt(headerOffset), i * 16);
    seedIndex.writeBigUInt64LE(BigInt(header.length), i * 16 + 8);
    seedData.push(data);
    seedHeaders.push(header);
    dataOffset += data.length;
    headerOffset += header.length;
  }
  fs.writeFileSync(path.join(seedDir, "events.jsonl"), Buffer.concat(seedData));
  fs.writeFileSync(
    path.join(seedDir, "entries.jsonl"),
    Buffer.concat(seedHeaders),
  );
  fs.writeFileSync(path.join(seedDir, "entries.idx"), seedIndex);
  await until('document.querySelector(".archive-chip")?.disabled === false');
  await evaluate('document.querySelector(".archive-chip").click()');
  await until(
    'document.querySelector(".archive-chip")?.getAttribute("aria-pressed")==="true" && !document.querySelector(".archive-chip").disabled',
  );
  assert(
    await evaluate('!document.querySelector(".archive-chip-pop")'),
    "Header click records without opening a popup",
  );
  const chatsDir = path.join(home, "conversation-archive", "chats");
  const chat = fs.readdirSync(chatsDir)[0];
  const archive = (channel) =>
    `window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'archive:${channel}',payload:[{chatId:${JSON.stringify(chat)}}]})`;
  await evaluate(
    `(()=>{const ta=document.querySelector('.ma-panel .composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'대화와 도구 실행, 파일 원본까지 저장해줘');ta.dispatchEvent(new Event('input',{bubbles:true}));ta.focus()})()`,
  );
  await evaluate(
    'document.querySelector(".ma-panel .composer button.send").click()',
  );
  await until(
    'document.querySelector(".ma-panel")?.textContent.includes("Write") || document.querySelector(".ma-panel")?.textContent.includes("파일을 수정")',
  );
  await sleep(400);
  fs.writeFileSync(artifact, after);
  await until(
    'document.querySelector(".ma-panel")?.textContent.includes("생성된 HTML과 도구 출력")',
  );
  await evaluate(archive("flush"));
  await sleep(300);
  await evaluate(archive("flush"));
  const logPath = path.join(chatsDir, chat, "Chat", "events.jsonl");
  assert(fs.existsSync(path.join(chatsDir, chat, "Chat", "format.json")));
  assert(!fs.existsSync(path.join(home, "conversation-archive", "objects")));
  assert(!fs.existsSync(path.join(home, "conversation-archive", "viewer")));
  const events = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(
    events.some(
      (e) =>
        e.source === "input" &&
        JSON.stringify(e.payload).includes("대화와 도구 실행"),
    ),
  );
  assert(
    events.some(
      (e) => e.source === "protocol-in" && e.payload.type === "assistant",
    ),
  );
  assert(events.some((e) => e.source === "protocol-out"));
  assert(
    events.some((e) => e.source === "tool" && e.payload.content === longOutput),
    "The entire untruncated tool output must be saved",
  );
  const modified = events.find(
    (e) => e.source === "file" && e.payload.change === "modified",
  );
  assert(modified, "A filesystem write must produce a stored version");
  const object = (hash) =>
    fs.readFileSync(
      path.join(
        home,
        "conversation-archive",
        "chats",
        chat,
        "View",
        "objects",
        hash.slice(0, 2),
        hash,
      ),
    );
  assert.equal(object(modified.payload.before.hash).toString(), before);
  assert.equal(object(modified.payload.after.hash).toString(), after);
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
  );
  const turns = await evaluate(archive("turns"));
  assert.equal(turns.items.length, 1);
  assert.equal(turns.items[0].model, "claude-haiku-4");
  assert.equal(turns.items[0].status, "completed");
  await openLibrary();
  assert.equal(
    await evaluate('document.querySelectorAll(".arc-session").length'),
    1,
  );
  await until(
    'document.querySelector(".arc-detail-scroll")?.textContent.includes("대화와 도구 실행") && document.querySelector(".arc-detail-scroll")?.textContent.includes("생성된 HTML")',
  );
  await screenshot("archive-session-conversation");
  assert(
    await evaluate('!document.querySelector(".arc-tabs")'),
    "The reader has one conversation flow with no category tabs",
  );
  assert(
    await evaluate(
      '!document.querySelector(".arc-event[data-kind=recording-enabled], .arc-event[data-kind=recording-paused], .arc-event[data-kind=result]")',
    ),
    "Recording controls and ordinary completion do not interrupt the conversation",
  );
  assert(
    await evaluate(
      '!document.querySelector(".arc-diagnostics, .arc-detail-scroll [data-kind=coverage-gap], .arc-detail-scroll [data-kind=capture-error]")',
    ),
    "Capture notices are absent from the conversation and initially collapsed",
  );
  await evaluate('document.querySelector(".arc-diagnostics-toggle").click()');
  await until(
    'document.querySelectorAll(".arc-diagnostics .arc-event").length === 2',
  );
  await evaluate(
    'document.querySelector(".arc-diagnostics [data-kind=coverage-gap] .arc-event-head").click()',
  );
  await until(
    'document.querySelector(".arc-diagnostics .arc-event-body")?.textContent.includes("ARCHIVE-CAPTURE-GAP")',
  );
  assert(
    await evaluate(
      '!!document.querySelector(".arc-diagnostics [data-kind=capture-error]") && !document.querySelector(".arc-detail-scroll [data-kind=coverage-gap], .arc-detail-scroll [data-kind=capture-error]")',
    ),
    "Previously saved capture errors remain accessible only in capture status",
  );
  await screenshot("archive-capture-status");
  await evaluate('document.querySelector(".arc-diagnostics-toggle").click()');
  assert(await evaluate('!document.querySelector(".arc-diagnostics")'));
  assert(
    events.some(
      (e) => e.source === "tool" && e.payload.input?.content === after,
    ),
    "The exact contents sent to the file-writing tool must be saved",
  );
  await until(
    'document.querySelector(".arc-activity[data-kind=tool_use]")?.textContent.includes("파일 쓰기")',
  );
  assert(
    await evaluate(
      'document.querySelectorAll(".arc-activity[data-kind=tool_result]").length >= 2',
    ),
    "Complete tool results are in the same conversation flow",
  );
  await until('!!document.querySelector(".arc-chat-message .md-h2")');
  const markdown = await evaluate(
    `(()=>{const root=document.querySelector('.arc-chat-message:has(.md-h2) .arc-message-text');const ul=root.querySelector('ul'),li=ul.querySelector('li'),code=root.querySelector('code.inline'),p=root.querySelector('p'),block=root.querySelector('.codeblock pre');return {list:getComputedStyle(ul).listStyleType,listPadding:parseFloat(getComputedStyle(ul).paddingLeft),listMarker:getComputedStyle(li,'::before').content,paragraphMargin:parseFloat(getComputedStyle(p).marginBottom),inlinePadding:parseFloat(getComputedStyle(code).paddingLeft),heading:parseFloat(getComputedStyle(root.querySelector('.md-h2')).fontSize),body:parseFloat(getComputedStyle(root).fontSize),orderedStart:root.querySelector('ol').start,quoteBorder:parseFloat(getComputedStyle(root.querySelector('blockquote')).borderLeftWidth),tableCells:root.querySelectorAll('td').length,codeWrap:getComputedStyle(block).whiteSpace,codeScrolls:block.scrollWidth>block.clientWidth,highlighted:!!block.querySelector('.hljs-keyword')};})()`,
  );
  assert.equal(markdown.list, "disc");
  assert(markdown.listPadding >= 18 && markdown.listMarker === "none");
  assert(markdown.paragraphMargin > 6 && markdown.inlinePadding > 2);
  assert(markdown.heading > markdown.body && markdown.body >= 13);
  assert.equal(markdown.orderedStart, 3);
  assert(markdown.quoteBorder >= 2 && markdown.tableCells === 2);
  assert(
    markdown.codeWrap === "pre" && markdown.codeScrolls && markdown.highlighted,
  );
  await evaluate(
    `(()=>{window.__archiveClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async text=>{window.__archiveCopiedText=text;};document.querySelector('.arc-chat-message:has(.md-h2) .arc-message-actions button:last-child').click();})()`,
  );
  assert.equal(
    await evaluate("window.__archiveCopiedText"),
    formattedReply,
    "Message copy returns Markdown text rather than a JSON envelope",
  );
  await evaluate(
    'document.querySelector(".arc-chat-message:has(.md-h2) .arc-message-actions button:first-child").click()',
  );
  await until(
    '!!document.querySelector(".arc-chat-message:has(.arc-raw-info)")',
  );
  await evaluate(
    'document.querySelector(".arc-chat-message:has(.arc-raw-info) .arc-message-actions button:last-child").click()',
  );
  assert.equal(
    JSON.parse(await evaluate("window.__archiveCopiedText")).payload.text,
    formattedReply,
    "Raw record is still available intact",
  );
  await evaluate(
    'document.querySelector(".arc-chat-message:has(.arc-raw-info) .arc-message-actions button:first-child").click()',
  );
  await evaluate(
    "navigator.clipboard.writeText = window.__archiveClipboardWrite",
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 880,
    height: 680,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(
    'document.querySelector(".arc-chat-message:has(.md-h2)").scrollIntoView({block:"start"})',
  );
  assert(
    await evaluate(
      'document.querySelector(".arc-dialog").scrollWidth <= document.querySelector(".arc-dialog").clientWidth + 1 && document.querySelector(".arc-detail-scroll").scrollWidth <= document.querySelector(".arc-detail-scroll").clientWidth + 1',
    ),
    "Long code and Markdown tables stay within the reader at narrow widths",
  );
  await screenshot("archive-markdown-narrow");
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await evaluate(
    'document.querySelector(".arc-chat-message:has(.md-h2)").scrollIntoView({block:"start"})',
  );
  await screenshot("archive-markdown-formatted");
  await evaluate(
    'document.querySelector(".arc-activity[data-kind=tool_use] .arc-event-head").click()',
  );
  await until(
    'document.querySelector(".arc-event-body")?.textContent.includes("file_path")',
  );
  await evaluate(
    `(()=>{const group=[...document.querySelectorAll('.arc-file-group')].find(g=>Number(g.dataset.firstSeq)<=${modified.seq}&&Number(g.dataset.lastSeq)>=${modified.seq});if(!group)throw Error('File group not found');group.querySelector('.arc-activity-head').click()})()`,
  );
  await until(
    `!!document.querySelector('.arc-event[data-seq="${modified.seq}"]')`,
  );
  await evaluate(
    `document.querySelector('.arc-event[data-seq="${modified.seq}"] .arc-event-head').click()`,
  );
  await until('!!document.querySelector(".arc-file-versions button")');
  await evaluate('document.querySelector(".arc-file-versions button").click()');
  await until(
    'document.querySelectorAll(".arc-snapshot").length === 2 && document.querySelector(".arc-snapshot-grid").textContent.includes("Before archive edit") && document.querySelector(".arc-snapshot-grid").textContent.includes("보관된 결과물")',
  );
  await screenshot("archive-session-files");
  await evaluate('document.querySelector(".arc-close").click()');
  await screenshot("archive-recording");
  await evaluate('document.querySelector(".archive-chip").click()');
  await until(
    'document.querySelector(".archive-chip")?.getAttribute("aria-pressed")==="false" && !document.querySelector(".archive-chip").disabled',
  );
  const pausedBytes = fs.statSync(logPath).size;
  fs.writeFileSync(
    path.join(work, "after-recording-stopped.txt"),
    "Must not be collected",
  );
  await sleep(400);
  await evaluate(archive("flush"));
  assert.equal(
    fs.statSync(logPath).size,
    pausedBytes,
    "Disabled recording must not write new events",
  );
  const previousOrigin = await evaluate("performance.timeOrigin");
  await cdp.send("Page.reload");
  await until(
    `performance.timeOrigin !== ${previousOrigin} && !!document.querySelector('.ma-panel .archive-chip')`,
  );
  assert.equal(
    (await evaluate(archive("status"))).status.enabled,
    false,
    "Reload preserves paused recording",
  );
  const reloadedTurns = await evaluate(archive("turns"));
  assert.equal(reloadedTurns.items.length, 1);
  assert(reloadedTurns.items[0].title.includes("대화와 도구 실행"));
  const nextRoot = path.join(home, "alternate-archive");
  const sessionFolder = await evaluate(archive("session-folder"));
  assert.equal(sessionFolder.path, path.join(chatsDir, chat));
  const rootCall = (root) =>
    `window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'archive:set-root',payload:[{path:${JSON.stringify(root)}}]})`;
  assert((await evaluate(rootCall(nextRoot))).root);
  assert.equal((await evaluate(archive("turns"))).items.length, 0);
  assert(
    fs.existsSync(logPath),
    "Changing location preserves the prior archive",
  );
  // Transfer ONLY one session folder. Import through the actual library UI while
  // both original paths are unavailable. Renames stay inside this fixture home.
  const originalRoot = path.join(home, "conversation-archive");
  const portableRoot = path.join(home, "copied-archive");
  const sharedSession = path.join(home, "shared-session");
  const hiddenWork = path.join(home, "unavailable-workspace");
  const hiddenArchive = path.join(home, "unavailable-original-archive");
  for (const target of [
    work,
    originalRoot,
    portableRoot,
    sharedSession,
    hiddenWork,
    hiddenArchive,
  ]) {
    assert(path.resolve(target).startsWith(path.resolve(home) + path.sep));
  }
  fs.cpSync(sessionFolder.path, sharedSession, { recursive: true });
  assert.deepEqual(fs.readdirSync(sharedSession).sort(), ["Chat", "View"]);
  fs.mkdirSync(portableRoot);
  await evaluate(rootCall(portableRoot));
  fs.renameSync(work, hiddenWork);
  fs.renameSync(originalRoot, hiddenArchive);
  try {
    assert(!fs.existsSync(work) && !fs.existsSync(originalRoot));
    await openLibrary();
    await evaluate(
      `(()=>{window.__archivePickDirectory = window.api.pickDirectory; window.api.pickDirectory = async () => ${JSON.stringify(sharedSession)}; return true})()`,
    );
    await evaluate('document.querySelector(".arc-import").click()');
    await until(
      '!!document.querySelector(".arc-session") && !document.querySelector(".arc-import").disabled',
    );
    await evaluate(
      "(()=>{window.api.pickDirectory = window.__archivePickDirectory; delete window.__archivePickDirectory; return true})()",
    );
    assert.equal((await evaluate(archive("status"))).config.enabled, false);
    const objectCall = (channel, hash) =>
      `window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'archive:${channel}',payload:[${JSON.stringify({ chatId: chat, hash, name: "result.html", offset: 0 })}]})`;
    assert.equal(
      (await evaluate(objectCall("object", modified.payload.before.hash))).text,
      before,
    );
    assert.equal(
      (await evaluate(objectCall("object", modified.payload.after.hash))).text,
      after,
    );
    const copy = await evaluate(
      objectCall("materialize", modified.payload.after.hash),
    );
    assert(
      copy.path.startsWith(
        path.join(portableRoot, "chats", chat, "View", "files") + path.sep,
      ),
    );
    assert.equal(fs.readFileSync(copy.path, "utf8"), after);
    await until(
      'document.querySelector(".arc-detail-scroll")?.textContent.includes("생성된 HTML")',
    );
    await evaluate(
      'document.querySelector(".arc-activity[data-kind=tool_use] .arc-event-head").click()',
    );
    await until(
      'document.querySelector(".arc-event-body")?.textContent.includes("보관된 결과물")',
    );
    await screenshot("archive-portable-single-session");
    // Exercise the session menu on the isolated imported copy, never user data.
    const importedSessionPath = path.join(portableRoot, "chats", chat);
    const importedLog = fs.readFileSync(
      path.join(importedSessionPath, "Chat", "events.jsonl"),
    );
    const openSessionMenu = async () => {
      await evaluate(
        'document.querySelector(".arc-session").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:window.innerWidth-4,clientY:window.innerHeight-4}))',
      );
      await until('!!document.querySelector(".arc-session-menu")');
      const bounds = await evaluate(
        '(()=>{const r=document.querySelector(".arc-session-menu").getBoundingClientRect();return {right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()',
      );
      assert(
        bounds.right <= bounds.width && bounds.bottom <= bounds.height,
        "Menu stays on screen",
      );
    };
    await openSessionMenu();
    await sleep(200);
    await screenshot("archive-session-context-menu");
    await evaluate(
      'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
    );
    await until(
      '!document.querySelector(".arc-session-menu") && !!document.querySelector(".arc-dialog")',
    );
    await openSessionMenu();
    await evaluate(
      'document.querySelector(".arc-session-menu .ctx-item").click()',
    );
    await until('!!document.querySelector(".arc-rename-input")');
    const renamedTitle = "공유한 세션 새 이름 🧪";
    await evaluate(
      `(()=>{const el=document.querySelector('.arc-rename-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(renamedTitle)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
    );
    await evaluate('document.querySelector(".arc-action-save").click()');
    await until(
      `!document.querySelector('.arc-session-action') && document.querySelector('.arc-session h3')?.textContent===${JSON.stringify(renamedTitle)}`,
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(importedSessionPath, "Chat", "name.json"),
          "utf8",
        ),
      ).title,
      renamedTitle,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(importedSessionPath, "Chat", "events.jsonl")),
      importedLog,
    );
    await evaluate('document.querySelector(".arc-close").click()');
    await openLibrary();
    await until(
      `document.querySelector('.arc-session h3')?.textContent===${JSON.stringify(renamedTitle)}`,
    );
    // A stale dialog cannot delete an identically named session in a new root.
    const wrongRoot = await evaluate(
      `window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'archive:delete',payload:[${JSON.stringify({ chatId: chat, root: sharedSession })}]})`,
    );
    assert.equal(wrongRoot.ok, false);
    assert(fs.existsSync(importedSessionPath));
    await openSessionMenu();
    await evaluate(
      'document.querySelector(".arc-session-menu .danger").click()',
    );
    await until(
      '!!document.querySelector(".arc-session-action [role=alertdialog]")',
    );
    assert(
      (
        await evaluate(
          'document.querySelector(".arc-session-action").textContent',
        )
      ).includes(renamedTitle),
    );
    await sleep(220);
    await screenshot("archive-session-delete-confirm");
    await evaluate(
      'document.querySelector(".arc-session-action .cancel").click()',
    );
    await until('!document.querySelector(".arc-session-action")');
    assert(
      fs.existsSync(importedSessionPath),
      "Cancel preserves the complete session",
    );
    await openSessionMenu();
    await evaluate(
      'document.querySelector(".arc-session-menu .danger").click()',
    );
    await until('!!document.querySelector(".arc-session-action .danger")');
    await evaluate(
      'document.querySelector(".arc-session-action .danger").click()',
    );
    await until(
      '!document.querySelector(".arc-session-action") && !document.querySelector(".arc-session")',
    );
    assert(
      !fs.existsSync(importedSessionPath),
      "Confirmed deletion removes Chat and View",
    );
    assert(
      fs.existsSync(path.join(sharedSession, "Chat", "events.jsonl")),
      "Shared source copy stays intact",
    );
    assert.equal(
      fs.readFileSync(path.join(hiddenWork, "result.html"), "utf8"),
      after,
    );
  } finally {
    await evaluate('document.querySelector(".arc-close")?.click()');
    fs.renameSync(hiddenArchive, originalRoot);
    fs.renameSync(hiddenWork, work);
  }
  await evaluate(rootCall(path.join(home, "conversation-archive")));
  assert.equal((await evaluate(archive("turns"))).items.length, 1);
  const recordingConfig = {
    chatId: chat,
    config: {
      enabled: true,
      cwd: work,
      roots: [work],
      title: "대화 기록 검증",
    },
  };
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'archive:configure',payload:[${JSON.stringify(recordingConfig)}]})`,
  );
  const lastFile = "<h1>FINAL-BEFORE-QUIT</h1>\n";
  fs.writeFileSync(artifact, lastFile);
  // Use Quit completely: closing only the main window can leave a notification
  // or another auxiliary window alive, which is not application shutdown.
  const surfacesBeforeClose = await evaluate(
    "window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'win:surface-debug',payload:[]})",
  );
  fs.writeFileSync(
    path.join(home, "surfaces-before-close.json"),
    JSON.stringify(surfacesBeforeClose, null, 2),
  );
  await evaluate(
    "window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'win:surface-debug',payload:['traymenu-open']})",
  );
  let menu;
  const menuDeadline = Date.now() + 10000;
  while (!menu && Date.now() < menuDeadline) {
    menu = (await cdpTargets(port)).find(
      (t) => t.type === "page" && t.url.includes("tray.html"),
    );
    if (!menu) await sleep(50);
  }
  assert(menu, "The actual tray menu must open");
  const menuCdp = await Cdp.connect(menu.webSocketDebuggerUrl);
  try {
    for (let i = 0; i < 50; i++) {
      if (await menuCdp.eval("!!window.__TAURI_INTERNALS__")) break;
      await sleep(50);
    }
    await menuCdp
      .eval(
        "window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'traymenu:action',payload:['quit']})",
        { awaitPromise: true },
      )
      .catch(() => {});
  } finally {
    menuCdp.close();
  }
  const closed = Date.now() + 10000;
  while (app.exitCode == null && Date.now() < closed) await sleep(100);
  if (app.exitCode == null)
    console.log(
      JSON.stringify({ surfacesBeforeClose, home, stillAlive: app.pid }),
    );
  assert.equal(
    app.exitCode,
    0,
    "Normal application shutdown must drain and exit",
  );
  const closedEvents = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(
    closedEvents.some(
      (e) =>
        e.source === "file" &&
        e.payload.after?.hash &&
        object(e.payload.after.hash).toString() === lastFile,
    ),
    "Quit drains the final file snapshot while recording is enabled",
  );
  cdp.close();
  app = launch();
  cdp = await connectMainPage(port);
  await until('!!document.querySelector(".archive-chip")');
  const afterRestart = await evaluate(archive("turns"));
  assert.equal(afterRestart.items.length, 1);
  assert.equal(afterRestart.items[0].status, "completed");
  assert.equal((await evaluate(archive("status"))).status.enabled, true);
  await until('!!document.querySelector(".ma-panel .composer textarea")');
  await evaluate(
    `(()=>{const ta=document.querySelector('.ma-panel .composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'재시작 후 첫 요청도 기록해줘');ta.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await evaluate(
    'document.querySelector(".ma-panel .composer button.send").click()',
  );
  await until(
    `(await ${archive("turns")}).items.some(t=>t.title==='재시작 후 첫 요청도 기록해줘' && t.status==='completed')`,
  );
  await evaluate(archive("flush"));
  assert.equal((await evaluate(archive("turns"))).items.length, 2);
  await openLibrary();
  assert.equal(
    await evaluate('document.querySelectorAll(".arc-session").length'),
    1,
    "Two turns across native restarts remain one session",
  );
  await until(
    'document.querySelector(".arc-detail-scroll")?.textContent.includes("대화와 도구 실행") && document.querySelector(".arc-detail-scroll")?.textContent.includes("재시작 후 첫 요청도 기록해줘")',
  );
  assert.equal(
    await evaluate('document.querySelectorAll(".arc-event.user").length'),
    2,
    "The default view includes every recorded user turn",
  );
  await screenshot("archive-complete-session");
  await evaluate('document.querySelector(".arc-search input").focus()');
  await evaluate(
    `(()=>{const input=document.querySelector('.arc-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'does-not-match');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await until(
    'document.querySelector(".arc-session-list")?.textContent.includes("검색에 맞는 세션이 없습니다")',
  );
  await evaluate(
    `(()=>{const input=document.querySelector('.arc-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'대화 기록');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await until('document.querySelectorAll(".arc-session").length === 1');
  console.log(
    JSON.stringify(
      {
        ok: true,
        exe,
        artifacts: home,
        chat,
        events: events.length,
        logBytes: fs.statSync(logPath).size,
        toolOutputBytes: Buffer.byteLength(longOutput),
        checks: [
          "native header toggle",
          "sidebar library entry and empty archive",
          "one conversation flow with tool actions and grouped file versions",
          "capture notices hidden from conversation and available in status details",
          "all turns in one session across restarts",
          "automatic scan past 4001 raw events before conversation",
          "global session search",
          "Markdown lists, headings, tables, code blocks and ordered starts",
          "message text copy and exact raw-record copy",
          "narrow reader with long code and tables",
          "input/response/raw protocols",
          "full tool output",
          "file before/after bytes",
          "ordered event IDs",
          "actual model and completion",
          "disabled no writes",
          "recording and archive reload persistence",
          "storage location round trip",
          "v1 migration and self-contained Chat/View session layout",
          "single session folder imported through UI without original workspace or archive",
          "session context menu, persisted rename, delete cancellation and confirmed deletion",
          "graceful shutdown and native restart",
          "enabled preference and first post-restart request",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  cdp?.close();
  if (app.pid) killTree(app.pid);
}
