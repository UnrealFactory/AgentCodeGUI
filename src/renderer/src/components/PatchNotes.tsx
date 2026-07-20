import { ReactNode, useEffect, useState } from 'react'
import { getPref, setPref } from '../lib/prefs'
import { IconClose, IconMascot } from './icons'

// 패치노트 릴리즈 카드 — 버전이 오를 때마다(패치 포함) 첫 실행에 한 번, 메인 위에
// 유리 카드로 뜬다. 2.0에서 풀스크린 소개 두 장(WhatsNew 전체 소개 덱 · UpdateNotes
// 패치노트 페이지)을 은퇴시키고 이 카드 하나로 합쳤다 — 바로 닫아도(✕·Esc·바깥 클릭),
// 스크롤로 끝까지 읽어도 좋게. 닫으면 현재 버전으로 도장(SEEN_KEY)이 찍힌다.
// 비주얼은 qcard 문법을 잇는 카드(캐논: scripts/poc-patchnotes) — 마스코트 헤더 +
// 메탈 그라데이션 시리즈 숫자(등장 때 한 번 스치는 시인) + 넘버 레일 하이라이트 리스트.
export const SEEN_KEY = 'whatsnew.seenVersion' // 예전 화면들과 같은 도장을 이어 쓴다

// '2.0.3' → '2.0' — 노트는 마이너 시리즈 단위로 쓴다 (히어로 숫자도 이 단위)
export function seriesOf(v: string): string {
  return v.split('.').slice(0, 2).join('.')
}

type Note = { tag: string; name: ReactNode; desc: ReactNode }
type Release = { eyebrow: string; lead: ReactNode; notes: Note[] }

