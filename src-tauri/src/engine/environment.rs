//! Engine launch environments. Saved choices activate at the next app start so
//! resident CLI processes and queued turns keep one authentication environment.
use ccg_engine::identity::EngineKind;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const FILE: &str = "engine-environments.json";
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Environment {
    #[serde(default)]
    pub mode: Mode,
    #[serde(default)]
    pub cli_path: String,
    #[serde(default)]
    pub config_dir: String,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Managed,
    System,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub claude: Environment,
    pub codex: Environment,
}
impl Settings {
    fn get(&self, engine: EngineKind) -> &Environment {
        match engine {
            EngineKind::Claude => &self.claude,
            EngineKind::Codex => &self.codex,
        }
    }
}
fn read() -> Settings {
    ccg_store::read_home_json(FILE)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}
pub fn active() -> &'static Settings {
    static ACTIVE: OnceLock<Settings> = OnceLock::new();
    ACTIVE.get_or_init(read)
}
pub fn is_system(engine: EngineKind) -> bool {
    active().get(engine).mode == Mode::System
}
pub fn system_id(id: &str) -> bool {
    match id {
        "claude" => is_system(EngineKind::Claude),
        "codex" => is_system(EngineKind::Codex),
        _ => false,
    }
}
fn user_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}
fn expand(path: &str) -> PathBuf {
    if path == "~" {
        return user_home();
    }
    if path.starts_with("~/") || path.starts_with("~\\") {
        return user_home().join(&path[2..]);
    }
    PathBuf::from(path)
}
fn default_config_dir(engine: EngineKind) -> PathBuf {
    let (var, dir) = match engine {
        EngineKind::Claude => ("CLAUDE_CONFIG_DIR", ".claude"),
        EngineKind::Codex => ("CODEX_HOME", ".codex"),
    };
    std::env::var_os(var)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(dir))
}
fn detect_cli(engine: EngineKind) -> Option<PathBuf> {
    let name = match engine {
        EngineKind::Claude => "claude",
        EngineKind::Codex => "codex",
    };
    ccg_engine::codex::versions::resolve_bin(Path::new(name)).or_else(|| {
        let local = user_home().join(".local/bin").join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        });
        local.is_file().then_some(local)
    })
}
fn resolve_cli(engine: EngineKind, env: &Environment) -> Option<PathBuf> {
    if env.cli_path.is_empty() {
        detect_cli(engine)
    } else {
        let p = expand(&env.cli_path);
        (p.is_absolute() && p.is_file()).then_some(p)
    }
}
fn resolve_config(engine: EngineKind, env: &Environment) -> PathBuf {
    if env.config_dir.is_empty() {
        default_config_dir(engine)
    } else {
        expand(&env.config_dir)
    }
}
pub fn cli(engine: EngineKind) -> Option<PathBuf> {
    let env = active().get(engine);
    if env.mode != Mode::System {
        return None;
    }
    // Never fall through to an app-managed installation if the selected file disappeared.
    Some(resolve_cli(engine, env).unwrap_or_else(|| {
        if env.cli_path.is_empty() {
            PathBuf::from(match engine {
                EngineKind::Claude => "claude",
                EngineKind::Codex => "codex",
            })
        } else {
            expand(&env.cli_path)
        }
    }))
}
pub fn config_dir(engine: EngineKind) -> Option<PathBuf> {
    is_system(engine).then(|| resolve_config(engine, active().get(engine)))
}
fn error(engine: EngineKind, env: &Environment) -> Option<String> {
    if env.mode != Mode::System {
        return None;
    }
    if resolve_cli(engine, env).is_none() {
        return Some(
            ccg_fs::t(
                "CLI 실행 파일을 찾지 못했어요. 설치된 파일의 전체 경로를 입력해 주세요.",
                "CLI not found. Enter the full path to the installed executable.",
            )
            .into(),
        );
    }
    let dir = resolve_config(engine, env);
    if !dir.is_absolute() || !dir.is_dir() {
        return Some(
            ccg_fs::t(
                "설정 폴더를 찾지 못했어요. 터미널에서 사용하는 설정 폴더를 지정해 주세요.",
                "Configuration folder not found. Select the folder used by your terminal CLI.",
            )
            .into(),
        );
    }
    None
}
fn view(engine: EngineKind, env: &Environment) -> Value {
    json!({
        "mode": env.mode, "cliPath": env.cli_path, "configDir": env.config_dir,
        "detectedCliPath": detect_cli(engine), "detectedConfigDir": default_config_dir(engine),
        "resolvedCliPath": resolve_cli(engine, env), "resolvedConfigDir": resolve_config(engine, env),
        "error": error(engine, env), "activeMode": active().get(engine).mode,
        "detectionError": error(engine, &Environment { mode: Mode::System, ..Environment::default() }),
        "restartRequired": env != active().get(engine),
    })
}
pub fn state() -> Value {
    let current = active();
    let saved = read();
    json!({ "claude": view(EngineKind::Claude, &saved.claude), "codex": view(EngineKind::Codex, &saved.codex), "restartRequired": &saved != current })
}
// A resumed conversation must stay in the same authentication/configuration home.
// Legacy conversations belong to the managed environment until explicitly cleared.
pub fn bind_chat(chat: &str, req: &Value) -> Result<(), String> {
    let engine = if req.get("engine").and_then(Value::as_str) == Some("codex") {
        EngineKind::Codex
    } else {
        EngineKind::Claude
    };
    let key = serde_json::to_string(&(chat, engine)).map_err(|e| e.to_string())?;
    let current = if is_system(engine) {
        json!({ "mode": "system", "cli": cli(engine), "configDir": config_dir(engine) })
    } else {
        json!({ "mode": "managed" })
    };
    let file = "engine-environment-bindings.json";
    let mut bindings = ccg_store::read_home_json(file)
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let previous = bindings
        .get(&key)
        .cloned()
        .unwrap_or_else(|| json!({ "mode": "managed" }));
    let resume = req
        .get("resume")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    if resume && previous != current {
        return Err(ccg_fs::t("실행 환경이 바뀌었어요. 기존 대화는 이전 환경에서 이어가거나 새 대화를 시작해 주세요.", "The execution environment changed. Resume this conversation in its previous environment or start a new chat.").into());
    }
    if bindings.get(&key) != Some(&current) {
        bindings[&key] = current;
        ccg_store::write_home_file(file, &bindings.to_string()).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn save(engine: EngineKind, mut env: Environment) -> Result<(), String> {
    let _ = active();
    static WRITE: Mutex<()> = Mutex::new(());
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    env.cli_path = env.cli_path.trim().into();
    env.config_dir = env.config_dir.trim().into();
    if [&env.cli_path, &env.config_dir]
        .iter()
        .any(|s| s.chars().any(|c| c.is_control() || c == '"'))
    {
        return Err(ccg_fs::t(
            "경로에는 따옴표나 제어 문자를 넣을 수 없어요.",
            "Paths cannot contain quotes or control characters.",
        )
        .into());
    }
    if let Some(e) = error(engine, &env) {
        return Err(e);
    }
    let mut settings = read();
    match engine {
        EngineKind::Claude => settings.claude = env,
        EngineKind::Codex => settings.codex = env,
    }
    ccg_store::write_home_file(
        FILE,
        &serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
pub fn dispatch(channel: &str, p: &Value) -> Option<Value> {
    Some(match channel {
        "engine-environment:get" => state(),
        "engine-environment:save" => {
            let a = crate::ipc::arg(p, 0);
            let engine = match a.get("engine").and_then(Value::as_str) {
                Some("claude") => EngineKind::Claude,
                Some("codex") => EngineKind::Codex,
                _ => return Some(json!({ "error": "Unknown engine" })),
            };
            let result = serde_json::from_value::<Environment>(
                a.get("environment").cloned().unwrap_or(Value::Null),
            )
            .map_err(|e| e.to_string())
            .and_then(|env| save(engine, env));
            match result {
                Ok(()) => state(),
                Err(e) => json!({ "error": e }),
            }
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saving_is_per_engine_and_validates_paths_without_touching_config() {
        let home = super::super::testhome::take("system-environment-save");
        let cli = home.dir.join("installed CLI.exe");
        let config = home.dir.join("existing config");
        std::fs::write(&cli, "fixture executable").unwrap();
        std::fs::create_dir(&config).unwrap();
        let credentials = config.join("auth.json");
        std::fs::write(&credentials, "existing-login-must-stay").unwrap();
        let env = Environment {
            mode: Mode::System,
            cli_path: cli.to_string_lossy().into(),
            config_dir: config.to_string_lossy().into(),
        };
        save(EngineKind::Claude, env.clone()).unwrap();
        assert_eq!(read().claude, env);
        assert_eq!(read().codex.mode, Mode::Managed);
        assert_eq!(
            std::fs::read_to_string(&credentials).unwrap(),
            "existing-login-must-stay"
        );
        assert!(save(
            EngineKind::Codex,
            Environment {
                cli_path: "missing.exe".into(),
                ..env.clone()
            }
        )
        .is_err());
        assert_eq!(
            read().codex.mode,
            Mode::Managed,
            "a rejected save must not alter another engine"
        );
        assert!(save(
            EngineKind::Codex,
            Environment {
                config_dir: cli.to_string_lossy().into(),
                ..env.clone()
            }
        )
        .is_err());
        save(EngineKind::Codex, env.clone()).unwrap();
        save(EngineKind::Claude, Environment::default()).unwrap();
        assert_eq!(read().claude.mode, Mode::Managed);
        assert_eq!(read().codex, env);
        assert_eq!(
            std::fs::read_to_string(&credentials).unwrap(),
            "existing-login-must-stay"
        );
    }

    #[test]
    fn executable_resolution_keeps_spaces_and_does_not_fall_back_for_bad_overrides() {
        let home = super::super::testhome::take("system-environment-resolve");
        let cli = home.dir.join("company CLI.cmd");
        std::fs::write(&cli, "fixture").unwrap();
        let mut env = Environment {
            mode: Mode::System,
            cli_path: cli.to_string_lossy().into(),
            config_dir: home.dir.to_string_lossy().into(),
        };
        assert_eq!(resolve_cli(EngineKind::Claude, &env), Some(cli));
        assert!(error(EngineKind::Claude, &env).is_none());
        env.cli_path = home.dir.join("missing.exe").to_string_lossy().into();
        assert_eq!(resolve_cli(EngineKind::Claude, &env), None);
        assert!(error(EngineKind::Claude, &env).is_some());
    }
}
