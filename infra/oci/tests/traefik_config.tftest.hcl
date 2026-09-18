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
  ssh_public_key         = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTests test@example.com"
  acme_email             = "ops@example.com"
  cloudflare_ipv4_ranges = ["198.51.100.0/24", "203.0.113.0/24"]
}
# ---------------------------------------------------------------------------
# Regression lock on traefik-config.yaml.
#
# Four bugs were found by running this exact shape on real k3s -- three on an
# aarch64 VM before any cloud instance existed, the fourth on the oci-shape-e2e
# CI runner. Each one is silent in a different way, so each gets an assertion
# here as well as coverage in that job. These run in milliseconds and need no
# cluster.
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

run "acme_email_is_substituted" {
  command = plan

  assert {
    condition     = strcontains(local.traefik_config_rendered, "email: ops@example.com")
    error_message = "ACME_EMAIL_PLACEHOLDER should be replaced with var.acme_email."
  }

  assert {
    condition     = !strcontains(local.traefik_config_rendered, "ACME_EMAIL_PLACEHOLDER")
    error_message = "No placeholder may survive into the rendered manifest."
  }
}

# ---------------------------------------------------------------------------
# cloud-init
# ---------------------------------------------------------------------------

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
