import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { APP_HOME } from '../engine/versions'
import { ueRoot } from './ue'
import { translateVerseDoc } from './verseDocKo'

/* ============================================================
 * Verse language server (Epic's verse-lsp). Unlike the other
 * servers, we can't ship or download it — it's Epic IP that
 * lives inside the `Verse.vsix` bundled with UEFN/Fortnite (or
 * an installed VS Code "Verse" extension). The user points us
 * at their own `Verse.vsix` (or a loose verse-lsp.exe) in the
 * settings; we extract/copy the Win64 binary into the app home
 * and run it from there (like VS Code copies it out of the
 * extension dir to avoid locking the original).
 *
 * Everything else the server needs — the source package, the
 * Verse/UnrealEngine API digests — is discovered automatically
 * from the project's generated `.vproject`, so the user only
 * ever supplies the one exe path.
 * ============================================================ */

const VERSE_DIR = path.join(APP_HOME, 'lsp', 'verse')
const VERSE_EXE = path.join(VERSE_DIR, 'verse-lsp.exe')
const VERSE_CONFIG = path.join(VERSE_DIR, 'config.json')
// the Win64 server binary inside the vsix (which is just a zip)
const VSIX_MEMBER = 'extension/bin/Win64/verse-lsp.exe'

interface VerseConfig {
  source?: string // the .vsix / .exe path the user picked (for display + re-prepare)
}

function readConfig(): VerseConfig {
  try {
    const v = JSON.parse(fs.readFileSync(VERSE_CONFIG, 'utf8'))
    return v && typeof v === 'object' ? (v as VerseConfig) : {}
  } catch {
    return {}
  }
}

/** The prepared, runnable server binary in the app home, or null when not configured. */
export function verseExePath(): string | null {
  try {
    return fs.existsSync(VERSE_EXE) ? VERSE_EXE : null
  } catch {
    return null
  }
}

/** The source path (vsix/exe) the user configured — for display in settings. */
export function verseSourcePath(): string | null {
  return readConfig().source ?? null
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 종료 코드 ${code}`))))
  })
}

// Pull just extension/bin/Win64/verse-lsp.exe out of a .vsix (zip) → destExe.
// Windows 10+ System32 tar (bsdtar) reads zips and can extract a single member.
async function extractVsixExe(vsix: string, destExe: string): Promise<void> {
  const tmp = path.join(VERSE_DIR, '_extract')
  await fsp.rm(tmp, { recursive: true, force: true })
  await fsp.mkdir(tmp, { recursive: true })
  const sysTar = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tar.exe')
  const tarBin = fs.existsSync(sysTar) ? sysTar : 'tar'
  const member = path.join(tmp, ...VSIX_MEMBER.split('/'))
  try {
    // single-member extract (fast; avoids unpacking the whole 14MB bundle)
    await run(tarBin, ['-xf', vsix, '-C', tmp, VSIX_MEMBER])
  } catch {
    /* fall through to a full extract */
  }
  if (!fs.existsSync(member)) {
    try {
      await run(tarBin, ['-xf', vsix, '-C', tmp])
    } catch {
      await run('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Force -LiteralPath '${vsix.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}'`
      ])
    }
  }
  if (!fs.existsSync(member)) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw new Error('이 vsix 안에서 verse-lsp.exe(Win64)를 찾지 못했어요')
  }
  await fsp.copyFile(member, destExe)
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
}

/**
 * Configure the Verse server from a user-supplied path. Accepts a `Verse.vsix`
 * (we extract the Win64 exe) or a loose `verse-lsp.exe` (we copy it). Callers must
 * stop any running verse server first so the destination isn't file-locked.
 */
export async function setVerseExe(srcPath: string): Promise<{ ok: boolean; error?: string }> {
  const p = (srcPath || '').trim().replace(/^"|"$/g, '')
  if (!p) return { ok: false, error: '경로가 비어 있어요' }
  if (process.platform !== 'win32') return { ok: false, error: 'Windows에서만 지원해요' }
  try {
    if (!fs.existsSync(p)) return { ok: false, error: '경로를 찾을 수 없어요' }
    await fsp.mkdir(VERSE_DIR, { recursive: true })
    const ext = path.extname(p).toLowerCase()
    if (ext === '.vsix') await extractVsixExe(p, VERSE_EXE)
    else if (ext === '.exe') await fsp.copyFile(p, VERSE_EXE)
    else return { ok: false, error: 'Verse.vsix 또는 verse-lsp.exe 를 지정해 주세요' }
    await fsp.writeFile(VERSE_CONFIG, JSON.stringify({ source: p } satisfies VerseConfig, null, 2))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message || '설정에 실패했어요' }
  }
}

/** Forget the configured server (delete the prepared exe + config). */
export async function clearVerseExe(): Promise<void> {
  await fsp.rm(VERSE_EXE, { force: true }).catch(() => {})
  await fsp.rm(VERSE_CONFIG, { force: true }).catch(() => {})
}

/** The UE project root (.uproject ancestor) for a .verse file, or null. */
export function verseProjectRoot(absFile: string): string | null {
  return ueRoot(path.dirname(absFile))
}

