import { useEffect, useState } from 'react'
import type { AgentStatus, ChangedFile, SubAgentInfo, SubAgentStatus, Todo } from '@shared/protocol'
import { IconBot, IconFile, IconChevRight, IconCheck, IconSearch, IconClose } from './icons'
import { FileBadge } from './fileType'
import { Markdown } from './Markdown'
import { MouseGestureLayer, scrollGestures } from './mouseGesture'

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: '대기 중',
  analyzing: '분석 중',
  working: '작업 중',
  done: '완료',
  error: '오류'
}

function fmtElapsed(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function StatusPill({ status, elapsed }: { status: AgentStatus; elapsed: number }) {
  return (
    <div className={'status-pill ' + status}>
      <span className="d" />
      <span>{STATUS_LABEL[status]}</span>
      {status !== 'idle' && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, opacity: 0.8 }}>{fmtElapsed(elapsed)}</span>
      )}
    </div>
  )
}

export function Todos({ todos }: { todos: Todo[] }) {
  const total = todos.length
  const done = todos.filter((t) => t.status === 'done').length
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div>
      <div className="progress">
        <i style={{ width: pct + '%' }} />
      </div>
      <div className="todos scroll">
        {todos.map((t) => (
          <div key={t.id} className={'todo ' + t.status}>
            <span className="box">{t.status === 'done' && <IconCheck size={12} />}</span>
            <span className="lab">{t.label}</span>
            {t.status === 'running' && (
              <span style={{ marginLeft: 'auto' }}>
                <span className="spin" />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export function FileRow({ f, onOpen }: { f: ChangedFile; onOpen: (f: ChangedFile) => void }) {
  const slash = f.path.lastIndexOf('/')
  const name = slash >= 0 ? f.path.slice(slash + 1) : f.path
  return (
    <button className="file" data-tip={f.path} onClick={() => onOpen(f)}>
      <FileBadge path={f.path} size={18} />
      {/* 좁은 목록이라 폴더 경로는 빼고 파일명만 — 전체 경로는 hover 툴팁(data-tip)에 있다.
          폴더를 조금이라도 잘라 보여주면 'P…' 같은 알아볼 수 없는 회색 조각이 남아 더 헷갈렸다. */}
      <span className="path">{name}</span>
      <span className="stat">
        {/* 항상 +N −M 고정 표기 — 변경이 없으면 +0 −0(흐리게). 행마다 형식이 달라 헷갈리던 문제 해결 */}
        <span className={'add' + (f.add ? '' : ' zero')}>+{f.add || 0}</span>
        <span className={'del' + (f.del ? '' : ' zero')}>−{f.del || 0}</span>
        <span className={'tag ' + (f.tag === 'new' ? 'new' : 'edit')}>{f.tag === 'new' ? 'NEW' : 'EDIT'}</span>
      </span>
      <IconChevRight size={14} className="fchev" />
    </button>
  )
}

function saIcon(name: string, size: number) {
  const n = name.toLowerCase()
  if (n.includes('explore') || n.includes('search') || n.includes('탐색')) return <IconSearch size={size} />
  if (n.includes('verify') || n.includes('test') || n.includes('검증')) return <IconCheck size={size} />
  if (n.includes('build') || n.includes('구현') || n.includes('code')) return <IconFile size={size} />
  return <IconBot size={size} />
}

const SA_STATUS_LABEL: Record<SubAgentStatus, string> = {
  queued: '대기 중',
  running: '실행 중',
  done: '완료'
}

// compact row — title + one-line description + status. The detail/output (full
// description, tools, result) lives in the card opened on click, so the panel
// stays tidy even with several subagents.
export function SubAgent({ a, onOpen }: { a: SubAgentInfo; onOpen: (a: SubAgentInfo) => void }) {
  return (
    <button className={'subagent ' + a.status} onClick={() => onOpen(a)}>
      <span className="sa-ic">{saIcon(a.name, 15)}</span>
      <div className="sa-main">
        <div className="sa-name">{a.name}</div>
        {a.role && <div className="sa-sub">{a.role}</div>}
      </div>
      <span className="sa-status">
        {a.status === 'running' && <span className="spin" />}
        {a.status === 'done' && (
          <span className="sa-check">
            <IconCheck size={12} />
          </span>
        )}
        {a.status === 'queued' && <span className="sa-dot" />}
      </span>
      <IconChevRight className="sa-chev" size={15} />
    </button>
  )
}

// centered detail card — same visual language as the settings modal / install card
export function SubAgentModal({ agent, onClose }: { agent: SubAgentInfo | null; onClose: () => void }) {
  // 마우스 제스처(U/D 스크롤·DR 닫기)의 대상 카드 엘리먼트
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!agent) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [agent, onClose])
  if (!agent) return null
  const doneCount = agent.tools.filter((t) => t.status !== 'running').length
  return (
    <div className="sa-overlay" onMouseDown={onClose}>
      <div className="sa-card" ref={setCardEl} onMouseDown={(e) => e.stopPropagation()}>
        <div className="sa-card-head">
          <span className={'sa-card-ic ' + agent.status}>{saIcon(agent.name, 18)}</span>
          <div className="sa-card-titles">
            <div className="sa-card-name">{agent.name}</div>
            {agent.role && <div className="sa-card-role">{agent.role}</div>}
          </div>
          <span className={'sa-card-status ' + agent.status}>{SA_STATUS_LABEL[agent.status]}</span>
          <button className="sa-card-close" onClick={onClose} aria-label="닫기">
            <IconClose size={18} />
          </button>
        </div>
        <div className="sa-card-body scroll">
          {agent.activity && (
            <div className="sa-card-sec">
              <div className="sa-card-lbl">{agent.status === 'done' ? '결과' : '설명'}</div>
              <div className="content sa-card-md">
                <Markdown text={agent.activity} />
              </div>
            </div>
          )}
          {/* 실행 중 내레이션의 누적 로그 — 최신 한 줄(activity)로 덮여 사라지던 과정을
              시간순으로 보여준다 (reducer가 변화를 쌓는다) */}
          {agent.log && agent.log.length > 0 && (
            <div className="sa-card-sec">
              <div className="sa-card-lbl">과정</div>
              <div className="sa-log">
                {agent.log.map((line, i) => (
                  <div className="sa-log-line" key={i}>
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="sa-card-sec">
            <div className="sa-card-lbl">
              도구 {doneCount}/{agent.tools.length}
            </div>
            {agent.tools.length ? (
              <div className="sa-tools">
                {agent.tools.map((t) => (
                  <div className={'sa-tool ' + t.status} key={t.id}>
                    <span className="sa-tool-verb">{t.verb}</span>
                    <span className="sa-tool-target">{t.target}</span>
                    <span className="sa-tool-st">
                      {t.status === 'running' ? <span className="spin" /> : t.status === 'done' ? <IconCheck size={12} /> : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ag-none">사용한 도구가 없어요</div>
            )}
          </div>
        </div>
      </div>
      {/* 우클릭 드래그 제스처 — 뷰어와 같은 문법 (U 맨 위 · D 맨 아래 · DR 닫기) */}
      <MouseGestureLayer
        target={cardEl}
        actions={[
          ...scrollGestures(() => cardEl?.querySelector('.sa-card-body')),
          { pattern: 'DR', label: '카드 닫기', run: onClose }
        ]}
      />
    </div>
  )
}
