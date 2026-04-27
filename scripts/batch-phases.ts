// Parallel WordBrain phase dispatcher.
//
// Usage:
//   bun run scripts/batch-phases.ts 2 3                  # dispatch phases 2 & 3 in parallel
//   bun run scripts/batch-phases.ts 2 3 4 --dry-run      # print prompts without spawning
//   bun run scripts/batch-phases.ts 1.5 --budget 2.0     # budget cap per phase (USD)
//
// For each phase N:
//   1. Reads .omc/prd.json to find US-PHASE-N's title + acceptance criteria
//   2. Creates a git worktree at .omc/worktrees/phase-{N} off `main`
//   3. Dispatches `claude -p` (opus, xhigh effort, acceptEdits, budget-capped) with the
//      plan excerpt + AC as context, working inside the worktree
//   4. Streams each sub-Claude's stdout to .omc/logs/phase-{N}.log
//   5. Reports per-phase result + remaining-budget summary at the end
//
// Dispatched phases never touch the parent checkout. Review each worktree,
// then `git merge` or `git cherry-pick` into main when satisfied.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runClaudeParallel, formatResult, type ClaudeRunOptions } from './claude-runner';

interface PRDStory {
  id: string;
  title: string;
  priority: number;
  passes: boolean;
  description: string;
  acceptanceCriteria: string[];
}
interface PRD {
  projectName: string;
  source: string;
  stories: PRDStory[];
}

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const PRD_PATH = path.join(REPO_ROOT, '.omc', 'prd.json');
const PLAN_PATH = path.join(REPO_ROOT, '.omc', 'plans', 'wordbrain-v1.md');
const WORKTREES_DIR = path.join(REPO_ROOT, '.omc', 'worktrees');
const LOGS_DIR = path.join(REPO_ROOT, '.omc', 'logs');

interface CliArgs {
  phases: string[];
  dryRun: boolean;
  budgetUsd: number;
  model: 'sonnet' | 'haiku' | 'opus';
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    phases: [],
    dryRun: false,
    budgetUsd: 3.0,
    model: 'opus',
    effort: 'xhigh',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--budget') args.budgetUsd = Number(argv[++i]);
    else if (a === '--model') args.model = argv[++i] as CliArgs['model'];
    else if (a === '--effort') args.effort = argv[++i] as CliArgs['effort'];
    else if (!a.startsWith('--')) args.phases.push(a);
  }
  if (args.phases.length === 0) {
    console.error(
      'usage: bun run scripts/batch-phases.ts <phase>... [--dry-run] [--budget N] [--model opus|sonnet|haiku] [--effort low|medium|high|xhigh|max]'
    );
    console.error('example: bun run scripts/batch-phases.ts 1.5 2 --dry-run');
    process.exit(2);
  }
  return args;
}

async function loadPRD(): Promise<PRD> {
  const raw = await fs.readFile(PRD_PATH, 'utf8');
  return JSON.parse(raw) as PRD;
}

function findStory(prd: PRD, phase: string): PRDStory {
  const id = `US-PHASE-${phase}`;
  const story = prd.stories.find((s) => s.id === id);
  if (!story) {
    const ids = prd.stories.map((s) => s.id).join(', ');
    throw new Error(`Story ${id} not found in ${PRD_PATH}. Known: ${ids}`);
  }
  return story;
}

