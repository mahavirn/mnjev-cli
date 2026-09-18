import { readFileSync } from "node:fs";
import { Agent, request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIDENCE_FLOOR, ESCAPE_HATCH, MAX_RETRIES, REQUEST_TIMEOUT_MS, RETRY_BASE_MS } from "./config.ts";

export { CONFIDENCE_FLOOR };
export const CONFIG = join(homedir(), ".mnjev", "config.json");
const HOST = "api.typesafe.ai";
const PATH = "/v1/systemone";

/**
 * A TLS handshake costs about 600ms, and `fetch` drops its socket after 4s of idle, so
 * every question typed into the REPL was paying for a new one. Keeping the socket open
 * turns a ~1200ms request into ~290ms.
 */
const agent = new Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 4 });

export type Reply = { status: number; text: string; retryAfter: string | null };
export type Transport = (payload: string, key: string) => Promise<Reply>;

const post: Transport = (payload, key) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: HOST,
        path: PATH,
        method: "POST",
        agent,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          text,
          retryAfter: (res.headers["retry-after"] as string | undefined) ?? null,
        }));
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    });
    req.on("error", reject);
    req.end(payload);
  });

export const NONE = "none of these";

export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> };

export class JevError extends Error {}

export function loadKey(): string {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  let key: unknown;
  try {
    key = JSON.parse(readFileSync(CONFIG, "utf8")).key;
  } catch {
    throw new JevError("No API key. Run `mnjev login`, or set TYPESAFE_API_KEY.");
  }
  // A truncated config would otherwise send "Bearer undefined" and report a 401.
  if (typeof key !== "string" || !key.trim()) {
    throw new JevError(`No key found in ${CONFIG}. Run \`mnjev login\` again.`);
  }
  return key.trim();
}

/** Transient by nature: rate limits, overload, and gateway hiccups. */
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Doubling backoff with jitter, unless the server named its own delay. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  // A server saying "retry after 0" means retry now, so 0 is honoured. A header sent
  // with no value is not a number at all, and must not become a zero-delay retry.
  const named = Number(retryAfter);
  if (retryAfter?.trim() && Number.isFinite(named) && named >= 0) return Math.min(named * 1000, 60_000);
  return RETRY_BASE_MS * 2 ** attempt * (1 + Math.random());
}

export async function ask(
  state: string,
  questions: Record<string, Question>,
  /** Swapped in tests; production always uses the keep-alive transport above. */
  transport: Transport = post,
) {
  // Resolved before the loop, so a missing key is not reported as a network failure.
  const key = loadKey();
  const payload = JSON.stringify({ model: "jev-latest", state, questions });

  let res!: Reply;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await transport(payload, key);
    } catch (err) {
      // A timeout is not retried: waiting longer for something already slow rarely helps.
      if ((err as Error).name === "TimeoutError") {
        throw new JevError(`mnjev did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`);
      }
      if (attempt >= MAX_RETRIES) throw new JevError(`Could not reach mnjev: ${(err as Error).message}`);
      await sleep(backoffMs(attempt, null));
      continue;
    }
    if (!RETRYABLE.has(res.status) || attempt >= MAX_RETRIES) break;
    await sleep(backoffMs(attempt, res.retryAfter));
  }

  // An error page is not JSON, and parsing it first would hide the status.
  const text = res.text;
  let body: { model?: string; answers?: Record<string, Answer>; usage?: { input_tokens: number; output_tokens: number }; detail?: { message?: string } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new JevError(`mnjev ${res.status}: ${text.slice(0, 200) || "empty response"}`);
  }
  if (res.status < 200 || res.status >= 300) throw new JevError(`mnjev ${res.status}: ${body?.detail?.message ?? text.slice(0, 200)}`);

  // Guarantee every question got a usable answer, so nothing downstream has to check.
  const answers = body.answers ?? {};
  const asked = Object.keys(questions);
  const missing = asked.filter((k) => !answers[k]);
  if (missing.length) throw new JevError(`mnjev answered ${asked.length - missing.length} of ${asked.length} questions.`);
  for (const id of asked) validate(id, answers[id]);

  // `model` is passed through: it names the exact version that answered, which --json
  // consumers rely on and which matters when `jev-latest` moves.
  return { model: body.model ?? "unknown", answers, usage: body.usage ?? { input_tokens: 0, output_tokens: 0 } };
}

