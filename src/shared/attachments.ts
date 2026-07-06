// 컴포저에 첨부할 수 있는 파일 확장자 — 렌더러(드롭/붙여넣기 필터·칩 렌더)와
// 메인(파일 대화상자 필터·붙여넣기 저장 확장자 검증)이 같은 목록을 공유한다.

/** 썸네일로 보여주고 뷰어로 여는 이미지 첨부 */
export const ATTACH_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']

/** 텍스트로 읽을 수 있는 첨부 — 엔진이 Read 도구로 그대로 읽는다 (문서·데이터·코드·로그) */
export const ATTACH_TEXT_EXTS = [
  // 문서
  'txt', 'md', 'markdown', 'html', 'htm',
  // 데이터·설정
  'json', 'jsonc', 'json5', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'log',
  // 코드
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'java', 'kt', 'rs', 'go', 'swift', 'php', 'rb', 'lua', 'py', 'sql',
  'sh', 'bash', 'bat', 'cmd', 'ps1',
  // 언리얼·기타
  'verse', 'uproject', 'uplugin', 'patch', 'diff'
]
