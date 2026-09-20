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
2. Terraform >= 1.10 (`use_lockfile` on the S3 backend; `versions.tf` pins the
   same floor, and the cross-variable validation below needs 1.9 of it).
3. An SSH keypair.
4. Optional but recommended: **upgrade the tenancy to Pay-As-You-Go.** Always
   Free resources stay $0, but the idle-reclamation policy (see below) applies
   only to Always-Free-*only* tenancies.

## Usage

```sh
cd infra/oci
cp terraform.tfvars.example terraform.tfvars   # then edit
make tf-oci-init-local                          # validation/testing only, no remote state
# ...or, for remote state, pass the same OWNER_ALIAS used for every later target:
make tf-oci-init  OWNER_ALIAS=jdoe
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
cannot be flushed by anyone who gets root on the box -- for traffic that crosses
that VNIC. See "What the NSG does not cover" below. The subnet security list
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

### Why there is no IPv6

This root is IPv4-only, and that is a decision rather than an omission.
Cloudflare reaches an origin over IPv4 whenever an `A` record exists, so the
box never needs an IPv6 address; giving it one would add a second address
family to reason about in the NSG for no reachability gain.

An earlier revision carried an `enable_ipv6` variable that set
`is_ipv6enabled` on the VCN, added a `::/0` route rule and admitted
Cloudflare's IPv6 ranges — but never assigned the subnet an `ipv6cidr_block`
and never gave the VNIC an address, and left both egress rules IPv4-only.
Turning it on produced ingress rules that could not match anything, which is
strictly worse than not offering the option. It has been removed.

The world-CIDR guards on `ssh_allowed_cidrs` and `k8s_api_allowed_cidrs`
measure how much address space a list actually covers rather than matching
`0.0.0.0/0` as a string. A string match was the whole guard until review
pointed out that `["0.0.0.0/1", "128.0.0.0/1"]` is a pair of ordinary-looking
CIDRs covering every IPv4 host, and that any decomposition works — four `/2`s,
256 `/8`s — so the test has to be coverage, not spelling. Both families are
measured even though the deployment is IPv4-only: the NSG builds its rules with
`source_type = "CIDR_BLOCK"`, which accepts either family without complaint, so
an IPv4-only guard would let `::/0` through to a live rule. `cloudflare_ipv4_ranges`
is measured the same way, because a world-open override there leaves
`restrict_ingress_to_cloudflare` reading as enabled while the origin is open.

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

#### What the NSG does not cover

An NSG filters traffic crossing the instance's VNIC. Traffic from a pod to a
host-bound port never crosses it — it is delivered inside the host's own
network stack — so with `INPUT` flushed, **any workload on this cluster can
reach every port the host listens on**, including 22 and the k3s API on 6443.

The table above is the proof, not a caution: `restrict_ingress_to_cloudflare`
admits port 80 only from Cloudflare's ranges, and the pod sourcing that request
holds a `10.42.0.0/16` address. It got a 301. The NSG therefore never evaluated
that traffic, and nothing about ports 22 or 6443 makes them different.

State the boundary accordingly. "6443 is closed" means *closed to the
internet*, and the SSH tunnel is the supported path **for operators**. It is
not a control against a compromised container, which reaches the API's TCP port
directly and is then held off only by Kubernetes authentication and the
NetworkPolicy the chart ships. If that distinction matters for what you deploy
here, take the two-layer option below rather than assuming the NSG covers it.

#### The one port taken back at the host, and why only one

Of the two administration ports the flush leaves exposed to the pod network,
cloud-init closes 22 and deliberately leaves 6443 open. The difference was
measured on a real cluster, not argued:

| host rule | pod → in-cluster Kubernetes API |
| --- | --- |
| none (baseline) | `401` — reachable |
| `-s 10.42.0.0/16 --dport 22 -j DROP` | `401` — unaffected |
| `-s 10.42.0.0/16 --dport 6443 -j DROP` | **curl timeout, exit 28** |

Nothing in the cluster needs to open a TCP connection to the node's `sshd`, so
the first rule costs nothing and cloud-init inserts it.

The third breaks the cluster because `kubernetes.default.svc` is a ClusterIP
that DNATs to the node's own apiserver port, and kube-proxy deliberately does
*not* masquerade pod-CIDR sources for it:

```text
-A KUBE-SERVICES -d 10.43.0.1/32 -p tcp --dport 443 -j KUBE-SVC-NPX46M4PTMTKRN6Y
-A KUBE-SVC-NPX46M4PTMTKRN6Y ! -s 10.42.0.0/16 ... -j KUBE-MARK-MASQ
-A KUBE-SEP-... -j DNAT --to-destination <node ip>:6443
```

The packet therefore arrives at `INPUT` carrying the pod's own source address
and destination port 6443 — indistinguishable from a pod dialling the node
directly. Dropping it takes out every in-cluster API client, which is most of
the control plane. For a hostile workload the control that applies there is
RBAC on its service account.

The rule goes in at the head of `INPUT`, but k3s and kube-router insert their
own jumps there on start and restart, so its position is best-effort. It is
defence in depth, not the boundary.

If you want two enforcement layers instead, replace the flush in
`cloud-init.yaml.tftpl` with explicit accepts inserted *before* the REJECT:

```sh
iptables -I INPUT -s 10.42.0.0/16 -j ACCEPT     # pods
iptables -I INPUT -s 10.43.0.0/16 -j ACCEPT     # services
iptables -I INPUT -p tcp --dport 80  -j ACCEPT
iptables -I INPUT -p tcp --dport 443 -j ACCEPT
netfilter-persistent save
```

Keep the pod-CIDR accepts above ahead of any narrower drop you add: the
measurement in the previous section applies to this layout too, and a rule that
denies the pod range port 6443 breaks the cluster whichever chain it lands in.

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

Three of the bugs in this config were found by running the shape on a real
aarch64 VM before any cloud instance existed. They are the original three, not
the complete set: `certResolvers` and the privileged-port binding came later,
out of the `oci-shape-e2e` job, and are documented further down. Each is silent
in a different way, so each is locked by an assertion in
`tests/traefik_config.tftest.hcl` *and* by the CI job:

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

## The cloud-config is gzipped

`compute.tf` sets `user_data = base64gzip(local.cloud_init)`, not
`base64encode`. OCI caps `metadata` plus `extendedMetadata` at 32,000 bytes and
enforces it at launch; the rendered cloud-config is 27,136 bytes — mostly the
12,632-byte Traefik manifest embedded in it — which plain base64 inflates to
36,184. Gzipped it is 13,356, and 13,452 with the SSH key beside it.

That refusal would have arrived *after* `terraform apply` had created the VCN,
the subnet, the NSG and the reserved IP, quoting a byte count rather than the
file that grew, so a `precondition` on the instance moves it to plan time. The
check is on the sum, because `ssh_authorized_keys` shares the same budget.

Two things make the compression safe rather than clever:

- cloud-init decompresses user data **before** it decides what the payload is.
  Verified against the cloud-init that ships in the Ubuntu 24.04 image this box
  boots, not against its documentation: `DataSourceOracle` base64-decodes the
  metadata value and hands the raw bytes to `convert_string`, which runs
  `util.decomp_gzip(bdata, decode=False)` ahead of the MIME/cloud-config test.
  This exact payload round-tripped back to the same 27,136 bytes beginning
  `#cloud-config`.
