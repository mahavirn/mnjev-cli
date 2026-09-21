import assert from "node:assert/strict";
import { buildQuestion, JevError, NONE, parseCriteria, render } from "./src/jev.ts";
import { candidates } from "./src/classify.ts";
import { explicit, explicitQuestion, hasCriterion, maxOptions, mayHaveOptions, spans } from "./src/parse.ts";

// --- parseCriteria ---
assert.deepEqual(parseCriteria("api,db"), { api: "api", db: "db" });
assert.deepEqual(parseCriteria(" api = the public API , db=the database "), {
  api: "the public API",
  db: "the database",
});
// a description containing = keeps everything after the first one
assert.deepEqual(parseCriteria("a=x=y,b=z"), { a: "x=y", b: "z" });
// trailing commas are ignored, not turned into an empty option
assert.deepEqual(parseCriteria("a,b,"), { a: "a", b: "b" });
assert.throws(() => parseCriteria("onlyone"), JevError);

// --- buildQuestion ---
assert.deepEqual(buildQuestion("noul", "is it down?", ""), { type: "noul", instructions: "is it down?" });
assert.deepEqual(buildQuestion("score", "how bad?", "low|high"), {
  type: "score",
  instructions: "how bad?",
  criteria: ["low", "high"],
});
assert.throws(() => buildQuestion("score", "how bad?", "low"), JevError);
assert.throws(() => buildQuestion("noul", "", ""), JevError);
assert.throws(() => buildQuestion("bogus", "q", ""), JevError);
// options go to Jev exactly as typed unless JEV_ESCAPE asks for an escape hatch
assert.ok(!(NONE in (buildQuestion("choice", "q", "a,b") as { criteria: object }).criteria));

// --- spans: over-find, decide nothing ---
// the split that plain rules could never get right is offered as a candidate
const morning = spans("coffee or tea in the morning");
assert.ok(morning.includes("coffee"));
assert.ok(morning.includes("tea"));
assert.ok(morning.includes("tea in the morning"));
// filler words are not alternatives on their own
assert.ok(!spans("is this a bug or a problem").includes("a"));
// a leading keyword is not part of any option
assert.ok(!spans("choice which team? billing, infra").some((s) => /^choice\b/i.test(s)));

// only lines that could name alternatives are worth an extraction call
assert.equal(mayHaveOptions("apple or banana"), true);
assert.equal(mayHaveOptions("email vs chat"), true);
assert.equal(mayHaveOptions("A. red B. blue"), true);
assert.equal(mayHaveOptions("can penguins swim?"), false);
assert.equal(mayHaveOptions("how angry is this customer?"), false);

// the sentence decides how many option slots to ask for, not a fixed cap
assert.equal(maxOptions("apple or banana"), 2);
assert.equal(maxOptions("chrome or firefox or safari or edge or opera?"), 5);
// never fewer than two, or a two-way choice could not be found at all
assert.equal(maxOptions("can penguins swim?"), 2);
// and capped, so one absurd line cannot build an enormous request
assert.equal(maxOptions("a or b or c or d or e or f or g or h or i or j or k or l"), 10);

// --- explicit: what the user states is never second-guessed ---
assert.equal(explicit("score how bad? low|high"), true);
assert.equal(explicit("choice which team? a,b"), true);
assert.equal(explicit("how urgent is this? low|medium|critical"), true);
assert.equal(explicit("can penguins swim?"), false);
assert.equal(explicit("email or chat"), false);

assert.deepEqual(explicitQuestion("choice which team? billing,technical"), {
  type: "choice",
  instructions: "which team?",
  criteria: { billing: "billing", technical: "technical" },
});
// pipes mean levels even without the score keyword
assert.deepEqual(explicitQuestion("how urgent? low|medium|high"), {
  type: "score",
  instructions: "how urgent?",
  criteria: ["low", "medium", "high"],
});
assert.throws(() => explicitQuestion("choice"), JevError);

// a line with no ? or : names no criterion, so the UI can say what is missing
assert.equal(hasCriterion("email or chat"), false);
assert.equal(hasCriterion("which is better for a quick reply? email or chat"), true);

