//! `git:ai-message` — AI 커밋 메시지(최종 파리티 감사 R1 §3.4 **M5**).
//!
//! ## R2가 남긴 이유와, 그 이유가 틀린 자리
//!
//! T3T4 R2는 이 채널을 **미구현으로 남기고** 근거를 적었다(`ipc/git.rs` 헤더):
//!
//! > 2.6.2는 SDK `query()`에 `{ maxTurns: 1, allowedTools: [] }`를 준다. 그런데 그 둘은
//! > argv 플래그가 아니다 — 설치본 `claude.exe 0.3.241`의 `--help`에 `turns`는 0회
//! > 등장한다. SDK는 이 값들을 stream-json 제어 요청으로 넘긴다.
//!
//! 앞 문장(`--help`에 없다)은 사실이고 뒤 문장(제어 요청으로 넘긴다)은 **사실이 아니다.**
//! SDK 본체(`@anthropic-ai/claude-agent-sdk/sdk.mjs`)의 argv 조립을 직접 읽으면:
//!
//! ```js
//! if (u) Y.push("--max-turns", u.toString());          // ← maxTurns는 CLI 플래그다(숨은 플래그)
//! if (St.length > 0) Y.push("--allowedTools", St.join(","));  // ← 빈 배열이면 **아무것도 안 붙는다**
//! ```
//!
//! 즉 2.6.2의 `allowedTools: []`는 와이어에서 **아무 일도 하지 않았고**, 실제로 "1턴"을
//! 만든 것은 `--max-turns 1` 하나다. 그리고 그 플래그는 `--help`에 안 보일 뿐 **있다** —
//! 실측(`--print --input-format stream-json`에 빈 stdin):
//!
//! ```text
//!   --ccg-bogus-flag 1  →  error: unknown option '--ccg-bogus-flag'
//!   --max-turns 1       →  (조용히 통과)
//! ```
//!
//! 그래서 이 파일은 **2.6.2가 실제로 보낸 argv**를 그대로 보낸다. 도구 목록은
//! 2.6.2와 같이 **안 보낸다**(보내면 그쪽에 없던 제약이 생긴다 — 파리티는 의도가 아니라
//! 바이트다). 도구 폭주를 막는 것은 `--max-turns 1`과 90초 상한이고, 그 둘이 2.6.2의
//! 실제 방어선이었다.
//!
//! ## 2.6.2와 한 줄씩 마주 보는 표 (`src/main/git.ts:510-630`)
//!
//! | 조각 | 2.6.2 | 여기 |
//! |---|---|---|
//! | 저장소 루트 | `repoRoot(cwd)` | `ccg_fs::git::repo_root` |
//! | diff 예산 | 총 120k · 파일 24k, 넘으면 **헤더만** | [`AI_DIFF_CAP`]·[`AI_FILE_CAP`] |
//! | diff 직렬화 | `+`/`-` 줄만(ctx 생략) | [`serialize_diff`] |
//! | 톤 | `git log -15 --pretty=%s` | `ccg_fs::git::log(root, 15, 0)` |
//! | 계정 격리 | `CLAUDE_CONFIG_DIR = accountRunDir(email)` | `ccg_auth::claude::account_run_dir` |
//! | 전역 API 키 | "API로"라고 저장한 키만 존중, 아니면 **걷어낸다** | 같음 |
//! | 모델·effort 기본 | `sonnet` · `low` | 같음 |
//! | effort 매핑 | minimal → `thinking: disabled`(fable은 예외) | 드라이버와 같은 규칙 |
//! | 상한 | 90초 abort | 90초 뒤 kill |
//! | 출력 | `<commit>…</commit>` 안만, 코드펜스 줄 제거 | [`extract_commit`] |
//!
//! ## 왜 허브(엔진)를 안 타나
//!
//! 이 호출은 **대화가 아니다**: 채팅 id도 세션도 없고 스레드에 말풍선을 남기지 않으며
//! 정체성 축(§2.4)도 안 만든다. 허브에 태우면 `ChatRuntime` 하나가 유령 채팅으로 뜨고
//! `chat:status`가 그 유령을 사이드바에 그린다. 2.6.2도 엔진(`engine.ts`)이 아니라
//! `git.ts`에서 SDK를 직접 불렀다 — 같은 이유다.
//!
//! 블로킹은 `parity::owns`가 `spawn_blocking` 팔로 보내 준다(최대 90초).

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// 총량 상한(문자) — 2.6.2 `AI_DIFF_CAP`. 컨텍스트가 아니라 속도·비용 보호용이다.
const AI_DIFF_CAP: usize = 120_000;
/// 파일 하나의 상한 — 락파일·생성물 하나가 예산을 다 먹지 않게(2.6.2 `AI_FILE_CAP`).
const AI_FILE_CAP: usize = 24_000;
/// 2.6.2 `setTimeout(() => abort.abort(), 90_000)`.
const DEADLINE: Duration = Duration::from_secs(90);
/// 톤 참고용 최근 커밋 제목 수 — 2.6.2 `git log -15`.
const TONE_N: usize = 15;

