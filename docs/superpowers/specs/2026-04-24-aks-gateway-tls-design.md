# AKS Gateway TLS Custom Domain Design

## Goal

Move the AKS production entrypoint from the Azure-generated public hostname to
`https://play.sresimulator.osadev.cloud`, while keeping the backend private,
automating certificate renewal, and minimizing manual day-2 operations.

## Current Context

- The AKS cluster is live and the app is reachable over HTTP through the static
  public IP currently exposed by the frontend `LoadBalancer` service.
- The current fallback host is
  `aaffinit-test.westeurope.cloudapp.azure.com`, backed by the static public IP
  `20.105.144.15`.
- The frontend is public on AKS today; the backend remains an internal
  `ClusterIP` service.
- The cluster does not yet have Gateway API CRDs or a Gateway controller.
- The cluster does not currently have the AKS Key Vault Secrets Provider add-on
  or workload identity enabled.
- The Azure subscription already contains reusable public DNS zones, including
  `osadev.cloud`, and `play.sresimulator.osadev.cloud` is currently unused.
- The Helm chart already contains an unfinished Key Vault CSI hook on the
  backend deployment, but there is no matching `SecretProviderClass` template or
  completed runtime contract around it.

## Requirements

- Reuse an existing public DNS zone; do not buy a new domain.
- Avoid a region-specific public URL.
- Keep ARO support intact; this change is for the AKS path.
- Keep the backend private and only expose the frontend edge.
- Automate certificate issuance and renewal after the initial rollout.
- Prefer a low-maintenance, Kubernetes-native operating model.
- Avoid pushing TLS certificates into application pods when the edge can own
  TLS termination.
- Keep destructive or environment-mutating actions behind explicit human
  approval at execution time.

## Chosen Approach

Use a self-managed Gateway API stack on AKS:

1. Use the canonical public hostname `play.sresimulator.osadev.cloud`.
2. Keep the existing static AKS public IP and repoint public traffic to an
   Envoy Gateway-managed service instead of the frontend service.
3. Install Envoy Gateway as the Gateway API controller.
4. Install cert-manager and issue the public certificate with Let's Encrypt
   using Azure DNS `DNS-01`.
5. Authenticate cert-manager to Azure DNS with AKS workload identity and a
   scoped Azure managed identity.
6. Terminate TLS at the Gateway listener using a Kubernetes TLS `Secret`
   referenced from `certificateRefs`.
7. Revert the frontend service to internal `ClusterIP` on AKS and route traffic
   to it through `Gateway` + `HTTPRoute`.
8. Leave the backend service private and unchanged from the current internal
   proxy model.

## Why This Approach

This is the lowest-maintenance path that is likely to work end-to-end for the
chosen hostname:

- `play.sresimulator.osadev.cloud` can be publicly trusted because the
  subscription already owns the DNS zone.
- Gateway API gives a cleaner public edge than continuing to use the frontend
  `LoadBalancer` service directly.
- cert-manager already supports Gateway listeners and updates the referenced TLS
  `Secret` automatically when the certificate renews.
- Azure DNS `DNS-01` avoids HTTP challenge bootstrapping problems during the
  migration from the current edge.
- The TLS certificate stays at the edge, where it belongs, rather than being
  mounted into application pods.

## Why Not Use Key Vault As The Primary TLS Source

Azure Key Vault is not the primary TLS path for this design.

- The user requirement is automatic public certificate rotation on a custom
  hostname we control in Azure DNS.
- The simplest proven automation flow for that requirement is
  cert-manager + Let's Encrypt + Azure DNS.
- Key Vault certificate auto-renewal for public certificates depends on
  supported integrated CAs and preexisting issuer setup, which is not part of
  the current app stack.
- The current repo does not have a finished Key Vault TLS integration path for a
  Gateway listener, and the existing CSI hook is incomplete.
- Using Key Vault as a mount source would also introduce pod-mount coupling that
  is unnecessary for Gateway-terminated TLS.

Key Vault may still be useful later for application secrets or a separate
certificate export workflow, but it should not be the critical path for the
public HTTPS rollout.

## Architecture

### Public Edge

- `play.sresimulator.osadev.cloud` resolves to the existing static AKS public IP.
- The Envoy Gateway service owns ports `80` and `443` on that IP.
- HTTPS is terminated at the Gateway listener.
- HTTP remains available only as a bootstrap and redirect path during rollout;
  the steady state should prefer HTTPS.

### Internal Traffic

- The frontend service becomes `ClusterIP`.
- A single `HTTPRoute` forwards traffic from the public Gateway to the frontend
  service.
- The frontend continues proxying `/api/*` to the backend service over the
  existing in-cluster path.
- The backend service remains `ClusterIP` and is not directly internet-exposed.

### Certificate Lifecycle

