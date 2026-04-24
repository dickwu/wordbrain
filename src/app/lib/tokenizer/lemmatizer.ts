import lemmatizer from 'wink-lemmatizer';

// English possessive / auxiliary clitics. Stripping these lets "bank's" match
// "bank" in the known-set and "it's" match "it"; it intentionally does NOT
// affect "n't" (contractions of not) because those belong to distinct head
// words ("don't" is treated as its own token, not as "do").
const CLITIC_RE = /(['’])s$/;

// wink-lemmatizer v3 ships three POS-specific helpers.  Without an upstream
// POS tagger we probe verb → noun → adjective and take the first hit that
// actually changes the surface form; tests in ./__tests__ pin the behaviour
// on the cases that matter for Phase 1 (running, ran, happier, mice, went).
export function lemmatize(surface: string): string {
  let lowered = surface.toLowerCase().replace(CLITIC_RE, '');
  if (!lowered) return surface.toLowerCase();
  const asVerb = lemmatizer.verb(lowered);
  if (asVerb !== lowered) return asVerb;
  const asNoun = lemmatizer.noun(lowered);
  if (asNoun !== lowered) return asNoun;
  const asAdj = lemmatizer.adjective(lowered);
  if (asAdj !== lowered) return asAdj;
  return lowered;
}
