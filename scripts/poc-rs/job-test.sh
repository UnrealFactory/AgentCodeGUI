#!/usr/bin/env bash
# M3 PoC 6 — job object 좀비 차단 대조 실험 (0원: claude.exe는 자격증명 없이 상주만).
#
#   bash scripts/poc-rs/job-test.sh --no-job     # 대조군: 부모가 죽어도 자식이 산다?
#   bash scripts/poc-rs/job-test.sh --with-job   # 실험군: KILL_ON_JOB_CLOSE
#
# 절차: poc가 claude.exe(337MB) + cmd.exe→ping.exe(손자 사슬)을 띄우고 pid를 남긴 뒤
#       job-go 파일을 기다린다 → 우리가 트리를 찍고 → go를 만들면 poc가
#       `taskkill /F /PID <자기자신>`으로 앱 크래시를 흉내낸다 → 다시 트리를 찍는다.
# ★ 정리는 반드시 PID 지정. 이름 기반 kill(taskkill /IM) 금지 — 사용자 실앱이 떠 있다.
set -u
MODE="${1:---with-job}"
BUSY="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EXE="$HERE/target/debug/poc_engine.exe"
T="$(cygpath -u "$(cmd //c echo %TEMP% 2>/dev/null | tr -d '\r')")/ccg-poc-rs"

alive() { tasklist //FI "PID eq $1" //NH 2>/dev/null | grep -qi "$1" && echo ALIVE || echo dead; }
kids()  { powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=$1' | ForEach-Object { \"\$(\$_.ProcessId) \$(\$_.Name)\" }" 2>/dev/null | tr -d '\r'; }

rm -f "$T/job-go" "$T/job-pids.json"
"$EXE" job "$MODE" $BUSY > "$T/job-$MODE$BUSY.log" 2>&1 &
DRIVER=$!

for _ in $(seq 1 150); do [ -f "$T/job-pids.json" ] && break; sleep 0.2; done
[ -f "$T/job-pids.json" ] || { echo "FAIL: no pids file"; exit 1; }
PIDS=$(cat "$T/job-pids.json"); echo "pids: $PIDS"
SELF=$(echo "$PIDS"   | sed 's/.*"self":\([0-9]*\).*/\1/')
CLAUDE=$(echo "$PIDS" | sed 's/.*"claude":\([0-9]*\).*/\1/')
CMD=$(echo "$PIDS"    | sed 's/.*"cmd":\([0-9]*\).*/\1/')
sleep 1
GRAND=$(kids "$CMD" | head -1 | cut -d' ' -f1)

echo "=== BEFORE kill ($MODE) ==="
echo "  poc(self) $SELF : $(alive "$SELF")"
echo "  claude.exe $CLAUDE : $(alive "$CLAUDE")"
echo "  cmd.exe    $CMD : $(alive "$CMD")"
echo "  grandchild $GRAND : $([ -n "$GRAND" ] && alive "$GRAND" || echo '(none)')"

touch "$T/job-go"
sleep 4
echo "=== AFTER  taskkill /F /PID $SELF ==="
echo "  poc(self) $SELF : $(alive "$SELF")"
A=$(alive "$CLAUDE"); B=$(alive "$CMD"); C=$([ -n "$GRAND" ] && alive "$GRAND" || echo dead)
echo "  claude.exe $CLAUDE : $A"
echo "  cmd.exe    $CMD : $B"
echo "  grandchild $GRAND : $C"

if [ "$A$B$C" = "deaddeaddead" ]; then echo "RESULT($MODE): all children reaped"
else echo "RESULT($MODE): ZOMBIES LEFT → cleaning up by PID"
  for p in "$CLAUDE" "$CMD" "$GRAND"; do
    [ -n "$p" ] && taskkill //F //T //PID "$p" 2>/dev/null | tr -d '\r'
  done
fi
wait $DRIVER 2>/dev/null
echo "--- log: $T/job-$MODE$BUSY.log"
