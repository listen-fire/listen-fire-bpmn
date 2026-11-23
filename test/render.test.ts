import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initParser, storyAnalysisInRust, type CatalogSnapshot } from '@listen-fire/movement-lang';
import { describe, expect, it } from 'vitest';

import { RENDERER_VERSION, renderProgram, type RenderInput } from '../src/render.js';
import { readBack, type Reading } from './check.js';

const PIN = '0.16.1';
const fixtures = join(import.meta.dirname, 'fixtures');

/** The catalog each fixture checks against: the handbook's captured catalog,
 *  or the snapshot scripts/project-catalog.sh writes (it connects Stripe). */
const CATALOGS: Record<string, string> = {
  batch_approval: 'handbook',
  deal_review: 'handbook',
  github_triage: 'handbook',
  inbound_intake: 'handbook',
  payment_failed: 'project',
  support_email_triage: 'handbook',
  who_takes_it: 'handbook',
};

async function snapshot(name: string): Promise<CatalogSnapshot> {
  const parsed: CatalogSnapshot = JSON.parse(await readFile(join(fixtures, 'catalogs', `${name}.json`), 'utf8'));
  return parsed;
}

async function analyse(source: string, catalog: string, languageVersion = PIN) {
  await initParser();
  return storyAnalysisInRust(source, await snapshot(catalog), { languageVersion });
}

async function render(name: string, options: Partial<RenderInput> = {}) {
  const source = await readFile(join(fixtures, `${name}.mvt`), 'utf8');
  const analysis = await analyse(source, CATALOGS[name] ?? 'handbook');
  const rendering = await renderProgram(source, { analysis, languageVersion: PIN, fileName: `${name}.mvt`, ...options });
  if (!rendering.ok) throw new Error(`${name} does not check: ${JSON.stringify(rendering.diagnostics)}`);
  return { ...rendering, reading: await readBack(rendering.xml) };
}

const names = (reading: Reading, type: string) => reading.nodes.filter((node) => node.type === type).map((node) => node.name);
const node = (reading: Reading, name: string) => reading.nodes.find((candidate) => candidate.name === name);

describe.each(Object.keys(CATALOGS))('%s', (name) => {
  it('re-reads cleanly: every node connected and drawn, no shape or label over another', async () => {
    const { reading, xml, warnings } = await render(name);
    expect(warnings).toEqual([]);
    expect(reading.warnings).toEqual([]);
    expect(reading.orphans).toEqual([]);
    expect(reading.undrawn).toEqual([]);
    expect(reading.overlaps).toEqual([]);
    expect(reading.labelClashes).toEqual([]);
    await expect(xml).toMatchFileSnapshot(join(import.meta.dirname, '..', 'examples', `${name}.bpmn`));
  });
});