// 선언 줄 바로 위의 문서 주석을 모은다 — 연속된 `# …` 줄(과 한 줄짜리 `<# … #>`)과
// `@doc("…")` 속성. 사이의 다른 속성(@editable 등)은 건너뛰고 더 위의 주석을 계속 찾는다.
function extractVerseDoc(lines: string[], declLine: number): string {
  const out: string[] = []
  for (let i = declLine - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (t === '') break // 빈 줄 — 붙어 있지 않은 주석이므로 중단
    if (t.startsWith('@')) {
      const dm = /^@doc\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(t)
      if (dm) out.unshift(dm[1].replace(/\\(.)/g, '$1'))
      continue // 다른 속성은 건너뛰고 위쪽 주석을 계속 본다
    }
    if (t.startsWith('<#') && t.endsWith('#>')) {
      out.unshift(t.slice(2, -2).trim())
      continue
    }
    if (t.startsWith('#') && !t.startsWith('#>')) {
      out.unshift(t.replace(/^#+\s?/, ''))
      continue
    }
    break // 코드 줄 — 중단
  }
  // 호버에 보이는 최종 문구 — 한국어 보기가 켜져 있고 이 API 주석의 번역이 팩에 있으면
  // 한국어로, 없으면(유저 코드 주석·신규 API) 영어 원문 그대로. 끄면 무조건 원문.
  return translateVerseDoc(out.join('\n').trim())
}

// Verse 키워드·지정자·속성·내장 타입 용어집 — verse-lsp는 이 언어 키워드들에 호버를 주지
// 않으므로(내장 타입은 이름-only 호버만) 직접 설명을 단다. 값은 카드에 그대로 렌더되는
// 설명(마크다운)이며, `코드 용어`는 백틱으로 감싸 본문과 같은 Verse 색으로 칠해진다.
// 칩·이름 없이 설명만 보여 준다(B안).
const VERSE_GLOSSARY: Record<string, string> = {
  // 선언 키워드
  class: '객체 타입을 정의합니다. 변수에 담아도 복사되지 않고 원본을 가리키며, 상속과 메서드를 가질 수 있습니다.',
  struct: '데이터를 묶는 타입을 정의합니다. 대입하거나 넘길 때 전체가 그대로 복사되어 원본과 따로 동작하며, 상속은 하지 않습니다.',
  enum: '이름을 붙인 값들을 나열한 목록을 정의합니다.',
  interface: '어떤 메서드들을 갖춰야 하는지 정해 둔 약속입니다. 클래스가 이 약속을 받아 그 메서드들을 실제로 구현합니다.',
  module: '관련된 코드를 한데 모으는 묶음입니다. 경로 `/My.com/Game` 로 구분됩니다.',
  using: '다른 모듈의 기능을 짧은 이름으로 바로 사용할 수 있게 가져옵니다.',
  import: '다른 모듈을 가져와 지금 코드에서 사용할 수 있게 합니다.',
  // 변수·값
  var: '나중에 값을 바꿀 수 있는 변수를 만듭니다. `set` 으로 새 값을 넣을 수 있습니다.',
  set: '`var` 로 만든 변수에 새 값을 넣습니다.',
  // 흐름 제어
  if: '조건식이 성공하면 그 안의 코드를 실행합니다.',
  then: '`if` 의 조건이 성공했을 때 실행할 부분을 `then` 뒤에 적습니다.',
  else: '`if` 가 실패했을 때 대신 실행합니다.',
  for: '범위나 배열의 원소를 하나씩 돌면서 실행합니다.',
  loop: '그 안의 코드를 계속 반복하고, `break` 를 만나면 빠져나옵니다.',
  case: '값이 무엇이냐에 따라 경우를 나눠 처리합니다.',
  return: '함수를 끝내고 값을 반환합니다.',
  break: '현재 실행 중인 `loop` 나 `for` 를 즉시 멈춥니다.',
  continue: '이번 반복은 건너뛰고 다음 반복으로 넘어갑니다.',
  defer: '이 블록이 끝날 때 마지막으로 실행할 코드를 예약합니다.',
  // 동시 실행
  spawn: '비동기 함수를 별도로 실행하며, 완료를 기다리지 않고 즉시 다음으로 넘어갑니다.',
  sync: '여러 작업을 동시에 시작하고 모두 완료될 때까지 기다립니다.',
  race: '여러 작업을 동시에 시작해 가장 먼저 완료된 결과만 취하고 나머지는 중단합니다.',
  rush: '여러 작업을 동시에 시작해 먼저 완료된 결과를 취하되, 나머지는 계속 실행되게 둡니다.',
  branch: '여러 작업을 동시에 시작하되 완료를 기다리지 않습니다.',
  // 반응형·라이브 변수
  live: '값을 다른 값에 연결해, 연결된 값이 바뀌면 자동으로 다시 계산되게 합니다.',
  await: '주어진 조건이 성공할 때까지 실행을 멈추고 기다립니다.',
  upon: '조건이 처음 참이 되는 순간 한 번만 실행합니다.',
  when: '조건이 참인 동안, 관련 값이 바뀔 때마다 반응해 실행합니다.',
  batch: '여러 변경을 하나로 묶어 모두 끝난 뒤 한 번만 알립니다. 중간의 불완전한 상태를 연결된 `live` 변수가 보지 않도록 합니다.',
  // 논리·참/거짓
  and: '양쪽이 모두 성공해야 성공합니다.',
  or: '한쪽이라도 성공하면 성공합니다.',
  not: '성공과 실패를 뒤집습니다.',
  true: '참 값입니다.',
  false: '거짓 값입니다. 옵션에서 값이 없음을 나타낼 때도 사용합니다.',
  // 특수 형식
  option: '값이 있을 수도, 없을 수도 있는 옵션으로 만듭니다.',
  external: '본문이 코드가 아니라 엔진 쪽에 있다는 표시입니다.',
  block: '여러 줄을 묶어 하나의 식처럼 다루며, 마지막 줄의 값이 결과가 됩니다.',
  // 내장 타입 (LSP의 이름-only 호버를 덮어씀)
  int: '정수입니다.',
  float: '소수점이 있는 수입니다.',
  logic: '참이나 거짓 둘 중 하나를 담습니다.',
  string: '글자들이 이어진 문자열입니다.',
  void: '값이 사실상 없음을 뜻하는 타입입니다. 돌려줄 게 없는 함수의 반환형으로 사용합니다.',
  char: '글자 하나를 담습니다.',
  char32: '유니코드 코드포인트 하나를 담는 글자입니다.',
  char8: 'UTF-8 바이트 하나를 담는 글자입니다.',
  rational: '오차 없이 정확한 분수를 담습니다.',
  any: '모든 타입을 다 받는 가장 위쪽 타입입니다.',
  comparable: '서로 같은지 비교할 수 있는 타입입니다.',
  tuple: '여러 값을 한 묶음으로 담습니다.',
  type: '타입 자체를 값처럼 다룹니다. 여러 타입에 두루 적용되는 함수를 만들 때 사용합니다.',
  subtype: '어떤 타입이거나 그 자식 타입이면 받아준다는 제약입니다.',
  array: '여러 값을 순서대로 담는 배열입니다. `[]t` 로도 표기합니다.',
  map: '키로 값을 찾는 묶음입니다. `[K]V` 로도 표기합니다.',
  weak_map: '영속 저장에 주로 사용하는 특수한 맵입니다. 전체를 순회하거나 한꺼번에 읽을 수는 없고, 항목 하나씩만 다룰 수 있습니다.',
  where: '타입 자체를 매개변수로 받게 해줍니다. 어떤 타입이 들어와도 그 타입 정보를 그대로 보존합니다.',
  // 접근 범위 지정자
  public: '어디서나 사용할 수 있습니다.',
  private: '선언한 클래스나 모듈 안에서만 보이고, 그 밖에서는 사용할 수 없습니다.',
  protected: '선언한 클래스와 그 자식 클래스에서만 사용할 수 있습니다.',
  internal: '같은 모듈 안에서만 사용할 수 있습니다.',
  scoped: '어느 범위에서 사용할 수 있는지 직접 지정하는 세밀한 접근 지정자입니다. 정해진 단계 대신 허용 범위를 명시적으로 지정합니다.',
  epic_internal: 'Epic 내부에서만 사용하며 일반 코드에서는 사용할 수 없습니다.',
  // 효과 지정자
  computes: '같은 입력에는 항상 같은 결과를 주고, 함수 밖의 값은 읽지도 바꾸지도 않습니다.',
  converges: '반드시 끝나며 무한히 도는 일이 없습니다.',
  reads: '함수 밖의 값(다른 객체나 변수)을 읽습니다.',
  writes: '함수 밖의 값(다른 객체나 변수)을 바꿉니다.',
  transacts: '도중에 실패하면 그동안 바꾼 값을 자동으로 되돌립니다.',
  decides: '성공하거나 실패할 수 있는 식이고, 실패하면 그 자리에서 멈춥니다. `if` 나 `for` 같은 곳에서만 사용할 수 있습니다.',
  suspends: '실행을 잠시 멈췄다 나중에 이어서 합니다. 비동기 작업에 붙습니다.',
  varies: '같은 입력이어도 호출할 때마다 결과가 달라질 수 있습니다.',
  no_rollback: '여기서 한 일은 실패하더라도 되돌릴 수 없습니다.',
  allocates: '호출할 때마다 새 객체를 만들어, 매번 다른 값으로 취급됩니다.',
  predicts: '서버가 확정하기 전에 클라이언트가 먼저 실행합니다.',
  // 그 밖의 지정자
  native: '실제 동작이 엔진 쪽에 구현돼 있습니다.',
  native_callable: '엔진이나 블루프린트에서 호출할 수 있게 열어 둡니다.',
  override: '부모 클래스의 메서드를 새로 덮어써 다시 정의합니다.',
  final: '더 이상 덮어쓰거나 상속할 수 없게 합니다. 클래스에 붙이면 자식 클래스를, 필드·메서드에 붙이면 재정의를 막습니다.',
  final_super: '상위 클래스로 이어지는 호출 체인을 더 이상 바꿀 수 없게 고정합니다.',
  final_super_base: '`<final_super>` 의 베이스 버전으로, 상속 구조의 맨 아래에서 상위 호출 체인을 고정합니다.',
  abstract: '이것만으로는 만들 수 없고 자식 클래스가 나머지를 구현해야 합니다. 본문 없는 메서드를 선언할 수 있습니다.',
  unique: '인스턴스마다 고유해서, 두 값이 같은 객체인지 비교할 수 있습니다.',
  concrete: '모든 항목에 기본값이 있어 값을 채우지 않아도 바로 만들 수 있습니다.',
  castable: '실행 중에 타입을 확인하거나 바꿀 수 있습니다.',
  constructor: '객체를 만들어 주는 함수입니다.',
  getter: '프로퍼티 값을 읽는 통로입니다.',
  setter: '프로퍼티 값을 바꾸는 통로입니다.',
  open: '다른 모듈에서 멤버를 더 추가할 수 있습니다.',
  closed: '다른 모듈에서 멤버를 더 추가할 수 없습니다.',
  persistable: '게임을 꺼도 저장되어 남을 수 있는 타입입니다. 보통 `<final>` 과 함께 사용합니다.',
  persistent: '게임을 꺼도 저장되어 남는 데이터입니다. 보통 `<final>` 과 함께 사용합니다.',
  localizes: '여러 언어로 번역되는 글자나 메시지를 만듭니다.',
  // 엔진 내부 지정자 — 엔진 API 정의/네이티브 선언에만 나오고 일반 코드에서 직접 쓸 일이 거의 없다.
  uht_comparable: 'UnrealHeaderTool(UHT)에서 비교 가능한 타입으로 다루도록 표시하는 엔진 내부 지정자입니다. 일반 코드에서 직접 쓸 일은 거의 없습니다.',
  module_scoped_var_weak_map_key: '`weak_map` 의 키로 쓰이는 모듈 범위 변수를 표시하는 엔진 내부 지정자입니다. 일반 코드에서 직접 쓸 일은 거의 없습니다.',
  mesh_part_field: '메시 파트와 연결되는 필드를 표시하는 엔진 내부 지정자입니다. 일반 코드에서 직접 쓸 일은 거의 없습니다.',
  // 특수 이름
  super: '부모 클래스를 가리킵니다.',
  Self: '지금 이 클래스 자신을 가리킵니다.',
  // 속성(@…)
  editable: '에디터에서 값을 직접 바꿀 수 있게 노출합니다.',
  doc: '심볼에 설명 글을 답니다.',
  available: '어느 버전부터 사용할 수 있는지 표시합니다.',
  deprecated: '더 이상 권장하지 않는 기능입니다. 앞으로 제거될 수 있으니 대체 기능으로 옮기는 것이 좋습니다.',
  experimental: '아직 실험 단계라 나중에 바뀔 수 있습니다.',
  // 엔진/컴파일러 내장 속성 — 주로 엔진 API 정의에 나타나며 일반 코드에서 직접 쓸 일은 거의 없다.
  import_as: '이 심볼을 원래 어느 경로·이름으로 가져왔는지 기록하는 엔진 내부 속성입니다. 주로 엔진 API 정의에 나타나며, 일반 코드에서 직접 쓸 일은 거의 없습니다.',
  vm_no_effect_token: '가상 머신(VM)이 이 함수를 이펙트 토큰 전달 없이 호출하도록 표시하는 엔진 내부 속성입니다. 일반 코드에서 직접 쓸 일은 거의 없습니다.',
  rtfm_always_open: '생성되는 Verse API 문서에서 이 항목을 항상 펼친 상태로 보이게 하는 엔진 내부 문서화 속성입니다.',
  // 속성을 "정의"할 때 붙이는 메타 속성 — `@editable` 같은 속성의 정의 위에 달린다. 엔진 API 정의엔
  // 문서 주석이 없어 직접 설명한다(엔진/컴파일러 내장이라 일반 코드에서 새로 만들 일은 거의 없다).
  attribscope_class: '정의 중인 속성을 클래스 멤버에 붙일 수 있게 허용하는 적용 범위 표시입니다.',
  attribscope_struct: '정의 중인 속성을 구조체 멤버에 붙일 수 있게 허용하는 적용 범위 표시입니다.',
  attribscope_data: '정의 중인 속성을 데이터 정의에 붙일 수 있게 허용하는 적용 범위 표시입니다.',
  attribscope_enum: '정의 중인 속성을 `enum` 에 붙일 수 있게 허용하는 적용 범위 표시입니다.',
  attribscope_interface: '정의 중인 속성을 인터페이스에 붙일 수 있게 허용하는 적용 범위 표시입니다.',
  attribscope_module: '정의 중인 속성을 모듈에 붙일 수 있게 허용하는 적용 범위 표시입니다.',
  customattribhandler: '이 속성을 엔진이 전용 로직으로 처리한다는 표시입니다. `@editable` 같은 내장 속성을 정의할 때 씁니다.'
}

/**
 * If the token under the cursor is a Verse keyword / specifier / attribute / built-in type,
 * return our own description (B안: 칩·이름 없이 설명만). verse-lsp gives no hover for these,
 * or only a useless name-only one for built-in types, so we supply it. Returns markdown or null.
 * Every glossary key is a Verse reserved word, so it can't collide with a user identifier —
 * membership alone is enough (wordAt matches whole tokens, so `set` won't fire inside `settings`).
 */
export async function verseKeywordDoc(absFile: string, line: number, col: number, text?: string): Promise<string | null> {
  let raw: string
  try {
    raw = (text != null ? text : await fsp.readFile(absFile, 'utf8')).split(/\r?\n/)[line]
  } catch {
    return null
  }
  if (!raw) return null
  // `@attribute` (@editable, @doc, @editable_slider …). verse-lsp gives these a MISLEADING hover —
  // it resolves the DECORATED declaration that follows, so the card reads the wrong symbol
  // (`Type`/`var`/the host class). Answer first, with a proper 'attribute' card, when the caret is
  // on the '@' OR anywhere in the name. Only for KNOWN attributes (glossary + the @editable_* family)
  // so a custom user attribute still falls through to verse-lsp's real definition.
  const attr = attrAt(raw, col)
  if (attr) {
    // Object.hasOwn: keep 'toString'/'constructor' (Object.prototype keys) from matching as attrs.
    const desc = Object.hasOwn(VERSE_GLOSSARY, attr)
      ? VERSE_GLOSSARY[attr]
      : attr.startsWith('editable_')
        ? VERSE_GLOSSARY.editable
        : undefined
    if (desc) return `### attribute \`${attr}\`\n\n${desc}`
  }
  const word = wordAt(raw, col)
  // Object.hasOwn: 'constructor'·'toString' 같은 Object.prototype 키를 설명으로 잘못 잡지 않게
  return word && Object.hasOwn(VERSE_GLOSSARY, word) ? VERSE_GLOSSARY[word] : null
}

// The `@attribute` name when the caret is on an attribute token — on the '@' itself (name follows)
// or anywhere inside the name (the word's start is immediately preceded by '@'). Else null.
function attrAt(line: string, col: number): string | null {
  if (line[col] === '@') {
    const m = /^@([A-Za-z_]\w*)/.exec(line.slice(col))
    return m ? m[1] : null
  }
  const w = wordAt(line, col)
  if (!w) return null
  let a = col
  while (a > 0 && /[A-Za-z0-9_]/.test(line[a - 1])) a--
  return line[a - 1] === '@' ? w : null
}

// `?` 는 Verse의 옵션 연산자로 위치에 따라 의미가 셋이다 — verse-lsp는 호버를 안 주고 `wordAt`도
// 기호를 안 잡으므로(글로서리처럼) 직접 설명한다. VERSE_GLOSSARY와 같은 톤(설명만, B안).
const VERSE_Q_OPTION = '옵션 타입입니다. 값이 있을 수도(그 값), 없을 수도(`false`) 있습니다.'
const VERSE_Q_QUERY = '옵션에 값이 있으면 그 값을 꺼내 성공하고, 없으면 실패합니다. `if` 나 `for` 같은 실패가 허용되는 곳에서 씁니다.'
const VERSE_Q_PARAM = '기본값이 있어 생략할 수 있는 이름 매개변수입니다.'

/**
 * Hover doc for the Verse `?` option operator at (line,col). Distinguishes its three forms by the
 * adjacent characters: `expr?` (option query — preceded by an identifier/closer), `?name:` (an
 * optional NAMED parameter — `?` then a name then `:`), and `?type` (an option TYPE — anything
 * else). Returns markdown (same shape as the keyword glossary), or null when the caret isn't on `?`.
 */
export async function verseSymbolDoc(absFile: string, line: number, col: number, text?: string): Promise<string | null> {
  let raw: string
  try {
    raw = (text != null ? text : await fsp.readFile(absFile, 'utf8')).split(/\r?\n/)[line]
  } catch {
    return null
  }
  if (!raw) return null
  // the `?` at the caret, or just left of it (hovering the char right after also counts)
  const i = raw[col] === '?' ? col : raw[col - 1] === '?' ? col - 1 : -1
  if (i < 0) return null
  const hash = raw.indexOf('#') // ignore a `?` inside a line comment
  if (hash >= 0 && hash < i) return null
  // postfix `expr?` — the char immediately before is an identifier or a closing bracket
  if (/[A-Za-z0-9_)\]]/.test(raw[i - 1] ?? '')) return VERSE_Q_QUERY
  // prefix `?name…` — `?name:` (a colon that isn't `:=`) is an optional parameter; else an option type
  const m = /^\?([A-Za-z_]\w*)(\s*:(?!=))?/.exec(raw.slice(i))
  if (!m) return null
  return m[2] ? VERSE_Q_PARAM : VERSE_Q_OPTION
}

