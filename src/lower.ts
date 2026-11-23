// The mapping: a checked program to the diagram's tree (flow.ts). One process
// per function a `listen` fires, plus one per function those call. The parse
// tree gives the order and nesting of statements and the text of conditions;
// the story analysis gives which system each step reads or writes, what each
// listen and wait is on, and which calls are calls of functions.
// Expressions and plain assignments fold into the steps that use them.

import {
  constructionAsCall,
  treeOfSlot,
  writtenArms,
  type ArmExpression,
  type AwaitExpression,
  type CallStatement,
  type ClosureExpression,
  type CollectionOpExpression,
  type CombinatorExpression,
  type ExprSlot,
  type Expression,
  type ExtractCallExpression,
  type ExtractExpression,
  type IfStatement,
  type LanguageVersion,
  type LinkExpression,
  type ListenDeclaration,
  type MatchExpression,
  type MovementDeclaration,
  type Program,
  type RValue,
  type Span,
  type Statement,
  type StoryWalk,
  type TraversalBlock,
  type WriteExpression,
} from '@listen-fire/movement-lang';

import { aliasesOf, edgesOf, type AnalysisIndex, type Read } from './analysis.js';
import { describeDuration, isoDuration } from './durations.js';
import { emptyFacts, factsOfSlot, mergeFacts, type ExpressionFacts } from './expressions.js';
import {
  flowEnds,
  unreachable,
  type Diagram,
  type EndStep,
  type Flow,
  type ProcessFlow,
  type Start,
  type Step,
  type System,
  type TaskStep,
  type Touch,
  type WaitStep,
} from './flow.js';
import { conditionLabel, joinWords, oneLine, shorten, templateLabel } from './labels.js';

/** What the diagram keeps about a name the analysis does not draw: a closure
 *  bound to it, or the assignment folded into the steps that read it. */
interface Binding {
  closure?: ClosureExpression;
  folded?: string;
}

interface ProgramIndex {
  source: string[];
  languageVersion: LanguageVersion;
  analysis: AnalysisIndex;
  functions: Map<string, MovementDeclaration>;
  fileScope: Map<string, Binding>;
  processIds: Map<string, string>;
  /** Functions reached by a call, still to be drawn. */
  calledQueue: string[];
  warnings: string[];
}

interface Context {
  index: ProgramIndex;
  scope: Map<string, Binding>;
  /** What `return` draws here: an end event, or a terminate end event in a
   *  race arm (the first arm to finish ends the race). */
  returns: 'none' | 'terminate';
}

const COLLECTION_OPS = new Set(['map', 'filter', 'reduce', 'groupby', 'keyby', 'sort']);

export interface LowerInput {
  program: Program;
  source: string;
  analysis: AnalysisIndex;
  languageVersion: LanguageVersion;
  /** The file's name, for the process documentation. */
  fileName?: string;
}

export function lowerProgram(input: LowerInput): Diagram {
  const index = indexProgram(input);
  const processes: ProcessFlow[] = [];
  const fired = new Map<string, Start[]>();
  for (const statement of input.program.statements) {
    if (statement.kind !== 'listen') continue;
    const fn = index.functions.get(statement.movement);
    if (fn === undefined) {
      index.warnings.push(`listen fires \`${statement.movement}\`, which is not declared in this file; not drawn`);
      continue;
    }
    fired.set(fn.name, [...(fired.get(fn.name) ?? []), startOf(statement, fn, index)]);
  }
  for (const [name, starts] of fired) {
    const fn = index.functions.get(name);
    if (fn !== undefined) processes.push(lowerFunction(fn, starts, index, input.fileName));
  }
  const drawn = new Set(fired.keys());
  for (let name = index.calledQueue.shift(); name !== undefined; name = index.calledQueue.shift()) {
    const fn = index.functions.get(name);
    if (fn === undefined || drawn.has(fn.name)) continue;
    drawn.add(fn.name);
    const start: Start = { kind: 'none', name: 'Called', doc: ['Started by a call from another function.'] };
    processes.push(lowerFunction(fn, [start], index, input.fileName));
  }
  for (const name of index.functions.keys()) {
    if (!drawn.has(name)) index.warnings.push(`function \`${name}\` is neither fired by a listen nor called; not drawn`);
  }
  return { processes, systems: input.analysis.systems, warnings: index.warnings };
}

function indexProgram(input: LowerInput): ProgramIndex {
  const index: ProgramIndex = {
    source: input.source.split('\n'),
    languageVersion: input.languageVersion,
    analysis: input.analysis,
    functions: new Map(),
    fileScope: new Map(),
    processIds: new Map(),
    calledQueue: [],
    warnings: [],
  };
  for (const statement of input.program.statements) {
    if (statement.kind === 'movement') {
      index.functions.set(statement.name, statement);
      index.processIds.set(statement.name, `Process_${slug(statement.name)}`);
    } else if (statement.kind === 'assign' && statement.value.kind === 'closure') {
      index.fileScope.set(statement.name, { closure: statement.value.closure });
    } else if (statement.kind === 'assign' && statement.value.kind !== 'construct') {
      index.fileScope.set(statement.name, { folded: sourceOf(index, statement.span) });
    }
  }
  return index;
}

// ── Starts ──

