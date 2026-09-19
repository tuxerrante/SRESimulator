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
# Every name derives from "<owner_alias>-free". The suffix is "-free" and not
# "-test" so that an OCI resource is never confused with an Azure one in a log
# line or a cost report.
# ---------------------------------------------------------------------------

run "vcn_name" {
  command = plan

  assert {
    condition     = oci_core_vcn.main.display_name == "jdoe-free-vcn"
    error_message = "VCN should be named <alias>-free-vcn."
  }
}

run "vcn_dns_label_strips_hyphens" {
  command = plan

  assert {
    condition     = oci_core_vcn.main.dns_label == "jdoefree"
    error_message = "OCI DNS labels are alphanumeric only; hyphens must be stripped."
  }
}

run "subnet_name" {
  command = plan

  assert {
    condition     = oci_core_subnet.public.display_name == "jdoe-free-subnet"
    error_message = "Subnet should be named <alias>-free-subnet."
  }
}

run "nsg_name" {
  command = plan

  assert {
    condition     = oci_core_network_security_group.instance.display_name == "jdoe-free-nsg"
    error_message = "NSG should be named <alias>-free-nsg."
  }
}

run "instance_name" {
  command = plan

  assert {
    condition     = oci_core_instance.k3s.display_name == "jdoe-free-k3s"
    error_message = "Instance should be named <alias>-free-k3s."
  }
}

run "gateway_and_route_table_names" {
  command = plan

  assert {
    condition     = oci_core_internet_gateway.main.display_name == "jdoe-free-igw"
    error_message = "Internet gateway should be named <alias>-free-igw."
  }

  assert {
    condition     = oci_core_route_table.main.display_name == "jdoe-free-rt"
    error_message = "Route table should be named <alias>-free-rt."
  }
}

run "reserved_ip_name" {
  command = plan

  assert {
    condition     = oci_core_public_ip.k3s.display_name == "jdoe-free-ip"
    error_message = "Reserved public IP should be named <alias>-free-ip."
  }
}

run "availability_domain_index_selects_the_right_ad" {
  command = plan

  variables {
    availability_domain_index = 2
  }

  assert {
    condition     = oci_core_instance.k3s.availability_domain == "AAAA:EU-FRANKFURT-1-AD-3"
    error_message = "availability_domain_index must select the matching AD; this is the knob used to work around 'Out of host capacity'."
  }
}

run "the_vcn_dns_label_fits_ocis_fifteen_character_limit" {
  command = plan

  variables {
    # The longest alias owner_alias now admits. If that ceiling is ever raised
    # without re-deriving it from this limit, this run fails.
    owner_alias = "abcdefghijk"
  }

  assert {
    condition     = length(oci_core_vcn.main.dns_label) <= 15
    error_message = "OCI caps VCN DNS labels at 15 characters. Exceeding it fails at apply, on an input terraform validate accepted."
  }

  assert {
    condition     = can(regex("^[a-z][a-z0-9]*$", oci_core_vcn.main.dns_label))
    error_message = "A VCN DNS label must be alphanumeric and start with a letter; hyphens and underscores are rejected by the API."
  }
}