/** Doc comment immediately above the declaration at `line` in `absFile` (own code or digest).
 *  `text` (the live buffer) is used instead of disk when the declaration is in the edited file. */
export async function verseDocAt(absFile: string, line: number, text?: string): Promise<string> {
  try {
    const lines = (text != null ? text : await fsp.readFile(absFile, 'utf8')).split(/\r?\n/)
    return extractVerseDoc(lines, line)
  } catch {
    return ''
  }
}

// the identifier under a column, or null
function wordAt(line: string, col: number): string | null {
  if (col < 0 || col > line.length) return null
  let a = col
  let b = col
  const isW = (c: string): boolean => /[A-Za-z0-9_]/.test(c)
  while (a > 0 && isW(line[a - 1])) a--
  while (b < line.length && isW(line[b])) b++
  const w = line.slice(a, b)
  return /^[A-Za-z_]\w*$/.test(w) ? w : null
}

// Index just past the ')' that matches the '(' at `open` (depth-balanced), or -1. Needed because
// Verse method receivers/params nest parens — `subtype(component)`, `voice_channel(member_info)`,
// `(local:)Persona…` — which a lazy `\(([^]*?)\)` regex would cut at the first ')'.
function balancedParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i + 1
  }
  return -1
}

// The type whose body encloses `declLine` — the nearest `Name := class|struct|enum|interface` header
// above it at a SHALLOWER indent. Used to qualify a synthesized member card (`(/Type:)Field…`).
function verseEnclosingType(lines: string[], declLine: number): string | null {
  const declIndent = verseIndent(lines[declLine] ?? '')
  for (let i = declLine - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trim()
    if (!t || t.startsWith('#') || t.startsWith('@')) continue
    const tm = /^([A-Za-z_]\w*)(?:<[^>]*>|\([^()]*\))*\s*:=\s*(?:class|struct|enum|interface)\b/.exec(t)
    if (tm && verseIndent(lines[i] ?? '') < declIndent) return tm[1]
  }
  return null
}