function startOf(listen: ListenDeclaration, fn: MovementDeclaration, index: ProgramIndex): Start {
  if (listen.path === undefined) {
    throw new Error(`line ${listen.span.start.line}: a settings listen reached the renderer; the checker refuses it from 0.13`);
  }
  const node = index.analysis.node('listen', listen.span);
  const walk = index.analysis.walkAt(listen.path.span);
  const edges = walk === undefined ? [] : edgesOf(walk.steps);
  const result = fn.params[0]?.name;
  const doc = [sourceOf(index, listen.span), ...(listen.alias === undefined ? [] : [`Listen lane: ${listen.alias}`])];
  switch (node?.adapterType) {
    case 'cron': {
      const schedule = scheduleOf(walk?.steps[0]);
      const zone = schedule.zone === undefined ? '' : ` (${schedule.zone})`;
      const name = schedule.cycle === undefined ? 'On schedule' : `On schedule ${schedule.cycle}${zone}`;
      return { kind: 'timer', name, result, doc, ...(schedule.cycle === undefined ? {} : { cycle: schedule.cycle }) };
    }
    case 'manual':
      return { kind: 'none', name: 'Started manually', result, doc };
    default: {
      const system = index.analysis.system(listen.instance);
      const what = edges.join(' › ');
      const where = system?.display ?? listen.instance;
      const touch: Touch | undefined = system === undefined ? undefined : { system, direction: 'read', what };
      return { kind: 'message', name: system?.startPhrase ?? `On ${where} ${what}`, result, message: `${where} ${what}`, doc, ...(touch === undefined ? {} : { touch }) };
    }
  }
}

/** A cron listen's schedule and zone, read from its hop's WHERE
 *  (`cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1"]->`): each is an equality
 *  of the hop's field to a literal, alone or among others joined by `and`. */
function scheduleOf(step: StoryWalk['steps'][number] | undefined): { cycle?: string; zone?: string } {
  if (step?.type !== 'edge' || step.expressionFilter === undefined) return {};
  const equalities = new Map<string, string>();
  const visit = (expr: Expression): void => {
    if (expr.type === 'logical' && expr.op === 'and') expr.operands.forEach(visit);
    if (expr.type !== 'compare' || expr.op !== 'eq') return;
    equality(expr.left, expr.right);
    equality(expr.right, expr.left);
  };
  const equality = (field: Expression, value: Expression): void => {
    if ((field.type === 'edge_property' || field.type === 'property') && value.type === 'static' && typeof value.value === 'string') {
      equalities.set(field.propertyTypeId, value.value);
    }
  };
  visit(step.expressionFilter);
  const cycle = equalities.get('Schedule');
  const zone = equalities.get('Zone');
  return { ...(cycle === undefined ? {} : { cycle }), ...(zone === undefined ? {} : { zone }) };
}

function lowerFunction(fn: MovementDeclaration, starts: Start[], index: ProgramIndex, fileName: string | undefined): ProcessFlow {
  const ctx: Context = { index, scope: new Map(index.fileScope), returns: 'none' };
  const flow = closed(lowerBody(fn.body, ctx), 'Done');
  const touched = new Set<string>();
  collectSystems(flow, touched);
  for (const start of starts) if (start.kind === 'message' && start.touch !== undefined) touched.add(start.touch.system.display);
  const doc = [
    `Function \`${fn.name}\`${fileName === undefined ? '' : ` in ${fileName}`}, drawn by @listen-fire/bpmn from the checked program.`,
    touched.size > 0 ? `Connected systems it touches: ${[...touched].join(', ')}.` : 'It touches no connected system.',
    'Queries are carried as text, types are dropped, and expressions are folded into the steps that use them; the program is the authority.',
  ];
  return { id: index.processIds.get(fn.name) ?? `Process_${slug(fn.name)}`, name: fn.name, doc, starts, flow };
}

function collectSystems(flow: Flow, into: Set<string>): void {
  for (const step of flow) {
    switch (step.kind) {
      case 'task':
      case 'wait':
        for (const touch of step.touches) into.add(touch.system.display);
        break;
      case 'scope':
        for (const touch of step.touches) into.add(touch.system.display);
        collectSystems(step.flow, into);
        break;
      case 'choice':
        for (const arm of step.arms) collectSystems(arm.flow, into);
        if (step.otherwise !== undefined) collectSystems(step.otherwise, into);
        break;
      case 'all':
        for (const arm of step.arms) collectSystems(arm, into);
        break;
      case 'firstEvent':
        for (const arm of step.arms) for (const touch of arm.wait.touches) into.add(touch.system.display);
        break;
      case 'end':
        break;
      default:
        unreachable(step);
    }
  }
}

// ── Bodies and statements ──

function lowerBody(statements: Statement[], ctx: Context): Flow {
  const flow: Flow = [];
  for (const [position, statement] of statements.entries()) {
    if (flowEnds(flow)) {
      const rest = statements.slice(position).filter((s) => !isDeclaration(s));
      if (rest.length > 0) {
        ctx.index.warnings.push(`line ${statement.span.start.line}: ${rest.length} statement(s) after a path that always ends are unreachable; not drawn`);
      }
      break;
    }
    flow.push(...lowerStatement(statement, ctx));
  }
  return flow;
}

function isDeclaration(statement: Statement): boolean {
  return statement.kind === 'import' || statement.kind === 'shape' || statement.kind === 'type';
}

