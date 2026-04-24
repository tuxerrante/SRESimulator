variable "owner_alias" {
  description = "Your corporate / Red Hat alias (e.g. jdoe). Used as prefix for all resource names."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,15}$", var.owner_alias))
    error_message = "owner_alias must be 3-16 lowercase alphanumeric characters starting with a letter."
  }
}

variable "location" {
  description = "Azure region for all resources."
  type        = string
  default     = "eastus"
}

variable "cluster_flavor" {
  description = "Which cluster platform to provision. Use aks for the default low-cost path or aro to retain the existing OpenShift flow."
  type        = string
  default     = "aks"

  validation {
    condition     = contains(["aks", "aro"], var.cluster_flavor)
    error_message = "cluster_flavor must be either \"aks\" or \"aro\"."
  }
}

variable "aro_version" {
  description = "OpenShift version for the ARO cluster (run `az aro get-versions --location <region>` to list available versions)."
  type        = string
  default     = ""
}

variable "master_vm_size" {
  description = "VM size for ARO master nodes (minimum Standard_D8s_v3, 3 masters are always created)."
  type        = string
  default     = "Standard_D8s_v3"
}

variable "worker_vm_size" {
  description = "VM size for ARO worker nodes."
  type        = string
  default     = "Standard_D4s_v3"
}

variable "worker_count" {
  description = "Number of ARO worker nodes (minimum 2)."
  type        = number
  default     = 2

  validation {
    condition     = var.cluster_flavor != "aro" || var.worker_count >= 2
    error_message = "ARO requires at least 2 worker nodes."
  }
}

variable "pull_secret_path" {
  description = "Path to a Red Hat pull secret JSON file (optional but recommended)."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# AKS sizing and networking
# ---------------------------------------------------------------------------
variable "aks_kubernetes_version" {
  description = "Optional AKS Kubernetes version. Leave empty to use the provider default/latest supported version."
  type        = string
  default     = ""
}

variable "aks_node_vm_size" {
  description = "VM size for the minimal AKS system/user node pool."
  type        = string
  default     = "Standard_B2s"
}

variable "aks_node_count_min" {
  description = "Minimum number of nodes for the AKS autoscaling node pool."
  type        = number
  default     = 1

  validation {
    condition     = var.aks_node_count_min >= 1
    error_message = "aks_node_count_min must be at least 1."
  }
}

variable "aks_node_count_max" {
  description = "Maximum number of nodes for the AKS autoscaling node pool."
  type        = number
  default     = 3

  validation {
    condition     = var.aks_node_count_max >= var.aks_node_count_min
    error_message = "aks_node_count_max must be greater than or equal to aks_node_count_min."
  }
}

variable "aks_vnet_address_space" {
  description = "Address space for the AKS virtual network."
  type        = string
  default     = "10.10.0.0/22"
}

variable "aks_node_subnet_cidr" {
  description = "CIDR for the AKS node subnet."
  type        = string
  default     = "10.10.0.0/24"
}

variable "aks_service_cidr" {
  description = "CIDR used by Kubernetes services in the AKS cluster. Must not overlap with the VNet."
  type        = string
  default     = "10.10.4.0/24"
}

variable "aks_dns_service_ip" {
  description = "Cluster DNS service IP inside aks_service_cidr."
  type        = string
  default     = "10.10.4.10"
}

variable "aks_node_resource_group_name" {
  description = "Optional override for the AKS-managed node resource group name. Leave empty to use the deterministic default."
  type        = string
  default     = ""

  validation {
    condition = (
      var.aks_node_resource_group_name == "" ||
      can(regex("^[A-Za-z0-9._()\\-]{1,80}$", var.aks_node_resource_group_name))
    )
    error_message = "aks_node_resource_group_name must be 1-80 chars using letters, numbers, period, underscore, parentheses, or hyphen."
  }
}

variable "aks_frontend_public_ip_name" {
  description = "Optional override for the static public IP resource bound to the AKS frontend public service."
  type        = string
  default     = ""

  validation {
    condition = (
      var.aks_frontend_public_ip_name == "" ||
      can(regex("^[A-Za-z0-9._-]{1,80}$", var.aks_frontend_public_ip_name))
    )
    error_message = "aks_frontend_public_ip_name must be 1-80 chars using letters, numbers, period, underscore, or hyphen."
  }
}

variable "aks_public_ip_dns_label" {
  description = "Optional DNS label for the static AKS frontend public IP. Leave empty to default to <owner_alias>-test."
  type        = string
  default     = ""

  validation {
    condition = (
      var.aks_public_ip_dns_label == "" ||
      can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.aks_public_ip_dns_label))
    )
    error_message = "aks_public_ip_dns_label must be 1-63 lowercase letters, numbers, or hyphens, starting and ending with an alphanumeric character."
  }
}

variable "aoai_model_name" {
  description = "Azure OpenAI model to deploy (must be available in the chosen region)."
  type        = string
  default     = "gpt-4o-mini"
}

variable "aoai_model_version" {
  description = "Model version for the Azure OpenAI deployment."
  type        = string
  default     = "2024-07-18"
}

variable "aoai_sku_name" {
  description = "Azure OpenAI deployment SKU name. For westeurope with gpt-4o-mini, use GlobalStandard."
  type        = string
  default     = "GlobalStandard"
}

