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
const MAX_VERSIONS = 5
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

        {/* 릴리즈 선택 — 시리즈 안의 버전들을 페이지처럼 오간다 (최신 5개까지).
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