function lowerStatement(statement: Statement, ctx: Context): Step[] {
  switch (statement.kind) {
    case 'import':
    case 'shape':
    case 'type':
      return [];
    case 'movement':
    case 'listen':
      return [unmapped(`${statement.kind} inside a function`, statement.span, ctx)];
    case 'assign':
      return lowerValue(statement.value, statement.name, statement.span, ctx);
    case 'write':
      return lowerWrite(statement.write, undefined, ctx);
    case 'match':
      return lowerMatch(statement.match, undefined, ctx);
    case 'call':
      return lowerCall(statement, undefined, statement.span, ctx);
    case 'block':
      return lowerBlock(statement.block, undefined, ctx);
    case 'link':
      return lowerLink(statement.link, undefined, statement.span, ctx);
    case 'unlink':
      return [recordTask(ctx, statement.span, { verb: 'Unlink', name: statement.from, edge: statement.edge, direction: 'write' })];
    case 'delete':
      return [recordTask(ctx, statement.span, { verb: 'Delete', name: statement.name, direction: 'write' })];
    case 'refresh':
      return [recordTask(ctx, statement.span, { verb: 'Refresh', name: statement.name, direction: 'read' })];
    case 'if':
      return lowerIf(statement, ctx);
    case 'await':
      return lowerAwait(statement.await, undefined, ctx);
    case 'combinator':
      return lowerCombinator(statement.combinator, undefined, statement.span, ctx);
    case 'collection':
      return lowerCollection(statement.collection, undefined, statement.span, ctx);
    case 'return':
      return lowerReturn(statement.value, statement.span, ctx);
    case 'error': {
      const before = effectsOf([statement.message], ctx, {});
      const message = templateLabel(statement.message, ctx.index.languageVersion);
      const end: EndStep = { kind: 'end', end: 'error', name: `Fail: ${message}`, error: message, doc: [sourceOf(ctx.index, statement.span)] };
      return [...before, end];
    }
    default:
      return unreachable(statement);
  }
}

/** A right-hand side, bound to `binding` when there is one. */
function lowerValue(value: RValue, binding: string | undefined, span: Span, ctx: Context): Step[] {
  switch (value.kind) {
    case 'construct':
      return lowerCall(constructionAsCall(value.construct), binding, span, ctx);
    case 'call':
      return lowerCall(value.call, binding, span, ctx);
    case 'write':
      return lowerWrite(value.write, binding, ctx);
    case 'match':
      return lowerMatch(value.match, binding, ctx);
    case 'link':
      return lowerLink(value.link, binding, span, ctx);
    case 'extract':
      return lowerExtract(value.extract, binding, ctx);
    case 'extractCall':
      return lowerExtractCall(value.extractCall, binding, ctx);
    case 'block':
      return lowerBlock(value.block, binding, ctx);
    case 'await':
      return lowerAwait(value.await, binding, ctx);
    case 'combinator':
      return lowerCombinator(value.combinator, binding, span, ctx);
    case 'collection':
      return lowerCollection(value.collection, binding, span, ctx);
    case 'closure':
      if (binding !== undefined) ctx.scope.set(binding, { closure: value.closure });
      return [];
    case 'members':
    case 'node':
      fold(binding, span, ctx);
      return [];
    case 'inlineBlock':
      return [unmapped('inline block (a retired form)', span, ctx)];
    case 'callback':
      throw new Error(`line ${span.start.line}: callback(…) reached the renderer; the checker refuses it from 0.13`);
    case 'lazy':
      throw new Error(`line ${span.start.line}: lazy reached the renderer; the checker refuses it from 0.14`);
    case 'expr':
      return lowerExpression(value.expr, binding, span, ctx);
    default:
      return unreachable(value);
  }
}

function lowerExpression(slot: ExprSlot, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const steps = effectsOf([slot], ctx, { statement: sourceOf(ctx.index, span), result: binding });
  if (steps.length === 0) fold(binding, span, ctx);
  return steps;
}

function fold(binding: string | undefined, span: Span, ctx: Context): void {
  if (binding !== undefined) ctx.scope.set(binding, { folded: sourceOf(ctx.index, span) });
}

interface EffectOptions {
  /** The statement's source, for a step that IS the statement. */
  statement?: string;
  /** The name the statement binds: the last read or AI step produces it. */
  result?: string;
}

/** The steps evaluating `slots` draws: one read of the connected systems
 *  their walks reach, a model call per `ai(…)`, and an unmapped marker per
 *  function body written inside them. */
function effectsOf(slots: ExprSlot[], ctx: Context, options: EffectOptions): TaskStep[] {
  const facts = factsOfSlots(slots, ctx);
  const steps: TaskStep[] = [];
  const reads = ctx.index.analysis.readsWithin(slots.map((slot) => slot.span));
  if (reads.length > 0) {
    const doc = options.statement !== undefined ? [options.statement] : slots.map((slot) => oneLine(slot.raw));
    steps.push(readTask(reads, [...doc, ...usesOf(facts, ctx)]));
  }
  for (const prompt of facts.aiPrompts) {
    steps.push({
      kind: 'task',
      task: 'service',
      look: 'ai',
      name: `AI: ${shorten(prompt, 60)}`,
      doc: [`AI step: ${prompt}`, ...(options.statement === undefined ? [] : [options.statement])],
      touches: [],
    });
  }
  const producer = steps.at(-1);
  if (producer !== undefined && options.result !== undefined) producer.result = options.result;
  for (const closure of facts.blockClosures) {
    ctx.index.warnings.push(`a function body written inside an expression is not drawn: ${shorten(oneLine(closure), 80)}`);
    steps.push({ kind: 'task', task: 'unmapped', look: 'plain', name: 'Unmapped: function inside an expression', doc: [closure], touches: [] });
  }
  return steps;
}

