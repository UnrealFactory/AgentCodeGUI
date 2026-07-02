import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type {
  EngineVersionEntry,
  EngineVersionState,
  SkillInfo,
  SkillScope,
  McpServerInfo,
  LspServerInfo,
  ApiConfigStatus,
  ApiUsageRecord
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
  type IconProps
} from './icons'
import { getTheme, setTheme, type Theme } from '../lib/theme'

export type SettingsView = 'version' | 'api' | 'mcp' | 'skill' | 'lsp' | 'appearance'
type View = SettingsView

const NAV: { id: View; label: string; Icon: (p: IconProps) => React.ReactElement }[] = [
  { id: 'version', label: 'Claude Code', Icon: IconClaude },
  { id: 'api', label: 'API', Icon: IconKey },
  { id: 'mcp', label: 'MCP', Icon: IconServer },
  { id: 'skill', label: 'Skill', Icon: IconBook },
  { id: 'lsp', label: 'Code', Icon: IconCode },
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

function VersionView() {
  const [state, setState] = useState<EngineVersionState | null>(null)
  const [available, setAvailable] = useState<EngineVersionEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // version currently installing
  const [dialog, setDialog] = useState<{
    title: string
    message: string
    tone?: 'danger' | 'warn'
    confirm?: { label: string; action: () => void }
  } | null>(null)
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
            <div className={'sd-ic' + (dialog.tone === 'warn' ? ' warn' : '')}>
              <IconAlert size={22} />
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
              // Verse(external)만 행을 클릭해 펼치는 디스클로저 — 하위에 '공식 문서 한국어' 옵션을 담는다.
              const isVerse = s.kind === 'external'
              return (
                <Fragment key={s.id}>
                  <div
                    className={'ext-item' + (isVerse ? ' disc-row' + (verseOpen ? ' open' : '') : '')}
                    role={isVerse ? 'button' : undefined}
                    aria-expanded={isVerse ? verseOpen : undefined}
                    onClick={isVerse ? () => setVerseOpen((o) => !o) : undefined}
                  >
                    {isVerse && (
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
                        <button className="inst-btn ghost" onClick={() => setConfirm(s)}>
                          <IconTrash size={13} /> 삭제
                        </button>
                      ) : (
                        <button className="inst-btn" disabled={installing} onClick={() => doInstall(s)}>
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
                </Fragment>
              )
            })}
          </div>
        )}

        <div className="set-note">
          내장 서버는 바로 사용할 수 있고, C#·C++ 서버는 최초 1회 내려받아 <code>~/.agentcodegui/lsp</code> 에
          설치됩니다. Verse 연결·문서 언어 옵션은 Verse 행을 클릭하면 펼쳐집니다.
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
              {view === 'version' && <VersionView />}
              {view === 'api' && <ApiView />}
              {view === 'mcp' && <McpView cwd={cwd} />}
              {view === 'skill' && <SkillView cwd={cwd} />}
              {view === 'lsp' && <LspView />}
              {view === 'appearance' && <AppearanceView />}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