variable "aoai_capacity" {
  description = "Rate limit in thousands of tokens per minute (K TPM). Cost is pay-per-token, not per capacity."
  type        = number
  default     = 80

  # Sizing rationale (from PR #31 real e2e measurements):
  #   Chat route:     ~16K tokens/request (12K context + 4K completion), 2-3 req/min peak
  #   Command route:  ~4K tokens/request, 1-2 req/min peak
  #   Scenario route: ~2.3K tokens/request (burst on session start)
  #   Single active user peak: ~50K TPM
  #   With prod + e2e concurrent: ~80K TPM burst
  #   80K TPM handles a single active user at peak plus concurrent e2e.
  #   GlobalStandard/DataZoneStandard (pay-as-you-go) means this only affects
  #   rate limit, not base cost.

  validation {
    condition     = var.aoai_capacity >= 1 && var.aoai_capacity <= 500
    error_message = "aoai_capacity must be between 1 and 500 (K TPM). For test environments, 500K TPM is the safe upper bound."
  }
}

variable "vnet_address_space" {
  description = "Address space for the ARO virtual network (minimum /22)."
  type        = string
  default     = "10.0.0.0/22"
}

variable "master_subnet_cidr" {
  description = "CIDR for the ARO master subnet (must be /23 within the VNet)."
  type        = string
  default     = "10.0.0.0/23"
}

variable "worker_subnet_cidr" {
  description = "CIDR for the ARO worker subnet (must be /23 within the VNet)."
  type        = string
  default     = "10.0.2.0/23"
}

variable "prod_namespace" {
  description = "Fixed namespace for the stable ('production') app deployment. E2E namespaces are ephemeral and separate."
  type        = string
  default     = "sre-simulator"
}

variable "budget_amount" {
  description = "Monthly budget cap in the subscription's billing currency (e.g. EUR). An email alert fires at 80% forecasted and 100% actual. Set to 0 to disable."
  type        = number
  default     = 200
}

variable "budget_alert_emails" {
  description = "Email addresses that receive budget alerts when spending approaches budget_amount. Budget resource is only created when budget_amount > 0 and at least one email is provided."
  type        = list(string)
  default     = []
}

variable "extra_tags" {
  description = "Additional tags to merge onto all resources."
  type        = map(string)
  default     = {}
}

variable "enable_cluster_rg_tag_overlay" {
  description = "Whether to attempt applying shared tags to the RP-managed <alias>-test-cluster-rg resource group. Disable when deny assignments block RG writes."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Azure SQL Database (optional, default off)
# ---------------------------------------------------------------------------
variable "enable_database" {
  description = "Whether to provision Azure SQL Database for persistent game data."
  type        = bool
  default     = false
}

variable "enable_sql_free_tier" {
  description = "Whether to apply Azure SQL free-tier overlay properties. Disable in regions/subscriptions where the update is not allowed."
  type        = bool
  default     = false
}

variable "sql_admin_password" {
  description = "Administrator password for Azure SQL Server (required when enable_database = true). Must meet Azure complexity requirements."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition = (
      var.sql_admin_password == "" ||
      (
        length(var.sql_admin_password) >= 8 &&
        can(regex("[A-Z]", var.sql_admin_password)) &&
        can(regex("[a-z]", var.sql_admin_password)) &&
        can(regex("[0-9]", var.sql_admin_password)) &&
        can(regex("[^A-Za-z0-9]", var.sql_admin_password))
      )
    )
    error_message = "When set, sql_admin_password must be at least 8 characters and include uppercase, lowercase, numeric, and special characters."
  }
}

variable "sql_server_name" {
  description = "Optional Azure SQL Server name override. Must be globally unique in Azure. If empty, defaults to <owner_alias>-test-sql."
  type        = string
  default     = ""

  validation {
    condition = (
      var.sql_server_name == "" ||
      can(regex("^[a-z][a-z0-9-]{1,61}[a-z0-9]$", var.sql_server_name))
    )
    error_message = "sql_server_name must be 3-63 chars, lowercase letters/numbers/hyphens, start with a letter, and not end with a hyphen."
  }
}

# ---------------------------------------------------------------------------
# Locals – derived names and shared tags
# ---------------------------------------------------------------------------
locals {
  prefix                      = "${var.owner_alias}-test"
  resource_group_name         = "${local.prefix}-rg"
  cluster_resource_group_name = "${local.prefix}-cluster-rg"
  cluster_resource_group_id   = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/resourcegroups/${local.cluster_resource_group_name}"
  cluster_name                = local.prefix
  vnet_name                   = "${local.prefix}-vnet"
  is_aro                      = var.cluster_flavor == "aro"
  is_aks                      = var.cluster_flavor == "aks"
  aks_vnet_name               = "${local.prefix}-aks-vnet"
  aks_node_subnet_name        = "aks-node-subnet"
  aks_dns_prefix              = var.aks_public_ip_dns_label != "" ? var.aks_public_ip_dns_label : local.prefix
  aks_node_resource_group_name = (
    var.aks_node_resource_group_name != "" ?
    var.aks_node_resource_group_name :
    "${local.prefix}-aks-nodes-rg"
  )
  aks_frontend_public_ip_name = (
    var.aks_frontend_public_ip_name != "" ?
    var.aks_frontend_public_ip_name :
    "${local.prefix}-aks-frontend-pip"
  )
  aro_sp_password_ttl      = "8760h"
  aro_sp_password_end_date = timeadd(timestamp(), local.aro_sp_password_ttl)
  aoai_account_name        = "${local.prefix}-aoai"
  sql_server_name          = var.sql_server_name != "" ? var.sql_server_name : "${local.prefix}-sql"

  tags = merge(var.extra_tags, {
    environment = "test"
    owner       = var.owner_alias
    project     = "sre-simulator"
    purpose     = "development-testing"
    auto-delete = "safe-to-delete"
    persist     = "true" # ARO-RP nightly cleaner can purge old groups without this tag.
  })
}
