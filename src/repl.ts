import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { HISTORY_MAX, MAX_STATE, PASTE_WINDOW_MS, PRICE_PER_MTOK } from "./config.ts";
import { DIR, JevError, usage } from "./jev.ts";
import { askAll } from "./classify.ts";
import {
  BANNER, below, bold, box, closeFrame, criterionHint, cyan, dim, echo, heading,
  openFrame, PROMPT, renderRich, spinner, yellow,
} from "./ui.ts";

type Ctx = { state: string; source: string; drain: () => void };
type Cmd = {
  name: string;
  arg?: string;
  help: string;
  hidden?: boolean;
  run: (rest: string, ctx: Ctx, rl: Interface) => Promise<void> | void;
};

/** Reports every state change the same way, so no caller has to remember to. */
function setState(ctx: Ctx, text: string, source: string): void {
  ctx.state = text.replace(/\r\n/g, "\n");
  ctx.source = source;
  console.log(dim(`  ${source} · ${ctx.state.length} chars`));
  // Said here rather than on the next question, which is where it used to surface.
  if (ctx.state.length > MAX_STATE) {
    console.log(yellow(`  that is over the ~${MAX_STATE} char limit, so questions will be refused until you load less`));
  }
}

const COMMANDS: Cmd[] = [
  { name: "/set", arg: "<text>", help: "type the state in directly", run: (rest, ctx) => setState(ctx, rest, "typed") },
  { name: "/load", arg: "<file>", help: "use a file as state", run: (rest, ctx) => setState(ctx, readFileSync(rest, "utf8"), rest) },
  { name: "/run", arg: "<command>", help: "use a command's output as state", run: async (rest, ctx, rl) => {
      const { out, code } = await shell(rest, rl, ctx.drain);
      // Keeping a failure as state is the point of /run, but it must not read as success:
      // answering questions about an error message quietly gives confident nonsense.
      if (code) console.log(yellow(`  exited ${code}, so this is the command's error output`));
      setState(ctx, out, `$ ${rest}${code ? ` (exited ${code})` : ""}`);
    } },
  {
    name: "/state", help: "show what is loaded",
    run: (_rest, ctx) => console.log(ctx.state ? `  ${dim(`${ctx.source}, ${ctx.state.length} chars`)}\n${preview(ctx.state)}` : dim("  nothing loaded")),
  },
  { name: "/clear", help: "drop the state", run: (_rest, ctx) => setState(ctx, "", "nothing") },
  { name: "/cost", help: "what this session has spent", run: () => console.log(cost()) },
  { name: "/help", help: "this list", run: () => console.log(HELP) },
  { name: "/exit", help: "leave", run: (_rest, _ctx, rl) => rl.close() },
  { name: "/quit", help: "leave", hidden: true, run: (_rest, _ctx, rl) => rl.close() },
];

/** readline keeps this, newest first, but does not declare it. */
const history = (rl: Interface) => (rl as Interface & { history?: string[] }).history;

const visible = COMMANDS.filter((c) => !c.hidden);
const label = (c: Cmd) => `${c.name} ${c.arg ?? ""}`.trim();

/** What a typed prefix could mean. The menu suggests these, so dispatch must accept them. */
const matching = (prefix: string, all = false) => (all ? COMMANDS : visible).filter((c) => c.name.startsWith(prefix));