describe('the mapping', () => {
  it('inbound intake: a start on the listen path, an AI extraction, a guarded write', async () => {
    const { reading } = await render('inbound_intake');
    expect(names(reading, 'bpmn:StartEvent')).toEqual(['On Email Emails\n→ e']);
    expect(names(reading, 'bpmn:ServiceTask')).toEqual(['Extract Company (AI)\n→ company', 'Write Attio Companies']);
    expect(names(reading, 'bpmn:EndEvent')).toEqual(['Fail: no company in ‹e.Subject›', 'Done']);
    expect(reading.participants).toEqual(['Intake', 'Email', 'Attio']);
    expect(reading.messageFlows).toEqual([
      { name: 'reads Emails', from: 'Email', to: 'On Email Emails\n→ e' },
      { name: 'writes Companies', from: 'Write Attio Companies', to: 'Attio' },
    ]);
  });

  it('payment failed: systems from connect, reads named by their results, branches on the plan', async () => {
    const { reading } = await render('payment_failed');
    expect(names(reading, 'bpmn:StartEvent')).toEqual(['On Stripe Invoices › Changes\n→ c']);
    expect(names(reading, 'bpmn:ServiceTask')).toEqual([
      'Read Stripe Invoice\n→ invoice',
      'Read Attio People\n→ person',
      'Write Gmail Messages',
      'Read Slack Channels\n→ channel',
      'Write Slack Messages',
    ]);
    expect(reading.participants).toEqual(['Payment Failed', 'Stripe', 'Attio', 'Gmail', 'Slack']);
  });

  it('github triage: a cron start reads its schedule from the path, a traversal block is a subprocess', async () => {
    const { reading, xml } = await render('github_triage');
    expect(names(reading, 'bpmn:StartEvent')[0]).toBe('On schedule 30 8 * * 1-5\n→ t');
    expect(xml).toContain('<bpmn:timeCycle xsi:type="bpmn:tFormalExpression">30 8 * * 1-5</bpmn:timeCycle>');
    expect(names(reading, 'bpmn:SubProcess')).toEqual(['For each GitHub Notification\n→ lines']);
    expect(names(reading, 'bpmn:ServiceTask')).toContain('Read GitHub Pull Request and Issue\n→ url');
    expect(names(reading, 'bpmn:EndEvent')).toContain('Fail: no #general channel');
    expect(reading.participants).toEqual(['triage', 'GitHub', 'Slack']);
  });

  it('batch approval: an ask is a user task, and its await a message wait on the Asks pool', async () => {
    const { reading } = await render('batch_approval');
    expect(names(reading, 'bpmn:UserTask')).toEqual(['Ask: Add ‹go.Text› to the pipeline?\n→ q']);
    expect(names(reading, 'bpmn:IntermediateCatchEvent')).toEqual(['Wait for Response on q\n→ a']);
    expect(reading.messageFlows).toContainEqual({ name: 'reads Response', from: 'Asks', to: 'Wait for Response on q\n→ a' });
    expect(names(reading, 'bpmn:StartEvent')).toEqual(['Started manually\n→ go']);
  });

  it('who takes it: a race of a reply and a timeout is an event-based gateway', async () => {
    const { reading } = await render('who_takes_it');
    expect(names(reading, 'bpmn:EventBasedGateway')).toHaveLength(1);
    expect(names(reading, 'bpmn:IntermediateCatchEvent')).toEqual(['Wait for Replies on msg\n→ reply', 'Wait 1 day']);
    expect(reading.sequenceFlows.map((flow) => flow.name)).toContain('reply.Message');
  });

  it('support triage: an AI extraction, then branches on its category', async () => {
    const { reading } = await render('support_email_triage');
    expect(names(reading, 'bpmn:ServiceTask')).toContain('Extract Verdict (AI)\n→ verdict');
    expect(reading.participants).toEqual(['triage', 'Email', 'Slack', 'Gmail']);
  });

  it('deal review: map, all, a call, an ai(…) prompt and an until', async () => {
    const { reading } = await render('deal_review');
    expect(names(reading, 'bpmn:SubProcess')).toEqual(['For each Attio Companies (up to 4 at once, failures skipped)']);
    expect(names(reading, 'bpmn:ServiceTask')).toEqual(
      expect.arrayContaining(['Extract Risk (AI)\n→ risk', 'AI: a five word headline for ‹c.Name›\n→ headline', 'Write Attio Notes']),
    );
    expect(names(reading, 'bpmn:CallActivity')).toEqual(['Notify owners']);
    expect(reading.participants).toContain('Notify owners');
    expect(names(reading, 'bpmn:IntermediateCatchEvent')).toEqual(['Wait until lead.Description != ""']);
    expect(names(reading, 'bpmn:ParallelGateway')).toHaveLength(2);
  });
});

