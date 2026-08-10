import path from 'node:path'
import fs from 'node:fs'
import { APP_HOME } from './engine/versions'
import type { ApiUsageRecord } from '@shared/protocol'

// API 모드 실행 원장 — 실행이 끝날 때마다 한 줄씩 append 되는 jsonl. 설정 → API의
// 통계(모델별·일별 비용, 토큰)가 이 파일을 읽어 집계한다. 레코드가 작아(~200B)
// 수천 건이어도 가볍지만, 읽기는 최근 MAX_RECORDS건으로 캡을 둔다.
const USAGE_PATH = path.join(APP_HOME, 'api-usage.jsonl')
const MAX_RECORDS = 20000
// 회전 임계 — append-only 원장이라 상한 없이는 파일도, 읽기(전량 파싱)도 영영 자란다.
// MAX_RECORDS(2만 건 × ~200B ≈ 4MB)를 넉넉히 넘는 크기에서 뒤쪽 절반만 남긴다.
const ROTATE_BYTES = 8 * 1024 * 1024

/** 실행 1건을 원장에 추가한다. 실패해도 실행 자체엔 영향을 주지 않는다(베스트 에포트). */
export function recordApiUsage(rec: ApiUsageRecord): void {
  try {
    fs.mkdirSync(APP_HOME, { recursive: true })
    try {
      if (fs.statSync(USAGE_PATH).size > ROTATE_BYTES) {
        // 앞쪽 절반을 버린다 — 잘린 첫 줄은 readApiUsage의 손상 줄 스킵이 걸러 준다
        const tail = fs.readFileSync(USAGE_PATH, 'utf8').slice(-Math.floor(ROTATE_BYTES / 2))
        fs.writeFileSync(USAGE_PATH, tail.slice(tail.indexOf('\n') + 1))
      }
    } catch {
      /* 파일 없음/스탯 실패 — 회전 없이 진행 */
    }
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
