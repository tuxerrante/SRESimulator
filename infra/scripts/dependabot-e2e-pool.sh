#!/usr/bin/env bash
# Provision the pre-created Dependabot E2E namespace pool.
#
# Run this with cluster-admin credentials. It is idempotent.
#
# Why a pool instead of a namespace created per pull request:
# creating a namespace is a cluster-scoped operation, and the namespaced verbs
# the E2E job needs could only be granted through a ClusterRoleBinding, because
# Kubernetes RBAC cannot scope a RoleBinding to a namespace name prefix and the
# job cannot grant itself rights in a namespace it just created without
# escalation privileges. Such a ClusterRoleBinding would also expose the
# production namespace to the E2E identity. Pre-creating a bounded pool keeps
# the identity namespace-only, gives every pull request a dedicated namespace,
# and caps how much of the cluster Dependabot can consume at once.
set -euo pipefail

POOL_SIZE="${POOL_SIZE:-4}"
NAMESPACE_PREFIX="${NAMESPACE_PREFIX:-sre-dependabot-e2e}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-gha-e2e-runner}"
SERVICE_ACCOUNT_NAMESPACE="${SERVICE_ACCOUNT_NAMESPACE:-sre-dependabot-e2e}"
BACKEND_PORT="${BACKEND_PORT:-8080}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require kubectl

if ! [[ "${POOL_SIZE}" =~ ^[0-9]+$ ]] || [[ "${POOL_SIZE}" -lt 1 ]]; then
  echo "POOL_SIZE must be a positive integer." >&2
  exit 1
fi

namespaces=()
for index in $(seq 1 "${POOL_SIZE}"); do
  namespaces+=("${NAMESPACE_PREFIX}-${index}")
done

kubectl get namespace "${SERVICE_ACCOUNT_NAMESPACE}" >/dev/null

for namespace in "${namespaces[@]}"; do
  echo "==> ${namespace}"

  kubectl create namespace "${namespace}" --dry-run=client -o yaml |
    kubectl apply -f - >/dev/null

  kubectl label namespace "${namespace}" \
    pod-security.kubernetes.io/enforce=restricted \
    pod-security.kubernetes.io/enforce-version=latest \
    pod-security.kubernetes.io/audit=restricted \
    pod-security.kubernetes.io/warn=restricted \
    app.kubernetes.io/managed-by=dependabot-e2e-pool \
    --overwrite >/dev/null

  kubectl apply -n "${namespace}" -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: dependabot-e2e-default-deny-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: dependabot-e2e-allow-dns
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: dependabot-e2e-frontend-to-backend
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: frontend
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: backend
      ports:
        - port: ${BACKEND_PORT}
          protocol: TCP
EOF

  kubectl apply -n "${namespace}" -f - >/dev/null <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${SERVICE_ACCOUNT_NAME}-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
subjects:
  - kind: ServiceAccount
    name: ${SERVICE_ACCOUNT_NAME}
    namespace: ${SERVICE_ACCOUNT_NAMESPACE}
EOF

  # The end-to-end identity holds the built-in `admin` ClusterRole inside its
  # namespace, so nothing in the namespace itself stops a bad chart value or a
  # runaway HorizontalPodAutoscaler from requesting the whole node pool and
  # starving production. A ResourceQuota is the only ceiling the namespace
  # owner cannot lift, which is why it is set here by the cluster admin rather
  # than shipped in the chart.
  #
  # Sizing comes from what the end-to-end deploy actually asks for: the backend
  # runs a single replica, while scripts/aks-deploy.sh enables the frontend
  # autoscaler up to 3 replicas, so the worst case is 4 pods requesting
  # 100m/128Mi, plus rolling-update surge. The ceiling below is roughly double
  # that, which absorbs surge and Helm hooks while still bounding one namespace
  # to well under a quarter of the node pool.
  kubectl apply -n "${namespace}" -f - >/dev/null <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: e2e-ceiling
spec:
  hard:
    requests.cpu: "1"
    requests.memory: 1536Mi
    limits.cpu: "4"
    limits.memory: 4Gi
    pods: "15"
    persistentvolumeclaims: "4"
    services: "10"
EOF

  # A ResourceQuota that constrains requests rejects any Pod that does not
  # declare them, so the defaults below are what keep the quota from turning
  # into an outage the first time a container omits its resources block.
  kubectl apply -n "${namespace}" -f - >/dev/null <<EOF
apiVersion: v1
kind: LimitRange
metadata:
  name: e2e-defaults
spec:
  limits:
    - type: Container
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      default:
        cpu: 500m
        memory: 512Mi
      max:
        cpu: "1"
        memory: 1Gi
EOF
done

echo
echo "Pool ready. Set this repository/environment variable so the workflow"
echo "can claim a slot; the workflow fails without it:"
echo
echo "  DEPENDABOT_E2E_NAMESPACE_POOL=\"${namespaces[*]}\""
echo
echo "The NetworkPolicies above deliberately grant no egress to the internet."
echo "Images are pulled by the kubelet, not by the Pod, so this does not break"
echo "image pulls."
