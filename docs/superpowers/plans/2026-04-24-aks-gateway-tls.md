# AKS Gateway TLS Custom Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current AKS public frontend `LoadBalancer` edge with an Envoy Gateway + cert-manager + Azure DNS custom-domain HTTPS edge on `play.sresimulator.osadev.cloud`, while preserving `AKS_EXPOSURE_MODE=publicService` as the rollback path and leaving ARO untouched.

**Architecture:** Terraform owns Azure-side prerequisites (AKS workload identity, the cert-manager DNS identity, the DNS zone role assignment, and the `play.sresimulator.osadev.cloud` A record). The AKS deploy path installs Envoy Gateway and cert-manager idempotently, applies cluster-scoped `ClusterIssuer` and `EnvoyProxy` manifests, and the app Helm chart renders `Gateway` and `HTTPRoute` resources when `exposure.mode=gateway`. The existing AKS `publicService` mode stays available for emergency rollback.

**Tech Stack:** Terraform/AzureRM, AKS workload identity, Azure DNS, Envoy Gateway `v1.6.5`, cert-manager `v1.20.1`, Helm, Bash/Make, Kubernetes Gateway API.

---

## File Structure

### Create

- `infra/aks_gateway_dns.tf` — Azure DNS lookup, cert-manager managed identity, DNS role assignment, and `play.sresimulator.osadev.cloud` A record.
- `infra/tests/aks_gateway_dns.tftest.hcl` — Terraform regression coverage for workload identity + DNS automation resources.
- `helm/sre-simulator/templates/gateway.yaml` — App-scoped Gateway resource for AKS Gateway mode.
- `helm/sre-simulator/templates/httproute.yaml` — HTTPS backend route plus HTTP-to-HTTPS redirect route.
- `docs/superpowers/plans/2026-04-24-aks-gateway-tls.md` — this implementation plan.

### Modify

- `infra/aks.tf` — enable AKS OIDC issuer and workload identity.
- `infra/variables.tf` — add Gateway/DNS variables and deterministic identity naming.
- `infra/outputs.tf` — expose Gateway host and identity metadata in outputs/env snippets.
- `infra/terraform.tfvars.example` — document the new AKS Gateway inputs.
- `infra/final-aaffinit-test.tfvars.example` — wire the final environment to `play.sresimulator.osadev.cloud`.
- `Makefile` — default AKS exposure mode to `gateway`, export new AKS Gateway/DNS vars, and update audit/status behavior.
- `scripts/aks-deploy.sh` — install Envoy Gateway and cert-manager, emit ClusterIssuer/EnvoyProxy manifests, and deploy the app in `gateway` or `publicService` mode.
- `scripts/aks-deploy.test.sh` — cover Gateway-mode values plus ClusterIssuer/EnvoyProxy manifest generation.
- `scripts/kube-deploy-common.sh` — add Gateway/certificate readiness helpers used by the AKS deploy path.
- `scripts/helm-platform.test.sh` — verify Gateway-mode rendering and preserve `publicService` coverage as the rollback path.
- `helm/sre-simulator/values.yaml` — add `gateway` config and make the AKS exposure toggle explicit.
- `helm/sre-simulator/templates/_helpers.tpl` — treat Gateway mode as HTTPS and keep public-origin derivation consistent.
- `helm/sre-simulator/templates/frontend-service.yaml` — keep frontend internal in Gateway mode, public only in `publicService` mode.
- `helm/sre-simulator/templates/backend-deployment.yaml` — remove the unfinished Key Vault CSI hook so the chosen TLS model is unambiguous.
- `.github/workflows/ci.yml` — render-test Gateway mode instead of the AKS public-service mode.
- `.github/workflows/helm-integration.yml` — keep runtime integration on Kind, but add a separate Gateway-mode render check.
- `README.md` — describe the AKS custom-domain Gateway edge and HTTP fallback semantics.
- `docs/ARCHITECTURE.md` — update the AKS public exposure model from `LoadBalancer` frontend to Gateway edge.
- `infra/POST_APPLY_CHECKLIST.md` — add Gateway/DNS/HTTPS follow-up checks.

### Test / Validate

- `make tf-init-local`
- `make tf-test`
- `bash scripts/aks-deploy.test.sh`
- `bash scripts/helm-platform.test.sh`
- `make validate`
- `make test`
- `make test-integration`

---

### Task 1: Add Terraform Support For DNS Automation And Workload Identity

**Files:**

- Create: `infra/aks_gateway_dns.tf`
- Create: `infra/tests/aks_gateway_dns.tftest.hcl`
- Modify: `infra/aks.tf`
- Modify: `infra/variables.tf`
- Modify: `infra/outputs.tf`
- Modify: `infra/terraform.tfvars.example`
- Modify: `infra/final-aaffinit-test.tfvars.example`
- Test: `infra/tests/aks_gateway_dns.tftest.hcl`

- [ ] **Step 1: Add a failing Terraform test for the new AKS Gateway prerequisites**

```hcl
mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      client_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000003"
      tenant_id       = "00000000-0000-0000-0000-000000000004"
    }
  }

  mock_data "azurerm_dns_zone" {
    defaults = {
      id                  = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/dns/providers/Microsoft.Network/dnsZones/osadev.cloud"
      name                = "osadev.cloud"
      resource_group_name = "dns"
    }
  }
}

mock_provider "azapi" {}

mock_provider "azuread" {
  mock_data "azuread_service_principal" {
    defaults = {
      object_id = "00000000-0000-0000-0000-000000000005"
    }
  }
}

variables {
  owner_alias                      = "jdoe"
  aks_gateway_host                 = "play.sresimulator.osadev.cloud"
  aks_dns_zone_name                = "osadev.cloud"
  aks_dns_zone_resource_group_name = "dns"
}

run "aks_gateway_prereqs" {
  command = plan

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].oidc_issuer_enabled == true
    error_message = "AKS Gateway mode needs the OIDC issuer enabled for workload identity."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].workload_identity_enabled == true
    error_message = "AKS Gateway mode needs workload identity enabled."
  }

  assert {
    condition     = azurerm_user_assigned_identity.aks_dns_solver[0].name == "jdoe-test-cert-manager-dns"
    error_message = "Terraform should create the deterministic cert-manager DNS identity."
  }

  assert {
    condition     = azurerm_role_assignment.aks_dns_solver_zone_contributor[0].role_definition_name == "DNS Zone Contributor"
    error_message = "The cert-manager identity should receive DNS Zone Contributor on the target zone."
  }

  assert {
    condition     = azurerm_dns_a_record.aks_gateway_host[0].name == "play.sresimulator"
    error_message = "Terraform should manage the play.sresimulator record inside the shared osadev.cloud zone."
  }
}
```

