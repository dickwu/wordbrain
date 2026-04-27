// Small proof-of-life for claude-runner.ts:
// asks haiku to echo a fixed marker and verifies the round-trip.
// Run:  bun run scripts/test-runner.ts

import { runClaude, formatResult, CLAUDE_BIN } from './claude-runner';

const MARKER = 'WORDBRAIN-RUNNER-OK';

async function main(): Promise<void> {
  console.log(`[test] CLAUDE_BIN = ${CLAUDE_BIN}`);
  console.log(
    `[test] asking opus (xhigh effort) to output "${MARKER}" via --print --output-format json`
  );

  const result = await runClaude({
    prompt: `Respond with exactly this single token and nothing else: ${MARKER}`,
    model: 'opus',
    effort: 'xhigh',
    outputFormat: 'json',
    timeoutMs: 180_000,
    // bare: true is tempting but requires ANTHROPIC_API_KEY. With OAuth sign-in
    // the default run inherits the user's auth, which is what we want here.
  });

  console.log(`[test] ${formatResult(result)}`);
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        cost_usd: result.parsed?.total_cost_usd,
        tokens: result.parsed?.usage,
        num_turns: result.parsed?.num_turns,
        session_id: result.parsed?.session_id,
        result_preview: result.parsed?.result?.slice(0, 200),
      },
      null,
      2
    )
  );

  if (result.parsed?.result?.includes(MARKER)) {
    console.log('\n✅ test passed — runner round-trip works');
    process.exit(0);
  }
  console.error('\n❌ test failed — expected marker not in parsed.result');
  if (result.stdout) console.error('--- stdout (full) ---\n' + result.stdout);
  if (result.stderr) console.error('--- stderr (full) ---\n' + result.stderr);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[test] threw:', err);
  process.exit(1);
});
