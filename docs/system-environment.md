# 시스템 CLI 환경

Settings → Engine에서 Claude Code와 Codex CLI 각각 **앱 관리 / 시스템 환경**을 선택한다.

- 앱 관리: 앱의 CLI 설치·업데이트 및 계정별 인증 폴더를 사용한다.
- 시스템 환경: 설치된 CLI와 기존 설정 폴더를 사용한다. 앱 계정 등록이나 API 키 입력이 필요하지 않으며, 인증과 과금은 해당 CLI 설정에 따른다.

시스템 환경의 CLI 실행 파일과 설정 폴더는 직접 지정할 수 있다. **자동 감지**를 누르면 두 경로를 확인해서 입력칸에 채우고 결과를 표시한다. 감지에 실패하면 입력하던 경로를 유지한다. 변경사항이 있을 때 카드 오른쪽 아래에 **취소 / 저장**이 나타나며, 감지만으로 설정이 저장되지는 않는다.

각 입력칸 오른쪽의 폴더 아이콘으로 실행 파일이나 설정 폴더를 찾아 선택할 수도 있다. 선택 창은 현재 경로에서 열리고, 취소하면 입력값을 유지한다. 선택한 경로는 **저장**을 눌러 적용한다.

빈 경로는 자동 감지를 사용한다. 실행 파일은 PATH와 사용자 `.local/bin`에서 찾고, 설정 폴더는 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`이 있으면 그 값을, 없으면 사용자 홈의 `.claude` / `.codex`를 사용한다. 공백이 있는 경로와 Windows `.cmd` 설치본도 지원한다.

저장 후 앱을 재시작하고 새 대화를 시작한다. 실행 중인 CLI와 예약된 작업에는 저장한 변경을 끼워 넣지 않는다. 이전 대화를 다른 설정 폴더로 잘못 재개하지 않도록 대화별 실행 환경을 기록하며, 환경이 다르면 이전 환경으로 돌아가거나 새 대화를 만들도록 안내한다.

시스템 환경을 선택한 엔진은 앱의 자동 설치·업데이트 대상에서 제외된다. 채팅의 앱 계정·API 과금 선택도 숨기고 시스템 환경 사용을 표시한다. 모델·추론 강도·승인 모드는 채팅에서 선택한 값을 사용한다.

프록시와 인증서 변수(`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` 등)는 앱 프로세스가 상속한 값이 CLI로 전달된다. 시스템 환경에서는 `NODE_OPTIONS`도 제거하지 않는다. PowerShell 프로필처럼 특정 터미널에서만 변수를 설정했다면 그 터미널에서 앱을 시작해야 같은 값을 상속한다.

Codex의 설정·인증 저장 위치는 [공식 OpenAI 문서의 Config and state locations](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations)를 따른다. 기존 설정·인증 파일을 앱 설정 저장 과정에서 덮어쓰지 않는다.

검증: `cargo test -p ccg-engine`, `cargo test -p agentcodegui`, `npm run typecheck:app`, `npm run app:build`. 실제 화면 회귀 검사는 개발 서버와 fakecli 빌드 후 `node scripts/poc-system-environment.mjs`로 실행한다. 격리 홈에서 UI 저장·경로 오류·재시작·두 엔진 응답·설정 폴더 및 환경 변수 상속을 검사하며 실제 계정이나 API를 사용하지 않는다.
