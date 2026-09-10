# 내 프로그램에 AgentCodeGUI 외부 도구 연동을 구현해 주세요

현재 작업 중인 프로그램의 선택 내용과 상태를 AgentCodeGUI에 전달하는 연결 모듈을 구현해 주세요. 먼저 프로젝트의 언어, 실행 환경, 선택·문서·상태 변경 이벤트를 확인하고 기존 구조에 맞춰 작업하세요. 아래에 필요한 규격과 Node.js 참고 코드를 모두 포함했습니다.

## 구현할 동작

- 프로그램을 실행하면 같은 컴퓨터의 AgentCodeGUI를 찾아 도구 이름과 아이콘을 등록합니다.
- 사용자가 코드·텍스트·표 행·오브젝트 등을 선택하거나 활성 문서와 상태를 바꾸면 최신 내용을 전달합니다. 선택을 해제하면 `items: []`를 전달해 이전 선택을 지웁니다.
- 선택 내용은 `items`, 함께 전달할 현재 상태는 `state`에 넣습니다. 프로그램 전체 데이터를 매번 덤프하지 말고 사용자가 지정한 범위에 맞춰 구성하세요.
- 사용자가 AgentCodeGUI의 대화 상단에서 이 도구를 연결하면 입력창 위에 선택 내용이 표시됩니다. 동일 도구를 여러 세션에 동시에 연결할 수 있습니다.
- AgentCodeGUI가 먼저 실행되지 않아도 프로그램은 정상 동작하며, 기다리다가 자동 연결합니다. 앱을 재시작하면 다시 연결하고 최신 내용을 재전송합니다.

이 규격의 이름은 **AgentCodeGUI External Tools API v1**입니다. HTTP와 JSON을 사용하는 전용 로컬 규격이며 MCP의 도구 호출 규격을 사용하지 않습니다. 외부 프로그램에서 대화로 선택·상태를 전달하는 기능입니다. AI 실행, AI 응답 구독 또는 외부 프로그램 원격 제어 API는 없습니다.

## 1. 앱 찾기와 인증

외부 도구 연동 기능이 포함된 AgentCodeGUI를 같은 컴퓨터에서 실행해야 합니다.

앱 홈은 `CCG_HOME` 환경 변수가 있으면 그 경로, 기본은 현재 사용자의 홈 폴더 아래 `.agentcodegui3`입니다. Windows 기본 예시는 `%USERPROFILE%\.agentcodegui3`입니다. 별도 프로필 사용자를 위해 연결 모듈에 앱 홈 경로를 지정할 수 있게 해 주세요.

앱 홈의 `external-bridge.json`을 네이티브 프로세스에서 읽습니다. 이 파일은 AgentCodeGUI가 생성하며 연결 모듈이 만들거나 수정하지 않습니다.

```json
{"protocolVersion":1,"url":"http://127.0.0.1:12345","token":"<앱 검색 토큰>","pid":1234}
```

위 주소와 토큰은 형식을 보여 주는 예시입니다. 실제 실행 시 파일에서 읽으세요. `protocolVersion`이 1이고 URL이 `http://127.0.0.1:<port>`인지 검증하며 포트와 토큰을 하드코딩하지 마세요. 파일이 없거나 앱이 종료된 상태면 잠시 후 다시 시도합니다.

요청은 `Authorization: Bearer <token>`을 사용하고 POST 본문에는 `Content-Type: application/json`을 지정합니다. 인증 토큰을 로그, 프롬프트, 저장소, 브라우저 코드에 넣지 마세요. Electron의 메인 프로세스, Tauri의 Rust 코드, Python/C# 프로세스, Node 로컬 서버 등에서 통신하세요. 웹 UI가 있는 프로그램은 자체 백엔드가 이 통신을 맡습니다. API는 브라우저의 `Origin` 요청을 거부하고 Host를 실제 루프백 주소로 확인합니다.

## 2. 도구 등록

검색 파일 토큰으로 `POST /v1/connect`를 호출합니다.

```json
{"protocolVersion":1,"manifest":{"id":"com.example.my-tool","instanceId":"workspace-42","name":"My Tool","version":"1.0.0","icon":"code"}}
```

