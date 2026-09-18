import { MAX_CANDIDATES, OPTION_CEILING } from "./config.ts";
import { buildQuestion, JevError, type Question } from "./jev.ts";

/**
 * This file decides nothing. It only shotguns candidate spans for Jev to choose from,
 * which is the pattern TypeSafe documents: "a regex finds the candidate values in the
 * text. Tune it to over-find. TypeSafe picks which candidate the question is asking for."
 */

/** Where a list of alternatives could plausibly be separated. */
const SEPARATOR = /\s*(?:\bor\b|\bvs\.?\b|\bversus\b|,|\||\b[A-E][.):]\s|\b[1-5][.):]\s)\s*/i;

/** Words too small to be an alternative on their own. */
const FILLER = /^(a|an|the|is|are|was|were|be|this|that|these|those|it|we|i|you|do|does|did|to|of|in|on|at|for|with|use|using|go|going|pick|choose|should|would|could|not|and|but|my|our|your)$/i;

/** True when the line might name alternatives, so it is worth asking Jev to find them. */
export function mayHaveOptions(line: string): boolean {
  return SEPARATOR.test(line);
}

/**
 * Upper bound on how many alternatives the line could name. Separators divide the line
 * into parts, and no alternative spans a separator, so the part count bounds it. Used to
 * size the extraction call: one question per possible alternative, no more, no fewer.
 */
export function maxOptions(line: string): number {
  const parts = line.replace(/^(choice|score)\s+/i, "").split(SEPARATOR).filter((p) => p.trim()).length;
  return Math.min(Math.max(parts, 2), OPTION_CEILING);
}

/**
 * Every contiguous run of up to six words within each separated part. Deliberately far
 * too many: recall over precision, because Jev does the choosing.
 */
export function spans(line: string): string[] {
  const body = line.replace(/^(choice|score)\s+/i, "");
  const parts = body
    .split(SEPARATOR)
    .map((p) => p.trim().replace(/^[?.,;:\s]+|[?.,;:\s]+$/g, "").split(/\s+/).filter(Boolean))
    .filter((w) => w.length);

  const usable = (s: string) => s.length > 1 && !FILLER.test(s);
  // Each whole part is the likeliest alternative, so these are kept first and never
  // dropped to make room for sub-spans of an earlier part.
  const kept = new Set([...new Set(parts.map((w) => w.join(" ")))].filter(usable).slice(0, MAX_CANDIDATES));

  // Then fill the remaining budget with shorter runs, widening only while they fit.
  for (let runLength = 2; runLength <= 6; runLength++) {
    const wider = new Set(kept);
    for (const words of parts) {
      for (let i = 0; i < words.length; i++) {
        for (let j = i; j < Math.min(i + runLength, words.length); j++) {
          const span = words.slice(i, j + 1).join(" ");
          if (usable(span)) wider.add(span);
        }
      }
    }
    if (wider.size > MAX_CANDIDATES) break;
    wider.forEach((v) => kept.add(v));
  }
  return [...kept];
}

/**
 * Where the question ends and the options begin. A `?` always wins, because a colon
 * turns up inside URLs and timestamps ("https://x.com", "12:30") far more often than it
 * introduces a list.
 */
function delimiter(body: string): number {
  const q = body.indexOf("?");
  return q !== -1 ? q : body.indexOf(":");
}

/** A line with neither a ? nor a : names no criterion for the UI to point at. */
export function hasCriterion(line: string): boolean {
  return delimiter(line) !== -1;
}

/**
 * Splits a line into its question and its options spec. The ? or : wins when present,
 * so "which team? billing, technical" keeps a spec containing spaces. Only without one
 * does the last word become the spec.
 */
export function splitSpec(line: string): { instructions: string; spec: string } | null {
  const body = line.replace(/^(choice|score)\s+/i, "").trim();
  const at = delimiter(body);
  if (at !== -1) {
    const spec = body.slice(at + 1).trim();
    return spec ? { instructions: body.slice(0, at + 1).trim(), spec } : null;
  }
  const cut = body.lastIndexOf(" ");
  return cut === -1 ? null : { instructions: body.slice(0, cut).trim(), spec: body.slice(cut + 1).trim() };
}

/**
 * True when the user stated the question type outright, so nothing needs deciding.
 * Pipes only count inside the options spec: "does grep | sort fix this?" is a question
 * about a shell pipe, not a request for levels.
 */
export function explicit(line: string): boolean {
  if (/^(choice|score)\b/i.test(line)) return true;
  return splitSpec(line)?.spec.includes("|") ?? false;
}

/** The question the user spelled out themselves. Only called when `explicit` is true. */
export function explicitQuestion(line: string): Question {
  const keyword = /^choice\b/i.test(line) ? "choice" : /^score\b/i.test(line) ? "score" : null;
  const split = splitSpec(line);
  if (!split) throw new JevError(`${keyword ?? "that"} needs a question then its options.`);
  // A bare "how urgent? low|medium|high" means levels even without the score keyword.
  const type = keyword === "choice" ? "choice" : split.spec.includes("|") ? "score" : keyword ?? "choice";
  return buildQuestion(type, split.instructions, split.spec);
}