fn en() -> bool {
    ccg_store::prefs::read_ui_prefs().get("ui.lang").and_then(Value::as_str) == Some("en")
}

/// 카드에 그대로 뜨는 문장 — 렌더러의 `t(ko, en)`과 같은 규약(사전 없음, 콜사이트 2인자).
fn t(en_on: bool, ko: &str, en_s: &str) -> String {
    if en_on { en_s.to_string() } else { ko.to_string() }
}

fn err(msg: String) -> Value {
    json!({ "ok": false, "error": msg })
}

/// 변경 줄만 남긴 diff 한 덩어리 — 2.6.2 `serializeDiff`.
/// `ctx`를 빼는 이유도 같다: 메시지 작성엔 변경 줄이면 충분하고 프롬프트가 짧아진다.
fn serialize_diff(rel: &str, d: &ccg_fs::diff::FileDiff) -> String {
    let mut out = String::with_capacity(256);
    out.push_str(&format!("### {rel} (+{} −{})", d.add, d.del));
    for l in &d.lines {
        match l.t {
            "add" => {
                out.push('\n');
                out.push('+');
                out.push_str(&l.text);
            }
            "del" => {
                out.push('\n');
                out.push('-');
                out.push_str(&l.text);
            }
            _ => {}
        }
    }
    out
}

/// 고른 파일들 → 프롬프트의 `[diff]` 블록. **캡이 걸린 자리는 전부 문장으로 말한다.**
///
/// 캡은 셋이고, 셋 다 같은 모양(`### <경로> (+N −M) — 본문 생략(<사유>): 규모만 참고`)으로
/// 착지한다:
///
/// | 캡 | 어디 | 사유 문구 |
/// |---|---|---|
/// | 파일 24,000자 | 여기([`AI_FILE_CAP`]) | 파일이 너무 큼 |
/// | 총량 120,000자 | 여기([`AI_DIFF_CAP`]) | 총량 상한 |
/// | 수집 예산 4MB/64KB | `ccg_fs::git`(`body_dropped`) | 파일이 너무 큼 · **수집 예산** |
///
/// 셋째 것이 R28b GIT R2 확인 크리틱이 잡은 자리다. 그때는 이 함수가 `body_dropped`를
/// 안 봐서 **본문도 사유도 없는 맨 헤더**가 나갔고(프롬프트 838자 대 옛길 15,838자),
/// 모델이 소스 변경을 한 줄도 못 본 채 커밋 메시지를 썼다. 헤더의 `(+40 −40)`은 정확했지만
/// 그건 규모일 뿐이다 — **없는 것을 없다고 말하지 않는 것**이 이 함수의 계약이다.
///
/// [`ccg_fs::git::BodyDropped::File`]을 「파일이 너무 큼」으로 옮기는 이유: 그 예산(64KB)은
/// [`AI_FILE_CAP`](24,000)보다 넉넉히 위라, 거기 걸린 파일은 파일당 호출(옛길)로 받아도
/// **반드시** 파일 캡에 걸린다. 즉 두 길의 프롬프트 문자열이 갈리지 않는다.
fn build_diff_text(en_on: bool, files: &[String], collected: &[ccg_fs::git::GitFileDiffResult]) -> String {
    use ccg_fs::git::BodyDropped;
    let mut diff_text = String::new();
    for (rel, d) in files.iter().zip(collected.iter()) {
        let head = match &d.diff {
            Some(x) => format!("### {rel} (+{} −{})", x.add, x.del),
            None => format!("### {rel}"),
        };
        let mut chunk = match &d.diff {
            Some(x) => serialize_diff(rel, x),
            None => format!(
                "{head} {}",
                if en_on {
                    format!("(no diff body: {})", d.error.as_deref().unwrap_or("not displayable"))
                } else {
                    format!("(diff 본문 없음: {})", d.error.as_deref().unwrap_or("표시 불가"))
                }
            ),
        };
        if d.diff.is_some() {
            // 수집 단계에서 이미 본문이 버려졌으면 `chunk`는 헤더뿐이라 아래 파일 캡이
            // 못 잡는다 — 그 자리를 여기서 말한다.
            if chunk.len() > AI_FILE_CAP || d.body_dropped == Some(BodyDropped::File) {
                chunk = format!(
                    "{head} {}",
                    t(en_on, "— 본문 생략(파일이 너무 큼): 규모만 참고", "— body omitted (file too large): use the size only")
                );
            } else if d.body_dropped == Some(BodyDropped::Batch) {
                chunk = format!(
                    "{head} {}",
                    t(en_on, "— 본문 생략(수집 예산): 규모만 참고", "— body omitted (collection budget): use the size only")
                );
            }
        }
        if diff_text.len() + chunk.len() > AI_DIFF_CAP {
            chunk = format!(
                "{head} {}",
                t(en_on, "— 본문 생략(총량 상한): 규모만 참고", "— body omitted (total cap reached): use the size only")
            );
        }
        if !diff_text.is_empty() {
            diff_text.push_str("\n\n");
        }
        diff_text.push_str(&chunk);
    }
    diff_text
}

