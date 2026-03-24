terraform {
  # Partial backend config: supply storage_account_name and resource_group_name
  # at init time via -backend-config flags or TF_STATE_ACCOUNT / TF_STATE_RG
  # env vars in the Makefile.  See: make tf-init TF_STATE_ACCOUNT=<name>
  backend "azurerm" {
    container_name = "tfstate"
    key            = "sre-simulator.tfstate"
  }
}