- cert-manager owns the certificate lifecycle.
- A `ClusterIssuer` uses Azure DNS `DNS-01` against the `osadev.cloud` zone.
- The `Gateway` listener references a TLS `Secret`.
- cert-manager's Gateway integration keeps that `Secret` populated and renewed.
- Envoy Gateway reloads the updated certificate when the referenced `Secret`
  changes.

## Platform Boundaries

- The new public AKS exposure mode is Gateway-based.
- The ARO path remains Route-based and should keep its current behavior.
- The implementation should introduce AKS-specific Gateway resources without
  changing the ARO Route contract.
- Existing AKS deploy and audit commands need to be updated so they validate the
  Gateway edge instead of a public frontend service.

## Code Versus Operator Responsibilities

### Code-Managed

These should become declarative and repeatable in the repository:

- Azure managed identity for cert-manager DNS updates.
- Azure role assignment granting DNS write access to the relevant DNS zone.
- DNS record for `play.sresimulator.osadev.cloud`.
- AKS settings needed for workload identity.
- Envoy Gateway installation and configuration.
- cert-manager installation and configuration.
- `ClusterIssuer`, `Gateway`, and `HTTPRoute` resources.
- Helm exposure logic so AKS can use a Gateway-backed internal frontend service.
- Validation and status targets that assert Gateway, DNS, HTTPS, and backend
  privacy.
- Documentation for one-time setup, normal deploys, and automatic renewal.

### Operator-Executed

These remain explicit operator actions:

- Approving and running `terraform apply`.
- Approving and running cluster-changing rollout commands.
- Investigating permission gaps if the current Azure identity cannot write the
  shared `osadev.cloud` zone.
- Emergency rollback if live traffic must be restored before the declarative
  path is fixed.

## Rollout Design

1. Enable any AKS identity prerequisites required for the DNS automation path.
2. Create the Azure managed identity and scope it only to the DNS zone role it
   needs.
3. Install Envoy Gateway without yet switching the canonical hostname.
4. Bind the Envoy Gateway service to the existing static public IP.
5. Install cert-manager and the Azure DNS-backed `ClusterIssuer`.
6. Create the DNS `A` record for `play.sresimulator.osadev.cloud`.
7. Create the `Gateway` and `HTTPRoute`.
8. Wait for certificate issuance and Gateway readiness.
9. Flip the AKS frontend service from public `LoadBalancer` to internal
   `ClusterIP`.
10. Promote `play.sresimulator.osadev.cloud` as the canonical production URL.
11. Keep the Azure-generated `cloudapp.azure.com` hostname available as an
    operator fallback until the new hostname is fully verified.

## Failure Handling And Rollback

- If DNS permissions are missing, stop before changing the live public edge.
- If certificate issuance fails, keep the current public service in place and do
  not promote the new hostname.
- If Gateway routing is wrong after deployment, restore the frontend service as
  the public edge and keep using the Azure-generated hostname while debugging.
- If the DNS record exists but HTTPS is not ready, do not switch user-facing
  references to the new host until cert-manager and the Gateway are healthy.
- If the shared-zone ownership model becomes a blocker, that is an environment
  permission issue and should not be worked around by hardcoding secrets or
  bypassing certificate automation.

## Verification Design

### Render-Level Verification

- Helm rendering should prove that the AKS path can express a Gateway-backed
  edge while the ARO path still renders a Route.
- Tests should assert that the frontend service is `ClusterIP` in Gateway mode.
- Tests should assert that the backend remains `ClusterIP`.

### Cluster-Level Verification

- `Gateway` reports accepted and programmed listeners.
- `HTTPRoute` attaches cleanly to the Gateway.
- cert-manager reports the certificate as ready.
- The TLS `Secret` referenced by the Gateway exists and is populated.
- `curl -I https://play.sresimulator.osadev.cloud/` succeeds.
- The existing live probe still returns `200`.
- No backend public edge object exists.

### Day-2 Verification

- Certificate renewal updates the referenced `Secret` without manual rotation.
- Gateway listeners continue serving the renewed certificate without pushing new
  app images.
- Future production deploys continue to use the canonical hostname and do not
  depend on the Azure-generated hostname.

## Out Of Scope

- Replacing application secrets with Key Vault in the same change.
- Adding a Key Vault private endpoint as part of the initial HTTPS cutover.
- Changing the ARO public exposure model.
- Reworking unrelated deploy or CI behavior outside the Gateway/TLS path.

## Success Criteria

- `play.sresimulator.osadev.cloud` becomes the stable public app URL.
- HTTPS works with a publicly trusted certificate.
- Certificate renewal is automatic after rollout.
- The backend remains private inside the cluster.
- The ARO route path remains available as a separate platform mode.
- The new AKS HTTPS path is declarative in repo code, with only approval-gated
  apply steps remaining manual.
