import type { InvestigationPhase } from "../../../shared/types/chat";
import type { Difficulty, Scenario } from "../../../shared/types/game";
import { utcOffsetMinutes, utcDaysAgo } from "./sim-clock";

const REGION = "eastus";

function severityForDifficulty(difficulty: Difficulty): "Sev2" | "Sev3" | "Sev4" {
  if (difficulty === "hard") return "Sev2";
  if (difficulty === "medium") return "Sev3";
  return "Sev4";
}

export function generateMockScenario(difficulty: Difficulty): Scenario {
  const clusterName = `aro-${difficulty}-mock`;
  return {
    id: `scenario_mock_${difficulty}`,
    title: `Mock ${difficulty.toUpperCase()} scenario`,
    difficulty,
    description:
      "Mock AI mode scenario used to validate cluster deployment wiring.",
    incidentTicket: {
      id: `IcM-MOCK-${difficulty.toUpperCase()}`,
      severity: severityForDifficulty(difficulty),
      title: `Mock incident for ${difficulty} difficulty`,
      description:
        "This ticket is generated in AI mock mode to validate end-to-end plumbing.",
      customerImpact:
        "No customer impact. This is a non-production mock validation scenario.",
      reportedTime: utcDaysAgo(),
      clusterName,
      region: REGION,
    },
    clusterContext: {
      name: clusterName,
      version: "4.19.9",
      region: REGION,
      nodeCount: difficulty === "easy" ? 6 : difficulty === "medium" ? 9 : 12,
      status: "Degraded (mock)",
      recentEvents: [
        `${utcOffsetMinutes(-40)} - monitor: mock alert triggered`,
        `${utcOffsetMinutes(-35)} - kubelet: probe timeout observed`,
      ],
      alerts: [
        {
          name: "MockProbeFailure",
          severity: difficulty === "hard" ? "critical" : "warning",
          message: "Mock AI mode alert to validate UI and command path.",
          firingTime: utcOffsetMinutes(-25),
        },
      ],
      upgradeHistory: [
        {
          from: "4.19.8",
          to: "4.19.9",
          status: "completed",
          timestamp: utcOffsetMinutes(-180),
        },
      ],
    },
  };
}

export function generateMockChatResponse(phase: InvestigationPhase): string {
  const markerPhase = phase || "reading";
  return [
    "**Mock AI mode is enabled.**",
    "",
    "The backend is reachable and chat streaming works, but no live Vertex call is performed.",
    "",
    "**Next step:** use `/api/ai/probe?live=true` with AI_MOCK_MODE disabled to verify real connectivity.",
    "",
    `[PHASE:${markerPhase}]`,
    "[SCORE:efficiency:+1:Validated mock AI chat path]",
  ].join("\n");
}

