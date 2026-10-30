// bpmn-moddle ships element types (bpmn-moddle/types) but none for its entry
// point. This declares the three calls this tool makes, and no more.
declare module 'bpmn-moddle' {
  export interface ModdleElement {
    readonly $type: string;
    id?: string;
    $instanceOf(type: string): boolean;
    [property: string]: unknown;
  }

  export interface ParseWarning {
    message: string;
  }

  export class BpmnModdle {
    create(type: string, attributes?: Record<string, unknown>): ModdleElement;
    toXML(element: ModdleElement, options?: { format?: boolean }): Promise<{ xml: string }>;
    fromXML(
      xml: string,
      typeName?: string,
    ): Promise<{
      rootElement: ModdleElement;
      warnings: ParseWarning[];
      elementsById: Record<string, ModdleElement>;
    }>;
  }
}
