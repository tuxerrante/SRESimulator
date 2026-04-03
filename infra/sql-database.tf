# ---------------------------------------------------------------------------
# Azure SQL Database (free tier)
#
# Gated behind var.enable_database (default false) so existing deployments
# are unaffected.  Uses the Azure SQL free offer: 100K vCore-seconds/month,
# 32 GB storage, built-in HA and automated backups at zero cost.
#
# Networking: By default uses a public endpoint with a firewall rule.
# For production, replace with a private endpoint inside the ARO VNet.
# ---------------------------------------------------------------------------

resource "azurerm_mssql_server" "main" {
  count               = var.enable_database ? 1 : 0
  name                = local.sql_server_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  version             = "12.0"

  administrator_login          = "sresimadmin"
  administrator_login_password = var.sql_admin_password

  minimum_tls_version = "1.2"

  tags = local.tags

  lifecycle {
    precondition {
      condition     = var.enable_database == false || var.sql_admin_password != ""
      error_message = "sql_admin_password is required when enable_database=true."
    }
    prevent_destroy = true
  }
}

resource "azurerm_mssql_database" "app" {
  count     = var.enable_database ? 1 : 0
  name      = "sresimulator"
  server_id = azurerm_mssql_server.main[0].id

  # Serverless General Purpose with free offer
  sku_name                    = "GP_S_Gen5_2"
  min_capacity                = 0.5
  auto_pause_delay_in_minutes = 60
  max_size_gb                 = 32

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

# Enable Azure SQL free offer (100K vCore-seconds/month, 32 GB).
# The azurerm provider does not yet expose use_free_limit /
# free_limit_exhaustion_behavior (hashicorp/terraform-provider-azurerm#32055),
# so we overlay them via azapi_update_resource.
resource "azapi_update_resource" "sql_free_tier" {
  count       = var.enable_database ? 1 : 0
  type        = "Microsoft.Sql/servers/databases@2023-08-01-preview"
  resource_id = azurerm_mssql_database.app[0].id

  body = {
    properties = {
      useFreeLimit                = true
      freeLimitExhaustionBehavior = "AutoPause"
    }
  }
}

# Allow connections from Azure services (including ARO worker nodes via their
# egress IPs).  start/end = 0.0.0.0 enables the special "Allow access to Azure
# services" rule.  This is intentionally broad for a dev/training tool.
# For production, replace with a VNet private endpoint or explicit egress IPs.
resource "azurerm_mssql_firewall_rule" "azure_services" {
  count            = var.enable_database ? 1 : 0
  name             = "allow-azure-services"
  server_id        = azurerm_mssql_server.main[0].id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}
