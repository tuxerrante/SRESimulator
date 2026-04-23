# ---------------------------------------------------------------------------
# Network - VNet + subnet for AKS
# ---------------------------------------------------------------------------

resource "azurerm_virtual_network" "aks" {
  count               = local.is_aks ? 1 : 0
  name                = local.aks_vnet_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = [var.aks_vnet_address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "aks" {
  count                = local.is_aks ? 1 : 0
  name                 = local.aks_node_subnet_name
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.aks[0].name
  address_prefixes     = [var.aks_node_subnet_cidr]
}

resource "azurerm_public_ip" "aks_ingress" {
  count               = local.is_aks ? 1 : 0
  name                = local.aks_ingress_public_ip_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
  domain_name_label   = local.aks_dns_prefix
  tags                = local.tags
}

# ---------------------------------------------------------------------------
# AKS Cluster - minimal cost defaults with a single autoscaled system pool
# ---------------------------------------------------------------------------

resource "azurerm_kubernetes_cluster" "aks" {
  count               = local.is_aks ? 1 : 0
  name                = local.cluster_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = local.aks_dns_prefix
  sku_tier            = "Free"
  node_resource_group = local.aks_node_resource_group_name
  kubernetes_version  = var.aks_kubernetes_version != "" ? var.aks_kubernetes_version : null
  tags                = local.tags

  default_node_pool {
    name                 = "system"
    vm_size              = var.aks_node_vm_size
    type                 = "VirtualMachineScaleSets"
    auto_scaling_enabled = true
    min_count            = var.aks_node_count_min
    max_count            = var.aks_node_count_max
    node_count           = var.aks_node_count_min
    vnet_subnet_id       = azurerm_subnet.aks[0].id
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin    = "azure"
    network_policy    = "azure"
    load_balancer_sku = "standard"
    outbound_type     = "loadBalancer"
    service_cidr      = var.aks_service_cidr
    dns_service_ip    = var.aks_dns_service_ip
  }

  lifecycle {
    # The cluster autoscaler updates node_count outside Terraform. Keep the
    # configured min/max bounds authoritative but ignore current live count.
    ignore_changes = [default_node_pool[0].node_count]
  }
}

resource "azurerm_role_assignment" "aks_main_rg_network_contributor" {
  count                = local.is_aks ? 1 : 0
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_kubernetes_cluster.aks[0].identity[0].principal_id
}
