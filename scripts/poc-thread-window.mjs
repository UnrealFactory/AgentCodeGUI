// PoC — 스레드 꼬리 윈도잉(useThreadWindow)의 브라우저 메커니즘 실측 검증.
// 실행: npx electron scripts/poc-thread-window.mjs
//
// 훅과 동일한 상수(TAIL 60 · STEP 60 · SLACK 40 · EPS 60)·동일한 보정 타이밍
// (DOM 변경 → 같은 태스크에서 scrollHeight 측정 → scrollTop 절댓값 대입 = useLayoutEffect)을
// 바닐라로 미러링해 검증한다. 실제 조건 재현: .thread zoom 1.15 + 아이템
// content-visibility:auto + contain-intrinsic-size 120px(실측 전 추정 높이) + 가변 높이.
//
// 시나리오:
//  1) 초기 렌더 = 꼬리 60개, 바닥 고정
//  2) 위로 스크롤 → 센티널(200px 여유) → STEP 확장, 보던 아이템 화면 위치 불변(±1px)
//  3) 맨 위 고정 반복 → start=0까지 연쇄 확장 (교착·무한루프 없음)
//  4) 바닥 복귀 → 꼬리로 트림, 바닥 고정 유지(점프 없음)
//  5) 바닥 고정 스트리밍 append — 윈도가 TAIL+SLACK로 유계 유지
//  6) 위를 읽는 중 아래 append — 화면 위치 불변 + 트림 안 함
import { app, BrowserWindow } from 'electron'

