terraform {
  # mock_provider in tests/*.tftest.hcl requires >= 1.7; the cross-variable
  # validation guarding ssh_allowed_cidrs against 0.0.0.0/0 requires >= 1.9.
  # Unlike the Azure root this one has no >= 1.5 consumers, so the floor is
  # simply the highest feature we use.
  required_version = ">= 1.9"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 9.2"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}
