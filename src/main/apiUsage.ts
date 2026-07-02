import path from 'node:path'
import fs from 'node:fs'
import { APP_HOME } from './engine/versions'
import type { ApiUsageRecord } from '@shared/protocol'

// API 모드 실행 원장 — 실행이 끝날 때마다 한 줄씩 append 되는 jsonl. 설정 → API의
// 통계(모델별·일별 비용, 토큰)가 이 파일을 읽어 집계한다. 레코드가 작아(~200B)
// 수천 건이어도 가볍지만, 읽기는 최근 MAX_RECORDS건으로 캡을 둔다.
const USAGE_PATH = path.join(APP_HOME, 'api-usage.jsonl')
const MAX_RECORDS = 20000

/** 실행 1건을 원장에 추가한다. 실패해도 실행 자체엔 영향을 주지 않는다(베스트 에포트). */
export function recordApiUsage(rec: ApiUsageRecord): void {
  try {
    fs.mkdirSync(APP_HOME, { recursive: true })
    fs.appendFileSync(USAGE_PATH, JSON.stringify(rec) + '\n')
  } catch {
    /* ignore */
  }
}

/** 원장 전체(최근 MAX_RECORDS건)를 읽는다 — 손상된 줄은 건너뛴다. */
export function readApiUsage(): ApiUsageRecord[] {
  try {
    const lines = fs.readFileSync(USAGE_PATH, 'utf8').split('\n')
    const out: ApiUsageRecord[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const v = JSON.parse(line)
        if (v && typeof v === 'object' && typeof v.ts === 'number') out.push(v as ApiUsageRecord)
      } catch {
        /* skip corrupt line */
      }
    }
    return out.length > MAX_RECORDS ? out.slice(-MAX_RECORDS) : out
  } catch {
    return []
  }
}
