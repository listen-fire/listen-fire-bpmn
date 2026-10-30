// What the diagram draws, before it is laid out: one tree per process, in
// program order. listen-fire's control flow is structured (no loops but
// collections, no jumps), so a tree of sequences, branches and scopes is
// enough; layout and XML are both a walk over it.

/** A system the program connects to (`gh = connect github using …`). */
export interface System {
  binding: string;
  adapter: string;
  /** What the diagram calls it: "GitHub", or "Airtable (crm)" when two
   *  connections share an adapter. */
  display: string;
}

/** A task's reach into a connected system, drawn as a message flow. */
export interface Touch {
  system: System;
  direction: 'read' | 'write';
}

export type TaskKind = 'service' | 'send' | 'user' | 'call' | 'unmapped';

export interface TaskStep {
  kind: 'task';
  task: TaskKind;
  name: string;
  doc: string[];
  touches: Touch[];
  /** A model call: `extract(…)`, `extractOne(…)`, `ai(…)`. */
  ai?: true;
  /** The process a call activity calls. */
  calls?: string;
}

export type Trigger =
  | { kind: 'message'; message: string }
  | { kind: 'timer'; isoDuration: string }
  | { kind: 'condition'; condition: string };

export interface WaitStep {
  kind: 'wait';
  trigger: Trigger;
  name: string;
  doc: string[];
  /** The system whose event ends the wait, when there is one. */
  touches: Touch[];
}

export interface EndStep {
  kind: 'end';
  /** `none` ends its own path; `terminate` ends its whole scope (a race arm
   *  finishing first); `error` ends the run (`fail`). */
  end: 'none' | 'terminate' | 'error';
  name: string;
  doc: string[];
}

export interface ChoiceStep {
  kind: 'choice';
  arms: Array<{ condition: string; flow: Flow }>;
  /** The `else` arm. Absent: the gateway's default flow carries straight on. */
  otherwise?: Flow;
  doc: string[];
}

/** `all(f, g)`: a parallel split and join. */
export interface AllStep {
  kind: 'all';
  arms: Flow[];
  doc: string[];
}

/** `race(…)` whose arms are each one wait: an event-based gateway. */
export interface FirstEventStep {
  kind: 'firstEvent';
  arms: Array<{ wait: WaitStep; result?: string }>;
  doc: string[];
}

/** A subprocess: a traversal block, a `map`, a race of several steps, or an
 *  `all` arm that returns early. */
export interface ScopeStep {
  kind: 'scope';
  name: string;
  doc: string[];
  touches: Touch[];
  repeat?: { sequential: boolean };
  /** A race of several steps: its arms split in parallel and the first to
   *  reach a terminate end event ends the scope. */
  race?: true;
  body: Body;
}

export type Step = TaskStep | WaitStep | EndStep | ChoiceStep | AllStep | FirstEventStep | ScopeStep;

export type Flow = Step[];

/** A callback: an event subprocess started by its message. */
export interface Handler {
  name: string;
  message: string;
  interrupting: boolean;
  doc: string[];
  body: Body;
}

export interface Body {
  flow: Flow;
  handlers: Handler[];
}

export type Start =
  | { kind: 'timer'; name: string; cycle: string; doc: string[] }
  | { kind: 'none'; name: string; doc: string[] }
  | { kind: 'message'; name: string; message: string; system?: System; doc: string[] };

export interface ProcessFlow {
  id: string;
  name: string;
  doc: string[];
  starts: Start[];
  body: Body;
}

export interface Diagram {
  processes: ProcessFlow[];
  systems: System[];
  warnings: string[];
}

/** Whether no path through `flow` reaches its end (each path ended at an
 *  end event). */
export function flowEnds(flow: Flow): boolean {
  return flow.some(stepEnds);
}

export function stepEnds(step: Step): boolean {
  switch (step.kind) {
    case 'end':
      return true;
    case 'choice':
      return step.otherwise !== undefined && flowEnds(step.otherwise) && step.arms.every((arm) => flowEnds(arm.flow));
    case 'all':
      return step.arms.length > 0 && step.arms.every(flowEnds);
    case 'task':
    case 'wait':
    case 'firstEvent':
    case 'scope':
      return false;
    default:
      return unreachable(step);
  }
}

export function unreachable(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
}
