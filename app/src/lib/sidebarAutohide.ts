// 사이드바 자동 숨김 — 설정 키·기본값·변경 이벤트 (App·Settings 공용 단일 소스).
// App은 왼쪽 칼럼(.lcol)을 오버레이로 접었다 왼쪽 가장자리 호버에 펼치고,
// Settings › Display의 토글/슬라이더가 값을 바꾸면 이 이벤트로 App이 즉시 다시 읽는다.
export const SIDEBAR_AUTOHIDE = 'sidebar.autohide'
export const SIDEBAR_AUTOHIDE_TRIGGER = 'sidebar.autohide.trigger'

// 자동 숨김 기본값 — 켜짐(설정에서 끄기 전까지 사이드바를 접어 둔다).
export const AUTOHIDE_DEFAULT = true

// 감지 폭 = 왼쪽 가장자리에서 이만큼 안쪽까지 마우스가 오면 펼친다(px).
export const AUTOHIDE_TRIGGER_DEFAULT = 50
export const AUTOHIDE_TRIGGER_MIN = 0
export const AUTOHIDE_TRIGGER_MAX = 100

// 설정 변경 → 메인 창 재읽기 신호 (프로필 변경 ccg-profile-changed와 같은 결).
export const SIDEBAR_AUTOHIDE_EVENT = 'ccg-sidebar-autohide-changed'

// 감지 폭 미리보기 — 설정에서 슬라이더를 만지는 동안 메인 창 왼쪽 가장자리에 그 폭만큼
// 띠를 띄워 '이 범위 안에 마우스가 오면 펼쳐진다'를 눈으로 보여준다.
// detail: { active: boolean; value: number } — active=false면 살짝 뒤 사라짐.
export const SIDEBAR_AUTOHIDE_TRIGGER_PREVIEW_EVENT = 'ccg-autohide-trigger-preview'
export type AutohideTriggerPreviewDetail = { active: boolean; value: number }
