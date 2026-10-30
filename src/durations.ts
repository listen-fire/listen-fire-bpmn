// listen-fire durations (`2d`, `1h30m`, `90s`, `1w`) as BPMN reads them
// (ISO 8601, `P2D`, `PT1H30M`) and as a person reads them ("2 days").

const UNITS: Record<string, { iso: string; time: boolean; word: string; days?: number }> = {
  w: { iso: 'D', time: false, word: 'week', days: 7 },
  d: { iso: 'D', time: false, word: 'day' },
  h: { iso: 'H', time: true, word: 'hour' },
  m: { iso: 'M', time: true, word: 'minute' },
  s: { iso: 'S', time: true, word: 'second' },
};

interface Part {
  amount: number;
  unit: string;
}

function partsOf(raw: string): Part[] | undefined {
  const text = raw.trim().replace(/^["']|["']$/g, '');
  const parts: Part[] = [];
  const pattern = /(\d+)\s*([wdhms])/y;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const [whole, amount, unit] = match;
    if (amount === undefined || unit === undefined) return undefined;
    parts.push({ amount: Number(amount), unit });
    consumed += whole.length;
  }
  return parts.length > 0 && consumed === text.length ? parts : undefined;
}

/** `1h30m` → `PT1H30M`. A duration it cannot read is returned as written. */
export function isoDuration(raw: string): string {
  const parts = partsOf(raw);
  if (parts === undefined) return raw.trim();
  let days = 0;
  let time = '';
  for (const { amount, unit } of parts) {
    const spec = UNITS[unit];
    if (spec === undefined) return raw.trim();
    if (spec.time) time += `${amount}${spec.iso}`;
    else days += amount * (spec.days ?? 1);
  }
  return `P${days > 0 ? `${days}D` : ''}${time === '' ? '' : `T${time}`}`;
}

/** `1h30m` → "1 hour 30 minutes". */
export function describeDuration(raw: string): string {
  const parts = partsOf(raw);
  if (parts === undefined) return raw.trim();
  return parts
    .map(({ amount, unit }) => {
      const word = UNITS[unit]?.word ?? unit;
      return `${amount} ${word}${amount === 1 ? '' : 's'}`;
    })
    .join(' ');
}
