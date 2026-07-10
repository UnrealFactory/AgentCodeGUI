import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type {
  EngineVersionEntry,
  EngineVersionState,
  SkillInfo,
  SkillScope,
  McpServerInfo,
  LspServerInfo,
  ApiConfigStatus,
  ApiUsageRecord,
  AccountInfo,
  AccountUsage
} from '@shared/protocol'
import { FileBadge } from './fileType'
import { getPref, setPref } from '../lib/prefs'
import {
  IconClose,
  IconServer,
  IconBook,
  IconRefresh,
  IconClaude,
  IconChevDown,
  IconChevRight,
  IconAlert,
  IconCheck,
  IconTrash,
  IconContrast,
  IconSun,
  IconMoon,
  IconCode,
  IconKey,
  IconDollar,
  IconUser,
  IconPlus,
  IconFilter,
  IconFolder,
  IconX2,
  IconSearch,
  type IconProps
} from './icons'
import { getTheme, setTheme, type Theme } from '../lib/theme'
import { DEFAULT_HIDE_DIRS, getHideDirs, getHideEnabled, setHideDirs, setHideEnabled } from '../lib/hideDirs'

export type SettingsView = 'account' | 'version' | 'api' | 'mcp' | 'skill' | 'lsp' | 'explorer' | 'appearance'
type View = SettingsView

const NAV: { id: View; label: string; Icon: (p: IconProps) => React.ReactElement }[] = [
  { id: 'account', label: 'Account', Icon: IconUser },
  { id: 'version', label: 'Claude Code', Icon: IconClaude },
  { id: 'api', label: 'API', Icon: IconKey },
  { id: 'mcp', label: 'MCP', Icon: IconServer },
  { id: 'skill', label: 'Skill', Icon: IconBook },
  { id: 'lsp', label: 'Code', Icon: IconCode },
  { id: 'explorer', label: 'Explorer', Icon: IconFilter },
  { id: 'appearance', label: 'Theme', Icon: IconContrast }
]

// numeric semver-ish compare: <0 if a is older than b
function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

// ── Account (클로드 구독 로그인 · 다중 계정 전환) ───────────────
// 번들 CLI의 `claude auth …`로 로그인/로그아웃하고, 각 계정의 크리덴셜을 암호화 스냅샷해두어
// "변경"으로 재로그인 없이 전환한다(main/auth.ts). 로그인은 브라우저 OAuth → 완료 시 자동 갱신.
function AccountView(): React.ReactElement {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null)
  // 'login' | 'logout' | <email>(전환 중) | null
  const [busy, setBusy] = useState<string | null>(null)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // 계정별 한도 사용률(5시간·주간·Fable) — 목록과 별도로 나중에 도착해 채워진다(네트워크 조회)
  const [usage, setUsage] = useState<Record<string, AccountUsage>>({})

  const reload = (): void => {
    window.api.auth.listAccounts().then(setAccounts).catch(() => setAccounts([]))
    window.api.auth
      .accountsUsage()
      .then((us) => setUsage(Object.fromEntries(us.map((u) => [u.email, u]))))
      .catch(() => {})
  }
  useEffect(() => reload(), [])
  useEffect(() => window.api.auth.onLoginUrl(setLoginUrl), [])

  const addAccount = async (): Promise<void> => {
    setBusy('login')
    setLoginUrl(null)
    setNote(null)
    try {
      const res = await window.api.auth.login(false)
      if (!res.ok) setNote(res.error ?? '로그인이 완료되지 않았어요')
    } catch {
      /* ignore */
    }
    setBusy(null)
    setLoginUrl(null)
    reload()
  }
  const doLogout = async (): Promise<void> => {
    setBusy('logout')
    setNote(null)
    try {
      await window.api.auth.logout()
    } catch {
      /* ignore */
    }
    setBusy(null)
    reload()
  }
  const doSwitch = async (email: string): Promise<void> => {
    setBusy(email)
    setNote(null)
    try {
      const st = await window.api.auth.switchAccount(email)
      if (st.error) setNote(st.error)
    } catch {
      /* ignore */
    }
    setBusy(null)
    reload()
  }
  const doRemove = async (email: string): Promise<void> => {
    try {
      setAccounts(await window.api.auth.removeAccount(email))
    } catch {
      /* ignore */
    }
  }

  const planLabel = (t?: string): string =>
    t ? t.charAt(0).toUpperCase() + t.slice(1) + ' 플랜' : '구독'

  // 계정별 남은 한도 — 앱 전체 관례(잔여 % = 100 − 사용률)를 따른다. 조회 못 한 항목은
  // 조용히 빠진다(저장 토큰 만료 등 — 전환하면 CLI가 리프레시하므로 전환은 정상).
  const usageText = (u?: AccountUsage): string => {
    if (!u) return ''
    const parts: string[] = []
    if (u.fiveHourPct != null) parts.push(`5시간 ${100 - u.fiveHourPct}%`)
    if (u.weeklyPct != null) parts.push(`주간 ${100 - u.weeklyPct}%`)
    if (u.fablePct != null) parts.push(`Fable ${100 - u.fablePct}%`)
    return parts.length ? ` · 남음: ${parts.join(' · ')}` : ''
  }

  return (
    <>
      <div className="set-h1">Account</div>
      <div className="set-h1-sub">
        클로드(Claude) 구독 계정이에요. 여러 계정을 등록해두고 <strong>변경</strong>으로 언제든 전환할 수 있어요 — 엔진
        실행은 지금 활성화된 계정(<code>~/.claude</code>)을 씁니다.
      </div>

      <div className="sec">
        <div className="card">
          {accounts == null ? (
            <div className="acct-row">
              <div className="ver-main">
                <div className="ver-meta">
                  <span className="set-spin" /> 불러오는 중…
                </div>
              </div>
            </div>
          ) : accounts.length === 0 && busy !== 'login' ? (
            <div className="acct-row">
              <div className="ver-ic">
                <IconUser size={20} />
              </div>
              <div className="ver-main">
                <div className="ver-name">로그인된 계정이 없어요</div>
                <div className="ver-meta">구독 계정으로 로그인하면 API 키 없이 실행할 수 있어요</div>
              </div>
              <button className="inst-btn" disabled={busy != null} onClick={() => void addAccount()}>
                로그인
              </button>
            </div>
          ) : (
            accounts.map((a) => (
              <div className="acct-row" key={a.email}>
                <div className="ver-ic">
                  <IconUser size={18} />
                </div>
                <div className="ver-main">
                  <div className="ver-name">
                    {a.email} {a.active && <span className="acct-badge">현재</span>}
                  </div>
                  <div className="ver-meta">
                    {planLabel(a.subscriptionType)}
                    {usageText(usage[a.email])}
                  </div>
                </div>
                {a.active ? (
                  <button className="inst-btn ghost" disabled={busy != null} onClick={() => void doLogout()}>
                    {busy === 'logout' ? (
                      <>
                        <span className="set-spin" /> …
                      </>
                    ) : (
                      '로그아웃'
                    )}
                  </button>
                ) : (
                  <>
                    <button className="inst-btn" disabled={busy != null} onClick={() => void doSwitch(a.email)}>
                      {busy === a.email ? (
                        <>
                          <span className="set-spin" /> 전환 중…
                        </>
                      ) : (
                        '변경'
                      )}
                    </button>
                    <button className="acct-x" disabled={busy != null} aria-label="목록에서 제거" onClick={() => void doRemove(a.email)}>
                      <IconTrash size={13} />
                    </button>
                  </>
                )}
              </div>
            ))
          )}

          {busy === 'login' ? (
            <div className="acct-row">
              <div className="ver-ic">
                <span className="set-spin" />
              </div>
              <div className="ver-main">
                <div className="ver-name">로그인 진행 중…</div>
                <div className="ver-meta">브라우저에서 로그인을 완료하세요</div>
              </div>
              <button className="inst-btn ghost" onClick={() => window.api.auth.cancelLogin().catch(() => {})}>
                취소
              </button>
            </div>
          ) : accounts != null && accounts.length > 0 ? (
            <button className="acct-add" disabled={busy != null} onClick={() => void addAccount()}>
              <IconPlus size={15} /> 계정 추가
            </button>
          ) : null}
        </div>

        {note && <div className="set-note">{note}</div>}
        {busy === 'login' && loginUrl && (
          <div className="set-note">
            브라우저가 안 열렸나요?{' '}
            <a href={loginUrl} target="_blank" rel="noreferrer">
              이 링크로 로그인
            </a>
          </div>
        )}
        <div className="set-note">
          계정 크리덴셜은 <code>~/.agentcodegui</code>에 <b>암호화(DPAPI)</b>되어 저장되고, “변경”은 재로그인 없이
          <code>~/.claude</code>의 활성 크리덴셜만 바꿔요. 리프레시 토큰이 만료된 계정은 다시 로그인이 필요할 수 있어요.
        </div>
      </div>
    </>
  )
}