- [ ] **Step 2: Run the Terraform tests and confirm the new test fails before implementation**

Run: `make tf-init-local && make tf-test`
Expected: `terraform test` fails because `oidc_issuer_enabled`, `workload_identity_enabled`, `azurerm_user_assigned_identity.aks_dns_solver`, `azurerm_role_assignment.aks_dns_solver_zone_contributor`, and `azurerm_dns_a_record.aks_gateway_host` do not exist yet.

- [ ] **Step 3: Add Gateway/DNS variables and locals in `infra/variables.tf`**

```hcl
variable "aks_gateway_host" {
  description = "Canonical AKS HTTPS hostname. Leave empty to disable custom DNS automation."
  type        = string
  default     = ""
}

variable "aks_dns_zone_name" {
  description = "Existing Azure DNS zone that owns aks_gateway_host."
  type        = string
  default     = ""
}

variable "aks_dns_zone_resource_group_name" {
  description = "Resource group that contains the Azure DNS zone for aks_gateway_host."
  type        = string
  default     = ""
}

variable "aks_cert_manager_identity_name" {
  description = "Optional override for the user-assigned identity used by cert-manager for Azure DNS."
  type        = string
  default     = ""
}

locals {
  aks_gateway_enabled = (
    local.is_aks &&
    var.aks_gateway_host != "" &&
    var.aks_dns_zone_name != "" &&
    var.aks_dns_zone_resource_group_name != ""
  )

  aks_gateway_record_name = local.aks_gateway_enabled ? trimsuffix(
    var.aks_gateway_host,
    ".${var.aks_dns_zone_name}"
  ) : ""

  aks_cert_manager_identity_name = (
    var.aks_cert_manager_identity_name != "" ?
    var.aks_cert_manager_identity_name :
    "${local.prefix}-cert-manager-dns"
  )
}
```

- [ ] **Step 4: Enable AKS OIDC + workload identity in `infra/aks.tf`**

```hcl
resource "azurerm_kubernetes_cluster" "aks" {
  count               = local.is_aks ? 1 : 0
  name                = local.cluster_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = local.aks_dns_prefix
  sku_tier            = "Free"
  node_resource_group = local.aks_node_resource_group_name
  kubernetes_version  = var.aks_kubernetes_version != "" ? var.aks_kubernetes_version : null
  oidc_issuer_enabled = true
  workload_identity_enabled = true
  tags                = local.tags

  default_node_pool {
    name                 = "system"
    vm_size              = var.aks_node_vm_size
    type                 = "VirtualMachineScaleSets"
    auto_scaling_enabled = true
    min_count            = var.aks_node_count_min
    max_count            = var.aks_node_count_max
    node_count           = var.aks_node_count_min
    vnet_subnet_id       = azurerm_subnet.aks[0].id
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin    = "azure"
    network_policy    = "azure"
    load_balancer_sku = "standard"
    outbound_type     = "loadBalancer"
    service_cidr      = var.aks_service_cidr
    dns_service_ip    = var.aks_dns_service_ip
  }

  lifecycle {
    ignore_changes = [default_node_pool[0].node_count]
  }
}
```

- [ ] **Step 5: Create `infra/aks_gateway_dns.tf` with the Azure DNS identity, role, and record**

```hcl
data "azurerm_dns_zone" "aks_public" {
  count               = local.aks_gateway_enabled ? 1 : 0
  name                = var.aks_dns_zone_name
  resource_group_name = var.aks_dns_zone_resource_group_name
}

resource "azurerm_user_assigned_identity" "aks_dns_solver" {
  count               = local.aks_gateway_enabled ? 1 : 0
  name                = local.aks_cert_manager_identity_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "aks_dns_solver_zone_contributor" {
  count                = local.aks_gateway_enabled ? 1 : 0
  scope                = data.azurerm_dns_zone.aks_public[0].id
  role_definition_name = "DNS Zone Contributor"
  principal_id         = azurerm_user_assigned_identity.aks_dns_solver[0].principal_id
}

resource "azurerm_dns_a_record" "aks_gateway_host" {
  count               = local.aks_gateway_enabled ? 1 : 0
  name                = local.aks_gateway_record_name
  zone_name           = data.azurerm_dns_zone.aks_public[0].name
  resource_group_name = data.azurerm_dns_zone.aks_public[0].resource_group_name
  ttl                 = 300
  records             = [azurerm_public_ip.aks_ingress[0].ip_address]
  tags                = local.tags
}
```

- [ ] **Step 6: Expose the new values in `infra/outputs.tf` and the example tfvars files**

```hcl
output "aks_gateway_public_host" {
  description = "Canonical AKS custom hostname when Gateway/DNS automation is enabled."
  value       = local.aks_gateway_enabled ? var.aks_gateway_host : ""
}

output "aks_cert_manager_identity_name" {
  description = "User-assigned identity used by cert-manager for Azure DNS DNS-01 updates."
  value       = local.aks_gateway_enabled ? azurerm_user_assigned_identity.aks_dns_solver[0].name : ""
}

output "aks_cert_manager_identity_client_id" {
  description = "Client ID for the cert-manager Azure DNS managed identity."
  value       = local.aks_gateway_enabled ? azurerm_user_assigned_identity.aks_dns_solver[0].client_id : ""
}

output "env_file_snippet" {
  value = join("", [
    local.is_aks ? <<-AKS
    # --- AKS cluster connection ---
    AKS_RG=${azurerm_resource_group.main.name}
    AKS_CLUSTER=${azurerm_kubernetes_cluster.aks[0].name}
    AKS_NODE_RG=${azurerm_kubernetes_cluster.aks[0].node_resource_group}
    AKS_FRONTEND_PUBLIC_IP_NAME=${azurerm_public_ip.aks_ingress[0].name}
    AKS_FRONTEND_PUBLIC_IP=${azurerm_public_ip.aks_ingress[0].ip_address}
    AKS_FRONTEND_PUBLIC_FQDN=${azurerm_public_ip.aks_ingress[0].fqdn}
    AKS_FRONTEND_PUBLIC_HOST=${try(azurerm_public_ip.aks_ingress[0].fqdn, "") != "" ? azurerm_public_ip.aks_ingress[0].fqdn : try(azurerm_public_ip.aks_ingress[0].ip_address, "")}
    AKS_GATEWAY_HOST=${local.aks_gateway_enabled ? var.aks_gateway_host : ""}
    AKS_DNS_ZONE_NAME=${var.aks_dns_zone_name}
    AKS_DNS_ZONE_RESOURCE_GROUP=${var.aks_dns_zone_resource_group_name}
    AKS_CERT_MANAGER_IDENTITY_NAME=${local.aks_gateway_enabled ? azurerm_user_assigned_identity.aks_dns_solver[0].name : ""}
    AKS
    : ""
  ])
}
```

