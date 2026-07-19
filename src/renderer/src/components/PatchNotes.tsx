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
  '2.0.4': {
    eyebrow: 'UPDATE',
    lead: '이 대화가 쓴 토큰을 이제 눈으로 확인할 수 있어요.',
    notes: [
      {
        tag: '컨텍스트',
        name: '토큰 사용량, 한눈에',
        desc: (
          <>
            컨텍스트 팝오버 맨 아래에 <b>토큰 사용량</b> 행이 생겼습니다 — 대화를 시작한 뒤
            실행이 실제로 보고한 <b>입력·출력·캐시</b> 토큰의 누적이에요. 대화를 닫았다 열어도
            이어지고, 본채팅·추가 채팅 창·멀티 패널 어디서든 보입니다.
          </>
        )
      },
      {
        tag: '모델별 내역',
        name: '어느 모델이 얼마나 썼는지',
        desc: (
          <>
            한 대화에서 <b>모델을 바꿔 썼다면</b>(직접 전환·자동 폴백·서브에이전트·GPT) 모델별
            내역 행이 아래에 갈라져 붙어요 — 각 행 오른쪽 숫자가 그 모델의 총합입니다.
          </>
        )
      },
      {
        tag: '알아두면',
        name: '한도 차감과는 별개예요',
        desc: (
          <>
            주간·5시간 한도는 <b>모델 단가와 캐시 여부로 가중</b>되어 차감되기 때문에 이 숫자와
            정비례하지 않습니다 — 그래서 어림 환산 없이 <b>실측 토큰</b> 그대로 보여드려요.
          </>
        )
      }
    ]
  },
  '2.0.3': {
    eyebrow: 'FIX',
    lead: '오래 숨어 있던 버그 넷을 잡았습니다.',
    notes: [
      {
        tag: '추가 채팅',
        name: '긴 대화도, 스크롤이 살아있어요',
        desc: (
          <>
            추가 채팅 창에서 대화가 창 높이를 넘는 순간 <b>스크롤이 통째로 사라지고</b> 입력창까지
            화면 밖으로 밀려나던 버그를 잡았습니다 — 답변이 길어지면 화면이 멈춘 것처럼 보이던
            바로 그 문제예요. 레이아웃 한 줄이 원인이었습니다.
          </>
        )
      },
      {
        tag: '대화 스크롤',
        name: '스크롤바를 잡아도, 이제 이겨요',
        desc: (
          <>
            답변이 흐르는 동안 <b>스크롤바를 드래그</b>하면 바닥 따라가기가 매 프레임 도로
            끌어내리던 싸움이 끝났습니다 — 잡는 순간 따라가기가 풀리고, <b>바닥에 내려놓으면</b>{' '}
            다시 따라갑니다. 휠과 같은 규칙이에요.
          </>
        )
      },
      {
        tag: '대화 안정성',
        name: "'응답이 없어요' 오보, 그만",
        desc: (
          <>
            분명 답이 오고 있는데 <b>'이번 턴이 응답 없이 끝났어요'</b>가 먼저 뜨던 오발을
            수정했습니다 — 이전 턴의 백그라운드 작업 통지를 새 턴이 먼저 조용히 소화하며 생기던
            가짜 종결이었어요. 진짜로 빈 턴일 때만 안내가 뜹니다.
          </>
        )
      },
      {
        tag: 'GPT · 안정성',
        name: '중지 직후의 메시지도, 안전하게',
        desc: (
          <>
            GPT 턴을 <b>중지한 직후 바로 다음 메시지</b>를 보내면, 늦게 도착한 이전 턴의 종료
            통지가 새 턴을 즉사시킬 수 있던 경계 구멍을 막았습니다 — 턴마다 신분증(id)을 확인해
            남의 통지를 돌려보냅니다.
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
