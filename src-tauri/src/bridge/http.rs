use super::{changed, error, model, now, Shared};
use axum::{body::to_bytes, extract::{Request, State}, http::{header, Method, StatusCode}, response::IntoResponse, Json, Router};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

#[derive(Clone)]
struct Service { shared: Shared, app: AppHandle, host: String }

pub(super) fn serve(shared: Shared, app: AppHandle) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let host = listener.local_addr().map_err(|e| e.to_string())?.to_string();
        let url = format!("http://{host}");
        let discovery = {
            let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
            state.url = Some(url.clone());
            state.version += 1;
            json!({"protocolVersion": model::VERSION, "url": url, "token": state.token, "pid": std::process::id()})
        };
        let home = ccg_store::app_home();
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        let path = home.join("external-bridge.json");
        // Same-user native adapters discover the ephemeral port and bootstrap
        // credential here. It is never returned by the renderer snapshot API.
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        use std::io::Write;
        let mut file = options.open(path).map_err(|e| e.to_string())?;
        file.write_all(serde_json::to_string(&discovery).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
        changed(&app);
        let service = Service { shared, app, host };
        let router = Router::new().fallback(handle).with_state(service);
        axum::serve(listener, router).await.map_err(|e| e.to_string())
    })
}

async fn handle(State(service): State<Service>, request: Request) -> impl IntoResponse {
    let (parts, body) = request.into_parts();
    // Browsers use an adapter backend, not the native credential. Reject Origin
    // even when the caller supplies a token, and pin Host against DNS rebinding.
    if parts.headers.contains_key(header::ORIGIN)
        || parts.headers.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(service.host.as_str()) {
        return response(StatusCode::FORBIDDEN, error("Native loopback clients only; Origin is not accepted."));
    }
    let path: Vec<_> = parts.uri.path().trim_matches('/').split('/').collect();
    let client_id = if path.len() >= 3 && path[0] == "v1" && path[1] == "clients" { Some(path[2]) } else { None };
    let bearer = parts.headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|s| s.strip_prefix("Bearer ")).unwrap_or_default();
    let authenticated = {
        let state = service.shared.lock().unwrap_or_else(|e| e.into_inner());
        match client_id {
            Some(id) => state.clients.get(id).is_some_and(|c| c.token.as_deref() == Some(bearer) && !bearer.is_empty()),
            None => state.token == bearer,
        }
    };
    if !authenticated { return response(StatusCode::UNAUTHORIZED, error("Invalid connection credential. Reconnect using the discovery file.")); }

    let method = parts.method;
    let input = if method == Method::POST {
        let bytes = match tokio::time::timeout(Duration::from_secs(5), to_bytes(body, model::MAX_BODY)).await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) => return response(StatusCode::PAYLOAD_TOO_LARGE, error("Request exceeds 512 KiB.")),
            Err(_) => return response(StatusCode::REQUEST_TIMEOUT, error("Request body timed out.")),
        };
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => value,
            Err(_) => return response(StatusCode::BAD_REQUEST, error("Expected a JSON request body.")),
        }
    } else { Value::Null };

    let (result, did_change) = {
        let mut state = service.shared.lock().unwrap_or_else(|e| e.into_inner());
        let before = state.version;
        // Authentication is checked again after the asynchronous body read: a
        // revoked connection must not revive itself by finishing an old request.
        if client_id.is_some_and(|id| !state.clients.get(id).is_some_and(|c| c.token.as_deref() == Some(bearer) && !bearer.is_empty())) {
            return response(StatusCode::UNAUTHORIZED, error("Connection was revoked."));
        }
        let result: Result<Value, String> = match (method.as_str(), path.as_slice()) {
            ("GET", ["v1"]) => Ok(json!({"ok": true, "protocolVersion": model::VERSION,
                "capabilities": ["selection", "tool-state", "session-binding", "shared-session-bindings", "icons", "metadata"]})),
            ("GET", ["v1", "icons"]) => Ok(json!({"ok": true, "icons": model::icons()})),
            ("POST", ["v1", "connect"]) => {
                let version = input["protocolVersion"].as_u64().unwrap_or(0);
                if version != u64::from(model::VERSION) { Err("Unsupported protocolVersion; expected 1.".into()) }
                else { serde_json::from_value(input["manifest"].clone()).map_err(|e| e.to_string()).and_then(|m| state.connect(model::VERSION, m, now())) }
            }
            ("POST", ["v1", "clients", id, "publish"]) => {
                match input["revision"].as_u64() {
                    Some(rev) => serde_json::from_value(input["document"].clone()).map_err(|e| e.to_string()).and_then(|d| state.publish(id, rev, d, now())),
                    None => Err("revision must be an unsigned integer.".into()),
                }
            }
            ("POST", ["v1", "clients", id, "manifest"]) => serde_json::from_value(input["manifest"].clone()).map_err(|e| e.to_string()).and_then(|m| state.update_manifest(id, m)),
            ("GET", ["v1", "clients", id, "poll"]) => state.poll(id, now()),
            ("DELETE", ["v1", "clients", id]) => state.leave(id),
            _ => return response(StatusCode::NOT_FOUND, error("Unknown endpoint or method.")),
        };
        (result, state.version != before)
    };
    if did_change && result.is_ok() { changed(&service.app); }
    match result {
        Ok(value) => response(StatusCode::OK, value),
        Err(e) => response(StatusCode::BAD_REQUEST, error(e)),
    }
}

fn response(status: StatusCode, value: Value) -> axum::response::Response {
    (status, [(header::CACHE_CONTROL, "no-store"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], Json(value)).into_response()
}
