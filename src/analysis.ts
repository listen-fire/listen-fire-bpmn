// The join between the parse tree and the checker's story analysis
// (listen-fire's docs/contracts/story-analysis.md). Every analysis entry
// carries the span of the syntax node it describes, so the renderer walks the
// parse tree for order and nesting and asks the analysis, by span, what each
// node touches. It never resolves a name to a system itself.

import {
  resolveInAnalysis,
  type Span,
  type StoryAddress,
  type StoryAnalysis,
  type StoryNode,
  type StorySymbol,
  type StoryWalk,
  type StoryWrite,
} from '@listen-fire/movement-lang';

import type { System } from './flow.js';
import { resolveEventPhrase, type Vocabulary } from './vocabulary.js';

export type NodeOf<K extends StoryNode['kind']> = Extract<StoryNode, { kind: K }>;

/** A walk the analysis typed: where it starts and every hop's landing. */
export type WalkNode = NodeOf<'traversal'> | NodeOf<'valuePath'>;

/** A walk that reads a connected system. */
export interface Read {
  system: System;
  /** The edges walked, in order (`Invoices`, `Changes`). */
  edges: string[];
  /** The record type the last hop lands on, where the analysis typed it. */
  landing?: string;
}

export class AnalysisIndex {
  readonly systems: System[];
  private readonly byBinding: Map<string, System>;
  private readonly nodes = new Map<string, StoryNode[]>();
  private readonly writes = new Map<string, StoryWrite>();
  private readonly walks: WalkNode[] = [];

  constructor(
    private readonly analysis: StoryAnalysis,
    vocabulary: Vocabulary,
  ) {
    for (const node of analysis.nodes) {
      const key = spanKey(node.span);
      this.nodes.set(key, [...(this.nodes.get(key) ?? []), node]);
      if ((node.kind === 'traversal' || node.kind === 'valuePath') && node.steps.length > 0) this.walks.push(node);
    }
    for (const write of analysis.writes) this.writes.set(spanKey(write.span), write);
    this.systems = systemsOf(analysis, vocabulary);
    this.byBinding = new Map(this.systems.map((system) => [system.binding, system]));
  }

  system(binding: string): System | undefined {
    return this.byBinding.get(binding);
  }

  node<K extends StoryNode['kind']>(kind: K, span: Span): NodeOf<K> | undefined {
    return this.nodes.get(spanKey(span))?.find((node): node is NodeOf<K> => node.kind === kind);
  }

  write(span: Span): StoryWrite | undefined {
    return this.writes.get(spanKey(span));
  }

  /** The reads of connected systems that the walks inside `spans` make, in
   *  source order. A walk inside a write's target or a wait's head is not in
   *  an expression slot, so it is not among them. */
  readsWithin(spans: Span[]): Read[] {
    return this.walks
      .filter((walk) => spans.some((span) => contains(span, walk.span)))
      .sort((a, b) => compareLoc(a.span.start, b.span.start))
      .flatMap((walk) => {
        const read = this.readOf(walk);
        return read === undefined ? [] : [read];
      });
  }

  /** What a walk reads: the system its hops land in, else the one its root
   *  is a record of. A walk of the run host's own units reads no system. */
  readOf(walk: WalkNode): Read | undefined {
    const landed = walk.landings.find((landing): landing is StoryAddress => landing !== null);
    const instance = landed?.instance ?? (walk.root === undefined ? undefined : this.address(walk.root, walk.scope)?.instance);
    const system = instance === undefined ? undefined : this.system(instance);
    if (system === undefined) return undefined;
    const last = walk.landings.at(-1);
    return { system, edges: edgesOf(walk.steps), ...(last?.position === undefined ? {} : { landing: last.position }) };
  }

  /** The walk the analysis typed at exactly `span` (a block's or a wait's head). */
  walkAt(span: Span): WalkNode | undefined {
    return this.node('traversal', span) ?? this.node('valuePath', span);
  }

  /** The symbol `name` resolves to from the innermost scope around `at`. */
  symbol(name: string, at: Span): StorySymbol | undefined {
    return resolveInAnalysis(this.analysis, this.scopeAt(at), name);
  }

  /** Where the records `name` holds live, seen from `at`. */
  addressAt(name: string, at: Span): StoryAddress | undefined {
    return this.symbol(name, at)?.address;
  }

  private address(name: string, scope: number): StoryAddress | undefined {
    return resolveInAnalysis(this.analysis, scope, name)?.address;
  }

  private scopeAt(span: Span): number {
    let best: { span: Span; id: number } | undefined;
    this.analysis.scopes.forEach((scope, id) => {
      if (scope.span === undefined || !contains(scope.span, span)) return;
      if (best === undefined || contains(best.span, scope.span)) best = { span: scope.span, id };
    });
    return best?.id ?? 0;
  }
}

/** The connected systems: one per `connect` the analysis records as an
 *  instance node. The run host's units (`manual`, `cron`) have no node. */
function systemsOf(analysis: StoryAnalysis, vocabulary: Vocabulary): System[] {
  const instances = analysis.nodes.flatMap((node) =>
    node.kind === 'instance' && node.adapterType !== undefined ? [{ binding: node.name, adapter: node.adapterType }] : [],
  );
  const perAdapter = new Map<string, number>();
  for (const { adapter } of instances) perAdapter.set(adapter, (perAdapter.get(adapter) ?? 0) + 1);
  return instances.map(({ binding, adapter }) => {
    const words = vocabulary[adapter];
    const name = words?.name ?? adapter;
    const display = (perAdapter.get(adapter) ?? 0) > 1 ? `${name} (${binding})` : name;
    const startPhrase = resolveEventPhrase(words);
    return {
      binding,
      adapter,
      display,
      ...(words?.icon === undefined ? {} : { icon: words.icon }),
      ...(startPhrase === undefined ? {} : { startPhrase }),
    };
  });
}

type TraversalStep = StoryWalk['steps'][number];

export function edgesOf(steps: TraversalStep[]): string[] {
  return steps.flatMap((step) => (step.type === 'edge' ? [step.edgeTypeId] : []));
}

export function aliasesOf(steps: TraversalStep[]): string[] {
  return steps.flatMap((step) => (step.type === 'edge' && step.alias !== undefined ? [step.alias] : []));
}

export function spanKey(span: Span): string {
  return `${span.start.line}:${span.start.col}-${span.end.line}:${span.end.col}`;
}

export function contains(outer: Span, inner: Span): boolean {
  return compareLoc(outer.start, inner.start) <= 0 && compareLoc(inner.end, outer.end) <= 0;
}

function compareLoc(a: Span['start'], b: Span['start']): number {
  return a.line - b.line || a.col - b.col;
}
