import { DockerApiClient } from "../docker/docker.client";

export interface EventBusInfo {
  name: string;
  arn: string;
}

export interface RuleInfo {
  name: string;
  eventBusName: string;
  eventPattern: string | null;
  state: string;
  targets: TargetInfo[];
}

export interface TargetInfo {
  id: string;
  arn: string;
  inputTransformer?: string;
}

export interface EventRouteTrace {
  eventBus: EventBusInfo;
  rules: RuleInfo[];
  matchingRules: RuleInfo[];
  nonMatchingRules: RuleInfo[];
  diagnosis: string;
}

export interface EventPatternMismatch {
  field: string;
  ruleExpects: string;
  eventHas: string;
}

/**
 * Traces an event through EventBridge routing to identify where it lands (or doesn't).
 */
export class EventRoutingDiagnostics {
  private docker: DockerApiClient;

  constructor() {
    this.docker = new DockerApiClient();
  }

  /**
   * List all custom event buses.
   */
  async listEventBuses(): Promise<EventBusInfo[]> {
    const containerId = await this.docker.findLocalStackContainer();
    const result = await this.docker.executeInContainer(containerId, [
      "awslocal",
      "events",
      "list-event-buses",
      "--output",
      "json",
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list event buses: ${result.stderr}`);
    }

    const parsed = JSON.parse(result.stdout);
    return (parsed.EventBuses || []).map((bus: { Name: string; Arn: string }) => ({
      name: bus.Name,
      arn: bus.Arn,
    }));
  }

  /**
   * List all rules on a given event bus.
   */
  async listRules(eventBusName: string): Promise<RuleInfo[]> {
    const containerId = await this.docker.findLocalStackContainer();
    const result = await this.docker.executeInContainer(containerId, [
      "awslocal",
      "events",
      "list-rules",
      "--event-bus-name",
      eventBusName,
      "--output",
      "json",
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list rules for bus '${eventBusName}': ${result.stderr}`);
    }

    const parsed = JSON.parse(result.stdout);
    const rules: RuleInfo[] = [];

    for (const rule of parsed.Rules || []) {
      const targets = await this.listTargets(rule.Name, eventBusName);
      rules.push({
        name: rule.Name,
        eventBusName: eventBusName,
        eventPattern: rule.EventPattern || null,
        state: rule.State || "UNKNOWN",
        targets,
      });
    }

    return rules;
  }

  /**
   * List targets for a specific rule.
   */
  async listTargets(ruleName: string, eventBusName: string): Promise<TargetInfo[]> {
    const containerId = await this.docker.findLocalStackContainer();
    const result = await this.docker.executeInContainer(containerId, [
      "awslocal",
      "events",
      "list-targets-by-rule",
      "--rule",
      ruleName,
      "--event-bus-name",
      eventBusName,
      "--output",
      "json",
    ]);

    if (result.exitCode !== 0) {
      return [];
    }

    const parsed = JSON.parse(result.stdout);
    return (parsed.Targets || []).map((t: { Id: string; Arn: string }) => ({
      id: t.Id,
      arn: t.Arn,
    }));
  }

  /**
   * Analyze whether a given event (source + detail-type) would match any rules on a bus.
   * This does pattern comparison locally without calling test-event-pattern.
   */
  analyzeEventAgainstRules(
    eventSource: string,
    eventDetailType: string,
    rules: RuleInfo[]
  ): {
    matching: RuleInfo[];
    nonMatching: RuleInfo[];
    mismatches: Map<string, EventPatternMismatch[]>;
  } {
    const matching: RuleInfo[] = [];
    const nonMatching: RuleInfo[] = [];
    const mismatches = new Map<string, EventPatternMismatch[]>();

    for (const rule of rules) {
      if (!rule.eventPattern) {
        // Rules without patterns match everything
        matching.push(rule);
        continue;
      }

      let pattern: Record<string, unknown>;
      try {
        pattern = JSON.parse(rule.eventPattern);
      } catch {
        nonMatching.push(rule);
        continue;
      }

      const ruleMismatches: EventPatternMismatch[] = [];
      let matches = true;

      // Check source pattern
      if (pattern.source) {
        const allowedSources = pattern.source as string[];
        if (!allowedSources.includes(eventSource)) {
          matches = false;
          ruleMismatches.push({
            field: "source",
            ruleExpects: JSON.stringify(allowedSources),
            eventHas: eventSource,
          });
        }
      }

      // Check detail-type pattern
      if (pattern["detail-type"]) {
        const allowedTypes = pattern["detail-type"] as string[];
        if (!allowedTypes.includes(eventDetailType)) {
          matches = false;
          ruleMismatches.push({
            field: "detail-type",
            ruleExpects: JSON.stringify(allowedTypes),
            eventHas: eventDetailType,
          });
        }
      }

      if (matches) {
        matching.push(rule);
      } else {
        nonMatching.push(rule);
        mismatches.set(rule.name, ruleMismatches);
      }
    }

    return { matching, nonMatching, mismatches };
  }