```hcl
# infra/terraform.tfvars.example
cluster_flavor                    = "aks"
aks_gateway_host                  = "play.sresimulator.osadev.cloud"
aks_dns_zone_name                 = "osadev.cloud"
aks_dns_zone_resource_group_name  = "dns"

# infra/final-aaffinit-test.tfvars.example
cluster_flavor                    = "aks"
location                          = "westeurope"
sql_server_name                   = "aaffinitsqlz1775642113"
aks_gateway_host                  = "play.sresimulator.osadev.cloud"
aks_dns_zone_name                 = "osadev.cloud"
aks_dns_zone_resource_group_name  = "dns"
aks_cert_manager_identity_name    = "aaffinit-test-cert-manager-dns"
```

- [ ] **Step 7: Run Terraform formatting and validation**

Run: `make tf-fmt && make tf-init-local && make tf-validate && make tf-test`
Expected: `terraform fmt`, `terraform validate`, and `terraform test` all pass, including the new `aks_gateway_dns.tftest.hcl` coverage.

- [ ] **Step 8: Commit the Terraform prerequisite changes**

```bash
git add \
  infra/aks.tf \
  infra/aks_gateway_dns.tf \
  infra/variables.tf \
  infra/outputs.tf \
  infra/terraform.tfvars.example \
  infra/final-aaffinit-test.tfvars.example \
  infra/tests/aks_gateway_dns.tftest.hcl
git commit -S -s -m "feat(infra): add AKS Gateway DNS automation"
```

### Task 2: Add Idempotent AKS Bootstrap Helpers For Envoy Gateway And cert-manager

**Files:**

- Modify: `scripts/aks-deploy.sh`
- Modify: `scripts/aks-deploy.test.sh`
- Modify: `scripts/kube-deploy-common.sh`
- Test: `scripts/aks-deploy.test.sh`

- [ ] **Step 1: Extend `scripts/aks-deploy.test.sh` with failing checks for Gateway-mode values and manifest generation**

```bash
run_gateway_values_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"
  stub_cluster_helpers
  capture_helm_invocation

  E2E_RELEASE="sre-simulator"
  AKS_RG="aaffinit-test-rg"
  AKS_CLUSTER="aaffinit-test"
  AKS_EXPOSURE_MODE="gateway"
  AKS_GATEWAY_HOST="play.sresimulator.osadev.cloud"
  AKS_GATEWAY_CLASS_NAME="eg"
  AKS_CLUSTER_ISSUER_NAME="letsencrypt-azuredns-prod"
  AKS_GATEWAY_TLS_SECRET_NAME="sre-simulator-gateway-tls"
  AOAI_DEPLOYMENT="gpt-4o-mini"

  if ! helm_deploy_sre "sre-simulator" "latest" "probe-token" >"$TMP_DIR/gateway.txt" 2>&1; then
    cat "$TMP_DIR/gateway.txt" >&2 || true
    fail "helm_deploy_sre should support AKS gateway mode"
  fi

  assert_contains 'mode: "gateway"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'host: "play.sresimulator.osadev.cloud"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'scheme: "https"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'className: "eg"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'clusterIssuer: "letsencrypt-azuredns-prod"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'secretName: "sre-simulator-gateway-tls"' "$TMP_DIR/captured-values.yaml"
}

run_clusterissuer_manifest_check() {
  local manifest

  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"

  AZURE_SUBSCRIPTION_ID="fe16a035-e540-4ab7-80d9-373fa9a3d6ae"
  AKS_DNS_ZONE_NAME="osadev.cloud"
  AKS_DNS_ZONE_RESOURCE_GROUP="dns"
  AKS_CERT_MANAGER_ACME_EMAIL="aaffinit@redhat.com"
  AKS_CERT_MANAGER_IDENTITY_CLIENT_ID="00000000-0000-0000-0000-000000000099"

  manifest="$(write_aks_clusterissuer_manifest)"
  assert_contains 'name: letsencrypt-azuredns-staging' "$manifest"
  assert_contains 'name: letsencrypt-azuredns-prod' "$manifest"
  assert_contains 'hostedZoneName: osadev.cloud' "$manifest"
  assert_contains 'resourceGroupName: dns' "$manifest"
  assert_contains 'clientID: 00000000-0000-0000-0000-000000000099' "$manifest"
}
```

- [ ] **Step 2: Run the AKS deploy helper tests and confirm they fail first**

Run: `bash scripts/aks-deploy.test.sh`
Expected: the new assertions fail because `scripts/aks-deploy.sh` still writes only `publicService` values and does not generate `ClusterIssuer` manifests.

- [ ] **Step 3: Add deterministic AKS Gateway defaults and bootstrap helpers in `scripts/aks-deploy.sh`**

```bash
ENVOY_GATEWAY_CHART="oci://docker.io/envoyproxy/gateway-helm"
ENVOY_GATEWAY_VERSION="v1.6.5"
CERT_MANAGER_CHART="jetstack/cert-manager"
CERT_MANAGER_VERSION="v1.20.1"

resolve_aks_gateway_identity_client_id() {
  local identity_name
  identity_name="${AKS_CERT_MANAGER_IDENTITY_NAME:-${AKS_CLUSTER}-cert-manager-dns}"
  AKS_CERT_MANAGER_IDENTITY_NAME="$identity_name"
  AKS_CERT_MANAGER_IDENTITY_CLIENT_ID="$(
    az identity show \
      -g "$AKS_RG" \
      -n "$identity_name" \
      --query clientId -o tsv
  )"
}

write_aks_clusterissuer_manifest() {
  local manifest_file
  manifest_file="$(mktemp "${TMPDIR:-/tmp}/sre-aks-clusterissuer.XXXXXX")"
  cat >"$manifest_file" <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-azuredns-staging
spec:
  acme:
    email: ${AKS_CERT_MANAGER_ACME_EMAIL}
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-azuredns-staging-account-key
    solvers:
      - dns01:
          azureDNS:
            subscriptionID: ${AZURE_SUBSCRIPTION_ID}
            resourceGroupName: ${AKS_DNS_ZONE_RESOURCE_GROUP}
            hostedZoneName: ${AKS_DNS_ZONE_NAME}
            environment: AzurePublicCloud
            managedIdentity:
              clientID: ${AKS_CERT_MANAGER_IDENTITY_CLIENT_ID}
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-azuredns-prod
spec:
  acme:
    email: ${AKS_CERT_MANAGER_ACME_EMAIL}
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-azuredns-prod-account-key
    solvers:
      - dns01:
          azureDNS:
            subscriptionID: ${AZURE_SUBSCRIPTION_ID}
            resourceGroupName: ${AKS_DNS_ZONE_RESOURCE_GROUP}
            hostedZoneName: ${AKS_DNS_ZONE_NAME}
            environment: AzurePublicCloud
            managedIdentity:
              clientID: ${AKS_CERT_MANAGER_IDENTITY_CLIENT_ID}
EOF
  printf '%s\n' "$manifest_file"
}
```

