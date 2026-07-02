import { ReactNode, useEffect, useRef, useState } from 'react'
import { getPref, setPref } from '../lib/prefs'
import { SEEN_KEY, seriesOf } from './WhatsNew'

// 업데이트 패치노트 — 마이너 버전이 오를 때마다(1.0 → 1.1, 1.2 …) 첫 실행에 한 번 뜬다.
// 1.1.x처럼 패치(x)만 오르는 건 같은 시리즈라 다시 띄우지 않는다. 새 설치(도장 없음)는
// 여기가 아니라 WhatsNew(전체 기능 소개)가 맡으므로, 도장이 "있고" 시리즈가 바뀐
// 경우에만 연다. 두 화면은 같은 SEEN_KEY를 읽고 써서 같은 실행에 겹쳐 뜨지 않는다.
//
// 비주얼은 "3D 크리에이터 포트폴리오" 레퍼런스를 우리 패치노트로 옮긴 것 —
// 칠흑(#0C0C0C) 무대 + Kanit, 위→아래 메탈 그라데이션 대제목(#646973 → #BBCCD7),
// 키워드 마퀴, 그리고 변경점을 01·02·03…의 "넘버드 리스트"로 (포트폴리오의 서비스
// 섹션처럼) 한 줄씩 스크롤로 떠오르게 쌓는다. 레퍼런스 맨 앞의 인물 포트레이트는 뺐다.
// 색은 컨셉 고정값이라 테마 변수를 쓰지 않는다.

type Note = { num: string; tag: string; name: ReactNode; desc: ReactNode }
type Release = { title: string; lead: string; notes: Note[] }

