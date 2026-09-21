#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ask, buildQuestion, certainty, CONFIDENCE_FLOOR, CONFIG, DIR, JevError, loadKey, render, verdictCode, verdictText, type Answer, type Question } from "./jev.ts";
import { CONCURRENCY } from "./config.ts";
import { renderRich, spinner } from "./ui.ts";
import { repl } from "./repl.ts";

const USAGE = `mnjev - typed decisions from your terminal

  mnjev               start the interface (needs a terminal)
  mnjev login         save your TypeSafe API key

Or ask in one shot, with state on stdin:

  <state> | mnjev noul   "question"
  <state> | mnjev choice "question" opt1,opt2[,opt3]
  <state> | mnjev score  "question" "lowest|middle|highest"

Or classify a whole list, one item per line:

  <list> | mnjev map [noul|choice|score] "question" [spec]

Flags:

  --json        the raw response (one JSON object per line for map)
  --exit-code   0 yes, 2 no, 3 cannot say or nothing fits. Errors stay 1.

  cat err.log | mnjev noul "is this a database problem?"
  git diff --name-only | mnjev map "does this file need a test?"
  git log --format=%s -50 | mnjev map choice "what kind of change?" "fix,feature,chore"
`;

/** Runs `fn` over the items, `limit` at a time, keeping their order. */
async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * One question (or a `;` list of them) against every line of stdin. Each line is its own
 * state, so each needs its own call; several questions about one line share a call.
 */
async function runMap(rest: string[], json: boolean, wantCode: boolean): Promise<void> {
  const kinds = ["noul", "choice", "score"];
  const named = kinds.includes(rest[1] ?? "");
  const kind = named ? rest[1] : "noul";
  const instructions = named ? rest[2] : rest[1];
  const spec = (named ? rest[3] : rest[2]) ?? "";
  if (!instructions) throw new JevError('map needs a question, like: mnjev map "is this urgent?"');

  const parts = instructions.split(";").map((p) => p.trim()).filter(Boolean);
  const questions: Record<string, Question> = Object.fromEntries(
    parts.map((p, i) => [`q${i}`, buildQuestion(kind, p, spec)]),
  );

  if (process.stdin.isTTY) throw new JevError("No items on stdin. Pipe a list in, one per line.");
  const items = (await readStdin()).split("\n").map((l) => l.trim()).filter(Boolean);
  if (!items.length) throw new JevError("Nothing on stdin.");

  let unsure = 0;
  let failed = 0;
  const rows: (string | null)[] = new Array(items.length).fill(null);
  let printed = 0;
  // Printed in input order as soon as each is ready, so a long list is not silent.
  const flush = () => {
    while (printed < rows.length && rows[printed] !== null) console.log(rows[printed++]);
  };

  // Resolved once here, not once per item inside ask: a missing key used to print the
  // same "run mnjev login" row for every line of the list.
  loadKey();

  await pool(items, CONCURRENCY, async (item, i) => {
    try {
      const res = await ask(item, questions);
      const answers = parts.map((_, q) => res.answers[`q${q}`]);
      if (answers.some((a) => certainty(a) < CONFIDENCE_FLOOR)) unsure++;
      rows[i] = json
        ? JSON.stringify({ item, answers: Object.fromEntries(parts.map((p, q) => [p, answers[q]])) })
        : [item, ...answers.flatMap((a: Answer) => [verdictText(a), certainty(a).toFixed(2)])].join("\t");
    } catch (err) {
      failed++;
      rows[i] = json
        ? JSON.stringify({ item, error: (err as Error).message })
        // Collapsed: an error carrying a newline (an HTML error page, say) split one
        // row into two for whatever is reading these columns.
        : [item, "error", (err as Error).message.replace(/\s+/g, " ")].join("\t");
    }
    flush();
  });

  // On stderr, so it never lands in the rows a pipeline is reading. One exit code cannot
  // say "one network blip" and "half of them need a look" at the same time; this can.
  const notes = [failed && `${failed} failed`, unsure && `${unsure} unsure`].filter(Boolean);
  if (notes.length) console.error(`mnjev: ${items.length} items, ${notes.join(", ")}`);

  // An item that errored is a failure, not low confidence, so it must not look like one.
  if (failed) process.exitCode = 1;
  // Opt-in, like the single-question form: a plain `map` in a pipeline must exit 0.
  else if (wantCode && unsure) process.exitCode = 3;
}

/** Reads the whole of stdin. `readFileSync(0)` can throw EAGAIN on a pipe. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function login() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const key = (await rl.question("TypeSafe API key: ")).trim();
  rl.close();
  if (!key) throw new JevError("No key entered.");
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG, JSON.stringify({ provider: "typesafe", key }), { mode: 0o600 });
  // The mode above is advisory on Windows, so say so rather than implying it is private.
  if (process.platform === "win32") {
    console.log(`Saved to ${CONFIG}`);
    console.log("Windows ignores file permissions here. Restrict it yourself, or use TYPESAFE_API_KEY.");
  } else {
    chmodSync(CONFIG, 0o600);
    console.log(`Saved to ${CONFIG} (readable only by you)`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const wantCode = args.includes("--exit-code");
  const rest = args.filter((a) => a !== "--json" && a !== "--exit-code");
  const [cmd, instructions, spec] = rest;

  if (cmd === "login") return login();
  if (!cmd) {
    if (!process.stdin.isTTY) throw new JevError("No command. See `mnjev --help`.");
    return repl();
  }
  // `mnjev --help` is a success; an unrecognised command is not, so scripts can tell.
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return void console.log(USAGE);
  if (cmd === "map") return runMap(rest, json, wantCode);
  if (!["noul", "choice", "score"].includes(cmd)) {
    throw new JevError(`Unknown command "${cmd}".\n\n${USAGE}`);
  }

  if (process.stdin.isTTY) throw new JevError("No state on stdin. Pipe something in.");
  const state = await readStdin();
  if (!state) throw new JevError("Empty state on stdin.");

  // Built before the spinner starts: a synchronous throw here would otherwise leave the
  // spinner running and write the error over its partial line.
  const question = buildQuestion(cmd, instructions ?? "", spec ?? "");
  const started = Date.now();
  const stop = spinner("thinking");
  const res = await ask(state, { answer: question }).finally(stop);

  // Piped output stays plain and one line, so it composes with other tools.
  if (json) console.log(JSON.stringify(res, null, 2));
  else if (process.stdout.isTTY) console.log(renderRich(res.answers.answer, `${Date.now() - started}ms · ${res.usage.input_tokens} tokens`));
  else console.log(render("answer", res.answers.answer));
  if (wantCode) process.exitCode = verdictCode(res.answers.answer);
}

/** Entry point. Called by bin/jev.mjs, which checks the Node version first. */
export async function run() {
  await main().catch((err) => {
    console.error(err instanceof JevError ? err.message : `Error: ${err.message}`);
    process.exit(1);
  });
}

if (import.meta.main) await run();
