# listen-fire-bpmn

Draws a listen-fire program (a `.mvt` file) as a BPMN 2.0 diagram: the
workflow notation that Camunda, Pega and Appian use, and that auditors read.

- The output opens in any BPMN viewer (bpmn.io, Camunda Modeler) already
  drawn: the file carries its layout (BPMN DI), not just its semantics.
- It is a one-way rendering for people to read. It is not meant to run in a
  BPMN engine, and it cannot be turned back into a program.
- It needs only the parser (`@listen-fire/movement-lang`). It does not check
  the program, read a catalog, or use credentials, so a program that parses
  but would not pass `listen-fire check` still draws.

## Use

Node 22.23.4 or later 22.x.

```sh
npm install
npm run build
node dist/cli.js program.mvt                         # BPMN XML on stdout
node dist/cli.js program.mvt -o program.bpmn         # or to a file
```

- A file that does not parse exits 1 with the parser's message.
- Anything drawn as "Unmapped", or not drawn, is reported on stderr as a
  warning; the exit code stays 0.

Rendered examples are in [`examples/`](examples/). They are the test
snapshots, so they always match the current renderer (`npm run examples`
rewrites them).

## What it draws

One pool per function that a `listen` fires, plus one per function those
call. Below them, one black-box pool per connected system, with message flows
from every step that reads or writes it: the "what can it touch" view. A
system that is connected but never used still gets a pool, marked unused.

| listen-fire | BPMN |
| --- | --- |
| `listen to cron { schedule }` | timer start event; the cron string is the `timeCycle` |
| `listen to <manual instance>` | plain start event |
| `listen to <system>` | message start event, with a message flow from the system's pool |
| several listens on one function | several start events, merged by a gateway |
| a read of a connected system (`chat-[ch:Channels WHERE …]->`) | service task "Read Slack Channels"; the statement is its documentation |
| `write` | service task "Write …" or "Update …" |
| `write` along a message edge (`Messages`, `Email`, …) | send task "Post to Slack channel", "Send Gmail message" |
| `write asks-[:Check]-> { Prompt: … }` | user task "Ask: …", with a message flow to the Asks pool |
| `match`, `link`, `unlink`, `delete`, `refresh` | service tasks "Find", "Link", "Unlink", "Delete", "Re-read" |
| `extract(…)`, `extractOne(…)`, `extract … from …`, `ai(…)` | service task named "… (AI)", `implementation="urn:listen-fire:ai"`; tier and output in the documentation |
| a traversal block `x-[…]-> { … }` | expanded subprocess, sequential multi-instance |
| `map(xs, f, { concurrency, onError })` (and `filter`, `reduce` …) with a body that does something | expanded subprocess, multi-instance; parallel only when `concurrency` is above 1 |
| `if` / `else if` / `else` | exclusive gateway with conditions; a merge gateway when two or more paths carry on |
| `return` | end event (of the subprocess, when inside a block or `map`) |
| `fail("…")` | error end event |
| `await first(x-[:Edge]->)` | message intermediate catch event ("Wait for approve to be called", "Wait for answer: …") |
| `await sleep(1d)` | timer intermediate catch event, ISO 8601 duration ("Wait 1 day") |
| `await until(cond, { every })` | conditional intermediate catch event |
| `race(…)` whose arms are each one wait | event-based gateway, each arm's result on its flow |
| any other `race(…)` | subprocess: a parallel split, each arm ending in a terminate end event |
| `all(f, g)` | parallel split and join |
| `callback(…)` | non-interrupting event subprocess with a message start event (a callback never ends the run); "fires at most once" in its documentation unless `once: false` |
| a call to a function declared in the file | call activity, and that function's own pool |
| a call to a plugin | service task "Run plugin …" |
| expressions and plain assignments | no node: folded into the documentation of the step that uses them ("where category = …") |

Anything else is drawn as a task named "Unmapped: <what it is>" and warned
about on stderr; nothing is dropped silently.

## What is lossy

- **Queries become text.** BPMN has no model of a query over a system. The
  traversal, with its `WHERE`, is in the task's documentation.
- **Types are dropped.** So are the checker's guarantees; the program is the
  authority.
- **Ties in a race.** listen-fire lands every arm that settles in the same
  moment; BPMN's first-to-finish takes one.
- **Concurrency limits** on `map` and `all` are noted in the name and the
  documentation; BPMN cannot express them.
- **`onError: "warn"`** is noted in the name ("failures skipped") rather than
  drawn as an error boundary event.
- **Reads inside an `until` condition** are named in the event's
  documentation, not drawn as message flows (BPMN tools only accept message
  flows into message events).
- **Message flows run straight down** from a step to its system's pool, so they
  cross whatever lies below the step, other pools included.
- A function body written inside an expression (`[x, ...map(xs, (p) => { … })]`)
  is drawn as "Unmapped".

## Why it lays out its own diagram

The control flow is structured (no loops but collections, no jumps), so every
piece of the diagram knows its own size: sequences run left to right, branches
stack downwards, subprocesses wrap their contents. `bpmn-auto-layout` would
lay out only the first pool, collapse every subprocess, and leave message
flows undrawn, which loses the connected-systems view.

## Develop

```sh
npm test                 # renders test/fixtures/*.mvt and checks each output
npm run code:type-check
```

Each fixture's output is read back through bpmn-moddle's `fromXML` and must
have no warnings, no node without its sequence flows, a shape for every
element, and no overlapping shapes.
