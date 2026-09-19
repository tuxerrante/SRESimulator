# Authentication comes from ~/.oci/config (`oci setup config`) so that no
# private key ever lands in a tfvars file or in Terraform state. The README
# documents the OCI_* environment-variable alternative for CI.
provider "oci" {
  region              = var.region
  config_file_profile = var.oci_config_file_profile
}

provider "http" {}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid

  # availability_domain_index's own validation can only bound the index
  # statically (0-2, the OCI maximum). How many domains a region actually has
  # is data, and plenty of regions have one -- eu-frankfurt-1 has three, but
  # README.md tells operators to increment the variable when A1 capacity runs
  # out, and that advice travels to other regions with the file. There, index
  # 1 passes validation and locals.availability_domain then fails with a bare
  # "Invalid index" that names neither the variable nor the reason.
  #
  # This lives on the data source, not as a precondition on the instance that
  # consumes the index, because Terraform evaluates the local before the
  # consuming resource's preconditions: tried that first, and the index error
  # pre-empted the message every time. A postcondition here is checked as soon
  # as the read returns, which is before anything can index into the result.
  lifecycle {
    postcondition {
      condition = var.availability_domain_index < length(self.availability_domains)
      error_message = format(
        "availability_domain_index is %d but this region exposes %d availability domain(s), so the highest valid index is %d.",
        var.availability_domain_index,
        length(self.availability_domains),
        length(self.availability_domains) - 1,
      )
    }
  }
}

# Canonical Ubuntu 24.04 for aarch64. Filtering by shape is what restricts the
# result to arm64 images; there is no separate architecture filter.
data "oci_core_images" "ubuntu_arm" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = var.ubuntu_version
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}
