mock_provider "oci" {
  mock_data "oci_identity_availability_domains" {
    defaults = {
      availability_domains = [
        { name = "AAAA:EU-FRANKFURT-1-AD-1" },
        { name = "AAAA:EU-FRANKFURT-1-AD-2" },
        { name = "AAAA:EU-FRANKFURT-1-AD-3" },
      ]
    }
  }

  mock_data "oci_core_images" {
    defaults = {
      images = [
        { id = "ocid1.image.oc1.eu-frankfurt-1.aaaaaaaaubuntu2404arm" },
      ]
    }
  }

  mock_data "oci_core_vnic_attachments" {
    defaults = {
      vnic_attachments = [
        { vnic_id = "ocid1.vnic.oc1.eu-frankfurt-1.aaaaaaaavnic" },
      ]
    }
  }

  mock_data "oci_core_private_ips" {
    defaults = {
      private_ips = [
        { id = "ocid1.privateip.oc1.eu-frankfurt-1.aaaaaaaaprivateip" },
      ]
    }
  }
}

mock_provider "http" {}

# Cloudflare ranges are supplied explicitly so that no test performs a network
# fetch. local.fetch_cloudflare_ipv4 then evaluates false and the data source
# is never read.
variables {
  owner_alias            = "jdoe"
  compartment_ocid       = "ocid1.compartment.oc1..aaaaaaaacompartment"
  ssh_public_key         = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTestsAAAAAAAAAAAAAAAAA test@example.com"
  acme_email             = "ops@example.com"
  cloudflare_ipv4_ranges = ["198.51.100.0/24", "203.0.113.0/24"]
}
# ---------------------------------------------------------------------------
# Regression lock on traefik-config.yaml.
#
# Six concerns are locked here. Four were bugs found by running this exact
# shape on real k3s -- three on an aarch64 VM before any cloud instance
# existed, the fourth on the oci-shape-e2e CI runner -- and two more came out
# of review: the image pin, and the ACME address's YAML scalar. Each is silent
# in a different way, which is why each gets an assertion here as well as
# coverage in that job. These run in milliseconds and need no cluster.
# ---------------------------------------------------------------------------

run "redirect_uses_v34_syntax" {
  command = plan

  assert {
    condition     = !can(regex("(?m)^[[:space:]]*redirectTo:", local.traefik_config_rendered))
    error_message = "redirectTo was removed in Traefik chart v34 and is a hard install failure. Because cloud-init writes this manifest before k3s first starts, the failure leaves Traefik at chart defaults with servicelb already disabled -- that is, no ingress at all."
  }

  assert {
    condition     = strcontains(local.traefik_config_rendered, "redirections:")
    error_message = "The HTTP entrypoint should redirect to websecure using the v34 redirections syntax."
  }
}

run "update_strategy_is_recreate_and_spelled_correctly" {
  command = plan

  assert {
    condition     = strcontains(local.traefik_config_rendered, "updateStrategy:")
    error_message = "Without updateStrategy: Recreate the surge pod cannot schedule on a single hostNetwork node, so every Traefik change after the first silently no-ops while helm reports success."
  }

  assert {
    condition     = strcontains(local.traefik_config_rendered, "type: Recreate")
    error_message = "updateStrategy.type must be Recreate."
  }

  assert {
    condition     = !can(regex("(?m)^[[:space:]]*strategy:", local.traefik_config_rendered))
    error_message = "The chart reads .Values.updateStrategy; deployment.strategy is silently ignored."
  }
}

run "host_network_shape_is_intact" {
  command = plan

  assert {
    condition     = strcontains(local.traefik_config_rendered, "hostNetwork: true")
    error_message = "hostNetwork: true is what preserves the client IP; without it the TCP remote address is not the client address."
  }

  assert {
    condition     = strcontains(local.traefik_config_rendered, "enabled: false")
    error_message = "The Traefik Service must be disabled; with hostNetwork it is dead weight that reintroduces NAT."
  }
}