/// `<commit>…</commit>` 안만 취한다(닫는 마커가 잘려도 허용) + 코드펜스 줄 제거.
///
/// 왜 마커인가(2.6.2 주석 그대로): *"아래와 같이 제안합니다…" 같은 서두를 모델이 붙여도
/// (금지 문구로는 안 막힌다 — 실측) 마커 안만 취하면 제목 칸에 잡담이 못 들어간다.*
pub fn extract_commit(text: &str) -> (String, String) {
    let lower = text.to_lowercase();
    let inner = match lower.find("<commit>") {
        Some(i) => {
            let from = i + "<commit>".len();
            let end = lower[from..].find("</commit>").map(|e| from + e).unwrap_or(text.len());
            &text[from..end]
        }
        None => text,
    };
    let clean = inner
        .lines()
        .filter(|l| !l.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n");
    let clean = clean.trim();
    match clean.find('\n') {
        None => (clean.to_string(), String::new()),
        Some(nl) => (clean[..nl].trim().to_string(), clean[nl + 1..].trim().to_string()),
    }
}

/// 프롬프트 조립 — 2.6.2 `git.ts:556-576`의 줄 순서 그대로.
fn build_prompt(en_on: bool, tone: &str, diff_text: &str) -> String {
    let mut p: Vec<String> = vec![t(
        en_on,
        "아래 diff로 git 커밋 메시지를 작성해줘.",
        "Write a git commit message for the diff below.",
    )];
    if !tone.is_empty() {
        p.push(if en_on {
            format!("\n[Recent commit subjects in this repo — follow this tone and format exactly]\n{tone}")
        } else {
            format!("\n[이 저장소의 최근 커밋 제목들 — 이 톤과 형식을 그대로 따라줘]\n{tone}")
        });
    }
    p.push(t(
        en_on,
        "\n[출력 형식 — 아래 마커 블록 하나만 출력한다. 마커 밖에는 어떤 글자도 쓰지 마라 (인사·설명·코드펜스 금지)]",
        "\n[Output format — print exactly one marker block as below. Write nothing outside the markers (no greetings, explanations, or code fences)]",
    ));
    p.push("<commit>".into());
    p.push(t(
        en_on,
        "제목 한 줄 (한국어, 72자 이내, 마침표 없이)",
        "One-line subject (English, 72 characters max, no trailing period)",
    ));
    p.push(String::new());
    p.push(t(
        en_on,
        "(선택) 빈 줄 하나 뒤 본문 2~4줄 — 변경이 여러 갈래일 때만",
        "(optional) after one blank line, a 2-4 line body — only when the change has multiple strands",
    ));
    p.push("</commit>".into());
    p.push(format!("\n[diff]\n{diff_text}"));
    p.join("\n")
}

/// effort → argv 조각. 2.6.2 `effortToOptions`와 드라이버(`ccg_engine::driver`)의 규칙이
/// 같다: `minimal`은 thinking을 끄고, **fable은 아무것도 안 보낸다**(명시적 disabled에 400).
fn effort_argv(model: &str, effort: &str) -> Vec<String> {
    match (effort, model) {
        ("minimal", "fable") => vec![],
        ("minimal", _) => vec!["--thinking".into(), "disabled".into()],
        (e, _) => vec!["--effort".into(), e.into()],
    }
}

/// 고른 파일들의 diff를 읽고 이 저장소의 최근 커밋 톤에 맞는 커밋 메시지를 1턴으로 쓴다.
///
/// 계정·모델·effort는 매번 카드에서 고른다(2.6.2 주석: *"계정마다 남은 한도가 달라
/// 「어느 계정으로 돌릴지」가 실사용 결정"*). 실패해도 입력창은 그대로다 —
/// 이 함수는 **던지지 않고** `{ok:false,error}`로 착지한다.
pub fn ai_message(a: &Value) -> Value {
    let en_on = en();
    let cwd = a.get("cwd").and_then(Value::as_str).unwrap_or("");
    let files: Vec<String> = a
        .get("files")
        .and_then(Value::as_array)
        .map(|x| x.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();

    let Some(root) = ccg_fs::git::repo_root(cwd) else {
        return err(t(en_on, "Git 저장소가 아니에요", "Not a Git repository"));
    };
    let root = root.to_string_lossy().to_string();
    if files.is_empty() {
        return err(t(en_on, "커밋에 담긴 파일이 없어요", "No files in this commit"));
    }
    if !crate::engine::versions::claude_bin_exists() {
        return err(t(
            en_on,
            "설치된 엔진이 없어요 — 설정 → Engine에서 먼저 설치해 주세요",
            "No engine installed — install one in Settings → Engine first",
        ));
    }
    let email = a
        .get("account")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(ccg_auth::claude::default_account_email);
    let Some(email) = email else {
        return err(t(
            en_on,
            "등록된 클로드 계정이 없어요 — 설정 → Account에서 로그인해 주세요",
            "No Claude account registered — sign in via Settings → Account",
        ));
    };
    let account_dir = match ccg_auth::claude::account_run_dir(&email) {
        Ok(d) => d,
        Err(e) => return err(format!("{e}")),
    };

    // diff 수집 — 파일 수와 **무관하게** git 스폰 2회가 보통이다(`bulk_file_diffs`).
    // 2.6.2는 파일마다 `gitFileDiff`를 직렬로 불러 **파일 N개 = 스폰 2N회**였고
    // (300개면 600번 프로세스), R1이 그 모양을 그대로 옮겼다.
    // 「1~2회」라고 단정하지 않는 이유: 32MB 캡을 넘으면 목록을 갈라 다시 부르므로
    // 몇 회 더 붙는다(400파일·72MB 실측 9회). 파일당 N회로 돌아가는 자리는
    // `bulk_file_diffs` 주석에 적힌 마지막 그물뿐이다.
    // 예산을 넘겨도 파일이 사라지진 않는 규약은 그대로다: 본문만 접고 헤더(+N −M)는 남긴다.
    // **접었으면 접었다고 말한다** — 캡 셋 전부 [`build_diff_text`]가 문장으로 옮긴다.
    let collected = ccg_fs::git::bulk_file_diffs(&root, &files);
    let diff_text = build_diff_text(en_on, &files, &collected);

    let tone = ccg_fs::git::log(&root, TONE_N, 0)
        .commits
        .iter()
        .map(|c| c.subject.clone())
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = build_prompt(en_on, tone.trim(), &diff_text);

    let model = a.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("sonnet");
    let effort = a.get("effort").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("low");

    match run_once(&root, &account_dir, model, effort, &prompt) {
        Ok(text) => {
            let (subject, body) = extract_commit(&text);
            if subject.is_empty() {
                return err(t(
                    en_on,
                    "메시지를 받지 못했어요 — 다시 시도해 주세요",
                    "No message received — please try again",
                ));
            }
            json!({ "ok": true, "subject": subject, "body": body })
        }
        Err(RunErr::Timeout) => err(t(
            en_on,
            "시간이 너무 걸려 중단했어요 — 다시 시도해 주세요",
            "Took too long and was stopped — please try again",
        )),
        Err(RunErr::Failed(why)) => err(if why.is_empty() {
            t(en_on, "AI 메시지 생성에 실패했어요", "Failed to generate the AI message")
        } else {
            why
        }),
    }
}

/// 실패의 두 얼굴 — 90초를 넘겼나(사용자에게 "다시" 라고 말한다), 아니면 다른 이유인가.
enum RunErr {
    Timeout,
    /// 빈 문자열이면 호출부가 기본 문장을 쓴다(스폰 실패 등은 원문을 그대로 싣는다).
    Failed(String),
}

/// **도구 없는 1턴** — 2.6.2가 실제로 보낸 argv 그대로 스폰하고, 프롬프트 한 줄을 넣고,
/// `result`(없으면 마지막 `assistant` 텍스트)를 거둔다.
fn run_once(
    root: &str,
    account_dir: &std::path::Path,
    model: &str,
    effort: &str,
    prompt: &str,
) -> Result<String, RunErr> {
    let bin = crate::engine::versions::claude_bin();
    let mut argv: Vec<String> = vec![
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--input-format".into(),
        "stream-json".into(),
    ];
    argv.extend(effort_argv(model, effort));
    argv.push("--model".into());
    argv.push(model.into());
    // 2.6.2 `permissionMode: 'default'`. `--permission-prompt-tool`은 **안 붙인다** —
    // 그쪽도 `canUseTool`/`permissionPromptToolName`을 안 줬다(= 승인 못 받으면 거절).
    argv.push("--permission-mode".into());
    argv.push("default".into());
    // ★ 이 한 줄이 "1턴"의 전부다(SDK: `if (u) Y.push("--max-turns", …)`).
    argv.push("--max-turns".into());
    argv.push("1".into());

    let mut cmd = Command::new(&bin);
    cmd.args(&argv)
        .current_dir(root)
        .env("CLAUDE_CONFIG_DIR", account_dir)
        .env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // 전역 ANTHROPIC_API_KEY는 사용자가 "API로"라고 저장해 둔 키만 존중하고, 아니면
    // 걷어내 구독으로 간다(2.6.2와 같은 결론 — 조용한 과금 방지).
    if let Ok(k) = std::env::var("ANTHROPIC_API_KEY") {
        if !k.is_empty() && ccg_store::api_config::env_key_choice(&k).as_deref() != Some("api") {
            cmd.env_remove("ANTHROPIC_API_KEY");
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — 콘솔이 번쩍이지 않게
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(RunErr::Failed(format!("{e}"))),
    };

    // 프롬프트 한 줄 → stdin 닫기. 드라이버의 `close_input`과 같은 자리다.
    if let Some(mut si) = child.stdin.take() {
        let line = json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] }
        });
        let _ = si.write_all(format!("{line}\n").as_bytes());
        let _ = si.flush();
    }

    // stdout은 별도 스레드에서 읽는다 — 여기서 블로킹 read를 하면 90초 상한을 못 건다.
    let (tx, rx) = mpsc::channel::<String>();
    if let Some(so) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(so).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    return;
                }
            }
        });
    }

    let started = Instant::now();
    let mut text = String::new();
    let mut done = false;
    while started.elapsed() < DEADLINE {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(line) => {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(got) = harvest(&v) {
                        text = got;
                    }
                    if v.get("type").and_then(Value::as_str) == Some("result") {
                        done = true;
                        break;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // 프로세스가 이미 죽었으면 더 기다릴 이유가 없다.
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let timed_out = !done && started.elapsed() >= DEADLINE;
    let _ = child.kill();
    let _ = child.wait();
    if timed_out {
        return Err(RunErr::Timeout);
    }
    if text.trim().is_empty() {
        return Err(RunErr::Failed(String::new()));
    }
    Ok(text)
}

/// 한 프레임에서 쓸 수 있는 텍스트 — 2.6.2의 `for await` 루프와 같은 우선순위
/// (`result.result`가 있으면 그것, 없으면 마지막 `assistant`의 text 블록).
fn harvest(v: &Value) -> Option<String> {
    match v.get("type").and_then(Value::as_str) {
        Some("result") => v
            .get("result")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        Some("assistant") => {
            let content = v.get("message")?.get("content")?.as_array()?;
            content
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .last()
                .map(str::to_string)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ccg_fs::diff::{DiffLine, FileDiff};

    #[test]
    fn the_marker_block_is_the_only_thing_that_reaches_the_subject_line() {
        // 모델이 서두를 붙여도 마커 안만 취한다(2.6.2가 실측으로 배운 그 자리).
        let (s, b) = extract_commit("아래와 같이 제안합니다.\n<commit>\n제목 한 줄\n\n본문 1\n본문 2\n</commit>\n감사합니다");
        assert_eq!(s, "제목 한 줄");
        assert_eq!(b, "본문 1\n본문 2");
        // 닫는 마커가 잘려도 허용.
        let (s, _) = extract_commit("<commit>\n잘린 제목");
        assert_eq!(s, "잘린 제목");
        // 마커가 아예 없으면 전체를 쓰되 코드펜스 줄은 걷어낸다.
        let (s, b) = extract_commit("```\n펜스 밖 제목\n\n본문\n```");
        assert_eq!(s, "펜스 밖 제목");
        assert_eq!(b, "본문");
        // 제목만 있으면 본문은 빈 문자열이다(카드가 undefined를 그리지 않게).
        let (s, b) = extract_commit("<commit>제목뿐</commit>");
        assert_eq!((s.as_str(), b.as_str()), ("제목뿐", ""));
    }

    /// diff 직렬화는 **변경 줄만** 남긴다 — ctx가 섞이면 프롬프트가 몇 배가 된다.
    #[test]
    fn only_the_changed_lines_are_serialized() {
        let d = FileDiff {
            path: "a.rs".into(),
            tag: "edit",
            add: 2,
            del: 1,
            lines: vec![
                DiffLine { t: "ctx", text: "그대로".into() },
                DiffLine { t: "add", text: "새 줄".into() },
                DiffLine { t: "del", text: "옛 줄".into() },
                DiffLine { t: "add", text: "새 줄 2".into() },
            ],
        };
        assert_eq!(serialize_diff("a.rs", &d), "### a.rs (+2 −1)\n+새 줄\n-옛 줄\n+새 줄 2");
    }

    /// effort 매핑은 드라이버와 **한 글자도 안 갈려야** 한다(fable의 400 사고 포함).
    #[test]
    fn the_effort_mapping_matches_the_driver() {
        assert_eq!(effort_argv("sonnet", "minimal"), vec!["--thinking", "disabled"]);
        assert!(effort_argv("fable", "minimal").is_empty(), "fable은 명시적 disabled에 400을 낸다");
        assert_eq!(effort_argv("sonnet", "low"), vec!["--effort", "low"]);
        assert_eq!(effort_argv("fable", "xhigh"), vec!["--effort", "xhigh"]);
    }

    /// 프레임 수확 우선순위 — `result`가 있으면 그것, 없으면 마지막 assistant 텍스트.
    #[test]
    fn the_result_frame_wins_over_the_assistant_text() {
        assert_eq!(harvest(&json!({ "type": "result", "result": "R" })).as_deref(), Some("R"));
        assert_eq!(harvest(&json!({ "type": "result", "result": "  " })), None, "빈 result는 안 쓴다");
        let a = json!({ "type": "assistant", "message": { "content": [
            { "type": "text", "text": "첫" }, { "type": "thinking", "thinking": "무시" }, { "type": "text", "text": "끝" }] } });
        assert_eq!(harvest(&a).as_deref(), Some("끝"));
        assert_eq!(harvest(&json!({ "type": "system" })), None);
    }

    /// 저장소가 아니면 **스폰 없이** 문장으로 착지한다(카드가 빈 채로 도는 일이 없게).
    #[test]
    fn a_non_repo_lands_as_a_sentence_without_spawning() {
        let _h = ccg_store::testhome::take("aimsg-nonrepo");
        let v = ai_message(&json!({ "cwd": "C:\\ccg-nowhere-\u{ac00}", "files": ["a.rs"] }));
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().is_some_and(|s| !s.is_empty()), "이유 없는 실패는 침묵이다");
    }

    /// 파일을 안 고른 커밋도 마찬가지 — 이것도 스폰 전에 걸린다.
    #[test]
    fn an_empty_file_list_never_reaches_the_engine() {
        let _h = ccg_store::testhome::take("aimsg-nofiles");
        let v = ai_message(&json!({ "cwd": std::env::current_dir().unwrap().to_string_lossy(), "files": [] }));
        assert_eq!(v["ok"], json!(false));
    }

    /// ★ R2 확인 크리틱이 잡은 자리의 회귀 그물 — 수집 단계에서 접힌 본문은 **문장이 되어야**
    /// 한다. 그때는 이 함수가 `body_dropped`를 안 봐서 본문도 사유도 없는 **맨 헤더**가
    /// 나갔고, 모델은 그것을 "이 파일 변경은 이게 전부"로 읽었다(프롬프트 838자 대 15,838자).
    ///
    /// 캡 셋이 각자 제 사유를 달고, **접히지 않은 파일 본문은 한 글자도 안 줄어야** 한다.
    #[test]
    fn a_body_dropped_by_the_collector_never_leaves_a_bare_header() {
        use ccg_fs::git::{BodyDropped, GitFileDiffResult};
        let head_only = |rel: &str, add: usize, del: usize, why: Option<BodyDropped>| GitFileDiffResult {
            diff: Some(FileDiff { path: rel.into(), tag: "edit", add, del, lines: Vec::new() }),
            body_dropped: why,
            ..Default::default()
        };
        let files: Vec<String> =
            ["생성물.lock", "배치/뒤 파일.txt", "src/작은 소스.rs"].iter().map(|s| s.to_string()).collect();
        let collected = vec![
            head_only("생성물.lock", 12_000, 12_000, Some(BodyDropped::File)),
            head_only("배치/뒤 파일.txt", 250, 250, Some(BodyDropped::Batch)),
            GitFileDiffResult {
                diff: Some(FileDiff {
                    path: "src/작은 소스.rs".into(),
                    tag: "edit",
                    add: 1,
                    del: 0,
                    lines: vec![DiffLine { t: "add", text: "fn b() {}".into() }],
                }),
                ..Default::default()
            },
        ];
        let out = build_diff_text(false, &files, &collected);
        assert!(out.contains("### 생성물.lock (+12000 −12000) — 본문 생략(파일이 너무 큼)"), "{out}");
        assert!(out.contains("### 배치/뒤 파일.txt (+250 −250) — 본문 생략(수집 예산)"), "{out}");
        // 접힌 행도 **규모는 정확히** 말한다 — 헤더의 숫자는 예산과 무관하다
        assert!(!out.contains("(+0 −0)"), "접히면서 증감까지 잃었다: {out}");
        // 같은 배치의 멀쩡한 파일은 본문 그대로(R2에서 증발했던 자리)
        assert!(out.contains("### src/작은 소스.rs (+1 −0)\n+fn b() {}"), "{out}");
        // 영어 판도 같은 자리에서 같은 말을 한다
        let en = build_diff_text(true, &files, &collected);
        assert!(en.contains("— body omitted (file too large)") && en.contains("— body omitted (collection budget)"), "{en}");
    }

    /// 프롬프트는 톤이 없어도 **마커 블록과 diff를 반드시** 싣는다.
    #[test]
    fn the_prompt_always_carries_the_marker_block_and_the_diff() {
        let p = build_prompt(false, "", "### a.rs (+1 −0)\n+x");
        assert!(p.contains("<commit>") && p.contains("</commit>"));
        assert!(p.contains("[diff]\n### a.rs"));
        assert!(!p.contains("최근 커밋 제목들"), "톤이 없는데 톤 블록을 넣었다");
        let p = build_prompt(true, "feat: x\nfix: y", "d");
        assert!(p.contains("Recent commit subjects") && p.contains("feat: x"));
        assert!(p.contains("One-line subject (English"), "영어 판인데 한국어를 요구한다");
    }
}
