/* ============================================================
 * McpSkillView — **이 패널(=채팅)이 실제로 들고 있는 도구 환경**을 헤더 칩 하나로.
 *
 * 왜 패널마다 다른가: MCP 서버는 `<폴더>/.mcp.json`, 스킬은 `<폴더>/.claude/skills`에서
 * 온다. 멀티 그리드는 패널마다 작업 폴더가 다르므로 **패널마다 목록이 다르다.**
 *
 * 값의 출처는 둘이다(★R3 — 2026-09-01 사용자 결정 「무조건 폴더 → MCP & Skill」):
 *  1) **와이어**(`EngineEvent{type:'tooling'}`) — 셸이 `system/init`의 `mcp_servers`·
 *     `skills`·`plugins`·`tools`를 커맨드 사전과 조인해 REPLACE로 보낸다. 연결 상태·
 *     내장 스킬·플러그인은 이쪽만 안다.
 *  2) **디스크 스캔**(`mcp:list`·`skill:list` — 설정 화면이 쓰던 그 채널) — 첫 턴 전
 *     폴백. R2까지는 첫 `system/init` 전에 칩이 아예 안 섰고("채팅을 쳐야만 나온다"),
 *     설정 ▸ MCP/Skill 탭이 그 빈자리를 메웠다. 그 탭을 걷어내면서 칩이 **항상** 서야
 *     했다 — 실행 전에는 "지금 붙어 있는 것"이 없으므로 설정 파일이 곧 진실이다.
 *     와이어 스냅샷이 닿는 순간 그쪽이 이긴다(연결 상태까지 아는 값이라서).
 *
 * ★R3 — **켜고 끄기도 여기서 한다**(설정 탭 제거의 나머지 반쪽). 토글은 설정 화면과
 * 같은 채널(`mcp:set-enabled`·`skill:set-enabled` — 앱 홈의 끔 목록, 사용자의
 * `~/.claude.json`은 불가침)을 부르고, 낙관값은 `ov`에 담아 파생값과 갈라 그린다 —
 * 살아 있는 세션의 'connected' 행을 꺼도 이번 턴은 그대로이므로(다음 스폰부터 적용)
 * 행 상태를 거짓말로 바꾸지 않고 「다음 실행부터 적용」 한 줄을 잇는다.
 * 내장(스코프 없음)·플러그인 스킬은 토글이 없다 — 2.6.2부터 끔 목록이 디스크 스킬만
 * 다뤘고, 엔진 쪽 동작이 실측된 적이 없는 이름에 스위치를 세우지 않는다.
 *
 * ★R2 — 와이어 푸시는 **스폰당 한 장**이다. 껍데기가 갈리는 순간(「크게 보기」·팝아웃·
 * 그리드 복귀) 스냅샷이 증발하므로 마운트마다 한 번 묻는다(`multi.toolingGet`).
 * 재시작 뒤에 안 되살아나는 원칙은 그대로다 — 스냅샷은 여전히 셸 **메모리**에만 있다.
 *
 * 문법은 전부 기존 것이다 — 행 토글의 축소 규칙(.wb-prow .sw2) 말고는 새 CSS가 없다:
 *   칩   = `.ma-p-folder` (패널 헤더 모노 필, 작업 폴더 칩과 같은 면)
 *   래퍼 = `.hfold`      (팝오버 기준점 + 안쪽 클릭의 바깥닫힘 차단)
 *   카드 = `.wb-pop.hpop.r` (아래로 열리는 WorkBar 유리 팝오버)
 *   섹션 = `.hsec` · 행 = `.wb-prow`(+`.done`/`.err`) · 토글 = `.sw2` · 빈 상태 = `.ag-none`
 * ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { ChatTooling, EngineEventV3, McpLive, McpServerInfo, SkillInfo, SkillLive } from '@shared/protocol'
import { getChatTooling, onChatEvent } from '../api/unified'
import { IconAlert, IconBook, IconChevDown, IconEyeOff, IconPlug, IconServer } from './icons'
import { t, useLang } from '../lib/i18n'
import { getPref, setPref } from '../lib/prefs'

/** 경로 비교용 정규화 — 대소문자·구분자·후행 슬래시를 접는다(m-logic §2.3의 축소판). */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * CLI가 보고하는 연결 상태 → 사람 말. 모르는 값은 **그대로 보여준다**(지어내지 않는다).
 *
 * ★R4(2026-09-01 사용자 지적) — **조용한 상태는 여기 안 온다.** `connected`는 초록
 * 체크가, `off`는 스위치+흐림이, `configured`(디스크 폴백)는 무표기가 이미 말한다 —
 * 문구는 사용자가 손대야 하는 상태에만 쓴다(행 렌더의 `quiet` 게이트가 거른다).
 */
