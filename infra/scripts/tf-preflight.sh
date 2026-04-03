#!/usr/bin/env bash
set -euo pipefail

OWNER_ALIAS="${OWNER_ALIAS:-}"
LOCATION="${LOCATION:-eastus}"
TF_STATE_KEY="${TF_STATE_KEY:-sre-simulator.tfstate}"
GENEVA_SUPPRESSION_ACCESS_CONFIRMED="${GENEVA_SUPPRESSION_ACCESS_CONFIRMED:-false}"
SQL_SERVER_NAME="${SQL_SERVER_NAME:-}"
TF_STATE_RG="${TF_STATE_RG:-tfstate-rg}"
TF_STATE_ACCOUNT="${TF_STATE_ACCOUNT:-}"
TF_STATE_CONTAINER="${TF_STATE_CONTAINER:-tfstate}"

failures=()
warnings=()

add_failure() {
  failures+=("$1")
}

add_warning() {
  warnings+=("$1")
}

require_command() {
  local command_name=$1
  if ! command -v "$command_name" >/dev/null 2>&1; then
    add_failure "Missing required command: ${command_name}"
  fi
}

contains_role() {
  local roles=$1
  local expected=$2
  local role
  while IFS= read -r role; do
    if [[ "$role" == "$expected" ]]; then
      return 0
    fi
  done <<<"$roles"
  return 1
}

is_tty() {
  [[ -t 0 ]]
}

is_yes() {
  local answer="${1:-}"
  answer="$(echo "$answer" | tr '[:upper:]' '[:lower:]')"
  [[ "$answer" == "y" || "$answer" == "yes" ]]
}

prompt_yes_no() {
  local prompt="$1"
  local response
  read -r -p "$prompt" response
  is_yes "$response"
}

ensure_state_backend_exists() {
  local storage_account_exists container_exists

  if [[ -z "$TF_STATE_ACCOUNT" ]]; then
    if is_tty; then
      echo "Terraform remote state account is not configured (TF_STATE_ACCOUNT is empty)."
      if prompt_yes_no "First-time run: create Terraform backend resources now? [y/N] "; then
        read -r -p "Enter globally unique TF_STATE_ACCOUNT name: " TF_STATE_ACCOUNT
      else
        add_failure "TF_STATE_ACCOUNT is required. Set it or run: make tf-bootstrap TF_STATE_ACCOUNT=<name>"
        return
      fi
    else
      add_failure "TF_STATE_ACCOUNT is required. Set it or run interactively to create backend resources."
      return
    fi
  fi

  if [[ ! "$TF_STATE_ACCOUNT" =~ ^[a-z0-9]{3,24}$ ]]; then
    add_failure "TF_STATE_ACCOUNT must be 3-24 lowercase alphanumeric characters."
    return
  fi

  storage_account_exists=false
  if az storage account show --name "$TF_STATE_ACCOUNT" --resource-group "$TF_STATE_RG" >/dev/null 2>&1; then
    storage_account_exists=true
  fi

  if [[ "$storage_account_exists" != "true" ]]; then
    if is_tty && prompt_yes_no "State storage account ${TF_STATE_ACCOUNT} not found in ${TF_STATE_RG}. Create it now? [y/N] "; then
      az group create --name "$TF_STATE_RG" --location "$LOCATION" --tags purpose=terraform-state >/dev/null
      az storage account create \
        --name "$TF_STATE_ACCOUNT" \
        --resource-group "$TF_STATE_RG" \
        --location "$LOCATION" \
        --sku Standard_LRS \
        --min-tls-version TLS1_2 \
        --allow-blob-public-access false \
        --tags purpose=terraform-state >/dev/null
      echo "Created Terraform state storage account: ${TF_STATE_ACCOUNT}"
    else
      add_failure "State storage account ${TF_STATE_ACCOUNT} was not found. Create it with: make tf-bootstrap TF_STATE_ACCOUNT=${TF_STATE_ACCOUNT}"
      return
    fi
  fi

  container_exists=false
  if az storage container show \
    --name "$TF_STATE_CONTAINER" \
    --account-name "$TF_STATE_ACCOUNT" \
    --auth-mode login >/dev/null 2>&1; then
    container_exists=true
  fi

  if [[ "$container_exists" != "true" ]]; then
    if is_tty && prompt_yes_no "State container ${TF_STATE_CONTAINER} not found in ${TF_STATE_ACCOUNT}. Create it now? [y/N] "; then
      az storage container create \
        --name "$TF_STATE_CONTAINER" \
        --account-name "$TF_STATE_ACCOUNT" \
        --auth-mode login >/dev/null
      echo "Created Terraform state container: ${TF_STATE_CONTAINER}"
    else
      add_failure "State container ${TF_STATE_CONTAINER} was not found in ${TF_STATE_ACCOUNT}. Create it with: az storage container create --name ${TF_STATE_CONTAINER} --account-name ${TF_STATE_ACCOUNT} --auth-mode login"
      return
    fi
  fi
}

