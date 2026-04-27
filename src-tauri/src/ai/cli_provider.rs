//! Subprocess wrappers for `claude -p` and `codex exec`.
//!
//! Both binaries are invoked through `tokio::process::Command` with a
//! sandboxed environment: HOME/PATH, login identity for CLI auth, and a small
//! provider-specific allowlist such as `CODEX_HOME` or API-key env vars when
//! the parent process has them set.
//!
//! Validated flag surface (2026-04-24):
//! * `claude -p <prompt> --output-format=json` — the response object exposes
//!   `result` (text payload) and metadata. We extract `result` and JSON-parse
//!   it. Supports `--json-schema=<schema>` for guaranteed-structured output.
//! * `codex exec <prompt> --output-schema <FILE>` — when a schema is supplied
//!   the final assistant turn is the JSON object on stdout. Without a schema,
//!   we capture the trailing `{...}`/`[...]` block with a tolerant parser.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

/// Default per-call timeout. Spec target is <12s cold / <6s warm; we add
/// headroom for both subprocess startup and slow networks.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliChannel {
    ClaudeP,
    CodexCli,
}

impl CliChannel {
    pub const fn binary(self) -> &'static str {
        match self {
            CliChannel::ClaudeP => "claude",
            CliChannel::CodexCli => "codex",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            CliChannel::ClaudeP => "claude-p",
            CliChannel::CodexCli => "codex-cli",
        }
    }
}

/// Inputs for a single CLI invocation.
#[derive(Debug, Clone)]
pub struct CliInvocation<'a> {
    pub channel: CliChannel,
    pub prompt: &'a str,
    /// Optional JSON schema. When present, callers get a guaranteed JSON
    /// object back (provider native structured-output flag is used).
    pub schema: Option<&'a Value>,
    pub timeout: Duration,
    /// Override the resolved binary path. Used by tests with a fake binary.
    pub binary_override: Option<&'a OsStr>,
}

impl<'a> CliInvocation<'a> {
    pub fn new(channel: CliChannel, prompt: &'a str) -> Self {
        Self {
            channel,
            prompt,
            schema: None,
            timeout: DEFAULT_TIMEOUT,
            binary_override: None,
        }
    }

    pub fn with_schema(mut self, schema: &'a Value) -> Self {
        self.schema = Some(schema);
        self
    }

    pub fn with_timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }

    pub fn with_binary_override(mut self, path: &'a OsStr) -> Self {
        self.binary_override = Some(path);
        self
    }
}

/// Successful subprocess result. `parsed` is `Some` when stdout could be
/// JSON-decoded.
#[derive(Debug, Clone)]
pub struct CliResponse {
    pub channel: CliChannel,
    pub stdout: String,
    pub stderr: String,
    pub parsed: Option<Value>,
    pub elapsed_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("subprocess timed out after {0:?}")]
    Timed(Duration),
    #[error("subprocess exited with status {status}: {stderr}")]
    NonZeroExit { status: i32, stderr: String },
    #[error("failed to spawn `{binary}`: {source}")]
    Spawn {
        binary: String,
        #[source]
        source: std::io::Error,
    },
    #[error("io error talking to `{binary}`: {source}")]
    Io {
        binary: String,
        #[source]
        source: std::io::Error,
    },
    #[error("could not parse JSON from `{channel}` stdout: {source}")]
    ParseJson {
        channel: &'static str,
        #[source]
        source: serde_json::Error,
    },
}

