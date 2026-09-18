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
# The Always Free A1 envelope is 4 OCPU / 24 GB / 200 GB block storage in
# total across the tenancy. Defaults here use half the compute allowance so a
# second instance remains possible.
# ---------------------------------------------------------------------------

run "default_shape_is_the_free_arm_shape" {
  command = plan

  assert {
    condition     = oci_core_instance.k3s.shape == "VM.Standard.A1.Flex"
    error_message = "Default shape must be VM.Standard.A1.Flex; it is the only Always Free shape with usable memory."
  }
}

run "default_sizing_stays_inside_the_free_allowance" {
  command = plan

  assert {
    condition     = one(oci_core_instance.k3s.shape_config).ocpus == 2
    error_message = "Default OCPUs should be 2."
  }

  assert {
    condition     = one(oci_core_instance.k3s.shape_config).memory_in_gbs == 12
    error_message = "Default memory should be 12 GB."
  }
}

run "boot_volume_default" {
  command = plan

  assert {
    condition     = tonumber(one(oci_core_instance.k3s.source_details).boot_volume_size_in_gbs) == 60
    error_message = "Default boot volume should be 60 GB, comfortably inside the 200 GB free total."
  }
}

run "ocpus_above_allowance_rejected" {
  command = plan

  variables {
    instance_ocpus = 5
  }

  expect_failures = [
    var.instance_ocpus,
  ]
}

run "memory_above_allowance_rejected" {
  command = plan

  variables {
    instance_memory_gbs = 32
  }

  expect_failures = [
    var.instance_memory_gbs,
  ]
}

run "boot_volume_below_minimum_rejected" {
  command = plan

  variables {
    boot_volume_size_gbs = 40
  }

  expect_failures = [
    var.boot_volume_size_gbs,
  ]
}
