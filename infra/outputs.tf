output "resource_group_name" {
  description = "Resource group containing all resources (delete this to tear everything down)."
  value       = azurerm_resource_group.main.name
}

output "cluster_flavor" {
  description = "Which cluster platform is provisioned by this stack."
  value       = var.cluster_flavor
}

output "cluster_name" {
  description = "Shared cluster name prefix used by the active platform."
  value       = local.cluster_name
}

output "aro_cluster_name" {
  description = "Name of the ARO cluster."
  value       = local.is_aro ? local.cluster_name : ""
}

output "aks_cluster_name" {
  description = "Name of the AKS cluster."
  value       = local.is_aks ? azurerm_kubernetes_cluster.aks[0].name : ""
}

output "aks_node_resource_group_name" {
  description = "AKS-managed node resource group (the one planned resource-group exception)."
  value       = local.is_aks ? azurerm_kubernetes_cluster.aks[0].node_resource_group : ""
}

output "aks_frontend_public_ip_name" {
  description = "Static public IP resource reserved for the AKS frontend public service."
  value       = local.is_aks ? azurerm_public_ip.aks_ingress[0].name : ""
}

output "aks_frontend_public_ip_address" {
  description = "Static public IP address reserved for the AKS frontend public service."
  value       = local.is_aks ? azurerm_public_ip.aks_ingress[0].ip_address : ""
}

output "aks_frontend_public_fqdn" {
  description = "Public DNS name attached to the AKS frontend public IP when a DNS label is configured."
  value       = local.is_aks ? azurerm_public_ip.aks_ingress[0].fqdn : ""
}

output "aks_frontend_public_host" {
  description = "Best available public host for the active cluster flavor. AKS returns the static frontend public IP FQDN when available, otherwise the raw IP. ARO returns an empty string because the app route host is namespace-specific and is discovered after cluster login."
  value = local.is_aks ? (
    try(azurerm_public_ip.aks_ingress[0].fqdn, "") != "" ?
    azurerm_public_ip.aks_ingress[0].fqdn :
    try(azurerm_public_ip.aks_ingress[0].ip_address, "")
  ) : ""
}

output "aks_gateway_public_host" {
  description = "Custom public host wired to the AKS frontend public IP when gateway DNS automation is enabled."
  value       = local.aks_gateway_enabled ? var.aks_gateway_host : ""
}

output "aks_cert_manager_identity_name" {
  description = "User-assigned identity name used by cert-manager DNS01 automation."
  value       = local.aks_gateway_enabled ? azurerm_user_assigned_identity.aks_dns_solver[0].name : ""
}

output "aks_cert_manager_identity_client_id" {
  description = "Client ID of the user-assigned identity used by cert-manager DNS01 automation."
  value       = local.aks_gateway_enabled ? azurerm_user_assigned_identity.aks_dns_solver[0].client_id : ""
}

output "aro_api_server_url" {
  description = "ARO API server URL."
  value = local.is_aro ? try(
    jsondecode(tostring(azapi_resource.aro_cluster[0].output)).properties.apiserverProfile.url,
    azapi_resource.aro_cluster[0].output.properties.apiserverProfile.url,
    "",
  ) : ""
}

output "aro_console_url" {
  description = "ARO web console URL."
  value = local.is_aro ? try(
    jsondecode(tostring(azapi_resource.aro_cluster[0].output)).properties.consoleProfile.url,
    azapi_resource.aro_cluster[0].output.properties.consoleProfile.url,
    "",
  ) : ""
}

output "aoai_endpoint" {
  description = "Azure OpenAI endpoint URL."
  value       = azurerm_cognitive_account.openai.endpoint
}

output "aoai_deployment_name" {
  description = "Azure OpenAI deployment name (use as AI_AZURE_OPENAI_DEPLOYMENT)."
  value       = azurerm_cognitive_deployment.model.name
}

output "aoai_account_name" {
  description = "Azure OpenAI account name (for `az cognitiveservices account keys list`)."
  value       = azurerm_cognitive_account.openai.name
}

output "prod_namespace" {
  description = "Fixed namespace for the stable app deployment (shared AOAI, same cluster as e2e)."
  value       = var.prod_namespace
}

