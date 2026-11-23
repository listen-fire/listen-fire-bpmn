// What the diagram draws, before it is laid out: one tree per process, in
// program order. listen-fire's control flow is structured (no loops but
// collections, no jumps), so a tree of sequences, branches and scopes is
// enough; layout and XML are both a walk over it.

/** A system the program connects to (`gh = connect \`@lf/github\` using …`). */
export interface System {
  binding: string;
  /** The adapter, as the story analysis names it (`github`). */
  adapter: string;
  /** What the diagram calls it: the vocabulary's name ("GitHub"), with the
   *  binding added when two connections share an adapter ("Slack (ops)"). */
  display: string;
  icon?: string;
}

/** A step's reach into a connected system, drawn as a message flow labelled
 *  "reads Channels" or "writes Messages". */
export interface Touch {
  system: System;
  direction: 'read' | 'write';
  /** The edges walked or written along, as the program names them. */
  what: string;
}

/** The kind of step, for its colour: written into the file as BPMN in Color
 *  and as `lf:kind`, which the viewer stylesheet keys on. */
export type Look = 'ai' | 'read' | 'write' | 'decision' | 'failure' | 'plain';

export type TaskKind = 'service' | 'user' | 'call' | 'unmapped';

export interface TaskStep {
  kind: 'task';
  task: TaskKind;
  name: string;
  /** The name the program binds this step's result to, drawn as "→ result". */
  result?: string;
  look: Look;
  doc: string[];
  touches: Touch[];
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
  result?: string;
  doc: string[];
  /** The system whose arrival ends the wait, when there is one. */
  touches: Touch[];
}

export interface EndStep {
  kind: 'end';
  /** `none` ends its own path; `terminate` ends its whole scope (a race arm
   *  finishing first); `error` ends the run (`fail`). */
  end: 'none' | 'terminate' | 'error';
  name: string;
  /** An error end's error: the failure message as written. */
  error?: string;
  doc: string[];
}

export interface ChoiceArm {
  /** The condition as the program writes it: the flow's condition expression. */
  condition: string;
  /** What the flow is labelled: the condition, or the null rule's words. */
  label: string;
  flow: Flow;
}

export interface ChoiceStep {
  kind: 'choice';
  arms: ChoiceArm[];
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
  result?: string;
  doc: string[];
  touches: Touch[];
  repeat?: { sequential: boolean };
  flow: Flow;
}

export type Step = TaskStep | WaitStep | EndStep | ChoiceStep | AllStep | FirstEventStep | ScopeStep;

export type Flow = Step[];

export type Start =
  | { kind: 'timer'; name: string; result?: string; cycle?: string; doc: string[] }
  | { kind: 'none'; name: string; result?: string; doc: string[] }
  | { kind: 'message'; name: string; result?: string; message: string; touch?: Touch; doc: string[] };

export interface ProcessFlow {
  id: string;
  name: string;
  doc: string[];
  starts: Start[];
  flow: Flow;
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

/** A step's name as drawn: its result on a line of its own. */
export function withResult(name: string, result: string | undefined): string {
  return result === undefined ? name : `${name}\n→ ${result}`;
}

export function unreachable(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
}
