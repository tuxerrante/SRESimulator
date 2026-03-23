# Post-Apply Checklist

Complete these steps after `terraform apply` succeeds.

## 1. Silence Cluster in Geneva Health

To avoid production alert noise from this test cluster, create a suppression
rule in Geneva Health:

1. Navigate to **Geneva Health** → **Suppression Rules**
2. Create a new suppression rule:
   - **Scope:** Cluster name = `<owner_alias>-test` (e.g. `jdoe-test`)
   - **Resource Group** = `<owner_alias>-test-rg`
   - **Subscription** = your subscription
   - **Suppression type** = "Suppress all alerts"
   - **Duration** = Indefinite (or match the expected cluster lifetime)
   - **Reason** = "Test/development cluster – not production"
3. Verify the rule is active before running break-fix scenarios

> **Why?** Without suppression, the test cluster's synthetic incidents will
> fire real alerts and page the on-call team.

## 2. Extract Kubeconfig

```bash
make tf-kubeconfig
# or
export KUBECONFIG=~/.kube/<owner_alias>-test
```

## 3. Generate `.env.local`

```bash
terraform -chdir=infra output -raw env_file_snippet > backend/.env.local
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

## 5. Tear Down (when done)

```bash
make tf-destroy
```

All resources are in a single resource group, so you can also run:

```bash
az group delete --name <owner_alias>-test-rg --yes --no-wait
```

> **Note:** `tf-destroy` / `az group delete` removes the cluster and AOAI
> account. Both prod and e2e namespaces disappear with the cluster.
