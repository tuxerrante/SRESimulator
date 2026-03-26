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
  name                = "${local.prefix}-sql"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  version             = "12.0"

  administrator_login          = "sresimadmin"
  administrator_login_password = var.sql_admin_password

  minimum_tls_version = "1.2"

  tags = local.tags

  lifecycle {
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

  # Enable Azure SQL free offer (100K vCore-seconds/month, 32 GB)
  free_limit                     = true
  free_limit_exhaustion_behavior = "AutoPause"

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

# Allow connections from Azure services (including ARO worker nodes).
resource "azurerm_mssql_firewall_rule" "azure_services" {
  count            = var.enable_database ? 1 : 0
  name             = "allow-azure-services"
  server_id        = azurerm_mssql_server.main[0].id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}
