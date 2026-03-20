import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runPreflights, requireLocalStackRunning, requireAuthToken } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { DockerApiClient } from "../lib/docker/docker.client";

export const schema = {
  service: z
    .enum(["eventbridge", "sqs", "dynamodb", "s3", "lambda"])
    .describe("The AWS service to inspect for resource state."),
  expected: z
    .string()
    .optional()
    .describe(
      "JSON string describing the expected resource state. " +
        'For EventBridge: {"busName": "...", "rules": [{"name": "...", "pattern": {...}, "targets": [...]}]}. ' +
        "The tool compares this against the actual state in LocalStack."
    ),
};

export const metadata: ToolMetadata = {
  name: "localstack-resource-diff",
  description:
    "Compares expected vs actual AWS resource state in LocalStack. " +
    "Shows what resources exist, what's missing, and what's misconfigured. " +
    "Useful for verifying infrastructure provisioning and catching configuration drift.",
  annotations: {
    title: "LocalStack Resource Diff",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

interface ResourceState {
  name: string;
  type: string;
  properties: Record<string, unknown>;
}

interface DiffResult {
  matching: string[];
  missing: string[];
  extra: string[];
  mismatched: Array<{ resource: string; field: string; expected: unknown; actual: unknown }>;
}

export default async function localstackResourceDiff({
  service,
  expected,
}: InferSchema<typeof schema>) {
  return withToolAnalytics("localstack-resource-diff", { service }, async () => {
    const preflightError = await runPreflights([requireAuthToken(), requireLocalStackRunning()]);
    if (preflightError) return preflightError;

    try {
      const docker = new DockerApiClient();
      const containerId = await docker.findLocalStackContainer();

      const actualResources = await getActualResources(docker, containerId, service);

      if (!expected) {
        // No expected state — just show what exists
        return formatResourceInventory(service, actualResources);
      }

      // Compare against expected state
      const expectedParsed = JSON.parse(expected);
      const diff = compareResources(service, expectedParsed, actualResources);
      return formatDiff(service, diff, actualResources);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return ResponseBuilder.error("Resource Diff Failed", message);
    }
  });
}

async function getActualResources(
  docker: DockerApiClient,
  containerId: string,
  service: string
): Promise<ResourceState[]> {
  switch (service) {
    case "eventbridge":
      return getEventBridgeResources(docker, containerId);
    case "sqs":
      return getSqsResources(docker, containerId);
    case "dynamodb":
      return getDynamoDbResources(docker, containerId);
    case "s3":
      return getS3Resources(docker, containerId);
    case "lambda":
      return getLambdaResources(docker, containerId);
    default:
      return [];
  }
}

async function getEventBridgeResources(
  docker: DockerApiClient,
  containerId: string
): Promise<ResourceState[]> {
  const resources: ResourceState[] = [];

  // List buses
  const busResult = await docker.executeInContainer(containerId, [
    "awslocal",
    "events",
    "list-event-buses",
    "--output",
    "json",
  ]);
  if (busResult.exitCode !== 0) return resources;

  const buses = JSON.parse(busResult.stdout).EventBuses || [];
  for (const bus of buses) {
    // List rules for each bus
    const rulesResult = await docker.executeInContainer(containerId, [
      "awslocal",
      "events",
      "list-rules",
      "--event-bus-name",
      bus.Name,
      "--output",
      "json",
    ]);

    const rules = rulesResult.exitCode === 0 ? JSON.parse(rulesResult.stdout).Rules || [] : [];
    const ruleDetails: Array<Record<string, unknown>> = [];

    for (const rule of rules) {
      // Get targets
      const targetsResult = await docker.executeInContainer(containerId, [
        "awslocal",
        "events",
        "list-targets-by-rule",
        "--rule",
        rule.Name,
        "--event-bus-name",
        bus.Name,
        "--output",
        "json",
      ]);

      const targets =
        targetsResult.exitCode === 0 ? JSON.parse(targetsResult.stdout).Targets || [] : [];

      ruleDetails.push({
        name: rule.Name,
        state: rule.State,
        eventPattern: rule.EventPattern ? JSON.parse(rule.EventPattern) : null,
        targetCount: targets.length,
        targets: targets.map((t: { Id: string; Arn: string }) => ({ id: t.Id, arn: t.Arn })),
      });
    }

    resources.push({
      name: bus.Name,
      type: "EventBus",
      properties: {
        arn: bus.Arn,
        ruleCount: rules.length,
        rules: ruleDetails,
      },
    });
  }

  return resources;
}

async function getSqsResources(
  docker: DockerApiClient,
  containerId: string
): Promise<ResourceState[]> {
  const resources: ResourceState[] = [];

  const result = await docker.executeInContainer(containerId, [
    "awslocal",
    "sqs",
    "list-queues",
    "--output",
    "json",
  ]);
  if (result.exitCode !== 0) return resources;

  const queueUrls = JSON.parse(result.stdout).QueueUrls || [];
  for (const url of queueUrls) {
    const attrResult = await docker.executeInContainer(containerId, [
      "awslocal",
      "sqs",
      "get-queue-attributes",
      "--queue-url",
      url,
      "--attribute-names",
      "All",
      "--output",
      "json",
    ]);

    const attrs = attrResult.exitCode === 0 ? JSON.parse(attrResult.stdout).Attributes || {} : {};

    const queueName = url.split("/").pop() || url;
    resources.push({
      name: queueName,
      type: "Queue",
      properties: {
        url,
        approximateMessages: parseInt(attrs.ApproximateNumberOfMessages || "0", 10),
        hasDlq: !!attrs.RedrivePolicy,
        visibilityTimeout: attrs.VisibilityTimeout,
      },
    });
  }

  return resources;
}

async function getDynamoDbResources(
  docker: DockerApiClient,
  containerId: string
): Promise<ResourceState[]> {
  const resources: ResourceState[] = [];

  const result = await docker.executeInContainer(containerId, [
    "awslocal",
    "dynamodb",
    "list-tables",
    "--output",
    "json",
  ]);
  if (result.exitCode !== 0) return resources;

  const tables = JSON.parse(result.stdout).TableNames || [];
  for (const tableName of tables) {
    const descResult = await docker.executeInContainer(containerId, [
      "awslocal",
      "dynamodb",
      "describe-table",
      "--table-name",
      tableName,
      "--output",
      "json",
    ]);

    if (descResult.exitCode === 0) {
      const table = JSON.parse(descResult.stdout).Table || {};
      resources.push({
        name: tableName,
        type: "Table",
        properties: {
          status: table.TableStatus,
          itemCount: table.ItemCount,
          keySchema: table.KeySchema,
          gsiCount: (table.GlobalSecondaryIndexes || []).length,
        },
      });
    }
  }

  return resources;
}

async function getS3Resources(
  docker: DockerApiClient,
  containerId: string
): Promise<ResourceState[]> {
  const result = await docker.executeInContainer(containerId, [
    "awslocal",
    "s3api",
    "list-buckets",
    "--output",
    "json",
  ]);
  if (result.exitCode !== 0) return [];

  const buckets = JSON.parse(result.stdout).Buckets || [];
  return buckets.map((b: { Name: string; CreationDate: string }) => ({
    name: b.Name,
    type: "Bucket",
    properties: { creationDate: b.CreationDate },
  }));
}

async function getLambdaResources(
  docker: DockerApiClient,
  containerId: string
): Promise<ResourceState[]> {
  const result = await docker.executeInContainer(containerId, [
    "awslocal",
    "lambda",
    "list-functions",
    "--output",
    "json",
  ]);
  if (result.exitCode !== 0) return [];

  const functions = JSON.parse(result.stdout).Functions || [];
  return functions.map(
    (f: { FunctionName: string; Runtime: string; Handler: string; State: string }) => ({
      name: f.FunctionName,
      type: "Function",
      properties: {
        runtime: f.Runtime,
        handler: f.Handler,
        state: f.State,
      },
    })
  );
}

function compareResources(
  service: string,
  expected: Record<string, unknown>,
  actual: ResourceState[]
): DiffResult {
  const diff: DiffResult = {
    matching: [],
    missing: [],
    extra: [],
    mismatched: [],
  };

  if (service === "eventbridge" && expected.busName) {
    const bus = actual.find((r) => r.name === expected.busName);
    if (!bus) {
      diff.missing.push(`EventBus: ${expected.busName}`);
    } else {
      diff.matching.push(`EventBus: ${expected.busName}`);

      // Check rules
      const expectedRules = (expected.rules as Array<Record<string, unknown>>) || [];
      const actualRules = (bus.properties.rules as Array<Record<string, unknown>>) || [];

      for (const expRule of expectedRules) {
        const actRule = actualRules.find((r) => r.name === expRule.name);
        if (!actRule) {
          diff.missing.push(`Rule: ${expRule.name}`);
        } else {
          diff.matching.push(`Rule: ${expRule.name}`);

          // Compare event pattern
          if (expRule.pattern && actRule.eventPattern) {
            const expPattern = JSON.stringify(expRule.pattern);
            const actPattern = JSON.stringify(actRule.eventPattern);
            if (expPattern !== actPattern) {
              diff.mismatched.push({
                resource: `Rule: ${expRule.name}`,
                field: "eventPattern",
                expected: expRule.pattern,
                actual: actRule.eventPattern,
              });
            }
          }
        }
      }

      // Check for extra rules not in expected
      const expectedNames = new Set(expectedRules.map((r) => r.name));
      for (const actRule of actualRules) {
        if (!expectedNames.has(actRule.name as string)) {
          diff.extra.push(`Rule: ${actRule.name}`);
        }
      }
    }
  }

  return diff;
}

function formatResourceInventory(service: string, resources: ResourceState[]) {
  if (resources.length === 0) {
    return ResponseBuilder.markdown(
      `# ${service.toUpperCase()} Resources\n\nNo ${service} resources found in LocalStack.`
    );
  }

  let result = `# ${service.toUpperCase()} Resources\n\n`;
  result += `**Total:** ${resources.length}\n\n`;

  for (const resource of resources) {
    result += `## ${resource.type}: ${resource.name}\n\n`;
    result += `\`\`\`json\n${JSON.stringify(resource.properties, null, 2)}\n\`\`\`\n\n`;
  }

  result += `---\nProvide \`expected\` parameter to compare against desired state.\n`;

  return ResponseBuilder.markdown(result);
}

function formatDiff(service: string, diff: DiffResult, actual: ResourceState[]) {
  const hasIssues = diff.missing.length > 0 || diff.mismatched.length > 0;

  let result = `# ${service.toUpperCase()} Resource Diff\n\n`;
  result += `**Status:** ${hasIssues ? "🚨 DRIFT DETECTED" : "✅ MATCHES EXPECTED"}\n\n`;

  if (diff.matching.length > 0) {
    result += `## ✅ Matching (${diff.matching.length})\n\n`;
    for (const r of diff.matching) result += `- ${r}\n`;
    result += `\n`;
  }

  if (diff.missing.length > 0) {
    result += `## 🚨 Missing (${diff.missing.length})\n\n`;
    for (const r of diff.missing) result += `- ${r}\n`;
    result += `\n`;
  }

  if (diff.extra.length > 0) {
    result += `## ℹ️ Extra (${diff.extra.length})\n\n`;
    for (const r of diff.extra) result += `- ${r}\n`;
    result += `\n`;
  }

  if (diff.mismatched.length > 0) {
    result += `## ⚠️ Mismatched (${diff.mismatched.length})\n\n`;
    for (const m of diff.mismatched) {
      result += `### ${m.resource}\n`;
      result += `**Field:** \`${m.field}\`\n`;
      result += `**Expected:**\n\`\`\`json\n${JSON.stringify(m.expected, null, 2)}\n\`\`\`\n`;
      result += `**Actual:**\n\`\`\`json\n${JSON.stringify(m.actual, null, 2)}\n\`\`\`\n\n`;
    }
  }

  return ResponseBuilder.markdown(result);
}
