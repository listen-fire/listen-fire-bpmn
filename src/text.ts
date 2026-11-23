// How much room a label takes once a BPMN viewer draws it. bpmn-js, the
// viewer the package's stylesheet is for, wraps an external label (an event's,
// a flow's) at 90px in 11px Arial, and a task's name inside the task in 12px.
// The layout reserves that room, so labels neither overlap shapes nor sit on
// flows. The widths are estimates per character class, erring wide.

export interface Size {
  width: number;
  height: number;
}

const EXTERNAL = { wrap: 90, fontSize: 11 };
const INSIDE = { fontSize: 12, padding: 5, icon: 22 };
const LINE_HEIGHT = 1.2;

/** An external label's box: its lines as the viewer wraps them. */
export function externalLabelSize(text: string): Size {
  const lines = wrap(text, EXTERNAL.wrap, EXTERNAL.fontSize);
  const width = Math.min(EXTERNAL.wrap, Math.max(...lines.map((line) => textWidth(line, EXTERNAL.fontSize))));
  return { width: Math.ceil(width) + 2, height: Math.ceil(lines.length * EXTERNAL.fontSize * LINE_HEIGHT) + 2 };
}

/** A task big enough for its name: 100 by 80 unless the name needs more. */
export function taskSize(name: string): Size {
  for (const width of [100, 130, 160]) {
    const lines = wrap(name, width - 2 * INSIDE.padding, INSIDE.fontSize);
    // Room above the text for the task's marker icon, and the same below.
    const height = Math.ceil(lines.length * INSIDE.fontSize * LINE_HEIGHT) + 2 * INSIDE.icon;
    if (height <= 80) return { width, height: 80 };
    if (width === 160 || lines.length <= 3) return { width, height: Math.ceil(height / 10) * 10 };
  }
  return { width: 100, height: 80 };
}

/** Lines as a viewer breaks them: at each newline, then at the last space
 *  that keeps a line within `width`; a word too long for a line is split. */
function wrap(text: string, width: number, fontSize: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (textWidth(candidate, fontSize) <= width) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);
      line = word;
      while (textWidth(line, fontSize) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), fontSize) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

function textWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const char of text) em += charEm(char);
  return em * fontSize;
}

/** Arial's advances, in ems, by character. */
const ADVANCES: Array<[string, number]> = [
  ['ijl', 0.222],
  [' ftI.,:;\'!|/', 0.278],
  ['r()[]{}-`"', 0.333],
  ['sckvxyzJ', 0.5],
  ['=+<>~', 0.584],
  ['FTZ', 0.611],
  ['ABEKPSVXY', 0.667],
  ['CDHNRUw', 0.722],
  ['GOQ', 0.778],
  ['mM', 0.833],
  ['W@', 0.944],
  ['%', 0.889],
  ['→', 1],
  ['‹›', 0.333],
];
function charEm(char: string): number {
  for (const [chars, em] of ADVANCES) if (chars.includes(char)) return em;
  return 0.556;
}

/** The height of `text` drawn inside a box `width` wide, as a subprocess's
 *  name is: 12px lines. */
export function insideTextHeight(text: string, width: number): number {
  return Math.ceil(wrap(text, width - 2 * INSIDE.padding, INSIDE.fontSize).length * INSIDE.fontSize * LINE_HEIGHT);
}
