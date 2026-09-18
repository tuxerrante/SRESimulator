# OCI free-tier Terraform root

Provisions the single Oracle Cloud Always Free box that hosts the SRE
Simulator: one `VM.Standard.A1.Flex` (aarch64) running single-node k3s, with
the bundled Traefik bound directly to the host network.

This is a **separate root** from `infra/`, not a flavor of it. Different
providers, different state, different lifecycle. Nothing here touches the Azure
configuration, and `infra/` continues to work unchanged.

## What it creates

| Resource | Notes |
| --- | --- |
| VCN + internet gateway + route table | `10.0.0.0/16` by default; must not overlap k3s pod `10.42.0.0/16` or service `10.43.0.0/16` |
| One public subnet | `10.0.0.0/24` |
| Network security group on the instance VNIC | The firewall. See below. |
| `VM.Standard.A1.Flex` instance | 2 OCPU / 12 GB / 60 GB by default — half the Always Free A1 allowance |
| Reserved public IP | Survives stop/start so the Cloudflare A record stays valid |
| cloud-init | Installs pinned k3s, writes the Traefik config, flushes the host firewall, adds swap |

Everything is inside the Always Free envelope (4 OCPU / 24 GB / 200 GB block
storage per tenancy). The variable validations refuse to exceed it.

## Prerequisites

1. `oci setup config` — the provider authenticates from `~/.oci/config`, so no
   private key ever lands in a tfvars file or in Terraform state.
2. Terraform >= 1.9 (cross-variable validation).
3. An SSH keypair.
4. Optional but recommended: **upgrade the tenancy to Pay-As-You-Go.** Always
   Free resources stay $0, but the idle-reclamation policy (see below) applies
   only to Always-Free-*only* tenancies.

## Usage

```sh
cd infra/oci
cp terraform.tfvars.example terraform.tfvars   # then edit
make tf-oci-init-local                          # or tf-oci-init for remote state
make tf-oci-validate tf-oci-test
make tf-oci-plan  OWNER_ALIAS=jdoe
make tf-oci-apply OWNER_ALIAS=jdoe CONFIRM_APPLY=jdoe
```

`tf-oci-apply` prints a post-apply checklist covering the steps Terraform
deliberately does not perform: the Cloudflare record, the origin-reachability
check, and the client-IP verification that must happen before
`requireAnonymousClientIp` is ever enabled.

The same targets exist at the repository root (`make tf-oci-plan`, …) and
simply delegate here.

### Expect "Out of host capacity"

A1 capacity in `eu-frankfurt-1` is frequently exhausted, and this is the single
most common failure of this build. It is not a misconfiguration. Increment
`availability_domain_index` (0 → 1 → 2) and re-apply; if all three are full,
retry later. Do not "fix" it by switching to a billable shape.

## The firewall

The primary control is the **NSG attached to the instance VNIC**. It is
stateful and enforced in the OCI network fabric, so unlike an iptables chain it
cannot be flushed by anyone who gets root on the box. The subnet security list
keeps only the ICMP rule.

| Dir | Proto | Port | Source | Default |
| --- | --- | --- | --- | --- |
| In | TCP | 80 | Cloudflare ranges | open |
| In | TCP | 443 | Cloudflare ranges | open |
| In | TCP | 22 | `ssh_allowed_cidrs` | **closed** |
| In | TCP | 6443 | `k8s_api_allowed_cidrs` | **closed** |
| In | ICMP | 3/4 | `0.0.0.0/0` | open |
| Out | all | all | `0.0.0.0/0` | open |

Restricting 80/443 to Cloudflare's published ranges (fetched with the `http`
data source at plan time) is what makes `cf-connecting-ip` trustworthy: without
it, anyone who learns the origin IP can bypass the proxy and forge that header.

`k8s_api_allowed_cidrs = ["0.0.0.0/0"]` is rejected by a variable validation,
and `ssh_allowed_cidrs = ["0.0.0.0/0"]` requires setting
`allow_ssh_from_anywhere = true` as a separate, deliberate act.

