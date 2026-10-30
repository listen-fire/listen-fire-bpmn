#!/usr/bin/env node
// listen-fire-bpmn <file.mvt> [-o out.bpmn]

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';

import { ProgramParseError, renderProgram } from './render.js';

const USAGE = 'usage: listen-fire-bpmn <file.mvt> [-o out.bpmn]';

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { output: { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
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
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    process.stderr.write(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  try {
    const { xml, warnings } = await renderProgram(source, { fileName: basename(file) });
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
    if (values.output === undefined) process.stdout.write(xml.endsWith('\n') ? xml : `${xml}\n`);
    else await writeFile(values.output, xml.endsWith('\n') ? xml : `${xml}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ProgramParseError) {
      process.stderr.write(`${file}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main();
