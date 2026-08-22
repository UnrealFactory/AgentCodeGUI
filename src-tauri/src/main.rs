// 콘솔 창 없이 뜨게 (릴리즈만 — dev는 로그를 봐야 한다)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;
mod win;

use std::fs::OpenOptions;

/// 단일 인스턴스 — **앱 홈 경로**를 키로 잡는다.
/// 격리 홈(CCG_HOME=.bench-home-tauri 등)끼리는 서로를 막지 않아야 벤치·dev가 사용자
/// 실앱과 나란히 돌 수 있다. 앱 홈 안의 잠금 파일을 공유 금지(dwShareMode=0)로 열어
/// 프로세스가 사는 동안 붙들고 있으면, 같은 홈을 쓰는 두 번째 인스턴스만 실패한다.
fn acquire_home_lock() -> Option<std::fs::File> {
    let home = ccg_store::app_home();
    let _ = std::fs::create_dir_all(&home);
    let path = home.join(".instance-lock");
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(0) // 다른 프로세스의 어떤 열기도 거부
            .open(path)
            .ok()
    }
    #[cfg(not(windows))]
    {
        OpenOptions::new().write(true).create(true).truncate(true).open(path).ok()
    }
}

fn main() {
    // 락은 프로세스 수명 동안 살아 있어야 한다(드랍되면 핸들이 닫혀 잠금이 풀린다)
    let Some(_lock) = acquire_home_lock() else {
        // 같은 앱 홈으로 이미 떠 있다 — 조용히 물러난다.
        // (2.6.2는 이 자리에서 기존 창을 앞으로 가져온다. 3.0은 창 라우팅이 서는
        //  M2에서 같은 동작을 붙인다 — docs/m1-report.md 갭 목록.)
        return;
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![ipc::ipc_call])
        .setup(|app| {
            win::create_main(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri 앱 실행 실패");
}
