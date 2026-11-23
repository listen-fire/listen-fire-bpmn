// For a host that shows the diagram with bpmn-js: marks each element with its
// kind (`lf-ai`, `lf-read`, …) for the stylesheet (viewer/lf-bpmn.css), adds
// the AI badge, draws each system's icon, and puts a chip behind each blank
// (‹email›) and each result name (→ person). Colours stay in the file and the
// stylesheet; this only marks. It runs in the browser and needs nothing but
// the viewer it is given.

import { AI_IMPLEMENTATION } from './kinds.js';

/** The parts of a bpmn-js viewer this reads: an imported diagram's
 *  `elementRegistry`, `canvas` and `overlays`. */
export interface BpmnViewer {
  get(service: 'elementRegistry'): { forEach(visit: (element: DiagramElement) => void): void };
  get(service: 'canvas'): { addMarker(id: string, marker: string): void; getContainer(): HTMLElement };
  get(service: 'overlays'): {
    add(id: string, type: string, overlay: { position: { top?: number; right?: number; left?: number }; html: HTMLElement }): void;
  };
}

interface DiagramElement {
  id: string;
  type: string;
  labelTarget?: unknown;
  businessObject?: { $attrs?: Record<string, string>; implementation?: string };
}

/** Marks an imported diagram for the stylesheet. Call it after `importXML`.
 *  The viewer's canvas takes the class `lf-bpmn`; the dark variant is `lf-dark`
 *  on the element given to bpmn-js, or any ancestor of it. */
export function styleDiagram(viewer: BpmnViewer): void {
  const canvas = viewer.get('canvas');
  const overlays = viewer.get('overlays');
  const container = canvas.getContainer();
  container.classList.add('lf-bpmn');
  viewer.get('elementRegistry').forEach((element) => {
    if (element.labelTarget !== undefined) return;
    const attrs = element.businessObject?.$attrs ?? {};
    const kind = attrs['lf:kind'];
    if (kind !== undefined) canvas.addMarker(element.id, `lf-${kind}`);
    if (element.type === 'bpmn:MessageFlow') canvas.addMarker(element.id, 'lf-message');
    if (element.businessObject?.implementation === AI_IMPLEMENTATION) {
      overlays.add(element.id, 'lf-badge', { position: { top: -9, right: 6 }, html: badge(container.ownerDocument) });
    }
    const icon = attrs['lf:icon'];
    if (icon !== undefined) overlays.add(element.id, 'lf-icon', { position: { top: 10, left: 8 }, html: image(container.ownerDocument, icon) });
  });
  chips(container);
}

function badge(document: Document): HTMLElement {
  const span = document.createElement('span');
  span.className = 'lf-badge';
  span.textContent = 'AI';
  return span;
}

function image(document: Document, src: string): HTMLElement {
  const img = document.createElement('img');
  img.className = 'lf-icon';
  img.alt = '';
  img.src = src;
  return img;
}

const SVG = 'http://www.w3.org/2000/svg';

/** A rounded chip behind each run-time blank (‹email›) and each result name
 *  (→ person) in the diagram's text. */
function chips(container: HTMLElement): void {
  for (const text of Array.from(container.querySelectorAll('text'))) {
    if (!(text instanceof SVGTextElement) || text.closest('.bjs-powered-by') !== null) continue;
    const content = text.textContent ?? '';
    const found: Array<{ start: number; length: number; kind: 'blank' | 'result' }> = [];
    for (const match of content.matchAll(/‹[^›]*›/g)) found.push({ start: match.index, length: match[0].length, kind: 'blank' });
    for (const match of content.matchAll(/→ (\S+)/g)) found.push({ start: match.index + 2, length: (match[1] ?? '').length, kind: 'result' });
    for (const { start, length, kind } of found) {
      let from: DOMPoint;
      let to: DOMPoint;
      try {
        from = text.getStartPositionOfChar(start);
        to = text.getEndPositionOfChar(start + length - 1);
      } catch {
        continue;
      }
      // A chip only where the words stayed on one line.
      if (to.x <= from.x || Math.abs(to.y - from.y) > 1) continue;
      const chip = container.ownerDocument.createElementNS(SVG, 'rect');
      chip.setAttribute('class', `lf-chip lf-${kind}`);
      chip.setAttribute('x', String(from.x - 2));
      chip.setAttribute('y', String(from.y - 10));
      chip.setAttribute('width', String(to.x - from.x + 4));
      chip.setAttribute('height', '14');
      chip.setAttribute('rx', '7');
      text.parentNode?.insertBefore(chip, text);
    }
  }
}
