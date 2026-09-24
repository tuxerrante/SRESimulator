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
# The Always Free A1 envelope is 2 OCPU / 12 GB / 200 GB block storage in
# total across the tenancy (1,500 OCPU-hours and 9,000 GB-hours a month). The
# defaults here spend the whole compute allowance; there is no room for a
# second instance.
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

  # 3, not some large number: it passes the old, wrong 4 OCPU ceiling and
  # fails the correct one, so this run discriminates between them.
  variables {
    instance_ocpus = 3
  }

  expect_failures = [
    var.instance_ocpus,
  ]
}

run "memory_above_allowance_rejected" {
  command = plan

  # 13 for the same reason -- inside the old, wrong 24 GB ceiling.
  variables {
    instance_memory_gbs = 13
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

# ---------------------------------------------------------------------------
# instance_shape is an allowlist, not advice.
#
# A mistyped shape is accepted by the OCI API, provisions successfully, and
# yields a working box indistinguishable from the intended one in the apply
# output. The first signal that it was billable is the invoice. An output
# warning is read after the resource exists, so only a plan-time refusal can
# actually prevent this.
# ---------------------------------------------------------------------------
run "a_shape_outside_the_always_free_family_is_rejected" {
  command = plan

  variables {
    # One character away from the free shape, and billable by the hour.
    instance_shape = "VM.Standard.A2.Flex"
  }

  expect_failures = [
    var.instance_shape,
  ]
}

run "a_billable_shape_requires_the_explicit_opt_in" {
  command = plan

  variables {
    instance_shape       = "VM.Standard.E5.Flex"
    allow_billable_shape = true
  }

  # No expect_failures: a deliberate paid upgrade stays available, it just has
  # to say so. This is what keeps the allowlist from being a dead end.
  assert {
    condition     = oci_core_instance.k3s.shape == "VM.Standard.E5.Flex"
    error_message = "allow_billable_shape must let a deliberately chosen paid shape through to the instance."
  }
}

run "the_allowance_ceilings_lift_with_the_billable_opt_in" {
  command = plan

  variables {
    instance_shape       = "VM.Standard.E5.Flex"
    allow_billable_shape = true
    instance_ocpus       = 8
    instance_memory_gbs  = 64
  }

  # The 2 OCPU / 12 GB ceilings encode the Always Free allowance. Leaving them
  # in force under a paid shape would make the upgrade pointless, so the same
  # opt-in releases all three.
  assert {
    condition = (
      one(oci_core_instance.k3s.shape_config).ocpus == 8 &&
      one(oci_core_instance.k3s.shape_config).memory_in_gbs == 64
    )
    error_message = "allow_billable_shape must lift the Always Free OCPU and memory ceilings."
  }
}

run "the_allowance_ceilings_still_bind_without_the_opt_in" {
  command = plan

  variables {
    # Same sizing as the run above, but no opt-in. The ceiling must hold, or
    # the run above would be proving nothing.
    instance_ocpus = 8
  }

  expect_failures = [
    var.instance_ocpus,
  ]
}

# ---------------------------------------------------------------------------
# The ceilings are keyed off the opt-in, not off the shape family, and on an A1
# shape that distinction is the whole finding.
#
# 2 OCPU / 12 GB is the Always Free *allowance*. It is not A1.Flex's maximum --
# the shape accepts up to 76 OCPU / 472 GB -- so a bigger A1 is an ordinary
# instance OCI provisions and bills, not a configuration it rejects. Keying the
# ceiling off the shape family would therefore have refused a purchase the
# opt-in exists to authorize, while an earlier 4 OCPU / 24 GB ceiling let twice
# the free allowance through under a message promising it was free.
# ---------------------------------------------------------------------------
run "the_opt_in_lifts_the_ocpu_ceiling_on_an_a1_shape_too" {
  command = plan

  variables {
    instance_shape       = "VM.Standard.A1.Flex"
    allow_billable_shape = true
    instance_ocpus       = 8
  }

  assert {
    condition     = one(oci_core_instance.k3s.shape_config).ocpus == 8
    error_message = "allow_billable_shape must lift the OCPU ceiling on an A1 shape; A1.Flex bills happily past the free allowance."
  }
}

run "the_opt_in_lifts_the_memory_ceiling_on_an_a1_shape_too" {
  command = plan

  variables {
    instance_shape       = "VM.Standard.A1.Flex"
    allow_billable_shape = true
    instance_memory_gbs  = 64
  }

  assert {
    condition     = one(oci_core_instance.k3s.shape_config).memory_in_gbs == 64
    error_message = "allow_billable_shape must lift the memory ceiling on an A1 shape."
  }
}
