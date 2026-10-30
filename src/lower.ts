// The mapping: a parsed program to the diagram's tree (flow.ts). One process
// per function a `listen` fires, plus one per function those call. Each
// statement becomes the BPMN construct the mapping names; expressions and
// plain assignments fold into the steps that use them.

import {
  constructionAsCall,
  typeNameOf,
  writtenArms,
  type ArmExpression,
  type CallStatement,
  type CallbackExpression,
  type ClosureExpression,
  type CollectionOpExpression,
  type CombinatorExpression,
  type ExprSlot,
  type ExtractCallExpression,
  type ExtractExpression,
  type IfStatement,
  type LinkExpression,
  type ListenDeclaration,
  type MatchExpression,
  type MovementDeclaration,
  type PathHead,
  type Program,
  type RValue,
  type Span,
  type Statement,
  type TraversalBlock,
  type AwaitExpression,
  type WriteExpression,
  treeOfSlot,
} from '@listen-fire/movement-lang';

import { emptyFacts, factsOfSlot, mergeFacts, oneLine, walkOfHead, type ExpressionFacts } from './expressions.js';
import {
  flowEnds,
  unreachable,
  type Diagram,
  type EndStep,
  type Flow,
  type Handler,
  type ProcessFlow,
  type Start,
  type Step,
  type System,
  type TaskStep,
  type Touch,
  type WaitStep,
} from './flow.js';
import { describeDuration, isoDuration } from './durations.js';

/** What the diagram knows about a name: where its records come from, and
 *  what kind of thing it is. */
interface Binding {
  system?: System;
  /** The kind of record it holds, by the edge that reached it ("Channels"). */
  label?: string;
  role?: 'callback' | 'ask';
  /** An ask's prompt, for naming the wait on its answer. */
  prompt?: string;
  closure?: ClosureExpression;
  /** The assignment's source, when the assignment drew nothing of its own. */
  folded?: string;
}

interface ProgramIndex {
  source: string[];
  systems: Map<string, System>;
  /** Constructed instances that are not connected systems (`cron`, `manual`). */
  instances: Map<string, string>;
  functions: Map<string, MovementDeclaration>;
  plugins: Set<string>;
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
  /** The enclosing process's or subprocess's callbacks. */
  handlers: Handler[];
}

const ADAPTER_NAMES: Record<string, string> = {
  airtable: 'Airtable',
  ask: 'Asks (people)',
  attio: 'Attio',
  email: 'Email',
  github: 'GitHub',
  gmail: 'Gmail',
  hubspot: 'HubSpot',
  linear: 'Linear',
  notion: 'Notion',
  slack: 'Slack',
};

/** Edges that deliver a message to a person: a write along one is a send task. */
const MESSAGE_EDGE = /^(messages?|emails?|posts?|replies|reply|comments?|dms?)$/i;

const COLLECTION_OPS = new Set(['map', 'filter', 'reduce', 'groupby', 'keyby', 'sort']);

export interface LowerOptions {
  /** The file's name, for the process documentation. */
  fileName?: string;
}

export function lowerProgram(program: Program, source: string, options: LowerOptions = {}): Diagram {
  const index = indexProgram(program, source);
  const processes: ProcessFlow[] = [];
  const listens = program.statements.filter((s): s is ListenDeclaration => s.kind === 'listen');
  const fired = new Map<string, Start[]>();
  for (const listen of listens) {
    const fn = index.functions.get(listen.movement);
    if (fn === undefined) {
      index.warnings.push(`listen fires \`${listen.movement}\`, which is not declared in this file; not drawn`);
      continue;
    }
    const starts = fired.get(fn.name) ?? [];
    starts.push(startOf(listen, fn, index));
    fired.set(fn.name, starts);
  }
  for (const [name, starts] of fired) {
    const fn = index.functions.get(name);
    if (fn !== undefined) processes.push(lowerFunction(fn, starts, index, options));
  }
  const drawn = new Set(fired.keys());
  while (index.calledQueue.length > 0) {
    const name = index.calledQueue.shift();
    const fn = name === undefined ? undefined : index.functions.get(name);
    if (fn === undefined || drawn.has(fn.name)) continue;
    drawn.add(fn.name);
    processes.push(
      lowerFunction(fn, [{ kind: 'none', name: 'Called', doc: ['Started by a call from another function.'] }], index, options),
    );
  }
  for (const name of index.functions.keys()) {
    if (!drawn.has(name)) index.warnings.push(`function \`${name}\` is neither fired by a listen nor called; not drawn`);
  }
  return { processes, systems: [...index.systems.values()], warnings: index.warnings };
}