run "cert_resolver_uses_the_v33_key_and_nesting" {
  command = plan

  # Found by the oci-shape-e2e job, not by reading: certResolvers was removed
  # in chart v33.0.0 with the same `fail` treatment as redirectTo, so it is
  # the same class of bug -- cloud-init writes the manifest before k3s first
  # starts, and the box comes up with no ingress at all.
  assert {
    condition     = !can(regex("(?m)^[[:space:]]*certResolvers:", local.traefik_config_rendered))
    error_message = "certResolvers was removed in Traefik chart v33.0.0 and is a hard install failure; use certificatesResolvers."
  }

  # The replacement is not a rename. certificatesResolvers maps straight onto
  # Traefik's static configuration, which carries an extra acme: level, and
  # getting that wrong is silent: the resolver simply never issues.
  assert {
    condition     = yamldecode(local.traefik_config_rendered).spec != null
    error_message = "The rendered manifest must parse as YAML."
  }

  assert {
    condition     = yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).certificatesResolvers.letsencrypt.acme.httpChallenge.entryPoint == "web"
    error_message = "certificatesResolvers requires an acme: level; without it the HTTP-01 challenge is never configured."
  }

  assert {
    condition     = yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).certificatesResolvers.letsencrypt.acme.storage == "/data/acme.json"
    error_message = "ACME storage must sit on the persistent volume or every Traefik restart re-issues and hits Let's Encrypt rate limits."
  }
}

run "traefik_can_actually_bind_the_privileged_ports" {
  command = plan

  # Bug 5, and the subtlest of the five: with hostNetwork and no Service,
  # Traefik binds :80 itself, but the chart's podSecurityContext runs it as
  # uid 65532. NET_BIND_SERVICE then sits in the permitted set and never
  # becomes effective, because the image carries no file capabilities -- so
  # the config reads as correct and the container crash-loops on
  # "listen tcp :80: bind: permission denied".
  assert {
    condition     = yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).podSecurityContext.runAsUser == 0
    error_message = "Traefik must run as uid 0 to bind :80 in the host network namespace; the chart default of 65532 cannot."
  }

  assert {
    condition     = yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).podSecurityContext.runAsNonRoot == false
    error_message = "runAsNonRoot must be false explicitly, or the kubelet refuses to start a container whose uid is 0."
  }

  # Root is only tolerable because everything else is taken away. If these
  # three drift, the trade this file makes stops being a trade.
  assert {
    condition     = yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).securityContext.capabilities.add == ["NET_BIND_SERVICE"]
    error_message = "NET_BIND_SERVICE must be the only capability added back."
  }

  # The add list is only half the claim. Without drop: [ALL] the container
  # keeps the runtime's whole default set -- CHOWN, SETUID, DAC_OVERRIDE,
  # NET_RAW -- and "NET_BIND_SERVICE is the only capability added back" stays
  # true while the posture it is shorthand for is gone. That matters here more
  # than anywhere else in this file: this pod runs as uid 0 in the host
  # network namespace, so the dropped set is the entire boundary.
  assert {
    condition     = try(yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).securityContext.capabilities.drop, []) == ["ALL"]
    error_message = "securityContext.capabilities.drop must stay [ALL]; root in the host netns with the default capability set is not the trade this file makes."
  }

  assert {
    condition     = yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).securityContext.allowPrivilegeEscalation == false
    error_message = "allowPrivilegeEscalation must stay false."
  }

  assert {
    condition     = yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).securityContext.readOnlyRootFilesystem == true
    error_message = "readOnlyRootFilesystem must stay true."
  }
}

