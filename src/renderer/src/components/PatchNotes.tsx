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
  '2.3.0': {
    eyebrow: 'UPDATE',
    lead: 'Claude 워크플로를 지원합니다 — 여러 에이전트가 단계별로 병렬 작업하는 워크플로가 백그라운드에서 완주하고, 끝나면 결과를 대화로 정리해 줘요. 백그라운드 셸·에이전트도 이제 턴이 끝나도 유지되고, 취소는 즉시·깨끗하게 됩니다.',
    notes: [
      {
        tag: '워크플로',
        name: '워크플로가 앱에서 완주합니다',
        desc: (
          <>
            Claude의 <b>Workflow 도구</b>(멀티 에이전트 오케스트레이션)를 시키면, 턴이 끝나도
            워크플로가 <b>백그라운드에서 계속 돌고</b> 완료되면 <b>결과 정리 답변이 저절로</b>{' '}
            도착합니다. 진행은 하단 <b>알약</b>으로 — 누르면 <b>단계 레일 + 에이전트 보드</b>
            (모델·토큰·도구 수 실시간)가 펼쳐져요. 카드의 <b>중지</b>, <b>Esc</b>·<b>↓→ 제스처</b>
            로 내려두기까지.
          </>
        )
      },
      {
        tag: '상주',
        name: '백그라운드가 턴을 넘습니다',
        desc: (
          <>
            백그라운드 <b>셸</b>(dev 서버 등)과 <b>서브에이전트</b>가 턴 종료와 함께 죽지 않고{' '}
            <b>계속 살아 있어요</b>. 도는 동안 보낸 메시지는 <b>같은 세션에 이어져</b> 작업이
            끊기지 않고, 폴더·모델·계정을 바꾸면 기존처럼 새 세션으로 시작합니다. 본채팅·멀티·
            추가 채팅 모두요.
          </>
        )
      },
      {
        tag: '취소',
        name: '취소는 즉시, 그리고 회수로',
        desc: (
          <>
            <b>Esc</b>·중지 버튼이 실행을 <b>즉시</b> 끊고, 보냈던 메시지와 반쯤 오던 답을
            스레드에서 걷어 <b>보낸 문장을 컴포저에 되살립니다</b> — 다듬어 다시 보내면 돼요
            (쓰던 초안은 지켜요). 멀티 채팅에서 취소가 안 먹던 문제도 함께 고쳤습니다.
          </>
        )
      },
      {
        tag: '입력',
        name: '↑/↓ 히스토리는 빈 입력에서만',
        desc: (
          <>
            메시지를 <b>쓰는 중</b>의 ↑/↓는 줄 이동으로 남고, <b>입력창이 빌 때만</b> 보낸
            메시지 다시 불러오기로 들어갑니다 — 초안을 쓰다 히스토리로 튀지 않아요.
          </>
        )
      }
    ]
  },
  '2.2.3': {
    eyebrow: 'FIX',
    lead: '멀티 채팅에서 컨텍스트를 누르면 나오는 사용 한도가 패널에 묶은 계정을 따라가지 않던 문제를 고쳤습니다 — 이제 패널마다 자기가 실제로 소비하는 계정의 남은 한도를 보여줘요.',
    notes: [
      {
        tag: '멀티',
        name: '한도가 패널 계정을 따라갑니다',
        desc: (
          <>
            패널마다 <b>다른 계정</b>을 묶어도 컨텍스트 팝업의 <b>5시간·주간 한도</b>가 전부{' '}
            <b>한 계정 수치</b>로 나오던 버그 — 이제 <b>그 패널이 실제로 소비하는 계정</b>{' '}
            기준으로 조회합니다. 팝업을 여는 순간 그 계정으로 새로 받아와, 계정을 막 바꾼
            직후에도 맞는 수치가 떠요.
          </>
        )
      },
      {
        tag: '멀티',
        name: '기본 계정 패널도 정확하게',
        desc: (
          <>
            계정을 따로 묶지 않은 패널은 <b>기본 계정</b> 기준이어야 하는데, 본채팅이 마지막으로
            보던 <b>다른 계정의 수치를 물려받을 수 있던</b> 것도 함께 고쳤습니다. 패널 실행이
            끝나면 화면 속 패널 계정들을 <b>모두 새로 받아</b> 방금 쓴 소비가 바로 반영돼요.
          </>
        )
      }
    ]
  },
  '2.2.2': {
    eyebrow: 'UPDATE',
    lead: '멀티 채팅 패널을 본채팅 크기의 카드로 크게 볼 수 있습니다 — 작은 글씨를 확대경 없이 읽고, 숫자 키로 패널을 크게 넘겨보세요. 작업 폴더엔 즐겨찾기와 참조 폴더가 생겨 여러 프로젝트를 함께 무는 작업이 쉬워졌어요.',
    notes: [
      {
        tag: '멀티',
        name: '패널 크게 보기',
        desc: (
          <>
            패널 헤더 오른쪽의 <b>크게 보기</b> 버튼(또는 스레드에서 <b>→↑ 제스처</b>)을
            누르면 그 패널이 <b>본채팅 크기의 카드</b>로 화면을 채웁니다 — 진행 중인 실행·
            쓰던 초안 그대로요. <b>숫자 키(1~6)</b>로 카드 속 패널을 갈아끼우며 크게 확인하고,
            <b>Esc</b>·베일 클릭·<b>↓→ 제스처</b>로 제자리. 카드 안 <b>Ctrl+휠</b> 글자
            크기는 그리드와 따로 기억됩니다.
          </>
        )
      },
      {
        tag: '멀티',
        name: '실행 중에도 위로 스크롤',
        desc: (
          <>
            에이전트가 답을 쓰는 동안 패널에서 <b>위로 올라갈 수 없던</b> 문제를 고쳤습니다 —
            본채팅과 같은 규칙으로, 휠을 올리면 따라가기가 풀려 지난 내용을 읽을 수 있고
            바닥에 닿거나 <b>맨 아래로</b> 버튼을 누르면 다시 따라갑니다.
          </>
        )
      },
      {
        tag: '폴더',
        name: '작업 폴더 즐겨찾기',
        desc: (
          <>
            작업 폴더 팝오버의 폴더에 <b>별</b>을 달아 고정하세요 — 목록이{' '}
            <b>즐겨찾기 / 최근</b> 섹션으로 나뉘고, 즐겨찾기는 최근에서 밀려나도 항상
            남습니다. 본채팅·멀티 패널·추가 채팅이 같은 목록을 공유해요.
          </>
        )
      },
      {
        tag: '폴더',
        name: '참조 폴더 — 다른 폴더도 함께',
        desc: (
          <>
            작업 폴더 외에 AI가 <b>함께 인식할 폴더</b>를 채팅마다 얹을 수 있습니다(최대 8개,
            Claude Code의 <b>--add-dir</b>과 같은 기능). 팝오버에서 즐겨찾기·최근 폴더의{' '}
            <b>+</b>를 누르거나 직접 골라 추가하면 폴더 칩에 <b>+N</b>이 붙고, 그 폴더의 코드
            읽기·수정이 대화 리셋 없이 바로 열려요. Claude·Codex(GPT) 모두 지원합니다.
          </>
        )
      }
    ]
  },
  '2.2.1': {
    eyebrow: 'UPDATE',
    lead: '작업 폴더에 .git이 없어도 이제 하위 폴더의 저장소를 알아서 찾아냅니다 — 언리얼 프로젝트처럼 플러그인 폴더에만 Git이 있는 구성도 스트립·카드로 그대로 이어져요. 자동 숨김 사이드바에서 탐색기 헤더 버튼이 안 눌리던 것도 고쳤습니다.',
    notes: [
      {
        tag: 'Git',
        name: '하위 저장소도 알아서 찾아요',
        desc: (
          <>
            작업 폴더 자체엔 <b>.git이 없고</b> 하위 폴더(예: 언리얼 프로젝트의 플러그인)에만
            저장소가 있는 구성 — 이제 하위 <b>3단계까지 가볍게 훑어</b> 저장소를 찾아 탐색기
            하단에 <b>저장소별 한 줄씩</b> 보여줍니다. 하위 저장소는 경로 라벨로 구분되고,
            여러 곳이면 최대 3줄 + <b>외 N곳</b>으로 접혀요. 줄을 누르면 카드가 <b>바로 그
            저장소</b>로 열립니다.
          </>
        )
      },
      {
        tag: 'Git',
        name: 'Git 카드에서 저장소 전환',
        desc: (
          <>
            저장소가 2곳 이상이면 카드 왼쪽에 <b>저장소 목록</b>이 생깁니다 — 클릭 한 번으로
            변경·히스토리·브랜치·원격 동작이 <b>통째로 그 저장소 기준</b>으로 바뀌어요.
            저장소마다 <b>커밋 대기 수</b>가 항상 보여서, 다른 저장소에 남은 변경도 카드 안에서
            바로 눈에 들어옵니다. 1곳뿐인 프로젝트에선 지금까지와 똑같아요.
          </>
        )
      },
      {
        tag: 'Git',
        name: '우클릭 “이 폴더 Git 추적”',
        desc: (
          <>
            자동 발견(3단계) 너머 깊은 곳의 저장소는 탐색기에서 그 폴더를 <b>우클릭</b>해 직접
            추가하세요 — <b>.git이 있는 폴더에서만</b> 항목이 나타나고, 프로젝트별로 기억됩니다.
            추적 중인 폴더에선 같은 자리에서 <b>해제</b>할 수 있어요.
          </>
        )
      },
      {
        tag: '탐색기',
        name: '헤더 버튼이 안 눌리던 것 수정',
        desc: (
          <>
            사이드바 <b>자동 숨김</b> 상태에서 탐색기 헤더의 <b>새로고침·숨긴 항목 보기</b>{' '}
            버튼에 호버·클릭이 안 먹고, 버튼으로 가는 길에 사이드바가 <b>먼저 접혀버리던</b>{' '}
            문제를 고쳤습니다 — 뒤에 깔린 본문의 창 끌기 띠가 버튼 위를 덮는 게 원인이었고,
            사이드바가 펼쳐진 동안엔 그 띠를 꺼서 해결했어요.
          </>
        )
      },
      {
        tag: '모델',
        name: 'Opus 5',
        desc: (
          <>
            Anthropic의 새 모델 출시에 맞춰 모델 선택지가 <b>Opus 4.8 → Opus 5</b>로
            올라갑니다. 별칭으로 실행되는 구조라 기존 채팅도 자동으로 최신 Opus를 써요.
          </>
        )
      }
    ]
  },
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
