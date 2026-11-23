# @listen-fire/bpmn

Draws a listen-fire program as a BPMN 2.0 diagram: the workflow notation
that Camunda, Pega and Appian use, and that auditors read.

- It draws only a program that checks. The picture comes from the same
  check that lets the program run, so the two cannot disagree.
- Every label comes from the program. Nothing is summarised or invented.
- The output opens in any BPMN viewer (bpmn.io, Camunda Modeler) already
  drawn: the file carries its layout (BPMN DI) and its colours (BPMN in
  Color).
- It is a one-way picture for people. It does not run in a BPMN engine, and
  it cannot be turned back into a program.

This release line, 0.16, reads programs pinned to listen-fire 0.16.

## Use

Node 22.23.4 or later 22.x.

### From code

```ts
import { initParser, storyAnalysisInRust } from '@listen-fire/movement-lang';
import { renderProgram } from '@listen-fire/bpmn';

await initParser();
const analysis = storyAnalysisInRust(source, catalogSnapshot, { languageVersion: pin });
const rendering = await renderProgram(source, { analysis, languageVersion: pin, vocabulary });
if (rendering.ok) show(rendering.xml);
else report(rendering.diagnostics);
```

- `analysis` is the checker's story analysis of the source.
- `languageVersion` is the pin the program is saved with. A pin of another
  compatibility key is refused by name, as a diagnostic.
- `vocabulary` names each connected system, keyed by its adapter:
  `{ attio: { name: 'Attio', icon: 'https://…/attio.svg' } }`. Without it,
  the first-party modules' names are used. A system with no words is named
  by its adapter.
  An entry may also carry `eventPhrase`, the module's own wording from its
  manifest's `vocabulary.eventPhrase`
  (`{ default: [{ template: 'When an email arrives' }] }`). A listen on that
  system then starts with that sentence instead of "On Email Emails". The
  first template whose every `{slot}` has a value wins, as on the hosted
  platform. A path listen's WHERE fills no slot; only an `address` the host
  puts in the entry does. If no template renders, the label is the derived one.
- A program whose check has an error gets `{ ok: false, diagnostics }`, and
  no diagram.

### From the command line

```sh
npm install && npm run build
listen-fire catalog --json > catalog.json        # in the program's project folder
node dist/cli.js program.mvt --catalog catalog.json --pin 0.16.1 > program.bpmn
node dist/cli.js program.mvt --catalog catalog.json --pin 0.16.1 --vocabulary words.json -o program.bpmn
```

- `--catalog` is required: without the catalog there is no check, so
  nothing is drawn. The CLI says how to make one.
- `--pin` is required: it is `engine:` in the project's `lf.yaml`.
- A program that does not check exits 1 with its diagnostics.
- Anything drawn as "Unmapped", or not drawn, is a warning on stderr.

### In a page, with bpmn-js

```ts
import { styleDiagram } from '@listen-fire/bpmn/viewer';
import '@listen-fire/bpmn/viewer.css';

await viewer.importXML(xml);
styleDiagram(viewer);
```

- `styleDiagram` adds the AI badge, each system's icon, and a chip behind
  each blank and each result name.
- Light shows the file's own colours. For dark, add the class `lf-dark` to
  the element given to bpmn-js, or to any ancestor of it.
- The bpmn.io watermark is never hidden.

## The rules

- **Only a checked program is drawn.** The check's diagnostics come back
  instead when any is an error.
- **Systems come from the check.** Each `connect` is a system, with its own
  pool below the program's. Which step reads or writes which system is the
  checker's answer, not the renderer's guess.
- **Each step names its result.** A read, an AI step, a write, a wait or a
  start that the program binds to a name draws it on its own line:
  "Read Attio People → person", "On Email Emails → e".
- **Conditions stay as written, with one fixed rule.** `x == null` is drawn
  "no x", and `x != null` "x found". The condition expression in the file
  keeps the program's own text.
