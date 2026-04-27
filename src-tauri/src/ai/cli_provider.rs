//! Subprocess wrappers for `claude -p` and `codex exec`.
//!
//! Both binaries are invoked through `tokio::process::Command` with a
//! sandboxed environment. Only `HOME` and `PATH` are forwarded by default —
//! Codex additionally needs `CODEX_HOME` (optional override of `~/.codex`) so
//! we forward it when the parent process has it set.
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
        .unwrap_or_else(|| inv.channel.binary().to_string());

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
        return Err(CliError::NonZeroExit {
            status: output.status.code().unwrap_or(-1),
            stderr,
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

/// Build the minimal env passed to the subprocess. Only HOME + PATH by
/// default; Codex also needs `CODEX_HOME` when the parent set it.
fn sandboxed_env(channel: CliChannel) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Ok(home) = std::env::var("HOME") {
        env.insert("HOME".to_string(), home);
    }
    if let Ok(path) = std::env::var("PATH") {
        env.insert("PATH".to_string(), path);
    }
    if matches!(channel, CliChannel::CodexCli) {
        if let Ok(codex_home) = std::env::var("CODEX_HOME") {
            env.insert("CODEX_HOME".to_string(), codex_home);
        }
    }
    env
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
            // The text payload lives under `result`. Many of our prompts ask
            // the model to return JSON directly, so try to deserialize it;
            // fall back to wrapping the raw string.
            let text = outer
                .get("result")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            match text {
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
        let resp = invoke(
            CliInvocation::new(CliChannel::ClaudeP, "ignored").with_binary_override(&fake),
        )
        .await
        .expect("invoke");
        assert_eq!(resp.parsed.unwrap(), json!({"hello": "world"}));
    }

    #[tokio::test]
    async fn parses_codex_trailing_object() {
        let payload =
            "[2026-04-24] codex thinking…\nfinal answer:\n{\"answer\":42,\"ok\":true}\n";
        let (_keep, fake) = echo_binary(payload);
        let resp = invoke(
            CliInvocation::new(CliChannel::CodexCli, "ignored").with_binary_override(&fake),
        )
        .await
        .expect("invoke");
        assert_eq!(resp.parsed.unwrap(), json!({"answer": 42, "ok": true}));
    }

    #[tokio::test]
    async fn missing_binary_is_spawn_error() {
        let bogus = OsString::from("/nonexistent/wb-no-such-binary-xyz");
        let err = invoke(
            CliInvocation::new(CliChannel::ClaudeP, "x").with_binary_override(&bogus),
        )
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
