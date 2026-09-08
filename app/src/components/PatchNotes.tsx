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

// chart — 본문(desc) 아래에 붙는 전/후 비교 막대(Cmp). 숫자를 문장에 늘어놓는 대신 막대로 보인다.
type Note = { tag: string; name: ReactNode; desc: ReactNode; chart?: ReactNode }
type Release = { eyebrow: string; lead: ReactNode; notes: Note[] }
type LocalizedRelease = { ko: Release; en: Release }

// ── 전/후 비교 막대 ──────────────────────────────────────────────────────────
// 한 행 = 지표 하나, 막대 둘(2.6.2 = 물러난 회색 · 3.0 = --blue). 길이는 행의 최댓값 대비 비율.
// 정체성은 색 하나에 안 맡긴다 — 범례 + 막대 끝 값 라벨(텍스트 토큰)이 같이 든다. 앱 스킴이
// 무채색이라 dataviz 검증기의 채도 기준엔 못 미치는 걸 알고 택한 값이다(CVD ΔE 30 · 대비는
// 라벨로 보강). 막대는 9px·데이터 끝만 4px 라운드·기준선 쪽은 각·둘 사이 3px 표면 간격.
type CmpRow = { label: string; before: number; after: number; unit: string }
function fmtNum(n: number, unit: string): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)}${unit}`
}
function Cmp({ rows, legend }: { rows: CmpRow[]; legend: [string, string] }): ReactNode {
  const summary = rows
    .map((r) => `${r.label}: ${legend[0]} ${fmtNum(r.before, r.unit)} → ${legend[1]} ${fmtNum(r.after, r.unit)}`)
    .join('; ')
  return (
    <div className="pn-cmp" role="img" aria-label={summary}>
      <div className="pn-cmp-legend">
        <span>
          <i className="pn-sw old" />
          {legend[0]}
        </span>
        <span>
          <i className="pn-sw new" />
          {legend[1]}
        </span>
      </div>
      {rows.map((r) => {
        const max = Math.max(r.before, r.after) || 1
        const delta = Math.round((r.after / r.before - 1) * 100)
        return (
          <div key={r.label} className="pn-cmp-row">
            <div className="pn-cmp-label">{r.label}</div>
            <div className="pn-cmp-bars">
              <div className="pn-cmp-bar" title={`${legend[0]} · ${fmtNum(r.before, r.unit)}`}>
                <i className="old" style={{ width: `${(r.before / max) * 100}%` }} />
                <span>{fmtNum(r.before, r.unit)}</span>
              </div>
              <div className="pn-cmp-bar" title={`${legend[1]} · ${fmtNum(r.after, r.unit)}`}>
                <i className="new" style={{ width: `${(r.after / max) * 100}%` }} />
                <span>{fmtNum(r.after, r.unit)}</span>
              </div>
            </div>
            <div className="pn-cmp-delta">{delta > 0 ? `+${delta}%` : `${delta}%`}</div>
          </div>
        )
      })}
    </div>
  )
}

// 3.0.0 실측(전부 2.6.2 → 3.0) — 출처는 아래 RELEASES 주석. 두 언어가 같은 수를 쓰도록 한 곳에.
const SIZE_ROWS = (ko: boolean): CmpRow[] => [
  { label: ko ? '설치 파일' : 'Installer', before: 157.5, after: 30.9, unit: 'MB' },
  { label: ko ? '설치 폴더' : 'Installed folder', before: 633.7, after: 139.4, unit: 'MB' }
]
const MEM_ROWS = (ko: boolean): CmpRow[] => [
  { label: ko ? '창 하나 더 열 때' : 'One extra window', before: 110.7, after: 19, unit: 'MB' },
  { label: ko ? '4패널 멀티 유휴' : '4-panel multi, idle', before: 505, after: 256, unit: 'MB' }
]
const START_ROWS = (ko: boolean): CmpRow[] => [
  { label: ko ? '첫 창이 뜰 때까지' : 'To first window', before: 336, after: 290, unit: 'ms' },
  { label: ko ? '쓸 수 있을 때까지' : 'To usable', before: 422, after: 373, unit: 'ms' }
]
const LEGEND: [string, string] = ['v2.6.2', 'v3.0']

// 커밋 수 — 리드 문장이 인용한다. 릴리즈 직전에 다시 세서 갱신할 것:
//   2.6.2까지 = git rev-list --count v2.6.2 · 3.0 = git rev-list --count v2.6.2..HEAD
//   (2026-09-02 실측: 137 / 426)
const COMMITS = { upTo262: 137, v3: 426 }
const RATIO = Math.floor(COMMITS.v3 / COMMITS.upTo262) // 「N배가 넘는」 — 내림이라 과장이 안 된다

// 버전별 패치노트 — 릴리즈마다 여기에 한 덩이씩(ko/en 두 벌) 얹는다. 카드의 버전
// 버튼으로 오갈 수 있는 건 최신 MAX_VERSIONS개까지 — 그보다 오래된 덩이는 릴리즈 때 지운다.
// ★ 2.x 덩이는 전부 지웠다(2026-09-02 사용자 지시) — 3.0은 앱 홈부터 새로 시작하고(2.6.2와
//   완전 분리·마이그레이션 없음) 2.6.2 설치본은 그대로 남으니, 3.0 카드가 2.x 소식을 되풀이할
//   이유가 없다. 이후 3.0.x 릴리즈부터 다시 5개 캡으로 쌓는다.
// ★ 2026-09-04 — 5 → 10. 카드가 860px로 커져 한 줄에 v3.0.x(한 자리) 12개 · v3.0.xx(두 자리)
// 11개까지 선다(JetBrains Mono 10.5px/600 · 알약 54.7/60.2px · gap 6 · 실측 헤드리스 렌더).
// 10이면 두 자리 패치 번호가 섞여도 한 줄이다.
const MAX_VERSIONS = 10
const RELEASES: Record<string, LocalizedRelease> = {
  //   키는 **풀버전**(`3.0.0`)이다. 앱 버전도 `3.0.0`(2026-09-02 beta.1 꼬리 제거 — Cargo.toml
  //   워크스페이스 + tauri.conf.json 두 곳)이라 `RELEASES[v]`가 바로 맞는다. 프리릴리즈 꼬리가
  //   붙은 빌드에서는 「현재 버전 노트가 없으면 최신 노트」 폴백이 이 덩이를 연다.
  //   숫자는 전부 **실측**이다. 반올림만 했고 지어낸 값은 없다.
  //   ★PATCHNOTES R1(§1.6-D 해소) — 용량·메모리 수치를 **배포 경로**(사용자가 실제로 켜는 자리)
  //   실측으로 갈아 끼웠다. 옛 값은 LSP가 안 뜨던 판의 것이라 오늘 사용자가 겪는 값이 아니다.
  //   출처: bench/results/multi-tauri-3.0.0-default-patchnotes-dist.json(exe sha `730e8b2d…` ·
  //   launchCwd = 배포 모사 · 3회) · coldstart-patchnotes-dist.json · docs/parity-fix-patchnotes-r1.md.
  //
  //   ★★GATES R2(2026-09-01) — **02 메모리 절만** 오늘의 배포 경로 실측으로 다시 갈아 끼웠다.
  //   LSPIDLE(온디맨드 기동)이 착지하면서 **유휴에 언어 서버가 한 톨도 안 뜬다** → PATCHNOTES R1이
  //   적은 「361MB · 그중 코드 인텔리전스 102MB」가 통째로 낡았다.
  //   출처: bench/results/multi-tauri-3.0.0-default-gates2-dist.json
  //     (exe sha `d896c0ee…` · launchCwd = `%LOCALAPPDATA%\ccg-gates-r2` 배포 모사 · 3회 중앙값)
  //   ★**어느 열인지**: `505MB → 256MB`는 둘 다 **Private** 열이다
  //     (2.6.2 = 박제 505.3 · 3.0 = 오늘 255.6). 창당 `19MB`와 `110.7MB`는 **WS** 열이다.
  //     PATCHNOTES R1이 WS(115)와 Private(101.6)을 한 문장에 섞은 사고(§3.1 ★R2 정정)가 있던
  //     자리라, 값을 옮길 때 열 이름을 값과 함께 들고 다닌다. (Cmp 막대도 행마다 따로 견준다 —
  //     한 행 안의 두 값만 같은 열이면 된다.)
  //   「약 100MB」 = 서버가 실제로 떠 있을 때의 Private 몫(101.6MB · GATES R1 = PATCHNOTES R1
  //     실측이 같은 자리를 두 번 세웠다). 유휴에는 그 몫이 **0**이다.
  //   ★**용량(01) 절은 안 건드렸다** — 설치기 바이트는 NSIS를 다시 구워야 재는데 이 라운드는
  //     안 구웠다. LSPIDLE 다이어트(−14.1MB)로 실제 값은 공시값보다 **작아졌을 뿐**이라
  //     공시가 사용자에게 불리한 방향으로 틀리지 않는다(설치 폴더 실측 139.4 → 125.2MB ·
  //     bench/results/footprint-gates2.json). 다음에 설치기를 구울 때 같이 고칠 자리다.
  //   시작 시간(336→290 / 422→373)은 m12 설치본 실측 그대로 둔다 — 오늘 재측정이 254 / 329.5로
  //   **더 빠르지만** 분모(2.6.2)가 그 세션 값이라 짝을 깨지 않는다(§1.6-E의 교훈).
  //   크래시 복구 0.45초는 이 라운드가 안 건드린 값이다.
  //   ★2026-09-02 개편 — 01을 「Electron → Tauri + Rust」 이야기로, 수치(용량·메모리·시작)는
  //     Cmp 막대로, 「폴더 우클릭」 항목은 삭제. 값은 하나도 안 바꿨다.
  //   ★2026-09-02 확장 — v2.6.2..HEAD 426커밋을 훑어 사용자 향 변화 전부를 05~19로 얹었다
  //     (채팅 엔진·도구 행·MCP & Skill 칩·뷰어 창·한도 두 갈래·계정·다이얼 1·사이드바/알림·
  //     채팅 손맛·Git·창/트레이·휴지통·홈 분리·Verse 제거). 문구의 UI 문자열은 전부 app/src에서
  //     실재를 확인한 것(「한도 소진 시」·「별도 창으로」·「사용 중」·COUNT_OPTIONS 1~6·tray.rs).
  // 3.0.3 — 「쓰다 보면 느려지다 응답 없음」(2026-09-03, WER AppHangB1 ×2): ① 허브가 스트리밍 중
  //   20ms 틱마다 슬롯마다 boards 인덱스+파일을 디스크에서 재읽기(lite::build → panel_seat_for_chat)
  //   → fanout Store에 세대+지문 캐시 ② chat:*·chats:* IPC가 async 워커에서 hub::call 3초 대기
  //   → spawn_blocking ③ 렌더러 토큰당 hasRunningBash 전체 스캔·도구 행 무memo·bgTasks/stderr/
  //   sent_user_texts/revisions 무캡·저장 디바운스 → 캡·memo·2초 ④ UI 스레드 감시 + 미니덤프
  //   ⑤ 파일 뷰어 본문을 등장 애니 뒤에 마운트·자동숨김 사이드바 그림자 ::after ⑥ 도구 행 툴팁 제거.
  // 3.0.9 — 2026-09-05 제보: Anthropic이 한도를 초기화해 줬는데(결제 직후·지원 처리) 설정·picker는 「Fable 0% 남음 · 곧」
  //   그대로(스크린샷). 실측: 디스크 캐시는 몇 분 뒤 정상값(Fable 1%)으로 갱신됐지만 그 사이 화면은 옛 값 — 캐시(셸 2분·
  //   메모리 5분·렌더러 1분)가 값의 나이만 보고 **리셋 시각을 지난 값**인지는 아무도 안 봤다 + 설정 탭은 주기 갱신 없음.
  //   같은 화면의 lmg 계정은 19시간 전 값: usage API가 429 + Retry-After 3600을 돌려주는데 30초 상한으로 잘라 자고 되묻고
  //   3분 격리 뒤 또(워커도 따로) → 차단이 안 풀림. → usage.rs AccountUsage::rolled + parity/usage.rs 디스크·메모리 적중에서
  //   지난 창 제외 + net.rs NetError::RateLimited(긴 Retry-After는 자지 않고 그 길이로 격리 · 상한 1시간) + acct_switch
  //   note_hold + 렌더러 lib/usageWindow.ts(windowRolled·nextReset) + accounts.ts scheduleRolledRefresh(리셋 시각 타이머 ·
  //   지난 창은 즉시, 계정당 1분) + Settings LimRow 「초기화됨 · 새 값 확인 중」·useNowSec·정렬 키 + Chat picker 줄·소진 숨김.
  '3.1.3': {
    ko: {
      eyebrow: 'UPDATE',
      lead: 'Codex 대화에서도 /btw로 현재 맥락을 이어받은 질문 창을 열 수 있습니다. 대화를 연 뒤 추가하거나 삭제한 계정이 전송에 바로 반영됩니다.',
      notes: [
        { tag: 'Codex', name: '/btw 질문 창 지원', desc: 'Codex 대화에서 /btw 질문을 입력하면 현재 대화를 분기한 별도 창이 열리고 첫 질문이 바로 전송됩니다. 본 작업은 계속 진행되고, 질문과 후속 답변은 별도 창에서 이어집니다.' },
        { tag: 'Codex', name: '원본 작업 목표를 이어받지 않음', desc: '분기된 질문 창은 원본 대화의 자동 진행 목표를 해제한 뒤 질문을 보냅니다. 분기가 실패하면 질문을 보내지 않고 오류로 표시하며, 다시 보내도 원본 대화에 이어쓰지 않고 새로 분기합니다.' },
        { tag: '계정', name: '열린 대화에 계정 변경 반영', desc: '대화를 연 뒤 계정을 추가하거나 삭제해도 다음 전송부터 바로 반영됩니다. 선택한 계정이나 폴더를 적용할 수 없으면 이전 계정으로 보내지 않고 전송을 취소하며, 입력한 내용은 유지됩니다.' }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Codex chats can now open a /btw side window that inherits the current context. Accounts added or removed after a chat was opened apply to its next send.',
      notes: [
        { tag: 'Codex', name: '/btw side questions', desc: 'Typing a /btw question in a Codex chat opens a separate window forked from the current conversation and sends the question right away. The main task keeps running, and the question and follow-ups continue in the side window.' },
        { tag: 'Codex', name: 'No inherited task goal', desc: 'The forked window clears the original conversation’s automatic goal before sending. If forking fails, the question is not sent and an error is shown; sending again forks anew instead of appending to the original conversation.' },
        { tag: 'Accounts', name: 'Account changes apply to open chats', desc: 'Accounts added or removed after a chat was opened take effect on its next send. If the selected account or folder cannot be applied, the send is cancelled instead of going out under the previous account, and your input is kept.' }
      ]
    }
  },
  '3.1.2': {
    ko: {
      eyebrow: 'BUG FIX',
      lead: '분할 수를 줄일 때 기존 대화가 빈 패널로 바뀌어 보이던 문제를 수정했습니다.',
      notes: [
        { tag: '배치', name: '분할을 줄여도 기존 대화 유지', desc: '5번 패널을 선택한 상태에서 5→4분할로 줄여도 기존 1~4번 대화가 유지되고 5번만 접힙니다. 2~6분할 전환은 표시 순서를 유지하며, 다시 늘리면 접힌 대화와 작성 중인 초안이 그대로 돌아옵니다.' },
        { tag: '배치', name: '1분할에서 원래 순서로 복귀', desc: '1분할에서는 선택한 대화를 보여 주고, 다시 여러 분할로 돌아가면 원래 순서를 복원합니다. 선택했던 대화가 앞쪽 패널을 밀어내지 않도록 수정했습니다.' }
      ]
    },
    en: {
      eyebrow: 'BUG FIX',
      lead: 'Fixed existing conversations appearing to be replaced by a blank panel when reducing the panel count.',
      notes: [
        { tag: 'Layout', name: 'Keep existing conversations when reducing panels', desc: 'Switching from five panels to four keeps conversations 1–4 in place and folds only panel 5, even when it is selected. Changes between two and six panels preserve display order; expanding again restores folded conversations and unsent drafts.' },
        { tag: 'Layout', name: 'Restore the original order after single-panel view', desc: 'Single-panel view shows the selected conversation. Returning to multiple panels restores the original order, so that conversation no longer displaces an earlier panel.' }
      ]
    }
  },
  '3.1.1': {
    ko: {
      eyebrow: 'UPDATE',
      lead: 'Blazor 코드 보기와 관련 파일 정리를 개선했습니다. 서브에이전트의 모델·추론 강도를 확인하고, 지난 연결 오류와 현재 재시도 상태를 구분할 수 있습니다.',
      notes: [
        { tag: 'Blazor', name: 'Razor 구문 색상과 코드 분석', desc: 'Razor의 마크업과 C# 구문을 구분해 표시합니다. C# 코드 분석을 설정한 프로젝트에서는 컴포넌트와 코드비하인드의 호버·정의 이동·의미 기반 색상을 지원합니다.' },
        { tag: '탐색기', name: '관련 파일을 Razor 파일 아래로', desc: '같은 폴더의 .razor·.cshtml 파일 아래에 .cs·.css·.js·.ts 동반 파일을 묶습니다. 펼침 상태를 기억하며, 원본 파일이 없는 동반 파일은 개별 항목으로 표시합니다.' },
        { tag: '에이전트', name: '서브에이전트 모델과 추론 강도', desc: '서브에이전트 목록과 상세 카드에 엔진이 제공하는 모델·추론 강도를 표시합니다. 늦게 도착한 정보도 완료된 작업을 다시 실행 중으로 바꾸지 않고 갱신합니다.' },
        { tag: '진단', name: '반복 오류를 접힌 기록으로', desc: 'stderr와 재연결 알림을 실행별 기록으로 모으고, 연속으로 반복된 출력은 횟수로 표시합니다. 기록을 펼치면 원문을 볼 수 있으며, 기존 대화에 쌓인 알림도 정리합니다.' },
        { tag: '상태', name: '현재 재시도와 지난 오류 구분', desc: '하단에는 최신 재시도 단계만 표시하고, 답변이나 도구 실행이 재개되면 기록을 ‘작업 재개됨’으로 바꿉니다. 이전 실행이나 백그라운드 작업의 통지가 현재 재시도 상태를 덮지 않도록 수정했습니다.' },
        { tag: '표시', name: '작업 표시 문구 정리', desc: 'Codex 대화의 작업 도구 설명에 Claude 이름이 나오던 오류를 수정하고, 작업 표시줄의 반복적인 클릭 안내 문구를 정리했습니다.' }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Improves Blazor code viewing and companion file organization. See subagent models and reasoning effort, and distinguish past connection errors from the current retry.',
      notes: [
        { tag: 'Blazor', name: 'Razor syntax and code analysis', desc: 'Razor markup and C# syntax have distinct colors. Projects with C# code analysis configured support hover, go to definition and semantic colors across components and code-behind files.' },
        { tag: 'Explorer', name: 'Group Razor companion files', desc: 'Groups .cs, .css, .js and .ts companions beneath their .razor or .cshtml file in the same folder. Expansion is remembered, and companions without a parent remain visible as individual files.' },
        { tag: 'Subagents', name: 'Show model and reasoning effort', desc: 'Subagent lists and detail cards show model and reasoning effort when supplied by the engine. Late metadata updates no longer turn completed work back into a running task.' },
        { tag: 'Diagnostics', name: 'Fold repeated output into logs', desc: 'Groups stderr and reconnection notices by run, with counts for consecutive repeated lines. Expand a log to read the original output. Previously accumulated notices are grouped when restoring a conversation.' },
        { tag: 'Status', name: 'Separate current retries from past errors', desc: 'The working indicator shows the latest retry phase. When responses or tools resume, the log changes to “Work resumed.” Events from old runs and background tasks no longer overwrite the current retry state.' },
        { tag: 'Display', name: 'Clearer activity labels', desc: 'Fixed Claude appearing in tool descriptions for Codex chats, and removed repetitive click instructions from activity indicators.' }
      ]
    }
  },
  '3.1.0': {
    ko: {
      eyebrow: 'FEATURE UPDATE',
      lead: '도구 실행 내역을 더 자세히 확인하고, Codex 초기화권과 모델별 컨텍스트를 앱에서 관리하세요. 질문 카드·이미지·스크롤·완료 알림도 개선했습니다.',
      notes: [
        { tag: '도구', name: 'Web 검색부터 MCP 응답까지', desc: 'Codex의 검색어와 결과 링크를 펼쳐 보고, Bash의 전체 명령·출력·종료 코드와 MCP의 요청 인자·응답·오류를 상세 카드에서 확인할 수 있습니다. Web 아이콘과 펼치기 화살표의 가독성도 다듬었습니다.' },
        { tag: '에이전트', name: '서브에이전트의 도구 내역 열기', desc: '서브에이전트 카드 안에서도 도구를 눌러 요청·결과와 파일을 확인하세요. 상세 화면에서 닫기·Esc·왼쪽 마우스 제스처로 이전 카드에 돌아옵니다.' },
        { tag: '초기화권', name: 'Codex 초기화권 조회와 사용', desc: '설정 › Account의 OpenAI 계정에서 보유 수량과 제공되는 상세 정보를 확인하고 직접 사용할 수 있습니다. 응답을 못 받은 요청은 같은 요청으로 재확인해 중복 사용을 방지합니다. 제공 여부는 계정과 Codex 버전에 따라 다릅니다.' },
        { tag: '컨텍스트', name: '모델별 크기와 자동 압축 기준', desc: '설정 › Engine에서 채팅에 표시되는 Codex 모델별 값을 확인하고 기본값·추천값·직접 설정 중 선택하세요. 처음에는 기본값이며 추천값은 직접 선택해 저장할 때만 적용됩니다. 컨텍스트 관리는 별도의 ON/OFF 카드로 분리했습니다. 둘 다 새 대화·재연결부터 적용됩니다.' },
        { tag: '질문', name: 'Codex 질문에 카드로 답하기', desc: 'Codex가 답변 중 보낸 질문도 카드로 표시합니다. 작업을 억지로 중단하지 않고 답을 보내며, 전송이 실패하면 입력을 유지해 다시 시도할 수 있습니다.' },
        { tag: '이미지', name: '첨부 이미지를 대화 안에서', desc: 'Markdown의 로컬 이미지가 링크처럼 보이거나 표시되지 않던 문제를 수정했습니다. 대화에서 이미지를 바로 보고 클릭해 확대할 수 있습니다.' },
        { tag: '스크롤', name: '답변 중 글자 겹침과 떨림 개선', desc: 'AI가 답변하는 동안 위로 스크롤했다 돌아오면 글자가 겹치거나 빠르게 떨리던 현상을 개선했습니다.' },
        { tag: '알림', name: '예전 완료 알림 반복 수정', desc: '내부 정리 작업이나 대화 복원, 반복된 상태 통지 때문에 지난 답변을 다시 알리던 문제를 수정했습니다. 중단·초기화도 완료로 알리지 않습니다.' }
      ]
    },
    en: {
      eyebrow: 'FEATURE UPDATE',
      lead: 'Inspect more tool activity and manage Codex resets and per-model context settings in the app. Also improves question cards, images, scrolling and completion alerts.',
      notes: [
        { tag: 'Tools', name: 'From web queries to MCP responses', desc: 'Expand Codex search queries and result links. Detail cards show full Bash commands, output and exit codes, plus MCP arguments, responses and errors. Web icons and expand arrows are easier to read.' },
        { tag: 'Subagents', name: 'Open every tool in the activity list', desc: 'Click tools inside a subagent card to inspect requests, results and files. Close, Escape or a left mouse gesture returns to the previous card.' },
        { tag: 'Resets', name: 'View and use Codex resets', desc: 'Open an OpenAI account under Settings › Account to see the balance, available details and use a reset manually. Unconfirmed requests reuse the same request on retry to prevent double spending. Availability depends on the account and Codex version.' },
        { tag: 'Context', name: 'Per-model windows and compaction thresholds', desc: 'Settings › Engine lists the Codex models shown in chat with Default, Recommended and Custom presets. Default is selected initially; Recommended requires an explicit save. Context management has its own ON/OFF card. Both settings apply to new or reconnected chats.' },
        { tag: 'Questions', name: 'Answer Codex questions in a card', desc: 'Questions sent while Codex is working now appear as cards. Send an answer without manually stopping the task. Failed sends preserve your input for retry.' },
        { tag: 'Images', name: 'See attached images in the conversation', desc: 'Fixed local Markdown images appearing as links or not loading. Images display inline and open in the image viewer when clicked.' },
        { tag: 'Scrolling', name: 'Steadier text during streaming', desc: 'Improved overlapping or rapidly jittering text when scrolling up and returning to an AI response that is still streaming.' },
        { tag: 'Alerts', name: 'Stop repeated alerts for old replies', desc: 'Fixed internal cleanup, restored chats and repeated status events announcing a previous reply again. Stopping or clearing a chat no longer counts as completion.' }
      ]
    }
  },
  '3.0.13': {
    ko: {
      eyebrow: 'UPDATE',
      lead: '시스템 환경 연결과 Claude 계획 검토를 추가하고, 파일 링크와 계정 표시·세션 복구를 개선했습니다.',
      notes: [
        { tag: '환경', name: '내 PC의 CLI와 로그인 사용', desc: 'Claude와 Codex 각각 앱 관리 또는 시스템 환경을 선택할 수 있습니다. 시스템 환경에서는 PC에 설치된 CLI와 기존 로그인·설정을 사용합니다. 환경 변경은 앱을 다시 시작한 뒤 새 대화에 적용됩니다.' },
        { tag: '설정', name: '실행 파일과 설정 폴더를 쉽게 지정', desc: '자동 감지 결과와 진행 상태를 확인하고, 파일·폴더 선택 버튼으로 경로를 직접 지정할 수 있습니다. 변경할 때만 저장·취소 버튼이 나타나며, 경로 글꼴과 툴팁도 다듬었습니다.' },
        { tag: '계획', name: '해당 세션에서 Claude 계획 검토', desc: 'Claude가 계획 승인을 요청하면 해당 대화 안에서 내용을 읽고 승인하거나 거절할 수 있습니다. 계획 새로고침·복사를 지원하며, 승인·거절 결과는 질문 답변처럼 채팅에 남고 다시 열어도 유지됩니다.' },
        { tag: '파일', name: '채팅의 로컬 파일 링크 열기', desc: '상세 제안서나 SVG 시안 등 로컬 파일 링크에 밑줄만 표시되고 클릭해도 열리지 않던 문제를 수정했습니다.' },
        { tag: '계정', name: '사용 중인 계정을 정확하게 표시', desc: 'Claude와 GPT의 사용 세션 수가 섞여 집계되던 문제를 수정했습니다. GPT 계정에도 현재·사용 중 표시와 주간 소진 계정 숨기기를 추가하고, 초기화 시각이 지난 계정은 다시 표시합니다.' },
        { tag: '복구', name: '한도 소진 뒤 GPT 세션이 막히던 오류 수정', desc: '과거 Claude 계정 연결 정보 때문에 GPT 세션이 Clear 후에도 실행되지 않던 문제를 수정했습니다. 사용 가능한 GPT 계정으로 전환한 뒤 기존 세션에서 대화를 이어갈 수 있습니다.' }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Adds system environments and Claude plan review, with fixes for file links, account indicators and session recovery.',
      notes: [
        { tag: 'Environment', name: 'Use your installed CLI and login', desc: 'Choose an app-managed or system environment separately for Claude and Codex. System mode uses the CLI, login and settings already on your PC. Environment changes apply to new chats after restarting the app.' },
        { tag: 'Settings', name: 'Choose executable and config paths', desc: 'Automatic detection now shows progress and results, and file and folder pickers let you select paths directly. Save and Cancel appear only when changes are pending. Path typography and tooltips have also been refined.' },
        { tag: 'Plans', name: 'Review Claude plans in their own session', desc: 'When Claude requests plan approval, read and approve or decline the plan inside that conversation. Plans support refresh and copy. Decisions appear in chat like question answers and remain after reopening.' },
        { tag: 'Files', name: 'Open local file links in chat', desc: 'Fixed underlined local file links, such as proposals and SVG previews, doing nothing when clicked.' },
        { tag: 'Accounts', name: 'Accurate account usage indicators', desc: 'Fixed Claude and GPT sessions being counted together. GPT accounts now show current and in-use indicators and support hiding accounts with exhausted weekly limits. Accounts reappear once their reset time has passed.' },
        { tag: 'Recovery', name: 'Recover GPT sessions after a limit', desc: 'Fixed stale Claude account references blocking GPT sessions even after Clear. Switching to an available GPT account now lets you continue in the existing session.' }
      ]
    }
  },
  '3.0.12': {
    ko: {
      eyebrow: 'UPDATE',
      lead: '모델을 바꾼 뒤 다음 메시지가 이전 모델로 실행될 수 있던 문제를 수정했습니다.',
      notes: [
        { tag: '모델', name: '다음 메시지에 선택한 모델 적용', desc: '이전 작업이 진행 중일 때 모델을 바꾸고 메시지를 보내면, 새 선택이 반영되지 않던 전송 오류를 수정했습니다. Codex와 Claude 모두 적용됩니다.' }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Fixed a case where the next message could run with the previous model after changing the selection.',
      notes: [
        { tag: 'Models', name: 'Use the selected model for the next message', desc: 'Fixed sends retaining the previous model when a model change was waiting for the active turn to finish. Applies to both Codex and Claude.' }
      ]
    }
  },
  '3.0.11': {
    ko: {
      eyebrow: 'UPDATE',
      lead: '사이드바와 파일 뷰어의 반응을 개선하고, Codex 작업 표시와 툴팁을 수정했습니다.',
      notes: [
        { tag: '사이드바', name: '자동 펼침 반응 개선', desc: '자동 모드에서 마우스를 가까이 가져갈 때 불필요한 화면 갱신을 줄여, 사이드바가 더 가볍게 펼쳐지고 접힙니다.' },
        { tag: '파일', name: '파일 뷰어를 더 빠르게', desc: '파일을 열 때 본문 표시를 늦추던 대기를 제거했습니다. 뷰어를 미리 준비하고 읽기 모드의 색상 정보를 재사용해 처음 열 때와 다시 열 때의 지연을 줄였습니다.' },
        { tag: 'Codex', name: '작업 중 문구가 바로 표시', desc: '중간 답변이 끝난 뒤에도 작업이 이어지면 작업 중 문구가 바로 다시 나타납니다. 다음 도구 실행까지 30초~1분 동안 표시가 사라지던 문제를 수정했습니다.' },
        { tag: '툴팁', name: '속도 설명도 앱 툴팁으로', desc: '표준·Fast 등의 속도 설명에 앱 툴팁을 적용했습니다. 메뉴 가장자리에서도 설명이 잘리지 않으며 키보드로 선택할 때도 확인할 수 있습니다.' }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Improves sidebar and file viewer responsiveness, and fixes Codex activity indicators and tooltips.',
      notes: [
        { tag: 'Sidebar', name: 'Smoother automatic reveal', desc: 'Reduced unnecessary screen updates when moving the pointer near the edge, making the sidebar lighter to open and close in automatic mode.' },
        { tag: 'Files', name: 'Faster file previews', desc: 'Removed the wait before showing file content. The viewer is prepared ahead of time and reuses syntax colors in read mode to reduce delays on first open and reopen.' },
        { tag: 'Codex', name: 'Activity returns immediately', desc: 'The working indicator now returns as soon as an intermediate reply finishes while work continues. Fixed the 30–60 second gap before the next tool event.' },
        { tag: 'Tooltips', name: 'App tooltips for speed options', desc: 'Standard, Fast and other speed descriptions now use the app tooltip style. Descriptions stay visible at menu edges and also appear on keyboard focus.' }
      ]
    }
  },
  '3.0.10': {
    ko: {
      eyebrow: 'UPDATE',
      lead: 'Clear 후 멈춤을 수정하고, Codex 도구 연동과 여러 파일의 변경 내용 확인을 개선했습니다.',
      notes: [
        {
          tag: '채팅',
          name: 'Clear 후 첫 메시지 멈춤 수정',
          desc: 'Clear 직후 메시지를 보내면 생각 중에서 멈추던 문제를 수정했습니다. 취소한 뒤 다시 보내지 않아도 대화를 이어갈 수 있습니다.'
        },
        {
          tag: 'Codex',
          name: 'MCP·스킬 연동',
          desc: '선택한 계정과 작업 폴더의 Codex MCP·스킬을 불러옵니다. 로컬·전역 필터와 $ 스킬 자동완성을 지원하며, 지원되는 항목의 켬·끔 설정은 계정별로 저장해 다음 실행에 반영합니다.'
        },
        {
          tag: '파일',
          name: '여러 파일을 펼쳐서 확인',
          desc: 'Edit 행을 누르면 수정한 파일 목록이 펼쳐집니다. 각 파일을 따로 열고 파일별 추가·삭제 줄 수도 확인할 수 있습니다.'
        },
        {
          tag: '앱',
          name: '패치노트 정리',
          desc: '3.0.7부터의 긴 설명을 핵심 변경 사항 위주로 줄였습니다. 한국어와 영어 모두 같은 내용으로 정리했습니다.'
        }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Fixes the first message after Clear and improves Codex tools and multi-file edit review.',
      notes: [
        {
          tag: 'Chat',
          name: 'First message after Clear',
          desc: 'Fixed messages getting stuck on thinking immediately after Clear. Conversations now continue without cancelling and resending.'
        },
        {
          tag: 'Codex',
          name: 'MCP and skills integration',
          desc: 'Loads Codex MCP servers and skills for the selected account and folder, with Local/Global filters and $ skill completion. Supported toggles are saved per account and applied on the next run.'
        },
        {
          tag: 'Files',
          name: 'Expand multi-file edits',
          desc: 'Click an Edit row to expand its file list. Open each file separately and see its added and removed line counts.'
        },
        {
          tag: 'App',
          name: 'Shorter patch notes',
          desc: 'Rewrote the notes from 3.0.7 onward around the changes that matter to users, in both Korean and English.'
        }
      ]
    }
  },
  '3.0.9': {
    ko: {
      eyebrow: 'UPDATE',
      lead: '사용 한도 표시를 개선하고, Codex 모델·속도 선택과 Updates 페이지를 추가했습니다.',
      notes: [
        {
          tag: '계정',
          name: '한도 초기화 후 표시 갱신',
          desc: '한도가 초기화된 뒤에도 0%로 남아 있던 표시를 수정했습니다. 초기화 시각에 다시 조회하고, 새 값을 기다리는 동안 확인 중으로 표시합니다.'
        },
        {
          tag: '계정',
          name: '한도 조회 재시도 개선',
          desc: '한도 조회가 제한되면 서버가 안내한 시간만큼 기다립니다. 반복 요청으로 갱신이 늦어지던 문제를 줄였습니다.'
        },
        {
          tag: 'Codex',
          name: '모델과 속도 선택',
          desc: 'GPT-6-Astra를 추가하고 이전 세대 모델 목록을 정리했습니다. 지원 모델에서 표준·Fast·Ultrafast 속도를 선택할 수 있습니다.'
        },
        {
          tag: '채팅',
          name: '응답 표시 안정성 개선',
          desc: '실행 시작 신호를 놓쳤을 때 답변이 화면에 표시되지 않던 문제를 보완했습니다.'
        },
        {
          tag: '앱',
          name: '설정에 Updates 추가',
          desc: '설정에서 업데이트 확인·설치·재시작을 진행할 수 있습니다. 이미 확인한 패치노트도 다시 열 수 있습니다.'
        }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Improves usage-limit displays and adds Codex model and speed choices plus an Updates page.',
      notes: [
        {
          tag: 'Accounts',
          name: 'Refresh limits after reset',
          desc: 'Fixed limits remaining at 0% after a reset. The app checks again at the reset time and shows a checking state until the new value arrives.'
        },
        {
          tag: 'Accounts',
          name: 'Better usage-query retries',
          desc: 'When usage queries are rate-limited, the app waits for the time requested by the server. This reduces repeated requests that delay fresh values.'
        },
        {
          tag: 'Codex',
          name: 'Model and speed choices',
          desc: 'Added GPT-6-Astra and cleaned up older model entries. Supported models offer Standard, Fast, or Ultrafast speed options.'
        },
        {
          tag: 'Chat',
          name: 'More reliable reply display',
          desc: 'Improved reply handling when the initial run-start signal is missed.'
        },
        {
          tag: 'App',
          name: 'Updates in Settings',
          desc: 'Check for updates, install, and restart from Settings. You can also reopen patch notes you have already read.'
        }
      ]
    }
  },
  // 3.0.8 — 2026-09-04 보고: 간단한 질문이 6분 38초 「작업 중」만 돌다 중단 → 그대로 재전송은 즉시 답(스크린샷 —
  //   세션 파일 없음). 코드 대조: /clear 뒤 첫 전송 경로(StopAll→clear_queue·forget_thread·t1_spawn·reaper 대기)에는
  //   결함 없음. 남은 침묵 후보는 CLI의 **API 재시도 대기** — claude.exe 2.1.260 실측: 과부하(529)·5xx·429·연결 실패에
  //   스스로 재시도(한 번 최대 60초 · 지속 과부하 모드는 최대 5분 · 기본 횟수 상한)하며 `system/api_retry`
  //   {attempt,max_retries,retry_delay_ms,error_status,error}를 낸다 → 3.0.7까지 frames.rs가 F21(미지)로 버려 화면은
  //   랜덤 문구+초만 돌았다 → frames.rs ApiRetry(상태기계 무동작) + wire.rs `api-retry` 번역 + session.ts apiRetry
  //   (메인 경로 진행·종결·카드에서 걷힘 · 스냅샷 null) + WorkingIndicator가 「API 오류 — 다시 시도를 기다리는 중 ·
  //   3/10 · 서버 과부하 · 42초 뒤 다시」로 남은 초 카운트다운(앰버 · shimmer 없음). 테스트 2(frames·wire).
  //   ② 「작업 폴더를 찾을 수 없어요 — C:\Users\<me>\Desktop」가 보낼 때마다 뜨다 몇 번째에 됨(제보 — 패널 칩은
  //   ClaudeOffice): hub.ensure가 **디스크 정체성**(폴더 빈 채 저장)으로 런타임을 먼저 만들고 그다음 요청 picker를
  //   패치했다 → 빈 폴더의 대체 `%USERPROFILE%\Desktop`이 OneDrive 리디렉션 계정엔 없어 CwdMissing으로 죽고 요청의
  //   폴더는 읽히지도 않았다(렌더러 지연 저장이 정체성을 되쓴 뒤에야 성공) → ensure_for(seed): Run·IdentitySet의
  //   패치를 런타임 생성 전에 얹음 + ident.rs desktop()이 SHGetKnownFolderPath(FOLDERID_Desktop) → %USERPROFILE%\Desktop
  //   → %USERPROFILE% 순으로 **실재하는** 폴더를 고름 + reject_spawn 표면을 op별로(run만 스레드 band · 조회/재장전은
  //   침묵 · 나머지는 verdict만 — /clear가 오류 말풍선을 앉히던 것도 이것) ③ 5·6분할 패널 헤더 칩 겹침(제보 화면 —
  //   「MCP & SKILL」 위로 「작업 중 00:36」): .hfold(min-width:0) 안의 .ma-p-folder 버튼이 min-width:auto라 래퍼 밖으로
  //   삐져나옴 → 칩 min-width:0(이름만 말줄임) + 제목 묶음 flex-shrink 10(제목이 먼저 양보).
  //   ④ 보드 다이얼 2·3·4·5 반복 시 순서 드리프트(제보 — 「1번이던 패널이 5번에」): applyCount가 줄일 때 포커스
  //   자리를 보이는 마지막 자리로 끌어올리며 panelOrder를 **영구히** 바꾸고 늘릴 땐 안 건드려, 5→1(포커스 5번)→5마다
  //   원래 1‥4번이 한 칸씩 밀렸다 → lib/panelLayout.ts resizeLayout: 승격을 오버레이(promo{slot,base})로 두고 늘리면
  //   base로 복원(승격 자리가 그래도 안 보이면 base 위에 다시 얹음) · 드래그/↥ 올리기는 오버레이 걷음 · 세션 레코드
  //   (promo) + legacy_bridge 보드 왕복(sanitize_promo · null은 걷음, 키 없음만 지난 값) · poc-panel-layout.mjs 16건.
  // 3.0.7 — 2026-09-04 보고·요청 다섯: ① 채팅 완료 순간 「응답 없음」(사용자 hang-17248 미니덤프): notify.rs
  //   push()가 tokio 워커에서 PUSH_LOCK(std Mutex)을 쥔 채 build() → hwnd() → SetWindowLongPtrW(다른 스레드의 창 =
  //   메인으로 동기 SendMessage), 메인은 Focused(true) → clear_for_window → push → 같은 락 대기 → 교착 → 토스트 창
  //   조작을 run_on_main_thread로 메인 직렬화(락 제거 · BUSY/DIRTY 재진입 가드) + no_activate는 소유 스레드가 아니면
  //   메인으로 넘김 + tray.rs show_menu의 SHOW_LOCK도 같은 처방 ② 마켓플레이스 플러그인 스킬 미탐색(제보 — 2.6.x
  //   app.asar·3.0 공통): skill:list가 ~/.claude/skills·.claude/skills만 훑음 → tooling.rs plugin_skills:
  //   installed_plugins.json(v1/v2) × enabledPlugins(사용자 → 프로젝트 settings/settings.local 겹침) ×
  //   <installPath>/skills(+plugin.json skills) → 이름 「플러그인:스킬」·scope plugin·toggleable:false(CLI 실측:
  //   skillOverrides는 source==="plugin"에 미적용) + wire.rs 라이브 조인이 「(플러그인) 설명」 머리를 init.plugins
  //   이름과 맞을 때 떼고 scope plugin + McpSkillView 디스크 행 스위치 제외. 회귀 테스트 2 ③ 사용자 요청 —
  //   MCP & Skill 팝오버 머리에 「로컬」·「전역」 알약(.pp-filt 문법 · 프리프 tooling.showLocal/showGlobal · 마지막
  //   하나는 못 끔): 로컬 = project/local 스킬 · 디스크 scope local 서버(와이어 행은 디스크 스캔과 이름 조인), 전역 =
  //   나머지(user/plugin/내장 · ~/.claude.json · 와이어 전용). 섹션 머리 수는 켜진 범위만, 칩 툴팁은 전체 · 머리
  //   오른쪽 끝 폴더 이름(.c) 제거(사용자 결정) ④ 사이드바 빈 곳 호버/클릭이 「창」 칩 달린 추가 채팅 줄로 감(사용자
  //   보고 · 자동숨김에서 실측 재현 — realprobe: elementFromPoint(120,680) = .slotchip.win): 칩 클래스 `win`이 앱
  //   루트 `.win{position:fixed; inset:0}`에 걸려 칩이 사이드바 칼럼(transform 컨테이닝 블록) 전체를 덮었다 →
  //   `winchip`으로 개명(styles.css 2곳 · poc-dial.mjs · critic-mux-attack.mjs 셀렉터) ⑤ 한도 대기 「언제 풀리는지
  //   알 수 없어」(사용자 지적 — 카드엔 「resets 3:30pm (Asia/Seoul)」가 적혀 있음): limit.rs classify가 옛 `|epoch`
  //   꼬리(parse_epoch)만 읽었다 → parse_reset_phrase(`3:30pm`·`3pm`·`Sep 8 at 3pm`·`in 1h 5m`, 로컬 벽시계 ·
  //   12h 지났으면 내일 · 30일 지난 날짜는 내년 · 모르는 꼴 None) + chrono 의존 · classify_limit_error_at(text,
  //   now_epoch_ms)로 런타임 시계 기준(가상 시계 재생 결정적) · 시각 미상 픽스처 문구를 시각 없는 것으로 교체
  //   (r14_limit_loop·probe_wfire_crit·probe_wfr2·wcap_limit_streak·replay·parity).
  // 3.0.6 — 2026-09-04 알림 디자인 패스: ① 스레드 안내(kind:notice)가 전부 노란 ⚠ 한 종 → 주제별 분류
  //   (lib/noticeCat.ts · 문장으로 판정 · 표 밖은 남의 문장=무채색 ⓘ): 한도 대기(라임·모래시계, 노랑 대체) · 풀림
  //   (초록·▶) · 계정(청록) · 모델(보라) · 수명(파랑·맥박) · 종료/재시작(무채색) · 중지(주황·■) · 예약(남색) · 거절
  //   (빨강·⊘) · 과금(금색) · CLI(무채색·모노) + 트레이 라벨 태그(.ntf-tag) ② LimitHoldBar 앰버 유리 → 같은
  //   .ntf-band(HoldBand · 한도/풀림 색) · IdentityBand도 분류 색 ③ ErrorBand [복사] 제거 ④ verdict queued
  //   「예약으로 넣었어요」 제거(예약 독과 중복 · deferred는 유지) ⑤ MAX_VERSIONS 5 → 10(한 줄 실측 12/11)
  //   ⑥ 계정 picker — 「계정」 헤더 오른쪽 한도별 숨김 알약 「Fable 소진 숨김」·「주간 소진 숨김」(시안 V2 ·
  //   .pp-filt · 옛 「소진된 계정 N개 표시」 접기 줄 대체 · 둘 다 켜면 어느 한쪽이라도 0%면 숨김) + 섹션 순서
  //   계정 → 한도 소진 시 ⑦ 도구 행 「새 파일 · +N」·「파일 N개 · +a −d」 구분점(Bash 「0.3s · 12줄」 문법)
  //   ⑧ 한도 자동 전환 뒤 자리 칩이 옛 계정 — chat:identity는 배너만 띄우고 picker 바인딩은 안 바꿔 「사용 중 ·
  //   2곳」이 유령처럼 보였고 다음 전송이 옛 계정을 실어 전환을 되돌렸다 → 착지 계정을 4창(App·MultiAgent·
  //   SessionWindow·PanelWindow)의 picker·예약 스냅샷에 미러링(lib/identityLanding.ts · 모델 폴백과 같은 규칙).
  // 3.0.5 — 2026-09-03 보고 넷: ① AI가 「지난 질문에 답을 안 보냈다」며 밀린 답을 되풀이 — 턴이 끝나는
  //   순간 CLI를 kill해 마지막 답(end_turn)이 세션 파일에 안 남았고, 다음 --resume이 "Continue from where
  //   you left off"를 합성 주입 → EOF 뒤 자발 퇴장 대기(kill_graceful, 유예 8s) + 새 스폰은 앞 프로세스 퇴장
  //   대기 ② 「예약으로 넣었어요」 연쇄 — 예약된 전송이 begin_run을 먼저 열어 앞 턴 Done이 그 id로 나가
  //   화면은 유휴·엔진은 스트리밍 → 판정 먼저, Queued는 런을 안 열고 드레인 때 sync_engine_run이 연다
  //   (echoed로 에코 억제) ③ 팝아웃 창의 계정 「현재」·「사용 중」 — chat:status 미구독 → 구독 ④ 「N번 자리」가
  //   슬롯 인덱스 → order 안의 보이는 위치(seat) + 보드 저장 시 재계산 ⑤ 성능: ma:event를 그 패널의 창에만,
  //   틱당 델타 합치기, 자리 조회 펌프당 1회, onNotify 인라인 → 안정 정체성, chat:status 지문 가드
  //   ⑥ 턴마다 「[stderr] Warning: claude.ai MCP servers blocked by enterprise policy」 카드 — 우리
  //   deniedMcpServers 설정에 CLI가 찍는 확인 경고 → on_stderr에서 그 한 종류만 거른다
  //   ⑦ 작업 폴더 이름이 소문자로 보임 — 정체성 정규화(CanonPath)가 경로를 통째로 소문자화해
  //   스폰 cwd·에코된 session.cwd·저장 정체성까지 소문자였다 → 원래 대소문자 보존, 비교·해시만
  //   접는다 ⑧ index.html 미리보기 위에 「AgentCodeGUI 시작하는 중」 스플래시 — 부트 스플래시
  //   initialization_script가 미리보기 iframe에도 돌았다 → 최상위 프레임에서만 ⑨ /clear 뒤 첫 메시지
  //   씹힘 — 유휴의 stop_all이 거절이라 엔진의 한도 대기표·예약이 살아남아 첫 전송이 닫힌 게이트 뒤에
  //   주차(판정은 수락, 화면은 작업 중) → 유휴에서도 큐·대기표 비우기.
  // 3.0.4 — 2026-09-03 보고 다섯: ① 링크가 안 열림 — 3.0에 2.6.2 setWindowOpenHandler→shell.openExternal의
  //   짝이 없었다 → shell:open-external + main.tsx 앵커 가로채기 + win.rs on_navigation 안전망 ② 재시작
  //   뒤 내 메시지만 사라짐 — 렌더러가 연 턴의 user-echo를 expect_runs가 통째로 삼켜 같은 대화를 그리는
  //   다른 창(팝아웃 그리드 유령 셀·자리 밖 수집기)이 말풍선을 못 받았고, 그 사본이 저장을 이겼다(실측
  //   ma-…-2.json worked 33·assistant 36·user 6) → Op::Run이 echoText/echoFrom으로 보낸 창만 빼고 에코
  //   ③ 워크플로 중지·한도 뒤 한참 멈춤 — T13 interrupt·한도 착지가 원장의 워크플로를 그대로 둬 90초
  //   리스가 다 흐를 때까지 Resident(LiveItems) → land_turn이 중단·한도 턴의 워크플로/에이전트를 즉시
  //   정착(settle_stranded_work) ④ 한도 뒤 「<synthetic>으로 전환」 → 계정 전환 → 재개 턴이 unrecognized
  //   model로 사망 — CLI의 합성 프레임 model:"<synthetic>"을 모델 전환으로 읽었다 → is_placeholder_model로
  //   차단 + 디스크의 오염 정체성 복구(ident.rs) + 종료 경로도 fallback_arms 정리 ⑤ 계정을 바꿔 보냈는데
  //   답이 없다가 /clear 뒤 됨 — 렌더러 대기표가 옛 계정 채로 큐 드레인을 붙들었다 → 계정 변경 시 표 무효.
  '3.0.8': {
    ko: {
      eyebrow: 'UPDATE',
      lead: '재시도 대기를 더 명확하게 표시하고, 작업 폴더와 멀티 패널 문제를 수정했습니다.',
      notes: [
        {
          tag: '채팅',
          name: 'API 재시도 대기 표시',
          desc: 'Claude가 서버 오류로 재시도를 기다릴 때 사유·시도 횟수·남은 시간을 표시합니다.'
        },
        {
          tag: '채팅',
          name: '작업 폴더 오류 수정',
          desc: '선택한 폴더 대신 바탕화면을 찾다가 전송에 실패하던 문제를 수정했습니다. OneDrive로 이동한 바탕화면도 올바르게 인식합니다.'
        },
        {
          tag: '멀티',
          name: '패널 순서 유지',
          desc: '패널 수를 줄였다 늘려도 원래 순서로 돌아옵니다. 직접 드래그해서 정한 순서는 유지합니다.'
        },
        {
          tag: '화면',
          name: '좁은 패널의 헤더 정리',
          desc: '5·6분할 화면에서 폴더·MCP & Skill·작업 상태 표시가 겹치던 문제를 수정했습니다.'
        }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Makes retry waits clearer and fixes working-folder and multi-panel issues.',
      notes: [
        {
          tag: 'Chat',
          name: 'Visible API retry waits',
          desc: 'When Claude waits to retry a server error, the app shows the reason, attempt count, and time remaining.'
        },
        {
          tag: 'Chat',
          name: 'Working-folder fix',
          desc: 'Fixed sends failing because the app looked for the Desktop instead of the selected folder. Desktops redirected to OneDrive are also recognized.'
        },
        {
          tag: 'Multi',
          name: 'Keep panel order',
          desc: 'Reducing and restoring the panel count now restores the original order. Orders set by dragging are preserved.'
        },
        {
          tag: 'Display',
          name: 'Cleaner narrow headers',
          desc: 'Fixed folder, MCP & Skill, and activity indicators overlapping in five- and six-panel layouts.'
        }
      ]
    }
  },
  '3.0.7': {
    ko: {
      eyebrow: 'UPDATE',
      lead: '알림과 사이드바의 안정성을 높이고, 플러그인 스킬과 도구 필터를 개선했습니다.',
      notes: [
        {
          tag: '안정성',
          name: '채팅 완료 시 멈춤 수정',
          desc: '완료 알림이 뜨는 순간 앱이 응답 없음으로 멈추던 문제를 수정했습니다. 트레이 메뉴도 함께 안정화했습니다.'
        },
        {
          tag: '스킬',
          name: '플러그인 스킬 표시',
          desc: 'Claude 플러그인으로 설치한 스킬이 MCP & Skill 목록과 / 자동완성에 표시됩니다. 플러그인 스킬은 목록에서 확인할 수 있으며 개별 스위치는 제공하지 않습니다.'
        },
        {
          tag: '도구',
          name: '로컬·전역 필터',
          desc: 'MCP & Skill 목록에서 프로젝트 항목과 전역 항목을 나눠 볼 수 있습니다. 선택한 필터는 다음에도 유지됩니다.'
        },
        {
          tag: '화면',
          name: '사이드바 클릭 오류 수정',
          desc: '사이드바의 빈 곳이나 다른 항목을 눌렀는데 별도 채팅 창이 열리던 문제를 수정했습니다.'
        },
        {
          tag: '한도',
          name: '한도 초기화 시각 인식',
          desc: 'Claude가 안내한 초기화 시각을 인식해 대기 시간을 표시합니다. 자동 재개를 사용하면 해당 시각에 맞춰 이어갑니다.'
        }
      ]
    },
    en: {
      eyebrow: 'UPDATE',
      lead: 'Improves notification and sidebar stability, plugin skills, and tool filters.',
      notes: [
        {
          tag: 'Stability',
          name: 'Fix for freezes on completion',
          desc: 'Fixed the app becoming unresponsive when a completion notification appeared. Tray menu handling was also improved.'
        },
        {
          tag: 'Skills',
          name: 'Show plugin skills',
          desc: 'Skills installed through Claude plugins now appear in MCP & Skill and / completion. Plugin skills are listed without individual toggles.'
        },
        {
          tag: 'Tools',
          name: 'Local and Global filters',
          desc: 'View project and global items separately in MCP & Skill. Your filter selection is remembered.'
        },
        {
          tag: 'Display',
          name: 'Sidebar click fix',
          desc: 'Fixed clicks on empty sidebar space or other items bringing an extra chat window to the front.'
        },
        {
          tag: 'Limits',
          name: 'Recognize limit reset times',
          desc: 'The app reads the reset time reported by Claude and displays the wait. Automatic resume continues at that time when enabled.'
        }
      ]
    }
  },
  '3.0.6': {
    ko: {
      eyebrow: 'DESIGN',
      lead: '채팅 안의 시스템 안내가 전부 노란 경고 하나였던 것을 주제별 색·아이콘·라벨로 나눴고, 한도 대기 상태줄도 같은 모양으로 맞췄습니다. 계정 목록에는 한도가 다 된 계정을 숨기는 알약 두 개가 생겼고, 한도 자동 전환 뒤 자리 칩이 옛 계정을 말하던 것을 고쳤습니다.',
      notes: [
        {
          tag: '대화',
          name: '시스템 안내가 전부 같은 노란 경고로 뜨던 것 — 주제별로 나눴습니다',
          desc: (
            <>
              한도 대기, 계정 자동 전환, 엔진 무응답, 프로세스 종료, 중지, 예약, 거절, CLI 경고까지 <b>전부 노란
              ⚠ 한 가지</b>로 나와 노랑이 아무 뜻도 없었습니다. 이제 주제마다 색·아이콘·작은 라벨을 하나씩 줍니다 —
              <b>한도 대기</b>(라임 · 모래시계), <b>한도 풀림</b>(초록 · ▶), <b>계정</b>(청록 · 사람), <b>모델</b>(보라 ·
              반짝임), <b>수명</b>(파랑 · 맥박: 무응답·빈 응답·유휴 정리), <b>종료·재시작</b>(무채색), <b>중지</b>(주황 ·
              ■), <b>예약</b>(남색 · 시계), <b>거절</b>(빨강 · ⊘), <b>CLI 원문</b>(무채색 · 고정폭). 색이 낯선 동안은
              라벨이 알려 줍니다. 노란 계열 자체도 어두운 바탕에서 머스터드로 읽혀 라임으로 바꿨습니다.
            </>
          )
        },
        {
          tag: '대화',
          name: '한도 대기 상태줄(입력창 위)도 같은 모양으로',
          desc: (
            <>
              입력창 위의 「사용 한도에 도달했어요 — 약 N분 뒤 자동으로 이어서 계속해요」 줄은 스레드 안내와 <b>다른
              앰버색 유리</b>였습니다. 이제 같은 판 문법입니다 — 기다리는 중은 한도 색(라임 · 모래시계), 정말 풀렸을
              때는 풀림 색(초록 · ▶), 자동 재개가 접힌 표는 한도 색 그대로에 [이어가기]만 붙습니다. 모델·계정
              자동 전환 알림 줄도 스레드와 같은 색을 따릅니다.
            </>
          )
        },
        {
          tag: '대화',
          name: '오류 카드의 [복사] 버튼을 뺐습니다',
          desc: (
            <>
              원문 칸을 드래그해 복사하면 되는 자리라 버튼이 하나 더 있을 이유가 없었습니다. 8줄 넘는 원문을 펼치는
              [전체 보기]는 그대로입니다.
            </>
          )
        },
        {
          tag: '대화',
          name: '「예약으로 넣었어요」 줄을 뺐습니다',
          desc: (
            <>
              답이 오는 중에 보낸 메시지는 입력창 아래 <b>예약 목록</b>에 바로 보이는데, 스레드에도 「예약으로
              넣었어요 — 턴이 끝나면 바로 나가요」를 한 줄 더 썼습니다. 같은 사실을 두 곳에서 말하던 것이라 스레드
              줄만 뺐습니다. 턴 중에 모델·계정 등을 바꿨을 때의 「설정을 예약했어요」는 목록에 안 보이므로 남깁니다.
            </>
          )
        },
        {
          tag: '앱',
          name: '이 업데이트 소식 카드의 버전 버튼을 10개까지',
          desc: (
            <>
              카드가 커진 뒤로 한 줄에 버전 알약이 12개까지 서는데 5개에서 잘랐습니다. 이제 최신 10개를 오갈 수
              있습니다(두 자리 패치 번호가 섞여도 한 줄).
            </>
          )
        },
        {
          tag: '계정',
          name: '계정 목록에서 한도가 다 된 계정을 골라 숨깁니다 — 「Fable 소진 숨김」·「주간 소진 숨김」',
          desc: (
            <>
              모델 칩을 열면 나오는 계정 목록의 「계정」 제목 오른쪽에 알약 두 개가 붙었습니다. <b>Fable 소진 숨김</b>을
              켜면 Fable 주간 한도가 0%인 계정이, <b>주간 소진 숨김</b>을 켜면 주간 한도가 0%인 계정이 목록에서
              빠집니다. 둘 다 켜면 둘 다 남은 계정만 남고, 하나만 켜면 다른 한도는 보지 않습니다. 지금 이 대화가 쓰는
              계정은 언제나 보입니다. 옛 「소진된 계정 N개 표시」 접기 줄을 대신하며, 그때 펼쳐 두었다면 그대로
              펼쳐진 채 이어집니다. 목록 순서도 바꿨습니다 — <b>계정</b>이 먼저, <b>한도 소진 시</b>가 그 아래입니다.
            </>
          )
        },
        {
          tag: '계정',
          name: '한도 자동 전환 뒤 자리 칩이 옛 계정을 말하던 것 — 「사용 중 · 2곳」이 유령처럼 보였습니다',
          desc: (
            <>
              한도에 걸려 엔진이 다른 계정으로 바꿔 이어간 뒤에도, 그 자리의 칩과 계정 목록의 「현재」는 <b>바꾸기 전
              계정</b>을 그대로 보여 줬습니다. 그래서 다른 자리에서 보면 「사용 중 · 2곳」인데 화면엔 그 계정을 쓰는
              자리가 안 보였고, 더 나쁘게는 다음 메시지가 옛 계정을 다시 실어 보내 <b>전환을 되돌려</b> 같은 한도에
              다시 걸릴 수 있었습니다. 이제 엔진이 계정을 바꾸면(되돌리기 포함) 본채팅·멀티 자리·추가 창·팝아웃 창의
              칩과 예약된 메시지가 모두 그 계정으로 따라갑니다. 모델 자동 전환이 이미 하던 것과 같은 규칙입니다.
            </>
          )
        },
        {
          tag: '대화',
          name: '도구 줄의 「새 파일 +33」 — 가운데 점을 넣었습니다',
          desc: (
            <>
              파일을 새로 쓴 줄의 오른쪽 요약이 「새 파일 +33」으로 한 덩이처럼 붙어 보였습니다. Bash 줄의 「0.3s ·
              12줄」처럼 <b>「새 파일 · +33」</b>, 「파일 3개 · +4 −2」로 가릅니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'DESIGN',
      lead: 'System notices in the thread were all the same yellow warning; they are now split by topic with their own color, icon and label, and the limit-hold bar matches. The account list gains two pills that hide used-up accounts, and the seat chip now follows automatic account switches.',
      notes: [
        {
          tag: 'Chat',
          name: 'Every system notice looked like the same yellow warning — now split by topic',
          desc: (
            <>
              Limit holds, automatic account switches, engine timeouts, process exits, stops, scheduling, refusals and
              CLI warnings all came out as <b>one yellow ⚠</b>, so yellow meant nothing. Each topic now has its own
              color, icon and small label — <b>limit hold</b> (lime · hourglass), <b>limit lifted</b> (green · ▶),
              <b>account</b> (teal · person), <b>model</b> (violet · sparkle), <b>watchdog</b> (blue · pulse: no
              reply, empty reply, idle cleanup), <b>exit / restart</b> (neutral), <b>stopped</b> (orange · ■),
              <b>scheduled</b> (indigo · clock), <b>refused</b> (red · ⊘), <b>CLI output</b> (neutral · monospace).
              The label carries you until the colors are familiar. The old yellow itself read as mustard on the dark
              background, so it became lime.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'The limit-hold bar above the composer now uses the same shape',
          desc: (
            <>
              The "Usage limit reached — auto-continues in ~N min" bar above the composer was a <b>separate amber
              glass strip</b>. It now uses the same band grammar as thread notices — the limit color (lime · hourglass)
              while waiting, the lifted color (green · ▶) once the limit is really gone, and the limit color with just a
              [Continue] pill when auto-resume has paused. The model / account auto-switch bars follow the same colors
              as the thread.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'Removed the [Copy] pill from error cards',
          desc: (
            <>
              You can select the raw pane and copy it, so the extra button had no job. [Show all] for raw output longer
              than 8 lines stays.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'Removed the "Queued instead" line',
          desc: (
            <>
              A message sent while a reply is streaming already shows up in the <b>queue list</b> under the composer,
              and the thread repeated it as "Queued instead — goes out when the turn ends". Same fact in two places, so
              the thread line is gone. "Setting scheduled" (changing model or account mid-turn) stays, because the
              queue list does not show it.
            </>
          )
        },
        {
          tag: 'App',
          name: 'This what&apos;s-new card keeps up to 10 versions',
          desc: (
            <>
              The card fits 12 version pills per row since it grew, but the list was capped at 5. It now keeps the
              latest 10 (still one row even with two-digit patch numbers).
            </>
          )
        },
        {
          tag: 'Accounts',
          name: 'Hide used-up accounts from the account list — "Hide Fable 0%" and "Hide weekly 0%"',
          desc: (
            <>
              Two pills now sit to the right of the <b>Account</b> heading in the model chip&apos;s list. <b>Hide Fable
              0%</b> drops accounts whose Fable weekly limit is at 0%; <b>Hide weekly 0%</b> drops those whose weekly
              limit is at 0%. With both on, only accounts with both limits left remain; with one on, the other limit is
              ignored. The account this chat is using always stays visible. This replaces the old &quot;Show N exhausted
              accounts&quot; fold — if you had it expanded, it stays expanded. The list order changed too:
              <b>Account</b> comes first, <b>When the limit runs out</b> below it.
            </>
          )
        },
        {
          tag: 'Accounts',
          name: 'After an automatic account switch the seat chip kept naming the old account — "In use · 2 places" looked like a ghost',
          desc: (
            <>
              When the engine moved a chat to another account on a usage limit, that seat&apos;s chip and the
              &quot;Current&quot; mark in its account list kept showing <b>the account it switched away from</b>. Seen
              from another seat, the account said &quot;In use · 2 places&quot; while no visible seat appeared to use
              it — and worse, the next message carried the old account again, <b>undoing the switch</b> and walking
              back into the same limit. Now when the engine changes the account (revert included), the chip and any
              queued messages in the main chat, multi-agent seats, extra windows and popped-out panels follow it. Same
              rule the automatic model switch already used.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'Tool rows: "New file +33" now has its separator',
          desc: (
            <>
              The right-hand summary of a file-write row read as &quot;New file +33&quot; in one lump. It now splits
              like the Bash row&apos;s &quot;0.3s · 12 lines&quot; — <b>&quot;New file · +33&quot;</b>, &quot;3 files ·
              +4 −2&quot;.
            </>
          )
        }
      ]
    }
  },
  '3.0.5': {
    ko: {
      eyebrow: 'FIXES',
      lead: 'AI가 「지난 질문에 답을 안 보냈다」며 같은 답을 되풀이하던 것, 「예약으로 넣었어요」가 계속 뜨던 것, 별도 창의 계정 표시와 「N번 자리」 번호를 고쳤습니다.',
      notes: [
        {
          tag: '대화',
          name: 'AI가 「지난 질문에 답을 안 보냈다」며 밀린 답을 되풀이하던 문제',
          desc: (
            <>
              턴이 끝나는 순간 앱이 CLI를 바로 종료했는데, CLI는 <b>마지막 답을 그 뒤에야</b> 세션 파일에 적습니다.
              그래서 파일에는 질문과 도구 호출만 남고 답은 빠졌고, 다음 턴이 그 파일로 이어지면 CLI가 「끊긴
              턴」으로 보고 이어가기 문구를 끼워 넣었습니다. 모델의 눈에는 답 없이 끝난 질문이 쌓인 대화라 매 턴
              「밀린 답」을 다시 썼습니다. 이제 턴이 끝나면 <b>CLI가 스스로 정리하고 나갈 때까지 기다립니다</b>
              (중지·무응답은 예전처럼 즉시 종료).
            </>
          )
        },
        {
          tag: '대화',
          name: '「예약으로 넣었어요」가 계속 뜨던 문제',
          desc: (
            <>
              답이 오는 중에 보낸 메시지는 예약이 되는데, 그 예약이 나갈 때 화면에 「턴 시작」이 전달되지 않아
              <b>엔진은 답을 쓰는데 화면은 유휴</b>였습니다. 그 상태에서 또 보내면 또 예약 — 연쇄였습니다. 이제
              예약된 메시지가 나가는 순간 화면도 작업 중으로 바뀌고, 거절된 전송이 다음 턴 표시를 삼키던 누수도
              막았습니다. 그리고 <b>중지</b>가 예약된 메시지를 버릴 때(중지 = 뒤에 줄 선 것까지 취소) 지금까지는
              말풍선만 남고 아무 말이 없었는데 — 「채팅이 씹힌」 것처럼 보이던 그 자리 — 이제 「예약된 메시지
              N건은 보내지 않았어요」로 알립니다.
            </>
          )
        },
        {
          tag: '계정',
          name: '별도 창(팝아웃)에서 계정의 「현재」·「사용 중」이 안 보이던 문제',
          desc: (
            <>
              팝아웃 창은 다른 창들이 받는 계정 상태 표를 구독하지 않아, 「현재」가 <b>목록 맨 위 계정</b>으로
              잘못 찍히고 다른 자리가 쓰는 계정의 「사용 중」 칩이 안 떴습니다. 이제 팝아웃 창도 같은 표를 받습니다.
            </>
          )
        },
        {
          tag: '계정',
          name: '「사용 중 · N번 자리」의 번호가 패널을 옮겨도 안 바뀌던 문제',
          desc: (
            <>
              번호를 슬롯의 <b>고정 번호</b>로 그려서, 패널을 드래그로 옮기면 화면의 1번이 칩에는 「3번 자리」였습니다.
              이제 화면에 보이는 자리 순서로 세고, 옮기면 바로 갱신됩니다. 접힌 자리는 「접힌 자리」로 표시합니다.
            </>
          )
        },
        {
          tag: '대화',
          name: '/clear 뒤 첫 메시지가 씹히던 문제(Esc로 끊고 다시 보내면 되던 것)',
          desc: (
            <>
              /clear는 엔진에 「전부 중지」를 보내는데, 대화가 유휴면 <b>「도는 실행이 없어요」로 거절만</b> 되고
              엔진 쪽 한도 대기표·예약은 그대로 남았습니다. 그 뒤 첫 전송은 「수락」으로 큐에 들어가되 닫힌
              대기표 뒤에 <b>조용히 주차</b>돼 화면만 「작업 중」으로 굳었습니다. 이제 유휴에서도 /clear가 큐와
              대기표를 비우고, 첫 전송이 바로 나갑니다.
            </>
          )
        },
        {
          tag: '탐색기',
          name: '작업 폴더 이름이 소문자로 바뀌어 보이던 문제',
          desc: (
            <>
              <code>C:\Code\VoxArtDev</code> 같은 폴더가 대화를 한 번 돌린 뒤 <code>c:\code\voxartdev</code>로
              소문자가 되어 보였습니다. 엔진이 폴더 경로를 <b>정체성 비교용으로 소문자로 접으면서</b> 그 접힌
              값을 스폰 폴더·저장까지 그대로 썼기 때문입니다. 이제 <b>원래 대소문자를 그대로</b> 두고, 같은
              폴더인지 판정할 때만 속으로 접습니다.
            </>
          )
        },
        {
          tag: '뷰어',
          name: 'HTML 파일(index.html) 미리보기 위에 「AgentCodeGUI 시작하는 중」이 뜨던 문제',
          desc: (
            <>
              파일 뷰어로 <code>index.html</code>을 미리보면 그 페이지 위에 앱 시작 스플래시가 떠서 한동안
              안 걷혔습니다. 앱이 창에 까는 부팅 스플래시 스크립트가 <b>미리보기 iframe 안에서도</b> 돌았고,
              파일 이름이 <code>index.html</code>이라 화면 판정을 통과했습니다. 이제 스플래시는 <b>앱의 최상위
              창에서만</b> 그려집니다.
            </>
          )
        },
        {
          tag: '대화',
          name: '턴마다 「[stderr] Warning: claude.ai MCP servers blocked by enterprise policy」 카드가 뜨던 것',
          desc: (
            <>
              설정에서 끈 claude.ai 커넥터(Gmail·Calendar·Drive)는 CLI에 「거부 목록」으로 전달되는데, CLI가 그걸
              기업 정책으로 보고 매번 경고를 찍었고 앱은 그 줄을 스레드 카드로 그렸습니다. <b>직접 끈 것의 확인
              문장</b>이라 이제 그 경고 한 종류만 거릅니다. 다른 stderr 경고는 그대로 보입니다.
            </>
          )
        },
        {
          tag: '성능',
          name: '패널 여럿이 답을 쓸 때의 버벅임 일부',
          desc: (
            <>
              팝아웃 창마다 <b>다른 패널의 토큰까지 전부 받아 버리던</b> 것을 그 패널의 창에만 보내고, 한 틱에 온
              토큰 조각은 합쳐 보내며, 자리 조회를 틱마다 하던 것을 줄였습니다. 스레드의 메시지가 토큰마다 다시
              그려지던 자리 하나(알림 콜백)도 고쳤습니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'FIXES',
      lead: 'The AI no longer keeps "re-sending answers it never sent", the "Queued instead" card no longer loops, and popped-out windows show the right account and seat number.',
      notes: [
        {
          tag: 'Chat',
          name: 'The AI kept saying it had not answered earlier questions and re-sent them',
          desc: (
            <>
              The app terminated the CLI the moment a turn ended, but the CLI writes the <b>final reply to the session
              file only after that</b>. The file kept the question and tool calls and lost the answer; the next turn
              resumed from that file, the CLI treated it as a cut-off turn and injected a continuation prompt. To the
              model the history looked like a pile of unanswered questions, so every turn it "re-sent the backlog". The
              app now <b>waits for the CLI to finish and exit on its own</b> after a turn (stop and hung processes are
              still killed immediately).
            </>
          )
        },
        {
          tag: 'Chat',
          name: '"Queued instead" kept appearing',
          desc: (
            <>
              A message sent while a reply is streaming is queued — but when that queued message went out, the screen
              was never told a turn had started, so <b>the engine was streaming while the UI showed idle</b>. Sending
              again in that state queued again, and so on. The UI now switches to working the moment a queued message
              goes out, and a rejected send no longer swallows the next turn&apos;s start. And when <b>Stop</b> discards
              queued messages (Stop cancels everything lined up behind the turn), the thread used to keep the bubble
              and say nothing — the "my message got eaten" moment — it now says "N queued messages were not sent".
            </>
          )
        },
        {
          tag: 'Accounts',
          name: 'Popped-out windows did not show "Current" / "In use" for accounts',
          desc: (
            <>
              A popped-out panel window never subscribed to the account-status table the other windows get, so
              "Current" pointed at the <b>top account in the list</b> and "In use" chips for other seats never appeared.
              Popped-out windows now receive the same table.
            </>
          )
        },
        {
          tag: 'Accounts',
          name: '"In use · Slot N" did not follow panel reordering',
          desc: (
            <>
              The number was the slot&apos;s <b>fixed index</b>, so after dragging panels around the first panel on
              screen could read "Slot 3". It now counts by the visible order and updates as soon as you move a panel;
              folded seats read "folded slot".
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'The first message after /clear got swallowed (Esc, then resend, worked)',
          desc: (
            <>
              /clear sends "stop everything" to the engine, but on an idle chat that was <b>merely rejected as
              "nothing running"</b>, leaving the engine’s limit hold and queue in place. The next send was then
              "accepted" into the queue and <b>parked silently</b> behind the closed hold while the screen showed
              "working". /clear now clears the queue and hold even when idle, so the first message goes straight out.
            </>
          )
        },
        {
          tag: 'Explorer',
          name: 'The working-folder name showed up lowercased',
          desc: (
            <>
              A folder like <code>C:\Code\VoxArtDev</code> turned into <code>c:\code\voxartdev</code> once the
              conversation had run once. The engine <b>folds the path to lowercase for identity comparison</b> and was
              then using that folded value for the spawn folder and for storage. It now <b>keeps the original case</b>
              and only folds internally when deciding whether two folders are the same.
            </>
          )
        },
        {
          tag: 'Viewer',
          name: '"AgentCodeGUI starting" appeared over an HTML (index.html) preview',
          desc: (
            <>
              Previewing an <code>index.html</code> in the file viewer drew the app’s startup splash on top of that
              page and left it there for a while. The boot-splash script the app injects into its window <b>also ran
              inside the preview iframe</b>, and the file being named <code>index.html</code> passed its screen check.
              The splash now draws <b>only in the app’s top-level window</b>.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'A "[stderr] Warning: claude.ai MCP servers blocked by enterprise policy" card on every turn',
          desc: (
            <>
              The claude.ai connectors you turn off in Settings (Gmail, Calendar, Drive) reach the CLI as a deny list,
              which the CLI reports as an enterprise-policy warning on every spawn — and the app drew that line as a
              thread card. It only confirms <b>what you switched off yourself</b>, so that one warning is now filtered;
              other stderr warnings still show.
            </>
          )
        },
        {
          tag: 'Performance',
          name: 'Some of the stutter while several panels stream',
          desc: (
            <>
              Each popped-out window used to receive and discard <b>every other panel&apos;s tokens</b>; panel events now
              go only to the windows that draw that panel, token fragments arriving in the same tick are merged, the
              seat lookup runs once per tick instead of once per slot, and one per-token re-render of the whole thread
              (the notify callback) was fixed.
            </>
          )
        }
      ]
    }
  },
  '3.0.4': {
    ko: {
      eyebrow: 'FIXES',
      lead: '링크가 안 열리던 것, 재시작 뒤 내 메시지만 사라지던 것, 워크플로를 멈추거나 한도에 걸린 뒤 한참 굳던 것을 고쳤습니다.',
      notes: [
        {
          tag: '채팅',
          name: '링크를 눌러도 브라우저가 안 열리던 문제',
          desc: (
            <>
              답변 속 마크다운 링크, 웹 검색 행을 펼쳤을 때의 페이지 목록, 설정의 로그인 링크가 눌러도 아무 일도
              없었습니다. 2.6.2에서 링크를 OS 브라우저로 넘기던 자리가 3.0 재구축 때 빠져 있었습니다. 이제 외부
              <b>http(s) 링크는 기본 브라우저</b>로 열리고, 앱 화면이 그 페이지로 바뀌는 일도 없습니다.
            </>
          )
        },
        {
          tag: '대화',
          name: '껐다 켜면 AI 답은 남고 내 메시지만 사라지던 문제',
          desc: (
            <>
              패널을 별도 창으로 띄워 대화하면, 메인 창의 그리드도 같은 대화를 몰래 따라 그리는데 그 사본에는
              <b>사용자 말풍선이 한 번도 오지 않았습니다</b>(보낸 창이 직접 그리니 엔진이 에코를 생략했습니다). 저장은
              그 사본이 이기므로 디스크에는 답만 남았습니다. 이제 엔진이 사용자 말풍선을 <b>보낸 창만 빼고</b> 같은
              대화를 그리는 모든 창에 전달합니다.
            </>
          )
        },
        {
          tag: '워크플로',
          name: '워크플로를 중지하거나 한도에 걸리면 한참 「작업 중」으로 굳던 문제',
          desc: (
            <>
              턴을 중지하거나 한도로 턴이 죽어도 그 턴이 띄운 워크플로는 목록에 그대로 남아, 더는 진행 신호가 오지
              않는데도 <b>90초 리스가 다 흐를 때까지</b> 화면이 「작업 중」이었습니다 — 그 뒤에야 「진행 상태를 알 수
              없어 표시를 정리했어요」가 떴습니다. 이제 중지·한도로 끝난 턴의 워크플로·백그라운드 에이전트는 그
              자리에서 정리되고, 한도 안내도 바로 섭니다.
            </>
          )
        },
        {
          tag: '한도',
          name: '한도 뒤 「<synthetic>으로 전환」 → 계정 전환 → 재개 턴이 죽던 꼬임',
          desc: (
            <>
              CLI는 한도 에러 문장을 모델 이름이 <code>&lt;synthetic&gt;</code>인 합성 메시지로 보내는데, 앱이 이걸
              <b>모델 전환</b>으로 읽어 대화의 모델을 그 이름으로 바꿔 버렸습니다. 그 뒤 계정을 갈아타고 이어서 보낸 턴은
              「There&apos;s an issue with the selected model」로 죽었고, 이 값이 파일에도 저장돼 재시작해도 반복됐습니다.
              이제 자리표시자 모델은 전환으로 치지 않고, 이미 오염된 대화는 열 때 기본 모델로 되돌립니다.
            </>
          )
        },
        {
          tag: '한도',
          name: '계정을 바꿔 보냈는데 답이 없다가 /clear 뒤에야 되던 문제',
          desc: (
            <>
              한도에 걸린 뒤 다른 계정을 골라 보내도, 화면의 한도 대기표가 <b>옛 계정 채로</b> 남아 새 전송을 붙들고
              있었습니다. 이제 계정을 바꾸는 순간 그 대기표는 무효가 됩니다(엔진 쪽 규칙과 같습니다).
            </>
          )
        },
        {
          tag: '계정',
          name: '아직 아무 말도 안 한 채팅에서 계정을 골라도 경고 카드가 뜨던 문제',
          desc: (
            <>
              계정 전환 확인 카드는 「이 대화의 프롬프트 캐시가 새 계정에 없다」는 비용을 경고하는 것인데, 주고받은
              것이 없는 채팅에도 떴습니다. 이제 <b>대화가 시작된 채팅에서만</b> 묻고, 빈 채팅에서는 바로 바뀝니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'FIXES',
      lead: 'Links now open, your own messages no longer vanish after a restart, and stopping a workflow or hitting the limit no longer freezes the chat.',
      notes: [
        {
          tag: 'Chat',
          name: 'Clicking a link did nothing',
          desc: (
            <>
              Markdown links in replies, the page list under a web-search row, and the login link in Settings did not
              open. The piece that handed links to the OS browser in 2.6.2 was missing from the 3.0 rebuild. External{' '}
              <b>http(s) links now open in your default browser</b>, and the app never navigates away to the page.
            </>
          )
        },
        {
          tag: 'Chats',
          name: 'After a restart the AI replies were there but your own messages were gone',
          desc: (
            <>
              While a panel was popped out into its own window, the main-window grid kept a shadow copy of the same
              conversation — and that copy <b>never received your bubbles</b> (the sending window drew them itself, so
              the engine skipped the echo). The shadow copy wins on save, so only the replies reached disk. The engine
              now delivers your message to every window showing that chat <b>except the one that sent it</b>.
            </>
          )
        },
        {
          tag: 'Workflow',
          name: 'Stopping a workflow or hitting the limit left the chat stuck on "Working"',
          desc: (
            <>
              When a turn was interrupted or killed by the usage limit, the workflows it had started stayed in the list
              even though no progress could arrive, so the chat showed "Working" <b>until their 90-second lease ran
              out</b> — only then did "cleaned up the display" appear. Workflows and background agents of a turn that
              ended by interrupt or limit are now settled on the spot, and the limit notice shows immediately.
            </>
          )
        },
        {
          tag: 'Limits',
          name: 'Limit → "switched to <synthetic>" → account switch → resumed turn died',
          desc: (
            <>
              The CLI reports a limit error as a synthetic message whose model is <code>&lt;synthetic&gt;</code>; the app
              read that as a <b>model fallback</b> and rewrote the chat&apos;s model to that name. The account switch and
              resume that followed then failed with "There&apos;s an issue with the selected model", and because the value
              was persisted it repeated after restarts. Placeholder models are no longer treated as a switch, and an
              already-poisoned chat is repaired to the default model when loaded.
            </>
          )
        },
        {
          tag: 'Limits',
          name: 'Sending on another account got no reply until /clear',
          desc: (
            <>
              After a limit, picking a different account and sending still went nowhere: the on-screen limit hold was
              still keyed to the <b>old account</b> and kept the new send queued. Changing the account now voids that
              hold, matching the engine&apos;s rule.
            </>
          )
        },
        {
          tag: 'Accounts',
          name: 'Picking an account in an empty chat showed the warning card',
          desc: (
            <>
              The switch-account confirmation warns that the new account has no prompt cache for this conversation —
              yet it appeared in chats with no messages at all. It now asks <b>only once a chat has started</b>; in an
              empty chat the account changes immediately.
            </>
          )
        }
      ]
    }
  },
  '3.0.3': {
    ko: {
      eyebrow: 'FIXES',
      lead: '쓰다 보면 느려지다 「응답 없음」으로 멈추던 문제를 고쳤습니다 — 그리고 뷰어 등장 버벅임, 도구 행 툴팁.',
      notes: [
        {
          tag: '성능',
          name: '쓰다 보면 점점 느려지던 문제',
          desc: (
            <>
              답변이 흐르는 동안 엔진이 <b>20ms마다, 열린 채팅마다</b> 보드 파일을 디스크에서 다시 읽고 있었습니다(초당
              수백 번). 화면 쪽도 글자가 올 때마다 대화 전체를 다시 훑고, 도구 하나가 끝날 때마다 그 묶음의 도구 행을
              전부 다시 그렸습니다. 이제 보드는 바뀔 때만 읽고, 검사는 이번 턴만 보며, 도구 행은 바뀐 것만 다시
              그립니다. 끝없이 자라던 기록(백그라운드 작업·stderr 알림·보낸 문장·모델 전환 이력)에도 상한을 두었습니다.
            </>
          )
        },
        {
          tag: '안정성',
          name: '「응답 없음」으로 멈추던 문제',
          desc: (
            <>
              채팅·저장 요청이 엔진의 답을 <b>최대 3초</b> 기다리는데, 그 대기가 모든 창이 함께 쓰는 작은 작업자 풀에서
              일어나 엔진이 잠깐 느려지면 <b>모든 창의 요청이 같이 멈췄습니다</b>. 전용 풀로 옮겼습니다. 답변 중
              0.6초마다 돌던 대화 저장(대화 전체를 다시 직렬화)도 답변 중에는 2초 간격으로 늦췄습니다. 그래도 멈추면
              원인을 남기도록, 화면이 6초 넘게 답이 없으면 앱 폴더에 <code>hang-*.dmp</code> 진단 파일을 자동으로
              씁니다.
            </>
          )
        },
        {
          tag: '뷰어',
          name: '파일 뷰어·사이드바가 스르륵 뜰 때 버벅이던 문제',
          desc: (
            <>
              파일을 열면 내용이 <b>등장 애니메이션 도중</b>에 도착해, 구문 강조와 수천 줄 그리기가 애니메이션의
              프레임을 먹었습니다 — 같은 파일을 다시 열면 캐시라 부드럽고, 처음 여는 큰 파일만 버벅이던 이유입니다.
              이제 애니메이션이 끝난 뒤에 내용을 붙입니다. 자동 숨김 사이드바는 펼칠 때마다 다시 칠하던 그림자와 블러
              레이어를 상주시켜 컴포지터만 움직입니다.
            </>
          )
        },
        {
          tag: '채팅',
          name: '도구 행의 「결과 보기」 툴팁 제거',
          desc: (
            <>
              Bash·Write·Web 같은 도구 행에 마우스를 올리면 뜨던 「결과 보기 / 파일 보기 / 찾은 페이지 보기」 툴팁을
              뺐습니다. 호버 안내는 <b>밑줄</b>만 남고, 클릭 동작은 그대로입니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'FIXES',
      lead: 'Fixed the slowdown that ended in "Not responding" — plus the stuttering viewer entrance and the tool-row tooltips.',
      notes: [
        {
          tag: 'Performance',
          name: 'The app got slower the longer you used it',
          desc: (
            <>
              While a reply streamed, the engine re-read the board files from disk <b>every 20 ms, for every open
              chat</b> (hundreds of reads per second). The UI also rescanned the whole conversation on every token and
              redrew every tool row in a group each time one tool finished. Boards are now read only when they change,
              the check looks at the current turn only, and only changed rows redraw. Records that grew without bound
              (background tasks, stderr notices, sent prompts, model-switch history) are now capped.
            </>
          )
        },
        {
          tag: 'Stability',
          name: 'The app froze with "Not responding"',
          desc: (
            <>
              Chat and save requests wait up to <b>3 seconds</b> for the engine, and that wait ran on the small worker
              pool every window shares — so a brief engine stall <b>froze every window's requests at once</b>. They now
              run on a dedicated pool. The conversation save that fired every 0.6 s during a reply (re-serialising the
              whole chat) now waits 2 s while a reply is streaming. Should the UI still stall for more than 6 seconds,
              the app writes a <code>hang-*.dmp</code> diagnostic file into its home folder.
            </>
          )
        },
        {
          tag: 'Viewer',
          name: 'The file viewer and sidebar stuttered while sliding in',
          desc: (
            <>
              File contents arrived <b>in the middle of the entrance animation</b>, so syntax highlighting and
              thousands of rows ate the animation's frames — which is why reopening the same file (cached) was smooth
              and only the first open of a big file stuttered. Contents now mount after the animation ends. The
              auto-hide sidebar keeps its shadow and blur layer resident instead of repainting them on every reveal.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'Removed the "View output" tooltip on tool rows',
          desc: (
            <>
              The "View output / View file / View found pages" tooltip that appeared when hovering Bash, Write or Web
              rows is gone. Hover shows the <b>underline</b> only; clicking works as before.
            </>
          )
        }
      ]
    }
  },
  // 3.0.2 — 3.0.1 보고 넷(2026-09-02): ① 업데이트 설치가 NSIS 기본 마법사(installMode
  //   passive)로 떠 2.6.2의 스플래시가 사라짐 → quiet(/S) + PowerShell·WPF 스플래시 복귀
  //   ② Git 스트립 중복 — cwd 표기와 `rev-parse --show-toplevel` 표기의 대소문자가 달라
  //   같은 저장소가 두 줄(ccg-fs `repos`의 `seen` 키를 대소문자 무시로) ③ /clear 뒤에도
  //   엔진이 옛 thread.session_id를 쥐고 있어 다음 전송이 지운 세션을 --resume → 지운 대화
  //   누적 + CLI의 "Continue from where you left off" 반복 주입 ④ 이미 그 모델로 갈아탄 뒤
  //   같은 모델의 폴백 신호가 오면 from == to 배너(fallback_arms가 land_turn마다 비워진다).
  '3.0.2': {
    ko: {
      eyebrow: 'FIXES',
      lead: '3.0.1에 들어온 보고 넷을 고쳤습니다 — 업데이트 화면, Git 목록, 대화 비우기, 모델 전환 알림.',
      notes: [
        {
          tag: '업데이트',
          name: '업데이트 설치가 윈도우 기본 설치 마법사로 뜨던 문제',
          desc: (
            <>
              3.0은 설치기의 <b>기본 진행 화면</b>을 그대로 썼습니다 — 「뒤로/다음/취소」 단추와 압축 해제 경로가
              흐르는 그 창입니다. 2.6.2처럼 <b>조용히 설치하고</b>, 그동안 앱의 스플래시(「새 버전으로 업데이트하는
              중」)를 보여 준 뒤 설치가 끝나면 자동으로 다시 열립니다.
            </>
          )
        },
        {
          tag: 'Git',
          name: '같은 저장소가 두 줄로 보이던 문제',
          desc: (
            <>
              폴더를 <b>소문자 경로</b>로 열었을 때(<code>c:\code\…</code>) Git이 알려 주는 실제 표기(
              <code>C:\Code\…</code>)와 글자가 달라, 같은 저장소를 <b>서로 다른 두 곳</b>으로 세어 탐색기 아래
              「main」 줄이 두 번 그려졌습니다. 윈도우는 경로 대소문자를 가리지 않으므로 한 곳으로 셉니다.
            </>
          )
        },
        {
          tag: '채팅',
          name: '대화를 비웠는데 지운 대화가 되살아나던 문제',
          desc: (
            <>
              <code>/clear</code>는 화면만 비우고 <b>엔진이 쥔 세션은 그대로</b>였습니다. 그래서 다음 메시지가 방금
              지운 대화를 이어받아, 지운 내용이 계속 쌓이고 「Continue from where you left off」가 되풀이됐습니다.
              이제 대화를 비우면 <b>엔진도 그 세션을 놓아</b> 다음 메시지가 진짜 새 대화로 시작합니다. 폴더를 바꾼
              뒤 첫 메시지도 같습니다.
            </>
          )
        },
        {
          tag: '채팅',
          name: '「Opus 5 → Opus 5」처럼 같은 모델로 전환했다는 알림',
          desc: (
            <>
              모델이 한 번 자동 전환된 뒤(예: Fable 5.1 → Opus 5) 같은 모델의 전환 신호가 또 오면,{' '}
              <b>바뀐 것이 없는데도</b> 「Opus 5가 거부해 Opus 5로 전환했어요」라는 알림이 떴습니다. 되돌리기 알약도
              아무것도 되돌리지 않는 자리를 가리켰습니다. 이제 <b>실제로 모델이 바뀔 때만</b> 알립니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'FIXES',
      lead: 'Four fixes reported on 3.0.1 — the update screen, the Git list, clearing a chat, and model-switch notices.',
      notes: [
        {
          tag: 'Update',
          name: 'Installing an update showed the standard Windows installer wizard',
          desc: (
            <>
              3.0 used the installer's <b>default progress window</b> — the one with Back/Next/Cancel and a stream of
              extraction paths. It now installs <b>quietly</b> as 2.6.2 did, showing the app's own splash ("Updating to
              the new version") while it runs, and reopens automatically when the install finishes.
            </>
          )
        },
        {
          tag: 'Git',
          name: 'The same repository appeared twice',
          desc: (
            <>
              Opening a folder by a <b>lower-case path</b> (<code>c:\code\…</code>) spelled it differently from what Git
              reports (<code>C:\Code\…</code>), so one repository was counted as <b>two</b> and the "main" row was drawn
              twice under the explorer. Windows paths are case-insensitive, so they now count as one.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'A cleared conversation came back',
          desc: (
            <>
              <code>/clear</code> only emptied the screen — <b>the engine kept the session</b>. The next message
              therefore resumed the conversation you had just cleared, so the old turns kept piling up and "Continue
              from where you left off" was replayed. Clearing now <b>releases the session on the engine too</b>, so the
              next message really does start a new conversation. The same applies to the first message after changing
              folders.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'A notice saying it switched from "Opus 5" to "Opus 5"',
          desc: (
            <>
              After the model had already switched once (say Fable 5.1 → Opus 5), another switch signal for the{' '}
              <b>same</b> model produced "Opus 5 refused, so the engine switched to Opus 5" — a switch that changed
              nothing, with an undo pill pointing at nothing. The notice now appears <b>only when the model actually
              changes</b>.
            </>
          )
        }
      ]
    }
  },
  // 3.0.1 — 3.0.0 첫 주 보고 셋(2026-09-02): 컨텍스트 게이지 100%(wire.rs result.usage 누적치) ·
  //   계정 picker(맨 위 고르면 바인딩 해제 → 정렬에 흔들림 · 살아 있는 런타임 계정 ≠ 「현재」 ·
  //   추가 채팅 창 미구독) · 멀티 패널 축소 승격(맨 앞 삽입 → 1·2번 밀림) + 드래그 왕복 반전.
  '3.0.1': {
    ko: {
      eyebrow: 'FIXES',
      lead: '3.0.0 첫 주에 들어온 보고 셋을 고쳤습니다 — 컨텍스트 게이지, 계정 선택, 멀티 패널 순서.',
      notes: [
        {
          tag: '채팅',
          name: '컨텍스트 게이지가 한 번에 100%로 튀던 문제',
          desc: (
            <>
              도구 호출이 이어진 턴의 결과 프레임은 호출마다 캐시 읽기를 다시 더한 <b>턴 누적치</b>인데, 그 값을
              컨텍스트로 읽고 있어 도구 몇 번에 게이지가 100%가 됐습니다. 2.6.2처럼 <b>마지막 호출의 컨텍스트</b>를
              씁니다.
            </>
          )
        },
        {
          tag: '계정',
          name: '고른 계정이 정렬 뒤에 바뀌던 문제',
          desc: (
            <>
              맨 위 계정을 고르면 「맨 위를 따라감」으로 저장돼, 설정에서 계정을 정렬하면 이 채팅의 계정이 조용히
              다른 계정으로 옮겨 갔습니다. 이제 고른 계정은 그 채팅에 <b>고정</b>됩니다. 실행 중인 채팅의 「현재」는
              목록 맨 위가 아니라 <b>실제로 물고 있는 계정</b>을 가리키고, 추가 채팅 창에서도 「현재」·「사용 중」
              칩이 같이 보입니다.
            </>
          )
        },
        {
          tag: '멀티 패널',
          name: '패널 수를 줄였다 늘리면 1·2번이 밀리던 문제',
          desc: (
            <>
              줄일 때 포커스된 패널을 1번 자리에 끼워 넣어 나머지가 한 칸씩 밀렸습니다 — 4→2에서 3번에 포커스가
              있으면 [3, 1], 다시 4로 가면 [3, 1, 2, 4]. 이제 접히게 된 포커스 패널은 <b>보이는 마지막 자리</b>로
              오고 1‥N-1번은 그대로입니다. 헤더를 길게 눌러 옮길 때 리렌더 사이의 이벤트로 순서가 왕복하던 것도
              막았습니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'FIXES',
      lead: "Three fixes for the reports from 3.0.0's first week — the context gauge, account selection, and multi-panel order.",
      notes: [
        {
          tag: 'Chat',
          name: 'The context gauge jumped to 100% after one exchange',
          desc: (
            <>
              The result frame of a turn with several tool calls carries the turn's <b>cumulative</b> usage (cache reads
              are re-added on every call), and that value was being read as the context — a few tool calls filled the
              gauge. It now uses the <b>last call's context</b>, as 2.6.2 did.
            </>
          )
        },
        {
          tag: 'Account',
          name: 'The account you picked changed after sorting',
          desc: (
            <>
              Picking the top account was stored as "follow the top", so sorting accounts in Settings silently moved
              this chat to a different account. A picked account is now <b>pinned</b> to the chat. For a running chat,
              "Current" points at <b>the account actually in use</b> rather than the top of the list, and extra chat
              windows now show the "Current" and "In use" chips too.
            </>
          )
        },
        {
          tag: 'Multi panel',
          name: 'Shrinking then growing the panel count shifted panels 1 and 2',
          desc: (
            <>
              Shrinking inserted the focused panel at slot 1 and pushed the rest down — 4→2 with focus on panel 3 gave
              [3, 1]; back to 4 gave [3, 1, 2, 4]. A focused panel that would be folded now lands in the{' '}
              <b>last visible slot</b>, and slots 1‥N-1 stay put. Press-and-hold reordering no longer flips back and
              forth when events arrive between re-renders.
            </>
          )
        }
      ]
    }
  },
  '3.0.0': {
    ko: {
      eyebrow: 'REBUILT',
      lead: `엔진을 완전히 새로 개발했습니다 — 더 가볍고, 더 안정적으로. 2.6.2까지 쌓인 커밋이 ${COMMITS.upTo262}개인데 3.0 하나에 ${COMMITS.v3}개 — ${RATIO}배가 넘는 개발과 안정성 검증을 거쳤어요. 화면은 그대로인데 설치 파일은 5배 작아지고, 창을 하나 더 여는 비용은 5분의 1이 됐습니다.`,
      notes: [
        {
          tag: '엔진',
          name: 'Electron → Tauri + Rust',
          desc: (
            <>
              앱을 받치는 껍데기를 <b>Electron에서 Tauri로</b>, 그 속을 <b>Rust로</b> 다시 지었습니다.
              예전엔 <b>크롬 한 벌을 통째로 안고</b> 다니며 창마다 프로세스를 띄웠는데, 이제 윈도우에
              이미 있는 웹 엔진(WebView2)을 빌려 쓰고 모든 창이 <b>Rust 엔진 하나</b>를 나눠 씁니다.
              엔진 프로세스·언어 서버·창 관리 같은 뒷일은 Rust가 맡아요. 설치 파일은 <b>5.1배</b>,
              설치 폴더는 <b>4.5배</b> 작아졌고, 그 폴더에서 <b>앱 자체는 6.8MB</b>입니다 — 나머지는
              코드 인텔리전스(언어 서버와 런타임)로, 2.6.2도 같은 서버를 안고 다녔으니 같은 것끼리
              견준 값이에요.
            </>
          ),
          chart: <Cmp rows={SIZE_ROWS(true)} legend={LEGEND} />
        },
        {
          tag: '메모리',
          name: '창을 더 열어도 무겁지 않아요',
          desc: (
            <>
              예전엔 추가 채팅·팝아웃 창을 하나 열 때마다 <b>프로세스 하나</b>가 같이 붙었습니다.
              이제 <b>프로세스 0개</b>예요 — 모든 창이 엔진 하나를 나눠 씁니다. 4패널 멀티를 켜 두고
              쉴 때 쓰는 메모리도 절반 아래고, <b>코드 분석을 안 쓰는 동안엔 그 몫을 아예 안 뭅니다</b>{' '}
              — 언어 서버는 파일을 열어 볼 때만 뜨고(그때 <b>약 100MB</b>), 한동안 안 쓰면 스스로
              물러나며 그 메모리를 돌려줘요.
            </>
          ),
          chart: <Cmp rows={MEM_ROWS(true)} legend={LEGEND} />
        },
        {
          tag: '안정성',
          name: '화면이 죽어도 앱이 살아납니다',
          desc: (
            <>
              웹 화면을 그리는 부분이 죽으면 예전엔 <b>빈 창</b>만 남아 앱을 껐다 켜야 했습니다.
              이제 앱이 그 사고를 <b>스스로 감지해 화면만 다시 그립니다</b> — 실측{' '}
              <b>0.45초</b> 만에 되돌아오고, 대화도 그대로예요. 창을 여러 개 띄워 둔 상태에서도
              죽은 창 하나만 복구됩니다.
            </>
          )
        },
        {
          tag: '속도',
          name: '시작이 조금 더 빠릅니다',
          desc: (
            <>
              아이콘을 누르고 <b>첫 창이 뜰 때까지</b>도, <b>실제로 쓸 수 있게 될 때까지</b>도
              빨라졌어요(설치본 실측). 시작 화면도 <b>작은 카드가 떴다가 큰 창으로 튀는</b> 대신
              창 안에서 그대로 이어집니다.
            </>
          ),
          chart: <Cmp rows={START_ROWS(true)} legend={LEGEND} />
        },
        {
          tag: '채팅 엔진',
          name: '상태가 안 꼬입니다',
          desc: (
            <>
              채팅을 모는 부분을 <b>상주 CLI + 명시적 상태기계</b>로 다시 짰습니다. 계정·모델·모드를
              바꿨는데 <b>예전 옵션으로 조용히 계속 돌던</b> 일, 말하는 도중 눌렀는데 아무 일도 없던
              일이 규약으로 막혔어요. CLI가 밖에서 죽어도 채팅이 굳지 않고 <b>진행 중이던 항목이
              사유와 함께 정착</b>됩니다. 워크플로 알약이 뜰 때도 안 뜰 때도 있던 문제를 잡았고,
              정착 통지 뒤 <b>15초 기상 유예</b>를 둬 CLI의 마무리 턴을 끊지 않아요.
            </>
          )
        },
        {
          tag: '도구 행',
          name: '눌러서 다 봅니다',
          desc: (
            <>
              도구 행 오른쪽 끝엔 <b>짧은 요약</b>(145 lines · 12 hits · 3 files +a −d)만 남기고,{' '}
              <b>행을 누르면 요청과 결과 전문 카드</b>가 열립니다 — ToolSearch·Grep·Bash 같은 내부
              도구도 전부요. MCP 도구는 <b>「MCP 서버_도구」</b>로 이름이 붙고, <b>파일 행이나 검색
              결과 항목을 누르면 그 파일이 바로 열려요</b>.
            </>
          )
        },
        {
          tag: 'MCP & Skill',
          name: '멀티 패널마다 칩 하나',
          desc: (
            <>
              패널 헤더의 <b>「MCP &amp; Skill」 칩</b>을 누르면 그 패널이 실제로 물고 있는 MCP 서버와
              스킬이 팝오버로 뜹니다 — 설정 파일이 아니라 <b>엔진이 알려준 값</b>이라 연결 실패·플러그인
              스킬까지 그대로 보여요. 켜고 끄기도 여기서 합니다. 설정의 MCP·Skill 두 탭은 이 칩으로
              옮겨져 사라졌어요.
            </>
          )
        },
        {
          tag: '뷰어',
          name: '별도 창으로 빼서 봅니다',
          desc: (
            <>
              뷰어 헤더의 <b>「별도 창으로」</b>를 한 번 누르면 뷰어가 독립 OS 창이 되고, 이후 탐색기·
              도구 로그·Git 카드 어디서 파일을 열든 <b>그 창에서 열립니다</b>. 자리와 크기를{' '}
              <b>재시작 후에도 기억</b>하고, 상단바 드래그·스냅은 OS 것 그대로예요. 마우스 제스처 →↑로도
              바로 빠지고, <b>「창 안으로」</b>가 원래대로 되돌립니다. 이미지·SVG·HTML 미리보기도
              3.0에서 다시 뜹니다.
            </>
          )
        },
        {
          tag: '한도',
          name: '다 되면 두 갈래',
          desc: (
            <>
              계정 픽커 아래 <b>「한도 소진 시」</b>에 체크 두 줄이 생겼어요. <b>다른 계정으로 이어서</b>는
              노는 계정 중 여유가 있는 곳을 <b>초기화 임박순</b>으로 골라 갈아타고 배너가 이유를
              말합니다(Codex 계정도). <b>현재 계정으로 이어서</b>는 리셋을 기다렸다 자동 재개하되{' '}
              <b>최대 2번</b>까지만 — 그 뒤엔 「이어가기」 버튼이 남아요. 둘 다 체크하면 전환을 먼저
              시도합니다. 설정 ▸ API 「한도가 다 되면」 카드도 같은 값이에요. 조회에 실패했을 뿐인데
              「풀렸다」고 오판하던 것도 없앴습니다.
            </>
          )
        },
        {
          tag: '계정',
          name: '누가 어디를 쓰는지 보입니다',
          desc: (
            <>
              픽커와 설정 ▸ Account에 <b>「사용 중」 칩</b>(다른 자리가 물고 있는 계정)과 <b>「현재」</b>{' '}
              강조가 붙고, 전환은 <b>확인 카드</b>를 거칩니다. 「기본 계정」 개념은 없앴어요 — <b>맨 위가
              기본</b>이고 카드를 길게 눌러 끌면 순서가 바뀝니다. 한도 조회는 캐시를 먼저 그려{' '}
              <b>즉시</b> 보이고, 워크바 게이지의 「데이터 없음」과 OpenAI 게이지 공백도 고쳤어요.
              로그아웃이 되살아나거나 토큰을 잃던 사고도 닫았습니다.
            </>
          )
        },
        {
          tag: '멀티 패널',
          name: '다이얼에 1이 들어왔어요',
          desc: (
            <>
              패널 개수 다이얼이 <b>1~6</b>이 됐습니다. <b>1</b>은 탐색기·뷰어·Git까지 있는 IDE 전체
              화면이고 2부터 그리드예요. 개수를 줄여도 대화는 <b>접힐 뿐 사라지지 않습니다</b>(⌄N
              배지에서 되찾기). 팝아웃 창을 닫아도 답변이 증발하지 않고, 질문·워크플로·btw 알약은
              컴포저 위 <b>선반</b>에 나란히 서서 입력창을 덮지 않아요.
            </>
          )
        },
        {
          tag: '사이드바·알림',
          name: '더 단순하게, 한 문법으로',
          desc: (
            <>
              사이드바는 <b>「채팅」·「추가 채팅」</b> 두 섹션, 보드는 한 줄이고 새 채팅 선택 모달은
              없앴습니다(새 채팅 = 곧장 일반 채팅). 「10분」 같은 상대 시간 라벨과 「실행」 배지도
              뺐어요 — 상태 점이 이미 말하니까요. 알림·배너 7종은 <b>형태 3 × 색조 4</b>의 한
              문법으로 통일했고, 아크릴 유리가 죽어 사이드바가 <b>진회색 벽지</b>가 되던 버그는
              의도된 불투명 폴백으로 닫았습니다.
            </>
          )
        },
        {
          tag: '채팅',
          name: '자잘한 손맛',
          desc: (
            <>
              보낸 시각과 끝난 시각이 보이고, <b>예약 메시지를 다시 초안으로 불러와 고칠 수</b> 있으며
              예약 항목에 첨부 썸네일이 붙습니다. 파일 드롭 과녁이 컴포저에서 <b>채팅 화면 전체</b>로
              넓어졌고, @ 멘션에서 ←로 상위 폴더로 올라가요. 빈 곳 우클릭에 뜨던 브라우저 메뉴는
              억제했고(붙여넣기는 유지), 정착 뒤에도 <b>읽던 자리</b>가 그대로입니다. /btw 곁다리
              창도 3.0에서 제대로 열려요.
            </>
          )
        },
        {
          tag: '코드 분석',
          name: '깔자마자 색이 칠해집니다',
          desc: (
            <>
              <b>TypeScript·JavaScript·Python</b>은 설치 직후 <b>아무것도 더 깔지 않아도</b>{' '}
              호버·정의 이동·자동완성이 됩니다 — 언어 서버와 <b>전용 Node 런타임을 앱이 직접
              안고</b> 다녀요. 컴퓨터에 Node가 있든 없든, 어디서 앱을 켜든 <b>똑같이</b> 동작해요.{' '}
              <b>C#·C++</b>는 설정 ▸ 코드 분석에서 한 번 누르면 받아집니다.
            </>
          )
        },
        {
          tag: 'Git',
          name: '큰 커밋도 됩니다',
          desc: (
            <>
              파일 <b>2,000개</b>를 한 번에 커밋하면 실패하던 문제(Windows 명령줄 길이 한계)를
              고쳤고, AI 커밋 메시지용 diff 수집은 파일당 스폰에서 <b>전체 1~2회</b>로 줄여 훨씬
              빨라요. 미추적 폴더를 「안 바뀌었다」고 하던 것, 못 읽는 폴더를 「비어 있음」이라 하던
              것도 사유를 말하게 했습니다.
            </>
          )
        },
        {
          tag: '창·트레이',
          name: 'X는 트레이로, 업데이트는 앱 안에서',
          desc: (
            <>
              창의 <b>X는 종료가 아니라 트레이 숨김</b>이에요 — 처음 한 번 우하단 안내가 뜹니다. 앱을
              다시 실행하면 새 창 대신 <b>기존 창이 앞으로</b> 옵니다. Ctrl+W가 남의 창을 닫던 버그를
              고쳤고, 닫기 전엔 저장을 끝냅니다. 앱 <b>자동 업데이트</b> 통로가 생겼고 부팅 때
              엔진(Claude Code)도 자동으로 올라가요. 셸 문구(파일 대화상자·설치 실패 안내)도 UI
              언어를 따릅니다.
            </>
          )
        },
        {
          tag: '파일',
          name: '휴지통에 못 넣으면 지우지 않아요',
          desc: (
            <>
              탐색기 삭제는 언제나 휴지통을 거칩니다. 네트워크·이동식·subst 드라이브처럼 휴지통이
              없는 곳에서 파일이 <b>조용히 증발하던</b> 자리를 막았어요 — 못 넣으면 지우지 않고
              알려줍니다.
            </>
          )
        },
        {
          tag: '알아둘 것',
          name: '3.0은 새 집에서 시작합니다',
          desc: (
            <>
              앱 홈이 <b>~/.agentcodegui3</b>로 갈라졌습니다. 2.6.2와 <b>나란히 설치·동시 사용</b>할
              수 있고 2.6.2 데이터엔 손을 대지 않아요. 대신 <b>기존 대화와 로그인은 3.0으로 넘어오지
              않습니다</b> — 2.6.2를 열면 그대로 있고, 3.0에선 한 번 다시 로그인해 주세요.
            </>
          )
        },
        {
          tag: '빠진 것',
          name: 'Verse 지원을 뺐습니다',
          desc: (
            <>
              UEFN Verse 언어 지원(서버 연결·구문 강조·VRS 배지·설정 항목)은 유지 부담이 커서
              3.0에서 <b>통째로 뺐습니다</b>. 필요하면 2.6.2를 그대로 쓰시면 돼요.
            </>
          )
        },
        {
          tag: '모델',
          name: 'Fable 5.1이 들어왔어요',
          desc: (
            <>
              모델 픽커에 Claude의 최신 최상위 모델 <b>Fable 5.1</b>이 올라왔습니다 — 채팅·멀티 패널·
              추가 채팅·Git 커밋 메시지 어디서든 고를 수 있어요. Fable 전용 <b>주간 한도</b>는 계정
              픽커에 따로 한 줄로 보이고, 정책상 답을 거부해 다른 모델로 넘어갈 땐 <b>확인 카드</b>가
              먼저 묻습니다.
            </>
          )
        }
      ]
    },
    en: {
      eyebrow: 'REBUILT',
      lead: `The engine was rebuilt from scratch — lighter and more stable. Everything up to 2.6.2 took ${COMMITS.upTo262} commits; 3.0 alone took ${COMMITS.v3} — more than ${RATIO}× the development and stability work. The screens look the same, but the installer is 5× smaller and one more window costs a fifth of what it did.`,
      notes: [
        {
          tag: 'Engine',
          name: 'Electron → Tauri + Rust',
          desc: (
            <>
              The shell that carries the app was rebuilt <b>from Electron to Tauri</b>, with its core{' '}
              <b>in Rust</b>. It used to <b>ship an entire copy of Chrome</b> and spawn a process per
              window; now it borrows the web engine Windows already has (WebView2) and every window
              shares <b>one Rust engine</b>. Engine processes, language servers and window management
              are all handled in Rust. The installer is <b>5.1×</b> smaller and the installed folder{' '}
              <b>4.5×</b> — and of that folder <b>the app itself is 6.8MB</b>; the rest is code
              intelligence (language servers and their runtime), which 2.6.2 shipped too, so this
              compares like with like.
            </>
          ),
          chart: <Cmp rows={SIZE_ROWS(false)} legend={LEGEND} />
        },
        {
          tag: 'Memory',
          name: 'Extra windows are cheap now',
          desc: (
            <>
              Every extra chat or pop-out window used to add <b>a whole process</b>. Now it adds{' '}
              <b>zero</b> — every window shares one engine. Sitting idle with a 4-panel multi board
              takes less than half of what it did, and <b>you pay nothing for code intelligence while
              you are not using it</b> — the language servers start only when you open a file (about{' '}
              <b>100MB</b> then), and step back on their own after a while, handing that memory back.
            </>
          ),
          chart: <Cmp rows={MEM_ROWS(false)} legend={LEGEND} />
        },
        {
          tag: 'Stability',
          name: 'The app recovers from a dead view',
          desc: (
            <>
              When the part that draws the UI crashed, you used to be left with an{' '}
              <b>empty window</b> and had to restart. The app now <b>detects that and redraws the
              view by itself</b> — measured at <b>0.45s</b>, with your conversation intact. With
              several windows open, only the one that died is recovered.
            </>
          )
        },
        {
          tag: 'Speed',
          name: 'Starts a little faster',
          desc: (
            <>
              Both <b>time to first window</b> and <b>time to actually usable</b> came down
              (measured on the installed build). The startup splash also stays inside the window
              instead of <b>popping from a small card to a big window</b>.
            </>
          ),
          chart: <Cmp rows={START_ROWS(false)} legend={LEGEND} />
        },
        {
          tag: 'Chat engine',
          name: 'State no longer tangles',
          desc: (
            <>
              The part that drives a chat was rewritten as a <b>resident CLI plus an explicit state
              machine</b>. Switching account, model or mode while it <b>quietly kept running on the
              old options</b>, or a click mid-turn doing nothing at all, is now ruled out by contract.
              If the CLI dies from outside, the chat no longer freezes — <b>whatever was in flight
              settles with a reason</b>. Workflow pills that showed up only sometimes are fixed, and a{' '}
              <b>15-second wake grace</b> after the settle notice keeps the CLI&apos;s wrap-up turn from
              being cut off.
            </>
          )
        },
        {
          tag: 'Tool rows',
          name: 'Click to see everything',
          desc: (
            <>
              The right edge of a tool row keeps only a <b>short summary</b> (145 lines · 12 hits ·
              3 files +a −d); <b>click the row for the full request and result card</b> — for internal
              tools like ToolSearch, Grep and Bash too. MCP tools are named <b>“MCP server_tool”</b>,
              and <b>clicking a file row or a search hit opens that file</b>.
            </>
          )
        },
        {
          tag: 'MCP & Skill',
          name: 'One chip per multi panel',
          desc: (
            <>
              Press the <b>“MCP &amp; Skill” chip</b> in a panel header and a popover lists the MCP
              servers and skills that panel is actually holding — reported <b>by the engine</b>, not
              read from a config file, so failed connections and plugin skills show as they are.
              Toggle them on and off right there. The MCP and Skill tabs in Settings moved into this
              chip and are gone.
            </>
          )
        },
        {
          tag: 'Viewer',
          name: 'Pop it out into its own window',
          desc: (
            <>
              Press <b>“Separate window”</b> in the viewer header once and the viewer becomes its own
              OS window; from then on every file you open — from Explorer, tool logs or Git cards —{' '}
              <b>opens there</b>. It <b>remembers position and size across restarts</b>, and title-bar
              drag and snap are the OS&apos;s own. The →↑ mouse gesture pops it out too, and{' '}
              <b>“Back inside”</b> restores it. Image, SVG and HTML preview are back in 3.0 as well.
            </>
          )
        },
        {
          tag: 'Limits',
          name: 'Two ways forward when it runs out',
          desc: (
            <>
              Under the account picker there is now a <b>“When the limit runs out”</b> pair of
              checkboxes. <b>Continue on another account</b> picks an idle account with room,{' '}
              <b>soonest reset first</b>, and the banner says why (Codex accounts too).{' '}
              <b>Continue on this account</b> waits for the reset and resumes on its own, but{' '}
              <b>at most twice</b> — after that a “Resume” button waits for you. Check both and
              switching is tried first. The “When the limit runs out” card in Settings ▸ API edits the
              same values. A lookup that merely failed is no longer mistaken for “limit lifted”.
            </>
          )
        },
        {
          tag: 'Accounts',
          name: 'See who is using what',
          desc: (
            <>
              The picker and Settings ▸ Account gain an <b>“In use” chip</b> (an account another seat
              is holding) and a <b>“Current”</b> highlight, and switching goes through a{' '}
              <b>confirmation card</b>. The “default account” concept is gone — <b>the top one is the
              default</b>, and long-press-drag reorders. Limit lookups paint from cache <b>instantly</b>;
              the work bar gauge&apos;s “no data” and the blank OpenAI gauge are fixed. Logouts that
              resurrected themselves or lost tokens are closed too.
            </>
          )
        },
        {
          tag: 'Multi panel',
          name: 'The dial now starts at 1',
          desc: (
            <>
              The panel-count dial runs <b>1 to 6</b>. <b>1</b> is the full IDE layout with Explorer,
              viewer and Git; 2 and up is the grid. Turning the count down <b>folds conversations
              instead of deleting them</b> (find them under the ⌄N badge). Closing a pop-out no longer
              loses its reply, and question, workflow and btw pills line up on a <b>shelf</b> above the
              composer instead of covering it.
            </>
          )
        },
        {
          tag: 'Sidebar & notices',
          name: 'Simpler, and one grammar',
          desc: (
            <>
              The sidebar is two sections — <b>Chats</b> and <b>Extra chats</b> — the board is one
              line, and the new-chat picker modal is gone (new chat = a plain chat, straight away).
              Relative time labels like “10m” and the “running” badge are gone too; the status dot
              already says it. The seven kinds of notices and banners share one grammar (<b>3 shapes ×
              4 tones</b>), and the bug where dead acrylic turned the sidebar into a <b>flat grey
              wall</b> is closed with an intentional opaque fallback.
            </>
          )
        },
        {
          tag: 'Chat',
          name: 'Small comforts',
          desc: (
            <>
              Sent and finished times are shown, <b>queued messages can be pulled back into the draft
              and edited</b>, and queued items show attachment thumbnails. The file-drop target grew
              from the composer to <b>the whole chat surface</b>, and ← in an @ mention goes up a
              folder. The browser menu on right-clicking empty space is suppressed (paste stays), your{' '}
              <b>reading position</b> survives a settle, and the /btw side window actually opens in 3.0.
            </>
          )
        },
        {
          tag: 'Code',
          name: 'Syntax intelligence works out of the box',
          desc: (
            <>
              <b>TypeScript, JavaScript and Python</b> get hover, go-to-definition and completion{' '}
              <b>with nothing else to install</b> — the app now <b>carries the language servers
              and their own Node runtime</b>. It behaves the same whether or not Node is on your
              machine, and no matter where you launch the app from. <b>C# and C++</b> are one click
              away in Settings ▸ Code analysis.
            </>
          )
        },
        {
          tag: 'Git',
          name: 'Big commits work',
          desc: (
            <>
              Committing <b>2,000 files</b> at once used to fail (Windows command-line length); fixed.
              Diff collection for AI commit messages went from one spawn per file to <b>one or two in
              total</b>, so it is far faster. Untracked folders reported as “unchanged” and unreadable
              folders reported as “empty” now state the real reason.
            </>
          )
        },
        {
          tag: 'Window & tray',
          name: 'X goes to the tray; updates come in-app',
          desc: (
            <>
              The window&apos;s <b>X hides to the tray instead of quitting</b> — a one-time notice
              explains it. Launching the app again <b>brings the existing window forward</b> instead of
              opening a second one. Ctrl+W closing someone else&apos;s window is fixed, and saves flush
              before closing. The app has an <b>auto-update</b> path now, and the engine (Claude Code)
              updates itself at boot. Shell text (file dialogs, install failures) follows the UI
              language.
            </>
          )
        },
        {
          tag: 'Files',
          name: 'Not deleted unless it reaches the Recycle Bin',
          desc: (
            <>
              Explorer deletes always go through the Recycle Bin. On network, removable or subst
              drives with no bin, files used to <b>vanish silently</b> — now the app refuses and tells
              you instead.
            </>
          )
        },
        {
          tag: 'Good to know',
          name: '3.0 starts in a new home',
          desc: (
            <>
              The app home moved to <b>~/.agentcodegui3</b>. 3.0 <b>installs and runs side by side
              with 2.6.2</b> and never touches its data. The flip side: <b>existing chats and logins do
              not carry over</b> — they stay in 2.6.2, and you sign in once more in 3.0.
            </>
          )
        },
        {
          tag: 'Removed',
          name: 'Verse support is gone',
          desc: (
            <>
              UEFN Verse language support (server hookup, syntax colors, VRS badge, settings entries)
              was <b>dropped entirely</b> in 3.0 — the upkeep cost too much. 2.6.2 still has it if you
              need it.
            </>
          )
        },
        {
          tag: 'Model',
          name: 'Fable 5.1 is in',
          desc: (
            <>
              The model picker now offers Claude&apos;s newest top-tier model, <b>Fable 5.1</b> — in
              chat, multi panels, extra chats and Git commit messages alike. Its dedicated <b>weekly
              limit</b> shows as its own row in the account picker, and when a policy refusal falls
              back to another model, a <b>confirmation card</b> asks first.
            </>
          )
        }
      ]
    }
  }
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

  // 설정 › 앱 · 업데이트의 「패치노트 보기」 — SEEN 도장과 무관하게 언제든 다시 연다
  // (Settings.tsx의 window.dispatchEvent(new CustomEvent('ccg-open-patchnotes'))).
  useEffect(() => {
    const open = (): void => {
      window.api.app
        .getVersion()
        .then((v) => {
          const ver = v || noteVersions()[0]
          if (!ver) return
          setVersion(ver)
          setSel(RELEASES[ver] ? ver : noteVersions()[0])
        })
        .catch(() => {})
    }
    window.addEventListener('ccg-open-patchnotes', open)
    return () => window.removeEventListener('ccg-open-patchnotes', open)
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

        {/* 릴리즈 선택 — 시리즈 안의 버전들을 페이지처럼 오간다 (최신 MAX_VERSIONS=10개까지 · 한 줄).
            덩이가 하나뿐이어도 줄을 남긴다 — 3.0.x가 계속 쌓일 자리라 첫 릴리즈부터 같은 모양으로. */}
        <div className="pn-vers">
          {versions.map((v) => (
            <button key={v} className={'pn-vbtn' + (v === cur ? ' on' : '')} onClick={() => setSel(v)}>
              v{v}
            </button>
          ))}
        </div>

        {/* key=버전 — 릴리즈를 바꾸면 스크롤이 맨 위에서 다시 시작한다 */}
        <div className="pn-scroll" key={cur}>
          {rel.notes.map((n, i) => (
            <article key={i} className="pn-item">
              <div className="pn-num">{String(i + 1).padStart(2, '0')}</div>
              <div>
                <span className="pn-tag">{n.tag}</span>
                <h3 className="pn-name">{n.name}</h3>
                <p className="pn-desc">{n.desc}</p>
                {n.chart}
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
