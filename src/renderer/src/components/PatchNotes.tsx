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
  '2.2.0': {
    eyebrow: 'UPDATE',
    lead: '이제 다른 모니터를 보고 있어도 AI가 끝나면 압니다 — 마우스가 있는 화면에 작은 알림 카드가 뜨고, 클릭하면 그 채팅 앞으로 바로 갑니다. 탐색기에는 Git 카드가 생겨 커밋부터 push까지 앱 안에서 끝나요.',
    notes: [
      {
        tag: '알림',
        name: '눈 돌린 사이 끝나면, 보고 있는 화면으로',
        desc: (
          <>
            다른 모니터에서 일하거나 창을 내려둔 사이 <b>답변이 도착</b>하거나 AI가{' '}
            <b>승인·질문으로 기다리기 시작</b>하면, <b>마우스가 있는 모니터</b> 우하단에 작은
            알림 카드가 뜹니다. 포커스를 뺏지 않고 조용히 떠 있고, 시간이 지나도 혼자
            사라지지 않아요 — 앱을 다시 보는 순간에만 스스로 물러납니다. 여러 채팅의 소식이
            겹치면 <b>한 장에 모아</b> 보여줘요.
          </>
        )
      },
      {
        tag: '알림',
        name: '클릭 한 번이면 그 채팅 앞으로',
        desc: (
          <>
            알림을 <b>클릭하면</b> 앱 창이 있던 자리 그대로 앞으로 나오며 <b>그 채팅으로 바로
            이동</b>합니다 — 일반·멀티·추가 채팅 창 모두요. 모아 보기에선 줄마다 제 채팅으로
            갑니다. 필요 없으면 설정 › Display › 알림에서 끌 수 있어요(기본 켬).
          </>
        )
      },
      {
        tag: 'Git',
        name: '탐색기에 Git 카드',
        desc: (
          <>
            탐색기 하단의 <b>상태 스트립</b>(브랜치·변경 수)을 누르면 <b>Git 카드</b>가
            열립니다 — 변경 파일을 <b>체크해 골라 커밋</b>하고, 히스토리를 훑고,{' '}
            <b>브랜치 전환·생성</b>과 push/pull까지 앱 안에서 끝나요. 파일을 누르면 그
            변경분이 코드 뷰어로 열립니다. 커밋 메시지는 골라둔 변경만 보고{' '}
            <b>AI가 초안</b>해 줍니다.
          </>
        )
      },
      {
        tag: '사이드바',
        name: '옆 모니터로 나가도 얌전히 접혀요',
        desc: (
          <>
            자동 숨김이 켜진 채 마우스가 <b>창 밖(옆 모니터)</b>으로 나가면, 펼쳐진 사이드바가
            접히지 않고 얼어붙던 것을 고쳤습니다 — 듀얼 모니터에서 실제로 겪은 보고예요.
          </>
        )
      }
    ]
  },
  '2.1.0': {
    eyebrow: 'UPDATE',
    lead: '채팅에 집중할 땐 사이드바를 접어 두고, 왼쪽 가장자리에 마우스를 대면 유리처럼 슥 나오게 했어요. 얼마나 가까이 가야 나올지도 정할 수 있고, 맞추는 동안 그 범위가 화면에 그려집니다.',
    notes: [
      {
        tag: '사이드바',
        name: '평소엔 접어 두고, 가장자리에서 슥',
        desc: (
          <>
            채팅·코드에 집중할 때 <b>사이드바를 접어</b> 본문을 더 넓게 쓰고, 왼쪽 가장자리에
            마우스를 대면 <b>유리처럼 떠서</b> 나옵니다 — 본문을 밀지 않고 그 위로 슬라이드해
            멀미 없이 부드러워요. 마우스를 치우면 다시 접혀요. <b>일반·멀티 채팅</b> 모두요.
            기본으로 켜져 있고, 설정 › Display에서 끌 수 있습니다.
          </>
        )
      },
      {
        tag: '사이드바',
        name: '얼마나 가까이 가면 나올지, 눈으로 맞춰요',
        desc: (
          <>
            설정 › Display에 <b>감지 폭</b> 슬라이더가 생겼어요(0~100px, 기본 50) — 가장자리에서
            이만큼 안쪽까지 마우스가 오면 펼쳐집니다. 슬라이더를 <b>만지는 동안</b> 창 왼쪽
            가장자리에 그 범위가 <b>띠로 그려져</b>, 얼마나 넓은지 바로 보며 맞출 수 있어요.
          </>
        )
      }
    ]
  },
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
