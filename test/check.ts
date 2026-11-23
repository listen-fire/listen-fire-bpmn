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
  /** Labels drawn over a shape that is not their own, or over each other. */
  labelClashes: string[];
  /** Every flow node, by type then name, for assertions on the mapping. */
  nodes: Array<{ type: string; name: string; id: string; kind?: string; documentation: string }>;
  sequenceFlows: Array<{ name: string; condition?: string }>;
  messageFlows: Array<{ name: string; from: string; to: string }>;
  participants: string[];
  /** Each shape's fill, as BPMN in Color writes it, by element id. */
  fills: Map<string, string>;
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

function text(element: ModdleElement | undefined, property: string): string {
  const value = element?.[property];
  return typeof value === 'string' ? value : '';
}

export async function readBack(xml: string): Promise<Reading> {
  const moddle = new BpmnModdle();
  const { rootElement, warnings } = await moddle.fromXML(xml);
  const drawn = new Set<ModdleElement>();
  const bounds = new Map<ModdleElement, Box>();
  const labels: Array<{ owner: ModdleElement; box: Box }> = [];
  const fills = new Map<string, string>();
  for (const diagram of many(rootElement, 'diagrams')) {
    const plane = one(diagram, 'plane');
    if (plane === undefined) continue;
    for (const shape of many(plane, 'planeElement')) {
      const target = one(shape, 'bpmnElement');
      if (target === undefined) continue;
      drawn.add(target);
      const box = one(shape, 'bounds');
      if (box !== undefined) bounds.set(target, boxOf(box));
      const label = one(shape, 'label');
      const labelBox = label === undefined ? undefined : one(label, 'bounds');
      if (labelBox !== undefined) labels.push({ owner: target, box: boxOf(labelBox) });
      const fill = shape['fill'];
      if (typeof fill === 'string' && target.id !== undefined) fills.set(target.id, fill);
    }
  }
  const reading: Reading = {
    warnings: warnings.map((warning) => warning.message),
    orphans: [],
    undrawn: [],
    overlaps: [],
    labelClashes: [],
    nodes: [],
    sequenceFlows: [],
    messageFlows: [],
    participants: [],
    fills,
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
  const flowNodes: ModdleElement[] = [];
  const visitContainer = (container: ModdleElement): void => {
    checkSiblings(many(container, 'flowElements'), container.$instanceOf('bpmn:SubProcess') ? bounds.get(container) : undefined);
    for (const element of many(container, 'flowElements')) {
      if (!drawn.has(element)) reading.undrawn.push(element.id ?? element.$type);
      if (element.$instanceOf('bpmn:SequenceFlow')) {
        const condition = text(one(element, 'conditionExpression'), 'body');
        reading.sequenceFlows.push({ name: text(element, 'name'), ...(condition === '' ? {} : { condition }) });
      }
      if (!element.$instanceOf('bpmn:FlowNode')) continue;
      flowNodes.push(element);
      reading.nodes.push({
        type: element.$type,
        name: text(element, 'name'),
        id: element.id ?? '',
        ...(element.$attrs['lf:kind'] === undefined ? {} : { kind: element.$attrs['lf:kind'] }),
        documentation: many(element, 'documentation').map((doc) => text(doc, 'text')).join('\n'),
      });
      const needsIncoming = !element.$instanceOf('bpmn:StartEvent');
      const needsOutgoing = !element.$instanceOf('bpmn:EndEvent');
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
        reading.participants.push(text(participant, 'name'));
      }
      for (const flow of many(root, 'messageFlows')) {
        if (!drawn.has(flow)) reading.undrawn.push(flow.id ?? 'message flow');
        reading.messageFlows.push({ name: text(flow, 'name'), from: text(one(flow, 'sourceRef'), 'name'), to: text(one(flow, 'targetRef'), 'name') });
      }
    }
  }
  // A subprocess's own box holds its steps, so only leaf shapes count.
  const leaves = flowNodes.filter((node) => !node.$instanceOf('bpmn:SubProcess'));
  for (const [index, { owner, box }] of labels.entries()) {
    for (const node of leaves) {
      const shape = bounds.get(node);
      if (node !== owner && shape !== undefined && intersects(box, shape)) reading.labelClashes.push(`the label of ${owner.id} lies on ${node.id}`);
    }
    for (const other of labels.slice(index + 1)) {
      if (intersects(box, other.box)) reading.labelClashes.push(`the labels of ${owner.id} and ${other.owner.id} overlap`);
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
