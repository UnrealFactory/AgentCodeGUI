import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { computeLineDiff, newFileDiff } from './claude/diff'
import { loadActiveQuery } from './engine/versions'
import { accountRunDir, defaultAccountEmail } from './auth'
import { envKeyChoice } from './apiConfig'
import type {
  EffortId,
  FileDiff,
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitFileDiffResult,
  GitLogResult,
  GitResult,
  GitStatus,
  ModelId
} from '@shared/protocol'

/**
 * Git — 시스템 git CLI 호출(`git -C <root>`). 번들 걱정 없는 얇은 래퍼로,
 * status는 --porcelain=v2 -z(로케일·인용에 안 흔들리는 기계 출력 + NUL 구분이라
 * 한글 경로 그대로), diff는 뷰어 계약(전체 파일·LF — computeLineDiff 재사용)을 지킨다.
 * 작업 폴더가 저장소 하위 폴더여도 루트(toplevel)를 찾아 그 기준으로 동작한다.
 */

const exec = (
  root: string,
  args: string[],
  opts?: { maxBuffer?: number }
): Promise<{ ok: boolean; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { maxBuffer: opts?.maxBuffer ?? 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' })
    )
  })

// git 에러는 stderr가 본문 — 렌더러 한 줄 표시용으로 다듬는다 (fatal: 접두 제거)
function errLine(stderr: string, stdout = ''): string {
  const raw = (stderr || stdout || '').trim()
  const first = raw.split('\n').find((l) => l.trim()) ?? '알 수 없는 오류'
  return first.replace(/^fatal:\s*/i, '').replace(/^error:\s*/i, '').trim() || '알 수 없는 오류'
}

const NOT_REPO: GitStatus = {
  repo: false,
  root: '',
  branch: '',
  detached: false,
  ahead: 0,
  behind: 0,
  upstream: null,
  hasRemote: false,
  files: []
}

/** 저장소 루트(toplevel) — git 미설치·저장소 아님이면 null. */
async function repoRoot(cwd: string): Promise<string | null> {
  if (!cwd) return null
  const r = await exec(cwd, ['rev-parse', '--show-toplevel'])
  if (!r.ok) return null
  const root = r.stdout.trim()
  return root ? path.resolve(root) : null
}