- [ ] **Step 4: Add Envoy Gateway install and Azure public-IP binding helpers in `scripts/aks-deploy.sh`**

```bash
write_aks_envoyproxy_manifest() {
  local ns=$1 manifest_file
  manifest_file="$(mktemp "${TMPDIR:-/tmp}/sre-aks-envoyproxy.XXXXXX")"
  cat >"$manifest_file" <<EOF
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: ${E2E_RELEASE}-public-edge
  namespace: ${ns}
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        patch:
          type: StrategicMerge
          value:
            metadata:
              annotations:
                service.beta.kubernetes.io/azure-load-balancer-resource-group: "${AKS_RG}"
                service.beta.kubernetes.io/azure-pip-name: "${AKS_FRONTEND_PUBLIC_IP_NAME}"
            spec:
              loadBalancerIP: "${AKS_FRONTEND_PUBLIC_IP}"
EOF
  printf '%s\n' "$manifest_file"
}

ensure_cert_manager() {
  helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
  helm upgrade --install cert-manager "$CERT_MANAGER_CHART" \
    --namespace cert-manager \
    --create-namespace \
    --version "$CERT_MANAGER_VERSION" \
    --set crds.enabled=true \
    --set-string podLabels.azure\\.workload\\.identity/use=true \
    --set-string serviceAccount.annotations.azure\\.workload\\.identity/client-id="${AKS_CERT_MANAGER_IDENTITY_CLIENT_ID}" \
    --wait --timeout 10m >/dev/null
}

ensure_envoy_gateway() {
  helm upgrade --install envoy-gateway "$ENVOY_GATEWAY_CHART" \
    --namespace envoy-gateway-system \
    --create-namespace \
    --version "$ENVOY_GATEWAY_VERSION" \
    --wait --timeout 10m >/dev/null
}
```

- [ ] **Step 5: Wire the bootstrap into a single idempotent helper and add shared readiness polling if needed**

```bash
ensure_aks_gateway_stack() {
  local ns=$1 issuer_manifest envoyproxy_manifest

  resolve_aks_public_endpoint
  resolve_aks_gateway_identity_client_id
  ensure_envoy_gateway
  ensure_cert_manager

  issuer_manifest="$(write_aks_clusterissuer_manifest)"
  "$KUBE_CLI" apply -f "$issuer_manifest" >/dev/null

  envoyproxy_manifest="$(write_aks_envoyproxy_manifest "$ns")"
  "$KUBE_CLI" apply -f "$envoyproxy_manifest" >/dev/null

  rm -f "$issuer_manifest" "$envoyproxy_manifest"
}
```

```bash
# scripts/kube-deploy-common.sh
wait_for_gateway_ready() {
  local ns=$1 gateway_name=$2
  "$KUBE_CLI" -n "$ns" wait --for=jsonpath='{.status.conditions[?(@.type=="Programmed")].status}'=True \
    "gateway/${gateway_name}" --timeout=6m >/dev/null
}
```

- [ ] **Step 6: Re-run the AKS deploy helper tests**

Run: `bash scripts/aks-deploy.test.sh`
Expected: the helper tests pass with the new Gateway-mode values, the generated ClusterIssuer manifests, and the existing `publicService` fallback coverage.

- [ ] **Step 7: Commit the AKS bootstrap helper changes**

```bash
git add scripts/aks-deploy.sh scripts/aks-deploy.test.sh scripts/kube-deploy-common.sh
git commit -S -s -m "feat(aks): bootstrap Gateway and certificate automation"
```

### Task 3: Add Helm Gateway Mode And Keep `publicService` As The Rollback Path

**Files:**

- Create: `helm/sre-simulator/templates/gateway.yaml`
- Create: `helm/sre-simulator/templates/httproute.yaml`
- Modify: `helm/sre-simulator/values.yaml`
- Modify: `helm/sre-simulator/templates/_helpers.tpl`
- Modify: `helm/sre-simulator/templates/frontend-service.yaml`
- Modify: `helm/sre-simulator/templates/backend-deployment.yaml`
- Modify: `scripts/helm-platform.test.sh`
- Test: `scripts/helm-platform.test.sh`

- [ ] **Step 1: Add a failing Gateway-mode render test**

```bash
gw_render="$(mktemp)"
trap 'rm -f "${route_render}" "${lb_render}" "${lb_no_db_render}" "${gw_render}"' EXIT

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=gateway \
  --set exposure.host=play.sresimulator.osadev.cloud \
  --set exposure.scheme=https \
  --set gateway.className=eg \
  --set gateway.tls.secretName=sre-simulator-gateway-tls \
  --set gateway.certManager.clusterIssuer=letsencrypt-azuredns-prod \
  --set gateway.envoyProxy.name=sre-simulator-public-edge >"${gw_render}"

grep -Eq '^kind: Gateway$' "${gw_render}" || \
  fail "Gateway mode should render a Gateway resource."

grep -Eq '^kind: HTTPRoute$' "${gw_render}" || \
  fail "Gateway mode should render HTTPRoute resources."

grep -Eq 'type: ClusterIP' "${gw_render}" || \
  fail "Gateway mode should keep the frontend Service internal."

if grep -Eq 'type: LoadBalancer' "${gw_render}"; then
  fail "Gateway mode must not expose the frontend directly as a LoadBalancer."
fi

grep -Eq 'value: "https://play\.sresimulator\.osadev\.cloud"' "${gw_render}" || \
  fail "Gateway mode should derive a HTTPS public origin for backend CORS."
```

- [ ] **Step 2: Run the render test and confirm it fails before chart changes**

Run: `bash scripts/helm-platform.test.sh`
Expected: the new Gateway-mode assertions fail because the chart does not yet render `Gateway` or `HTTPRoute` resources.

