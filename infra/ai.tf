# ---------------------------------------------------------------------------
# Azure OpenAI (Cognitive Services) - single account + deployment
# ---------------------------------------------------------------------------
#
# Per PR #31 spike results, all routes can share a single gpt-4o-mini deployment.
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
