# ARO Classic Platform Operations

## Investigation posture

ARO Classic sessions assume a customer-managed OpenShift cluster running on ARO
virtual machines. `oc` is the primary cluster CLI, while KQL and the Dashboard
surface operational clues.

## High-signal areas

- Machine API health and machine lifecycle drift.
- Cluster operators such as `machine-config`, `kube-apiserver`, and
  `cluster-etcd-operator`.
- Routes, ingress canaries, and control plane node readiness.
- Upgrade history when cluster versions or operators appear inconsistent.

## Common clues

- Missing or degraded machine objects after VM deletion.
- Machine Config Daemon failures when host permissions drift.
- Route and ingress symptoms that begin after NetworkPolicy or egress changes.
- Etcd quorum or kube-apiserver latency spikes after host outages.

## Command vocabulary

- Use `oc get nodes`, `oc get machines -A`, and `oc describe machine ...`
  when machine-level evidence is relevant.
- Prefer cluster operator status and events before proposing destructive fixes.
- Treat Dashboard as the canonical read-only surface; legacy Geneva wording may
  appear only in older fixtures.
