terraform {
  # mock_provider in tests/*.tftest.hcl requires >= 1.7; the cross-variable
  # validation guarding ssh_allowed_cidrs against 0.0.0.0/0 requires >= 1.9;
  # backend.tf's use_lockfile requires >= 1.10. Unlike the Azure root this one
  # has no >= 1.5 consumers, so the floor is simply the highest feature we use.
  #
  # Raising it is free here: ci.yml pins 1.16.3 for both terraform jobs.
  required_version = ">= 1.10"

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
