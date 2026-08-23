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
 * 문법은 전부 기존 것이다 — 새 CSS를 한 줄도 안 만든다:
 *   칩   = `.ma-p-folder` (패널 헤더 모노 필, 작업 폴더 칩과 같은 면)
 *   래퍼 = `.hfold`      (팝오버 기준점 + 안쪽 클릭의 바깥닫힘 차단)
 *   카드 = `.wb-pop.hpop.r` (아래로 열리는 WorkBar 유리 팝오버)
 *   섹션 = `.hsec` · 행 = `.wb-prow`(+`.done`/`.err`) · 빈 상태 = `.ag-none`
 * ============================================================ */
import { useEffect, useState } from 'react'
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
 */
export function McpSkillView({ panelId, cwd }: { panelId: string; cwd: string }) {
  useLang()
  const [snap, setSnap] = useState<ChatTooling | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setSnap(null) // 자리가 바뀌면 남의 목록이다 — 다음 턴의 init이 채운다
    return (
      window.api.multi?.onEvent?.(panelId, (e: EngineEvent) => {
        if (e.type === 'tooling') setSnap(e.tooling)
      }) ?? (() => {})
    )
  }, [panelId])

  // 팝오버는 Esc / 바깥 클릭으로 닫는다 (네이티브 다이얼로그 금지 — 카드 패턴 유지).
  // 안쪽 클릭은 호스트가 감싼 `.hfold`가 mousedown 전파를 막는다(FolderPop과 같은 규약).
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 폴더를 바꾼 직후의 스냅샷은 **남의 폴더 것**이다. 와이어가 cwd를 싣고 오므로
  // 어긋나면 없는 것으로 친다 — 낡은 목록을 그리느니 안 그리는 게 낫다.
  const stale = !!snap && !!cwd && norm(snap.cwd) !== norm(cwd)
  const tl = stale ? null : snap
  // 첫 턴 전에는 아무것도 모른다. 빈 칩을 세우지 않는다("없음"과 "아직 모름"은 다르다).
  if (!tl) return null

  const bad = tl.mcp.filter((m) => m.status === 'failed' || m.status === 'needs-auth').length
  const live = tl.mcp.filter((m) => m.status === 'connected').length
  const offN = tl.mcp.filter((m) => m.status === 'off').length
  const skillsOn = tl.skills.filter((s) => !s.off)
  // 칩 본문 — 모노 필에 들어가는 최소 정보. 실패가 있으면 `n/전체`로 분모를 드러낸다
  // (실패는 숫자 하나로 가려지면 안 되는 사실이다).
  const count = bad > 0 ? `${live}/${tl.mcp.length - offN}` : `${live}`
  const tip = [
    tl.mcp.length === 0
      ? t('MCP 서버 없음', 'No MCP servers')
      : t(`MCP ${live}개 연결${bad ? ` · ${bad}개 실패` : ''}${offN ? ` · ${offN}개 꺼짐` : ''}`,
          `${live} MCP connected${bad ? ` · ${bad} failed` : ''}${offN ? ` · ${offN} off` : ''}`),
    t(`스킬 ${skillsOn.length}개`, `${skillsOn.length} skills`),
    t('클릭해 자세히', 'Click for details')
  ].join(' · ')

  return (
    <span className="hfold" onMouseDown={(e) => e.stopPropagation()}>
      <button
        className={'ma-p-folder' + (open ? ' on' : ' has-tip tip-wrap')}
        data-tip={tip}
        aria-label={tip}
        onClick={() => setOpen((o) => !o)}
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
            <span className="c">{baseOf(tl.cwd)}</span>
          </div>

          <div className="hsec">
            {t('MCP 서버', 'MCP servers')}
            {tl.mcp.length > 0 ? ` ${tl.mcp.length}` : ''}
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
            {t('스킬', 'Skills')} {tl.skills.length}
          </div>
          {tl.skills.length ? (
            <div className="wb-pop-list">
              {tl.skills.map((s) => (
                <SkillRow key={s.name} s={s} />
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
