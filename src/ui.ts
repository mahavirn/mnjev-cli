import { CONFIDENCE_FLOOR, certainty, levelName, NONE, type Answer, type Question } from "./jev.ts";

// Cursor work needs a terminal; colour needs one that is not piped or asked to stay plain.
const TTY = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
const COLOR = TTY && !process.env.NO_COLOR;

const paint = (code: string) => (s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = paint("2");
export const bold = paint("1");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");
export const red = paint("31");

/**
 * Characters that take two terminal columns. Surrogate pairs already count two UTF-16
 * units, so emoji come out right without being listed.
 * ponytail: CJK and fullwidth only. Combining marks still over-count; real wcwidth if it matters.
 */
const WIDE = /[\u1100-\u115F\u2329\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/g;

/** Printable width in columns, ignoring colour codes. */
const len = (s: string) => {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.length + (plain.match(WIDE)?.length ?? 0);
};

const cols = () => process.stdout.columns || 80;
/** Inside of the frame. Recomputed per draw, so resize works. */
const inner = () => Math.max(cols() - 2, 16);

export const PROMPT = COLOR ? `${dim("│")} ${cyan("›")} ` : "> ";

const SGR = /\x1b\[[0-9;]*m/g;

/** Cuts by printable width, copying colour codes whole: half an escape eats what follows. */
export function truncate(s: string, width: number): string {
  if (len(s) <= width) return s;
  let out = "";
  let shown = 0;
  let i = 0;
  const room = Math.max(width - 1, 0);
  while (i < s.length) {
    SGR.lastIndex = i;
    const m = SGR.exec(s);
    if (m?.index === i) {
      out += m[0];
      i = SGR.lastIndex;
      continue;
    }
    // Checked before taking it: a two-column character would otherwise step past the edge.
    const w = len(s[i]);
    if (shown + w > room) break;
    out += s[i++];
    shown += w;
  }
  return COLOR ? `${out}…\x1b[0m` : `${out}…`;
}

const rule = (left: string, right: string) => dim(`${left}${"─".repeat(inner())}${right}`);

/** A closed box around static text. */
export function box(lines: string[]): string {
  const w = inner();
  const body = lines.map((l) => `${dim("│")} ${truncate(l, w - 2)}${" ".repeat(Math.max(w - 1 - len(truncate(l, w - 2)), 0))}${dim("│")}`);
  return [rule("╭", "╮"), ...body, rule("╰", "╯")].join("\n");
}

/** What `below` last drew, so an unchanged status costs no writing at all. */
let drawn = "";

/** Top border, plus two rows reserved below so the status line always has somewhere to go. */
export function openFrame(): void {
  if (!TTY) return;
  drawn = "";
  process.stdout.write(`${rule("╭", "╮")}\n\n\n\x1b[2A`);
}

/**
 * Bottom border and status line, drawn without moving the cursor. Runs on every keypress.
 * ponytail: no right border, readline owns that row. Drawing one means a raw-mode editor.
 */
export function below(status: string, inputLen = 0, atEnd = true): void {
  if (!TTY) return;
  // Typing rarely changes anything down here, and redrawing a full-width border on every
  // keystroke is what made the box feel slow. The row count is part of the key because a
  // line that wraps pushes readline over the bottom rule, which then needs repainting.
  const key = `${cols()}\u0000${rowsUsed([" ".repeat(inputLen)])}\u0000${status}`;
  if (key === drawn) return;
  drawn = key;
  // `\x1b[1B` stops at the last row; a `\n` here would scroll, and the saved cursor
  // position is absolute, so the restore would land a row below the real input line.
  // A line that wraps lands on the row the old rule occupied, leaving its tail glued to
  // the text. Only safe with the cursor at the end, or this would eat what is to its right.
  const wipe = atEnd ? "\x1b[0K" : "";
  process.stdout.write(
    `\x1b7${wipe}\x1b[1B\r\x1b[0J${rule("╰", "╯")}\r\x1b[1B  ${truncate(status, cols() - 3)}\x1b8`,
  );
}

/** Rows the submitted input took up, wrapping included. */
function rowsUsed(lines: string[]): number {
  const width = cols();
  // len, not .length: a wide character wraps after half as many, and an undercount here
  // erases from the wrong row and leaves the box on screen.
  return lines.reduce((n, l, i) => n + Math.max(Math.ceil(((i === 0 ? len(PROMPT) : 0) + len(l)) / width), 1), 0);
}

/** Erases the input box on submit, so it stays the last thing on screen. */
export function closeFrame(lines: string[]): void {
  if (!TTY) return;
  drawn = "";
  process.stdout.write(`\x1b[0J\x1b[${rowsUsed(lines) + 1}A\r\x1b[0J`);
}

/** The submitted question, reprinted where the box was. */
export const echo = (text: string) => `  ${dim("›")} ${text}`;

/** Braille spinner, so a 1.2s wait does not look like a hang. */
export function spinner(label: string) {
  if (!COLOR) return () => {};
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const started = Date.now();
  let i = 0;
  const timer = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    // Held back a second so a 330ms answer does not flash the hint.
    const meta = secs >= 1 ? dim(` (${secs}s · ctrl-c to cancel)`) : "";
    process.stdout.write(`\r\x1b[2K  ${cyan(frames[i++ % frames.length])} ${dim(label)}${meta}`);
  }, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write(`\r\x1b[2K`);
  };
}

const BAR = 20;
function bar(p: number): string {
  // Clamped: drawing must not throw, whatever number it is handed.
  const filled = Math.min(Math.max(Math.round(p * BAR), 0), BAR);
  return `${"█".repeat(filled)}${dim("░".repeat(BAR - filled))}`;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Green when Jev is sure, yellow when it is not. The colour is the whole message. */
function tone(confidence: number) {
  return confidence >= CONFIDENCE_FLOOR ? paint("32") : paint("33");
}

/** Every option Jev scored, as bars. Nothing is hidden: this is the response. */
function bars(rows: [string, number][]): string[] {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, p]) => `    ${dim(k.padEnd(width))}  ${bar(p)} ${dim(pct(p).padStart(4))}`);
}