// 루트 밖으로 못 나가게 — git이 준 rel(포워드 슬래시)을 안전하게 절대 경로로
function absOf(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

// porcelain v2의 XY(index·worktree) 한 쌍 → 표시용 상태 문자 하나로 접기.
// 스테이징 개념을 UI에 안 쓰므로 "워크트리 우선, 없으면 index" — R(개명)은 어느 쪽이든 R.
function collapseXY(xy: string): 'M' | 'A' | 'D' | 'R' {
  const x = xy[0] ?? '.'
  const y = xy[1] ?? '.'
  if (x === 'R' || y === 'R') return 'R'
  const c = y !== '.' ? y : x
  if (c === 'A' || c === 'C') return 'A'
  if (c === 'D') return 'D'
  return 'M' // M·T·기타 → 수정
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const root = await repoRoot(cwd)
  if (!root) return NOT_REPO
  const [st, remotes] = await Promise.all([
    exec(root, ['status', '--porcelain=v2', '--branch', '-z']),
    exec(root, ['remote'])
  ])
  if (!st.ok) return NOT_REPO
  const out: GitStatus = {
    repo: true,
    root,
    branch: '',
    detached: false,
    ahead: 0,
    behind: 0,
    upstream: null,
    hasRemote: remotes.ok && remotes.stdout.trim().length > 0,
    files: []
  }
  const toks = st.stdout.split('\0')
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (!t) continue
    if (t.startsWith('# branch.head ')) {
      const h = t.slice('# branch.head '.length)
      out.detached = h === '(detached)'
      out.branch = out.detached ? 'HEAD 분리됨' : h
    } else if (t.startsWith('# branch.upstream ')) {
      out.upstream = t.slice('# branch.upstream '.length)
    } else if (t.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(t)
      if (m) {
        out.ahead = parseInt(m[1], 10)
        out.behind = parseInt(m[2], 10)
      }
    } else if (t.startsWith('1 ')) {
      const m = /^1 (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(t)
      if (m) out.files.push({ path: m[2], status: collapseXY(m[1]) })
    } else if (t.startsWith('2 ')) {
      // 개명 — 원래 경로는 다음 NUL 토큰
      const m = /^2 (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(t)
      const orig = toks[++i]
      if (m) out.files.push({ path: m[2], status: 'R', renamedFrom: orig || undefined })
    } else if (t.startsWith('u ')) {
      const m = /^u (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(t)
      if (m) out.files.push({ path: m[2], status: 'U' })
    } else if (t.startsWith('? ')) {
      out.files.push({ path: t.slice(2), status: 'A', untracked: true })
    }
  }
  out.files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))
  return out
}

const FS = '\x1f' // log 필드 구분자 — 커밋 메시지에 나올 수 없는 unit separator

export async function gitLog(cwd: string, limit = 200, skip = 0): Promise<GitLogResult> {
  const root = await repoRoot(cwd)
  if (!root) return { commits: [], hasMore: false }
  const fmt = `%H${FS}%h${FS}%P${FS}%an${FS}%at${FS}%D${FS}%s`
  // limit+1로 한 장 더 받아 다음 페이지 유무를 안다
  const r = await exec(root, ['log', `--pretty=format:${fmt}`, `-n${limit + 1}`, `--skip=${skip}`, 'HEAD'])
  if (!r.ok) return { commits: [], hasMore: false }
  // 업스트림에 아직 없는 커밋 집합 — '푸시 안 됨' 점 표시용 (업스트림 없으면 표시 안 함)
  const unpushed = new Set<string>()
  const up = await exec(root, ['rev-list', '@{upstream}..HEAD'])
  if (up.ok) for (const h of up.stdout.split('\n')) if (h.trim()) unpushed.add(h.trim())
  const rows = r.stdout.split('\n').filter((l) => l.includes(FS))
  const hasMore = rows.length > limit
  const commits: GitCommit[] = rows.slice(0, limit).map((line) => {
    const [hash, shortHash, parents, author, at, refs, subject] = line.split(FS)
    return {
      hash,
      shortHash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      time: parseInt(at, 10) || 0,
      refs: refs
        ? refs
            .split(', ')
            .map((s) => s.replace(/^HEAD -> /, '').trim())
            .filter((s) => s && s !== 'HEAD')
        : [],
      subject: subject ?? '',
      unpushed: unpushed.has(hash)
    }
  })
  return { commits, hasMore }
}

// ── diff — 뷰어 계약(전체 파일·LF·whole)을 computeLineDiff 재사용으로 지킨다 ──

const MAX_DIFF_BYTES = 1_500_000 // 한쪽 1.5MB 초과·바이너리는 diff 표시 포기 (뷰어 멈춤 방지)

function looksBinary(s: string): boolean {
  return s.includes('\0')
}

async function showAt(root: string, rev: string, rel: string): Promise<string | null> {
  const r = await exec(root, ['show', `${rev}:${rel}`])
  return r.ok ? r.stdout : null
}

function buildFileDiff(rel: string, base: string | null, cur: string | null): GitFileDiffResult {
  if ((base && base.length > MAX_DIFF_BYTES) || (cur && cur.length > MAX_DIFF_BYTES))
    return { diff: null, error: '파일이 너무 커요 — diff 표시는 1.5MB까지만' }
  if ((base && looksBinary(base)) || (cur && looksBinary(cur)))
    return { diff: null, error: '바이너리 파일 — diff를 표시할 수 없어요' }
  if (base == null && cur == null) return { diff: null, error: '내용을 읽을 수 없어요' }
  let diff: FileDiff
  if (base == null || base === '') {
    const d = newFileDiff(cur ?? '')
    diff = { path: rel, tag: 'new', add: d.add, del: 0, lines: d.lines }
  } else {
    const d = computeLineDiff(base, cur ?? '')
    diff = { path: rel, tag: 'edit', add: d.add, del: d.del, lines: d.lines }
  }
  return { diff }
}

/** 워킹트리 파일 diff — HEAD ↔ 디스크. 새 파일(HEAD에 없음)은 전체 추가. */
export async function gitFileDiff(cwd: string, rel: string): Promise<GitFileDiffResult> {
  const root = await repoRoot(cwd)
  if (!root) return { diff: null, error: 'Git 저장소가 아니에요' }
  const abs = absOf(root, rel)
  if (!abs) return { diff: null, error: '잘못된 경로' }
  const base = await showAt(root, 'HEAD', rel)
  let cur: string | null = null
  try {
    cur = await fs.promises.readFile(abs, 'utf8')
  } catch {
    cur = null // 삭제된 파일
  }
  if (cur == null && base == null) return { diff: null, error: '내용을 읽을 수 없어요' }
  const d = buildFileDiff(rel, base, cur ?? '')
  // 디스크에서 지워진 파일 — 뷰어가 읽을 게 없으니 HEAD 스냅샷을 같이 준다
  if (cur == null && base != null && !looksBinary(base) && base.length <= MAX_DIFF_BYTES) d.headContent = base
  return d
}

/** 커밋 상세 — 메타(제목·본문·작성자·시각) + 바뀐 파일 목록(상태). */
export async function gitCommitDetail(cwd: string, hash: string): Promise<GitCommitDetail | null> {
  const root = await repoRoot(cwd)
  if (!root || !/^[0-9a-f]{4,40}$/i.test(hash)) return null
  const fmt = `%H${FS}%h${FS}%an${FS}%at${FS}%s${FS}%b`
  const [meta, names] = await Promise.all([
    exec(root, ['log', '-1', `--pretty=format:${fmt}`, hash]),
    // -z: 상태와 경로가 NUL로 번갈아 온다 (R은 status·old·new 3연속)
    exec(root, ['show', '--name-status', '--format=', '-z', hash])
  ])
  if (!meta.ok) return null
  const [full, shortHash, author, at, subject, body] = meta.stdout.split(FS)
  const files: GitCommitFile[] = []
  const toks = names.ok ? names.stdout.split('\0') : []
  for (let i = 0; i < toks.length; i++) {
    const st = toks[i]
    if (!st) continue
    const c = st[0]
    if (c === 'R' || c === 'C') {
      const from = toks[++i]
      const to = toks[++i]
      if (to) files.push({ path: to, status: 'R', renamedFrom: from })
    } else {
      const p = toks[++i]
      if (p) files.push({ path: p, status: c === 'A' ? 'A' : c === 'D' ? 'D' : 'M' })
    }
  }
  return {
    hash: full,
    shortHash,
    author,
    time: parseInt(at, 10) || 0,
    subject: subject ?? '',
    body: (body ?? '').trim(),
    files
  }
}

/** 커밋 시점 파일 — 뷰어 override용: 그 시점 내용 + 부모 대비 diff. 삭제 파일은 내용 ''. */
export async function gitCommitFileDiff(
  cwd: string,
  hash: string,
  rel: string
): Promise<GitFileDiffResult & { content: string | null }> {
  const root = await repoRoot(cwd)
  if (!root || !/^[0-9a-f]{4,40}$/i.test(hash)) return { diff: null, content: null, error: 'Git 저장소가 아니에요' }
  const [base, cur] = await Promise.all([showAt(root, `${hash}^`, rel), showAt(root, hash, rel)])
  const d = buildFileDiff(rel, base, cur ?? '')
  return { ...d, content: cur ?? '' }
}

// ── 쓰기 동작 — 전부 {ok, error} 한 모양으로 돌려 카드가 그대로 보여준다 ──

/** 고른 파일만 커밋 — add(그 경로만) 후 commit. 스테이징 용어는 UI에 없다. */
export async function gitCommit(cwd: string, files: string[], subject: string, body: string): Promise<GitResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'Git 저장소가 아니에요' }
  if (!files.length) return { ok: false, error: '커밋할 파일이 없어요' }
  if (!subject.trim()) return { ok: false, error: '커밋 메시지를 입력해 주세요' }
  const add = await exec(root, ['add', '-A', '--', ...files])
  if (!add.ok) return { ok: false, error: errLine(add.stderr) }
  const args = ['commit', '-m', subject.trim()]
  if (body.trim()) args.push('-m', body.trim())
  const r = await exec(root, args)
  if (!r.ok) {
    // 커밋이 거부되면(훅·identity 미설정 등) 방금 올린 스테이징을 되돌려 상태를 원래대로
    await exec(root, ['reset', '--', ...files])
    const e = r.stderr + r.stdout
    if (/user\.(name|email)/i.test(e))
      return { ok: false, error: 'git 사용자 정보가 없어요 — 터미널에서 git config --global user.name / user.email을 설정해 주세요' }
    return { ok: false, error: errLine(r.stderr, r.stdout) }
  }
  return { ok: true }
}

