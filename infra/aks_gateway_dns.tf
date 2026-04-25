# ---------------------------------------------------------------------------
# AKS Gateway DNS automation - custom host record + cert-manager identity
# ---------------------------------------------------------------------------

data "azurerm_dns_zone" "aks_public" {
  count               = local.aks_gateway_enabled ? 1 : 0
  name                = var.aks_dns_zone_name
  resource_group_name = var.aks_dns_zone_resource_group_name
}

resource "azurerm_user_assigned_identity" "aks_dns_solver" {
  count               = local.aks_gateway_enabled ? 1 : 0
  name                = local.aks_cert_manager_identity_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "aks_dns_solver_zone_contributor" {
  count                = local.aks_gateway_enabled ? 1 : 0
  scope                = data.azurerm_dns_zone.aks_public[0].id
  role_definition_name = "DNS Zone Contributor"
  principal_id         = azurerm_user_assigned_identity.aks_dns_solver[0].principal_id
}

resource "azurerm_federated_identity_credential" "aks_dns_solver_cert_manager" {
  count                     = local.aks_gateway_enabled ? 1 : 0
  name                      = "cert-manager"
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = azurerm_kubernetes_cluster.aks[0].oidc_issuer_url
  user_assigned_identity_id = azurerm_user_assigned_identity.aks_dns_solver[0].id
  subject                   = "system:serviceaccount:cert-manager:cert-manager"
}

resource "azurerm_dns_a_record" "aks_gateway_host" {
  count               = local.aks_gateway_enabled ? 1 : 0
  name                = local.aks_gateway_record_name
  zone_name           = data.azurerm_dns_zone.aks_public[0].name
  resource_group_name = data.azurerm_dns_zone.aks_public[0].resource_group_name
  ttl                 = 300
  target_resource_id  = azurerm_public_ip.aks_ingress[0].id
  tags                = local.tags
}
