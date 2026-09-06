# 플랜 승인 전 미리보기

Claude의 `ExitPlanMode` 승인 요청에는 계획을 읽을 수 있는 Markdown 카드가 표시된다. 파일 경로가 있으면 해당 파일을 읽고, 파일 경로 없이 본문이 전달되면 전달된 본문을 표시한다. 긴 계획은 카드 안에서 스크롤하며, 승인 버튼은 아래에 남는다.

파일을 외부에서 수정했다면 **계획 다시 읽기**, 본문을 가져가려면 **계획 복사**를 사용한다. **계획 승인**은 기존의 일회 허용 응답을 보내고, **승인하지 않기**와 Esc는 거부 응답을 보낸다. 계획 카드에서는 숫자 키로 승인하지 않는다. 다른 도구의 일반 승인 화면은 기존 동작을 유지한다.

응답하면 해당 세션 채팅에 질문 답변과 같은 형태로 **계획을 승인했습니다.** 또는 **계획을 거절했습니다.**와 시각을 남긴다. 이 기록은 대화와 함께 저장되며, 일반 채팅·멀티 패널·분리 창에 동일하게 적용된다.

현재 요청의 `input.planFilePath`와 구형 CLI의 `input.plan`을 사용한다. `planFilePath`는 [공식 SDK 변경 기록](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#0276)에 추가된 필드다. 다른 대화의 최신 Markdown 파일을 추측해서 보여주지 않는다. 파일 누락·빈 파일·큰 파일의 일부 표시 여부도 카드에 알린다. 파일 읽기는 기존 파일 IPC의 작업 스레드에서 처리하여 엔진 허브를 막지 않는다.

검증: `cargo test -p agentcodegui engine::wire::tests`, `npm run typecheck:app`, `npm run app:build`. 개발 서버와 fakecli 빌드 후 `node scripts/poc-plan-preview.mjs`로 실제 승인 요청 → 파일 미리보기 → 승인·거부 응답을 검사한다. 실제 계정이나 모델 API를 사용하지 않는다.
