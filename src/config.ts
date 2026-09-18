/**
 * Every tunable in one place. Limits used to live in three files, and each env var was
 * parsed a different way, which is why `JEV_CONFIDENCE=high` silently disabled the
 * confidence gate and `JEV_ESCAPE=0` switched the escape hatch on.
 */

/** A flag is on only for a clearly affirmative value, so `0`, `false` and `no` are off. */
function flag(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  warn(`${name}="${process.env[name]}" is not a yes/no value, using ${fallback}.`);
  return fallback;
}

/** A number is used only when it parses and sits in range, so a typo cannot disable it. */
function number(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  warn(`${name}="${raw}" is not a number between ${min} and ${max}, using ${fallback}.`);
  return fallback;
}

function warn(message: string): void {
  console.error(`mnjev: ${message}`);
}

/**
 * Below this, Jev is guessing. Act above it, ask the user below it.
 * A noul is measured outward from 0.5, so 0.7 needs p>0.85 or p<0.15.
 */
export const CONFIDENCE_FLOOR = number("JEV_CONFIDENCE", 0.7, 0, 1);

/**
 * Off by default: your options go to Jev exactly as you typed them. Adding a
 * "none of these" option helps only when the real answer is absent, and costs real
 * accuracy when it is present (measured: 0.71 right -> 0.27 wrong).
 */
export const ESCAPE_HATCH = flag("JEV_ESCAPE");

/** A hung connection would otherwise spin forever with no way out but Ctrl-C. */
export const REQUEST_TIMEOUT_MS = number("JEV_TIMEOUT_MS", 30_000, 1_000, 600_000);

/** Jev's accuracy falls as unrelated state grows, so keep what we send bounded. */
export const MAX_STATE = 24_000;

/** One line cannot ask for an unbounded number of alternatives. */
export const OPTION_CEILING = 10;

/** Candidate spans are duplicated into every extraction slot, so their count is capped. */
export const MAX_CANDIDATES = 150;

/**
 * TypeSafe's API docs say to "retry the request with exponential backoff" on a rate
 * limit, so a busy moment does not fail a script.
 */
export const MAX_RETRIES = number("JEV_RETRIES", 3, 0, 10);

/** First backoff delay; each attempt doubles it. Lowered in tests to keep them fast. */
export const RETRY_BASE_MS = number("JEV_RETRY_BASE_MS", 500, 1, 60_000);
