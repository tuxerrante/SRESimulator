terraform {
  backend "azurerm" {
    resource_group_name  = "tfstate-rg"
    storage_account_name = "youraliastrophic"
    container_name       = "tfstate"
    key                  = "sre-simulator.tfstate"
  }
}
