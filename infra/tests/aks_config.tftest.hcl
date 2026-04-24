mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      client_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000003"
      tenant_id       = "00000000-0000-0000-0000-000000000004"
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
# AKS default path - the repo should provision AKS unless explicitly set to ARO
# ---------------------------------------------------------------------------

run "cluster_flavor_defaults_to_aks" {
  command = plan

  assert {
    condition     = var.cluster_flavor == "aks"
    error_message = "cluster_flavor should default to aks for new environments."
  }
}

run "aks_resources_created_by_default" {
  command = plan

  assert {
    condition     = length(azurerm_kubernetes_cluster.aks) == 1
    error_message = "AKS cluster should be created by default."
  }

  assert {
    condition     = length(azapi_resource.aro_cluster) == 0
    error_message = "ARO cluster should not be created when cluster_flavor=aks."
  }
}

run "aks_cluster_naming" {
  command = plan

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].name == "jdoe-test"
    error_message = "AKS cluster name should match the shared <alias>-test prefix."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].node_resource_group == "jdoe-test-aks-nodes-rg"
    error_message = "AKS node resource group should use the deterministic default name."
  }

  assert {
    condition     = azurerm_public_ip.aks_ingress[0].name == "jdoe-test-aks-ingress-pip"
    error_message = "AKS frontend public IP should use the default shared-resource-group name."
  }

  assert {
    condition     = azurerm_public_ip.aks_ingress[0].resource_group_name == "jdoe-test-rg"
    error_message = "AKS frontend public IP should stay in the main resource group."
  }

  assert {
    condition     = azurerm_public_ip.aks_ingress[0].domain_name_label == "jdoe-test"
    error_message = "AKS frontend public IP should default its DNS label to the shared prefix."
  }
}

run "aks_same_rg_intent" {
  command = plan

  assert {
    condition     = azurerm_virtual_network.aks[0].resource_group_name == "jdoe-test-rg"
    error_message = "AKS VNet should stay in the main resource group."
  }

  assert {
    condition     = azurerm_subnet.aks[0].resource_group_name == "jdoe-test-rg"
    error_message = "AKS node subnet should stay in the main resource group."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].resource_group_name == "jdoe-test-rg"
    error_message = "AKS control-plane resource should stay in the main resource group."
  }

  assert {
    condition     = azurerm_role_assignment.aks_main_rg_network_contributor[0].role_definition_name == "Network Contributor"
    error_message = "AKS managed identity should get Network Contributor access for shared networking resources."
  }
}

run "aks_minimal_autoscaling_defaults" {
  command = plan

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].sku_tier == "Free"
    error_message = "AKS should default to the Free control-plane tier for lowest cost."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].default_node_pool[0].vm_size == "Standard_B2s"
    error_message = "AKS should default to Standard_B2s for the minimal worker/system node pool."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].default_node_pool[0].auto_scaling_enabled == true
    error_message = "AKS default node pool should enable cluster autoscaling."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].default_node_pool[0].min_count == 1
    error_message = "AKS autoscaler should default to a single node minimum."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].default_node_pool[0].max_count == 3
    error_message = "AKS autoscaler should default to a small upper bound."
  }
}

run "aks_network_profile_defaults" {
  command = plan

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].network_profile[0].network_plugin == "azure"
    error_message = "AKS should use the Azure CNI network plugin."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].network_profile[0].network_policy == "azure"
    error_message = "AKS should enable Azure network policy so Kubernetes NetworkPolicy continues to work."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].network_profile[0].load_balancer_sku == "standard"
    error_message = "AKS should use a Standard load balancer for the ingress service."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].network_profile[0].outbound_type == "loadBalancer"
    error_message = "AKS should default outbound traffic to the load balancer path."
  }
}
