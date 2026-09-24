#!/usr/bin/env bash
# OCI k3s deployment helpers. Sourced (not executed) by Make recipes.
#
# The free-tier box runs single-node k3s on an aarch64 Always Free A1.Flex
# instance, so this flavor differs from aks/aro in three ways that matter:
#
#   * there is no cloud login at all — the operator already holds a kubeconfig
#     (typically through `make -C infra/oci tf-oci-kubeconfig` plus an SSH
#     tunnel), so cluster_login() must never reach for Azure credentials;
#   * images are pulled from GHCR rather than built in-cluster, so
#     prepare_release_images() builds nothing and instead refuses a tag whose
#     manifest carries no linux/arm64 leg;
#   * exposure is a Traefik Ingress terminating TLS on the box, not a Route or
#     an Azure Gateway.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBE_CLI=kubectl
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/kube-deploy-common.sh"

OCI_IMAGE_REGISTRY="${OCI_IMAGE_REGISTRY:-ghcr.io}"
OCI_IMAGE_OWNER="${OCI_IMAGE_OWNER:-tuxerrante}"
OCI_REQUIRED_PLATFORM="${OCI_REQUIRED_PLATFORM:-linux/arm64}"

# Usage: oci_image_repository <component>
oci_image_repository() {
  local component=$1
  printf '%s/%s/sre-simulator-%s\n' \
    "$OCI_IMAGE_REGISTRY" "$OCI_IMAGE_OWNER" "$component"
}

cluster_login() {
  require_cli kubectl

  if [ -z "${KUBECONFIG:-}" ] && [ ! -f "${HOME}/.kube/config" ]; then
    echo "KUBECONFIG is not set and ~/.kube/config does not exist." >&2
    echo "Fetch the k3s kubeconfig first: make tf-oci-kubeconfig" >&2
    return 1
  fi

  # The kubeconfig points at 127.0.0.1:6443 through an SSH tunnel, because the
  # k3s API is deliberately closed at the NSG. A refused connection here almost
  # always means the tunnel is down rather than the cluster being unhealthy, so
  # say that instead of leaking a raw dial error.
  if ! kubectl get nodes >/dev/null 2>&1; then
    echo "Cannot reach the k3s API server." >&2
    echo "Port 6443 is closed at the NSG by design; open the tunnel first:" >&2
    echo "  ssh -N -L 6443:127.0.0.1:6443 <operator>@<public-ip>" >&2
    echo "  (make tf-oci-kubeconfig prints the exact command for this box)" >&2
    return 1
  fi
}

print_cluster_login_summary() {
  local context server node_count
  context=$(kubectl config current-context 2>/dev/null || printf '(none)')
  server=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || printf '(unknown)')
  node_count=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')

  echo "Kubeconfig context: $context"
  echo "Kubernetes API: $server"
  echo "Nodes ready: $node_count"
}

