#!/usr/bin/env bash
# R2 — 폴백이 **모든 문서**에 도달하는지 4경로로 확인한다 (M-UI R2 빌더).
#
# R1 크리틱이 실증한 구멍: 폴백이 **부팅 순간에 존재하던 문서에만** 걸렸다
# (재로드 후 · 나중에 연 추가 채팅 창 · 크래시 복구 재로드 = `__ccgGlass.events === 0`).
# 이 스크립트는 그중 1~3을 자동으로 돌린다. 4(크래시 복구)는 프로세스를 죽여야 해서
# 수동이다 — 아래 주석의 두 줄을 그대로 쓰면 된다.
#
# 준비:
#   npm run tauri:build
#   powershell -NoProfile -File docs/critic/tools/mui-spawn.ps1 \
#     -HomeDir .mui-home-r2 -ForceOff 1 -CdpPort 9333 -PidFile docs/critic/tools/.mui-r2-pid
# 사용:
#   bash scripts/poc-glass/poc-glass-paths.sh 9333 "FORCE-OFF"
#
# 4) 크래시 복구 두 갈래 (내가 띄운 PID 트리 안에서만 — 이름으로 kill 금지):
#   node -e "import('file:///$PWD/bench/lib.mjs').then(m=>{const t=m.procTreeMem(<셸PID>,{role:true});
#     console.log(JSON.stringify((t.procs||[]).map(p=>({pid:p.pid,role:p.role}))))})"
#   # role=renderer 를 죽이면 crash.rs `reload_all`(1순위), role=browser(msedgewebview2)를
#   # 죽이면 `recreate_windows`(2순위)로 간다. 죽인 뒤 아래 READ/SESSION 두 줄을 다시 돌린다.
set -e
PORT=${1:?cdp port}
LBL=${2:-run}

READ="JSON.stringify({cls:document.documentElement.className,\
style:!!document.getElementById('ccg-glass-fallback'),\
panel:getComputedStyle(document.documentElement).getPropertyValue('--panel').trim(),\
tOn:window.__ccgGlassBoot&&window.__ccgGlassBoot.tOn,\
tOff:window.__ccgGlassBoot&&window.__ccgGlassBoot.tOff,\
prev:window.__ccgGlassBoot&&window.__ccgGlassBoot.prev,\
paint:window.__ccgSplashPaintAt,\
ev:window.__ccgGlass&&window.__ccgGlass.events,\
ok:window.__ccgGlass&&window.__ccgGlass.state&&window.__ccgGlass.state.ok})"

echo "### [$LBL] 1) 부팅 창"
node docs/critic/tools/mui-cdp.mjs "$PORT" eval "$READ" | tail -1

node docs/critic/tools/mui-cdp.mjs "$PORT" eval "(()=>{location.reload();return 1})()" >/dev/null
sleep 5
echo "### [$LBL] 2) location.reload() 후"
node docs/critic/tools/mui-cdp.mjs "$PORT" eval "$READ" | tail -1

node docs/critic/tools/mui-cdp.mjs "$PORT" newwin >/dev/null
sleep 4
echo "### [$LBL] 3) 부팅 뒤 연 추가 채팅 창"
node docs/critic/tools/mui-cdp-target.mjs "$PORT" "#session" | tail -1