// `@editable` / `@experimental` 등 선언 줄 바로 위의 @속성 이름들(붙어 있는 블록 안). `@doc`는
// 문서 본문으로 따로 처리하므로 제외. extractVerseDoc과 같은 위쪽 스캔 규칙(빈 줄/코드 줄에서 중단).
function verseDeclAttrs(lines: string[], declLine: number): string[] {
  const out: string[] = []
  for (let i = declLine - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trim()
    if (t === '') break
    if (t.startsWith('@')) {
      const am = /^@([A-Za-z_]\w*)/.exec(t)
      if (am && am[1] !== 'doc') out.unshift(am[1])
      continue
    }
    if (t.startsWith('#') || (t.startsWith('<#') && t.endsWith('#>'))) continue
    break // 코드 줄 — 중단
  }
  return out
}

/**
 * verse-lsp gives NO hover (nor definition) at a symbol's *declaration* site — only at its
 * uses. To fill that gap, turn the declaration line into an LSP-style signature string that
 * the renderer's parseVerseSig formats into the same card. Only fires when the hovered word
 * is the name the line declares, so it never invents a card for an unrelated token.
 * Returns a ```verse fenced markdown string, or null.
 */
export async function verseDeclHover(absFile: string, line: number, col: number, text?: string): Promise<string | null> {
  let lines: string[]
  try {
    lines = (text != null ? text : await fsp.readFile(absFile, 'utf8')).split(/\r?\n/)
  } catch {
    return null
  }
  const raw = lines[line]
  if (!raw) return null
  const word = wordAt(raw, col)
  if (!word) return null
  const s = raw.trim()
  // 선언 위의 @속성들 — verse-lsp는 사용처 호버에서 이를 `<editable>` 지정자로 접어 주지만 선언부엔
  // 호버가 없다. 같은 모양(`<attr>`)으로 sig의 이름 뒤에 실어, 카드가 사용처와 동일하게 ATTRIBUTES
  // 행을 그리게 한다(@속성/지정자 구분은 렌더러 splitVerseSpecs가 한다).
  const attrSpecs = verseDeclAttrs(lines, line)
    .map((a) => `<${a}>`)
    .join('')
  let sig: string | null = null
  let isMember = false // ②/③ are members of an enclosing type; ① is the type itself
  // ① 타입 선언: Name<specs> := class|struct|enum|interface|module<specs>(super)?
  let m = /^([A-Za-z_]\w*)((?:<[^>]*>)*)\s*:=\s*(class|struct|enum|interface|module)\b((?:<[^>]*>)*)/.exec(s)
  if (m && m[1] === word) sig = `${m[3]} ${m[1]}${m[2]}${attrSpecs}${m[4]}`
  // ② 함수/메서드: [(receiver).|(/Module:)] Name<specs>(params)<effects>:ret [= …]
  //    · 네이티브 선언은 `= 본문`이 없어 `:ret`에서 끝난다 → `=`는 선택적
  //    · 확장 메서드는 `(Recv:type …).Name…`로 시작(리시버는 떼어냄), 자유 함수는 `(/Module:)Name…`(한정자 보존)
  //    · 매개변수·리시버의 중첩 괄호를 담으려 괄호 균형으로 끊는다(정규식 불가)
  if (!sig) {
    let t = s
    let qual = '' // 보존할 모듈 한정자 (/path:)
    if (t.startsWith('(')) {
      const e = balancedParen(t, 0)
      if (e > 0 && t[e] === '.') t = t.slice(e + 1) // 확장 메서드 리시버 → 제거
      else if (e > 0 && t[1] === '/') {
        qual = t.slice(0, e)
        t = t.slice(e)
      }
    }
    const nm = /^([A-Za-z_]\w*)((?:<[^>]*>)*)\(/.exec(t)
    if (nm && nm[1] === word) {
      const pOpen = nm[0].length - 1 // '(' 위치
      const pEnd = balancedParen(t, pOpen)
      const tail = pEnd > 0 ? /^((?:<[^>]*>)*)\s*:\s*([^=]+?)\s*(?:=|$)/.exec(t.slice(pEnd)) : null
      if (pEnd > 0 && tail) {
        sig = `${qual}${nm[1]}${nm[2]}${attrSpecs}(${t.slice(pOpen + 1, pEnd - 1).trim()})${tail[1]}:${tail[2].trim()}`
        isMember = !qual // 한정자가 이미 있으면 enclosing-type 한정자를 또 붙이지 않는다
      }
    }
  }
  // ③ var / 필드: [var|set]<specs> Name<specs>:type [= value]   (':='는 ①에서 처리)
  //    엔진 API 정의는 `var<private> Name<native><public>:type`처럼 바인딩 키워드에 지정자가
  //    붙는다 — parseVerseSig는 `var `(공백)만 바인딩으로 읽으므로 키워드만 떼어 출력한다.
  if (!sig && !s.includes(':=')) {
    m = /^((?:var|set)(?:<[^>]*>)*\s+)?([A-Za-z_]\w*)((?:<[^>]*>)*)\s*:\s*([^=]+?)(?:\s*=\s*.*)?$/.exec(s)
    if (m && m[2] === word) {
      const bind = m[1] ? (/^(var|set)/.exec(m[1])?.[1] ?? '') : ''
      sig = `${bind ? bind + ' ' : ''}${m[2]}${m[3]}${attrSpecs}:${m[4].trim()}`
      isMember = true
    }
  }
  if (!sig) return null
  // verse-lsp gives no qualifier here (it returned nothing), so prepend the enclosing type as one —
  // the hover card uses it to tell a struct field / enum value from a free constant ('Struct Value').
  if (isMember) {
    const enc = verseEnclosingType(lines, line)
    if (enc) sig = `(/${enc}:)${sig}`
  }
  const doc = extractVerseDoc(lines, line) // 선언 위 문서 주석도 함께
  return '```verse\n' + sig + '\n```' + (doc ? '\n\n' + doc : '')
}

// Indentation depth in levels (tab or 4 spaces = 1 level), to tell a class-body field from a
// method-body local.
function verseIndent(line: string): number {
  let i = 0
  let lvl = 0
  for (;;) {
    if (line[i] === '\t') {
      lvl++
      i++
    } else if (line.startsWith('    ', i)) {
      lvl++
      i += 4
    } else break
  }
  return lvl
}

/**
 * Synthesize a hover card for a Verse *local variable* or *parameter* — verse-lsp gives no hover
 * for these at their declaration, and at *use* sites returns only a bare `:type` signature that
 * the renderer mislabels 'Constant'. So we run this FIRST and override: scan upward from the
 * hovered line (nearest binding wins → approximate lexical scope) for the word's binding — a
 * parameter in a single-line function header, a `var`/`set`, or a walrus/typed local. Returns a
 * `### Parameter | Local Variable | Variable \`name\`` markdown (+ a `Type:` line; `typeHint` =
 * verse-lsp's inferred type fills it for an untyped `:=` local), or null when the word is NOT a
 * param/local — including a class-body member FIELD (indentation tells it apart), which is left
 * to verse-lsp's own hover. Heuristic: multi-line signatures / shadowed names may misresolve.
 */
export async function verseLocalHover(
  absFile: string,
  line: number,
  col: number,
  typeHint?: string,
  text?: string
): Promise<string | null> {
  let lines: string[]
  try {
    lines = (text != null ? text : await fsp.readFile(absFile, 'utf8')).split(/\r?\n/)
  } catch {
    return null
  }
  const word = wordAt(lines[line] ?? '', col)
  if (!word) return null
  const card = (kind: string, type?: string): string =>
    `### ${kind} \`${word}\`` + (type && type.trim() ? `\nType: \`${type.trim()}\`` : '')
  // A binding at line bi is a class-body member field (not a local) when its indent equals the
  // body indent of the nearest enclosing class/struct/interface (= header indent + 1). Deeper
  // ⇒ inside a method ⇒ a true local. No enclosing type ⇒ treat as local (module-level binding).
  const isMethodLocal = (bi: number): boolean => {
    for (let j = bi; j >= 0; j--) {
      if (/^\s*[A-Za-z_]\w*\s*(?:<[^>]*>)*\s*:=\s*(?:class|struct|interface)\b/.test(lines[j] ?? '')) {
        return verseIndent(lines[bi]) > verseIndent(lines[j]) + 1
      }
    }
    return true
  }
  for (let i = line; i >= 0; i--) {
    const t = (lines[i] ?? '').trim()
    // parameter — single-line function-definition header `Name(… word : type …)<effects>:ret =`
    const fh = /^[A-Za-z_]\w*(?:<[^>]*>)*\s*\(([\s\S]*?)\)(?:<[^>]*>)*\s*:[^=]*=/.exec(t)
    if (fh) {
      const pm = new RegExp(`(?:^|[(,]\\s*)\\??\\s*${word}\\s*:\\s*([^,)]+)`).exec('(' + fh[1])
      if (pm) return card('Parameter', pm[1])
    }
    // `var` declaration — local only when inside a method body (else it's a member field →
    // verse-lsp). NOTE: `set X = …` is a re-assignment, not a declaration, so it's excluded — we
    // keep scanning up to the real `var X` decl (field or local) and label by that.
    const vm = new RegExp(`^var\\s+${word}\\b\\s*(?::\\s*([^=]+?))?\\s*(?:=|$)`).exec(t)
    if (vm) return isMethodLocal(i) ? card('Variable', vm[1] || typeHint) : null
    // walrus local — `word := …` at statement start or in `if (word := …)` / `for (word := …)`.
    // EXCEPT a type definition `word := class|struct|enum|interface|module` — that's a TYPE, not a
    // local; stop here so the hover falls through to the real kind detection (Enum/Struct/Class…).
    if (new RegExp(`(?:^|[(,]\\s*)\\??${word}\\s*:=`).test(t)) {
      if (/:=\s*(?:class|struct|enum|interface|module)\b/.test(t)) break
      return isMethodLocal(i) ? card('Local Variable', typeHint) : null
    }
    // for-loop iteration variable — `for (Player : coll)`, `for (A : x, B : y)`, `for (K -> V : map)`.
    // Bound with a bare `:` (or as a map key before `->`), so the walrus/typed-local branches miss it
    // and it falls through to verse-lsp's raw use-site card — a confusing 'constant'/`<internal>`, plus
    // verseDefInfo grabbing the comment ABOVE the `for` line as its "doc". Label it a loop-scoped local
    // instead, typed by verse-lsp's inferred element type (the `:` here binds the COLLECTION, not the
    // element type, so we can't read it off the line). No bogus doc — verseLocalHover attaches none.
    if (/\bfor\s*\(/.test(t)) {
      const re = new RegExp(`[(,]\\s*${word}\\s*->|(?:[(,]|->)\\s*${word}\\s*:(?!=)`)
      if (re.test(t)) return isMethodLocal(i) ? card('Local Variable', typeHint) : null
    }
    // typed local/field statement — `word : type = …`
    const tm = new RegExp(`^${word}\\s*:\\s*([^=]+?)\\s*=`).exec(t)
    if (tm) return isMethodLocal(i) ? card('Local Variable', tm[1]) : null
  }
  return null
}

interface VprojectPkg {
  name: string
  dirPath: string
}

// Parse a .vproject manifest → its package dirPaths (source + digest packages).
function parseVproject(file: string): VprojectPkg[] | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      packages?: { desc?: { name?: string; dirPath?: string } }[]
    }
    const pkgs = (j.packages ?? [])
      .map((p) => ({ name: p.desc?.name ?? '', dirPath: p.desc?.dirPath ?? '' }))
      .filter((p) => p.dirPath)
    return pkgs.length ? pkgs : null
  } catch {
    return null
  }
}

