// The diagram's tree (flow.ts) to BPMN 2.0 XML with its drawing (BPMN DI).
//
// Layout is done here rather than by an auto-layout library because the tree
// is structured: every block knows its own size, sequences run left to
// right, branches stack downwards, and subprocesses wrap their contents. That
// also gives what bpmn-auto-layout cannot: several pools, expanded
// subprocesses, and message flows to the connected systems.
//
// A block's size includes its labels, so a label never needs moving after
// the fact: an event's label sits above it when a system feeds it (the
// message flow comes from below) and below it otherwise, and a branch's
// condition sits on the flow into the branch, left of the branch's steps.

import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';

import {
  flowEnds,
  unreachable,
  withResult,
  type AllStep,
  type ChoiceStep,
  type Diagram,
  type EndStep,
  type FirstEventStep,
  type Flow,
  type Look,
  type ProcessFlow,
  type ScopeStep,
  type Start,
  type Step,
  type System,
  type TaskStep,
  type Touch,
  type Trigger,
  type WaitStep,
} from './flow.js';
import { AI_IMPLEMENTATION, LF_NAMESPACE } from './kinds.js';
import { externalLabelSize, insideTextHeight, taskSize, type Size } from './text.js';

const EVENT = { width: 36, height: 36 };
const GATEWAY = { width: 50, height: 50 };
/** Horizontal space between consecutive steps. */
const GAP = 50;
/** Vertical space between stacked branches. */
const ROW_GAP = 60;
/** Between a shape and its label. */
const LABEL_GAP = 4;
const SCOPE_PAD = 30;
const POOL_LABEL = 30;
const POOL_PAD = 40;
const POOL_GAP = 40;
const SYSTEM_POOL_HEIGHT = 40;
const SYSTEM_POOL_GAP = 16;


/** A kind of element, as `lf:kind` names it: a step's look, or a pool. */
export type Kind = Look | 'system' | 'pool';

/** The light palette, written into the file as BPMN in Color. The viewer
 *  stylesheet's dark variant overrides it by `lf:kind`. */
const PALETTE: Record<Kind, { stroke: string; fill: string }> = {
  ai: { stroke: '#7c3aed', fill: '#f1eafe' },
  read: { stroke: '#2563eb', fill: '#e8f0fe' },
  write: { stroke: '#4d7c0f', fill: '#eef5d9' },
  decision: { stroke: '#b45309', fill: '#fff4de' },
  failure: { stroke: '#dc2626', fill: '#fdecec' },
  system: { stroke: '#64748b', fill: '#f1f3f7' },
  pool: { stroke: '#334155', fill: '#ffffff' },
  plain: { stroke: '#334155', fill: '#ffffff' },
};
const SEQUENCE_FLOW_STROKE = '#334155';
const MESSAGE_FLOW_STROKE = '#64748b';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** A path leaving a block, not yet connected to whatever comes next. */
interface Exit {
  from: ModdleElement;
  name?: string;
  condition?: string;
  isDefault?: true;
  /** Leave the source from its right side even when it is a gateway. */
  side?: 'right';
  /** Run along this height: a branch with nothing on it. */
  viaY?: number;
  /** Where the flow's name is drawn. */
  label?: Rect;
}

interface Container {
  flowElements: ModdleElement[];
}

/** A laid-out piece of the diagram: its size, the height its sequence flows
 *  enter at (`axis`), and how to draw it at a position. */
interface Block {
  width: number;
  height: number;
  axis: number;
  place(container: Container, x: number, y: number, inbound: Exit[]): Exit[];
}

const EMPTY: Block = { width: 0, height: 0, axis: 0, place: (_container, _x, _y, inbound) => inbound };

/** A branch of a split: its steps, the flow into it, and the name on the
 *  flow out of it (an event-based gateway arm's result). */
interface Row {
  block: Block;
  exit: Omit<Exit, 'from' | 'label'>;
  continues: boolean;
  exitName?: string;
}

export interface RenderOptions {
  exporterVersion: string;
}

export async function renderBpmn(diagram: Diagram, options: RenderOptions): Promise<string> {
  const writer = new Writer();
  const definitions = writer.definitions(diagram, options);
  const { xml } = await writer.moddle.toXML(definitions, { format: true });
  return unescapeTextGreaterThan(xml);
}

/** XML needs `>` escaped nowhere in text but after `]]`, and the program's
 *  arrows (`-[:Invoice]->`) read badly as `-&gt;` to anyone who reads the
 *  file, or escapes it again for a web page. */
