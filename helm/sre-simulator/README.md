# Helm Chart Profiles

This chart supports both OpenShift and generic Kubernetes by using an explicit
public exposure mode plus compatibility toggles.

## Quick Profiles

- Base defaults: `values.yaml` (Route-oriented defaults, OpenShift-compatible).
- Generic Kubernetes: `values-generic.yaml` (Ingress profile for kind/minikube).
- ARO + Vertex AI: `values-aro-ai-live.example.yaml`.
- ARO + Azure OpenAI: `values-aro-ai-azure-foundry.example.yaml`.

## Exposure Selection

`exposure.mode` is the primary control:

- `route` -> render `route.yaml` (OpenShift Route)
- `ingress` -> render `ingress.yaml` (Kubernetes Ingress)
- `publicService` -> frontend `Service` type `LoadBalancer`
- `gateway` -> Gateway API (`Gateway` + `HTTPRoute`)
- `none` -> no public edge object

Compatibility toggles remain available:

- `route.enabled`
- `ingress.enabled`

When `exposure.mode` is empty, the chart falls back to these legacy booleans.
When `exposure.mode` is set, it takes precedence.

## Platform-Specific Values

- `route.*` is OpenShift-specific.
- `ingress.*` is generic Kubernetes Ingress-specific.
- `gateway.*` is Gateway API-specific (AKS path in this repo).
- `storage.storageClass` is optional. Leave empty to use your cluster default.

## Render Examples

OpenShift Route mode:

```bash
helm template sre-simulator ./helm/sre-simulator \
  --values ./helm/sre-simulator/values.yaml
```

Generic Kubernetes Ingress mode:

```bash
helm template sre-simulator ./helm/sre-simulator \
  --values ./helm/sre-simulator/values.yaml \
  --values ./helm/sre-simulator/values-generic.yaml
```