# Usage: require_arm64_image <repository> <tag>
# The A1.Flex box is aarch64. An amd64-only image does not fail at deploy time:
# it schedules, pulls, and then CrashLoopBackOffs with "exec format error",
# which reads as an application bug. Refuse it here, where the cause is still
# visible, and name the workflow that publishes the arm64 leg.
require_arm64_image() {
  local repo=$1 tag=$2 platforms

  require_cli docker

  if ! platforms=$(docker buildx imagetools inspect "${repo}:${tag}" \
      --format '{{range .Manifest.Manifests}}{{.Platform.OS}}/{{.Platform.Architecture}}
{{end}}' 2>/dev/null); then
    echo "Cannot read the image manifest for ${repo}:${tag}." >&2
    echo "Check the tag exists and that you are logged in to ${OCI_IMAGE_REGISTRY}." >&2
    return 1
  fi

  if ! printf '%s\n' "$platforms" | grep -Fqx "$OCI_REQUIRED_PLATFORM"; then
    echo "${repo}:${tag} advertises no ${OCI_REQUIRED_PLATFORM} manifest." >&2
    echo "Platforms present: $(printf '%s' "$platforms" | grep -v '^$' | tr '\n' ' ')" >&2
    echo "The OCI box is aarch64; an amd64-only image CrashLoopBackOffs with" >&2
    echo "'exec format error'. Publish a release so build-push.yml emits the" >&2
    echo "arm64 leg, or pick a tag that already has one." >&2
    return 1
  fi
}

# Usage: prepare_release_images <namespace> <tag>
# Nothing is built: the box pulls released multi-arch images from GHCR. The
# namespace is still ensured so later steps can create secrets in it.
prepare_release_images() {
  local ns=$1 tag=$2
  ensure_namespace "$ns"

  local component
  for component in frontend backend; do
    require_arm64_image "$(oci_image_repository "$component")" "$tag" || return 1
  done
  echo "Verified ${OCI_REQUIRED_PLATFORM} manifests for frontend and backend at tag $tag."
}

# Usage: write_oci_exposure_values
# Prints the path of a temp values file. Mirrors write_aks_exposure_values:
# the caller owns the file and removes it.
write_oci_exposure_values() {
  local values_file
  values_file="$(mktemp "${TMPDIR:-/tmp}/sre-oci-exposure.XXXXXX")"
  if ! cat >"$values_file" <<EOF
exposure:
  mode: "ingress"
  host: "${DEPLOY_HOST}"
  scheme: "${DEPLOY_SCHEME}"
frontend:
  image:
    repository: "$(oci_image_repository frontend)"
    tag: "${OCI_IMAGE_TAG}"
    pullPolicy: "IfNotPresent"
backend:
  image:
    repository: "$(oci_image_repository backend)"
    tag: "${OCI_IMAGE_TAG}"
    pullPolicy: "IfNotPresent"
EOF
  then
    rm -f "$values_file"
    return 1
  fi

  printf '%s\n' "$values_file"
}

# Usage: helm_deploy_sre <namespace> <tag> <probe-token>
# Sets DEPLOY_HOST / DEPLOY_SCHEME for the caller.
#
# Unlike the Azure flavors this layers the committed profile files rather than
# passing every knob as --set: values-oci.yaml is the reviewed production
# shape, and re-expressing it here would let the two drift silently.
helm_deploy_sre() {
  local ns=$1 tag=$2 probe_token=$3
  local values_file rc

  if [ -z "${OCI_INGRESS_HOST:-}" ]; then
    echo "OCI_INGRESS_HOST is required (the public hostname Traefik serves)." >&2
    return 1
  fi

  DEPLOY_HOST="$OCI_INGRESS_HOST"
  DEPLOY_SCHEME="https"
  OCI_IMAGE_TAG="$tag"

  require_prod_db_secret_name postgres || return 1
  require_db_secret_exists_in_namespace "$ns" || return 1

  local ai_flags=()
  if [ -n "${OCI_OPENROUTER_SECRET_NAME:-}" ]; then
    ai_flags+=(--set "ai.openrouter.credentials.existingSecretName=$OCI_OPENROUTER_SECRET_NAME")
  fi
  local route_key var_name
  for route_key in chat command scenario probe; do
    var_name="OCI_OPENROUTER_MODEL_$(printf '%s' "$route_key" | tr '[:lower:]' '[:upper:]')"
    if [ -n "${!var_name:-}" ]; then
      ai_flags+=(--set-string "ai.openrouter.routeModels.${route_key}=${!var_name}")
    fi
  done

  values_file="$(write_oci_exposure_values)" || return 1

  helm upgrade --install "$E2E_RELEASE" ./helm/sre-simulator -n "$ns" \
    --values ./helm/sre-simulator/values.yaml \
    --values ./helm/sre-simulator/values-oci.yaml \
    --values "$values_file" \
    --set-string ai.liveProbeToken="$probe_token" \
    --set "database.existingSecretName=$DB_SECRET_NAME" \
    "${ai_flags[@]}" \
    --wait --timeout 15m >/dev/null
  rc=$?

  rm -f "$values_file"
  return "$rc"
}
