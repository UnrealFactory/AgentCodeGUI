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