// Find the project's generated .vproject under <root>/Saved/VerseProject. Prefers the
// one named after the .uproject (the project's own manifest), else the first that parses.
function findVproject(root: string): string | null {
  const base = path.join(root, 'Saved', 'VerseProject')
  let uprojName = ''
  try {
    const u = fs.readdirSync(root).find((n) => n.toLowerCase().endsWith('.uproject'))
    if (u) uprojName = u.slice(0, -'.uproject'.length)
  } catch {
    /* ignore */
  }
  // deterministic path first: Saved/VerseProject/<name>/vproject/<name>.vproject
  if (uprojName) {
    const det = path.join(base, uprojName, 'vproject', `${uprojName}.vproject`)
    if (fs.existsSync(det)) return det
  }
  // fallback: scan <base>/*/vproject/*.vproject and take the first valid one
  try {
    for (const proj of fs.readdirSync(base)) {
      const vdir = path.join(base, proj, 'vproject')
      let files: string[] = []
      try {
        files = fs.readdirSync(vdir)
      } catch {
        continue
      }
      const v = files.find((n) => n.toLowerCase().endsWith('.vproject'))
      if (v && parseVproject(path.join(vdir, v))) return path.join(vdir, v)
    }
  } catch {
    /* no VerseProject folder — project files not generated yet */
  }
  return null
}