- `id`는 프로그램 식별자, `instanceId`는 창 또는 작업공간의 식별자입니다. 재시작해도 같은 값으로 유지하고 동시에 실행하는 서로 다른 인스턴스는 구분하세요. 살아 있는 같은 `(id, instanceId)`를 중복 등록하면 오류입니다.
- `name`은 사용자가 연결 목록에서 보는 이름입니다. `icon`은 앱이 제공하는 ID입니다. `code`, `table`, `design`, `document`, `tool` 등을 사용할 수 있습니다.
- 등록 응답은 `{ok:true, protocolVersion:1, clientId, token, pollIntervalMs, bindings, limits, ...}`입니다. 여기서 받은 **인스턴스 토큰**을 이후 `/v1/clients/:id/...` 요청에 사용합니다. 검색 파일 토큰과 역할이 다릅니다.
- 등록만으로 세션에 자동 연결되지는 않습니다. 어느 세션에서 사용할지는 사용자가 AgentCodeGUI에서 선택합니다.

## 3. 선택과 상태 발행

인스턴스 토큰으로 `POST /v1/clients/:clientId/publish`를 호출합니다. `:clientId`는 등록 응답의 실제 값으로 대체합니다.

```json
{
  "revision": 1,
  "document": {
    "items": [
      {"id":"selection","kind":"code/selection","title":"checkout.ts : 12–18","text":"const total = calculateTotal(items);","uri":"file:///C:/project/checkout.ts","range":{"startLine":12,"endLine":18}},
      {"id":"selected-rows","kind":"table/rows","title":"선택한 매출 2행","data":[{"product":"Bag","sales":1240000},{"product":"Tray","sales":860000}]}
    ],
    "state": {"activeDocument":"checkout.ts","unsavedChanges":true,"taskStatus":"idle"}
  }
}
```

`document`는 변경분이 아닌 전체 최신 내용으로 교체됩니다. `revision`은 양의 정수이며 등록 후 1부터 증가시킵니다. 같은 연결에서 이전 값 이하를 보내면 오류입니다. 다시 등록하면 1부터 시작하세요. 요청을 직렬화하고 빠른 변경은 최신 값으로 합쳐 순서가 뒤집히지 않게 하세요.

항목의 `id`, `kind`, `title`은 필수 비어 있지 않은 문자열입니다. 항목 ID는 문서 안에서 고유해야 합니다. `kind`는 프로그램이 정하는 문자열입니다. 원문은 `text`, 구조화된 표·객체·배열은 `data`에 넣으세요. `uri`, `range` 등 추가 필드는 보존됩니다. `state`는 임의 JSON 또는 null입니다. 모델에 필요한 정보는 `items` 또는 `state` 안에 넣으세요.

## 4. 연결 유지와 복원

- 등록 응답의 `pollIntervalMs`(현재 1000ms)를 기준으로 `GET /v1/clients/:clientId/poll`을 주기적으로 호출합니다. 15초 동안 통신이 없으면 오프라인으로 표시되어 전송에서 제외됩니다.
- poll 응답은 `{ok:true, protocolVersion:1, clientId, bindings:[{chatId,enabled,includeSelection}], revision, ...}`입니다. `bindings`는 이 도구에 연결된 세션들입니다. 다른 도구나 전체 대화 목록은 반환되지 않습니다.
- `boundChatId`와 `enabled`라는 구형 요약 필드도 있지만 새 구현은 `bindings`를 사용하세요. 도구가 한 세션에만 속한다고 가정하지 마세요.
- 세션이 OFF여도 최신 문서는 발행할 수 있습니다. 한 번 발행한 문서를 AgentCodeGUI가 연결된 세션들에 제공합니다. 도구 쪽에서 세션별로 다른 문서를 발행할 필요가 없습니다.
- 네트워크 오류와 앱 종료에는 짧은 대기 후 재시도합니다. 요청에는 시간 제한을 두세요. 검색 파일의 주소·토큰이 바뀌거나 인스턴스 인증에 실패(401)하면 검색 파일을 다시 읽고 재등록한 뒤 최신 문서를 발행합니다. 종료할 때는 가능하면 `DELETE /v1/clients/:clientId`로 알립니다.
- 이름·아이콘·버전 변경은 `POST /v1/clients/:clientId/manifest`에 `{manifest:{...}}` 전체를 보냅니다. 연결 중인 `id`와 `instanceId`는 바꿀 수 없습니다.