function unescapeTextGreaterThan(xml: string): string {
  return xml.replace(/>([^<]*)</g, (_whole, text: string) => `>${text.replace(/(?<!\]\])&gt;/g, '>')}<`);
}

class Writer {
  readonly moddle = new BpmnModdle();
  private readonly counters = new Map<string, number>();
  private readonly planeElements: ModdleElement[] = [];
  private readonly bounds = new Map<ModdleElement, Rect>();
  private readonly gateways = new Set<ModdleElement>();
  private readonly links = new Map<ModdleElement, { incoming: ModdleElement[]; outgoing: ModdleElement[] }>();
  private readonly messages = new Map<string, ModdleElement>();
  private readonly errors = new Map<string, ModdleElement>();
  private readonly touches: Array<{ element: ModdleElement; touch: Touch }> = [];
  /** Every label placed, for routing message flows around them. */
  private readonly labels: Rect[] = [];

  definitions(diagram: Diagram, options: RenderOptions): ModdleElement {
    const participants: ModdleElement[] = [];
    const processes: ModdleElement[] = [];
    const messageFlows: ModdleElement[] = [];
    const collaboration = this.create('bpmn:Collaboration', 'Collaboration', { participants, messageFlows });

    const pools = diagram.processes.map((process) => ({ process, block: this.sequence([this.startsBlock(process.starts), this.flowBlock(process.flow)]) }));
    const innerWidth = Math.max(400, ...pools.map(({ block }) => block.width));
    const poolWidth = POOL_LABEL + POOL_PAD + innerWidth + POOL_PAD;
    let y = 0;
    for (const { process, block } of pools) {
      const height = POOL_PAD + block.height + POOL_PAD;
      const element = this.processElement(process);
      processes.push(element);
      const participant = this.create('bpmn:Participant', 'Participant', { name: process.name, processRef: element });
      kindOf(participant, 'pool');
      participants.push(participant);
      this.shape(participant, { x: 0, y, width: poolWidth, height }, 'pool', { isHorizontal: true });
      block.place(this.containerOf(element), POOL_LABEL + POOL_PAD, y + POOL_PAD, []);
      y += height + POOL_GAP;
    }
    y -= POOL_GAP;

    // Each system pool leaves room above it for the labels of the flows into it.
    const flowLabels = this.touches.map(({ element, touch }) => ({ element, touch, text: flowName(touch), size: externalLabelSize(flowName(touch)) }));
    const systemPools = new Map<string, { participant: ModdleElement; rect: Rect }>();
    const used = diagram.systems.filter((system) => this.touches.some(({ touch }) => touch.system.binding === system.binding));
    for (const [position, system] of used.entries()) {
      const tallest = Math.max(0, ...flowLabels.filter(({ touch }) => touch.system.binding === system.binding).map(({ size }) => size.height));
      y += Math.max(position === 0 ? POOL_GAP : SYSTEM_POOL_GAP, tallest + 10);
      const rect = { x: 0, y, width: poolWidth, height: SYSTEM_POOL_HEIGHT };
      const participant = this.systemParticipant(system, `${system.display}`, `Connected system: \`${system.binding}\`, a connection of ${system.adapter}. Drawn as a black box.`);
      participants.push(participant);
      this.shape(participant, rect, 'system', { isHorizontal: true });
      systemPools.set(system.binding, { participant, rect });
      y += SYSTEM_POOL_HEIGHT;
    }
    for (const system of diagram.systems) {
      if (systemPools.has(system.binding)) continue;
      // A connection nothing reads or writes still belongs to the "what can it touch" view.
      y += SYSTEM_POOL_GAP;
      const participant = this.systemParticipant(system, `${system.display} (connected, unused)`, `Connected system: \`${system.binding}\`, a connection of ${system.adapter}. No step reads or writes it.`);
      participants.push(participant);
      this.shape(participant, { x: 0, y, width: poolWidth, height: SYSTEM_POOL_HEIGHT }, 'system', { isHorizontal: true });
      y += SYSTEM_POOL_HEIGHT;
    }

    const obstacles = [...this.bounds.entries()].map(([element, rect]) => ({ element, rect }));
    const perElement = new Map<ModdleElement, number>();
    const columns: Rect[] = [];
    for (const { element, touch, text, size } of flowLabels) {
      const pool = systemPools.get(touch.system.binding);
      const rect = this.bounds.get(element);
      if (pool === undefined || rect === undefined) continue;
      const nth = perElement.get(element) ?? 0;
      perElement.set(element, nth + 1);
      const read = touch.direction === 'read';
      const flow = this.create('bpmn:MessageFlow', 'MessageFlow', {
        name: text,
        sourceRef: read ? pool.participant : element,
        targetRef: read ? element : pool.participant,
      });
      messageFlows.push(flow);
      const blocking = obstacles.filter((obstacle) => obstacle.element !== element && !inside(rect, obstacle.rect)).map((obstacle) => obstacle.rect);
      const earlier = [...columns];
      const down = channel(rect, pool.rect.y, [...blocking, ...this.labels, ...earlier], nth);
      // Later flows keep off this one's path.
      for (const [index, point] of down.entries()) {
        const next = down[index + 1];
        if (next !== undefined) columns.push(segmentBox(point, next));
      }
      const column = down.at(-1)?.x ?? rect.x + rect.width / 2;
      const label = this.flowLabelAt(column, pool.rect.y, size, [...blocking, ...earlier]);
      this.edge(flow, read ? [...down].reverse() : down, MESSAGE_FLOW_STROKE, label);
    }

    const plane = this.moddle.create('bpmndi:BPMNPlane', { id: 'BPMNPlane_1', bpmnElement: collaboration, planeElement: this.planeElements });
    const diagramElement = this.moddle.create('bpmndi:BPMNDiagram', { id: 'BPMNDiagram_1', plane });
    const definitions = this.moddle.create('bpmn:Definitions', {
      id: 'Definitions_1',
      targetNamespace: LF_NAMESPACE,
      exporter: '@listen-fire/bpmn',
      exporterVersion: options.exporterVersion,
      rootElements: [collaboration, ...processes, ...this.messages.values(), ...this.errors.values()],
      diagrams: [diagramElement],
    });
    definitions.$attrs['xmlns:lf'] = LF_NAMESPACE;
    return definitions;
  }

