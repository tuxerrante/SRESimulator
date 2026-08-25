provider "azurerm" {
  features {}
}

provider "azapi" {}

provider "azuread" {}

data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "main" {
  name     = local.resource_group_name
  location = var.location
  tags     = local.tags

  lifecycle {
    # Azure policy stamps this creation timestamp; Terraform must not remove it.
    ignore_changes = [tags["createdAt"]]
  }
}
