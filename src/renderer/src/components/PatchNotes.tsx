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
  '2.3.2': {
    ko: {
      eyebrow: 'FIX',
      lead: '백그라운드로 돌던 워크플로·에이전트가 도중에 소리 없이 끊기던 심각한 버그를 고쳤습니다 — 유휴 엔진 정리 안전망이 일하는 중인 엔진을 잘못 회수하던 게 원인이에요. 답이 오는데도 "응답 없이 끝났어요"가 뜨던 오탐도 함께 잡았습니다.',
      notes: [
        {
          tag: '상주',
          name: '일하는 엔진은 회수하지 않아요',
          desc: (
            <>
              안 쓰는 엔진을 정리하는 안전망(10/30분)이 내부 플래그 꼬임으로{' '}
              <b>워크플로가 한창 도는 상주 엔진</b>을 종료시킬 수 있었습니다 — 몇 시간짜리 검증
              루프가 새벽에 통째로 끊긴 실제 사고를 역추적해 찾았어요. 이제 타이머가{' '}
              <b>끄기 직전에 현재 상태를 재검증</b>하고, 살아있는 셸·워크플로·에이전트가
              하나라도 있으면 닫지 않습니다. 에이전트는 <b>전사 파일이 최근에 쓰였는지</b>까지
              확인해 조용히 일하는 중이면 살려 둬요.
            </>
          )
        },
        {
          tag: '상주',
          name: '에이전트 완료 보고가 잘리지 않아요',
          desc: (
            <>
              백그라운드 에이전트가 끝나는 <b>그 순간</b> 엔진을 정리해 버려, 결과를 정리해 주는{' '}
              <b>보고 턴이 잘리고</b> 후속 진행이 멈추던 문제 — 워크플로가 받던 유예를
              에이전트·셸도 똑같이 받아 <b>보고 턴까지 기다렸다</b> 정리합니다. 백그라운드로
              시킨 일이 끝나면 결과 정리가 대화에 제대로 도착해요.
            </>
          )
        },
        {
          tag: '오탐',
          name: '"응답 없이 끝났어요" 오탐 수정',
          desc: (
            <>
              밀린 완료 통지를 소화하는 <b>무음 턴</b>을 진짜 답변의 끝으로 오판해, 답이
              스트리밍되기 직전에 안내가 뜨던 버그 — 판정을 <b>프레임이 흐르는 동안 미루고</b>,
              다음 턴이 이어지는 게 보이면 아예 띄우지 않으며, 그래도 떴다면 답변이 오는 순간{' '}
              <b>자동으로 걷어냅니다</b>. 진짜 무음 턴의 안내는 그대로예요.
            </>
          )
        },
        {
          tag: '안내',
          name: '백그라운드 작업이 정리되면 이유를 남겨요',
          desc: (
            <>
              상주 중 <b>모델·모드·계정</b> 같은 실행 설정을 바꿔 보내면 백그라운드 작업을
              이어받을 수 없어 정리되는데, 지금까진 <b>아무 말 없이 사라졌습니다</b> — 이제 왜
              정리됐는지 스레드에 한 줄 안내가 남아요.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'FIX',
      lead: 'Fixed a serious bug where background workflows and agents were silently cut down mid-run — the idle-engine reclaimer was mistakenly collecting engines that were still working. Also fixed the false "ended without a reply" notice that appeared even as the answer was on its way.',
      notes: [
        {
          tag: 'Resident',
          name: 'Working engines are never reclaimed',
          desc: (
            <>
              The safety net that cleans up unused engines (10/30 min) could, through a stuck
              internal flag, shut down a resident engine <b>while a workflow was still
              running</b> — traced from a real incident where an hours-long verification loop
              was cut overnight. Timers now <b>re-validate live state right before closing</b>{' '}
              and never close while any shell, workflow, or agent is alive. For agents we even
              check <b>whether their transcript files were written recently</b>, so quiet
              workers stay alive.
            </>
          )
        },
        {
          tag: 'Resident',
          name: 'Agent wrap-up replies survive',
          desc: (
            <>
              Finishing a background agent used to tear the engine down <b>at that very
              moment</b>, cutting off the <b>wrap-up turn</b> that reports its results and
              continues the work — agents and shells now get the same grace workflows do: the
              engine <b>waits for the report turn</b> before cleaning up. When background work
              finishes, the wrap-up now lands in the chat properly.
            </>
          )
        },
        {
          tag: 'False alarm',
          name: 'False "ended without a reply" fixed',
          desc: (
            <>
              A <b>silent turn</b> digesting backlogged completion notices was mistaken for the
              end of the real answer, so the notice appeared right before the reply streamed in
              — the verdict is now <b>deferred while frames keep flowing</b>, skipped entirely
              when the next turn is seen coming, and if it still slipped through, it is{' '}
              <b>retracted automatically</b> the moment the answer arrives. Genuine silent-turn
              notices stay.
            </>
          )
        },
        {
          tag: 'Notice',
          name: 'Cleaned-up background work now says why',
          desc: (
            <>
              Sending with changed run settings (<b>model, mode, account</b>) while resident
              means background tasks cannot be carried over and get cleaned up — until now they{' '}
              <b>vanished without a word</b>. A one-line notice in the thread now explains why.
            </>
          )
        }
      ]
    }
  },
  '2.3.1': {
    ko: {
      eyebrow: 'UPDATE',
      lead: '영어 UI를 지원합니다 — 설정에서 한국어/영어를 재시작 없이 바로 전환해요. 그리고 메모리 대수술: 분석 서버·대화 스냅샷·상주 엔진이 쓰던 메모리를 절반 이하로 줄였습니다.',
      notes: [
        {
          tag: '언어',
          name: '한국어 · English',
          desc: (
            <>
              설정 › <b>Language</b>에서 UI 언어를 고릅니다 — <b>재시작 없이 즉시</b> 바뀌고, 채팅
              화면부터 업데이트 안내·git 메시지 같은 구석까지 <b>앱 전체</b>가 따라와요. 추가
              채팅 창 등 다른 창도 함께 전환됩니다.
            </>
          )
        },
        {
          tag: '메모리',
          name: '분석 서버가 쌓이지 않아요',
          desc: (
            <>
              코드 분석(LSP) 서버가 <b>작업 폴더마다 하나씩 쌓여</b> 며칠 상주하면 수 GB까지
              커지던 문제 — 이제 <b>안 쓰는 서버는 알아서 접고</b>(10~30분), 필요하면 다시
              띄웁니다. TS 서버는 구성 다이어트로 <b>세트당 프로세스 4→2개</b>. 실측 사례로{' '}
              <b>3.3GB → 약 1.5GB</b>예요.
            </>
          )
        },
        {
          tag: '메모리',
          name: '대화는 활성만 메모리에',
          desc: (
            <>
              쌓인 채팅·멀티 세션의 대화 기록을 전부 들고 있던 것을, <b>보고 있는 대화만</b> 들고
              나머지는 <b>전환할 때 디스크에서</b> 읽어오게 바꿨어요. 대화가 많을수록 컸던
              메모리가 가벼워지고, 유휴 애니메이션 루프도 멈춰 오래 켜둘수록 무거워지던 증상이
              사라집니다.
            </>
          )
        },
        {
          tag: '수정',
          name: '자잘한 정리',
          desc: (
            <>
              멀티 패널의 작업 바 팝오버(변경된 파일 등)가 <b>클릭한 칩 위에</b> 뜨도록 고쳤어요.
              완료 통지를 놓친 백그라운드 에이전트가 엔진 프로세스를 붙잡고 상주하던 것도{' '}
              <b>30분 안전망</b>으로 정리됩니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'The UI now speaks English — switch between Korean and English in Settings, no restart needed. Plus a memory overhaul: language servers, chat snapshots, and resident engines now use less than half the memory.',
      notes: [
        {
          tag: 'Language',
          name: '한국어 · English',
          desc: (
            <>
              Pick your UI language under Settings › <b>Language</b> — it switches{' '}
              <b>instantly, no restart</b>, and covers the <b>whole app</b>: from the chat surface
              down to updater notices and git messages. Extra chat windows follow along too.
            </>
          )
        },
        {
          tag: 'Memory',
          name: 'Language servers no longer pile up',
          desc: (
            <>
              Code-intelligence (LSP) servers used to <b>accumulate one per working folder</b>,
              growing to multiple GB over a few days. Now <b>idle servers fold themselves up</b>{' '}
              (10–30 min) and respawn on demand, and the TS server set slimmed from{' '}
              <b>4 processes to 2</b>. Measured case: <b>3.3GB → about 1.5GB</b>.
            </>
          )
        },
        {
          tag: 'Memory',
          name: 'Only the active chat stays in memory',
          desc: (
            <>
              Instead of holding every chat and multi-session transcript at once, the app now
              keeps <b>only what you are looking at</b> and reads the rest <b>from disk on
              switch</b>. Memory no longer grows with your chat history, and idle animation loops
              now stop — so the app stays light however long it runs.
            </>
          )
        },
        {
          tag: 'Fixes',
          name: 'Small clean-ups',
          desc: (
            <>
              Work-bar popovers in multi panels (changed files and friends) now open{' '}
              <b>above the chip you clicked</b>. Background agents that missed their completion
              notice used to keep the engine process resident — a <b>30-minute safety net</b>{' '}
              now reclaims them.
            </>
          )
        }
      ]
    }
  },
  '2.3.0': {
    ko: {
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
    en: {
      eyebrow: 'UPDATE',
      lead: 'Claude workflows are now supported — multi-agent, multi-stage runs finish in the background and post a wrap-up reply to the chat when they are done. Background shells and agents now outlive the turn too, and cancel is instant and clean.',
      notes: [
        {
          tag: 'Workflow',
          name: 'Workflows run to completion in the app',
          desc: (
            <>
              Ask Claude to use its <b>Workflow tool</b> (multi-agent orchestration) and the
              workflow <b>keeps running in the background</b> after the turn ends — when it
              completes, a <b>wrap-up reply arrives on its own</b>. Follow progress with the{' '}
              <b>pill</b> at the bottom: press it to unfold the <b>stage rail + agent board</b>{' '}
              (model, tokens, tool counts — live). Stop from the card, or tuck it away with{' '}
              <b>Esc</b> / the <b>↓→ gesture</b>.
            </>
          )
        },
        {
          tag: 'Resident',
          name: 'Background work outlives the turn',
          desc: (
            <>
              Background <b>shells</b> (dev servers and the like) and <b>subagents</b> no longer
              die with the turn — they <b>stay alive</b>. Messages sent while they run{' '}
              <b>continue in the same session</b> so the work never breaks, and changing folder,
              model, or account starts a fresh session as before. Main chat, multi panels, and
              extra chat windows alike.
            </>
          )
        },
        {
          tag: 'Cancel',
          name: 'Cancel is instant — and takes it back',
          desc: (
            <>
              <b>Esc</b> / the stop button now cuts the run <b>immediately</b>, sweeps your sent
              message and the half-arrived answer out of the thread, and{' '}
              <b>restores your sentence to the composer</b> — polish it and send again (a draft
              in progress is kept). Also fixed cancel not taking effect in multi chat.
            </>
          )
        },
        {
          tag: 'Input',
          name: '↑/↓ history only on an empty composer',
          desc: (
            <>
              While you are <b>writing</b>, ↑/↓ stay line movement; <b>only when the composer is
              empty</b> do they recall sent messages — no more being yanked into history
              mid-draft.
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
