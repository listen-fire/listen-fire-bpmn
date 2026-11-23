// What a value expression holds that the story analysis does not record as a
// node of its own: the model calls written in it (`ai(…)`), the names it reads
// (so folded assignments can be shown on the step that uses them), and any
// function body written inside it. Reads of connected systems come from the
// analysis (analysis.ts), never from here.

import { treeOfSlot, type ExprSlot, type LanguageVersion, type MExpr } from '@listen-fire/movement-lang';

import { oneLine, templateText } from './labels.js';

export interface ExpressionFacts {
  /** Each `ai(…)` call's prompt, its `${…}` drawn as blanks. */
  aiPrompts: string[];
  names: Set<string>;
  /** Functions with a statement body written inside an expression
   *  (`[x, ...map(xs, (p) => { … })]`). Their statements are not read here. */
  blockClosures: string[];
}

export function emptyFacts(): ExpressionFacts {
  return { aiPrompts: [], names: new Set(), blockClosures: [] };
}

export function mergeFacts(into: ExpressionFacts, from: ExpressionFacts): ExpressionFacts {
  into.aiPrompts.push(...from.aiPrompts);
  into.blockClosures.push(...from.blockClosures);
  for (const name of from.names) into.names.add(name);
  return into;
}

/** Facts of one slot. A slot the expression grammar refuses is reported
 *  through `warn` and contributes nothing. */
export function factsOfSlot(slot: ExprSlot, languageVersion: LanguageVersion, warn: (message: string) => void): ExpressionFacts {
  let tree: MExpr;
  try {
    tree = treeOfSlot(slot, languageVersion);
  } catch (error) {
    warn(`could not read the expression \`${oneLine(slot.raw)}\` (${messageOf(error)})`);
    return emptyFacts();
  }
  const facts = emptyFacts();
  visit(tree, slot.raw, facts);
  return facts;
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
      const prompt = expr.args[0]?.value;
      if (callee !== undefined && callee.toLowerCase() === 'ai' && prompt !== undefined) {
        facts.aiPrompts.push(templateText(prompt, source));
      }
      if (callee === undefined) recurse(expr.callee);
      for (const arg of expr.args) recurse(arg.value);
      return;
    }
    case 'path':
      recurse(expr.root);
      for (const hop of expr.hops) {
        recurse(hop.where);
        recurse(hop.config);
        recurse(hop.orderBy?.key);
      }
      return;
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
      throw new Error('`lazy` reached the renderer; the checker refuses it from 0.14, so a checked program never holds it');
    default:
      return unhandled(expr);
  }
}

function unhandled(value: never): never {
  throw new Error(`unhandled expression: ${JSON.stringify(value)}`);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