/** One task reading every system `reads` reach: "Read Attio People". */
function readTask(reads: Read[], doc: string[]): TaskStep {
  const bySystem = new Map<string, { system: System; paths: string[] }>();
  for (const read of reads) {
    const entry = bySystem.get(read.system.binding) ?? { system: read.system, paths: [] };
    const path = read.edges.join(' › ');
    if (!entry.paths.includes(path)) entry.paths.push(path);
    bySystem.set(read.system.binding, entry);
  }
  const systems = [...bySystem.values()];
  return {
    kind: 'task',
    task: 'service',
    look: 'read',
    name: `Read ${joinWords(systems.map(({ system, paths }) => `${system.display} ${joinWords(paths)}`))}`,
    doc,
    touches: systems.map(({ system, paths }) => ({ system, direction: 'read', what: joinWords(paths) })),
  };
}

/** The folded assignments a step reads, shown in its documentation. */
function usesOf(facts: ExpressionFacts, ctx: Context): string[] {
  const lines: string[] = [];
  for (const name of facts.names) {
    const folded = ctx.scope.get(name)?.folded;
    if (folded !== undefined) lines.push(`where ${oneLine(folded)}`);
  }
  return lines;
}

function factsOfSlots(slots: ExprSlot[], ctx: Context): ExpressionFacts {
  const facts = emptyFacts();
  for (const slot of slots) mergeFacts(facts, factsOfSlot(slot, ctx.index.languageVersion, warner(ctx.index)));
  return facts;
}

// ── Writes and other record operations ──

function lowerWrite(write: WriteExpression, binding: string | undefined, ctx: Context): Step[] {
  const slots = write.fields.map((field) => field.value);
  const before = effectsOf(slots, ctx, {});
  const recorded = ctx.index.analysis.write(write.span);
  const system = recorded?.target === undefined ? undefined : ctx.index.analysis.system(recorded.target.instance);
  const edge = recorded?.parents.at(-1)?.edge;
  const record = recorded?.target?.recordType;
  const doc = [sourceOf(ctx.index, write.span), ...usesOf(factsOfSlots(slots, ctx), ctx)];
  const what = edge ?? record ?? 'records';
  const touches: Touch[] = system === undefined ? [] : [{ system, direction: 'write', what }];
  const result = binding === undefined ? {} : { result: binding };
  if (system?.adapter === 'ask') {
    const prompt = write.fields.find((field) => field.name === 'Prompt');
    const asked = prompt === undefined ? what : templateLabel(prompt.value, ctx.index.languageVersion);
    return [...before, { kind: 'task', task: 'user', look: 'write', name: `Ask: ${shorten(asked, 80)}`, ...result, doc, touches }];
  }
  const where = system === undefined ? '' : `${system.display} `;
  const name = recorded?.action === 'update' ? `Update ${where}${record ?? nameOfTarget(write)}` : `Write ${where}${what}`;
  // A write onto records this run built reaches no system.
  const look = system === undefined ? 'plain' : 'write';
  return [...before, { kind: 'task', task: 'service', look, name, ...result, doc, touches }];
}

function nameOfTarget(write: WriteExpression): string {
  const target = write.target;
  if (target.kind !== 'position') return 'record';
  return target.root.kind === 'name' ? target.root.name : oneLine(target.root.expr.raw);
}

function lowerMatch(match: MatchExpression, binding: string | undefined, ctx: Context): Step[] {
  const recorded = ctx.index.analysis.write(match.span);
  const system = recorded?.target === undefined ? undefined : ctx.index.analysis.system(recorded.target.instance);
  const what = recorded?.target?.recordType ?? recorded?.parents.at(-1)?.edge ?? 'record';
  const unique = match.uniqueBy.map((clause) => `unique by ${oneLine(clause.predicate.raw)}`);
  return [
    {
      kind: 'task',
      task: 'service',
      look: 'read',
      name: `Find ${system === undefined ? '' : `${system.display} `}${what}`,
      ...(binding === undefined ? {} : { result: binding }),
      doc: [sourceOf(ctx.index, match.span), ...unique],
      touches: system === undefined ? [] : [{ system, direction: 'read', what }],
    },
  ];
}

function lowerLink(link: LinkExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  return [recordTask(ctx, span, { verb: 'Link', name: link.from, edge: link.edge, direction: 'write', result: binding })];
}

/** A step on a record the run holds: its system is where the analysis says
 *  that record lives. */
function recordTask(
  ctx: Context,
  span: Span,
  op: { verb: string; name: string; edge?: string; direction: Touch['direction']; result?: string },
): TaskStep {
  const address = ctx.index.analysis.addressAt(op.name, span);
  const system = address === undefined ? undefined : ctx.index.analysis.system(address.instance);
  const what = op.edge ?? address?.position ?? op.name;
  return {
    kind: 'task',
    task: 'service',
    look: system === undefined ? 'plain' : op.direction,
    name: `${op.verb} ${system === undefined ? '' : `${system.display} `}${what}`,
    ...(op.result === undefined ? {} : { result: op.result }),
    doc: [sourceOf(ctx.index, span)],
    touches: system === undefined ? [] : [{ system, direction: op.direction, what }],
  };
}