run "the_traefik_image_is_pinned_away_from_the_chart_default" {
  command = plan

  # The chart default that k3s v1.33.4+k3s1 ships is
  # rancher/mirrored-library-traefik:3.3.6, which carried 4 critical and 68
  # high CVEs when scanned on 2026-09-18 -- including an OpenSSL X.509 heap
  # overflow and a Go crypto/tls session-resumption validation bug, both in
  # the TLS path this pod terminates. That is not acceptable for an
  # internet-facing ingress, and it is less acceptable still now that the pod
  # runs as uid 0 (see the run above).
  assert {
    condition     = yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).image.tag != ""
    error_message = "The Traefik image tag must be pinned; falling back to the chart appVersion reintroduces 3.3.6."
  }

  assert {
    condition     = !strcontains(yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).image.tag, "3.3.")
    error_message = "Traefik 3.3.x carries 4 critical CVEs. Bump the pin rather than reverting it."
  }

  # A floating tag would make the box and the CI gate run different binaries,
  # which is the same class of mistake as forking this file. A full x.y.z tag
  # is necessary and not sufficient: a tag is a mutable pointer, so
  # `docker.io/library/traefik:v3.7.13` can be re-pushed at any time and this
  # pod is a root-owned host-network TLS terminator. The reference therefore
  # carries the digest as well, in the `x.y.z@sha256:<64 hex>` form, which the
  # k3s-packaged chart accepts because its `traefik.image-name` helper is a
  # plain `printf "%s:%s" repository tag` -- verified by rendering
  # traefik-34.2.1+up34.2.0 with this exact value. The digest cannot live under
  # an `image.digest` key instead: the chart's values.schema.json sets
  # `additionalProperties: false` on `image`.
  #
  # Two assertions rather than one so the failure names which half regressed:
  # dropping the digest and floating the tag are different mistakes.
  assert {
    condition     = can(regex("^v?[0-9]+\\.[0-9]+\\.[0-9]+(@|$)", yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).image.tag))
    error_message = "The image tag must start with a full x.y.z version, not a floating major or minor."
  }

  assert {
    condition     = can(regex("^v?[0-9]+\\.[0-9]+\\.[0-9]+@sha256:[0-9a-f]{64}$", yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).image.tag))
    error_message = "The image tag must also pin the digest as x.y.z@sha256:<64 hex>. A bare tag is mutable, and this pod runs as uid 0 on the host network terminating TLS."
  }

  # Every assertion above reads the tag, so reverting to
  # rancher/mirrored-library-traefik:v3.7.13 -- the obvious "keep the rancher
  # mirror, take the bump" edit -- would leave all three green. The scan that
  # justified this pin puts the mirror at 2 HIGH against upstream's 0, so the
  # repository is half of what was decided and has to be asserted as such.
  assert {
    condition     = yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).image.repository == "docker.io/library/traefik"
    error_message = "The image repository must stay docker.io/library/traefik. The rancher mirror still carries an openssl QUIC DoS at the same tag; bump the tag, do not swap the repository."
  }

  # The Traefik image is not the only thing this manifest runs as uid 0 in the
  # host network namespace. The volume-permissions initContainer executes on
  # every rollout, before Traefik reads acme.json, and every assertion above
  # is satisfied while it floats on a mutable `busybox:1.37`. Asserted
  # structurally over all initContainers, so adding a second helper cannot
  # reintroduce a floating tag beside a pinned one.
  assert {
    condition = alltrue([
      for c in yamldecode(yamldecode(local.traefik_config_rendered).spec.valuesContent).deployment.initContainers :
      can(regex("@sha256:[0-9a-f]{64}$", c.image))
    ])
    error_message = "Every initContainer image must be digest-pinned. These run as uid 0 in the host network namespace on every rollout, so a registry retag changes executed code with no diff here."
  }
}