/** Marker, verdict, dim aside. Every answer reads the same way. */
const verdict = (confidence: number, text: string, aside: string, warn = false) =>
  `  ${(warn ? yellow : tone(confidence))("●")} ${bold(text)}  ${dim(aside)}`;

export function renderRich(a: Answer, meta?: string): string {
  const lines: string[] = [];

  if (a.type === "noul") {
    // A noul is one number: the probability the statement is true.
    const yes = a.noul > 0.5;
    const sure = certainty(a);
    // "sure", because this is the probability of the answer given, not the confidence a
    // choice prints beside it. A 65% "no" is a weak answer, not a 65%-confident one, and
    // an unlabelled number here read as the same measure as "confidence 65%".
    lines.push(verdict(sure, yes ? "yes" : "no", `${pct(yes ? a.noul : 1 - a.noul)} sure`));
    lines.push(...bars([["yes", a.noul], ["no", 1 - a.noul]]));
    // Measured outward from 0.5, so name the number this answer actually had to beat.
    const need = Math.round((0.5 + CONFIDENCE_FLOOR / 2) * 100);
    if (sure < CONFIDENCE_FLOOR) lines.push(`  ${yellow("unsure")} ${dim(`- needs ${need}% either way, 50% means no idea`)}`);
  } else if (a.type === "choice") {
    const none = a.choice === NONE;
    const sure = a.confidence >= CONFIDENCE_FLOOR;
    // A confident "none of these" is still a warning: your options did not cover the case.
    lines.push(verdict(a.confidence, none ? (sure ? "none of these fit" : "no clear answer") : a.choice, `confidence ${pct(a.confidence)}`, none));
    // Ranked, because for a choice the order of your options carries no meaning.
    lines.push(...bars(Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1])));
    if (none && sure) lines.push(`  ${dim("the answer is not among the options you gave")}`);
    else if (!sure) lines.push(`  ${yellow("unsure")} ${dim("- try clearer options, or more context")}`);
  } else {
    const top = Object.keys(a.legend ?? {}).length - 1;
    lines.push(verdict(a.confidence, levelName(a), `${a.score.toFixed(2)} of 0-${top}, confidence ${pct(a.confidence)}`));
    // Kept in scale order, because for a score the order IS the meaning.
    lines.push(...bars(Object.keys(a.legend ?? {}).map((k) => [a.legend[k], a.probabilities?.[k] ?? 0])));
    if (a.confidence < CONFIDENCE_FLOOR) lines.push(`  ${yellow("unsure")} ${dim("- the levels overlap, try fewer or clearer ones")}`);
  }

  if (meta) lines.push(`  ${dim(meta)}`);
  return lines.join("\n");
}

export function criterionHint(a: Answer, q: Question): string {
  if (a.type !== "choice" || q.type !== "choice" || a.confidence >= CONFIDENCE_FLOOR) return "";
  const opts = Object.keys(q.criteria).filter((k) => k !== NONE);
  if (opts.length < 2) return "";
  return `  ${dim("say what you are comparing on:")}  ${cyan(`which is better for X? ${opts.join(" or ")}`)}`;
}

export const heading = (q: string) => `  ${dim(q)}`;

export const BANNER = [
  ``,
  box([
    `${bold("mnjev")}  ${dim("typed decisions")}`,
    ``,
    `Ask anything. Load state first when the question is about your stuff.`,
    ``,
    `  can penguins swim?`,
    `  email vs chat`,
    ``,
    `  ${dim("Two steps: load something, then ask about it.")}`,
    ``,
    `  ${cyan("!git log --oneline -10")}`,
    `  ${cyan("is any of this about auth?")}`,
  ]),
  ``,
  `  ${dim("/ for commands · tab to complete · ctrl-c to cancel, twice to exit")}`,
  ``,
].join("\n");
