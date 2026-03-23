# ---------------------------------------------------------------------------
# Network – VNet + subnets for ARO
# ---------------------------------------------------------------------------

resource "azurerm_virtual_network" "aro" {
  name                = local.vnet_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = [var.vnet_address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "master" {
  name                 = "master-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.aro.name
  address_prefixes     = [var.master_subnet_cidr]

  # ARO requires the Microsoft.RedHatOpenShift RP to join the subnet
  delegation {
    name = "aro-master"
    service_delegation {
      name = "Microsoft.RedHatOpenShift/openShiftClusters"
    }
  }
}

resource "azurerm_subnet" "worker" {
  name                 = "worker-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.aro.name
  address_prefixes     = [var.worker_subnet_cidr]

  delegation {
    name = "aro-worker"
    service_delegation {
      name = "Microsoft.RedHatOpenShift/openShiftClusters"
    }
  }
}

# ---------------------------------------------------------------------------
# Service Principal for ARO
# ---------------------------------------------------------------------------

resource "azuread_application" "aro" {
  display_name = "${local.prefix}-aro-sp"
  owners       = [data.azurerm_client_config.current.object_id]
}

resource "azuread_service_principal" "aro" {
  client_id = azuread_application.aro.client_id
  owners    = [data.azurerm_client_config.current.object_id]
}

resource "azuread_service_principal_password" "aro" {
  service_principal_id = azuread_service_principal.aro.id
  end_date_relative    = "8760h" # 1 year
}

# Grant Contributor on the VNet so the ARO RP can manage networking
resource "azurerm_role_assignment" "aro_vnet_contributor" {
  scope                = azurerm_virtual_network.aro.id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.aro.object_id
}

# The ARO RP service principal also needs Contributor on the VNet.
# Look up the well-known ARO RP application ID.
data "azuread_service_principal" "aro_rp" {
  client_id = "f1dd0a37-89c6-4e07-bcd1-ffd3d43d8875" # Azure Red Hat OpenShift RP
}

resource "azurerm_role_assignment" "aro_rp_vnet_contributor" {
  scope                = azurerm_virtual_network.aro.id
  role_definition_name = "Contributor"
  principal_id         = data.azuread_service_principal.aro_rp.object_id
}

# ---------------------------------------------------------------------------
# ARO Cluster via azapi (azurerm does not have a native ARO resource)
# ---------------------------------------------------------------------------

resource "azapi_resource" "aro_cluster" {
  type      = "Microsoft.RedHatOpenShift/openShiftClusters@2023-11-22"
  name      = local.cluster_name
  location  = azurerm_resource_group.main.location
  parent_id = azurerm_resource_group.main.id
  tags      = local.tags

  body = {
    properties = {
      clusterProfile = {
        domain          = local.prefix
        resourceGroupId = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/resourceGroups/${local.prefix}-cluster-rg"
        version         = var.aro_version != "" ? var.aro_version : null
        pullSecret      = var.pull_secret_path != "" ? file(var.pull_secret_path) : null
      }

      networkProfile = {
        podCidr     = "10.128.0.0/14"
        serviceCidr = "172.30.0.0/16"
      }

      servicePrincipalProfile = {
        clientId     = azuread_application.aro.client_id
        clientSecret = azuread_service_principal_password.aro.value
      }

      masterProfile = {
        vmSize   = var.master_vm_size
        subnetId = azurerm_subnet.master.id
      }

      workerProfiles = [
        {
          name       = "worker"
          vmSize     = var.worker_vm_size
          diskSizeGB = 128
          count      = var.worker_count
          subnetId   = azurerm_subnet.worker.id
        }
      ]

      apiserverProfile = {
        visibility = "Public"
      }

      ingressProfiles = [
        {
          name       = "default"
          visibility = "Public"
        }
      ]
    }
  }

  schema_validation_enabled = false

  timeouts {
    create = "90m"
    delete = "60m"
  }

  depends_on = [
    azurerm_role_assignment.aro_vnet_contributor,
    azurerm_role_assignment.aro_rp_vnet_contributor,
  ]
}