// 시리즈('1.1')별 패치노트. 다음 마이너에선 여기에 한 덩이만 더 얹으면 된다.
const RELEASES: Record<string, Release> = {
  '1.4': {
    title: "WHAT'S NEW",
    lead: 'Verse 공식 문서가 한국어로 다시 태어나고, 과금은 구독과 API 사이를 오가요 — 1.4.',
    notes: [
      {
        num: '01',
        tag: 'Verse · 한국어 문서',
        name: '공식 문서를, 처음부터 다시',
        desc: (
          <>
            <b>/Verse.org</b> · <b>/UnrealEngine.com</b> · <b>/Fortnite.com</b>의 API 주석{' '}
            <b>3,193개를 전면 재번역</b>했어요 — 직역투를 걷어내고 자연스러운 문단으로,
            전문용어엔 <b>짧은 풀이</b>를 붙여서. 호버 카드 서식도 새로: 주석 속 코드 예시는{' '}
            <b>색칠된 코드 블록</b>으로, 긴 문서는 <b>섹션 제목</b>으로, 핵심 용어는{' '}
            <b>코드 색 + 설명 툴팁</b>으로 읽혀요.
          </>
        )
      },
      {
        num: '02',
        tag: 'Verse · 정확도',
        name: '호버가 닿지 않던 곳까지',
        desc: (
          <>
            digest의 <b>파라미터형 타입</b>(<b>chat_channel</b> 같은)이 이제 선언 호버 · 멤버
            자동완성 · 색칠에 모두 잡혀요. <b>transform:</b> 블록형 생성의 타입도 구조체색으로.
            속성 이름과 겹치는 변수의 엉뚱한 호버, 스코프 밖 후보 누출, <b>Foo().</b> 뒤의
            노이즈까지 — 조용히 틀리던 것들을 정리했습니다.
          </>
        )
      },
      {
        num: '03',
        tag: 'Verse · 반응속도',
        name: '열자마자, 바로',
        desc: (
          <>
            .verse 파일을 여는 <b>즉시</b> — 분석 서버가 데워지기 전에도 키워드·지역변수·선언
            호버와 자동완성이 떠요. 파일 저장이나 <b>UEFN Verse 재빌드</b>를 감지하면 완성·색
            데이터가 <b>자동 갱신</b>되어 앱을 껐다 켤 필요가 없고, 분석이 멈춰도 스스로
            복구합니다.
          </>
        )
      },
      {
        num: '04',
        tag: '채팅 · /ask',
        name: '/ask는 기다리지 않아요',
        desc: (
          <>
            AI가 작업 중이어도 <b>/ask는 즉시</b> 열리고, <b>/ 명령 팔레트</b>도 실행 중에
            그대로 떠요. /ask 모달엔 <b>자체 모델·강도·모드</b> 선택이 생겨 — 본 작업은 Fable로,
            빠른 질문은 가볍게. 예약 메시지가 명령 뒤에 갇혀 안 나가던 문제도 고쳤습니다.
          </>
        )
      },
      {
        num: '05',
        tag: '모델',
        name: '전환은, 투명하게',
        desc: (
          <>
            Fable이 <b>Opus로 전환되는 순간</b>(정책 거부 · 한도 · 일시 과부하) 채팅에{' '}
            <b>경고 배너</b>가 뜨고 모델 선택도 따라 바뀌어요. Claude Code가 보내는 알림·경고
            줄도 스레드에 그대로 보이고, 사용량 카드엔 <b>Fable 주간 한도</b>가 추가됐습니다.
          </>
        )
      },
      {
        num: '06',
        tag: '과금 · API 모드 (1.4.1)',
        name: '구독으로도, API 키로도',
        desc: (
          <>
            컴포저의 <b>과금 선택</b>으로 실행마다 <b>구독(정액) ↔ API 키(종량)</b>를 골라요 —
            채팅·코드·/ask는 전역으로, <b>멀티는 패널마다 따로</b>. 키는 설정 → <b>API</b>에{' '}
            <b>Windows 암호화(DPAPI)</b>로 저장되고 화면엔 끝 4자리만, 실행이 실제로 어느 쪽
            인증으로 붙었는지 어긋나면 <b>배너로 알려</b>줍니다.
          </>
        )
      },
      {
        num: '07',
        tag: '과금 · 비용 추적 (1.4.1)',
        name: '쓴 만큼, 보이게',
        desc: (
          <>
            API 모드의 컨텍스트 카드는 한도 대신 <b>이번 대화 비용</b>과 <b>남은 예산</b>(예산
            입력 시)을 보여줘요. 설정 → API의 <b>사용 통계</b>에선 <b>1일·7일·30일·전체</b>{' '}
            기간으로 <b>모델별 비용</b>과 <b>일별 미니 차트</b>, 입력·출력 토큰까지 — 실행 한
            건 한 건이 원장에 쌓입니다.
          </>
        )
      },
      {
        num: '08',
        tag: '설정 · Verse (1.4.1)',
        name: 'Verse 행, 반듯하게',
        desc: (
          <>
            설정 → Code의 <b>Verse 행이 다른 서버와 같은 높이</b>로 정돈됐어요. verse-lsp 연결
            안내와 <b>지정된 경로</b>, 공식 문서 한국어 토글은 <b>행을 펼치면</b> 깔끔하게
            이어집니다.
          </>
        )
      },
      {
        num: '09',
        tag: '멀티 · 승인/질문 (1.4.2)',
        name: '물어본 패널에서, 바로',
        desc: (
          <>
            멀티의 <b>승인·질문 카드가 요청한 패널 안에</b> 떠요 — 여러 패널이 동시에 물어봐도
            어느 작업의 요청인지 위치로 바로 읽히고, 카드가 뜬 패널은 <b>응답 대기</b> 골드
            펄스로 표시됩니다. 숫자 키·Esc는 <b>포커스된 패널의 카드에만</b> 들어가 키 한 번이
            다른 패널의 요청까지 답해버리는 일이 없고, 질문 카드는 <b>크게 보기</b>로 패널
            확장과 이어져요.
          </>
        )
      }
    ]
  },
  '1.3': {
    title: "WHAT'S NEW",
    lead: 'Verse가 색을 넘어 정의로 뛰고, 멤버까지 자동완성. 코드 모드는 넓게, 자동완성은 깔끔하게 — 1.3.',
    notes: [
      {
        num: '01',
        tag: 'Verse · LSP',
        name: 'Verse가, 진짜 언어처럼',
        desc: (
          <>
            색만 입던 <b>.verse</b>가 이제 진짜 언어처럼 읽혀요. <b>정의 이동(F12)</b>·구조화 호버 카드·심볼
            목록에, 함수·타입·멤버·지역/매개변수를 <b>의미대로 색칠</b>하고, <b>멤버 자동완성</b>(타입 ·
            <b>@속성</b> · <b>&lt;지정자&gt;</b>)까지. 아직 저장하지 않은 버퍼에서도 호버와 정의가 떠요.
          </>
        )
      },
      {
        num: '02',
        tag: '자동완성',
        name: '고를 것만, 또렷하게',
        desc: (
          <>
            자동완성 항목마다 <b>종류별 SVG 아이콘과 색 그룹</b>이 붙었어요. 이름이 같은 오버로드는 한 줄로
            합쳐 <b>+N</b>으로 보여 주고, 입력한 접두어와 <b>정확히 맞는 후보</b>만 남겨 — 군더더기 없이
            고릅니다.
          </>
        )
      },
      {
        num: '03',
        tag: '탐색기',
        name: '파일이, 한눈에',
        desc: (
          <>
            탐색기의 글자 배지를 <b>Material 아이콘 테마</b>의 모던 SVG 아이콘으로 바꿨어요. 언어·설정·이미지
            파일이 <b>색과 모양</b>으로 즉시 구분돼, 트리만 훑어도 무엇이 무엇인지 보입니다.
          </>
        )
      },
      {
        num: '04',
        tag: '코드 · 채팅',
        name: '모드에, 꼭 맞게',
        desc: (
          <>
            <b>‘에이전트’ 탭이 ‘코드’</b>가 되고, 우측 패널이 사라진 자리의 할 일·변경 파일·컨텍스트는
            컴포저 위 <b>작업 바</b>로 옮겨 대화 칼럼이 넓어졌어요. 폴더 없는 순수 채팅엔 설명·브레인스토밍 같은
            <b>대화 중심 추천</b>을, 다크모드 Claude 아바타엔 <b>코랄 브랜드색</b>을 되살렸습니다.
          </>
        )
      },
      {
        num: '05',
        tag: 'Verse · 한국어',
        name: '공식 문서를, 한국어로',
        desc: (
          <>
            <b>/Verse.org</b> · <b>/UnrealEngine.com</b> · <b>/Fortnite.com</b> API 주석 설명을 호버에서{' '}
            <b>한국어로</b> 보여줘요(설정에서 원문↔한국어 전환). 선언 위치에서도 — 네이티브·확장 메서드,{' '}
            <b>@editable</b> 같은 속성까지 호버 카드가 뜨고, 속성은 지정자와 갈라 <b>ATTRIBUTES</b> 행으로
            또렷하게 보여요.
          </>
        )
      }
    ]
  },
  '1.2': {
    title: "WHAT'S NEW",
    lead: '여러 에이전트가 나란히 일하는 곳에 파일 탐색기가 들어왔어요. 읽기는 더 또렷하게 — 1.2.',
    notes: [
      {
        num: '01',
        tag: '멀티 · 탐색기',
        name: '패널마다, 파일 트리를',
        desc: (
          <>
            멀티 모드에서 각 패널의 <b>폴더 칩을 누르면</b> 그 자리에서 파일 트리가 펼쳐져요. 패널마다
            작업 폴더가 달라도 — 이름으로 검색하고, AI가 만지거나 새로 만든 파일은 <b>색·배지</b>로,
            클릭하면 그대로 <b>코드 뷰어</b>로 열립니다. 단일 모드의 탐색기를 칩에서 펼치는 형태예요.
          </>
        )
      },
      {
        num: '02',
        tag: '코드 뷰어',
        name: '읽기와 변경을, 따로',
        desc: (
          <>
            코드 뷰어에 <b>변경/일반 보기 토글(Ctrl+D)</b>이 생겼어요. diff 마킹(추가는 초록 행·삭제는
            빨간 줄)을 읽기 모드와 <b>분리</b>해서, 그냥 읽고 싶을 땐 군더더기 없이 — 변경점을 보고 싶을
            땐 한 키로 켜고 끕니다.
          </>
        )
      },
      {
        num: '03',
        tag: 'Verse',
        name: '.verse도, 색을 입고',
        desc: (
          <>
            언리얼 <b>.verse</b> 파일을 인식해요. 전용 아이콘 배지와 <b>구문 강조</b>(UE6 코퍼스 기반),
            설정의 Code 탭에도 노출 — Verse 코드도 다른 언어처럼 또렷하게 읽힙니다.
          </>
        )
      },
      {
        num: '04',
        tag: '채팅',
        name: '읽기 편하게, 더',
        desc: (
          <>
            채팅에서 <b>Ctrl+휠</b>로 글자 크기를 키우고, 본문 폭을 넓혀 긴 답변도 시원하게 봐요. 폴더를
            안 골라도 <b>바탕화면</b>에서 바로 동작해, 가벼운 작업은 폴더 고르는 단계 없이 시작됩니다.
          </>
        )
      }
    ]
  },
  '1.1': {
    title: "WHAT'S NEW",
    lead: '코딩 에이전트 데스크탑이 한 걸음 더 나아갔어요. 읽고, 고치고, 가볍게 대화까지 — 1.1.',
    notes: [
      {
        num: '01',
        tag: '코드 에디터',
        name: '읽고, 이제 고칩니다',
        desc: (
          <>
            코드 뷰어에 <b>CodeMirror 편집기</b>가 들어왔어요. 읽기 모드에선 부모 커밋과의 표준
            diff(추가는 초록 행·삭제는 빨간 고스트 줄)를, 편집 모드에선 군더더기 없는 에디터를 —
            헤더 토글로 오가며 제자리에서 고치고, 검색 바로 파일 안을 바로 훑어요.
          </>
        )
      },
      {
        num: '02',
        tag: '심볼 분석',
        name: '다시 켜도, 거의 즉시',
        desc: (
          <>
            시맨틱 토큰을 프로젝트별로 <b>디스크에 캐시</b>하고 LSP 서버를 미리 데워 둬서, 앱을 다시
            열어도 분석이 곧장 떠요. <b>파일별 진행 칩</b>으로 어디까지 분석됐는지 한눈에 — UE 컴파일
            DB와 clangd 인덱스도 앱 홈으로 깔끔히 옮겼습니다.
          </>
        )
      },
      {
        num: '03',
        tag: 'C# · Roslyn',
        name: '정의도, 호버도 더 정확히',
        desc: (
          <>
            C# 분석 엔진을 <b>Microsoft Roslyn LSP</b>로 교체했어요(.NET 10). 프로젝트 초기화가 끝날
            때까지 기다렸다 칠해 호버가 들쭉날쭉하지 않고, <b>정의 이동·타입 정보</b>가 한결
            정확해졌습니다.
          </>
        )
      },
      {
        num: '04',
        tag: '창 · 입력',
        name: '작은 마찰까지',
        desc: (
          <>
            최대화 버튼에서 펼쳐지는 <b>커스텀 창 스냅</b>(반·1/4 배치), 반응형 컴포저, 다듬은 검색
            바, 질문 모달 위치 정리까지 — 손에 닿는 자리들을 매만졌어요.
          </>
        )
      },
      {
        num: '05',
        tag: '채팅',
        name: '탐색기 없이, 그냥 대화',
        desc: (
          <>
            맨 앞에 <b>채팅</b> 탭이 생겼어요. 탐색기도 작업 폴더 선택도 없이 바로 — 자체 대화
            목록을 가진 순수 대화 공간이에요. 작업 모드는 <b>채팅 · 에이전트 · 멀티</b>로 정리하고,
            탭과 새 대화 버튼에 호버 설명을 더했습니다.
          </>
        )
      }
    ]
  }
}

