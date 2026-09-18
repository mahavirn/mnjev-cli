import { CONFIDENCE_FLOOR, certainty, levelName, NONE, type Answer, type Question } from "./jev.ts";

// Colour is off when piped, when NO_COLOR is set, or on a dumb terminal.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code: string) => (s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = paint("2");
export const bold = paint("1");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");
export const red = paint("31");

export const PROMPT = COLOR ? `${cyan("›")} ` : "> ";

const BAR = 20;
function bar(p: number): string {
  // Clamped: drawing must not throw, whatever number it is handed.
  const filled = Math.min(Math.max(Math.round(p * BAR), 0), BAR);
  return `${"█".repeat(filled)}${dim("░".repeat(BAR - filled))}`;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Green when Jev is sure, yellow when it is not. The colour is the whole message. */
function tone(confidence: number) {
  return confidence >= CONFIDENCE_FLOOR ? paint("1;32") : paint("1;33");
}

/** Braille spinner, so a 1.2s wait does not look like a hang. */
export function spinner(label: string) {
  if (!COLOR) return () => {};
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${cyan(frames[i++ % frames.length])} ${dim(label)}`);
  }, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write(`\r\x1b[2K`);
  };
}

/** Every option Jev scored, as bars. Nothing is hidden: this is the response. */
function bars(rows: [string, number][]): string[] {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, p]) => `    ${dim(k.padEnd(width))}  ${bar(p)} ${dim(pct(p).padStart(4))}`);
}

export function renderRich(a: Answer, meta?: string): string {
  const lines: string[] = [];

  if (a.type === "noul") {
    // A noul is one number: the probability the statement is true.
    const yes = a.noul > 0.5;
    const sure = certainty(a);
    lines.push(`  ${tone(sure)(yes ? "yes" : "no")}  ${dim(pct(yes ? a.noul : 1 - a.noul))}`);
    lines.push(...bars([["yes", a.noul], ["no", 1 - a.noul]]));
    if (sure < CONFIDENCE_FLOOR) lines.push(`  ${yellow("unsure")} ${dim("- 50% means it has no idea")}`);
  } else if (a.type === "choice") {
    const none = a.choice === NONE;
    const sure = a.confidence >= CONFIDENCE_FLOOR;
    const c = none ? yellow : tone(a.confidence);
    lines.push(`  ${c(none ? (sure ? "none of these fit" : "no clear answer") : a.choice)}  ${dim(`confidence ${pct(a.confidence)}`)}`);
    // Ranked, because for a choice the order of your options carries no meaning.
    lines.push(...bars(Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1])));
    if (none && sure) lines.push(`  ${dim("the answer is not among the options you gave")}`);
    else if (!sure) lines.push(`  ${yellow("unsure")} ${dim("- try clearer options, or more context")}`);
  } else {
    const top = Object.keys(a.legend ?? {}).length - 1;
    lines.push(`  ${tone(a.confidence)(levelName(a))}  ${dim(`${a.score.toFixed(2)} of 0-${top}, confidence ${pct(a.confidence)}`)}`);
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
  `  ${bold("mnjev")}  ${dim("typed decisions")}`,
  ``,
  `  Ask anything. Load state first when the question is about your stuff.`,
  ``,
  `    can penguins swim?`,
  `    email vs chat`,
  `    ${cyan("/run")} git log --oneline -10   ${dim("then")}   is any of this about auth?`,
  ``,
  `  ${dim("/help for commands, /exit to quit")}`,
  ``,
].join("\n");
