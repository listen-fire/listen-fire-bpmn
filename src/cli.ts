#!/usr/bin/env node
// listen-fire-bpmn <file.mvt> --catalog <snapshot.json> --pin <version> [--vocabulary <words.json>] [-o out.bpmn]

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';

import {
  RustCheckRefused,
  diagnosticSeverity,
  initParser,
  storyAnalysisInRust,
  type CatalogSnapshot,
  type Diagnostic,
} from '@listen-fire/movement-lang';

import { messageOf } from './expressions.js';
import { renderProgram } from './render.js';
import { FIRST_PARTY_VOCABULARY, vocabularyFrom, type Vocabulary } from './vocabulary.js';

const USAGE = 'usage: listen-fire-bpmn <file.mvt> --catalog <snapshot.json> --pin <version> [--vocabulary <words.json>] [-o out.bpmn]';

const NO_CATALOG = [
  'listen-fire-bpmn draws only a program that checks, and the check needs the catalog of the systems it connects to.',
  'In the program\'s project folder, write a catalog snapshot and pass it:',
  '  listen-fire catalog --json > catalog.json',
  '  listen-fire-bpmn <file.mvt> --catalog catalog.json --pin <version>',
].join('\n');

const NO_PIN = [
  'listen-fire-bpmn reads a program by the language version it is pinned to, and draws nothing on a guess.',
  'Pass the pin: in a project folder it is `engine:` in lf.yaml (--pin 0.16.1).',
].join('\n');

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        catalog: { type: 'string' },
        pin: { type: 'string' },
        vocabulary: { type: 'string' },
        output: { type: 'string', short: 'o' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const [file, ...extra] = positionals;
  if (file === undefined || extra.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (values.catalog === undefined) {
    process.stderr.write(`${NO_CATALOG}\n`);
    return 2;
  }
  if (values.pin === undefined) {
    process.stderr.write(`${NO_PIN}\n`);
    return 2;
  }
  let source: string;
  let snapshot: CatalogSnapshot;
  let vocabulary: Vocabulary = FIRST_PARTY_VOCABULARY;
  try {
    source = await readFile(file, 'utf8');
    snapshot = snapshotFrom(JSON.parse(await readFile(values.catalog, 'utf8')), values.catalog);
    if (values.vocabulary !== undefined) {
      vocabulary = { ...FIRST_PARTY_VOCABULARY, ...vocabularyFrom(JSON.parse(await readFile(values.vocabulary, 'utf8'))) };
    }
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return 1;
  }
  await initParser();
  let analysis;
  try {
    analysis = storyAnalysisInRust(source, snapshot, { languageVersion: values.pin });
  } catch (error) {
    if (!(error instanceof RustCheckRefused)) throw error;
    const at = error.loc === undefined ? '' : `:${error.loc.line}:${error.loc.col}`;
    process.stderr.write(`${file}${at}: ${error.message}\n`);
    return 1;
  }
  const rendering = await renderProgram(source, { analysis, languageVersion: values.pin, vocabulary, fileName: basename(file) });
  if (!rendering.ok) {
    for (const diagnostic of rendering.diagnostics) process.stderr.write(`${describe(file, diagnostic)}\n`);
    process.stderr.write('not drawn: only a program that checks under its pin is drawn\n');
    return 1;
  }
  for (const warning of rendering.warnings) process.stderr.write(`warning: ${warning}\n`);
  const xml = rendering.xml.endsWith('\n') ? rendering.xml : `${rendering.xml}\n`;
  if (values.output === undefined) process.stdout.write(xml);
  else await writeFile(values.output, xml);
  return 0;
}

function describe(file: string, diagnostic: Diagnostic): string {
  const { line, col } = diagnostic.span.start;
  return `${file}:${line}:${col} ${diagnosticSeverity(diagnostic)} ${diagnostic.code} ${diagnostic.message}`;
}

/** The snapshot `listen-fire catalog --json` writes; the checker refuses one
 *  it cannot load, by name, so only its outline is checked here. */
function snapshotFrom(value: unknown, path: string): CatalogSnapshot {
  if (!isSnapshot(value)) throw new Error(`${path} is not a catalog snapshot (write one with \`listen-fire catalog --json\`)`);
  return value;
}

function isSnapshot(value: unknown): value is CatalogSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  return 'contractVersion' in value && typeof value.contractVersion === 'number' && 'adapters' in value && typeof value.adapters === 'object';
}

process.exitCode = await main();