run "acme_email_is_substituted" {
  command = plan

  # Read back through both parsers rather than matched as a substring. The
  # placeholder sits on an unquoted scalar inside `valuesContent: |-`, so the
  # outer HelmChartConfig parses no matter what the address contains and the
  # only thing that can break is the inner document -- which is precisely the
  # document a substring assertion never looks at.
  assert {
    condition = yamldecode(
      yamldecode(local.traefik_config_rendered).spec.valuesContent
    ).certificatesResolvers.letsencrypt.acme.email == var.acme_email
    error_message = "The rendered values document must parse, and ACME_EMAIL_PLACEHOLDER must be replaced with var.acme_email."
  }

  # The quoting is the second barrier, independent of acme_email's validation.
  # An address beginning `>`, `*` or `{` would otherwise read as a block
  # scalar, an alias or a flow mapping in the values document k3s's
  # helm-controller parses, and a values document that fails to parse leaves
  # Traefik at chart defaults with servicelb disabled -- no ingress at all.
  assert {
    condition     = strcontains(local.traefik_config_rendered, "email: \"${var.acme_email}\"")
    error_message = "The ACME address must be emitted as a quoted YAML scalar."
  }

  assert {
    condition     = !strcontains(local.traefik_config_rendered, "ACME_EMAIL_PLACEHOLDER")
    error_message = "No placeholder may survive into the rendered manifest."
  }
}

# ---------------------------------------------------------------------------
# cloud-init
# ---------------------------------------------------------------------------

run "the_instance_metadata_fits_inside_the_launch_api_limit" {
  command = plan

  # OCI caps metadata + extendedMetadata at 32,000 bytes and enforces it at
  # launch -- after apply has already built the VCN, the subnet, the NSG and
  # the reserved IP. Plain base64 of this cloud-config is 36,184 bytes, so the
  # launch would have been refused every time. Nothing else here can catch it:
  # every run is mock_provider-backed, so no test weighs what the real API
  # would have measured.
  assert {
    condition     = local.metadata_bytes <= 32000
    error_message = "Instance metadata is ${local.metadata_bytes} bytes; OCI refuses a launch over 32,000."
  }

  # The size on its own would pass again if someone dropped the compression
  # and shrank the manifest instead, and that would be fine -- but it would
  # also pass if base64gzip were replaced by base64encode on a smaller file
  # and then the file grew back. The gzip header is what makes the property
  # structural: "H4sI" is the base64 of 1f 8b 08 00, the gzip magic plus the
  # deflate method and empty flags.
  #
  # Depended on by nothing less than the box booting: cloud-init's
  # DataSourceOracle base64-decodes this value and convert_string runs
  # decomp_gzip on the bytes before deciding whether it is cloud-config.
  assert {
    condition     = startswith(local.user_data, "H4sI")
    error_message = "user_data must be gzipped before base64 encoding, or it does not fit."
  }

  # The instance is what ships, and an intermediate local proves nothing about
  # it -- the same lesson as the gate that asserted a Deployment's template
  # while the pod ran another image.
  assert {
    condition     = oci_core_instance.k3s.metadata.user_data == local.user_data
    error_message = "The instance must launch with the compressed payload, not with some other rendering."
  }
}

run "cloud_init_disables_servicelb_and_keeps_local_storage" {
  command = plan

  assert {
    condition     = strcontains(local.cloud_init, "--disable=servicelb")
    error_message = "servicelb must be disabled or its DaemonSet contends with hostNetwork Traefik for ports 80 and 443."
  }

  assert {
    condition     = !can(regex("(?m)^[[:space:]]*--disable=local-storage", local.cloud_init))
    error_message = "local-storage provides the local-path StorageClass that values-oci.yaml and Traefik's ACME volume both need."
  }

  assert {
    condition     = !can(regex("(?m)^[[:space:]]*--node-external-ip", local.cloud_init))
    error_message = "OCI's public IP is 1:1 NAT and the OS never sees it; setting --node-external-ip breaks externalTrafficPolicy: Local."
  }
}

run "cloud_init_writes_the_manifest_under_a_name_k3s_does_not_own" {
  command = plan

  assert {
    condition     = strcontains(local.cloud_init, "/var/lib/rancher/k3s/server/manifests/traefik-config.yaml")
    error_message = "The HelmChartConfig must land in the k3s auto-deploy manifests directory."
  }

  assert {
    condition     = !strcontains(local.cloud_init, "/var/lib/rancher/k3s/server/manifests/traefik.yaml")
    error_message = "k3s owns manifests/traefik.yaml and rewrites it on every server restart."
  }
}