const inRange = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * The API is a trust boundary. A score with no legend used to reach the renderer and
 * throw a raw TypeError; a probability above 1 threw a RangeError from the bar drawing.
 */
function validate(id: string, a: Answer): void {
  const bad = (why: string) => new JevError(`mnjev returned an unusable answer for "${id}": ${why}.`);
  if (a.type === "noul") {
    if (!inRange(a.noul)) throw bad(`noul ${a.noul} is not between 0 and 1`);
    return;
  }
  if (!inRange(a.confidence)) throw bad(`confidence ${a.confidence} is not between 0 and 1`);
  if (a.type === "choice") {
    if (typeof a.choice !== "string") throw bad("no choice was returned");
    return;
  }
  if (!Number.isFinite(a.score)) throw bad(`score ${a.score} is not a number`);
  if (!a.legend || typeof a.legend !== "object" || !Object.keys(a.legend).length) throw bad("the score has no legend");
}

/** Applied in one place, so every choice honours JEV_ESCAPE the same way. */
export function withEscapeHatch<T extends Record<string, string | null>>(criteria: T): T {
  if (!ESCAPE_HATCH || Object.keys(criteria).some((k) => /^none\b/i.test(k))) return criteria;
  return { ...criteria, [NONE]: "none of the other options is a correct answer" };
}

/** "a,b,c" or "a=first one,b=second one" -> {a:"...",b:"..."}. Descriptions are optional. */
export function parseCriteria(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) out[trimmed] = trimmed;
    else out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  if (Object.keys(out).length < 2) throw new JevError("A choice needs at least 2 options.");
  return out;
}

export function buildQuestion(kind: string, instructions: string, spec: string): Question {
  if (!instructions) throw new JevError(`${kind} needs a question.`);
  if (kind === "noul") return { type: "noul", instructions };
  if (kind === "choice") return { type: "choice", instructions, criteria: withEscapeHatch(parseCriteria(spec)) };
  if (kind === "score") {
    const levels = spec.split("|").map((s) => s.trim()).filter(Boolean);
    if (levels.length < 2) throw new JevError('A score needs at least 2 levels, like "calm|annoyed|furious".');
    return { type: "score", instructions, criteria: levels };
  }
  throw new JevError(`Unknown question type "${kind}". Use noul, choice, or score.`);
}

/**
 * The level a score lands on: the likeliest one, falling back to the nearest by value.
 * Both lookups can miss if probabilities are keyed differently, so neither is trusted
 * on its own, and the raw key is shown rather than the word "undefined".
 */
export function levelName(a: Extract<Answer, { type: "score" }>): string {
  const likeliest = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1])[0]?.[0];
  const nearest = String(Math.round(a.score));
  return a.legend[likeliest ?? ""] ?? a.legend[nearest] ?? likeliest ?? nearest;
}

/** How sure Jev is of the answer it gave, on one scale for all three question types. */
export function certainty(a: Answer): number {
  // 0.5 means no idea, so a noul's certainty runs outward from the middle both ways.
  return a.type === "noul" ? Math.abs(a.noul - 0.5) * 2 : a.confidence;
}

function flag(confidence: number): string {
  return confidence < CONFIDENCE_FLOOR ? "  <- low, check this" : "";
}

/** One plain line, for piped output. The terminal gets `renderRich` instead. */
export function render(id: string, a: Answer): string {
  if (a.type === "noul") return `${id}: ${a.noul > 0.5 ? "yes" : "no"} (${a.noul.toFixed(2)})${flag(certainty(a))}`;
  if (a.type === "choice") return `${id}: ${a.choice}  confidence ${a.confidence.toFixed(2)}${flag(a.confidence)}`;
  return `${id}: ${levelName(a)} (${a.score.toFixed(2)})  confidence ${a.confidence.toFixed(2)}${flag(a.confidence)}`;
}
