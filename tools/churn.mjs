// 프로세스 표를 흔드는 부하 발생기 — R28g GATE.
//
// 왜 있나: `src-tauri/src/ipc/accounts.rs`의 취소 회귀 테스트 둘은 **프로세스 스냅샷**
// (`CreateToolhelp32Snapshot`)으로 「래퍼 안의 프로그램」을 찾는다. 그 스냅샷은 프로세스
// 표가 흔들리는 순간 실패할 수 있고(ERROR_BAD_LENGTH), 그 실패가 「자식이 없다」와
// 구분되지 않으면 게이트가 확률적으로 붉어진다(R28f 확인 크리틱 R2 §3-A·§3-C).
// 그래서 게이트는 **부하를 깔고도** 초록이어야 한다 — 그 부하를 여기서 만든다.
//
//   node tools/churn.mjs --par=20 --secs=90
//
// 안전(★사용자의 실앱이 떠 있다):
//  · 이름 기반 kill을 **하지 않는다**. 우리가 spawn한 PID만 들고 있다가 끝낼 때 죽인다.
//  · 띄우는 것은 System32의 무해한 한 방짜리(`cmd /c ver`)뿐이고 스스로 즉시 끝난다.
//  · 파일도 네트워크도 건드리지 않는다.
import { spawn } from 'node:child_process';
import path from 'node:path';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const par = Number(arg('par', 20));
const secs = Number(arg('secs', 60));

const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const shell = path.join(sys32, 'cmd.exe');

const live = new Set();
let spawned = 0;
let stop = false;

function one() {
  if (stop) return;
  let p;
  try {
    // `ver`는 cmd 내장이라 손자를 안 만든다 — 표를 흔들되 남의 트리를 오염시키지 않는다.
    p = spawn(shell, ['/c', 'ver'], { stdio: 'ignore', windowsHide: true });
  } catch {
    setTimeout(one, 5);
    return;
  }
  spawned++;
  live.add(p);
  const done = () => {
    live.delete(p);
    one();
  };
  p.on('exit', done);
  p.on('error', done);
}

const t0 = Date.now();
for (let i = 0; i < par; i++) one();

const timer = setInterval(() => {
  if (Date.now() - t0 >= secs * 1000) {
    stop = true;
    clearInterval(timer);
    // 우리가 띄운 것만 정리한다(대부분 이미 스스로 끝났다).
    for (const p of live) {
      try {
        p.kill();
      } catch {
        /* 이미 끝났다 */
      }
    }
    const rate = Math.round(spawned / ((Date.now() - t0) / 1000));
    console.log(JSON.stringify({ spawned, secs: Math.round((Date.now() - t0) / 1000), perSec: rate }));
    process.exit(0);
  }
}, 200);
