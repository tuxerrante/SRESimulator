mock_provider "oci" {
  mock_data "oci_identity_availability_domains" {
    defaults = {
      availability_domains = [
        { name = "AAAA:EU-FRANKFURT-1-AD-1" },
        { name = "AAAA:EU-FRANKFURT-1-AD-2" },
        { name = "AAAA:EU-FRANKFURT-1-AD-3" },
      ]
    }
  }

  mock_data "oci_core_images" {
    defaults = {
      images = [
        { id = "ocid1.image.oc1.eu-frankfurt-1.aaaaaaaaubuntu2404arm" },
      ]
    }
  }

  mock_data "oci_core_vnic_attachments" {
    defaults = {
      vnic_attachments = [
        { vnic_id = "ocid1.vnic.oc1.eu-frankfurt-1.aaaaaaaavnic" },
      ]
    }
  }

  mock_data "oci_core_private_ips" {
    defaults = {
      private_ips = [
        { id = "ocid1.privateip.oc1.eu-frankfurt-1.aaaaaaaaprivateip" },
      ]
    }
  }
}

mock_provider "http" {}

# Cloudflare ranges are supplied explicitly so that no test performs a network
# fetch. local.fetch_cloudflare_ipv4 then evaluates false and the data source
# is never read.
variables {
  owner_alias            = "jdoe"
  compartment_ocid       = "ocid1.compartment.oc1..aaaaaaaacompartment"
  ssh_public_key         = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTests test@example.com"
  acme_email             = "ops@example.com"
  cloudflare_ipv4_ranges = ["198.51.100.0/24", "203.0.113.0/24"]
}
# ---------------------------------------------------------------------------
# The NSG is the firewall. These assertions are the reason it can be trusted.
# ---------------------------------------------------------------------------

run "ssh_is_closed_by_default" {
  command = plan

  assert {
    condition     = length(oci_core_network_security_group_security_rule.ingress_ssh) == 0
    error_message = "SSH must be closed unless ssh_allowed_cidrs is set explicitly."
  }
}

run "kubernetes_api_is_closed_by_default" {
  command = plan

  assert {
    condition     = length(oci_core_network_security_group_security_rule.ingress_k8s_api) == 0
    error_message = "The k3s API must never be open by default. The supported path is an SSH tunnel."
  }
}

run "no_rule_opens_22_or_6443_to_the_internet" {
  command = plan

  variables {
    ssh_allowed_cidrs     = ["198.51.100.10/32"]
    k8s_api_allowed_cidrs = ["198.51.100.10/32"]
  }

  assert {
    condition = length([
      for r in values(oci_core_network_security_group_security_rule.ingress_ssh) : r
      if r.source == "0.0.0.0/0"
    ]) == 0
    error_message = "No SSH rule may use 0.0.0.0/0."
  }

  assert {
    condition = length([
      for r in values(oci_core_network_security_group_security_rule.ingress_k8s_api) : r
      if r.source == "0.0.0.0/0"
    ]) == 0
    error_message = "No Kubernetes API rule may use 0.0.0.0/0."
  }
}

run "web_ingress_is_restricted_to_cloudflare" {
  command = plan

  assert {
    condition = toset([
      for r in values(oci_core_network_security_group_security_rule.ingress_http) : r.source
    ]) == toset(["198.51.100.0/24", "203.0.113.0/24"])
    error_message = "Port 80 must be restricted to the Cloudflare ranges; an open origin defeats the proxy and makes cf-connecting-ip forgeable."
  }

  assert {
    condition = toset([
      for r in values(oci_core_network_security_group_security_rule.ingress_https) : r.source
    ]) == toset(["198.51.100.0/24", "203.0.113.0/24"])
    error_message = "Port 443 must be restricted to the Cloudflare ranges."
  }
}

run "opting_out_of_cloudflare_restriction_opens_the_origin" {
  command = plan

  variables {
    restrict_ingress_to_cloudflare = false
  }

  assert {
    condition = toset([
      for r in values(oci_core_network_security_group_security_rule.ingress_https) : r.source
    ]) == toset(["0.0.0.0/0"])
    error_message = "restrict_ingress_to_cloudflare = false is the documented bring-up escape hatch and should open 443 to the internet."
  }
}

run "path_mtu_discovery_stays_open" {
  command = plan

  assert {
    condition     = oci_core_network_security_group_security_rule.ingress_icmp_pmtud.protocol == "1"
    error_message = "ICMP must be permitted for path-MTU discovery; without it large HTTPS responses hang while small ones succeed."
  }

  assert {
    condition = (
      one(oci_core_network_security_group_security_rule.ingress_icmp_pmtud.icmp_options).type == 3 &&
      one(oci_core_network_security_group_security_rule.ingress_icmp_pmtud.icmp_options).code == 4
    )
    error_message = "The ICMP rule should be type 3 code 4, fragmentation needed."
  }
}

run "instance_has_no_ephemeral_public_ip" {
  command = plan

  assert {
    condition     = tobool(one(oci_core_instance.k3s.create_vnic_details).assign_public_ip) == false
    error_message = "A private IP carries at most one public IP; the reserved address cannot attach if an ephemeral one is assigned at launch."
  }
}

run "instance_vnic_is_attached_to_the_nsg" {
  command = plan

  assert {
    condition     = length(one(oci_core_instance.k3s.create_vnic_details).nsg_ids) == 1
    error_message = "The instance VNIC must be in the NSG, otherwise nothing is enforced."
  }
}

run "public_ip_is_reserved_not_ephemeral" {
  command = plan

  assert {
    condition     = oci_core_public_ip.k3s.lifetime == "RESERVED"
    error_message = "An ephemeral IP changes on stop/start and would silently break the Cloudflare A record."
  }
}

# ---------------------------------------------------------------------------
# IPv4 only, on purpose.
#
# An earlier revision had an `enable_ipv6` flag that set is_ipv6enabled on the
# VCN and added a ::/0 route rule and Cloudflare IPv6 ingress rules, but never
# gave the subnet an ipv6cidr_block, never assigned the VNIC an address, and
# left egress IPv4-only. It produced ingress rules that could match nothing.
# It was removed rather than completed, because Cloudflare reaches an origin
# over IPv4 whenever an A record exists.
#
# These assertions exist so that a future half-wiring fails here rather than
# on the box.
# ---------------------------------------------------------------------------

run "the_network_is_ipv4_only" {
  command = plan

  assert {
    condition = alltrue([
      for rule in oci_core_route_table.main.route_rules :
      !strcontains(rule.destination, ":")
    ])
    error_message = "A ::/0 route rule is useless without a subnet ipv6cidr_block and a VNIC address; complete the IPv6 path or leave it out."
  }

  assert {
    condition     = !strcontains(oci_core_network_security_group_security_rule.egress_all.destination, ":")
    error_message = "Egress is IPv4-only, so any IPv6 ingress rule would admit traffic the box cannot answer."
  }

  assert {
    condition = alltrue([
      for cidr in local.web_ingress_cidrs : !strcontains(cidr, ":")
    ])
    error_message = "web_ingress_cidrs must stay IPv4-only while the VNIC has no IPv6 address."
  }
}
