import { OPTION_CEILING } from "./config.ts";
import { ask, buildQuestion, CONFIDENCE_FLOOR, NONE, withEscapeHatch, type Answer, type Question } from "./jev.ts";
import { explicit, explicitQuestion, hasCriterion, maxOptions, mayHaveOptions, spans } from "./parse.ts";

/** Used when Jev calls something a rating but the line names no levels of its own. */
const DEFAULT_LEVELS = ["not at all", "slightly", "moderately", "very", "extremely"];
const NO_SPAN = "__no_such_alternative";

export type Resolved =
  | { text: string; question: Question; answer: Answer; bare: boolean; error?: undefined }
  | { text: string; error: string; question?: undefined; answer?: undefined; bare?: undefined };

/**
 * Jev finds the alternatives. Code only supplies candidate spans to choose among,
 * because Jev returns no text and so can never hand a list back.
 * Returns null when the line names no alternatives.
 */
export async function findOptions(line: string): Promise<string[] | null> {
  // Guard here too, not only in the caller: a sentence with no separator has no
  // alternatives, however many word runs can be sliced out of it.
  if (!mayHaveOptions(line)) return null;
  const candidates = spans(line);
  if (candidates.length < 2) return null;

  // A null description means "the option name speaks for itself", which the API accepts.
  const criteria: Record<string, string | null> = Object.fromEntries(candidates.map((s) => [s, null]));
  const nth = (n: string): Question => ({
    type: "choice",
    instructions:
      `Which span is the ${n} alternative the user is choosing between? Pick the span that is ` +
      `exactly the alternative, with no lead-in words and no shared context.`,
    criteria: { ...criteria, [NO_SPAN]: "there is no such alternative" },
  });

  // One slot per alternative the line could possibly name, so nothing is silently dropped.
  const slots = Math.min(maxOptions(line), OPTION_CEILING);
  const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  const CARDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const ordinals = ORDINALS.slice(0, slots);
  const res = await ask(line, {
    count: {
      type: "choice",
      instructions: "How many distinct alternatives is the user asking to choose between?",
      // One alternative is not a choice, so the count starts at two.
      criteria: Object.fromEntries([
        ["0", "none, this is not a choice between alternatives"],
        ...ordinals.slice(1).map((_, i) => [String(i + 2), CARDINALS[i + 1]]),
      ]) as Record<string, string>,
    },
    ...Object.fromEntries(ordinals.map((o, i) => [`o${i}`, nth(o)])),
  });

  const count = res.answers.count as Extract<Answer, { type: "choice" }>;
  // An unsure count means Jev could not tell whether these are alternatives at all.
  if (count.confidence < CONFIDENCE_FLOOR) return null;
  const n = Number(count.choice);
  if (!n) return null;

  const picked = ordinals.slice(0, n)
    .map((_, i) => (res.answers[`o${i}`] as Extract<Answer, { type: "choice" }>).choice)
    .filter((s) => s !== NO_SPAN);
  // Duplicates mean Jev could not tell two slots apart, so the reading is not usable.
  return new Set(picked).size === picked.length && picked.length >= 2 ? picked : null;
}

/** Every form the line could take, so one call can answer all of them. */
export function candidates(text: string, options: string[] | null): Record<string, Question> {
  const out: Record<string, Question> = { noul: buildQuestion("noul", text, "") };
  if (options && options.length >= 2) {
    // Built directly rather than through a comma-joined spec, so an option containing
    // a comma survives, and so the escape hatch never leaks into the score levels.
    out.choice = { type: "choice", instructions: text, criteria: withEscapeHatch(Object.fromEntries(options.map((o) => [o, o]))) };
    out.score = { type: "score", instructions: text, criteria: options };
  } else {
    out.score = { type: "score", instructions: text, criteria: DEFAULT_LEVELS };
  }
  return out;
}

const TYPE_CRITERIA = {
  noul: "a yes or no answer",
  choice: "picking one item from a set of named alternatives",
  score: "a rating or a level along a scale",
};

/**
 * Finds the alternatives, then classifies and answers every line. Extraction needs its
 * own call because its result defines the choice question. Lines that name no
 * alternatives skip it, so a plain yes/no still costs a single round trip.
 */
export async function askAll(state: string, lines: string[]): Promise<Resolved[]> {
  const found = await Promise.all(
    lines.map((line) =>
      explicit(line) || !mayHaveOptions(line)
        ? Promise.resolve(null)
        // Finding options is an improvement, not a requirement: a failure still answers.
        : findOptions(line).catch(() => null),
    ),
  );

  const questions: Record<string, Question> = {};
  const forms = lines.map((line, i) => {
    if (explicit(line)) {
      // A malformed segment must not cost the other questions their answers.
      try {
        const q = explicitQuestion(line);
        questions[`f${i}_${q.type}`] = q;
        return { fixed: q, forms: null, error: null };
      } catch (err) {
        return { fixed: null, forms: null, error: (err as Error).message };
      }
    }
    const f = candidates(line, found[i]);
    questions[`t${i}`] = {
      type: "choice",
      instructions: `What kind of answer does this input call for? Input: ${line}`,
      criteria: TYPE_CRITERIA,
    };
    for (const [kind, q] of Object.entries(f)) questions[`f${i}_${kind}`] = q;
    return { fixed: null, forms: f, error: null };
  });

  const res = await ask(state, questions);

  return lines.map((text, i): Resolved => {
    const bare = !hasCriterion(text);
    const { fixed, forms: f, error } = forms[i];
    if (error) return { text, error };
    if (fixed) return { text, question: fixed, answer: res.answers[`f${i}_${fixed.type}`], bare };

    const verdict = res.answers[`t${i}`] as Extract<Answer, { type: "choice" }>;
    const fallback = f!.choice ? "choice" : "noul";
    const wanted = verdict.confidence >= CONFIDENCE_FLOOR ? verdict.choice : fallback;
    // Pick the answer and its question together, so they can never disagree.
    const kind = f![wanted] ? wanted : fallback;
    return { text, question: f![kind], answer: res.answers[`f${i}_${kind}`], bare };
  });
}

export { NONE };