/// Spawn the requested CLI, write the prompt over stdin (when applicable),
/// wait up to `inv.timeout`, and JSON-parse the structured payload.
pub async fn invoke(inv: CliInvocation<'_>) -> Result<CliResponse, CliError> {
    let started = std::time::Instant::now();
    let binary_str = inv
        .binary_override
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| resolve_channel_binary(inv.channel));

    let mut cmd = Command::new(&binary_str);
    cmd.env_clear();
    cmd.envs(sandboxed_env(inv.channel));
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let writes_stdin = configure(&mut cmd, &inv);

    let mut child = cmd.spawn().map_err(|source| CliError::Spawn {
        binary: binary_str.clone(),
        source,
    })?;

    if writes_stdin {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(inv.prompt.as_bytes())
                .await
                .map_err(|source| CliError::Io {
                    binary: binary_str.clone(),
                    source,
                })?;
            stdin.shutdown().await.ok();
        }
    } else {
        // Drop stdin to signal EOF for CLIs that read it opportunistically.
        drop(child.stdin.take());
    }

    let output = match timeout(inv.timeout, child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            return Err(CliError::Io {
                binary: binary_str,
                source: e,
            })
        }
        Err(_) => return Err(CliError::Timed(inv.timeout)),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        let diagnostic = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr
        };
        return Err(CliError::NonZeroExit {
            status: output.status.code().unwrap_or(-1),
            stderr: diagnostic,
        });
    }

    let parsed = parse_response(inv.channel, &stdout)?;

    Ok(CliResponse {
        channel: inv.channel,
        stdout,
        stderr,
        parsed,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Returns `true` when the prompt should be written to stdin (Codex). For
/// `claude -p` we pass the prompt as a positional arg so quoting works.
fn configure(cmd: &mut Command, inv: &CliInvocation<'_>) -> bool {
    match inv.channel {
        CliChannel::ClaudeP => {
            cmd.arg("-p")
                .arg(inv.prompt)
                .arg("--output-format")
                .arg("json")
                .arg("--permission-mode")
                .arg("bypassPermissions");
            if let Some(schema) = inv.schema {
                cmd.arg("--json-schema").arg(schema.to_string());
            }
            false
        }
        CliChannel::CodexCli => {
            cmd.arg("exec")
                .arg("--skip-git-repo-check")
                .arg("--ignore-rules");
            if let Some(schema) = inv.schema {
                if let Ok(file) = write_temp_schema(schema) {
                    cmd.arg("--output-schema").arg(file);
                }
            }
            // Prompt goes via stdin (`-` placeholder is the CLI's idiomatic
            // form; it also accepts the absent positional with stdin).
            cmd.arg("-");
            true
        }
    }
}

/// Resolve the binary path used for a CLI channel. Desktop app launches often
/// have a short PATH, so prefer the known install locations before falling
/// back to PATH lookup. Env overrides are intentionally first for debugging.
pub fn resolve_channel_binary(channel: CliChannel) -> String {
    if let Ok(override_path) = std::env::var(binary_override_env(channel)) {
        if !override_path.trim().is_empty() {
            return override_path;
        }
    }

    for candidate in preferred_binary_paths(channel) {
        if is_executable(&candidate) {
            return candidate.to_string_lossy().into_owned();
        }
    }

    which::which(channel.binary())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| channel.binary().to_string())
}

pub fn resolved_channel_binary_path(channel: CliChannel) -> Option<String> {
    let resolved = resolve_channel_binary(channel);
    let path = Path::new(&resolved);
    if is_executable(path) {
        return Some(resolved);
    }
    which::which(&resolved)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

fn binary_override_env(channel: CliChannel) -> &'static str {
    match channel {
        CliChannel::ClaudeP => "WORDBRAIN_CLAUDE_BIN",
        CliChannel::CodexCli => "WORDBRAIN_CODEX_BIN",
    }
}

fn preferred_binary_paths(channel: CliChannel) -> Vec<PathBuf> {
    let home = std::env::var("HOME").ok().filter(|s| !s.is_empty());
    match channel {
        CliChannel::ClaudeP => {
            let mut paths = Vec::new();
            if let Some(home) = &home {
                paths.push(PathBuf::from(home).join(".local/bin/claude"));
            }
            paths.extend([
                PathBuf::from("/opt/homebrew/bin/claude"),
                PathBuf::from("/usr/local/bin/claude"),
            ]);
            paths
        }
        CliChannel::CodexCli => {
            let mut paths = vec![PathBuf::from("/opt/homebrew/bin/codex")];
            if let Some(home) = &home {
                paths.push(PathBuf::from(home).join(".local/bin/codex"));
                paths.push(PathBuf::from(home).join(".cargo/bin/codex"));
            }
            paths.extend([
                PathBuf::from("/usr/local/bin/codex"),
                PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
            ]);
            paths
        }
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Build the minimal env passed to the subprocess. HOME + PATH are the base,
/// but Claude Code OAuth/keychain auth also needs the login identity
/// (`USER`/`LOGNAME`); without those it reports "Not logged in" even when a
/// normal terminal session is authenticated.
fn sandboxed_env(channel: CliChannel) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Ok(home) = std::env::var("HOME") {
        env.insert("HOME".to_string(), home);
    }
    env.insert("PATH".to_string(), effective_path());

    for key in ["USER", "LOGNAME", "SHELL", "TMPDIR"] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                env.insert(key.to_string(), value);
            }
        }
    }

    if !env.contains_key("USER") || !env.contains_key("LOGNAME") {
        if let Some(login) = infer_login_name() {
            env.entry("USER".to_string())
                .or_insert_with(|| login.clone());
            env.entry("LOGNAME".to_string()).or_insert(login);
        }
    }

    if matches!(channel, CliChannel::CodexCli) {
        for key in ["CODEX_HOME", "OPENAI_API_KEY"] {
            if let Ok(value) = std::env::var(key) {
                if !value.is_empty() {
                    env.insert(key.to_string(), value);
                }
            }
        }
        if !env.contains_key("CODEX_HOME") {
            if let Some(home) = env.get("HOME") {
                let codex_home = Path::new(home).join(".codex");
                if codex_home.is_dir() {
                    env.insert(
                        "CODEX_HOME".to_string(),
                        codex_home.to_string_lossy().into_owned(),
                    );
                }
            }
        }
    }
    if matches!(channel, CliChannel::ClaudeP) {
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CONFIG_DIR",
        ] {
            if let Ok(value) = std::env::var(key) {
                if !value.is_empty() {
                    env.insert(key.to_string(), value);
                }
            }
        }
    }
    env
}

