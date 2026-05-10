# Setup and Operations

Technical setup and operational commands are documented here so
`README.md` can stay customer-focused.

## Prerequisites

| Requirement | Version |
| --- | --- |
| Node.js | >= 20 |
| npm | >= 10 |
| gcloud | Optional for Vertex provider |
| Managed AI endpoint | Vertex or Azure OpenAI/Foundry |

## Local development

```bash
make install
make dev
```

## AI runtime configuration

For provider options, environment variables, and runtime behavior, use:

- [docs/AI_RUNTIME.md](AI_RUNTIME.md)
- [docs/ARO_AI_CONNECTIVITY_SPIKE.md](ARO_AI_CONNECTIVITY_SPIKE.md)

## Useful Make targets

| Command | Description |
| --- | --- |
| `make validate` | Lint + typecheck validation |
| `make test` | Unit tests with coverage |
| `make test-integration` | Integration tests |
| `make security` | Security checks |
| `make aro-login` | Authenticate Azure CLI if needed and log `oc` into the configured ARO cluster |
| `make e2e-azure-route-up` | Create temporary Azure e2e namespace |
| `make e2e-azure-route-refresh` | Refresh existing e2e namespace |
| `make e2e-azure-route-down` | Delete temporary e2e namespace |
| `make prod-up-tag TAG=vX.Y.Z` | Deploy a specific semver release |
| `make prod-up-final` | Guarded production deploy sequence |
| `make prod-status` | Show production namespace status |
| `make prod-down` | Delete production namespace (explicit confirmation) |

## Production and infra guidance

For production environment safety checks and sequencing:

- [infra/POST_APPLY_CHECKLIST.md](../infra/POST_APPLY_CHECKLIST.md)

For release/tag policy and CI/CD gating:

- [docs/RELEASES.md](RELEASES.md)

### Public URL and DNS

The canonical public URL for the AKS production path is
`https://play.sresimulator.osadev.cloud`.

- Exposure modes and the frontend-only public edge are described in
  [docs/ARCHITECTURE.md](ARCHITECTURE.md) under "Cluster Exposure Model".
- Gateway TLS, DNS zone, and certificate automation details are captured in
  [docs/superpowers/specs/2026-04-24-aks-gateway-tls-design.md](superpowers/specs/2026-04-24-aks-gateway-tls-design.md).
- After Terraform changes, use
  [infra/POST_APPLY_CHECKLIST.md](../infra/POST_APPLY_CHECKLIST.md)
  to sequence DNS verification, certificate checks, and the final deploy flow.

For AKS, `publicService` remains the rollback exposure mode when operators need
to temporarily expose only the frontend through a `LoadBalancer` service. ARO
still uses the Route-based fallback described in the architecture doc.
