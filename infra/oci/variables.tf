# ---------------------------------------------------------------------------
# Identity and placement
# ---------------------------------------------------------------------------
variable "owner_alias" {
  description = "Your corporate / Red Hat alias (e.g. jdoe). Used as prefix for all resource names."
  type        = string

  # 11, not 16, and the ceiling is not arbitrary. network.tf derives the VCN
  # DNS label as replace(local.prefix, "-", ""), i.e. this alias with "free"
  # appended, and OCI caps VCN and subnet DNS labels at 15 alphanumeric
  # characters starting with a letter. 11 + len("free") == 15 exactly.
  #
  # Without this the failure lands at apply time on an input that passed
  # terraform validate, which is the worst place for it: the VCN is one of the
  # first resources created, so the operator watches a plan succeed and the
  # apply die on a name.
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,10}$", var.owner_alias))
    error_message = "owner_alias must be 3-11 lowercase alphanumeric characters starting with a letter. The 11-character ceiling comes from OCI's 15-character VCN DNS label limit: network.tf appends \"free\" to this value."
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
    condition = (
      var.availability_domain_index >= 0 &&
      var.availability_domain_index < 3 &&
      floor(var.availability_domain_index) == var.availability_domain_index
    )
    error_message = "availability_domain_index must be the whole number 0, 1 or 2. A fractional value passes a bare range check and then fails at plan time with \"Invalid index\"."
  }
}

# ---------------------------------------------------------------------------
# Instance sizing -- Always Free envelope is 4 OCPU / 24 GB / 200 GB total
# ---------------------------------------------------------------------------
variable "instance_shape" {
  description = "Compute shape. VM.Standard.A1.Flex is the aarch64 Always Free shape."
  type        = string
  default     = "VM.Standard.A1.Flex"

  # VM.Standard.A1.Flex is the only Ampere A1 shape, and A1 is the only family
  # inside the Always Free allowance. Every other shape on the list bills by the
  # hour from the moment it launches.
  #
  # This is an allowlist rather than an output warning because of how the
  # mistake actually happens: a typo -- "VM.Standard.A2.Flex", "VM.Standard.E4.
  # Flex" -- is accepted by the API, provisions successfully, and produces a
  # working box that looks exactly like the intended one. Nothing in the apply
  # output distinguishes a free instance from a billable one, and the first
  # signal is a bill weeks later. An output cannot stop that; it is read after
  # the resource exists, which is already too late.
  #
  # A deliberate paid upgrade is still available, but has to say so.
  validation {
    condition = (
      var.allow_billable_shape ||
      contains(["VM.Standard.A1.Flex"], var.instance_shape)
    )
    error_message = "instance_shape must be VM.Standard.A1.Flex, the only Always Free shape. Any other shape bills hourly from launch and is indistinguishable from the free one in the apply output, so a typo here is silent. Set allow_billable_shape = true to provision a paid shape deliberately."
  }
}

variable "allow_billable_shape" {
  description = <<-EOT
    Explicit opt-in required before instance_shape may name a shape outside the
    Always Free A1 family.

    Setting this also lifts the instance_ocpus and instance_memory_gbs ceilings,
    which exist to keep the instance inside the same Always Free allowance and
    are meaningless once the shape is billable.
  EOT
  type        = bool
  default     = false
}

variable "instance_ocpus" {
  description = "OCPUs for the instance. The Always Free A1 allowance is 4 in total across all instances."
  type        = number
  default     = 2

  # The ceiling is the Always Free allowance, so it is lifted by the same
  # opt-in that lifts the shape allowlist -- a deliberate paid shape that could
  # not be sized past 4 OCPUs would be a pointless upgrade. The floor stays.
  validation {
    condition = (
      var.instance_ocpus >= 1 &&
      (var.allow_billable_shape || var.instance_ocpus <= 4)
    )
    error_message = "instance_ocpus must be between 1 and 4 to stay inside the Always Free A1 allowance. Set allow_billable_shape = true to size a paid shape past it."
  }
}