// --- candidates: every form the line could take ---
const withOpts = candidates("which is yellow? apple or banana", ["apple", "banana"]);
assert.equal(withOpts.noul.type, "noul");
assert.deepEqual(Object.keys((withOpts.choice as { criteria: object }).criteria), ["apple", "banana"]);
// found options become the levels, so a rating reuses them rather than a generic scale
assert.deepEqual((withOpts.score as { criteria: string[] }).criteria, ["apple", "banana"]);
// the escape hatch must never leak in as a rating level
assert.ok(!(withOpts.score as { criteria: string[] }).criteria.includes(NONE));

const noOpts = candidates("how angry is this customer?", null);
assert.equal((noOpts.score as { criteria: string[] }).criteria.length, 5);
assert.equal(noOpts.choice, undefined); // nothing can invent option names

// --- render, and the confidence gate ---
assert.equal(render("q", { type: "noul", noul: 0.99 }), "q: yes (0.99)");
// a confident no is still confident: both edges are certainty, the middle is not
assert.equal(render("q", { type: "noul", noul: 0.02 }), "q: no (0.02)");
assert.match(render("q", { type: "noul", noul: 0.55 }), /low, check this$/);
assert.equal(
  render("q", { type: "choice", choice: "billing", confidence: 1, probabilities: {} }),
  "q: billing  confidence 1.00",
);
// a 0.40 answer must be flagged, not shown as if it were settled
assert.match(
  render("q", { type: "choice", choice: "backups", confidence: 0.4, probabilities: {} }),
  /low, check this$/,
);
const legend = { "0": "calm", "1": "civil", "2": "annoyed", "3": "furious" };
assert.equal(
  render("q", { type: "score", score: 2.68, confidence: 0.9, legend, probabilities: {} }),
  "q: furious (2.68)  confidence 0.90",
);
assert.match(
  render("q", { type: "score", score: 2.68, confidence: 0.68, legend, probabilities: {} }),
  /low, check this$/,
);

// --- config: a typo must never silently disable a safety feature ---
import { spawnSync } from "node:child_process";

