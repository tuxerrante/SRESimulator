mock_provider "azurerm" {}
mock_provider "azapi" {}
mock_provider "azuread" {}

variables {
  owner_alias = "jdoe"
}

# ---------------------------------------------------------------------------
# ARO cluster sizing – verify defaults are minimal and configurable
# ---------------------------------------------------------------------------

run "default_master_vm_size" {
  command = plan

  assert {
    condition     = var.master_vm_size == "Standard_D8s_v3"
    error_message = "Default master VM size should be Standard_D8s_v3 (minimum for control plane)."
  }
}

run "default_worker_vm_size" {
  command = plan

  assert {
    condition     = var.worker_vm_size == "Standard_D4s_v3"
    error_message = "Default worker VM size should be Standard_D4s_v3."
  }
}

run "default_worker_count" {
  command = plan

  assert {
    condition     = var.worker_count == 2
    error_message = "Default worker count should be 2 (minimum for ARO)."
  }
}

run "custom_worker_sizing" {
  command = plan

  variables {
    owner_alias    = "jdoe"
    worker_vm_size = "Standard_D8s_v3"
    worker_count   = 4
  }

  assert {
    condition     = var.worker_vm_size == "Standard_D8s_v3"
    error_message = "Custom worker VM size should be accepted."
  }

  assert {
    condition     = var.worker_count == 4
    error_message = "Custom worker count should be accepted."
  }
}

# ---------------------------------------------------------------------------
# Azure OpenAI sizing – verify cost-optimized defaults
# ---------------------------------------------------------------------------

run "default_aoai_model" {
  command = plan

  assert {
    condition     = var.aoai_model_name == "gpt-4o-mini"
    error_message = "Default model should be gpt-4o-mini (cheapest, per PR #31)."
  }
}

run "default_aoai_capacity" {
  command = plan

  assert {
    condition     = var.aoai_capacity == 1
    error_message = "Default AOAI capacity should be 1 (1K TPM minimum)."
  }
}

run "aoai_sku_is_s0" {
  command = plan

  assert {
    condition     = azurerm_cognitive_account.openai.sku_name == "S0"
    error_message = "Azure OpenAI SKU must be S0 (only option for OpenAI kind)."
  }
}

run "aoai_kind_is_openai" {
  command = plan

  assert {
    condition     = azurerm_cognitive_account.openai.kind == "OpenAI"
    error_message = "Cognitive account kind must be OpenAI."
  }
}

# ---------------------------------------------------------------------------
# Network addressing defaults
# ---------------------------------------------------------------------------

run "default_vnet_address_space" {
  command = plan

  assert {
    condition     = azurerm_virtual_network.aro.address_space[0] == "10.0.0.0/22"
    error_message = "Default VNet address space should be 10.0.0.0/22."
  }
}

run "default_subnet_cidrs" {
  command = plan

  assert {
    condition     = azurerm_subnet.master.address_prefixes[0] == "10.0.0.0/23"
    error_message = "Default master subnet CIDR should be 10.0.0.0/23."
  }

  assert {
    condition     = azurerm_subnet.worker.address_prefixes[0] == "10.0.2.0/23"
    error_message = "Default worker subnet CIDR should be 10.0.2.0/23."
  }
}