run "apt_runs_after_the_connectivity_wait_not_before_runcmd" {
  command = plan

  # cloud-init orders package-update-upgrade-install BEFORE runcmd, and the
  # instance has no route out until Terraform attaches the reserved public IP.
  # apt in the cloud-config body would therefore run with no egress, and its
  # failure is silent and total: iptables-persistent and unattended-upgrades
  # go missing, runcmd's first item fails, and the bootstrap script never runs.
  assert {
    condition     = !can(regex("(?m)^package_(update|upgrade):", local.cloud_init))
    error_message = "package_update/package_upgrade run before runcmd, when the box still has no route out."
  }

  assert {
    condition     = !can(regex("(?m)^packages:", local.cloud_init))
    error_message = "A top-level packages: block runs before runcmd, when the box still has no route out."
  }

  # Ordering inside the script is the whole point of the move, so assert the
  # position rather than mere presence.
  assert {
    condition     = can(regex("(?s)waiting for outbound connectivity.*updating the package index", local.cloud_init))
    error_message = "The apt phase must sit after the connectivity wait, not before it."
  }

  # debconf asks iptables-persistent whether to save the current rules. Under
  # runcmd nothing sets this for us, and an unanswered prompt hangs the boot.
  assert {
    condition     = strcontains(local.cloud_init, "export DEBIAN_FRONTEND=noninteractive")
    error_message = "apt from runcmd must set DEBIAN_FRONTEND=noninteractive or iptables-persistent's debconf prompt hangs the boot."
  }

  # netfilter-persistent ships with iptables-persistent, so the flush cannot
  # run before the install.
  assert {
    condition     = can(regex("(?s)upgrading and installing packages.*flushing the host INPUT chain", local.cloud_init))
    error_message = "netfilter-persistent comes from iptables-persistent; the firewall flush must run after the install."
  }
}

run "runcmd_invokes_only_the_bootstrap_script" {
  command = plan

  # unattended-upgrades used to be enabled here, ahead of a script that now
  # installs it. One entry point means one place where a failure is visible.
  assert {
    condition     = length(yamldecode(local.cloud_init).runcmd) == 1
    error_message = "runcmd should contain exactly the bootstrap script; anything else runs before its dependencies are installed."
  }

  assert {
    condition     = yamldecode(local.cloud_init).runcmd[0] == ["/opt/bootstrap-k3s.sh"]
    error_message = "runcmd's only entry must be /opt/bootstrap-k3s.sh."
  }

  assert {
    condition     = strcontains(local.cloud_init, "systemctl enable --now unattended-upgrades")
    error_message = "unattended-upgrades must still be enabled, now from inside the script."
  }
}

run "cloud_init_pins_the_k3s_version" {
  command = plan

  assert {
    condition     = strcontains(local.cloud_init, "INSTALL_K3S_VERSION=\"v1.33.4+k3s1\"")
    error_message = "k3s must be pinned so a rebuild reproduces the Traefik chart version this config was verified against."
  }
}

# ---------------------------------------------------------------------------
# Structural validation.
#
# Every assertion above is a string match, and a string match stays green if
# the embedded HelmChartConfig is indented one space wrong -- which is exactly
# what compute.tf's indent()/replace() pipeline can get wrong. yamldecode is
# the cheap structural check, and it has to run three times because this is a
# document (cloud-init) containing a document (the HelmChartConfig) containing
# a document (valuesContent, a string as far as Helm's own parser is
# concerned).
# ---------------------------------------------------------------------------

