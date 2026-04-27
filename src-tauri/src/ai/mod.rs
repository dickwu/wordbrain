//! AI provider chain for the learning loop.
//!
//! Story Review, Writing Train, MCQ explanations and synonym extraction all
//! route through [`chain::ai_call`], which tries `claude -p` first and falls
//! back to `codex exec` if the primary fails. Both channels are spawned via
//! `tokio::process::Command` with a small allowlisted environment.
//!
//! No network code lives here — the only HTTP path stays in
//! `commands::dict::lookup_ai`, gated behind an opt-in Settings toggle.
//!
//! Validated CLI surface (2026-04-24, on the dev box):
//! * `claude -p <prompt> --output-format=json` (Claude Code 2.x; supports
//!   `--json-schema=<schema>` for structured output)
//! * `codex exec <prompt>` (Codex CLI; supports `--output-schema <FILE>` —
//!   we pass the schema as a file path when callers need structured output)

pub mod chain;
pub mod cli_provider;
pub mod prompts;

pub use chain::{ai_call, ai_provider_status, AiCallOutcome, AiUnavailable, ProviderStatus};
pub use cli_provider::{CliChannel, CliInvocation, CliResponse};
