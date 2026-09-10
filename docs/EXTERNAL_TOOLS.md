# 외부 도구 연결 · External Tools API v1

외부 프로그램이 선택 내용과 현재 상태를 AgentCodeGUI의 연결된 세션들에 제공하는 로컬 HTTP API입니다. 코드 편집기, 표 편집기, 디자인 도구 또는 자체 프로그램에 작은 연결 모듈을 넣어 사용할 수 있습니다. Node 예제는 `examples/external-tool-lab/client.mjs`에 있습니다. 다른 언어도 HTTP와 JSON만 지원하면 됩니다.

앱의 **설정 → External Tools(외부 도구 연동)**에서 **AI용 연동 지침 복사**를 누르면 개발 AI에게 전달할 규격과 실행 가능한 참고 코드가 함께 복사됩니다. 연결할 프로그램의 프로젝트를 개발하는 AI에게 붙여넣고 원하는 선택 내용과 상태를 알려주세요. 미리보기에서 직접 전체 선택하여 복사할 수도 있습니다. 지침은 앱에 포함되므로 이 저장소나 별도 문서 서버에 접근하지 않아도 읽을 수 있습니다.

복사 지침의 원문은 `docs/EXTERNAL_TOOLS_AI.md`와 영문 `docs/EXTERNAL_TOOLS_AI.en.md`입니다. 앱은 여기에 실제 `client.mjs`와 `connect-example.mjs` 소스를 붙여 전달합니다. 규격을 바꿀 때 두 지침도 함께 갱신해 주세요.

## 사용자 동작

1. 외부 프로그램과 AgentCodeGUI를 실행합니다.
2. 사용할 세션의 헤더에서 **도구 연결**을 열고 도구를 연결합니다. 한 세션에 여러 도구를 연결할 수 있습니다.
3. 선택 내용은 입력창 위에 표시됩니다. 펼치면 원문과 도구 상태를 확인할 수 있습니다.
4. 메시지 전송 또는 예약 시 그 순간 화면에 표시된 선택 내용과 상태를 복사하여 첨부합니다. 이후 선택을 바꾸거나 도구를 끄더라도 이미 보낸 메시지와 예약한 메시지의 첨부는 유지됩니다.

연결 목록에서 도구의 스위치를 끄면 연결을 유지하면서 이후 전송에서 그 도구의 선택 내용과 상태를 모두 제외합니다. 다시 켜면 최신 내용을 가져옵니다. **×**는 해당 세션과의 연결을 해제합니다. 선택 행의 **다음 메시지에 포함** 스위치는 선택 내용만 제어하며 도구 상태는 켜진 도구에서 계속 포함됩니다. 선택 행은 **도구 이름 - 선택 제목**으로 표시하고 선택 제목이 없으면 도구 이름만 표시합니다. 줄을 클릭하면 원문을 펼칠 수 있습니다.

전송한 메시지 위의 도구 첨부는 각각 눌러 독립적으로 펼치거나 접을 수 있습니다. 여러 첨부를 동시에 열어 비교할 수 있으며, 각 첨부에는 해당 메시지를 보낼 때 저장한 선택 내용과 도구 상태가 표시됩니다.

하나의 도구 인스턴스를 여러 세션에 동시에 연결할 수 있습니다. 예를 들어 CodePad를 1·2·3·4번 세션에서 각각 **연결**하면 같은 최신 선택 내용과 상태를 함께 사용할 수 있습니다. 한 세션에서 OFF 또는 ×를 눌러도 다른 세션은 유지됩니다. 선택 내용 포함 여부와 메시지 복사본도 세션별로 독립적입니다. 같은 프로그램의 서로 다른 창을 구분하려면 각 창에 고유한 `instanceId`를 사용합니다. 연결과 세션별 설정은 앱 재시작 후 복원됩니다. 일반 채팅, 다중 세션 화면, 분리된 채팅 창에서 같은 연결을 사용합니다.

이전 단일 연결 설정 파일은 처음 읽을 때 여러 세션을 지원하는 저장 형식(version 2)으로 변환하며, 기존 세션과 ON/OFF·선택 포함 설정을 그대로 보존합니다. HTTP 프로토콜 버전은 계속 1입니다.

도구 업데이트만으로 AI가 실행되지는 않습니다. 이 API는 선택 내용과 도구 상태를 AI에 전달하며, 별도 도구 패널이나 외부 프로그램 제어 기능은 제공하지 않습니다.

## 실행 가능한 예제

Node.js 22 이상에서 저장소 루트 기준으로 실행합니다.

```powershell
node examples/external-tool-lab/server.mjs --open
```

