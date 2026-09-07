import { memo, useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ToolLogItem } from '@shared/protocol'
import { t } from '../lib/i18n'
import { settleText, useSettledReason } from '../lib/settled'
import { fmtToolResult, mcpParts, parseSearchOutput, parseToolArgs, toolFiles, webToolDetails } from '../lib/toolResult'
import { MouseGestureLayer, scrollGestures } from './mouseGesture'
import { IconSearch, IconEye, IconFile, IconPencil, IconTerminal, IconGlobe, IconPlug, IconWrench, IconClose, IconCopy, IconChevDown } from './icons'

export type OpenToolFile = (path: string, line?: number) => void

function toolIcon(kind: string, size: number) {
  if (kind === 'search') return <IconSearch size={size} />
  if (kind === 'read') return <IconEye size={size} />
  if (kind === 'write') return <IconFile size={size} />
  if (kind === 'edit') return <IconPencil size={size} />
  if (kind === 'bash') return <IconTerminal size={size} />
  if (kind === 'web') return <IconGlobe size={size} />
  if (kind === 'mcp') return <IconPlug size={size} />
  return <IconWrench size={size} />
}

// File groups and web results share the same visible expand/collapse indicator.
function ToolExpandIcon() {
  return <span className="t-fold" aria-hidden="true"><IconChevDown size={14} stroke={2.4} /></span>
}

// 실행 시간 표시 (bash 행 요약·모달) — 10초 미만은 소수 한 자리, 1분 넘으면 m s
function fmtDur(ms: number): string {
  const s = ms / 1000
  if (s < 10) return s.toFixed(1) + 's'
  if (s < 60) return Math.round(s) + 's'
  return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's'
}

// result shown on the right: a spinner while running, a red mark on error, the +/-
// line counts for edits (colored), or the tool's text summary otherwise.
// Bash는 '✓' 대신 실행 시간 · 출력 줄수 — 다른 도구의 '10줄'과 같은 문법.
// prop 이름 t는 i18n의 t()를 가리므로 안에서는 tl(tool log)로 받는다
// Skill/Workflow 정착 행 — 요약 문장(「Launching skill: …」 등)이 대상 자리(동사 옆)로
// 온다(2026-09-01 사용자 결정: 오른쪽 끝 정렬 기각·원문 유지). 이름 대상(t-target)은
// 요약이 이름을 이미 품고 있어 겹치므로, 이때는 실행 중에만 보인다.
function resultBesideVerb(tl: ToolLogItem): boolean {
  return (tl.verb === 'Skill' || tl.verb === 'Workflow') && tl.status === 'done' && !!tl.result
}

// 줄 수 — split('\n')은 출력 전체를 배열로 복제한다(행마다·렌더마다). 개수만 센다.
function countLines(s: string): number {
  let n = 1
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
  return n
}

function ToolResult({ t: tl }: { t: ToolLogItem }) {
  // ★ 3.0 M-UX R2 — 이 도구가 **사유와 함께 정착**했나(`chat:run-state.settled[]`).
  // 스트림이 밖에서 죽으면 합성 result가 busy만 내리고 도구 행은 안 건드린다 →
  // R1에서는 이 스피너가 영원히 돌았다. m-logic §5.2: Completed만 "완료", 나머지는
  // "정리됨" + 사유 부제(여기서는 툴팁 — 행 오른쪽 칸이 좁다).
  const settled = useSettledReason(tl.id)
  if (tl.status === 'running') {
    const why = settled ? settleText(settled) : null
    if (why)
      return (
        <span className="t-res settled" title={`${why.label} — ${why.sub}`}>
          {why.label}
        </span>
      )
    return <span className="t-res"><span className="spin" /></span>
  }
  if (tl.status === 'error') return <span className="t-res err">{t('오류', 'Error')}</span>
  if (tl.kind === 'bash') {
    const n = tl.outputLines ?? (tl.output ? countLines(tl.output) : 0)
    const parts = [tl.durationMs != null ? fmtDur(tl.durationMs) : '', n ? t(`${n}줄`, `${n} lines`) : ''].filter(Boolean)
    if (parts.length) return <span className="t-res">{parts.join(' · ')}</span>
  }
  // Skill/Workflow 정착 — 요약 원문이 오른쪽 끝이 아니라 **동사 옆**에 앉는다
  // (2026-09-01 사용자 결정: 원문은 그대로, 정렬만 왼쪽으로)
  if (resultBesideVerb(tl)) return <span className="t-res near">{tl.result}</span>
  // ★TOOLROW — 엔진이 보낸 요약 토큰(`145 lines`·`12 hits`·`done`·`+3 −1`…)을 표시 언어로 푼다
  return <span className="t-res">{fmtToolResult(tl.result)}</span>
}