function indexProgram(program: Program, source: string): ProgramIndex {
  const adapters = new Set<string>();
  const plugins = new Set<string>();
  for (const statement of program.statements) {
    if (statement.kind !== 'import' || statement.source.kind !== 'builtin') continue;
    for (const imported of statement.names) {
      const local = imported.alias ?? imported.name;
      if (statement.source.namespace === 'adapters') adapters.add(local);
      if (statement.source.namespace === 'plugins') plugins.add(local);
    }
  }
  const constructs: Array<{ binding: string; adapter: string }> = [];
  const index: ProgramIndex = {
    source: source.split('\n'),
    systems: new Map(),
    instances: new Map(),
    functions: new Map(),
    plugins,
    fileScope: new Map(),
    processIds: new Map(),
    calledQueue: [],
    warnings: [],
  };
  for (const statement of program.statements) {
    if (statement.kind === 'movement') {
      index.functions.set(statement.name, statement);
      index.processIds.set(statement.name, `Process_${slug(statement.name)}`);
    } else if (statement.kind === 'assign' && statement.value.kind === 'construct') {
      const callee = statement.value.construct.callee;
      if (adapters.has(callee)) constructs.push({ binding: statement.name, adapter: callee });
      else index.instances.set(statement.name, callee);
    } else if (statement.kind === 'assign' && statement.value.kind === 'closure') {
      index.fileScope.set(statement.name, { closure: statement.value.closure });
    } else if (statement.kind === 'assign') {
      index.fileScope.set(statement.name, { folded: sourceOf(index, statement.span) });
    }
  }
  const perAdapter = new Map<string, number>();
  for (const { adapter } of constructs) perAdapter.set(adapter, (perAdapter.get(adapter) ?? 0) + 1);
  for (const { binding, adapter } of constructs) {
    const name = ADAPTER_NAMES[adapter] ?? capitalise(adapter);
    const display = (perAdapter.get(adapter) ?? 0) > 1 ? `${name} (${binding})` : name;
    const system: System = { binding, adapter, display };
    index.systems.set(binding, system);
    index.fileScope.set(binding, { system });
  }
  return index;
}

function startOf(listen: ListenDeclaration, fn: MovementDeclaration, index: ProgramIndex): Start {
  const config = listen.config.map((arg) => `${arg.name}: ${oneLine(arg.value.raw)}`);
  const doc = [`listen to ${listen.instance}${config.length > 0 ? ` { ${config.join(', ')} }` : ''} fire ${fn.name}`];
  if (listen.alias !== undefined) doc.push(`Listen lane: ${listen.alias}`);
  const system = index.systems.get(listen.instance);
  const adapter = system?.adapter ?? index.instances.get(listen.instance) ?? listen.instance;
  if (adapter === 'cron') {
    const schedule = listen.config.find((arg) => arg.name === 'schedule');
    const cycle = schedule === undefined ? '' : unquote(schedule.value.raw);
    return { kind: 'timer', name: `On schedule ${cycle}`, cycle, doc };
  }
  if (adapter === 'manual') return { kind: 'none', name: 'Started manually', doc };
  const event = eventLabelOf(fn, index);
  const label = event === undefined ? 'event' : event;
  if (system === undefined) {
    return { kind: 'message', name: `On ${listen.instance} ${label}`, message: `${listen.instance} ${label}`, doc };
  }
  const name = singular(label).toLowerCase() === system.display.toLowerCase() ? `On new ${label}` : `On ${system.display} ${label}`;
  return { kind: 'message', name, message: `${system.display} ${label}`, system, doc };
}

/** The event a fired function's parameter is typed as: `Email` in
 *  `m: <inbox-[:Email]->>`. */
function eventLabelOf(fn: MovementDeclaration, index: ProgramIndex): string | undefined {
  const param = fn.params[0];
  const type = param === undefined ? undefined : typeNameOf(param.type);
  if (type === undefined) return undefined;
  if (type.position !== undefined) return type.position;
  if (type.hopsRaw === undefined) return undefined;
  const walk = walkOfHead({ root: { kind: 'name', name: type.graph }, hopsRaw: type.hopsRaw, span: type.span }, warner(index));
  return walk.labels.at(-1);
}

function lowerFunction(fn: MovementDeclaration, starts: Start[], index: ProgramIndex, options: LowerOptions): ProcessFlow {
  const scope = new Map(index.fileScope);
  for (const param of fn.params) {
    const type = typeNameOf(param.type);
    const system = type === undefined ? undefined : index.systems.get(type.graph);
    const label = type === undefined ? undefined : (type.position ?? labelOfType(type.graph, type.hopsRaw, type.span, index));
    scope.set(param.name, { system, label });
  }
  const handlers: Handler[] = [];
  const ctx: Context = { index, scope, returns: 'none', handlers };
  const flow = closed(lowerBody(fn.body, ctx), 'Done');
  const touched = new Set<string>();
  collectSystems(flow, handlers, touched);
  for (const start of starts) if (start.kind === 'message' && start.system !== undefined) touched.add(start.system.display);
  const doc = [
    `Function \`${fn.name}\`${options.fileName === undefined ? '' : ` in ${options.fileName}`}, drawn by listen-fire-bpmn from the parsed program.`,
    touched.size > 0 ? `Connected systems it touches: ${[...touched].join(', ')}.` : 'It touches no connected system.',
    'Queries are carried as text, types are dropped, and expressions are folded into the steps that use them; the program is the authority.',
  ];
  const id = index.processIds.get(fn.name) ?? `Process_${slug(fn.name)}`;
  return { id, name: fn.name, doc, starts, body: { flow, handlers } };
}

function labelOfType(graph: string, hopsRaw: string | undefined, span: Span, index: ProgramIndex): string | undefined {
  if (hopsRaw === undefined) return undefined;
  return walkOfHead({ root: { kind: 'name', name: graph }, hopsRaw, span }, warner(index)).labels.at(-1);
}