// 가장 높은 시리즈를 폴백으로 — 미래 버전이 RELEASES에 아직 없으면 최신 덱을 보여 준다
function pickRelease(version: string): Release {
  const exact = RELEASES[seriesOf(version)]
  if (exact) return exact
  const latest = Object.keys(RELEASES).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  )
  return RELEASES[latest[latest.length - 1]]
}

// 한 줄 리드 문장을 글자 단위로 — 마운트하면 왼→오로 또렷해진다 (레퍼런스의 AnimatedText)
function CharReveal({ text }: { text: string }): ReactNode {
  return (
    <>
      {Array.from(text).map((ch, i) => (
        <span key={i} className="un-char" style={{ animationDelay: `${0.25 + i * 0.014}s` }}>
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </>
  )
}

export function UpdateNotes(): ReactNode {
  const [version, setVersion] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 도장이 "있고"(설치 이력 있음) 시리즈가 바뀐 업데이트에서만 — 첫 설치는 WhatsNew가,
  // 같은 시리즈의 패치(1.1.1 등)는 이미 본 내용이라 스킵.
  useEffect(() => {
    window.api.app
      .getVersion()
      .then((v) => {
        if (!v) return
        const seen = getPref<string>(SEEN_KEY, '')
        if (!seen) return // 첫 설치 → WhatsNew가 맡는다
        if (seriesOf(seen) === seriesOf(v)) return // 같은 마이너 시리즈 → 이미 봄
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [version])

  // 넘버드 리스트가 뷰포트로 들어오는 순간 한 줄씩 떠오른다 (레퍼런스의 스크롤 FadeIn)
  useEffect(() => {
    if (!version) return
    const root = listRef.current
    if (!root) return
    const items = Array.from(root.querySelectorAll<HTMLElement>('.un-item'))
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        }
      },
      { threshold: 0.18 }
    )
    items.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [version])

  if (!version) return null

  const rel = pickRelease(version)

  return (
    <div className="set-dialog-overlay un-overlay" role="dialog" aria-modal="true">
      {/* 상단 내비 — 로고 + 버전 (닫기는 하단 CTA·Esc로) */}
      <header className="un-nav">
        <div className="un-logo">
          Agent Code GUI<sup>v{version}</sup>
        </div>
      </header>

      {/* 히어로 — 메탈 그라데이션 대제목 + 글자 단위로 떠오르는 한 줄 */}
      <section className="un-hero">
        <div className="un-eyebrow">새 버전 · v{version}</div>
        <h1 className="un-title">{rel.title}</h1>
        <p className="un-lead">
          <CharReveal text={rel.lead} />
        </p>
        <div className="un-scrollhint" aria-hidden="true">
          아래로 스크롤
        </div>
      </section>

      {/* 키워드 마퀴 — 레퍼런스의 스크롤 마퀴를 외부 에셋 없이 텍스트로. 화면보다 넓게
          채운 한 그룹을 둘로 복제하고 정확히 한 그룹 폭(-50%)만큼 굴려서, 두 번째 그룹이
          첫 그룹 자리로 들어와 끊김 없이 계속 도는 무한 루프가 된다 */}
      <div className="un-marquee" aria-hidden="true">
        <div className="un-marquee-track">
          {Array.from({ length: 2 }).map((_, half) => (
            <div className="un-marquee-group" key={half}>
              {Array.from({ length: 3 }).flatMap((_, rep) =>
                rel.notes.map((n) => (
                  <span key={`${half}-${rep}-${n.num}`} className="un-marquee-item">
                    {n.tag} <em>·</em>
                  </span>
                ))
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 변경점 — 01·02·03 넘버드 리스트 (포트폴리오 서비스 섹션) */}
      <section className="un-list" ref={listRef}>
        {rel.notes.map((n) => (
          <article key={n.num} className="un-item">
            <div className="un-num">{n.num}</div>
            <div className="un-body">
              <div className="un-tag">{n.tag}</div>
              <h2 className="un-name">{n.name}</h2>
              <p className="un-desc">{n.desc}</p>
            </div>
          </article>
        ))}
      </section>

      {/* 마무리 CTA — 레퍼런스 ContactButton(그라데이션 필) */}
      <footer className="un-foot">
        <button className="un-cta" onClick={close}>
          시작하기
        </button>
      </footer>
    </div>
  )
}
