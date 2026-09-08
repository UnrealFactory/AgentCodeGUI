import type { DiagnosticLog } from '@shared/diagnostics'
import { useState } from 'react'
import { t } from '../lib/i18n'

export function DiagnosticNotice({ log }: { log: DiagnosticLog }) {
  const [open, setOpen] = useState(false)
  const connection = log.group === 'connection'
  const label = connection ? t('연결 진단 기록', 'Connection diagnostics') : t('stderr 기록', 'stderr log')
  const status = connection
    ? log.state === 'active' ? t('재시도 중', 'Retrying')
      : log.state === 'resumed' ? t('작업 재개됨', 'Work resumed') : t('지난 기록', 'History')
    : t('진단 출력', 'Diagnostic output')
  return (
    <details className="diagnostic-notice" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="diagnostic-title">{label}</span>
        <span className="diagnostic-count">{t(`${log.total}건`, `${log.total} entries`)}</span>
        <span className="diagnostic-status">{status}</span>
        <time>{log.entries[log.entries.length - 1]?.time}</time>
      </summary>
      {open && <div className="diagnostic-entries">
        {log.omitted > 0 && <div className="diagnostic-omitted">{t(`이전 ${log.omitted}건 생략`, `${log.omitted} earlier entries omitted`)}</div>}
        {log.entries.map((entry, i) => (
          <div className="diagnostic-entry" key={i}>
            <time>{entry.time}</time>
            <pre>{entry.text}</pre>
            {entry.count > 1 && <span className="diagnostic-count">×{entry.count}</span>}
          </div>
        ))}
      </div>}
    </details>
  )
}
