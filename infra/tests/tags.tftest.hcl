mock_provider "azurerm" {}
mock_provider "azapi" {}
mock_provider "azuread" {}

variables {
  owner_alias = "jdoe"
}

# ---------------------------------------------------------------------------
# Tags: mandatory labels are applied to all taggable resources
# ---------------------------------------------------------------------------

run "resource_group_has_required_tags" {
  command = plan

  assert {
    condition     = azurerm_resource_group.main.tags["environment"] == "test"
    error_message = "Resource group must have environment=test tag."
  }

  assert {
    condition     = azurerm_resource_group.main.tags["owner"] == "jdoe"
    error_message = "Resource group must have owner tag matching owner_alias."
  }

  assert {
    condition     = azurerm_resource_group.main.tags["project"] == "sre-simulator"
    error_message = "Resource group must have project=sre-simulator tag."
  }

  assert {
    condition     = azurerm_resource_group.main.tags["auto-delete"] == "safe-to-delete"
    error_message = "Resource group must have auto-delete=safe-to-delete tag."
  }
}

run "vnet_has_required_tags" {
  command = plan

  assert {
    condition     = azurerm_virtual_network.aro.tags["environment"] == "test"
    error_message = "VNet must have environment=test tag."
  }

  assert {
    condition     = azurerm_virtual_network.aro.tags["owner"] == "jdoe"
    error_message = "VNet must have owner tag matching owner_alias."
  }
}

run "aoai_has_required_tags" {
  command = plan

  assert {
    condition     = azurerm_cognitive_account.openai.tags["environment"] == "test"
    error_message = "Azure OpenAI account must have environment=test tag."
  }

  assert {
    condition     = azurerm_cognitive_account.openai.tags["owner"] == "jdoe"
    error_message = "Azure OpenAI account must have owner tag matching owner_alias."
  }
}

run "extra_tags_merge" {
  command = plan

  variables {
    owner_alias = "jdoe"
    extra_tags = {
      team       = "platform"
      cost-center = "eng-42"
    }
  }

  assert {
    condition     = azurerm_resource_group.main.tags["team"] == "platform"
    error_message = "Extra tags should be merged into resource group tags."
  }

  assert {
    condition     = azurerm_resource_group.main.tags["cost-center"] == "eng-42"
    error_message = "Extra tags should be merged into resource group tags."
  }

  assert {
    condition     = azurerm_resource_group.main.tags["environment"] == "test"
    error_message = "Mandatory tags must still be present after merging extra tags."
  }
}
