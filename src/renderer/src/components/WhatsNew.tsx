import { ReactNode, useEffect, useState } from 'react'
import { getPref, setPref } from '../lib/prefs'

// "전체 기능 소개" 덱 — 새로 설치한 사람에게 딱 한 번, 우리 앱에 어떤 기능이 있는지
// 한 바퀴 둘러보게 해 준다. 업데이트(버전 상승)로 뜨는 건 여기가 아니라 UpdateNotes가
// 맡는다 — 그래서 이 화면은 "본 적 없는(기록이 전혀 없는) 첫 실행"에만 연다. 닫으면
// 현재 버전으로 도장(SEEN_KEY)이 찍히고, 이후로는 다시 뜨지 않는다.
// 내용은 1.3 시점까지 쌓인 모든 기능을 한 번에 — 개요 → 코드 인텔리전스 → Git →
// 멀티 에이전트 → 대화 → 엔진/마무리.
// 비주얼은 "시네마틱 히어로" 컨셉: 풀스크린 루프 비디오 무대 위에 세리프 대제목
// (영문 Instrument Serif · 한글 Noto Serif KR)과 리퀴드 글래스 내비/칩.
// 기능별 슬라이드로 쪼개져 하단 칩·← →·Enter(CTA)로 한 장씩 넘긴다.
// 닫기는 상단 건너뛰기, 마지막 슬라이드의 시작하기, 또는 Esc.
// SEEN_KEY·seriesOf는 UpdateNotes(업데이트 패치노트)와 공유한다 — 같은 도장을 읽고
// 써서 둘이 같은 실행에 동시에 뜨지 않게 조율한다.
export const SEEN_KEY = 'whatsnew.seenVersion'

// '1.5.3' → '1.5' — 패치노트는 마이너 단위로 같은 내용이므로 이 단위로 비교한다
export function seriesOf(v: string): string {
  return v.split('.').slice(0, 2).join('.')
}

// "전체 기능 소개" 덱 — 역대 버전에서 쌓인 기능을 한 번에 둘러보도록
// 개요 → 코드 인텔리전스 → Git → 멀티 에이전트 → 대화 → 엔진/마무리로 엮었다.
// 비주얼은 기존 "스페이스" 무대를 그대로 — 슬라이드마다 배경 비디오가 바뀐다 (딥 스페이스
// 5종). 전부 CloudFront immutable 캐시라 한 번 받으면 디스크 캐시로 재생; 받기 전/오프라인엔
// 딥 네이비(#010828) 무대가 그대로 깔려 깨지지 않는다.
const CDN = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/'
// 무대 비디오 5종 — 추상적인 딥 스페이스라 어느 기능 슬라이드에든 얹힌다 (개요/마무리는 동일 무대로 북엔드)
const V_HERO = CDN + 'hf_20260331_045634_e1c98c76-1265-4f5c-882a-4276f2080894.mp4'
const V_GIT = CDN + 'hf_20260331_151551_992053d1-3d3e-4b8c-abac-45f22158f411.mp4'
const V_COMMIT = CDN + 'hf_20260331_053923_22c0a6a5-313c-474c-85ff-3b50d25e944a.mp4'
const V_DIFF = CDN + 'hf_20260331_054411_511c1b7a-fb2f-42ef-bf6c-32c0b1a06e79.mp4'
const V_LAYOUT = CDN + 'hf_20260331_055729_72d66327-b59e-4ae9-bb70-de6ccb5ecdb0.mp4'