  /** A message flow's label, just above the pool beside the flow's last
   *  stretch: to its right, or to its left when the right is taken. */
  private flowLabelAt(column: number, poolTop: number, size: Size, taken: Rect[]): Rect {
    const top = poolTop - size.height - 3;
    const right = { x: column + 5, y: top, ...size };
    const left = { x: column - 5 - size.width, y: top, ...size };
    const free = (rect: Rect): boolean => ![...this.labels, ...taken].some((other) => intersects(rect, other));
    const chosen = free(right) || !free(left) ? right : left;
    this.labels.push(chosen);
    return chosen;
  }

  // ── Elements ──

  private create(type: string, prefix: string, attributes: Record<string, unknown> = {}): ModdleElement {
    const count = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, count);
    return this.moddle.create(type, { id: `${prefix}_${count}`, ...attributes });
  }

  private readonly containers = new Map<ModdleElement, Container>();

  private processElement(process: ProcessFlow): ModdleElement {
    const flowElements: ModdleElement[] = [];
    const element = this.moddle.create('bpmn:Process', {
      id: process.id,
      name: process.name,
      isExecutable: false,
      documentation: this.documentation(process.doc),
      flowElements,
    });
    this.containers.set(element, { flowElements });
    return element;
  }

  private systemParticipant(system: System, name: string, doc: string): ModdleElement {
    const participant = this.create('bpmn:Participant', 'Participant', { name, documentation: this.documentation([doc]) });
    kindOf(participant, 'system');
    if (system.icon !== undefined) participant.$attrs['lf:icon'] = system.icon;
    return participant;
  }

  private containerOf(element: ModdleElement): Container {
    const container = this.containers.get(element);
    if (container === undefined) throw new Error(`${element.id} holds no flow elements`);
    return container;
  }

  private node(
    container: Container,
    type: string,
    attributes: Record<string, unknown>,
    rect: Rect,
    look: Look,
    di: { label?: Rect; extra?: Record<string, unknown> } = {},
  ): ModdleElement {
    const incoming: ModdleElement[] = [];
    const outgoing: ModdleElement[] = [];
    const element = this.create(type, type.replace(/^bpmn:/, ''), { incoming, outgoing, ...attributes });
    kindOf(element, look);
    container.flowElements.push(element);
    this.links.set(element, { incoming, outgoing });
    this.bounds.set(element, rect);
    if (type.endsWith('Gateway')) this.gateways.add(element);
    this.shape(element, rect, look, di.extra, di.label);
    return element;
  }

  private shape(element: ModdleElement, rect: Rect, kind: Kind, extra: Record<string, unknown> = {}, label?: Rect): void {
    const { stroke, fill } = PALETTE[kind];
    this.planeElements.push(
      this.moddle.create('bpmndi:BPMNShape', {
        id: `${element.id ?? 'Element'}_di`,
        bpmnElement: element,
        bounds: this.moddle.create('dc:Bounds', { ...rounded(rect) }),
        'bioc:stroke': stroke,
        'bioc:fill': fill,
        'color:border-color': stroke,
        'color:background-color': fill,
        ...(label === undefined ? {} : { label: this.label(label) }),
        ...extra,
      }),
    );
    if (label !== undefined) this.labels.push(label);
  }

  private edge(element: ModdleElement, points: Point[], stroke: string, label?: Rect): void {
    this.planeElements.push(
      this.moddle.create('bpmndi:BPMNEdge', {
        id: `${element.id ?? 'Edge'}_di`,
        bpmnElement: element,
        waypoint: points.map((point) => this.moddle.create('dc:Point', { x: Math.round(point.x), y: Math.round(point.y) })),
        'bioc:stroke': stroke,
        'color:border-color': stroke,
        ...(label === undefined ? {} : { label: this.label(label) }),
      }),
    );
  }

  private label(rect: Rect): ModdleElement {
    return this.moddle.create('bpmndi:BPMNLabel', { bounds: this.moddle.create('dc:Bounds', { ...rounded(rect) }) });
  }

  private documentation(lines: string[]): ModdleElement[] {
    const text = lines.filter((line) => line.trim() !== '').join('\n');
    return text === '' ? [] : [this.moddle.create('bpmn:Documentation', { text })];
  }

  private message(name: string): ModdleElement {
    let message = this.messages.get(name);
    if (message === undefined) {
      message = this.create('bpmn:Message', 'Message', { name });
      this.messages.set(name, message);
    }
    return message;
  }

  private error(name: string): ModdleElement {
    let error = this.errors.get(name);
    if (error === undefined) {
      error = this.create('bpmn:Error', 'Error', { name });
      this.errors.set(name, error);
    }
    return error;
  }

  private connect(container: Container, exit: Exit, target: ModdleElement): void {
    const flow = this.create('bpmn:SequenceFlow', 'Flow', {
      name: exit.name,
      sourceRef: exit.from,
      targetRef: target,
      conditionExpression: exit.condition === undefined ? undefined : this.moddle.create('bpmn:FormalExpression', { body: exit.condition }),
    });
    container.flowElements.push(flow);
    this.links.get(exit.from)?.outgoing.push(flow);
    this.links.get(target)?.incoming.push(flow);
    if (exit.isDefault === true) exit.from.default = flow;
    const source = this.bounds.get(exit.from);
    const destination = this.bounds.get(target);
    if (source === undefined || destination === undefined) throw new Error('a sequence flow joins an element with no shape');
    const label = exit.name === undefined ? undefined : exit.label;
    if (label !== undefined) this.labels.push(label);
    this.edge(flow, route(source, this.gateways.has(exit.from), destination, this.gateways.has(target), exit), SEQUENCE_FLOW_STROKE, label);
  }

  // ── Blocks ──

  /** A task-sized node; `terminal` nodes lead nowhere. */
  private nodeBlock(size: Size, make: (container: Container, rect: Rect) => ModdleElement): Block {
    return {
      ...size,
      axis: size.height / 2,
      place: (container, x, y, inbound) => {
        const element = make(container, { x, y, ...size });
        for (const exit of inbound) this.connect(container, exit, element);
        return [{ from: element }];
      },
    };
  }

  /** An event with its name outside it: above when a system feeds it, below
   *  otherwise. The block is as wide as the wider of the two. */
  private eventBlock(
    name: string,
    above: boolean,
    make: (container: Container, rect: Rect, label: Rect | undefined) => ModdleElement,
    terminal = false,
  ): Block {
    const size = name === '' ? { width: 0, height: 0 } : externalLabelSize(name);
    const room = name === '' ? 0 : size.height + LABEL_GAP;
    const width = Math.max(EVENT.width, size.width);
    return {
      width,
      height: EVENT.height + room,
      axis: (above ? room : 0) + EVENT.height / 2,
      place: (container, x, y, inbound) => {
        const event = { x: x + (width - EVENT.width) / 2, y: y + (above ? room : 0), ...EVENT };
        const label = name === '' ? undefined : { x: x + (width - size.width) / 2, y: above ? y : y + EVENT.height + LABEL_GAP, ...size };
        const element = make(container, event, label);
        for (const exit of inbound) this.connect(container, exit, element);
        return terminal ? [] : [{ from: element }];
      },
    };
  }

  private sequence(blocks: Block[]): Block {
    const parts = blocks.filter((block) => block.width > 0);
    if (parts.length === 0) return EMPTY;
    const above = Math.max(...parts.map((block) => block.axis));
    const below = Math.max(...parts.map((block) => block.height - block.axis));
    const width = parts.reduce((sum, block) => sum + block.width, 0) + GAP * (parts.length - 1);
    return {
      width,
      height: above + below,
      axis: above,
      place: (container, x, y, inbound) => {
        let exits = inbound;
        let left = x;
        for (const block of parts) {
          exits = block.place(container, left, y + above - block.axis, exits);
          left += block.width + GAP;
        }
        return exits;
      },
    };
  }

  private flowBlock(flow: Flow): Block {
    return this.sequence(flow.map((step) => this.stepBlock(step)));
  }

  private stepBlock(step: Step): Block {
    switch (step.kind) {
      case 'task':
        return this.taskBlock(step);
      case 'wait':
        return this.waitBlock(step);
      case 'end':
        return this.endBlock(step);
      case 'choice':
        return this.choiceBlock(step);
      case 'all':
        return this.allBlock(step);
      case 'firstEvent':
        return this.firstEventBlock(step);
      case 'scope':
        return this.scopeBlock(step);
      default:
        return unreachable(step);
    }
  }

  private taskBlock(step: TaskStep): Block {
    const type = (() => {
      switch (step.task) {
        case 'service':
          return 'bpmn:ServiceTask';
        case 'user':
          return 'bpmn:UserTask';
        case 'call':
          return 'bpmn:CallActivity';
        case 'unmapped':
          return 'bpmn:Task';
        default:
          return unreachable(step.task);
      }
    })();
    const name = withResult(step.name, step.result);
    return this.nodeBlock(taskSize(name), (container, rect) => {
      const element = this.node(
        container,
        type,
        {
          name,
          documentation: this.documentation(step.doc),
          implementation: step.look === 'ai' ? AI_IMPLEMENTATION : undefined,
          calledElement: step.calls,
        },
        rect,
        step.look,
      );
      for (const touch of step.touches) this.touches.push({ element, touch });
      return element;
    });
  }

  private eventDefinition(trigger: Trigger): ModdleElement {
    switch (trigger.kind) {
      case 'message':
        return this.create('bpmn:MessageEventDefinition', 'MessageEventDefinition', { messageRef: this.message(trigger.message) });
      case 'timer':
        return this.create('bpmn:TimerEventDefinition', 'TimerEventDefinition', {
          timeDuration: this.moddle.create('bpmn:FormalExpression', { body: trigger.isoDuration }),
        });
      case 'condition':
        return this.create('bpmn:ConditionalEventDefinition', 'ConditionalEventDefinition', {
          condition: this.moddle.create('bpmn:FormalExpression', { body: trigger.condition }),
        });
      default:
        return unreachable(trigger);
    }
  }

  private waitBlock(step: WaitStep): Block {
    const fed = step.touches.length > 0;
    return this.eventBlock(withResult(step.name, step.result), fed, (container, rect, label) => {
      const element = this.node(
        container,
        'bpmn:IntermediateCatchEvent',
        { name: withResult(step.name, step.result), documentation: this.documentation(step.doc), eventDefinitions: [this.eventDefinition(step.trigger)] },
        rect,
        fed ? 'read' : 'plain',
        { label },
      );
      for (const touch of step.touches) this.touches.push({ element, touch });
      return element;
    });
  }

  private endBlock(step: EndStep): Block {
    return this.eventBlock(
      step.name,
      false,
      (container, rect, label) => {
        const definitions = (() => {
          switch (step.end) {
            case 'none':
              return [];
            case 'terminate':
              return [this.create('bpmn:TerminateEventDefinition', 'TerminateEventDefinition')];
            case 'error':
              return [this.create('bpmn:ErrorEventDefinition', 'ErrorEventDefinition', { errorRef: this.error(step.error ?? step.name) })];
            default:
              return unreachable(step.end);
          }
        })();
        return this.node(
          container,
          'bpmn:EndEvent',
          { name: step.name, documentation: this.documentation(step.doc), eventDefinitions: definitions },
          rect,
          step.end === 'error' ? 'failure' : 'plain',
          { label },
        );
      },
      true,
    );
  }

  /** A split gateway, branches stacked downwards from its axis, and — when
   *  two or more branches carry on — a merge gateway. A flow's name sits
   *  above its first stretch, left of the branch's steps, so the branches
   *  start far enough right to leave it room. */
  private branching(spec: {
    split: (container: Container, rect: Rect) => ModdleElement;
    rows: Row[];
    merge?: (container: Container, rect: Rect) => ModdleElement;
  }): Block {
    const rows = spec.rows.map((row) => ({
      ...row,
      height: row.block.width === 0 ? GATEWAY.height : row.block.height,
      axis: row.block.width === 0 ? GATEWAY.height / 2 : row.block.axis,
      inLabel: row.exit.name === undefined ? undefined : externalLabelSize(row.exit.name),
      outLabel: row.exitName === undefined ? undefined : externalLabelSize(row.exitName),
    }));
    // The first branch leaves the gateway's right corner; the others leave
    // its bottom and turn right, so their names start right of its centre.
    const inLeft = (position: number): number => (position === 0 ? GATEWAY.width + 6 : GATEWAY.width / 2 + 6);
    const rowsLeft = Math.max(GATEWAY.width + GAP, ...rows.map((row, position) => (row.inLabel === undefined ? 0 : inLeft(position) + row.inLabel.width + 10)));
    const first = rows[0];
    const axis = Math.max(GATEWAY.height / 2, first?.axis ?? 0, (first?.inLabel?.height ?? 0) + 6);
    const tops: number[] = [];
    let bottom = 0;
    for (const [position, row] of rows.entries()) {
      const top = position === 0 ? axis - row.axis : bottom + ROW_GAP;
      tops.push(top);
      bottom = top + row.height;
    }
    const continuing = rows.filter((row) => row.continues).length;
    const merging = spec.merge !== undefined && continuing >= 2;
    const rowsWidth = Math.max(0, ...rows.map((row) => row.block.width));
    const tail = Math.max(GAP, ...rows.map((row) => (row.outLabel === undefined ? 0 : row.outLabel.width + 16)));
    const width = rowsLeft + rowsWidth + (merging ? tail + GATEWAY.width : 0);
    const height = Math.max(bottom, axis + GATEWAY.height / 2);
    return {
      width,
      height,
      axis,
      place: (container, x, y, inbound) => {
        const gatewayRect = (left: number): Rect => ({ x: left, y: y + axis - GATEWAY.height / 2, ...GATEWAY });
        const split = spec.split(container, gatewayRect(x));
        for (const exit of inbound) this.connect(container, exit, split);
        const exits: Exit[] = [];
        for (const [position, row] of rows.entries()) {
          const top = y + (tops[position] ?? 0);
          const lane = top + row.axis;
          const label = row.inLabel === undefined ? undefined : { x: x + inLeft(position), y: lane - row.inLabel.height - 3, ...row.inLabel };
          let rowExits = row.block.place(container, x + rowsLeft, top, [{ from: split, ...row.exit, ...(label === undefined ? {} : { label }) }]);
          if (row.block.width === 0 && position > 0) rowExits = rowExits.map((exit) => ({ ...exit, viaY: lane }));
          const outLabel = row.outLabel;
          if (row.exitName !== undefined && outLabel !== undefined) {
            const at = { x: x + rowsLeft + row.block.width + 6, y: lane - outLabel.height - 3, ...outLabel };
            rowExits = rowExits.map((exit) => ({ ...exit, name: row.exitName, label: at }));
          }
          exits.push(...rowExits);
        }
        if (!merging || spec.merge === undefined) return exits;
        const merge = spec.merge(container, gatewayRect(x + width - GATEWAY.width));
        for (const exit of exits) this.connect(container, exit, merge);
        return [{ from: merge }];
      },
    };
  }

  private gateway(type: string, look: Look, doc: string[] = []) {
    return (container: Container, rect: Rect): ModdleElement => this.node(container, type, { documentation: this.documentation(doc) }, rect, look);
  }

  private choiceBlock(step: ChoiceStep): Block {
    const arms: Row[] = step.arms.map((arm) => ({
      block: this.flowBlock(arm.flow),
      exit: { condition: arm.condition, name: arm.label },
      continues: !flowEnds(arm.flow),
    }));
    const rows: Row[] =
      step.otherwise === undefined
        ? [{ block: EMPTY, exit: { isDefault: true, side: 'right' }, continues: true }, ...arms]
        : [...arms, { block: this.flowBlock(step.otherwise), exit: { isDefault: true, name: 'else' }, continues: !flowEnds(step.otherwise) }];
    return this.branching({
      split: this.gateway('bpmn:ExclusiveGateway', 'decision', step.doc),
      rows,
      merge: this.gateway('bpmn:ExclusiveGateway', 'decision'),
    });
  }

  private allBlock(step: AllStep): Block {
    return this.branching({
      split: this.gateway('bpmn:ParallelGateway', 'plain', step.doc),
      rows: step.arms.map((arm) => ({ block: this.flowBlock(arm), exit: {}, continues: !flowEnds(arm) })),
      merge: this.gateway('bpmn:ParallelGateway', 'plain'),
    });
  }

  private firstEventBlock(step: FirstEventStep): Block {
    return this.branching({
      split: this.gateway('bpmn:EventBasedGateway', 'decision', step.doc),
      rows: step.arms.map((arm) => ({
        block: this.waitBlock(arm.wait),
        exit: {},
        continues: true,
        ...(arm.result === undefined ? {} : { exitName: arm.result }),
      })),
      merge: this.gateway('bpmn:ExclusiveGateway', 'decision'),
    });
  }

  private scopeBlock(step: ScopeStep): Block {
    const opening = this.eventBlock('', false, (container, rect) => this.node(container, 'bpmn:StartEvent', {}, rect, 'plain'));
    const inner = this.sequence([opening, this.flowBlock(step.flow)]);
    const name = withResult(step.name, step.result);
    const width = inner.width + 2 * SCOPE_PAD;
    const top = insideTextHeight(name, width) + 20;
    const height = top + inner.height + SCOPE_PAD;
    return this.nodeBlock({ width, height }, (container, rect) => {
      const flowElements: ModdleElement[] = [];
      const loop =
        step.repeat === undefined
          ? undefined
          : this.create('bpmn:MultiInstanceLoopCharacteristics', 'MultiInstanceLoopCharacteristics', { isSequential: step.repeat.sequential });
      const element = this.node(
        container,
        'bpmn:SubProcess',
        { name, documentation: this.documentation(step.doc), loopCharacteristics: loop, flowElements },
        rect,
        'plain',
        { extra: { isExpanded: true } },
      );
      for (const touch of step.touches) this.touches.push({ element, touch });
      inner.place({ flowElements }, rect.x + SCOPE_PAD, rect.y + top, []);
      return element;
    });
  }

  private startsBlock(starts: Start[]): Block {
    const blocks = starts.map((start) => this.startBlock(start));
    if (blocks.length <= 1) return blocks[0] ?? EMPTY;
    // Several listens fire one function: their start events merge.
    const tops: number[] = [];
    let bottom = 0;
    for (const block of blocks) {
      tops.push(tops.length === 0 ? 0 : bottom + ROW_GAP);
      bottom = (tops.at(-1) ?? 0) + block.height;
    }
    const firstAxis = blocks[0]?.axis ?? 0;
    const lastAxis = (tops.at(-1) ?? 0) + (blocks.at(-1)?.axis ?? 0);
    const axis = (firstAxis + lastAxis) / 2;
    const startsWidth = Math.max(...blocks.map((block) => block.width));
    return {
      width: startsWidth + GAP + GATEWAY.width,
      height: Math.max(bottom, axis + GATEWAY.height / 2),
      axis,
      place: (container, x, y) => {
        const exits = blocks.flatMap((block, position) => block.place(container, x + (startsWidth - block.width) / 2, y + (tops[position] ?? 0), []));
        const merge = this.node(
          container,
          'bpmn:ExclusiveGateway',
          {},
          { x: x + startsWidth + GAP, y: y + axis - GATEWAY.height / 2, ...GATEWAY },
          'decision',
        );
        for (const exit of exits) this.connect(container, exit, merge);
        return [{ from: merge }];
      },
    };
  }

  private startBlock(start: Start): Block {
    const fed = start.kind === 'message' && start.touch !== undefined;
    const name = withResult(start.name, start.result);
    return this.eventBlock(name, fed, (container, rect, label) => {
      const definitions = (() => {
        switch (start.kind) {
          case 'timer':
            return [
              this.create('bpmn:TimerEventDefinition', 'TimerEventDefinition', {
                timeCycle: start.cycle === undefined ? undefined : this.moddle.create('bpmn:FormalExpression', { body: start.cycle }),
              }),
            ];
          case 'message':
            return [this.eventDefinition({ kind: 'message', message: start.message })];
          case 'none':
            return [];
          default:
            return unreachable(start);
        }
      })();
      const element = this.node(
        container,
        'bpmn:StartEvent',
        { name, documentation: this.documentation(start.doc), eventDefinitions: definitions },
        rect,
        fed ? 'read' : 'plain',
        { label },
      );
      if (start.kind === 'message' && start.touch !== undefined) this.touches.push({ element, touch: start.touch });
      return element;
    });
  }
}

