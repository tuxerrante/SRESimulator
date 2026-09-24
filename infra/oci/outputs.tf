output "public_ip" {
  description = "Reserved public IP of the k3s box. This is the Cloudflare A-record target."
  value       = oci_core_public_ip.k3s.ip_address
}

output "instance_id" {
  description = "OCID of the compute instance."
  value       = oci_core_instance.k3s.id
}

output "instance_name" {
  description = "Display name of the compute instance."
  value       = oci_core_instance.k3s.display_name
}

output "availability_domain" {
  description = "Availability domain the instance landed in. Note it before a rebuild: A1 capacity is not uniform across ADs."
  value       = local.availability_domain
}

output "network_security_group_id" {
  description = "OCID of the NSG attached to the instance VNIC."
  value       = oci_core_network_security_group.instance.id
}

output "ssh_command" {
  description = "SSH into the box. Requires ssh_allowed_cidrs to include your address."
  value       = "ssh ${var.operator_username}@${oci_core_public_ip.k3s.ip_address}"
}

output "kubeconfig_command" {
  description = "Fetch a kubeconfig that talks to the API through an SSH tunnel."
  # No -C. README.md's workflow runs `cd infra/oci` first, so `-C infra/oci`
  # would resolve to infra/oci/infra/oci and fail for the reader most likely to
  # copy this line. The bare target is defined in both this root's Makefile and
  # the repository-root wrapper, so it works from either directory.
  value = "make tf-oci-kubeconfig"
}

output "api_tunnel_command" {
  description = "Open the SSH tunnel the kubeconfig expects. Port 6443 is closed at the NSG by design."
  value       = "ssh -N -L 6443:127.0.0.1:6443 ${var.operator_username}@${oci_core_public_ip.k3s.ip_address}"
}

output "post_apply_checklist" {
  description = "Manual steps that Terraform deliberately does not perform."
  value       = <<-EOT
    Free-tier box is up at ${oci_core_public_ip.k3s.ip_address}.

    Terraform stops here on purpose. The remaining steps touch DNS, a third
    party, and a live certificate authority, none of which belong in state.

     1. Cloudflare: create a PROXIED A record for your apex pointing at
        ${oci_core_public_ip.k3s.ip_address}. Leave the proxy on -- it is the
        only realistic DDoS mitigation at this budget, and restricting 80/443
        to Cloudflare's ranges (the default here) means a grey-clouded record
        simply will not answer.

     2. Confirm the origin is not reachable directly:
          curl -sS --max-time 10 http://${oci_core_public_ip.k3s.ip_address}/
        should hang or refuse from a non-Cloudflare address.

     3. Wait for cloud-init, then check k3s came up with the intended Traefik:
          ssh ${var.operator_username}@${oci_core_public_ip.k3s.ip_address}
          sudo cloud-init status --wait
          kubectl -n kube-system get ds,deploy
        Expect NO svclb DaemonSet and NO "traefik" Service. If you see either,
        the HelmChartConfig did not apply -- read
        /var/log/cloud-init-output.log before doing anything else.

     4. Verify the client IP survives before enabling
        backend.auth.requireAnonymousClientIp. A wrong answer fails closed and
        takes anonymous Easy mode down.

        Not from Traefik's own log: the chart leaves the access log disabled
        and traefik-config.yaml does not turn it on, so
        `logs deploy/traefik` prints startup lines and says nothing about any
        request. Ask a backend that echoes the headers it was handed:
          kubectl create namespace ip-probe
          kubectl -n ip-probe create deployment whoami \
            --image=traefik/whoami:v1.10.2
          kubectl -n ip-probe expose deployment whoami --port=80
          kubectl -n ip-probe create ingress whoami --class=traefik \
            --rule="probe.invalid/*=whoami:80"
          kubectl -n ip-probe rollout status deploy/whoami --timeout=180s
          node_ip=$(kubectl get nodes -o wide --no-headers | awk '{print $6}')
          kubectl -n ip-probe run client --restart=Never \
            --image=curlimages/curl:8.13.0 \
            -- curl -sk -H "Host: probe.invalid" "https://$node_ip/"
          kubectl -n ip-probe logs -f client
          kubectl -n ip-probe get pod client -o jsonpath='{.status.podIP}{"\n"}'
          kubectl delete namespace ip-probe
        X-Real-Ip in the echoed headers must equal the client pod's address.
        A Ready backend is not yet a programmed route -- Traefik reconciles
        Ingresses asynchronously, so a first 404 means retry, not failure.

        The request has to come from a genuine non-loopback source. Curling
        from the box proves nothing: loopback takes the "-i lo -j ACCEPT" path
        and reports an address no external caller can produce. Your own
        machine cannot reach the origin directly either, since 80/443 admit
        only Cloudflare's ranges by default -- which leaves a pod as the
        closest thing to an external client available before DNS exists.

        Also note that the frontend proxy reads x-envoy-external-address, which
        Traefik never sets. Until TRUSTED_CLIENT_IP_HEADER ships, leave
        requireAnonymousClientIp at its default of false.

     5. Only once DNS resolves: let Traefik order a certificate, and watch it.
          kubectl -n kube-system logs deploy/traefik -f | grep -i acme

    Back up state now: terraform state pull > backup-$(date +%F).tfstate
  EOT
}
