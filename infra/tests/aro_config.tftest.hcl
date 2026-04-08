mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      client_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000003"
      tenant_id       = "00000000-0000-0000-0000-000000000004"
    }
  }

  mock_data "azurerm_resource_group" {
    defaults = {
      tags = {
        createdAt = "2026-04-08T00:00:00Z"
      }
    }
  }
}
mock_provider "azapi" {}
mock_provider "azuread" {
  mock_data "azuread_service_principal" {
    defaults = {
      object_id = "00000000-0000-0000-0000-000000000005"
    }
  }
}

variables {
  owner_alias = "jdoe"
}

# ---------------------------------------------------------------------------
# ARO cluster configuration – API/ingress visibility, network profiles
# ---------------------------------------------------------------------------

run "aro_resource_type" {
  command = plan

  assert {
    condition     = azapi_resource.aro_cluster.type == "Microsoft.RedHatOpenShift/openShiftClusters@2023-11-22"
    error_message = "ARO cluster must use the correct Azure API resource type."
  }
}

run "aro_cluster_tags_applied" {
  command = plan

  assert {
    condition     = azapi_resource.aro_cluster.tags["environment"] == "test"
    error_message = "ARO cluster resource must have environment=test tag."
  }

  assert {
    condition     = azapi_resource.aro_cluster.tags["owner"] == "jdoe"
    error_message = "ARO cluster resource must have owner tag matching alias."
  }

  assert {
    condition     = azapi_resource.aro_cluster.tags["persist"] == "true"
    error_message = "ARO cluster resource must have persist=true tag."
  }
}

run "aro_cluster_domain" {
  command = plan

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.clusterProfile.domain == "jdoe-test"
    error_message = "ARO cluster domain should match the prefix (<alias>-test)."
  }

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.clusterProfile.resourceGroupId == "/subscriptions/00000000-0000-0000-0000-000000000003/resourcegroups/jdoe-test-cluster-rg"
    error_message = "ARO cluster profile should target the RP-managed cluster resource group."
  }
}

run "aro_cluster_rg_tags_overlay" {
  command = plan

  assert {
    condition     = azapi_update_resource.aro_cluster_rg_tags[0].type == "Microsoft.Resources/resourceGroups@2021-04-01"
    error_message = "Cluster RG tag overlay should use the resource group ARM type."
  }

  assert {
    condition     = azapi_update_resource.aro_cluster_rg_tags[0].resource_id == "/subscriptions/00000000-0000-0000-0000-000000000003/resourcegroups/jdoe-test-cluster-rg"
    error_message = "Cluster RG tag overlay should target the RP-managed cluster resource group id."
  }

  # body.tags is computed from runtime RG tags + local tags; that merged map is
  # unknown at plan time in tests, so assert target wiring instead.
}

run "aro_cluster_rg_tags_overlay_can_be_disabled" {
  command = plan

  variables {
    owner_alias                   = "jdoe"
    enable_cluster_rg_tag_overlay = false
  }

  assert {
    condition     = length(azapi_update_resource.aro_cluster_rg_tags) == 0
    error_message = "Cluster RG tag overlay should be omitted when enable_cluster_rg_tag_overlay=false."
  }
}

run "aro_network_profile" {
  command = plan

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.networkProfile.podCidr == "10.128.0.0/14"
    error_message = "ARO pod CIDR should be 10.128.0.0/14."
  }

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.networkProfile.serviceCidr == "172.30.0.0/16"
    error_message = "ARO service CIDR should be 172.30.0.0/16."
  }

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.networkProfile.outboundType == "Loadbalancer"
    error_message = "ARO outboundType must be explicitly set to Loadbalancer."
  }

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.networkProfile.preconfiguredNsg == "Disabled"
    error_message = "ARO preconfiguredNsg must be explicitly set to Disabled."
  }
}

run "aro_api_public" {
  command = plan

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.apiserverProfile.visibility == "Public"
    error_message = "ARO API server should be public for test cluster."
  }
}

run "aro_ingress_public" {
  command = plan

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.ingressProfiles[0].visibility == "Public"
    error_message = "ARO default ingress should be public for test cluster."
  }
}

run "aro_worker_disk_size" {
  command = plan

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.workerProfiles[0].diskSizeGB == 128
    error_message = "ARO worker disk size should be 128 GB."
  }
}

run "aro_security_profile_defaults" {
  command = plan

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.clusterProfile.fipsValidatedModules == "Disabled"
    error_message = "ARO FIPS modules setting must be explicitly set to Disabled."
  }

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.masterProfile.encryptionAtHost == "Disabled"
    error_message = "ARO masterProfile.encryptionAtHost must be explicitly set to Disabled."
  }

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.workerProfiles[0].encryptionAtHost == "Disabled"
    error_message = "ARO workerProfile.encryptionAtHost must be explicitly set to Disabled."
  }
}

run "aro_sp_password_expiry" {
  command = plan

  assert {
    condition     = azuread_service_principal_password.aro.end_date_relative == "8760h"
    error_message = "Service principal password should expire after 1 year (8760h)."
  }
}

run "aro_role_assignments_are_contributor" {
  command = plan

  assert {
    condition     = azurerm_role_assignment.aro_vnet_contributor.role_definition_name == "Contributor"
    error_message = "ARO SP role assignment on VNet should be Contributor."
  }

  assert {
    condition     = azurerm_role_assignment.aro_rp_vnet_contributor.role_definition_name == "Contributor"
    error_message = "ARO RP role assignment on VNet should be Contributor."
  }
}

run "subnets_not_delegated" {
  command = plan

  assert {
    condition     = length(azurerm_subnet.master.delegation) == 0
    error_message = "Master subnet must not be delegated; ARO creates private endpoints in this subnet."
  }

  assert {
    condition     = length(azurerm_subnet.worker.delegation) == 0
    error_message = "Worker subnet must not be delegated."
  }
}