**Be honest about what this buys.** An NSG cannot absorb a volumetric DDoS:
packets still traverse the 50 Mbps-per-OCPU link, and the 10 TB/month egress
cap is an availability *and* a billing risk. Cloudflare's proxy is the actual
mitigation. Layered on top: Traefik `rateLimit` / `inFlightReq` middlewares,
the application's own rate limiter, and Turnstile.

### The in-VM firewall is deliberately flushed

OCI's Ubuntu images ship `iptables-persistent` with a default-DROP `INPUT`
chain. cloud-init flushes it and lets the NSG be the single source of truth,
because maintaining two half-synchronised firewalls is how an evening
disappears.

Measured on a local aarch64 VM reproducing this shape, using a genuine
non-loopback source (a pod curling the node IP — loopback and SSH-tunnelled
traffic both hit `-i lo -j ACCEPT` and prove nothing):

| | node:80 from a pod | pod→pod | egress |
| --- | --- | --- | --- |
| `INPUT` flushed | **301** | ok | ok |
| OCI default-REJECT | **000, "Failed to connect after 0 ms"** | ok | ok |

So the hazard is specifically **inbound traffic to the hostNetwork ingress**.
Pod networking and DNS are unaffected either way.

If you want two enforcement layers instead, replace the flush in
`cloud-init.yaml.tftpl` with explicit accepts inserted *before* the REJECT:

```sh
iptables -I INPUT -s 10.42.0.0/16 -j ACCEPT     # pods
iptables -I INPUT -s 10.43.0.0/16 -j ACCEPT     # services
iptables -I INPUT -p tcp --dport 80  -j ACCEPT
iptables -I INPUT -p tcp --dport 443 -j ACCEPT
netfilter-persistent save
```

## `traefik-config.yaml` is shared with CI

`traefik-config.yaml` is consumed by exactly two callers, which must stay
byte-identical apart from substituting `ACME_EMAIL_PLACEHOLDER`:

1. `cloud-init.yaml.tftpl`, which writes it to
   `/var/lib/rancher/k3s/server/manifests/` on the box;
2. the `oci-shape-e2e` job in `.github/workflows/ci.yml`, which installs real
   k3s on an arm64 GitHub-hosted runner and copies the same file into the same
   path.

**Do not fork it.** A private copy in CI would green-light a configuration the
box never runs, which is the entire failure mode the shared file exists to
prevent.

Three bugs in this config were found by running the shape on a real aarch64 VM
before any cloud instance existed. Each is silent in a different way, so each
is locked by an assertion in `tests/traefik_config.tftest.hcl` *and* by the CI
job:

1. **`redirectTo` was removed in Traefik chart v34** (k3s v1.33.4 ships
   v34.2.1) and is a hard install failure. Because cloud-init writes the
   manifest before k3s first starts, that failure leaves Traefik at chart
   defaults — `service.enabled: true`, `hostNetwork: false` — with servicelb
   already disabled, i.e. no ingress at all.
2. **`updateStrategy: Recreate` is required.** With `hostNetwork` on a single
   node the default rolling-update surge pod can never schedule
   (`didn't have free ports for the requested pod ports`). The old pod keeps
   serving the *old* config while helm reports success and `kubectl get deploy`
   shows the new args, so every Traefik change after the first silently no-ops.
3. **The key is `updateStrategy`, not `deployment.strategy`.** The chart's
   `templates/deployment.yaml` reads `.Values.updateStrategy`; the other
   spelling is accepted and ignored.

## Why these k3s flags

- `--disable=servicelb` is **required**, not an optimisation: Traefik uses
  `hostNetwork`, and the svclb DaemonSet would contend for ports 80 and 443.
- `local-storage` is deliberately **kept** — it provides the `local-path`
  StorageClass that `values-oci.yaml` and Traefik's ACME volume both need.
- `--disable=metrics-server` because HPA is off on a single node.
- `--node-external-ip` is deliberately **not** set. OCI's public IP is 1:1 NAT,
  the OS only ever sees the private address, and k3s documents that setting it
  breaks `externalTrafficPolicy: Local`.

