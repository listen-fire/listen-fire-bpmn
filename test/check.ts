// Structural checks on a rendered file, read back the way a BPMN tool reads
// it: through bpmn-moddle's fromXML.

import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';

export interface Reading {
  warnings: string[];
  /** Flow nodes with no sequence flow in or out where one is required. */
  orphans: string[];
  /** Elements the diagram does not draw. */
  undrawn: string[];
  /** Pairs of sibling shapes (in one process or subprocess, or two pools)
   *  that overlap, or a child drawn outside its subprocess. */
  overlaps: string[];
  /** Every flow node, by type then name, for assertions on the mapping. */
  nodes: Array<{ type: string; name: string; id: string }>;
  messageFlows: number;
  participants: string[];
}

function many(element: ModdleElement, property: string): ModdleElement[] {
  const value = element[property];
  return Array.isArray(value) ? value.filter(isElement) : [];
}

function one(element: ModdleElement, property: string): ModdleElement | undefined {
  const value = element[property];
  return isElement(value) ? value : undefined;
}

function isElement(value: unknown): value is ModdleElement {
  return typeof value === 'object' && value !== null && '$type' in value;
}

export async function readBack(xml: string): Promise<Reading> {
  const moddle = new BpmnModdle();
  const { rootElement, warnings } = await moddle.fromXML(xml);
  const drawn = new Set<ModdleElement>();
  const bounds = new Map<ModdleElement, Box>();
  for (const diagram of many(rootElement, 'diagrams')) {
    const plane = one(diagram, 'plane');
    if (plane === undefined) continue;
    for (const shape of many(plane, 'planeElement')) {
      const target = one(shape, 'bpmnElement');
      if (target !== undefined) drawn.add(target);
      const box = one(shape, 'bounds');
      if (target !== undefined && box !== undefined) bounds.set(target, boxOf(box));
    }
  }
  const reading: Reading = {
    warnings: warnings.map((warning) => warning.message),
    orphans: [],
    undrawn: [],
    overlaps: [],
    nodes: [],
    messageFlows: 0,
    participants: [],
  };
  const checkSiblings = (elements: ModdleElement[], within?: Box): void => {
    const boxes = elements.flatMap((element) => {
      const box = bounds.get(element);
      return box === undefined ? [] : [{ element, box }];
    });
    for (const [index, { element, box }] of boxes.entries()) {
      if (within !== undefined && !inside(box, within)) reading.overlaps.push(`${element.id} lies outside its container`);
      for (const other of boxes.slice(index + 1)) {
        if (intersects(box, other.box)) reading.overlaps.push(`${element.id} overlaps ${other.element.id}`);
      }
    }
  };
  const visitContainer = (container: ModdleElement): void => {
    checkSiblings(many(container, 'flowElements'), container.$instanceOf('bpmn:SubProcess') ? bounds.get(container) : undefined);
    for (const element of many(container, 'flowElements')) {
      if (!drawn.has(element)) reading.undrawn.push(element.id ?? element.$type);
      if (!element.$instanceOf('bpmn:FlowNode')) continue;
      reading.nodes.push({ type: element.$type, name: typeof element.name === 'string' ? element.name : '', id: element.id ?? '' });
      const eventSubprocess = element.$instanceOf('bpmn:SubProcess') && element.triggeredByEvent === true;
      const needsIncoming = !element.$instanceOf('bpmn:StartEvent') && !eventSubprocess;
      const needsOutgoing = !element.$instanceOf('bpmn:EndEvent') && !eventSubprocess;
      if (needsIncoming && many(element, 'incoming').length === 0) reading.orphans.push(`${element.id}: no incoming flow`);
      if (needsOutgoing && many(element, 'outgoing').length === 0) reading.orphans.push(`${element.id}: no outgoing flow`);
      if (element.$instanceOf('bpmn:SubProcess')) visitContainer(element);
    }
  };
  for (const root of many(rootElement, 'rootElements')) {
    if (root.$instanceOf('bpmn:Process')) visitContainer(root);
    if (root.$instanceOf('bpmn:Collaboration')) {
      checkSiblings(many(root, 'participants'));
      for (const participant of many(root, 'participants')) {
        if (!drawn.has(participant)) reading.undrawn.push(participant.id ?? 'participant');
        reading.participants.push(typeof participant.name === 'string' ? participant.name : '');
      }
      for (const flow of many(root, 'messageFlows')) {
        if (!drawn.has(flow)) reading.undrawn.push(flow.id ?? 'message flow');
        reading.messageFlows++;
      }
    }
  }
  return reading;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxOf(element: ModdleElement): Box {
  const number = (property: string): number => {
    const value = element[property];
    return typeof value === 'number' ? value : Number(value);
  };
  return { x: number('x'), y: number('y'), width: number('width'), height: number('height') };
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(inner: Box, outer: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
