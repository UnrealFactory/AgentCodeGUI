//! 서버 레지스트리 — (스펙 id, 루트)마다 인스턴스 하나. 지연 스폰 · 유휴 회수 · 좀비 안전망.
//!
//! 2.6.2가 실측으로 세운 수명 규약을 그대로 옮긴다:
//!  - **지연 스폰**: 파일을 물었을 때 그 프로젝트의 서버를 띄운다. 프리웜은 그걸 앞당길 뿐.
//!  - **유휴 회수**: 마지막 사용에서 TTL(bundled 10분 / 무거운 서버 30분)이 지나면 프로세스째
//!    접는다. 회수가 없으면 폴더 수만큼 무한 누적된다(2.6.2 실측: 이틀 상주에 tsserver 세트
//!    6개 3GB+). 접어도 다음 요청이 도로 스폰하고, **토큰 디스크 캐시 + 프리웜** 덕에 복귀가
//!    싸다 — 그래서 회수가 체감 손해가 아니다.
//!  - **재스폰 쿨다운 30초**: 망가진 설치가 스폰 루프를 돌지 않게.
//!  - **좀비 안전망**: 자식이 이미 죽었는데 핸들만 남은 항목을 스윕이 걷어낸다.
//!
//! 테스트 주입: `CCG_LSP_IDLE_TTL_MS`(TTL 덮어쓰기) · `CCG_LSP_SWEEP_MS`(스윕 주기).
//! 기본값은 스펙/2.6.2 그대로 — 벤치가 10분을 기다리지 않고 회수를 실증하기 위한 문이다.

use crate::server::{now_ms, Server, Status};
use crate::spec::{root_for, ServerSpec};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// 죽은/실패한 서버는 이만큼 지나야 다시 띄운다(2.6.2 RESPAWN_COOLDOWN).
const RESPAWN_COOLDOWN_MS: u64 = 30_000;
const SWEEP_EVERY_MS_DEFAULT: u64 = 60_000;

struct Entry {
    server: Option<Arc<Server>>,
    /// 마지막으로 죽은 시각(0 = 죽은 적 없음) — 쿨다운 판정.
    died_at_ms: u64,
    last_error: Option<String>,
}

#[derive(Default)]
struct Registry {
    map: HashMap<String, Entry>,
}

static REG: OnceLock<Mutex<Registry>> = OnceLock::new();
static SWEEPER: AtomicBool = AtomicBool::new(false);

fn reg() -> &'static Mutex<Registry> {
    REG.get_or_init(|| Mutex::new(Registry::default()))
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok()?.parse::<u64>().ok()
}

fn ttl_for(spec: &ServerSpec) -> u64 {
    env_u64("CCG_LSP_IDLE_TTL_MS").unwrap_or(spec.idle_ttl_ms)
}

fn key_of(spec: &ServerSpec, root: &Path) -> String {
    format!("{}|{}", spec.id, root.to_string_lossy().to_ascii_lowercase())
}

/// 이 파일을 맡는 서버(없으면 스폰). 스폰 자체가 실패하면 `Err(이유)`.
pub fn ensure(spec: &'static ServerSpec, root: &Path) -> Result<Arc<Server>, String> {
    let key = key_of(spec, root);
    {
        let mut r = reg().lock().unwrap();
        if let Some(e) = r.map.get_mut(&key) {
            if let Some(s) = &e.server {
                if s.raw_status() != Status::Error {
                    s.touch();
                    return Ok(s.clone());
                }
                // 죽었다 — 쿨다운 안이면 그 상태를 그대로 보고한다(스폰 루프 방지)
                if now_ms().saturating_sub(e.died_at_ms) < RESPAWN_COOLDOWN_MS {
                    return Ok(s.clone());
                }
                e.server = None;
            } else if e.died_at_ms > 0 && now_ms().saturating_sub(e.died_at_ms) < RESPAWN_COOLDOWN_MS {
                return Err(e.last_error.clone().unwrap_or_else(|| "재스폰 쿨다운".into()));
            }
        }
    }
    // 스폰은 레지스트리 잠금 **밖에서** — 프로세스 생성은 수십 ms고, 그동안 다른 창의
    // status 폴링까지 세워 두면 UI가 멈춘 것처럼 보인다.
    let spawned = Server::spawn(spec, root);
    let mut r = reg().lock().unwrap();
    match spawned {
        Ok(s) => {
            // 경쟁 스폰 — 그 사이 누가 먼저 넣었으면 내 것을 접고 그쪽을 쓴다
            if let Some(e) = r.map.get(&key) {
                if let Some(existing) = &e.server {
                    if existing.raw_status() != Status::Error {
                        let mine = s.clone();
                        let winner = existing.clone();
                        drop(r);
                        mine.shutdown("경쟁 스폰 — 먼저 등록된 서버를 쓴다");
                        winner.touch();
                        return Ok(winner);
                    }
                }
            }
            r.map.insert(key, Entry { server: Some(s.clone()), died_at_ms: 0, last_error: None });
            drop(r);
            start_sweeper();
            Ok(s)
        }
        Err(e) => {
            r.map.insert(
                key,
                Entry { server: None, died_at_ms: now_ms(), last_error: Some(e.clone()) },
            );
            Err(e)
        }
    }
}