function kindOf(element: ModdleElement, kind: Kind): void {
  element.$attrs['lf:kind'] = kind;
}

/** What a message flow carries: "reads Channels", "writes Messages". */
function flowName(touch: Touch): string {
  return `${touch.direction === 'read' ? 'reads' : 'writes'} ${touch.what}`;
}

/** Orthogonal waypoints from one shape to the next. A gateway sends its
 *  branches out of its top or bottom corner; a merge gateway takes them in
 *  the same way. */
function route(source: Rect, sourceIsGateway: boolean, target: Rect, targetIsGateway: boolean, exit: Exit): Point[] {
  const sy = source.y + source.height / 2;
  const ty = target.y + target.height / 2;
  const sourceRight = source.x + source.width;
  const sourceCentre = source.x + source.width / 2;
  const targetCentre = target.x + target.width / 2;
  const intoTarget = (from: number): Point =>
    targetIsGateway ? { x: targetCentre, y: from > ty ? target.y + target.height : target.y } : { x: target.x, y: ty };

  if (exit.viaY !== undefined && sourceIsGateway) {
    const start = { x: sourceCentre, y: exit.viaY > sy ? source.y + source.height : source.y };
    if (targetIsGateway) return [start, { x: sourceCentre, y: exit.viaY }, { x: targetCentre, y: exit.viaY }, intoTarget(exit.viaY)];
    const bend = target.x - GAP / 2;
    return [start, { x: sourceCentre, y: exit.viaY }, { x: bend, y: exit.viaY }, { x: bend, y: ty }, { x: target.x, y: ty }];
  }
  if (Math.abs(sy - ty) < 1) return [{ x: sourceRight, y: sy }, { x: target.x, y: ty }];
  if (sourceIsGateway && exit.side !== 'right') {
    return [{ x: sourceCentre, y: ty > sy ? source.y + source.height : source.y }, { x: sourceCentre, y: ty }, { x: target.x, y: ty }];
  }
  if (targetIsGateway) return [{ x: sourceRight, y: sy }, { x: targetCentre, y: sy }, intoTarget(sy)];
  const bend = target.x - GAP / 2;
  return [{ x: sourceRight, y: sy }, { x: bend, y: sy }, { x: bend, y: ty }, { x: target.x, y: ty }];
}