## 5. 나머지 API와 한도

검색 파일 토큰으로 `GET /v1`(프로토콜 버전과 기능 목록), `GET /v1/icons`(`icons:[{id,ko,en,path}]`)를 호출할 수 있습니다. 아이콘은 이 목록의 ID를 사용하며 미지원 값은 `tool`로 표시됩니다.

오류는 `{ok:false,error:"설명"}` 형식입니다. 401은 인증 실패, 403은 Origin/Host 거부, 400은 잘못된 데이터나 버전·revision 등 요청 오류, 413은 요청 크기 초과입니다. 400을 받으면 같은 잘못된 데이터를 반복 전송하지 말고 수정하세요.

모든 크기는 UTF-8 기준입니다. 메타데이터는 최대 16 KiB, 문서는 256 KiB, HTTP 본문은 512 KiB입니다. 문서 항목은 최대 32개, 등록 도구는 최대 32개입니다. 메시지 하나에 합쳐 첨부할 수 있는 외부 데이터는 최대 96 KiB이므로 실제 선택은 충분히 작게 유지하세요. 문자열 상한은 manifest의 id 128바이트, name/instanceId 각각 160바이트, version 80바이트, icon 128바이트, 항목의 id/kind 각각 128바이트, title 240바이트입니다.

## 6. 사용자에게 설명할 사용법과 완료 확인

1. 구현한 프로그램과 AgentCodeGUI를 실행하고 도구가 연결 목록에 나타나는지 확인합니다.
2. 세션 상단의 도구 연결에서 선택하고, 프로그램의 실제 선택을 바꿔 입력창 위 표시가 갱신되는지 확인합니다.
3. 선택을 해제했을 때 이전 내용이 사라지는지 확인합니다.
4. 메시지를 보내면 그 순간의 선택·상태가 복사됩니다. 이후 프로그램 선택을 바꾸어도 이미 보낸 첨부는 바뀌지 않아야 합니다.
5. ‘다음 메시지에 포함’을 끄면 선택 내용만 제외되고 도구 상태는 전달됩니다. 연결 목록의 ON/OFF는 해당 도구의 선택과 상태를 함께 제어합니다. ×는 해당 세션에서만 연결을 해제합니다.
6. 같은 도구를 여러 세션에 연결하고 개별 ON/OFF·해제가 다른 세션에 영향을 주지 않는지 확인합니다.
7. AgentCodeGUI를 재시작해 자동 재연결과 최신 내용 재발행을 확인합니다.

구현 후 변경한 파일, 프로그램에서 사용자가 누를 위치, 실행 방법, 실제 확인한 결과와 아직 확인하지 못한 항목을 알려주세요. AgentCodeGUI가 설치되지 않았거나 실행되지 않아 실제 연결을 확인할 수 없다면 그 사실을 구분해 설명하세요.

## 7. 실행 가능한 Node.js 참고 코드

아래 두 코드 블록을 같은 폴더의 `client.mjs`와 `connect-example.mjs`로 저장하세요. Node.js 22 이상에서 `node connect-example.mjs`로 실행하고 Ctrl+C로 종료합니다. 외부 패키지는 필요 없습니다. AgentCodeGUI의 도구 연결 목록에 **My Tool**이 나타납니다.

이는 고정된 샘플 선택을 보내는 예제입니다. 실제 연동에서는 `connect-example.mjs`의 manifest를 내 프로그램에 맞게 바꾸고, 실제 선택·문서·상태 변경 이벤트에서 `client.publish(...)`를 호출하세요. Node 이외의 언어라면 위 HTTP 규약으로 같은 동작을 구현하면 됩니다. 참고 코드는 자동 연결·재연결, 최신 값 병합, 순차 발행과 종료 처리를 포함합니다.