- `base64gzip` writes a zero mtime into the gzip header, so the value is stable
  across runs. An unstable one would show a `user_data` diff on every plan and
  force a replacement of the instance.

The cost is that the Console no longer shows a readable initialization script.
Read the plaintext locally instead:

```sh
cd infra/oci
echo 'local.cloud_init' | terraform console -var-file=terraform.tfvars
```

`console` evaluates against a backend, so it needs a real `tf-oci-init`;
`tf-oci-init-local` uses `-backend=false` and console then stops with
"Backend initialization required". If you only want to read the script, use the
same `backend_override.tf` selecting the local backend that the CI render step
drops in — `.gitignore` covers `infra/oci/*_override.tf`, so it cannot be
committed by accident.

## Why apt runs from the bootstrap script

There is no `package_update` / `package_upgrade` / `packages:` block in
`cloud-init.yaml.tftpl`. cloud-init runs its `package-update-upgrade-install`
module **before** `runcmd`, and at that point the instance has no route out:
`compute.tf` launches it with `assign_public_ip = false` and attaches the
reserved public IP immediately afterwards, and there is no NAT gateway.

The failure mode if apt ran there is silent and total. `iptables-persistent`
and `unattended-upgrades` would be missing, `runcmd`'s first item would fail,
and `/opt/bootstrap-k3s.sh` would never run — a box that boots, answers SSH,
and has no k3s on it.

So the apt phase lives in the bootstrap script, immediately after the
connectivity wait that already had to exist for the k3s installer download.
Two details that cloud-init used to handle and the script now handles itself:

- `DEBIAN_FRONTEND=noninteractive`, because `iptables-persistent` asks through
  debconf whether to save the current rules and an unanswered prompt hangs the
  boot;