echo "== ARO final infra preflight =="
echo "Owner alias: ${OWNER_ALIAS:-<missing>}"
echo "Location: ${LOCATION}"
echo "State key: ${TF_STATE_KEY}"
echo "State account: ${TF_STATE_ACCOUNT:-<missing>}"
echo "State resource group: ${TF_STATE_RG}"
echo "State container: ${TF_STATE_CONTAINER}"
echo "SQL server name: ${SQL_SERVER_NAME:-<default from alias>}"
echo

if [[ -z "$OWNER_ALIAS" ]]; then
  add_failure "OWNER_ALIAS is required (expected aaffinit for final environment)."
elif [[ ! "$OWNER_ALIAS" =~ ^[a-z][a-z0-9]{2,15}$ ]]; then
  add_failure "OWNER_ALIAS must match ^[a-z][a-z0-9]{2,15}$."
fi

if [[ "$OWNER_ALIAS" != "aaffinit" ]]; then
  add_failure "OWNER_ALIAS must be aaffinit for the final environment naming convention."
fi

if [[ "$TF_STATE_KEY" == "sre-simulator.tfstate" ]]; then
  add_failure "TF_STATE_KEY uses the shared default. Use an isolated key (example: aaffinit-test-sre-simulator.tfstate)."
fi

if [[ "$TF_STATE_KEY" != *"${OWNER_ALIAS}"* ]]; then
  add_warning "TF_STATE_KEY does not contain owner alias; verify this is intentional."
fi

require_command "az"
require_command "terraform"

