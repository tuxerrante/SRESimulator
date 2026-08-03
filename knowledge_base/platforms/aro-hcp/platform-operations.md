# ARO HCP Platform Operations

## Investigation posture

ARO HCP sessions distinguish guest-cluster evidence gathering from hosted
control plane ownership. `oc` remains the primary cluster CLI for the guest
cluster, but not every symptom should lead to management-plane remediation.

## High-signal areas

- Guest-cluster routes, namespaces, workloads, and node pool behavior.
- Hosted control plane boundary notes when an upgrade or rollout appears stuck.
- Evidence that separates guest-cluster misconfiguration from provider-owned
  control plane responsibilities.

## Common clues

- Route 503 failures caused by guest-cluster NetworkPolicy changes.
- Node pool rollout stalls after unsupported guest configuration drift.
- Upgrade states that appear blocked at the guest/control-plane boundary.

## Command vocabulary

- Use `oc` for guest-cluster inspection, workload events, and route evidence.
- Prefer node pool names, guest cluster names, and hosted control plane
  namespaces when the scenario provides them.
- Make hosted control plane ownership explicit before suggesting escalations or
  non-customer remediations.

## Escalation boundary

- Continue in the guest cluster for workload, Route, NetworkPolicy, node, and
  guest operator evidence.
- Escalate when evidence points to the hosted control plane namespace,
  management-cluster controllers, provider-owned API availability, or direct
  etcd/control-plane remediation.
- State which guest evidence justifies the escalation; never instruct the
  player to mutate management-cluster resources from the guest session.
