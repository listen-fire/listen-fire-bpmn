// What the diagram calls each connected system. The program names a system by
// its own binding (`crm`); the reader knows it as "Attio". A host supplies the
// words, keyed by the adapter as the story analysis names it.

export interface SystemWords {
  /** The system's name as a person knows it. */
  name: string;
  /** An image the viewer draws beside the system's pool: a URL or a data URI. */
  icon?: string;
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
    words[adapter] = entry.icon === undefined ? { name: entry.name } : { name: entry.name, icon: entry.icon };
  }
  return words;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