// 버전별 패치노트 — 릴리즈마다 여기에 한 덩이씩 얹는다. 카드의 버전 버튼으로
// 오갈 수 있는 건 최신 MAX_VERSIONS개까지 — 그보다 오래된 덩이는 릴리즈 때 지운다.
// 지난 1.x 노트들은 은퇴한 UpdateNotes와 함께 정리했다(이제 보여줄 경로가 없다).
const MAX_VERSIONS = 5
const RELEASES: Record<string, Release> = {
  '2.0.9': {
    eyebrow: 'UPDATE',
    lead: '다른 창에서 일해도 이 창의 유리가 이제 꺼지지 않습니다 — 통째로 회색이 되던 비활성 창이 유리 그대로 남아요. 파일 트리의 선택 표시도 회색 판 대신 담백한 테두리로 바뀌었습니다.',
    notes: [
      {
        tag: '유리',
        name: '다른 창을 봐도, 유리는 그대로',
        desc: (
          <>
            창이 <b>포커스를 잃으면</b> Windows가 아크릴을 꺼버려서 앱이 통째로{' '}
            <b>불투명한 회색</b>으로 변했어요 — 옆에 띄워두고 다른 일을 하면 늘 그 모습이던
            거죠. 이제 포커스가 없어도 유리가 그대로 비칩니다. 본채팅과 <b>추가 채팅 창</b>{' '}
            모두, 전환 순간의 깜빡임도 없이요.
          </>
        )
      },
      {
        tag: '탐색기',
        name: '선택한 파일, 회색 판 대신 테두리로',
        desc: (
          <>
            파일 트리에서 <b>열어둔 파일</b>이 불투명한 회색 덩어리로 깔려 보이던 것을,
            호버와 같은 옅은 톤에 <b>얇은 테두리</b>가 도는 모양으로 바꿨어요 — 마우스를
            치워도 이제 안 못생겼습니다. 파일 검색 결과의 선택 표시도 같이요.
          </>
        )
      }
    ]
  },
  '2.0.8': {
    eyebrow: 'UPDATE',
    lead: '창의 유리 느낌을 이제 직접 조절할 수 있고, AI가 일하는 동안 몇 초째인지 실시간으로 보이며, 코드의 변경 표시는 바뀐 줄만 정확히 짚도록 다시 만들었습니다. 큰 파일에서의 코드 창 타이핑·호버 랙도 크게 걷어냈고, 환경변수에 API 키가 있어도 이제 먼저 물어보고 과금해요.',
    notes: [
      {
        tag: '설정',
        name: 'Display 탭이 생겼어요',
        desc: (
          <>
            설정 › 환경에 <b>Display</b> 탭이 새로 들어왔습니다 — 창의 화면 느낌을 다루는
            자리예요. 첫 손님은 유리 슬라이더입니다.
          </>
        )
      },
      {
        tag: '유리',
        name: '벽지 비침, 내 마음대로',
        desc: (
          <>
            창 뒤가 비치는 정도를 <b>0~100% 슬라이더</b>로 조절해요 — 0이면 완전 불투명,
            올릴수록 아크릴 유리가 잘 비칩니다. <b>기본 50%가 지금까지의 모습 그대로</b>라
            아무것도 안 바꾸면 달라지는 건 없어요. 끌면 그 자리에서 바로 보입니다.
          </>
        )
      },
      {
        tag: '어디서나',
        name: '모든 창이 함께 바뀌어요',
        desc: (
          <>
            본채팅과 <b>추가 채팅 창</b>이 같은 값을 함께 씁니다 — 나란히 띄워도 비침이
            어긋나지 않아요. 정한 값은 <b>재시작해도 유지</b>됩니다.
          </>
        )
      },
      {
        tag: '채팅',
        name: '지금 몇 초째인지 보여요',
        desc: (
          <>
            작업 중 문구 옆에 <b>경과 시간</b>이 실시간으로 흐릅니다 — &ldquo;검색하는 중 ·
            37초&rdquo;처럼요. 질문 카드에 잠시 가려져도 <b>이어서 셉니다</b>. 끝나면 늘
            보던 &ldquo;N초 동안 작업함&rdquo;으로 자연스럽게 이어져요. 본채팅·추가 채팅
            창·멀티 패널 어디서나.
          </>
        )
      },
      {
        tag: '과금',
        name: 'API 키, 이제 먼저 물어봐요',
        desc: (
          <>
            컴퓨터 환경변수에 <b>ANTHROPIC_API_KEY</b>가 설정돼 있으면, 구독으로 보낸
            대화도 조용히 그 키의 <b>API 크레딧으로 과금</b>되던 문제를 잡았어요. 이제 실행
            전에 카드로 물어봅니다 — 승인하면 그 키로, 거절하면 키를 무시하고{' '}
            <b>구독으로</b> 실행해요. 한 번 정하면 같은 키는 다시 묻지 않고, 키가 바뀌면
            다시 확인합니다.
          </>
        )
      },
      {
        tag: '코드',
        name: '바뀐 줄만 정확히 초록으로',
        desc: (
          <>
            파일 보기의 변경 표시가 <b>몇 줄만 고쳐도 파일 전체가 바뀐 것처럼</b> 초록으로
            뭉개지던 문제를 잡았어요 — GPT가 고친 파일, 윈도우 개행(CRLF) 파일, 큰 파일의
            멀리 떨어진 두 곳 수정까지 전부요. 이제 <b>실제로 바뀐 줄만</b> 정확히 짚고,
            옆의 초록 위치 표시·+N −N 숫자도 같은 걸 말합니다.
          </>
        )
      },
      {
        tag: '코드',
        name: '변경 표시 한도, 4천 → 3만 줄',
        desc: (
          <>
            변경이 4천 줄을 넘으면 표시를 접던 한도를 <b>3만 줄</b>로 올렸어요. 표시 계산
            방식을 새로 만들어 비용이 파일 크기가 아니라 <b>바뀐 양에만 비례</b>합니다 —
            3만 줄 파일도 즉시, 예전의 크래시 걱정 없이 안전하게요.
          </>
        )
      },
      {
        tag: '코드',
        name: '저장해도 개행은 그대로',
        desc: (
          <>
            코드 창에서 윈도우 개행(CRLF) 파일을 편집·저장하면 파일 전체 개행이 <b>조용히
            LF로 바뀌어</b> git에 전부 변경으로 잡히던 문제도 함께 잡았어요 — 이제 원본
            개행 그대로 저장됩니다.
          </>
        )
      },
      {
        tag: '성능',
        name: '큰 파일 타이핑, 이제 안 밀려요',
        desc: (
          <>
            코드 편집기가 <b>키를 칠 때마다 파일 전체를 다시 색칠</b>하던 걸 걷어냈어요 —
            이제 타이핑이 잠깐 멈췄을 때 한 번만 칠합니다. 15만 자 문서에서 키 하나에 들던
            비용이 <b>56ms → 0.6ms</b>(실측 약 95배)라, 큰 파일에서도 타이핑이 밀리지
            않아요. 자동완성을 띄운 채 타이핑할 때 분석 서버로 <b>문서 전체를 보내던 것도
            바뀐 조각만</b> 보내도록 다이어트했습니다.
          </>
        )
      },
      {
        tag: '성능',
        name: '긴 파일 호버, 컥 하던 것도',
        desc: (
          <>
            파일 보기에서 <b>호버 카드가 뜨고 질 때마다</b>, 그리고 &ldquo;심볼 분석
            중&rdquo; 표시가 도는 동안 0.8초마다, 수천 줄을 통째로 다시 그리던 걸 재사용으로
            바꿨어요 — 3,700줄 파일 기준 <b>32ms → 2ms</b>(실측 16배). 긴 파일에서 호버할
            때 미세하게 컥 하던 그 순간이 사라집니다.
          </>
        )
      }
    ]
  },
  '2.0.7': {
    eyebrow: 'UPDATE',
    lead: '답변이 흐르는 동안 앱이 하던 헛일을 걷어내 스트리밍이 눈에 띄게 가벼워졌고, 한도 숫자는 어디서나 남은 양을 말해주며, 업데이트 알림은 카드 하나로 정리했습니다.',
    notes: [
      {
        tag: '성능',
        name: '스트리밍, 확 가벼워졌어요',
        desc: (
          <>
            답변 글자가 도착할 때마다 <b>하나씩 따로</b> 전달하고, 화면 전체를 다시 그리고,
            대화 전체를 저장 준비하던 헛일을 걷어냈어요. 이제 글자들을 <b>한 프레임 단위로
            묶어</b> 처리하고, <b>마지막 말풍선만</b> 다시 그립니다. 대화가 길수록, 채팅이
            많을수록, 멀티 패널이 여럿 돌수록 심해지던 랙이 사라져요 — 스트리밍 중에
            입력칸 타이핑이나 스크롤도 함께 매끄러워집니다.
          </>
        )
      },
      {
        tag: '로봇',
        name: '작업 중 로봇, 매끄럽게 그려져요',
        desc: (
          <>
            작업 중 표시의 로봇이 그려지는 동안 <b>아직 안 그린 획의 시작점이 점으로 미리
            떠 보이거나 깜빡이던</b> 문제를 잡았어요. 이제 <b>몸통 → 귀 → 더듬이 → 눈</b>{' '}
            순서로 각 획이 배어들 듯 이어지고, 완성된 얼굴이 <b>잠깐 머문 뒤</b> 사라집니다.
          </>
        )
      },
      {
        tag: '한도',
        name: '한도 숫자, 쓴 양일까 남은 양일까',
        desc: (
          <>
            설정 → Account의 계정 게이지, 채팅의 컨텍스트 팝오버, 계정 선택 목록 — 한도
            숫자가 <b>쓴 양인지 남은 양인지</b> 표시가 없어 헷갈렸어요. 이제 어디서나{' '}
            <b>&ldquo;n% 남음&rdquo;</b> 한 가지로 표기됩니다. 남은 양이 <b>40% 이하면 주황,
            10% 이하면 빨강</b>으로 바와 숫자가 물들어, 거의 빈 배터리처럼 한눈에 읽혀요.
          </>
        )
      },
      {
        tag: '업데이트',
        name: '업데이트 알림은 카드 하나로',
        desc: (
          <>
            새 버전이 나오면 사이드바 하단에 <b>옛 업데이트 바</b>가 알림 카드와 별개로 하나
            더 떠서, 눌러 보면 결국 같은 카드가 열리는 <b>중복 알림</b>이었어요 — 옛 바를
            정리해 이제 새 버전 안내는 유리 카드 하나로만 옵니다.
          </>
        )
      }
    ]
  },
  '2.0.6': {
    eyebrow: 'FIX',
    lead: '앱이 사라질 수 있던 업데이트 사고를 막고, 엔진 자동 업데이트가 헛도는 일을 잡았습니다.',
    notes: [
      {
        tag: '업데이트',
        name: '앱이 사라지던 업데이트 사고, 이제 없어요',
        desc: (
          <>
            새 버전이 받아진 상태로 앱을 닫으면 <b>화면에 아무것도 없이</b> 설치가 뒤에서
            돌았는데, 그 사이 PC를 끄면 이전 버전은 지워지고 새 버전은 깔리지 못해 <b>앱이
            통째로 사라질 수</b> 있었어요. 이제 설치는 업데이트 카드의 <b>업데이트 버튼</b>을
            눌렀을 때만, 진행이 보이는 채로 이뤄집니다 — 앱을 닫고 바로 PC를 꺼도 안전해요.
            받아둔 업데이트는 남아 있다가 버튼을 누르면 다시 받지 않고 바로 적용됩니다.
          </>
        )
      },
      {
        tag: '엔진',
        name: '매번 돌아오던 엔진 업데이트 카드 종료',
        desc: (
          <>
            <b>프리뷰 버전</b>을 쓰고 있으면 시작할 때마다 엔진 업데이트가 정식 버전을
            설치했다가 <b>정리 단계가 도로 지우는</b> 일을 끝없이 반복했어요 — 이제 쓰는
            버전이 정식보다 새로우면 그대로 둡니다.
          </>
        )
      }
    ]
  },
  '2.0.5': {
    eyebrow: 'UPDATE',
    lead: '멀티 채팅에 파일 탐색기가 들어오고, 사이드바 폭을 끌어서 조절할 수 있게 되고, 창 유리가 더 살아나고, C# 분석이 새 파일을 놓치지 않게 됐습니다.',
    notes: [
      {
        tag: '파일 탐색기',
        name: '멀티 채팅에도, 파일 탐색기',
        desc: (
          <>
            멀티 뷰에서도 <b>` 키</b>나 헤더의 <b>탐색기 버튼</b>으로 왼쪽 사이드바가 파일
            탐색기로 전환됩니다 — 트리는 <b>마지막으로 클릭한 패널</b>의 작업 폴더를 따라가요.
            다른 패널을 클릭하면 트리도 그 패널 폴더로 바뀌고, 파일을 열면 그 패널의 변경
            표시(diff)와 함께 보입니다. 변경 파일 배지와 우클릭 '변경된 파일 보기'도 그 패널
            기준이에요.
          </>
        )
      },
      {
        tag: '사이드바',
        name: '사이드바 폭, 내 마음대로',
        desc: (
          <>
            사이드바(파일 탐색기)의 <b>오른쪽 경계를 드래그</b>해 폭을 조절할 수 있습니다 —
            정한 폭은 다음 실행에도 기억돼요. 경계를 <b>더블클릭</b>하면 기본 폭으로
            돌아옵니다.
          </>
        )
      },
      {
        tag: '유리',
        name: '유리가 진짜 유리처럼',
        desc: (
          <>
            사이드바가 창 뒤를 <b>10%만 비추던 틴트</b> 때문에 어두운 배경화면에서는 아크릴
            유리가 <b>사실상 불투명하게</b> 보였어요 — 통과율을 30%로 올려 이제 어떤
            배경화면에서도 창 뒤가 은은히 비칩니다. 유리는 뒤에 보이는 것을 비추는 재질이라,
            밝은 벽지일수록 더 살아나요.
          </>
        )
      },
      {
        tag: '계정 카드',
        name: "'기본' 배지, 제자리에",
        desc: (
          <>
            설정 → Account에서 이메일이 길거나 창이 좁으면 <b>기본 배지가 다음 줄로 내려가고</b>{' '}
            삭제·기본으로 버튼이 <b>카드 밖으로 밀려 잘리던</b> 문제를 잡았습니다 — 이제
            이메일만 말줄임(…)되고 배지·게이지·버튼은 늘 제자리예요. 그래도 좁으면 게이지와
            버튼이 둘째 줄로 내려앉아 아무것도 잘리지 않습니다.
          </>
        )
      },
      {
        tag: '멀티',
        name: '팝오버가 사이드바 밑으로 숨지 않아요',
        desc: (
          <>
            좁은 멀티 패널에서 작업 바의 <b>컨텍스트 팝오버</b>와 헤더의 <b>폴더 팝오버</b>가
            패널 밖으로 나가 <b>왼쪽이 뜯긴 채 사이드바 밑으로 들어간 것처럼</b> 보이던 버그를
            수정했습니다 — 이제 팝오버가 패널 폭에 맞춰 항상 자기 패널 안에 뜹니다.
          </>
        )
      },
      {
        tag: 'C#',
        name: '새로 생긴 C# 파일도 곧장 색인',
        desc: (
          <>
            에이전트가 <b>명령어(Bash)로</b> 파일을 만들거나 외부 도구가 <b>앱 밖에서</b> C#
            파일을 만들고 고쳐도, 이제 코드 뷰어의 색·호버가 곧장 따라옵니다 — 열려 있던
            문서도 재열람 없이 새 타입의 색을 받아요. <b>GPT</b>가 고친 파일이 분석에 반영되지
            않던 것과, <b>솔루션 파일이 앱 밖에서 재생성</b>돼 새 프로젝트가 생겨도 미리 떠
            있던 분석 서버가 이를 놓치던 문제도 함께 잡았습니다.
          </>
        )
      },
      {
        tag: 'C#',
        name: 'Build.cs를 열어도 이제 가볍게',
        desc: (
          <>
            언리얼 프로젝트의 <b>Build.cs·Target.cs</b>를 열면 루트의 자동 생성 솔루션(엔진
            자동화 프로젝트 수십 개)을 통째로 인덱싱하느라 <b>몇 분씩 '분석 중'</b>이 뜨던
            것을, 이 파일들의 진짜 주인인 <b>룰 전용 프로젝트</b>만 열도록 바꿨습니다 — 몇 초
            만에 색·호버가 나와요. 소속 프로젝트가 없는 낱 C# 파일도 더는 그 거대 솔루션을
            깨우지 않습니다.
          </>
        )
      }
    ]
  },
}

// 카드가 보여줄 버전 목록 — 최신부터, 최대 MAX_VERSIONS개 (가독성 캡)
function noteVersions(): string[] {
  return Object.keys(RELEASES)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .slice(0, MAX_VERSIONS)
}

export function PatchNotes(): ReactNode {
  const [version, setVersion] = useState<string | null>(null)
  // 보고 있는 릴리즈 — 버전 버튼으로 오간다. null = 아직 결정 전(카드 열릴 때 채움)
  const [sel, setSel] = useState<string | null>(null)

  // decide only once the REAL version arrives — comparing against the pre-IPC
  // fallback would flash the card for users who have already seen this version.
  // 도장(마지막으로 본 버전)과 현재 버전이 다르면 연다 — 새 설치(도장 없음)도 포함.
  useEffect(() => {
    window.api.app
      .getVersion()
      .then((v) => {
        if (!v) return
        if (getPref<string>(SEEN_KEY, '') === v) return
        setVersion(v)
        // 처음 보여줄 릴리즈: 현재 버전의 노트가 있으면 그것, 없으면 최신 노트
        setSel(RELEASES[v] ? v : noteVersions()[0])
      })
      .catch(() => {})
  }, [])

  const close = (): void => {
    if (version) setPref(SEEN_KEY, version)
    setVersion(null)
  }

  useEffect(() => {
    if (!version) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [version])

  if (!version) return null

  const versions = noteVersions()
  const cur = sel && RELEASES[sel] ? sel : versions[0]
  const rel = RELEASES[cur]
  const series = seriesOf(cur)

  return (
    <div className="pn-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pncard" role="dialog" aria-label="업데이트 소식">
        <div className="pn-head">
          <IconMascot size={18} />
          <span className="pn-hl">업데이트 소식</span>
          <span className="pn-sp" />
          <span className="pn-verpill">v{version}</span>
          <button className="pn-x" onClick={close} aria-label="닫기">
            <IconClose size={13} />
          </button>
        </div>

        <div className="pn-hero">
          {/* 마스코트 워터마크 — 히어로 우측에 크게, 숨결처럼 옅게 */}
          <IconMascot className="pn-wm" stroke={1.1} aria-hidden="true" />
          <div className="pn-eyebrow">{rel.eyebrow}</div>
          <div className="pn-ver">
            {series}
            {/* 등장 때 딱 한 번 스치는 시인 — 같은 숫자를 겹쳐 그라데이션만 흐른다 */}
            <span className="pn-sheen" aria-hidden="true">
              {series}
            </span>
          </div>
          <p className="pn-lead">{rel.lead}</p>
        </div>

        {/* 릴리즈 선택 — 시리즈 안의 버전들을 페이지처럼 오간다 (최신 5개까지) */}
        {versions.length > 1 && (
          <div className="pn-vers">
            {versions.map((v) => (
              <button key={v} className={'pn-vbtn' + (v === cur ? ' on' : '')} onClick={() => setSel(v)}>
                v{v}
              </button>
            ))}
          </div>
        )}

        {/* key=버전 — 릴리즈를 바꾸면 스크롤이 맨 위에서 다시 시작한다 */}
        <div className="pn-scroll" key={cur}>
          {rel.notes.map((n, i) => (
            <article key={i} className="pn-item">
              <div className="pn-num">{String(i + 1).padStart(2, '0')}</div>
              <div>
                <span className="pn-tag">{n.tag}</span>
                <h3 className="pn-name">{n.name}</h3>
                <p className="pn-desc">{n.desc}</p>
              </div>
            </article>
          ))}
        </div>

        <div className="pn-foot">
          <span className="pn-hint">닫으면 이 버전 소식은 다시 뜨지 않아요</span>
          <button className="pn-go" onClick={close} autoFocus>
            시작하기
          </button>
        </div>
      </div>
    </div>
  )
}
