# Openshift Clusters: Alerts/Symptoms and Possible Root Causes or Resolutions

## Cluster Availability & Health

### Cluster Shutdown & Failed Restart

- **Version:** 4.x (Exact version unspecified)
- **Symptoms:** The cluster was reporting critical failures with etcd offline, API pods offline, and all nodes in a Not Ready state.
- **Root Cause:** The customer had deallocated (powered off) the cluster for a significant period. When they attempted to power it back on, the cluster failed to recover its state (likely due to etcd quorum loss or certificate expiry during downtime). The investigation concluded this was customer-induced.
- **Technical Details:** When etcd quorum is lost, the OpenShift API becomes read-only. Applications running on the cluster are unaffected, but platform functionality is limited — you cannot scale applications, change deployments, or run builds. An etcd cluster with 3 members requires at least 2 healthy members to maintain quorum.
- **Recovery Options:**
  1. **Quorum Restore (no backup required):** Use the `quorum-restore.sh` script, which brings back a single-member etcd cluster based on its local data directory and retires the previous cluster identifier. SSH into the recovery node (choose the member with the highest Raft index that is not a learner) and run the script. Remaining online nodes automatically rejoin the new etcd cluster.
  2. **Restore from etcd backup:** Use `cluster-restore.sh` to restore etcd from a prior backup. Requires at least one healthy master host.
  3. After recovery, return to a three-node configuration by deleting and re-creating any offline nodes. A new revision is forced and etcd automatically scales up.