/** A message flow's path from a shape down to its system's pool: straight
 *  down when nothing is in the way; otherwise a short drop, a run sideways
 *  and down the nearest clear column. Shapes and labels are both in the way. */
function channel(rect: Rect, poolTop: number, obstacles: Rect[], nth: number): Point[] {
  const blocked = (a: Point, b: Point): boolean => {
    const segment = { x: Math.min(a.x, b.x) - 3, y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x) + 6, height: Math.abs(a.y - b.y) };
    return obstacles.some((obstacle) => intersects(segment, obstacle));
  };
  const centre = rect.x + rect.width / 2;
  const bottom = rect.y + rect.height;
  const straight = centre + (nth % 2 === 0 ? 1 : -1) * Math.ceil(nth / 2) * 12;
  if (!blocked({ x: straight, y: bottom + 1 }, { x: straight, y: poolTop })) {
    return [
      { x: straight, y: bottom },
      { x: straight, y: poolTop },
    ];
  }
  const jog = bottom + 12 + nth * 6;
  for (let distance = 8; distance < 2000; distance += 8) {
    for (const column of [rect.x + rect.width + distance, rect.x - distance]) {
      if (column < POOL_LABEL + 4) continue;
      if (blocked({ x: straight, y: bottom + 1 }, { x: straight, y: jog })) break;
      if (!blocked({ x: straight, y: jog }, { x: column, y: jog }) && !blocked({ x: column, y: jog }, { x: column, y: poolTop })) {
        return [
          { x: straight, y: bottom },
          { x: straight, y: jog },
          { x: column, y: jog },
          { x: column, y: poolTop },
        ];
      }
    }
  }
  return [
    { x: straight, y: bottom },
    { x: straight, y: poolTop },
  ];
}

function segmentBox(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x) - 4, y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x) + 8, height: Math.abs(a.y - b.y) };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Whether `inner` lies within `outer`: a subprocess around a step is not in
 *  the step's way. */
function inside(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function rounded(rect: Rect): Rect {
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}