/// 이 파일의 서버 루트(스펙의 루트 규칙 적용).
pub fn root_of(spec: &ServerSpec, abs: &Path, cwd: &Path) -> PathBuf {
    root_for(spec, abs, cwd)
}

/// cwd 아래(또는 그 자체)에 뜬 서버들의 상태 — 탐색기 폴더 배지.
pub fn project_state(cwd: &Path) -> (&'static str, Option<f64>) {
    let root = cwd.to_string_lossy().to_ascii_lowercase();
    let prefix = format!("{root}{}", std::path::MAIN_SEPARATOR);
    let r = reg().lock().unwrap();
    let mut analyzing = false;
    let mut ready = false;
    let mut pct = None;
    for (k, e) in r.map.iter() {
        let sroot = &k[k.find('|').map(|i| i + 1).unwrap_or(0)..];
        if sroot != root && !sroot.starts_with(&prefix) {
            continue;
        }
        let Some(s) = &e.server else { continue };
        match s.raw_status() {
            Status::Error => continue,
            Status::Starting => {
                analyzing = true;
                if let Some(p) = s.progress_pct() {
                    pct = Some(p);
                }
            }
            Status::Ready => {
                if s.status() == Status::Starting {
                    analyzing = true;
                    if let Some(p) = s.progress_pct() {
                        pct = Some(p);
                    }
                } else if let Some(p) = s.progress_pct() {
                    // clangd: initialize는 즉시 끝나지만 백그라운드 인덱싱은 이어진다 —
                    // 진행률이 흐르는 동안은 '분석 중'으로 정직하게 보여 준다
                    analyzing = true;
                    pct = Some(p);
                } else {
                    ready = true;
                }
            }
        }
    }
    if analyzing {
        ("analyzing", pct)
    } else if ready {
        ("ready", None)
    } else {
        ("idle", None)
    }
}

/// 지금 살아 있는 서버 수(진단·테스트).
pub fn live_count() -> usize {
    reg().lock().unwrap().map.values().filter(|e| e.server.is_some()).count()
}

fn start_sweeper() {
    if SWEEPER.swap(true, Ordering::SeqCst) {
        return;
    }
    let every = env_u64("CCG_LSP_SWEEP_MS").unwrap_or(SWEEP_EVERY_MS_DEFAULT);
    std::thread::Builder::new()
        .name("ccg-lsp-sweep".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(every));
            sweep_idle();
        })
        .ok();
}

/// 유휴 회수 + 좀비 정리. 스윕 스레드가 부르고, 테스트가 직접 부를 수도 있다.
pub fn sweep_idle() {
    let mut doomed: Vec<(Arc<Server>, &'static str)> = Vec::new();
    {
        let mut r = reg().lock().unwrap();
        let mut drop_keys: Vec<String> = Vec::new();
        for (k, e) in r.map.iter_mut() {
            let Some(s) = &e.server else {
                // 실패 항목은 쿨다운이 지나면 자리째 비운다(맵이 루트 수만큼 자라지 않게)
                if e.died_at_ms > 0 && now_ms().saturating_sub(e.died_at_ms) > RESPAWN_COOLDOWN_MS * 4 {
                    drop_keys.push(k.clone());
                }
                continue;
            };
            // ① 좀비 안전망 — 프로세스는 이미 죽었는데 핸들만 남은 항목
            if s.raw_status() == Status::Error {
                doomed.push((s.clone(), "죽은 서버 정리"));
                e.server = None;
                e.died_at_ms = now_ms();
                continue;
            }
            // ② 유휴 회수
            if s.idle_ms() >= ttl_for(s.spec) {
                doomed.push((s.clone(), "유휴 서버 회수"));
                e.server = None;
                e.died_at_ms = 0; // 정상 회수 — 쿨다운 없이 다음 요청이 바로 되살린다
            }
        }
        for k in drop_keys {
            r.map.remove(&k);
        }
    }
    // 프로세스 종료(taskkill)는 잠금 밖에서 — 수십 ms 걸린다
    for (s, why) in doomed {
        s.shutdown(why);
    }
}

/// 앱 종료 — 서버를 전부 접는다(안 접으면 node/tsserver가 그대로 남는다).
pub fn dispose_all() {
    let taken: Vec<Arc<Server>> = {
        let mut r = reg().lock().unwrap();
        let list = r.map.values_mut().filter_map(|e| e.server.take()).collect();
        r.map.clear();
        list
    };
    for s in taken {
        s.shutdown("앱 종료");
    }
}
