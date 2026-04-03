mock_provider "azurerm" {}
mock_provider "azapi" {}
mock_provider "azuread" {}

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
}

run "aro_cluster_domain" {
  command = plan

  assert {
    condition     = azapi_resource.aro_cluster.body.properties.clusterProfile.domain == "jdoe-test"
    error_message = "ARO cluster domain should match the prefix (<alias>-test)."
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

run "subnet_delegations" {
  command = plan

  assert {
    condition     = azapi_update_resource.master_subnet_delegation.body.properties.delegations[0].properties.serviceName == "Microsoft.RedHatOpenShift/hcpOpenShiftClusters"
    error_message = "Master subnet must delegate to Microsoft.RedHatOpenShift/hcpOpenShiftClusters."
  }

  assert {
    condition     = azapi_update_resource.worker_subnet_delegation.body.properties.delegations[0].properties.serviceName == "Microsoft.RedHatOpenShift/hcpOpenShiftClusters"
    error_message = "Worker subnet must delegate to Microsoft.RedHatOpenShift/hcpOpenShiftClusters."
  }
}
