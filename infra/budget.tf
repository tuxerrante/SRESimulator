# ---------------------------------------------------------------------------
# Budget alert – email notification when RG spending approaches the cap
# Only created when budget_alert_emails is non-empty and budget_amount > 0.
# ---------------------------------------------------------------------------

resource "azurerm_consumption_budget_resource_group" "main" {
  count = length(var.budget_alert_emails) > 0 && var.budget_amount > 0 ? 1 : 0

  name              = "${local.prefix}-budget"
  resource_group_id = azurerm_resource_group.main.id
  amount            = var.budget_amount
  time_grain        = "Monthly"

  time_period {
    start_date = formatdate("YYYY-MM-01'T'00:00:00Z", timestamp())
  }

  notification {
    enabled        = true
    operator       = "GreaterThanOrEqualTo"
    threshold      = 80
    threshold_type = "Forecasted"
    contact_emails = var.budget_alert_emails
  }

  notification {
    enabled        = true
    operator       = "GreaterThanOrEqualTo"
    threshold      = 100
    threshold_type = "Actual"
    contact_emails = var.budget_alert_emails
  }

  lifecycle {
    ignore_changes = [time_period]
  }
}