- **A message keeps its author's words.** Each `${…}` in a failure message
  or an ask's prompt is drawn as a marked blank: ‹email›.
- **Each message flow says what it carries:** "reads People", "writes
  Messages".
- **The kind of step is its colour:**

  | Kind of step | Look |
  | --- | --- |
  | AI step | purple, with an "AI" badge |
  | read | blue |
  | write | green |
  | decision | amber |
  | failure | red |
  | system | grey pool |

## What it draws

One pool per function a listen fires, and one per function those call.
Below them, one pool per connected system, with message flows from every
step that reads or writes it. A connected system that no step uses still
gets a pool, marked unused.

| listen-fire | BPMN |
| --- | --- |
| `listen to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1"]->` | timer start event; the schedule is its `timeCycle` |
| `listen to manual-[:Invocations]->` | plain start event, "Started manually" |
| `listen to <system>-[…]->` | message start event, with a message flow from the system's pool |
| several listens on one function | several start events, merged by a gateway |
| a read of a connected system | service task "Read Slack Channels" |
| `write` | service task "Write …", or "Update …" for a write to a record the run holds |
| `write` to `@lf/ask` | user task "Ask: …" |
| `match`, `link`, `unlink`, `delete`, `refresh` | service tasks "Find", "Link", "Unlink", "Delete", "Refresh" |
| `extract(…)`, `extractOne(…)`, `ai(…)` | service task "Extract … (AI)" or "AI: …", `implementation="urn:listen-fire:ai"` |
| a traversal block `x-[…]-> { … }` | expanded subprocess, sequential multi-instance |
| `map(xs, f, { concurrency, onError })` and its kin, with a body that does something | expanded subprocess, multi-instance; parallel only when `concurrency` is above 1 |
| `if` / `else if` / `else` | exclusive gateway with conditions; a merge gateway when two or more paths carry on |
| `return` | end event (of the subprocess, inside a block or `map`) |
| `fail("…")` | error end event |
| `await x-[:Edge]->` | message intermediate catch event, "Wait for Edge on x" |
| `await sleep(1d)` | timer intermediate catch event, ISO 8601 duration, "Wait 1 day" |
| `await until(cond, { every })` | conditional intermediate catch event |
| `race(…)` whose arms are each one wait | event-based gateway, each arm's result on its flow |
| any other `race(…)` | subprocess: a parallel split, each arm ending in a terminate end event |
| `all(f, g)` | parallel split and join |
| a call to a function declared in the file | call activity, and that function's own pool |
| a call to a plugin | service task "Run plugin …" |
| expressions and plain assignments | no node: folded into the documentation of the step that uses them |

Anything else is drawn as a task named "Unmapped: <what it is>" and warned
about; nothing is dropped silently.

## What is lossy

- **Queries become text.** BPMN has no model of a query. The walk, with its
  `WHERE`, is in the task's documentation.
- **Types are dropped.** The program is the authority.
- **Ties in a race.** listen-fire lands every arm that settles in the same
  moment; BPMN's first to finish takes one.
- **Concurrency limits** on `map` and `all` are in the name and the
  documentation; BPMN cannot express them.
- **Reads inside an `until` condition** are named in the event's
  documentation, not drawn as message flows.
- **Message flows cross the pools between a step and its system.**

## Develop

```sh
npm test                 # renders test/fixtures/*.mvt and checks each output
npm run code:type-check
npm run review           # PNGs of every fixture, light and dark, in review/
```

- Each fixture's output is read back through bpmn-moddle and must have no
  warnings, no node without its sequence flows, a shape for every element,
  no overlapping shapes and no label over a shape or another label.
- The outputs are the examples in [`examples/`](examples/) (`npm run
  examples` rewrites them).
- Each fixture checks against a catalog snapshot in
  `test/fixtures/catalogs/`: the handbook's captured catalog, or
  `project.json`, which `scripts/project-catalog.sh` writes with
  `listen-fire catalog --json` and no live credentials.