- [ ] **Step 3: Add `gateway` settings to `helm/sre-simulator/values.yaml` and teach `_helpers.tpl` about HTTPS Gateway mode**

```yaml
exposure:
  # route: OpenShift Route
  # ingress: Kubernetes Ingress
  # publicService: Kubernetes Service type LoadBalancer
  # gateway: Kubernetes Gateway API public edge
  # none: no public edge object
  mode: route
  host: sre-simulator.apps.example.com
  scheme: ""

gateway:
  className: eg
  tls:
    secretName: sre-simulator-gateway-tls
  certManager:
    clusterIssuer: letsencrypt-azuredns-prod
  envoyProxy:
    name: sre-simulator-public-edge
```

```tpl
{{- define "sre-simulator.publicScheme" -}}
{{- $mode := include "sre-simulator.exposureMode" . -}}
{{- if .Values.exposure.scheme -}}
{{- .Values.exposure.scheme -}}
{{- else if or (eq $mode "route") (eq $mode "gateway") -}}
{{- print "https" -}}
{{- else if and (eq $mode "ingress") .Values.ingress.tls.enabled -}}
{{- print "https" -}}
{{- else -}}
{{- print "http" -}}
{{- end -}}
{{- end }}
```

- [ ] **Step 4: Add `Gateway` + `HTTPRoute` templates and keep the frontend internal in Gateway mode**

```yaml
{{- if eq (include "sre-simulator.exposureMode" .) "gateway" }}
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: {{ include "sre-simulator.fullname" . }}
  annotations:
    cert-manager.io/cluster-issuer: {{ .Values.gateway.certManager.clusterIssuer | quote }}
spec:
  gatewayClassName: {{ .Values.gateway.className }}
  infrastructure:
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: {{ .Values.gateway.envoyProxy.name }}
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      hostname: {{ include "sre-simulator.publicHost" . | quote }}
    - name: https
      protocol: HTTPS
      port: 443
      hostname: {{ include "sre-simulator.publicHost" . | quote }}
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            group: ""
            name: {{ .Values.gateway.tls.secretName }}
{{- end }}
```

```yaml
{{- if eq (include "sre-simulator.exposureMode" .) "gateway" }}
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ include "sre-simulator.fullname" . }}-redirect
spec:
  parentRefs:
    - name: {{ include "sre-simulator.fullname" . }}
      sectionName: http
  hostnames:
    - {{ include "sre-simulator.publicHost" . | quote }}
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ include "sre-simulator.fullname" . }}
spec:
  parentRefs:
    - name: {{ include "sre-simulator.fullname" . }}
      sectionName: https
  hostnames:
    - {{ include "sre-simulator.publicHost" . | quote }}
  rules:
    - backendRefs:
        - name: {{ include "sre-simulator.fullname" . }}-frontend
          port: {{ .Values.frontend.port }}
{{- end }}
```

```yaml
{{- $publicService := .Values.frontend.service.public -}}
{{- $publicServiceEnabled := eq (include "sre-simulator.exposureMode" .) "publicService" -}}
{{- $frontendServicePort := ternary 80 .Values.frontend.port $publicServiceEnabled -}}
spec:
  type: {{ ternary "LoadBalancer" "ClusterIP" $publicServiceEnabled }}
```

- [ ] **Step 5: Remove the incomplete Key Vault CSI path from the backend chart**

```yaml
# helm/sre-simulator/values.yaml
- keyvault:
-   name: ""
-   tenantId: ""
```

```yaml
# helm/sre-simulator/templates/backend-deployment.yaml
-            {{- if .Values.keyvault.name }}
-            - name: secrets
-              mountPath: /mnt/secrets
-              readOnly: true
-            {{- end }}
-        {{- if .Values.keyvault.name }}
-        - name: secrets
-          csi:
-            driver: secrets-store.csi.k8s.io
-            readOnly: true
-            volumeAttributes:
-              secretProviderClass: {{ include "sre-simulator.fullname" . }}-secrets
-        {{- end }}
```

- [ ] **Step 6: Re-run the Helm platform tests**

Run: `bash scripts/helm-platform.test.sh`
Expected: Route mode still renders a Route, `publicService` mode still renders a frontend `LoadBalancer` for rollback, and the new `gateway` mode renders `Gateway` + `HTTPRoute` with a `ClusterIP` frontend service and HTTPS public origin.

- [ ] **Step 7: Commit the chart changes**

```bash
git add \
  helm/sre-simulator/values.yaml \
  helm/sre-simulator/templates/_helpers.tpl \
  helm/sre-simulator/templates/frontend-service.yaml \
  helm/sre-simulator/templates/backend-deployment.yaml \
  helm/sre-simulator/templates/gateway.yaml \
  helm/sre-simulator/templates/httproute.yaml \
  scripts/helm-platform.test.sh
git commit -S -s -m "feat(helm): add AKS Gateway exposure mode"
```

### Task 4: Wire Gateway Mode Into The AKS Deploy Path And Runtime Audits

**Files:**

- Modify: `Makefile`
- Modify: `scripts/aks-deploy.sh`
- Modify: `scripts/aks-deploy.test.sh`
- Modify: `scripts/kube-deploy-common.sh`
- Test: `scripts/aks-deploy.test.sh`
- Test: `scripts/helm-platform.test.sh`

- [ ] **Step 1: Add explicit AKS Gateway defaults and a rollback toggle in `Makefile`**

```makefile
AKS_EXPOSURE_MODE ?= gateway
AKS_GATEWAY_HOST ?= play.sresimulator.osadev.cloud
AKS_GATEWAY_CLASS_NAME ?= eg
AKS_GATEWAY_TLS_SECRET_NAME ?= sre-simulator-gateway-tls
AKS_CLUSTER_ISSUER_NAME ?= letsencrypt-azuredns-prod
AKS_DNS_ZONE_NAME ?= osadev.cloud
AKS_DNS_ZONE_RESOURCE_GROUP ?= dns
AKS_CERT_MANAGER_IDENTITY_NAME ?= $(if $(strip $(AKS_CLUSTER)),$(AKS_CLUSTER)-cert-manager-dns,)
AKS_CERT_MANAGER_ACME_EMAIL ?= aaffinit@redhat.com

export AKS_EXPOSURE_MODE AKS_GATEWAY_HOST AKS_GATEWAY_CLASS_NAME
export AKS_GATEWAY_TLS_SECRET_NAME AKS_CLUSTER_ISSUER_NAME
export AKS_DNS_ZONE_NAME AKS_DNS_ZONE_RESOURCE_GROUP
export AKS_CERT_MANAGER_IDENTITY_NAME AKS_CERT_MANAGER_ACME_EMAIL
```

