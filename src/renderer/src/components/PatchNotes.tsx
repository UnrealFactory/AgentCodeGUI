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
  '2.3.6': {
    ko: {
      eyebrow: 'FIX',
      lead: '중단(Esc) 한 번이 백그라운드 작업을 조용히 죽이고, 그 뒤로 대화가 계속 꼬이던 문제를 고쳤습니다. 이제 중단은 "지금 답변만 멈춰"입니다 — 뒤에서 돌던 작업은 계속 돌아요.',
      notes: [
        {
          tag: '중단',
          name: 'Esc가 백그라운드를 죽이지 않아요',
          desc: (
            <>
              중단(Esc·중지 버튼)이 답변만 끊는 게 아니라 <b>엔진 프로세스째 내려서</b>, 뒤에서
              돌던 셸·워크플로·에이전트가 통째로 사라졌습니다 — 이제 <b>지금 턴만 우아하게
              끊고</b> 백그라운드는 계속 돕니다. 상주 워크플로 위에서 Esc를 누르면 워크플로만
              곱게 멈추고, 중지 보고도 대화에 제대로 도착해요.
            </>
          )
        },
        {
          tag: '상주',
          name: '중단 후 계속 꼬이던 루프 수정',
          desc: (
            <>
              중단으로 죽은 백그라운드 작업이 <b>미결 통지</b>로 남아, 그 뒤 매 턴이 &quot;통지
              소화 → 턴 종료 직후 상주 사망 → 새 작업도 또 사망&quot;을 반복하는 <b>자기 영속
              루프</b>에 빠질 수 있었습니다(백그라운드로 시킨 일이 몇십 초 만에 소리 없이 죽고
              &quot;응답 없음&quot;이 뜨던 그 증상). 진입점이 사라져 루프가 시작되지 않아요.
            </>
          )
        },
        {
          tag: '채팅',
          name: '통지 처리 중 보낸 메시지가 작업을 자르지 않아요',
          desc: (
            <>
              백그라운드 작업의 완료 통지를 소화하는 <b>짧은 무음 턴</b>이 도는 사이에 메시지를
              보내면, 상주를 잘라내고 새로 시작하며 살아있던 작업까지 죽였습니다 — 이제 그
              턴이 끝나길 <b>잠깐 기다렸다 이어붙입니다</b>. 타이밍 나쁘게 보내도 안전해요.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'FIX',
      lead: 'Fixed a single stop (Esc) silently killing background work and leaving the chat tangled afterwards. Stop now means "stop this reply" — work running behind it keeps going.',
      notes: [
        {
          tag: 'Stop',
          name: 'Esc no longer kills background work',
          desc: (
            <>
              Stopping (Esc / the stop button) didn&apos;t just cut the reply — it took the{' '}
              <b>whole engine process down</b>, and background shells, workflows, and agents died
              with it. It now <b>gracefully ends just the current turn</b> while background work
              keeps running. Esc over a resident workflow stops only the workflow, and its
              wrap-up report still lands in the chat.
            </>
          )
        },
        {
          tag: 'Resident',
          name: 'The post-stop tangle loop is gone',
          desc: (
            <>
              Work killed by a stop lingered as an <b>undelivered notice</b>, and every turn
              after could repeat &quot;digest notice → resident dies right after the turn → new
              work dies too&quot; — a <b>self-perpetuating loop</b> (the one where background
              jobs silently died within seconds and &quot;ended without a reply&quot; appeared).
              The entry point is gone, so the loop never starts.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'Messages during notice handling no longer cut work',
          desc: (
            <>
              Sending a message while a <b>short silent turn</b> was digesting a completion
              notice used to cut the resident engine and respawn, killing live work — it now{' '}
              <b>briefly waits for that turn to end and attaches</b>. Bad timing is safe.
            </>
          )
        }
      ]
    }
  },
  '2.3.5': {
    ko: {
      eyebrow: 'UPDATE',
      lead: '멀티에이전트 패널을 한눈에 구분합니다 — 패널마다 이름을 직접 짓고, 컬러 태그가 기본으로 깔리고, 제목에 마우스를 올리면 처음 시킨 지시가 그대로 떠요. 워크플로 여러 개를 동시에 돌려도 이제 각자 알약으로 따로 추적됩니다.',
      notes: [
        {
          tag: '멀티',
          name: '패널 이름을 직접 지어요',
          desc: (
            <>
              패널 제목을 <b>더블클릭</b>(또는 호버 연필, 포커스한 패널에선 <b>F2</b>)하면 그
              자리에서 바로 수정합니다. 직접 지은 이름은 <b>다음 지시를 보내도 유지</b>되고,
              비워서 저장하면 원래의 자동 제목(첫 지시)으로 돌아와요.
            </>
          )
        },
        {
          tag: '멀티',
          name: '패널마다 컬러 태그',
          desc: (
            <>
              모든 패널 헤더 아래 <b>고유 색 라인</b>이 기본으로 깔립니다 — 1번 보라, 2번 파랑,
              3번 주황… 슬롯마다 색이 달라 &quot;어느 패널이더라&quot;가 <b>글보다 색으로 먼저</b>{' '}
              잡혀요. <b>번호 칩을 클릭</b>하면 7색을 돌며 바꿀 수 있고, 고른 색은 대화를 비워도
              유지됩니다.
            </>
          )
        },
        {
          tag: '멀티',
          name: '뭘 시켰는지 바로 확인',
          desc: (
            <>
              패널 제목에 <b>마우스를 올리면</b> 그 패널에 처음 시킨 <b>지시 원문</b>이 보낸
              시각·대화 턴 수와 함께 카드로 떠요. 제목은 요약, 원문은 한 호버 거리 —
              &quot;이 패널에 뭐 시켰더라&quot;가 사라집니다.
            </>
          )
        },
        {
          tag: '워크플로',
          name: '동시 워크플로를 각자 추적해요',
          desc: (
            <>
              한 대화에서 워크플로를 여러 개 돌리면 진행 표시가 <b>서로를 덮어쓰던</b> 문제 —
              이제 하단 도크에 <b>알약이 나란히</b> 뜨고, 펼친 카드의 <b>번호 탭</b>으로 오가며,
              중지도 각자 누릅니다. 끝난 워크플로의 알약만 조용히 사라져요.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Multi-agent panels are now easy to tell apart — name each panel yourself, color tags come on by default, and hovering a title shows the original first instruction. Multiple workflows in one chat are now tracked separately, each with its own pill.',
      notes: [
        {
          tag: 'Multi',
          name: 'Name your panels',
          desc: (
            <>
              <b>Double-click</b> a panel title (or the hover pencil — <b>F2</b> on the focused
              panel) to edit it in place. A name you set <b>survives further prompts</b>, and
              saving it empty falls back to the automatic title (the first instruction).
            </>
          )
        },
        {
          tag: 'Multi',
          name: 'A color tag on every panel',
          desc: (
            <>
              Every panel header now carries a <b>distinct color line</b> by default — violet
              for 1, blue for 2, orange for 3… so &quot;which panel was that&quot; registers{' '}
              <b>by color before you read a word</b>. <b>Click the number chip</b> to cycle
              through 7 colors; your pick survives clearing the chat.
            </>
          )
        },
        {
          tag: 'Multi',
          name: 'See what you asked, instantly',
          desc: (
            <>
              <b>Hover a panel title</b> and a card shows the <b>original first instruction</b>{' '}
              you gave that panel, with its time and turn count. The title is the summary; the
              full text is one hover away — no more &quot;what did I ask this one again?&quot;
            </>
          )
        },
        {
          tag: 'Workflow',
          name: 'Concurrent workflows, tracked separately',
          desc: (
            <>
              Running several workflows in one chat used to make their progress{' '}
              <b>overwrite each other</b> — pills now line up <b>side by side</b> in the dock,
              the expanded card switches between them with <b>number tabs</b>, and each has its
              own stop. Only a finished workflow&apos;s pill quietly disappears.
            </>
          )
        }
      ]
    }
  },
  '2.3.4': {
    ko: {
      eyebrow: 'FIX',
      lead: '클리어한 대화가 백그라운드 작업이 끝나는 순간 되살아나던 문제와, 중단 직후 보낸 메시지가 답 없이 씹히던 문제를 고쳤습니다. 멀티 채팅이 가로로 밀리던 것도 잡고, 트레이 우클릭 메뉴는 새로 그렸어요.',
      notes: [
        {
          tag: '클리어',
          name: '지운 대화가 되살아나지 않아요',
          desc: (
            <>
              /clear(↑↓ 제스처 포함)가 <b>화면만 지우고</b> 뒤에서 돌던 워크플로·셸·에이전트는
              살려 둬서, 그 작업이 끝나는 순간 정리 턴이 <b>빈 대화 위에서 되살아났습니다</b> —
              이제 클리어가 그 대화의 <b>백그라운드 작업까지 함께 회수</b>합니다(본채팅·추가
              채팅 창·멀티 패널 모두). 지웠으면 정말 끝이에요.
            </>
          )
        },
        {
          tag: '채팅',
          name: '중단 직후 보낸 메시지가 씹히지 않아요',
          desc: (
            <>
              백그라운드 작업 중 턴을 중단하면 완료 통지가 세션에 밀려 남는데, 다음 메시지가 그
              통지를 소화하는 <b>무음 턴</b>의 끝을 진짜 끝으로 오판해 — 줄 서 있던{' '}
              <b>진짜 답변 턴을 엔진째 닫아</b>버렸습니다. &quot;응답 없이 끝났어요&quot;만 남고
              답이 영영 안 오던 그 증상이에요. 이제 통지를 소화한 턴은 <b>진짜 턴이 시작될
              때까지 기다립니다</b>.
            </>
          )
        },
        {
          tag: '멀티',
          name: '패널이 가로로 밀리지 않아요',
          desc: (
            <>
              긴 파일 경로처럼 <b>안 꺾이는 글자</b>가 목록 안에 오면 좁은 패널 폭을 뚫고
              스레드가 <b>가로로 밀리던</b> 문제 — 목록·제목까지 줄바꿈 규칙을 넓히고, 스레드의{' '}
              <b>가로 스크롤 자체를 잠갔습니다</b>(본채팅·추가 창도 같은 잠금). 코드 블록과 표는
              지금처럼 자기 안에서만 가로 스크롤해요.
            </>
          )
        },
        {
          tag: '트레이',
          name: '우클릭 메뉴 새 단장',
          desc: (
            <>
              투박한 시스템 기본 메뉴 대신 <b>앱과 같은 결의 다크 카드</b>로 —{' '}
              <b>AgentCodeGUI 열기 / 완전히 종료</b> 두 줄, 호버 하이라이트, 커서 위로 조용히
              떠오릅니다. 언어 전환도 즉시 반영돼요.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'FIX',
      lead: 'Fixed cleared chats coming back to life the moment a background task finished, and messages sent right after a stop getting swallowed with no reply. Multi-chat no longer drifts sideways, and the tray right-click menu got a redesign.',
      notes: [
        {
          tag: 'Clear',
          name: 'Cleared chats stay cleared',
          desc: (
            <>
              /clear (and the ↑↓ gesture) only <b>wiped the screen</b> while workflows, shells,
              and agents kept running behind it — so the cleanup turn <b>resurrected the empty
              chat</b> the moment they finished. Clearing now <b>reclaims that chat&apos;s
              background work too</b> (main chat, extra chat windows, and multi panels alike).
              Cleared means gone.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'Messages after a stop are no longer swallowed',
          desc: (
            <>
              Stopping a turn mid-background-work leaves a completion notice queued in the
              session; the next message digests it as a <b>silent mini-turn</b>, whose end was
              mistaken for the real end — <b>shutting down the engine with your actual reply
              turn still queued</b>. That was the &quot;ended without a reply&quot; that never
              recovered. The digest turn now <b>waits for the real turn to start</b>.
            </>
          )
        },
        {
          tag: 'Multi',
          name: 'Panels no longer drift sideways',
          desc: (
            <>
              An <b>unbreakable token</b> like a long file path inside a list could punch past a
              narrow panel&apos;s width and drag the thread <b>sideways</b> — wrapping rules now
              cover lists and headings, and the thread&apos;s <b>horizontal scrolling is locked</b>{' '}
              (main chat and extra windows too). Code blocks and tables still scroll within
              themselves as before.
            </>
          )
        },
        {
          tag: 'Tray',
          name: 'Right-click menu redesigned',
          desc: (
            <>
              The clunky stock system menu is replaced with a <b>dark card that matches the
              app</b> — two rows, <b>Open AgentCodeGUI / Quit completely</b>, hover highlights,
              rising quietly above the cursor. Language switches apply instantly.
            </>
          )
        }
      ]
    }
  },
  '2.3.3': {
    ko: {
      eyebrow: 'UPDATE',
      lead: 'X를 눌러도 앱이 꺼지지 않습니다 — 트레이로 내려가 하던 일을 계속해요. 업데이트는 이제 항상 가장 마지막 패치본을 설치하고, 워크플로 알약이 대화 마지막 줄을 가리던 것도 고쳤습니다.',
      notes: [
        {
          tag: '트레이',
          name: '닫기는 이제 트레이로',
          desc: (
            <>
              창의 <b>X</b>(또는 Alt+F4)는 이제 앱을 끄지 않고 <b>시스템 트레이로 최소화</b>
              합니다 — 돌던 워크플로·백그라운드 셸·에이전트·추가 채팅이 그대로 이어져요. 트레이
              아이콘을 <b>클릭</b>하면 창이 돌아오고, 진짜 종료는 아이콘 <b>우클릭 → 종료</b>
              입니다. 처음 숨을 때 한 번, 계속 실행 중이라는 풍선 안내가 떠요.
            </>
          )
        },
        {
          tag: '업데이트',
          name: '항상 가장 마지막 패치본으로',
          desc: (
            <>
              새 버전을 받아둔 채 앱을 켜 두는 사이 <b>더 새 패치본</b>이 올라오면, 이전엔
              재시작 전까지 몰라서 <b>낡은 버전을 설치</b>했어요 — 이제 받아둔 상태에서도{' '}
              <b>10분마다 조용히 재확인</b>해 더 새 버전이 보이면 자동으로 갈아 받습니다.
              같은 버전 확인으로는 <b>나중에</b>로 접어둔 카드가 되뜨지 않아요.
            </>
          )
        },
        {
          tag: '채팅',
          name: '알약이 마지막 줄을 가리지 않아요',
          desc: (
            <>
              워크플로·질문 알약이 하단에 떠 있는 동안 대화의 <b>마지막 줄이 그 뒤에 숨던</b>{' '}
              문제 — 알약이 있는 동안 <b>본문 바닥 여백이 자동으로 늘어나</b>, 바닥에 붙어
              읽어도 마지막 줄이 알약 위로 올라옵니다. 두 알약이 이층으로 쌓이면 여백도 한 층
              더 올라가요.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Pressing X no longer quits the app — it minimizes to the system tray and keeps working. Updates now always install the very latest patch, and the workflow pill no longer covers the last line of the chat.',
      notes: [
        {
          tag: 'Tray',
          name: 'Close now goes to the tray',
          desc: (
            <>
              The window&apos;s <b>X</b> (or Alt+F4) no longer quits the app — it{' '}
              <b>minimizes to the system tray</b>, so running workflows, background shells,
              agents, and extra chats carry on. <b>Click</b> the tray icon to bring the window
              back; to really quit, <b>right-click the icon → Quit</b>. The first time it hides,
              a one-time balloon notes it is still running.
            </>
          )
        },
        {
          tag: 'Update',
          name: 'Always the very latest patch',
          desc: (
            <>
              If a <b>newer patch</b> was published while a downloaded update sat waiting, the
              app used to <b>install the stale one</b> until a restart — it now{' '}
              <b>quietly re-checks every 10 minutes</b> even in that state and swaps in the
              newer download automatically. Same-version checks never re-open a card you
              dismissed with <b>Later</b>.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'Pills no longer cover the last line',
          desc: (
            <>
              While a workflow or question pill floated at the bottom, the chat&apos;s{' '}
              <b>last line could hide behind it</b> — the thread&apos;s bottom padding now{' '}
              <b>grows automatically</b> while a pill is docked, so the last line sits above it
              even when pinned to the bottom. When both pills stack, the padding steps up one
              more tier.
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
