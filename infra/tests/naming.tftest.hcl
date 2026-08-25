mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      client_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000003"
      tenant_id       = "00000000-0000-0000-0000-000000000004"
    }
  }
}
mock_provider "azapi" {}
mock_provider "azuread" {
  mock_data "azuread_service_principal" {
    defaults = {
      object_id = "00000000-0000-0000-0000-000000000005"
    }
  }
}

variables {
  owner_alias    = "jdoe"
  cluster_flavor = "aro"
}

# ---------------------------------------------------------------------------
# Resource naming convention: all names derive from "<owner_alias>-test"
# ---------------------------------------------------------------------------

run "resource_group_name" {
  command = plan

  assert {
    condition     = azurerm_resource_group.main.name == "jdoe-test-rg"
    error_message = "Resource group should be named <alias>-test-rg."
  }
}

run "vnet_name" {
  command = plan

  assert {
    condition     = azurerm_virtual_network.aro[0].name == "jdoe-test-vnet"
    error_message = "VNet should be named <alias>-test-vnet."
  }
}

run "subnet_names" {
  command = plan

  assert {
    condition     = azurerm_subnet.master[0].name == "master-subnet"
    error_message = "Master subnet should be named master-subnet."
  }

  assert {
    condition     = azurerm_subnet.worker[0].name == "worker-subnet"
    error_message = "Worker subnet should be named worker-subnet."
  }
}

run "aro_cluster_name" {
  command = plan

  assert {
    condition     = azapi_resource.aro_cluster[0].name == "jdoe-test"
    error_message = "ARO cluster should be named <alias>-test."
  }
}

run "service_principal_display_name" {
  command = plan

  assert {
    condition     = azuread_application.aro[0].display_name == "jdoe-test-aro-sp"
    error_message = "Service principal app should be named <alias>-test-aro-sp."
  }
}

run "aoai_account_name" {
  command = plan

  assert {
    condition     = azurerm_cognitive_account.openai.name == "jdoe-test-aoai"
    error_message = "Azure OpenAI account should be named <alias>-test-aoai."
  }

  assert {
    condition     = azurerm_cognitive_account.openai.custom_subdomain_name == "jdoe-test-aoai"
    error_message = "Azure OpenAI subdomain should match account name."
  }
}

run "aoai_deployment_name" {
  command = plan

  assert {
    condition     = azurerm_cognitive_deployment.model.name == "gpt-5.6-terra"
    error_message = "Azure OpenAI deployment name should match the model name variable."
  }
}

run "aoai_command_deployment_name" {
  command = plan

  assert {
    condition     = one(azurerm_cognitive_deployment.command[*].name) == "gpt-5-mini"
    error_message = "Command-route deployment should default to the gpt-5-mini deployment name."
  }

  assert {
    condition     = one(azurerm_cognitive_deployment.command[*].model[0].name) == "gpt-5-mini"
    error_message = "Command-route deployment should default to the gpt-5-mini model."
  }
}

run "aoai_command_alias_differs_from_model" {
  command = plan

  variables {
    aoai_command_deployment_name = "command-fast"
    aoai_command_model_name      = "gpt-5-mini"
  }

  assert {
    condition     = one(azurerm_cognitive_deployment.command[*].name) == "command-fast"
    error_message = "Command-route deployment alias should be independent of the model name."
  }

  assert {
    condition     = one(azurerm_cognitive_deployment.command[*].model[0].name) == "gpt-5-mini"
    error_message = "Changing the command-route deployment alias must not change the model name."
  }
}

run "aoai_command_deployment_disabled" {
  command = plan

  variables {
    enable_aoai_command_deployment = false
  }

  assert {
    condition     = length(azurerm_cognitive_deployment.command) == 0
    error_message = "Command-route deployment must not be created when disabled."
  }
}

# Verify naming changes when alias changes
run "different_alias_propagates" {
  command = plan

  variables {
    owner_alias = "zsmith"
  }

  assert {
    condition     = azurerm_resource_group.main.name == "zsmith-test-rg"
    error_message = "Resource group name should update when owner_alias changes."
  }

  assert {
    condition     = azapi_resource.aro_cluster[0].name == "zsmith-test"
    error_message = "Cluster name should update when owner_alias changes."
  }

  assert {
    condition     = azurerm_cognitive_account.openai.name == "zsmith-test-aoai"
    error_message = "AOAI account name should update when owner_alias changes."
  }
}