export async function gitPush(cwd: string): Promise<GitResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'Git 저장소가 아니에요' }
  const st = await gitStatus(root)
  // 업스트림이 없으면 첫 푸시 — origin에 현재 브랜치를 만든다
  const args = st.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']
  if (!st.hasRemote) return { ok: false, error: '원격 저장소(remote)가 없어요 — git remote add origin <url> 후 다시' }
  const r = await exec(root, args)
  return r.ok ? { ok: true } : { ok: false, error: errLine(r.stderr, r.stdout) }
}

export async function gitPull(cwd: string): Promise<GitResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'Git 저장소가 아니에요' }
  const r = await exec(root, ['pull'])
  if (!r.ok) {
    const e = r.stderr + r.stdout
    if (/CONFLICT/i.test(e)) return { ok: false, error: '병합 충돌이 났어요 — 충돌 파일을 정리한 뒤 커밋해 주세요' }
    return { ok: false, error: errLine(r.stderr, r.stdout) }
  }
  return { ok: true }
}

export async function gitFetch(cwd: string): Promise<GitResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'Git 저장소가 아니에요' }
  const r = await exec(root, ['fetch', '--prune'])
  return r.ok ? { ok: true } : { ok: false, error: errLine(r.stderr, r.stdout) }
}

