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
    condition     = var.worker_count >= 2
    error_message = "ARO requires at least 2 worker nodes."
  }
}

variable "pull_secret_path" {
  description = "Path to a Red Hat pull secret JSON file (optional but recommended)."
  type        = string
  default     = ""
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
  #   Standard (pay-as-you-go) means this only affects rate limit, not cost.

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

# ---------------------------------------------------------------------------
# Azure SQL Database (optional, default off)
# ---------------------------------------------------------------------------
variable "enable_database" {
  description = "Whether to provision Azure SQL Database (free tier) for persistent game data."
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
      var.enable_database == false ||
      (
        length(var.sql_admin_password) >= 8 &&
        can(regex("[A-Z]", var.sql_admin_password)) &&
        can(regex("[a-z]", var.sql_admin_password)) &&
        can(regex("[0-9]", var.sql_admin_password)) &&
        can(regex("[^A-Za-z0-9]", var.sql_admin_password))
      )
    )
    error_message = "When enable_database is true, sql_admin_password must be at least 8 characters and include uppercase, lowercase, numeric, and special characters."
  }
}

# ---------------------------------------------------------------------------
# Locals – derived names and shared tags
# ---------------------------------------------------------------------------
locals {
  prefix              = "${var.owner_alias}-test"
  resource_group_name = "${local.prefix}-rg"
  cluster_name        = local.prefix
  vnet_name           = "${local.prefix}-vnet"
  aoai_account_name   = "${local.prefix}-aoai"

  tags = merge(var.extra_tags, {
    environment = "test"
    owner       = var.owner_alias
    project     = "sre-simulator"
    purpose     = "development-testing"
    auto-delete = "safe-to-delete"
  })
}
