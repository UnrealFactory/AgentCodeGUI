import type { TrayMenuItem } from '@shared/protocol'

// 트레이 우클릭 메뉴 페이지 — main(showTrayMenu)이 trayMenuShow로 항목을 밀어넣고,
// 렌더 후 콘텐츠 높이를 resize로 보고하면 main이 커서 기준 위치를 확정하고 보여준다
// (토스트와 같은 깜빡임 없는 첫 표시). 클릭·Esc가 action으로 흘러 main이 창을 부순다
// (바깥 클릭은 main의 blur 핸들러 몫). 라벨은 main이 표시 시점 언어로 채워 보낸다.

const menu = document.getElementById('menu') as HTMLDivElement

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

window.api.trayMenu.onShow((items: TrayMenuItem[]) => {
  menu.innerHTML = items
    .map((it, i) => `${i ? '<div class="sep"></div>' : ''}<button class="row" data-id="${esc(it.id)}">${esc(it.label)}</button>`)
    .join('')
  menu.classList.add('in')
  // 렌더가 앉은 뒤의 실측 높이를 보고 — main이 창 크기·위치를 확정하고 보여준다
  requestAnimationFrame(() => {
    window.api.trayMenu.resize(menu.offsetHeight).catch(() => {})
  })
})

menu.addEventListener('click', (ev) => {
  const hit = (ev.target as HTMLElement).closest('[data-id]') as HTMLElement | null
  if (hit?.dataset.id) window.api.trayMenu.action(hit.dataset.id).catch(() => {})
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.trayMenu.action('').catch(() => {})
})
