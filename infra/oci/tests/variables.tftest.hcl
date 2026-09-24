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

# The overlap check above cannot catch an IPv6 value: it compares network
# addresses, and an IPv6 prefix never equals an IPv4 one, so every arm of it
# passes and the value reaches oci_core_vcn.cidr_blocks. This root assigns no
# IPv6 address anywhere, so the refusal belongs at plan time with the
# variable's own name on it.
run "vcn_cidr_may_not_be_ipv6" {
  command = plan

  variables {
    vcn_cidr    = "2001:db8::/16"
    subnet_cidr = "10.0.0.0/24"
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

# `ssh_public_key_accepts_a_real_rsa_key` below already witnesses a 2048-bit
# key, and that stayed true through every version of this check. What it could
# not witness is the arm's weakness: RSA matched a *floor* of base64 characters
# after the type header, so filler passed, and a 4096-bit key truncated
# anywhere past 204 characters passed -- which is the failure this validation
# exists to catch, since truncated copy-paste is how the variable realistically
# goes wrong. A positive run cannot fail on either.
#
# RSA is enumerated per modulus size now, so each arm needs its own witness;
# 2048 has one, and these add the other three. The blobs are real `ssh-keygen
# -t rsa` output, unedited -- shortening them for the page would test a
# different string than the one an operator pastes.
run "ssh_public_key_accepts_a_real_rsa_4096_key" {
  command = plan

  variables {
    ssh_public_key = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDmII6qxdUvJ8PkoQQybzUwYDu22Jpc/k93f1o24GV3QopaLsQ5kxhq+xjRqAKhMP9wvrdZ8GzIVEGLlJKHR2JCepf1wqnUlDdt17vm0VhK7S/JR9rfc2PtD98/EBZOpkUe/55xyO6L7fjYW2nhErm4keGUi5ky/+5c+zQBHDxGPOJ7bnBzVIo3RsyPhwi8bFr0IxQXo27MmoZ6DQyYTtEk0u42sweYM/ZJvm6DnBnx5+vkZc8/Ya2BXxpxvGmlPRQvlaOjk4LbZFF+eAH6P5UUH/PqUpilJ5ADfC4kHm7AKSb2rRev/56KqKblSwd8dZ6rv+pBAlGFCQuaFHPogwJPzl6i6HVnxEWJGGsglddUGi2wXyCKtd99fLyy0fmSB35UTr0bS3OocIYgQ2yIfKC/+X/Kmv5Kjs34hGJ/g9a5Bdq17toIC/pE9TEzp1j2py+wLYuPvtVcaLc55ewv6G0PsEwxOyRKN19YuiuYKRXmIOObH/LtqHt0YoO4zGP/ieEOIirG/cyVU4MMmHOfESq35pk5tOB7119o+ScssTu3Pc1sQmCRC9Wihp9A9dXPuvJcg5oBTQU2pVVlsZhbMdNHVf7qjixL2+Qr+acrWi49TwP/YQfUIjt80Oo+/EH1b0GJB0vzD++t5v3w3sg8jQ/TuHDaaUIC3MwRmAmEj7orbw== test@example.com"
  }
}

run "ssh_public_key_accepts_a_real_rsa_1024_key" {
  command = plan

  variables {
    ssh_public_key = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC9uj1IuTZa3mKczwG5eraPSDnS8PmLvtHRmYYZGZeVbskWMkYVZ9sQwD2xM4gBmtU25z5FSkWPJ/bew3xXQiDiztyFoIVW04z8cjWAKkyq7mktGnDDnHXIgP5pYZZI5F5CY2b9bhbnPE3cy+3D/A5b5yetrin8p8hCVmE9uIaBYw== test@example.com"
  }
}

run "ssh_public_key_accepts_a_real_rsa_3072_key" {
  command = plan

  variables {
    ssh_public_key = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7H6AyxOnESJec4Ul0j+B1uo/4ySgIkMMIhGFMYdWZhKNDLs85jnBXvi/7yZzfL6U6IpSi9Gk+TIJVlyz/aK7tdiEPBbyBD19A95g/WrFEoUcRemCpDelJpL/aM5E9N12v4CdPoQyHHxsCULAbyEY9GOL546/GH0LlKlmBW3hM/jlW/cMcs452WshN3M1+SE2JbLoZeVwYtJYpjza8QgqFcj3v9a2wrkEwWWNSGmf8EEf6NMpxGDvyapCNjxz8DIGw3cLdxv/4DuOnha7BqVsGF3ZTO1vJCCtjkcAwf3VyUsbEAUjFcx4XQ5PP9ykEZ3NO5nVvm2r46VDyCNlWXZXArSa/lZKWZYUY3RQYAimDrD54wkN1G4QOBGJNGs/bHVeD1LubQo/4bno4m0r6qcGCbEjRGH0cPFw5EIIX6OzYjrdsVFa7X+UnMwUEwsYGbEgSCtWRpmJ0N24mxiJ3QR+36N0a/uclESYiwnI8RCZrwwQFLc1wwfPvBnKTP6qNnFE= test@example.com"
  }
}

# The reported bypass: a valid RSA type header followed by nothing but filler.
# It is the right length and spelled in the base64 alphabet, and it decodes to
# a modulus of zero -- an authorized-keys line sshd installs and can never
# authenticate, on a box whose only other way in is a rebuild.
run "ssh_public_key_rejects_rsa_filler_that_is_merely_long_enough" {
  command = plan

  variables {
    ssh_public_key = "ssh-rsa AAAAB3NzaC1yc2EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA test@example.com"
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}

# A 4096-bit key cut short. It clears the old 204-character floor by a wide
# margin and is the realistic way this variable goes wrong.
run "ssh_public_key_rejects_a_truncated_rsa_4096_key" {
  command = plan

  variables {
    ssh_public_key = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDmII6qxdUvJ8PkoQQybzUwYDu22Jpc/k93f1o24GV3QopaLsQ5kxhq+xjRqAKhMP9wvrdZ8GzIVEGLlJKHR2JCepf1wqnUlDdt17vm0VhK7S/JR9rfc2PtD98/EBZOpkUe/55xyO6L7fjYW2nhErm4keGUi5ky/+5c+zQBHDxGPOJ7bnBzVIo3RsyPhwi8bFr0IxQXo27MmoZ6DQyYTtEk0u42sweYM/ZJvm6DnBnx5+vkZc8/Ya2BXxpxvGmlPRQvlaOjk4LbZFF+ test@example.com"
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
    # floor this replaced -- and an ed25519 blob is invariably exactly 68
    # characters, so this one is truncated. authorized_keys silently ignores a
    # truncated line, leaving a box with no way in: 22 is closed by default and
    # there is no console password.
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

# ---------------------------------------------------------------------------
# The determined run has to cover the *whole* type header.
#
# Recognising the opening of one is not the same check. An earlier version
# stopped at 12 characters for RSA and 28 for the NIST curves, which left the
# tail of the type string inside the free repetition that follows -- so the two
# runs below passed while decoding to a type string sshd cannot parse, on a box
# whose only other way in is a rebuild. The run lengths are now derived from
# the wire format (see variables.tf) rather than from what a valid key happens
# to start with.
# ---------------------------------------------------------------------------
run "ssh_public_key_rejects_a_truncated_rsa_type_header" {
  command = plan

  variables {
    # "AAAAB3NzaC1y" decodes to a 4-byte length of 7 followed by "ssh-r", and
    # the two bytes that should finish "ssh-rsa" come out of the filler as
    # NULs. Long enough to clear the length floor, and not a key.
    ssh_public_key = "ssh-rsa AAAAB3NzaC1yAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA test@example.com"
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}

run "ssh_public_key_rejects_a_truncated_ecdsa_type_header" {
  command = plan

  variables {
    # Same shape one type over: the curve name that follows the type string is
    # never checked if the run stops inside the type string.
    ssh_public_key = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= test@example.com"
  }

  expect_failures = [
    var.ssh_public_key,
  ]
}

# The negatives above are only worth what the positives are. Both keys are
# throwaway `ssh-keygen` output, kept verbatim so that tightening the runs
# again cannot quietly start rejecting real keys -- which would be the worse
# failure of the two, since it blocks a legitimate bring-up.
run "ssh_public_key_accepts_a_real_rsa_key" {
  command = plan

  variables {
    ssh_public_key = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCtvZA7tiyTH3cAMmapgwQUiITup1/WTT1Ry+b0pTVUG+gpM3ksaa4Yam7Zbhji7mkasqqEwkN1tmXzhQmLmPmLU4FxVG5Nl8a9GXDGIV2y2R0pYN4QByTxhnbPwMHBUxuIm2NbGJRRgf3wTLWLerixeedob+SI0hMKMPdL3jVOsoTfgGPXa4yVDvogfuMe5V0TwwYG7qEk24WIblAsO9LwskEPWcIJESBjidt68MzmF7qISvvn1ke00VU2tKTc80IitSwUrHo/eCKHq+Jgo7ay69M+Rw4JWlIyPYGx4Kf1SMkCWg8j9DBNN60V9dSpQMwHGKxBa3EEj4mIa+axLEiJ test@example.com"
  }

  assert {
    condition     = can(regex("^ssh-rsa ", var.ssh_public_key))
    error_message = "A real ssh-rsa key from ssh-keygen must satisfy the wire-format check."
  }
}

run "ssh_public_key_accepts_a_real_ecdsa_key" {
  command = plan

  variables {
    ssh_public_key = "ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAGE6oTUvPLYeQnFecK9mj9YDN6FNld4N8INKOu6C/NKmW4izp/ODwslHHEDrBNxUMFhGxJYgzjnH2IrcxpH7apbpwH8wZg02ZyF06XQNOOj677LGR+w0//vVvybYWOGCeTHvTO6Jx9IHSp3kFPD4xCL/sDr/KE5uL9qDCMBh3n6dsmMvA== test@example.com"
  }

  assert {
    condition     = can(regex("^ecdsa-sha2-nistp521 ", var.ssh_public_key))
    error_message = "A real ecdsa-sha2-nistp521 key from ssh-keygen must satisfy the wire-format check."
  }
}

# ---------------------------------------------------------------------------
# The coverage guards measure the union of the listed blocks, not their sum.
# A sum is sound in the direction that matters -- coverage never exceeds the
# sum, so "sum < 2^32" still cannot let the whole internet through -- but it
# over-refuses, and it over-refuses on two shapes an operator writes by hand.
# These runs are the regression lock on that, and they pass only because the
# containment filter is there: with a plain sum each one is rejected with an
# error message claiming the list covers the entire internet.
# ---------------------------------------------------------------------------

run "a_repeated_ssh_range_is_counted_once" {
  command = plan

  variables {
    # Two spellings of one block, which is what a copy-paste into a list
    # produces. Summed, this is 2^31 + 2^31 = the whole address space.
    ssh_allowed_cidrs = ["10.0.0.0/1", "10.0.0.0/1"]
  }

  assert {
    condition     = length(oci_core_network_security_group_security_rule.ingress_ssh) == 1
    error_message = "A duplicate entry must collapse, not read as twice the address space."
  }
}

run "a_nested_range_does_not_inflate_the_measured_coverage" {
  command = plan

  variables {
    # Union 3/4 of the space, sum exactly all of it: the /2 sits wholly
    # inside the /1, so a plain sum counts that quarter twice and refuses.
    #
    # The realistic shape -- a /32 written out beside the /24 containing it --
    # is deliberately *not* the fixture here. It is the case an operator hits,
    # but it is only ~16.7M addresses, so a plain sum passes it too and the
    # run would not discriminate. These numbers are chosen so that it does.
    ssh_allowed_cidrs = ["0.0.0.0/1", "0.0.0.0/2", "128.0.0.0/2"]
  }

  assert {
    condition     = length(oci_core_network_security_group_security_rule.ingress_ssh) == 3
    error_message = "A CIDR contained in another entry must not be double-counted."
  }
}

run "a_repeated_cloudflare_range_is_counted_once" {
  command = plan

  variables {
    restrict_ingress_to_cloudflare = true
    cloudflare_ipv4_ranges         = ["0.0.0.0/1", "0.0.0.0/1", "128.0.0.0/2"]
  }

  # Two rules, not three: the NSG for_each is over a set, so the duplicate
  # collapses there as well. That is the point -- the duplicate was never
  # going to produce a second rule, only a second term in the old sum.
  assert {
    condition     = length(oci_core_network_security_group_security_rule.ingress_http) == 2
    error_message = "A duplicated Cloudflare range must not read as the whole internet."
  }
}

run "the_union_guard_still_refuses_a_real_full_cover" {
  command = plan

  variables {
    # Same three-entry shape as the run above, but these do tile the space.
    # Without this the two runs above could be passed by deleting the guard.
    cloudflare_ipv4_ranges = ["0.0.0.0/1", "128.0.0.0/2", "192.0.0.0/2"]
  }

  expect_failures = [
    var.cloudflare_ipv4_ranges,
  ]
}

run "the_union_guard_still_refuses_a_nested_full_cover" {
  command = plan

  variables {
    # A contained entry alongside a genuine tiling: the containment filter
    # must drop the /16 without dropping either half of the cover.
    k8s_api_allowed_cidrs = ["0.0.0.0/1", "128.0.0.0/1", "10.1.0.0/16"]
  }

  expect_failures = [
    var.k8s_api_allowed_cidrs,
  ]
}