- [ ] **Step 2: Switch `scripts/aks-deploy.sh` from hard-coded `publicService` to `AKS_EXPOSURE_MODE`**

```bash
write_aks_exposure_values() {
  local values_file
  values_file="$(mktemp "${TMPDIR:-/tmp}/sre-aks-exposure.XXXXXX")"
  cat >"$values_file" <<EOF
exposure:
  mode: "${AKS_EXPOSURE_MODE}"
  host: "${DEPLOY_HOST}"
  scheme: "${DEPLOY_SCHEME}"
gateway:
  className: "${AKS_GATEWAY_CLASS_NAME}"
  tls:
    secretName: "${AKS_GATEWAY_TLS_SECRET_NAME}"
  certManager:
    clusterIssuer: "${AKS_CLUSTER_ISSUER_NAME}"
  envoyProxy:
    name: "${E2E_RELEASE}-public-edge"
EOF

  if [[ "${AKS_EXPOSURE_MODE}" == "publicService" ]]; then
    cat >>"$values_file" <<EOF
frontend:
  service:
    public:
      loadBalancerIP: "${AKS_FRONTEND_PUBLIC_IP}"
      annotations:
        service.beta.kubernetes.io/azure-load-balancer-resource-group: "${AKS_RG}"
        service.beta.kubernetes.io/azure-pip-name: "${AKS_FRONTEND_PUBLIC_IP_NAME}"
EOF
  fi

  printf '%s\n' "$values_file"
}
```

- [ ] **Step 3: Ensure the deploy path bootstraps the Gateway stack before Helm when `AKS_EXPOSURE_MODE=gateway`**

```bash
helm_deploy_sre() {
  local ns=$1 tag=$2 probe_token=$3

  require_cli helm
  ensure_namespace "$ns"

  if [[ "${AKS_EXPOSURE_MODE:-gateway}" == "gateway" ]]; then
    ensure_aks_gateway_stack "$ns"
    DEPLOY_HOST="${AKS_GATEWAY_HOST}"
    DEPLOY_SCHEME="https"
  else
    resolve_aks_public_endpoint
    DEPLOY_HOST="$AKS_FRONTEND_PUBLIC_ENDPOINT_HOST"
    DEPLOY_SCHEME="${AKS_FRONTEND_PUBLIC_ORIGIN_SCHEME:-http}"
  fi

  local exposure_values_file
  exposure_values_file="$(write_aks_exposure_values)"

  helm upgrade --install "$E2E_RELEASE" ./helm/sre-simulator -n "$ns" \
    --create-namespace \
    -f "$exposure_values_file" \
    --set "frontend.image.repository=${AKS_FRONTEND_IMAGE_REPO:-ghcr.io/tuxerrante/sre-simulator-frontend}" \
    --set "frontend.image.tag=${tag}" \
    --set "frontend.image.pullPolicy=${image_pull_policy}" \
    --set frontend.replicas=1 \
    --set frontend.autoscaling.enabled=true \
    --set "frontend.autoscaling.minReplicas=${AKS_FRONTEND_MIN_REPLICAS:-1}" \
    --set "frontend.autoscaling.maxReplicas=${AKS_FRONTEND_MAX_REPLICAS:-3}" \
    --set "backend.image.repository=${AKS_BACKEND_IMAGE_REPO:-ghcr.io/tuxerrante/sre-simulator-backend}" \
    --set "backend.image.tag=${tag}" \
    --set "backend.image.pullPolicy=${image_pull_policy}" \
    --set backend.replicas=1 \
    --set "backend.port=${BACKEND_PORT:-8080}" \
    --set "frontend.port=${FRONTEND_PORT:-3000}" \
    --set ai.provider=azure-openai \
    --set ai.mockMode=false \
    --set "ai.model=${aoai_model}" \
    --set "ai.azureOpenai.endpointFromSecret.existingSecretName=azure-openai-creds" \
    --set "ai.azureOpenai.endpointFromSecret.key=endpoint" \
    --set "ai.azureOpenai.deployment=${AOAI_DEPLOYMENT}" \
    --set "ai.azureOpenai.credentials.existingSecretName=azure-openai-creds" \
    --set "ai.azureOpenai.credentials.key=api-key" \
    --set "ai.liveProbeToken=${probe_token}" \
    "${aoai_route_flags[@]}" \
    "${image_pull_flags[@]}" \
    "${db_flags[@]}" \
    --wait --timeout 15m >/dev/null
}
```

- [ ] **Step 4: Update status and audit targets to treat Gateway mode as the AKS steady state**

```makefile
prod-status:
 @set -e; \
 . scripts/select-deploy.sh; \
 NS="$(PROD_NAMESPACE)"; \
 echo "Namespace: $$NS"; \
 if [ "$(CLUSTER_FLAVOR)" = "aks" ] && [ "$(AKS_EXPOSURE_MODE)" = "gateway" ]; then \
  echo "Gateway:"; \
  "$$KUBE_CLI" -n "$$NS" get gateway,httproute,certificate 2>/dev/null || echo "  (no gateway resources)"; \
 else \
  echo "Frontend service:"; \
  "$$KUBE_CLI" -n "$$NS" get "svc/$(E2E_RELEASE)-frontend" 2>/dev/null || echo "  (no frontend service)"; \
 fi
```

