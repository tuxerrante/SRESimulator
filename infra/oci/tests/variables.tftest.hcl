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
    ssh_public_key = "-----BEGIN OPENSSH PRIVATE KEY-----"
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