// Fallback folder source: the UEFN-generated `*.code-workspace` in the project root. It lists
// the exact multi-root set VS Code opens — the source package, the Assets/vproject dirs, and the
// Verse/UnrealEngine/Fortnite API digests — each with its REAL absolute path. UEFN keeps the
// generated `.vproject` under a GLOBAL `%LOCALAPPDATA%\UnrealEditorFortnite\Saved\VerseProject`,
// which findVproject (scanning only <root>/Saved/VerseProject) can't reach, so for those projects
// this file is the only way to hand verse-lsp its digest folders. (Same file the explorer's
// "Verse API" group reads.) Returns null when there's no such file.
function verseCodeWorkspaceFolders(root: string): { uri: string; name: string }[] | null {
  let files: string[]
  try {
    files = fs.readdirSync(root).filter((n) => n.toLowerCase().endsWith('.code-workspace'))
  } catch {
    return null
  }
  for (const n of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, n), 'utf8')) as {
        folders?: { name?: string; path?: string }[]
      }
      const seen = new Set<string>()
      const out: { uri: string; name: string }[] = []
      for (const f of j.folders ?? []) {
        if (!f.path) continue
        let abs: string
        try {
          abs = path.resolve(root, f.path) // workspace paths may be relative to the .code-workspace dir
          if (!fs.existsSync(abs)) continue
        } catch {
          continue
        }
        const key = abs.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ uri: pathToFileURL(abs).href, name: f.name || path.basename(abs) })
      }
      if (out.length) return out
    } catch {
      // malformed workspace file — try the next one
    }
  }
  return null
}

