# Post-Apply Checklist

Complete these steps after `terraform apply` succeeds.

Before `terraform apply`, run the preflight gates for the final environment:

```bash
make tf-preflight \
  OWNER_ALIAS=aaffinit \
  CLUSTER_FLAVOR=aks \
  TF_STATE_ACCOUNT=<state-account> \
  LOCATION=westeurope \
  TF_STATE_KEY=aaffinit-test-sre-simulator.tfstate \
  SQL_SERVER_NAME=aaffinit-test-sql-20260403
```

If you are using the ARO fallback path instead of AKS, add:

```bash
GENEVA_SUPPRESSION_ACCESS_CONFIRMED=true
```

If this is your first run and the backend does not exist yet, preflight will
ask to create the state resource group/storage account/container and persist
backend defaults to `infra/.tf-backend.env`.

## 1. ARO-only: Silence Cluster in Geneva Health

Skip this section for AKS. Geneva suppression is only required for ARO
deployments.

To avoid production alert noise from this test cluster, create a suppression
rule in Geneva Health and confirm it is active before any break/fix traffic:

1. Navigate to **Geneva Health** → **Suppression Rules**
2. Create a new suppression rule:
   - **Scope:** Cluster name = `<owner_alias>-test` (e.g. `jdoe-test`)
   - **Resource Group** = `<owner_alias>-test-rg`
   - **Subscription** = your subscription
   - **Suppression type** = "Suppress all alerts"
   - **Duration** = Indefinite (or match the expected cluster lifetime)
   - **Reason** = "Test/development cluster – not production"
3. Verify the rule is active before running break-fix scenarios

> **Why?** Without suppression, the test cluster's incidents (synthetic ones are only simulated)
> will fire real alerts and page the on-call team.

For ARO final deployment targets, export:

```bash
export GENEVA_SUPPRESSION_RULE_ACTIVE=true
```

## 2. Extract Kubeconfig

```bash
make tf-kubeconfig CLUSTER_FLAVOR=aks
# or
export KUBECONFIG=~/.kube/<owner_alias>-test
```

## 3. Generate `.env.local`

> **Warning:** Do NOT blindly redirect into an existing `.env.local` — it will
> overwrite any manually-added values (API keys, custom endpoints, etc.).

Preview the generated snippet first:

```bash
terraform -chdir=infra output -raw env_file_snippet
```

If `backend/.env.local` does not exist yet, you can write it:

```bash
terraform -chdir=infra output -raw env_file_snippet > backend/.env.local
```

If the file already exists, compare and merge manually:

```bash
diff <(terraform -chdir=infra output -raw env_file_snippet) backend/.env.local
```

Then fill in the API key:

```bash
az cognitiveservices account keys list \
  -g <owner_alias>-test-rg \
  -n <owner_alias>-test-aoai \
  --query key1 -o tsv
```

## 4. Namespace Model (Shared Cluster + Shared AOAI)

The selected cluster (`CLUSTER_FLAVOR=aks` by default, `aro` as fallback) and
Azure OpenAI deployment are **shared** between the stable ("production")
namespace and ephemeral e2e namespaces:

```text
┌─────────────────────────────────────────────┐
│  Selected Cluster (<alias>-test)            │
│                                             │
│  ┌─────────────────────┐  ┌──────────────┐  │
│  │ sre-simulator (prod)│  │ sre-manual-  │  │
│  │ ─ stable, protected │  │ e2e-<ts>     │  │    ┌────────────────────┐
│  │ ─ make prod-up      │  │ ─ disposable │  │───▶│ Azure OpenAI       │
│  │ ─ make prod-down    │  │ ─ make e2e-  │  │    │ (<alias>-test-aoai)│
│  │   (requires confirm)│  │   azure-     │  │    │ shared by all ns   │
│  └─────────────────────┘  │   route-up   │  │    └────────────────────┘
│                           └──────────────┘  │
└─────────────────────────────────────────────┘
```

### Deploy to production namespace

```bash
CLUSTER_FLAVOR=aks make prod-up
```

For the final environment run (DB enabled + mandatory checks), use:

```bash
DB_SECRET_NAME=sre-sql-creds \
CLUSTER_FLAVOR=aks \
make prod-up-final
```

### Check production status

```bash
CLUSTER_FLAVOR=aks make prod-status
```

### Delete production namespace (requires typing namespace name)

```bash
CLUSTER_FLAVOR=aks make prod-down
```

### Deploy ephemeral e2e (disposable, no confirmation needed)

```bash
CLUSTER_FLAVOR=aks make e2e-azure-route-up    # creates timestamped namespace
CLUSTER_FLAVOR=aks make e2e-azure-route-down  # deletes it (refuses if it matches prod namespace)
```

## 5. Validate exposure, TLS, and DB connectivity

Run these checks after each final deployment:

```bash
# Snapshot pods plus Gateway/HTTPRoute/certificate state
CLUSTER_FLAVOR=aks make prod-status

# Frontend public edge exists; backend remains private ClusterIP and non-routable
CLUSTER_FLAVOR=aks make public-exposure-audit NS=sre-simulator
```

### Confirm the custom DNS record