function statusLabel(s: string): string {
  if (s === 'failed') return t('연결 실패', 'Connection failed')
  if (s === 'needs-auth') return t('인증 필요', 'Needs auth')
  if (s === 'pending') return t('연결 중', 'Connecting')
  if (s === 'disabled') return t('CLI가 껐음', 'Disabled by the CLI')
  return s
}

/** 행 색조 — 문제 있는 행만 색을 입는다(`.err` 빨간 아이콘). 연결됨은 무색이다 —
 *  초록 플러그가 스킬의 책 아이콘과 색이 갈려 혼자 튀었다(★R4 사용자 지적: 스킬
 *  아이콘과 같은 무채로). 켜짐/꺼짐은 스위치가, 문제는 빨강이 말한다. */
function mcpTone(s: string): string {
  if (s === 'failed' || s === 'needs-auth') return ' err'
  return ''
}
function mcpIcon(s: string): React.ReactNode {
  // ★R4 — 연결됨은 체크가 아니라 **플러그**다(사용자 지적: 체크는 MCP에 안 어울린다).
  if (s === 'connected' || s === 'configured') return <IconPlug size={12} />
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

/**
 * 호버 툴팁용 본문 — ★R4: 네이티브 `title`(OS 서식이라 튄다 — 유저 결정) 대신 앱 공통
 * 커스텀 툴팁(`has-tip`/`data-tip`)을 쓴다. 다만 이 카드는 스크롤 컨테이너(`.wb-pop`
 * overflow)라 카드 밖으로 나간 툴팁은 **잘린다** — 내장 스킬 설명(941자)을 통째로 실으면
 * 첫 화면 반쯤이 뭉텅 날아간 채 보이므로, 행(110자)보다 넉넉한 선에서 자른다.
 */
function tipText(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 280 ? flat.slice(0, 280).trimEnd() + '…' : flat
}

/** 스킬 스코프 배지 — 표식이 없으면(내장·설명 없음) **아무것도 안 적는다**. */
function scopeLabel(s: SkillLive['scope']): string {
  if (s === 'project') return t('프로젝트', 'Project')
  if (s === 'user') return t('개인', 'Personal')
  if (s === 'local') return t('로컬', 'Local')
  if (s === 'plugin') return t('플러그인', 'Plugin')
  return ''
}

/** 행 토글 — 설정 화면의 `.sw2` 그대로(팝오버 안에서는 CSS가 축소판으로 그린다). */
function Toggle({ on, name, onFlip }: { on: boolean; name: string; onFlip: () => void }) {
  return (
    <button
      className={'sw2' + (on ? ' on' : '')}
      role="switch"
      aria-checked={on}
      aria-label={t(name + (on ? ' 끄기' : ' 켜기'), (on ? 'Turn off ' : 'Turn on ') + name)}
      onClick={(e) => {
        e.stopPropagation()
        onFlip()
      }}
    />
  )
}

/** 표시용 MCP 행 — 와이어(McpLive) 또는 디스크 스캔에서 온다. `detail`은 디스크 전용
 *  (전송 방식 + 커맨드/URL — 실행 전에는 도구 목록이 없어 이 줄이 그 자리를 채운다). */
interface McpRowData extends McpLive {
  detail?: string
  /** 로컬/전역 알약의 판정 재료 — 디스크 스캔의 scope(이름으로 조인). 못 찾으면 전역. */
  scope?: 'local' | 'global'
}

/**
 * ★3.0.6(2026-09-04 사용자 요청) — 팝오버 머리의 **「로컬」·「전역」 알약**(계정 picker의
 * `.pp-filt`와 같은 문법). 켜진 범위만 보인다: 로컬만 켜면 로컬, 전역만 켜면 전역, 둘 다 켜면
 * 전부. 마지막 하나는 못 끈다(빈 알약 둘 = 빈 목록은 답이 없다). 프리프 `tooling.showLocal`·
 * `tooling.showGlobal`(기본 둘 다 켬)에 절인다 — 접힘과 달리 알약이 상태를 늘 보여 주므로
 * "왜 안 보이지"가 생기지 않는다.
 *
 * 판정: **로컬 = 이 폴더의 것** — 프로젝트·로컬 스코프 스킬(`.claude/skills`), 프로젝트·
 * 비공개 MCP 서버(`.mcp.json` 등 디스크 스캔 scope `local`). **전역 = 나머지** — 개인
 * 스킬(`~/.claude/skills`)·플러그인 스킬·내장 스킬(스코프 표식 없음), `~/.claude.json` 서버,
 * 디스크 스캔에 없는 와이어 전용 서버(플러그인이 붙인 것).
 */
type ScopeFilter = { local: boolean; global: boolean }
function skillIsLocal(s: SkillLive): boolean {
  return s.scope === 'project' || s.scope === 'local'
}

function McpRow({
  m,
  note,
  toggle
}: {
  m: McpRowData
  note?: string
  toggle?: { on: boolean; onFlip: () => void }
}) {
  const n = m.tools.length
  // ★R4(2026-09-01 사용자 지적) — 행의 주인공은 이름이다. 「연결됨」은 초록 체크가,
  // 도구 수는 오른쪽 「도구 N」 배지가 이미 말하므로 그 사이 문구는 소음이었다.
  // 상태 문구는 **손대야 하는 상태**(실패·인증·연결 중·CLI가 껐음·미지)에만 남기고,
  // 도구 이름 나열(app_feedback, log_work …)은 호버 툴팁으로 옮긴다.
  const quiet = m.status === 'connected' || m.status === 'configured' || m.status === 'off'
  const subText = [quiet ? '' : statusLabel(m.status), note ?? ''].filter(Boolean).join(' · ')
  const hover = n > 0 ? m.tools.join(', ') : m.detail || undefined
  return (
    <div className={'wb-prow' + mcpTone(m.status)}>
      <span className="ic">{mcpIcon(m.status)}</span>
      <span className={'grow' + (hover ? ' has-tip tip-wrap' : '')} data-tip={hover ? tipText(hover) : undefined}>
        {m.name}
        {subText && <span className="sub">{subText}</span>}
      </span>
      {n > 0 && <span className="end">{t(`도구 ${n}`, `${n} tools`)}</span>}
      {toggle && <Toggle on={toggle.on} name={m.name} onFlip={toggle.onFlip} />}
    </div>
  )
}

function SkillRow({
  s,
  note,
  toggle
}: {
  s: SkillLive
  note?: string
  toggle?: { on: boolean; onFlip: () => void }
}) {
  const badge = scopeLabel(s.scope)
  return (
    <div className={'wb-prow' + (s.off ? ' done' : '')}>
      <span className="ic">{s.off ? <IconEyeOff size={12} /> : <IconBook size={12} />}</span>
      <span
        className={'grow' + (s.description ? ' has-tip tip-wrap' : '')}
        data-tip={s.description ? tipText(s.description) : undefined}
      >
        /{s.name}
        {/* 설명은 한 줄로 자른다 — 내장 스킬 설명은 수백 자짜리가 있다(dataviz 실측 941자).
            ★R4 — 꺼진 행에도 「꺼짐」 대신 설명을 그대로 둔다: 흐림+스위치가 이미 상태를
            말하고, 되켤지 판단하려면 무엇을 하는 스킬인지가 더 필요하다.
            전체 설명은 앱 공통 툴팁으로(네이티브 title 금지 — 유저 결정). */}
        <span className="sub">
          {s.description ? oneLine(s.description) : t('설명 없음', 'No description')}
          {note ? ` · ${note}` : ''}
        </span>
      </span>
      {badge && <span className="end">{badge}</span>}
      {toggle && <Toggle on={toggle.on} name={'/' + s.name} onFlip={toggle.onFlip} />}
    </div>
  )
}

/**
 * 헤더의 도구 환경 칩. 주소는 표면에 따라 둘 중 하나다 — 이 컴포넌트가 **스스로**
 * 구독한다(세션 상태를 거치지 않는다: 도구 환경은 대화 내용이 아니라 실행 환경이고,
 * 스냅샷에 절이면 재시작 뒤 낡은 목록이 되살아난다):
 *   `panelId` = 멀티 보드 자리 키(`ma:event` 봉투 주소)
 *   `chatId`  = 본채팅(★R3 — 설정 탭 제거로 이 표면에도 칩이 서야 했다;
 *               `chat:event` 브로드캐스트에서 자기 것만 거른다)
 *
 * `onOpen`은 **팝오버 배타**의 절반이다 — 호스트가 자기 폴더 팝오버를 접는다(아래 참조).
 */
export function McpSkillView({
  panelId,
  chatId,
  cwd,
  onOpen
}: {
  panelId?: string
  chatId?: string
  cwd: string
  onOpen?: () => void
}) {
  useLang()
  const [snap, setSnap] = useState<ChatTooling | null>(null)
  // ★R3 — 디스크 폴백(첫 턴 전의 진실). 와이어 스냅샷이 닿기 전에도 칩이 서야 한다.
  const [disk, setDisk] = useState<{ cwd: string; mcp: McpServerInfo[]; skills: SkillInfo[] } | null>(null)
  // ★R3 — 토글 낙관값. `m:이름`/`s:이름` → 켬. 파생값(스냅샷·디스크)과 갈라 두는 이유:
  // 살아 있는 'connected' 행을 꺼도 이번 턴은 그대로라, 행 상태를 덮어쓰면 거짓말이 된다.
  const [ov, setOv] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState(false)
  // ★R4 — 섹션 접기(사용자 요청: 내장 스킬 16개가 목록을 길게 만든다). 팝오버가 닫히면
  // 리셋되는 가벼운 상태 — 접힘을 절이면 "왜 안 보이지"가 다음 세션의 미스터리가 된다.
  const [fold, setFold] = useState<{ mcp: boolean; skills: boolean }>({ mcp: false, skills: false })
  const [scopeF, setScopeF] = useState<ScopeFilter>(() => ({
    local: getPref<boolean>('tooling.showLocal', true),
    global: getPref<boolean>('tooling.showGlobal', true)
  }))
  const flipScope = (k: keyof ScopeFilter): void => {
    const next = { ...scopeF, [k]: !scopeF[k] }
    if (!next.local && !next.global) return // 마지막 하나는 못 끈다(ScopeFilter 주석)
    setScopeF(next)
    setPref(k === 'local' ? 'tooling.showLocal' : 'tooling.showGlobal', next[k])
  }
  const wrapRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    let alive = true
    setSnap(null) // 자리(주소)가 바뀌면 남의 목록이다
    // ★R2 ① **지금 값을 셸에 묻는다.** 이 한 줄이 와이어 스냅샷의 수명이다 — 푸시는 스폰당
    // 한 장뿐이라 재마운트(「크게 보기」·팝아웃 첫 진입·그리드 복귀)에는 아무것도 안 온다.
    // 답이 `null`이면 아직 모르는 것이므로(런타임 없음 · `system/init` 전 · 앱 재시작 직후)
    // 그대로 둔다 — 그동안은 디스크 폴백이 그린다.
    // 물어보는 사이에 푸시가 먼저 닿았으면 그쪽이 최신이다(왕복은 수 ms지만 0은 아니다) —
    // 그래서 두 주소 모두 `cur ?? tl`로 받는다.
    let off: () => void = () => {}
    if (panelId) {
      void window.api.multi
        ?.toolingGet?.(panelId)
        .then((tl) => {
          if (alive && tl) setSnap((cur) => cur ?? tl)
        })
        .catch(() => {})
      // ② 이후는 푸시가 잇는다(턴마다 · 정책 변경 · 세션 중간 커맨드 갱신).
      off =
        window.api.multi?.onEvent?.(panelId, (e: EngineEventV3) => {
          if (e.type === 'tooling') setSnap(e.tooling)
        }) ?? (() => {})
    } else if (chatId) {
      // ★R3 본채팅 — 같은 두 박자를 chatId 주소로. `chat:event`는 브로드캐스트라
      // 자기 것만 거른다(봉투의 타입은 동결 계약면(EngineEvent)이라 V3로 좁혀 읽는다).
      void getChatTooling(chatId).then((tl) => {
        if (alive && tl) setSnap((cur) => cur ?? tl)
      })
      off = onChatEvent((cid, ev) => {
        const e = ev as EngineEventV3
        if (cid === chatId && e.type === 'tooling') setSnap(e.tooling)
      })
    }
    return () => {
      alive = false
      off()
    }
  }, [panelId, chatId])

  // ★R3 — 디스크 스캔(설정 ▸ MCP/Skill 탭이 쓰던 `mcp:list`·`skill:list` 그대로).
  // 폴더가 바뀌면 다시 훑고, 지난 폴더에서 만진 낙관값도 접는다 — 파생값의 출처가
  // 통째로 바뀌므로 그 위에 얹은 낙관값은 근거를 잃는다(다음 스캔이 진실을 다시 준다).
  useEffect(() => {
    let alive = true
    setDisk(null)
    setOv({})
    const dir = cwd || ''
    Promise.all([
      window.api.mcp?.list?.(dir) ?? Promise.resolve([]),
      window.api.skill?.list?.(dir) ?? Promise.resolve([])
    ])
      .then(([mcp, skills]) => {
        if (alive) setDisk({ cwd: dir, mcp, skills })
      })
      .catch(() => {
        if (alive) setDisk({ cwd: dir, mcp: [], skills: [] })
      })
    return () => {
      alive = false
    }
  }, [cwd])

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
  const live = stale ? null : snap
  // 디스크 폴백도 같은 게이트 — 스캔이 도는 사이 폴더가 바뀌면 남의 폴더 것이다.
  const diskOk = !!disk && norm(disk.cwd) === norm(cwd || '')

  const mOn = (name: string, derived: boolean): boolean => ov['m:' + name] ?? derived
  const sOn = (name: string, derived: boolean): boolean => ov['s:' + name] ?? derived
  const flip = (kind: 'm' | 's', name: string, cur: boolean): void => {
    const next = !cur
    setOv((o) => ({ ...o, [`${kind}:${name}`]: next }))
    const req =
      kind === 'm' ? window.api.mcp?.setEnabled?.(name, next) : window.api.skill?.setEnabled?.(name, next)
    // 실패하면 낙관값만 걷는다 — 파생값이 도로 보이는 게 곧 되돌림이다.
    void req?.catch?.(() =>
      setOv((o) => {
        const c = { ...o }
        delete c[`${kind}:${name}`]
        return c
      })
    )
  }

  // 행 재료 — 와이어가 있으면 그것(연결 상태·도구·내장 스킬까지), 없으면 디스크 스캔
  // (등록 여부만 안다). 디스크 행은 실행 전이라 "지금 붙어 있는 것"이 없으므로
  // 낙관값을 상태에 바로 입힌다 — 표시가 곧 설정이다.
  // 와이어 행에는 scope가 없다 — 같은 폴더의 디스크 스캔에서 이름으로 빌린다(로컬/전역 알약).
  const diskMcpScope = new Map((diskOk ? disk!.mcp : []).map((d) => [d.name, d.scope] as const))
  const mcpRows: McpRowData[] = live
    ? live.mcp.map((m) => ({ ...m, scope: diskMcpScope.get(m.name) ?? 'global' }))
    : (diskOk ? disk!.mcp : []).map((d) => ({
        name: d.name,
        status: mOn(d.name, d.enabled) ? 'configured' : 'off',
        tools: [],
        detail: (d.transport !== 'unknown' ? d.transport + ' · ' : '') + d.detail,
        scope: d.scope
      }))
  const skillRows: SkillLive[] = live
    ? live.skills
    : (diskOk ? disk!.skills : []).map((d) => ({
        name: d.name,
        description: d.description,
        // 디스크 스코프(global/local/plugin) → 와이어 스코프 낱말(개인/프로젝트/플러그인)로 접는다
        scope: d.scope === 'global' ? 'user' : d.scope === 'plugin' ? 'plugin' : 'project',
        off: !sOn(d.name, d.enabled)
      }))
  const plugins = live?.plugins ?? []
  // 로컬/전역 알약 — 칩 툴팁은 전체를 세고(붙어 있는 것의 사실), 섹션 머리·목록은 켜진 범위만.
  const inScope = (local: boolean): boolean => (local ? scopeF.local : scopeF.global)
  const mcpShown = mcpRows.filter((m) => inScope(m.scope === 'local'))
  const skillShown = skillRows.filter((s) => inScope(skillIsLocal(s)))
  const mcpShownOff = mcpShown.filter((m) => m.status === 'off').length
  const mcpShownTotal = mcpShown.length - mcpShownOff
  const skillShownOn = skillShown.filter((s) => !s.off).length
  const skillShownOff = skillShown.length - skillShownOn

  // ★R2 — **상태를 전부 센다.** R1은 `connected`/`failed`/`off` 셋만 읽어서, 서버 10대
  // (연결7·실패1·인증필요1·연결중1)를 「MCP 7개 연결 · 2개 실패」로 적었다 — 합이 9다
  // (크리틱 A1). 사라진 한 대는 `pending`이었고, `needs-auth`는 「실패」로 합산됐다.
  // 사용자가 할 일이 다르다: 하나는 로그인, 하나는 설정 고치기, 하나는 그냥 기다리기.
  // status는 열린 집합이라 **나머지 전부**를 `unknown`으로 모아 분모를 정확히 유지한다.
  const n = (p: (s: string) => boolean): number => mcpRows.filter((m) => p(m.status)).length
  const liveN = n((s) => s === 'connected')
  const failed = n((s) => s === 'failed')
  const auth = n((s) => s === 'needs-auth')
  const pending = n((s) => s === 'pending')
  const cliOff = n((s) => s === 'disabled')
  const offN = n((s) => s === 'off') // 셸/낙관값이 되붙인 행(여기서 끔)
  // 분모 = 끈 것을 뺀 전부. 나머지는 `unknown`으로 떨어져 합이 맞는다(디스크 행은 전부
  // `configured`라 unknown 0).
  const total = mcpRows.length - offN
  const unknown = total - liveN - failed - auth - pending - cliOff - n((s) => s === 'configured')
  // 색으로 먼저 읽혀야 하는 것 = 사용자가 손대야 붙는 것(실패·인증 필요).
  const bad = failed + auth
  const skillsOn = skillRows.filter((s) => !s.off)
  const skillsOff = skillRows.length - skillsOn.length
  // 칩은 수를 안 센다(★R3 — 「0 · 16」이 불편하다는 사용자 지적) — 글자 「MCP & Skill」로
  // 서고, 수·상태는 툴팁과 팝오버가 말한다. 실패만 빨간 수로 칩에 남는다(열기 전에
  // 알아야 하는 유일한 값).
  const tip = [
    mcpRows.length === 0
      ? // 「서버 없음」이 아니라 「0개」 — 뒤따르는 「스킬 N개」와 같은 문형(사용자 지적)
        t('MCP 0개', '0 MCP')
      : live
        ? t(
            `MCP ${liveN}개 연결${failed ? ` · ${failed}개 실패` : ''}${auth ? ` · ${auth}개 인증 필요` : ''}` +
              `${pending ? ` · ${pending}개 연결 중` : ''}${cliOff ? ` · ${cliOff}개 CLI가 껐음` : ''}` +
              `${unknown > 0 ? ` · ${unknown}개 상태 미상` : ''}${offN ? ` · ${offN}개 꺼짐` : ''}`,
            `${liveN} MCP connected${failed ? ` · ${failed} failed` : ''}${auth ? ` · ${auth} need auth` : ''}` +
              `${pending ? ` · ${pending} connecting` : ''}${cliOff ? ` · ${cliOff} disabled by the CLI` : ''}` +
              `${unknown > 0 ? ` · ${unknown} unknown` : ''}${offN ? ` · ${offN} off` : ''}`
          )
        : t(
            `MCP ${total}개 등록${offN ? ` · ${offN}개 꺼짐` : ''}`,
            `${total} MCP configured${offN ? ` · ${offN} off` : ''}`
          ),
    // 「끈 SKILL」이라고 적는다 — 앞의 MCP 문장에도 「N개 꺼짐」이 올 수 있어서, 같은
    // 낱말을 `·`로 잇기만 하면 그 수가 서버 것인지 스킬 것인지 안 갈린다.
    // 표기는 섹션 머리와 같은 대문자 「SKILL」(2026-09-01 사용자 결정).
    t(`SKILL ${skillsOn.length}개${skillsOff ? ` · 끈 SKILL ${skillsOff}개` : ''}`,
      `${skillsOn.length} SKILL${skillsOff ? ` · ${skillsOff} SKILL off` : ''}`),
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
        <span className="ma-p-folder-name">MCP & SKILL</span>
        {/* 실패는 색으로 먼저 읽혀야 한다 — 팝오버를 열기 전에 알아야 하는 유일한 값
            (AgentPanel의 오류 표기와 같은 인라인 토큰 사용) */}
        {bad > 0 && <span style={{ color: 'var(--red)', fontWeight: 600 }}>{bad}</span>}
        <IconChevDown size={10} />
      </button>
      {open && (
        <div className="wb-pop hpop r">
          <div className="wb-pop-h">
            <span className="t">{t('도구 환경', 'Tool environment')}</span>
            {/* 로컬/전역 알약(ScopeFilter 주석) — 계정 picker 헤더의 .pp-filt 문법 그대로 */}
            <span className="pp-filts">
              <button
                className={'pp-filt' + (scopeF.local ? ' on' : '')}
                aria-pressed={scopeF.local}
                onClick={() => flipScope('local')}
              >
                {t('로컬', 'Local')}
              </button>
              <button
                className={'pp-filt' + (scopeF.global ? ' on' : '')}
                aria-pressed={scopeF.global}
                onClick={() => flipScope('global')}
              >
                {t('전역', 'Global')}
              </button>
            </span>
            {/* 오른쪽 끝의 폴더 이름은 뺐다(2026-09-04 사용자 결정 — 옆 폴더 칩이 이미 말한다).
                ★R2의 "패널 meta의 cwd에서 딴다" 규칙은 툴팁·판정(norm(cwd))에 그대로 남아 있다. */}
          </div>

          {/* ★R2 — 섹션 머리는 **칩과 같은 수**를 센다. 끈 것은 따로 적는다.
              ★R4 — 「MCP 서버」→「MCP」(사용자 지적: 뻔한 낱말은 뺀다) · 머리 클릭=접기. */}
          <button
            className={'hsec hsec-btn' + (fold.mcp ? ' folded' : '')}
            aria-expanded={!fold.mcp}
            onClick={() => setFold((f) => ({ ...f, mcp: !f.mcp }))}
          >
            {/* 수는 0이어도 적는다(2026-09-01 사용자 결정 번복 — 두 머리가 같은 문형이어야) */}
            {`MCP ${mcpShownTotal}`}
            {mcpShownOff > 0 ? t(` · 꺼짐 ${mcpShownOff}`, ` · ${mcpShownOff} off`) : ''}
            <IconChevDown size={10} />
          </button>
          {fold.mcp ? null : mcpShown.length ? (
            <div className="wb-pop-list">
              {mcpShown.map((m) => {
                const derived = m.status !== 'off'
                const on = live ? mOn(m.name, derived) : derived
                // 살아 있는 행의 토글은 이번 턴을 못 바꾼다 — 상태와 스위치가 어긋난
                // 동안만 그 사실을 한 줄로 잇는다(디스크 행은 표시가 곧 설정이라 불필요).
                const note =
                  live && on !== derived ? t('다음 실행부터 적용', 'Applies from the next run') : undefined
                return (
                  <McpRow key={m.name} m={m} note={note} toggle={{ on, onFlip: () => flip('m', m.name, on) }} />
                )
              })}
            </div>
          ) : (
            <div className="ag-none">
              {mcpRows.length
                ? t('이 범위에 해당하는 MCP 서버가 없어요', 'No MCP servers in this scope')
                : t('이 폴더에 붙은 MCP 서버가 없어요', 'No MCP servers attached to this folder')}
            </div>
          )}

          <button
            className={'hsec hsec-btn' + (fold.skills ? ' folded' : '')}
            aria-expanded={!fold.skills}
            onClick={() => setFold((f) => ({ ...f, skills: !f.skills }))}
          >
            {/* 라벨은 「SKILL」 — 옆 머리 MCP가 전부 대문자라 짝을 맞춘다 · 수는 0이어도 적는다 */}
            {`SKILL ${skillShownOn}`}
            {skillShownOff > 0 ? t(` · 꺼짐 ${skillShownOff}`, ` · ${skillShownOff} off`) : ''}
            <IconChevDown size={10} />
          </button>
          {fold.skills ? null : skillShown.length ? (
            <div className="wb-pop-list">
              {/* 키에 자리를 섞는다 — 같은 이름이 두 번 오는 판이 있다(플러그인/프로젝트
                  중복). 이름만 키로 쓰면 React가 같은 행으로 접어 하나가 사라진다. */}
              {skillShown.map((s, i) => {
                // 토글은 **끔 목록이 다루는 이름에만** 세운다 — 디스크 스킬(개인·프로젝트·
                // 로컬)과 이미 꺼 둔 행. 내장(스코프 없음)·플러그인 스킬은 스위치가 없다
                // (★3.0.6 — 디스크 스캔도 플러그인 스킬을 내므로 그쪽도 같은 규칙: CLI가
                // `skillOverrides`를 플러그인 스킬에 적용하지 않는다).
                const canToggle = live
                  ? s.off === true || s.scope === 'user' || s.scope === 'project' || s.scope === 'local'
                  : s.scope !== 'plugin'
                const derived = !s.off
                const on = canToggle && live ? sOn(s.name, derived) : derived
                const note =
                  live && canToggle && on !== derived
                    ? t('다음 실행부터 적용', 'Applies from the next run')
                    : undefined
                return (
                  <SkillRow
                    key={`${s.name}#${i}`}
                    s={s}
                    note={note}
                    toggle={canToggle ? { on, onFlip: () => flip('s', s.name, on) } : undefined}
                  />
                )
              })}
            </div>
          ) : (
            <div className="ag-none">
              {skillRows.length
                ? t('이 범위에 해당하는 스킬이 없어요', 'No skills in this scope')
                : live
                  ? t('쓸 수 있는 스킬이 없어요', 'No skills available')
                  : t('이 폴더에서 찾은 스킬이 없어요', 'No skills found for this folder')}
            </div>
          )}

          {plugins.length > 0 && scopeF.global && (
            <>
              <div className="hsec">
                {t('플러그인', 'Plugins')} {plugins.length}
              </div>
              <div className="wb-pop-list">
                {plugins.map((p) => (
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

          {/* 출처 각주는 R4에서 제거(2026-09-01 사용자 지적) — 상시 문단은 소음이고,
              토글의 「다음 실행부터 적용」은 어긋난 행에만 인라인으로 붙는다. */}
        </div>
      )}
    </span>
  )
}
