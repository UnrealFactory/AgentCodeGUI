# Add AgentCodeGUI integration to my program

Implement an adapter that sends the current program's selection and state to AgentCodeGUI. First inspect the project's language, runtime, and selection/document/state change events, then integrate with its existing structure. The complete protocol and Node.js reference source are included below.

## Required behavior

- On startup, find AgentCodeGUI on the same computer and register the program's name and icon.
- Publish the latest selection when the user selects code, text, table rows, or objects, and publish current state when the active document or state changes. Send `items: []` when the selection is cleared.
- Put selections in `items` and accompanying current state in `state`. Follow the user's requested scope instead of dumping the entire program's data on every change.
- When the user connects the tool at the top of an AgentCodeGUI conversation, its selection appears above the composer. One tool can connect to multiple sessions simultaneously.
- The program must continue working when AgentCodeGUI is not running, wait for it, and reconnect automatically. After an app restart, register again and republish the latest document.

This protocol is **AgentCodeGUI External Tools API v1**, a dedicated local HTTP/JSON protocol. It does not use MCP tool calls. It sends selections and state from the program into conversations. There is no API to start AI runs, subscribe to AI responses, or remotely control the program.

## 1. Discovery and authentication

Run a build of AgentCodeGUI that supports external tool integration on the same computer.

Use the `CCG_HOME` environment variable for the app home if present; otherwise use `.agentcodegui3` inside the current user's home directory. The default on Windows is `%USERPROFILE%\.agentcodegui3`. Allow an app home override for users running another profile.

Read `external-bridge.json` from the app home in a native process. AgentCodeGUI creates this file; the adapter must not create or modify it.

```json
{"protocolVersion":1,"url":"http://127.0.0.1:12345","token":"<discovery token>","pid":1234}
```

These values illustrate the format. Read the actual file at runtime. Validate protocol version 1 and an `http://127.0.0.1:<port>` URL. Do not hardcode the port or token. Retry after a short delay if the file is absent or the app is stopped.

Use `Authorization: Bearer <token>` and `Content-Type: application/json` for POST bodies. Keep tokens out of logs, prompts, repositories, and browser code. Communicate from an Electron main process, Tauri Rust code, Python/C# process, or local Node server. A program with a web UI needs its own backend to perform this communication. The API rejects browser `Origin` requests and validates Host against its actual loopback address.

## 2. Register the tool

Call `POST /v1/connect` using the discovery token.

```json
{"protocolVersion":1,"manifest":{"id":"com.example.my-tool","instanceId":"workspace-42","name":"My Tool","version":"1.0.0","icon":"code"}}
```

- `id` identifies the program and `instanceId` identifies a window or workspace. Keep them stable across restarts. Distinguish simultaneous instances. Registering the same live `(id, instanceId)` twice returns an error.
- `name` appears in the connection list. `icon` is an app-provided ID such as `code`, `table`, `design`, `document`, or `tool`.
- The response is `{ok:true, protocolVersion:1, clientId, token, pollIntervalMs, bindings, limits, ...}`. Use this **instance token** for subsequent `/v1/clients/:id/...` requests. It is separate from the discovery token.
- Registration does not automatically bind a session. The user chooses sessions in AgentCodeGUI.

## 3. Publish selection and state

Call `POST /v1/clients/:clientId/publish` with the instance token. Replace `:clientId` with the actual registration result.

```json
{
  "revision": 1,
  "document": {
    "items": [
      {"id":"selection","kind":"code/selection","title":"checkout.ts : 12–18","text":"const total = calculateTotal(items);","uri":"file:///C:/project/checkout.ts","range":{"startLine":12,"endLine":18}},
      {"id":"selected-rows","kind":"table/rows","title":"2 selected sales rows","data":[{"product":"Bag","sales":1240000},{"product":"Tray","sales":860000}]}
    ],
    "state": {"activeDocument":"checkout.ts","unsavedChanges":true,"taskStatus":"idle"}
  }
}
```