const HELP = (() => {
  const w = Math.max(...visible.map((c) => label(c).length));
  return [
    ``,
    `  ${dim("Just ask. Jev works out what kind of question it is:")}`,
    ``,
    `    can penguins swim?                            ${dim("yes / no")}`,
    `    email vs chat                                 ${dim("pick one")}`,
    `    which team? billing, support, or infra        ${dim("pick one")}`,
    `    how urgent is this? low|medium|critical       ${dim("a level")}`,
    ``,
    `  ${dim("Put the question before the ? and the options after it:")}`,
    ``,
    `    ${dim("vague")}   email or chat`,
    `    ${dim("clear")}   which is better for a quick reply? email or chat`,
    ``,
    `  ${dim("Separate questions with ; to ask them all in one call:")}`,
    ``,
    `    is this a bug?; which team? billing, infra; how risky? low|high`,
    ``,
    `  ${dim("State is what Jev reads. Load it when the question is about your stuff.")}`,
    ``,
    ...visible.map((c) => `    ${cyan(label(c).padEnd(w))}   ${dim(c.help)}`),
    ``,
    `    ${cyan("!<command>".padEnd(w))}   ${dim("shorthand for /run")}`,
    `    ${cyan("@<file>".padEnd(w))}   ${dim("pull a file into one question")}`,
    ``,
    `  ${dim("Paste several lines and they become the state. End a line with \\ to continue it.")}`,
    ``,
    `  ${dim("To override what Jev decided, say it outright:")}`,
    ``,
    `    ${cyan("choice")} which team? billing,technical`,
    `    ${cyan("score")}  how urgent? low|medium|critical`,
    ``,
  ].join("\n");
})();

function preview(state: string): string {
  const lines = state.split("\n");
  const shown = lines.slice(0, 5).map((l) => dim(`  │ ${l.slice(0, 76)}`)).join("\n");
  return lines.length > 5 ? `${shown}\n${dim(`  │ ... ${lines.length - 5} more lines`)}` : shown;
}

function cost(): string {
  const u = usage();
  // Six places, because a whole session of questions still costs a fraction of a cent.
  const dollars = ((u.input_tokens / 1e6) * PRICE_PER_MTOK).toFixed(6);
  // "requests", not "calls": this counts every round trip, retried rate limits included,
  // while the tokens and the money only ever come from the ones that answered. Calling
  // both a call put two different meanings on one line.
  const tries = `${u.calls} ${u.calls === 1 ? "request" : "requests"}`;
  return `  ${dim(`${tries} · ${u.input_tokens.toLocaleString()} input tokens · $${dollars}`)}`;
}

function readBlock(path: string): string | null {
  try {
    return `--- ${path} ---\n${readFileSync(path, "utf8")}`;
  } catch {
    return null;
  }
}

/**
 * `@path` pulls that file in as state for one question. The `@` must start a word, so
 * `bob@example.com` is an address rather than a file.
 */
export function mentioned(line: string): { blocks: string[]; missing: string[] } {
  const blocks: string[] = [];
  const missing: string[] = [];
  for (const m of line.matchAll(/(?:^|\s)@(\S+)/g)) {
    // "what about @notes.txt?" must not look for a file named "notes.txt?".
    const tries = [m[1], m[1].replace(/[?.,;:!]+$/, "")];
    // A loop, not .map: that read every candidate, so a plain `@huge.log` (where both
    // candidates are the same string) was pulled off disk twice.
    let found: string | null = null;
    for (const t of tries) {
      found = readBlock(t);
      if (found) break;
    }
    if (found) blocks.push(found);
    else missing.push(m[1]);
  }
  return { blocks, missing };
}

const HISTORY = join(DIR, "history");

function loadHistory(): string[] {
  try {
    // readline keeps history newest first; the file is written oldest first.
    return readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).slice(-HISTORY_MAX).reverse();
  } catch {
    return [];
  }
}

/** `/set` exists to type content in directly, so it is the one line most likely to hold a secret. */
const persistable = (line: string) => !/^\s*\/set\b/i.test(line);

function saveHistory(lines: string[]): void {
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    writeFileSync(HISTORY, `${lines.filter(persistable).slice(0, HISTORY_MAX).reverse().join("\n")}\n`, { mode: 0o600 });
    // It records everything typed, including /set and every command, and `mode` above
    // is ignored when the file already exists.
    if (process.platform !== "win32") chmodSync(HISTORY, 0o600);
  } catch {
    // History is a convenience; losing it must never take the session down.
  }
}