- retries — `Acquire::Retries=3`, an outer five-attempt loop, and
  `DPkg::Lock::Timeout=300` to absorb the `unattended-upgrades` run Ubuntu
  starts on first boot.

The firewall flush runs *after* the apt phase, because `netfilter-persistent`
comes from `iptables-persistent`. That ordering is safe: the measured table
above shows egress works with the OCI default chain in place.

### The installer is pinned and checksum-verified

cloud-init does **not** pipe `https://get.k3s.io` into a root shell. That
endpoint serves whatever is on the k3s master branch at the moment of the
request, so pinning `k3s_version` pinned the *binary* and said nothing about
the ~36 KB of shell that selects and installs it — two different files, 38693
vs 36501 bytes when measured.

Instead the bootstrap script downloads the `install.sh` tagged for exactly
`k3s_version` (the `+` percent-encoded, which `raw.githubusercontent.com`
requires), checks it against `k3s_install_script_sha256`, and refuses to
execute it on a mismatch — printing both digests.

**Bumping k3s means bumping both variables in the same commit.** That friction
is deliberate: forgetting fails the bootstrap loudly at boot rather than
installing an unreviewed script. Recompute with:

```sh
curl -sfL "https://raw.githubusercontent.com/k3s-io/k3s/$(
  printf %s "$K3S_VERSION" | sed 's/+/%2B/')/install.sh" | sha256sum
```

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

Traefik-native ACME via `certificatesResolvers`, not cert-manager: cert-manager would
add three Deployments plus CRDs to a 12 GB box, and the chart's existing
cert-manager wiring is Gateway-API/Envoy-shaped and does not apply to an
Ingress. Because the certificate never lands in a Kubernetes Secret,
`ingress.tls.enabled` stays `false` and `exposure.scheme: https` is set
explicitly.

For a **first bring-up**, a Cloudflare Origin CA certificate (free, 15-year)
with Cloudflare in Full (strict) mode is simpler than debugging ACME through
the proxy. Switch to `certificatesResolvers` afterwards if you want origin
certificates that do not depend on Cloudflare.

The key name matters. `certResolvers` was removed in Traefik chart v33.0.0 and
its replacement, `certificatesResolvers`, maps straight onto Traefik's static
configuration — so it carries an extra `acme:` level that the old key did not.
Getting the key wrong fails the install outright; getting the nesting wrong is
silent and the resolver simply never issues. Both are locked in
`tests/traefik_config.tftest.hcl` and exercised for real by `oci-shape-e2e`.

### Why Traefik runs as root

`hostNetwork: true` with `service.enabled: false` means Traefik binds :80 and
:443 itself. The chart's default `podSecurityContext` runs it as uid 65532, and
`NET_BIND_SERVICE` does not rescue that: on execve a non-root process gets an
empty effective capability set unless the binary carries file capabilities, and
the Traefik image does not set them. The container crash-loops on
`listen tcp :80: bind: permission denied`.

Docker hides this — it sets `net.ipv4.ip_unprivileged_port_start=0` inside
containers, so the same image binds :80 fine under `docker run --user 65532`.
Kubernetes sets no such sysctl, which is why only `oci-shape-e2e` caught it.

The trade is uid 0 with `ALL` capabilities dropped except `NET_BIND_SERVICE`,
`allowPrivilegeEscalation: false` and `readOnlyRootFilesystem: true`. The
alternative — `net.ipv4.ip_unprivileged_port_start=0` as a node sysctl — was
rejected: it lets every unprivileged process on the box bind low ports, it is a
node-level setting that would have to be duplicated outside the shared config,
and it is the wider grant of the two.

## State backend

`backend.tf` targets OCI Object Storage through its S3-compatible endpoint.
`skip_s3_checksum = true` is load-bearing: it drops the SHA256 checksum
Terraform asks the AWS SDK to compute — `x-amz-checksum-sha256` plus
`x-amz-sdk-checksum-algorithm` — which OCI's S3 shim rejects.

It does not leave the request checksum-free. Measured against Terraform 1.16.3
with a logging stub endpoint, `PutObject` still carries the SDK's own default
full-object `x-amz-checksum-crc32` with the flag set. Removing that one is the
SDK's business rather than the backend block's, so the `tf-oci-*` targets
export `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`, which was verified on
the same stub to drop the header entirely. A bare `terraform init` run by hand
should export it too.

### State locking