/** 파일 하나 되돌리기 — 추적 파일은 HEAD로, 새(미추적) 파일은 휴지통으로(복구 가능). */
export async function gitDiscard(cwd: string, rel: string, untracked: boolean): Promise<GitResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'Git 저장소가 아니에요' }
  const abs = absOf(root, rel)
  if (!abs) return { ok: false, error: '잘못된 경로' }
  if (untracked) {
    try {
      await shell.trashItem(abs)
      return { ok: true }
    } catch {
      return { ok: false, error: '파일을 휴지통으로 보내지 못했어요' }
    }
  }
  // index에 올라가 있어도(A 포함) 한 번에 HEAD 상태로 — 스테이징·워크트리 모두 복원
  const r = await exec(root, ['checkout', 'HEAD', '--', rel])
  if (r.ok) return { ok: true }
  // HEAD에 없던(새로 add된) 파일 — 스테이징 해제 후 휴지통
  const rm = await exec(root, ['rm', '--cached', '-f', '--ignore-unmatch', '--', rel])
  if (rm.ok) {
    try {
      await shell.trashItem(abs)
      return { ok: true }
    } catch {
      return { ok: false, error: '파일을 휴지통으로 보내지 못했어요' }
    }
  }
  return { ok: false, error: errLine(r.stderr) }
}

export async function gitBranches(cwd: string): Promise<GitBranch[]> {
  const root = await repoRoot(cwd)
  if (!root) return []
  const r = await exec(root, [
    'for-each-ref',
    'refs/heads',
    '--sort=-committerdate',
    `--format=%(refname:short)${FS}%(HEAD)${FS}%(committerdate:unix)`
  ])
  if (!r.ok) return []
  return r.stdout
    .split('\n')
    .filter((l) => l.includes(FS))
    .map((l) => {
      const [name, head, at] = l.split(FS)
      return { name, current: head === '*', time: parseInt(at, 10) || 0 }
    })
}

