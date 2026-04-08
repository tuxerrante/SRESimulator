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

# ---------------------------------------------------------------------------
# owner_alias validation
# ---------------------------------------------------------------------------

run "owner_alias_valid_short" {
  command = plan

  variables {
    owner_alias = "abc"
  }

  assert {
    condition     = azurerm_resource_group.main.name == "abc-test-rg"
    error_message = "Resource group name should be derived from owner_alias."
  }
}

run "owner_alias_valid_long" {
  command = plan

  variables {
    owner_alias = "jdoe1234"
  }

  assert {
    condition     = azurerm_resource_group.main.name == "jdoe1234-test-rg"
    error_message = "Resource group name should be derived from owner_alias."
  }
}

run "owner_alias_reject_uppercase" {
  command = plan

  variables {
    owner_alias = "JDoe"
  }

  expect_failures = [
    var.owner_alias,
  ]
}

run "owner_alias_reject_too_short" {
  command = plan

  variables {
    owner_alias = "ab"
  }

  expect_failures = [
    var.owner_alias,
  ]
}

run "owner_alias_reject_starts_with_number" {
  command = plan

  variables {
    owner_alias = "1abc"
  }

  expect_failures = [
    var.owner_alias,
  ]
}

run "owner_alias_reject_special_chars" {
  command = plan

  variables {
    owner_alias = "j-doe"
  }

  expect_failures = [
    var.owner_alias,
  ]
}

# ---------------------------------------------------------------------------
# worker_count validation
# ---------------------------------------------------------------------------

run "worker_count_minimum_accepted" {
  command = plan

  variables {
    owner_alias  = "test"
    worker_count = 2
  }

  assert {
    condition     = var.worker_count == 2
    error_message = "Minimum worker count of 2 should be accepted."
  }
}

run "worker_count_below_minimum_rejected" {
  command = plan

  variables {
    owner_alias  = "test"
    worker_count = 1
  }

  expect_failures = [
    var.worker_count,
  ]
}

run "cluster_rg_tag_overlay_default_enabled" {
  command = plan

  variables {
    owner_alias = "test"
  }

  assert {
    condition     = var.enable_cluster_rg_tag_overlay == true
    error_message = "Cluster RG tag overlay should be enabled by default."
  }
}
