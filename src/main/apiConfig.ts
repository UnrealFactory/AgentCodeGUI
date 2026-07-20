import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { safeStorage } from 'electron'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'
import type { ApiConfigStatus } from '@shared/protocol'

// API 키 과금 설정 — 키·예산·누적 사용액을 앱 홈에 보관한다. 키는 가능하면
// safeStorage(Windows DPAPI)로 암호화해 저장하고(enc:true), 암호화를 못 쓰는
// 환경에서만 평문으로 남긴다(enc:false — 상태에 그대로 드러나므로 UI가 경고 가능).
// 키 원문은 이 모듈 밖(특히 렌더러)으로 절대 나가지 않는다 — 엔진이 실행 직전
// getApiKey()로 읽어 하위 CLI의 환경변수(ANTHROPIC_API_KEY)로만 주입한다.
const CONFIG_PATH = path.join(APP_HOME, 'api-config.json')

interface StoredConfig {
  key?: string // base64(safeStorage 암호문) 또는 평문(enc:false일 때)
  enc?: boolean // key가 safeStorage로 암호화됐는지
  keyTail?: string // 표시용 끝 4자리 (복호화 없이 상태 조회)
  budgetUsd?: number | null
  spentUsd?: number
  // OpenAI(Codex) API 키 — Anthropic 키와 같은 저장 규칙(암호화·끝 4자리).
  // 예산은 Anthropic 전용 — Codex는 실행 비용을 보고하지 않아 차감이 불가능하다.
  openaiKey?: string
  openaiEnc?: boolean
  openaiKeyTail?: string
  // 시스템 환경변수 ANTHROPIC_API_KEY 확인 카드의 답 — 키 지문(sha256 앞 12자)별.
  // 'api'=이 키로 과금 계속, 'sub'=키를 걷어내고 구독. 키 원문은 저장하지 않고,
  // 키가 바뀌면 지문이 달라져 자연히 다시 묻는다.
  envKeyChoices?: Record<string, 'api' | 'sub'>
}

function readConfig(): StoredConfig {
  try {
    const v = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return v && typeof v === 'object' ? (v as StoredConfig) : {}
  } catch {
    return {}
  }
}

function writeConfig(cfg: StoredConfig): void {
  fs.mkdirSync(APP_HOME, { recursive: true })
  writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

/** 렌더러용 스냅샷 — 키 원문 대신 존재 여부 + 끝 4자리만. */
export function apiConfigStatus(): ApiConfigStatus {
  const cfg = readConfig()
  return {
    hasKey: !!cfg.key,
    keyTail: cfg.key ? (cfg.keyTail ?? null) : null,
    budgetUsd: typeof cfg.budgetUsd === 'number' ? cfg.budgetUsd : null,
    spentUsd: typeof cfg.spentUsd === 'number' ? cfg.spentUsd : 0,
    hasOpenaiKey: !!cfg.openaiKey,
    openaiKeyTail: cfg.openaiKey ? (cfg.openaiKeyTail ?? null) : null
  }
}

// 저장 규칙 한 벌 — Anthropic('key')과 OpenAI('openaiKey')가 같은 절차를 쓴다
function encodeKey(trimmed: string): { value: string; enc: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { value: safeStorage.encryptString(trimmed).toString('base64'), enc: true }
  }
  return { value: trimmed, enc: false }
}
function decodeKey(value: string | undefined, enc: boolean | undefined): string | null {
  if (!value) return null
  if (!enc) return value
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    // 다른 OS 계정/머신에서 복사된 파일 등 — 복호화 불가면 키 없음으로 취급
    return null
  }
}

/** API 키 저장. safeStorage 가용 시 암호화, 아니면 평문(enc:false)으로 기록. */
export function setApiKey(key: string): void {
  const trimmed = key.trim()
  if (!trimmed) return
  const cfg = readConfig()
  const { value, enc } = encodeKey(trimmed)
  cfg.key = value
  cfg.enc = enc
  cfg.keyTail = trimmed.slice(-4)
  writeConfig(cfg)
}

export function clearApiKey(): void {
  const cfg = readConfig()
  delete cfg.key
  delete cfg.enc
  delete cfg.keyTail
  writeConfig(cfg)
}

/** 저장된 API 키 원문 (없거나 복호화 실패 시 null). 엔진의 env 주입 전용. */
export function getApiKey(): string | null {
  const cfg = readConfig()
  return decodeKey(cfg.key, cfg.enc)
}

/** OpenAI API 키 저장 — Codex 실행의 API 모드(auth.json 물질화)에 쓰인다. */
export function setOpenaiApiKey(key: string): void {
  const trimmed = key.trim()
  if (!trimmed) return
  const cfg = readConfig()
  const { value, enc } = encodeKey(trimmed)
  cfg.openaiKey = value
  cfg.openaiEnc = enc
  cfg.openaiKeyTail = trimmed.slice(-4)
  writeConfig(cfg)
}

export function clearOpenaiApiKey(): void {
  const cfg = readConfig()
  delete cfg.openaiKey
  delete cfg.openaiEnc
  delete cfg.openaiKeyTail
  writeConfig(cfg)
}

/** 저장된 OpenAI API 키 원문 (없거나 복호화 실패 시 null). Codex 엔진 전용. */
export function getOpenaiApiKey(): string | null {
  const cfg = readConfig()
  return decodeKey(cfg.openaiKey, cfg.openaiEnc)
}

// ── 환경변수 ANTHROPIC_API_KEY 확인 ──────────────────────────────
// 헤드리스 CLI는 전역 env 키가 있으면 묻지 않고 구독 로그인보다 우선한다(실측:
// apiKeySource=ANTHROPIC_API_KEY, OAuth 무시). 그래서 엔진이 구독 실행 전에 질문
// 카드로 확인하고, 답을 여기 지문별로 기억해 같은 키면 다시 묻지 않는다.

function envKeyFp(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

/** 이 env 키에 대해 저장된 선택 (없으면 null → 질문 카드가 뜬다). */
export function envKeyChoice(key: string): 'api' | 'sub' | null {
  const v = readConfig().envKeyChoices?.[envKeyFp(key)]
  return v === 'api' || v === 'sub' ? v : null
}

export function setEnvKeyChoice(key: string, choice: 'api' | 'sub'): void {
  const cfg = readConfig()
  cfg.envKeyChoices = { ...(cfg.envKeyChoices ?? {}), [envKeyFp(key)]: choice }
  writeConfig(cfg)
}

export function setBudget(usd: number | null): void {
  const cfg = readConfig()
  cfg.budgetUsd = typeof usd === 'number' && isFinite(usd) && usd > 0 ? usd : null
  writeConfig(cfg)
}

/** API 모드 실행이 끝날 때마다 그 실행의 total_cost_usd를 누적한다. (Anthropic 전용 —
 *  Codex는 비용을 보고하지 않아 누적이 없다.) */
export function addSpend(usd: number): void {
  if (!(typeof usd === 'number' && isFinite(usd) && usd > 0)) return
  const cfg = readConfig()
  cfg.spentUsd = (typeof cfg.spentUsd === 'number' ? cfg.spentUsd : 0) + usd
  writeConfig(cfg)
}

/** 예산 초기화(0원) — 예산을 지우고 누적 사용액도 0으로. 재충전 후 기준을 새로
 *  잡을 때 초기화 → 예산 재입력 흐름으로 쓴다. */
export function resetBudget(): void {
  const cfg = readConfig()
  cfg.budgetUsd = null
  cfg.spentUsd = 0
  writeConfig(cfg)
}
