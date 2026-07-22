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
  '2.0.12': {
    eyebrow: 'FIX',
    lead: 'AI가 생각하는 동안 뜨는 표시를 두 엔진 모두 우리 고유의 모습으로 통일하고, 답이 나오기 전까지 끊기지 않게 다듬었어요 — 마스코트가 그려지고 문구가 흐르고 초가 세지는 그 표시요.',
    notes: [
      {
        tag: '생각 표시',
        name: '생각하는 동안, 두 엔진 모두 같은 모습으로',
        desc: (
          <>
            GPT(Codex)로 대화할 때 생각 줄에 <b>모델이 속으로 적는 영어 메모</b>가 그대로
            튀어나와, 우리 표시와 따로 놀았어요. 이제 Claude·GPT <b>어느 쪽이든</b>{' '}
            <b>마스코트 + 우리 문구 + 경과 초</b>로 통일됩니다 — 모델이 안에서 뭐라 적든,
            화면엔 늘 같은 모습이에요.
          </>
        )
      },
      {
        tag: '생각 표시',
        name: '떴다 사라지던 깜빡임 정리',
        desc: (
          <>
            답이 한 번 나온 뒤 AI가 <b>말없이 다음 일을 준비하는 짧은 구간</b>에서 그 표시가
            사라졌다 다시 뜨곤 했어요. 이제 <b>답이 실제로 흐르는 동안</b>에만 잠깐 비켜서고,
            생각·도구·준비 구간에는 계속 떠 있어 <b>지금 돌고 있다는 신호</b>가 끊기지 않습니다.
          </>
        )
      }
    ]
  },
  '2.0.11': {
    eyebrow: 'FIX',
    lead: '파일 탐색기를 보는 동안에도 이제 설정을 열 수 있어요 — 채팅 사이드바 아래에만 있던 설정 진입점을, 탐색기 맨 아래에도 똑같은 모양으로 놓았습니다.',
    notes: [
      {
        tag: '탐색기',
        name: '탐색기에서도 설정을 열어요',
        desc: (
          <>
            왼쪽을 <b>파일 탐색기</b>로 바꾸면 채팅 사이드바가 사라지면서, 그 아래 있던{' '}
            <b>설정 진입점</b>도 같이 사라져 설정을 열려면 다시 사이드바로 돌아가야 했어요.
            이제 탐색기 <b>맨 아래</b>에도 사이드바와 똑같은 프로필 행(아바타·이름·톱니)이
            붙어, 어느 쪽을 보고 있든 바로 설정을 열 수 있습니다.
          </>
        )
      }
    ]
  },
  '2.0.10': {
    eyebrow: 'FIX',
    lead: 'AI가 고친 C# 코드가 다른 파일의 색칠에 안 반영되던 구멍을 여러 갈래로 막았습니다 — 한 번 봤던 파일의 외부 변경, 폴더 밖 프로젝트, 빌드된 DLL 참조까지. 제네릭 타입 호버 카드의 치환 줄도 코드 색 그대로 한 행에 정리했어요.',
    notes: [
      {
        tag: 'C#',
        name: '한 번 봤던 파일의 변화도, 색에 바로',
        desc: (
          <>
            코드 창에서 <b>한 번 열어봤던 C# 파일</b>을 AI가 나중에 고치면 — 예를 들어
            어트리뷰트에 새 필드를 추가하면 — 분석 서버가 <b>옛날 내용으로 계속 계산</b>해서,
            그 필드를 쓰는 다른 파일에선 색이 영영 안 들어왔어요. 이제 디스크 변화를 열린
            문서에도 즉시 반영하고 다시 분석합니다. 솔루션이 참조하는 <b>폴더 밖 프로젝트</b>의
            외부 변화도 감시에 들어왔고, 플러그인 관리 코드를 <b>빌드된 DLL</b>로 참조하는
            구성에선 그 DLL이 재빌드될 때 분석 서버를 자동 재시작해 새 타입이 색에
            들어옵니다(실측상 재시작만이 통하는 케이스). 빌드 산출물(obj) 변화에 헛분석하던
            것도 걸렀어요.
          </>
        )
      },
      {
        tag: '코드',
        name: '호버 카드의 제네릭, 행으로 정리',
        desc: (
          <>
            제네릭 타입에 마우스를 올리면 카드 본문 끝에 <b>“TKey 은(는) int”</b> 같은
            분석기 원문이 산문처럼 섞여 나왔어요. 이제 <b>GENERIC 행</b>으로 올려 NAME 아래에{' '}
            <b>코드 색 그대로</b>(<code>TKey = int</code>) 정돈해 보여줍니다.
          </>
        )
      }
    ]
  },
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
