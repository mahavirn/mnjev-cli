import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { MAX_STATE } from "./config.ts";
import { JevError } from "./jev.ts";
import { askAll } from "./classify.ts";
import { BANNER, criterionHint, cyan, dim, heading, PROMPT, renderRich, spinner, yellow } from "./ui.ts";

const HELP = [
  ``,
  `  ${dim("Just ask. Jev works out what kind of question it is:")}`,
  ``,
  `    can penguins swim?                            ${dim("yes / no")}`,
  `    email vs chat                                 ${dim("pick one")}`,
  `    which team? billing, support, or infra        ${dim("pick one")}`,
  `    which fruit is yellow? A. Apple B. Banana     ${dim("pick one")}`,
  `    how urgent is this? low|medium|critical       ${dim("a level")}`,
  ``,
  `  ${dim("Put the question before the ? and the options after it. That way the")}`,
  `  ${dim("options stay clean and Jev knows what you are comparing on:")}`,
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
  `    ${cyan("/set")}  <text>      type the state in directly`,
  `    ${cyan("/load")} <file>      use a file as state`,
  `    ${cyan("/run")}  <command>   use a command's output as state`,
  `    ${cyan("/state")}            show what is loaded`,
  `    ${cyan("/clear")}            drop the state`,
  `    ${cyan("/help")}  ${cyan("/exit")}`,
  ``,
  `  ${dim("Your options go to Jev exactly as you typed them, and every")}`,
  `  ${dim("probability it returns is shown. Watch the confidence.")}`,
  ``,
  `  ${dim("To override what Jev decided, say it outright:")}`,
  ``,
  `    ${cyan("choice")} which team? billing,technical`,
  `    ${cyan("score")}  how urgent? low|medium|critical`,
  ``,
].join("\n");

function preview(state: string): string {
  const lines = state.split("\n");
  const shown = lines.slice(0, 5).map((l) => dim(`  │ ${l.slice(0, 76)}`)).join("\n");
  return lines.length > 5 ? `${shown}\n${dim(`  │ ... ${lines.length - 5} more lines`)}` : shown;
}

export async function repl() {
  let state = "";
  let source = "nothing";

  /** Returns false when the session should end. */
  async function handle(line: string): Promise<boolean> {
    if (line === "/exit" || line === "/quit") return false;
    if (line === "/help") { console.log(HELP); return true; }
    if (line === "/clear") { state = ""; source = "nothing"; console.log("State cleared."); return true; }
    if (line === "/state") {
      console.log(state ? `  ${dim(`${source}, ${state.length} chars`)}\n${preview(state)}` : dim("  nothing loaded"));
      return true;
    }
    if (line.startsWith("/set ")) {
      state = line.slice(5).trim();
      source = "typed";
      console.log(dim(`  state set, ${state.length} chars`));
      return true;
    }
    if (line.startsWith("/load ")) {
      const path = line.slice(6).trim();
      state = readFileSync(path, "utf8");
      source = path;
      console.log(dim(`  loaded ${path}, ${state.length} chars`));
      return true;
    }
    if (line.startsWith("/run ")) {
      const cmd = line.slice(5).trim();
      let out: string;
      try {
        out = execSync(cmd, { encoding: "utf8", maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        // A failing command is the interesting case: `/run npm test` on a broken suite
        // must keep its output. Only a command that does not exist is a user mistake.
        const e = err as { status?: number; code?: string; stdout?: string; stderr?: string };
        const captured = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        // 127 on POSIX shells, 9009 from cmd.exe, ENOENT when the shell itself is missing.
        if (e.status === 127 || e.status === 9009 || e.code === "ENOENT") {
          // Typing a question after /run is the common slip, so name the command they wanted.
          throw new JevError(`\`${cmd}\` is not a shell command. To type state directly, use /set.`);
        }
        if (!captured.trim()) throw new JevError(`\`${cmd}\` exited ${e.status ?? "abnormally"} with no output.`);
        out = captured;
      }
      // Windows tools emit CRLF; the stray \r would show up in the state preview.
      state = out.replace(/\r\n/g, "\n");
      source = `$ ${cmd}`;
      console.log(dim(`  captured ${state.length} chars from ${cmd}`));
      return true;
    }
    if (line.startsWith("/")) { console.log(yellow(`  unknown command. /help for the list`)); return true; }

    // Jev answers every question in one round trip, so `a?; b?; c?` costs one call.
    const parts = line.split(";").map((p) => p.trim()).filter(Boolean);

    // Whatever the user typed goes to Jev. A question also carries its own text, so
    // "which fruit is red?" is not judged against yesterday's git log, and a question
    // asked with nothing loaded is simply its own state.
    const rough = [state, ...parts].filter(Boolean).join("\n\n");
    if (rough.length > MAX_STATE) {
      console.log(yellow(`  ${rough.length} chars is too much. Jev loses accuracy past ~${MAX_STATE}; narrow it with /run.`));
      return true;
    }

    const started = Date.now();
    const stop = spinner(parts.length > 1 ? `asking ${parts.length} questions` : "thinking");
    try {
      // One call: Jev classifies each line and answers it in the same round trip.
      const results = await askAll(rough, parts);
      stop();
      results.forEach((r) => {
        if (results.length > 1) console.log(heading(r.text));
        if (r.error) {
          console.log(yellow(`  ${r.error}`));
          return;
        }
        console.log(renderRich(r.answer));
        if (r.bare) console.log(criterionHint(r.answer, r.question));
      });
      console.log(`  ${dim(`${Date.now() - started}ms`)}`);
    } catch (err) {
      stop();
      throw err;
    }
    return true;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // stdin can close while a request is in flight, and prompting a closed readline throws.
  let closed = false;
  rl.on("close", () => { closed = true; });
  console.log(BANNER);
  rl.setPrompt(PROMPT);
  rl.prompt();

  // Iterating handles Ctrl-D and EOF; rl.question() hangs forever once stdin closes.
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) {
      try {
        if (!(await handle(line))) break;
      } catch (err) {
        console.error(yellow(`  ${err instanceof JevError ? err.message : (err as Error).message}`));
      }
    }
    // Do not break here: stdin may be closed while lines are still queued, and
    // breaking would silently drop them. Just stop prompting and let it drain.
    if (!closed) rl.prompt();
  }
  rl.close();
}
