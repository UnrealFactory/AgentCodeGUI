import { ReactNode, useEffect, useState } from 'react'
import { getPref, setPref } from '../lib/prefs'
import { t, useLang } from '../lib/i18n'
import { IconClose, IconMascot } from './icons'

// 패치노트 릴리즈 카드 — 버전이 오를 때마다(패치 포함) 첫 실행에 한 번, 메인 위에
// 유리 카드로 뜬다. 2.0에서 풀스크린 소개 두 장(WhatsNew 전체 소개 덱 · UpdateNotes
// 패치노트 페이지)을 은퇴시키고 이 카드 하나로 합쳤다 — 바로 닫아도(✕·Esc·바깥 클릭),
// 스크롤로 끝까지 읽어도 좋게. 닫으면 현재 버전으로 도장(SEEN_KEY)이 찍힌다.
// 비주얼은 qcard 문법을 잇는 카드(캐논: scripts/poc-patchnotes) — 마스코트 헤더 +
// 메탈 그라데이션 시리즈 숫자(등장 때 한 번 스치는 시인) + 넘버 레일 하이라이트 리스트.
//
// 언어: 릴리즈마다 ko/en 두 벌을 함께 쓴다(설정 › Language를 따라 즉시 전환).
// 새 릴리즈를 얹을 땐 반드시 두 언어 모두 채울 것 — 타입이 강제한다.
export const SEEN_KEY = 'whatsnew.seenVersion' // 예전 화면들과 같은 도장을 이어 쓴다

// '2.0.3' → '2.0' — 노트는 마이너 시리즈 단위로 쓴다 (히어로 숫자도 이 단위)
export function seriesOf(v: string): string {
  return v.split('.').slice(0, 2).join('.')
}

type Note = { tag: string; name: ReactNode; desc: ReactNode }
type Release = { eyebrow: string; lead: ReactNode; notes: Note[] }
type LocalizedRelease = { ko: Release; en: Release }