# ---------------------------------------------------------------------------
# Azure SQL Database outputs (only when enable_database = true)
# ---------------------------------------------------------------------------
output "sql_server_fqdn" {
  description = "Azure SQL Server FQDN."
  value       = var.enable_database ? azurerm_mssql_server.main[0].fully_qualified_domain_name : ""
}

output "sql_database_name" {
  description = "Azure SQL Database name."
  value       = var.enable_database ? azurerm_mssql_database.app[0].name : ""
}

output "sql_connection_hint" {
  description = "DATABASE_URL template (replace <PASSWORD> with the admin password). Uses ADO.NET-style 'Server=...;Database=...;User Id=...;Password=...' connection string format."
  sensitive   = true
  value       = var.enable_database ? "Server=${azurerm_mssql_server.main[0].fully_qualified_domain_name};Database=${azurerm_mssql_database.app[0].name};User Id=sresimadmin;Password=<PASSWORD>;Encrypt=true;TrustServerCertificate=false" : ""
}

output "env_file_snippet" {
  description = "Paste into backend/.env.local to connect to these resources."
  value = join("", [
    <<-EOT
    # --- Generated by terraform output env_file_snippet ---
    AZURE_SUBSCRIPTION_ID=${data.azurerm_client_config.current.subscription_id}
    CLUSTER_FLAVOR=${var.cluster_flavor}
    AOAI_RG=${azurerm_resource_group.main.name}
    AOAI_ACCOUNT=${azurerm_cognitive_account.openai.name}
    AOAI_DEPLOYMENT=${azurerm_cognitive_deployment.model.name}
    AI_PROVIDER=azure-openai
    AI_MOCK_MODE=false
    AI_STRICT_STARTUP=true
    AI_MODEL=${var.aoai_model_name}
    AI_AZURE_OPENAI_ENDPOINT=${azurerm_cognitive_account.openai.endpoint}
    AI_AZURE_OPENAI_DEPLOYMENT=${azurerm_cognitive_deployment.model.name}
    AI_AZURE_OPENAI_API_VERSION=2024-10-21
    AI_AZURE_OPENAI_API_KEY=<run: az cognitiveservices account keys list -g ${azurerm_resource_group.main.name} -n ${azurerm_cognitive_account.openai.name} --query key1 -o tsv>
    EOT
    ,
    local.is_aks ? <<-AKS
    # --- AKS cluster connection ---
    AKS_RG=${azurerm_resource_group.main.name}
    AKS_CLUSTER=${azurerm_kubernetes_cluster.aks[0].name}
    AKS_NODE_RG=${azurerm_kubernetes_cluster.aks[0].node_resource_group}
    AKS_FRONTEND_PUBLIC_IP_NAME=${azurerm_public_ip.aks_ingress[0].name}
    AKS_FRONTEND_PUBLIC_IP=${azurerm_public_ip.aks_ingress[0].ip_address}
    AKS_FRONTEND_PUBLIC_FQDN=${azurerm_public_ip.aks_ingress[0].fqdn}
    AKS_FRONTEND_PUBLIC_HOST=${try(azurerm_public_ip.aks_ingress[0].fqdn, "") != "" ? azurerm_public_ip.aks_ingress[0].fqdn : try(azurerm_public_ip.aks_ingress[0].ip_address, "")}
    AKS_GATEWAY_HOST=${local.aks_gateway_enabled ? var.aks_gateway_host : ""}
    AKS_DNS_ZONE_NAME=${local.aks_gateway_enabled ? var.aks_dns_zone_name : ""}
    AKS_DNS_ZONE_RESOURCE_GROUP=${local.aks_gateway_enabled ? var.aks_dns_zone_resource_group_name : ""}
    AKS_CERT_MANAGER_IDENTITY_NAME=${local.aks_gateway_enabled ? local.aks_cert_manager_identity_name : ""}
    AKS
    : <<-ARO
    # --- ARO cluster connection ---
    ARO_RG=${azurerm_resource_group.main.name}
    ARO_CLUSTER=${local.cluster_name}
    ARO
    ,
    var.enable_database ? <<-SQL
    # --- Azure SQL Database (enable_database = true) ---
    STORAGE_BACKEND=mssql
    DATABASE_URL=<run: terraform -chdir=infra output -raw sql_connection_hint | sed 's/<PASSWORD>/YOUR_SQL_PASSWORD/'>
    SQL
    : "",
  ])
}