variable "instance_memory_gbs" {
  description = "Memory in GB. The Always Free A1 allowance is 24 GB in total across all instances."
  type        = number
  default     = 12

  # Lifted by allow_billable_shape for the same reason as instance_ocpus.
  validation {
    condition = (
      var.instance_memory_gbs >= 6 &&
      (var.allow_billable_shape || var.instance_memory_gbs <= 24)
    )
    error_message = "instance_memory_gbs must be between 6 and 24 to stay inside the Always Free A1 allowance. Set allow_billable_shape = true to size a paid shape past it."
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
# root on the box -- for traffic that crosses that VNIC. Pod-to-host traffic
# does not, so these lists govern internet exposure, not what a workload on the
# cluster can reach. See "What the NSG does not cover" in README.md.
# Everything below defaults to closed.
# ---------------------------------------------------------------------------
variable "ssh_allowed_cidrs" {
  description = "Source CIDRs allowed to reach TCP 22. Empty means SSH is closed to the internet."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.ssh_allowed_cidrs : can(cidrhost(c, 0))])
    error_message = "Every entry in ssh_allowed_cidrs must be a CIDR block, e.g. 203.0.113.4/32. A bare address is not one, and the NSG rule would be built from it verbatim."
  }

  # cidrhost() accepts both families and so does the NSG's CIDR_BLOCK source
  # type, so an IPv6 entry builds a rule OCI accepts and then never matches.
  # Nothing downstream has an IPv6 address to match it against: network.tf
  # gives the VCN no IPv6 CIDR (the half-wired enable_ipv6 path was removed
  # rather than completed), the VNIC is assigned no IPv6 address, and
  # Cloudflare reaches an IPv4-only origin over IPv4. The operator would read
  # "22 is open to my prefix" off a clean plan and then find the box
  # unreachable, with the rule sitting right there in the console.
  #
  # cidrnetmask() is the discriminator -- it errors on anything but IPv4.
  # The IPv6 arm of the coverage measurement below stays regardless: it is the
  # second barrier, and it is what catches "::/0" if this one is ever relaxed
  # to admit IPv6 alongside a completed dual-stack network.
  validation {
    condition     = alltrue([for c in var.ssh_allowed_cidrs : can(cidrnetmask(c))])
    error_message = "ssh_allowed_cidrs must contain IPv4 CIDRs only. This deployment is IPv4-only, so an IPv6 entry produces an NSG rule that can never match and silently leaves SSH closed."
  }

  # Cross-variable validation, hence required_version >= 1.9.
  #
  # This measures how much address space the list actually covers rather than
  # matching "0.0.0.0/0" as a string. The string form was the whole guard until
  # it was pointed out that ["0.0.0.0/1", "128.0.0.0/1"] is a pair of ordinary
  # -looking CIDRs that together cover every IPv4 host and sailed straight
  # past it. Any decomposition does -- four /2s, 256 /8s -- so the test has to
  # be coverage, not spelling.
  #
  # Both families are measured even though this deployment is IPv4-only. The
  # NSG rules are built with a plain for_each over this list and source_type =
  # "CIDR_BLOCK", which accepts either family without complaint, so an
  # IPv4-only guard would silently pass "::/0" straight through to a live rule.
  #
  # Entries that are not valid CIDRs are filtered out of both sums rather than
  # crashing the expression; the validation above is what reports them.
  validation {
    condition = (
      var.allow_ssh_from_anywhere ||
      (
        sum(concat([0], [
          for c in var.ssh_allowed_cidrs :
          pow(2, 32 - tonumber(split("/", c)[1])) if can(cidrnetmask(c))
        ])) < pow(2, 32) &&
        sum(concat([0], [
          for c in var.ssh_allowed_cidrs :
          pow(2, 128 - tonumber(split("/", c)[1]))
          if !can(cidrnetmask(c)) && can(cidrhost(c, 0))
        ])) < pow(2, 128)
      )
    )
    error_message = "ssh_allowed_cidrs covers the entire IPv4 or IPv6 address space, which requires setting allow_ssh_from_anywhere = true. Splitting the range (0.0.0.0/1 plus 128.0.0.0/1) is still opening SSH to the world. Brute-force traffic against 22 is the dominant background noise on any public IP."
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

    Scope of the guarantee: empty means closed *to the internet*, not closed
    absolutely. An NSG filters traffic crossing the VNIC, and pod-to-host
    traffic never crosses it, so with the host INPUT chain flushed -- which
    cloud-init does deliberately, see cloud-init.yaml.tftpl -- a workload on
    this cluster can reach 6443 on the node. That is not a gap this variable
    can close, and closing it at the host would buy nothing: the API is
    reachable in-cluster by design through the kubernetes.default.svc ClusterIP,
    so a compromised pod never needs the host port. The control that matters
    for a hostile workload is RBAC on its service account, not a firewall.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.k8s_api_allowed_cidrs : can(cidrhost(c, 0))])
    error_message = "Every entry in k8s_api_allowed_cidrs must be a CIDR block, e.g. 203.0.113.4/32."
  }

  # Same IPv4-only reasoning as ssh_allowed_cidrs: an IPv6 entry here builds a
  # rule that can never match, which on this variable reads as "I have scoped
  # the API to my prefix" while the practical effect is that 6443 stays shut.
  # That failure is in the safe direction, but it is still a lie in the plan.
  validation {
    condition     = alltrue([for c in var.k8s_api_allowed_cidrs : can(cidrnetmask(c))])
    error_message = "k8s_api_allowed_cidrs must contain IPv4 CIDRs only. This deployment is IPv4-only, so an IPv6 entry produces an NSG rule that can never match."
  }

  # Same coverage measurement as ssh_allowed_cidrs, and here it is load-bearing
  # for a promise the description makes outright: this list has no escape hatch,
  # so a guard that only recognised the canonical spelling would have let
  # ["0.0.0.0/1", "128.0.0.0/1"] expose the API to the entire internet while
  # still reading as "can never be opened to the world".
  validation {
    condition = (
      sum(concat([0], [
        for c in var.k8s_api_allowed_cidrs :
        pow(2, 32 - tonumber(split("/", c)[1])) if can(cidrnetmask(c))
      ])) < pow(2, 32) &&
      sum(concat([0], [
        for c in var.k8s_api_allowed_cidrs :
        pow(2, 128 - tonumber(split("/", c)[1]))
        if !can(cidrnetmask(c)) && can(cidrhost(c, 0))
      ])) < pow(2, 128)
    )
    error_message = "Refusing to expose the Kubernetes API to the entire address space, however it is spelled -- 0.0.0.0/0, ::/0, or a split such as 0.0.0.0/1 plus 128.0.0.0/1. Use an SSH tunnel instead."
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

  # This override is consumed whenever restrict_ingress_to_cloudflare is true,
  # so an unvalidated value defeats the setting it is supposed to configure:
  # ["0.0.0.0/0"] leaves the restriction switched on while admitting the whole
  # internet to 80/443, and with it the origin-IP bypass that restriction
  # exists to prevent -- which is also what makes cf-connecting-ip trustworthy.
  # restrict_ingress_to_cloudflare = false is the honest way to open the origin.
  validation {
    condition     = alltrue([for c in var.cloudflare_ipv4_ranges : can(cidrnetmask(c))])
    error_message = "Every entry in cloudflare_ipv4_ranges must be an IPv4 CIDR block. Cloudflare reaches an IPv4 origin over IPv4, and this deployment assigns no IPv6 address."
  }

  validation {
    condition = sum(concat([0], [
      for c in var.cloudflare_ipv4_ranges :
      pow(2, 32 - tonumber(split("/", c)[1])) if can(cidrnetmask(c))
    ])) < pow(2, 32)
    error_message = "cloudflare_ipv4_ranges covers the entire IPv4 address space, which leaves 80/443 open to the world while restrict_ingress_to_cloudflare still reads as enabled. Set restrict_ingress_to_cloudflare = false instead."
  }
}