- **References:**
  - [OKD Docs: Quorum Restoration](https://docs.okd.io/latest/backup_and_restore/control_plane_backup_and_restore/disaster_recovery/quorum-restoration.html)
  - [OpenShift Examples: Lost Quorum](https://examples.openshift.pub/control-plane/lost-quorum/)

### Missing Master Node / Disturbed Indexing

- **Version:** Unknown
- **Symptoms:** The cluster was missing an entire master node (master-2), and indexing was reported as "disturbed".
- **Root Cause:** The node was deleted, likely by the customer. SREs attempted to verify the actor via ARM logs but found them missing timestamp/identity details ("List Cluster Credentials" was the only return), leading to a "square 0" investigation state.
- **Diagnostic Commands:**

  ```bash
  oc get machines -n openshift-machine-api
  oc get nodes
  oc describe machine <machine-name> -n openshift-machine-api
  ```

### Master-0 Machine in Failed State

- **Version:** Unknown
- **Symptoms:** The master-0 machine object was in a "Failed" state, even though the underlying node appeared "Ready" (or became ready after SRE redeployment).
- **Root Cause:** The machine entered a failed state (possibly due to a transient provisioning issue), and OpenShift stops reconciling the machine status once it reaches "Failed". The remediation required manually patching the machine status back to "Provisioned" to align it with the healthy node state.
- **Technical Details:** When a Machine enters the "Failed" phase in OpenShift, it is considered permanent. The machine controller's actuator `Update()` method is never called again, and reconciliation stops. Common causes include: the cloud instance was terminated by an outside actor, cloud credentials were missing, or the provisioning state shows "Failed" despite the VM being healthy.
- **Official Remediation:** The officially supported approach is to **delete the failed Machine object** and let the MachineSet create a replacement: `oc delete machine <machine-name> -n openshift-machine-api`. Manually patching the status from "Failed" to "Provisioned" is **not officially supported** because the actuator will not resume reconciliation even after the patch. However, for control plane machines, editing the machine CR to remove `lifecycleHooks` contents may be necessary.
- **Diagnostic Commands:**

  ```bash
  oc get machines -n openshift-machine-api
  oc logs -n openshift-machine-api deployment/machine-api-controllers -c machine-controller
  ```

- **References:**
  - [Machine API Operator Troubleshooting](https://github.com/openshift/machine-api-operator/blob/main/docs/user/TroubleShooting.md)
  - [OKD: Troubleshooting Control Plane Machine Set](https://docs.okd.io/latest/machine_management/control_plane_machine_management/cpmso-troubleshooting.html)

### Kube-apiserver Hard Down

- **Version:** Unknown
- **Symptoms:** kube-apiserver was completely down; logs were missing for the previous 24 hours.
- **Root Cause:** The cluster had been deallocated and powered back on, causing the control plane components to fail to recover automatically. See "Cluster Shutdown & Failed Restart" above for etcd quorum recovery procedures.

## Installation Failures

### Cluster Install Failure (410 Gone)

- **Version:** 4.11 / 4.12 / 4.13 (Impacted installer images)
- **Symptoms:** Cluster installations failed consistently with a 410 Gone response regarding the OS image.
- **Root Cause:** A backend issue with the Azure machine image repository (potentially triggered by a Windows update) caused it to incorrectly report Red Hat CoreOS (RHCOS) images as deleted/gone. This was a widespread outage requiring an RP configuration update to reference specific image digests.
- **Technical Details:** A `410 Gone` HTTP status on Azure during RHCOS image retrieval typically means the RHCOS VHD blob URL embedded in the installer version has been decommissioned or removed from Azure storage. Older OpenShift installer versions reference RHCOS image URLs via the `rhcos-redirector` service, which may have been retired. The redirector host `rhcos-redirector.apps.art.xq1c.p1.openshiftapps.com` embedded in older installers (4.6, 4.7.53 and earlier, 4.8.48 and earlier, 4.9.44 and earlier) may no longer resolve.
- **Workarounds:**
  - Upgrade the installer to a newer version that references current RHCOS image URLs.
  - For air-gapped/restricted networks, manually download the RHCOS image from [mirror.openshift.com](https://mirror.openshift.com) and host it locally.
  - For Azure Stack Hub, specify the `clusterOSImage` field in the install config.
- **References:**
  - [Red Hat Solution 7027723: Cannot Install OpenShift Cluster using RHCOS Images](https://access.redhat.com/solutions/7027723)

### Hive Install Failure (OCPBUGS-35300)

- **Version:** 4.14
- **Symptoms:** HiveClusterInstallFailure with an "Unknown Error" in the Hive cluster logs.
- **Root Cause:** Traced to OpenShift bug OCPBUGS-35300. The bug is related to the Machine Config Daemon (MCD) on Azure — specifically, the MCD pull service starts before networking is fully available. The fix (PR `openshift/machine-config-operator#4423`) ensures the MCD pull service runs after the `network-online.target` systemd unit.
- **Workaround:** Delete and recreate the cluster using version 4.13 until the fix is available.
- **Diagnostic Tips:** Each install attempt runs in a pod in the same namespace as the ClusterDeployment. Filter with `-l hive.openshift.io/job-type=provision` to find provision pods and check their logs.
- **References:**
  - [OCPBUGS-35300 on Red Hat Jira](https://issues.redhat.com/browse/OCPBUGS-35300)
  - [Hive Troubleshooting Guide](https://github.com/openshift/hive/blob/master/docs/troubleshooting.md)

### ARM Template Zonal Allocation Failure

- **Version:** Unknown
- **Symptoms:** Master VM creation failed in westus2 and centralindia with an ARM error: "expects all elements to be of type...".
- **Root Cause:** An abrupt change in ARM's validation logic began rejecting the Availability Zone parameter when passed as a string (e.g., "1") instead of an integer (e.g., 1). This broke the RP's ARM templates for master node deployment in specific regions.

### Install Failure (ARO-10654)

- **Version:** 4.14
- **Symptoms:** Cluster install failure where the customer saw an "Internal Server Error".
- **Root Cause:** Identified as a bug tracked by ARO-10654. The failure was related to specific networking configurations (UDR) in 4.14 installer logic. Specifically, the ARO gateway proxy was not active early enough in the machine boot sequence — the `machine-config-daemon-pull` service attempted to pull an image before the ARO-provisioned dnsmasq service started. In clusters dependent on the RP Gateway Service (private clusters with UDR), the ACR image pull would fail with a timeout.
- **Resolution:** As of September 5, 2024, all new cluster installs have been patched. Fleet-wide maintenance completed October 25, 2024. Safe upgrade edges: 4.13.51, 4.13.52, 4.14.38, 4.14.39.
- **Previous Workaround:** Add an Internet route for `arosvc.azurecr.io` or add a `0.0.0.0/0` Internet route to the route table.
- **References:**
  - [Red Hat Solution 7074686: Troubleshooting ARO 4.14.z / 4.13.40 Install Failures](https://access.redhat.com/solutions/7074686)

### Install Failure (Invalid SKU)

- **Version:** Unknown
- **Symptoms:** Cluster installation failed.
- **Root Cause:** The customer selected an invalid or unsupported VM SKU for the cluster nodes, causing the provisioning process to fail validation.

### Hive Install Failure (ClusterDeployment Controller)

- **Version:** Unknown
- **Symptoms:** HiveClusterInstallFailure with log messages pointing to errors in the clusterdeployment-controller.
- **Root Cause:** The error was related to an invalid ARM template or resource ID issue where the automation workflow failed to populate the resource ID correctly, masking the true error.

## Update & Upgrade Issues

### Post-PUCM Cluster Issues

- **Version:** Unknown
- **Symptoms:** The cluster experienced issues immediately following a Pre-Upgrade Cluster Maintenance (PUCM) run.
- **Root Cause:** The cluster was PUCM'd using an older, incompatible version of the maintenance script. It required a re-run with the correct payload to fix the state.

### Pull Secret / Operator Update Failure

- **Version:** 4.12.54
- **Symptoms:** The ARO Operator update failed. One worker pod successfully pulled image 0116:01, but another failed to pull 0116:06 with an unauthorized error.
- **Root Cause:** The image pull secret used by the ARO operator was invalid or expired. The cluster required a specific PUCM update to rotate the ACR token and fix the secrets/certs.
- **Technical Details:** The cluster pull secret (in `openshift-config/pull-secret`) contains an `arosvc.azurecr.io` auth entry that is critical for cluster operation. The `imagecontentsourcepolicies` are configured with digest mirrors pointing to `arosvc.azurecr.io` as mirrors for upstream `quay.io` sources. If this auth entry expires or is corrupted, image pulls fail with `unauthorized` errors.
- **Warning:** Never remove or alter the `arosvc.azurecr.io` entry from the pull secret — it is required for the cluster to function properly.
- **References:**
  - [Microsoft: Add or Update Pull Secret on ARO](https://learn.microsoft.com/en-us/azure/openshift/howto-add-update-pull-secret)
  - [Red Hat Solution 6656861: Failed to pull image from azurecr.io in ARO](https://access.redhat.com/solutions/6656861)

### Upgrade Stuck (Partition Table)

- **Version:** Upgrading 4.12.25 -> 4.12.30
- **Symptoms:** Upgrade hung; machine-config-daemon pods were degraded.
- **Root Cause:** The daemon failed with "failed to update the partition table". This is a known issue where the partition table update on the nodes fails during the upgrade process, blocking the new machine config application.
- **Technical Details:** This can occur when Ignition tries to modify disk partitions during the MCD update process and the disk layout doesn't match expectations, or the disk is locked by another process. Related issues include the MCD failing to pivot the OS image (`rpm-ostree rebase` failures).
- **Diagnostic Commands:**

  ```bash
  oc get mcp
  oc logs -f -n openshift-machine-config-operator -c machine-config-daemon <pod-name>
  ```

- **Recovery:** Force the machine-config daemon to re-validate by running: `oc debug node/<node_name> -- touch /host/run/machine-config-daemon-force`, then the node will reboot and re-apply the config.
- **References:**
  - [Red Hat Solution 5244121: MachineConfigPool stuck in degraded](https://access.redhat.com/solutions/5244121)

### Preconfigured NSG Reset during PUCM

- **Version:** Unknown
- **Symptoms:** `az aro update` commands failed for the customer. SREs noted the cluster appeared to have preconfiguredNSG disabled despite being enabled previously.
- **Root Cause:** A critical bug in the PUCM logic caused the preconfiguredNSG flag in the cluster document to be reverted to disabled (from enabled) during maintenance. This put the cluster in a state where the RP attempted to manage NSGs that the customer owned, causing updates to fail.
- **Technical Details:** In the ARO-RP codebase, `PreconfiguredNSG` is a string field with values `"Enabled"` or `"Disabled"`. The REST API default is `"Disabled"`. If the PUCM maintenance path does not explicitly preserve this field during cluster document updates, it reverts to the default, causing the ARO operator's subnets controller to attempt managing customer-owned NSGs.
- **References:**
  - [Microsoft: Bring your own NSG to ARO](https://learn.microsoft.com/en-us/azure/openshift/howto-bring-nsg)
  - [ARO-RP Source Code](https://github.com/Azure/ARO-RP)

### Stuck Upgrades (Machine Config Mismatch)

- **Version:** Multiple (4.12->4.15, 4.17->4.18)
- **Symptoms:** Clusters stuck during upgrade. Master nodes showing "Unexpected on-disk state".
- **Root Cause:** Customer workloads or configurations (specifically around dnsmasq or custom machine configs) interfered with the on-disk state expected by the Machine Config Operator (MCO). The MCO blocked the upgrade because the actual node state drifted from the rendered config.
- **Technical Details:** The MCD regularly checks nodes for configuration drift. If the system state differs from what the MCO expects, it sets the MachineConfigPool as Degraded and stops taking action. Common drift types include:
  - **Content mismatch:** Files on disk were manually edited (e.g., `/usr/local/bin/configure-ovs.sh`, `/etc/ssh/sshd_config`).
  - **File mode mismatch:** Permissions differ from the rendered MachineConfig (e.g., expected `0600`, found `0644`).
  - **OS image URL mismatch:** The running OS image doesn't match the expected `osImageURL`.
- **Resolution:**
  1. Fix the mismatched file content on the affected node using `oc debug node/<NODE>`.
  2. Force the machine-config to refresh by updating the `machineconfiguration.openshift.io/currentConfig` annotation on the node.
  3. For OS image mismatches, manually pivot to the correct OS image using `machine-config-daemon pivot`.
- **Diagnostic Commands:**

  ```bash
  oc get mcp
  oc describe mcp worker  # or master
  oc get node <node_name> -o yaml | grep machineconfiguration
  oc logs -n openshift-machine-config-operator <mcd-pod> -c machine-config-daemon
  ```

- **References:**
  - [Red Hat Solution 5315421: On-disk validation fails on file content mismatch](https://access.redhat.com/solutions/5315421)
  - [Red Hat Solution 5598401: Cluster Updates but MCP Degraded with "Unexpected on-disk state"](https://access.redhat.com/solutions/5598401)
  - [Red Hat Solution 4724681: Upgrade stalls waiting for machine-config operator](https://access.redhat.com/solutions/4724681)

### Slow Upgrade (Manual Uncordon Required)

- **Version:** Unknown
- **Symptoms:** Cluster update took approximately 8 hours to complete.
- **Root Cause:** The nodes were not draining/uncordoning automatically as expected. The customer had to manually uncordon nodes to allow the upgrade to progress, likely due to Pod Disruption Budgets (PDBs) or workloads preventing the drain.
- **Technical Details:** If a PDB is misconfigured (e.g., `minAvailable` equals the replica count, or replicas is 1 with a PDB), the MCD cannot drain the node and the upgrade hangs. The MCO will report degraded with "failed to drain node after 1 hour" and log "Cannot evict pod as it would violate the pod's disruption budget." A single misconfigured PDB by any developer can block cluster-wide upgrades.
- **Diagnostic Commands:**

  ```bash
  oc get pdb --all-namespaces
  oc get nodes -o wide  # Check for SchedulingDisabled nodes
  oc adm uncordon <node-name>  # Manual uncordon if stuck
  ```

- **Workarounds:**
  1. Use `oc adm drain <node> --disable-eviction` to bypass PDB checks (use with caution).
  2. Delete the problematic PDB or pods before upgrading.
  3. Increase replicas so they exceed the `minAvailable` PDB threshold.
  4. Check the `PodDisruptionBudgetAtLimit` alert using PromQL: `kube_poddisruptionbudget_status_current_healthy == kube_poddisruptionbudget_status_desired_healthy`.
- **References:**
  - [Red Hat Solution 4736031: Drain with PDB blocks in OpenShift 4](https://access.redhat.com/solutions/4736031)
  - [Red Hat Solution 4857671: PDB causes MCO degraded](https://access.redhat.com/solutions/4857671)
  - [OpenShift Runbook: PodDisruptionBudgetAtLimit](https://github.com/openshift/runbooks/blob/master/alerts/cluster-kube-controller-manager-operator/PodDisruptionBudgetAtLimit.md)

## Configuration & Customer Action

### Compliance Operator Failure

- **Version:** Unknown
- **Symptoms:** The compliance operator scan failed.
- **Root Cause:** The scan failed because the ARO APIServer object encryption was not set to aescbc by default (or as expected by the compliance profile). This was a mismatch between ARO defaults and the compliance check expectations.
- **Technical Details:** By default, etcd data is **not encrypted** in OpenShift Container Platform. The CIS/PCI-DSS compliance rule `ocp4-cis-api-server-encryption-provider-config` checks `oc get apiserver cluster -ojson | jq -r '.spec.encryption.type'` and expects `aescbc`. When encryption is not enabled, the scan reports FAILED. With OpenShift 4.11 and earlier, only `aescbc` is supported; OpenShift 4.13+ also supports `aesgcm` (AES-GCM).
- **Remediation:**
  1. **Via Compliance Operator:** Apply the auto-generated `ComplianceRemediation` objects: `oc -n openshift-compliance patch complianceremediations/<scan>-<rule> --patch '{"spec":{"apply":true}}' --type=merge`
  2. **Manual fix:** Run `oc edit apiserver cluster` and set `spec.encryption.type: aescbc`. The encryption process can take 20+ minutes depending on cluster size.
  3. **Verify:** `oc get openshiftapiserver -o=jsonpath='{range .items[0].status.conditions[?(@.type=="Encrypted")]}{.reason}{"\n"}{.message}{"\n"}'`
  4. **Rescan:** `oc annotate compliancescans/<scan_name> compliance.openshift.io/rescan=`
- **References:**
  - [Red Hat: Encrypting etcd data](https://docs.redhat.com/en/documentation/openshift_container_platform/4.10/html/security_and_compliance/encrypting-etcd)
  - [Red Hat: Compliance Operator](https://docs.redhat.com/en/documentation/openshift_container_platform/4.9/html/security_and_compliance/compliance-operator)

### Image Pull Errors (arosvc unreachable)

- **Version:** Unknown
- **Symptoms:** arosvc.azurecr.io Unreachable / Image pull errors.
- **Root Cause:** The cluster was unable to authenticate to the ARO service container registry due to an invalid pull secret or authentication issue to the mirror.
- **Technical Details:** The cluster has `imagecontentsourcepolicies` configured with repository digest mirrors pointing to `arosvc.azurecr.io/openshift-release-dev/ocp-release` and `arosvc.azurecr.io/openshift-release-dev/ocp-v4.0-art-dev` as mirrors for upstream `quay.io` sources. Errors typically appear as: `"dial tcp: lookup arosvc.[region].data.azurecr.io: no such host"` or `unauthorized: authentication required`.
- **Diagnostic Commands:**

  ```bash
  oc get secrets pull-secret -n openshift-config -o template='{{index .data ".dockerconfigjson"}}' | base64 -d | jq .
  oc get imagecontentsourcepolicy -o yaml
  ```

- **Warning:** Never remove or alter the `arosvc.azurecr.io` entry from the pull secret — it is required for the cluster to function.
- **References:**
  - [Red Hat Solution 6656861: Failed to pull image from azurecr.io in ARO](https://access.redhat.com/solutions/6656861)
  - [Microsoft: Add or Update Pull Secret on ARO](https://learn.microsoft.com/en-us/azure/openshift/howto-add-update-pull-secret)

### Guardrails Crashlooping

- **Version:** Unknown
- **Symptoms:** Guardrails pods were crashlooping.
- **Root Cause:** The customer installed Guardrails via Helm/OLM before it was officially supported or fully integrated in ARO, causing permission issues or configuration conflicts with the managed service.

### PV Deletion Blocked by Deny Assignment

- **Version:** Unknown
- **Symptoms:** Customer unable to delete Persistent Volumes (PVs).
- **Root Cause:** The ARO Deny Assignment prevents customers from directly deleting PV resources to protect the storage backend. They must delete the Persistent Volume Claim (PVC) instead, which triggers the PV deletion.
- **Technical Details:** In ARO, a DenyAssignment is attached to the auto-generated resource group (e.g., `aro-infra-xxxxxxx-clustername`). Only the Cluster Service Principal is excluded from this deny assignment. The error when trying to delete directly is: `"The client <USER-ID> has permission to perform action Microsoft.Compute/disks/delete; however, the access is denied because of the deny assignment."` If a PV is deleted before the PVC, the backend Azure disk is orphaned and cannot be manually deleted due to the deny assignment — a support case is required.
- **Microsoft policy:** "Don't circumvent the deny assignment that is configured as part of the service, or perform administrative tasks normally prohibited by the deny assignment."
- **Correct procedure:** Always delete the **PVC** first, which triggers OpenShift to automatically clean up the PV and the underlying Azure disk.
- **References:**
  - [Red Hat Solution 6540431: Unable to delete backend Azure disk after deleting the PV](https://access.redhat.com/solutions/6540431)
  - [Red Hat Solution 6990216: Deny assignment error when trying to delete Azure disk](https://access.redhat.com/solutions/6990216)
  - [Microsoft: ARO Support Policies](https://learn.microsoft.com/en-us/azure/openshift/support-policies-v4)

### MCO Broken (Permissions Modification)

- **Version:** Unknown
- **Symptoms:** Machine Config Operator (MCO) broken.
- **Root Cause:** The customer recursively modified file permissions on control plane nodes (specifically /etc or similar critical paths) to 755. This broke SSH access and internal component authentication, requiring node replacement or cluster recreation.
- **Technical Details:** The MCO regularly validates on-disk state against the rendered MachineConfig. Recursive permission changes to `/etc` cause widespread file mode mismatches (e.g., `/etc/ssh/sshd_config` expected `0600`, found `0644`), which the MCO detects and marks the node as Degraded. Since SSH keys and certificates also have their permissions changed, remote access and internal component authentication break simultaneously.

### EgressIP Misconfiguration

- **Version:** Unknown
- **Symptoms:** Customer unable to log in to the cluster.
- **Root Cause:** The customer knowingly changed the cluster egressIP to an incorrect one, breaking the return path for API server traffic or authentication flows.
- **Technical Details:** If the `egressIPs` parameter is set on a NetNamespace but no node hosts that egress IP address, **all egress traffic from that namespace is silently dropped**. If a broad or incorrect `namespaceSelector` accidentally matches OpenShift system namespaces (e.g., `openshift-authentication`, `openshift-kube-apiserver`), it can reroute critical API server and OAuth traffic through the egress IP path, breaking cluster communications and login.
- **Key risks:**
  - Do not create egress rules with broad label selectors that force all namespaces to use the same outbound IP — this can crash the hosting node during high traffic.
  - An error in a label selector can change the outbound IP for many namespaces at once.
  - Egress IP configuration differences exist between OpenShift SDN and OVN-Kubernetes, requiring manual reconfiguration after CNI migration.
- **Diagnostic Commands:**

  ```bash
  oc get egressip
  oc get netnamespace <namespace> -o yaml  # For OpenShift SDN
  oc get hostsubnet -o yaml  # Check egress IP assignments on nodes
  ```

- **References:**
  - [Red Hat: Configuring egress IPs (OVN-Kubernetes)](https://docs.redhat.com/en/documentation/openshift_container_platform/4.18/html/ovn-kubernetes_network_plugin/configuring-egress-ips-ovn)
  - [Red Hat Solution 7005481: How to validate EgressIP is working](https://access.redhat.com/solutions/7005481)

### Master Node Deleted

- **Version:** Unknown
- **Symptoms:** Master node missing/deleting.
- **Root Cause:** The customer manually deleted the master node (unsupported action). The cluster was missing a machine in the machine-api, and the customer had likely removed the VM or the machine object directly.

### Storage / Plugin Deletion Failure

- **Version:** Unknown
- **Symptoms:** Storage issues; unable to delete plugins.
- **Root Cause:** The customer force-deleted PVs (--grace-period=0) instead of PVCs, or deleted the CSI driver/plugin before deleting the PVs, leaving resources in a terminating state that couldn't be cleaned up.

### SLA Breach Warning

- **Version:** Unknown
- **Symptoms:** Customer flagged a potential SLA breach.
- **Root Cause:** Confusion regarding the MCS SLA vs ARO SLA. The service was actually fine, but the customer misinterpreted the metrics/status.

## Monitoring, Logging & Telemetry

### False Active Alerts (MDM Bug)

- **Version:** N/A
- **Symptoms:** False active alerts and Ingestion Heartbeat failure.
- **Root Cause:** A bug in the MDM (Monitoring Data Manager) service caused "Failed to read HTTP status line" errors. It was an internal MDM bug, not a network issue.

### Cosmos DB 429 / Monitor Panic

- **Version:** N/A
- **Symptoms:** Cosmos DB 429 throttling / Region instability in West Europe.
- **Root Cause:** The ARO Monitor service was crashlooping due to a nil pointer exception (dereference) when processing a specific cluster's data. This crashloop caused a massive spike in requests to Cosmos DB, consuming all RUs and throttling the entire region.

### GatewayAvailability / Geneva Blip

- **Version:** N/A
- **Symptoms:** GatewayAvailability / DBTokenDegraded alerts.
- **Root Cause:** False positives due to a Geneva blip (heartbeat failure) or MDM statsd socket broken pipe. The underlying services were healthy, but the monitoring agent failed to report.

## Resource & Capacity

### LB Throttling / Storage Account API Flood

- **Version:** Unknown
- **Symptoms:** Load Balancer throttling.
- **Root Cause:** Initially suspected to be a Storage Account Controller API flood. Later linked to an OCP Image Registry bug where the registry was making excessive calls, causing throttling on the underlying Azure resources.

### MHC / Core Quota Issues

- **Version:** Unknown
- **Symptoms:** MHCUnterminatedShortCircuit alert firing saying "No quota issues".
- **Root Cause:** Despite the error message claiming no quota issues, it was actually a core quota issue preventing the machine from being created. The error message logic was misleading.
- **Technical Details:** The `MachineHealthCheckUnterminatedShortCircuit` alert fires when `mapi_machinehealthcheck_short_circuit == 1`. Known bugs (OCPBUGS-4725, OCPBUGS-8286) cause this alert to fire spuriously — the `mapi_machinehealthcheck_short_circuit` Prometheus metric fails to properly reconcile and remove MachineHealthChecks that have been deleted. Short-circuiting is controlled by the `maxUnhealthy` field: if not set, it defaults to 100% and machines are remediated regardless of cluster state.
- **References:**
  - [OCPBUGS-4725](https://issues.redhat.com/browse/OCPBUGS-4725)
  - [Red Hat: Deploying Machine Health Checks](https://docs.openshift.com/container-platform/4.8/machine_management/deploying-machine-health-checks.html)

### HighOverallControlPlaneMemory (Recurring)

- **Version:** Unknown
- **Symptoms:** HighOverallControlPlaneMemory alert (5th occurrence).
- **Root Cause:** Recurring memory pressure on the control plane nodes due to customer workloads or scale. The customer had 26 worker nodes (E series), putting significant load on the masters. Required resize.

## Networking & Security

### CoreDNS Failures

- **Version:** Unknown
- **Symptoms:** CoreDNS failures.
- **Root Cause:** Customer DNS configuration issue. CEE requested SRE to run troubleshooting steps, but the issue was ultimately a misconfiguration on the customer's end.
- **Technical Details:** The DNS Operator deploys CoreDNS as a DaemonSet to provide name resolution to pods. For external domains, CoreDNS uses the forward plugin to send queries upstream (defaulting to the node's `/etc/resolv.conf`). A known issue involves repeated SERVFAILs: CoreDNS has a 6-second timeout on forwarded requests. Due to dnsmasq queueing behavior, if a forwarded request is lost, CoreDNS responds with SERVFAIL for all queries for that name/type for the next 40 seconds.
- **Diagnostic Commands:**

  ```bash
  oc get pods -n openshift-dns
  oc get dns.operator/default -o yaml
  oc logs -n openshift-dns <coredns-pod>
  # Test DNS from inside a pod:
  oc debug node/<node> -- nslookup kubernetes.default.svc.cluster.local
  ```

- **Resolution Options:**
  - Configure per-zone DNS forwarding in the DNS Operator to bypass problematic upstream resolvers.
  - Ensure EgressNetworkPolicy allows DNS traffic (both UDP and TCP).
  - Tune CoreDNS cache duration to reduce upstream load.
- **References:**
  - [Red Hat Solution 3804501: Troubleshooting OCP 4 DNS](https://access.redhat.com/solutions/3804501)
  - [Red Hat Solution 7015390: CoreDNS SERVFAIL Timeouts on ARO](https://access.redhat.com/solutions/7015390)
  - [Red Hat: DNS Operator in OpenShift](https://docs.openshift.com/container-platform/4.11/networking/dns-operator.html)

### api-int Unreachable / Live Migration

- **Version:** Unknown
- **Symptoms:** api-int unreachable, packet drops.
- **Root Cause:** The issue occurred after a Live Migration event triggered by a hardware degraded event on the Azure platform. The VM was evacuated, and networking (api-int) failed to recover correctly after the migration.
- **Technical Details:** Azure continuously monitors for hardware degradation. When detected, Azure attempts to live migrate VMs to healthy hosts. Live migration is a VM-preserving operation that pauses the VM for typically less than 5 seconds, preserving memory, open files, and network connections. However, this brief freeze can be enough to cause transient networking issues in latency-sensitive applications like OpenShift control plane components, particularly if OVN-Kubernetes networking or API server connections time out. In cases where live migration isn't possible (e.g., M-Series, G-Series hardware), the VM experiences unexpected downtime and is redeployed.
- **Verification:** Check Azure Resource Health Logs for events like `LiveMigrationSucceeded` or `VirtualMachinePossiblyDegradedDueToHardwareFailure`.
- **Mitigation:** Use Azure Scheduled Events (IMDS API) to detect upcoming migrations, ensure 3 control plane nodes across availability zones, and proactively redeploy VMs when hardware degradation is detected.
- **References:**
  - [Azure: Find out when your VM hardware is degraded with Scheduled Events](https://azure.microsoft.com/en-us/blog/find-out-when-your-virtual-machine-hardware-is-degraded-with-scheduled-events/)
  - [Azure: Maintenance and updates for VMs](https://learn.microsoft.com/en-us/azure/virtual-machines/maintenance-and-updates)

### Resolv.conf Parsing Error

- **Version:** Unknown
- **Symptoms:** Error while parsing resolv.conf.
- **Root Cause:** Upstream DNS configuration issues. The customer had upstream DNS servers configured, and something in the response or configuration was causing resolv.conf parsing errors on the nodes.

### Accelerated Networking Issue

- **Version:** 4.13
- **Symptoms:** Accelerated networking issue.
- **Root Cause:** Required manual remediation via SSH to fix the accelerated networking configuration on the nodes. This is often related to the nmstate bug or similar issues where the interface doesn't come up correctly after a reboot or update.
- **Technical Details:** Accelerated networking is not configured by default on OpenShift 4 on Azure. Enabling it requires shutting down and deallocating the VM first, then updating the machine object spec. For OpenShift v4.10 and v4.11, configuring master nodes with accelerated networking is not supported because no machine sets are available for control plane nodes. The Kubernetes NMState Operator can manage network interface configuration declaratively, but deleting an NNCP does not remove the configuration from the primary interface — the operator re-adds the interface on pod/node restart.
- **References:**
  - [Red Hat Solution 6007341: Accelerated networking on OpenShift 4 / Azure](https://access.redhat.com/solutions/6007341)
  - [Red Hat Solution 7024803: Configuring Accelerated Networking for OpenShift on Azure](https://access.redhat.com/solutions/7024803)
  - [GitHub: Enable Accelerated networking on ARO (Issue #246)](https://github.com/Azure/OpenShift/issues/246)

### EgressIP / Bug ARO-22360

- **Version:** Unknown
- **Symptoms:** api-server pods logging timeouts during master->master communication.
- **Root Cause:** Related to Bug ARO-22360 involving EgressIP configuration. The issue was deemed not severe enough to threaten cluster health but caused noise in the logs.

### Network Issues (SDN to OVN)

- **Version:** Unknown
- **Symptoms:** Network issues after SDN to OVN migration + upgrade.
- **Root Cause:** Related to a bug (possibly ARO-22360 or similar) where the migration or configuration of egressIP caused connectivity issues.
- **Technical Details:** OpenShift 4.16 is the final version supporting OpenShiftSDN; clusters must migrate to OVN-Kubernetes before upgrading to 4.17. Key migration impacts:
  - **EgressNetworkPolicy stops working** after migration (Red Hat Solution 7005009).
  - **Egress IP and multicast are temporarily disabled** during live migration when both CNIs are running.
  - **IP addresses are not preserved:** Subnets assigned to nodes and IPs assigned to pods change during migration.
  - **MTU decreases by 50 bytes** post-migration (OVN overhead is 100 bytes vs SDN's 50 bytes).
  - **Reserved IP ranges** must not be in use: `100.64.0.0/16`, `169.254.169.0/29`, `100.88.0.0/16`, `fd98::/64`, `fd69::/125`, `fd97::/64`.
  - **Egress router pods** must be removed before migration (only redirect mode is supported on OVN-Kubernetes).
  - **NNCP on primary interface** must be deleted before migration.
- **References:**
  - [Red Hat Solution 7057169: Limited Live Migration from SDN to OVN-Kubernetes](https://access.redhat.com/solutions/7057169)
  - [Red Hat Solution 7005009: Migration breaks EgressNetworkPolicy](https://access.redhat.com/solutions/7005009)
  - [OKD: Migrating from OpenShift SDN](https://docs.okd.io/4.15/networking/ovn_kubernetes_network_provider/migrate-from-openshift-sdn.html)