function planExcerpt(phase: string, maxChars = 8000): string {
  if (!existsSync(PLAN_PATH)) return '(plan file missing)';
  const full = require('node:fs').readFileSync(PLAN_PATH, 'utf8') as string;
  const marker = new RegExp(`### Phase ${phase.replace('.', '\\.')} `, 'i');
  const idx = full.search(marker);
  if (idx < 0)
    return `(phase ${phase} section not found; whole plan:)\n\n` + full.slice(0, maxChars);
  const nextHeader = full.slice(idx + 10).search(/\n### Phase /);
  const end = nextHeader < 0 ? Math.min(full.length, idx + maxChars) : idx + 10 + nextHeader;
  return full.slice(idx, end);
}

function buildPrompt(story: PRDStory, worktree: string): string {
  const acNumbered = story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return [
    `You are working on the WordBrain project, in an isolated git worktree at: ${worktree}`,
    '',
    `Story: ${story.id} — ${story.title}`,
    `Description: ${story.description}`,
    '',
    'Acceptance criteria (ALL must pass — verify with fresh evidence before finishing):',
    acNumbered,
    '',
    '--- relevant plan excerpt ---',
    planExcerpt(story.id.replace('US-PHASE-', '')),
    '',
    '--- execution rules ---',
    '1. Work inside the worktree only. Do not cd elsewhere.',
    '2. Prefer edits to existing files over creating new ones.',
    '3. Run `bun install` if you add JS deps; `cargo check` after Rust changes; `bun test` if you add tests; `bun run build` as a final gate.',
    '4. When every acceptance criterion is verified, print a final JSON block:',
    '   {"status":"done","commits":["sha1","sha2"],"notes":"..."}',
    '   and stop. Do not commit on any branch other than the worktree branch.',
    '5. If you hit an irreducible blocker (missing data file, missing credentials, tool limitation), print:',
    '   {"status":"blocked","reason":"...","needed":"..."}',
    '   and stop.',
    '',
    `Budget cap: the sub-Claude has a hard USD budget ($${'budgetUsd_will_be_interpolated'}). Stay well under it.`,
  ].join('\n');
}

async function ensureWorktree(phase: string): Promise<string> {
  const branch = `phase-${phase}`;
  const wtPath = path.join(WORKTREES_DIR, `phase-${phase}`);
  if (existsSync(wtPath)) return wtPath;
  await fs.mkdir(WORKTREES_DIR, { recursive: true });
  // Create worktree off main; if branch already exists, reuse it.
  const r = spawnSync('git', ['worktree', 'add', '-B', branch, wtPath, 'main'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr}`);
  }
  return wtPath;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prd = await loadPRD();
  await fs.mkdir(LOGS_DIR, { recursive: true });

  console.log(
    `[batch] phases=[${args.phases.join(', ')}] model=${args.model} effort=${args.effort} budget=$${args.budgetUsd} dryRun=${args.dryRun}`
  );

  const jobs: Array<ClaudeRunOptions & { phase: string; worktree: string; story: PRDStory }> = [];
  for (const phase of args.phases) {
    const story = findStory(prd, phase);
    if (story.passes) {
      console.log(`[batch] ${story.id} already passes=true — skipping`);
      continue;
    }
    const worktree = args.dryRun
      ? path.join(WORKTREES_DIR, `phase-${phase}`)
      : await ensureWorktree(phase);
    const prompt = buildPrompt(story, worktree).replace(
      'budgetUsd_will_be_interpolated',
      args.budgetUsd.toFixed(2)
    );
    jobs.push({
      phase,
      worktree,
      story,
      prompt,
      model: args.model,
      effort: args.effort,
      cwd: worktree,
      outputFormat: 'json',
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite'],
      maxBudgetUsd: args.budgetUsd,
      timeoutMs: 45 * 60 * 1000,
      logTo: path.join(LOGS_DIR, `phase-${phase}.log`),
    });
  }

  if (args.dryRun) {
    console.log('[batch] DRY RUN — prompts that would be sent:\n');
    for (const j of jobs) {
      console.log(`═════ ${j.story.id} → ${j.worktree} ═════`);
      console.log(j.prompt);
      console.log('');
    }
    console.log(`[batch] dry-run total jobs: ${jobs.length} (no sub-Claudes spawned)`);
    return;
  }

  console.log(`[batch] dispatching ${jobs.length} sub-Claude(s) in parallel …`);
  const started = Date.now();
  const results = await runClaudeParallel(jobs);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  let totalCost = 0;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const r = results[i];
    totalCost += r.parsed?.total_cost_usd ?? 0;
    console.log(`[batch] ${j.story.id} (${j.worktree}): ${formatResult(r)}`);
  }
  console.log(`[batch] total_elapsed=${elapsed}s total_cost=$${totalCost.toFixed(4)}`);
  console.log(`[batch] review each worktree under ${WORKTREES_DIR}/phase-* then merge into main`);
}

main().catch((err: unknown) => {
  console.error('[batch] threw:', err);
  process.exit(1);
});