// ── Model calls ──

function lowerExtract(extract: ExtractExpression, binding: string | undefined, ctx: Context): Step[] {
  const analysed = ctx.index.analysis.node('extract', extract.span)?.node;
  const written = extract.stages.flatMap((stage) => stage.children.map((child) => child.name));
  const nodes = analysed === undefined ? written : [analysed.name];
  const doc = [`AI step${extract.tier === undefined ? '' : `, tier ${extract.tier}`}.`, sourceOf(ctx.index, extract.span)];
  return [
    ...effectsOf(extract.from, ctx, {}).filter((step) => step.look !== 'ai'),
    {
      kind: 'task',
      task: 'service',
      look: 'ai',
      name: `Extract ${nodes.length > 0 ? joinWords(nodes) : 'fields'} (AI)`,
      ...(binding === undefined ? {} : { result: binding }),
      doc,
      touches: [],
    },
  ];
}

function lowerExtractCall(call: ExtractCallExpression, binding: string | undefined, ctx: Context): Step[] {
  const analysed = ctx.index.analysis.node('extract', call.span)?.node;
  const shape = analysed?.name ?? writtenShape(call);
  const settings = call.config === undefined ? '' : ` Settings: ${oneLine(call.config.raw)}.`;
  const output = call.finds === 'one' ? `one ${shape} or nothing` : `a list of ${shape}`;
  return [
    ...effectsOf([call.content], ctx, {}),
    {
      kind: 'task',
      task: 'service',
      look: 'ai',
      name: `Extract ${call.finds === 'one' ? '' : 'each '}${shape} (AI)`,
      ...(binding === undefined ? {} : { result: binding }),
      doc: [`AI step. Output: ${output}.${settings}`, sourceOf(ctx.index, call.span)],
      touches: [],
    },
  ];
}

function writtenShape(call: ExtractCallExpression): string {
  switch (call.shape.kind) {
    case 'named':
      return call.shape.name;
    case 'inline':
      return call.shape.declaration.name;
    case 'computed':
      return oneLine(call.shape.expr.raw);
    default:
      return unreachable(call.shape);
  }
}

// ── Calls ──

function lowerCall(call: CallStatement, binding: string | undefined, span: Span, ctx: Context): Step[] {
  if (COLLECTION_OPS.has(call.callee.toLowerCase())) {
    const collection = collectionOfCall(call);
    if (collection !== undefined) return lowerCollection(collection, binding, span, ctx);
  }
  const callee = ctx.index.analysis.symbol(call.callee, call.span);
  const local = ctx.scope.get(call.callee)?.closure;
  const declared = callee?.kind === 'movement' && ctx.index.functions.has(call.callee);
  const external = callee?.kind === 'fileImport' || callee?.kind === 'plugin';
  if (!declared && !external && local === undefined) {
    // A built-in (`only`, `count`, `Text.join`): an expression.
    if (call.expression !== undefined) return lowerExpression(call.expression, binding, span, ctx);
    return [unmapped(`a call of \`${call.callee}\``, span, ctx)];
  }
  const slots: ExprSlot[] = [];
  const argSteps: Step[] = [];
  for (const arg of call.args) {
    switch (arg.kind) {
      case 'expr':
        slots.push(arg.expr);
        break;
      case 'call':
        argSteps.push(...lowerCall(arg.call, undefined, span, ctx));
        break;
      case 'write':
        argSteps.push(...lowerWrite(arg.write, undefined, ctx));
        break;
      case 'node':
      case 'type':
        break;
      case 'closure':
        argSteps.push(unmapped('function passed to a call', arg.closure.span, ctx));
        break;
      default:
        unreachable(arg);
    }
  }
  const before = [...effectsOf(slots, ctx, {}), ...argSteps];
  const doc = [sourceOf(ctx.index, span), ...usesOf(factsOfSlots(slots, ctx), ctx)];
  const result = binding === undefined ? {} : { result: binding };
  if (declared) {
    ctx.index.calledQueue.push(call.callee);
    const calls = ctx.index.processIds.get(call.callee);
    return [...before, { kind: 'task', task: 'call', look: 'plain', name: call.callee, ...result, doc, touches: [], ...(calls === undefined ? {} : { calls }) }];
  }
  if (local !== undefined) return [...before, closureScope(call.callee, local, doc, ctx)];
  if (callee?.kind === 'plugin') {
    return [...before, { kind: 'task', task: 'service', look: 'plain', name: `Run plugin ${call.callee}`, ...result, doc, touches: [] }];
  }
  // A function imported from another file: its own diagram draws it.
  return [...before, { kind: 'task', task: 'call', look: 'plain', name: call.callee, ...result, doc, touches: [] }];
}

function closureScope(name: string, closure: ClosureExpression, doc: string[], ctx: Context): Step {
  const flow = closed(lowerBody(closure.body, { ...ctx, scope: new Map(ctx.scope), returns: 'none' }), 'Done');
  return { kind: 'scope', name, doc, touches: [], flow };
}

/** `map(xs, (x) => { … })` written as a call: its source, function and
 *  settings, as the collection form holds them. */
