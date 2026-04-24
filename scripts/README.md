# WordBrain batch scripts

## `claude-runner.ts`

Headless Claude Code runner. Spawns `claude -p <prompt>` with configurable
model, tool allowlist, permission mode, working directory, and budget cap,
then returns the parsed JSON result (cost, tokens, session id, response text).

Parallel execution is built in — fire N sub-Claudes at once, each in its own
cwd / worktree:

```ts
import { runClaudeParallel } from './claude-runner';

const results = await runClaudeParallel([
  { prompt: 'job 1 …', model: 'sonnet', cwd: '/path/to/worktree-1', bare: true },
  { prompt: 'job 2 …', model: 'sonnet', cwd: '/path/to/worktree-2', bare: true },
]);
```

## `test-runner.ts`

Small round-trip test — asks haiku to echo a fixed marker via JSON output.
Use it to verify the runner mechanics before you queue a large batch:

```bash
bun run scripts/test-runner.ts
```

Expected: prints `✅ test passed` in ≤15 seconds, exit 0.

## Notes on `--bare`

`bare: true` disables hooks, auto-memory, LSP, plugin sync, and CLAUDE.md
auto-discovery. Good for deterministic batch jobs — **but** it also forces
API-key auth (`ANTHROPIC_API_KEY` env var or `apiKeyHelper` in settings).
If you're signed in via OAuth (the default for `claude login`), leave `bare`
off so the subprocess inherits your keychain session.

Set `bare: true` only when you've explicitly exported `ANTHROPIC_API_KEY` for
the batch run and want the sub-Claudes to ignore the project's hook stack.
