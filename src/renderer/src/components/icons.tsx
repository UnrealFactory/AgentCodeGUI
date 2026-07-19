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
// 한 바퀴 회전(새로고침) — 호 하나+화살촉 하나. 순환 화살표(IconRefresh)는 화살촉 2개가
// 13px쯤에서 호와 뭉개져 덩어리로 보여, 작은 헤더 버튼은 이 단순형을 쓴다
export const IconRotate = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
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
// 왼쪽 +/− 두 줄 + 오른쪽 브래킷 — 변경(diff) 보기 토글 글리프
export const IconDiff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 5v6M4 8h6" />
    <path d="M4 17h6" />
    <path d="M15 4h5v16h-5" />
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
// ── 공식 로고 (simple-icons 경로) — 면(fill) 로고라 스트로크 Icon 래퍼 대신 그대로 그린다.
// 색은 currentColor — 타일/배지의 글자색을 그대로 따른다.
export const LogoClaude = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  </svg>
)
export const LogoOpenAI = ({ size = 18 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
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
// 원 안의 위 화살표 — 사이드바 앱 업데이트 배지
export const IconArrowUpCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={12} cy={12} r={9} />
    <path d="M12 16V8.5" />
    <path d="M8.5 11.5 12 8l3.5 3.5" />
  </Icon>
)
// 바닥선으로 내려오는 화살표 — 업데이트 알림 카드 (PoC .upd 글리프)
export const IconDownload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v11" />
    <path d="M7 10l5 5 5-5" />
    <path d="M4 21h16" />
  </Icon>
)

// ── 2.0 마스코트 로봇 — 브랜드 글리프 (PoC 손제도, 원본 파일 나오면 교체) ──
export const IconMascot = ({ size = 20, stroke = 1.5, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" {...rest}>
    <rect x={5.5} y={8} width={13} height={10} rx={4.5} />
    <circle cx={10.2} cy={13} r={0.95} fill="currentColor" stroke="none" />
    <circle cx={13.8} cy={13} r={0.95} fill="currentColor" stroke="none" />
    <path d="M9.5 8Q9 5.8 7.3 4.9" />
    <circle cx={7} cy={4.7} r={0.85} fill="currentColor" stroke="none" />
    <path d="M14.5 8Q15 5.8 16.7 4.9" />
    <circle cx={17} cy={4.7} r={0.85} fill="currentColor" stroke="none" />
    <path d="M4.4 10.6C3 11.5 3 14.5 4.4 15.4" />
    <path d="M19.6 10.6C21 11.5 21 14.5 19.6 15.4" />
  </svg>
)

// 라이브 작업 인디케이터 — 선부터 그려지는 루프(머리→귀→더듬이→점). CSS .wbot 문법과 짝.
export const IconMascotDraw = ({ size = 20, stroke = 1.5, className, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={('wbot ' + (className ?? '')).trim()} {...rest}>
    <rect className="st d1" pathLength={1} x={5.5} y={8} width={13} height={10} rx={4.5} />
    <path className="st d2" pathLength={1} d="M4.4 10.6C3 11.5 3 14.5 4.4 15.4" />
    <path className="st d2" pathLength={1} d="M19.6 10.6C21 11.5 21 14.5 19.6 15.4" />
    <path className="st d3" pathLength={1} d="M9.5 8Q9 5.8 7.3 4.9" />
    <path className="st d3" pathLength={1} d="M14.5 8Q15 5.8 16.7 4.9" />
    {/* 더듬이 끝점은 더듬이 획이 끝난 직후에, 눈은 맨 마지막에 — 점이 획 없이 먼저 뜨면
        사이클 중간이 조각처럼 보인다 (완성 순서: 몸통 → 귀 → 더듬이·끝점 → 눈) */}
    <circle className="dd" cx={7} cy={4.7} r={0.85} fill="currentColor" stroke="none" />
    <circle className="dd" cx={17} cy={4.7} r={0.85} fill="currentColor" stroke="none" />
    <circle className="de" cx={10.2} cy={13} r={0.95} fill="currentColor" stroke="none" />
    <circle className="de" cx={13.8} cy={13} r={0.95} fill="currentColor" stroke="none" />
  </svg>
)

// 톱니 — 사이드바 하단 계정 줄의 설정 글리프
export const IconGear = (p: IconProps) => (
  <Icon {...p}>
    <circle cx={12} cy={12} r={3} />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Icon>
)

// 오른쪽 패널(탐색기) 토글 — PoC 헤더의 파일 탐색기 버튼
export const IconPanelRight = (p: IconProps) => (
  <Icon {...p} stroke={1.8}>
    <rect x={3} y={4} width={18} height={16} rx={2} />
    <path d="M15 4v16" />
  </Icon>
)