function collectionOfCall(call: CallStatement): CollectionOpExpression | undefined {
  const op = call.callee.toLowerCase();
  if (!isCollectionOp(op)) return undefined;
  let source: ExprSlot | undefined;
  let fn: ArmExpression | undefined;
  let config: ExprSlot | undefined;
  for (const arg of call.args) {
    if (arg.kind === 'closure') fn = { kind: 'closure', closure: arg.closure, span: arg.closure.span };
    else if (arg.kind === 'expr' && source === undefined) source = arg.expr;
    else if (arg.kind === 'expr' && arg.expr.raw.trim().startsWith('{')) config = arg.expr;
  }
  if (source === undefined || fn === undefined) return undefined;
  return { op, source, fn, ...(config === undefined ? {} : { config }), span: call.span };
}

function isCollectionOp(op: string): op is CollectionOpExpression['op'] {
  return COLLECTION_OPS.has(op);
}

// ── Collections, traversal blocks ──

function lowerBlock(block: TraversalBlock, binding: string | undefined, ctx: Context): Step[] {
  const walk = ctx.index.analysis.walkAt(block.head.span);
  const read = walk === undefined ? undefined : ctx.index.analysis.readOf(walk);
  const edges = walk === undefined ? [] : edgesOf(walk.steps);
  const aliases = walk === undefined ? [] : aliasesOf(walk.steps);
  const head = headText(block);
  const what = read === undefined ? edges.join(' › ') || head : `${read.system.display} ${read.landing ?? edges.join(' › ')}`;
  const flow = closed(lowerBody(block.body, { ...ctx, scope: new Map(ctx.scope), returns: 'none' }), 'Done');
  const before = block.head.root?.kind === 'expression' ? effectsOf([block.head.root.expr], ctx, {}) : [];
  return [
    ...before,
    {
      kind: 'scope',
      name: `For each ${what}`,
      ...(binding === undefined ? {} : { result: binding }),
      doc: [
        `Runs once per record of ${head}${aliases.length > 0 ? `, each held as ${joinWords(aliases)}` : ''}.`,
        ...(binding === undefined ? [] : [`Each run's return is collected into ${binding}.`]),
      ],
      touches: read === undefined ? [] : [{ system: read.system, direction: 'read', what: edges.join(' › ') }],
      repeat: { sequential: true },
      flow,
    },
  ];
}

function headText(block: TraversalBlock): string {
  const root = block.head.root;
  if (root === undefined) return block.head.hopsRaw;
  return oneLine(`${root.kind === 'name' ? root.name : root.expr.raw}${block.head.hopsRaw}`);
}

interface CollectionSettings {
  concurrency?: number;
  onError?: string;
}

function lowerCollection(collection: CollectionOpExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const before = effectsOf([collection.source], ctx, {});
  const sourceName = oneLine(collection.source.raw);
  const settings = settingsOf(collection.config, ctx);
  const fn = collection.fn;
  let flow: Flow;
  let member: string | undefined;
  if (fn.kind === 'closure') {
    const param = fn.closure.params[0];
    if (param !== undefined) {
      const address = ctx.index.analysis.addressAt(param.name, fn.closure.span);
      const system = address === undefined ? undefined : ctx.index.analysis.system(address.instance);
      if (system !== undefined) member = `${system.display} ${address?.position ?? sourceName}`;
    }
    flow = lowerBody(fn.closure.body, { ...ctx, scope: new Map(ctx.scope), returns: 'none' });
  } else {
    flow = lowerArmRef(fn.name, fn.span, { ...ctx, scope: new Map(ctx.scope) });
  }
  if (flow.length === 0) {
    fold(binding, span, ctx);
    return before;
  }
  const verb = collection.op === 'map' ? 'For each' : `${capitalise(collection.op)} each`;
  const notes: string[] = [];
  if (settings.concurrency !== undefined && settings.concurrency > 1) notes.push(`up to ${settings.concurrency} at once`);
  if (settings.onError === 'warn') notes.push('failures skipped');
  const doc = [
    `${collection.op}(${sourceName}, …): runs once per member${binding === undefined ? '' : `, collected into ${binding}`}.`,
    settings.concurrency === undefined
      ? 'No concurrency setting: members run one at a time.'
      : `Concurrency limit ${settings.concurrency} (BPMN cannot express the limit; it is noted here).`,
    ...(settings.onError === undefined ? [] : [`onError: "${settings.onError}": a failing member is reported and the others carry on.`]),
    sourceOf(ctx.index, span),
  ];
  return [
    ...before,
    {
      kind: 'scope',
      name: `${verb} ${member ?? sourceName}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
      ...(binding === undefined ? {} : { result: binding }),
      doc,
      touches: [],
      repeat: { sequential: !(settings.concurrency !== undefined && settings.concurrency > 1) },
      flow: closed(flow, 'Done'),
    },
  ];
}

/** The settings record's `concurrency` and `onError`, where written as
 *  literals. */
function settingsOf(slot: ExprSlot | undefined, ctx: Context): CollectionSettings {
  if (slot === undefined) return {};
  try {
    const tree = treeOfSlot(slot, ctx.index.languageVersion);
    if (tree.kind !== 'map') return {};
    const settings: CollectionSettings = {};
    for (const member of tree.entries) {
      if ('kind' in member) continue;
      if (member.key.text === 'concurrency' && member.value.kind === 'literal' && typeof member.value.value === 'number') {
        settings.concurrency = member.value.value;
      }
      if (member.key.text === 'onError' && member.value.kind === 'string') {
        settings.onError = member.value.parts.filter((part): part is string => typeof part === 'string').join('');
      }
    }
    return settings;
  } catch {
    ctx.index.warnings.push(`could not read the settings \`${oneLine(slot.raw)}\``);
    return {};
  }
}