describe('the legibility rules', () => {
  it('a null test is drawn as "no x" or "x found", and the condition keeps the program\'s text', async () => {
    const { reading } = await render('payment_failed');
    expect(reading.sequenceFlows).toContainEqual({ name: 'no invoice', condition: 'invoice == null' });
    expect(reading.sequenceFlows).toContainEqual({ name: 'no person', condition: 'person == null' });
    expect(reading.sequenceFlows).toContainEqual({ name: 'person.Plan == "monthly"', condition: 'person.Plan == "monthly"' });
    const { reading: deals } = await render('deal_review');
    expect(deals.sequenceFlows).toContainEqual({ name: 'ops found', condition: 'ops != null' });
  });

  it('each ${…} in a failure message is a marked blank', async () => {
    const { reading } = await render('payment_failed');
    expect(names(reading, 'bpmn:EndEvent')).toEqual(
      expect.arrayContaining([
        'Fail: payment_failed event ‹c.Id› has no invoice',
        'Fail: ‹email› not found in the CRM (invoice ‹invoice.Id›)',
        'Fail: ‹email› has no plan in the CRM (invoice ‹invoice.Id›)',
      ]),
    );
  });

  it('each message flow says what it reads or writes', async () => {
    const { reading } = await render('payment_failed');
    expect(reading.messageFlows.map((flow) => flow.name)).toEqual([
      'reads Invoices › Changes',
      'reads Invoice',
      'reads People',
      'writes Messages',
      'reads Channels',
      'writes Messages',
    ]);
  });

  it('colours each kind of step in the file, and marks its kind for the viewer', async () => {
    const { reading } = await render('inbound_intake');
    const extract = node(reading, 'Extract Company (AI)\n→ company');
    const write = node(reading, 'Write Attio Companies');
    const failure = node(reading, 'Fail: no company in ‹e.Subject›');
    expect([extract?.kind, write?.kind, failure?.kind]).toEqual(['ai', 'write', 'failure']);
    expect(reading.fills.get(extract?.id ?? '')).toBe('#f1eafe');
    expect(reading.fills.get(failure?.id ?? '')).toBe('#fdecec');
  });

  it('writes the program\'s arrows into the documentation unescaped', async () => {
    const { reading, xml } = await render('payment_failed');
    expect(xml).toContain('<bpmn:documentation>invoice = only(c-[:Invoice]->)</bpmn:documentation>');
    expect(node(reading, 'Read Stripe Invoice\n→ invoice')?.documentation).toBe('invoice = only(c-[:Invoice]->)');
  });
});

describe('what it refuses', () => {
  it('draws nothing for a program that does not check, and answers with its diagnostics', async () => {
    const source = (await readFile(join(fixtures, 'inbound_intake.mvt'), 'utf8')).replace('company.name', 'company.missing');
    const rendering = await renderProgram(source, { analysis: await analyse(source, 'handbook'), languageVersion: PIN });
    expect(rendering.ok).toBe(false);
    if (!rendering.ok) expect(rendering.diagnostics.map((d) => d.code)).toContain('MOV_UNKNOWN_PROPERTY');
  });

  it('refuses a pin of another compatibility key by name', async () => {
    const source = await readFile(join(fixtures, 'inbound_intake.mvt'), 'utf8');
    const rendering = await renderProgram(source, { analysis: await analyse(source, 'handbook'), languageVersion: '0.15.3' });
    expect(rendering.ok).toBe(false);
    if (!rendering.ok) {
      expect(rendering.diagnostics.map((d) => d.code)).toEqual(['MOV_LANGUAGE_VERSION_UNSUPPORTED']);
      expect(rendering.diagnostics[0]?.message).toContain('0.15.3');
    }
  });
});

describe('the vocabulary', () => {
  it('names each system, and carries its icon to the viewer', async () => {
    const { reading, xml } = await render('inbound_intake', {
      vocabulary: { attio: { name: 'Acme CRM', icon: 'https://example.com/attio.svg' }, email: { name: 'Intake inbox' } },
    });
    expect(reading.participants).toEqual(['Intake', 'Intake inbox', 'Acme CRM']);
    expect(xml).toContain('lf:icon="https://example.com/attio.svg"');
  });

  it('names a system by its adapter when the vocabulary has no words for it', async () => {
    const { reading } = await render('inbound_intake', { vocabulary: {} });
    expect(reading.participants).toEqual(['Intake', 'email', 'attio']);
  });
});

describe('the package', () => {
  it('states the version it exports', async () => {
    const manifest: { version: string } = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    expect(RENDERER_VERSION).toBe(manifest.version);
  });
});
