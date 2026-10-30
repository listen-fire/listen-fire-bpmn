import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProgramParseError, renderProgram } from '../src/render.js';
import { readBack } from './check.js';

const fixtures = join(import.meta.dirname, 'fixtures');

async function render(name: string) {
  const source = await readFile(join(fixtures, `${name}.mvt`), 'utf8');
  const rendering = await renderProgram(source, { fileName: `${name}.mvt` });
  return { ...rendering, reading: await readBack(rendering.xml) };
}

const names = (reading: Awaited<ReturnType<typeof readBack>>, type: string) =>
  reading.nodes.filter((node) => node.type === type).map((node) => node.name);

describe.each(['github-triage', 'expense-approval', 'support-email-triage', 'deal-review'])('%s', (name) => {
  it('re-reads cleanly, every node connected and drawn', async () => {
    const { reading, xml } = await render(name);
    expect(reading.warnings).toEqual([]);
    expect(reading.orphans).toEqual([]);
    expect(reading.undrawn).toEqual([]);
    expect(reading.overlaps).toEqual([]);
    await expect(xml).toMatchFileSnapshot(join(import.meta.dirname, '..', 'examples', `${name}.bpmn`));
  });
});

describe('the mapping', () => {
  it('github triage: timer start, read, traversal subprocess, branches, error end, send', async () => {
    const { reading, warnings } = await render('github-triage');
    expect(warnings).toEqual([]);
    expect(names(reading, 'bpmn:StartEvent')[0]).toBe('On schedule 30 8 * * 1-5');
    expect(names(reading, 'bpmn:SubProcess')).toEqual(['For each GitHub Notification']);
    expect(names(reading, 'bpmn:ServiceTask')).toContain('Read Slack Channels');
    expect(names(reading, 'bpmn:SendTask')).toEqual(['Post to Slack channel']);
    expect(names(reading, 'bpmn:EndEvent')).toContain('Fail: no #general channel');
    expect(reading.participants).toEqual(['triage', 'GitHub', 'Slack']);
  });

  it('expense approval: a race of single waits is an event-based gateway', async () => {
    const { reading, warnings } = await render('expense-approval');
    expect(warnings).toEqual([]);
    expect(names(reading, 'bpmn:EventBasedGateway')).toHaveLength(1);
    expect(names(reading, 'bpmn:IntermediateCatchEvent')).toEqual([
      'Wait for approve to be called',
      'Wait for reject to be called',
      'Wait 1 day',
    ]);
    expect(names(reading, 'bpmn:SubProcess')).toEqual(['When approve is called', 'When reject is called']);
    expect(names(reading, 'bpmn:ServiceTask')).toContain('Update Airtable Record');
    expect(names(reading, 'bpmn:StartEvent')[0]).toBe('On Airtable Record Change');
  });

  it('support triage: a message start from email, an AI extraction, sends to Slack and Gmail', async () => {
    const { reading, warnings } = await render('support-email-triage');
    expect(warnings).toEqual([]);
    expect(names(reading, 'bpmn:StartEvent')).toEqual(['On new Email']);
    expect(names(reading, 'bpmn:ServiceTask')).toContain('Extract Verdict (AI)');
    expect(names(reading, 'bpmn:SendTask')).toEqual(['Post to Slack channel', 'Send Gmail message']);
    expect(reading.participants).toEqual(['triage', 'Email', 'Slack', 'Gmail']);
  });

  it('deal review: map, all, an ask, a race of several steps, await until, a callback, a call', async () => {
    const { reading, warnings } = await render('deal-review');
    expect(warnings).toEqual([]);
    expect(names(reading, 'bpmn:SubProcess')).toEqual([
      'For each Airtable Deal (up to 4 at once, failures skipped)',
      'Race: first to finish wins',
      'When more is called',
    ]);
    expect(names(reading, 'bpmn:ParallelGateway')).toHaveLength(3);
    expect(names(reading, 'bpmn:UserTask')).toEqual(['Ask: Approve the negotiation batch?']);
    expect(names(reading, 'bpmn:IntermediateCatchEvent')).toEqual([
      'Wait for answer: Approve the negotiation batch?',
      'Wait 2 days',
      'Wait until lead != null',
    ]);
    expect(names(reading, 'bpmn:CallActivity')).toEqual(['Notify owner']);
    expect(reading.participants).toContain('Notify owner');
    expect(names(reading, 'bpmn:ServiceTask')).toEqual(
      expect.arrayContaining(['Extract Risk (AI)', 'Generate headline (AI)', 'Update Airtable Deal']),
    );
    expect(names(reading, 'bpmn:EndEvent').filter((name) => name === 'Return "approved"')).toHaveLength(1);
  });
});

describe('what it cannot map', () => {
  it('draws an Unmapped task and warns, rather than dropping the statement', async () => {
    const source = [
      'go = manual()',
      'function f(run: <go-[:invocation]->>) {',
      '  x = { y = 1 }.y',
      '}',
      'listen to go {} fire f',
    ].join('\n');
    const { xml, warnings } = await renderProgram(source);
    const reading = await readBack(xml);
    expect(reading.nodes.some((node) => node.name.startsWith('Unmapped: '))).toBe(true);
    expect(warnings.some((warning) => warning.includes('Unmapped'))).toBe(true);
    expect(reading.orphans).toEqual([]);
  });

  it('refuses a file that does not parse, with the parser\'s message', async () => {
    await expect(renderProgram('function f( {')).rejects.toBeInstanceOf(ProgramParseError);
  });
});