function collectSystems(flow: Flow, handlers: Handler[], into: Set<string>): void {
  const visitFlow = (steps: Flow): void => {
    for (const step of steps) {
      switch (step.kind) {
        case 'task':
        case 'wait':
          for (const touch of step.touches) into.add(touch.system.display);
          break;
        case 'scope':
          for (const touch of step.touches) into.add(touch.system.display);
          collectSystems(step.body.flow, step.body.handlers, into);
          break;
        case 'choice':
          for (const arm of step.arms) visitFlow(arm.flow);
          if (step.otherwise !== undefined) visitFlow(step.otherwise);
          break;
        case 'all':
          for (const arm of step.arms) visitFlow(arm);
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
  };
  visitFlow(flow);
  for (const handler of handlers) collectSystems(handler.body.flow, handler.body.handlers, into);
}

// ── Bodies and statements ──

function lowerBody(statements: Statement[], ctx: Context): Flow {
  const flow: Flow = [];
  for (const [position, statement] of statements.entries()) {
    if (flowEnds(flow)) {
      const rest = statements.slice(position).filter((s) => !isDeclaration(s));
      if (rest.length > 0) {
        ctx.index.warnings.push(
          `line ${statement.span.start.line}: ${rest.length} statement(s) after a path that always ends are unreachable; not drawn`,
        );
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
      return lowerWrite(statement.write, undefined, statement.span, ctx);
    case 'match':
      return lowerMatch(statement.match, undefined, statement.span, ctx);
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
      return [recordTask(ctx, statement.span, { verb: 'Re-read', name: statement.name, direction: 'read' })];
    case 'if':
      return lowerIf(statement, ctx);
    case 'await':
      return lowerAwait(statement.await, undefined, statement.span, ctx);
    case 'combinator':
      return lowerCombinator(statement.combinator, undefined, statement.span, ctx);
    case 'collection':
      return lowerCollection(statement.collection, undefined, statement.span, ctx);
    case 'return':
      return lowerReturn(statement.value, statement.span, ctx);
    case 'error': {
      const before = effectsOf(factsOf(statement.message, ctx), ctx, { purpose: 'the failure message' });
      const message = unquote(statement.message.raw);
      const end: EndStep = { kind: 'end', end: 'error', name: `Fail: ${message}`, doc: [sourceOf(ctx.index, statement.span)] };
      return [...before, end];
    }
    default:
      return unreachable(statement);
  }
}

/** A right-hand side, bound to `binding` when there is one. */
function lowerValue(value: RValue, binding: string | undefined, span: Span, ctx: Context): Step[] {
  switch (value.kind) {
    case 'construct': {
      const call = constructionAsCall(value.construct);
      return lowerCall(call, binding, span, ctx);
    }
    case 'call':
      return lowerCall(value.call, binding, span, ctx);
    case 'write':
      return lowerWrite(value.write, binding, span, ctx);
    case 'match':
      return lowerMatch(value.match, binding, span, ctx);
    case 'link':
      return lowerLink(value.link, binding, span, ctx);
    case 'extract':
      return lowerExtract(value.extract, binding, span, ctx);
    case 'extractCall':
      return lowerExtractCall(value.extractCall, binding, span, ctx);
    case 'block':
      return lowerBlock(value.block, binding, ctx);
    case 'await':
      return lowerAwait(value.await, binding, span, ctx);
    case 'combinator':
      return lowerCombinator(value.combinator, binding, span, ctx);
    case 'collection':
      return lowerCollection(value.collection, binding, span, ctx);
    case 'callback':
      return lowerCallback(value.callback, binding, span, ctx);
    case 'closure':
      if (binding !== undefined) ctx.scope.set(binding, { closure: value.closure });
      return [];
    case 'members':
    case 'node':
    case 'lazy':
      fold(binding, span, {}, ctx);
      return [];
    case 'inlineBlock':
      return [unmapped('inline block (a retired form)', span, ctx)];
    case 'expr':
      return lowerExpression(value.expr, binding, span, ctx);
    default:
      return unreachable(value);
  }
}

function lowerExpression(slot: ExprSlot, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const facts = factsOf(slot, ctx);
  const steps = effectsOf(facts, ctx, { binding, statement: sourceOf(ctx.index, span), purpose: binding });
  const provenance = provenanceOf(facts, ctx);
  if (steps.length === 0) fold(binding, span, provenance, ctx);
  else if (binding !== undefined) ctx.scope.set(binding, provenance);
  return steps;
}

function fold(binding: string | undefined, span: Span, provenance: Binding, ctx: Context): void {
  if (binding === undefined) return;
  ctx.scope.set(binding, { ...provenance, folded: sourceOf(ctx.index, span) });
}

/** Where a value's records come from: the first walk's system and edge, or
 *  the first name read that has a known origin. */
function provenanceOf(facts: ExpressionFacts, ctx: Context): Binding {
  for (const walk of facts.walks) {
    const root = walk.root === undefined ? undefined : ctx.scope.get(walk.root);
    if (root?.system !== undefined || walk.labels.length > 0) {
      return { system: root?.system, label: walk.labels.at(-1) ?? root?.label };
    }
  }
  for (const name of facts.names) {
    const known = ctx.scope.get(name);
    if (known?.system !== undefined) return { system: known.system, label: known.label };
  }
  return {};
}

interface EffectPurpose {
  binding?: string;
  /** The statement's source, for a read that IS the statement. */
  statement?: string;
  /** What an `ai(…)` call computes, for its task's name. */
  purpose?: string;
}

/** The steps an expression's evaluation draws: a read of each connected
 *  system it walks, a model call per `ai(…)`, and an unmapped marker per
 *  function body written inside it. */
function effectsOf(facts: ExpressionFacts, ctx: Context, purpose: EffectPurpose): Step[] {
  const steps: Step[] = [];
  const reads = facts.walks.flatMap((walk) => {
    const system = walk.root === undefined ? undefined : ctx.scope.get(walk.root)?.system;
    return system === undefined ? [] : [{ walk, system }];
  });
  if (reads.length > 0) {
    const bySystem = new Map<string, string[]>();
    for (const { walk, system } of reads) {
      const labels = bySystem.get(system.display) ?? [];
      labels.push(walk.labels.join(' → '));
      bySystem.set(system.display, labels);
    }
    const parts = [...bySystem].map(([display, labels]) => `${display} ${joinWords(unique(labels.filter((label) => label !== '')))}`.trim());
    const doc = purpose.statement !== undefined ? [purpose.statement] : reads.map(({ walk }) => walk.text);
    steps.push({
      kind: 'task',
      task: 'service',
      name: `Read ${joinWords(parts)}`,
      doc: [...doc, ...usesOf(facts, ctx)],
      touches: uniqueTouches(reads.map(({ system }) => ({ system, direction: 'read' }))),
    });
  }
  for (const prompt of facts.aiCalls) {
    steps.push({
      kind: 'task',
      task: 'service',
      ai: true,
      name: `Generate ${purpose.purpose ?? 'value'} (AI)`,
      doc: [`AI step: ${prompt}`, ...(purpose.statement === undefined ? [] : [purpose.statement])],
      touches: [],
    });
  }
  for (const closure of facts.blockClosures) {
    ctx.index.warnings.push(`a function body written inside an expression is not drawn: ${oneLine(closure).slice(0, 80)}`);
    steps.push({ kind: 'task', task: 'unmapped', name: 'Unmapped: function inside an expression', doc: [closure], touches: [] });
  }
  return steps;
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

function factsOf(slot: ExprSlot | undefined, ctx: Context): ExpressionFacts {
  return slot === undefined ? emptyFacts() : factsOfSlot(slot, warner(ctx.index));
}

// ── Writes and other record operations ──

function lowerWrite(write: WriteExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const before: Step[] = [];
  const facts = emptyFacts();
  for (const field of write.fields) {
    const fieldFacts = factsOf(field.value, ctx);
    before.push(...effectsOf({ ...fieldFacts, walks: fieldFacts.walks }, ctx, { purpose: field.name }));
    mergeFacts(facts, fieldFacts);
  }
  for (const clause of write.uniqueBy) mergeFacts(facts, factsOf(clause.predicate, ctx));

  const target = write.target;
  let system: System | undefined;
  let edge: string | undefined;
  let recordLabel: string | undefined;
  let fromSystemItself = false;
  switch (target.kind) {
    case 'linked':
    case 'tuple': {
      const head = target.kind === 'linked' ? target.path : target.paths[0];
      const walk = head === undefined ? undefined : walkOfHead(head, warner(ctx.index));
      const root = walk?.root === undefined ? undefined : ctx.scope.get(walk.root);
      system = root?.system;
      fromSystemItself = walk?.root !== undefined && ctx.index.systems.has(walk.root);
      recordLabel = root?.label;
      edge = target.explicitType ?? walk?.labels.at(-1);
      break;
    }
    case 'position': {
      const name = target.root.kind === 'name' ? target.root.name : undefined;
      const root = name === undefined ? undefined : ctx.scope.get(name);
      system = root?.system;
      recordLabel = root?.label;
      break;
    }
    default:
      unreachable(target);
  }

  const doc = [sourceOf(ctx.index, span), ...usesOf(facts, ctx)];
  const touches: Touch[] = system === undefined ? [] : [{ system, direction: 'write' }];
  let task: TaskStep;
  if (system?.adapter === 'ask') {
    const promptField = write.fields.find((field) => field.name.toLowerCase() === 'prompt');
    const prompt = promptField === undefined ? edge ?? 'a person' : unquote(promptField.value.raw);
    task = { kind: 'task', task: 'user', name: `Ask: ${prompt}`, doc, touches };
    if (binding !== undefined) ctx.scope.set(binding, { system, label: edge, role: 'ask', prompt });
    return [...before, task];
  }
  const where = system === undefined ? '' : `${system.display} `;
  if (target.kind !== 'position' && edge !== undefined && MESSAGE_EDGE.test(edge)) {
    const name =
      fromSystemItself || recordLabel === undefined
        ? `Send ${where}${singular(edge).toLowerCase()}`
        : `Post to ${where}${singular(recordLabel).toLowerCase()}`;
    task = { kind: 'task', task: 'send', name, doc, touches };
  } else if (target.kind === 'position') {
    const subject = recordLabel === undefined ? nameOfRoot(target.root) : singular(recordLabel);
    task = { kind: 'task', task: 'service', name: `Update ${where}${subject}`, doc, touches };
  } else {
    task = { kind: 'task', task: 'service', name: `Write ${where}${edge ?? 'record'}`, doc, touches };
  }
  if (binding !== undefined) ctx.scope.set(binding, { system, label: edge ?? recordLabel });
  return [...before, task];
}

function nameOfRoot(root: { kind: 'name'; name: string } | { kind: 'expression'; expr: ExprSlot }): string {
  return root.kind === 'name' ? root.name : oneLine(root.expr.raw);
}

function lowerMatch(match: MatchExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const head = match.target.kind === 'linked' ? match.target.path : match.target.paths[0];
  const walk = head === undefined ? undefined : walkOfHead(head, warner(ctx.index));
  const system = walk?.root === undefined ? undefined : ctx.scope.get(walk.root)?.system;
  const label = match.target.explicitType ?? walk?.labels.at(-1) ?? 'record';
  if (binding !== undefined) ctx.scope.set(binding, { system, label });
  const unique = match.uniqueBy.map((clause) => `unique by ${oneLine(clause.predicate.raw)}`);
  return [
    {
      kind: 'task',
      task: 'service',
      name: `Find ${system === undefined ? '' : `${system.display} `}${singular(label)}`,
      doc: [sourceOf(ctx.index, span), ...unique],
      touches: system === undefined ? [] : [{ system, direction: 'read' }],
    },
  ];
}

function lowerLink(link: LinkExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const from = ctx.scope.get(link.from);
  const system = from?.system;
  if (binding !== undefined) ctx.scope.set(binding, { system, label: link.edge });
  return [
    {
      kind: 'task',
      task: 'service',
      name: `Link ${system === undefined ? '' : `${system.display} `}${link.edge}`,
      doc: [sourceOf(ctx.index, span)],
      touches: system === undefined ? [] : [{ system, direction: 'write' }],
    },
  ];
}

function recordTask(
  ctx: Context,
  span: Span,
  op: { verb: string; name: string; edge?: string; direction: Touch['direction'] },
): TaskStep {
  const record = ctx.scope.get(op.name);
  const system = record?.system;
  const subject = op.edge ?? (record?.label === undefined ? op.name : singular(record.label));
  return {
    kind: 'task',
    task: 'service',
    name: `${op.verb} ${system === undefined ? '' : `${system.display} `}${subject}`,
    doc: [sourceOf(ctx.index, span)],
    touches: system === undefined ? [] : [{ system, direction: op.direction }],
  };
}

// ── Model calls ──

function lowerExtract(extract: ExtractExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const facts = emptyFacts();
  for (const slot of extract.from) mergeFacts(facts, factsOf(slot, ctx));
  const nodes = extract.stages.flatMap((stage) => stage.children.map((child) => child.name));
  if (binding !== undefined) ctx.scope.set(binding, { label: nodes[0] });
  const doc = [`AI step${extract.tier === undefined ? '' : `, tier ${extract.tier}`}.`, sourceOf(ctx.index, span)];
  return [
    ...effectsOf({ ...facts, aiCalls: [] }, ctx, {}),
    { kind: 'task', task: 'service', ai: true, name: `Extract ${nodes.length > 0 ? joinWords(nodes) : 'fields'} (AI)`, doc, touches: [] },
  ];
}

function lowerExtractCall(call: ExtractCallExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const facts = factsOf(call.content, ctx);
  const shape = (() => {
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
  })();
  if (binding !== undefined) ctx.scope.set(binding, { label: shape });
  const settings = call.config === undefined ? '' : ` Settings: ${oneLine(call.config.raw)}.`;
  const output = call.finds === 'one' ? `one ${shape} or nothing` : `a list of ${shape}`;
  const doc = [`AI step. Output: ${output}.${settings}`, sourceOf(ctx.index, span)];
  return [
    ...effectsOf(facts, ctx, { purpose: binding }),
    {
      kind: 'task',
      task: 'service',
      ai: true,
      name: `Extract ${call.finds === 'one' ? '' : 'each '}${shape} (AI)`,
      doc,
      touches: [],
    },
  ];
}

// ── Calls ──

function lowerCall(call: CallStatement, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const callee = call.callee;
  if (COLLECTION_OPS.has(callee.toLowerCase())) {
    const collection = collectionOfCall(call);
    if (collection !== undefined) return lowerCollection(collection, binding, span, ctx);
  }
  const argSteps: Step[] = [];
  const facts = emptyFacts();
  const declared = ctx.index.functions.has(callee);
  const local = ctx.scope.get(callee)?.closure;
  if (!declared && local === undefined && !ctx.index.plugins.has(callee)) {
    // A built-in (`only`, `count`, `Text.join`): an expression.
    if (call.expression !== undefined) return lowerExpression(call.expression, binding, span, ctx);
  }
  for (const arg of call.args) {
    switch (arg.kind) {
      case 'expr':
        mergeFacts(facts, factsOf(arg.expr, ctx));
        break;
      case 'call':
        argSteps.push(...lowerCall(arg.call, undefined, span, ctx));
        break;
      case 'write':
        argSteps.push(...lowerWrite(arg.write, undefined, span, ctx));
        break;
      case 'node':
      case 'type':
        break;
      case 'closure':
        argSteps.push(unmapped('function passed to a call', arg.span, ctx));
        break;
      default:
        unreachable(arg);
    }
  }
  const before = [...effectsOf(facts, ctx, {}), ...argSteps];
  const doc = [sourceOf(ctx.index, span), ...usesOf(facts, ctx)];
  if (declared) {
    ctx.index.calledQueue.push(callee);
    if (binding !== undefined) ctx.scope.set(binding, {});
    return [...before, { kind: 'task', task: 'call', name: callee, doc, touches: [], calls: ctx.index.processIds.get(callee) }];
  }
  if (local !== undefined) {
    return [...before, closureScope(callee, local, doc, ctx)];
  }
  if (ctx.index.plugins.has(callee)) {
    return [...before, { kind: 'task', task: 'service', name: `Run plugin ${callee}`, doc, touches: [] }];
  }
  // A positional call with no expression reading and no declaration: a
  // function imported from another file.
  return [...before, { kind: 'task', task: 'call', name: callee, doc, touches: [] }];
}

function closureScope(name: string, closure: ClosureExpression, doc: string[], ctx: Context): Step {
  const handlers: Handler[] = [];
  const inner: Context = { ...ctx, scope: new Map(ctx.scope), returns: 'none', handlers };
  const flow = closed(lowerBody(closure.body, inner), 'Done');
  return { kind: 'scope', name, doc, touches: [], body: { flow, handlers } };
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
    if (arg.kind === 'closure') fn = { kind: 'closure', closure: arg.closure, span: arg.span };
    else if (arg.kind === 'expr' && source === undefined) source = arg.expr;
    else if (arg.kind === 'expr' && arg.expr.raw.trim().startsWith('{')) config = arg.expr;
  }
  if (source === undefined || fn === undefined) return undefined;
  return { op, source, fn, config, span: call.span };
}

function isCollectionOp(op: string): op is CollectionOpExpression['op'] {
  return COLLECTION_OPS.has(op);
}

// ── Collections, traversal blocks ──

function lowerBlock(block: TraversalBlock, binding: string | undefined, ctx: Context): Step[] {
  const walk = walkOfHead(block.head, warner(ctx.index));
  const root = walk.root === undefined ? undefined : ctx.scope.get(walk.root);
  const system = root?.system;
  const label = walk.labels.at(-1) ?? root?.label ?? 'record';
  const scope = new Map(ctx.scope);
  for (const { alias, label: aliasLabel } of walk.aliases) scope.set(alias, { system, label: aliasLabel });
  const handlers: Handler[] = [];
  const flow = closed(lowerBody(block.body, { ...ctx, scope, returns: 'none', handlers }), 'Done');
  if (binding !== undefined) ctx.scope.set(binding, {});
  const before = walk.root === undefined && block.head.root?.kind === 'expression' ? effectsOf(factsOf(block.head.root.expr, ctx), ctx, {}) : [];
  return [
    ...before,
    {
      kind: 'scope',
      name: `For each ${system === undefined ? '' : `${system.display} `}${singular(label)}`,
      doc: [`Runs once per record of ${walk.text}`, ...(binding === undefined ? [] : [`Each run's return is collected into ${binding}.`])],
      touches: system === undefined ? [] : [{ system, direction: 'read' }],
      repeat: { sequential: true },
      body: { flow, handlers },
    },
  ];
}

interface CollectionSettings {
  concurrency?: number;
  onError?: string;
}

function lowerCollection(collection: CollectionOpExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const sourceFacts = factsOf(collection.source, ctx);
  const before = effectsOf(sourceFacts, ctx, {});
  const origin = provenanceOf(sourceFacts, ctx);
  const sourceName = collection.source.raw.trim();
  const settings = settingsOf(collection.config, ctx);
  const handlers: Handler[] = [];
  const scope = new Map(ctx.scope);
  let flow: Flow;
  const fn = collection.fn;
  if (fn.kind === 'closure') {
    const param = fn.closure.params[0];
    if (param !== undefined) scope.set(param.name, { system: origin.system, label: origin.label });
    flow = lowerBody(fn.closure.body, { ...ctx, scope, returns: 'none', handlers });
  } else {
    flow = lowerArmRef(fn.name, fn.span, { ...ctx, scope, handlers });
  }
  if (flow.length === 0 && handlers.length === 0) {
    fold(binding, span, {}, ctx);
    return before;
  }
  if (binding !== undefined) ctx.scope.set(binding, {});
  const label = origin.label === undefined ? sourceName : singular(origin.label);
  const what = `${origin.system === undefined ? '' : `${origin.system.display} `}${label}`;
  const verb = collection.op === 'map' ? 'For each' : `${capitalise(collection.op)} each`;
  const notes: string[] = [];
  if (settings.concurrency !== undefined && settings.concurrency > 1) notes.push(`up to ${settings.concurrency} at once`);
  if (settings.onError === 'warn') notes.push('failures skipped');
  const doc = [
    `${collection.op}(${sourceName}, …): runs once per member${binding === undefined ? '' : `, collected into ${binding}`}.`,
    settings.concurrency === undefined
      ? 'No concurrency setting: members run one at a time.'
      : `Concurrency limit ${settings.concurrency} (BPMN cannot express the limit; it is noted here).`,
    ...(settings.onError === undefined ? [] : [`onError: "${settings.onError}" — a failing member is reported and the others carry on.`]),
    sourceOf(ctx.index, span),
  ];
  return [
    ...before,
    {
      kind: 'scope',
      name: `${verb} ${what}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
      doc,
      touches: [],
      repeat: { sequential: !(settings.concurrency !== undefined && settings.concurrency > 1) },
      body: { flow: closed(flow, 'Done'), handlers },
    },
  ];
}

/** The settings record's `concurrency` and `onError`, where written as
 *  literals. */
function settingsOf(slot: ExprSlot | undefined, ctx: Context): CollectionSettings {
  if (slot === undefined) return {};
  try {
    const tree = treeOfSlot(slot);
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
  const facts = emptyFacts();
  for (const arm of statement.arms) mergeFacts(facts, factsOf(arm.condition, ctx));
  const before = effectsOf(facts, ctx, {});
  const branch = (body: Statement[]): Flow => lowerBody(body, { ...ctx, scope: new Map(ctx.scope) });
  return [
    ...before,
    {
      kind: 'choice',
      arms: statement.arms.map((arm) => ({ condition: oneLine(arm.condition.raw), flow: branch(arm.body) })),
      otherwise: statement.elseArm === undefined ? undefined : branch(statement.elseArm.body),
      doc: usesOf(facts, ctx),
    },
  ];
}

function lowerReturn(value: RValue, span: Span, ctx: Context): Step[] {
  const text = value.kind === 'expr' ? oneLine(value.expr.raw) : undefined;
  const before = value.kind === 'expr' ? effectsOf(factsOf(value.expr, ctx), ctx, { purpose: 'return value' }) : lowerValue(value, undefined, span, ctx);
  const end: EndStep = {
    kind: 'end',
    end: ctx.returns,
    name: text === undefined || text.length > 30 || text.includes('${') ? 'Return' : `Return ${text}`,
    doc: [sourceOf(ctx.index, span)],
  };
  return [...before, end];
}

// ── Waits ──

function lowerAwait(expression: AwaitExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const source = expression.source;
  const doc = [sourceOf(ctx.index, span)];
  switch (source.kind) {
    case 'traversal':
    case 'first':
      return [waitOnEdge(source.head, binding, doc, ctx)];
    case 'sleep':
      return [
        {
          kind: 'wait',
          trigger: { kind: 'timer', isoDuration: isoDuration(source.duration.raw) },
          name: `Wait ${describeDuration(source.duration.raw)}`,
          doc,
          touches: [],
        },
      ];
    case 'until': {
      const condition = source.condition;
      let text: string;
      const facts = emptyFacts();
      if (condition.kind === 'expr') {
        text = oneLine(condition.expr.raw);
        mergeFacts(facts, factsOf(condition.expr, ctx));
      } else {
        const ret = [...condition.closure.body].reverse().find((s) => s.kind === 'return');
        text = ret?.kind === 'return' && ret.value.kind === 'expr' ? oneLine(ret.value.expr.raw) : 'the condition holds';
        for (const statement of condition.closure.body) mergeFacts(facts, factsOfStatement(statement, ctx));
      }
      const every = source.every === undefined ? 'every 1 hour (the default)' : `every ${describeDuration(source.every.raw)}`;
      const systems = unique(
        facts.walks.flatMap((walk) => {
          const system = walk.root === undefined ? undefined : ctx.scope.get(walk.root)?.system;
          return system === undefined ? [] : [`${system.display} ${walk.labels.join(' → ')}`];
        }),
      );
      return [
        {
          kind: 'wait',
          trigger: { kind: 'condition', condition: text },
          name: `Wait until ${shorten(text, 40)}`,
          doc: [
            ...doc,
            `Re-checked ${every}.`,
            ...(systems.length > 0 ? [`Each check reads ${joinWords(systems)}.`] : []),
          ],
          touches: [],
        },
      ];
    }
    case 'combinator':
      return lowerCombinator(source.combinator, binding, span, ctx);
    default:
      return unreachable(source);
  }
}

function factsOfStatement(statement: Statement, ctx: Context): ExpressionFacts {
  switch (statement.kind) {
    case 'assign':
    case 'return':
      return statement.value.kind === 'expr'
        ? factsOf(statement.value.expr, ctx)
        : statement.value.kind === 'call' && statement.value.call.expression !== undefined
          ? factsOf(statement.value.call.expression, ctx)
          : emptyFacts();
    case 'call':
      return factsOf(statement.expression, ctx);
    default:
      return emptyFacts();
  }
}

function waitOnEdge(head: PathHead, binding: string | undefined, doc: string[], ctx: Context): WaitStep {
  const walk = walkOfHead(head, warner(ctx.index));
  const rootName = walk.root;
  const root = rootName === undefined ? undefined : ctx.scope.get(rootName);
  const edge = walk.labels.at(-1) ?? 'event';
  if (binding !== undefined) ctx.scope.set(binding, { system: root?.system, label: edge });
  if (root?.role === 'callback' && rootName !== undefined) {
    const name = edge === 'Called' ? `Wait for ${rootName} to be called` : `Wait for ${rootName} ${edge}`;
    return { kind: 'wait', trigger: { kind: 'message', message: `${rootName} ${edge}` }, name, doc, touches: [] };
  }
  if (root?.role === 'ask' && root.system !== undefined) {
    return {
      kind: 'wait',
      trigger: { kind: 'message', message: `${rootName ?? 'ask'} ${edge}` },
      name: `Wait for answer: ${root.prompt ?? rootName}`,
      doc,
      touches: [{ system: root.system, direction: 'read' }],
    };
  }
  const where = root?.system === undefined ? (rootName === undefined ? '' : `${rootName} `) : `${root.system.display} `;
  return {
    kind: 'wait',
    trigger: { kind: 'message', message: `${where}${edge}` },
    name: `Wait for ${where}${singular(edge)}`,
    doc,
    touches: root?.system === undefined ? [] : [{ system: root.system, direction: 'read' }],
  };
}

// ── race / all ──

function lowerCombinator(combinator: CombinatorExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  if (binding !== undefined) ctx.scope.set(binding, {});
  if (combinator.arms.kind === 'dynamic') {
    return [unmapped(`${combinator.kind} over arms built at run time`, span, ctx)];
  }
  const doc = [sourceOf(ctx.index, span)];
  const arms = writtenArms(combinator.arms);
  const settings = settingsOf(combinator.settings, ctx);
  switch (combinator.kind) {
    case 'race':
      return [lowerRace(arms, doc, ctx)];
    case 'all':
    case 'parallel': {
      const flows = arms.map((arm, position) => allArm(arm, position, ctx));
      if (settings.concurrency !== undefined) {
        doc.push(`Concurrency limit ${settings.concurrency} (BPMN cannot express the limit; it is noted here).`);
      }
      return [{ kind: 'all', arms: flows, doc }];
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
    return [{ kind: 'task', task: 'call', name, doc: [sourceOf(ctx.index, span)], touches: [], calls: ctx.index.processIds.get(name) }];
  }
  return [unmapped(`function value \`${name}\``, span, ctx)];
}

/** An `all` arm. Its last `return` is just the arm finishing; an earlier one
 *  ends the arm early, which BPMN can only say inside a subprocess (a bare
 *  end event in a parallel branch would starve the join). */
function allArm(arm: ArmExpression, position: number, ctx: Context): Flow {
  const handlers: Handler[] = [];
  const flow = lowerArm(arm, { ...ctx, returns: 'none', handlers });
  const last = flow.at(-1);
  if (last?.kind === 'end' && last.end === 'none') flow.pop();
  if (!containsReturn(flow) && handlers.length === 0) return flow;
  return [
    {
      kind: 'scope',
      name: `Arm ${position + 1}`,
      doc: ['An arm of all(…) that can return early.'],
      touches: [],
      body: { flow: closed(flow, 'Done'), handlers },
    },
  ];
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
  if (waits.every((wait) => wait !== undefined)) {
    return {
      kind: 'firstEvent',
      arms: waits.flatMap((wait) => (wait === undefined ? [] : [wait])),
      doc: [...doc, 'Ties: when arms settle in the same moment listen-fire lands every one; BPMN takes one.'],
    };
  }
  const handlers: Handler[] = [];
  const closedArms = flows.map((flow) =>
    flowEnds(flow) ? flow : [...flow, { kind: 'end' as const, end: 'terminate' as const, name: 'Finished first', doc: [] }],
  );
  return {
    kind: 'scope',
    name: 'Race: first to finish wins',
    doc: [
      ...doc,
      'Every arm starts at once; the first to reach a terminate end event ends the race and stops the rest.',
      'Ties: when arms settle in the same moment listen-fire lands every one; BPMN takes one.',
    ],
    touches: [],
    race: true,
    body: { flow: [{ kind: 'all', arms: closedArms, doc: [] }], handlers },
  };
}

/** An arm that is one wait and then, at most, a plain return. */
function singleWait(flow: Flow): { wait: WaitStep; result?: string } | undefined {
  const [first, second, ...rest] = flow;
  if (first?.kind !== 'wait' || rest.length > 0) return undefined;
  if (second === undefined) return { wait: first };
  if (second.kind === 'end' && second.end === 'terminate') {
    return { wait: first, result: second.name === 'Return' ? undefined : second.name.replace(/^Return /, '') };
  }
  return undefined;
}

// ── Callbacks ──

function lowerCallback(callback: CallbackExpression, binding: string | undefined, span: Span, ctx: Context): Step[] {
  const name = binding ?? 'callback';
  if (binding !== undefined) ctx.scope.set(binding, { role: 'callback' });
  const once = callback.config.find((arg) => arg.name === 'once');
  const repeatable = once !== undefined && once.value.raw.trim() === 'false';
  const handlers: Handler[] = [];
  const subject = callback.subject;
  let flow: Flow;
  if (subject.kind === 'inline') {
    const scope = new Map(ctx.scope);
    for (const param of subject.closure.params) scope.set(param.name, {});
    flow = lowerBody(subject.closure.body, { ...ctx, scope, returns: 'none', handlers });
  } else {
    flow = lowerArmRef(subject.movement, subject.span, { ...ctx, handlers });
  }
  ctx.handlers.push({
    name: `When ${name} is called`,
    message: `${name} Called`,
    interrupting: !repeatable,
    doc: [
      sourceOf(ctx.index, span),
      repeatable ? 'Repeatable: fires every time it is called.' : 'Fires at most once.',
      'It shares the run\'s data, as a callback shares the run\'s scope.',
    ],
    body: { flow: closed(flow, 'Done'), handlers },
  });
  return [];
}

// ── Helpers ──

function closed(flow: Flow, name: string): Flow {
  return flowEnds(flow) ? flow : [...flow, { kind: 'end', end: 'none', name, doc: [] }];
}

function unmapped(what: string, span: Span, ctx: Context): TaskStep {
  ctx.index.warnings.push(`line ${span.start.line}: no BPMN mapping yet for ${what}; drawn as an "Unmapped" task`);
  return { kind: 'task', task: 'unmapped', name: `Unmapped: ${what}`, doc: [sourceOf(ctx.index, span)], touches: [] };
}

function warner(index: ProgramIndex): (message: string) => void {
  return (message) => index.warnings.push(message);
}

/** The source text a span covers. */
function sourceOf(index: ProgramIndex, span: Span): string {
  const { start, end } = span;
  if (start.line === end.line) return (index.source[start.line - 1] ?? '').slice(start.col - 1, end.col - 1);
  const lines = [(index.source[start.line - 1] ?? '').slice(start.col - 1)];
  for (let line = start.line + 1; line < end.line; line++) lines.push(index.source[line - 1] ?? '');
  lines.push((index.source[end.line - 1] ?? '').slice(0, end.col - 1));
  return lines.join('\n');
}

function uniqueTouches(touches: Touch[]): Touch[] {
  const seen = new Set<string>();
  return touches.filter((touch) => {
    const key = `${touch.system.binding}/${touch.direction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

export function singular(label: string): string {
  if (/ies$/i.test(label)) return `${label.slice(0, -3)}y`;
  if (/[^s]s$/i.test(label)) return label.slice(0, -1);
  return label;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function unquote(raw: string): string {
  const text = raw.trim();
  return /^(["']).*\1$/s.test(text) ? text.slice(1, -1) : oneLine(text);
}

function shorten(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'function';
}

