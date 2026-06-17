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
  '1.1': {
    title: "WHAT'S NEW",
    lead: '코딩 에이전트 데스크탑이 한 걸음 더 나아갔어요. 읽고, 고치고, 더 빨라진 1.1.',
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