function paths(prefix: string): string[] {
  const cut = prefix.lastIndexOf("/");
  const dir = cut === -1 ? "." : prefix.slice(0, cut + 1) || "/";
  const head = prefix.slice(cut + 1);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.startsWith(head) && (head.startsWith(".") || !e.name.startsWith(".")))
      .map((e) => `${cut === -1 ? "" : dir}${e.name}${e.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

export function completer(line: string): [string[], string] {
  if (line.startsWith("/") && !line.includes(" ")) {
    const hits = matching(line).map((c) => c.name);
    return [hits.length ? hits : visible.map((c) => c.name), line];
  }
  const at = /(?:^\/load\s+|@)(\S*)$/.exec(line);
  return at ? [paths(at[1]), at[1]] : [[], line];
}

/** Output kept from one command, matching the old maxBuffer rather than growing forever. */
const MAX_OUTPUT = 1 << 24;

type Ran = { out: string; code: number };

/**
 * `exec` drops `detached`, and settles only once every inheritor of its pipes is gone, so
 * `sleep 30 | cat` could never be cancelled. spawn gives a real process group, and `exit`
 * fires when the shell goes whether or not a grandchild still holds the pipe.
 */
export function launch(cmd: string): Promise<Ran> & { child: ChildProcess } {
  // stdin ignored, so a command that reads it sees EOF instead of waiting forever.
  const proc = spawn(cmd, { shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const promise = new Promise<Ran>((resolve, reject) => {
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => { if (out.length < MAX_OUTPUT) out += d; });
    proc.stderr.on("data", (d: string) => { if (err.length < MAX_OUTPUT) err += d; });
    proc.on("error", reject);
    // Both streams, in that order: `npm test` writes progress to stdout and the failure
    // to stderr, and keeping only stdout drops the part worth asking about.
    proc.on("exit", (code, signal) => resolve({ out: out + err, code: code ?? (signal ? 1 : 0) }));
  });
  return Object.assign(promise, { child: proc });
}

/** Programs the user allowed for the rest of the session. */
const allowed = new Set<string>();
/**
 * Anything beyond one program and its arguments, which the allowlist must not cover.
 * It stops a second program being smuggled in, not a flag: `git -c alias.x=!cmd` can
 * still run anything git can. Enumerating every tool's escape hatch is unwinnable, so
 * the box says the allowlist trusts the program, and nothing here pretends otherwise.
 */
const SHELL_SYNTAX = /[;&|`$(){}<>\n\\]/;
let child: ChildProcess | null = null;
let asking: AbortController | null = null;

/**
 * Signals the whole process group. Killing only the shell leaves `sleep 30 | cat` holding
 * the pipe, and exec settles on that pipe closing, so the REPL would never come back.
 */
let cancelled = false;

export function stopChild(): void {
  const pid = child?.pid;
  if (!pid) return;
  cancelled = true;
  try {
    process.kill(-pid, "SIGINT");
  } catch {
    child?.kill("SIGINT");
  }
  const dying = child;
  setTimeout(() => {
    // Only if this exact child is still running: the pid could have been recycled.
    if (dying.exitCode !== null || dying.signalCode !== null) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone, which is the good case.
    }
  }, 2_000).unref();
}