fn infer_login_name() -> Option<String> {
    std::env::var("USER")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("LOGNAME").ok().filter(|s| !s.is_empty()))
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .and_then(|home| {
                    Path::new(&home)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_string())
                })
                .filter(|s| !s.is_empty())
        })
}

fn effective_path() -> String {
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect();

    if let Ok(home) = std::env::var("HOME") {
        append_path(&mut parts, &format!("{home}/.local/bin"));
        append_path(&mut parts, &format!("{home}/.cargo/bin"));
        append_path(&mut parts, &format!("{home}/.bun/bin"));
    }
    for p in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        append_path(&mut parts, p);
    }

    parts.join(":")
}

fn append_path(parts: &mut Vec<String>, value: &str) {
    if parts.iter().any(|p| p == value) {
        return;
    }
    parts.push(value.to_string());
}

/// Persist the schema to a temporary file so `codex exec --output-schema`
/// can pick it up. We deliberately keep the path string in the command —
/// the OS reaps the temp file at process exit.
fn write_temp_schema(schema: &Value) -> std::io::Result<String> {
    use std::io::Write;
    let mut tmp = tempfile::Builder::new()
        .prefix("wb-schema-")
        .suffix(".json")
        .tempfile()?;
    tmp.write_all(schema.to_string().as_bytes())?;
    let (_, path) = tmp.keep().map_err(|e| e.error)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Channel-specific parser. `claude -p --output-format=json` returns a
/// structured object whose `result` field carries the model's text payload —
/// when that text is JSON we surface the parsed value to callers.
fn parse_response(channel: CliChannel, stdout: &str) -> Result<Option<Value>, CliError> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    match channel {
        CliChannel::ClaudeP => {
            let outer: Value =
                serde_json::from_str(trimmed).map_err(|source| CliError::ParseJson {
                    channel: "claude-p",
                    source,
                })?;
            if let Some(structured) = outer.get("structured_output") {
                return Ok(Some(structured.clone()));
            }
            // The text payload lives under `result`. Many of our prompts ask
            // the model to return JSON directly, so try to deserialize it;
            // fall back to wrapping the raw string.
            let text = outer
                .get("result")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            match text {
                Some(t) if t.trim().is_empty() => Ok(None),
                Some(t) => match extract_json_payload(&t) {
                    Some(parsed) => Ok(Some(parsed)),
                    None => Ok(Some(Value::String(t))),
                },
                None => Ok(Some(outer)),
            }
        }
        CliChannel::CodexCli => Ok(extract_json_payload(trimmed)),
    }
}

