import { diff_match_patch } from 'diff-match-patch';

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffSpan {
  op: DiffOp;
  text: string;
}

const dmp = new diff_match_patch();

export function diffWords(before: string, after: string): DiffSpan[] {
  const raw = dmp.diff_main(before, after);
  dmp.diff_cleanupSemantic(raw);
  return raw.map(([op, text]) => ({
    op: opToTag(op),
    text,
  }));
}

function opToTag(op: number): DiffOp {
  if (op === 1) return 'insert';
  if (op === -1) return 'delete';
  return 'equal';
}