// 실패 출력에서 에러로 읽히는 줄만 붉게 — 성공 출력은 설치 로그처럼 완전 무채색 유지
function bashErrLine(failed: boolean, ln: string): boolean {
  return failed && /(^|\s)(error|err!|fatal|exception|failed)\b/i.test(ln)
}

// 도구 상세 카드 — Bash 로그 모달을 일반화한 것(★TOOLROW 2026-09-02 사용자 결정: 행 오른쪽엔
// 요약만, 본문은 클릭 카드로). 종류별 섹션:
//   Bash        「명령」·「출력」 (예전 BashLogModal 그대로)
//   Search      「요청」(pattern·path·glob 표)·「결과」(파일 목록 — 항목 클릭 = 그 파일 열기)
//   MCP·기타    「요청」(입력 인자 표)·「결과」(본문 터미널 웰)
// 오류 행은 결과 섹션이 「오류」가 되고 줄이 붉다. 채팅 스크롤러/가상화 밖(body 포털)에
// 그려서 어느 화면(메인·멀티 패널·추가 채팅)에서 열어도 안전하다.
// prop 이름 t는 i18n의 t()를 가리므로 안에서는 tl(tool log)로 받는다
function ToolLogModal({
  t: tl,
  onClose,
  onOpenFile
}: {
  t: ToolLogItem
  onClose: () => void
  onOpenFile?: OpenToolFile
}) {
  // 복사 피드백 — 요청/결과 어느 쪽을 복사했는지 구분 (복사 → 복사됨 1.2s, 설정 CopyRow 이디엄)
  const [copied, setCopied] = useState<'req' | 'out' | null>(null)
  // 마우스 제스처(↑/↓ 출력 스크롤 · ↓→ 닫기) 대상 — 카드 엘리먼트를 state로 추적
  const [card, setCard] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Ctrl+W — main이 앱 종료를 삼키고 보내는 신호(shortcut:close). 코드 뷰어와 같은 규칙.
    const offCloseShortcut = window.api.onCloseShortcut(onClose)
    return () => {
      document.removeEventListener('keydown', onKey)
      offCloseShortcut()
    }
  }, [onClose])
  const failed = tl.status === 'error'
  const isBash = tl.kind === 'bash'
  const isSearch = tl.kind === 'search'
  const output = tl.output ?? ''
  const lines = output.split('\n')
  const req = parseToolArgs(tl.args)
  const reqText = isBash ? tl.command ?? tl.target : req.raw || tl.target
  const search = isSearch && !failed && output ? parseSearchOutput(output, req.rows?.find(([key]) => key === 'output_mode')?.[1]) : null
  const showFiles = !!search && search.hits.length > 0
  const mcp = tl.kind === 'mcp' ? mcpParts(tl.name) : null
  const title = mcp ? `${mcp.server} · ${mcp.tool}` : tl.target || tl.verb
  const sub = [
    mcp
      ? t(`MCP · ${mcp.server} 서버 · ${mcp.tool} 도구`, `MCP · ${mcp.server} server · ${mcp.tool} tool`)
      : isBash
        ? t('Bash · 일회성 실행', 'Bash · one-off run')
        : isSearch
          ? t('검색', 'Search')
          : t('도구', 'Tool') + ' · ' + tl.verb,
    tl.durationMs != null ? fmtDur(tl.durationMs) : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const copy = (which: 'req' | 'out', text: string): void => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(which)
        setTimeout(() => setCopied(null), 1200)
      })
      .catch(() => {})
  }
  // 결과 목록의 파일 — 카드를 닫고 연다(뷰어가 카드 아래에 열리면 가려진다)
  const openHit = (p: string, line?: string): void => {
    if (!onOpenFile) return
    onClose()
    const n = Number(line)
    onOpenFile(p, Number.isInteger(n) && n > 0 ? n : undefined)
  }
  // 엔진이 끝 4,000자만 실어 보내는 캡은 '끝부분 4,000자'로 알린다
  const capped = tl.outputTruncated ?? output.length >= 4000
  const resultLabel = failed ? t('오류', 'Error') : isBash ? t('출력', 'Output') : t('결과', 'Result')
  return createPortal(
    <div className="sa-overlay tool-detail-overlay" onMouseDown={onClose}>
      <div className="dc-card" ref={setCard} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dc-head">
          <div className="dc-tile">{toolIcon(tl.kind, 19)}</div>
          <div className="dc-tt">
            <span className={'dc-title' + (mcp ? '' : ' mono')}>{title}</span>
            <div className="dc-sub">{sub}</div>
          </div>
          <span className={'dc-badge' + (failed ? ' err' : '')}>
            <span className="d" />
            {failed ? t('오류', 'Error') : t('완료', 'Done')}
          </span>
          <button className="dc-close" onClick={onClose} aria-label={t('닫기', 'Close')}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dc-body scroll">
          <div className="dc-sec">
            <span>{isBash ? t('명령', 'Command') : t('요청', 'Request')}</span>
            <i className="dc-ln" />
            {!!reqText && (
              <button className={'dc-copy' + (copied === 'req' ? ' on' : '')} onClick={() => copy('req', reqText)}>
                <IconCopy size={12} />
                {copied === 'req' ? t('복사됨 ✓', 'Copied ✓') : isBash ? t('명령 복사', 'Copy command') : t('요청 복사', 'Copy request')}
              </button>
            )}
          </div>
          {isBash || !req.rows ? (
            <div className="dc-cmd">{reqText || t('(인자 없음)', '(no arguments)')}</div>
          ) : (
            <div className="dc-kv">
              {req.rows.map(([k, v]) => (
                <div key={k}>
                  <span className="k">{k}</span>
                  <span className="v">{v}</span>
                </div>
              ))}
            </div>
          )}
          <div className="dc-sec">
            <span>
              {resultLabel}
              {showFiles && search ? ` · ${t(`${search.hits.length}건`, `${search.hits.length} hits`)}` : ''}
            </span>
            <i className="dc-ln" />
            {!!output && (
              <button className={'dc-copy' + (copied === 'out' ? ' on' : '')} onClick={() => copy('out', output)}>
                <IconCopy size={12} />
                {copied === 'out' ? t('복사됨 ✓', 'Copied ✓') : t('결과 복사', 'Copy result')}
              </button>
            )}
          </div>
          {showFiles && search ? (
            <>
              <div className="dc-files">
                {search.hits.map((h, i) => (
                  <button
                    key={i}
                    className={'dc-file' + (onOpenFile ? ' openable' : '')}
                    onClick={() => openHit(h.path, h.line)}
                    title={onOpenFile ? t('파일 보기', 'View file') : undefined}
                  >
                    {h.line && <span className="ln">{h.line}</span>}
                    <span className="p">{h.path}</span>
                    {h.count != null && <span className="hit">{t(`${h.count}건`, `${h.count} hits`)}</span>}
                    {h.text && <span className="hit">{h.text}</span>}
                  </button>
                ))}
                {search.truncated && <div className="dc-file-note">{t('결과가 잘렸어요', 'Results were truncated')}</div>}
              </div>
              {search.rest.length > 0 && (
                <div className="dc-term dc-term-after">
                  <div className="dc-term-body">
                    {search.rest.map((ln, i) => (
                      <div key={i} className="bo-ln">
                        {ln}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : output ? (
            <div className="dc-term">
              <div className="dc-term-body">
                {lines.map((ln, i) => (
                  <div key={i} className={'bo-ln' + ((isBash ? bashErrLine(failed, ln) : failed) ? ' err' : '')}>
                    {/* 빈 줄은 NBSP로 높이 유지 — 일반 공백은 collapse돼 줄이 사라진다 */}
                    {ln || ' '}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="dc-cmd dc-empty">{capped ? t('결과가 길어 미리보기가 생략됐어요', 'The result was too long to preview') : t('(출력 없음)', '(no output)')}</div>
          )}
        </div>
        <div className="dc-foot">
          {tl.exitCode != null && <span className="dc-stat">{t('종료 코드', 'Exit code')} <b>{tl.exitCode}</b></span>}
          {tl.durationMs != null && (
            <span className="dc-stat">
              {t('소요', 'Took')} <b>{fmtDur(tl.durationMs)}</b>
            </span>
          )}
          {!!output && (
            <span className="dc-stat">
              {resultLabel}{' '}
              <b>
                {capped
                  ? t('끝부분만 표시', 'Showing the end of the output')
                  : showFiles && search
                    ? t(`${search.hits.length}건`, `${search.hits.length} hits`)
                    : t(`${lines.length}줄`, `${lines.length} lines`)}
              </b>
            </span>
          )}
        </div>
      </div>
      <MouseGestureLayer
        target={card}
        actions={[
          ...scrollGestures(() => card?.querySelector('.dc-body')),
          { pattern: 'L', label: t('뒤로', 'Back'), run: onClose },
          { pattern: 'DR', label: t('창 닫기', 'Close window'), run: onClose }
        ]}
      />
    </div>,
    document.body
  )
}

// Bash 행 — Read/Edit 행이 파일을 열듯 명령(t-target)을 클릭하면 전체 로그 모달이
// 열린다(호버는 밑줄만 — 「결과 보기」 툴팁은 2026-09-03 사용자 결정으로 뺐다). 인라인 출력은 성공·실패 모두 없음 — 실패도 우측
// '오류' 요약만 남기고, 내용은 다른 도구들과 똑같이 클릭해서 모달로 읽는다.
// prop 이름 t는 i18n의 t()를 가리므로 안에서는 tl(tool log)로 받는다
// memo — 도구 행 하나가 끝날 때마다 그룹의 다른 60행이 같이 다시 그려지지 않게(3.0.3).
// 리듀서는 바뀐 도구 항목만 새 객체로 만들므로(tool-end) 나머지 행은 참조가 그대로다.
const BashRow = memo(function BashRow({ t: tl }: { t: ToolLogItem }) {
  const [open, setOpen] = useState(false)
  const clickable = tl.status !== 'running'
  return (
    <>
      <button
        type="button"
        disabled={!clickable}
        className={'t-row bash ' + tl.status + (clickable ? ' openable' : '')}
        data-tool-id={tl.id}
        onClick={clickable ? () => setOpen(true) : undefined}
      >
        <span className="t-ic">{toolIcon('bash', 14)}</span>
        <span className="t-verb">{tl.verb}</span>
        <span className="t-target">
          <span className="t-txt">{tl.target}</span>
        </span>
        <ToolResult t={tl} />
      </button>
      {open && <ToolLogModal t={tl} onClose={() => setOpen(false)} />}
    </>
  )
})

// 일반 도구 행(Read/Write/Edit/Search/MCP/기타) — ★TOOLROW(2026-09-02 사용자 결정):
//   파일 행(read/write/edit)  클릭 = 파일 열기(2.6.2 그대로). 오류면 오류 본문 카드.
//   나머지(search/mcp/other)  클릭 = 상세 카드(「요청」·「결과」). 실행 중엔 안 열린다.
// 오른쪽 요약은 ToolResult가 토큰을 풀어 그린다 — 본문은 어느 행에도 안 나온다.
// prop 이름 t는 i18n의 t()를 가리므로 안에서는 tl(tool log)로 받는다
const ToolRow = memo(function ToolRow({ t: tl, onOpenFile }: { t: ToolLogItem; onOpenFile?: OpenToolFile }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const fileRow = tl.kind === 'read' || tl.kind === 'write' || tl.kind === 'edit'
  const files = fileRow ? toolFiles(tl) : []
  const errCard = tl.status === 'error'
  const multiple = files.length > 1 && !errCard
  const toFile = fileRow && !errCard && !!onOpenFile && files.length === 1
  const toCard = fileRow ? errCard : tl.status !== 'running'
  const clickable = multiple || toFile || toCard
  return (
    <>
      <button
        type="button"
        disabled={!clickable}
        className={'t-row ' + tl.kind + ' ' + tl.status + (clickable ? ' openable' : '') + (multiple && expanded ? ' expanded' : '')}
        data-tool-id={tl.id}
        aria-expanded={multiple ? expanded : undefined}
        aria-controls={multiple ? listId : undefined}
        onClick={multiple ? () => setExpanded(v => !v) : toFile ? () => onOpenFile!(files[0].path) : toCard ? () => setOpen(true) : undefined}
      >
        <span className="t-ic">{toolIcon(tl.kind, 14)}</span>
        <span className="t-verb">{tl.verb}</span>
        {/* 호버 안내는 밑줄뿐 — 「결과 보기/파일 보기/오류 보기」 툴팁은 2026-09-03 사용자 결정으로 뺐다.
            Skill/Workflow 정착 행은 요약 문장이 이 자리로 오므로 이름 대상은 접는다 */}
        {!resultBesideVerb(tl) && (
          <span className="t-target">
            <span className="t-txt">{tl.target}</span>
          </span>
        )}
        <ToolResult t={tl} />
        {multiple && <ToolExpandIcon />}
      </button>
      {multiple && expanded && (
        <div id={listId} className="t-file-list">
          {files.map((file, i) => (
            <button key={`${file.path}:${i}`} type="button" className="t-file" disabled={!onOpenFile} onClick={() => onOpenFile?.(file.path)}>
              <span className="t-ic"><IconFile size={13} /></span>
              <span className="t-file-path">{file.path}</span>
              {file.add != null && file.del != null && <span className="t-res">{fmtToolResult(`+${file.add} −${file.del}`)}</span>}
            </button>
          ))}
        </div>
      )}
      {open && <ToolLogModal t={tl} onClose={() => setOpen(false)} onOpenFile={onOpenFile} />}
    </>
  )
})

// 링크에 표시할 도메인 (www. 제거)
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// Web 행 (WebSearch/WebFetch): 검색이 찾은 페이지 목록(links)이 실려 오면 행을 클릭해
// 목록을 펼치고, 각 항목은 OS 브라우저로 연다(target=_blank → 메인의 shell.openExternal
// 경유). links 없이 target 자체가 URL인 행(WebFetch)은 클릭하면 그 페이지를 바로 연다.
// 그 외 완료 행은 요청/결과 상세 모달을 연다(Codex는 결과 링크 없이 검색어만 줄 수 있다).
// 펼침 목록은 배시 출력 블록과 같은 --inset 카드 이디엄: 웹 아이콘 · 제목 · 도메인.
// prop 이름 t는 i18n의 t()를 가리므로 안에서는 tl(tool log)로 받는다
function WebRow({ t: raw }: { t: ToolLogItem }) {
  const tl = webToolDetails(raw)
  const [open, setOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const listId = useId()
  const links = tl.links ?? []
  const direct = !links.length && /^https?:\/\//i.test(tl.target) ? tl.target : null
  const toDetails = tl.status !== 'running' && (tl.status === 'error' || (!links.length && !direct))
  const expandable = !toDetails && links.length > 0
  const clickable = toDetails || links.length > 0 || !!direct
  return (
    <>
      <button
        type="button"
        disabled={!clickable}
        className={'t-row ' + tl.kind + ' ' + tl.status + (clickable ? ' openable' : '') + (expandable && open ? ' expanded' : '')}
        data-tool-id={tl.id}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? listId : undefined}
        onClick={toDetails ? () => setDetailsOpen(true) : links.length ? () => setOpen((o) => !o) : direct ? () => void window.api.openExternal(direct) : undefined}
      >
        <span className="t-ic">{toolIcon(tl.kind, 14)}</span>
        <span className="t-verb">{tl.verb}</span>
        {/* 호버 툴팁(「찾은 페이지 보기」 등)은 2026-09-03 사용자 결정으로 뺐다 — 밑줄만 */}
        <span className="t-target">
          <span className="t-txt">{tl.target}</span>
        </span>
        <ToolResult t={tl} />
        {expandable && <ToolExpandIcon />}
      </button>
      {open && links.length > 0 && (
        <div id={listId} className="wl-list scroll">
          {links.map((l) => (
            <a key={l.url} className="wl-item" href={l.url} target="_blank" rel="noreferrer">
              <span className="wl-icon" aria-hidden="true"><IconGlobe size={14} /></span>
              <span className="wl-title">{l.title}</span>
              <span className="wl-host">{hostOf(l.url)}</span>
            </a>
          ))}
        </div>
      )}
      {detailsOpen && <ToolLogModal t={tl} onClose={() => setDetailsOpen(false)} />}
    </>
  )
}

export function ToolActivityRow({ t, onOpenFile }: { t: ToolLogItem; onOpenFile?: OpenToolFile }) {
  if (t.kind === 'web') return <WebRow t={t} />
  if (t.kind === 'bash') return <BashRow t={t} />
  return <ToolRow t={t} onOpenFile={onOpenFile} />
}
