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
# owner_alias -- deliberately stricter than the Azure root
#
# The Azure root allows {2,15}; this one caps at {2,10} because network.tf
# derives the VCN DNS label from the prefix and OCI caps those at 15
# alphanumeric characters. The shapes are otherwise the same.
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

# allow_ssh_from_anywhere is an opt-in for *breadth*, not for family. Once the
# IPv4-only guard exists, "::/0" is refused whether or not the operator opted
# in -- there is nothing on the other side of that rule to match. Asserting it
# here keeps the two guards from being conflated later: the opt-in path is
# still exercised with an IPv4 world CIDR two runs above.
run "ssh_ipv6_world_is_refused_even_with_the_opt_in" {
  command = plan

  variables {
    ssh_allowed_cidrs       = ["::/0"]
    allow_ssh_from_anywhere = true
  }

  expect_failures = [
    var.ssh_allowed_cidrs,
  ]
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
    ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTestsAAAAAAAAAAAAAAAAA test@example.com\nruncmd:\n  - [touch, /tmp/injected]"
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

# ---------------------------------------------------------------------------
# World coverage, however it is spelled
#
# The guards above matched "0.0.0.0/0" and "::/0" as strings. A pair of
# ordinary-looking CIDRs covers the same space and passed, so the guards now
# measure coverage instead. These runs are the ones the string form failed.
# ---------------------------------------------------------------------------

run "ssh_split_world_still_needs_the_opt_in" {
  command = plan

  variables {
    # Together these two are 0.0.0.0/0 with extra steps.
    ssh_allowed_cidrs = ["0.0.0.0/1", "128.0.0.0/1"]
  }

  expect_failures = [
    var.ssh_allowed_cidrs,
  ]
}

run "ssh_split_world_is_accepted_with_the_opt_in" {
  command = plan

  variables {
    ssh_allowed_cidrs       = ["0.0.0.0/1", "128.0.0.0/1"]
    allow_ssh_from_anywhere = true
  }

  assert {
    condition     = length(oci_core_network_security_group_security_rule.ingress_ssh) == 2
    error_message = "The opt-in should still permit a deliberately world-open list."
  }
}

run "ssh_quartered_world_still_needs_the_opt_in" {
  command = plan

  variables {
    # Any decomposition works, so the check cannot enumerate spellings.
    ssh_allowed_cidrs = ["0.0.0.0/2", "64.0.0.0/2", "128.0.0.0/2", "192.0.0.0/2"]
  }

  expect_failures = [
    var.ssh_allowed_cidrs,
  ]
}

# Reached by the IPv4-only guard first now, but kept as-is: the coverage
# measurement it was written for is the barrier that survives if this
# deployment ever becomes dual-stack, and that is exactly when a split IPv6
# world would stop being unreachable and start being open.
run "ssh_split_ipv6_world_is_refused" {
  command = plan

  variables {
    ssh_allowed_cidrs = ["::/1", "8000::/1"]
  }

  expect_failures = [
    var.ssh_allowed_cidrs,
  ]
}

run "a_genuinely_narrow_ssh_list_is_untouched" {
  command = plan

  variables {
    # The guard has to stay usable, or it gets discovered by locking an
    # operator out rather than by this test.
    ssh_allowed_cidrs = ["203.0.113.4/32", "198.51.100.0/24", "10.0.0.0/8"]
  }

  assert {
    condition     = length(oci_core_network_security_group_security_rule.ingress_ssh) == 3
    error_message = "Ordinary operator CIDRs must not trip the world-coverage guard."
  }
}

run "ssh_entries_must_be_cidrs_not_bare_addresses" {
  command = plan

  variables {
    ssh_allowed_cidrs = ["203.0.113.4"]
  }

  expect_failures = [
    var.ssh_allowed_cidrs,
  ]
}

run "kubernetes_api_split_world_is_always_rejected" {
  command = plan

  variables {
    # No opt-in exists for this list, so this is the case that decides whether
    # the description's "can never be opened to the world" is true.
    k8s_api_allowed_cidrs = ["0.0.0.0/1", "128.0.0.0/1"]
  }

  expect_failures = [
    var.k8s_api_allowed_cidrs,
  ]
}

run "kubernetes_api_entries_must_be_cidrs" {
  command = plan

  variables {
    k8s_api_allowed_cidrs = ["203.0.113.4"]
  }

  expect_failures = [
    var.k8s_api_allowed_cidrs,
  ]
}

run "cloudflare_override_may_not_open_the_origin_to_everyone" {
  command = plan

  variables {
    # restrict_ingress_to_cloudflare stays true, so this would read as a
    # restricted origin while admitting the whole internet to 80/443.
    cloudflare_ipv4_ranges = ["0.0.0.0/0"]
  }

  expect_failures = [
    var.cloudflare_ipv4_ranges,
  ]
}

run "cloudflare_override_split_world_is_rejected_too" {
  command = plan

  variables {
    cloudflare_ipv4_ranges = ["0.0.0.0/1", "128.0.0.0/1"]
  }

  expect_failures = [
    var.cloudflare_ipv4_ranges,
  ]
}

run "cloudflare_override_must_be_ipv4" {
  command = plan

  variables {
    # The box is assigned no IPv6 address, so an IPv6 range here builds an NSG
    # rule that can never match.
    cloudflare_ipv4_ranges = ["2400:cb00::/32"]
  }

  expect_failures = [
    var.cloudflare_ipv4_ranges,
  ]
}

run "acme_email_may_not_carry_yaml_significant_characters" {
  command = plan

  variables {
    # Passes any ordinary email regex, and begins a folded block scalar in the
    # values document k3s's helm-controller parses.
    acme_email = ">ops@example.com"
  }

  expect_failures = [
    var.acme_email,
  ]
}

run "acme_email_alias_character_is_rejected" {
  command = plan

  variables {
    acme_email = "*ops@example.com"
  }

  expect_failures = [
    var.acme_email,
  ]
}

run "an_ordinary_acme_email_is_still_accepted" {
  command = plan

  variables {
    acme_email = "sre-ops.team+acme@sub.example.co.uk"
  }

  assert {
    condition     = strcontains(local.traefik_config_rendered, "sre-ops.team+acme@sub.example.co.uk")
    error_message = "A conventional address must still be accepted and substituted."
  }
}

run "ssh_public_key_must_carry_key_material" {
  command = plan

  variables {
    # Passes the key-type check, trimspaces to a bare type name, and installs
    # an authorized-keys line that can never authenticate. With 22 closed by
    # default that is an unreachable box.
    ssh_public_key = "ssh-ed25519 "
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}

run "ssh_public_key_rejects_non_base64_material" {
  command = plan

  variables {
    ssh_public_key = "ssh-ed25519 not the key you are looking for"
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}

run "operator_username_may_not_be_root" {
  command = plan

  variables {
    # Matches the username pattern, and defeats the non-root boundary the
    # variable exists to create.
    operator_username = "root"
  }

  expect_failures = [
    var.operator_username,
  ]
}

# ---------------------------------------------------------------------------
# IPv4-only deployment
# ---------------------------------------------------------------------------

run "ssh_allowed_cidrs_rejects_ipv6" {
  command = plan

  variables {
    # A perfectly well-formed CIDR that cidrhost() accepts and the NSG's
    # CIDR_BLOCK source type accepts, against a VNIC that has no IPv6 address.
    ssh_allowed_cidrs = ["2001:db8::/64"]
  }

  expect_failures = [
    var.ssh_allowed_cidrs,
  ]
}

run "k8s_api_allowed_cidrs_rejects_ipv6" {
  command = plan

  variables {
    k8s_api_allowed_cidrs = ["2001:db8::/64"]
  }

  expect_failures = [
    var.k8s_api_allowed_cidrs,
  ]
}

run "ssh_allowed_cidrs_still_accepts_ipv4" {
  command = plan

  variables {
    ssh_allowed_cidrs = ["203.0.113.4/32", "198.51.100.0/24"]
  }

  assert {
    condition     = length(oci_core_network_security_group_security_rule.ingress_ssh) == 2
    error_message = "Both IPv4 source CIDRs should still produce one NSG rule each."
  }
}

# ---------------------------------------------------------------------------
# availability_domain_index against the region's real domain count
# ---------------------------------------------------------------------------

run "ssh_public_key_rejects_a_curve_that_does_not_exist" {
  command = plan

  variables {
    ssh_public_key = "ecdsa-sha2-nistp999 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEexample test@example.com"
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}

run "availability_domain_index_beyond_the_regions_domain_count" {
  command = plan

  override_data {
    target = data.oci_identity_availability_domains.ads
    values = {
      availability_domains = [
        { name = "AAAA:EU-FRANKFURT-1-AD-1" },
      ]
    }
  }

  variables {
    # Passes the variable's own static 0-2 bound, and there is exactly one
    # domain to index.
    availability_domain_index = 1
  }

  expect_failures = [
    data.oci_identity_availability_domains.ads,
  ]
}

# ---------------------------------------------------------------------------
# ssh_public_key is matched against the OpenSSH wire format, not the base64
# alphabet.
#
# An OpenSSH blob opens with a length-prefixed copy of its own type string, so
# a fixed run of leading base64 characters is determined by the key type and
# cannot vary between keys. Checking that run is what ties the blob to the
# label in front of it. Counting characters from the base64 alphabet, which is
# what this replaced, could not: every string below is spelled correctly and
# none of them is a key.
# ---------------------------------------------------------------------------
run "ssh_public_key_rejects_a_blob_too_short_to_hold_a_key" {
  command = plan

  variables {
    # Correct type header, correct alphabet, comfortably past the 32-character
    # floor this replaced -- and an ed25519 blob is invariably exactly 68. authorized_keys silently ignores it, leaving a box
    # with no way in, because 22 is closed by default and there is no console
    # password.
    ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFRAbcdefghijklmnopqrstuv test@example.com"
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}

run "ssh_public_key_rejects_a_blob_that_contradicts_its_own_type" {
  command = plan

  variables {
    # Labelled ed25519, but the embedded wire-format header says ssh-rsa. sshd
    # reads the header and ignores the label, so this is not the key the
    # operator thinks they installed. Length alone can never catch this.
    ssh_public_key = "ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABgQDZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA test@example.com"
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}

run "ssh_public_key_rejects_a_curve_header_for_the_wrong_curve" {
  command = plan

  variables {
    # nistp384 label over the nistp256 header. Same class as the run above, on
    # the type where the two differ by a single base64 character.
    ssh_public_key = "ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= test@example.com"
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}
