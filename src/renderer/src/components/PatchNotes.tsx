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
  '2.4.0': {
    ko: {
      eyebrow: 'NEW',
      lead: '사용 한도에 막혀도 이제 앱이 알아서 기다립니다 — 한도가 풀리는 시각에 중단한 곳부터 자동으로 이어가요.',
      notes: [
        {
          tag: '자동 이어서',
          name: '한도가 풀리면 자동으로 계속해요',
          desc: (
            <>
              모델 칩 → 과금에서 <b>자동 이어서</b>를 켜 두면, 구독 한도에 막혀 멈춘 대화를{' '}
              <b>한도가 초기화되는 시각</b>에 맞춰 자동으로 이어갑니다. 기다리는 동안 컴포저 위
              상태줄이 남은 시간을 보여주고(언제든 취소), 보내기 직전에 <b>정말 풀렸는지 다시
              확인</b>한 뒤에만 이어가요. 본채팅·멀티 패널·추가 채팅 어디서든 동작하고,
              본채팅의 대기는 앱을 껐다 켜도 이어집니다.
            </>
          )
        },
        {
          tag: '계정',
          name: '소진된 계정도 펼쳐서 고를 수 있어요',
          desc: (
            <>
              지난 버전에서 숨겼던 <b>주간 한도 0% 계정</b>을 계정 목록 끝의 &quot;소진된 계정
              N개 표시&quot;로 다시 펼칠 수 있습니다. 소진 계정엔 잔여 % 대신 <b>언제
              돌아오는지</b>가 표시돼요 — 자동 이어서와 함께라면, 소진 계정을 미리 골라 두고
              풀리는 시각에 이어가게 할 수 있습니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'NEW',
      lead: 'Hitting a usage limit no longer ends your flow — the app now waits and picks up right where you left off when the limit resets.',
      notes: [
        {
          tag: 'Auto-continue',
          name: 'Continues automatically when the limit resets',
          desc: (
            <>
              Turn on <b>Auto-continue</b> under model chip → Billing, and a conversation
              stopped by a subscription limit resumes on its own at the <b>reset time</b>.
              While waiting, a strip above the composer shows the countdown (cancel anytime),
              and the app <b>double-checks the limit is actually lifted</b> before sending.
              Works in the main chat, multi-agent panels, and extra chat windows — the main
              chat&apos;s wait even survives an app restart.
            </>
          )
        },
        {
          tag: 'Accounts',
          name: 'Exhausted accounts can be shown again',
          desc: (
            <>
              Weekly-exhausted accounts (hidden since the last release) can be revealed with
              &quot;Show exhausted accounts&quot; at the tail of the account list. They now
              show <b>when they come back</b> instead of a meaningless 0% — pair one with
              auto-continue to wait out the reset on purpose.
            </>
          )
        }
      ]
    }
  },
  '2.3.10': {
    ko: {
      eyebrow: 'FIX',
      lead: '워크플로를 중지하거나 앱을 껐다 켠 뒤 첫 메시지가 답 없이 증발하던 문제를 뿌리부터 잡았습니다. 계정 선택도 쓸 수 있는 계정만 보여줘요.',
      notes: [
        {
          tag: '안정성',
          name: '메시지가 답 없이 끝나던 문제를 잡았어요',
          desc: (
            <>
              워크플로·백그라운드 작업이 돌던 대화를 <b>Esc로 중지</b>하거나 <b>앱을 껐다 켠</b>{' '}
              뒤, 다음 메시지가 &quot;응답 없이 끝났어요&quot;로 증발하는 일이 있었습니다.
              엔진이 다시 뜨며 밀린 작업 통지를 소화하는 턴이 <b>메시지를 함께 삼키는 경합</b>이
              원인 — 이제 그 시그니처를 감지하면 <b>메시지를 자동으로 다시 전달</b>합니다.
              직접 중지한 턴은 되살리지 않아요.
            </>
          )
        },
        {
          tag: '계정',
          name: '주간 한도가 끝난 계정은 숨겨요',
          desc: (
            <>
              계정 선택 목록에서 <b>주간 한도 잔여 0%</b>인 계정은 보이지 않습니다 — 골라도
              실행이 거부될 뿐이니까요. <b>5시간 한도</b> 소진은 곧 풀리니 그대로 보이고, 지금
              이 채팅이 쓰는 계정은 소진돼도 남아 다른 계정으로 벗어날 수 있어요. Claude와
              OpenAI(Codex) 계정 모두 같은 규칙입니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'FIX',
      lead: 'Fixed the root cause of a first message silently vanishing after stopping a workflow or relaunching the app. The account picker now only offers accounts you can actually use.',
      notes: [
        {
          tag: 'Stability',
          name: 'Messages no longer end with no reply',
          desc: (
            <>
              After <b>stopping a workflow with Esc</b> or <b>relaunching the app</b> while
              background work was running, the next message could vanish with &quot;this turn
              ended without a reply&quot;. The engine&apos;s restart turn that digests pending
              task notifications was <b>swallowing your message along with them</b> — the app
              now detects that signature and <b>automatically re-delivers your message</b>.
              Turns you interrupted yourself are never resurrected.
            </>
          )
        },
        {
          tag: 'Accounts',
          name: 'Accounts out of weekly quota are hidden',
          desc: (
            <>
              The account picker no longer lists accounts with <b>0% weekly limit left</b> —
              picking one would only get the run rejected. A drained <b>5-hour window</b> stays
              visible since it recovers soon, and the account this chat is currently bound to
              stays listed even when drained so you can switch away. The same rule applies to
              both Claude and OpenAI (Codex) accounts.
            </>
          )
        }
      ]
    }
  },
  '2.3.9': {
    ko: {
      eyebrow: 'PERFORMANCE',
      lead: '메모리를 통째로 다시 손봤습니다. 앱이 더 가볍게 뜨고, 대화가 아무리 길어져도 스크롤이 무거워지지 않고, 안 쓰는 프로세스는 스스로 물러납니다.',
      notes: [
        {
          tag: '성능',
          name: '앱이 훨씬 가볍게 뜹니다',
          desc: (
            <>
              시작할 때 <b>지금 보고 있는 대화만</b> 싣고 나머지는 전환하는 순간 되읽도록
              바꿨어요 — 대화가 수십 개여도 첫 화면까지의 짐이 늘지 않습니다. 화면 코드도{' '}
              <b>1/3로 압축</b>했고, 코드 뷰어(에디터)는 <b>처음 열 때</b> 로드해요.
            </>
          )
        },
        {
          tag: '채팅',
          name: '대화가 길어져도 스크롤이 무겁지 않아요',
          desc: (
            <>
              긴 대화는 <b>최근 부분만</b> 그리고, 위로 올라가면 <b>⋯ 표시에 닿는 대로 이어서</b>{' '}
              붙습니다 — 보던 위치는 그대로 고정돼요. 대화 내용은 하나도 지워지지 않고
              화면에 그리는 양만 줄인 것이라, <b>찾기(Ctrl+F)</b>나 <b>↑ 맨 위로</b>는 전체를
              펼친 뒤 동작합니다. 도구 기록도 최근 것만 보이고 <b>이전 도구 N개 펼치기</b>로
              마저 볼 수 있어요.
            </>
          )
        },
        {
          tag: '메모리',
          name: '안 쓰는 프로세스는 스스로 물러납니다',
          desc: (
            <>
              멀티 패널·추가 채팅이 띄운 엔진이 <b>15분 놀면 조용히 회수</b>돼요 — 대화는
              그대로라 다음 지시에서 이어집니다. AI가 돌린 빌드가 남기던{' '}
              <b>수백 MB짜리 상주 프로세스</b>도 차단했고, 코드 인텔리전스·사용량 기록·탐색기
              설정에도 각각 상한이 생겨 오래 켜 둘수록 늘던 메모리를 잡았습니다.
            </>
          )
        },
        {
          tag: '저장',
          name: '자동 저장이 대화 수에 밀리지 않아요',
          desc: (
            <>
              멀티 세션과 추가 채팅을 <b>항목별 파일로 나눠</b> 저장하도록 바꿨습니다 — 예전엔
              한 창에서 한 글자가 늘 때마다 <b>모든 대화를 통째로 다시 기록</b>해서, 쌓일수록
              저장이 무거워졌어요. 이제 <b>바뀐 것만</b> 씁니다. 기존 저장본은 처음 실행할 때
              자동으로 옮겨집니다.
            </>
          )
        },
        {
          tag: '다듬기',
          name: '카드 안 설명이 앱 결에 맞게',
          desc: (
            <>
              질문·워크플로 카드에서 <b>운영체제 기본 툴팁</b>이 뒤늦게 뜨던 자리들을 앱과 같은
              결의 설명으로 바꿨어요(카드 밖으로 잘리지 않게 방향도 손봤습니다). 업데이트
              확인은 <b>30분 간격</b>으로 완화해 배터리에서 덜 깨웁니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'PERFORMANCE',
      lead: 'A full memory overhaul. The app starts lighter, long conversations stay smooth no matter how far they run, and idle processes now bow out on their own.',
      notes: [
        {
          tag: 'Performance',
          name: 'The app starts noticeably lighter',
          desc: (
            <>
              Startup now loads <b>only the chat you are looking at</b> and re-reads the rest the
              moment you switch — dozens of chats no longer add weight before the first paint.
              The UI bundle is <b>a third of its old size</b>, and the code viewer (editor) loads{' '}
              <b>the first time you open it</b>.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'Long threads stay light to scroll',
          desc: (
            <>
              Long conversations render <b>only the recent stretch</b>, and scrolling up{' '}
              <b>extends it as you reach the ⋯ marker</b> — your reading position stays pinned.
              Nothing is dropped from the conversation itself, only from what gets drawn, so{' '}
              <b>Find (Ctrl+F)</b> and <b>↑ scroll-to-top</b> expand everything first. Tool logs
              show the latest rows with <b>Show N earlier tools</b> for the rest.
            </>
          )
        },
        {
          tag: 'Memory',
          name: 'Idle processes bow out on their own',
          desc: (
            <>
              Engines spun up by multi panels and extra chats are <b>reclaimed after 15 idle
              minutes</b> — the conversation is untouched and simply resumes on your next
              instruction. Builds run by the AI no longer leave <b>hundreds of megabytes of
              resident helpers</b> behind, and code intelligence, usage records, and explorer
              state each gained a cap, so memory no longer creeps the longer you leave it open.
            </>
          )
        },
        {
          tag: 'Saving',
          name: 'Autosave no longer scales with your chat count',
          desc: (
            <>
              Multi sessions and extra chats are now stored as <b>one file per item</b>. Before,
              a single keystroke in one window <b>rewrote every conversation wholesale</b>, so
              saving got heavier as chats piled up — now only <b>what changed</b> is written.
              Existing data migrates automatically on first launch.
            </>
          )
        },
        {
          tag: 'Polish',
          name: 'In-card hints now match the app',
          desc: (
            <>
              The question and workflow cards used to fall back to <b>the OS tooltip</b> in a few
              spots; those now use the app&apos;s own hint styling (repositioned so they never
              clip outside the card). Update checks eased to <b>every 30 minutes</b> to wake the
              network less on battery.
            </>
          )
        }
      ]
    }
  },
  '2.3.8': {
    ko: {
      eyebrow: 'UPDATE',
      lead: '멀티채팅 패널이 일을 마치면 자기 컬러 태그 색 테두리로 알려줍니다. AI가 도는 중에도 패널 이름이 제대로 바뀌고, 설정의 계정 카드는 꾹 눌러 끌면 순서를 바꿀 수 있어요.',
      notes: [
        {
          tag: '멀티',
          name: '끝난 패널은 자기 색으로 빛나요',
          desc: (
            <>
              패널이 <b>완료</b> 상태가 되면 그 패널의 <b>컬러 태그 색 테두리</b>가 패널을
              둘러쌉니다 — 헤더 하단 라인과 같은 색이라, 여러 패널을 돌려놓고도{' '}
              <b>어느 패널이 끝났는지</b> 색만으로 한눈에 읽혀요. 새 지시를 보내거나 대화를
              비우면 테두리도 함께 내려갑니다.
            </>
          )
        },
        {
          tag: '멀티',
          name: 'AI 작업 중에도 이름이 바뀌어요',
          desc: (
            <>
              패널이 답변을 스트리밍하는 동안 이름을 바꾸면 <b>입력한 글자가 계속 덮여
              지워지던</b> 문제를 고쳤습니다 — 매 토큰 렌더마다 입력칸 전체 선택이 다시
              걸리던 것으로, 한글 조합이 깨지던 것도 같은 원인이었어요. 이제 <b>연필·더블클릭
              ·F2</b> 어느 길로 들어가도 작업 중 여부와 무관하게 편안히 바뀝니다.
            </>
          )
        },
        {
          tag: '계정',
          name: '계정 카드를 꾹 눌러 끌어 정렬하세요',
          desc: (
            <>
              설정 › Account의 계정 카드를 <b>0.35초 꾹 누르면 집혀서</b>, 위아래로 끌면
              순서가 바뀝니다 — Anthropic·OpenAI 목록 모두요. 이 순서는{' '}
              <b>채팅의 계정 선택 목록에도 그대로</b> 반영돼, 자주 쓰는 계정을 맨 위로 올려둘
              수 있어요. 삭제·기본 버튼 클릭과는 충돌하지 않습니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Multi-chat panels now announce completion with a border in their own tag color. Renaming a panel works even while the AI is running, and account cards in Settings can be press-and-hold dragged into a new order.',
      notes: [
        {
          tag: 'Multi',
          name: 'Finished panels glow in their own color',
          desc: (
            <>
              When a panel reaches <b>Done</b>, a border in that panel&apos;s{' '}
              <b>color-tag hue</b> wraps around it — the same color as the header underline, so
              with several panels running you can tell <b>which one finished</b> at a glance.
              Sending a new instruction or clearing the chat lifts the border again.
            </>
          )
        },
        {
          tag: 'Multi',
          name: 'Renaming works while the AI is busy',
          desc: (
            <>
              Renaming a panel during a streaming reply used to <b>keep wiping what you
              typed</b> — every token re-render re-selected the whole input, which also broke
              Korean IME composition. Fixed at the root: whether you enter via{' '}
              <b>pencil, double-click, or F2</b>, editing now behaves the same busy or idle.
            </>
          )
        },
        {
          tag: 'Account',
          name: 'Press and hold to reorder accounts',
          desc: (
            <>
              In Settings › Account, <b>hold a card for 0.35s to pick it up</b>, then drag it
              up or down to reorder — both the Anthropic and OpenAI lists. The order carries
              over to <b>the account picker in chats</b>, so your go-to account can sit on
              top. It never collides with the Delete / Make-default buttons.
            </>
          )
        }
      ]
    }
  },
  '2.3.7': {
    ko: {
      eyebrow: 'UPDATE',
      lead: '자주 쓰는 프롬프트를 저장해 두고 클릭 한 번으로 복사해 쓰는 프롬프트 라이브러리가 생겼습니다. 작업 폴더의 최근 목록도 이제 안 쓰는 항목을 지울 수 있어요.',
      notes: [
        {
          tag: '프롬프트',
          name: '자주 쓰는 프롬프트를 저장해 두세요',
          desc: (
            <>
              사이드바 <b>추가 채팅 아래 &apos;프롬프트&apos;</b> 버튼이 라이브러리 카드를
              엽니다 — 자주 쓰는 지시를 저장해 두고, 목록에서 <b>행을 클릭하면 바로
              클립보드에 복사</b>돼요(초록 &apos;복사됨&apos; 피드백). 제목은 비워도 첫 줄로
              표시되고, 호버하면 복사·수정·삭제가 나옵니다. 저장한 목록은{' '}
              <b>모든 창이 공유</b>해요.
            </>
          )
        },
        {
          tag: '프롬프트',
          name: 'Enter로 저장, 제스처로 닫기',
          desc: (
            <>
              편집 화면은 테두리 없는 <b>종이 같은 캔버스</b> — 큰 제목과 본문이 밑줄 하나로
              나뉩니다. 채팅 입력창과 같은 문법으로 <b>Enter 저장 · Shift+Enter 줄바꿈</b>,
              마우스 제스처 <b>↓→ 닫기</b>와 목록 <b>↑/↓ 스크롤</b>도 다른 카드들과 똑같이
              통해요.
            </>
          )
        },
        {
          tag: '폴더',
          name: '최근 폴더를 지울 수 있어요',
          desc: (
            <>
              작업 폴더 목록의 최근 항목에 <b>호버하면 ✕</b>가 나타납니다 — 한 번 눌러본
              폴더가 계속 목록에 남는 게 싫을 때 그 자리에서 지워요. 지운 폴더는 다시
              사용하면 재등장하고, <b>비운 목록이 재시작 때 되살아나지도 않습니다</b>.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'A prompt library is here — save the prompts you reuse and copy them with a single click. The working-folder recents list can finally be pruned, too.',
      notes: [
        {
          tag: 'Prompts',
          name: 'Save the prompts you reuse',
          desc: (
            <>
              The new <b>&apos;Prompts&apos; button under Extra chat</b> in the sidebar opens a
              library card — save instructions you use often, and <b>click a row to copy it
              straight to the clipboard</b> (with a green &apos;Copied&apos; flash). Leave the
              title empty and the first line stands in; hover for copy, edit, and delete. The
              list is <b>shared across every window</b>.
            </>
          )
        },
        {
          tag: 'Prompts',
          name: 'Enter saves, gestures close',
          desc: (
            <>
              Editing happens on a borderless, <b>paper-like canvas</b> — a large title and the
              body split by a single underline. Same grammar as the chat composer:{' '}
              <b>Enter saves, Shift+Enter breaks a line</b>, and the mouse gestures work like
              every other card — <b>↓→ closes</b>, <b>↑/↓ scroll</b> the list.
            </>
          )
        },
        {
          tag: 'Folders',
          name: 'Recent folders can be removed',
          desc: (
            <>
              <b>Hover a recent entry</b> in the working-folder list and an <b>✕</b> appears —
              remove a folder you tried once and never meant to keep, right there. It comes
              back if you use it again, and <b>an emptied list no longer resurrects on
              restart</b>.
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
