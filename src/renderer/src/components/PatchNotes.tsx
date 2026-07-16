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
  },
  '2.0.0': {
    eyebrow: 'ALL NEW',
    lead: '앱을 처음부터 다시 그렸습니다.',
    notes: [
      {
        tag: '디자인 리뉴얼',
        name: '플랫 다크, 진짜 아크릴 위에',
        desc: (
          <>
            창이 곧 카드입니다 — <b>Windows 11 아크릴 재질</b> 위에 무채색 틴트를 얹은{' '}
            <b>플랫 다크 디자인</b>으로 전면 리뉴얼했어요. 사이드바와 탐색기는 재질이 은은하게
            비치는 유리 면, 본문은 근검정 패널. 메시지는 <b>아바타 없는 문법</b>(내 메시지=필,
            답변=맨몸 텍스트), 팝오버는 전부 <b>창 안 유리 카드</b>로 통일했습니다.
          </>
        )
      },
      {
        tag: '엔진 · OpenAI',
        name: 'Codex CLI, 나란히',
        desc: (
          <>
            이제 Claude Code만이 아니에요 — 컴포저의 <b>엔진 picker</b>에서{' '}
            <b>Anthropic / OpenAI</b>를 골라 같은 채팅 화면 그대로 <b>Codex CLI</b>로
            실행합니다. GPT 모델 목록은 설치된 Codex에서 실시간으로 불러오고, 스트리밍·도구
            실행·<b>승인 카드</b>·서브에이전트·변경 파일 추적·컨텍스트 게이지까지 같은 문법으로
            동작해요. <b>OpenAI API 키</b>(암호화 저장)를 등록하면 종량 실행도 됩니다.
          </>
        )
      },
      {
        tag: '사이드바',
        name: '채팅·멀티·창, 세 갈래로',
        desc: (
          <>
            모드 탭이 사라지고 사이드바가 <b>일반 채팅 · 멀티 · 추가 채팅</b> 세 섹션으로
            정리됐어요. 새 채팅은 <b>선택 모달</b>(일반/멀티·패널 수 미리보기)로 열고, 목록엔{' '}
            <b>상대 시간</b>과 섹션별 <b>검색</b>, 우클릭 <b>이름 변경(F2)·삭제(Del)</b>가
            들어왔습니다. 추가 채팅 창도 목록에 함께 — 클릭하면 그 창이 앞으로 와요.
          </>
        )
      },
      {
        tag: '멀티 · 추가 채팅',
        name: '어느 화면이든, 본채팅 그대로',
        desc: (
          <>
            멀티 패널과 추가 채팅 창의 속을 <b>본채팅 부품 그대로</b> 갈아 끼웠어요 — 진짜
            컴포저(모델 칩·<b>/</b> 명령·<b>@</b> 멘션·첨부·예약)와 <b>작업 바</b>, 같은 스레드
            문법. 멀티는 <b>미니어처 배율</b>로 여럿을 한눈에 보고, <b>Ctrl+휠 배율은 화면별
            독립</b>이라 본채팅·멀티·추가 채팅이 각자 편한 크기를 기억합니다.
          </>
        )
      },
      {
        tag: '카드 문법',
        name: '묻는 카드는, 한 문법으로',
        desc: (
          <>
            질문·승인 카드를 <b>마스코트 헤더의 카드 한 문법</b>으로 통일했어요 — 플랫 선택지,
            항상 열려 있는 <b>직접 입력</b>, 답하고 나면 대화에 <b>문답 흔적</b>(Q와 ✓)이
            남습니다. GPT의 <b>선택형 질문</b>도 같은 카드로 떠요. Bash 로그·서브에이전트·
            백그라운드 셸의 <b>상세 카드 3종</b>도 같은 골격으로 맞췄습니다.
          </>
        )
      },
      {
        tag: '설정',
        name: '설정도, 처음부터 다시',
        desc: (
          <>
            설정 창을 <b>레일 그룹</b>(사용자·엔진·확장·환경)과 <b>설정 검색</b>이 있는 새 셸로
            다시 지었어요 — Profile 탭 신설, API는 Anthropic·OpenAI <b>키 카드</b>와 예산
            게이지로, MCP/Skill·Code/LSP·Explorer·Gestures 전 탭이 같은 카드 문법입니다.
          </>
        )
      },
      {
        tag: '탐색기',
        name: '왼쪽으로, 더 단정하게',
        desc: (
          <>
            탐색기가 <b>왼쪽 칼럼</b>으로 왔어요 — 사이드바와 <b>한 자리를 전환</b>하며
            씁니다. 마스코트+프로젝트명 헤더, <b>파일 이름 검색</b>, 모두 접기, <b>숨긴 항목
            살짝 보기</b>까지. 오른쪽 레일은 은퇴했습니다.
          </>
        )
      },
      {
        tag: '창 · 네이티브',
        name: '스냅도 최대화도 OS 그대로',
        desc: (
          <>
            투명 창 시절의 수동 드래그·커스텀 스냅을 걷어냈습니다 — 이제 <b>Aero Snap,
            Win+화살표, 더블클릭 최대화, 가장자리 리사이즈</b>가 전부 네이티브로 동작해요.
            창이 커지거나 흔들리던 DPI 보정 배관도 함께 사라졌습니다.
          </>
        )
      },
      {
        tag: '군더더기 제거',
        name: '바로 채팅부터',
        desc: (
          <>
            켜면 <b>입장 화면 없이 바로 시작</b>합니다 — 닉네임·아바타는 설정 Profile에서
            언제든. 쓰임이 적던 <b>Git 카드</b>와 <b>라이트 테마</b>, 프롬프트 설정, 크게 보기를
            정리했고 순수 채팅 모드는 일반 채팅에 합쳐졌어요. 다크 온리가 된 만큼 모든 표면이
            한 팔레트로 정확히 맞습니다.
          </>
        )
      },
      {
        tag: '마스코트',
        name: '생각할 땐, 로봇이 그려져요',
        desc: (
          <>
            AI가 일하는 동안 <b>마스코트 로봇이 선부터 그려지는 루프</b>(머리→귀→더듬이→점)가
            문구와 함께 떠요 — Claude든 GPT든 같은 손길로. 웰컴 화면과 사이드바 브랜드,
            탐색기 헤더에도 같은 글리프가 들어갔습니다.
          </>
        )
      },
      {
        tag: '패치노트',
        name: '새 소식은, 이 카드로',
        desc: (
          <>
            풀스크린 소개 화면 두 장(전체 기능 소개·업데이트 노트)을 은퇴시켰어요 — 이제 버전이
            오르면 <b>지금 보고 계신 이 릴리즈 카드</b>가 한 장 뜹니다. 바로 닫아도(✕·Esc·바깥
            클릭), 스크롤로 끝까지 읽어도 좋아요.
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
