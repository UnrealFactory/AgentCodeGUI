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
  '2.0.5': {
    eyebrow: 'FIX',
    lead: '가장자리에서 잘리던 것 둘을 폈습니다.',
    notes: [
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
  '2.0.2': {
    eyebrow: 'UPDATE',
    lead: '쓰다 보면 걸리던 결들을 다듬었습니다.',
    notes: [
      {
        tag: 'GPT · 웹 검색',
        name: '무엇을 검색했는지 보여요',
        desc: (
          <>
            GPT의 <b>WebSearch 행에 실제 검색어</b>가 표시됩니다 — 검색어가 완료 시점에야
            확정되는 프로토콜이라, 실행 중엔 '검색 중…'이었다가 끝나면 검색어로 정착해요.
            검색이 아닌 열람 동작은 <b>'검색한 페이지 열람'</b>으로 구분합니다.
          </>
        )
      },
      {
        tag: 'GPT · 터미널',
        name: '백그라운드 명령도, 로그가 남아요',
        desc: (
          <>
            백그라운드 세션으로 넘어갔다 끝난 명령의 행이 이제 <b>최종 출력·실제 소요·성패</b>로
            되살아납니다 — 행을 클릭하면 <b>전체 로그</b>를 볼 수 있어요. 어떤 Bash 행은 클릭되고
            어떤 행은 안 되던 미스터리의 답이었습니다.
          </>
        )
      },
      {
        tag: '계정 한도',
        name: '언제 풀리는지, 게이지 옆에',
        desc: (
          <>
            설정 계정 카드의 한도 게이지 옆에 <b>초기화 시점</b>이 붙었어요 — 5시간 창은{' '}
            <b>남은 시간</b>('2시간 10분 뒤'), 주간·Fable은 <b>날짜와 시각</b>('7/18 (토)
            15:00'). Anthropic·OpenAI 카드 모두요.
          </>
        )
      },
      {
        tag: '컴포저',
        name: '길게 쓰면, 넓게 써져요',
        desc: (
          <>
            입력이 <b>두 줄 이상으로 자라면</b> 입력칸이 첫 줄 전체 폭을 차지하고 모델 칩·보내기가
            아랫줄로 내려갑니다 — 긴 모델·계정 요약이 글을 중간에 꺾던 문제의 해법. 한 줄일 땐
            기존 모습 그대로예요.
          </>
        )
      },
      {
        tag: '패치노트',
        name: '릴리즈마다, 한 장씩',
        desc: (
          <>
            지금 보고 계신 이 카드에 <b>버전 버튼</b>이 생겼어요 — 릴리즈별로 노트를 나눠 보고,
            최신 5개까지 오갈 수 있습니다.
          </>
        )
      }
    ]
  },
  '2.0.1': {
    eyebrow: 'UPDATE',
    lead: '작업표시줄까지, 마스코트 얼굴로.',
    notes: [
      {
        tag: '아이콘',
        name: '작업표시줄에도, 마스코트가',
        desc: (
          <>
            앱 아이콘과 설치 마법사 아트가 <b>마스코트 브랜드</b>로 바뀌었어요 — 다크 카드 위
            근백색 로봇. 작업표시줄·바로가기·우클릭 메뉴·설치 화면 어디서나 같은 얼굴입니다.
          </>
        )
      }
    ]
  }
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
          <button className="pn-x" onClick={close} title="닫기">
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