  /**
   * Full trace: given an event bus and event attributes, trace the entire routing path.
   */
  async traceEvent(
    eventBusName: string,
    eventSource?: string,
    eventDetailType?: string
  ): Promise<EventRouteTrace> {
    const buses = await this.listEventBuses();
    const bus = buses.find((b) => b.name === eventBusName);

    if (!bus) {
      const busNames = buses.map((b) => b.name).join(", ");
      throw new Error(
        `Event bus '${eventBusName}' not found. Available buses: ${busNames || "none"}`
      );
    }

    const rules = await this.listRules(eventBusName);

    if (!eventSource && !eventDetailType) {
      // No event to match — just return the topology
      return {
        eventBus: bus,
        rules,
        matchingRules: [],
        nonMatchingRules: [],
        diagnosis:
          rules.length === 0
            ? `Event bus '${eventBusName}' has no rules configured. All events will be dropped.`
            : `Event bus '${eventBusName}' has ${rules.length} rule(s). Provide source/detail-type to check matching.`,
      };
    }

    const { matching, nonMatching, mismatches } = this.analyzeEventAgainstRules(
      eventSource || "",
      eventDetailType || "",
      rules
    );

    let diagnosis: string;
    if (matching.length > 0) {
      const targetDescs = matching
        .flatMap((r) => r.targets.map((t) => `${r.name} → ${t.arn}`))
        .join(", ");
      diagnosis = `Event matches ${matching.length} rule(s) and will be routed to: ${targetDescs}`;
    } else {
      // Build detailed mismatch explanation
      const mismatchDetails: string[] = [];
      for (const [ruleName, fields] of mismatches) {
        for (const m of fields) {
          mismatchDetails.push(
            `Rule '${ruleName}' expects ${m.field}=${m.ruleExpects} but event has ${m.field}="${m.eventHas}"`
          );
        }
      }
      diagnosis =
        `SILENT FAILURE: Event matches 0 rules and will be silently dropped. ` +
        `EventBridge will return SUCCESS but nothing will process this event.\n\n` +
        `Mismatches:\n${mismatchDetails.map((d) => `  - ${d}`).join("\n")}`;
    }

    return {
      eventBus: bus,
      rules,
      matchingRules: matching,
      nonMatchingRules: nonMatching,
      diagnosis,
    };
  }

  /**
   * Check the current depth of an SQS queue (approximate message count).
   */
  async getQueueDepth(queueName: string): Promise<{ approximate: number; queueUrl: string }> {
    const containerId = await this.docker.findLocalStackContainer();

    // Get queue URL
    const urlResult = await this.docker.executeInContainer(containerId, [
      "awslocal",
      "sqs",
      "get-queue-url",
      "--queue-name",
      queueName,
      "--output",
      "json",
    ]);

    if (urlResult.exitCode !== 0) {
      throw new Error(`Queue '${queueName}' not found: ${urlResult.stderr}`);
    }

    const queueUrl = JSON.parse(urlResult.stdout).QueueUrl;

    // Get attributes
    const attrResult = await this.docker.executeInContainer(containerId, [
      "awslocal",
      "sqs",
      "get-queue-attributes",
      "--queue-url",
      queueUrl,
      "--attribute-names",
      "ApproximateNumberOfMessages",
      "--output",
      "json",
    ]);

    if (attrResult.exitCode !== 0) {
      throw new Error(`Failed to get queue attributes: ${attrResult.stderr}`);
    }

    const attrs = JSON.parse(attrResult.stdout).Attributes || {};
    return {
      approximate: parseInt(attrs.ApproximateNumberOfMessages || "0", 10),
      queueUrl,
    };
  }
}