const PAGE = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#111;color:#ddd;font:13px sans-serif}
  #sc{height:600px;overflow:auto}
  #th{zoom:1.15}
  .it{content-visibility:auto;contain-intrinsic-size:auto 120px;border-bottom:1px solid #333;padding:8px}
  .older{height:28px;text-align:center;color:#777}
</style>
<div id="sc"><div id="th"></div></div>
<script>
const TAIL=60, STEP=60, SLACK=40, EPS=60
const sc=document.getElementById('sc'), th=document.getElementById('th')
let total=500, start=Math.max(0,total-TAIL)
const itemH=(i)=>40+(i*97)%7*40 // 40~280px 가변 (결정적)
const mkItem=(i)=>{const d=document.createElement('div');d.className='it';d.dataset.i=i;d.style.minHeight=itemH(i)+'px';d.textContent='msg #'+i;return d}
let sent=null
function syncSentinel(){
  if(start>0&&!sent){sent=document.createElement('div');sent.className='older';sent.textContent='\\u22ef';th.prepend(sent);io.observe(sent)}
  else if(start===0&&sent){io.unobserve(sent);sent.remove();sent=null}
}
// 초기 마운트 — 꼬리만
for(let i=start;i<total;i++) th.appendChild(mkItem(i))
const rendered=()=>th.querySelectorAll('.it').length
const fromBottom=()=>sc.scrollHeight-sc.scrollTop-sc.clientHeight
// shiftTo — 훅과 동일: 변경 직전 기하 저장 → keyed 증분 DOM 반영 → 같은 태스크에서 보정
function shiftTo(next){
  if(next===start) return
  const c={top:sc.scrollTop,height:sc.scrollHeight}
  if(next<start){ // 위로 확장 — 센티널 뒤에 순서대로 삽입
    const ref=th.querySelector('.it')
    for(let i=next;i<start;i++) th.insertBefore(mkItem(i),ref)
  } else { // 트림 — 앞에서 제거
    for(let i=start;i<next;i++) th.querySelector('.it').remove()
  }
  start=next; syncSentinel()
  sc.scrollTop=c.top+(sc.scrollHeight-c.height) // 절댓값 대입 — anchoring과 이중보정 없음
}
const io=new IntersectionObserver((es)=>{
  if(!es.some(e=>e.isIntersecting)) return
  if(start>0) shiftTo(Math.max(0,start-STEP))
},{root:sc,rootMargin:'200px 0px 0px 0px'})
syncSentinel()
sc.addEventListener('scroll',()=>{
  if(fromBottom()>EPS) return
  const tail=Math.max(0,total-TAIL)
  if(tail-start>SLACK) shiftTo(tail)
},{passive:true})
sc.scrollTop=sc.scrollHeight

// ── 시나리오 드라이버 ──
const frames=(n)=>new Promise(r=>{const f=()=>n-->0?requestAnimationFrame(f):r();f()})
const until=async(fn,ms)=>{const t0=performance.now();while(!fn()){if(performance.now()-t0>ms)return false;await frames(2)}return true}
const fails=[]
const check=(name,ok,info)=>{console.log((ok?'PASS':'FAIL')+' — '+name+(info?' ('+info+')':''));if(!ok)fails.push(name)}
const anchorRect=()=>{ // 뷰포트에 걸친 첫 아이템의 (화면상) top
  for(const el of th.querySelectorAll('.it')){const r=el.getBoundingClientRect();if(r.bottom>0)return{el,top:r.top}}
}
async function run(){
  await frames(3)
  check('1 초기 꼬리 렌더', rendered()===TAIL, rendered()+'/'+TAIL)
  check('1 초기 바닥 고정', fromBottom()<=1, 'fromBottom='+fromBottom())

  // 2) 확장 + 무점프
  sc.scrollTop=150; await frames(2)
  const a=anchorRect()
  const ok2=await until(()=>rendered()>=TAIL+STEP,3000)
  check('2 센티널 확장 발화', ok2, 'rendered='+rendered())
  const d=Math.abs(anchorRect().el===a.el?anchorRect().top-a.top:999)
  check('2 확장 시 화면 위치 불변', d<=1, 'delta='+d.toFixed(2)+'px')

  // 3) 맨 위 고정 → 전체까지 연쇄 확장
  let guard=30
  while(start>0&&guard-->0){sc.scrollTop=0;await frames(4)}
  check('3 맨 위 연쇄 확장 → 전체', start===0&&rendered()===total, 'start='+start)

  // 4) 바닥 복귀 → 트림 + 바닥 유지
  sc.scrollTop=sc.scrollHeight
  const ok4=await until(()=>rendered()===TAIL,3000)
  check('4 바닥 복귀 트림', ok4, 'rendered='+rendered())
  check('4 트림 후 바닥 유지', fromBottom()<=1, 'fromBottom='+fromBottom())

  // 5) 바닥 고정 스트리밍 — rAF 바닥 고정 미러 + append, 윈도 유계
  let maxR=0
  for(let k=0;k<SLACK+20;k++){
    th.appendChild(mkItem(total++)) // 훅에선 total prop 갱신에 해당
    sc.scrollTop=sc.scrollHeight    // useThreadFollow의 rAF stick 미러
    await frames(1); maxR=Math.max(maxR,rendered())
  }
  await frames(3)
  check('5 스트리밍 윈도 유계', rendered()<=TAIL+SLACK+2&&maxR<=TAIL+SLACK+2, 'max='+maxR+' now='+rendered())

  // 6) 위를 읽는 중 아래 append — 화면 불변·트림 없음
  sc.scrollTop=Math.max(0,sc.scrollHeight/2); await frames(2)
  const b=anchorRect(), rBefore=rendered()
  for(let k=0;k<30;k++) th.appendChild(mkItem(total++))
  await frames(3)
  const d6=Math.abs(anchorRect().el===b.el?anchorRect().top-b.top:999)
  check('6 읽는 중 append 화면 불변', d6<=1, 'delta='+d6.toFixed(2)+'px')
  check('6 읽는 중 트림 안 함', rendered()===rBefore+30, rendered()+' vs '+(rBefore+30))

  console.log('POC-DONE '+(fails.length?'FAIL '+fails.length:'ALL-PASS'))
}
run()
</script>`

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { backgroundThrottling: false, offscreen: true }
  })
  let done = false
  win.webContents.on('console-message', (_e, _lv, msg) => {
    console.log('[page]', msg)
    if (msg.startsWith('POC-DONE')) {
      done = true
      app.exit(msg.includes('ALL-PASS') ? 0 : 1)
    }
  })
  // 오프스크린은 페인트 루프가 돌아야 rAF/IO가 진행된다
  win.webContents.on('paint', () => {})
  win.webContents.setFrameRate(60)
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  setTimeout(() => {
    if (!done) {
      console.log('[poc] TIMEOUT — 시나리오가 30s 안에 끝나지 않음')
      app.exit(2)
    }
  }, 30000)
})
