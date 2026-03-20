import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runPreflights, requireLocalStackRunning, requireAuthToken } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { EventRoutingDiagnostics } from "../lib/diagnostics/event-routing";

export const schema = {
  eventBusName: z
    .string()
    .optional()
    .describe("The EventBridge event bus to inspect. If omitted, lists all buses and their rules."),
  source: z
    .string()
    .optional()
    .describe(
      "The event source to test against rules (e.g., 'orders.api'). When provided with eventBusName, traces whether this event would be routed."
    ),
  detailType: z
    .string()
    .optional()
    .describe(
      "The event detail-type to test against rules (e.g., 'ORDER_PLACED'). Used together with source for full route tracing."
    ),
};

export const metadata: ToolMetadata = {
  name: "localstack-inspect-event-routing",
  description:
    "Inspects EventBridge event routing in LocalStack: lists buses, rules, targets, and traces whether a specific event would match any rules or silently fail. Essential for diagnosing silent failures where EventBridge returns success but events are dropped.",
  annotations: {
    title: "LocalStack Event Routing Inspector",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function localstackInspectEventRouting({
  eventBusName,
  source,
  detailType,
}: InferSchema<typeof schema>) {
  return withToolAnalytics(
    "localstack-inspect-event-routing",
    { eventBusName, source, detailType },
    async () => {
      const preflightError = await runPreflights([requireAuthToken(), requireLocalStackRunning()]);
      if (preflightError) return preflightError;

      try {
        const diagnostics = new EventRoutingDiagnostics();

        // If no bus specified, show overview of all buses
        if (!eventBusName) {
          return await handleOverview(diagnostics);
        }

        // Trace event routing on the specified bus
        const trace = await diagnostics.traceEvent(eventBusName, source, detailType);
        return formatTrace(trace, source, detailType);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return ResponseBuilder.error("Event Routing Inspection Failed", message);
      }
    }
  );
}

async function handleOverview(diagnostics: EventRoutingDiagnostics) {
  const buses = await diagnostics.listEventBuses();

  if (buses.length === 0) {
    return ResponseBuilder.markdown(
      "# EventBridge Overview\n\nNo event buses found in LocalStack. " +
        "Create one with `awslocal events create-event-bus --name <bus-name>`."
    );
  }

  let result = `# EventBridge Overview\n\n`;
  result += `**Event Buses:** ${buses.length}\n\n`;

  for (const bus of buses) {
    const rules = await diagnostics.listRules(bus.name);
    result += `## ${bus.name}\n`;
    result += `**ARN:** \`${bus.arn}\`\n`;
    result += `**Rules:** ${rules.length}\n\n`;

    if (rules.length > 0) {
      for (const rule of rules) {
        const targetCount = rule.targets.length;
        result += `- **${rule.name}** (${rule.state})`;
        if (rule.eventPattern) {
          result += ` — pattern: \`${rule.eventPattern}\``;
        }
        result += ` → ${targetCount} target(s)\n`;
        for (const target of rule.targets) {
          result += `  - \`${target.arn}\`\n`;
        }
      }
    } else {
      result += `*No rules — all events to this bus will be silently dropped*\n`;
    }
    result += `\n`;
  }

  result += `---\n**Trace an event:** provide \`eventBusName\` + \`source\` to check if an event would be routed or silently dropped.\n`;

  return ResponseBuilder.markdown(result);
}

function formatTrace(
  trace: {
    eventBus: { name: string; arn: string };
    rules: Array<{
      name: string;
      eventPattern: string | null;
      state: string;
      targets: Array<{ id: string; arn: string }>;
    }>;
    matchingRules: Array<{ name: string }>;
    nonMatchingRules: Array<{ name: string }>;
    diagnosis: string;
  },
  source?: string,
  detailType?: string
) {
  const isTracing = source || detailType;
  const hasMatch = trace.matchingRules.length > 0;

  let result = `# EventBridge Route Trace\n\n`;
  result += `**Bus:** ${trace.eventBus.name}\n`;

  if (isTracing) {
    result += `**Event Source:** \`${source || "(any)"}\`\n`;
    result += `**Detail Type:** \`${detailType || "(any)"}\`\n`;
    result += `**Status:** ${hasMatch ? "✅ ROUTED" : "🚨 SILENT FAILURE — EVENT WILL BE DROPPED"}\n\n`;
  }

  // Show all rules
  result += `## Rules (${trace.rules.length})\n\n`;

  for (const rule of trace.rules) {
    const isMatch = trace.matchingRules.includes(rule);
    const icon = !isTracing ? "📋" : isMatch ? "✅" : "❌";

    result += `### ${icon} ${rule.name}\n`;
    result += `**State:** ${rule.state}\n`;
    if (rule.eventPattern) {
      result += `**Pattern:** \`${rule.eventPattern}\`\n`;
    }
    result += `**Targets:**\n`;
    for (const target of rule.targets) {
      result += `  - \`${target.arn}\`\n`;
    }
    result += `\n`;
  }

  // Diagnosis
  result += `## Diagnosis\n\n${trace.diagnosis}\n`;

  if (!hasMatch && isTracing) {
    result += `\n### What This Means\n\n`;
    result += `EventBridge will accept this event and return \`FailedEntryCount: 0\` (success), `;
    result += `but **no downstream system will ever receive it**. The event silently vanishes.\n\n`;
    result += `This is one of the most common and dangerous bugs in event-driven architectures.\n`;
  }

  return ResponseBuilder.markdown(result);
}
