/* ============================================================================
 * critic-m10-live-account — **측정 전용 계정의 수명 관리**(M10 라이브 하네스 넷의 공용부).
 *
 * ★왜 이 파일이 생겼나(R28f M10 수정 R1 · 실제 사고).
 *
 * M10의 라이브 갈래는 「측정 전용 계정 폴더」 하나를 가리키고(`--account=` ·
 * `CCG_LIVE_ACCOUNT_DIR`), 주행마다 그 폴더의 `.credentials.json`을 **격리 홈으로 복사**해
 * 쓴다(실앱 토큰을 안 건드리려는 설계다). 그런데 복사만 하고 **되돌리지 않았다.**
 *
 *   · 액세스 토큰의 수명은 로그인 시점 + 8시간이다(2026-08-25 11:01 로그인 →
 *     만료 `2026-08-25T10:01:59.262Z` = 19:01:59 KST).
 *   · 19:01:59 이전 주행은 복사한 액세스 토큰을 **그대로** 써서 전부 성공했다.
 *   · 만료 뒤 첫 주행이 리프레시를 돌렸고, 그 리프레시는 **회전**이다(옛 리프레시 토큰이
 *     즉시 무효가 된다). 새 토큰은 그 주행의 격리 홈에 적혔고, 홈은 주행 끝에 지워졌다.
 *   · 그래서 **원본 폴더의 리프레시 토큰만 남았고, 그것은 이미 죽은 값**이다. 그 뒤 모든
 *     주행이 `Failed to authenticate: OAuth session expired and could not be refreshed`.
 *     서버에 직접 물어도 `invalid_grant — Refresh token not found or invalid`.
 *
 * 즉 계정을 죽인 것은 「병렬 주행」이 아니라 **되돌려 쓰지 않은 복사**다(직렬로 돌려도
 * 똑같이 죽는다). 이 파일이 그 자리를 둘로 막는다.
 *
 *   ① `preflight()` — 남은 수명을 미리 보고, 이미 만료면 **4분을 태우기 전에** 멈춘다.
 *   ② `saveBack()`  — 격리 홈에서 CLI가 갱신한 자격증명을 측정 계정 폴더로 되돌린다.
 *
 * ★안전(트랩 5) — 사용자 실홈(`%USERPROFILE%\.agentcodegui`)에는 **한 바이트도 안 쓴다.**
 * `saveBack()`은 대상 폴더가 실홈 아래면 아무것도 안 하고 사유를 반환한다. `--account=`가
 * 없는 주행(실홈 기본 계정을 복사하는 옛 경로)에서는 애초에 호출되지 않는다.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const REAL_HOME = path.join(os.homedir(), '.agentcodegui')

/** 실홈 아래인가 — `saveBack`의 하드 가드. */
export function isRealHome(dir) {
  const a = path.resolve(dir).toLowerCase()
  const b = REAL_HOME.toLowerCase()
  return a === b || a.startsWith(b + path.sep)
}

const readCred = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 액세스 토큰의 남은 수명(ms). 못 읽으면 `null`. */
export function tokenState(dir) {
  const o = readCred(dir)?.claudeAiOauth
  // `expiresAt: 0` 은 **값이다** — CLI가 인증에 실패하면 그 자리에 0을 박는다(실측).
  // 그걸 「없음」으로 접으면 saveBack이 그 파일을 「비교 불가」로 흘려보낸다.
  if (o?.expiresAt === undefined || o?.expiresAt === null) return null
  return {
    expiresAt: new Date(o.expiresAt).toISOString(),
    msLeft: o.expiresAt - Date.now(),
    expired: o.expiresAt <= Date.now(),
    refreshExpiresAt: o.refreshTokenExpiresAt ? new Date(o.refreshTokenExpiresAt).toISOString() : null
  }
}

/**
 * 주행 전 점검. **막지는 않는다** — 사실만 문자열로 돌려준다(호출부가 fail/skip을 고른다).
 * 반환: `{ state, fatal, msg }` · 계정 주입이 없으면 `null`.
 */
export function preflight(dir) {
  if (!dir) return null
  const state = tokenState(dir)
  if (!state) return { state: null, fatal: false, msg: `측정 계정의 .credentials.json을 못 읽었다: ${dir}` }
  const mins = Math.round(state.msLeft / 60000)
  if (state.expired) {
    return {
      state,
      fatal: true,
      msg:
        `측정 계정의 액세스 토큰이 ${state.expiresAt}에 만료됐다(${-mins}분 지남). ` +
        `이 폴더의 리프레시 토큰은 회전으로 죽었을 수 있다 — 라이브 주행은 4분씩 헛되이 태우고 ` +
        `"OAuth session expired and could not be refreshed"로 끝난다. 격리 홈에서 재로그인해라.`
    }
  }
  return { state, fatal: false, msg: `측정 계정 잔여 수명 ${mins}분(만료 ${state.expiresAt})` }
}