run "cloud_init_and_the_embedded_manifest_both_parse_as_yaml" {
  command = plan

  assert {
    condition     = length(yamldecode(local.cloud_init).write_files) == 2
    error_message = "cloud-init must parse as YAML and write exactly the Traefik manifest and the bootstrap script."
  }

  assert {
    condition = yamldecode(one([
      for f in yamldecode(local.cloud_init).write_files :
      f.content
      if f.path == "/var/lib/rancher/k3s/server/manifests/traefik-config.yaml"
    ])).kind == "HelmChartConfig"
    error_message = "The embedded manifest must parse as YAML at its own indentation level and be a HelmChartConfig."
  }

  assert {
    condition = yamldecode(yamldecode(one([
      for f in yamldecode(local.cloud_init).write_files :
      f.content
      if f.path == "/var/lib/rancher/k3s/server/manifests/traefik-config.yaml"
    ])).spec.valuesContent).hostNetwork == true
    error_message = "valuesContent must itself parse as YAML and carry hostNetwork: true."
  }

  assert {
    condition = yamldecode(yamldecode(one([
      for f in yamldecode(local.cloud_init).write_files :
      f.content
      if f.path == "/var/lib/rancher/k3s/server/manifests/traefik-config.yaml"
    ])).spec.valuesContent).updateStrategy.type == "Recreate"
    error_message = "valuesContent must carry updateStrategy.type: Recreate at the top level, not under deployment."
  }

  assert {
    condition = yamldecode(yamldecode(one([
      for f in yamldecode(local.cloud_init).write_files :
      f.content
      if f.path == "/var/lib/rancher/k3s/server/manifests/traefik-config.yaml"
    ])).spec.valuesContent).service.enabled == false
    error_message = "valuesContent must disable the Traefik Service."
  }
}

run "rendered_user_data_carries_no_trailing_whitespace" {
  command = plan

  # indent() pads blank lines, so the naive render leaves trailing spaces on
  # every empty line inside the embedded manifest. yamllint --strict rejects
  # that, and so does a careful reviewer reading the instance's user_data.
  assert {
    condition     = !can(regex("(?m)[ \t]+$", local.cloud_init))
    error_message = "compute.tf must strip the trailing whitespace that indent() introduces on blank lines."
  }
}

run "the_ssh_key_cannot_escape_its_yaml_scalar" {
  command = plan

  # The paired negative case lives in variables.tftest.hcl
  # (ssh_public_key_must_be_a_single_line). This run covers the structural half:
  # even if that validation is loosened or bypassed, the value is emitted as a
  # quoted scalar and cannot terminate early.
  assert {
    condition     = strcontains(local.cloud_init, "- \"ssh-ed25519 ")
    error_message = "The authorized key must be emitted as a quoted YAML scalar. A bare interpolation lets any newline in the value become a top-level cloud-config directive."
  }

  assert {
    condition = sort(keys(yamldecode(local.cloud_init))) == sort([
      "final_message",
      "runcmd",
      "users",
      "write_files",
    ])
    error_message = "The rendered cloud-config has an unexpected set of top-level keys. Either a directive was added deliberately and this list needs updating, or an interpolated value broke out of its scalar."
  }
}

# ---------------------------------------------------------------------------
# Supply chain and host firewall.
#
# All three properties below were measured on a real Ubuntu 24.04 box with a
# real iptables-persistent before they were written, and each of the string
# forms asserted here is one a first guess got wrong. They are locked because
# every one of them fails silently: a stale pin installs a different
# installer, an unverified download is a root shell from the internet, and a
# save that did not persist only shows up on the next reboot.
# ---------------------------------------------------------------------------