/** Reads a config value in a fresh process, since env is read once at import. */
function configWith(env: Record<string, string>, name: string): string {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(new URL("./src/config.ts", import.meta.url).href)});` +
    `process.stdout.write(String(m.${name}));`,
  ], { env: { ...process.env, ...env }, encoding: "utf8" });
  return r.stdout;
}

// an unparseable number falls back instead of becoming NaN, which would disable the gate
assert.equal(configWith({ JEV_CONFIDENCE: "high" }, "CONFIDENCE_FLOOR"), "0.7");
assert.equal(configWith({ JEV_CONFIDENCE: "" }, "CONFIDENCE_FLOOR"), "0.7");
// out of range is a typo too, not an instruction
assert.equal(configWith({ JEV_CONFIDENCE: "5" }, "CONFIDENCE_FLOOR"), "0.7");
assert.equal(configWith({ JEV_CONFIDENCE: "0.9" }, "CONFIDENCE_FLOOR"), "0.9");
// the obvious way to switch a flag off must switch it off
assert.equal(configWith({ JEV_ESCAPE: "0" }, "ESCAPE_HATCH"), "false");
assert.equal(configWith({ JEV_ESCAPE: "false" }, "ESCAPE_HATCH"), "false");
assert.equal(configWith({ JEV_ESCAPE: "1" }, "ESCAPE_HATCH"), "true");
assert.equal(configWith({ JEV_ESCAPE: "maybe" }, "ESCAPE_HATCH"), "false");

// --- splitSpec: the ? wins, so an options list may contain spaces ---
import { splitSpec } from "./src/parse.ts";
assert.deepEqual(splitSpec("choice which team? billing, technical"), {
  instructions: "which team?",
  spec: "billing, technical",
});
// a spaced list used to be truncated to its last word and rejected
assert.deepEqual(explicitQuestion("choice which team? billing, technical").criteria, {
  billing: "billing",
  technical: "technical",
});
// a pipe inside the question is a shell pipe, not a request for levels
assert.equal(explicit("does grep | sort fix this?"), false);
assert.equal(explicit("how urgent? low|medium|high"), true);
// nothing after the ? means no spec at all
assert.equal(splitSpec("can penguins swim?"), null);

// --- spans: bounded, because they are copied into every extraction slot ---
const huge = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" or ");
assert.ok(spans(huge).length <= 150, `unbounded candidates: ${spans(huge).length}`);
// a short line is unaffected by the cap
assert.ok(spans("coffee or tea in the morning").includes("tea in the morning"));

// --- certainty is one calculation, used by both renderers ---
import { certainty } from "./src/jev.ts";
assert.equal(certainty({ type: "noul", noul: 0.5 }), 0);
assert.equal(certainty({ type: "noul", noul: 1 }), 1);
assert.equal(certainty({ type: "noul", noul: 0 }), 1);
assert.equal(certainty({ type: "choice", choice: "a", confidence: 0.8, probabilities: {} }), 0.8);

// --- transport: every failure mode reports itself accurately ---
import { ask, type Reply, type Transport } from "./src/jev.ts";

process.env.TYPESAFE_API_KEY = "test-key-for-transport-checks";
const one = { a: { type: "noul" as const, instructions: "q" } };
const two = { ...one, b: { type: "noul" as const, instructions: "r" } };
const reply = (status: number, text: string, retryAfter: string | null = null): Reply => ({ status, text, retryAfter });
const ok = JSON.stringify({ model: "jev-1.13.0", answers: { a: { type: "noul", noul: 0.9 }, b: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 5, output_tokens: 1 } });

/** Returns the error message `ask` produced for a given canned reply. */
async function failure(transport: Transport): Promise<string> {
  try {
    await ask("state", two, transport);
    return "no error";
  } catch (err) {
    assert.ok(err instanceof JevError, `expected a JevError, got ${(err as Error).name}`);
    return (err as Error).message;
  }
}

// an HTML error page must report its status, not a JSON parse error
assert.match(await failure(async () => reply(502, "<html>502 Bad Gateway</html>")), /^mnjev 502: <html>/);
// a JSON error body uses the message the server sent
assert.match(await failure(async () => reply(401, JSON.stringify({ detail: { message: "bad key" } }))), /^mnjev 401: bad key$/);
// an empty 200 is still a failure, not an empty answer set
assert.match(await failure(async () => reply(200, "")), /empty response/);
// a partial answer set is caught here, so no renderer has to guard for it
assert.match(
  await failure(async () => reply(200, JSON.stringify({ answers: { a: { type: "noul", noul: 0.5 } } }))),
  /answered 1 of 2 questions/,
);
// a timeout says so rather than surfacing a raw socket error
assert.match(
  await failure(() => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))),
  /did not respond within \d+s/,
);
// a connection failure names itself
assert.match(await failure(() => Promise.reject(new Error("ECONNREFUSED"))), /Could not reach mnjev: ECONNREFUSED/);

// a complete response passes through untouched
{
  const res = await ask("state", two, async () => reply(200, ok));
  assert.deepEqual(res.answers.a, { type: "noul", noul: 0.9 });
  assert.equal(res.usage.input_tokens, 5);
  // --json consumers need to know which model version answered, since jev-latest moves
  assert.equal(res.model, "jev-1.13.0");
}

// --- retry: a rate limit must not fail a script ---

/** Serves the given statuses in order, then a valid answer. Counts its calls. */
function flaky(statuses: number[]) {
  let calls = 0;
  const transport: Transport = async () => {
    const status = calls < statuses.length ? statuses[calls] : 200;
    calls++;
    return reply(status, status === 200 ? ok : "{}", "0");
  };
  return { transport, calls: () => calls };
}

// a 429 then a 200 succeeds, and the caller never sees the retry
{
  const f = flaky([429]);
  const res = await ask("s", one, f.transport);
  assert.equal(f.calls(), 2);
  assert.deepEqual(res.answers.a, { type: "noul", noul: 0.9 });
}
// overload and gateway errors retry too
{
  const f = flaky([529, 503]);
  await ask("s", one, f.transport);
  assert.equal(f.calls(), 3);
}
// giving up reports the status rather than retrying forever
{
  const f = flaky([429, 429, 429, 429, 429]);
  await assert.rejects(() => ask("s", one, f.transport), /mnjev 429/);
  assert.equal(f.calls(), 4, "the first attempt plus three retries");
}
// a 401 is not transient, so it must not be retried
{
  const f = flaky([401]);
  await assert.rejects(() => ask("s", one, f.transport), /mnjev 401/);
  assert.equal(f.calls(), 1);
}
// a timeout is not retried either: waiting longer for something already slow rarely helps
{
  let calls = 0;
  const transport: Transport = () => {
    calls++;
    return Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
  };
  await assert.rejects(() => ask("s", one, transport), /did not respond within/);
  assert.equal(calls, 1);
}
delete process.env.TYPESAFE_API_KEY;

// --- the API is a trust boundary: bad answers must not reach a renderer ---
process.env.TYPESAFE_API_KEY = "test-key-for-transport-checks";
const answered = (a: unknown) => async () => reply(200, JSON.stringify({ answers: { a }, usage: {} }));

/** Same as `failure`, for fixtures that answer the single question `one`. */
async function failureOne(transport: Transport): Promise<string> {
  try {
    await ask("state", one, transport);
    return "no error";
  } catch (err) {
    assert.ok(err instanceof JevError, `expected a JevError, got ${(err as Error).name}`);
    return (err as Error).message;
  }
}

// a probability outside 0..1 used to crash the bar drawing with a RangeError
assert.match(await failureOne(answered({ type: "noul", noul: 1.05 })), /noul 1.05 is not between 0 and 1/);
assert.match(await failureOne(answered({ type: "noul", noul: -0.1 })), /not between 0 and 1/);
// a score with no legend used to crash the renderer with a raw TypeError
assert.match(
  await failureOne(answered({ type: "score", score: 1, confidence: 0.9, legend: {}, probabilities: {} })),
  /the score has no legend/,
);
assert.match(
  await failureOne(answered({ type: "choice", confidence: 0.9, probabilities: {} })),
  /no choice was returned/,
);
delete process.env.TYPESAFE_API_KEY;

// even so, drawing itself never throws on an odd number
import { renderRich } from "./src/ui.ts";
assert.doesNotThrow(() => renderRich({ type: "noul", noul: 1.05 }));
assert.doesNotThrow(() => renderRich({ type: "noul", noul: -0.5 }));

// a score labels itself from whichever lookup works, never the word "undefined"
import { levelName } from "./src/jev.ts";
assert.equal(levelName({ type: "score", score: 1, confidence: 1, legend: { "0": "low", "1": "high" }, probabilities: { "1": 0.9 } }), "high");
// probabilities keyed by name rather than index still resolve via the score
assert.equal(levelName({ type: "score", score: 0, confidence: 1, legend: { "0": "low", "1": "high" }, probabilities: { low: 0.9 } }), "low");

// --- a ? delimits the options; a colon only when there is no ? ---
assert.deepEqual(splitSpec("choice is https://x.com down? up,down"), {
  instructions: "is https://x.com down?",
  spec: "up,down",
});
assert.deepEqual(splitSpec("score 12:30 error how bad? low|high"), {
  instructions: "12:30 error how bad?",
  spec: "low|high",
});
// a colon still works when no ? is present
assert.deepEqual(splitSpec("choice pick one: red, blue"), { instructions: "pick one:", spec: "red, blue" });

// --- every whole alternative survives the candidate cap ---
const wordy = Array.from({ length: 8 }, (_, i) => `option number ${i}`);
const wordySpans = spans(wordy.join(" or "));
assert.ok(wordy.every((o) => wordySpans.includes(o)), "a whole alternative was dropped for a sub-span");
assert.ok(wordySpans.length <= 150);

// --- an empty Retry-After is not a zero-second delay ---
{
  process.env.TYPESAFE_API_KEY = "test-key-for-transport-checks";
  let calls = 0;
  const started = Date.now();
  const transport: Transport = async () => {
    calls++;
    return reply(429, "{}", "");
  };
  await assert.rejects(() => ask("s", one, transport), /mnjev 429/);
  assert.equal(calls, 4);
  // backoff is 500ms, 1000ms, 2000ms before jitter, so this cannot finish instantly
  assert.ok(Date.now() - started > 500, `retried with no pause at all (${Date.now() - started}ms)`);
  delete process.env.TYPESAFE_API_KEY;
}


// --- oversized state is refused at the one place every request passes through ---
process.env.TYPESAFE_API_KEY = "test-key-for-transport-checks";
import { checkState } from "./src/jev.ts";
import { MAX_STATE } from "./src/config.ts";
const huger = "x".repeat(MAX_STATE + 1);
assert.throws(() => checkState(huger), JevError);
assert.doesNotThrow(() => checkState("x".repeat(MAX_STATE)));
// the one-shot path used to send it anyway, because the guard lived in the REPL
await assert.rejects(() => ask(huger, one, async () => reply(200, ok)), /Jev loses accuracy past/);
{
  // and askAll refuses before spending a call per line on option finding
  const { askAll } = await import("./src/classify.ts");
  await assert.rejects(() => askAll(huger, ["a or b"]), /loses accuracy past/);
}

// --- a cancelled request is not a failure to retry ---
{
  let calls = 0;
  const transport: Transport = () => {
    calls++;
    return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  };
  await assert.rejects(() => ask("s", one, transport), /Cancelled/);
  assert.equal(calls, 1);
}

// --- /cost counts every call, including the ones option finding adds ---
import { usage } from "./src/jev.ts";
{
  const before = usage();
  await ask("s", one, async () => reply(200, ok));
  const after = usage();
  assert.equal(after.calls, before.calls + 1);
  assert.equal(after.input_tokens, before.input_tokens + 5);
}
delete process.env.TYPESAFE_API_KEY;

// --- /cost counts round trips that were billed, not only the ones that worked ---
process.env.TYPESAFE_API_KEY = "test-key-for-transport-checks";
{
  const before = usage().calls;
  const f = flaky([429, 503]);
  await ask("s", one, f.transport);
  // two rejected attempts plus the one that answered were all billed
  assert.equal(usage().calls - before, 3);
}
{
  // a request that fails outright still cost its round trips
  const before = usage().calls;
  await assert.rejects(() => ask("s", one, flaky([429, 429, 429, 429, 429]).transport), /mnjev 429/);
  assert.equal(usage().calls - before, 4);
}
delete process.env.TYPESAFE_API_KEY;

// --- completion is driven by the command table, so it can never drift from it ---
import { completer, mentioned } from "./src/repl.ts";
assert.deepEqual(completer("/lo"), [["/load"], "/lo"]);
assert.deepEqual(completer("/c"), [["/clear", "/cost"], "/c"]);
// an unknown slash command offers the whole list rather than nothing
assert.ok(completer("/zzz")[0].includes("/help"));
// /quit is hidden, so it is dispatchable but never suggested
assert.ok(!completer("/")[0].includes("/quit"));
// a plain question is not a completion target
assert.deepEqual(completer("can penguins swim?"), [[], "can penguins swim?"]);
// paths complete after /load and after an @
assert.ok(completer("/load test")[0].some((p) => p.startsWith("test")));
assert.ok(completer("is @test")[0].some((p) => p.startsWith("test")));

// --- @file pulls a real file in, and anything else is left alone ---
// an address is not a mention: the @ has to start a word
assert.deepEqual(mentioned("mail me at bob@example.com"), { blocks: [], missing: [] });
// a path that cannot be read is reported, never silently dropped
assert.deepEqual(mentioned("is @nope.txt broken?").missing, ["nope.txt"]);
{
  const pulled = mentioned("does @test.ts check retries?");
  assert.equal(pulled.blocks.length, 1);
  assert.equal(pulled.missing.length, 0);
  assert.match(pulled.blocks[0], /^--- test\.ts ---\n/);
}
// trailing punctuation belongs to the sentence, not to the filename
{
  const pulled = mentioned("what about @test.ts?");
  assert.equal(pulled.blocks.length, 1, "the ? was treated as part of the path");
  assert.equal(pulled.missing.length, 0);
}

// --- truncate cuts by printable width and never splits a colour code ---
import { box as uiBox, truncate } from "./src/ui.ts";
{
  const bare = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const painted = `\x1b[36mabcdefghij\x1b[0m`;
  // colour costs no width, so ten printable characters still fit a width of ten
  assert.equal(truncate(painted, 10), painted);
  // narrower, and it is cut to fit with the ellipsis inside the width
  for (const w of [1, 2, 5, 9]) {
    const cut = bare(truncate(painted, w));
    assert.ok(cut.length <= w, `width ${w} produced ${cut.length} chars`);
    assert.ok(cut.endsWith("\u2026"), `width ${w} lost the ellipsis`);
  }
  assert.equal(bare(truncate(painted, 5)), "abcd\u2026");
  // a half-written escape would swallow whatever the terminal prints next
  assert.ok(!/\x1b(\[[0-9;]*)?$/.test(truncate(painted, 5)), "cut ends mid-escape");
  assert.ok(truncate(painted, 5).startsWith("\x1b[36m"), "the colour code was dropped");
  // a CJK character takes two columns, so half as many fit
  assert.equal(truncate("\u65e5\u672c\u8a9e\u3067\u3059", 4), "\u65e5\u2026");
  // three CJK characters fill the same six columns as six letters, so the box pads them
  // identically. Counting them as three would leave the right border three columns in.
  const pad = (l: string) => uiBox([l]).split("\n")[1].match(/ *\u2502$/)![0].length;
  assert.equal(pad("\u65e5\u672c\u8a9e"), pad("abcdef"));
  // and the box still lines up around one
  const line = uiBox([`\x1b[36mabcdefghijklmnopqrstuvwxyz\x1b[0m`]).split("\n")[1];
  assert.ok(!/\x1b(\[[0-9;]*)?$/.test(line), "box row ends mid-escape");
}

// --- /run must keep the failure, which is the whole point of running a broken suite ---
import { launch } from "./src/repl.ts";
{
  const r = await launch(`echo "running tests"; echo "FAIL: auth.test.js line 42" >&2; exit 2`);
  assert.equal(r.code, 2);
  // keeping only stdout dropped the one line worth asking Jev about
  assert.match(r.out, /running tests/);
  assert.match(r.out, /FAIL: auth\.test\.js line 42/);
}
{
  // a command that only writes to stderr is still captured
  const r = await launch(`echo "just a warning" >&2`);
  assert.equal(r.code, 0);
  assert.match(r.out, /just a warning/);
}
{
  // nothing is piped in, so a command reading stdin sees EOF instead of hanging
  const r = await launch("cat");
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
}
{
  // a missing program reports through the shell's 127 rather than throwing
  const r = await launch("definitely-not-a-real-command-xyz");
  assert.equal(r.code, 127);
}

// --- a retry backoff must be interruptible, not dead for up to a minute ---
process.env.TYPESAFE_API_KEY = "test-key-for-transport-checks";
{
  const ac = new AbortController();
  const slow: Transport = async () => reply(429, "{}", "60");
  const started = Date.now();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(() => ask("s", one, slow, ac.signal), /Cancelled/);
  assert.ok(Date.now() - started < 3_000, "ctrl-c waited out the whole Retry-After");
}
delete process.env.TYPESAFE_API_KEY;

// --- verdicts: one calculation behind render, map, and --exit-code ---
import { verdictCode, verdictText } from "./src/jev.ts";
assert.equal(verdictText({ type: "noul", noul: 0.99 }), "yes");
assert.equal(verdictText({ type: "noul", noul: 0.01 }), "no");
assert.equal(verdictText({ type: "choice", choice: "billing", confidence: 1, probabilities: {} }), "billing");
assert.equal(verdictText({ type: "score", score: 3, confidence: 1, legend, probabilities: { "3": 1 } }), "furious");

// 0 yes, 2 no, 3 cannot say. 1 stays reserved for a command that failed.
assert.equal(verdictCode({ type: "noul", noul: 0.99 }), 0);
assert.equal(verdictCode({ type: "noul", noul: 0.01 }), 2);
// a noul is measured outward from 0.5, so 0.83 is not settled at the default floor
assert.equal(verdictCode({ type: "noul", noul: 0.83 }), 3);
assert.equal(verdictCode({ type: "noul", noul: 0.5 }), 3);
assert.equal(verdictCode({ type: "choice", choice: "billing", confidence: 0.95, probabilities: {} }), 0);
assert.equal(verdictCode({ type: "choice", choice: "billing", confidence: 0.4, probabilities: {} }), 3);
// a confident choice never reports "no": only a noul has one
assert.notEqual(verdictCode({ type: "choice", choice: "no", confidence: 0.99, probabilities: {} }), 2);
// a confident "none of these fit" is not something to act on, so it must not exit 0
assert.equal(verdictCode({ type: "choice", choice: NONE, confidence: 0.99, probabilities: {} }), 3);

// --- the answer marker is part of the grammar, not decoration ---
assert.match(renderRich({ type: "noul", noul: 0.99 }), /●/);
assert.doesNotThrow(() => renderRich({ type: "score", score: 1, confidence: 0.9, legend, probabilities: {} }));

// --- a box pads to a fixed width whatever colour codes are inside it ---
import { box, cyan as paintCyan } from "./src/ui.ts";
{
  const bare = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const plain = box(["abc"]).split("\n").map(bare);
  const painted = box([paintCyan("abc")]).split("\n").map(bare);
  assert.equal(plain[1].length, painted[1].length, "colour must not change the padding");
  assert.equal(plain[0].length, plain[1].length, "border and body must line up");
  assert.equal(plain[1], "\u2502 abc" + " ".repeat(plain[1].length - 6) + "\u2502");
}

// Last line on purpose: anything added below this would not be covered by it.
console.log("all checks passed");
