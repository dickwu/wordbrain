// Headless Claude Code runner — spawn `claude -p <prompt>` with configurable
// model, tool allowlist, permission mode, and budget cap, then collect the
// structured JSON result.  Designed for parallel batch jobs where each sub-
// Claude works in its own isolated cwd (or worktree).
//
// Usage:
//   import { runClaude, runClaudeParallel } from './claude-runner';
//   const r = await runClaude({ prompt: 'hello', model: 'haiku' });
//   console.log(r.parsed?.result);
//
// Runs under Bun: `bun run scripts/test-runner.ts`.  Uses `Bun.spawn` so the
// child inherits the same subprocess semantics bash uses (avoids an issue on
// this machine where node's spawn hits a stale Node-linked claude shim).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// Resolve an absolute path to the `claude` binary once at import time.
//
// Important: Bun automatically prepends `node_modules/.bin` to a subprocess'
// PATH, so a plain `which claude` inside a Bun-run script lands on a broken
// npm-linked shim (`~/node_modules/.bin/claude`) that crashes under Node v25.
// We side-step that by (a) shelling out through a LOGIN bash and (b) explicitly
// rejecting any resolution that still passes through `/node_modules/`.
function resolveClaudeBin(): string {
  const override = process.env.WORDBRAIN_CLAUDE_BIN;
  if (override) return override;

  const home = process.env.HOME ?? '';
  const preferred = [
    `${home}/.local/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const p of preferred) {
    try {
      if (require('node:fs').existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }

  const r = spawnSync('/bin/bash', ['-lc', 'command -v claude'], { encoding: 'utf8' });
  const line = (r.stdout ?? '')
    .split('\n')
    .find((x) => x.trim().length > 0)
    ?.trim();
  if (line && line.length > 0 && !line.includes('/node_modules/')) return line;

  return 'claude';
}
export const CLAUDE_BIN: string = resolveClaudeBin();

export type ClaudeModel = 'haiku' | 'sonnet' | 'opus' | (string & {});
export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan';
export type OutputFormat = 'text' | 'json' | 'stream-json';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeRunOptions {
  prompt: string;
  model?: ClaudeModel;
  /** Working directory for the spawned claude process (defaults to process.cwd()). */
  cwd?: string;
  /** Hard SIGKILL deadline. Default 10 min. */
  timeoutMs?: number;
  /** Comma-separated tool whitelist, e.g. ['Read','Edit','Write','Bash']. */
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;
  /** Default 'json' so `parsed.result` is populated. */
  outputFormat?: OutputFormat;
  /** Extra directories the subprocess may read/write. */
  addDirs?: string[];
  effort?: EffortLevel;
  /** Abort if estimated spend exceeds this USD amount. */
  maxBudgetUsd?: number;
  /** Skip hooks, LSP, plugin sync, auto-memory. Requires ANTHROPIC_API_KEY. */
  bare?: boolean;
  /** Appended after the default system prompt. */
  appendSystemPrompt?: string;
  /** Mirror stdout to a file as the process runs. */
  logTo?: string;
  /** Extra env vars merged over process.env. */
  env?: Record<string, string>;
}

export interface ClaudeRunResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Parsed `--output-format json` payload when available. */
  parsed?: {
    result?: string;
    session_id?: string;
    total_cost_usd?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    num_turns?: number;
    is_error?: boolean;
    subtype?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function buildArgs(opts: ClaudeRunOptions): string[] {
  const fmt: OutputFormat = opts.outputFormat ?? 'json';
  const args: string[] = ['-p', opts.prompt, '--output-format', fmt];
  if (opts.model) args.push('--model', opts.model);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
  if (opts.disallowedTools?.length) args.push('--disallowedTools', opts.disallowedTools.join(','));
  if (opts.addDirs?.length) args.push('--add-dir', ...opts.addDirs);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.bare) args.push('--bare');
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  return args;
}

export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const fmt: OutputFormat = opts.outputFormat ?? 'json';
  const args = buildArgs(opts);
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  const start = Date.now();
  const proc = Bun.spawn([CLAUDE_BIN, ...args], {
    cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const killTimer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }, timeoutMs);

  let logHandle: fs.FileHandle | null = null;
  if (opts.logTo) {
    await fs.mkdir(path.dirname(opts.logTo), { recursive: true });
    logHandle = await fs.open(opts.logTo, 'w');
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(killTimer);

  if (logHandle) {
    await logHandle.write(stdout);
    await logHandle.close();
  }

  const durationMs = Date.now() - start;

  let parsed: ClaudeRunResult['parsed'];
  if (fmt === 'json' && stdout.trim().length > 0) {
    try {
      parsed = JSON.parse(stdout) as ClaudeRunResult['parsed'];
    } catch {
      // leave undefined
    }
  }

  return {
    ok: exitCode === 0 && !parsed?.is_error,
    exitCode,
    durationMs,
    stdout,
    stderr,
    parsed,
  };
}

export async function runClaudeParallel(jobs: ClaudeRunOptions[]): Promise<ClaudeRunResult[]> {
  return Promise.all(jobs.map((job) => runClaude(job)));
}

export function formatResult(r: ClaudeRunResult): string {
  const cost = r.parsed?.total_cost_usd;
  const tokens = r.parsed?.usage;
  const totalTokens = tokens ? (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0) : 0;
  return [
    r.ok ? 'OK ' : 'FAIL',
    `exit=${r.exitCode}`,
    `dur=${(r.durationMs / 1000).toFixed(1)}s`,
    cost !== undefined ? `cost=$${cost.toFixed(4)}` : '',
    totalTokens ? `tokens=${totalTokens}` : '',
    r.parsed?.num_turns ? `turns=${r.parsed.num_turns}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