// 기능 슬라이드 — title의 <em>은 뮤트로 가라앉고, accent는 네온 그린 Condiment
// 필기체(mix-blend-exclusion)로 제목 모서리에 살짝 기울여 얹힌다
type Slide = { chip: string; accent: string; video: string; title: ReactNode; desc: ReactNode }
const SLIDES: Slide[] = [
  {
    chip: '개요',
    accent: 'the launch',
    video: V_HERO,
    title: (
      <>
        코딩 에이전트가,
        <br />
        <em>데스크탑이 됩니다.</em>
      </>
    ),
    desc: (
      <>
        <b>AgentCodeGUI</b>는 이 PC의 Claude Code를 <b>풀 에이전트 모드</b>로 구동하는 데스크탑
        IDE예요. 별도 API 키 없이 기존 로그인 그대로 — <b>채팅·코드·멀티</b> 세 모드, 자체
        탐색기·코드 인텔리전스·Git까지, 지금까지 쌓인 모든 것을 한 장씩 넘겨보세요.
      </>
    )
  },
  {
    chip: '코드 인텔리전스',
    accent: 'read the code',
    video: V_DIFF,
    title: (
      <>
        다른 에디터 없이도,
        <br />
        <em>읽고, 고칩니다.</em>
      </>
    ),
    desc: (
      <>
        내장 파일 탐색기와 <b>LSP 코드 뷰어</b> — 심볼 탐색, Ctrl+F, <b>F12로 정의 이동</b>,
        구조화된 호버 카드와 <b>종류별 아이콘이 붙는 자동완성</b>. <b>읽기·편집 모드</b>를 오가고{' '}
        <b>변경/일반 토글(Ctrl+D)</b>로 diff를 켜고 끄며 제자리에서 고치고, C#·TS·Python은 물론
        언리얼 <b>Verse</b>까지 정의·호버·자동완성을 — <b>공식 문서는 전면 한국어 번역과 카드
        서식</b>(코드 예시 색칠·용어 풀이)으로, 파일을 <b>여는 즉시</b> 반응하고 분석은 디스크
        캐시로 <b>다시 켜도 거의 즉시</b> 떠요. 탐색기는 <b>bin·obj·Saved 같은 빌드 폴더를 숨겨</b>{' '}
        소스만 남기고(설정 Explorer), <b>가장자리를 끌어 폭까지</b> 맞출 수 있어요.
      </>
    )
  },
  {
    chip: '⎇ Git',
    accent: 'git, in a card',
    video: V_GIT,
    title: (
      <>
        브랜치의 흐름이,
        <br />
        <em>한 장의 카드로.</em>
      </>
    ),
    desc: (
      <>
        탐색기 <b>⎇ 버튼</b> 하나로 커밋 히스토리·변경 사항·브랜치/태그가 한 카드에. 변경을 읽어{' '}
        <b>Claude가 커밋 메시지를 짓고</b> 푸시·당겨오기까지, 삭제된 줄은 diff에 <b>빨간 고스트
        줄</b>로 그대로 남아요.
      </>
    )
  },
  {
    chip: '멀티 에이전트',
    accent: 'in parallel',
    video: V_LAYOUT,
    title: (
      <>
        여럿이 한 번에,
        <br />
        <em>동시에 일합니다.</em>
      </>
    ),
    desc: (
      <>
        <b>N개의 패널</b>이 각자 폴더·프롬프트·모델로 동시에 작업해요. 실행 중에도 다음 메시지를{' '}
        <b>예약</b>해 두면 끝나는 대로 순차 전송, <b>세션 단위 작업 목록</b>으로 전체 진행이 한눈에.{' '}
        <b>승인·질문 카드는 물어본 패널 안에</b> 떠서 동시에 여러 개가 와도 안 헷갈리고, 패널{' '}
        <b>폴더 칩을 누르면</b> 그 자리에서 파일 트리가 펼쳐져요.
      </>
    )
  },
  {
    chip: '대화',
    accent: 'every keystroke',
    video: V_COMMIT,
    title: (
      <>
        입력 한 줄까지,
        <br />
        <em>매끄럽게.</em>
      </>
    ),
    desc: (
      <>
        맨 앞 <b>채팅</b> 탭의 폴더 없는 순수 대화부터 — 이미지·텍스트 파일은 <b>붙여넣기·드래그</b>로
        첨부, <b>/ 명령어·스킬</b>과 <b>@ 파일 멘션</b>, <b>↑/↓로 보낸 메시지 복구</b>,{' '}
        <b>Ctrl+F 대화 검색</b>과 <b>Ctrl+휠 글자 크기</b>, 드래그하면 뜨는 복사·“더 자세히” 툴바, 채팅별
        프롬프트까지. 실행 중에도{' '}
        <b>메시지 예약</b>과 <b>/ask 빠른 질문</b>(파일 첨부까지)이 끊김 없이 — 그리고 <b>추가 채팅</b>
        (Ctrl+Shift+N)으로 <b>독립된 대화 창</b>을 하나 더 띄워 코드 옆에서 따로 물어볼 수 있어요.
        <b>작업 폴더</b>와 모델·강도 선택까지 기억해 <b>새 창에도 그대로</b>, 추가 채팅 안에서도{' '}
        <b>/ask</b>가 됩니다. 채팅·코드·멀티 어디서나 똑같이.
      </>
    )
  },
  {
    chip: '과금',
    accent: 'your billing',
    video: V_COMMIT,
    title: (
      <>
        구독으로도,
        <br />
        <em>API 키로도.</em>
      </>
    ),
    desc: (
      <>
        컴포저의 <b>과금 선택</b>으로 실행마다 <b>구독(정액) ↔ API 키(종량)</b>를 오가요 — 멀티는{' '}
        <b>패널마다 따로</b> 골라요. 설정 <b>Account</b>에선 <b>클로드 구독 계정을 여러 개 등록·전환</b>
        (로그인/로그아웃)하고 계정마다 <b>남은 한도(5시간·주간·Fable)</b>를 한눈에 — <b>API</b>에선 키
        (<b>암호화 저장</b>)·예산과 <b>모델별·일별 사용 통계</b>를 관리합니다. API 모드에선 5시간 한도
        대신 <b>대화 비용과 남은 예산</b>이 보여요.
      </>
    )
  },
  {
    chip: '그리고',
    accent: 'ready',
    video: V_HERO,
    title: (
      <>
        엔진까지,
        <br />
        <em>앱 안에서.</em>
      </>
    ),
    desc: (
      <>
        Claude Code 엔진을 <b>인앱에서 설치·전환·정리</b>하고(시스템 설치는 그대로 둬요), 라이트·다크
        테마, 최대화 버튼의 <b>창 스냅 배치</b>, 우클릭 <b>“AgentCodeGUI로 열기”</b>, 자동
        업데이트까지. 자, 이제 <b>시작할 시간</b>이에요.
      </>
    )
  }
]

