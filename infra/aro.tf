# ---------------------------------------------------------------------------
# Network – VNet + subnets for ARO
# ---------------------------------------------------------------------------

resource "azurerm_virtual_network" "aro" {
  count               = local.is_aro ? 1 : 0
  name                = local.vnet_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = [var.vnet_address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "master" {
  count = local.is_aro ? 1 : 0
  # Keep ARO subnets non-delegated in Terraform: delegation capabilities differ
  # by subscription/region and are validated server-side during cluster create.
  name                                          = "master-subnet"
  resource_group_name                           = azurerm_resource_group.main.name
  virtual_network_name                          = azurerm_virtual_network.aro[0].name
  address_prefixes                              = [var.master_subnet_cidr]
  private_link_service_network_policies_enabled = false
}

resource "azurerm_subnet" "worker" {
  count                = local.is_aro ? 1 : 0
  name                 = "worker-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.aro[0].name
  address_prefixes     = [var.worker_subnet_cidr]
}

# ---------------------------------------------------------------------------
# Service Principal for ARO
# ---------------------------------------------------------------------------

resource "azuread_application" "aro" {
  count = local.is_aro ? 1 : 0
  # ARO create still expects a customer SP (client_id/client_secret) that the
  # RP uses for day-2 Azure operations in this subscription.
  display_name = "${local.prefix}-aro-sp"
  owners       = [data.azurerm_client_config.current.object_id]
}

resource "azuread_service_principal" "aro" {
  count     = local.is_aro ? 1 : 0
  client_id = azuread_application.aro[0].client_id
  owners    = [data.azurerm_client_config.current.object_id]
}

resource "azuread_service_principal_password" "aro" {
  count = local.is_aro ? 1 : 0
  # ARO API requires a secret-backed SP profile. Keep expiry bounded and rotate
  # credentials out-of-band before expiration for long-lived clusters.
  service_principal_id = azuread_service_principal.aro[0].id
  end_date             = local.aro_sp_password_end_date

  lifecycle {
    # Avoid perpetual diffs from timestamp()-based end_date recomputation after
    # the secret has been created once.
    ignore_changes = [end_date]
  }
}

# Grant Contributor on the VNet so the ARO RP can manage networking
resource "azurerm_role_assignment" "aro_vnet_contributor" {
  count                = local.is_aro ? 1 : 0
  scope                = azurerm_virtual_network.aro[0].id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.aro[0].object_id
}

# The ARO RP service principal also needs Contributor on the VNet.
# Look up the well-known ARO RP application ID.
data "azuread_service_principal" "aro_rp" {
  count     = local.is_aro ? 1 : 0
  client_id = "f1dd0a37-89c6-4e07-bcd1-ffd3d43d8875" # Azure Red Hat OpenShift RP
}

resource "azurerm_role_assignment" "aro_rp_vnet_contributor" {
  count = local.is_aro ? 1 : 0
  # Separate from the customer SP above: this grants the managed ARO RP identity
  # enough rights to attach/update networking artifacts inside the VNet.
  scope                = azurerm_virtual_network.aro[0].id
  role_definition_name = "Contributor"
  principal_id         = data.azuread_service_principal.aro_rp[0].object_id
}

# ---------------------------------------------------------------------------
# ARO Cluster via azapi (azurerm does not have a native ARO resource)
# ---------------------------------------------------------------------------

resource "azapi_resource" "aro_cluster" {
  count     = local.is_aro ? 1 : 0
  type      = "Microsoft.RedHatOpenShift/openShiftClusters@2023-11-22"
  name      = local.cluster_name
  location  = azurerm_resource_group.main.location
  parent_id = azurerm_resource_group.main.id
  tags      = local.tags

  body = {
    properties = {
      clusterProfile = merge(
        {
          # Omit optional fields when unset; sending explicit nulls can force
          # invalid updates against long-lived ARO clusters.
          domain               = local.prefix
          fipsValidatedModules = "Disabled" # required by newer ARO API validation.
          # The ARO RP auto-creates this resource group to hold cluster-internal
          # resources (VMs, disks, LBs). It is managed by the RP.
          resourceGroupId = local.cluster_resource_group_id
        },
        var.aro_version != "" ? { version = var.aro_version } : {},
        var.pull_secret_path != "" ? { pullSecret = sensitive(file(var.pull_secret_path)) } : {}
      )

      networkProfile = {
        podCidr          = "10.128.0.0/14"
        serviceCidr      = "172.30.0.0/16"
        outboundType     = "Loadbalancer"
        preconfiguredNsg = "Disabled"
      }

      servicePrincipalProfile = {
        clientId     = azuread_application.aro[0].client_id
        clientSecret = azuread_service_principal_password.aro[0].value
      }

      masterProfile = {
        vmSize           = var.master_vm_size
        subnetId         = azurerm_subnet.master[0].id
        encryptionAtHost = "Disabled"
      }

      workerProfiles = [
        {
          name             = "worker"
          vmSize           = var.worker_vm_size
          diskSizeGB       = 128
          count            = var.worker_count
          subnetId         = azurerm_subnet.worker[0].id
          encryptionAtHost = "Disabled"
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

  # Keep client-side schema checks relaxed: azapi schemas can lag new/preview
  # ARO API fields, while ARM still enforces authoritative server validation.
  schema_validation_enabled = false

  timeouts {
    create = "90m"
    delete = "60m"
  }

  lifecycle {
    # ARO rejects many post-create cluster property updates through the same PUT
    # API path used by azapi. Keep cluster tags on create, but avoid tag-only
    # drift trying to mutate an otherwise healthy running cluster.
    ignore_changes = [tags]
  }

  depends_on = [
    # Ensure both principals have network rights before ARM evaluates ARO create.
    azurerm_role_assignment.aro_vnet_contributor[0],
    azurerm_role_assignment.aro_rp_vnet_contributor[0],
  ]
}

# The RP-managed cluster resource group is created outside Terraform's graph.
# Overlay required tags so cleanup/discovery tooling can identify it reliably.
data "azurerm_resource_group" "aro_cluster_rg_current" {
  count = local.is_aro && var.enable_cluster_rg_tag_overlay ? 1 : 0
  name  = local.cluster_resource_group_name

  depends_on = [
    azapi_resource.aro_cluster[0],
  ]
}

resource "azapi_update_resource" "aro_cluster_rg_tags" {
  count       = local.is_aro && var.enable_cluster_rg_tag_overlay ? 1 : 0
  type        = "Microsoft.Resources/resourceGroups@2021-04-01"
  resource_id = local.cluster_resource_group_id

  body = {
    tags = merge(
      try(data.azurerm_resource_group.aro_cluster_rg_current[0].tags, {}),
      local.tags
    )
  }

  depends_on = [
    azapi_resource.aro_cluster[0],
  ]
}
