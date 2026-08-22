/**
 * 2.6.2 usage 파서 **원문 이식** — src/main/auth.ts fetchAccountUsage 의 파싱 블록 +
 * src/main/index.ts fetchUsage 의 파싱 블록. 네트워크 없음(본문을 stdin으로 받는다).
 */
function parseAccount(email, j) {
  const pct = (u) => {
    if (!u) return null
    const n = parseFloat(String(u.utilization ?? ''))
    return isNaN(n) ? null : Math.max(0, Math.min(100, Math.round(n)))
  }
  const toTs = (s) => {
    if (!s) return null
    const ms = Date.parse(s)
    return isNaN(ms) ? null : Math.floor(ms / 1000)
  }
  const fable = Array.isArray(j.limits)
    ? j.limits.find((l) => l?.kind === 'weekly_scoped' && (l.scope?.model?.display_name ?? '').toLowerCase().includes('fable'))
    : undefined
  return {
    email,
    fiveHourPct: pct(j.five_hour),
    weeklyPct: pct(j.seven_day),
    fablePct: fable && typeof fable.percent === 'number' ? Math.max(0, Math.min(100, Math.round(fable.percent))) : null,
    fiveHourResetsAt: toTs(j.five_hour?.resets_at),
    weeklyResetsAt: toTs(j.seven_day?.resets_at),
    fableResetsAt: toTs(fable?.resets_at)
  }
}

function parseInfo(j) {
  const toTs = (s) => {
    if (!s) return null
    const ms = Date.parse(s)
    return isNaN(ms) ? null : Math.floor(ms / 1000)
  }
  const win = (o) => (o ? { pct: Math.max(0, Math.min(100, Math.round(parseFloat(String(o.utilization ?? 0)) || 0))), resetsAt: toTs(o.resets_at) } : null)
  const fable = Array.isArray(j.limits)
    ? j.limits.find((l) => l?.kind === 'weekly_scoped' && (l.scope?.model?.display_name ?? '').toLowerCase().includes('fable'))
    : undefined
  const money = (m) => {
    if (m == null) return null
    if (typeof m === 'number') return m
    if (typeof m !== 'object') return null
    const o = m
    if (typeof o.amount_minor === 'number') return o.amount_minor / Math.pow(10, typeof o.exponent === 'number' ? o.exponent : 2)
    return money(o.money) ?? money(o.credits)
  }
  const sp = j.spend
  const outOfCredits = sp?.disabled_reason === 'out_of_credits'
  return {
    fiveHour: win(j.five_hour),
    weekly: win(j.seven_day),
    weeklyFable: fable ? { pct: Math.max(0, Math.min(100, Math.round(fable.percent ?? 0))), resetsAt: toTs(fable.resets_at) } : null,
    extraCredit: sp
      ? {
          enabled: !!sp.enabled,
          outOfCredits,
          currency: (sp.used?.currency || 'USD'),
          used: money(sp.used),
          cap: money(sp.cap) ?? money(sp.limit),
          balance: money(sp.balance) ?? (outOfCredits ? 0 : null),
          pct: typeof sp.percent === 'number' ? Math.max(0, Math.min(100, Math.round(sp.percent))) : null
        }
      : null
  }
}

let s = ''
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const bodies = JSON.parse(s)
  console.log(JSON.stringify(bodies.map((b) => ({ account: parseAccount('e@x.com', b), info: parseInfo(b) }))))
})
