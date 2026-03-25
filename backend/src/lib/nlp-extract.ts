import nlp from "compromise";

const EVIDENTIAL_VERBS =
  "(confirmed|found|shows|showed|indicates|indicated|reveals|revealed|demonstrates|proved|established)";
const HYPOTHESIS_TERMS =
  "(think|hypothesis|theory|believe|suspect|seems|root cause|might be|could be|probably|possibly|likely)";

/**
 * Extract factual sentences -- those containing evidential verbs that
 * signal confirmed findings. Returns full sentences (capped at 150 chars).
 */
export function extractFacts(text: string): string[] {
  const doc = nlp(text);
  const sentences = doc.sentences().out("array") as string[];
  const facts: string[] = [];

  for (const sentence of sentences) {
    const s = nlp(sentence);
    if (s.has(EVIDENTIAL_VERBS)) {
      facts.push(sentence.trim().slice(0, 150));
    }
  }

  return facts;
}

/**
 * Extract hypothesis sentences -- those expressing uncertainty or
 * speculation about root causes. Returns full sentences (capped at 200 chars).
 */
export function extractHypotheses(text: string): string[] {
  const doc = nlp(text);
  const sentences = doc.sentences().out("array") as string[];
  const hypotheses: string[] = [];

  for (const sentence of sentences) {
    const s = nlp(sentence);
    if (s.has(HYPOTHESIS_TERMS)) {
      hypotheses.push(sentence.trim().slice(0, 200));
    }
  }

  return hypotheses;
}
