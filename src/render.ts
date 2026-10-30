// The whole pipeline: listen-fire source in, BPMN XML out.

import { initParser, parseProgram } from '@listen-fire/movement-lang';

import { renderBpmn } from './bpmn.js';
import { lowerProgram } from './lower.js';

export interface Rendering {
  xml: string;
  /** Things drawn as "Unmapped", or not drawn, each said once. */
  warnings: string[];
}

/** Thrown when the source does not parse; the message is the parser's. */
export class ProgramParseError extends Error {
  override readonly name = 'ProgramParseError';
}

export async function renderProgram(source: string, options: { fileName?: string } = {}): Promise<Rendering> {
  await initParser();
  let program;
  try {
    program = parseProgram(source);
  } catch (error) {
    throw new ProgramParseError(error instanceof Error ? error.message : String(error));
  }
  const diagram = lowerProgram(program, source, options);
  const xml = await renderBpmn(diagram);
  return { xml, warnings: [...new Set(diagram.warnings)] };
}
