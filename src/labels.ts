// The words a diagram puts on a step. Every label is the program's own text,
// read through its expression tree, with one fixed paraphrase: a null test is
// drawn as "no x" or "x found". Nothing is summarised or invented.

import { treeOfSlot, type ExprSlot, type LanguageVersion, type MExpr } from '@listen-fire/movement-lang';

/** A condition as a flow's label: `x == null` is "no x", `x != null` is
 *  "x found", and anything else is the condition as written. The condition
 *  expression in the file keeps the program's text either way. */
export function conditionLabel(slot: ExprSlot, languageVersion: LanguageVersion): string {
  const written = oneLine(slot.raw);
  const tree = treeOf(slot, languageVersion);
  if (tree === undefined) return written;
  const test = nullTest(tree);
  if (test === undefined) return written;
  const subject = oneLine(slot.raw.slice(test.subject.at.start, test.subject.at.end));
  return test.op === '==' ? `no ${subject}` : `${subject} found`;
}

function nullTest(tree: MExpr): { op: '==' | '!='; subject: MExpr } | undefined {
  const expr = tree.kind === 'paren' ? tree.expr : tree;
  if (expr.kind !== 'binary' || (expr.op !== '==' && expr.op !== '!=')) return undefined;
  if (isNull(expr.right)) return { op: expr.op, subject: expr.left };
  if (isNull(expr.left)) return { op: expr.op, subject: expr.right };
  return undefined;
}

function isNull(expr: MExpr): boolean {
  return expr.kind === 'literal' && expr.value === null;
}

/** A string as a label: its text, each `${…}` drawn as a marked blank,
 *  ‹email›, holding the interpolation's source. Anything but one string
 *  literal is shown as written. */
export function templateLabel(slot: ExprSlot, languageVersion: LanguageVersion): string {
  const tree = treeOf(slot, languageVersion);
  return tree === undefined ? oneLine(slot.raw) : templateText(tree, slot.raw);
}

/** `templateLabel` for an expression already read from `raw`, its source. */
export function templateText(tree: MExpr, raw: string): string {
  if (tree.kind !== 'string') return oneLine(raw.slice(tree.at.start, tree.at.end));
  return oneLine(tree.parts.map((part) => (typeof part === 'string' ? part : `‹${oneLine(raw.slice(part.at.start, part.at.end))}›`)).join(''));
}

function treeOf(slot: ExprSlot, languageVersion: LanguageVersion): MExpr | undefined {
  try {
    return treeOfSlot(slot, languageVersion);
  } catch {
    return undefined;
  }
}

/** A label cut to `length` characters, the cut marked. */
export function shorten(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
