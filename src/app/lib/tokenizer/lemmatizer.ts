import lemmatizer from 'wink-lemmatizer';

// wink-lemmatizer v3 ships three POS-specific helpers.  Without an upstream
// POS tagger we probe verb → noun → adjective and take the first hit that
// actually changes the surface form; tests in ./__tests__ pin the behaviour
// on the cases that matter for Phase 1 (running, ran, happier, mice, went).
export function lemmatize(surface: string): string {
  const lowered = surface.toLowerCase();
  const asVerb = lemmatizer.verb(lowered);
  if (asVerb !== lowered) return asVerb;
  const asNoun = lemmatizer.noun(lowered);
  if (asNoun !== lowered) return asNoun;
  const asAdj = lemmatizer.adjective(lowered);
  if (asAdj !== lowered) return asAdj;
  return lowered;
}
