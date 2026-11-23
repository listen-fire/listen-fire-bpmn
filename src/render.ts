// The whole pipeline: a checked program in, BPMN XML out. Only a program
// whose check has no error is drawn; any other gets its check's diagnostics
// back, so the picture can never disagree with what the checker decided.

import {
  SUPPORTED_STORY_ANALYSIS_VERSIONS,
  diagnosticSeverity,
  initParser,
  languageVersionDiagnostic,
  parseProgram,
  type Diagnostic,
  type LanguageVersion,
  type StoryAnalysis,
} from '@listen-fire/movement-lang';

import { AnalysisIndex } from './analysis.js';
import { renderBpmn } from './bpmn.js';
import { lowerProgram } from './lower.js';
import { FIRST_PARTY_VOCABULARY, type Vocabulary } from './vocabulary.js';

/** This renderer's release. Its line reads the programs of one listen-fire
 *  compatibility key: this one reads 0.16. */
export const RENDERER_VERSION = '0.16.1';

export type Rendering =
  | {
      ok: true;
      xml: string;
      /** Things drawn as "Unmapped", or not drawn, each said once. */
      warnings: string[];
    }
  | {
      ok: false;
      /** The check's errors (with its other diagnostics), or the refusal of
       *  the program's pin. */
      diagnostics: Diagnostic[];
    };

export interface RenderInput {
  /** The checker's story analysis of `source`: `storyAnalysisInRust(source,
   *  snapshot, { languageVersion })`. */
  analysis: StoryAnalysis;
  /** The pin the program is saved with: the release it was written against. */
  languageVersion: LanguageVersion;
  /** What to call each system, by adapter. Defaults to the first-party names. */
  vocabulary?: Vocabulary;
  /** The file's name, for the documentation. */
  fileName?: string;
}

export async function renderProgram(source: string, input: RenderInput): Promise<Rendering> {
  const refusal = languageVersionDiagnostic(input.languageVersion);
  if (refusal !== undefined) return { ok: false, diagnostics: [refusal] };
  if (!SUPPORTED_STORY_ANALYSIS_VERSIONS.includes(input.analysis.storyAnalysisVersion)) {
    throw new Error(
      `story analysis version ${input.analysis.storyAnalysisVersion} is not one this renderer reads (${SUPPORTED_STORY_ANALYSIS_VERSIONS.join(', ')})`,
    );
  }
  // A pin the analysing release does not read comes back as its version
  // diagnostic alone, with every list empty; a read analysis always has the
  // file's scope.
  if (input.analysis.scopes.length === 0 || input.analysis.diagnostics.some((d) => diagnosticSeverity(d) === 'error')) {
    return { ok: false, diagnostics: input.analysis.diagnostics };
  }
  await initParser();
  const program = parseProgram(source, { languageVersion: input.languageVersion });
  const diagram = lowerProgram({
    program,
    source,
    analysis: new AnalysisIndex(input.analysis, input.vocabulary ?? FIRST_PARTY_VOCABULARY),
    languageVersion: input.languageVersion,
    ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
  });
  const xml = await renderBpmn(diagram, { exporterVersion: RENDERER_VERSION });
  return { ok: true, xml, warnings: [...new Set(diagram.warnings)] };
}
