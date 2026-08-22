import { useEffect, useState, type ReactNode } from 'react'
import type { ChangedFile, SubAgentInfo, SubAgentStatus, Todo } from '@shared/protocol'
import {
  IconBot,
  IconFile,
  IconCheck,
  IconSearch,
  IconClose,
  IconEye,
  IconPencil,
  IconTerminal,
  IconGlobe,
  IconPlug,
  IconWrench
} from './icons'
import { FileBadge } from './fileType'
import { Markdown } from './Markdown'
import { MouseGestureLayer, scrollGestures } from './mouseGesture'
import { t } from '../lib/i18n'

// 미완료 할 일의 원형 마커 (PoC pop-todo의 circle glyph — 전용 아이콘이 없어 인라인)
function TodoCircle() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="8" />
    </svg>
  )
}

// 할 일 목록 — PoC .prow 문법: 완료=행 흐림+초록 ✓, 미완료=원형 마커(진행 중이면
// 끝에 '진행 중' 라벨), 맨 아래 진행 바(.wb-pbar). 체크박스·상단 바는 은퇴.
export function Todos({ todos }: { todos: Todo[] }) {
  const total = todos.length
  const done = todos.filter((t) => t.status === 'done').length
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <>
      <div className="todos scroll">
        {/* 항목 변수는 td — t는 i18n 함수라 가리면 안 된다 */}
        {todos.map((td) => (
          <div key={td.id} className={'wb-prow' + (td.status === 'done' ? ' done' : '')}>
            <span className="ic">{td.status === 'done' ? <IconCheck size={12} /> : <TodoCircle />}</span>
            <span className="grow">{td.label}</span>
            {td.status === 'running' && <span className="end">{t('진행 중', 'In progress')}</span>}
          </div>
        ))}
      </div>
      <div className="wb-pbar">
        <i style={{ width: pct + '%' }} />
      </div>
    </>
  )
}

export function FileRow({ f, onOpen }: { f: ChangedFile; onOpen: (f: ChangedFile) => void }) {
  const slash = f.path.lastIndexOf('/')
  const name = slash >= 0 ? f.path.slice(slash + 1) : f.path
  return (
    <button className="file" onClick={() => onOpen(f)}>
      <FileBadge path={f.path} size={18} />
      {/* 좁은 목록이라 폴더 경로는 빼고 파일명만 — 경로 hover 툴팁·끝 화살표는 은퇴(유저 결정),
          +/- 통계·태그가 행 끝까지 붙는다. 폴더를 조금이라도 잘라 보여주면 'P…' 같은
          알아볼 수 없는 회색 조각이 남아 더 헷갈렸다. */}
      <span className="path">{name}</span>
      <span className="stat">
        {/* 항상 +N −M 고정 표기 — 변경이 없으면 +0 −0(흐리게). 행마다 형식이 달라 헷갈리던 문제 해결 */}
        <span className={'add' + (f.add ? '' : ' zero')}>+{f.add || 0}</span>
        <span className={'del' + (f.del ? '' : ' zero')}>−{f.del || 0}</span>
        <span className={'tag ' + (f.tag === 'new' ? 'new' : 'edit')}>{f.tag === 'new' ? 'NEW' : 'EDIT'}</span>
      </span>
    </button>
  )
}

function saIcon(name: string, size: number): ReactNode {
  const n = name.toLowerCase()
  if (n.includes('explore') || n.includes('search') || n.includes('탐색')) return <IconSearch size={size} />
  if (n.includes('verify') || n.includes('test') || n.includes('검증')) return <IconCheck size={size} />
  if (n.includes('build') || n.includes('구현') || n.includes('code')) return <IconFile size={size} />
  return <IconBot size={size} />
}

// 도구 사용 행 아이콘 — Chat.tsx toolIcon과 같은 매핑. Chat이 이 파일을 import하는
// 방향이라 거기서 가져오면 순환 — 소형 사본을 둔다.
function dcToolIcon(kind: string, size: number): ReactNode {
  if (kind === 'search') return <IconSearch size={size} />
  if (kind === 'read') return <IconEye size={size} />
  if (kind === 'write') return <IconFile size={size} />
  if (kind === 'edit') return <IconPencil size={size} />
  if (kind === 'bash') return <IconTerminal size={size} />
  if (kind === 'web') return <IconGlobe size={size} />
  if (kind === 'mcp') return <IconPlug size={size} />
  return <IconWrench size={size} />
}

// 라벨은 함수로 늦춰 렌더 때 t() 평가 — 모듈 스코프 상수에 언어가 박제되지 않게
const SA_STATUS_LABEL: Record<SubAgentStatus, () => string> = {
  queued: () => t('대기', 'Queued'),
  running: () => t('실행 중', 'Running'),
  done: () => t('완료', 'Done')
}

// 소요 표기 — PoC 푸터 칩: '42초' / '1분 8초'
function fmtSaDur(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return t(`${s}초`, `${s}s`)
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? t(`${m}분 ${r}초`, `${m}m ${r}s`) : t(`${m}분`, `${m}m`)
}

