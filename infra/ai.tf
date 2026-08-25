# ---------------------------------------------------------------------------
# Azure OpenAI (Cognitive Services) - single account + deployment
# ---------------------------------------------------------------------------
#
# All routes can share the default deployment.
# Per-route overrides (e.g. a more capable model for chat) are handled at the
# application layer via AI_AZURE_OPENAI_DEPLOYMENT_<ROUTE> env vars.

resource "azurerm_cognitive_account" "openai" {
  name                  = local.aoai_account_name
  location              = azurerm_resource_group.main.location
  resource_group_name   = azurerm_resource_group.main.name
  kind                  = "OpenAI"
  sku_name              = "S0"
  custom_subdomain_name = local.aoai_account_name
  tags                  = local.tags
}

resource "azurerm_cognitive_deployment" "model" {
  name                 = var.aoai_model_name
  cognitive_account_id = azurerm_cognitive_account.openai.id

  model {
    format  = "OpenAI"
    name    = var.aoai_model_name
    version = var.aoai_model_version
  }

  sku {
    name     = var.aoai_sku_name
    capacity = var.aoai_capacity
  }
}

# Fast, low-reasoning deployment for the command route (deterministic CLI/KQL
# output formatting). Without it, the command route falls back to the heavy
# global deployment above and routinely exceeds the 12s command timeout, which
# the app degrades to a mock response ending in "Error: timeout". Wire the app
# to this deployment's name via AOAI_DEPLOYMENT_COMMAND /
# AI_AZURE_OPENAI_DEPLOYMENT_COMMAND (see outputs.tf env_file_snippet).
resource "azurerm_cognitive_deployment" "command" {
  count                = var.enable_aoai_command_deployment ? 1 : 0
  name                 = var.aoai_command_deployment_name
  cognitive_account_id = azurerm_cognitive_account.openai.id

  model {
    format  = "OpenAI"
    name    = var.aoai_command_model_name
    version = var.aoai_command_model_version
  }

  sku {
    name     = var.aoai_command_sku_name
    capacity = var.aoai_command_capacity
  }

  # Azure serializes deployment mutations on a single account; creating this in
  # parallel with the primary deployment can return HTTP 409. Force ordering.
  depends_on = [azurerm_cognitive_deployment.model]
}