```bash
terraform -chdir=infra output -raw aks_gateway_public_host
terraform -chdir=infra output -raw aks_frontend_public_ip_address
terraform -chdir=infra output -raw aks_frontend_public_fqdn

dig +short play.sresimulator.osadev.cloud
dig +short "$(terraform -chdir=infra output -raw aks_frontend_public_fqdn)"
```

`play.sresimulator.osadev.cloud` should resolve to the same public IP returned
by `aks_frontend_public_ip_address`. Use the Azure-generated hostname from
`aks_frontend_public_fqdn` only as an operator fallback while the custom DNS
record propagates or during DNS troubleshooting.

### Confirm Gateway and certificate readiness

```bash
kubectl -n sre-simulator get gateway,httproute,certificate

kubectl -n sre-simulator wait \
  --for=jsonpath='{.status.conditions[?(@.type=="Programmed")].status}'=True \
  gateway/sre-simulator --timeout=5m

CERT_NAME="$(kubectl -n sre-simulator get certificate -o jsonpath='{range .items[*]}{.metadata.name}{\"|\"}{.spec.secretName}{\"\\n\"}{end}' | awk -F'|' '$2 == \"sre-simulator-gateway-tls\" {print $1; exit}')"
kubectl -n sre-simulator wait \
  --for=jsonpath='{.status.conditions[?(@.type=="Ready")].status}'=True \
  "certificate/${CERT_NAME}" --timeout=10m
```

If `CERT_NAME` is empty, the gateway shim did not create a certificate for
`sre-simulator-gateway-tls`, so investigate the `Gateway` annotation,
cert-manager controllers, and DNS solver identity before continuing.

### Verify HTTPS on the customer-facing host

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://play.sresimulator.osadev.cloud/
curl -I https://play.sresimulator.osadev.cloud/
```

Expect the custom host to present a valid certificate and return the normal
frontend response for the deployed release.

### Fallback DB check when GitHub pipelines are unavailable

```bash
CLUSTER_FLAVOR=aks make db-mode-check NS=sre-simulator
CLUSTER_FLAVOR=aks make db-port-forward-check NS=sre-simulator
```

Use `db-mode-check` as the primary proof that the deployed backend is wired for
Azure SQL mode: it verifies `STORAGE_BACKEND=mssql` plus the `DATABASE_URL`
secret reference on the backend deployment.

`db-port-forward-check` is an additional reachability smoke test. It calls
`/api/scores?difficulty=easy` through a local `kubectl port-forward` or
`oc port-forward` tunnel to the backend service and confirms that this path
responds with `200`.

## 6. AOAI Capacity & Scaling Notes

The Azure OpenAI deployment is provisioned with a **Standard (pay-as-you-go)**
SKU. Key things to know:

### Capacity is a rate limit, not a cost driver

The `aoai_capacity` variable (default 80K TPM) controls the **tokens per
minute rate limit**, not billing. Cost is strictly per-token-consumed. You can
safely increase capacity to avoid throttling without increasing spend.

### Deployment creation is slow — always pre-provision

Creating or modifying an Azure OpenAI model deployment takes **75 minutes to
2+ hours**. Never attempt to create deployments on-demand (e.g. during user
login). The single shared deployment created by Terraform should serve all
concurrent users; increase `aoai_capacity` if you see 429 errors.

### Multiplayer sizing reference

| Concurrent users | Recommended TPM | Notes |
| ----------------: | ----------------: | ------- |
| 1 | 80K | Default — covers peak + concurrent e2e |
| 2-3 | 150K | Comfortable headroom |
| 5+ | 250K+ | Consider Global Standard for 2M+ TPM ceiling |

To change capacity without redeploying, update `aoai_capacity` in
`terraform.tfvars` and run `make tf-apply`. The change takes effect within
minutes (it only updates the rate limit on the existing deployment).

### Documented Azure limits

| Limit | Value |
| ------- | ------- |
| Max standard deployments per AOAI resource | 32 |
| Max AOAI resources per region per subscription | 30 |
| `gpt-4o-mini` Tier 1 quota (Standard) | 6M TPM |
| `gpt-4o-mini` usage tier (monthly) | 85B tokens |

See [Azure OpenAI Quotas and Limits](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/quotas-limits)
for the full reference. Quota tiers auto-upgrade with usage.

## 7. Tear Down (when done)

```bash
CLUSTER_FLAVOR=aks make tf-destroy
```

Most customer-managed resources are in a single resource group, so you can also run:

```bash
az group delete --name <owner_alias>-test-rg --yes --no-wait
```

> **Note:** `tf-destroy` / `az group delete` removes the cluster and AOAI
> account in the customer-managed RG. AKS still has an Azure-managed node
> resource group, and ARO still has an RP-managed cluster resource group; both
> are cleaned up by the provider when cluster deletion completes.
>
> **Tagging caveat:** Managed cluster resource groups can be protected by Azure
> deny assignments. In that case, even Owner/Contributor principals cannot
> write tags on that RG, and `persist=true` cannot be enforced there via
> Terraform.
>
> **Workaround for locked-down subscriptions:** Disable the cluster RG tag overlay
> by setting `enable_cluster_rg_tag_overlay=false` for plan/apply. Example:
>
> ```bash
> terraform -chdir=infra plan -var="enable_cluster_rg_tag_overlay=false"
> terraform -chdir=infra apply -var="enable_cluster_rg_tag_overlay=false"
> ```
