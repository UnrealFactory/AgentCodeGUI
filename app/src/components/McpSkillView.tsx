/* ============================================================
 * McpSkillView — **이 패널(=채팅)이 실제로 들고 있는 도구 환경**을 헤더 칩 하나로.
 *
 * 왜 패널마다 다른가: MCP 서버는 `<폴더>/.mcp.json`, 스킬은 `<폴더>/.claude/skills`에서
 * 온다. 멀티 그리드는 패널마다 작업 폴더가 다르므로 **패널마다 목록이 다르다.** 2.6.2는
 * 이것을 설정 화면 한 곳에서만 보여줬고(전역 스캔), "지금 이 대화에 뭐가 붙어 있나"는
 * 어디에서도 못 물었다.
 *
 * 값의 출처는 와이어 하나다(`EngineEvent{type:'tooling'}`) — 셸이 `system/init`의
 * `mcp_servers`·`skills`·`plugins`·`tools`를 커맨드 사전과 조인해 REPLACE로 보낸다.
 * 디스크를 다시 스캔하지 않는다: 연결 실패도, 승인 안 된 `.mcp.json`도, 플러그인이
 * 들고 온 스킬도 파일만 봐서는 모른다.
 *
 * ★R2 — 그 푸시는 **스폰당 한 장**이다. R1은 그것을 컴포넌트 state에만 담아서, 껍데기가
 * 갈리는 순간(「크게 보기」=오버레이 카드로 이동 · 팝아웃=다른 창 · 복귀=그리드 재마운트)
 * 칩이 통째로 증발했다 — 사용자는 "지금 이 대화에 뭐가 붙어 있나"를 다시 보려고 턴을 한
 * 번 더 태워야 했다(크리틱 A9·A6). 값은 셸의 옮김기에 그대로 살아 있었고, 없던 것은
 * **다시 물을 창구**였다. 이제 마운트마다 한 번 묻는다(`multi.toolingGet`).
 * 재시작 뒤에 안 되살아나는 원칙은 그대로다 — 스냅샷은 여전히 셸 **메모리**에만 있다.
 *
 * 문법은 전부 기존 것이다 — 새 CSS를 한 줄도 안 만든다:
 *   칩   = `.ma-p-folder` (패널 헤더 모노 필, 작업 폴더 칩과 같은 면)
 *   래퍼 = `.hfold`      (팝오버 기준점 + 안쪽 클릭의 바깥닫힘 차단)
 *   카드 = `.wb-pop.hpop.r` (아래로 열리는 WorkBar 유리 팝오버)
 *   섹션 = `.hsec` · 행 = `.wb-prow`(+`.done`/`.err`) · 빈 상태 = `.ag-none`
 * ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { ChatTooling, EngineEvent, McpLive, SkillLive } from '@shared/protocol'
import { IconAlert, IconBook, IconCheck, IconChevDown, IconEyeOff, IconPlug, IconServer } from './icons'
import { t, useLang } from '../lib/i18n'

/** 경로 비교용 정규화 — 대소문자·구분자·후행 슬래시를 접는다(m-logic §2.3의 축소판). */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
function baseOf(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return n.slice(n.lastIndexOf('/') + 1) || n
}

/** CLI가 보고하는 연결 상태 → 사람 말. 모르는 값은 **그대로 보여준다**(지어내지 않는다). */
function statusLabel(s: string): string {
  if (s === 'connected') return t('연결됨', 'Connected')
  if (s === 'failed') return t('연결 실패', 'Connection failed')
  if (s === 'needs-auth') return t('인증 필요', 'Needs auth')
  if (s === 'pending') return t('연결 중', 'Connecting')
  if (s === 'disabled') return t('CLI가 껐음', 'Disabled by the CLI')
  // 셸이 붙인 값 — CLI는 끈 서버를 아예 안 싣는다(그래서 이 행이 필요하다)
  if (s === 'off') return t('설정에서 껐어요', 'Turned off in Settings')
  return s
}