async function shell(cmd: string, rl: Interface, drain: () => void): Promise<{ out: string; code: number }> {
  const head = cmd.split(/\s+/)[0] ?? "";
  // `git` in the allowlist must not wave through `git log; curl x | sh`, which is a
  // different program wearing the same first word.
  const simple = !SHELL_SYNTAX.test(cmd);
  if (!simple || !allowed.has(head)) {
    // Drops anything still unsent, so a stray keystroke cannot become the answer to a
    // box it never saw. A question queued earlier still runs after this, as intended.
    drain();
    console.log(box([
      bold("Run a shell command?"),
      ``,
      `  ${cyan(cmd)}`,
      ``,
      `  ${dim("1")}  yes`,
      ...(simple ? [`  ${dim("2")}  yes, and stop asking for ${bold(head)}`] : []),
      `  ${dim("3")}  no`,
      ``,
      ...(simple
        ? [dim(`  option 2 trusts ${head} itself, flags included, not just this command`)]
        : [dim("  shell syntax, so this one is always confirmed")]),
    ]));
    asking = new AbortController();
    const past = history(rl);
    const depth = past?.length ?? 0;
    let pick: string;
    try {
      pick = (await rl.question(`  ${dim("1-3, enter for yes")} `, { signal: asking.signal })).trim();
    } catch {
      throw new JevError("Not run.");
    } finally {
      asking = null;
      // readline records question answers too, and "2" is not something to press up for.
      past?.splice(0, past.length - depth);
    }
    if (pick === "2" && simple) allowed.add(head);
    else if (pick && pick !== "1") throw new JevError("Not run.");
  }

  const stop = spinner(cmd);
  const p = launch(cmd);
  child = p.child;
  try {
    const { out, code } = await p;
    if (cancelled) throw new JevError("Cancelled.");
    // 127 on POSIX shells, 9009 from cmd.exe. Typing a question after ! is the common slip.
    if (code === 127 || code === 9009) {
      throw new JevError(`\`${cmd}\` is not a shell command. To type state directly, use /set.`);
    }
    // A failing command is the interesting case: `/run npm test` on a broken suite keeps
    // its output. Only one with nothing to show is useless.
    if (!out.trim()) throw new JevError(`\`${cmd}\` exited ${code} with no output.`);
    return { out, code };
  } catch (err) {
    if ((err as Error).name === "Error" && !(err instanceof JevError)) {
      throw new JevError(`\`${cmd}\` could not be started: ${(err as Error).message}`);
    }
    throw err;
  } finally {
    stop();
    child = null;
    cancelled = false;
  }
}

