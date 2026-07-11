import type { SVGProps } from 'react'

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'stroke'> & { size?: number; stroke?: number }

function Icon({ size = 18, stroke = 1.6, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
)
export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={11} cy={11} r={7} />
    <path d="M21 21l-4.3-4.3" />
  </Icon>
)
// 계정 — 사람 실루엣 (설정 → 계정 탭)
export const IconUser = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={12} cy={8} r={4} />
    <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
  </Icon>
)
// 필터 — 줄어드는 가로선 3개. "Verse 위주로 보기" 토글에 쓴다(앱의 라인아트 톤 유지)
export const IconFilter = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 5h18" />
    <path d="M6 12h12" />
    <path d="M10 19h4" />
  </Icon>
)
export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <rect x={9} y={9} width={11} height={11} rx={2.5} />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Icon>
)
export const IconChevDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
)
export const IconChevRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
)
export const IconChevLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Icon>
)
// 사이드 패널(탐색기) 토글 — 좌측 칼럼이 그어진 패널. "패널 보이기/숨기기"의 통념 아이콘
export const IconPanelLeft = (p: IconProps) => (
  <Icon {...p}>
    <rect x={3} y={4} width={18} height={16} rx={2} />
    <path d="M9 4v16" />
  </Icon>
)
export const IconImage = (p: IconProps) => (
  <Icon {...p}>
    <rect x={3} y={3} width={18} height={18} rx={2.5} />
    <circle cx={8.5} cy={8.5} r={1.6} />
    <path d="M21 15l-5-5L5 21" />
  </Icon>
)
export const IconSend = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 19V5" />
    <path d="M5 12l7-7 7 7" />
  </Icon>
)
export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 6L9 17l-5-5" />
  </Icon>
)
export const IconFile = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </Icon>
)
export const IconFileText = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8" />
    <path d="M8 17h6" />
  </Icon>
)
export const IconPaperclip = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </Icon>
)
export const IconMore = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={5} cy={12} r={1.4} />
    <circle cx={12} cy={12} r={1.4} />
    <circle cx={19} cy={12} r={1.4} />
  </Icon>
)
export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </Icon>
)
export const IconList = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 6h13" />
    <path d="M8 12h13" />
    <path d="M8 18h13" />
    <path d="M3 6h.01" />
    <path d="M3 12h.01" />
    <path d="M3 18h.01" />
  </Icon>
)
// collapse toward the centre (two chevrons meeting) — used for /compact
export const IconCompress = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 5l7 5 7-5" />
    <path d="M5 19l7-5 7 5" />
  </Icon>
)
export const IconX2 = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 6L6 18" />
    <path d="M6 6l12 12" />
  </Icon>
)
export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
)
export const IconShieldChk = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
)
export const IconClipList = (p: IconProps) => (
  <Icon {...p}>
    <rect x={8} y={2} width={8} height={4} rx={1} />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M9 12h6" />
    <path d="M9 16h4" />
  </Icon>
)
export const IconCheckCirc = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={12} cy={12} r={9} />
    <path d="M8.5 12.5l2.5 2.5 4.5-5" />
  </Icon>
)
export const IconBolt = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 2L4.5 13.5H11l-1 8.5L18.5 10.5H12z" />
  </Icon>
)
export const IconBot = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 8V4H8" />
    <rect x={4} y={8} width={16} height={12} rx={2} />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M9 13v2" />
    <path d="M15 13v2" />
  </Icon>
)
export const IconTerminal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 17l6-6-6-6" />
    <path d="M12 19h7" />
  </Icon>
)
export const IconEye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx={12} cy={12} r={3} />
  </Icon>
)
// 별표 — 설정 Explorer의 확장자(*.ext) 섹션
export const IconAsterisk = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14" />
    <path d="M6 8.5l12 7" />
    <path d="M18 8.5l-12 7" />
  </Icon>
)
// 눈에 사선 — 탐색기 우클릭 '숨김 목록에 추가'
export const IconEyeOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.6 5.3A11 11 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.8" />
    <path d="M6.5 6.5A16.9 16.9 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.4-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="M3 3l18 18" />
  </Icon>
)
export const IconCode = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 8l-4 4 4 4" />
    <path d="M15 8l4 4-4 4" />
  </Icon>
)
export const IconPencil = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Icon>
)
export const IconGlobe = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={12} cy={12} r={9} />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
  </Icon>
)
export const IconFolder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
)
export const IconFolderOpen = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1" />
    <path d="M3 7v10a2 2 0 0 0 2 2h12.2a2 2 0 0 0 1.94-1.5l1.6-6A2 2 0 0 0 18.8 9H7.06a2 2 0 0 0-1.94 1.5z" />
  </Icon>
)
// Epic Verse 로고(V) — 앱 fileicons/verse.svg 그대로. 채움형 글리프라 라인아트 Icon
// 래퍼와 별개로 두고, color(=currentColor·fill)로 코랄 등 원하는 색을 입힌다.
export const IconVerse = ({ size = 16, className, style }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} style={style}>
    <path d="m1 1 7 14 7-14H9l3 2c-1.164 2.334-2.34 4.664-3.5 7-1.507-2.997-3-6-4.5-9z" />
  </svg>
)
export const IconPlug = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />
  </Icon>
)
export const IconWrench = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" />
  </Icon>
)
export const IconMin = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14" />
  </Icon>
)
export const IconMax = (p: IconProps) => (
  <Icon {...p}>
    <rect x={5} y={5} width={14} height={14} rx={1.5} />
  </Icon>
)
export const IconRestore = (p: IconProps) => (
  <Icon {...p}>
    <rect x={4} y={7} width={13} height={13} rx={2} />
    <path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
  </Icon>
)
export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12" />
    <path d="M6 18L18 6" />
  </Icon>
)
export const IconGitBranch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={7} cy={5.5} r={2.6} />
    <circle cx={7} cy={18.5} r={2.6} />
    <circle cx={17} cy={8.5} r={2.6} />
    <path d="M7 8.1v7.8" />
    <path d="M17 11.1c0 3.4-4.5 3.7-7.3 4.6" />
  </Icon>
)
// Matches the Claude mark used in RookissAi-WorkSpace (its Icon.Sparkle).
export const IconClaude = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13" />
  </Icon>
)
export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </Icon>
)
export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={12} cy={12} r={9} />
    <path d="M12 7v5l3 2" />
  </Icon>
)
// 달러 — 설정 → API의 예산(충전액) 카드
export const IconDollar = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2.5v19" />
    <path d="M16.5 6.5H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7" />
  </Icon>
)
// 신용카드 — 컴포저 과금 picker의 '구독'(정액) 옵션
export const IconCard = (p: IconProps) => (
  <Icon {...p}>
    <rect x={2.5} y={5.5} width={19} height={13} rx={2.5} />
    <path d="M2.5 10h19" />
    <path d="M6.5 14.5h4" />
  </Icon>
)
// 열쇠 — 설정 → API (API 키 과금) 탭
export const IconKey = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={7.5} cy={15.5} r={4.5} />
    <path d="M10.8 12.2L21 2" />
    <path d="M15.5 7.5l3 3" />
  </Icon>
)
export const IconServer = (p: IconProps) => (
  <Icon {...p}>
    <rect x={3} y={3} width={18} height={7} rx={2} />
    <rect x={3} y={14} width={18} height={7} rx={2} />
    <path d="M7 6.5h.01" />
    <path d="M7 17.5h.01" />
  </Icon>
)
export const IconBook = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 18.5A2.5 2.5 0 0 1 7.5 16H19V3H7.5A2.5 2.5 0 0 0 5 5.5Z" />
    <path d="M5 18.5A2.5 2.5 0 0 0 7.5 21H19v-5" />
  </Icon>
)
// half-filled circle — the appearance/theme glyph
export const IconContrast = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={12} cy={12} r={9} />
    <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
  </Icon>
)
export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={12} cy={12} r={4} />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
)
export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Icon>
)
// 2×2 panel grid — the multi-agent mode glyph
export const IconGrid = (p: IconProps) => (
  <Icon {...p}>
    <rect x={3} y={3} width={7} height={7} rx={1.5} />
    <rect x={14} y={3} width={7} height={7} rx={1.5} />
    <rect x={3} y={14} width={7} height={7} rx={1.5} />
    <rect x={14} y={14} width={7} height={7} rx={1.5} />
  </Icon>
)
// a single framed panel — the single-mode glyph
export const IconSquare = (p: IconProps) => (
  <Icon {...p}>
    <rect x={4} y={4} width={16} height={16} rx={2.5} />
  </Icon>
)
// speech bubble — the 채팅(pure conversation) mode glyph
export const IconMessage = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
  </Icon>
)
// open a panel to the full-screen modal
export const IconExpand = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M16 3h3a2 2 0 0 1 2 2v3" />
    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </Icon>
)
// 8-ray spark — the per-chat/panel 프롬프트 glyph (ctx menu, sidebar marker, panel chip)
export const IconSpark = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v3" />
    <path d="M12 18v3" />
    <path d="M3 12h3" />
    <path d="M18 12h3" />
    <path d="M5.6 5.6l2.1 2.1" />
    <path d="M16.3 16.3l2.1 2.1" />
    <path d="M5.6 18.4l2.1-2.1" />
    <path d="M16.3 7.7l2.1-2.1" />
  </Icon>
)
export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={12} cy={12} r={10} />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </Icon>
)
// double chevron right — "오른쪽 탭 닫기" (close tabs to the right)
export const IconChevsRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 17 5-5-5-5" />
    <path d="m13 17 5-5-5-5" />
  </Icon>
)
// "✕ ▯ ✕" — the middle tab survives, its neighbours close ("다른 탭 닫기")
export const IconCloseOthers = (p: IconProps) => (
  <Icon {...p}>
    <rect x={9.75} y={6.5} width={4.5} height={11} rx={1.5} />
    <path d="m3 10.5 3 3" />
    <path d="m6 10.5-3 3" />
    <path d="m18 10.5 3 3" />
    <path d="m21 10.5-3 3" />
  </Icon>
)
// 마우스 본체 + 가운데 휠 — 설정 → Gestures 탭
export const IconMouse = (p: IconProps) => (
  <Icon {...p}>
    <rect x={6.5} y={3} width={11} height={18} rx={5.5} />
    <path d="M12 7v4" />
  </Icon>
)