run "the_k3s_installer_is_pinned_and_verified_not_piped_from_the_internet" {
  command = plan

  # https://get.k3s.io serves the master-branch script, so pinning
  # INSTALL_K3S_VERSION pinned the binary and left the ~36KB of shell that
  # installs it floating. Measured: the two are different files.
  #
  # Non-comment lines only: the script explains at length why it does not use
  # that endpoint, and a bare strcontains cannot tell the prohibition from the
  # thing prohibited.
  assert {
    condition     = !can(regex("(?m)^[^#\n]*get\\.k3s\\.io", local.cloud_init))
    error_message = "cloud-init must not fetch anything from get.k3s.io. That endpoint serves the master-branch installer, as root, and no version pin constrains it."
  }

  # The "+" has to survive as %2B; raw.githubusercontent.com 404s on the bare
  # form, which would fail the download rather than install the wrong thing --
  # loud, but still a broken bootstrap.
  assert {
    condition     = strcontains(local.cloud_init, "https://raw.githubusercontent.com/k3s-io/k3s/v1.33.4%2Bk3s1/install.sh")
    error_message = "The installer URL must be the install.sh tagged for exactly k3s_version, with the + percent-encoded, so the script and the binary come from one release."
  }

  assert {
    condition     = strcontains(local.cloud_init, "sha256sum -c -")
    error_message = "The downloaded installer must be checksum-verified before it is executed."
  }

  # Ordering, not presence. A verification that runs after the script has
  # already executed is decoration.
  assert {
    condition     = can(regex("(?s)sha256sum -c -.*sh /opt/k3s-install.sh server", local.cloud_init))
    error_message = "The digest check must run before the installer is executed, not after."
  }
}

run "the_pod_cidr_cannot_reach_the_nodes_sshd" {
  command = plan

  # 22 can be taken back at the host and 6443 cannot: kube-proxy deliberately
  # does not masquerade pod-CIDR sources for kubernetes.default.svc, so a DROP
  # on 6443 breaks every in-cluster API client. Measured on a real cluster --
  # baseline 401, with the 22 rule 401, with the 6443 rule a curl timeout.
  assert {
    condition     = strcontains(local.cloud_init, "iptables -I INPUT 1 -s 10.42.0.0/16 -p tcp --dport 22 -j DROP")
    error_message = "The host must drop new pod-CIDR connections to sshd. The NSG cannot: pod-to-host traffic never crosses the VNIC."
  }

  assert {
    condition     = !can(regex("iptables -I INPUT[^\\n]*--dport 6443[^\\n]*DROP", local.cloud_init))
    error_message = "Do not add the same DROP for 6443. kubernetes.default.svc DNATs to the node with the pod's own source address, so this breaks every in-cluster API client."
  }

  # The rule is inserted after the flush, or the flush removes it.
  assert {
    condition     = can(regex("(?s)iptables -F INPUT.*iptables -I INPUT 1 -s 10.42.0.0/16", local.cloud_init))
    error_message = "The pod-CIDR drop must be inserted after the INPUT flush, not before it."
  }
}

run "the_flushed_ruleset_is_persisted_and_the_save_is_verified" {
  command = plan

  # No "|| true". iptables-persistent's saved ruleset is Ubuntu's default-DROP
  # one until the save succeeds, so ignoring a failure yields a box that
  # serves traffic until someone reboots it, with cloud-init reporting success.
  assert {
    condition     = !can(regex("netfilter-persistent save[^\\n]*\\|\\| true", local.cloud_init))
    error_message = "netfilter-persistent save must not be allowed to fail silently; it is the only step that carries the flush across a reboot."
  }

  # The saved forms, measured with iptables-save rather than assumed. A policy
  # is written ":INPUT ACCEPT [0:0]", never the "-P INPUT ACCEPT" that sets
  # it, and iptables inserts "-m tcp" into the saved rule. Grepping for either
  # command verbatim fails against a correctly saved file -- which would have
  # bricked every boot.
  assert {
    condition     = strcontains(local.cloud_init, "grep -q \"^:INPUT ACCEPT\" /etc/iptables/rules.v4")
    error_message = "The save must be verified by re-reading rules.v4, and against iptables-save's own output form (':INPUT ACCEPT'), not the command that sets the policy."
  }

  assert {
    condition     = strcontains(local.cloud_init, "-A INPUT -s 10.42.0.0/16.*--dport 22 -j DROP")
    error_message = "The persisted pod-CIDR drop must be verified too; a save that lost it is only discovered on the next reboot."
  }
}