```makefile
public-exposure-audit:
 @set -e; \
 . scripts/select-deploy.sh; \
 NS="$${NS:-$(PROD_NAMESPACE)}"; \
 RELEASE="$${RELEASE:-$(E2E_RELEASE)}"; \
 FRONT_SVC="$$RELEASE-frontend"; \
 BACK_SVC="$$RELEASE-backend"; \
 if [ "$(CLUSTER_FLAVOR)" = "aks" ] && [ "$(AKS_EXPOSURE_MODE)" = "gateway" ]; then \
  "$$KUBE_CLI" -n "$$NS" get "gateway/$$RELEASE" >/dev/null; \
  "$$KUBE_CLI" -n "$$NS" get "httproute/$$RELEASE" >/dev/null; \
  FRONT_TYPE=$$("$$KUBE_CLI" -n "$$NS" get "svc/$$FRONT_SVC" -o jsonpath='{.spec.type}'); \
  if [ "$$FRONT_TYPE" != "ClusterIP" ]; then \
   echo "Frontend service type must be ClusterIP in AKS gateway mode, found $$FRONT_TYPE"; \
   exit 1; \
  fi; \
 else \
  if "$$KUBE_CLI" -n "$$NS" get "ingress/$$RELEASE" >/dev/null 2>&1; then \
   echo "Unexpected frontend ingress found: $$RELEASE"; \
   exit 1; \
  fi; \
  if "$$KUBE_CLI" -n "$$NS" get "ingress/$$RELEASE-backend" >/dev/null 2>&1; then \
   echo "Unexpected backend ingress found: $$RELEASE-backend"; \
   exit 1; \
  fi; \
  FRONT_TYPE=$$("$$KUBE_CLI" -n "$$NS" get "svc/$$FRONT_SVC" -o jsonpath='{.spec.type}'); \
  if [ "$$FRONT_TYPE" != "LoadBalancer" ]; then \
   echo "Frontend service type must be LoadBalancer on AKS publicService mode, found $$FRONT_TYPE"; \
   exit 1; \
  fi; \
  FRONT_PORT=$$("$$KUBE_CLI" -n "$$NS" get "svc/$$FRONT_SVC" -o jsonpath='{.spec.ports[0].port}'); \
  if [ "$$FRONT_PORT" != "80" ]; then \
   echo "Frontend service port must be 80 on AKS publicService mode, found $$FRONT_PORT"; \
   exit 1; \
  fi; \
 fi; \
 SVC_TYPE=$$("$$KUBE_CLI" -n "$$NS" get "svc/$$BACK_SVC" -o jsonpath='{.spec.type}'); \
 if [ "$$SVC_TYPE" != "ClusterIP" ]; then \
  echo "Backend service type must be ClusterIP, found $$SVC_TYPE"; \
  exit 1; \
 fi
```

- [ ] **Step 5: Re-run the shell tests for both deploy helpers and chart rendering**

Run: `bash scripts/aks-deploy.test.sh && bash scripts/helm-platform.test.sh`
Expected: both test suites pass, covering the default `gateway` path and the explicit `publicService` rollback path.

- [ ] **Step 6: Commit the deploy-path and audit updates**

```bash
git add Makefile scripts/aks-deploy.sh scripts/aks-deploy.test.sh scripts/kube-deploy-common.sh
git commit -S -s -m "feat(aks): default production exposure to Gateway"
```

### Task 5: Update CI Coverage And Human-Facing Docs

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/helm-integration.yml`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `infra/POST_APPLY_CHECKLIST.md`
- Test: `make validate`
- Test: `make test`
- Test: `make test-integration`

- [ ] **Step 1: Update CI template coverage to render Gateway mode explicitly**

```yaml
- name: Helm template (AKS Gateway mode)
  run: |
    set -euo pipefail
    helm template sre-simulator ./helm/sre-simulator \
      --values ./helm/sre-simulator/values.yaml \
      --set exposure.mode=gateway \
      --set exposure.host=play.sresimulator.osadev.cloud \
      --set exposure.scheme=https \
      --set gateway.className=eg \
      --set gateway.tls.secretName=sre-simulator-gateway-tls \
      --set gateway.certManager.clusterIssuer=letsencrypt-azuredns-prod \
      --set gateway.envoyProxy.name=sre-simulator-public-edge \
      --set frontend.autoscaling.enabled=true \
      --set backend.autoscaling.enabled=true \
      --set database.enabled=true \
      --set database.existingSecretName=sre-sql-creds
```

- [ ] **Step 2: Keep the Kind integration test runtime path lightweight, but add a Gateway-mode render check there too**

```yaml
- name: Render Gateway mode for AKS
  run: |
    set -euo pipefail
    helm template sre-simulator ./helm/sre-simulator \
      --set exposure.mode=gateway \
      --set exposure.host=play.sresimulator.osadev.cloud \
      --set exposure.scheme=https \
      --set gateway.className=eg \
      --set gateway.tls.secretName=sre-simulator-gateway-tls \
      --set gateway.certManager.clusterIssuer=letsencrypt-azuredns-prod \
      --set gateway.envoyProxy.name=sre-simulator-public-edge >/dev/null

- name: Deploy chart with mock AI mode
  run: |
    set -euo pipefail
    helm install sre-simulator ./helm/sre-simulator \
      --set frontend.image.repository=sre-simulator-frontend \
      --set frontend.image.tag=test \
      --set frontend.image.pullPolicy=Never \
      --set backend.image.repository=sre-simulator-backend \
      --set backend.image.tag=test \
      --set backend.image.pullPolicy=Never \
      --set ai.mockMode=true \
      --set ai.strictStartup=false \
      --set storage.storageClass=standard \
      --set frontend.autoscaling.enabled=true \
      --set frontend.autoscaling.minReplicas=1 \
      --set frontend.autoscaling.maxReplicas=2 \
      --set exposure.mode=publicService \
      --set exposure.host=sre-simulator.localtest.me \
      --set exposure.scheme=http \
      --wait --timeout 3m
```

- [ ] **Step 3: Update the docs so the new AKS story is consistent**

```md
## Deployment targets

Production-style semver deployments now target **AKS by default**. The AKS path
uses Envoy Gateway on the existing static public IP, serves the app at
`https://play.sresimulator.osadev.cloud`, and keeps the backend private behind
the frontend proxy. The previous `publicService` mode remains available as an
explicit AKS rollback path.
```

```md
## AKS Exposure Model

- `Gateway` and `HTTPRoute` expose only the frontend on AKS.
- The frontend service is `ClusterIP` in Gateway mode.
- The backend remains a private `ClusterIP` service.
- cert-manager manages the TLS secret referenced by the Gateway listener.
- The Azure-generated `aaffinit-test.westeurope.cloudapp.azure.com` host remains
  an operator fallback during rollout, not the canonical production URL.
```

```md
## Post-apply checklist

7. Verify the custom DNS record exists:
   `az network dns record-set a show -g dns -z osadev.cloud -n play.sresimulator`
8. Verify Gateway TLS readiness:
   `kubectl -n sre-simulator get gateway,httproute,certificate`
9. Verify HTTPS:
   `curl -I https://play.sresimulator.osadev.cloud/`
```

- [ ] **Step 4: Run the full repo validation and test gates**

Run: `make validate && make test && make test-integration`
Expected: lint, type checks, unit tests, shell tests, and integration tests all pass with the new Gateway-mode code and updated docs.

- [ ] **Step 5: Commit the CI and documentation updates**

```bash
git add \
  .github/workflows/ci.yml \
  .github/workflows/helm-integration.yml \
  README.md \
  docs/ARCHITECTURE.md \
  infra/POST_APPLY_CHECKLIST.md
