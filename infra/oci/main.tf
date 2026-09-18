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