function mockOcOutput(command: string): string {
  const trimmed = command.replace(/^oc\s+/, "");

  if (/^describe\s+node/i.test(trimmed)) {
    const nameMatch = trimmed.match(/^describe\s+node\s+(\S+)/i);
    const nodeName = nameMatch?.[1] ?? "master-0";
    return [
      `Name:               ${nodeName}`,
      `Roles:              master`,
      `Labels:             kubernetes.io/hostname=${nodeName}`,
      `                    node-role.kubernetes.io/master=`,
      `                    node.openshift.io/os_id=rhcos`,
      `Annotations:        machineconfiguration.openshift.io/state: Done`,
      `CreationTimestamp:   ${utcOffsetMinutes(-90 * 24 * 60)}`,
      `Taints:             <none>`,
      `Unschedulable:      false`,
      `Conditions:`,
      `  Type                 Status  LastHeartbeatTime                 Reason                       Message`,
      `  ----                 ------  -----------------                 ------                       -------`,
      `  MemoryPressure       False   ${utcOffsetMinutes(-2)}   KubeletHasSufficientMemory   kubelet has sufficient memory available`,
      `  DiskPressure         False   ${utcOffsetMinutes(-2)}   KubeletHasNoDiskPressure     kubelet has no disk pressure`,
      `  PIDPressure          False   ${utcOffsetMinutes(-2)}   KubeletHasSufficientPID      kubelet has sufficient PID available`,
      `  Ready                True    ${utcOffsetMinutes(-2)}   KubeletReady                 kubelet is posting ready status`,
      `Addresses:`,
      `  InternalIP:  10.0.1.4`,
      `  Hostname:    ${nodeName}`,
      `Capacity:`,
      `  cpu:                8`,
      `  memory:             32Gi`,
      `  pods:               250`,
      `Allocatable:`,
      `  cpu:                7500m`,
      `  memory:             30Gi`,
      `  pods:               250`,
      `Events:`,
      `  Type    Reason    Age    From     Message`,
      `  ----    ------    ----   ----     -------`,
      `  Normal  Starting  90d    kubelet  Starting kubelet.`,
    ].join("\n");
  }

  if (/^describe\s+machine\b/i.test(trimmed)) {
    const withNs = trimmed.match(/^describe\s+machine\s+-n\s+\S+\s+(\S+)/i);
    let name = withNs?.[1];
    if (!name) {
      const simple = trimmed.match(/^describe\s+machine\s+(\S+)/i);
      const token = simple?.[1];
      if (token && token !== "-n" && token !== "--namespace") {
        name = token;
      }
    }
    name ??= "machine-mock-0";
    return [
      `Name:         ${name}`,
      `Namespace:    openshift-machine-api`,
      `Labels:       machine.openshift.io/cluster-api-cluster=mock`,
      `Annotations:  <none>`,
      `API Version:  machine.openshift.io/v1beta1`,
      `Kind:         Machine`,
      `Phase:        Running`,
      `Provider ID:  azure:///subscriptions/mock/resourceGroups/mock/providers/Microsoft.Compute/virtualMachines/${name}`,
      `Conditions:`,
      `  Type     Status  Reason`,
      `  ----     ------  ------`,
      `  Ready    True    MachineReady`,
      `Events:       <none>`,
    ].join("\n");
  }

  if (/^describe\s+pod/i.test(trimmed)) {
    const nameMatch = trimmed.match(/^describe\s+pod\s+(\S+)/i);
    const podName = nameMatch?.[1] ?? "example-pod-abc12";
    return [
      `Name:         ${podName}`,
      `Namespace:    openshift-monitoring`,
      `Node:         worker-0/10.0.2.4`,
      `Status:       Running`,
      `IP:           10.128.0.15`,
      `Containers:`,
      `  main:`,
      `    Image:          quay.io/openshift/mock-image:v4.19`,
      `    State:          Running`,
      `      Started:      ${utcOffsetMinutes(-60)}`,
      `    Ready:          True`,
      `    Restart Count:  0`,
      `Events:`,
      `  Type    Reason   Age   From     Message`,
      `  ----    ------   ----  ----     -------`,
      `  Normal  Pulled   60m   kubelet  Container image already present on machine`,
      `  Normal  Created  60m   kubelet  Created container main`,
      `  Normal  Started  60m   kubelet  Started container main`,
    ].join("\n");
  }

  if (/^describe\s+/i.test(trimmed)) {
    const parts = trimmed.match(/^describe\s+(\S+)\s*(\S*)/i);
    const resource = parts?.[1] ?? "resource";
    const name = parts?.[2] || `${resource}-mock-0`;
    return [
      `Name:         ${name}`,
      `Namespace:    openshift-cluster`,
      `Labels:       app=${resource}`,
      `Annotations:  <none>`,
      `Status:       Active`,
      `Events:       <none>`,
    ].join("\n");
  }

  if (/^delete\s+/i.test(trimmed)) {
    const parts = trimmed
      .replace(/\s+--force/g, "")
      .replace(/\s+--grace-period=\d+/g, "")
      .match(/^delete\s+(\S+)\s+(\S+)/i);
    const resource = parts?.[1] ?? "resource";
    const name = parts?.[2] ?? "unknown";
    return `${resource} "${name}" deleted`;
  }

  if (/^logs\s+/i.test(trimmed)) {
    return [
      `${utcOffsetMinutes(-10)} I0101 10:00:00.000000  1 server.go:182] Starting server on :8443`,
      `${utcOffsetMinutes(-8)} I0101 10:02:00.000000  1 controller.go:95] Syncing resources`,
      `${utcOffsetMinutes(-5)} W0101 10:05:00.000000  1 reflector.go:324] Watch error: connection reset by peer`,
      `${utcOffsetMinutes(-3)} I0101 10:07:00.000000  1 controller.go:95] Syncing resources`,
      `${utcOffsetMinutes(-1)} I0101 10:09:00.000000  1 controller.go:120] Reconcile complete`,
    ].join("\n");
  }

  if (/\s+-o\s+jsonpath/i.test(command)) {
    return '{"status":"Ready","reason":"KubeletReady"}';
  }

  if (/^get\s+machine/i.test(trimmed)) {
    return [
      "NAME                                   PHASE         TYPE              REGION    ZONE   AGE",
      "aro-mock-master-0                      Running       Standard_D8s_v3   eastus    1      90d",
      "aro-mock-master-1                      Running       Standard_D8s_v3   eastus    2      90d",
      "aro-mock-master-2                      Running       Standard_D8s_v3   eastus    3      90d",
      "aro-mock-worker-0                      Running       Standard_D4s_v3   eastus    1      90d",
      "aro-mock-worker-1                      Running       Standard_D4s_v3   eastus    2      90d",
    ].join("\n");
  }

  if (/^get\s+events/i.test(trimmed)) {
    return [
      `LAST SEEN   TYPE      REASON    OBJECT               MESSAGE`,
      `${utcOffsetMinutes(-10)}   Normal    Pulling   pod/monitor-abc12    Pulling image "quay.io/openshift/mock:v4.19"`,
      `${utcOffsetMinutes(-8)}    Normal    Pulled    pod/monitor-abc12    Successfully pulled image`,
      `${utcOffsetMinutes(-5)}    Warning   Unhealthy pod/monitor-abc12    Readiness probe failed: connection refused`,
      `${utcOffsetMinutes(-2)}    Normal    Scheduled pod/api-server-xyz   Successfully assigned pod`,
    ].join("\n");
  }

  return [
    "NAME                                   STATUS   ROLES    AGE   VERSION",
    "master-0                               Ready    master   90d   v1.30.4+mock",
    "master-1                               Ready    master   90d   v1.30.4+mock",
    "worker-0                               Ready    worker   90d   v1.30.4+mock",
    "",
    `# mock command received: ${command}`,
  ].join("\n");
}

export function generateMockCommandOutput(
  command: string,
  type: "oc" | "kql" | "geneva"
): string {
  if (type === "oc") {
    return mockOcOutput(command);
  }

  if (type === "kql") {
    return [
      "TimeGenerated                Level    Message",
      `${utcOffsetMinutes(-12)}    Warning  Mock probe event`,
      `${utcOffsetMinutes(-10)}    Info     Command path validated`,
      "",
      `// mock query received: ${command}`,
    ].join("\n");
  }

  return [
    "Dashboard: Mock Geneva View",
    `LastUpdated: ${utcOffsetMinutes(-5)}`,
    "Status: healthy (mock)",
    "",
    `# mock command received: ${command}`,
  ].join("\n");
}
