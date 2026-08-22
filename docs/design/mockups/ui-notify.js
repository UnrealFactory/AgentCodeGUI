/* 목업 자가 계측 — "밀도를 잃지 않았다"는 주장을 목업이 스스로 증명하게 만든다.
 *
 * 왜 필요한가: 새 UI 제안은 거의 항상 "여백을 넓혀 깔끔해 보이게" 하는 쪽으로 샌다.
 * 눈으로는 그게 더 나아 보이고, 실제로는 한 화면에 들어가는 정보가 줄어든다.
 * 그래서 각 알림 요소의 **실제 렌더 높이**를 옆에 찍고, A(현행)/B(제안) 합계를 아래에
 * 적는다. B의 합계가 A보다 크면 그 제안은 밀도를 잃은 것이고, 그 사실이 목업 안에 남는다.
 *
 * 표시 대상: [data-m] 이 붙은 요소. 값은 라벨(예: "band").
 */
(function () {
  function px(n) {
    return Math.round(n * 10) / 10
  }
  function run() {
    const sums = {}
    document.querySelectorAll('[data-m]').forEach((el) => {
      const pane = el.closest('.pane')
      const key = pane ? pane.dataset.k || '?' : '?'
      const h = el.getBoundingClientRect().height
      sums[key] = (sums[key] || 0) + h
      // data-m="all"은 스레드 통째를 재는 것이라 옆에 찍을 자리가 없다(합계만 쓴다)
      if (el.dataset.m === 'all') return
      const host = el.classList.contains('meas') ? el : el.parentElement
      if (host && !host.querySelector(':scope > .h-tag')) {
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
        const t = document.createElement('span')
        t.className = 'h-tag'
        t.textContent = px(h) + 'px'
        host.appendChild(t)
      }
    })
    document.querySelectorAll('[data-sum]').forEach((el) => {
      const k = el.dataset.sum
      el.textContent = sums[k] != null ? px(sums[k]) + 'px' : '—'
    })
    const a = sums['A']
    const b = sums['B']
    const v = document.querySelector('[data-verdict]')
    if (v && a != null && b != null) {
      const d = px(b - a)
      v.textContent =
        d === 0
          ? 'B = A (동률)'
          : d < 0
            ? 'B가 ' + px(a - b) + 'px 낮다 (밀도 유지·개선)'
            : 'B가 ' + d + 'px 높다 (밀도 손실 — 제안을 다시 깎아야 한다)'
      v.style.color = d <= 0 ? 'var(--green)' : 'var(--red)'
    }
  }
  // 웹폰트가 붙기 전에 재면 높이가 거짓이 된다
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(run)
  else window.addEventListener('load', run)
})()
