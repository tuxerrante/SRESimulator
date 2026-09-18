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
# Freeform tags mirror the Azure root so a cost report can be grouped the same
# way across both clouds.
# ---------------------------------------------------------------------------

run "instance_carries_the_standard_tags" {
  command = plan

  assert {
    condition     = oci_core_instance.k3s.freeform_tags["project"] == "sre-simulator"
    error_message = "project tag should be sre-simulator."
  }

  assert {
    condition     = oci_core_instance.k3s.freeform_tags["owner"] == "jdoe"
    error_message = "owner tag should be the owner_alias."
  }

  assert {
    condition     = oci_core_instance.k3s.freeform_tags["environment"] == "free"
    error_message = "environment tag should be free, distinguishing it from the Azure root's test environment."
  }
}

run "auto_delete_tag_is_protective" {
  command = plan

  assert {
    condition     = oci_core_instance.k3s.freeform_tags["auto-delete"] == "do-not-delete"
    error_message = "Unlike the Azure test environment this box is long-lived; the auto-delete tag must not invite a cleaner to remove it."
  }
}

run "network_resources_are_tagged_too" {
  command = plan

  assert {
    condition     = oci_core_vcn.main.freeform_tags["project"] == "sre-simulator"
    error_message = "VCN should carry the standard tags."
  }

  assert {
    condition     = oci_core_network_security_group.instance.freeform_tags["project"] == "sre-simulator"
    error_message = "NSG should carry the standard tags."
  }
}

run "extra_tags_are_merged" {
  command = plan

  variables {
    extra_tags = { cost-center = "demo" }
  }

  assert {
    condition     = oci_core_instance.k3s.freeform_tags["cost-center"] == "demo"
    error_message = "extra_tags should merge into the standard tag set."
  }

  assert {
    condition     = oci_core_instance.k3s.freeform_tags["project"] == "sre-simulator"
    error_message = "extra_tags must not displace the standard tags."
  }
}
