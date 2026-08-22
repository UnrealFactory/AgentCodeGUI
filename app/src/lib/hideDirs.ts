// 탐색기에서 숨길 폴더·파일 프리셋 — bin·obj·Saved 같은 빌드/생성물 폴더와 Thumbs.db 같은
// 잡동사니 파일을 트리에서 감춰 소스에 집중하게 한다. 전역 설정(설정 › Explorer)이라 프로젝트별이
// 아니라 앱 전체에 적용되고, ui-prefs.json에 저장된다. 설정 화면(관리 UI)과 탐색기(소비자)가
// 이 한 곳을 공유하고, 탐색기 트리 우클릭 '숨김 목록에 추가'도 여기로 넣는다.
//
// 목록은 두 벌로 나뉜다 — 폴더 목록은 '폴더만', 파일 목록은 '파일만' 매칭한다. 한 목록에 합치면
// 숨김 폴더와 같은 이름의 파일(예: 확장자 없는 'Saved')까지 사라지는 부작용이 생겨서다.
//
// 매칭은 main/files.ts의 makeExcluder가 담당한다: 이름은 대소문자 구분 없이 basename 기준,
// 슬래시 없는 '순수 이름'은 "어느 깊이든 그 이름이면 숨김"으로 동작하고(예: 여러 하위 프로젝트의
// bin/obj를 한 번에), `*.uasset` 같은 와일드카드 패턴도 받는다. 숨겨도 파일 자체는 그대로고
// 에이전트는 접근할 수 있다 — 보기만 정리.
import { getPref, setPref } from './prefs'

// 기본 숨김 목록 — .NET·언리얼·웹·파이썬의 흔한 빌드/생성물·의존성·VCS 폴더. 편집한 설정을
// 저장한 적이 없으면 이 목록이 그대로 쓰인다. .github/.claude/.vscode처럼 사람이 직접 여는
// 설정 폴더는 일부러 뺐다.
export const DEFAULT_HIDE_DIRS = [
  // 버전 관리·에디터 캐시
  '.git', '.svn', '.hg', '.idea', '.vs',
  // 의존성
  'node_modules', 'vendor', 'Pods',
  // 빌드 산출물 (웹/JS)
  'dist', 'out', 'build', 'coverage', '.next', '.nuxt', '.turbo', '.cache', '.vite',
  // .NET / C# (Visual Studio · Rider) — 빌드·테스트·분석 생성물
  'bin', 'obj', 'Properties', 'TestResults', 'artifacts', 'BenchmarkDotNet.Artifacts', '.sonarqube',
  // C/C++ 빌드 구성 출력 (Visual Studio) — 프로젝트 루트에 바로 생기는 Debug/Release·플랫폼 폴더
  'Debug', 'Release', 'x64', 'x86', 'Win32', 'Win64', 'ipch',
  // Unreal Engine — 엔진 생성물 + 바이너리 에셋(Content: .uasset/.umap는 코드로 못 여니 기본 숨김).
  // 코드/설정인 Config·Source·Plugins는 그대로 보인다.
  'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', 'Cooked', 'StagedBuilds', 'Content',
  // Python
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
  // 기타 빌드
  'target', '.gradle'
]

// 기본 숨김 파일 목록 — OS가 흘리는 잡동사니만. 빌드 생성물 파일(*.uasset 등)은 대부분
// 폴더 단위(Content·bin·obj)로 이미 가려지니 기본값은 보수적으로 잡았다 — 필요하면 설정
// (이름·*.확장자 패턴)이나 트리 우클릭('숨김 목록에 추가' — 이름)으로 더한다.
export const DEFAULT_HIDE_FILES = ['.DS_Store', 'Thumbs.db', 'desktop.ini']

const ENABLED_KEY = 'explorer.hideEnabled'
const DIRS_KEY = 'explorer.hideDirs'
const FILES_KEY = 'explorer.hideFiles'
// 설정에서 목록/토글을 바꾸면 이 이벤트로 알려, 열려 있는 탐색기가 트리를 조용히 다시 읽는다.
const EVENT = 'explorer-hide-changed'

/** 숨김 기능 자체가 켜져 있는가 (기본 켜짐). */
export function getHideEnabled(): boolean {
  return getPref<boolean>(ENABLED_KEY, true)
}

/** 사용자가 관리하는 숨김 폴더 이름 목록 (설정하지 않았으면 기본값). */
export function getHideDirs(): string[] {
  return getPref<string[]>(DIRS_KEY, DEFAULT_HIDE_DIRS)
}

/** 사용자가 관리하는 숨김 파일 이름·패턴 목록 (설정하지 않았으면 기본값). */
export function getHideFiles(): string[] {
  return getPref<string[]>(FILES_KEY, DEFAULT_HIDE_FILES)
}

/** 지금 실제로 제외할 이름들 — 꺼져 있으면 빈 배열. 탐색기가 이걸 exclude로 넘긴다. */
export function getActiveHideDirs(): string[] {
  return getHideEnabled() ? getHideDirs() : []
}

export function setHideEnabled(v: boolean): void {
  setPref(ENABLED_KEY, v)
  emitHideChanged()
}

export function setHideDirs(list: string[]): void {
  setPref(DIRS_KEY, list)
  emitHideChanged()
}

export function setHideFiles(list: string[]): void {
  setPref(FILES_KEY, list)
  emitHideChanged()
}

/**
 * 이름 목록 → "이 basename이 숨김 대상인가" 판정 함수 — main/files.ts의 makeExcluder와
 * 같은 규칙(대소문자 무시, `*`/`?` 와일드카드, 슬래시 있으면 basename만)의 렌더러 사본.
 * 탐색기 '파일 검색' 결과가 트리와 같은 항목을 숨기려면 렌더러에서도 판정해야 하는데,
 * main 쪽 모듈은 node API에 묶여 못 가져와서 규칙을 복제한다. 빈 목록이면 null.
 */
export function makeNameMatcher(patterns: string[]): ((name: string) => boolean) | null {
  if (!patterns.length) return null
  const exact = new Set<string>()
  const regexes: RegExp[] = []
  for (const raw of patterns) {
    let p = (raw || '').trim()
    if (p.startsWith('**/')) p = p.slice(3)
    if (p.includes('/')) p = p.slice(p.lastIndexOf('/') + 1)
    if (!p) continue
    if (p.includes('*') || p.includes('?')) {
      const re = '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      try {
        regexes.push(new RegExp(re, 'i'))
      } catch {
        /* skip an unparseable glob */
      }
    } else {
      exact.add(p.toLowerCase())
    }
  }
  return (name) => exact.has(name.toLowerCase()) || regexes.some((re) => re.test(name))
}

export function emitHideChanged(): void {
  window.dispatchEvent(new Event(EVENT))
}

/** 변경 구독 — 반환한 함수를 호출하면 해제. */
export function onHideChanged(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}
