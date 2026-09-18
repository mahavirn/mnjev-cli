# mnjev-cli

Ask [TypeSafe's Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) a
question from your terminal and get a decision back, with the probability of every option.

> Unofficial. Not affiliated with, endorsed by, or supported by TypeSafe AI. "TypeSafe"
> and "Jev" are their names, not mine. The package name is prefixed to keep it clearly
> out of their namespace. You bring your own API key.

The package is `mnjev-cli`; the command it installs is `mnjev`.

Jev is a System One model. It does not write text. You give it some state and a question
whose possible answers are fixed in advance, and it returns one of those answers with a
calibrated probability. So this is not a chatbot, it is a decision tool.

```
› /run git --version
  captured 35 chars from git --version
› is this about version control?
  yes  99%
    yes  ████████████████████  99%
    no   ░░░░░░░░░░░░░░░░░░░░   1%
  1941ms
```

## Install

Needs **Node 22.18 or newer**. No dependencies and no build step.

```bash
node --version           # must be v22.18+
npm install -g mnjev-cli
mnjev --help
```

Developed and tested on macOS, against Node 22.18 and 24.19. Nothing in it is
macOS-specific and the Windows code paths are handled, but it has not been run on Windows
or Linux.

### From a checkout

```bash
git clone https://github.com/mahavirn/mnjev-cli.git
cd mnjev-cli
npm link                 # puts `mnjev` on your PATH, running src/ directly
npm unlink -g mnjev-cli    # to remove it later
```

Or skip linking entirely: `node bin/mnjev.mjs --help`.

## Log in

Get a key from [console.typesafe.ai](https://console.typesafe.ai), then:

```bash
mnjev login
```

That writes `~/.mnjev/config.json` with mode `0600`, outside your project so it cannot be
committed by accident. **Windows ignores file permissions**, so `mnjev login` warns there
and you should restrict the file yourself or use `TYPESAFE_API_KEY` instead.

`TYPESAFE_API_KEY` overrides the file, which is what you want in CI.

## Use it

Run `mnjev` with no arguments for the interactive interface, or pipe state in for one shot.

### Just ask

**Jev decides what kind of question you asked.** You never name a type:

```
is this a database problem?                              -> yes/no
which team should own this? billing, support, or infra   -> pick one
which fruit is yellow? A. Apple B. Banana C. Grape       -> pick one
email vs chat                                            -> pick one
how urgent is this? low|medium|critical                  -> a level
how angry is this customer?                              -> a level
```

**Jev finds your options too.** Code does not decide where they are. It shotguns every
plausible span of your sentence, deliberately far too many, and Jev picks which ones are
real. This is the pattern TypeSafe documents: *"a regex finds the candidate values in the
text. Tune it to over-find. TypeSafe picks which candidate the question is asking for."*

That matters on real sentences. Rules that try to find options precisely score 4/10 on
longer inputs. Over-finding and letting Jev choose scores 12/12:

```
coffee or tea in the morning                  -> ["coffee", "tea"]
...should we use email or chat                -> ["email", "chat"]
is this a bug in our code or a problem with the upstream API
                                              -> ["a bug in our code",
                                                  "a problem with the upstream API"]
```

The one thing Jev cannot do is **invent levels**. A rating with no levels named, like
`how angry is this customer?`, gets a generic `not at all → extremely` scale.

To override what Jev decided, state it outright. A `|` list, or a leading `choice` or
`score`, is taken as given:

```
choice which team? billing, technical
score  how urgent? low|medium|critical
```

### Load state

State is what Jev reads. Load it when the question is about your own code or data.

| Command | What it does |
|---|---|
| `/set <text>` | type the state in directly |
| `/load <file>` | use a file as state |
| `/run <command>` | use a command's output as state |
| `/state` | show what is loaded |
| `/clear` | drop the state |
| `/help` `/exit` | |

`/run` keeps the output of a command that fails, so `/run npm test` on a broken suite
loads the failure for you to ask about.

### Ask several questions at once

Jev answers questions in parallel, so separate them with `;` and pay for one call:

```
› is this a bug fix?; how risky is it? low|medium|high
  is this a bug fix?
  no  57%
    yes  █████████░░░░░░░░░░░  43%
    no   ███████████░░░░░░░░░  57%
  unsure - 50% means it has no idea
  how risky is it? low|medium|high
  medium  0.63 of 0-2, confidence 33%
    low     ████████░░░░░░░░░░░░  41%
    medium  ███████████░░░░░░░░░  55%
    high    █░░░░░░░░░░░░░░░░░░░   4%
  unsure - the levels overlap, try fewer or clearer ones
  1206ms
```

TypeSafe measured batching at *"12.2x cheaper and 10.0x faster with no change in
answers"*, so five questions cost roughly what one costs.

### One shot

State comes from stdin, so it pipes like any other unix tool. Output stays one plain
greppable line when piped:

```bash
cat err.log    | mnjev noul   "is this a database problem?"
cat ticket.txt | mnjev choice "which team?" "billing=payments,technical=bugs"
cat review.txt | mnjev score  "how angry is this person?" "calm|annoyed|furious"
```

Add `--json` for the raw API response. `mnjev --help` exits 0; an unknown command exits 1,
so scripts can tell a typo from an answer.

### Say what you are comparing on

A bare comparison names no criterion, so there is nothing for Jev to decide:

```
› email or chat
  chat  confidence 4%
    chat   ██████████░░░░░░░░░░  52%
    email  ██████████░░░░░░░░░░  48%
  say what you are comparing on:  which is better for X? email or chat

› which leaves a written record that is easy to search later? email or chat
  email  confidence 98%

› which is better for reaching someone within a minute? email or chat
  chat  confidence 100%
```

Same two options, same model, opposite answers. The criterion is the question; without
one there is nothing to decide. Putting the question before the `?` also keeps shared
context out of your options.

### Jev has no clock and cannot see your machine

It judges the state you give it:

```
› /run date
› is this year 2027?
  no  100%
```

It does know things, though, so plenty of questions need no state at all:

```
can penguins swim?         yes  97%
can penguins fly?          no   97%
is 7 a prime number?       yes  98%
is my build passing?       no   52%   <- unsure, and rightly so
is it raining right now?   no   73%   <- unsure, and rightly so
```

Everything you type goes to Jev. Nothing is intercepted and nothing is refused. Questions
it cannot answer land near 50% and are flagged, which is a better guard than declining to
ask.

## The three question types

| Type | Question | Returns |
|---|---|---|
| `noul` | is this true? | one number, 0 to 1 |
| `choice` | which of these? | one of your options, plus confidence and full probabilities |
| `score` | which level? | a position on your scale, which can land between two levels |

For `choice`, `a,b,c` is enough. Use `a=what a means,b=what b means` when the names alone
are not clear.

## Read the confidence

This is the part that matters.

**Jev must return one of the options it was given.** When the real answer is not among
them, you get a wrong answer with low confidence. The confidence is the only signal:

```
Sydney     confidence 0.41     <- correct answer was missing from the list
Canberra   confidence 1.00     <- correct answer present
```

Same question, same model. Only the confidence told the truth.

Every probability Jev returns is shown, on every call:

```
  coffee  confidence 96%
    coffee  ████████████████████  98%
    tea     ░░░░░░░░░░░░░░░░░░░░   2%
```

A choice is ranked by probability. A score keeps its scale order, because for a score the
order is the meaning. Answers below `0.7` turn yellow and are marked `unsure`; confident
ones are green and stay out of your way. Colour is off automatically when output is piped,
when `NO_COLOR` is set, or on a dumb terminal.

A `noul` is measured outward from `0.5`, since `0.5` means no idea and both `0.99` and
`0.01` are confident. At the default floor a noul needs to be above `0.85` or below `0.15`.

### Letting Jev decline

Your options go to Jev exactly as typed. `JEV_ESCAPE=1` adds a `none of these` option so
it can reject the whole list. Asking *"which city is the capital of Australia?"*:

| options given | without escape hatch | with it |
|---|---|---|
| Sydney, Melbourne, **Canberra** | `Canberra` 1.00 (right) | `Canberra` 1.00 (right) |
| Sydney, Melbourne, Perth | `Sydney` 0.41 (wrong) | `none of these` 0.99 (right) |

On a clear-cut question it is free, and it rescues the case where the real answer is
missing. **On an ambiguous question it can steal the answer:** asked which of three
fruits is red, with a defensible answer present, one measured pair went from `0.71` right
to `0.27` on `none of these`.

So it is off by default. Turn it on when your option lists may genuinely not cover the
case, such as routing against a fixed set of teams.

## Speed and cost

`$0.042` per million input tokens, output free. TypeSafe quotes 70 to 500 ms of model
time. Measured end to end from a terminal, including network:

| | first question of a session | after that |
|---|---|---|
| a line naming no alternatives (`can penguins swim?`) | ~1200ms | **~330ms** |
| a line naming alternatives (`email vs chat`) | ~1900ms | **~730ms** |

A line that names alternatives costs two calls, because the options have to be found
before they can define the question that follows them.

The first question of a session pays a TCP and TLS handshake, about 600ms. After that the
connection is held open, so idle time between questions costs nothing. Node's own `fetch`
drops its socket after four seconds of idle, which is shorter than the time it takes to
type a question, so this tool uses a keep-alive agent instead. Without it every question
paid the handshake again.

## Settings

Read once at startup. A value that does not parse prints a warning and falls back, so a
typo cannot silently switch a safety feature off.

| variable | default | meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | from `~/.mnjev/config.json` | your API key |
| `JEV_CONFIDENCE` | `0.7` | below this an answer is flagged unsure; must be 0 to 1 |
| `JEV_ESCAPE` | `0` | add a "none of these" option; `1`/`true`/`yes`/`on` to enable |
| `JEV_TIMEOUT_MS` | `30000` | give up on a request after this long; 1000 to 600000 |
| `JEV_RETRIES` | `3` | retries after a rate limit or gateway error; 0 to 10 |
| `JEV_RETRY_BASE_MS` | `500` | first backoff delay; each retry doubles it |
| `NO_COLOR` | unset | any value turns colour off |

A `429`, `529`, or `502`/`503`/`504` is retried with doubling backoff and jitter,
honouring the server's `Retry-After` header. A `401` is not retried, because a wrong key
stays wrong. A timeout is not retried either, because waiting longer for something already
slow rarely helps.

## What Jev is bad at

From TypeSafe's own [known issues](https://docs.typesafe.ai/model-jaggedness/jev-1.13):

- **Counting and maths.** It cannot count reliably. Compute it in code and pass the result.
- **Dates.** It reads dates as text, not as ordered values. Compare dates yourself.
- **Literal reading.** It answers the question you wrote, not the one you meant.
- **Big irrelevant state.** Accuracy falls as unrelated content grows. This is why `/run`
  exists: send the 20 lines that matter, not the whole log. The REPL warns above 24,000
  characters.
- **Untrusted input.** It does not treat state as hostile. Text inside your state can
  steer the answer, so do not pipe in content you would not trust.

## Develop

```bash
npm test       # plain assert, no framework, no fixtures
npm run build  # strips types from src/ into lib/
```

```
bin/mnjev.mjs    entry point; checks the Node version, then loads the CLI
src/config.ts    every tunable and env var, with validating parsers
src/jev.ts       transport, retries, question building, the confidence gate
src/parse.ts     generates candidate spans; decides nothing
src/classify.ts  asks Jev to find the options and pick the question type
src/repl.ts      the interactive interface
src/ui.ts        colour, bars, spinner
src/cli.ts       one-shot flags and login
```

Node will not strip types from files under `node_modules`, so the published package ships
plain JavaScript in `lib/`. `npm run build` produces it with Node's own type stripper,
which is why there are still no dependencies. It runs automatically on `npm pack` and
`npm publish`.

## Not built yet

- **MCP support.** An MCP tool's arguments are open sets and Jev needs closed ones. The
  option finder here is the piece that was missing, so this is now mostly plumbing.
- **OpenRouter key support.** Jev is not in OpenRouter's public model index and its
  request shape is not OpenAI-compatible, so going through it would mean a text model
  imitating a calibrated probability, which defeats the point.
- **Pinned model version.** Requests use `jev-latest`, so behaviour can change when
  TypeSafe ships a new model.

## Licence

MIT. See [LICENSE](LICENSE).
