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
  '2.4.3': {
    ko: {
      eyebrow: 'IMPROVED',
      lead: 'C# 코드 색칠·호버가 언리얼 프로젝트에서도 제대로 나옵니다 — 스크립트 폴더에 .cs만 있어도 알아서 프로젝트를 찾아내요.',
      notes: [
        {
          tag: 'C#',
          name: '프로젝트 파일이 안 보여도 색이 제대로 나와요',
          desc: (
            <>
              폴더에 <b>.cs 파일만</b> 있고 프로젝트 파일(.csproj)이 안 보이는 경우, 지금까지는
              앱이 그 파일들을 <b>소속 없는 낱파일</b>로 다뤄서 기본 문법만 색이 붙고{' '}
              <b>라이브러리·엔진 타입은 무색</b>이었습니다. 이제 프로젝트 파일이 다른 곳에
              생성돼 있으면 그걸 찾아내 함께 읽습니다 — <b>참조 라이브러리와 자동 생성
              코드까지</b> 색과 <b>호버 설명·F12 이동</b>이 모두 살아나요. 필요한 만큼만 열어
              분석하므로 <b>몇 초</b>면 준비됩니다.
            </>
          )
        },
        {
          tag: 'C#',
          name: '코드가 바뀌면 색도 알아서 따라가요',
          desc: (
            <>
              파일을 새로 만들거나, 다른 도구·터미널에서 코드가 바뀌거나,{' '}
              <b>참조 라이브러리를 다시 빌드</b>했을 때도 색과 호버가 <b>스스로 갱신</b>됩니다.
              예전엔 이런 변화가 반영되지 않아 새 타입이 무색으로 남고, 앱을 다시 켜야 회복되던
              자리들이에요.
            </>
          )
        },
        {
          tag: '탐색기',
          name: 'Git 상태 라벨을 하나로',
          desc: (
            <>
              변경사항이 없는 저장소가 브랜치 종류에 따라 <b>&apos;깨끗&apos;</b>과{' '}
              <b>&apos;최신&apos;</b> 두 이름으로 갈려 보이던 것을 <b>&apos;최신&apos;</b> 하나로
              통일했습니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'IMPROVED',
      lead: 'C# highlighting and hovers now work properly in Unreal projects — a script folder with nothing but .cs files finds its project on its own.',
      notes: [
        {
          tag: 'C#',
          name: 'Colors work even with no project file in sight',
          desc: (
            <>
              When a folder holds <b>only .cs files</b> with no project file (.csproj) beside
              them, the app used to treat them as <b>loose files with no project</b> — basic
              syntax got colored, but <b>library and engine types stayed plain</b>. Now the app
              locates the project file even when it&apos;s generated elsewhere and reads it too,
              so <b>referenced libraries and generated code</b> get full coloring,{' '}
              <b>hover docs, and go-to-definition</b>. It opens only what it needs, so it&apos;s
              ready in <b>seconds</b>.
            </>
          )
        },
        {
          tag: 'C#',
          name: 'Colors keep up when code changes',
          desc: (
            <>
              Adding a new file, editing code from another tool or the terminal, or{' '}
              <b>rebuilding a referenced library</b> now refreshes coloring and hovers{' '}
              <b>on its own</b>. Previously those changes went unnoticed — new types stayed
              plain until you restarted the app.
            </>
          )
        },
        {
          tag: 'Explorer',
          name: 'One label for a clean repo',
          desc: (
            <>
              A repository with no changes showed up as either <b>&quot;Clean&quot;</b> or{' '}
              <b>&quot;Up to date&quot;</b> depending on the branch — it&apos;s now always{' '}
              <b>&quot;Up to date&quot;</b>.
            </>
          )
        }
      ]
    }
  },
  '2.4.2': {
    ko: {
      eyebrow: 'NEW',
      lead: '멀티채팅 패널 이름을 자물쇠로 고정해 둘 수 있습니다 — 대화를 비우거나 작업 폴더를 바꿔도 그 이름 그대로예요.',
      notes: [
        {
          tag: '멀티',
          name: '패널 이름을 자물쇠로 고정해요',
          desc: (
            <>
              패널 제목 옆 <b>자물쇠</b>를 누르면 그 이름이 고정됩니다. 지금까지는{' '}
              <b>/clear</b>·제스처로 대화를 비우거나 <b>작업 폴더를 바꾸면</b> 이름이 지워지고
              다음 지시로 다시 지어졌지만, 잠가 두면 &quot;프론트&quot;·&quot;테스트&quot;처럼{' '}
              <b>역할 이름을 붙여 둔 패널</b>이 그대로 남습니다. 잠긴 채로도 <b>직접 이름
              바꾸기</b>는 그대로 되고(연필·더블클릭·F2), 잠금 상태는 자물쇠 아이콘이 계속
              켜져 있어 한눈에 보여요.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'NEW',
      lead: 'Multi-chat panel titles can now be pinned with a lock — clearing the conversation or switching the working folder no longer renames them.',
      notes: [
        {
          tag: 'Multi-agent',
          name: 'Lock a panel title in place',
          desc: (
            <>
              Click the <b>lock</b> next to a panel title to pin it. Until now,{' '}
              <b>/clear</b>, the clear gesture, or <b>changing the working folder</b> wiped the
              title and let the next prompt name it again — with the lock on, panels you&apos;ve
              named by role (&quot;Frontend&quot;, &quot;Tests&quot;) keep that name. You can
              still <b>rename by hand</b> while locked (pencil, double-click, F2), and the lock
              icon stays lit so the state is visible at a glance.
            </>
          )
        }
      ]
    }
  },
  '2.4.1': {
    ko: {
      eyebrow: 'FIX',
      lead: '계정을 추가할 때 브라우저 탭이 두 장(하나는 404) 뜨던 문제와, 파일을 고칠 때마다 도구 행의 +/- 숫자가 계속 불어나던 문제를 고쳤습니다.',
      notes: [
        {
          tag: '로그인',
          name: '로그인 탭이 하나만 열려요',
          desc: (
            <>
              계정을 추가하면 <b>인증 페이지가 두 장</b> 열리고, 그중 하나는{' '}
              <b>404 오류 페이지</b>인 일이 있었습니다. CLI가 이미 브라우저를 여는데 앱도 같이
              열면서, 앱이 잡은 주소가 인증 페이지가 아니라 <b>내부 로그인 서버 주소</b>였던 게
              원인 — 이제 브라우저는 한 번만 열립니다. 브라우저가 안 뜨는 환경을 위한{' '}
              <b>수동 링크</b>는 그대로 남아 있고, 링크 끝에 마침표가 붙어 깨지던 것도
              고쳤어요. Claude와 OpenAI(Codex) 로그인 모두 해당됩니다.
            </>
          )
        },
        {
          tag: '도구 행',
          name: '+/- 줄 수가 그 편집의 크기를 보여줘요',
          desc: (
            <>
              같은 파일을 여러 번 고치면 도구 행의 <b>+N −N이 회를 거듭할수록 불어나</b> 한 줄만
              고쳐도 큰 숫자가 뜨고, 대화 중에 새로 만든 파일은 이후 편집도 계속{' '}
              <b>&apos;새 파일&apos;</b>로 표시됐습니다. 이제 각 행은 <b>그 편집 하나의 증감</b>을
              보여줍니다 — 파일 전체 변경량은 원래대로 <b>변경 파일 목록과 diff</b>에서 볼 수
              있어요.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'FIX',
      lead: 'Fixed adding an account opening two browser tabs (one of them a 404), and tool rows whose +/- line counts kept growing with every edit to the same file.',
      notes: [
        {
          tag: 'Sign-in',
          name: 'Only one sign-in tab opens',
          desc: (
            <>
              Adding an account could open <b>two auth tabs</b>, one of them a{' '}
              <b>404 error page</b>. The CLI already opens the browser, and the app opened one
              too — using an address that was the <b>internal login server</b>, not the auth
              page. Now the browser opens exactly once. The <b>manual link</b> for environments
              where no browser opens is still there, and it no longer breaks on a trailing
              period. Applies to both Claude and OpenAI (Codex) sign-in.
            </>
          )
        },
        {
          tag: 'Tool rows',
          name: '+/- counts now reflect that one edit',
          desc: (
            <>
              Editing the same file repeatedly made each tool row&apos;s <b>+N −N grow
              cumulatively</b> — a one-line change could show a huge number — and a file created
              during the conversation kept reading <b>&quot;New file&quot;</b> on every later
              edit. Each row now shows <b>the size of that single edit</b>; the total change per
              file is still in the <b>changed-files list and diff</b>, as before.
            </>
          )
        }
      ]
    }
  },
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
