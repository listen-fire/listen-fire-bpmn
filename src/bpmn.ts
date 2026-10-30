// The diagram's tree (flow.ts) to BPMN 2.0 XML with its drawing (BPMN DI).
//
// Layout is done here rather than by an auto-layout library because the tree
// is structured: every block knows its own size, sequences run left to
// right, branches stack downwards, and subprocesses wrap their contents. That
// also gives what bpmn-auto-layout cannot: several pools, expanded
// subprocesses, and message flows to the connected systems.

import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';

import {
  flowEnds,
  unreachable,
  type Body,
  type ChoiceStep,
  type Diagram,
  type EndStep,
  type FirstEventStep,
  type Flow,
  type Handler,
  type ProcessFlow,
  type ScopeStep,
  type Start,
  type Step,
  type TaskStep,
  type Touch,
  type Trigger,
  type WaitStep,
  type AllStep,
} from './flow.js';

const TASK = { width: 100, height: 80 };
const EVENT = { width: 36, height: 36 };
const GATEWAY = { width: 50, height: 50 };
/** Horizontal space between consecutive steps. */
const GAP = 50;
/** Vertical space between stacked branches (room for event labels). */
const ROW_GAP = 60;
const SCOPE_PAD = 30;
const SCOPE_PAD_TOP = 40;
const POOL_LABEL = 30;
const POOL_PAD = 40;
const POOL_GAP = 40;
const SYSTEM_POOL_HEIGHT = 60;

export const AI_IMPLEMENTATION = 'urn:listen-fire:ai';

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

export interface RenderOptions {
  exporterVersion?: string;
}