export async function gitSwitchBranch(cwd: string, name: string): Promise<GitResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'Git 저장소가 아니에요' }
  const r = await exec(root, ['switch', name])
  if (!r.ok) {
    const e = r.stderr + r.stdout
    if (/would be overwritten|충돌|conflict/i.test(e))
      return { ok: false, error: '지금 변경과 충돌해요 — 커밋하거나 되돌린 뒤 전환해 주세요' }
    return { ok: false, error: errLine(r.stderr, r.stdout) }
  }
  return { ok: true }
}

export async function gitCreateBranch(cwd: string, name: string): Promise<GitResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'Git 저장소가 아니에요' }
  const clean = name.trim()
  if (!clean) return { ok: false, error: '브랜치 이름을 입력해 주세요' }
  const chk = await exec(root, ['check-ref-format', '--branch', clean])
  if (!chk.ok) return { ok: false, error: '브랜치 이름으로 쓸 수 없는 형식이에요' }
  const r = await exec(root, ['switch', '-c', clean])
  return r.ok ? { ok: true } : { ok: false, error: errLine(r.stderr, r.stdout) }
}

// ── AI 커밋 메시지 — 엔진 SDK 1회 헤드리스 호출(도구 없음·1턴) ──────────────

// diff 프롬프트 예산 — 컨텍스트(200k 토큰)가 아니라 속도·비용 보호용. 상한을 넘겨도
// 파일을 통째로 빼지 않고 "파일명 + 변경 규모"는 항상 넣는다(모델이 언급은 할 수 있게).
const AI_DIFF_CAP = 120_000 // 총량 상한(문자)
const AI_FILE_CAP = 24_000 // 파일 하나의 상한 — 락파일·생성물 하나가 예산을 다 먹지 않게

function serializeDiff(rel: string, diff: FileDiff): string {
  const lines: string[] = [`### ${rel} (+${diff.add} −${diff.del})`]
  for (const l of diff.lines) {
    if (l.t === 'add') lines.push('+' + l.text)
    else if (l.t === 'del') lines.push('-' + l.text)
    // ctx는 생략 — 메시지 작성엔 변경 줄이면 충분하고 프롬프트가 짧아진다
  }
  return lines.join('\n')
}

/**
 * 고른 파일들의 diff를 읽고 이 저장소의 최근 커밋 톤에 맞는 한국어 커밋 메시지를 쓴다.
 * 계정·모델·effort는 매번 카드에서 고른다 — 계정마다 남은 한도가 달라 "어느 계정으로
 * 돌릴지"가 실사용 결정이라서(이 앱의 계정 문법). 실패해도 입력창은 그대로다.
 */