Each `document` replaces the previous document in full; it is not a patch. `revision` is a positive integer, starting at 1 after registration and strictly increasing. Equal or smaller revisions are rejected. Start at 1 again after registering anew. Serialize requests and coalesce rapid changes to the latest value to avoid reordering.

Each item requires nonempty string `id`, `kind`, and `title`. IDs must be unique within the document. `kind` is defined by your program. Use `text` for source text and `data` for structured tables, objects, or arrays. Extra fields such as `uri` and `range` are preserved. `state` is arbitrary JSON or null. Put all model-relevant information inside `items` or `state`.

## 4. Keep the connection alive and recover

- Call `GET /v1/clients/:clientId/poll` at the registration response's `pollIntervalMs` (currently 1000ms). After 15 seconds without communication the tool is marked offline and excluded from message capture.
- The poll response is `{ok:true, protocolVersion:1, clientId, bindings:[{chatId,enabled,includeSelection}], revision, ...}`. These are this tool's bindings, not all conversations or other tools.
- Legacy summary fields `boundChatId` and `enabled` also exist, but new implementations should use `bindings`. Do not assume exclusive ownership by one session.
- Keep publishing the latest document even when sessions are OFF. AgentCodeGUI distributes one published document to the connected sessions; the adapter does not publish separate documents per session.
- Retry network errors and app shutdown after a short delay. Use request timeouts. When the discovery URL/token changes or instance authentication fails (401), reread discovery, register again, and republish the latest document. On shutdown, call `DELETE /v1/clients/:clientId` if possible.
- To update name, icon, or version, send the complete `{manifest:{...}}` to `POST /v1/clients/:clientId/manifest`. A connected instance cannot change its `id` or `instanceId`.

## 5. Other endpoints and limits

Use the discovery token for `GET /v1` (protocol version and capabilities) and `GET /v1/icons` (`icons:[{id,ko,en,path}]`). Use IDs from that catalog. Unknown icons fall back to `tool`.

Errors are `{ok:false,error:"description"}`. 401 means authentication failed, 403 means Origin/Host rejection, 400 means invalid data, version, revision, or another request error, and 413 means an oversized request. Correct a 400 response's cause instead of repeatedly sending the same invalid data.

All sizes are UTF-8. Limits: 16 KiB metadata, 256 KiB document, 512 KiB HTTP body, 32 items per document, and 32 registered tools. All external data captured in one message is limited to 96 KiB combined, so keep actual selections well below that. String limits in bytes: manifest id 128, name/instanceId 160 each, version 80, icon 128; item id/kind 128 each and title 240.

## 6. Explain usage and verify completion

1. Run the integrated program and AgentCodeGUI; confirm the tool appears in the connection list.
2. Connect it at the top of a session. Change a real selection in the program and confirm that the composer context updates.
3. Clear the selection and confirm that the old selection disappears.
4. Sending a message freezes a copy of selection/state at that moment. Later selection changes must not alter sent attachments.
5. Turning off “Include in next message” excludes selection only; tool state remains included. The connection list's ON/OFF switch controls both selection and state. × disconnects only that session.
6. Connect the same tool to multiple sessions and confirm that ON/OFF and disconnect apply independently.
7. Restart AgentCodeGUI and confirm automatic reconnection and republishing of the latest document.

After implementation, report changed files, where users interact with the program, how to run it, actual verification results, and anything still unverified. If AgentCodeGUI is unavailable and the real connection cannot be checked, say so explicitly.

## 7. Runnable Node.js reference

Save the following two code blocks as `client.mjs` and `connect-example.mjs` in the same folder. Run `node connect-example.mjs` with Node.js 22 or later; stop with Ctrl+C. No external packages are required. **My Tool** appears in AgentCodeGUI's tool connection list.

This example publishes a fixed sample selection. For the real integration, customize the manifest and call `client.publish(...)` from actual selection/document/state change events. For other languages, implement the same behavior using the HTTP contract above. The reference includes automatic connection/reconnection, latest-value coalescing, serialized publishing, and shutdown handling.
