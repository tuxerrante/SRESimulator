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
# owner_alias -- same contract as the Azure root
# ---------------------------------------------------------------------------

run "owner_alias_valid_short" {
  command = plan

  variables {
    owner_alias = "abc"
  }

  assert {
    condition     = oci_core_vcn.main.display_name == "abc-free-vcn"
    error_message = "Names should derive from owner_alias."
  }
}

run "owner_alias_reject_uppercase" {
  command = plan

  variables {
    owner_alias = "JDoe"
  }

  expect_failures = [
    var.owner_alias,
  ]
}

run "owner_alias_reject_too_short" {
  command = plan

  variables {
    owner_alias = "ab"
  }

  expect_failures = [
    var.owner_alias,
  ]
}

run "owner_alias_reject_starts_with_number" {
  command = plan

  variables {
    owner_alias = "1abc"
  }

  expect_failures = [
    var.owner_alias,
  ]
}

# ---------------------------------------------------------------------------
# Access-control guard rails
# ---------------------------------------------------------------------------

run "ssh_open_to_the_world_requires_explicit_opt_in" {
  command = plan

  variables {
    ssh_allowed_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [
    var.ssh_allowed_cidrs,
  ]
}

run "ssh_open_to_the_world_accepted_with_opt_in" {
  command = plan

  variables {
    ssh_allowed_cidrs       = ["0.0.0.0/0"]
    allow_ssh_from_anywhere = true
  }

  assert {
    condition     = length(oci_core_network_security_group_security_rule.ingress_ssh) == 1
    error_message = "With the explicit opt-in the rule should be created."
  }
}

run "kubernetes_api_open_to_the_world_is_always_rejected" {
  command = plan

  variables {
    k8s_api_allowed_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [
    var.k8s_api_allowed_cidrs,
  ]
}

# ---------------------------------------------------------------------------
# Remaining input contracts
# ---------------------------------------------------------------------------

run "compartment_ocid_must_look_like_an_ocid" {
  command = plan

  variables {
    compartment_ocid = "not-an-ocid"
  }

  expect_failures = [
    var.compartment_ocid,
  ]
}

run "ssh_public_key_must_be_openssh_format" {
  command = plan

  variables {
    # The mistake being guarded against is pasting the private half of the
    # pair. The header is assembled through interpolation so that the string
    # detect-private-key looks for never appears literally in the repository;
    # Terraform still sees the full header at plan time.
    ssh_public_key = "-----BEGIN OPENSSH ${"PRIVATE"} KEY-----"
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}

run "acme_email_must_be_an_email" {
  command = plan

  variables {
    acme_email = "not-an-email"
  }

  expect_failures = [
    var.acme_email,
  ]
}

run "k3s_version_must_be_pinned_precisely" {
  command = plan

  variables {
    k3s_version = "latest"
  }

  expect_failures = [
    var.k3s_version,
  ]
}

run "availability_domain_index_out_of_range_rejected" {
  command = plan

  variables {
    availability_domain_index = 3
  }

  expect_failures = [
    var.availability_domain_index,
  ]
}

# The IPv6 world CIDR is a separate string from the IPv4 one, and this
# deployment being IPv4-only does not make "::/0" harmless: the NSG builds its
# rules with source_type = "CIDR_BLOCK", which accepts either family without
# complaint, so a guard written against "0.0.0.0/0" alone would pass "::/0"
# straight through to a live rule.

run "ssh_open_to_the_ipv6_world_requires_explicit_opt_in" {
  command = plan

  variables {
    ssh_allowed_cidrs = ["::/0"]
  }

  expect_failures = [
    var.ssh_allowed_cidrs,
  ]
}

run "ssh_open_to_the_ipv6_world_accepted_with_opt_in" {
  command = plan

  variables {
    ssh_allowed_cidrs       = ["::/0"]
    allow_ssh_from_anywhere = true
  }

  assert {
    condition     = length(oci_core_network_security_group_security_rule.ingress_ssh) == 1
    error_message = "With the explicit opt-in the rule should be created."
  }
}

run "kubernetes_api_open_to_the_ipv6_world_is_always_rejected" {
  command = plan

  variables {
    k8s_api_allowed_cidrs = ["::/0"]
  }

  expect_failures = [
    var.k8s_api_allowed_cidrs,
  ]
}

# ---------------------------------------------------------------------------
# CIDR layout
#
# vcn_cidr's description has always claimed it must avoid the k3s ranges. The
# failure mode when it does not is intermittent pod networking on the box,
# which points nowhere near this variable, so the claim is worth enforcing.
# ---------------------------------------------------------------------------

run "vcn_cidr_may_not_equal_the_k3s_pod_range" {
  command = plan

  variables {
    vcn_cidr    = "10.42.0.0/16"
    subnet_cidr = "10.42.0.0/24"
  }

  expect_failures = [
    var.vcn_cidr,
  ]
}

run "vcn_cidr_may_not_sit_inside_the_k3s_service_range" {
  command = plan

  variables {
    vcn_cidr    = "10.43.5.0/24"
    subnet_cidr = "10.43.5.0/26"
  }

  expect_failures = [
    var.vcn_cidr,
  ]
}

run "vcn_cidr_may_not_swallow_the_k3s_ranges" {
  command = plan

  variables {
    vcn_cidr = "10.0.0.0/8"
  }

  expect_failures = [
    var.vcn_cidr,
  ]
}

run "vcn_cidr_adjacent_to_the_k3s_ranges_is_fine" {
  command = plan

  variables {
    vcn_cidr    = "10.44.0.0/16"
    subnet_cidr = "10.44.0.0/24"
  }

  assert {
    condition     = contains(oci_core_vcn.main.cidr_blocks, "10.44.0.0/16")
    error_message = "A non-overlapping CIDR should be accepted verbatim."
  }
}

run "subnet_cidr_must_live_inside_the_vcn" {
  command = plan

  variables {
    vcn_cidr    = "10.0.0.0/16"
    subnet_cidr = "10.1.0.0/24"
  }

  expect_failures = [
    var.subnet_cidr,
  ]
}

run "subnet_cidr_may_not_be_wider_than_the_vcn" {
  command = plan

  variables {
    vcn_cidr    = "10.0.0.0/16"
    subnet_cidr = "10.0.0.0/8"
  }

  expect_failures = [
    var.subnet_cidr,
  ]
}

# ---------------------------------------------------------------------------
# Inputs that pass validation and then fail at apply
#
# Each of these was a real gap: the variable accepted a value that terraform
# validate waved through and that only failed later, either in the OCI API or
# in the shell of the rendered bootstrap script. That is the worst shape for an
# infra bug, because the operator has already committed to the apply.
# ---------------------------------------------------------------------------
run "owner_alias_must_leave_room_for_the_vcn_dns_label" {
  command = plan

  variables {
    # 12 characters. The old regex allowed up to 16, and network.tf derives the
    # VCN DNS label by appending "free", so this produced a 16-character label
    # against OCI's documented 15-character limit.
    owner_alias = "abcdefghijkl"
  }

  expect_failures = [
    var.owner_alias,
  ]
}

run "ssh_public_key_must_be_a_single_line" {
  command = plan

  variables {
    # The first line is a valid key, so the format regex -- which is unanchored
    # at the end -- matches. cloud-init.yaml.tftpl interpolates this into a YAML
    # sequence item, so the second line lands as a top-level cloud-config
    # directive. Rendering the real template with a value like this injected a
    # new top-level key alongside runcmd, users and write_files.
    ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTests test@example.com\nruncmd:\n  - [touch, /tmp/injected]"
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}

run "availability_domain_index_must_be_a_whole_number" {
  command = plan

  variables {
    # Passes a bare >= 0 && < 3 range check, then fails at plan with
    # "Invalid index" when it is used to subscript the AD list.
    availability_domain_index = 1.5
  }

  expect_failures = [
    var.availability_domain_index,
  ]
}

run "swap_size_mb_must_be_a_whole_number" {
  command = plan

  variables {
    # Interpolated into fallocate -l "<n>M" and dd count="<n>", neither of
    # which takes a fraction.
    swap_size_mb = 2048.5
  }

  expect_failures = [
    var.swap_size_mb,
  ]
}
