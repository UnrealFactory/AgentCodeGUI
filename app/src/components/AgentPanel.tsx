import { useEffect, useState, type ReactNode } from 'react'
import type { ChangedFile, SubAgentInfo, SubAgentStatus, Todo } from '@shared/protocol'
import {
  IconBot,
  IconFile,
  IconCheck,
  IconSearch,
  IconClose
} from './icons'
import { FileBadge } from './fileType'
import { Markdown } from './Markdown'
import { MouseGestureLayer, scrollGestures } from './mouseGesture'
import { t } from '../lib/i18n'
import { settleText, useSettledReason } from '../lib/settled'
import { ToolActivityRow, type OpenToolFile } from './ToolActivity'

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

function saEffort(effort?: string): string {
  const labels: Record<string, string> = {
    none: t('없음', 'None'),
    minimal: t('최소', 'Minimal'),
    low: t('낮음', 'Low'),
    medium: t('보통', 'Medium'),
    high: t('높음', 'High'),
    xhigh: t('매우 높음', 'Very high'),
    max: t('최대', 'Max'),
    ultra: t('울트라', 'Ultra')
  }
  return effort ? labels[effort] ?? effort : t('정보 없음', 'Unavailable')
}

// 팝오버 한 줄 — PoC .prow: 상태 아이콘(✓/스피너/점) + 이름/역할. 상세는 클릭해 여는
// 카드에 있으므로 행은 조용하게 유지한다.
export function SubAgent({ a, onOpen }: { a: SubAgentInfo; onOpen: (a: SubAgentInfo) => void }) {
  // ★ 3.0 M-UX R3 — 원장이 사유와 함께 정착시킨 서브에이전트인가(`chat:run-state.settled[]`).
  // 서브에이전트의 원장 id는 `Task` 도구의 tool_use id 그대로라(`wire.rs`의 `agent.id`)
  // `settled[]`의 키와 같은 문자열이다. 실행 중이던 것이 정착했다면 그건 "완료"가 아니라
  // **정리**다 — 색·문구가 그 차이를 말해야 한다(m-logic §5.2).
  const why = useSaSettled(a)
  // PoC 행 서브: '역할 · 42초' — 완료돼 소요가 잡히면 뒤에 붙인다
  const sub = why
    ? `${why.label} — ${why.sub}`
    : [a.role, a.model, a.effort ? t('추론 ', 'Effort ') + saEffort(a.effort) : '', a.durationMs != null ? fmtSaDur(a.durationMs) : ''].filter(Boolean).join(' · ')
  return (
    <button className={'wb-prow act' + (a.status === 'done' && !why ? ' done' : '')} onClick={() => onOpen(a)}>
      <span className="ic">
        {why ? (
          <IconClose size={12} />
        ) : a.status === 'running' ? (
          <span className="spin" />
        ) : a.status === 'done' ? (
          <IconCheck size={12} />
        ) : (
          <span className="dot" />
        )}
      </span>
      <span className="grow">
        {a.name}
        {sub && <span className="sub">{sub}</span>}
      </span>
    </button>
  )
}

/**
 * ★ R3 — 이 서브에이전트가 **정리**됐나. `completed`로 끝난 정상 종료에는 값이 없다
 * (그때는 평소의 「완료」 어휘를 그대로 쓴다 — settleText가 null을 준다).
 *
 * 셸이 스트림을 닫을 때 `wire::settle_all_background()`가 살아 있던 서브에이전트를
 * `status:'done'` + activity "턴 종료로 정리됨"으로 접어 보낸다. 그 화면만 보면 **완료와
 * 구분이 안 된다** — 초록 ✓에 「완료」다. 원장의 사유가 그 둘을 가른다.
 */
function useSaSettled(a: SubAgentInfo | null): { label: string; sub: string } | null {
  const reason = useSettledReason(a?.id)
  if (!a || !reason) return null
  return settleText(reason)
}

// 상태 배지 — PoC .stbadge: 완료=초록, 실행 중=중립+스피너, 대기=중립
// ★ R3 — 원장 사유가 있으면 그것이 배지다("정리됨"), 부제는 title로.
function saBadge(status: SubAgentStatus, why: { label: string; sub: string } | null): ReactNode {
  if (why)
    return (
      <span className="dc-badge n" title={`${why.label} — ${why.sub}`}>
        <span className="d" />
        {why.label}
      </span>
    )
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
export function SubAgentModal({ agent, cwd, onClose, onOpenFile }: { agent: SubAgentInfo | null; cwd?: string; onClose: () => void; onOpenFile?: OpenToolFile }) {
  // 마우스 제스처(U/D 스크롤·DR 닫기)의 대상 카드 엘리먼트
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const why = useSaSettled(agent) // ★ R3 — 정리됨(사유) 어휘. 없으면 평소의 완료/실행 중
  useEffect(() => {
    if (!agent) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.tool-detail-overlay, .fv-overlay.from-detail')) onClose()
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
            <div className="dc-sub">
              {t('서브에이전트', 'Subagent')}
              {agent.role && !['서브에이전트', 'Subagent'].includes(agent.role) ? ` · ${agent.role}` : ''}
            </div>
            <div className="dc-sa-meta">
              <span className="dc-stat">
                {t('모델', 'Model')} <b>{agent.model || t('정보 없음', 'Unavailable')}</b>
              </span>
              <span className="dc-stat">
                {t('추론 노력', 'Reasoning effort')} <b>{saEffort(agent.effort)}</b>
              </span>
            </div>
          </div>
          {saBadge(agent.status, why)}
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
                  <Markdown text={agent.activity} cwd={cwd} onOpenFile={onOpenFile} />
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
                <ToolActivityRow key={tu.id} t={tu} onOpenFile={onOpenFile} />
              ))}
            </div>
          ) : (
            <div className="dc-box tools">
              <div className="ag-none">{t('사용한 도구가 없어요', 'No tools were used')}</div>
            </div>
          )}
        </div>
        <div className="dc-foot">
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
      {/* 우클릭 드래그 제스처 — L 뒤로 · U 맨 위 · D 맨 아래 · DR 닫기 */}
      <MouseGestureLayer
        target={cardEl}
        actions={[
          ...scrollGestures(() => cardEl?.querySelector('.dc-body')),
          { pattern: 'L', label: t('뒤로', 'Back'), run: onClose },
          { pattern: 'DR', label: t('카드 닫기', 'Close card'), run: onClose }
        ]}
      />
    </div>
  )
}