/** 행 색조 — 기존 `.wb-prow.done`(초록 아이콘·흐린 글씨) / `.err`(빨간 아이콘) 그대로. */
function mcpTone(s: string): string {
  if (s === 'connected') return ' done'
  if (s === 'failed' || s === 'needs-auth') return ' err'
  return ''
}
function mcpIcon(s: string): React.ReactNode {
  if (s === 'connected') return <IconCheck size={12} stroke={2.4} />
  if (s === 'failed' || s === 'needs-auth') return <IconAlert size={12} />
  if (s === 'pending') return <span className="spin" />
  return <IconEyeOff size={12} />
}

/**
 * 설명 한 줄 — **여기서 자르지 않으면 팝오버가 문단 더미가 된다.**
 *
 * 실측(`poc-mcpskill.mjs --app`): 한 패널의 스킬이 15~16개이고 그중 내장 스킬 설명은
 * 300~900자다(`dataviz` 941자·`update-config` 604자). 300px 폭 카드에서 그 한 행이
 * 카드 높이(340px)를 통째로 먹어, 스크롤을 몇 번 내려야 다음 스킬 이름이 나온다 —
 * 이 목록의 일은 "무엇이 붙어 있나"이지 설명서가 아니다.
 *
 * CSS 한 줄 자르기(`text-overflow`)를 안 쓰는 이유: `.wb-prow .sub`는 다른 팝오버
 * 넷이 함께 쓰는 규칙이라, 거기에 `nowrap`을 넣으면 남의 화면이 같이 바뀐다.
 */
function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 110 ? flat.slice(0, 110).trimEnd() + '…' : flat
}

/** 스킬 스코프 배지 — 표식이 없으면(내장·설명 없음) **아무것도 안 적는다**. */
function scopeLabel(s: SkillLive['scope']): string {
  if (s === 'project') return t('프로젝트', 'Project')
  if (s === 'user') return t('개인', 'Personal')
  if (s === 'local') return t('로컬', 'Local')
  if (s === 'plugin') return t('플러그인', 'Plugin')
  return ''
}

function McpRow({ m }: { m: McpLive }) {
  const n = m.tools.length
  return (
    <div className={'wb-prow' + mcpTone(m.status)}>
      <span className="ic">{mcpIcon(m.status)}</span>
      <span className="grow">
        {m.name}
        <span className="sub">
          {statusLabel(m.status)}
          {/* 도구 이름을 접어 넣는다 — "붙긴 했는데 뭘 주는지"가 이 목록의 반이다 */}
          {n > 0 ? ` · ${m.tools.slice(0, 4).join(', ')}${n > 4 ? ` +${n - 4}` : ''}` : ''}
        </span>
      </span>
      {n > 0 && <span className="end">{t(`도구 ${n}`, `${n} tools`)}</span>}
    </div>
  )
}

function SkillRow({ s }: { s: SkillLive }) {
  const badge = scopeLabel(s.scope)
  return (
    <div className={'wb-prow' + (s.off ? ' done' : '')}>
      <span className="ic">{s.off ? <IconEyeOff size={12} /> : <IconBook size={12} />}</span>
      <span className="grow">
        /{s.name}
        {/* 설명은 한 줄로 자른다 — 내장 스킬 설명은 수백 자짜리가 있다(dataviz 실측 941자) */}
        <span className="sub" title={s.off ? undefined : s.description || undefined}>
          {s.off
            ? t('설정에서 껐어요', 'Turned off in Settings')
            : s.description
              ? oneLine(s.description)
              : t('설명 없음', 'No description')}
        </span>
      </span>
      {badge && <span className="end">{badge}</span>}
    </div>
  )
}

