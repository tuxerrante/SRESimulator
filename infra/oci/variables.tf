# ---------------------------------------------------------------------------
# Identity and placement
# ---------------------------------------------------------------------------
variable "owner_alias" {
  description = "Your corporate / Red Hat alias (e.g. jdoe). Used as prefix for all resource names."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,15}$", var.owner_alias))
    error_message = "owner_alias must be 3-16 lowercase alphanumeric characters starting with a letter."
  }
}

variable "compartment_ocid" {
  description = "OCID of the compartment that will hold every resource in this root."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.(compartment|tenancy)\\.", var.compartment_ocid))
    error_message = "compartment_ocid must be an OCID starting with ocid1.compartment. or ocid1.tenancy."
  }
}

variable "region" {
  description = "OCI region. Always Free capacity lives in your tenancy's home region."
  type        = string
  default     = "eu-frankfurt-1"
}

variable "oci_config_file_profile" {
  description = "Profile in ~/.oci/config used for authentication. Run `oci setup config` to create one."
  type        = string
  default     = "DEFAULT"
}

variable "availability_domain_index" {
  description = <<-EOT
    Zero-based index into the region's availability domains.

    A1.Flex capacity in eu-frankfurt-1 is frequently exhausted: "Out of host
    capacity" is the single most common failure of this build. When it happens,
    increment this and re-apply rather than changing the shape.
  EOT
  type        = number
  default     = 0

  validation {
    condition     = var.availability_domain_index >= 0 && var.availability_domain_index < 3
    error_message = "availability_domain_index must be 0, 1 or 2."
  }
}

# ---------------------------------------------------------------------------
# Instance sizing -- Always Free envelope is 4 OCPU / 24 GB / 200 GB total
# ---------------------------------------------------------------------------
variable "instance_shape" {
  description = "Compute shape. VM.Standard.A1.Flex is the aarch64 Always Free shape."
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  description = "OCPUs for the instance. The Always Free A1 allowance is 4 in total across all instances."
  type        = number
  default     = 2

  validation {
    condition     = var.instance_ocpus >= 1 && var.instance_ocpus <= 4
    error_message = "instance_ocpus must be between 1 and 4 to stay inside the Always Free A1 allowance."
  }
}

variable "instance_memory_gbs" {
  description = "Memory in GB. The Always Free A1 allowance is 24 GB in total across all instances."
  type        = number
  default     = 12

  validation {
    condition     = var.instance_memory_gbs >= 6 && var.instance_memory_gbs <= 24
    error_message = "instance_memory_gbs must be between 6 and 24 to stay inside the Always Free A1 allowance."
  }
}

variable "boot_volume_size_gbs" {
  description = "Boot volume size in GB. Always Free block storage totals 200 GB; 50 is the minimum."
  type        = number
  default     = 60

  validation {
    condition     = var.boot_volume_size_gbs >= 50 && var.boot_volume_size_gbs <= 200
    error_message = "boot_volume_size_gbs must be between 50 and 200."
  }
}

variable "ubuntu_version" {
  description = "Canonical Ubuntu release to select from the OCI image catalogue."
  type        = string
  default     = "24.04"
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------
variable "vcn_cidr" {
  description = "CIDR block for the VCN. Must not overlap the k3s pod (10.42.0.0/16) or service (10.43.0.0/16) ranges."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.vcn_cidr, 0))
    error_message = "vcn_cidr must be a valid CIDR block."
  }

  # The description above states the constraint; without this it is only a
  # suggestion. An overlapping VCN makes host routing ambiguous against the
  # cluster's own ranges, and the symptom is intermittent pod networking
  # rather than anything that points back here.
  #
  # Terraform has no CIDR-overlap function and its comparison operators only
  # accept numbers, so the test is done by masking: two prefixes overlap iff
  # one's network address, re-masked to the other's prefix length, equals that
  # other's network address. Checking both directions covers containment
  # either way.
  validation {
    condition = can(cidrhost(var.vcn_cidr, 0)) && alltrue([
      for reserved in ["10.42.0.0/16", "10.43.0.0/16"] : !(
        cidrhost("${cidrhost(reserved, 0)}/${split("/", var.vcn_cidr)[1]}", 0) == cidrhost(var.vcn_cidr, 0) ||
        cidrhost("${cidrhost(var.vcn_cidr, 0)}/${split("/", reserved)[1]}", 0) == cidrhost(reserved, 0)
      )
    ])
    error_message = "vcn_cidr must not overlap the k3s pod range 10.42.0.0/16 or the service range 10.43.0.0/16."
  }
}

variable "subnet_cidr" {
  description = "CIDR block for the single public subnet."
  type        = string
  default     = "10.0.0.0/24"

  validation {
    condition     = can(cidrhost(var.subnet_cidr, 0))
    error_message = "subnet_cidr must be a valid CIDR block."
  }

  # Containment, rather than a second overlap test: a subnet inside the VCN
  # inherits the VCN's non-overlap guarantee, and a subnet outside it is a
  # mistake OCI would reject later with a far less specific message.
  validation {
    condition = can(cidrhost(var.subnet_cidr, 0)) && can(cidrhost(var.vcn_cidr, 0)) && (
      tonumber(split("/", var.subnet_cidr)[1]) >= tonumber(split("/", var.vcn_cidr)[1]) &&
      cidrhost("${cidrhost(var.subnet_cidr, 0)}/${split("/", var.vcn_cidr)[1]}", 0) == cidrhost(var.vcn_cidr, 0)
    )
    error_message = "subnet_cidr must be contained within vcn_cidr."
  }
}