`use_lockfile = true` is on, which is why `versions.tf` floors at Terraform
1.10. Terraform writes a `<key>.tflock` object with `If-None-Match: *` and
deletes it on release — verified as the actual wire behaviour on 1.16.3 against
the same stub endpoint (`PUT …tflock` with the precondition, `GET` on release,
`DELETE`). Without it, two operators sharing one `OCI_STATE_KEY` can apply
concurrently and the second write silently discards the first; bucket
versioning recovers the object afterwards but does not prevent the race.

**Confirm the precondition is honoured on the real bucket before relying on
it.** The lock is only as good as OCI's handling of `If-None-Match`, and that
cannot be tested without the tenancy. Run the same conditional create twice:

```bash
aws --endpoint-url "https://<namespace>.compat.objectstorage.<region>.oraclecloud.com" \
  s3api put-object --bucket "<bucket>" --key locking-probe --if-none-match '*' --body /dev/null
# repeat the identical command; it must fail with PreconditionFailed (412)
aws --endpoint-url "https://<namespace>.compat.objectstorage.<region>.oraclecloud.com" \
  s3api delete-object --bucket "<bucket>" --key locking-probe
```

If the second call succeeds instead of returning 412, the shim overwrites
rather than refusing, two simultaneous applies would each believe they hold the
lock, and the mitigation falls back to the alias-derived key plus not sharing
one. Either way the ordinary single-operator case is unshared.

The credentials are **Customer Secret Keys** (an access-key/secret pair
generated once in the console), not the API signing key the provider uses.
Terraform reads them from the environment as `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`; the Makefile exports both out of `.oci-backend.env`,
but a bare `terraform init` run by hand has to export them itself — and has to
pass `-backend-config=key=<alias>-free-sre-simulator.tfstate` as well.
`backend.tf` carries **no default key**, so a manual init that omits it stops
with `The attribute "key" is required by the backend` rather than quietly
picking a shared object. Prefer `make tf-oci-init`, which derives the key.

### `.oci-backend.env` is data, not makefile text

The Makefile reads the file as `KEY=VALUE` lines and binds only these seven
keys: `OCI_STATE_BUCKET`, `OCI_STATE_NAMESPACE`, `OCI_STATE_REGION`,
`OCI_STATE_COMPARTMENT_OCID`, `OCI_STATE_ENDPOINT`, `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`. Blank lines, `#` comments, a trailing `# note`, an
`export` prefix, spaces around the equals and CRLF line endings are all
accepted; the value itself may not contain whitespace.

Anything else — a `KEY := value` makefile assignment, a bare `$(shell ...)`,
a target — is refused **by line number** rather than ignored, because under
the previous `-include` such a line did something, and half-reading a file
that used to work is worse than refusing it. A key repeated in the file is
refused too: make would otherwise take the last one without saying so. A
command-line `VAR=value` still wins over the file, and the file still wins
over the environment.

This matters beyond tidiness: `-include` *executes* the file as makefile
text, at parse time, with make's privileges. A state file an operator edits
by hand is the one channel into these targets with no other validation on it.

**`tf-oci-init` and `tf-oci-plan` both require `OWNER_ALIAS`, and refuse
without it.** The object key is derived from it —
`<alias>-free-sre-simulator.tfstate` — and `init` is the one target that writes
that key into `.terraform/`, which every later target then reads back. There is
deliberately **no shared default key**: an earlier revision fell back to
`sre-simulator-free.tfstate`, so two operators who each omitted the alias landed
on the same state object and the second `apply` proposed destroying the first
one's box. Documenting that hazard was not enough, because the omission is
silent at the moment it matters.

`tf-oci-plan`, `tf-oci-apply` and `tf-oci-destroy` additionally refuse when
the alias on the command line disagrees with the key `init` recorded in
`.terraform/`. Terraform reads the recorded key, not the flag, so without that
check `tf-oci-init OWNER_ALIAS=jdoe` followed by `tf-oci-plan
OWNER_ALIAS=alice` would plan alice's resources against jdoe's state — and the
apply of a plan computed that way reads as a destroy.

One escape hatch remains, and it is explicit: `make tf-oci-init-local`
(`terraform init -backend=false`) for validation and `terraform test`, which
need no state at all.

`OCI_STATE_KEY` is **not** a second one, despite looking like it. It is accepted
only as a restatement of the alias-derived key: a value that disagrees with
`OWNER_ALIAS` is refused at parse time, and a value that agrees is exactly what
the Makefile would have derived anyway. Sharing one state object on purpose is
therefore done by sharing the `OWNER_ALIAS` it is derived from — which is the
point, because the key and the resource names the plan carries then cannot say
different things.

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
| `init -backend=false`, `validate`, `test` here | 123 test cases, all on `mock_provider` |
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