export async function repl(): Promise<void> {
  // Lines arriving together came from a paste, so they are gathered before being handled.
  const pending: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();
  const clearPending = () => {
    pending.length = 0;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const ctx: Ctx = { state: "", source: "nothing", drain: clearPending };
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
    completer,
    history: loadHistory(),
    historySize: HISTORY_MAX,
    removeHistoryDuplicates: true,
  });

  let busy = false;
  let closed = false;
  let armed = false;
  let hint = "";
  let continued: string[] = [];
  let inflight: AbortController | null = null;

  function status(): string {
    if (hint) return yellow(hint);
    if (continued.length) return dim("… line continues, end without \\ to send");
    const typed = rl.line ?? "";
    if (typed.startsWith("/")) {
      const hits = matching(typed);
      if (hits.length === 1) return `${cyan(label(hits[0]))}  ${dim(hits[0].help)}`;
      if (hits.length) return hits.map((c) => cyan(c.name)).join("  ");
    }
    return dim(ctx.state ? `${ctx.source} · ${ctx.state.length} chars · tab completes` : "no state · / for commands · tab completes");
  }

  const repaint = () => {
    if (busy || closed) return;
    const typed = rl.line ?? "";
    below(status(), typed.length, rl.cursor >= typed.length);
  };

  function prompt(): void {
    if (closed) return;
    openFrame();
    rl.prompt();
    repaint();
  }

  process.stdin.on("keypress", (_s, key) => {
    if (key?.ctrl && key.name === "c") return;
    if (hint) { hint = ""; armed = false; }
    setImmediate(repaint);
  });

  rl.on("SIGINT", () => {
    if (asking) return void asking.abort();
    if (inflight) return void inflight.abort();
    if (child) return void stopChild();
    // ctrl-c abandons what you were typing, and a line left open with \ is part of that.
    // Keeping it meant the next question was silently sent with the old text glued on.
    continued = [];
    if (rl.line) {
      // ctrl-u only kills leftwards, so text to the right of the cursor would survive
      // and "twice to exit" could never arm.
      rl.write(null, { ctrl: true, name: "u" });
      rl.write(null, { ctrl: true, name: "k" });
      armed = false;
      repaint();
      return;
    }
    if (armed) return void rl.close();
    armed = true;
    hint = "press ctrl-c again to exit";
    repaint();
  });

  async function askJev(line: string): Promise<void> {
    const parts = line.split(";").map((p) => p.trim()).filter(Boolean);
    const { blocks, missing } = mentioned(line);
    // Silently dropping these would answer against nothing while looking like it read them.
    for (const path of missing) console.log(yellow(`  could not read @${path}, so it was not sent`));
    // Each question carries its own text, so one is not judged against another's context.
    const rough = [ctx.state, ...blocks, ...parts].filter(Boolean).join("\n\n");

    const started = Date.now();
    inflight = new AbortController();
    const stop = spinner(parts.length > 1 ? `asking ${parts.length} questions` : "thinking");
    try {
      const results = await askAll(rough, parts, inflight.signal);
      stop();
      for (const r of results) {
        if (results.length > 1) console.log(heading(r.text));
        if (r.error) { console.log(yellow(`  ${r.error}`)); continue; }
        console.log(renderRich(r.answer));
        const why = r.bare ? criterionHint(r.answer, r.question) : "";
        if (why) console.log(why);
      }
      // Named on the answer itself, not only under the box: stale state is Jev's worst
      // failure mode, and the answer is where you are actually looking.
      const sources = [ctx.state ? ctx.source : "", ...blocks.map((b) => b.split("\n")[0].replace(/^--- | ---$/g, ""))].filter(Boolean);
      const from = sources.length ? ` · judged against ${sources.join(" + ")}` : "";
      console.log(`  ${dim(`${Date.now() - started}ms${from}`)}`);
    } finally {
      stop();
      inflight = null;
    }
  }

  async function dispatch(name: string, rest: string): Promise<void> {
    const near = matching(name, true);
    const cmd = COMMANDS.find((c) => c.name === name) ?? (near.length === 1 ? near[0] : undefined);
    if (!cmd) {
      throw new JevError(near.length
        ? `${name} could be ${near.map((c) => c.name).join(" or ")}. Type more of it, or press tab.`
        : `unknown command ${name}. /help for the list`);
    }
    if (cmd.arg && !rest) throw new JevError(`${cmd.name} needs ${cmd.arg}`);
    await cmd.run(rest, ctx, rl);
  }

  async function handle(line: string): Promise<void> {
    if (line.startsWith("!")) return dispatch("/run", line.slice(1).trim());
    if (line.startsWith("/")) {
      const space = line.indexOf(" ");
      return dispatch(space === -1 ? line : line.slice(0, space), space === -1 ? "" : line.slice(space + 1).trim());
    }
    await askJev(line);
  }

  async function submit(batch: string[]): Promise<void> {
    // A flush that drain() emptied has nothing to do, and closeFrame([]) would eat a
    // line of real output.
    if (!batch.length) return;
    busy = true;
    try {
      closeFrame(batch);
      if (batch.length > 1) {
        // Pasted content is data, not commands worth pressing up for, and it may be a log
        // with a token in it. Keep it out of the history file.
        const past = history(rl);
        if (past) for (const line of batch) {
          const at = past.indexOf(line);
          if (at !== -1) past.splice(at, 1);
        }
        setState(ctx, batch.join("\n"), `pasted ${batch.length} lines`);
      } else {
        const line = batch[0].trim();
        if (line.endsWith("\\")) {
          continued.push(line.slice(0, -1));
        } else {
          const full = [...continued, line].map((l) => l.trim()).filter(Boolean).join(" ");
          continued = [];
          if (full) {
            console.log(echo(full));
            await handle(full);
          }
        }
      }
    } catch (err) {
      console.error(yellow(`  ${err instanceof JevError ? err.message : (err as Error).message}`));
    } finally {
      // Outside the try before: one failed write left busy stuck on, and the REPL then
      // took keystrokes and Enter while doing nothing at all.
      busy = false;
      prompt();
    }
  }

  rl.on("line", (raw) => {
    pending.push(raw);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = pending.splice(0);
      // A rejected chain skips every .then after it, which is the whole rest of the session.
      chain = chain.then(() => submit(batch)).catch(() => {});
    }, PASTE_WINDOW_MS);
  });

  console.log(BANNER);
  prompt();

  await new Promise<void>((done) => {
    rl.on("close", () => {
      // Mid-submit the box is already gone; otherwise the cursor still sits inside it.
      if (!busy) { process.stdout.write("\n"); closeFrame([rl.line ?? ""]); }
      closed = true;
      clearPending();
      saveHistory(history(rl) ?? []);
      console.log(dim("  bye"));
      done();
    });
  });
}