# ---------------------------------------------------------------------------
# Access control
#
# The primary firewall is an NSG on the instance VNIC: it is stateful, enforced
# in the OCI network fabric, and therefore cannot be flushed by anyone who gets
# root on the box. Everything below defaults to closed.
# ---------------------------------------------------------------------------
variable "ssh_allowed_cidrs" {
  description = "Source CIDRs allowed to reach TCP 22. Empty means SSH is closed to the internet."
  type        = list(string)
  default     = []

  # Cross-variable validation, hence required_version >= 1.9.
  #
  # Both world CIDRs are listed even though this deployment is IPv4-only. The
  # NSG rules are built with a plain for_each over this list and source_type =
  # "CIDR_BLOCK", which accepts either family without complaint, so an
  # IPv4-only guard would silently pass "::/0" straight through to a live rule.
  validation {
    condition     = length(setintersection(toset(var.ssh_allowed_cidrs), toset(["0.0.0.0/0", "::/0"]))) == 0 || var.allow_ssh_from_anywhere
    error_message = "Opening SSH to 0.0.0.0/0 or ::/0 requires setting allow_ssh_from_anywhere = true. Brute-force traffic against 22 is the dominant background noise on any public IP."
  }
}

variable "allow_ssh_from_anywhere" {
  description = "Explicit opt-in required before ssh_allowed_cidrs may contain 0.0.0.0/0."
  type        = bool
  default     = false
}

variable "k8s_api_allowed_cidrs" {
  description = <<-EOT
    Source CIDRs allowed to reach the k3s API on TCP 6443.

    Leave this empty. The supported access path is an SSH tunnel:
    `ssh -L 6443:127.0.0.1:6443 <operator>@<ip>`, which `make tf-oci-kubeconfig`
    sets up for you. Exposing 6443 to the internet is the highest-severity
    mistake available in this design.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = length(setintersection(toset(var.k8s_api_allowed_cidrs), toset(["0.0.0.0/0", "::/0"]))) == 0
    error_message = "Refusing to expose the Kubernetes API to 0.0.0.0/0 or ::/0. Use an SSH tunnel instead."
  }
}

variable "restrict_ingress_to_cloudflare" {
  description = <<-EOT
    Restrict TCP 80/443 to Cloudflare's published ranges.

    This is what makes cf-connecting-ip trustworthy and prevents an attacker
    from bypassing the proxy by hitting the origin IP directly. Set to false
    only for a bring-up before DNS is in place.
  EOT
  type        = bool
  default     = true
}

variable "cloudflare_ipv4_ranges" {
  description = "Override Cloudflare's IPv4 ranges. Empty fetches https://www.cloudflare.com/ips-v4 at plan time."
  type        = list(string)
  default     = []
}

variable "ssh_public_key" {
  description = "SSH public key material authorised for the operator user."
  type        = string

  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+) ", var.ssh_public_key))
    error_message = "ssh_public_key must be an OpenSSH public key (ssh-ed25519, ssh-rsa or ecdsa-sha2-nistp*)."
  }
}

# ---------------------------------------------------------------------------
# Host configuration
# ---------------------------------------------------------------------------
variable "operator_username" {
  description = "Non-root user created on the box and granted passwordless sudo."
  type        = string
  default     = "sre"

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]{2,31}$", var.operator_username))
    error_message = "operator_username must be a valid lowercase Linux username."
  }
}

variable "k3s_version" {
  description = "k3s release to install. Pinned so a rebuild reproduces the verified Traefik chart version."
  type        = string
  default     = "v1.33.4+k3s1"

  validation {
    condition     = can(regex("^v1\\.[0-9]+\\.[0-9]+\\+k3s[0-9]+$", var.k3s_version))
    error_message = "k3s_version must look like v1.33.4+k3s1."
  }
}

variable "acme_email" {
  description = "Contact address for Let's Encrypt registration. Substituted into traefik-config.yaml."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.acme_email))
    error_message = "acme_email must be a valid email address."
  }
}

variable "swap_size_mb" {
  description = "Swapfile size in MB. OCI A1 images ship none, and an out-of-memory kill during a container build is unpleasant."
  type        = number
  default     = 2048

  validation {
    condition     = var.swap_size_mb >= 0 && var.swap_size_mb <= 8192
    error_message = "swap_size_mb must be between 0 and 8192."
  }
}

variable "extra_tags" {
  description = "Additional freeform tags merged into every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
locals {
  # "-free", not "-test", so OCI and Azure resource names are never ambiguous
  # in a log line or a cost report.
  prefix = "${var.owner_alias}-free"

  vcn_name      = "${local.prefix}-vcn"
  subnet_name   = "${local.prefix}-subnet"
  nsg_name      = "${local.prefix}-nsg"
  instance_name = "${local.prefix}-k3s"

  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[
    var.availability_domain_index
  ].name

  fetch_cloudflare_ipv4 = var.restrict_ingress_to_cloudflare && length(var.cloudflare_ipv4_ranges) == 0

  cloudflare_ipv4 = (
    var.restrict_ingress_to_cloudflare
    ? (
      length(var.cloudflare_ipv4_ranges) > 0
      ? var.cloudflare_ipv4_ranges
      : compact(split("\n", trimspace(data.http.cloudflare_ipv4[0].response_body)))
    )
    : ["0.0.0.0/0"]
  )

  # Every source permitted to reach the Traefik entrypoints, as one flat list
  # so the NSG rules can for_each over it. IPv4 only: see network.tf.
  web_ingress_cidrs = local.cloudflare_ipv4

  tags = merge(var.extra_tags, {
    environment = "free"
    owner       = var.owner_alias
    project     = "sre-simulator"
    purpose     = "free-tier-hosting"
    auto-delete = "do-not-delete"
  })
}
