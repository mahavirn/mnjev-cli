#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ask, buildQuestion, CONFIG, JevError, render } from "./jev.ts";
import { renderRich, spinner } from "./ui.ts";
import { repl } from "./repl.ts";

const USAGE = `mnjev - typed decisions from your terminal

  mnjev               start the interface (needs a terminal)
  mnjev login         save your TypeSafe API key

Or ask in one shot, with state on stdin:

  <state> | mnjev noul   "question"
  <state> | mnjev choice "question" opt1,opt2[,opt3]
  <state> | mnjev score  "question" "lowest|middle|highest"

Add --json for the raw response.

  cat err.log | mnjev noul "is this a database problem?"
  git log --oneline -20 | mnjev choice "which commit broke auth?" "$(git log --format=%h -20 | tr '\\n' ',' | sed 's/,$//')"
`;

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
  mkdirSync(join(homedir(), ".mnjev"), { recursive: true, mode: 0o700 });
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
  const [cmd, instructions, spec] = args.filter((a) => a !== "--json");

  if (cmd === "login") return login();
  if (!cmd) {
    if (!process.stdin.isTTY) throw new JevError("No command. See `mnjev --help`.");
    return repl();
  }
  // `mnjev --help` is a success; an unrecognised command is not, so scripts can tell.
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return void console.log(USAGE);
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
}

/** Entry point. Called by bin/jev.mjs, which checks the Node version first. */
export async function run() {
  await main().catch((err) => {
    console.error(err instanceof JevError ? err.message : `Error: ${err.message}`);
    process.exit(1);
  });
}

if (import.meta.main) await run();
