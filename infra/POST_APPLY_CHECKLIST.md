# Post-Apply Checklist

Complete these steps after `terraform apply` succeeds.

Before `terraform apply`, run the preflight gates for the final environment:

```bash
make tf-preflight \
  OWNER_ALIAS=aaffinit \
  TF_STATE_ACCOUNT=<state-account> \
  TF_STATE_KEY=aaffinit-test-sre-simulator.tfstate \
  SQL_SERVER_NAME=aaffinit-test-sql-20260403 \
  GENEVA_SUPPRESSION_ACCESS_CONFIRMED=true
```

If this is your first run and the backend does not exist yet, preflight will
ask to create the state resource group/storage account/container.

## 1. Silence Cluster in Geneva Health

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

For guarded final deployment targets, export:

```bash
export GENEVA_SUPPRESSION_RULE_ACTIVE=true
```

## 2. Extract Kubeconfig

```bash
make tf-kubeconfig
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

The ARO cluster and Azure OpenAI deployment are **shared** between the
stable ("production") namespace and ephemeral e2e namespaces:

```text
┌─────────────────────────────────────────────┐
│  ARO Cluster (<alias>-test)                 │
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
make prod-up
```

For the final environment run (DB enabled + mandatory checks), use:

```bash
DB_SECRET_NAME=sre-sql-creds \
GENEVA_SUPPRESSION_RULE_ACTIVE=true \
make prod-up-final
```

### Check production status

```bash
make prod-status
```

### Delete production namespace (requires typing namespace name)

```bash
make prod-down
```

### Deploy ephemeral e2e (disposable, no confirmation needed)

```bash
make e2e-azure-route-up    # creates timestamped namespace
make e2e-azure-route-down  # deletes it (refuses if it matches prod namespace)
```

## 5. Validate exposure and DB connectivity

Run these checks after each final deployment:

```bash
# Frontend route exists; backend remains private ClusterIP and non-routable
make public-exposure-audit NS=sre-simulator

# Fallback DB check when GH pipelines are unavailable
make db-port-forward-check NS=sre-simulator
```

`db-port-forward-check` calls `/api/scores?difficulty=easy` through a local
`oc port-forward` tunnel to the backend service. A `200` response confirms the
backend can serve DB-backed queries.

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
make tf-destroy
```

Most customer-managed resources are in a single resource group, so you can also run:

```bash
az group delete --name <owner_alias>-test-rg --yes --no-wait
```

> **Note:** `tf-destroy` / `az group delete` removes the cluster and AOAI
> account in the customer-managed RG. The ARO RP-managed cluster RG is cleaned
> up by the provider when cluster deletion completes.