`hostNetwork: true` with `service.enabled: false` is the decision that
preserves the client IP: Traefik binds the host network namespace directly, so
the TCP remote address *is* the client address. Every alternative (ServiceLB,
`externalTrafficPolicy: Local`, `hostPort`) either NATs or loses it.

## TLS

Traefik-native ACME via `certResolvers`, not cert-manager: cert-manager would
add three Deployments plus CRDs to a 12 GB box, and the chart's existing
cert-manager wiring is Gateway-API/Envoy-shaped and does not apply to an
Ingress. Because the certificate never lands in a Kubernetes Secret,
`ingress.tls.enabled` stays `false` and `exposure.scheme: https` is set
explicitly.

For a **first bring-up**, a Cloudflare Origin CA certificate (free, 15-year)
with Cloudflare in Full (strict) mode is simpler than debugging ACME through
the proxy. Switch to `certResolvers` afterwards if you want origin certificates
that do not depend on Cloudflare.

## State backend

`backend.tf` targets OCI Object Storage through its S3-compatible endpoint.
`skip_s3_checksum = true` is load-bearing: Terraform >= 1.6 uses AWS SDK v2,
which sends `x-amz-checksum-*` headers that OCI's S3 shim rejects.

The credentials are **Customer Secret Keys** (an access-key/secret pair
generated once in the console), not the API signing key the provider uses.

Worth stating plainly, because it partly defeats the purpose: this makes the
free path depend on the OCI tenancy for its own state. Back it up —
`terraform state pull > backup-$(date +%F).tfstate` — and note that deleting
`backend.tf` falls back to local state with no other change.

## Idle reclamation

OCI reclaims Always Free instances idle for over 7 days (95th-percentile CPU
**and** network **and** memory all below 20%), which is a real risk for a
low-traffic demo.

- Primary mitigation: upgrade the tenancy to Pay-As-You-Go. The policy applies
  only to Always-Free-only tenancies, and Always Free resources remain $0.
- Secondary: this root plus cloud-init makes a rebuild roughly 15 minutes with
  no manual steps, provided state and DNS are backed up. After a rebuild the
  reserved IP is new, so update the Cloudflare A record.

Do not paper over it with a `stress-ng` keepalive cron.

## Why apply is not automated in CI

Automating `terraform apply` here would mean storing a tenancy-wide API signing
key as a repository secret — a large blast radius for a path one operator runs
by hand a handful of times a year. CI runs only the credential-free
`terraform fmt`, `validate` and `test`.

## What CI does run

`.github/workflows/ci.yml` has a `terraform-validate` job whose result
`ci-gate` counts, so it is merge-blocking. It holds no credentials and can
therefore run on fork pull requests:

| Step | Covers |
| --- | --- |
| `terraform fmt -check -recursive` from `infra/` | both roots, including this nested one |
| `init -backend=false`, `validate`, `test` in `infra/` | the Azure root, which no workflow ran before |
| `init -backend=false`, `validate`, `test` here | 48 assertions, all on `mock_provider` |
| render `local.cloud_init`, then `bash -n` + `shellcheck` | the bootstrap script the instance actually boots |

The last step is worth explaining. It renders through `terraform console`
rather than re-invoking `templatefile()` in the workflow, so the script that
gets linted is the output of this root's own `local.cloud_init` and cannot
drift from what cloud-init writes. `console` refuses to run against an
uninitialised backend, so the step drops a `backend_override.tf` selecting the
local backend for that step alone — `.gitignore` covers `infra/oci/*_override.tf`
so a local reproduction cannot commit one. The expression wraps `yamldecode`,
which means the step also fails if the rendered `user_data` stops being
parseable YAML.

`terraform.tfvars.example` doubles as the fixture for that render, so CI also
proves the documented example still satisfies every variable validation.

`scripts/terraform-gate.test.sh` (run by `make test-shell`) locks the wiring:
that `ci-gate` counts the result, that the job never grows a `secrets.` or
`environment:` reference, that both roots stay covered, and that
`traefik-config.yaml` keeps the three properties the aarch64 dry-run VM proved
it needs.