/// Tolerant JSON sniff. Tries the whole string first; if that fails, scans
/// for the last `{...}` or `[...]` block in the stdout (Codex prints status
/// chatter before the structured payload when no schema is supplied).
fn extract_json_payload(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Some(v);
    }
    let last_open = trimmed.rfind('{').or_else(|| trimmed.rfind('['))?;
    let candidate = &trimmed[last_open..];
    serde_json::from_str::<Value>(candidate).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::ffi::OsString;

    fn echo_binary(payload: &str) -> (tempfile::NamedTempFile, OsString) {
        // Self-contained fake CLI: invokes /bin/cat by absolute path so the
        // child process does not depend on PATH (a sibling test mutates
        // PATH while exercising the unavailable-binary fallback path, and
        // Cargo runs lib tests on shared process env in parallel).
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let mut tmp = tempfile::Builder::new()
            .prefix("wb-fake-cli-")
            .suffix(".sh")
            .tempfile()
            .expect("tempfile");
        writeln!(tmp, "#!/bin/sh").unwrap();
        writeln!(tmp, "/bin/cat <<'JSON'").unwrap();
        writeln!(tmp, "{payload}").unwrap();
        writeln!(tmp, "JSON").unwrap();
        let path = tmp.path().to_path_buf();
        let mut perm = std::fs::metadata(&path).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&path, perm).unwrap();
        let os = OsString::from(path);
        (tmp, os)
    }

    #[tokio::test]
    async fn parses_claude_envelope() {
        let envelope = serde_json::json!({
            "type": "result",
            "result": "{\"hello\":\"world\"}"
        })
        .to_string();
        let (_keep, fake) = echo_binary(&envelope);
        let resp =
            invoke(CliInvocation::new(CliChannel::ClaudeP, "ignored").with_binary_override(&fake))
                .await
                .expect("invoke");
        assert_eq!(resp.parsed.unwrap(), json!({"hello": "world"}));
    }

    #[tokio::test]
    async fn parses_claude_structured_output_envelope() {
        let envelope = serde_json::json!({
            "type": "result",
            "result": "",
            "structured_output": {
                "story_text": "Maya followed her ____ into the attic.",
                "blanks": [
                    {
                        "index": 0,
                        "target_word": "curiosity",
                        "options": ["curiosity", "boredom", "anger", "hunger"],
                        "correct_index": 0
                    }
                ]
            }
        })
        .to_string();
        let (_keep, fake) = echo_binary(&envelope);
        let resp =
            invoke(CliInvocation::new(CliChannel::ClaudeP, "ignored").with_binary_override(&fake))
                .await
                .expect("invoke");
        assert_eq!(
            resp.parsed.unwrap(),
            json!({
                "story_text": "Maya followed her ____ into the attic.",
                "blanks": [
                    {
                        "index": 0,
                        "target_word": "curiosity",
                        "options": ["curiosity", "boredom", "anger", "hunger"],
                        "correct_index": 0
                    }
                ]
            })
        );
    }

    #[tokio::test]
    async fn parses_codex_trailing_object() {
        let payload = "[2026-04-24] codex thinking…\nfinal answer:\n{\"answer\":42,\"ok\":true}\n";
        let (_keep, fake) = echo_binary(payload);
        let resp =
            invoke(CliInvocation::new(CliChannel::CodexCli, "ignored").with_binary_override(&fake))
                .await
                .expect("invoke");
        assert_eq!(resp.parsed.unwrap(), json!({"answer": 42, "ok": true}));
    }

    #[tokio::test]
    async fn missing_binary_is_spawn_error() {
        let bogus = OsString::from("/nonexistent/wb-no-such-binary-xyz");
        let err = invoke(CliInvocation::new(CliChannel::ClaudeP, "x").with_binary_override(&bogus))
            .await
            .expect_err("must fail");
        assert!(matches!(err, CliError::Spawn { .. }));
    }

    #[tokio::test]
    async fn timeout_kills_long_runner() {
        use std::os::unix::fs::PermissionsExt;
        let mut tmp = tempfile::Builder::new()
            .prefix("wb-slow-cli-")
            .suffix(".sh")
            .tempfile()
            .expect("tempfile");
        // Absolute /bin/sleep so the child does not depend on PATH.
        std::io::Write::write_all(&mut tmp, b"#!/bin/sh\n/bin/sleep 5\n").unwrap();
        let path = tmp.path().to_path_buf();
        let mut perm = std::fs::metadata(&path).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&path, perm).unwrap();
        let os = OsString::from(path);
        let err = invoke(
            CliInvocation::new(CliChannel::ClaudeP, "x")
                .with_timeout(Duration::from_millis(250))
                .with_binary_override(&os),
        )
        .await
        .expect_err("must time out");
        assert!(matches!(err, CliError::Timed(_)));
    }
}