// ── Branching ──

function lowerIf(statement: IfStatement, ctx: Context): Step[] {
  const conditions = statement.arms.map((arm) => arm.condition);
  const before = effectsOf(conditions, ctx, {});
  const branch = (body: Statement[]): Flow => lowerBody(body, { ...ctx, scope: new Map(ctx.scope) });
  return [
    ...before,
    {
      kind: 'choice',
      arms: statement.arms.map((arm) => ({
        condition: oneLine(arm.condition.raw),
        label: shorten(conditionLabel(arm.condition, ctx.index.languageVersion), 80),
        flow: branch(arm.body),
      })),
      ...(statement.elseArm === undefined ? {} : { otherwise: branch(statement.elseArm.body) }),
      doc: usesOf(factsOfSlots(conditions, ctx), ctx),
    },
  ];
}

function lowerReturn(value: RValue, span: Span, ctx: Context): Step[] {
  const text = value.kind === 'expr' ? oneLine(value.expr.raw) : undefined;
  const before = value.kind === 'expr' ? effectsOf([value.expr], ctx, {}) : lowerValue(value, undefined, span, ctx);
  const end: EndStep = {
    kind: 'end',
    end: ctx.returns,
    name: text === undefined || text.length > 30 || text.includes('${') ? 'Return' : `Return ${text}`,
    doc: [sourceOf(ctx.index, span)],
  };
  return [...before, end];
}

// ── Waits ──

function lowerAwait(expression: AwaitExpression, binding: string | undefined, ctx: Context): Step[] {
  const source = expression.source;
  const doc = [sourceOf(ctx.index, expression.span)];
  const result = binding === undefined ? {} : { result: binding };
  switch (source.kind) {
    case 'traversal': {
      const awaited = ctx.index.analysis.node('await', expression.span)?.source;
      const walk = ctx.index.analysis.walkAt(source.head.span);
      const read = walk === undefined ? undefined : ctx.index.analysis.readOf(walk);
      const edges = walk === undefined ? [] : edgesOf(walk.steps);
      const root = (awaited?.kind === 'traversal' ? awaited.root : undefined) ?? walk?.root ?? oneLine(source.head.hopsRaw);
      const edge = (awaited?.kind === 'traversal' ? awaited.edge : undefined) ?? edges.at(-1) ?? 'arrival';
      const wait: WaitStep = {
        kind: 'wait',
        trigger: { kind: 'message', message: `${root} ${edge}` },
        name: `Wait for ${source.arrivalsOnly === true ? 'new ' : ''}${edge} on ${root}`,
        ...result,
        doc,
        touches: read === undefined ? [] : [{ system: read.system, direction: 'read', what: edge }],
      };
      return [wait];
    }
    case 'sleep':
      return [
        {
          kind: 'wait',
          trigger: { kind: 'timer', isoDuration: isoDuration(source.duration.raw) },
          name: `Wait ${describeDuration(source.duration.raw)}`,
          ...result,
          doc,
          touches: [],
        },
      ];
    case 'until': {
      const condition = source.condition;
      let written: ExprSlot | undefined;
      let spans: Span[];
      if (condition.kind === 'expr') {
        written = condition.expr;
        spans = [condition.expr.span];
      } else {
        const last = [...condition.closure.body].reverse().find((s) => s.kind === 'return');
        written = last?.kind === 'return' && last.value.kind === 'expr' ? last.value.expr : undefined;
        spans = [condition.closure.span];
      }
      const text = written === undefined ? 'the condition holds' : oneLine(written.raw);
      const label = written === undefined ? text : conditionLabel(written, ctx.index.languageVersion);
      const every = source.every === undefined ? 'every 1 hour (the default)' : `every ${describeDuration(source.every.raw)}`;
      const reads = ctx.index.analysis.readsWithin(spans).map((read) => `${read.system.display} ${read.edges.join(' › ')}`);
      return [
        {
          kind: 'wait',
          trigger: { kind: 'condition', condition: text },
          name: `Wait until ${shorten(label, 60)}`,
          ...result,
          doc: [...doc, `Re-checked ${every}.`, ...(reads.length > 0 ? [`Each check reads ${joinWords([...new Set(reads)])}.`] : [])],
          touches: [],
        },
      ];
    }
    case 'combinator':
      return lowerCombinator(source.combinator, binding, expression.span, ctx);
    default:
      return unreachable(source);
  }
}

// ── race / all ──

function lowerCombinator(combinator: CombinatorExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  if (binding !== undefined) ctx.scope.delete(binding);
  if (combinator.arms.kind === 'dynamic') return [unmapped(`${combinator.kind} over arms built at run time`, span, ctx)];
  const doc = [sourceOf(ctx.index, span)];
  const arms = writtenArms(combinator.arms);
  switch (combinator.kind) {
    case 'race':
      return [lowerRace(arms, doc, ctx)];
    case 'all':
    case 'parallel': {
      const settings = settingsOf(combinator.settings, ctx);
      if (settings.concurrency !== undefined) doc.push(`Concurrency limit ${settings.concurrency} (BPMN cannot express the limit; it is noted here).`);
      return [{ kind: 'all', arms: arms.map((arm, position) => allArm(arm, position, ctx)), doc }];
    }
    default:
      return unreachable(combinator.kind);
  }
}

