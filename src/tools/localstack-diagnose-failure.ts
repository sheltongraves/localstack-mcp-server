import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runPreflights, requireLocalStackRunning, requireAuthToken } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { withToolAnalytics } from "../core/analytics";
import { EventRoutingDiagnostics } from "../lib/diagnostics/event-routing";
import { DockerApiClient } from "../lib/docker/docker.client";

export const schema = {
  testOutput: z
    .string()
    .describe(
      "The failing test output (pytest, jest, etc.). The tool will parse assertion errors, " +
        "identify which AWS resources are involved, and trace through LocalStack to find the root cause."
    ),
  context: z
    .string()
    .optional()
    .describe("Additional context about the failure, such as the git diff or recent code changes."),
};

export const metadata: ToolMetadata = {
  name: "localstack-diagnose-failure",
  description:
    "Diagnoses integration test failures by analyzing test output, inspecting LocalStack resource state, " +
    "and tracing event flows to identify root causes. Especially effective at catching silent failures " +
    "in EventBridge, SQS dead-letter queues, and misconfigured IAM policies.",
  annotations: {
    title: "LocalStack Failure Diagnostician",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

interface DiagnosticFinding {
  severity: "critical" | "warning" | "info";
  category: string;
  description: string;
  evidence: string;
  suggestion: string;
}

export default async function localstackDiagnoseFailure({
  testOutput,
  context,
}: InferSchema<typeof schema>) {
  return withToolAnalytics(
    "localstack-diagnose-failure",
    { testOutput: testOutput.slice(0, 200), context: context?.slice(0, 200) },
    async () => {
      const preflightError = await runPreflights([requireAuthToken(), requireLocalStackRunning()]);
      if (preflightError) return preflightError;

      try {
        const findings: DiagnosticFinding[] = [];

        // Parse the test output for clues
        const parsedFailures = parseTestOutput(testOutput);

        // Run diagnostics based on what we find
        if (parsedFailures.involvesSqs) {
          const sqsFindings = await diagnoseSqs(parsedFailures);
          findings.push(...sqsFindings);
        }

        if (parsedFailures.involvesEventBridge) {
          const ebFindings = await diagnoseEventBridge(parsedFailures);
          findings.push(...ebFindings);
        }

        if (parsedFailures.involvesDynamodb) {
          const ddbFindings = await diagnoseDynamodb();
          findings.push(...ddbFindings);
        }

        if (parsedFailures.involvesS3) {
          const s3Findings = await diagnoseS3();
          findings.push(...s3Findings);
        }

        // If we couldn't determine service involvement, do a general check
        if (findings.length === 0) {
          const generalFindings = await diagnoseGeneral(testOutput);
          findings.push(...generalFindings);
        }

        return formatDiagnosis(parsedFailures, findings, context);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return ResponseBuilder.error("Diagnosis Failed", message);
      }
    }
  );
}

interface ParsedTestOutput {
  failingTests: string[];
  assertionErrors: string[];
  involvesSqs: boolean;
  involvesEventBridge: boolean;
  involvesDynamodb: boolean;
  involvesS3: boolean;
  involvesLambda: boolean;
  queueNames: string[];
  eventBusNames: string[];
  expectedMessages: number | null;
  actualMessages: number | null;
}

function parseTestOutput(output: string): ParsedTestOutput {
  const lines = output.split("\n");

  // Extract failing test names
  const failingTests: string[] = [];
  for (const line of lines) {
    const failMatch = line.match(/FAILED\s+(.+?)(?:\s+-|$)/);
    if (failMatch) failingTests.push(failMatch[1]);
  }

  // Extract assertion errors
  const assertionErrors: string[] = [];
  for (const line of lines) {
    if (/assert|AssertionError|Expected|expected/i.test(line) && !/^[-=]+$/.test(line.trim())) {
      assertionErrors.push(line.trim());
    }
  }

  // Detect service involvement
  const involvesSqs = /sqs|queue|receive_message|send_message/i.test(output);
  const involvesEventBridge = /eventbridge|event.?bridge|put_events|event.?bus|event.?rule/i.test(
    output
  );
  const involvesDynamodb = /dynamodb|dynamo|put_item|get_item|scan|query/i.test(output);
  const involvesS3 = /\bs3\b|bucket|put_object|get_object/i.test(output);
  const involvesLambda = /lambda|invoke|function/i.test(output);

  // Extract queue names
  const queueNames: string[] = [];
  const queueMatches = output.matchAll(/queue[_-]?(?:name|url)['":\s]*['"]?([a-zA-Z0-9_-]+)/gi);
  for (const m of queueMatches) queueNames.push(m[1]);

  // Extract event bus names
  const eventBusNames: string[] = [];
  const busMatches = output.matchAll(
    /(?:EventBusName|event[_-]?bus(?:_?name)?)['":\s=]+['"]?([a-zA-Z0-9_-]+)/gi
  );
  for (const m of busMatches) {
    // Filter out property key fragments that aren't real bus names
    const name = m[1];
    if (name && !/^(?:name|Name|url|arn)$/i.test(name)) {
      eventBusNames.push(name);
    }
  }

  // Try to extract expected vs actual message counts
  let expectedMessages: number | null = null;
  let actualMessages: number | null = null;
  const countMatch = output.match(/assert\s+len\(messages\)\s*(?:>=|==|>)\s*(\d+)/);
  if (countMatch) expectedMessages = parseInt(countMatch[1], 10);
  const emptyMatch = output.match(
    /assert\s+(?:len\(messages\)|resp\.get.*Messages.*)\s*==\s*(?:\[\]|0)/
  );
  if (emptyMatch) actualMessages = 0;

  return {
    failingTests,
    assertionErrors,
    involvesSqs,
    involvesEventBridge,
    involvesDynamodb,
    involvesS3,
    involvesLambda,
    queueNames,
    eventBusNames,
    expectedMessages,
    actualMessages,
  };
}

async function diagnoseSqs(parsed: ParsedTestOutput): Promise<DiagnosticFinding[]> {
  const findings: DiagnosticFinding[] = [];
  const diagnostics = new EventRoutingDiagnostics();

  for (const queueName of parsed.queueNames) {
    try {
      const depth = await diagnostics.getQueueDepth(queueName);
      if (depth.approximate === 0 && parsed.expectedMessages && parsed.expectedMessages > 0) {
        findings.push({
          severity: "critical",
          category: "Empty Queue",
          description: `Queue '${queueName}' is empty but tests expected ${parsed.expectedMessages} message(s).`,
          evidence: `ApproximateNumberOfMessages: ${depth.approximate}`,
          suggestion:
            "Messages are not arriving in the queue. Check if the producer (EventBridge rule, Lambda, or direct sender) is correctly configured.",
        });
      }
    } catch {
      findings.push({
        severity: "warning",
        category: "Queue Not Found",
        description: `Queue '${queueName}' does not exist.`,
        evidence: "GetQueueUrl returned an error",
        suggestion: "Ensure infrastructure provisioning created the queue before tests run.",
      });
    }
  }

  // Check for DLQ messages
  try {
    const docker = new DockerApiClient();
    const containerId = await docker.findLocalStackContainer();
    const result = await docker.executeInContainer(containerId, [
      "awslocal",
      "sqs",
      "list-queues",
      "--output",
      "json",
    ]);
    if (result.exitCode === 0) {
      const queues = JSON.parse(result.stdout);
      const dlqUrls = (queues.QueueUrls || []).filter((url: string) =>
        /dlq|dead.?letter/i.test(url)
      );
      for (const dlqUrl of dlqUrls) {
        const attrResult = await docker.executeInContainer(containerId, [
          "awslocal",
          "sqs",
          "get-queue-attributes",
          "--queue-url",
          dlqUrl,
          "--attribute-names",
          "ApproximateNumberOfMessages",
          "--output",
          "json",
        ]);
        if (attrResult.exitCode === 0) {
          const attrs = JSON.parse(attrResult.stdout).Attributes || {};
          const dlqDepth = parseInt(attrs.ApproximateNumberOfMessages || "0", 10);
          if (dlqDepth > 0) {
            findings.push({
              severity: "critical",
              category: "Dead Letter Queue Has Messages",
              description: `DLQ has ${dlqDepth} message(s) — processing failures are occurring.`,
              evidence: `Queue: ${dlqUrl}, Messages: ${dlqDepth}`,
              suggestion:
                "Messages are being sent to the DLQ, indicating processing errors. Check Lambda handler logs.",
            });
          }
        }
      }
    }
  } catch {
    // Non-critical — skip DLQ check
  }

  return findings;
}

async function diagnoseEventBridge(parsed: ParsedTestOutput): Promise<DiagnosticFinding[]> {
  const findings: DiagnosticFinding[] = [];
  const diagnostics = new EventRoutingDiagnostics();

  for (const busName of parsed.eventBusNames) {
    try {
      const buses = await diagnostics.listEventBuses();
      const bus = buses.find((b) => b.name === busName);

      if (!bus) {
        findings.push({
          severity: "critical",
          category: "Event Bus Not Found",
          description: `Event bus '${busName}' does not exist.`,
          evidence: `Available buses: ${buses.map((b) => b.name).join(", ") || "none"}`,
          suggestion: "Ensure infrastructure provisioning creates the event bus before tests run.",
        });
        continue;
      }

      const rules = await diagnostics.listRules(busName);
      if (rules.length === 0) {
        findings.push({
          severity: "critical",
          category: "No EventBridge Rules",
          description: `Event bus '${busName}' has no rules. All events will be silently dropped.`,
          evidence: "list-rules returned 0 rules",
          suggestion: "Create rules with appropriate event patterns to route events to targets.",
        });
      }

      // Check for disabled rules
      const disabledRules = rules.filter((r) => r.state === "DISABLED");
      if (disabledRules.length > 0) {
        findings.push({
          severity: "warning",
          category: "Disabled Rules",
          description: `${disabledRules.length} rule(s) are disabled on bus '${busName}'.`,
          evidence: `Disabled: ${disabledRules.map((r) => r.name).join(", ")}`,
          suggestion: "Enable rules that should be routing events.",
        });
      }

      // Check for rules with no targets
      const noTargetRules = rules.filter((r) => r.targets.length === 0);
      if (noTargetRules.length > 0) {
        findings.push({
          severity: "critical",
          category: "Rules Without Targets",
          description: `${noTargetRules.length} rule(s) have no targets — they match events but don't route them anywhere.`,
          evidence: `No targets: ${noTargetRules.map((r) => r.name).join(", ")}`,
          suggestion: "Add targets (SQS, Lambda, etc.) to these rules.",
        });
      }
    } catch {
      // Skip if we can't inspect this bus
    }
  }

  return findings;
}

async function diagnoseDynamodb(): Promise<DiagnosticFinding[]> {
  const findings: DiagnosticFinding[] = [];

  try {
    const docker = new DockerApiClient();
    const containerId = await docker.findLocalStackContainer();
    const result = await docker.executeInContainer(containerId, [
      "awslocal",
      "dynamodb",
      "list-tables",
      "--output",
      "json",
    ]);

    if (result.exitCode === 0) {
      const tables = JSON.parse(result.stdout).TableNames || [];
      if (tables.length === 0) {
        findings.push({
          severity: "critical",
          category: "No DynamoDB Tables",
          description: "No DynamoDB tables exist in LocalStack.",
          evidence: "list-tables returned 0 tables",
          suggestion: "Ensure infrastructure provisioning creates required tables.",
        });
      }
    }
  } catch {
    // Skip
  }

  return findings;
}

async function diagnoseS3(): Promise<DiagnosticFinding[]> {
  const findings: DiagnosticFinding[] = [];

  try {
    const docker = new DockerApiClient();
    const containerId = await docker.findLocalStackContainer();
    const result = await docker.executeInContainer(containerId, [
      "awslocal",
      "s3api",
      "list-buckets",
      "--output",
      "json",
    ]);

    if (result.exitCode === 0) {
      const buckets = JSON.parse(result.stdout).Buckets || [];
      if (buckets.length === 0) {
        findings.push({
          severity: "warning",
          category: "No S3 Buckets",
          description: "No S3 buckets exist in LocalStack.",
          evidence: "list-buckets returned 0 buckets",
          suggestion: "Ensure infrastructure provisioning creates required buckets.",
        });
      }
    }
  } catch {
    // Skip
  }

  return findings;
}

async function diagnoseGeneral(testOutput: string): Promise<DiagnosticFinding[]> {
  const findings: DiagnosticFinding[] = [];

  // Check for common error patterns
  if (/ResourceNotFoundException/i.test(testOutput)) {
    findings.push({
      severity: "critical",
      category: "Resource Not Found",
      description: "A test is trying to access an AWS resource that doesn't exist.",
      evidence: "ResourceNotFoundException in test output",
      suggestion:
        "Run infrastructure provisioning before tests. Check that table/queue/bucket names match.",
    });
  }

  if (/AccessDeniedException|UnauthorizedAccess/i.test(testOutput)) {
    findings.push({
      severity: "critical",
      category: "Access Denied",
      description: "IAM permissions are blocking the operation.",
      evidence: "AccessDeniedException in test output",
      suggestion:
        "Check IAM enforcement mode. Use the IAM policy analyzer to generate required policies.",
    });
  }

  if (/ConnectionRefused|ECONNREFUSED/i.test(testOutput)) {
    findings.push({
      severity: "critical",
      category: "Connection Refused",
      description: "Cannot connect to LocalStack.",
      evidence: "ConnectionRefused/ECONNREFUSED in test output",
      suggestion: "Ensure LocalStack is running and AWS_ENDPOINT_URL is set correctly.",
    });
  }

  if (/timeout|timed out/i.test(testOutput)) {
    findings.push({
      severity: "warning",
      category: "Timeout",
      description: "A test timed out waiting for a response or message.",
      evidence: "Timeout pattern detected in test output",
      suggestion:
        "Check if the expected message/event is actually being produced. Increase wait times if needed.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "info",
      category: "Manual Review Needed",
      description: "Could not automatically determine root cause from test output.",
      evidence: "No recognized patterns found",
      suggestion: "Check LocalStack logs with the logs-analysis tool for more context.",
    });
  }

  return findings;
}

function formatDiagnosis(
  parsed: ParsedTestOutput,
  findings: DiagnosticFinding[],
  context?: string
): ReturnType<typeof ResponseBuilder.markdown> {
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;

  let result = `# Test Failure Diagnosis\n\n`;

  // Summary
  if (parsed.failingTests.length > 0) {
    result += `**Failing Tests:** ${parsed.failingTests.length}\n`;
    for (const test of parsed.failingTests) {
      result += `  - \`${test}\`\n`;
    }
    result += `\n`;
  }

  result += `**Findings:** ${criticalCount} critical, ${warningCount} warnings\n`;

  // Services involved
  const services: string[] = [];
  if (parsed.involvesEventBridge) services.push("EventBridge");
  if (parsed.involvesSqs) services.push("SQS");
  if (parsed.involvesDynamodb) services.push("DynamoDB");
  if (parsed.involvesS3) services.push("S3");
  if (parsed.involvesLambda) services.push("Lambda");
  if (services.length > 0) {
    result += `**Services Involved:** ${services.join(", ")}\n`;
  }
  result += `\n`;

  // Findings
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  );

  for (const finding of sorted) {
    const icon =
      finding.severity === "critical" ? "🚨" : finding.severity === "warning" ? "⚠️" : "ℹ️";

    result += `## ${icon} ${finding.category}\n\n`;
    result += `${finding.description}\n\n`;
    result += `**Evidence:** ${finding.evidence}\n\n`;
    result += `**Suggestion:** ${finding.suggestion}\n\n`;
  }

  // Context analysis
  if (context) {
    result += `## Code Context\n\n`;
    // Look for source mismatches in the diff
    const sourceMatch = context.match(/[+-]\s*"Source":\s*"([^"]+)"/g);
    if (sourceMatch && sourceMatch.length > 1) {
      result += `Detected source field change in diff:\n`;
      for (const m of sourceMatch) {
        result += `  \`${m.trim()}\`\n`;
      }
      result += `\nThis may indicate an accidental change to the EventBridge event source.\n\n`;
    }
  }

  // Next steps
  result += `## Recommended Next Steps\n\n`;
  if (parsed.involvesEventBridge) {
    result += `1. Use \`localstack-inspect-event-routing\` to trace event routing\n`;
  }
  result += `${parsed.involvesEventBridge ? "2" : "1"}. Use \`localstack-logs-analysis\` with \`analysisType: "errors"\` to check LocalStack logs\n`;
  result += `${parsed.involvesEventBridge ? "3" : "2"}. Use \`localstack-aws-client\` to inspect specific resource state\n`;

  return ResponseBuilder.markdown(result);
}