// 팝오버 한 줄 — PoC .prow: 상태 아이콘(✓/스피너/점) + 이름/역할. 상세는 클릭해 여는
// 카드에 있으므로 행은 조용하게 유지한다.
export function SubAgent({ a, onOpen }: { a: SubAgentInfo; onOpen: (a: SubAgentInfo) => void }) {
  // PoC 행 서브: '역할 · 42초' — 완료돼 소요가 잡히면 뒤에 붙인다
  const sub = [a.role, a.durationMs != null ? fmtSaDur(a.durationMs) : ''].filter(Boolean).join(' · ')
  return (
    <button className={'wb-prow act' + (a.status === 'done' ? ' done' : '')} onClick={() => onOpen(a)}>
      <span className="ic">
        {a.status === 'running' ? <span className="spin" /> : a.status === 'done' ? <IconCheck size={12} /> : <span className="dot" />}
      </span>
      <span className="grow">
        {a.name}
        {sub && <span className="sub">{sub}</span>}
      </span>
    </button>
  )
}

// 상태 배지 — PoC .stbadge: 완료=초록, 실행 중=중립+스피너, 대기=중립
function saBadge(status: SubAgentStatus): ReactNode {
  if (status === 'done')
    return (
      <span className="dc-badge">
        <span className="d" />
        {SA_STATUS_LABEL.done()}
      </span>
    )
  return (
    <span className="dc-badge n">
      {status === 'running' ? <span className="spin" /> : <span className="d" />}
      {SA_STATUS_LABEL[status]()}
    </span>
  )
}

// 서브에이전트 상세 카드 — PoC 상세 카드 문법(.dc-*): 아이콘 타일 + 제목/서브 + 상태
// 배지 헤더, 본문은 섹션 라벨(결과 · 과정 · 도구 사용) 아래 카드, 푸터는 스탯 칩.
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
  return (
    <div className="sa-overlay" onMouseDown={onClose}>
      <div className="dc-card" ref={setCardEl} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dc-head">
          <div className="dc-tile">{saIcon(agent.name, 19)}</div>
          <div className="dc-tt">
            <span className="dc-title">{agent.name}</span>
            {/* PoC msub: '서브에이전트 · Opus 5 · 읽기 전용 탐색' — 모델은 사이드체인 실측 */}
            <div className="dc-sub">
              {t('서브에이전트', 'Subagent')}
              {agent.model ? ` · ${agent.model}` : ''}
              {agent.role ? ` · ${agent.role}` : ''}
            </div>
          </div>
          {saBadge(agent.status)}
          <button className="dc-close" onClick={onClose} aria-label={t('닫기', 'Close')}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dc-body scroll">
          {agent.activity && (
            <>
              <div className="dc-sec">
                <span>{agent.status === 'done' ? t('결과', 'Result') : t('설명', 'Description')}</span>
                <i className="dc-ln" />
              </div>
              <div className="dc-box">
                <div className="content dc-md">
                  <Markdown text={agent.activity} />
                </div>
              </div>
            </>
          )}
          {/* 실행 중 내레이션의 누적 로그 — 최신 한 줄(activity)로 덮여 사라지던 과정을
              시간순 타임라인(점+연결선)으로 보여준다 (reducer가 변화를 쌓는다) */}
          {agent.log && agent.log.length > 0 && (
            <>
              <div className="dc-sec">
                <span>{t('과정', 'Progress')}</span>
                <i className="dc-ln" />
              </div>
              <div className="dc-box">
                <div className="dc-log">
                  {agent.log.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              </div>
            </>
          )}
          <div className="dc-sec">
            <span>{t('도구 사용', 'Tool use')}</span>
            <i className="dc-ln" />
          </div>
          {agent.tools.length ? (
            <div className="dc-box tools">
              {/* 항목 변수는 tu — t는 i18n 함수라 가리면 안 된다 */}
              {agent.tools.map((tu) => (
                <div className="dc-tool" key={tu.id}>
                  <span className="tic">{dcToolIcon(tu.kind, 15)}</span>
                  <span className="tname">{tu.verb}</span>
                  <span className="targ">{tu.target}</span>
                  <span className="tend">
                    {tu.status === 'running' ? (
                      <span className="spin" />
                    ) : tu.status === 'error' ? (
                      <span style={{ color: 'var(--red)' }}>{t('오류', 'Error')}</span>
                    ) : tu.result ? (
                      tu.result
                    ) : (
                      <span className="ok">
                        <IconCheck size={12} />
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="dc-box tools">
              <div className="ag-none">{t('사용한 도구가 없어요', 'No tools were used')}</div>
            </div>
          )}
        </div>
        <div className="dc-foot">
          {agent.model && (
            <span className="dc-stat">
              {t('모델', 'Model')} <b>{agent.model}</b>
            </span>
          )}
          {agent.durationMs != null && (
            <span className="dc-stat">
              {t('소요', 'Duration')} <b>{fmtSaDur(agent.durationMs)}</b>
            </span>
          )}
          <span className="dc-stat">
            {t('도구 호출', 'Tool calls')} <b>{t(`${agent.tools.length}회`, `${agent.tools.length}`)}</b>
          </span>
        </div>
      </div>
      {/* 우클릭 드래그 제스처 — 뷰어와 같은 문법 (U 맨 위 · D 맨 아래 · DR 닫기) */}
      <MouseGestureLayer
        target={cardEl}
        actions={[
          ...scrollGestures(() => cardEl?.querySelector('.dc-body')),
          { pattern: 'DR', label: t('카드 닫기', 'Close card'), run: onClose }
        ]}
      />
    </div>
  )
}
