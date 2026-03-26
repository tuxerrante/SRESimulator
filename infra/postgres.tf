# ---------------------------------------------------------------------------
# Azure Database for PostgreSQL Flexible Server
#
# Gated behind var.enable_postgres (default false) so existing deployments
# are unaffected.  The server has prevent_destroy to guard against accidental
# `terraform destroy` of the resource group wiping out game data.
#
# Networking: By default uses a public endpoint with a firewall rule.
# For production, replace with a private endpoint inside the ARO VNet.
# ---------------------------------------------------------------------------

resource "azurerm_postgresql_flexible_server" "main" {
  count               = var.enable_postgres ? 1 : 0
  name                = "${local.prefix}-pg"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  version             = "16"

  sku_name   = "B_Standard_B1ms"
  storage_mb = 32768
  zone       = "1"

  administrator_login    = "sresimadmin"
  administrator_password = var.pg_admin_password

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  count     = var.enable_postgres ? 1 : 0
  name      = "sresimulator"
  server_id = azurerm_postgresql_flexible_server.main[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# Allow connections from Azure services (including ARO worker nodes via their egress IPs).
# Note: start/end = 0.0.0.0 enables the special "Allow access to Azure services" rule.
# For production, restrict to specific egress IPs or use a VNet private endpoint instead.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  count            = var.enable_postgres ? 1 : 0
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.main[0].id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}
