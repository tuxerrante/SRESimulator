# ARO AI Connectivity Spike

This runbook validates issue `#4` end-to-end: backend pod -> Vertex AI -> Claude response.

## Alternative: Azure OpenAI / Foundry

For a no-`gcloud` pod-native path, use Azure OpenAI/Foundry with API key auth.
In this flow, both endpoint and API key are masked in a Kubernetes Secret (not in Helm values).

1. Create an API key secret in the target namespace:

```bash
oc -n <namespace> create secret generic azure-openai-creds \
  --from-literal=endpoint="https://<your-account>.cognitiveservices.azure.com" \
  --from-literal=api-key="<azure-openai-key>"
```

1. Deploy with the Azure Foundry override values:

```bash
helm upgrade --install sre-simulator ./helm/sre-simulator \
  -n <namespace> \
  -f helm/sre-simulator/values-aro-ai-azure-foundry.example.yaml
```

1. Run the same probe checks:

```bash
oc -n <namespace> exec deploy/sre-simulator-backend -- \
  node -e "fetch('http://127.0.0.1:8080/api/ai/probe?live=true').then(async (r)=>{console.log(r.status);console.log(await r.text());process.exit(r.ok?0:1)}).catch((e)=>{console.error(e);process.exit(1)})"
```

## Goal

Prove that an in-cluster backend pod can execute a live model call using `GET /api/ai/probe?live=true`.

## 1) Prepare GCP credentials (initial/simple path)

Create a Kubernetes secret in your target namespace with a GCP service account JSON key:

```bash
oc -n <namespace> create secret generic gcp-vertex-creds \
  --from-file=credentials.json="/absolute/path/to/service-account.json"
```

## 2) Deploy chart with live AI mode enabled

Create an override file:

```yaml
ai:
  mockMode: false
  strictStartup: true
  model: claude-sonnet-4@20250514
  vertex:
    region: us-east5
    projectId: <your-gcp-project-id>
    credentials:
      existingSecretName: gcp-vertex-creds
      key: credentials.json
      mountPath: /var/run/secrets/gcp
```

Deploy:

```bash
helm upgrade --install sre-simulator ./helm/sre-simulator \
  -n <namespace> \
  -f /path/to/override-values.yaml
```

## 3) Verify backend readiness

```bash
oc -n <namespace> rollout status deploy/sre-simulator-backend
oc -n <namespace> get pods -l app.kubernetes.io/component=backend
```

If startup validation fails, inspect:

```bash
oc -n <namespace> logs deploy/sre-simulator-backend
```

## 4) Run active probe inside pod

Use Node.js (present in the backend container) so no extra tooling is required:

```bash
oc -n <namespace> exec deploy/sre-simulator-backend -- \
  node -e "fetch('http://127.0.0.1:8080/api/ai/probe?live=true').then(async (r)=>{console.log(r.status);console.log(await r.text());process.exit(r.ok?0:1)}).catch((e)=>{console.error(e);process.exit(1)})"
```

Expected result:

- HTTP `200`
- JSON with `"ok": true`, `"mode": "live"`, and latency data.

## 5) Run external route probe

```bash
ROUTE_HOST=$(oc -n <namespace> get route sre-simulator -o jsonpath='{.spec.host}')
curl -sS "https://${ROUTE_HOST}/api/ai/probe?live=true" | jq
```

Expected result:

- Same `"ok": true` response from outside the cluster route.

## Notes

- For long-term hardening, replace key-based credentials with workload identity federation.
- Keep `mockMode=true` in non-production environments when you only need deployment smoke checks.
