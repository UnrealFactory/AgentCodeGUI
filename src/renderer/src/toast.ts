import type { NotifyEntry, NotifyKind } from '@shared/protocol'

// 포커스 밖 알림 토스트 페이지 — main(notifyToast.ts)이 notifyShow로 표시 목록을
// REPLACE로 밀어넣고, 렌더 후 콘텐츠 높이를 notifyResize로 보고하면 main이 창 크기를
// 확정하고 보여준다. 1건=상세 카드, 여러 건=집계 행(행 클릭=그 채팅으로 점프).
// 자동 닫힘 없음 — 클릭(점프)·✕·해당 창 포커스 회복(main이 지움)만이 소멸 경로다.

const KIND_LABEL: Record<NotifyKind, string> = {
  done: '답변 도착',
  error: '오류로 끝났어요',
  approve: '승인 대기 중',
  ask: 'AI가 질문했어요'
}

const ICONS: Record<NotifyKind, string> = {
  done: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8.5l3.5 3.5 7-8"/></svg>',
  error:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 4.5v4.3"/><circle cx="8" cy="11.6" r=".2" fill="currentColor"/></svg>',
  approve:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.6"/></svg>',
  ask: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5.7 6a2.4 2.4 0 1 1 3.4 2.5c-.7.35-1.1.8-1.1 1.6"/><circle cx="8" cy="12.4" r=".2" fill="currentColor"/></svg>'
}

const card = document.getElementById('card') as HTMLDivElement

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function titleOf(e: NotifyEntry): string {
  return e.title.trim() || '새 채팅'
}

// 2.0 마스코트 로봇 — icons.tsx IconMascot의 정적 사본 (React 없는 페이지라 인라인)
const MASCOT =
  '<svg class="mascot" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="5.5" y="8" width="13" height="10" rx="4.5"/>' +
  '<circle cx="10.2" cy="13" r=".95" fill="currentColor" stroke="none"/>' +
  '<circle cx="13.8" cy="13" r=".95" fill="currentColor" stroke="none"/>' +
  '<path d="M9.5 8Q9 5.8 7.3 4.9"/><circle cx="7" cy="4.7" r=".85" fill="currentColor" stroke="none"/>' +
  '<path d="M14.5 8Q15 5.8 16.7 4.9"/><circle cx="17" cy="4.7" r=".85" fill="currentColor" stroke="none"/>' +
  '<path d="M4.4 10.6C3 11.5 3 14.5 4.4 15.4"/><path d="M19.6 10.6C21 11.5 21 14.5 19.6 15.4"/></svg>'

function headHtml(): string {
  return `
    <div class="t-head">
      ${MASCOT}
      <span class="appname">AgentCodeGUI</span>
      <button class="t-close" id="close" aria-label="닫기">✕</button>
    </div>`
}

function render(entries: NotifyEntry[]): void {
  if (entries.length === 0) return // main이 곧 창을 부순다 — 마지막 프레임은 그대로 둔다
  const first = !card.innerHTML
  // 단건 = 카드 전체가 클릭 대상(호버 링도 카드 전체) — 집계는 행 단위
  document.body.classList.toggle('single', entries.length === 1)
  if (entries.length === 1) {
    const e = entries[0]
    card.innerHTML = `
      ${headHtml()}
      <div class="t-body">
        <div class="t-ico ${e.kind}">${ICONS[e.kind]}</div>
        <div class="t-main">
          <div class="t-title">${esc(KIND_LABEL[e.kind])}<span class="chat">${esc(titleOf(e))}</span></div>
          ${e.preview ? `<div class="t-prev">${esc(e.preview)}</div>` : ''}
        </div>
      </div>`
  } else {
    card.innerHTML = `
      ${headHtml()}
      <div class="t-agg">
        <div class="sum">받은 알림 ${entries.length}건</div>
        <div class="t-rows">
          ${entries
            .map(
              (e) => `
            <button class="t-row" data-key="${esc(e.key)}">
              <i class="${e.kind}"></i>
              <span class="nm">${esc(titleOf(e))}</span>
              <span class="st">${esc(KIND_LABEL[e.kind])}</span>
            </button>`
            )
            .join('')}
        </div>
      </div>`
  }
  // 등장 애니는 첫 표시에만 — 집계 변신(항목 추가) 때는 깜빡이지 않는다
  if (first) card.classList.add('in')
  // 렌더가 앉은 뒤의 실측 높이를 보고 — main이 창 크기를 확정하고 보여준다
  requestAnimationFrame(() => {
    window.api.notify.resize(card.offsetHeight).catch(() => {})
  })
}

let current: NotifyEntry[] = []

document.body.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement
  if (t.closest('#close')) {
    window.api.notify.close().catch(() => {})
    return
  }
  const hit = t.closest('[data-key]') as HTMLElement | null
  if (hit?.dataset.key) {
    window.api.notify.open(hit.dataset.key).catch(() => {})
    return
  }
  // 단건 카드 — ✕ 밖이면 어디를 눌러도(헤더 포함) 그 채팅으로 점프
  if (current.length === 1) window.api.notify.open(current[0].key).catch(() => {})
})

window.api.notify.onShow((entries) => {
  current = entries
  render(entries)
})