variable "ssh_public_key" {
  description = "SSH public key material authorised for the operator user."
  type        = string

  # The three NIST curves are enumerated rather than matched as nistp[0-9]+,
  # which admitted "ecdsa-sha2-nistp999". RFC 5656 defines exactly these three
  # for SSH and OpenSSH implements no others, so the open form was only ever
  # able to wave through a typo -- and a typo here is an authorized_keys line
  # sshd ignores, on a box whose only other way in is a rebuild.
  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) ", var.ssh_public_key))
    error_message = "ssh_public_key must be an OpenSSH public key (ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, ecdsa-sha2-nistp384 or ecdsa-sha2-nistp521)."
  }

  # The check above stops at the type prefix and the space, so "ssh-ed25519 "
  # passed it. compute.tf then trimspaces that down to a bare type name and
  # cloud-init installs it as an authorized-keys line with no key material.
  # Nothing fails loudly: the instance comes up, the key is simply unusable --
  # and because 22 is closed by default and there is no console password, the
  # result is a box nobody can log into. Rebuilding it is the only recovery,
  # which is a steep price for a truncated copy-paste.
  #
  # Counting base64 characters is not enough to prevent that, which is why this
  # matches the wire format instead. An OpenSSH blob is a length-prefixed type
  # string followed by the key fields, so its opening bytes -- and therefore a
  # fixed run of leading base64 characters -- are fully determined by the key
  # type and cannot vary between keys. Matching that run ties the blob to the
  # type label in front of it and rejects anything that is merely spelled in the
  # base64 alphabet. The lengths are the encodings of the real key sizes:
  # ed25519 is invariant at 68 characters, the three NIST curves at 140/184/232,
  # and RSA floors at 204 (a 1024-bit modulus).
  #
  # Terraform cannot base64-decode this to check it properly: the decoded bytes
  # are binary and base64decode() insists on valid UTF-8, so it fails on roughly
  # every real key. Prefix matching is what is actually available here.
  #
  # Verified against keys from ssh-keygen for all six type/size combinations,
  # and against the reported bypass -- a 32-character ed25519 blob -- plus a
  # blob whose header names a different type than its label.
  validation {
    condition     = can(regex("^(ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{48}|ssh-rsa AAAAB3NzaC1y[A-Za-z0-9+/]{192,}={0,2}|ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAy[A-Za-z0-9+/]{110,}={0,2}|ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAz[A-Za-z0-9+/]{154,}={0,2}|ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1[A-Za-z0-9+/]{202,}={0,2})([[:space:]].*)?$", var.ssh_public_key))
    error_message = "ssh_public_key must carry a well-formed OpenSSH blob matching its key type, e.g. \"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... user@host\". Base64 characters alone are not enough: a truncated or mistyped blob installs an authorized-keys line that can never authenticate, on a box whose only other way in is a rebuild."
  }

  # The regex above is unanchored at the end, and compute.tf's trimspace only
  # strips leading and trailing whitespace -- so a value whose *first* line is a
  # valid key passes while carrying arbitrary further lines. cloud-init.yaml.tftpl
  # interpolates this into a YAML sequence item, so those lines land as
  # top-level cloud-config directives. Verified by rendering the real template:
  # a key with one embedded newline injected a new top-level key alongside
  # runcmd, users and write_files.
  #
  # The template also quotes the value now, so this is the second of two
  # independent barriers rather than the only one.
  validation {
    condition     = !can(regex("[\r\n]", var.ssh_public_key))
    error_message = "ssh_public_key must be a single line. Embedded newlines are interpolated into cloud-init as additional YAML directives."
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

  # "root" satisfies the pattern above, and the description's promise of a
  # non-root operator is the whole reason this variable exists. cloud-init
  # would add the authorized key to the root account directly, and the
  # bootstrap would install the kubeconfig into /home/root -- a directory that
  # is not root's home on Ubuntu, so the file would also land somewhere the
  # operator never looks.
  validation {
    condition     = var.operator_username != "root"
    error_message = "operator_username must not be root. The operator account is created with passwordless sudo precisely so that the key does not authorise the root account directly."
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

  # Deliberately narrower than RFC 5321, which permits characters such as
  # `>`, `*` and `{` in a local part. compute.tf substitutes this value onto an
  # unquoted YAML scalar that k3s's helm-controller parses, where each of those
  # begins a block scalar, an alias or a flow mapping -- and a values document
  # that fails to parse leaves the box with no ingress at all. No ACME contact
  # address needs them, so the conservative set is the right trade here, and
  # compute.tf quotes the value as a second barrier.
  validation {
    condition     = can(regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", var.acme_email))
    error_message = "acme_email must be a valid email address using the conventional character set (letters, digits, and . _ % + - before the @)."
  }
}

variable "swap_size_mb" {
  description = "Swapfile size in MB. OCI A1 images ship none, and an out-of-memory kill during a container build is unpleasant."
  type        = number
  default     = 2048

  validation {
    condition = (
      var.swap_size_mb >= 0 &&
      var.swap_size_mb <= 8192 &&
      floor(var.swap_size_mb) == var.swap_size_mb
    )
    error_message = "swap_size_mb must be a whole number between 0 and 8192. It is interpolated into fallocate -l and dd count=, neither of which takes a fraction."
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