export async function renderBpmn(diagram: Diagram, options: RenderOptions = {}): Promise<string> {
  const writer = new Writer();
  const definitions = writer.definitions(diagram, options);
  const { xml } = await writer.moddle.toXML(definitions, { format: true });
  return xml;
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

  definitions(diagram: Diagram, options: RenderOptions): ModdleElement {
    const participants: ModdleElement[] = [];
    const processes: ModdleElement[] = [];
    const messageFlows: ModdleElement[] = [];
    const collaboration = this.create('bpmn:Collaboration', 'Collaboration', { participants, messageFlows });

    const pools = diagram.processes.map((process) => ({ process, block: this.bodyBlock(process.body, this.startsBlock(process.starts)) }));
    const innerWidth = Math.max(400, ...pools.map(({ block }) => block.width));
    const poolWidth = POOL_LABEL + POOL_PAD + innerWidth + POOL_PAD;
    let y = 0;
    for (const { process, block } of pools) {
      const height = POOL_PAD + block.height + POOL_PAD;
      const element = this.processElement(process);
      processes.push(element);
      const participant = this.create('bpmn:Participant', 'Participant', { name: process.name, processRef: element });
      participants.push(participant);
      this.shape(participant, { x: 0, y, width: poolWidth, height }, { isHorizontal: true });
      block.place(this.containerOf(element), POOL_LABEL + POOL_PAD, y + POOL_PAD, []);
      y += height + POOL_GAP;
    }

    const systemPools = new Map<string, { participant: ModdleElement; rect: Rect }>();
    const used = diagram.systems.filter((system) => this.touches.some(({ touch }) => touch.system.binding === system.binding));
    for (const system of used) {
      const participant = this.create('bpmn:Participant', 'Participant', {
        name: system.display,
        documentation: this.documentation([`Connected system: \`${system.binding} = connect ${system.adapter} …\`. Drawn as a black box.`]),
      });
      participants.push(participant);
      const rect = { x: 0, y, width: poolWidth, height: SYSTEM_POOL_HEIGHT };
      this.shape(participant, rect, { isHorizontal: true });
      systemPools.set(system.binding, { participant, rect });
      y += SYSTEM_POOL_HEIGHT + POOL_GAP;
    }
    for (const system of diagram.systems) {
      if (!systemPools.has(system.binding)) {
        // A connection nothing reads or writes still belongs to the "what can it touch" view.
        const participant = this.create('bpmn:Participant', 'Participant', {
          name: `${system.display} (connected, unused)`,
          documentation: this.documentation([`Connected system: \`${system.binding} = connect ${system.adapter} …\`. No step reads or writes it.`]),
        });
        participants.push(participant);
        this.shape(participant, { x: 0, y, width: poolWidth, height: SYSTEM_POOL_HEIGHT }, { isHorizontal: true });
        y += SYSTEM_POOL_HEIGHT + POOL_GAP;
      }
    }

    const perElement = new Map<ModdleElement, number>();
    for (const { element, touch } of this.touches) {
      const pool = systemPools.get(touch.system.binding);
      const rect = this.bounds.get(element);
      if (pool === undefined || rect === undefined) continue;
      const nth = perElement.get(element) ?? 0;
      perElement.set(element, nth + 1);
      const x = rect.x + rect.width / 2 + (nth % 2 === 0 ? 1 : -1) * Math.ceil(nth / 2) * 12;
      const bottom = rect.y + rect.height;
      const read = touch.direction === 'read';
      const flow = this.create('bpmn:MessageFlow', 'MessageFlow', {
        sourceRef: read ? pool.participant : element,
        targetRef: read ? element : pool.participant,
      });
      messageFlows.push(flow);
      const waypoints = read
        ? [
            { x, y: pool.rect.y },
            { x, y: bottom },
          ]
        : [
            { x, y: bottom },
            { x, y: pool.rect.y },
          ];
      this.edge(flow, waypoints);
    }

    const plane = this.moddle.create('bpmndi:BPMNPlane', { id: 'BPMNPlane_1', bpmnElement: collaboration, planeElement: this.planeElements });
    const diagramElement = this.moddle.create('bpmndi:BPMNDiagram', { id: 'BPMNDiagram_1', plane });
    return this.moddle.create('bpmn:Definitions', {
      id: 'Definitions_1',
      targetNamespace: 'https://listen-fire.dev/schema/bpmn',
      exporter: 'listen-fire-bpmn',
      exporterVersion: options.exporterVersion ?? '0.1.0',
      rootElements: [collaboration, ...processes, ...this.messages.values(), ...this.errors.values()],
      diagrams: [diagramElement],
    });
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
    shape: Record<string, unknown> = {},
  ): ModdleElement {
    const incoming: ModdleElement[] = [];
    const outgoing: ModdleElement[] = [];
    const prefix = type.replace(/^bpmn:/, '');
    const element = this.create(type, prefix, { incoming, outgoing, ...attributes });
    container.flowElements.push(element);
    this.links.set(element, { incoming, outgoing });
    this.bounds.set(element, rect);
    if (type.endsWith('Gateway')) this.gateways.add(element);
    this.shape(element, rect, shape);
    return element;
  }

  private shape(element: ModdleElement, rect: Rect, extra: Record<string, unknown> = {}): void {
    this.planeElements.push(
      this.moddle.create('bpmndi:BPMNShape', {
        id: `${element.id ?? 'Element'}_di`,
        bpmnElement: element,
        bounds: this.moddle.create('dc:Bounds', { ...rect }),
        ...extra,
      }),
    );
  }

  private edge(element: ModdleElement, points: Point[]): void {
    this.planeElements.push(
      this.moddle.create('bpmndi:BPMNEdge', {
        id: `${element.id ?? 'Edge'}_di`,
        bpmnElement: element,
        waypoint: points.map((point) => this.moddle.create('dc:Point', { x: Math.round(point.x), y: Math.round(point.y) })),
      }),
    );
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
      conditionExpression:
        exit.condition === undefined ? undefined : this.moddle.create('bpmn:FormalExpression', { body: exit.condition }),
    });
    container.flowElements.push(flow);
    this.links.get(exit.from)?.outgoing.push(flow);
    this.links.get(target)?.incoming.push(flow);
    if (exit.isDefault === true) exit.from.default = flow;
    const source = this.bounds.get(exit.from);
    const destination = this.bounds.get(target);
    if (source === undefined || destination === undefined) throw new Error('a sequence flow joins an element with no shape');
    this.edge(flow, route(source, this.gateways.has(exit.from), destination, this.gateways.has(target), exit));
  }

  // ── Blocks ──

  /** A single node; `terminal` nodes (end events) lead nowhere. */
  private nodeBlock(
    size: { width: number; height: number },
    make: (container: Container, rect: Rect) => ModdleElement,
    terminal = false,
  ): Block {
    return {
      ...size,
      axis: size.height / 2,
      place: (container, x, y, inbound) => {
        const element = make(container, { x, y, ...size });
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
        case 'send':
          return 'bpmn:SendTask';
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
    return this.nodeBlock(TASK, (container, rect) => {
      const element = this.node(
        container,
        type,
        {
          name: step.name,
          documentation: this.documentation(step.doc),
          implementation: step.ai === true ? AI_IMPLEMENTATION : undefined,
          calledElement: step.calls,
        },
        rect,
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
    return this.nodeBlock(EVENT, (container, rect) => {
      const element = this.node(
        container,
        'bpmn:IntermediateCatchEvent',
        { name: step.name, documentation: this.documentation(step.doc), eventDefinitions: [this.eventDefinition(step.trigger)] },
        rect,
      );
      for (const touch of step.touches) this.touches.push({ element, touch });
      return element;
    });
  }

  private endBlock(step: EndStep): Block {
    return this.nodeBlock(
      EVENT,
      (container, rect) => {
        const definitions = (() => {
          switch (step.end) {
            case 'none':
              return [];
            case 'terminate':
              return [this.create('bpmn:TerminateEventDefinition', 'TerminateEventDefinition')];
            case 'error':
              return [this.create('bpmn:ErrorEventDefinition', 'ErrorEventDefinition', { errorRef: this.error(step.name.replace(/^Fail: /, '')) })];
            default:
              return unreachable(step.end);
          }
        })();
        return this.node(
          container,
          'bpmn:EndEvent',
          { name: step.name, documentation: this.documentation(step.doc), eventDefinitions: definitions },
          rect,
        );
      },
      true,
    );
  }

  /** A split gateway, branches stacked downwards from its axis, and — when
   *  two or more branches carry on — a merge gateway. */
  private branching(spec: {
    split: (container: Container, rect: Rect) => ModdleElement;
    rows: Array<{ block: Block; exit: Omit<Exit, 'from'>; continues: boolean; name?: string }>;
    merge?: (container: Container, rect: Rect) => ModdleElement;
  }): Block {
    const rows = spec.rows.map((row) => ({
      ...row,
      height: row.block.width === 0 ? GATEWAY.height : row.block.height,
      axis: row.block.width === 0 ? GATEWAY.height / 2 : row.block.axis,
    }));
    const first = rows[0];
    const axis = Math.max(GATEWAY.height / 2, first?.axis ?? 0);
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
    const rowsLeft = GATEWAY.width + GAP;
    const width = rowsLeft + rowsWidth + (merging ? GAP + GATEWAY.width : 0);
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
          let rowExits = row.block.place(container, x + rowsLeft, top, [{ from: split, ...row.exit }]);
          if (row.block.width === 0 && position > 0) rowExits = rowExits.map((exit) => ({ ...exit, viaY: top + row.axis }));
          exits.push(...rowExits);
        }
        if (!merging || spec.merge === undefined) return exits;
        const merge = spec.merge(container, gatewayRect(x + width - GATEWAY.width));
        for (const exit of exits) this.connect(container, exit, merge);
        return [{ from: merge }];
      },
    };
  }

  private gateway(type: string, doc: string[] = [], attributes: Record<string, unknown> = {}) {
    return (container: Container, rect: Rect): ModdleElement =>
      this.node(container, type, { documentation: this.documentation(doc), ...attributes }, rect);
  }

  private choiceBlock(step: ChoiceStep): Block {
    const arms = step.arms.map((arm) => ({
      block: this.flowBlock(arm.flow),
      exit: { condition: arm.condition, name: shorten(arm.condition, 30) },
      continues: !flowEnds(arm.flow),
    }));
    const rows =
      step.otherwise === undefined
        ? [{ block: EMPTY, exit: { isDefault: true as const, side: 'right' as const }, continues: true }, ...arms]
        : [
            ...arms,
            { block: this.flowBlock(step.otherwise), exit: { isDefault: true as const, name: 'else' }, continues: !flowEnds(step.otherwise) },
          ];
    return this.branching({
      split: this.gateway('bpmn:ExclusiveGateway', step.doc),
      rows,
      merge: this.gateway('bpmn:ExclusiveGateway'),
    });
  }

  private allBlock(step: AllStep): Block {
    return this.branching({
      split: this.gateway('bpmn:ParallelGateway', step.doc),
      rows: step.arms.map((arm) => ({ block: this.flowBlock(arm), exit: {}, continues: !flowEnds(arm) })),
      merge: this.gateway('bpmn:ParallelGateway'),
    });
  }

  private firstEventBlock(step: FirstEventStep): Block {
    return this.branching({
      split: this.gateway('bpmn:EventBasedGateway', step.doc),
      rows: step.arms.map((arm) => ({
        block: named(this.waitBlock(arm.wait), arm.result),
        exit: {},
        continues: true,
      })),
      merge: this.gateway('bpmn:ExclusiveGateway'),
    });
  }

  private scopeBlock(step: ScopeStep): Block {
    const opening = this.nodeBlock(EVENT, (container, rect) => this.node(container, 'bpmn:StartEvent', {}, rect));
    const inner = this.bodyBlock(step.body, opening);
    const width = inner.width + 2 * SCOPE_PAD;
    const height = SCOPE_PAD_TOP + inner.height + SCOPE_PAD;
    return this.nodeBlock({ width, height }, (container, rect) => {
      const flowElements: ModdleElement[] = [];
      const loop =
        step.repeat === undefined
          ? undefined
          : this.create('bpmn:MultiInstanceLoopCharacteristics', 'MultiInstanceLoopCharacteristics', { isSequential: step.repeat.sequential });
      const element = this.node(
        container,
        'bpmn:SubProcess',
        { name: step.name, documentation: this.documentation(step.doc), loopCharacteristics: loop, flowElements },
        rect,
        { isExpanded: true },
      );
      for (const touch of step.touches) this.touches.push({ element, touch });
      inner.place({ flowElements }, rect.x + SCOPE_PAD, rect.y + SCOPE_PAD_TOP, []);
      return element;
    });
  }

  private handlerBlock(handler: Handler): Block {
    const opening = this.nodeBlock(EVENT, (container, rect) =>
      this.node(
        container,
        'bpmn:StartEvent',
        {
          name: `${handler.message.replace(/ Called$/, '')} called`,
          isInterrupting: handler.interrupting,
          eventDefinitions: [this.eventDefinition({ kind: 'message', message: handler.message })],
        },
        rect,
      ),
    );
    const inner = this.bodyBlock(handler.body, opening);
    const width = inner.width + 2 * SCOPE_PAD;
    const height = SCOPE_PAD_TOP + inner.height + SCOPE_PAD;
    return {
      width,
      height,
      axis: height / 2,
      place: (container, x, y) => {
        const flowElements: ModdleElement[] = [];
        const rect = { x, y, width, height };
        this.node(
          container,
          'bpmn:SubProcess',
          { name: handler.name, documentation: this.documentation(handler.doc), triggeredByEvent: true, flowElements },
          rect,
          { isExpanded: true },
        );
        inner.place({ flowElements }, x + SCOPE_PAD, y + SCOPE_PAD_TOP, []);
        return [];
      },
    };
  }

  /** A scope's contents: its opening, its flow, and its callbacks' event
   *  subprocesses in a row underneath. */
  private bodyBlock(body: Body, opening: Block): Block {
    const main = this.sequence([opening, this.flowBlock(body.flow)]);
    const handlers = body.handlers.map((handler) => this.handlerBlock(handler));
    if (handlers.length === 0) return main;
    const handlersWidth = handlers.reduce((sum, block) => sum + block.width, 0) + GAP * (handlers.length - 1);
    const handlersHeight = Math.max(...handlers.map((block) => block.height));
    return {
      width: Math.max(main.width, handlersWidth),
      height: main.height + ROW_GAP + handlersHeight,
      axis: main.axis,
      place: (container, x, y, inbound) => {
        const exits = main.place(container, x, y, inbound);
        let left = x;
        for (const block of handlers) {
          block.place(container, left, y + main.height + ROW_GAP, []);
          left += block.width + GAP;
        }
        return exits;
      },
    };
  }

  private startsBlock(starts: Start[]): Block {
    const blocks = starts.map((start) => this.startBlock(start));
    if (blocks.length <= 1) return blocks[0] ?? EMPTY;
    // Several listens fire one function: their start events merge.
    const height = blocks.length * EVENT.height + (blocks.length - 1) * ROW_GAP;
    const width = EVENT.width + GAP + GATEWAY.width;
    return {
      width,
      height,
      axis: height / 2,
      place: (container, x, y) => {
        const exits = blocks.flatMap((block, position) => block.place(container, x, y + position * (EVENT.height + ROW_GAP), []));
        const merge = this.node(
          container,
          'bpmn:ExclusiveGateway',
          {},
          { x: x + EVENT.width + GAP, y: y + height / 2 - GATEWAY.height / 2, ...GATEWAY },
        );
        for (const exit of exits) this.connect(container, exit, merge);
        return [{ from: merge }];
      },
    };
  }

  private startBlock(start: Start): Block {
    return this.nodeBlock(EVENT, (container, rect) => {
      const definitions = (() => {
        switch (start.kind) {
          case 'timer':
            return [
              this.create('bpmn:TimerEventDefinition', 'TimerEventDefinition', {
                timeCycle: this.moddle.create('bpmn:FormalExpression', { body: start.cycle }),
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
        { name: start.name, documentation: this.documentation(start.doc), eventDefinitions: definitions },
        rect,
      );
      if (start.kind === 'message' && start.system !== undefined) {
        this.touches.push({ element, touch: { system: start.system, direction: 'read' } });
      }
      return element;
    });
  }
}

/** Names every path out of `block` (an event-based gateway arm's result). */
function named(block: Block, name: string | undefined): Block {
  if (name === undefined) return block;
  return { ...block, place: (container, x, y, inbound) => block.place(container, x, y, inbound).map((exit) => ({ ...exit, name })) };
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

function shorten(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