/**
 * 격리 홈이 갱신한 자격증명을 **측정 계정 폴더로 되돌린다**(리프레시 체인 보존).
 *
 * 되돌리는 조건은 하나뿐이다 — 홈 쪽 `expiresAt`이 **더 미래**일 것. CLI가 인증에 실패하면
 * 홈 쪽 파일의 `expiresAt`을 0으로 지워 두므로(실측), 그 값을 되돌리면 계정을 스스로
 * 못 쓰게 만든다. 그래서 「더 새 것일 때만」이 안전 조건이다.
 */
export function saveBack(dir, HOME) {
  if (!dir) return null
  const src = path.resolve(dir)
  if (isRealHome(src)) return { saved: false, why: '실홈 계정 폴더 — 되돌리지 않는다(트랩 5)' }
  const name = path.basename(src)
  const from = path.join(HOME, 'accounts', name)
  const a = tokenState(from)
  const b = tokenState(src)
  if (!a) return { saved: false, why: '홈 쪽 자격증명 없음' }
  if (!b) return { saved: false, why: '원본 자격증명 없음' }
  if (!(new Date(a.expiresAt) > new Date(b.expiresAt))) {
    return { saved: false, why: `홈 쪽이 더 새롭지 않다(home ${a.expiresAt} · src ${b.expiresAt})` }
  }
  try {
    fs.copyFileSync(path.join(from, '.credentials.json'), path.join(src, '.credentials.json'))
    return { saved: true, expiresAt: a.expiresAt, was: b.expiresAt }
  } catch (e) {
    return { saved: false, why: String(e?.message ?? e) }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 자기 검증 ($0 · 실 CLI·실계정 무접촉) — `node scripts/critic-m10-live-account.mjs --selftest`
//
// 합성 폴더로만 잰다. 재는 것 다섯:
//   T1 만료 토큰 → preflight가 **치명**으로 판정 · T2 살아 있는 토큰 → 잔여 수명 보고
//   T3 홈이 더 새로우면 되돌린다 · T4 홈이 더 낡았으면(인증 실패로 0이 박힌 경우) **안** 되돌린다
//   T5 대상이 사용자 실홈 아래면 무조건 거부(트랩 5)
// ═════════════════════════════════════════════════════════════════════════════
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.slice(1))) {
  if (process.argv.includes('--selftest')) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-acct-'))
    const mk = (dir, expiresAt) => {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt } })
      )
    }
    let bad = 0
    const t = (id, cond, extra) => {
      if (cond) console.log(`  o ${id}${extra ? ' — ' + extra : ''}`)
      else {
        bad++
        console.error(`  x ${id}${extra ? ' — ' + extra : ''}`)
      }
    }
    const src = path.join(root, 'acct')

    mk(src, Date.now() - 60_000)
    const p1 = preflight(src)
    t('T1 만료=치명', p1.fatal === true, p1.msg.slice(0, 60))

    mk(src, Date.now() + 3_600_000)
    const p2 = preflight(src)
    t('T2 생존=경고 아님', p2.fatal === false && /잔여 수명 6[01]분/.test(p2.msg), p2.msg)

    const HOME = path.join(root, 'home')
    mk(path.join(HOME, 'accounts', 'acct'), Date.now() + 7_200_000)
    const r3 = saveBack(src, HOME)
    t('T3 새 자격증명은 되돌린다', r3.saved === true, JSON.stringify(r3))
    t('T3b 원본이 실제로 갱신됐다', tokenState(src).msLeft > 5_400_000, tokenState(src).expiresAt)

    mk(path.join(HOME, 'accounts', 'acct'), 0) // CLI가 인증 실패 뒤 0을 박은 모양
    const r4 = saveBack(src, HOME)
    t('T4 낡은(0) 자격증명은 안 되돌린다', r4.saved === false, r4.why)
    t('T4b 원본 무손상', tokenState(src).msLeft > 5_400_000)

    const r5 = saveBack(path.join(os.homedir(), '.agentcodegui', 'accounts', 'whoever'), HOME)
    t('T5 실홈은 무조건 거부', r5.saved === false && /실홈/.test(r5.why), r5.why)

    fs.rmSync(root, { recursive: true, force: true })
    console.log(bad === 0 ? 'PASS — 0건' : `FAIL — ${bad}건`)
    process.exit(bad === 0 ? 0 : 1)
  }
}
