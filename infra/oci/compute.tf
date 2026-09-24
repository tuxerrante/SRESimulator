locals {
  # The one documented substitution into the shared Traefik config. See the
  # header of traefik-config.yaml: CI performs the same replace with a dummy
  # address, and nothing else about the file may differ between the two.
  #
  # jsonencode, not the bare value. The placeholder sits on an unquoted scalar
  # inside `valuesContent: |-`, which is a literal block scalar -- so the
  # HelmChartConfig itself always parses, and the damage is one level down, in
  # the values YAML that k3s's helm-controller parses to feed Helm. An address
  # beginning `>`, `*` or `{` reads there as a block scalar, an alias or a flow
  # mapping, and all three pass an email regex. Verified with go-yaml: the
  # outer document loads and the inner parse fails.
  #
  # That failure mode is bug 1 and bug 4 again. cloud-init writes this manifest
  # before k3s first starts, so a broken values document leaves Traefik at
  # chart defaults with servicelb already disabled -- no ingress at all.
  # YAML is a superset of JSON, so the emitted double-quoted scalar is inert
  # whatever the value contains. acme_email's own validation is the first of
  # the two barriers.
  traefik_config_rendered = replace(
    file("${path.module}/traefik-config.yaml"),
    "ACME_EMAIL_PLACEHOLDER",
    jsonencode(var.acme_email),
  )

  # indent() pads blank lines too, which leaves trailing whitespace that
  # yamllint rejects in the rendered user_data. Strip it here rather than in
  # the template, so the template stays readable.
  traefik_config_indented = replace(
    indent(6, local.traefik_config_rendered),
    "/(?m)[ \t]+$/",
    "",
  )

  # install.sh as tagged for exactly this release, rather than whatever
  # https://get.k3s.io serves at boot. The "+" in a k3s version is a real
  # character in the git tag and has to survive the URL path, so it is
  # percent-encoded here; raw.githubusercontent.com rejects the bare form.
  k3s_install_url = format(
    "https://raw.githubusercontent.com/k3s-io/k3s/%s/install.sh",
    replace(var.k3s_version, "+", "%2B"),
  )

  # k3s's default cluster CIDR. A local and not a variable on purpose:
  # cloud-init does not pass --cluster-cidr, so this is not something the
  # operator can choose -- it is a constant of the installer that the host
  # firewall rule has to agree with. vcn_cidr's overlap validation in
  # variables.tf refuses to collide with the same range.
  k3s_pod_cidr = "10.42.0.0/16"

  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    k3s_version        = var.k3s_version
    k3s_install_url    = local.k3s_install_url
    k3s_install_sha256 = var.k3s_install_script_sha256
    k3s_pod_cidr       = local.k3s_pod_cidr
    operator_username  = var.operator_username
    ssh_public_key     = trimspace(var.ssh_public_key)
    swap_size_mb       = var.swap_size_mb
    traefik_config     = local.traefik_config_indented
  })

  # gzip, not plain base64, because plain base64 does not fit. OCI caps the
  # combined metadata and extendedMetadata objects at 32,000 bytes (stated on
  # the Console's initialization-script field), and the rendered cloud-config
  # is 27,136 bytes -- mostly the 12,632-byte Traefik manifest embedded in it
  # -- which base64 inflates to 36,184. Measured with `terraform console`, not
  # estimated. The instance would have been refused at launch, and no test
  # here could have caught it: every one of them is mock_provider-backed, so
  # nothing weighs the metadata the API would have rejected.
  #
  # Safe because cloud-init decompresses user data before it decides what it
  # is. Verified against the cloud-init that ships in the Ubuntu 24.04 image
  # this box boots, not against the documentation: DataSourceOracle base64
  # decodes the metadata value into raw bytes, hands it to `convert_string`,
  # and `convert_string` runs `util.decomp_gzip(bdata, decode=False)` before
  # the MIME/cloud-config test. This exact payload was decompressed by that
  # function back to the same 27,136 bytes, beginning `#cloud-config`.
  #
  # `base64gzip` writes a zero mtime into the gzip header, so the value is
  # stable across runs -- checked, because an unstable one would show a
  # user_data diff on every plan and force a replace of the instance.
  #
  # The cost is that the Console no longer shows a readable script. `terraform
  # console -var-file=... 'local.cloud_init'` prints the plaintext, and the
  # README says so.
  user_data = base64gzip(local.cloud_init)

  # ssh_authorized_keys shares the same 32,000-byte budget, so the check is on
  # the sum rather than on user_data alone.
  metadata_bytes = length(local.user_data) + length(trimspace(var.ssh_public_key))
}

resource "oci_core_instance" "k3s" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = local.instance_name
  shape               = var.instance_shape
  freeform_tags       = local.tags

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu_arm.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_size_gbs
  }

  create_vnic_details {
    subnet_id      = oci_core_subnet.public.id
    nsg_ids        = [oci_core_network_security_group.instance.id]
    hostname_label = replace(local.prefix, "-", "")

    # No ephemeral public IP: a private IP can carry only one public IP, and
    # this one gets the RESERVED address below. The cost is that the instance
    # has no route to the internet for the few seconds between launch and the
    # reserved IP attaching, which is why cloud-init waits for connectivity
    # before its first download.
    assign_public_ip = false
  }

  metadata = {
    ssh_authorized_keys = trimspace(var.ssh_public_key)
    user_data           = local.user_data
  }

  lifecycle {
    # A newer Ubuntu image published upstream must not silently destroy and
    # recreate the box on an unrelated apply.
    ignore_changes = [source_details[0].source_id]

    # The limit is the API's, and it is only enforced at launch -- which is
    # after `terraform apply` has already created the VCN, the subnet, the
    # NSG and the reserved IP, leaving a half-built stack and an error that
    # names a byte count rather than the file that grew. A precondition moves
    # that refusal to plan time, where it costs nothing and can say what to
    # do about it.
    #
    # A limit rather than an equality: the manifest, the bootstrap script and
    # the operator's SSH key all grow, and the whole point is that the next
    # person to add 6 KB of cloud-config finds out at plan.
    precondition {
      condition     = local.metadata_bytes <= 32000
      error_message = <<-EOT
        Instance metadata is ${local.metadata_bytes} bytes, over OCI's 32,000-byte
        cap on metadata + extendedMetadata. The launch would be refused by the
        API after the rest of the stack had already been created.

        user_data is the gzipped, base64-encoded cloud-config from
        cloud-init.yaml.tftpl, which embeds traefik-config.yaml. Shrink one of
        those two files, or fetch the Traefik manifest at boot instead of
        embedding it -- noting that embedding is what keeps CI and the box
        provably on the same file.
      EOT
    }
  }
}

data "oci_core_vnic_attachments" "k3s" {
  compartment_id = var.compartment_ocid
  instance_id    = oci_core_instance.k3s.id
}

data "oci_core_private_ips" "k3s" {
  vnic_id = data.oci_core_vnic_attachments.k3s.vnic_attachments[0].vnic_id
}

# A reserved (not ephemeral) address so that a stop/start, or a rebuild after
# OCI reclaims an idle instance, does not invalidate the Cloudflare A record.
resource "oci_core_public_ip" "k3s" {
  compartment_id = var.compartment_ocid
  display_name   = "${local.prefix}-ip"
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_private_ips.k3s.private_ips[0].id
  freeform_tags  = local.tags
}
