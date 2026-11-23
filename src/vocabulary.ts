// What the diagram calls each connected system. The program names a system by
// its own binding (`crm`); the reader knows it as "Attio". A host supplies the
// words, keyed by the adapter as the story analysis names it.

/** A module's declared event wording, as its manifest's `vocabulary.eventPhrase`:
 *  per event name (or `default`), templates in preference order, each with
 *  `{slot}` tokens. Declared here structurally; the renderer does not depend
 *  on the engine's contracts. */
export type EventPhrases = Readonly<Record<string, readonly { readonly template: string }[]>>;

export interface SystemWords {
  /** The system's name as a person knows it. */
  name: string;
  /** An image the viewer draws beside the system's pool: a URL or a data URI. */
  icon?: string;
  /** The module's declared wording for what starts a listen on it. */
  eventPhrase?: EventPhrases;
  /** The address a person writes to for this system's inbound listens, which
   *  fills an `{address}` slot. Only a host that has provisioned one knows it. */
  address?: string;
}

export type Vocabulary = Readonly<Record<string, SystemWords>>;

/** The first-party modules' names, for a host with nothing better (the CLI). */
export const FIRST_PARTY_VOCABULARY: Vocabulary = {
  affinity: { name: 'Affinity' },
  airtable: { name: 'Airtable' },
  ask: { name: 'Asks' },
  attio: { name: 'Attio' },
  dealroom: { name: 'Dealroom' },
  dropbox: { name: 'Dropbox' },
  email: { name: 'Email' },
  evertrace: { name: 'Evertrace' },
  forms: { name: 'Forms' },
  github: { name: 'GitHub' },
  gmail: { name: 'Gmail' },
  'google-drive': { name: 'Google Drive' },
  'google-sheets': { name: 'Google Sheets' },
  granola: { name: 'Granola' },
  slack: { name: 'Slack' },
  stripe: { name: 'Stripe' },
  telegram: { name: 'Telegram' },
  webhook: { name: 'Webhook' },
  whatsapp: { name: 'WhatsApp' },
};

/** A vocabulary read from JSON, refused by what is wrong with it. */
export function vocabularyFrom(value: unknown): Vocabulary {
  if (!isRecord(value)) throw new Error('a vocabulary is a JSON object of adapter → { "name": …, "icon"?: … }');
  const words: Record<string, SystemWords> = {};
  for (const [adapter, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.name !== 'string') throw new Error(`vocabulary entry "${adapter}" needs a "name" string`);
    if (entry.icon !== undefined && typeof entry.icon !== 'string') throw new Error(`vocabulary entry "${adapter}": "icon" is a string`);
    if (entry.address !== undefined && typeof entry.address !== 'string') throw new Error(`vocabulary entry "${adapter}": "address" is a string`);
    const eventPhrase = entry.eventPhrase === undefined ? undefined : eventPhrasesFrom(entry.eventPhrase, adapter);
    words[adapter] = {
      name: entry.name,
      ...(entry.icon === undefined ? {} : { icon: entry.icon }),
      ...(eventPhrase === undefined ? {} : { eventPhrase }),
      ...(entry.address === undefined ? {} : { address: entry.address }),
    };
  }
  return words;
}

function eventPhrasesFrom(value: unknown, adapter: string): EventPhrases {
  const refused = new Error(`vocabulary entry "${adapter}": "eventPhrase" is an object of event name → [{ "template": … }]`);
  if (!isRecord(value)) throw refused;
  const phrases: Record<string, { template: string }[]> = {};
  for (const [event, templates] of Object.entries(value)) {
    if (!Array.isArray(templates)) throw refused;
    phrases[event] = templates.map((entry) => {
      if (!isRecord(entry) || typeof entry.template !== 'string') throw refused;
      return { template: entry.template };
    });
  }
  return phrases;
}

/** The sentence a listen's module declares for it, or undefined when it
 *  declares none that renders. Plain substitution, as the hosted platform does
 *  it: the first template whose every `{slot}` has a non-empty string value
 *  wins. A path listen carries no event selection and no narrowing keys (its
 *  selection is its WHERE, which fills no slot), so only a host's `address`
 *  is available to fill. */
export function resolveEventPhrase(words: SystemWords | undefined): string | undefined {
  const phrases = words?.eventPhrase;
  if (phrases === undefined) return undefined;
  const config: Record<string, unknown> = words?.address === undefined ? {} : { address: words.address };
  for (const { template } of phrases.default ?? []) {
    const filled = fillTemplate(template, config);
    if (filled !== undefined) return filled;
  }
  return undefined;
}

function fillTemplate(template: string, config: Record<string, unknown>): string | undefined {
  let unresolved = false;
  const filled = template.replace(/\{(\w+)\}/g, (_match, slot: string) => {
    const value = config[slot];
    if (typeof value !== 'string' || value.length === 0) {
      unresolved = true;
      return '';
    }
    return value;
  });
  return unresolved ? undefined : filled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
