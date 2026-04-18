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