/**
 * The multi-root workspace folders verse-lsp needs: the vproject folder (so the server
 * discovers the manifest) plus every package dirPath it declares (the user's source and
 * the Verse/UnrealEngine API digests). Prefers a local `.vproject`; when none is reachable
 * (UEFN keeps the generated manifest in a global Saved/VerseProject), falls back to the
 * project's `*.code-workspace`, which lists the same folders with absolute paths. Returns
 * null only when neither exists — the project hasn't generated Verse files yet, so navigation
 * can't resolve and we stay colour-only.
 */
export function verseWorkspaceFolders(root: string): { uri: string; name: string }[] | null {
  const vproj = findVproject(root)
  const pkgs = vproj ? parseVproject(vproj) : null
  if (vproj && pkgs) {
    const seen = new Set<string>()
    const out: { uri: string; name: string }[] = []
    const add = (dir: string, name: string): void => {
      if (!dir) return
      let abs: string
      try {
        abs = path.resolve(dir)
        if (!fs.existsSync(abs)) return
      } catch {
        return
      }
      const key = abs.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      out.push({ uri: pathToFileURL(abs).href, name })
    }
    add(path.dirname(vproj), 'vproject')
    for (const p of pkgs) add(p.dirPath, p.name)
    if (out.length) return out
  }
  // No reachable local .vproject — try the UEFN-written *.code-workspace (global digest paths).
  return verseCodeWorkspaceFolders(root)
}