독립된 테스트 창에 코드 선택, 표 행 선택, 임의 JSON 입력, 상태 변경, 아이콘 선택 기능이 있습니다. 세 개의 도구가 앱의 연결 목록에 나타납니다. 종료할 때 창 상단의 **테스트 도구 종료**를 누릅니다.

바탕화면에 예제와 실행 파일을 복사하려면 다음을 실행합니다.

```powershell
node scripts/install-external-tool-lab.mjs
```

생성된 폴더의 **검증 앱과 함께 실행.vbs**는 빌드된 실제 앱과 테스트 도구를 별도 프로필로 함께 엽니다. 이 검증 앱의 답변은 고정된 테스트 응답이며 실제 계정이나 AI를 사용하지 않습니다. `target/debug`의 앱·가짜 CLI·계정 시드 도구가 필요합니다. 터미널에서는 `node scripts/open-external-tools-preview.mjs`로 실행할 수 있습니다.

별도 프로필은 양쪽에 같은 경로를 지정합니다. 예제 서버와 설치 스크립트는 `--app-home=C:\path\to\profile`을 받습니다. 기본 프로필은 `%USERPROFILE%\.agentcodegui3`, 환경 변수는 `CCG_HOME`입니다. 외부 도구 연결 기능이 포함된 네이티브 앱 빌드가 필요합니다.

## Node 연결 모듈

```js
import { ExternalToolClient } from './client.mjs'

const client = new ExternalToolClient({
  id: 'com.example.editor',
  instanceId: 'workspace-42', // 재시작해도 유지되는 창/작업공간 식별자
  name: 'My Editor',
  version: '1.0.0',
  icon: 'code'
})
client.on('status', status => {
  // connected, bindings: [{chatId, enabled, includeSelection}], revision, error
  console.log(status.connected, status.enabled)
})
client.start()

// 선택 변경, 활성 문서 변경, 작업 상태 변경 시 호출합니다.
await client.publish({
  items: [{
    id: 'selection', kind: 'code/selection', title: 'checkout.ts · 12–18행',
    text: 'const total = calculateTotal(items)',
    uri: 'file:///C:/project/checkout.ts',
    range: { startLine: 12, endLine: 18 }
  }],
  state: { activeFile: 'checkout.ts', unsavedChanges: true, taskStatus: 'idle' }
})

// 선택이 없으면 items: []로 보냅니다. 상태는 계속 제공할 수 있습니다.
// 빠른 선택 변경은 최신 값으로 병합되고, 앱 재시작 후 자동 재연결됩니다.
// 종료 시: await client.close()
```

`kind`는 프로그램이 정하는 문자열입니다. `text`는 원문, `data`는 표·객체·배열 등 JSON 데이터에 사용합니다. `state`도 임의 JSON입니다. 항목의 `uri`, `range` 등 확장 필드는 보존됩니다. 모델이 필요한 정보는 `items` 또는 `state`에 넣으세요. 문서 최상위의 별도 확장 필드는 저장할 수 있으나 메시지 첨부에는 포함되지 않습니다.

## HTTP 계약

앱은 `127.0.0.1`의 임의 포트에서 수신하고 앱 데이터 폴더의 `external-bridge.json`에 검색 정보를 씁니다.

```json
{"protocolVersion":1,"url":"http://127.0.0.1:12345","token":"<bootstrap credential>","pid":1234}
```

검색 파일의 토큰을 `Authorization: Bearer <token>`으로 사용합니다. `POST` 요청은 `Content-Type: application/json`을 사용합니다. 인증 정보는 로그에 남기거나 브라우저에 전달하지 마세요.

| 메서드·경로 | 인증 | 요청 또는 응답 |
| --- | --- | --- |
| `GET /v1` | 검색 파일 토큰 | 프로토콜 버전과 기능 목록 |
| `GET /v1/icons` | 검색 파일 토큰 | `icons: [{id, ko, en, path}]` |
| `POST /v1/connect` | 검색 파일 토큰 | `{protocolVersion:1, manifest:{id,instanceId,name,icon,version}}` |
| `POST /v1/clients/:id/publish` | 등록 후 발급된 토큰 | `{revision:1, document:{items:[],state:{}}}` |
| `POST /v1/clients/:id/manifest` | 등록 후 발급된 토큰 | `{manifest:{id,instanceId,name,icon,version}}` 전체 메타데이터 |
| `GET /v1/clients/:id/poll` | 등록 후 발급된 토큰 | 자신의 `bindings: [{chatId,enabled,includeSelection}]`, `revision` |
| `DELETE /v1/clients/:id` | 등록 후 발급된 토큰 | 프로그램 종료 알림 |

