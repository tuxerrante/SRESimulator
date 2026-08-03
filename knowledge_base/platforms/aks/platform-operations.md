# AKS Platform Operations

## Investigation posture

AKS sessions use `kubectl` as the primary cluster CLI. Focus on workloads,
node pools, add-ons, network behavior, and observable managed-cluster symptoms
rather than direct control plane mutations.

## High-signal areas

- Pod and event evidence for `ImagePullBackOff`, DNS failure, or upgrade stalls.
- Node pool rollouts, drain failures, and PodDisruptionBudget constraints.
- CoreDNS, kube-proxy, Azure CNI, and other managed add-on signals.
- Managed resource group hints when infrastructure naming helps correlate clues.

## Common clues

- `kubectl get pods` or `kubectl describe pod` exposing image pull failures.
- CoreDNS timeouts after outbound or egress path changes.
- Node pool upgrades that deadlock on disruption budgets and placement limits.

## Command vocabulary

- Prefer `kubectl get nodes`, `kubectl get events`, and `kubectl describe ...`.
- Use KQL or Dashboard evidence when the clue points to Azure Monitor or
  managed platform health.
- Treat Geneva as a legacy Dashboard alias only when older fixtures still use
  the older wording.
