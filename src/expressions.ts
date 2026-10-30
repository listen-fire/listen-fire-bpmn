// What a value expression does that the diagram must show: the walks it takes
// (reads, when they start from a connected system), the model calls in it
// (`ai(…)`), and the names it reads (so folded assignments can be shown on
// the task that uses them). Expressions are otherwise folded into the task
// that holds them.

import { probePathHead, treeOfSlot, type ExprSlot, type MExpr, type PathHead } from '@listen-fire/movement-lang';

type Hop = Extract<MExpr, { kind: 'path' }>['hops'][number];

/** One walk, as written. `root` is the name it starts from, where it has one. */
export interface Walk {
  root?: string;
  labels: string[];
  /** Hop aliases, each with its label (`n` in `-[n:Notifications]->`). */
  aliases: Array<{ alias: string; label: string }>;
  text: string;
}

export interface ExpressionFacts {
  walks: Walk[];
  /** The prompt of each `ai(…)` call, as written. */
  aiCalls: string[];
  names: Set<string>;
  /** Functions with a statement body written inside an expression
   *  (`[x, ...map(xs, (p) => { … })]`). Their statements are not read here. */
  blockClosures: string[];
}

export function emptyFacts(): ExpressionFacts {
  return { walks: [], aiCalls: [], names: new Set(), blockClosures: [] };
}

export function mergeFacts(into: ExpressionFacts, from: ExpressionFacts): ExpressionFacts {
  into.walks.push(...from.walks);
  into.aiCalls.push(...from.aiCalls);
  into.blockClosures.push(...from.blockClosures);
  for (const name of from.names) into.names.add(name);
  return into;
}

/** Facts of one slot. A slot the expression grammar refuses is reported
 *  through `warn` and contributes nothing. */
export function factsOfSlot(slot: ExprSlot, warn: (message: string) => void): ExpressionFacts {
  let tree: MExpr;
  try {
    tree = treeOfSlot(slot);
  } catch (error) {
    warn(`could not read the expression \`${oneLine(slot.raw)}\` (${messageOf(error)}); its reads are not drawn`);
    return emptyFacts();
  }
  const facts = emptyFacts();
  visit(tree, slot.raw, facts);
  return facts;
}

/** The walk a path head takes — a traversal block's, a write's target, an
 *  await's. */
export function walkOfHead(head: PathHead, warn: (message: string) => void): Walk {
  const raw = probePathHead(head);
  const display = head.root === undefined ? head.hopsRaw : spellHead(head);
  const root = head.root?.kind === 'name' ? head.root.name : undefined;
  try {
    const tree = treeOfSlot({ raw, span: head.span });
    if (tree.kind === 'path') return { root, ...hopsOf(tree.hops), text: display };
  } catch (error) {
    warn(`could not read the walk \`${oneLine(display)}\` (${messageOf(error)})`);
  }
  return { root, labels: [], aliases: [], text: display };
}

function spellHead(head: PathHead): string {
  const root = head.root;
  if (root === undefined) return head.hopsRaw;
  return `${root.kind === 'name' ? root.name : root.expr.raw}${head.hopsRaw}`;
}

function hopsOf(hops: Hop[]): Pick<Walk, 'labels' | 'aliases'> {
  return {
    labels: hops.map((hop) => hop.label.text),
    aliases: hops.flatMap((hop) => (hop.alias === undefined ? [] : [{ alias: hop.alias.text, label: hop.label.text }])),
  };
}

function rootName(expr: MExpr | undefined): string | undefined {
  if (expr === undefined) return undefined;
  switch (expr.kind) {
    case 'name':
      return expr.field === true ? undefined : expr.name.text;
    case 'member':
    case 'index':
      return rootName(expr.object);
    case 'paren':
      return rootName(expr.expr);
    case 'path':
      return rootName(expr.root);
    case 'call':
      return rootName(expr.args[0]?.value);
    default:
      return undefined;
  }
}

function visit(expr: MExpr, source: string, facts: ExpressionFacts): void {
  const recurse = (child: MExpr | undefined): void => {
    if (child !== undefined) visit(child, source, facts);
  };
  switch (expr.kind) {
    case 'literal':
    case 'special':
    case 'type':
    case 'declaration':
      return;
    case 'name':
      if (expr.field !== true) facts.names.add(expr.name.text);
      return;
    case 'string':
      for (const part of expr.parts) if (typeof part !== 'string') recurse(part);
      return;
    case 'paren':
      recurse(expr.expr);
      return;
    case 'list':
      for (const element of expr.elements) recurse(element.kind === 'spread' ? element.expr : element);
      return;
    case 'map':
      for (const member of expr.entries) recurse('kind' in member ? member.expr : member.value);
      return;
    case 'member':
      recurse(expr.object);
      return;
    case 'index':
      recurse(expr.object);
      recurse(expr.index);
      return;
    case 'call': {
      const callee = expr.callee.kind === 'name' ? expr.callee.name.text : undefined;
      if (callee !== undefined && callee.toLowerCase() === 'ai') {
        facts.aiCalls.push(source.slice(expr.at.start, expr.at.end));
      }
      if (callee === undefined) recurse(expr.callee);
      for (const arg of expr.args) recurse(arg.value);
      return;
    }
    case 'path': {
      facts.walks.push({ root: rootName(expr.root), ...hopsOf(expr.hops), text: source.slice(expr.at.start, expr.at.end) });
      recurse(expr.root);
      for (const hop of expr.hops) {
        recurse(hop.where);
        recurse(hop.config);
        recurse(hop.orderBy?.key);
      }
      return;
    }
    case 'unary':
      recurse(expr.operand);
      return;
    case 'binary':
      recurse(expr.left);
      recurse(expr.right);
      return;
    case 'exists':
    case 'within':
      recurse(expr.operand);
      return;
    case 'where':
      recurse(expr.source);
      recurse(expr.predicate);
      return;
    case 'is':
      recurse(expr.subject);
      return;
    case 'if':
      recurse(expr.condition);
      recurse(expr.then);
      recurse(expr.else);
      return;
    case 'closure':
      if (expr.body.kind === 'expr') recurse(expr.body.expr);
      else facts.blockClosures.push(source.slice(expr.at.start, expr.at.end));
      return;
    case 'node':
    case 'graph':
      for (const entry of expr.entries) if (entry.value.kind !== 'declaredEdge') recurse(entry.value);
      if (expr.kind === 'graph') for (const spread of expr.spreads) recurse(spread);
      return;
    case 'mapped':
      recurse(expr.source);
      recurse(expr.body);
      return;
    case 'lazy':
      recurse(expr.walk);
      return;
    default:
      return unhandled(expr);
  }
}

function unhandled(value: never): never {
  throw new Error(`unhandled expression: ${JSON.stringify(value)}`);
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
