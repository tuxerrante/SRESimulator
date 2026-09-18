data "http" "cloudflare_ipv4" {
  count = local.fetch_cloudflare_ipv4 ? 1 : 0
  url   = "https://www.cloudflare.com/ips-v4"
}

resource "oci_core_vcn" "main" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = [var.vcn_cidr]
  display_name   = local.vcn_name
  dns_label      = replace(local.prefix, "-", "")
  freeform_tags  = local.tags
}

resource "oci_core_internet_gateway" "main" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${local.prefix}-igw"
  enabled        = true
  freeform_tags  = local.tags
}

resource "oci_core_route_table" "main" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "${local.prefix}-rt"
  freeform_tags  = local.tags

  # IPv4 only, deliberately. Cloudflare reaches an origin over IPv4 whenever an
  # A record exists, so the origin never needs an IPv6 address; a half-enabled
  # IPv6 path is worse than none, because the NSG would carry ingress rules that
  # can never match. See README "Why there is no IPv6".
  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.main.id
  }
}

# The subnet's security list is deliberately near-empty: the NSG on the VNIC is
# the single source of truth for ingress. Keeping both would make every future
# firewall question a two-place lookup.
#
# ICMP type 3 code 4 (fragmentation needed) is the exception and must stay
# open. Dropping it breaks path-MTU discovery, which presents as large HTTPS
# responses hanging forever while small ones succeed -- a genuinely horrible
# thing to debug.
resource "oci_core_default_security_list" "main" {
  manage_default_resource_id = oci_core_vcn.main.default_security_list_id
  display_name               = "${local.prefix}-default-sl"
  freeform_tags              = local.tags

  egress_security_rules {
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    protocol         = "all"
    stateless        = false
  }

  ingress_security_rules {
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = "1"
    stateless   = false

    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.main.id
  cidr_block                 = var.subnet_cidr
  display_name               = local.subnet_name
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.main.id
  prohibit_public_ip_on_vnic = false
  freeform_tags              = local.tags
}

# ---------------------------------------------------------------------------
# Network security group -- the real firewall
#
# Enforced in the OCI network fabric rather than on the host, so it survives
# anyone who gets root on the box and flushes iptables.
# ---------------------------------------------------------------------------
resource "oci_core_network_security_group" "instance" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = local.nsg_name
  freeform_tags  = local.tags
}

resource "oci_core_network_security_group_security_rule" "egress_all" {
  network_security_group_id = oci_core_network_security_group.instance.id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  description               = "GHCR, Let's Encrypt, OpenRouter, Neon"
}

resource "oci_core_network_security_group_security_rule" "ingress_http" {
  for_each = toset(local.web_ingress_cidrs)

  network_security_group_id = oci_core_network_security_group.instance.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  description               = "HTTP: ACME HTTP-01 challenge and the redirect to HTTPS"

  tcp_options {
    destination_port_range {
      min = 80
      max = 80
    }
  }
}

resource "oci_core_network_security_group_security_rule" "ingress_https" {
  for_each = toset(local.web_ingress_cidrs)

  network_security_group_id = oci_core_network_security_group.instance.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  description               = "HTTPS: the application"

  tcp_options {
    destination_port_range {
      min = 443
      max = 443
    }
  }
}

resource "oci_core_network_security_group_security_rule" "ingress_ssh" {
  for_each = toset(var.ssh_allowed_cidrs)

  network_security_group_id = oci_core_network_security_group.instance.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  description               = "SSH administration"

  tcp_options {
    destination_port_range {
      min = 22
      max = 22
    }
  }
}

# Empty by default and intended to stay that way. See k8s_api_allowed_cidrs.
resource "oci_core_network_security_group_security_rule" "ingress_k8s_api" {
  for_each = toset(var.k8s_api_allowed_cidrs)

  network_security_group_id = oci_core_network_security_group.instance.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  description               = "k3s API server -- prefer an SSH tunnel over opening this"

  tcp_options {
    destination_port_range {
      min = 6443
      max = 6443
    }
  }
}

resource "oci_core_network_security_group_security_rule" "ingress_icmp_pmtud" {
  network_security_group_id = oci_core_network_security_group.instance.id
  direction                 = "INGRESS"
  protocol                  = "1"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "Path-MTU discovery (fragmentation needed)"

  icmp_options {
    type = 3
    code = 4
  }
}
