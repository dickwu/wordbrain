//! Ordered fallback chain: `claude -p` PRIMARY → `codex exec` SECONDARY.
//!
//! Story generation, MCQ explanation, writing grading and synonym extraction
//! all funnel through [`ai_call`]. On non-zero exit, JSON parse failure or
//! timeout we record the failure and try the next channel; if both fail the
//! caller gets [`AiUnavailable`] with the channel order tried plus the last
//! error string so the UI can render a single notification.
//!
//! Provider availability is detected once at startup via [`ai_provider_status`]
//! and cached behind a `OnceLock` for the lifetime of the process.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::cli_provider::{
    invoke, resolved_channel_binary_path, CliChannel, CliInvocation, CliResponse, DEFAULT_TIMEOUT,
};

/// What `ai_call` hands back to callers on success.
#[derive(Debug, Clone, Serialize)]
pub struct AiCallOutcome {
    pub channel: String,
    pub raw_text: String,
    pub parsed: Option<Value>,
    pub elapsed_ms: u64,
}

/// Structured error mirrored to the renderer when both channels fail.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiUnavailable {
    pub tried: Vec<String>,
    pub last_error: String,
}

impl std::fmt::Display for AiUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "AI providers unavailable (tried {}): {}",
            self.tried.join(" → "),
            self.last_error
        )
    }
}

impl std::error::Error for AiUnavailable {}

const DEFAULT_ORDER: &[CliChannel] = &[CliChannel::ClaudeP, CliChannel::CodexCli];

/// Public entry: run `prompt` against the chain, optionally with a JSON
/// schema for structured output. The first channel to succeed wins.
pub async fn ai_call(prompt: &str, schema: Option<&Value>) -> Result<AiCallOutcome, AiUnavailable> {
    ai_call_with_order(prompt, schema, DEFAULT_ORDER).await
}

/// Internal helper used by tests to inject a custom order or skip a channel.
pub async fn ai_call_with_order(
    prompt: &str,
    schema: Option<&Value>,
    order: &[CliChannel],
) -> Result<AiCallOutcome, AiUnavailable> {
    let mut last_error = String::from("no channels attempted");
    let mut tried: Vec<String> = Vec::with_capacity(order.len());

    for channel in order {
        let mut inv = CliInvocation::new(*channel, prompt).with_timeout(DEFAULT_TIMEOUT);
        if let Some(s) = schema {
            inv = inv.with_schema(s);
        }
        tried.push(channel.label().to_string());
        match invoke(inv).await {
            Ok(resp) => return Ok(success(*channel, resp)),
            Err(err) => {
                last_error = format!("{}: {err}", channel.label());
                log::warn!("ai_call: {last_error}");
                continue;
            }
        }
    }

    Err(AiUnavailable { tried, last_error })
}

fn success(channel: CliChannel, resp: CliResponse) -> AiCallOutcome {
    AiCallOutcome {
        channel: channel.label().to_string(),
        raw_text: resp.stdout,
        parsed: resp.parsed,
        elapsed_ms: resp.elapsed_ms,
    }
}

// ---------------------------------------------------------------------------
// Provider status (cached at startup, mirrored to the Settings panel)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub channel: String,
    pub binary: String,
    pub available: bool,
    pub resolved_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStatusReport {
    pub providers: Vec<ProviderStatus>,
    pub any_available: bool,
}

static PROVIDER_CACHE: OnceLock<ProviderStatusReport> = OnceLock::new();

fn detect_now() -> ProviderStatusReport {
    let providers = DEFAULT_ORDER
        .iter()
        .map(|c| {
            let resolved = resolved_channel_binary_path(*c);
            ProviderStatus {
                channel: c.label().to_string(),
                binary: c.binary().to_string(),
                available: resolved.is_some(),
                resolved_path: resolved,
            }
        })
        .collect::<Vec<_>>();
    let any_available = providers.iter().any(|p| p.available);
    ProviderStatusReport {
        providers,
        any_available,
    }
}

/// Tauri command — exposes the cached availability report to the renderer.
#[tauri::command]
pub async fn ai_provider_status() -> ProviderStatusReport {
    PROVIDER_CACHE.get_or_init(detect_now).clone()
}

/// Force a re-detection (called on app boot before the renderer asks).
pub fn warm_provider_cache() {
    let _ = PROVIDER_CACHE.get_or_init(detect_now);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_now_reports_two_channels() {
        let r = detect_now();
        assert_eq!(r.providers.len(), 2);
        assert_eq!(r.providers[0].channel, "claude-p");
        assert_eq!(r.providers[1].channel, "codex-cli");
    }

    #[tokio::test]
    async fn fallback_then_failure_uses_secondary_label() {
        // Both channels resolve to bogus override paths — the loop should
        // attempt claude-p first, then codex-cli, then surface AiUnavailable
        // with the codex-cli error as the last_error. Restore env afterward to
        // avoid leaking into sibling tests in the same binary.
        let prev_path = std::env::var("PATH").unwrap_or_default();
        let prev_claude = std::env::var_os("WORDBRAIN_CLAUDE_BIN");
        let prev_codex = std::env::var_os("WORDBRAIN_CODEX_BIN");
        std::env::set_var("PATH", "/nonexistent");
        std::env::set_var("WORDBRAIN_CLAUDE_BIN", "/nonexistent/wb-claude");
        std::env::set_var("WORDBRAIN_CODEX_BIN", "/nonexistent/wb-codex");
        let result = ai_call("ping", None).await;
        std::env::set_var("PATH", prev_path);
        restore_env("WORDBRAIN_CLAUDE_BIN", prev_claude);
        restore_env("WORDBRAIN_CODEX_BIN", prev_codex);
        let err = result.expect_err("both gone");
        assert_eq!(
            err.tried,
            vec!["claude-p".to_string(), "codex-cli".to_string()]
        );
        assert!(err.last_error.contains("codex-cli"));
    }

    fn restore_env(key: &str, value: Option<std::ffi::OsString>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }
}
