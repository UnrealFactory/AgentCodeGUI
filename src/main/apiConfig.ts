import path from 'node:path'
import fs from 'node:fs'
import { safeStorage } from 'electron'
import { APP_HOME } from './engine/versions'
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

/** 렌더러용 스냅샷 — 키 원문 대신 존재 여부 + 끝 4자리만. */
export function apiConfigStatus(): ApiConfigStatus {
  const cfg = readConfig()
  return {
    hasKey: !!cfg.key,
    keyTail: cfg.key ? (cfg.keyTail ?? null) : null,
    budgetUsd: typeof cfg.budgetUsd === 'number' ? cfg.budgetUsd : null,
    spentUsd: typeof cfg.spentUsd === 'number' ? cfg.spentUsd : 0
  }
}

/** API 키 저장. safeStorage 가용 시 암호화, 아니면 평문(enc:false)으로 기록. */
export function setApiKey(key: string): void {
  const trimmed = key.trim()
  if (!trimmed) return
  const cfg = readConfig()
  if (safeStorage.isEncryptionAvailable()) {
    cfg.key = safeStorage.encryptString(trimmed).toString('base64')
    cfg.enc = true
  } else {
    cfg.key = trimmed
    cfg.enc = false
  }
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
  if (!cfg.key) return null
  if (!cfg.enc) return cfg.key
  try {
    return safeStorage.decryptString(Buffer.from(cfg.key, 'base64'))
  } catch {
    // 다른 OS 계정/머신에서 복사된 파일 등 — 복호화 불가면 키 없음으로 취급
    return null
  }
}

export function setBudget(usd: number | null): void {
  const cfg = readConfig()
  cfg.budgetUsd = typeof usd === 'number' && isFinite(usd) && usd > 0 ? usd : null
  writeConfig(cfg)
}

/** API 모드 실행이 끝날 때마다 그 실행의 total_cost_usd를 누적한다. */
export function addSpend(usd: number): void {
  if (!(typeof usd === 'number' && isFinite(usd) && usd > 0)) return
  const cfg = readConfig()
  cfg.spentUsd = (typeof cfg.spentUsd === 'number' ? cfg.spentUsd : 0) + usd
  writeConfig(cfg)
}

/** 누적 사용액 리셋 — 재충전했거나 기준점을 새로 잡을 때. */
export function resetSpend(): void {
  const cfg = readConfig()
  cfg.spentUsd = 0
  writeConfig(cfg)
}
