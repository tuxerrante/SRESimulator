mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      client_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000003"
      tenant_id       = "00000000-0000-0000-0000-000000000004"
    }
  }

  mock_data "azurerm_dns_zone" {
    defaults = {
      id                  = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/dns/providers/Microsoft.Network/dnsZones/osadev.cloud"
      name                = "osadev.cloud"
      resource_group_name = "dns"
    }
  }

  mock_resource "azurerm_public_ip" {
    override_during = plan

    defaults = {
      id         = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/jdoe-test-rg/providers/Microsoft.Network/publicIPAddresses/jdoe-test-aks-frontend-pip"
      ip_address = "203.0.113.10"
      fqdn       = "jdoe-test.eastus.cloudapp.azure.com"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    override_during = plan

    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/jdoe-test-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/jdoe-test-cert-manager-dns"
      client_id    = "00000000-0000-0000-0000-000000000006"
      principal_id = "00000000-0000-0000-0000-000000000007"
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
  owner_alias                      = "jdoe"
  aks_gateway_host                 = "play.sresimulator.osadev.cloud"
  aks_dns_zone_name                = "osadev.cloud"
  aks_dns_zone_resource_group_name = "dns"
}

run "gateway_locals_are_derived_from_host" {
  command = plan

  assert {
    condition     = local.aks_gateway_enabled == true
    error_message = "AKS gateway automation should be enabled when AKS gateway DNS variables are set."
  }

  assert {
    condition     = local.aks_gateway_record_name == "play.sresimulator"
    error_message = "Gateway record name should strip the DNS zone suffix from the configured host."
  }

  assert {
    condition     = local.aks_cert_manager_identity_name == "${var.owner_alias}-test-cert-manager-dns"
    error_message = "Cert-manager DNS identity name should default to <alias>-test-cert-manager-dns."
  }
}

run "aks_cluster_enables_oidc_and_workload_identity" {
  command = plan

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].oidc_issuer_enabled == true
    error_message = "AKS should enable the OIDC issuer for workload identity."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.aks[0].workload_identity_enabled == true
    error_message = "AKS should enable workload identity."
  }
}

run "cert_manager_dns_identity_is_created_deterministically" {
  command = plan

  assert {
    condition     = length(azurerm_user_assigned_identity.aks_dns_solver) == 1
    error_message = "AKS gateway DNS automation should create one user-assigned identity for cert-manager."
  }

  assert {
    condition     = azurerm_user_assigned_identity.aks_dns_solver[0].name == "${var.owner_alias}-test-cert-manager-dns"
    error_message = "Cert-manager DNS identity should use the deterministic default name."
  }

  assert {
    condition     = length(azurerm_federated_identity_credential.aks_dns_solver_cert_manager) == 1
    error_message = "AKS gateway DNS automation should create one federated identity credential for cert-manager."
  }

  assert {
    condition     = azurerm_federated_identity_credential.aks_dns_solver_cert_manager[0].name == "cert-manager"
    error_message = "The federated identity credential should use a stable cert-manager name."
  }

  assert {
    condition     = azurerm_federated_identity_credential.aks_dns_solver_cert_manager[0].subject == "system:serviceaccount:cert-manager:cert-manager"
    error_message = "The federated identity credential should target the cert-manager controller service account."
  }

  assert {
    condition     = azurerm_federated_identity_credential.aks_dns_solver_cert_manager[0].audience[0] == "api://AzureADTokenExchange"
    error_message = "The federated identity credential should use the Azure AD token exchange audience."
  }
}

run "gateway_outputs_expose_host_and_identity" {
  command = plan

  assert {
    condition     = output.aks_gateway_public_host == "play.sresimulator.osadev.cloud"
    error_message = "aks_gateway_public_host should expose the configured custom gateway host."
  }

  assert {
    condition     = output.aks_cert_manager_identity_name == "${var.owner_alias}-test-cert-manager-dns"
    error_message = "aks_cert_manager_identity_name should expose the deterministic cert-manager identity name."
  }

  assert {
    condition     = output.aks_cert_manager_identity_client_id == azurerm_user_assigned_identity.aks_dns_solver[0].client_id
    error_message = "aks_cert_manager_identity_client_id should expose the DNS solver identity client ID."
  }
}

run "dns_zone_contributor_role_is_assigned" {
  command = plan

  assert {
    condition     = azurerm_role_assignment.aks_dns_solver_zone_contributor[0].role_definition_name == "DNS Zone Contributor"
    error_message = "Cert-manager DNS identity should get DNS Zone Contributor on the target zone."
  }

  assert {
    condition     = azurerm_role_assignment.aks_dns_solver_zone_contributor[0].scope == "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/dns/providers/Microsoft.Network/dnsZones/osadev.cloud"
    error_message = "DNS Zone Contributor assignment should target the configured public DNS zone."
  }
}

run "gateway_host_a_record_is_created_in_zone" {
  command = plan

  assert {
    condition     = length(azurerm_dns_a_record.aks_gateway_host) == 1
    error_message = "AKS gateway automation should create one public DNS A record."
  }

  assert {
    condition     = azurerm_dns_a_record.aks_gateway_host[0].name == "play.sresimulator"
    error_message = "The gateway DNS A record name should be the host prefix inside the zone."
  }

  assert {
    condition     = azurerm_dns_a_record.aks_gateway_host[0].zone_name == "osadev.cloud"
    error_message = "The gateway DNS A record should be created in the configured DNS zone."
  }

  assert {
    condition     = azurerm_dns_a_record.aks_gateway_host[0].resource_group_name == "dns"
    error_message = "The gateway DNS A record should be created in the DNS zone resource group."
  }

  assert {
    condition     = azurerm_dns_a_record.aks_gateway_host[0].target_resource_id == azurerm_public_ip.aks_ingress[0].id
    error_message = "The gateway DNS A record should alias the reserved AKS frontend public IP resource."
  }
}

run "partial_gateway_inputs_are_rejected" {
  command = plan

  variables {
    owner_alias                      = "jdoe"
    aks_gateway_host                 = "play.sresimulator.osadev.cloud"
    aks_dns_zone_name                = ""
    aks_dns_zone_resource_group_name = ""
  }

  expect_failures = [
    var.aks_gateway_host,
  ]
}

run "gateway_host_must_be_under_dns_zone" {
  command = plan

  variables {
    owner_alias                      = "jdoe"
    aks_gateway_host                 = "play.sresimulator.example.com"
    aks_dns_zone_name                = "osadev.cloud"
    aks_dns_zone_resource_group_name = "dns"
  }

  expect_failures = [
    var.aks_gateway_host,
  ]
}

run "gateway_host_rejects_trailing_dot" {
  command = plan

  variables {
    owner_alias                      = "jdoe"
    aks_gateway_host                 = "play.sresimulator.osadev.cloud."
    aks_dns_zone_name                = "osadev.cloud"
    aks_dns_zone_resource_group_name = "dns"
  }

  expect_failures = [
    var.aks_gateway_host,
  ]
}
