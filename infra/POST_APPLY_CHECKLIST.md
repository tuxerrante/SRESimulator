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
make -C infra tf-kubeconfig
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

## 4. Deploy the App

```bash
make e2e-azure-route-up
```

## 5. Tear Down (when done)

```bash
make -C infra tf-destroy
```

All resources are in a single resource group, so you can also run:

```bash
az group delete --name <owner_alias>-test-rg --yes --no-wait
```