// 버전별 패치노트 — 릴리즈마다 여기에 한 덩이씩(ko/en 두 벌) 얹는다. 카드의 버전
// 버튼으로 오갈 수 있는 건 최신 MAX_VERSIONS개까지 — 그보다 오래된 덩이는 릴리즈 때 지운다.
// 지난 1.x 노트들은 은퇴한 UpdateNotes와 함께 정리했다(이제 보여줄 경로가 없다).
const MAX_VERSIONS = 5
const RELEASES: Record<string, LocalizedRelease> = {
  '2.6.1': {
    ko: {
      eyebrow: 'IMPROVED',
      lead: '설정 Account의 계정 한도가 더 읽기 쉬워졌습니다 — 초기화 시각을 남은 시간으로 통일하고, 급한 계정부터 보는 정렬을 더했어요.',
      notes: [
        {
          tag: '설정',
          name: '한도 초기화, 남은 시간으로 통일',
          desc: (
            <>
              주간·Fable 한도의 초기화 시각이 <b>&apos;8/21 (금) 15:00&apos;</b> 같은 날짜
              대신 <b>&apos;1일 22시간 뒤&apos;</b>처럼 <b>남은 시간</b>으로 표시됩니다 —
              5시간 창과 같은 문법이라 어느 창이 먼저 돌아오는지 한눈에 비교돼요. 정확한
              날짜·시각이 궁금하면 그 칸에 <b>마우스를 올려</b> 확인할 수 있습니다.
            </>
          )
        },
        {
          tag: '설정',
          name: '계정 정렬 — 초기화 임박순 · 한도 적게 남은순',
          desc: (
            <>
              계정 목록 위 <b>정렬 칩</b>으로 <b>기본(내가 정한 순서)</b> 외에{' '}
              <b>초기화 임박순</b>과 <b>한도 적게 남은순</b>을 고를 수 있습니다 — 어느
              계정이 먼저 풀리는지, 어디가 아직 여유 있는지 바로 보여요. 화면 표시만
              바꾸는 정렬이라 <b>채팅의 계정 선택 순서는 그대로</b>고, 고른 정렬은 저장돼
              다음에도 유지됩니다(정렬 중엔 꾹-드래그 순서 바꾸기가 잠겨요).
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'IMPROVED',
      lead: 'Account limits in Settings are easier to read — reset times now show as time remaining, plus sorting to surface the most urgent account first.',
      notes: [
        {
          tag: 'Settings',
          name: 'Limit resets shown as time remaining',
          desc: (
            <>
              Weekly and Fable limit resets now read as <b>time remaining</b> — like{' '}
              <b>&quot;in 1d 22h&quot;</b> — instead of a date like{' '}
              <b>&quot;Fri 8/21 15:00&quot;</b>. It&apos;s the same style as the 5-hour
              window, so you can compare at a glance which window comes back first.{' '}
              <b>Hover the cell</b> for the exact date and time.
            </>
          )
        },
        {
          tag: 'Settings',
          name: 'Sort accounts — resets soonest · least limit left',
          desc: (
            <>
              <b>Sort chips</b> above the account list add <b>Resets soonest</b> and{' '}
              <b>Least limit left</b> alongside <b>Default (your own order)</b> — see
              right away which account frees up first and which still has headroom. The
              sort only changes the view: <b>the account picker order in chats stays
              put</b>, and your choice is remembered for next time (long-press drag
              reordering locks while a sort is active).
            </>
          )
        }
      ]
    }
  },
  '2.6.0': {
    ko: {
      eyebrow: 'NEW',
      lead: '/btw — 지금 대화의 컨텍스트를 그대로 이어받은 별도 질문 창. 곁다리 질문을 던져도 원래 대화는 깨끗하게 유지됩니다.',
      notes: [
        {
          tag: '채팅',
          name: '/btw — 컨텍스트를 이어받은 질문 창',
          desc: (
            <>
              작성칸에 <b>/btw 질문</b>을 치면(작업 중에도!) 지금까지의 대화 내용을{' '}
              <b>그대로 이어받은 별도 창</b>이 뜨고 질문이 바로 전송됩니다. 대화를{' '}
              <b>포크</b>해서 열기 때문에 곁다리 문답이 <b>원래 대화에는 전혀 남지
              않아요</b> — 컨텍스트도 안 먹습니다. 질문 없이 <b>/btw</b>만 치면 빈 질문
              창이 열리고, <b>btw 전용 시작 화면</b>이 컨텍스트를 이어받았는지와 곁다리
              질문 추천을 보여줘요. 본채팅·추가 채팅·멀티 패널(별도 창 포함) 어디서든
              됩니다 — 멀티에선 알약이 그 패널 안에 떠요.
            </>
          )
        },
        {
          tag: '채팅',
          name: 'btw 알약 — 내리면 알약, 삭제는 ✕로만',
          desc: (
            <>
              질문 창을 <b>최소화하거나 닫으면</b> 원래 채팅 하단에 <b>btw 알약</b>으로
              내려앉습니다(창이 떠 있는 동안엔 알약이 숨어요). 이름은 <b>BTW - 원본 채팅
              제목</b>, 다른 알약과 구분되는 <b>파란 테두리</b>예요. 상태 점이 <b>진행
              중(펄스)/답 완료(초록)</b>를 알려주고, <b>클릭하면 창이 다시 열려</b> 문답이
              그대로 이어져요. 창의 X는 언제나 알약으로 남고, <b>삭제는 알약의
              ✕뿐</b>입니다. 알약은 재시작 후에도 남고, 사이드바 <b>추가 채팅</b>{' '}
              목록에서도 찾을 수 있습니다.
            </>
          )
        },
        {
          tag: '멀티',
          name: '별도 창으로 뺀 패널의 자리도 클릭하면 선택',
          desc: (
            <>
              별도 창으로 뽑아둔 패널의 그리드 자리(점선 칸)를 클릭하면 이제 <b>그 패널이
              선택</b>되어 포커스 링이 뜨고, 파일 탐색기(`)가 <b>그 패널의 폴더</b>를
              따라갑니다 — 창을 앞으로 가져오는 기존 동작은 그대로예요. 선택된 상태에서{' '}
              <b>Enter</b>를 치면 그 창으로 가고, <b>Esc</b>는 선택만 놓습니다(다른
              창에서 보고 있는 실행을 여기 Esc가 끊지 않아요).
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'NEW',
      lead: '/btw — a side-question window that carries your current chat’s context. Ask away; the original conversation stays untouched.',
      notes: [
        {
          tag: 'Chat',
          name: '/btw — a question window with your context',
          desc: (
            <>
              Type <b>/btw your question</b> (even mid-run!) and a <b>separate window
              opens carrying the conversation so far</b>, sending the question right
              away. It <b>forks</b> the session, so the side chat <b>leaves no trace in
              the original</b> — and costs it no context. Bare <b>/btw</b> opens an empty
              question window with a <b>btw-specific start screen</b> showing whether
              context was carried over, plus side-question suggestions. Works in the main
              chat, extra chat windows, and multi-panel chats (popped-out panels too) —
              panel pills live inside the panel.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'btw pills — put it down, delete only via ✕',
          desc: (
            <>
              <b>Minimizing or closing</b> the question window parks it as a <b>btw
              pill</b> at the bottom of the original chat (the pill hides while the
              window is on screen). It&apos;s named <b>BTW - the original chat&apos;s
              title</b>, with a <b>blue border</b> that sets it apart from other pills.
              The dot shows <b>working (pulse) / answered (green)</b>, and <b>clicking
              reopens the window</b> with the thread intact. The window&apos;s X always
              parks it — <b>only the pill&apos;s ✕ deletes</b> the question chat. Pills
              survive restarts, and the chats also appear under <b>Chat windows</b> in
              the sidebar.
            </>
          )
        },
        {
          tag: 'Multi',
          name: 'Popped-out panel slots are selectable too',
          desc: (
            <>
              Clicking the grid slot (dashed box) of a panel you popped into its own
              window now <b>selects that panel</b> — it gets the focus ring, and the file
              explorer (`) follows <b>that panel&apos;s folder</b>. Bringing the window to
              front still works as before. While selected, <b>Enter</b> jumps to the
              window and <b>Esc</b> just releases the selection (it never cancels a run
              you&apos;re watching in the other window).
            </>
          )
        }
      ]
    }
  },
  '2.5.2': {
    ko: {
      eyebrow: 'IMPROVED',
      lead: '멀티 패널 팝아웃이 더 손에 붙습니다 — 크게 보기에서 같은 제스처 한 번 더면 별도 창으로, 별도 창에선 Enter로 바로 입력창에 커서가 갑니다.',
      notes: [
        {
          tag: '멀티',
          name: '크게 보기 제스처 한 번 더 = 별도 창으로',
          desc: (
            <>
              그리드에서 <b>→↑ 제스처</b>로 패널을 크게 보고 있을 때, <b>같은 →↑를 한 번
              더</b> 그으면 그 패널이 <b>별도 창</b>으로 빠집니다 — 확대의 다음 단계라 획도
              같아요. 원래 크기로 돌아가는 ↓→는 그대로입니다.
            </>
          )
        },
        {
          tag: '멀티',
          name: '별도 창에서 Enter로 입력창 포커스',
          desc: (
            <>
              팝아웃 창에서 대화를 읽다가 <b>Enter</b>를 치면 이제 <b>입력창으로 커서가
              이동</b>합니다 — 그리드에서 선택한 패널에 Enter 치던 것과 같은 규칙이에요. 창이
              처음 열릴 때도 크게 보기 카드처럼 <b>입력창에 바로 커서</b>가 가서, 뽑자마자
              이어서 타이핑할 수 있습니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'IMPROVED',
      lead: 'Panel pop-out gets smoother — repeat the Expand gesture to open the panel in its own window, and in that window Enter now jumps to the input box.',
      notes: [
        {
          tag: 'Multi',
          name: 'Repeat the Expand gesture to pop out',
          desc: (
            <>
              While a panel is expanded via the <b>→↑ gesture</b>, drawing the <b>same →↑
              again</b> pops it out into its <b>own window</b> — the next step up from
              expanding, so it shares the stroke. ↓→ to restore size works as before.
            </>
          )
        },
        {
          tag: 'Multi',
          name: 'Enter focuses the input in a popped-out window',
          desc: (
            <>
              Reading the conversation in a popped-out window, pressing <b>Enter</b> now{' '}
              <b>moves the cursor to the input box</b> — the same rule as pressing Enter on a
              focused panel in the grid. The window also <b>focuses the input right when it
              opens</b>, like the expand card does, so you can keep typing the moment it pops
              out.
            </>
          )
        }
      ]
    }
  },
  '2.5.1': {
    ko: {
      eyebrow: 'IMPROVED',
      lead: '긴 대화에서 컨텍스트가 가득 차 자동으로 요약될 때, 이제 그 순간을 카드로 알려드립니다 — 게이지가 말없이 뚝 떨어지는 일이 없어요.',
      notes: [
        {
          tag: '컨텍스트',
          name: '자동 요약이 보이게 됐어요',
          desc: (
            <>
              대화가 길어져 컨텍스트가 가득 차면 Claude가 <b>스스로 이전 대화를 요약</b>해
              자리를 비우는데, 지금까지는 아무 표시 없이 게이지만 갑자기 떨어졌습니다. 이제
              그 지점에 <b>/compact 계열 카드</b>가 떠서 자동 요약이 일어났음을 알려주고,{' '}
              <b>컨텍스트 절약(전 → 후 %)과 회수한 토큰</b>도 실측으로 함께 보여줘요. 카드는
              게이지가 떨어지는 바로 그 순간에 나타나 이유를 설명합니다 — 본채팅·멀티
              패널·팝아웃·추가 채팅 어디서든요.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'IMPROVED',
      lead: 'When a long conversation fills the context and gets auto-summarized, a card now marks the moment — no more gauge silently plummeting.',
      notes: [
        {
          tag: 'Context',
          name: 'Auto-compaction is now visible',
          desc: (
            <>
              When the context fills up, Claude <b>summarizes the earlier conversation on its
              own</b> to make room — but until now the only sign was the gauge suddenly
              dropping. A <b>/compact-style card</b> now appears right at that point, showing
              that an auto-summary happened along with the <b>measured savings (before → after
              %) and tokens reclaimed</b>. The card lands at the exact moment the gauge drops,
              explaining it — in the main chat, multi panels, pop-outs, and extra chat windows
              alike.
            </>
          )
        }
      ]
    }
  },
  '2.5.0': {
    ko: {
      eyebrow: 'NEW',
      lead: '멀티 패널이 자유로워집니다 — 패널을 별도 창으로 뽑아 다른 모니터에 두고, 끌어서 순서도 바꿔요. 긴 작업에서 끝난 워크플로 알약이 쌓이던 것도 정리했습니다.',
      notes: [
        {
          tag: '멀티',
          name: '패널을 별도 창으로 — 듀얼 모니터에서 나란히',
          desc: (
            <>
              패널 헤더의 새 버튼(크게 보기 옆 ↗)으로 그 패널을 <b>독립 창</b>으로 띄웁니다.
              창은 자유롭게 옮기고 크기를 바꿀 수 있어 — <b>확대해 볼 패널은 왼쪽 모니터에,
              나머지 그리드는 오른쪽에</b> 두는 식으로 나란히 쓸 수 있어요. 실행 중인 턴과
              백그라운드 작업은 <b>끊기지 않고</b>, 창을 닫으면 쓰던 초안·설정까지 그대로
              그리드로 돌아옵니다. 그리드의 빈 자리를 클릭하면 그 창이 앞으로 와요.
            </>
          )
        },
        {
          tag: '멀티',
          name: '패널 순서를 끌어서 바꿔요',
          desc: (
            <>
              패널 헤더를 <b>잠깐 길게 누르면</b> 집어 들 수 있습니다 — 끌어서 원하는 자리에
              놓으면 끝. 바꾼 순서는 세션에 저장돼 다시 켜도 유지돼요. 번호는 <b>자리
              기준</b>(왼쪽부터 1·2·3…)이라 옮기면 새 자리 번호를 받고, 대화·실행·색 태그는
              패널을 그대로 따라갑니다. 쓰임이 없던 숫자 키(1~N) 패널 점프는 정리했어요.
            </>
          )
        },
        {
          tag: '워크플로',
          name: '끝난 워크플로 알약이 바로 걷혀요',
          desc: (
            <>
              에이전트가 턴을 끝내지 않은 채 워크플로를 연달아 돌리는 <b>긴 작업</b>에서, 이미
              끝난 워크플로 알약이 화면 아래에 <b>계속 쌓여 남던</b> 문제를 고쳤습니다. 이제
              완료·중지되는 <b>즉시 사라지고</b>, 실제로 돌고 있는 것만 남아요.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'NEW',
      lead: 'Multi panels break free — pop a panel out into its own window on another monitor, and drag panels to reorder them. Finished workflow pills no longer pile up during long runs.',
      notes: [
        {
          tag: 'Multi',
          name: 'Pop a panel out — side by side on two monitors',
          desc: (
            <>
              A new button in the panel header (↗, next to Expand) opens that panel in its{' '}
              <b>own window</b> — move and resize it freely, so the panel you want big sits on{' '}
              <b>the left monitor while the grid stays on the right</b>. Running turns and
              background work <b>keep going uninterrupted</b>, and closing the window returns
              everything — even the draft you were typing — right back to the grid. Clicking
              the placeholder in the grid brings the window forward.
            </>
          )
        },
        {
          tag: 'Multi',
          name: 'Drag panels to reorder them',
          desc: (
            <>
              <b>Press and hold</b> a panel header for a moment to pick it up — drag it to the
              spot you want and drop. The order is saved per session. Numbers follow the{' '}
              <b>position</b> (1·2·3… from the left), so a moved panel takes its new spot&apos;s
              number while its conversation, runs, and color tag travel with it. The unused
              number-key (1–N) panel jump has been retired.
            </>
          )
        },
        {
          tag: 'Workflow',
          name: 'Finished workflow pills clear right away',
          desc: (
            <>
              During <b>long runs</b> where the agent keeps its turn going while running one
              workflow after another, pills for already-finished workflows used to{' '}
              <b>pile up</b> at the bottom of the chat. They now disappear <b>the moment</b> a
              workflow completes or stops — only what&apos;s actually running stays.
            </>
          )
        }
      ]
    }
  },
}

// 카드가 보여줄 버전 목록 — 최신부터, 최대 MAX_VERSIONS개 (가독성 캡)
function noteVersions(): string[] {
  return Object.keys(RELEASES)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .slice(0, MAX_VERSIONS)
}

export function PatchNotes(): ReactNode {
  const lang = useLang() // 설정 › Language 전환 즉시 카드 내용도 갈아탄다
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
  const rel = RELEASES[cur][lang === 'en' ? 'en' : 'ko']
  const series = seriesOf(cur)

  return (
    <div className="pn-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pncard" role="dialog" aria-label={t('업데이트 소식', "What's new")}>
        <div className="pn-head">
          <IconMascot size={18} />
          <span className="pn-hl">{t('업데이트 소식', "What's new")}</span>
          <span className="pn-sp" />
          <span className="pn-verpill">v{version}</span>
          <button className="pn-x" onClick={close} aria-label={t('닫기', 'Close')}>
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
          <span className="pn-hint">
            {t('닫으면 이 버전 소식은 다시 뜨지 않아요', "Once closed, this version's news won't show again")}
          </span>
          <button className="pn-go" onClick={close} autoFocus>
            {t('시작하기', 'Get started')}
          </button>
        </div>
      </div>
    </div>
  )
}