git commit -S -s -m "docs(aks): document the Gateway TLS deployment path"
```

### Task 6: Run The Approval-Gated Live Rollout And Verification

**Files:**

- Modify: local-only `infra/terraform.tfvars` if needed for real values (do not commit secret-bearing changes)
- Test: live Azure/AKS environment

- [ ] **Step 1: Make sure the branch is clean and the current code passes locally**

Run: `git status --short && make validate && make test && make test-integration`
Expected: no uncommitted code changes and all validation gates green before touching Azure or the cluster.

- [ ] **Step 2: Update local-only Terraform inputs for the real environment**

```hcl
# infra/terraform.tfvars (local working copy, not for commit)
cluster_flavor                    = "aks"
location                          = "westeurope"
sql_server_name                   = "aaffinitsqlz1775642113"
aks_gateway_host                  = "play.sresimulator.osadev.cloud"
aks_dns_zone_name                 = "osadev.cloud"
aks_dns_zone_resource_group_name  = "dns"
aks_cert_manager_identity_name    = "aaffinit-test-cert-manager-dns"
```

- [ ] **Step 3: Run Azure preflight and create the Terraform plan**

Run:

```bash
make tf-preflight \
  OWNER_ALIAS=aaffinit \
  CLUSTER_FLAVOR=aks \
  LOCATION=westeurope \
  TF_STATE_ACCOUNT="${TF_STATE_ACCOUNT}" \
  TF_STATE_KEY=aaffinit-test-sre-simulator.tfstate \
  SQL_SERVER_NAME=aaffinitsqlz1775642113 \
  GENEVA_SUPPRESSION_ACCESS_CONFIRMED=true

make tf-init-isolated OWNER_ALIAS=aaffinit

make tf-plan OWNER_ALIAS=aaffinit CLUSTER_FLAVOR=aks
```

Expected: the Terraform plan shows OIDC/workload identity changes on the AKS cluster, the new `aaffinit-test-cert-manager-dns` identity, a `DNS Zone Contributor` assignment on `osadev.cloud`, and an `A` record for `play.sresimulator.osadev.cloud`.

- [ ] **Step 4: Pause for explicit approval before the apply**

Run only after the human types `yes` for this exact command and scope:

```bash
make tf-apply OWNER_ALIAS=aaffinit CONFIRM_APPLY=aaffinit
```

Expected: Terraform applies the Azure-side prerequisites and prints the updated post-apply checklist.

- [ ] **Step 5: Refresh kubeconfig and do a staging-issuer smoke deploy first**

Run:

```bash
make tf-kubeconfig
export KUBECONFIG="$HOME/.kube/aaffinit-test"

DB_SECRET_NAME=sre-sql-creds make prod-up-final \
  CLUSTER_FLAVOR=aks \
  AKS_EXPOSURE_MODE=gateway \
  AKS_CLUSTER_ISSUER_NAME=letsencrypt-azuredns-staging
```

Expected: Envoy Gateway and cert-manager install successfully, the Gateway resources appear in `sre-simulator`, and cert-manager completes a DNS-01 challenge against the staging ACME endpoint.

- [ ] **Step 6: Promote the production certificate and verify the canonical host**

Run:

```bash
DB_SECRET_NAME=sre-sql-creds make prod-up-final \
  CLUSTER_FLAVOR=aks \
  AKS_EXPOSURE_MODE=gateway \
  AKS_CLUSTER_ISSUER_NAME=letsencrypt-azuredns-prod

make public-exposure-audit CLUSTER_FLAVOR=aks NS=sre-simulator
make db-port-forward-check CLUSTER_FLAVOR=aks NS=sre-simulator
curl -I https://play.sresimulator.osadev.cloud/
curl -ksS -H "x-ai-probe-token: ${AI_LIVE_PROBE_TOKEN}" \
  "https://play.sresimulator.osadev.cloud/api/ai/probe?live=true"
```

Expected: the Gateway is programmed, the frontend and backend services are both `ClusterIP`, the custom hostname serves HTTPS successfully, and the live probe returns `200`.

- [ ] **Step 7: If the rollout fails, use the preserved AKS `publicService` path to restore traffic**

Run:

```bash
DB_SECRET_NAME=sre-sql-creds make prod-up-final \
  CLUSTER_FLAVOR=aks \
  AKS_EXPOSURE_MODE=publicService \
  AKS_FRONTEND_PUBLIC_HOST=aaffinit-test.westeurope.cloudapp.azure.com \
  AKS_FRONTEND_PUBLIC_ORIGIN_SCHEME=http
```

Expected: the app falls back to the old AKS public-service edge on the reserved static IP while the Gateway/certificate issue is debugged separately.

- [ ] **Step 8: Commit only if the implementation code changed during rollout**

```bash
git status --short
git add \
  infra/aks.tf \
  infra/aks_gateway_dns.tf \
  infra/variables.tf \
  infra/outputs.tf \
  infra/terraform.tfvars.example \
  infra/final-aaffinit-test.tfvars.example \
  infra/tests/aks_gateway_dns.tftest.hcl \
  Makefile \
  scripts/aks-deploy.sh \
  scripts/aks-deploy.test.sh \
  scripts/kube-deploy-common.sh \
  scripts/helm-platform.test.sh \
  helm/sre-simulator/values.yaml \
  helm/sre-simulator/templates/_helpers.tpl \
  helm/sre-simulator/templates/frontend-service.yaml \
  helm/sre-simulator/templates/backend-deployment.yaml \
  helm/sre-simulator/templates/gateway.yaml \
  helm/sre-simulator/templates/httproute.yaml \
  .github/workflows/ci.yml \
  .github/workflows/helm-integration.yml \
  README.md \
  docs/ARCHITECTURE.md \
  infra/POST_APPLY_CHECKLIST.md
git commit -S -s -m "fix(aks): finalize the Gateway TLS rollout"
```

---

## Self-Review

- **Spec coverage:** The plan covers Azure prerequisites, Gateway controller install, cert-manager and DNS automation, Helm chart changes, deploy/audit updates, CI coverage, docs, and the approval-gated live rollout.
- **Placeholder scan:** No `TBD`, `TODO`, or “implement later” placeholders remain; all tasks name exact files and commands.
- **Type consistency:** The plan uses one consistent AKS control surface:
  - `AKS_EXPOSURE_MODE`
  - `AKS_GATEWAY_HOST`
  - `AKS_GATEWAY_CLASS_NAME`
  - `AKS_GATEWAY_TLS_SECRET_NAME`
  - `AKS_CLUSTER_ISSUER_NAME`
  - `AKS_DNS_ZONE_NAME`
  - `AKS_DNS_ZONE_RESOURCE_GROUP`
  - `AKS_CERT_MANAGER_IDENTITY_NAME`