if ((${#failures[@]} == 0)); then
  if ! az account show >/dev/null 2>&1; then
    add_failure "Azure CLI is not authenticated. Run: az login"
  fi
fi

if ((${#failures[@]} == 0)); then
  ensure_state_backend_exists
fi

subscription_id=""
assignee=""
if ((${#failures[@]} == 0)); then
  subscription_id="$(az account show --query id -o tsv)"
  assignee="$(az account show --query user.name -o tsv)"

  echo "Subscription: ${subscription_id}"
  echo "Assignee: ${assignee}"
  echo

  role_names="$(az role assignment list \
    --assignee "$assignee" \
    --scope "/subscriptions/${subscription_id}" \
    --include-inherited \
    --query "[].roleDefinitionName" \
    -o tsv 2>/dev/null || true)"

  if [[ -z "$role_names" ]]; then
    add_warning "Could not enumerate role assignments for ${assignee}; confirm permissions manually."
  else
    if ! contains_role "$role_names" "Owner" && ! contains_role "$role_names" "Contributor"; then
      add_failure "Missing Owner/Contributor at subscription scope; Terraform apply may fail."
    fi
    if ! contains_role "$role_names" "Owner" && ! contains_role "$role_names" "User Access Administrator"; then
      add_warning "No Owner/User Access Administrator detected; role assignment resources may fail."
    fi
  fi

  for provider in \
    Microsoft.RedHatOpenShift \
    Microsoft.Compute \
    Microsoft.Network \
    Microsoft.Sql \
    Microsoft.CognitiveServices; do
    state="$(az provider show --namespace "$provider" --query registrationState -o tsv 2>/dev/null || true)"
    if [[ "$state" != "Registered" ]]; then
      add_failure "Resource provider ${provider} is not Registered (state=${state:-unknown})."
    fi
  done

  app_rg="${OWNER_ALIAS}-test-rg"
  cluster_rg="${OWNER_ALIAS}-test-cluster-rg"
  sql_server_name="${SQL_SERVER_NAME:-${OWNER_ALIAS}-test-sql}"

  app_rg_exists="$(az group exists --name "$app_rg" 2>/dev/null || echo false)"
  if [[ "$app_rg_exists" == "true" ]]; then
    add_failure "Resource group ${app_rg} already exists. This risks side effects on existing resources."
  fi

  cluster_rg_exists="$(az group exists --name "$cluster_rg" 2>/dev/null || echo false)"
  if [[ "$cluster_rg_exists" == "true" ]]; then
    add_failure "Cluster resource group ${cluster_rg} already exists. Clean up or choose a different alias/suffix."
  fi

  sql_name_matches="$(az sql server list --query "[?name=='${sql_server_name}'] | length(@)" -o tsv 2>/dev/null || true)"
  if [[ -z "$sql_name_matches" ]]; then
    add_warning "Could not verify SQL server name collisions for ${sql_server_name}; check manually."
  elif [[ "$sql_name_matches" != "0" ]]; then
    add_failure "SQL server name ${sql_server_name} already exists in this subscription context."
  fi

  latest_aro_version="$(az aro get-versions --location "$LOCATION" --query "[-1]" -o tsv 2>/dev/null || true)"
  if [[ -z "$latest_aro_version" ]]; then
    add_warning "Could not resolve latest ARO version. Verify az aro extension and region support."
  else
    echo "Latest reported ARO version in ${LOCATION}: ${latest_aro_version}"
  fi

  dsv3_quota="$(az vm list-usage --location "$LOCATION" \
    --query "[?contains(name.localizedValue, 'DSv3') || contains(name.value, 'DSv3')].[name.localizedValue, currentValue, limit]" \
    -o tsv 2>/dev/null || true)"
  if [[ -z "$dsv3_quota" ]]; then
    add_warning "Could not resolve DSv3 quota usage for ${LOCATION}. Check compute quotas manually."
  else
    echo
    echo "DSv3 quota usage (name current limit):"
    echo "$dsv3_quota"
  fi
fi

if [[ "$GENEVA_SUPPRESSION_ACCESS_CONFIRMED" != "true" ]]; then
  add_failure "Geneva suppression access was not confirmed. Set GENEVA_SUPPRESSION_ACCESS_CONFIRMED=true after validating access."
fi

echo
echo "Recommended terraform values:"
echo "  owner_alias = \"aaffinit\""
echo "  master_vm_size = \"Standard_D8s_v3\""
echo "  worker_vm_size = \"Standard_D4s_v3\""
echo "  worker_count = 2"
echo "  aro_version = \"${latest_aro_version:-<pin-latest-compatible>}\""
echo "  enable_database = true"
echo "  sql_server_name = \"${SQL_SERVER_NAME:-${OWNER_ALIAS}-test-sql}\""
echo "  extra_tags = { test = \"true\" }"

if ((${#warnings[@]} > 0)); then
  echo
  echo "Warnings:"
  for warning in "${warnings[@]}"; do
    echo "  - ${warning}"
  done
fi

if ((${#failures[@]} > 0)); then
  echo
  echo "Preflight failed:"
  for failure in "${failures[@]}"; do
    echo "  - ${failure}"
  done
  exit 1
fi

echo
echo "Preflight passed."