export async function gitAiMessage(
  cwd: string,
  files: string[],
  opts?: { account?: string; model?: ModelId; effort?: EffortId }
): Promise<{ ok: boolean; subject?: string; body?: string; error?: string }> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'Git 저장소가 아니에요' }
  if (!files.length) return { ok: false, error: '커밋에 담긴 파일이 없어요' }
  const query = await loadActiveQuery().catch(() => null)
  if (!query) return { ok: false, error: '설치된 엔진이 없어요 — 설정 → Engine에서 먼저 설치해 주세요' }
  const email = opts?.account || defaultAccountEmail()
  if (!email) return { ok: false, error: '등록된 클로드 계정이 없어요 — 설정 → Account에서 로그인해 주세요' }
  let accountDir: string
  try {
    accountDir = accountRunDir(email)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '계정 준비에 실패했어요' }
  }

  // diff 수집 — 예산을 넘겨도 파일이 사라지진 않는다: 본문만 접고 헤더(+N −M)는 남긴다
  let diffText = ''
  for (const rel of files) {
    const d = await gitFileDiff(root, rel)
    const head = d.diff ? `### ${rel} (+${d.diff.add} −${d.diff.del})` : `### ${rel}`
    let chunk = d.diff ? serializeDiff(rel, d.diff) : `${head} (diff 본문 없음: ${d.error ?? '표시 불가'})`
    if (d.diff && chunk.length > AI_FILE_CAP) chunk = `${head} — 본문 생략(파일이 너무 큼): 규모만 참고`
    if (diffText.length + chunk.length > AI_DIFF_CAP) chunk = `${head} — 본문 생략(총량 상한): 규모만 참고`
    diffText += (diffText ? '\n\n' : '') + chunk
  }

  const recent = await exec(root, ['log', '-15', '--pretty=format:%s'])
  const tone = recent.ok && recent.stdout.trim() ? recent.stdout.trim() : ''

  // 출력은 <commit> 마커로 감싸게 한다 — "아래와 같이 제안합니다…" 같은 서두를 모델이
  // 붙여도(금지 문구로는 안 막힘, 실측) 마커 안만 취하면 제목 칸에 잡담이 못 들어간다.
  const prompt = [
    '아래 diff로 git 커밋 메시지를 작성해줘.',
    tone ? `\n[이 저장소의 최근 커밋 제목들 — 이 톤과 형식을 그대로 따라줘]\n${tone}` : '',
    '\n[출력 형식 — 아래 마커 블록 하나만 출력한다. 마커 밖에는 어떤 글자도 쓰지 마라 (인사·설명·코드펜스 금지)]',
    '<commit>',
    '제목 한 줄 (한국어, 72자 이내, 마침표 없이)',
    '',
    '(선택) 빈 줄 하나 뒤 본문 2~4줄 — 변경이 여러 갈래일 때만',
    '</commit>',
    `\n[diff]\n${diffText}`
  ].join('\n')

  // 계정 격리 env — 전역 ANTHROPIC_API_KEY는 사용자가 "API로"를 저장해둔 키만 존중,
  // 아니면 걷어내 구독으로 (본실행의 질문 카드 흐름과 같은 결론, 조용한 과금 방지)
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: accountDir }
  const envKey = process.env.ANTHROPIC_API_KEY || null
  if (envKey && envKeyChoice(envKey) !== 'api') delete env.ANTHROPIC_API_KEY

  const model: ModelId = opts?.model ?? 'sonnet'
  const effort: EffortId = opts?.effort ?? 'low'
  // 엔진의 effortToOptions와 같은 매핑 — minimal은 thinking을 끈다 (Fable은 못 끔)
  const effortOpts: Record<string, unknown> =
    effort !== 'minimal' ? { effort } : model === 'fable' ? {} : { thinking: { type: 'disabled' } }

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 90_000)
  try {
    const q = query({
      prompt,
      options: {
        cwd: root,
        model,
        ...effortOpts,
        permissionMode: 'default',
        maxTurns: 1,
        allowedTools: [], // 도구 없는 순수 1턴 — diff는 프롬프트에 이미 있다
        env,
        abortController: abort
      }
    })
    let text = ''
    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      const m = msg as { type?: string; subtype?: string; result?: string; message?: { content?: unknown } }
      if (m.type === 'result' && typeof m.result === 'string' && m.result.trim()) text = m.result
      else if (m.type === 'assistant') {
        const content = m.message?.content
        if (Array.isArray(content))
          for (const b of content)
            if (b && typeof b === 'object' && (b as { type?: string }).type === 'text')
              text = String((b as { text?: string }).text ?? text)
      }
    }
    // 마커 안만 취한다 (닫는 마커가 잘려도 허용). 마커 없이 답한 드문 경우엔
    // 코드펜스 줄만 걷어내고 전체를 폴백으로 쓴다.
    const marked = /<commit>([\s\S]*?)(?:<\/commit>|$)/i.exec(text)
    const clean = (marked ? marked[1] : text)
      .split('\n')
      .filter((l) => !/^\s*```/.test(l))
      .join('\n')
      .trim()
    if (!clean) return { ok: false, error: '메시지를 받지 못했어요 — 다시 시도해 주세요' }
    const nl = clean.indexOf('\n')
    const subject = (nl < 0 ? clean : clean.slice(0, nl)).trim()
    const body = nl < 0 ? '' : clean.slice(nl + 1).trim()
    return { ok: true, subject, body }
  } catch (e) {
    if (abort.signal.aborted) return { ok: false, error: '시간이 너무 걸려 중단했어요 — 다시 시도해 주세요' }
    return { ok: false, error: e instanceof Error ? e.message : 'AI 메시지 생성에 실패했어요' }
  } finally {
    clearTimeout(timer)
  }
}