function lowerArm(arm: ArmExpression, ctx: Context): Flow {
  if (arm.kind === 'closure') return lowerBody(arm.closure.body, { ...ctx, scope: new Map(ctx.scope) });
  return lowerArmRef(arm.name, arm.span, ctx);
}

/** A function named where a function is expected: a declared function is a
 *  call activity; a closure bound earlier is its body. */
function lowerArmRef(name: string, span: Span, ctx: Context): Flow {
  const closure = ctx.scope.get(name)?.closure;
  if (closure !== undefined) return lowerBody(closure.body, { ...ctx, scope: new Map(ctx.scope) });
  if (ctx.index.functions.has(name)) {
    ctx.index.calledQueue.push(name);
    const calls = ctx.index.processIds.get(name);
    return [{ kind: 'task', task: 'call', look: 'plain', name, doc: [sourceOf(ctx.index, span)], touches: [], ...(calls === undefined ? {} : { calls }) }];
  }
  return [unmapped(`function value \`${name}\``, span, ctx)];
}

/** An `all` arm. Its last `return` is just the arm finishing; an earlier one
 *  ends the arm early, which BPMN can only say inside a subprocess (a bare
 *  end event in a parallel branch would starve the join). */
function allArm(arm: ArmExpression, position: number, ctx: Context): Flow {
  const flow = lowerArm(arm, { ...ctx, returns: 'none' });
  const last = flow.at(-1);
  if (last?.kind === 'end' && last.end === 'none') flow.pop();
  if (!containsReturn(flow)) return flow;
  return [{ kind: 'scope', name: `Arm ${position + 1}`, doc: ['An arm of all(…) that can return early.'], touches: [], flow: closed(flow, 'Done') }];
}

function containsReturn(flow: Flow): boolean {
  return flow.some((step) => {
    switch (step.kind) {
      case 'end':
        return step.end === 'none';
      case 'choice':
        return step.arms.some((arm) => containsReturn(arm.flow)) || (step.otherwise !== undefined && containsReturn(step.otherwise));
      case 'all':
        return step.arms.some(containsReturn);
      case 'task':
      case 'wait':
      case 'firstEvent':
      case 'scope':
        return false;
      default:
        return unreachable(step);
    }
  });
}

function lowerRace(arms: ArmExpression[], doc: string[], ctx: Context): Step {
  const flows = arms.map((arm) => lowerArm(arm, { ...ctx, returns: 'terminate' }));
  const waits = flows.map(singleWait);
  const ties = 'Ties: when arms settle in the same moment listen-fire lands every one; BPMN takes one.';
  if (waits.every((wait) => wait !== undefined)) {
    return { kind: 'firstEvent', arms: waits.flatMap((wait) => (wait === undefined ? [] : [wait])), doc: [...doc, ties] };
  }
  const closedArms = flows.map((flow): Flow => (flowEnds(flow) ? flow : [...flow, { kind: 'end', end: 'terminate', name: 'Finished first', doc: [] }]));
  return {
    kind: 'scope',
    name: 'Race: first to finish wins',
    doc: [...doc, 'Every arm starts at once; the first to reach a terminate end event ends the race and stops the rest.', ties],
    touches: [],
    flow: [{ kind: 'all', arms: closedArms, doc: [] }],
  };
}

/** An arm that is one wait and then, at most, a plain return. */
function singleWait(flow: Flow): { wait: WaitStep; result?: string } | undefined {
  const [first, second, ...rest] = flow;
  if (first?.kind !== 'wait' || rest.length > 0) return undefined;
  if (second === undefined) return { wait: first };
  if (second.kind === 'end' && second.end === 'terminate') {
    return second.name === 'Return' ? { wait: first } : { wait: first, result: second.name.replace(/^Return /, '') };
  }
  return undefined;
}

// ── Helpers ──

function closed(flow: Flow, name: string): Flow {
  return flowEnds(flow) ? flow : [...flow, { kind: 'end', end: 'none', name, doc: [] }];
}

function unmapped(what: string, span: Span, ctx: Context): TaskStep {
  ctx.index.warnings.push(`line ${span.start.line}: no BPMN mapping yet for ${what}; drawn as an "Unmapped" task`);
  return { kind: 'task', task: 'unmapped', look: 'plain', name: `Unmapped: ${what}`, doc: [sourceOf(ctx.index, span)], touches: [] };
}

function warner(index: ProgramIndex): (message: string) => void {
  return (message) => index.warnings.push(message);
}

/** The source text a span covers. */
function sourceOf(index: ProgramIndex, span: Span): string {
  const { start, end } = span;
  if (start.line === end.line) return (index.source[start.line - 1] ?? '').slice(start.col - 1, end.col - 1).trimEnd();
  const lines = [(index.source[start.line - 1] ?? '').slice(start.col - 1)];
  for (let line = start.line + 1; line < end.line; line++) lines.push(index.source[line - 1] ?? '');
  lines.push((index.source[end.line - 1] ?? '').slice(0, end.col - 1));
  return lines.join('\n').trimEnd();
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'function';
}