등록 응답에는 `clientId`, 별도 `token`, `pollIntervalMs`, `bindings`, `limits`가 포함됩니다. 이후 인스턴스 요청에는 등록 토큰을 사용합니다. 다른 인스턴스의 토큰이나 검색 파일 토큰으로 인스턴스 API를 호출할 수 없습니다.

등록·poll 응답의 이전 `boundChatId`·`enabled` 필드는 구형 연결 모듈을 위한 요약값으로 유지합니다. `boundChatId`는 켜진 연결 중 하나(모두 꺼져 있으면 연결 중 하나, 없으면 null)를 나타내며 독점 소유 세션을 뜻하지 않습니다. `enabled`는 하나라도 켜져 있으면 true입니다. 새 연결 모듈은 `bindings`를 기준으로 표시해야 합니다. 문서는 한 번만 발행하며 앱이 연결된 세션들에 같은 최신 값을 제공합니다.

`revision`은 등록할 때마다 1부터 시작하는 단조 증가 정수입니다. 등록 중인 동일한 `(id, instanceId)`를 다시 등록하면 오류입니다. 앱 재시작 또는 연결 만료 후 같은 식별자로 등록하면 기존 세션과 스위치 상태를 복원합니다. 메타데이터 변경으로 `id`, `instanceId`를 바꿀 수는 없습니다.

약 1초마다 `poll`을 호출하여 연결을 유지합니다. 15초 동안 응답이 없으면 오프라인으로 표시하고 전송에서 제외합니다. OFF 상태에서도 최신 문서를 보낼 수 있으며, 다시 켤 때 사용됩니다. 검색 파일의 주소·토큰이 바뀌면 새 앱 프로세스에 다시 등록하고 최신 문서를 재발행합니다. 호출 오류는 `{ok:false,error:"..."}`이며 인증 실패는 401, 브라우저 Origin/잘못된 Host는 403, 잘못된 데이터는 400입니다.

API는 브라우저 `Origin` 요청을 허용하지 않습니다. 웹 UI가 있는 외부 프로그램도 예제처럼 자체 로컬 서버에서 네이티브 연결을 수행해야 합니다. 도구 API는 자신과 연결된 세션의 ID·사용 설정만 반환하며 대화 내용, AI 응답, 다른 도구 데이터나 다른 세션 목록은 반환하지 않습니다.

## 아이콘과 데이터 한도

아이콘 ID: `tool`, `code`, `terminal`, `browser`, `document`, `folder`, `table`, `database`, `design`, `image`, `video`, `audio`, `chart`, `package`, `cube`, `git`, `cloud`, `device`, `game`, `workflow`.

생략하거나 지원하지 않는 ID를 보내면 `tool`을 표시합니다. 도구가 SVG나 HTML을 앱에 삽입하지 않고 앱이 제공하는 아이콘을 선택합니다. 원본 카탈로그는 `src/shared/external-tool-icons.json`입니다.

| 항목 | 한도 |
| --- | --- |
| 등록 인스턴스 | 32개 |
| 도구 메타데이터 | 16 KiB |
| 문서 | 256 KiB, 항목 최대 32개·고유 ID |
| HTTP 요청 본문 | 512 KiB |
| 메시지 전체 외부 첨부 | 96 KiB |

크기는 UTF-8 JSON 기준입니다. 선택 내용이 너무 크면 앱은 전송 전에 오류를 표시합니다. 연결 설정에는 이름·아이콘·인스턴스·세션·스위치 상태만 저장하며 토큰과 실시간 문서는 저장하지 않습니다. 전송하거나 예약한 메시지의 복사본은 해당 대화 기록에 저장됩니다.

## 검증

```powershell
npm run typecheck:app
npm run app:build
cargo test -p agentcodegui bridge::tests
cargo test -p ccg-store legacy_bridge::tests
cargo build -p agentcodegui --features custom-protocol
cargo build -p ccg-engine --features fakecli --bin ccg-fakecli
cargo build -p ccg-auth --features cli --bin ccg-auth-probe
node scripts/poc-external-tools.mjs
```

마지막 스크립트는 별도 프로필의 실제 Tauri 앱·독립된 Node 도구·브라우저 선택·CLI 표준입력까지 검사합니다. AI 응답에는 비용이 들지 않는 검증용 CLI를 사용하며, 실제 모델의 답변 품질을 평가하는 테스트는 아닙니다. 결과와 스크린샷은 출력된 `.poc-home-external-tools-*` 폴더에 남습니다.