function VersionView() {
  const [state, setState] = useState<EngineVersionState | null>(null)
  const [available, setAvailable] = useState<EngineVersionEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // version currently installing
  const [dialog, setDialog] = useState<{
    title: string
    message: string
    tone?: 'danger' | 'warn' | 'ok' // ok = 결과 알림 (체크 아이콘, 확인만)
    confirm?: { label: string; action: () => void }
  } | null>(null)
  const [cleaning, setCleaning] = useState(false) // 이전 버전 정리 진행 중
  const [install, setInstall] = useState<{
    version: string
    log: string[]
    status: 'running' | 'done' | 'error'
    error?: string
  } | null>(null)
  const [open, setOpen] = useState(false)
  const pickRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const refreshState = (): void => {
    window.api.engine.state().then(setState).catch(() => {})
  }
  const refreshList = (): void => {
    setLoading(true)
    setListError(null)
    window.api.engine
      .listAvailable()
      .then((r) => setAvailable(r.versions))
      .catch((e: unknown) => setListError(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    refreshState()
    refreshList()
    return window.api.engine.onInstallProgress((p) => {
      if (p.line) setInstall((c) => (c ? { ...c, log: [...c.log, p.line as string] } : c))
    })
  }, [])

  // keep the log scrolled to the latest line
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [install?.log])

  // close the dropdown on a click outside the picker / Escape.
  // capture phase so the settings modal's stopPropagation doesn't swallow it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) setOpen(false)
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

  const apply = async (version: string, installed: boolean): Promise<void> => {
    if (installed) {
      // already installed → just switch (quick); surface failures as a small dialog
      try {
        await window.api.engine.setActive(version)
      } catch (e) {
        setDialog({ title: '전환 실패', message: String((e as Error)?.message ?? e) })
      }
      refreshState()
      return
    }
    setBusy(version)
    setInstall({ version, log: ['설치를 준비하는 중…'], status: 'running' })
    try {
      const r = await window.api.engine.install(version)
      if (r.ok) {
        await window.api.engine.setActive(version) // 설치하면 바로 그 버전을 사용
        setInstall((c) => (c ? { ...c, status: 'done' } : c))
      } else {
        setInstall((c) => (c ? { ...c, status: 'error', error: r.error ?? '알 수 없는 오류로 설치에 실패했습니다.' } : c))
      }
    } catch (e) {
      setInstall((c) => (c ? { ...c, status: 'error', error: String((e as Error)?.message ?? e) } : c))
    } finally {
      setBusy(null)
      refreshState()
    }
  }

  const doRemove = async (version: string): Promise<void> => {
    try {
      await window.api.engine.uninstall(version)
    } catch (e) {
      setDialog({ title: '삭제 실패', message: String((e as Error)?.message ?? e) })
      return
    }
    refreshState()
  }
  const askDelete = (version: string): void => {
    setOpen(false)
    setDialog({
      title: '버전 삭제',
      message: `${version} 버전을 삭제할까요? ~/.agentcodegui 에서 제거됩니다.`,
      confirm: { label: '삭제', action: () => void doRemove(version) }
    })
  }

  // "current" = the version installed & selected in ~/.agentcodegui (null until one is installed)
  const current = state?.active ?? null

  // 이전 버전 일괄 정리 — 최신 설치본(installed[0], 내림차순 정렬)만 남긴다
  const newest = state?.installed[0] ?? null
  const oldCount = Math.max(0, (state?.installed.length ?? 0) - 1)
  const doCleanup = async (): Promise<void> => {
    setCleaning(true)
    try {
      const r = await window.api.engine.cleanup()
      setDialog({
        title: '정리 완료',
        tone: 'ok',
        message:
          `이전 버전 ${r.removed.length}개를 삭제했습니다` +
          (r.freedBytes > 0 ? ` (${fmtBytes(r.freedBytes)} 확보)` : '') +
          '.' +
          (r.activeSwitched && r.kept ? ` 사용 버전이 ${r.kept}(으)로 전환되었습니다.` : '')
      })
    } catch (e) {
      setDialog({ title: '정리 실패', message: String((e as Error)?.message ?? e) })
    } finally {
      setCleaning(false)
      refreshState()
    }
  }
  const askCleanup = (): void => {
    if (!newest || oldCount === 0) return
    // 사용 중인 버전이 최신이 아니면 그것도 삭제 대상 — 전환된다는 걸 미리 알린다
    const activeIsOld = !!current && current !== newest
    setDialog({
      title: '이전 버전 정리',
      message:
        `최신 ${newest} 버전만 남기고 이전 버전 ${oldCount}개를 삭제할까요? ` +
        `~/.agentcodegui/engines 에서 제거됩니다.` +
        (activeIsOld ? ` 사용 중인 ${current}도 삭제 대상이라, 정리 후 ${newest}(으)로 전환됩니다.` : ''),
      confirm: { label: '삭제', action: () => void doCleanup() }
    })
  }

  const onPick = (v: EngineVersionEntry): void => {
    setOpen(false)
    if (v.version === current) return
    const installed = state?.installed.includes(v.version) ?? false
    // older than the version in use → ask before applying
    if (current && cmpVer(v.version, current) < 0) {
      const verb = installed ? '사용' : '설치' // already installed → just switch, not reinstall
      setDialog({
        title: '과거 버전 선택',
        message: `현재 사용 중인 ${current}보다 낮은 ${v.version} 버전입니다. 그래도 ${verb}할까요?`,
        tone: 'warn',
        confirm: { label: verb, action: () => void apply(v.version, installed) }
      })
      return
    }
    void apply(v.version, installed)
  }

  // registry list + any installed versions not on it (newest first)
  const rows: EngineVersionEntry[] = (() => {
    const base = (available ?? []).slice(0, 30)
    const seen = new Set(base.map((e) => e.version))
    const extra = (state?.installed ?? [])
      .filter((v) => !seen.has(v))
      .map((v) => ({ version: v, date: null, latest: false }))
    return [...extra, ...base]
  })()

  return (
    <>
      <div className="set-h1">Claude Code</div>
      <div className="set-h1-sub">Claude Code 엔진 버전을 선택하면 전용 폴더에 설치되고, 해당 버전으로 실행됩니다.</div>

      <div className="sec">
        <div className="card">
          <div className="ver-row">
            <div className="ver-ic">
              <IconClaude size={20} />
            </div>
            <div className="ver-main">
              <div className="ver-name">현재 엔진</div>
              <div className="ver-meta">{current ? '내 컴퓨터에 설치된 버전' : '아직 설치·고정된 버전이 없습니다'}</div>
            </div>

            <div className="vpick" ref={pickRef}>
              <button
                className={'vpick-btn' + (open ? ' open' : '')}
                onClick={() => setOpen((o) => !o)}
                disabled={!!busy}
              >
                <span className="vpick-cur">{busy ? '설치 중…' : current ?? '버전 선택'}</span>
                <IconChevDown className="vpick-chev" size={15} />
              </button>

              {open && (
                <div className="vpick-menu">
                  <div className="vpick-head">
                    <span>버전 선택</span>
                    <button className="vpick-refresh" onClick={refreshList} disabled={loading} aria-label="새로고침">
                      <IconRefresh size={13} />
                    </button>
                  </div>
                  <div className="vpick-list scroll">
                    {loading && rows.length === 0 ? (
                      <div className="vpick-msg">
                        <span className="set-spin" /> 불러오는 중…
                      </div>
                    ) : listError && rows.length === 0 ? (
                      <div className="vpick-msg err">목록을 불러오지 못했습니다</div>
                    ) : (
                      rows.map((v) => {
                        const installed = state?.installed.includes(v.version) ?? false
                        const isCur = v.version === current
                        return (
                          <button
                            key={v.version}
                            className={'vpick-opt' + (isCur ? ' on' : '')}
                            onClick={() => onPick(v)}
                          >
                            <span className="vpo-v">{v.version}</span>
                            {v.latest && <span className="vtag latest">최신</span>}
                            {isCur && <span className="vtag cur">현재</span>}
                            {installed && !isCur && <span className="vtag inst">설치됨</span>}
                            <span className="vpo-right">
                              <span className="vpo-act">{isCur ? '사용 중' : installed ? '사용' : '설치'}</span>
                              {installed && !isCur && (
                                <span
                                  className="vpo-del"
                                  role="button"
                                  tabIndex={-1}
                                  aria-label="삭제"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    askDelete(v.version)
                                  }}
                                >
                                  <IconTrash size={13} />
                                </span>
                              )}
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {oldCount > 0 && (
            <>
              <div className="ver-div" />
              <div className="ver-row">
                <div className="ver-ic">
                  <IconTrash size={18} />
                </div>
                <div className="ver-main">
                  <div className="ver-name">이전 버전 정리</div>
                  <div className="ver-meta">
                    최신 {newest}만 남기고 이전 버전 {oldCount}개를 삭제합니다
                  </div>
                </div>
                <button className="inst-btn ghost" disabled={cleaning || !!busy} onClick={askCleanup}>
                  {cleaning ? (
                    <>
                      <span className="set-spin" /> 정리 중…
                    </>
                  ) : (
                    '정리'
                  )}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="set-note">
          설치 위치: <code>~/.agentcodegui/engines/&lt;버전&gt;</code> · 시스템에 설치된 Claude는 건드리지 않습니다.
        </div>
      </div>

      {install && (
        <div
          className="set-dialog-overlay"
          onMouseDown={() => {
            if (install.status !== 'running') setInstall(null)
          }}
        >
          <div className="install-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ic-head">
              <span className={'ic-hic ' + install.status}>
                {install.status === 'running' ? (
                  <span className="set-spin" />
                ) : install.status === 'done' ? (
                  <IconCheck size={16} />
                ) : (
                  <IconAlert size={16} />
                )}
              </span>
              <span className="ic-title">
                {install.status === 'running' ? '버전 설치 중' : install.status === 'done' ? '설치 완료' : '설치 실패'}
              </span>
              <span className="ic-ver">{install.version}</span>
            </div>
            <div className="ic-log scroll" ref={logRef}>
              {install.log.map((l, i) => (
                <div className="ic-ln" key={i}>
                  {l}
                </div>
              ))}
              {install.status === 'error' && install.error && <div className="ic-ln err">{install.error}</div>}
            </div>
            <div className="ic-foot">
              <span className={'ic-status ' + install.status}>
                {install.status === 'running'
                  ? '설치하는 중…'
                  : install.status === 'done'
                    ? '설치가 완료되었습니다'
                    : '설치에 실패했습니다'}
              </span>
              {install.status === 'error' && (
                <button
                  className="sd-cancel"
                  onClick={() => {
                    const v = install.version
                    setInstall(null)
                    void apply(v, false)
                  }}
                >
                  다시 시도
                </button>
              )}
              <button className="sd-go" onClick={() => setInstall(null)} disabled={install.status === 'running'}>
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog && (
        <div className="set-dialog-overlay" onMouseDown={() => setDialog(null)}>
          <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className={'sd-ic' + (dialog.tone === 'warn' ? ' warn' : dialog.tone === 'ok' ? ' ok' : '')}>
              {dialog.tone === 'ok' ? <IconCheck size={22} /> : <IconAlert size={22} />}
            </div>
            <div className="sd-title">{dialog.title}</div>
            <div className="sd-msg">{dialog.message}</div>
            <div className="sd-btns">
              <button className="sd-cancel" onClick={() => setDialog(null)}>
                {dialog.confirm ? '취소' : '닫기'}
              </button>
              {dialog.confirm && (
                <button
                  className={'sd-go' + (dialog.tone === 'warn' ? '' : ' danger')}
                  onClick={() => {
                    const a = dialog.confirm!.action
                    setDialog(null)
                    a()
                  }}
                >
                  {dialog.confirm.label}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// USD 표시 — 소액(토큰 과금)은 셋째 자리까지, 그 외 둘째 자리까지
function fmtUsd(v: number): string {
  return '$' + (v > 0 && v < 1 ? v.toFixed(3) : v.toFixed(2))
}
// 정리로 확보한 디스크 용량 — 엔진 폴더는 수십 MB~GB 단위라 KB 아래는 뭉갠다
function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}
function fmtTokS(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'K'
  return String(n)
}
// 모델 표시명 → 앱 전역의 모델 정체성 색 (picker 점과 동일) — 통계 행의 identity 점
function modelDotColor(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('fable')) return 'var(--gold)'
  if (m.includes('opus')) return 'var(--violet)'
  if (m.includes('sonnet')) return 'var(--blue)'
  if (m.includes('haiku')) return 'var(--teal)'
  return 'var(--text-4)'
}
const USAGE_SOURCE_LABEL: Record<ApiUsageRecord['source'], string> = {
  chat: '코드', ask: '/ask', talk: '채팅', ma: '멀티'
}
type StatPeriod = '1d' | '7d' | '30d' | 'all'
const STAT_PERIODS: { id: StatPeriod; label: string; days: number | null }[] = [
  { id: '1d', label: '1일', days: 1 },
  { id: '7d', label: '7일', days: 7 },
  { id: '30d', label: '30일', days: 30 },
  { id: 'all', label: '전체', days: null }
]

function ApiView() {
  const [st, setSt] = useState<ApiConfigStatus | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [budgetInput, setBudgetInput] = useState('')
  const [busy, setBusy] = useState(false)
  // 사용 통계 — API 모드 실행 원장(jsonl)을 읽어 렌더러에서 집계한다
  const [recs, setRecs] = useState<ApiUsageRecord[] | null>(null)
  const [period, setPeriod] = useState<StatPeriod>('30d')

  useEffect(() => {
    window.api.apiConfig
      .get()
      .then((s) => {
        setSt(s)
        setBudgetInput(s.budgetUsd != null ? String(s.budgetUsd) : '')
      })
      .catch(() => {})
    window.api.apiConfig
      .listUsage()
      .then(setRecs)
      .catch(() => setRecs([]))
  }, [])

  // 기간 요약(비용·실행·토큰) + 모델별 비용 — 기간 칩을 따른다
  const stats = useMemo(() => {
    const list = recs ?? []
    const days = STAT_PERIODS.find((t) => t.id === period)?.days ?? null
    const cut = days == null ? 0 : Date.now() - days * 864e5
    const rows = list.filter((r) => r.ts >= cut)
    let cost = 0
    let inTok = 0
    let outTok = 0
    const byModel = new Map<string, { cost: number; runs: number; tok: number }>()
    const bySource = new Map<ApiUsageRecord['source'], number>()
    for (const r of rows) {
      cost += r.costUsd
      inTok += r.inTok + r.cacheRead + r.cacheWrite
      outTok += r.outTok
      const m = byModel.get(r.model) ?? { cost: 0, runs: 0, tok: 0 }
      m.cost += r.costUsd
      m.runs += 1
      m.tok += r.inTok + r.cacheRead + r.cacheWrite + r.outTok
      byModel.set(r.model, m)
      bySource.set(r.source, (bySource.get(r.source) ?? 0) + r.costUsd)
    }
    const models = [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost)
    const sources = [...bySource.entries()].sort((a, b) => b[1] - a[1])
    return { runs: rows.length, cost, inTok, outTok, models, maxModelCost: models[0]?.cost ?? 0, sources }
  }, [recs, period])

  // 일별 미니 바차트 — 기간 칩과 무관하게 항상 최근 14일 고정 창
  const days = useMemo(() => {
    const list = recs ?? []
    const out: { label: string; cost: number; runs: number }[] = []
    const today = new Date()
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
      const from = d.getTime()
      const to = from + 864e5
      let cost = 0
      let runs = 0
      for (const r of list) {
        if (r.ts >= from && r.ts < to) {
          cost += r.costUsd
          runs += 1
        }
      }
      out.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, cost, runs })
    }
    return out
  }, [recs])
  const maxDay = Math.max(...days.map((d) => d.cost), 0)

  const saveKey = async (): Promise<void> => {
    const k = keyInput.trim()
    if (!k) return
    setBusy(true)
    try {
      setSt(await window.api.apiConfig.setKey(k))
      setKeyInput('')
    } catch {
      /* ignore */
    } finally {
      setBusy(false)
    }
  }
  const removeKey = async (): Promise<void> => {
    setBusy(true)
    try {
      setSt(await window.api.apiConfig.clearKey())
    } catch {
      /* ignore */
    } finally {
      setBusy(false)
    }
  }
  const saveBudget = async (): Promise<void> => {
    const n = parseFloat(budgetInput)
    const usd = isFinite(n) && n > 0 ? n : null
    try {
      const s = await window.api.apiConfig.setBudget(usd)
      setSt(s)
      setBudgetInput(s.budgetUsd != null ? String(s.budgetUsd) : '')
    } catch {
      /* ignore */
    }
  }
  const resetSpend = async (): Promise<void> => {
    try {
      setSt(await window.api.apiConfig.resetSpend())
    } catch {
      /* ignore */
    }
  }

  const budgetDirty = (st?.budgetUsd != null ? String(st.budgetUsd) : '') !== budgetInput.trim()
  const remain = st && st.budgetUsd != null ? st.budgetUsd - st.spentUsd : null

  return (
    <>
      <div className="set-h1">API</div>
      <div className="set-h1-sub">
        API 키를 등록하면 채팅 컴포저의 <strong>API 토글</strong>로 실행 과금을 구독(OAuth) ↔ API 크레딧 사이에서
        전환할 수 있습니다. API 모드에선 5시간·주간 한도 대신 사용 비용이 표시됩니다.
      </div>

      <div className="sec">
        <div className="card">
          <div className="ver-row">
            <div className="ver-ic">
              <IconKey size={20} />
            </div>
            <div className="ver-main">
              <div className="ver-name">API 키</div>
              <div className="ver-meta">
                {st == null
                  ? '불러오는 중…'
                  : st.hasKey
                    ? `sk-ant-…${st.keyTail ?? '????'} · 암호화되어 이 컴퓨터에만 저장됨`
                    : 'platform.claude.com에서 발급한 키(sk-ant-api…)를 입력하세요'}
              </div>
            </div>
            {st?.hasKey ? (
              <button className="inst-btn ghost" disabled={busy} onClick={() => void removeKey()}>
                <IconTrash size={13} /> 삭제
              </button>
            ) : (
              <div className="api-form">
                <input
                  className="api-input"
                  type="password"
                  placeholder="sk-ant-api03-…"
                  value={keyInput}
                  spellCheck={false}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveKey()
                  }}
                />
                <button className="inst-btn" disabled={busy || !keyInput.trim()} onClick={() => void saveKey()}>
                  저장
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="set-note">
          키는 Windows 계정에 묶인 암호화(DPAPI)로 <code>~/.agentcodegui/api-config.json</code>에 저장되며, 실행할 때
          엔진 프로세스에만 전달됩니다. 화면에는 끝 4자리만 표시돼요.
        </div>
      </div>

      <div className="sec">
        <div className="card">
          <div className="ver-row">
            <div className="ver-ic">
              <IconDollar size={20} />
            </div>
            <div className="ver-main">
              <div className="ver-name">예산 (선택)</div>
              <div className="ver-meta">충전한 금액(USD)을 입력하면 컨텍스트 표시에 “남은 예산”이 나옵니다</div>
            </div>
            <div className="api-form">
              <input
                className="api-input num"
                type="number"
                min={0}
                step={1}
                placeholder="예: 20"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveBudget()
                }}
              />
              <button className="inst-btn" disabled={!budgetDirty} onClick={() => void saveBudget()}>
                저장
              </button>
            </div>
          </div>
          <div className="api-spend">
            <span className="api-spend-l">API 모드 누적 사용액</span>
            <span className="api-spend-v">{st ? fmtUsd(st.spentUsd) : '—'}</span>
            {remain != null && (
              <span className={'api-spend-remain' + (remain <= 0 ? ' over' : '')}>
                남은 예산 {fmtUsd(Math.max(0, remain))}
              </span>
            )}
            <span className="smh-spacer" />
            <button className="inst-btn ghost" disabled={!st || st.spentUsd === 0} onClick={() => void resetSpend()}>
              <IconRefresh size={13} /> 리셋
            </button>
          </div>
        </div>
        <div className="set-note">
          Anthropic은 계정 잔액 조회 API를 제공하지 않아, 이 앱이 API 모드 실행마다 보고되는 비용
          (<code>total_cost_usd</code>)을 직접 누적해 예산에서 차감합니다. 다른 앱에서 같은 키를 쓰면 실제 잔액과
          어긋날 수 있어요 — 재충전 후에는 <strong>리셋</strong>으로 기준을 다시 잡아 주세요.
        </div>
      </div>

      <div className="sec">
        <div className="api-stat-head">
          <span className="api-stat-title">사용 통계</span>
          <div className="skill-tabs slim">
            {STAT_PERIODS.map((t) => (
              <button
                key={t.id}
                className={'skill-tab' + (period === t.id ? ' active' : '')}
                onClick={() => setPeriod(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {recs == null ? (
          <div className="ver-loading">
            <span className="set-spin" /> 불러오는 중…
          </div>
        ) : recs.length === 0 ? (
          <div className="set-empty">아직 API 모드 실행 기록이 없어요. 컴포저의 API 토글을 켜고 실행하면 여기에 쌓입니다.</div>
        ) : (
          <>
            <div className="api-tiles">
              <div className="api-tile">
                <div className="api-tile-l">총 비용</div>
                <div className="api-tile-v">{fmtUsd(stats.cost)}</div>
                <div className="api-tile-d">실행 {stats.runs}회</div>
              </div>
              <div className="api-tile">
                <div className="api-tile-l">입력 토큰</div>
                <div className="api-tile-v">{fmtTokS(stats.inTok)}</div>
                <div className="api-tile-d">캐시 읽기·생성 포함</div>
              </div>
              <div className="api-tile">
                <div className="api-tile-l">출력 토큰</div>
                <div className="api-tile-v">{fmtTokS(stats.outTok)}</div>
                <div className="api-tile-d">
                  {stats.sources.length
                    ? stats.sources.map(([s, c]) => `${USAGE_SOURCE_LABEL[s]} ${fmtUsd(c)}`).join(' · ')
                    : ' '}
                </div>
              </div>
            </div>

            <div className="api-chart">
              <div className="api-chart-h">
                <span className="api-chart-t">일별 비용</span>
                <span className="api-chart-s">최근 14일</span>
              </div>
              <div className="api-days">
                {days.map((d, i) => (
                  <div
                    className="api-day has-tip"
                    key={i}
                    data-tip={`${d.label} · ${fmtUsd(d.cost)} · ${d.runs}회`}
                  >
                    <div
                      className={'api-day-bar' + (d.cost === 0 ? ' zero' : '')}
                      style={{ height: maxDay > 0 ? `${Math.max(3, (d.cost / maxDay) * 100)}%` : '3%' }}
                    />
                  </div>
                ))}
              </div>
              <div className="api-day-lbls">
                {days.map((d, i) => (
                  <span className="api-day-lbl" key={i}>
                    {(days.length - 1 - i) % 3 === 0 ? d.label : ''}
                  </span>
                ))}
              </div>
            </div>

            <div className="api-chart">
              <div className="api-chart-h">
                <span className="api-chart-t">모델별 비용</span>
                <span className="api-chart-s">{STAT_PERIODS.find((t) => t.id === period)?.label}</span>
              </div>
              <div className="api-mrows">
                {stats.models.map((m) => (
                  <div className="api-mrow" key={m.model}>
                    <span className="api-mdot" style={{ background: modelDotColor(m.model) }} />
                    <span className="api-mname">{m.model}</span>
                    <span className="api-mbar-wrap">
                      <span
                        className="api-mbar"
                        style={{ width: stats.maxModelCost > 0 ? `${Math.max(1.5, (m.cost / stats.maxModelCost) * 100)}%` : '1.5%' }}
                      />
                    </span>
                    <span className="api-mval">{fmtUsd(m.cost)}</span>
                    <span className="api-mruns">{m.runs}회 · {fmtTokS(m.tok)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="set-note">
          API 모드로 돌린 실행만 집계됩니다 (구독 실행은 실제 청구가 아니라 제외). 기록은{' '}
          <code>~/.agentcodegui/api-usage.jsonl</code>에 쌓여요.
        </div>
      </div>
    </>
  )
}

const SCOPE_TABS: { id: 'all' | SkillScope; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'global', label: '전역' },
  { id: 'local', label: '로컬' }
]

function SkillView({ cwd }: { cwd: string }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [scope, setScope] = useState<'all' | SkillScope>('all')
  const [busy, setBusy] = useState<string | null>(null) // skill name currently toggling

  const refresh = (): void => {
    window.api.skill
      .list(cwd)
      .then(setSkills)
      .catch(() => setSkills([]))
  }
  useEffect(refresh, [cwd])

  const toggle = async (s: SkillInfo): Promise<void> => {
    const next = !s.enabled
    setBusy(s.name)
    // optimistic — a name can appear in both scopes, so flip every matching row
    setSkills((cur) => cur?.map((x) => (x.name === s.name ? { ...x, enabled: next } : x)) ?? cur)
    try {
      await window.api.skill.setEnabled(s.name, next)
    } catch {
      refresh() // revert to the persisted truth on failure
    } finally {
      setBusy(null)
    }
  }

  const counts = {
    all: skills?.length ?? 0,
    global: skills?.filter((s) => s.scope === 'global').length ?? 0,
    local: skills?.filter((s) => s.scope === 'local').length ?? 0
  }
  const rows = (skills ?? []).filter((s) => scope === 'all' || s.scope === scope)

  return (
    <>
      <div className="set-h1">Skill</div>
      <div className="set-h1-sub">에이전트가 쓸 수 있는 Skill을 범위별로 보고, 여기서 바로 켜고 끌 수 있습니다.</div>

      <div className="sec">
        <div className="skill-tabs">
          {SCOPE_TABS.map((t) => (
            <button
              key={t.id}
              className={'skill-tab' + (scope === t.id ? ' active' : '')}
              onClick={() => setScope(t.id)}
            >
              {t.label}
              <span className="skill-tab-n">{counts[t.id]}</span>
            </button>
          ))}
          <button className="skill-refresh" onClick={refresh} aria-label="새로고침">
            <IconRefresh size={14} />
          </button>
        </div>

        {skills == null ? (
          <div className="ver-loading">
            <span className="set-spin" /> 불러오는 중…
          </div>
        ) : rows.length === 0 ? (
          <div className="set-empty">
            {scope === 'local'
              ? cwd
                ? '이 프로젝트의 .claude/skills 에 Skill이 없습니다.'
                : '연결된 프로젝트가 없어 로컬 Skill을 찾을 수 없습니다.'
              : scope === 'global'
                ? '~/.claude/skills 에 Skill이 없습니다.'
                : '설치된 Skill이 없습니다.'}
          </div>
        ) : (
          <div className="ext-list">
            {rows.map((s) => (
              <div className={'ext-item skill' + (s.enabled ? '' : ' off')} key={s.scope + ':' + s.name}>
                <div className="ext-main has-tip tip-wrap" data-tip={s.description || '설명이 없습니다.'}>
                  <div className="ext-top">
                    <span className="ext-name">{s.name}</span>
                    <span className={'scope-badge ' + s.scope}>{s.scope === 'global' ? '전역' : '로컬'}</span>
                  </div>
                  <div className="ext-desc">{s.description || '설명이 없습니다.'}</div>
                </div>
                <button
                  className={'skill-toggle' + (s.enabled ? ' on' : '')}
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={s.name + (s.enabled ? ' 끄기' : ' 켜기')}
                  disabled={busy === s.name}
                  onClick={() => void toggle(s)}
                >
                  <span className="skill-knob" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="set-note">
          전역: <code>~/.claude/skills</code> · 로컬: <code>&lt;프로젝트&gt;/.claude/skills</code> · 끄면 이후 실행부터 에이전트가 그 Skill을 사용하지 않습니다.
        </div>
      </div>
    </>
  )
}

function McpView({ cwd }: { cwd: string }) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)
  const [scope, setScope] = useState<'all' | 'global' | 'local'>('all')
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = (): void => {
    window.api.mcp
      .list(cwd)
      .then(setServers)
      .catch(() => setServers([]))
  }
  useEffect(refresh, [cwd])

  const toggle = async (s: McpServerInfo): Promise<void> => {
    const next = !s.enabled
    setBusy(s.name)
    setServers((cur) => cur?.map((x) => (x.name === s.name ? { ...x, enabled: next } : x)) ?? cur)
    try {
      await window.api.mcp.setEnabled(s.name, next)
    } catch {
      refresh()
    } finally {
      setBusy(null)
    }
  }

  const counts = {
    all: servers?.length ?? 0,
    global: servers?.filter((s) => s.scope === 'global').length ?? 0,
    local: servers?.filter((s) => s.scope === 'local').length ?? 0
  }
  const rows = (servers ?? []).filter((s) => scope === 'all' || s.scope === scope)

  return (
    <>
      <div className="set-h1">MCP</div>
      <div className="set-h1-sub">에이전트가 쓸 수 있는 MCP 서버를 범위별로 보고, 여기서 바로 켜고 끌 수 있습니다.</div>

      <div className="sec">
        <div className="skill-tabs">
          {SCOPE_TABS.map((t) => (
            <button
              key={t.id}
              className={'skill-tab' + (scope === t.id ? ' active' : '')}
              onClick={() => setScope(t.id)}
            >
              {t.label}
              <span className="skill-tab-n">{counts[t.id]}</span>
            </button>
          ))}
          <button className="skill-refresh" onClick={refresh} aria-label="새로고침">
            <IconRefresh size={14} />
          </button>
        </div>

        {servers == null ? (
          <div className="ver-loading">
            <span className="set-spin" /> 불러오는 중…
          </div>
        ) : rows.length === 0 ? (
          <div className="set-empty">
            {scope === 'local'
              ? cwd
                ? '이 프로젝트(.mcp.json·로컬)에 등록된 MCP 서버가 없습니다.'
                : '연결된 프로젝트가 없어 로컬 MCP 서버를 찾을 수 없습니다.'
              : scope === 'global'
                ? '~/.claude.json 에 등록된 전역 MCP 서버가 없습니다.'
                : '등록된 MCP 서버가 없습니다.'}
          </div>
        ) : (
          <div className="ext-list">
            {rows.map((s) => (
              <div className={'ext-item skill' + (s.enabled ? '' : ' off')} key={s.origin + ':' + s.name}>
                <div className="ext-main has-tip tip-wrap" data-tip={s.detail || '연결 정보가 없습니다.'}>
                  <div className="ext-top">
                    <span className="ext-name">{s.name}</span>
                    <span className={'scope-badge ' + s.scope}>{s.scope === 'global' ? '전역' : '로컬'}</span>
                    {s.transport !== 'unknown' && <span className="ver-chip">{s.transport.toUpperCase()}</span>}
                  </div>
                  <div className="ext-desc ext-cmd">{s.detail || '연결 정보가 없습니다.'}</div>
                </div>
                <button
                  className={'skill-toggle' + (s.enabled ? ' on' : '')}
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={s.name + (s.enabled ? ' 끄기' : ' 켜기')}
                  disabled={busy === s.name}
                  onClick={() => void toggle(s)}
                >
                  <span className="skill-knob" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="set-note">
          전역: <code>~/.claude.json</code> · 프로젝트: <code>&lt;프로젝트&gt;/.mcp.json</code> · 끄면 이후 실행부터 에이전트가 그 서버를 사용하지 않습니다.
        </div>
      </div>
    </>
  )
}

// a representative filename per server id → the same FileBadge the rest of the app
// uses, so the languages are recognizable at a glance
const LSP_BADGE: Record<string, string> = { ts: 'a.ts', py: 'a.py', cs: 'a.cs', cpp: 'a.cpp', verse: 'a.verse' }

// the install/remove progress card (엔진 설치와 같은 카드 모달) — one op at a time
interface LspCard {
  id: string // server id the op belongs to (routes progress events)
  op: '설치' | '삭제' | '준비'
  label: string
  log: string[]
  status: 'running' | 'done' | 'error'
  error?: string
  percent: number | null
}

function LspView() {
  const [servers, setServers] = useState<LspServerInfo[] | null>(null)
  const [pct, setPct] = useState<Record<string, number | null>>({})
  const [confirm, setConfirm] = useState<LspServerInfo | null>(null)
  const [card, setCard] = useState<LspCard | null>(null)
  // Verse 공식 문서 호버 언어 — 'ko'(기본, 한국어 번역) / 'en'(원문). 메인은 ui-prefs 저장 IPC에서 이 값을 읽어 호버 번역을 켜고 끈다.
  const [verseKo, setVerseKo] = useState<boolean>(() => getPref<string>('verseDocLang', 'ko') !== 'en')
  // Verse 행 펼침 — 클릭하면 '공식 문서 한국어' 등 Verse 전용 옵션이 행 아래로 펼쳐진다.
  const [verseOpen, setVerseOpen] = useState(false)
  // UE C++ 공식 주석 호버 언어 — 'ko'(기본) / 'en'. C/C++ 행을 펼치면 토글이 보인다.
  const [ueKo, setUeKo] = useState<boolean>(() => getPref<string>('ueDocLang', 'ko') !== 'en')
  const [cppOpen, setCppOpen] = useState(false)

  const refresh = (): void => {
    window.api.lsp
      .servers()
      .then(setServers)
      .catch(() => setServers([]))
  }
  useEffect(() => {
    refresh()
    return window.api.lsp.onInstallProgress((p) => {
      setPct((c) => ({ ...c, [p.server]: p.done ? null : p.percent }))
      // stream download lines + percent into the open card (only the matching op's)
      setCard((c) =>
        c && c.id === p.server && c.status === 'running'
          ? { ...c, log: p.line ? [...c.log, p.line] : c.log, percent: p.percent ?? c.percent }
          : c
      )
      if (p.done) refresh()
    })
  }, [])

  const doInstall = (s: LspServerInfo): void => {
    setCard({ id: s.id, op: '설치', label: s.langs, log: ['설치를 준비하는 중…'], status: 'running', percent: null })
    // optimistic: the row flips to 설치 중 right away; progress events drive the %
    setServers((cur) => cur?.map((x) => (x.id === s.id ? { ...x, state: 'installing' } : x)) ?? cur)
    window.api.lsp
      .installServer(s.id)
      .then((r) =>
        setCard((c) =>
          c && c.id === s.id
            ? r.ok
              ? { ...c, status: 'done', percent: 100, log: [...c.log, '설치가 끝났어요. 파일을 열면 바로 심볼 탐색이 켜집니다.'] }
              : { ...c, status: 'error', error: r.error || '설치에 실패했습니다.' }
            : c
        )
      )
      .catch(() => setCard((c) => (c && c.id === s.id ? { ...c, status: 'error', error: '설치에 실패했습니다.' } : c)))
      .finally(refresh)
  }
  const doRemove = (s: LspServerInfo): void => {
    setCard({
      id: s.id,
      op: '삭제',
      label: s.langs,
      log: ['실행 중인 분석 서버를 중지하는 중…', '설치된 파일을 삭제하는 중…'],
      status: 'running',
      percent: null
    })
    window.api.lsp
      .uninstallServer(s.id)
      .then((r) =>
        setCard((c) =>
          c && c.id === s.id
            ? r.ok
              ? { ...c, status: 'done', log: [...c.log, '삭제가 끝났어요. 필요하면 언제든 다시 설치할 수 있어요.'] }
              : { ...c, status: 'error', error: r.error || '삭제하지 못했어요.' }
            : c
        )
      )
      .catch(() => setCard((c) => (c && c.id === s.id ? { ...c, status: 'error', error: '삭제하지 못했어요.' } : c)))
      .finally(refresh)
  }
  // Verse(external): the user picks their Verse.vsix / verse-lsp.exe; we extract+prepare it.
  const doVersePick = async (): Promise<void> => {
    const p = await window.api.lsp.pickVerseServer()
    if (!p) return
    setCard({ id: 'verse', op: '준비', label: 'Verse', log: [`선택: ${p}`, 'verse-lsp.exe 준비 중…'], status: 'running', percent: null })
    const r = await window.api.lsp.setVersePath(p).catch(() => ({ ok: false as const, error: '설정에 실패했습니다.' }))
    setCard((c) =>
      c && c.id === 'verse'
        ? r.ok
          ? { ...c, status: 'done', log: [...c.log, '준비 완료. .verse 파일을 열면 정의 이동·호버·심볼이 켜집니다.'] }
          : { ...c, status: 'error', error: r.error || '설정에 실패했습니다.' }
        : c
    )
    refresh()
  }
  const doVerseClear = async (): Promise<void> => {
    await window.api.lsp.clearVersePath().catch(() => {})
    refresh()
  }
  const toggleVerseKo = (): void => {
    setVerseKo((on) => {
      const next = !on
      setPref('verseDocLang', next ? 'ko' : 'en') // 메인이 다음 호버부터 적용
      return next
    })
  }
  const toggleUeKo = (): void => {
    setUeKo((on) => {
      const next = !on
      setPref('ueDocLang', next ? 'ko' : 'en') // 메인이 다음 호버부터 적용
      return next
    })
  }

  return (
    <>
      <div className="set-h1">Code</div>
      <div className="set-h1-sub">
        파일 뷰어의 심볼 탐색(호버 타입 정보 · Ctrl+클릭 정의 이동)을 언어별 분석 서버가 제공합니다.
      </div>

      <div className="sec">
        {servers == null ? (
          <div className="ver-loading">
            <span className="set-spin" /> 불러오는 중…
          </div>
        ) : (
          <div className="ext-list">
            {servers.map((s) => {
              const installing = s.state === 'installing'
              const p = pct[s.id]
              // 펼치는 디스클로저 행: Verse(external)는 '공식 문서 한국어' 등 Verse 옵션을,
              // C/C++는 'Unreal Engine 공식 문서 한국어' 옵션을 행 아래에 담는다.
              const isVerse = s.kind === 'external'
              const isCpp = s.id === 'cpp'
              const disc = isVerse || isCpp
              const open = isVerse ? verseOpen : cppOpen
              const toggleOpen = isVerse ? () => setVerseOpen((o) => !o) : () => setCppOpen((o) => !o)
              return (
                <Fragment key={s.id}>
                  <div
                    className={'ext-item' + (disc ? ' disc-row' + (open ? ' open' : '') : '')}
                    role={disc ? 'button' : undefined}
                    aria-expanded={disc ? open : undefined}
                    onClick={disc ? toggleOpen : undefined}
                  >
                    {disc && (
                      <span className="ext-chev" aria-hidden>
                        <IconChevRight size={15} />
                      </span>
                    )}
                    <FileBadge path={LSP_BADGE[s.id] ?? 'a.txt'} size={30} />
                    <div className="ext-main">
                      <div className="ext-top">
                        <span className="ext-name">{s.langs}</span>
                        {s.state === 'bundled' && <span className="ver-chip latest">앱 내장</span>}
                        {s.kind !== 'external' && s.state === 'installed' && (
                          <span className="ver-chip latest">설치됨</span>
                        )}
                        {s.kind === 'external' &&
                          (s.state === 'installed' ? (
                            <span className="ver-chip latest">지정됨</span>
                          ) : (
                            <span className="ver-chip">미지정</span>
                          ))}
                        {/* Verse의 요구사항·경로·문서 언어는 행을 펼치면 보인다 — 접힌 행은
                            다른 서버들과 같은 2줄 높이를 유지한다 */}
                        {!isVerse && s.requires && <span className="ver-chip">{s.requires}</span>}
                      </div>
                      <div className="ext-desc ext-cmd">{s.exts}</div>
                    </div>
                    {s.kind === 'download' &&
                      (s.state === 'installed' ? (
                        <button
                          className="inst-btn ghost"
                          onClick={(e) => {
                            e.stopPropagation() // C/C++ 디스클로저 행 토글에 안 걸리게
                            setConfirm(s)
                          }}
                        >
                          <IconTrash size={13} /> 삭제
                        </button>
                      ) : (
                        <button
                          className="inst-btn"
                          disabled={installing}
                          onClick={(e) => {
                            e.stopPropagation()
                            doInstall(s)
                          }}
                        >
                          {installing ? `설치 중…${p != null ? ` ${p}%` : ''}` : '설치'}
                        </button>
                      ))}
                    {s.kind === 'external' &&
                      (s.state === 'installed' ? (
                        <button
                          className="inst-btn ghost"
                          onClick={(e) => {
                            e.stopPropagation()
                            doVerseClear()
                          }}
                        >
                          <IconTrash size={13} /> 삭제
                        </button>
                      ) : (
                        <button
                          className="inst-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            doVersePick()
                          }}
                        >
                          설정
                        </button>
                      ))}
                  </div>
                  {/* Verse 펼침 — 연결 안내·지정 경로·문서 언어가 행 아래로 깔끔하게 이어진다.
                      (하단 set-note에 있던 긴 설명을 여기로 옮겨 접힌 행은 다른 서버와 동일한 높이) */}
                  {isVerse && verseOpen && (
                    <>
                      <div className="ext-item ext-sub">
                        <div className="ext-main">
                          <div className="ext-sub-name">Epic verse-lsp 연결</div>
                          <div className="ext-desc ext-sub-desc">
                            UEFN/포트나이트의 <code>Verse.vsix</code>(또는 <code>verse-lsp.exe</code>) 경로를 지정하면 정의
                            이동·호버·심볼이 켜집니다. 소스·디제스트 폴더는 프로젝트의 <code>.vproject</code>에서 자동으로
                            찾고, 지정 전에는 구문 강조만 동작해요.
                          </div>
                          {s.path && (
                            <div className="ext-sub-path">
                              <IconCheck size={12} />
                              <code>{s.path}</code>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="ext-item ext-sub">
                        <div className="ext-main">
                          <div className="ext-sub-name">공식 문서를 한국어로 보기</div>
                          <div className="ext-desc ext-sub-desc">
                            <code>/Verse.org</code> · <code>/UnrealEngine.com</code> · <code>/Fortnite.com</code> API 주석
                            설명을 호버에서 한국어로 보여줍니다. 끄면 영어 원문으로 표시합니다. (번역에 없는 항목이나 내 코드
                            주석은 원문 그대로)
                          </div>
                        </div>
                        <button
                          className={'skill-toggle' + (verseKo ? ' on' : '')}
                          role="switch"
                          aria-checked={verseKo}
                          aria-label={verseKo ? 'Verse 한국어 문서 끄기' : 'Verse 한국어 문서 켜기'}
                          onClick={toggleVerseKo}
                        >
                          <span className="skill-knob" />
                        </button>
                      </div>
                    </>
                  )}
                  {/* C/C++ 펼침 — 언리얼 프로젝트의 엔진 공식 주석(clangd 호버) 한국어 번역 토글 */}
                  {isCpp && cppOpen && (
                    <div className="ext-item ext-sub">
                      <div className="ext-main">
                        <div className="ext-sub-name">Unreal Engine 공식 문서를 한국어로 보기</div>
                        <div className="ext-desc ext-sub-desc">
                          언리얼 프로젝트(<code>.uproject</code>)의 C++ 호버에 실리는 엔진 공식 주석(<code>AActor</code>·
                          <code>TObjectPtr</code> 같은 핵심 타입 설명)을 한국어로 보여줍니다. 끄면 영어 원문으로
                          표시합니다. (번역에 없는 항목이나 내 코드 주석은 원문 그대로)
                        </div>
                      </div>
                      <button
                        className={'skill-toggle' + (ueKo ? ' on' : '')}
                        role="switch"
                        aria-checked={ueKo}
                        aria-label={ueKo ? 'Unreal Engine 한국어 문서 끄기' : 'Unreal Engine 한국어 문서 켜기'}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleUeKo()
                        }}
                      >
                        <span className="skill-knob" />
                      </button>
                    </div>
                  )}
                </Fragment>
              )
            })}
          </div>
        )}

        <div className="set-note">
          내장 서버는 바로 사용할 수 있고, C#·C++ 서버는 최초 1회 내려받아 <code>~/.agentcodegui/lsp</code> 에
          설치됩니다. Verse 연결·문서 언어 옵션은 Verse 행을, Unreal Engine 문서 언어 옵션은 C·C++ 행을
          클릭하면 펼쳐집니다.
        </div>
      </div>

      {confirm && (
        <div className="set-dialog-overlay" onMouseDown={() => setConfirm(null)}>
          <div className="set-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="sd-ic">
              <IconAlert size={22} />
            </div>
            <div className="sd-title">분석 서버 삭제</div>
            <div className="sd-msg">{`${confirm.langs} 분석 서버를 삭제할까요? 필요하면 언제든 다시 설치할 수 있어요.`}</div>
            <div className="sd-btns">
              <button className="sd-cancel" onClick={() => setConfirm(null)}>
                취소
              </button>
              <button
                className="sd-go danger"
                onClick={() => {
                  const s = confirm
                  setConfirm(null)
                  doRemove(s)
                }}
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}

      {card && (
        <div
          className="set-dialog-overlay"
          onMouseDown={() => {
            if (card.status !== 'running') setCard(null)
          }}
        >
          <div className="install-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ic-head">
              <span className={'ic-hic ' + card.status}>
                {card.status === 'running' ? (
                  <span className="set-spin" />
                ) : card.status === 'done' ? (
                  <IconCheck size={16} />
                ) : (
                  <IconAlert size={16} />
                )}
              </span>
              <span className="ic-title">
                {card.status === 'running'
                  ? `분석 서버 ${card.op} 중`
                  : card.status === 'done'
                    ? `${card.op} 완료`
                    : `${card.op} 실패`}
              </span>
              <span className="ic-ver">{card.label}</span>
            </div>
            <div className="ic-log scroll">
              {card.log.map((l, i) => (
                <div className="ic-ln" key={i}>
                  {l}
                </div>
              ))}
              {card.status === 'error' && card.error && <div className="ic-ln err">{card.error}</div>}
            </div>
            <div className="ic-foot">
              <span className={'ic-status ' + card.status}>
                {card.status === 'running'
                  ? card.op === '설치'
                    ? `내려받는 중…${card.percent != null ? ` ${card.percent}%` : ''}`
                    : card.op === '준비'
                      ? '준비하는 중…'
                      : '삭제하는 중…'
                  : card.status === 'done'
                    ? `${card.op}가 완료되었습니다`
                    : `${card.op}에 실패했습니다`}
              </span>
              <button className="sd-go" onClick={() => setCard(null)} disabled={card.status === 'running'}>
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── 탐색기 (숨길 폴더 관리) ───────────────────────────────────────
// 파일 탐색기 트리에서 감출 폴더 이름을 전역으로 관리한다. bin·obj·Saved 같은 빌드/생성물
// 폴더를 이름 기준(대소문자 무시, 어느 깊이든)으로 숨겨 소스에 집중하게 한다. 저장 즉시
// lib/hideDirs가 이벤트를 쏴 열려 있는 탐색기가 트리를 다시 읽는다.
function ExplorerView(): React.ReactElement {
  const [enabled, setEnabled] = useState<boolean>(() => getHideEnabled())
  const [dirs, setDirs] = useState<string[]>(() => getHideDirs())
  const [input, setInput] = useState('')
  // 목록 찾기 — 프리셋이 수십 개라 특정 폴더 하나를 지우려면 검색이 빠르다 (대소문자 무시)
  const [query, setQuery] = useState('')

  const commit = (list: string[]): void => {
    setDirs(list)
    setHideDirs(list) // 저장 + 탐색기에 알림
  }
  const toggle = (): void => {
    const next = !enabled
    setEnabled(next)
    setHideEnabled(next)
  }
  const add = (): void => {
    // 폴더 '이름'만 받는다 — 경로 구분자는 떼어내고, 이미 있으면(대소문자 무시) 무시
    const name = input.trim().replace(/[\\/]/g, '')
    if (!name) return
    setInput('')
    if (dirs.some((d) => d.toLowerCase() === name.toLowerCase())) return
    commit([...dirs, name])
  }
  const remove = (name: string): void => commit(dirs.filter((d) => d !== name))
  const isDefault =
    dirs.length === DEFAULT_HIDE_DIRS.length &&
    dirs.every((d, i) => d === DEFAULT_HIDE_DIRS[i])
  const q = query.trim().toLowerCase()
  const shown = q ? dirs.filter((d) => d.toLowerCase().includes(q)) : dirs

  return (
    <>
      <div className="set-h1">Explorer</div>
      <div className="set-h1-sub">
        파일 탐색기 트리에서 숨길 폴더를 관리해요. <code>bin</code>·<code>obj</code>·<code>Saved</code> 같은 빌드·생성물
        폴더를 감춰 소스에 집중할 수 있어요.
      </div>

      <div className="sec">
        {/* 위: 마스터 토글 하나 */}
        <div className="card">
          <div className="ver-row">
            <div className="ver-ic">
              <IconFilter size={20} />
            </div>
            <div className="ver-main">
              <div className="ver-name">빌드·생성물 폴더 숨기기</div>
              <div className="ver-meta">
                {enabled ? '아래 목록의 폴더를 탐색기에서 감춰요' : '모든 폴더를 그대로 보여줘요'}
              </div>
            </div>
            <button
              className={'skill-toggle' + (enabled ? ' on' : '')}
              role="switch"
              aria-checked={enabled}
              aria-label={enabled ? '폴더 숨김 끄기' : '폴더 숨김 켜기'}
              onClick={toggle}
            >
              <span className="skill-knob" />
            </button>
          </div>
        </div>

        {/* 아래: 추가 입력 + 폴더가 한 줄씩 쭉 */}
        <div className={'exd-panel' + (enabled ? '' : ' off')}>
          <div className="exd-add">
            <input
              className="api-input"
              placeholder="폴더 이름 추가 (예: Logs)"
              value={input}
              spellCheck={false}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add()
              }}
            />
            <button className="inst-btn" disabled={!input.trim()} onClick={add}>
              <IconPlus size={14} /> 추가
            </button>
          </div>

          <div className="exd-listhead">
            <div className="exd-find">
              <IconSearch size={12} />
              <input
                placeholder="폴더 찾기"
                value={query}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setQuery('')
                }}
              />
              {query && (
                <button className="exd-find-x" aria-label="찾기 지우기" onClick={() => setQuery('')}>
                  <IconX2 size={11} />
                </button>
              )}
            </div>
            <span className="exd-count">{q ? `${shown.length}/${dirs.length}개 폴더` : `${dirs.length}개 폴더`}</span>
            <button className="exd-restore" disabled={isDefault} onClick={() => commit([...DEFAULT_HIDE_DIRS])}>
              <IconRefresh size={12} /> 기본값 복원
            </button>
          </div>

          <div className="exd-list scroll">
            {dirs.length === 0 ? (
              <div className="exd-empty">숨길 폴더가 없어요 — 위에서 추가하세요</div>
            ) : shown.length === 0 ? (
              <div className="exd-empty">‘{query.trim()}’와 일치하는 폴더가 없어요</div>
            ) : (
              shown.map((d) => (
                <div className="exd-row" key={d}>
                  <IconFolder className="exd-row-ic" size={14} />
                  <span className="exd-row-n">{d}</span>
                  <button className="exd-row-x" aria-label={d + ' 제거'} onClick={() => remove(d)}>
                    <IconX2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="set-note">
          폴더 이름은 <b>대소문자 구분 없이</b>, 트리의 <b>어느 깊이에서든</b> 같은 이름의 <b>폴더만</b> 숨겨요(같은
          이름의 파일은 그대로). 숨겨도 파일은 남아 있고 에이전트는 접근할 수 있어요 — 보기만 정리하는 거예요. 탐색기
          헤더의 <IconFilter size={11} /> 버튼으로도 빠르게 켜고 끌 수 있어요.
        </div>
      </div>
    </>
  )
}

const THEME_OPTS: {
  id: Theme
  label: string
  desc: string
  Icon: (p: IconProps) => React.ReactElement
}[] = [
  { id: 'light', label: '라이트', desc: '밝은 화면', Icon: IconSun },
  { id: 'dark', label: '다크', desc: '어두운 화면', Icon: IconMoon }
]

function AppearanceView() {
  const [theme, setThemeState] = useState<Theme>(() => getTheme())
  const pick = (t: Theme): void => {
    setTheme(t)
    setThemeState(t)
  }
  return (
    <>
      <div className="set-h1">Theme</div>
      <div className="set-h1-sub">앱 테마를 선택하세요. 변경하면 곧바로 적용됩니다.</div>
      <div className="theme-grid">
        {THEME_OPTS.map(({ id, label, desc, Icon }) => (
          <button
            key={id}
            className={'theme-card' + (theme === id ? ' on' : '')}
            onClick={() => pick(id)}
            aria-pressed={theme === id}
          >
            <span className={'theme-prev ' + id}>
              <Icon size={20} />
            </span>
            <span className="theme-name">{label}</span>
            <span className="theme-desc">{desc}</span>
            {theme === id && (
              <span className="theme-chk">
                <IconCheck size={13} />
              </span>
            )}
          </button>
        ))}
      </div>
    </>
  )
}

export function SettingsModal({
  cwd,
  onClose,
  initialView
}: {
  cwd: string
  onClose: () => void
  initialView?: SettingsView // 특정 탭으로 바로 열기 (예: 컴포저 API 토글 → 'api')
}) {
  const [view, setView] = useState<View>(initialView ?? 'version')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="set-overlay" onMouseDown={onClose}>
      <div className="set-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="set-modal-head">
          <span className="smh-title">설정</span>
          <span className="smh-spacer" />
          <button className="smh-close" onClick={onClose} aria-label="닫기">
            <IconClose size={18} />
          </button>
        </div>
        <div className="set-body">
          <nav className="set-nav">
            <div className="nh">설정</div>
            {NAV.map(({ id, label, Icon }) => (
              <button
                key={id}
                className={'nav-item' + (view === id ? ' active' : '')}
                onClick={() => setView(id)}
              >
                <span className="ic">
                  <Icon size={17} />
                </span>
                {label}
              </button>
            ))}
          </nav>
          <main className="set-main scroll">
            <div className="set-inner">
              {view === 'account' && <AccountView />}
              {view === 'version' && <VersionView />}
              {view === 'api' && <ApiView />}
              {view === 'mcp' && <McpView cwd={cwd} />}
              {view === 'skill' && <SkillView cwd={cwd} />}
              {view === 'lsp' && <LspView />}
              {view === 'explorer' && <ExplorerView />}
              {view === 'appearance' && <AppearanceView />}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