/**
 * 패널 헤더의 도구 환경 칩. `panelId`는 `ma:event` 봉투의 주소 — 이 컴포넌트가 **스스로**
 * 구독한다(패널 세션 상태를 거치지 않는다: 도구 환경은 대화 내용이 아니라 실행 환경이고,
 * 스냅샷에 절이면 재시작 뒤 낡은 목록이 되살아난다).
 *
 * `onOpen`은 **팝오버 배타**의 절반이다 — 호스트가 자기 폴더 팝오버를 접는다(아래 참조).
 */
export function McpSkillView({
  panelId,
  cwd,
  onOpen
}: {
  panelId: string
  cwd: string
  onOpen?: () => void
}) {
  useLang()
  const [snap, setSnap] = useState<ChatTooling | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    let alive = true
    setSnap(null) // 자리가 바뀌면 남의 목록이다
    // ★R2 ① **지금 값을 셸에 묻는다.** 이 한 줄이 칩의 수명이다 — 푸시는 스폰당 한 장뿐이라
    // 재마운트(「크게 보기」·팝아웃 첫 진입·그리드 복귀)에는 아무것도 안 온다. 답이 `null`
    // 이면 아직 모르는 것이므로(런타임 없음 · `system/init` 전 · 앱 재시작 직후) 그대로 둔다.
    void window.api.multi
      ?.toolingGet?.(panelId)
      .then((tl) => {
        // 물어보는 사이에 푸시가 먼저 닿았으면 그쪽이 최신이다(왕복은 수 ms지만 0은 아니다).
        if (alive && tl) setSnap((cur) => cur ?? tl)
      })
      .catch(() => {})
    // ② 이후는 푸시가 잇는다(턴마다 · 정책 변경 · 세션 중간 커맨드 갱신).
    const off =
      window.api.multi?.onEvent?.(panelId, (e: EngineEvent) => {
        if (e.type === 'tooling') setSnap(e.tooling)
      }) ?? (() => {})
    return () => {
      alive = false
      off()
    }
  }, [panelId])

  // 팝오버는 Esc / 바깥 클릭으로 닫는다 (네이티브 다이얼로그 금지 — 카드 패턴 유지).
  //
  // ★R2 — **캡처 단계**로 듣고 내 래퍼 안이면 무시한다. R1은 버블 단계 `window` mousedown
  // 하나였고 "안쪽 클릭은 `.hfold`의 stopPropagation이 막는다"에 기대고 있었는데, 그 전제가
  // 옆 칩에서 반대로 물렸다: 폴더 칩의 래퍼도 `.hfold`(=stopPropagation)라 그 클릭이
  // `window`까지 **안 온다**. 그래서 도구 팝오버가 안 닫힌 채 폴더 팝오버가 그 위에 정확히
  // 포개져 떴다(크리틱 A10 — 겹침 64,200px²). 캡처는 타깃보다 **먼저** 돌므로 남이 끊어도
  // 울리고, 내 안쪽 클릭은 래퍼 containment로 직접 가른다(전파에 안 기댄다).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 폴더를 바꾼 직후의 스냅샷은 **남의 폴더 것**이다. 와이어가 cwd를 싣고 오므로
  // 어긋나면 없는 것으로 친다 — 낡은 목록을 그리느니 안 그리는 게 낫다.
  const stale = !!snap && !!cwd && norm(snap.cwd) !== norm(cwd)
  const tl = stale ? null : snap
  // 첫 턴 전에는 아무것도 모른다. 빈 칩을 세우지 않는다("없음"과 "아직 모름"은 다르다).
  if (!tl) return null

  // ★R2 — **상태를 전부 센다.** R1은 `connected`/`failed`/`off` 셋만 읽어서, 서버 10대
  // (연결7·실패1·인증필요1·연결중1)를 「MCP 7개 연결 · 2개 실패」로 적었다 — 합이 9다
  // (크리틱 A1). 사라진 한 대는 `pending`이었고, `needs-auth`는 「실패」로 합산됐다.
  // 사용자가 할 일이 다르다: 하나는 로그인, 하나는 설정 고치기, 하나는 그냥 기다리기.
  // status는 열린 집합이라 **나머지 전부**를 `unknown`으로 모아 분모를 정확히 유지한다.
  const n = (p: (s: string) => boolean): number => tl.mcp.filter((m) => p(m.status)).length
  const live = n((s) => s === 'connected')
  const failed = n((s) => s === 'failed')
  const auth = n((s) => s === 'needs-auth')
  const pending = n((s) => s === 'pending')
  const cliOff = n((s) => s === 'disabled')
  const offN = n((s) => s === 'off') // 셸이 되붙인 행(설정에서 끔)
  // 분모 = CLI가 아는 서버(끈 것 제외). 나머지는 전부 `unknown`으로 떨어져 합이 맞는다.
  const total = tl.mcp.length - offN
  const unknown = total - live - failed - auth - pending - cliOff
  // 색으로 먼저 읽혀야 하는 것 = 사용자가 손대야 붙는 것(실패·인증 필요).
  const bad = failed + auth
  const skillsOn = tl.skills.filter((s) => !s.off)
  const skillsOff = tl.skills.length - skillsOn.length
  // 칩 본문 — 모노 필에 들어가는 최소 정보. **다 안 붙었으면** `n/전체`로 분모를 드러낸다
  // (R1은 실패가 있을 때만 드러내서, 연결 중 1대만 남은 판이 「4」로 보였다).
  const count = live === total ? `${live}` : `${live}/${total}`
  const tip = [
    tl.mcp.length === 0
      ? t('MCP 서버 없음', 'No MCP servers')
      : t(
          `MCP ${live}개 연결${failed ? ` · ${failed}개 실패` : ''}${auth ? ` · ${auth}개 인증 필요` : ''}` +
            `${pending ? ` · ${pending}개 연결 중` : ''}${cliOff ? ` · ${cliOff}개 CLI가 껐음` : ''}` +
            `${unknown > 0 ? ` · ${unknown}개 상태 미상` : ''}${offN ? ` · ${offN}개 꺼짐` : ''}`,
          `${live} MCP connected${failed ? ` · ${failed} failed` : ''}${auth ? ` · ${auth} need auth` : ''}` +
            `${pending ? ` · ${pending} connecting` : ''}${cliOff ? ` · ${cliOff} disabled by the CLI` : ''}` +
            `${unknown > 0 ? ` · ${unknown} unknown` : ''}${offN ? ` · ${offN} off` : ''}`
        ),
    // 「끈 스킬」이라고 적는다 — 앞의 MCP 문장에도 「N개 꺼짐」이 올 수 있어서, 같은
    // 낱말을 `·`로 잇기만 하면 그 수가 서버 것인지 스킬 것인지 안 갈린다.
    t(`스킬 ${skillsOn.length}개${skillsOff ? ` · 끈 스킬 ${skillsOff}개` : ''}`,
      `${skillsOn.length} skills${skillsOff ? ` · ${skillsOff} skills off` : ''}`),
    t('클릭해 자세히', 'Click for details')
  ].join(' · ')

  return (
    <span className="hfold" ref={wrapRef} onMouseDown={(e) => e.stopPropagation()}>
      <button
        className={'ma-p-folder' + (open ? ' on' : ' has-tip tip-wrap')}
        data-tip={tip}
        aria-label={tip}
        onClick={() =>
          setOpen((o) => {
            // ★R2 배타의 나머지 절반 — 내가 열릴 때 호스트가 자기 폴더 팝오버를 접는다.
            // 반대 방향(내가 열린 채 폴더 칩)은 위 캡처 리스너가 닫는다. 두 방향을 다
            // 막아야 "동시에 안 열린다"가 참이 된다(R1 §2.2는 참이 아니었다).
            if (!o) onOpen?.()
            return !o
          })
        }
      >
        <IconPlug size={11} />
        {/* 실패는 색으로 먼저 읽혀야 한다 — 팝오버를 열기 전에 알아야 하는 유일한 값
            (AgentPanel의 오류 표기와 같은 인라인 토큰 사용) */}
        <span style={bad > 0 ? { color: 'var(--red)' } : undefined}>{count}</span>
        <span>·</span>
        <span>{skillsOn.length}</span>
        <IconChevDown size={10} />
      </button>
      {open && (
        <div className="wb-pop hpop r">
          <div className="wb-pop-h">
            <span className="t">{t('도구 환경', 'Tool environment')}</span>
            {/* ★R2 정정(크리틱 §5-마) — 표시 이름은 **패널 meta의 cwd**에서 딴다.
                `tl.cwd`는 `system/init`이 되돌려 준 값이고, 앱은 CLI를 정규화된(소문자)
                cwd로 띄우므로 CLI가 소문자를 돌려준다 — 같은 헤더에서 폴더 칩은
                `AgentCodeGUI`, 이 머리는 `agentcodegui`가 됐다. 위 `stale` 게이트가
                두 경로의 폴더가 같음을 이미 보장하므로 골라 쓰기만 하면 된다. */}
            <span className="c">{baseOf(cwd || tl.cwd)}</span>
          </div>

          {/* ★R2 — 섹션 머리는 **칩과 같은 수**를 센다. R1은 여기만 off를 포함해서
              칩 `1 · 1` 옆에 「MCP 서버 2」가 섰다(크리틱 §3.3 끝). 끈 것은 따로 적는다. */}
          <div className="hsec">
            {t('MCP 서버', 'MCP servers')}
            {total > 0 ? ` ${total}` : ''}
            {offN > 0 ? t(` · 꺼짐 ${offN}`, ` · ${offN} off`) : ''}
          </div>
          {tl.mcp.length ? (
            <div className="wb-pop-list">
              {tl.mcp.map((m) => (
                <McpRow key={m.name} m={m} />
              ))}
            </div>
          ) : (
            <div className="ag-none">
              {t('이 폴더에 붙은 MCP 서버가 없어요', 'No MCP servers attached to this folder')}
            </div>
          )}

          <div className="hsec">
            {t('스킬', 'Skills')} {skillsOn.length}
            {skillsOff > 0 ? t(` · 꺼짐 ${skillsOff}`, ` · ${skillsOff} off`) : ''}
          </div>
          {tl.skills.length ? (
            <div className="wb-pop-list">
              {/* 키에 자리를 섞는다 — 같은 이름이 두 번 오는 판이 있다(플러그인/프로젝트
                  중복). 이름만 키로 쓰면 React가 같은 행으로 접어 하나가 사라진다. */}
              {tl.skills.map((s, i) => (
                <SkillRow key={`${s.name}#${i}`} s={s} />
              ))}
            </div>
          ) : (
            <div className="ag-none">{t('쓸 수 있는 스킬이 없어요', 'No skills available')}</div>
          )}

          {tl.plugins.length > 0 && (
            <>
              <div className="hsec">
                {t('플러그인', 'Plugins')} {tl.plugins.length}
              </div>
              <div className="wb-pop-list">
                {tl.plugins.map((p) => (
                  <div className="wb-prow" key={p.name}>
                    <span className="ic">
                      <IconServer size={12} />
                    </span>
                    <span className="grow">{p.name}</span>
                    {p.version && <span className="end">{p.version}</span>}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 출처를 적는다 — "왜 저 서버가 여기 없지"의 답이 여기 있어야 한다.
              끈 항목은 위 목록에 꺼짐 행으로 남고, 켜고 끄기는 아직 설정에서만 한다. */}
          <div className="wb-psep" />
          <div className="ag-none">
            {t(
              '이 대화가 실행될 때 CLI가 보고한 목록이에요 · 프로젝트: <폴더>/.mcp.json · .claude/skills',
              'Reported by the CLI when this chat ran · Project: <folder>/.mcp.json · .claude/skills'
            )}
          </div>
        </div>
      )}
    </span>
  )
}