export function WhatsNew() {
  const [version, setVersion] = useState<string | null>(null)
  const [slide, setSlide] = useState(0)
  const [videoOn, setVideoOn] = useState(false)
  // 슬라이드 비디오가 못 내려오면 첫 장(히어로) 비디오로 폴백 — 무대가 비지 않게
  const [videoErr, setVideoErr] = useState(false)

  // 장이 바뀌면 새 무대가 페이드인으로 떠오른다 (캐시되면 거의 즉시)
  useEffect(() => {
    setVideoOn(false)
    setVideoErr(false)
  }, [slide])

  // decide only once the REAL version arrives — comparing against the pre-IPC
  // fallback would flash the screen for users who have already seen this version.
  // 이 화면은 "전체 기능 소개"라 새로 설치한 사람(도장이 전혀 없는 첫 실행)에게만 연다.
  // 업데이트로 버전이 올라간 경우는 여기 말고 UpdateNotes(업데이트 패치노트)가 맡는다.
  useEffect(() => {
    window.api.app
      .getVersion()
      .then((v) => {
        if (!v) return
        const seen = getPref<string>(SEEN_KEY, '')
        if (seen) return // 이미 본 적 있음(설치 이력 있음) → 소개 덱은 다시 안 뜬다
        setVersion(v)
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
      } else if (e.key === 'ArrowRight') {
        setSlide((s) => Math.min(s + 1, SLIDES.length - 1))
      } else if (e.key === 'ArrowLeft') {
        setSlide((s) => Math.max(s - 1, 0))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [version])

  if (!version) return null

  const cur = SLIDES[slide]
  const last = slide === SLIDES.length - 1
  const videoSrc = videoErr ? SLIDES[0].video : cur.video

  return (
    <div className="set-dialog-overlay wn-overlay">
      {/* 풀스크린 루프 비디오 — 재생이 시작되면 딥 스페이스 무대 위로 떠오른다 */}
      <video
        key={videoSrc}
        className={'wn-video' + (videoOn ? ' on' : '')}
        src={videoSrc}
        autoPlay
        loop
        muted
        playsInline
        onPlaying={() => setVideoOn(true)}
        onError={() => {
          if (!videoErr) setVideoErr(true)
        }}
        aria-hidden="true"
      />
      {/* 밝은 영상 프레임에서도 글자가 또렷하게 — 비디오와 콘텐츠 사이 스크림 */}
      <div className="wn-scrim" aria-hidden="true" />

      <header className="wn-nav">
        <div className="wn-logo">
          Agent Code GUI<sup>v{version}</sup>
        </div>
        <button className="wn-glass wn-nav-cta" onClick={close}>
          건너뛰기
        </button>
      </header>

      {/* key 리마운트로 슬라이드가 바뀔 때마다 fade-rise가 다시 흐른다 */}
      <main className="wn-hero" key={slide}>
        <div className="wn-eyebrow">
          {slide === 0
            ? `Introducing — v${version}`
            : `0${slide} / 0${SLIDES.length - 1} — ${cur.chip}`}
        </div>
        <div className="wn-titlewrap">
          <h1 className="wn-title">{cur.title}</h1>
          {/* 네온 필기체 액센트 — 제목 모서리에 살짝 기울여 얹힌다 (Condiment) */}
          <span className="wn-accent" aria-hidden="true">
            {cur.accent}
          </span>
        </div>
        <p className="wn-desc">{cur.desc}</p>
        <button
          className="wn-glass wn-cta"
          onClick={() => (last ? close() : setSlide(slide + 1))}
          autoFocus
        >
          {last ? '시작하기' : slide === 0 ? '둘러보기' : '다음 이야기'}
        </button>
      </main>

      <footer className="wn-dock">
        {SLIDES.map((s, i) => (
          <button
            key={i}
            className={'wn-glass wn-chip' + (i === slide ? ' on' : '')}
            onClick={() => setSlide(i)}
          >
            {s.chip}
          </button>
        ))}
      </footer>
    </div>
  )
}