output "post_apply_checklist" {
  description = "Platform-specific post-apply steps (kubeconfig, namespace model, optional SQL, ARO-only Geneva suppression)."
  value = join("", [
    <<-EOT

    ╔══════════════════════════════════════════════════════════════════════╗
    ║                       POST-APPLY CHECKLIST                          ║
    ╠══════════════════════════════════════════════════════════════════════╣
    ║                                                                      ║
    ║  Platform: ${upper(var.cluster_flavor)}                                           ║
    ║                                                                      ║
    EOT
    ,
    local.is_aro ? <<-ARO
    ║  1. SILENCE CLUSTER IN GENEVA HEALTH                                 ║
    ║     Create a suppression rule to avoid production alert noise:        ║
    ║     • Scope: Cluster = "${local.cluster_name}"                       ║
    ║     • Resource Group = "${azurerm_resource_group.main.name}"          ║
    ║     • Suppression type = "Suppress all alerts"                       ║
    ║     • Duration = Indefinite (or match cluster lifetime)              ║
    ║     • Reason = "Test/development cluster – not production"           ║
    ║     • Then: export GENEVA_SUPPRESSION_RULE_ACTIVE=true               ║
    ║                                                                      ║
    ARO
    : <<-AKS
    ║  1. GENEVA SUPPRESSION                                               ║
    ║     • Not required for AKS deployments.                              ║
    ║                                                                      ║
    AKS
    ,
    <<-EOT
    ║  2. GET KUBECONFIG                                                   ║
    ║     make tf-kubeconfig                                               ║
    ║                                                                      ║
    ║  3. GENERATE .env.local                                              ║
    ║     terraform -chdir=infra output -raw env_file_snippet              ║
    ║                                                                      ║
    EOT
    ,
    local.is_aks ? <<-AKS
    ║  4. AKS INGRESS IP + NODE RG EXCEPTION                               ║
    ║     • Static ingress IP stays in RG "${azurerm_resource_group.main.name}"   ║
    ║     • Managed node RG = "${local.aks_node_resource_group_name}"            ║
    ║     • This node RG is the expected non-shared RG exception.          ║
    ║                                                                      ║
    AKS
    : <<-ARO
    ║  4. ARO RP-MANAGED CLUSTER RG                                        ║
    ║     • RP-managed cluster RG = "${local.cluster_resource_group_name}"        ║
    ║     • This RG is created and cleaned up by the ARO resource provider.║
    ║                                                                      ║
    ARO
    ,
    <<-EOT
    ║  5. NAMESPACE MODEL (shared cluster, shared AOAI)                    ║
    ║     • Stable ("prod"):  make prod-up   → ns "${var.prod_namespace}"  ║
    ║     • Ephemeral (e2e):  make e2e-azure-route-up → timestamped ns     ║
    ║     • Both share the same Azure OpenAI account/deployment.           ║
    ║     • prod-down requires typing the namespace name to confirm.       ║
    ║     • e2e namespaces are disposable and auto-cleaned.                ║
    ║                                                                      ║
    ║  6. FINAL DEPLOY + CHECKS (with Azure SQL enabled)                   ║
    ║     • DB_SECRET_NAME=sre-sql-creds make prod-up-final                ║
    ║     • make public-exposure-audit NS="${var.prod_namespace}"           ║
    ║     • make db-port-forward-check NS="${var.prod_namespace}"           ║
    ║                                                                      ║
    EOT
    ,
    var.enable_database ? <<-SQL
    ║  7. AZURE SQL DATABASE (enable_database = true)                      ║
    ║     a. Get the connection string template:                            ║
    ║        terraform -chdir=infra output -raw sql_connection_hint         ║
    ║     b. Replace <PASSWORD> with your sql_admin_password value.         ║
    ║     c. Create a K8s secret in the target namespace with kubectl/oc.   ║
    ║        <cli> -n <NS> create secret generic sre-sql-creds \            ║
    ║          --from-literal=connection-string="Server=...;..."            ║
    ║     d. Deploy with database enabled:                                  ║
    ║        DB_SECRET_NAME=sre-sql-creds make prod-up                      ║
    ║                                                                      ║
    SQL
    : "",
    <<-END
    ╚══════════════════════════════════════════════════════════════════════╝
    END
  ])
}
