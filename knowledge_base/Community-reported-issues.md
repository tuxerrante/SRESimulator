# Community-Reported OpenShift Issues: Reproducible Scenarios

**References:**

- [ARO Support Lifecycle & Release Calendar](https://learn.microsoft.com/en-us/azure/openshift/support-lifecycle)
- [ARO Support Policies](https://learn.microsoft.com/en-us/azure/openshift/support-policies-v4)
- [OpenShift Container Platform Documentation](https://docs.openshift.com/container-platform/4.18/welcome/index.html)
- [Red Hat Knowledge Base](https://access.redhat.com/knowledgebase)

Real-world OpenShift issues collected from r/openshift, Stack Overflow, GitHub issues, Red Hat Knowledge Base, and community blog posts. Each entry is documented with injection methods for reproducing in a local cluster.

## Networking

### Route Returns 503 After Applying NetworkPolicy

- **Difficulty:** Easy
- **Symptoms:** Application route returns `503 Service Unavailable`. The pod is running and healthy. `oc get route` shows the route exists. Curling the service ClusterIP from inside the cluster also fails.
- **Root Cause:** A `deny-by-default` NetworkPolicy was applied to the namespace, which blocks all ingress traffic including traffic from the OpenShift router (HAProxy). The router pods run in `openshift-ingress` namespace and need explicit allowance.
- **Fix:**
  1. Identify the blocking policy: `oc get networkpolicy -n <namespace>`
  2. Create an allow rule for the ingress controller:

     ```yaml
     apiVersion: networking.k8s.io/v1
     kind: NetworkPolicy
     metadata:
       name: allow-from-openshift-ingress
     spec:
       podSelector: {}
       ingress:
         - from:
             - namespaceSelector:
                 matchLabels:
                   network.openshift.io/policy-group: ingress
     ```

- **Injection Method:**
  1. Deploy a simple web app with a route
  2. Verify the route works
  3. Apply a deny-by-default NetworkPolicy:

     ```yaml
     kind: NetworkPolicy
     apiVersion: networking.k8s.io/v1
     metadata:
       name: deny-by-default
     spec:
       podSelector: {}
       ingress: []
     ```

  4. The route now returns 503

- **References:**
  - [Red Hat Blog: Network Policies Controlling Cross-Project Communication](https://www.redhat.com/en/blog/network-policies-controlling-cross-project-communication-on-openshift)
  - [OpenShift Examples: Network Policy](https://examples.openshift.pub/networking/network-policy/)

### Cross-Namespace Communication Blocked by NetworkPolicy

- **Difficulty:** Easy
- **Symptoms:** Service A in namespace-1 cannot reach Service B in namespace-2. `curl` between pods across namespaces times out. Same services work fine without NetworkPolicy.
- **Root Cause:** A default-deny NetworkPolicy in the destination namespace blocks all ingress traffic. Cross-namespace traffic requires explicit `namespaceSelector` allow rules.
- **Fix:** Create a NetworkPolicy in the destination namespace allowing traffic from the source namespace:

  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: allow-from-namespace-1
    namespace: namespace-2
  spec:
    podSelector: {}
    ingress:
      - from:
          - namespaceSelector:
              matchLabels:
                kubernetes.io/metadata.name: namespace-1
  ```

- **Injection Method:**
  1. Create two namespaces with communicating services
  2. Verify connectivity works
  3. Apply `deny-by-default` NetworkPolicy to the destination namespace
  4. Cross-namespace requests now timeout

### DNS Resolution Failure from Pods

- **Difficulty:** Medium
- **Symptoms:** Pods cannot resolve external DNS names. `nslookup` from inside pods returns `SERVFAIL` or times out. CoreDNS pods may be running but returning errors. Cluster-internal DNS (service names) may still work.
- **Root Cause:** CoreDNS forward plugin sends external queries upstream (node's `/etc/resolv.conf`). If upstream DNS is unreachable, misconfigured, or blocked by an EgressNetworkPolicy (especially a `deny 0.0.0.0/0` rule), all external DNS resolution fails. CoreDNS has a 6-second timeout; if a forwarded request is lost, it responds with SERVFAIL for that name/type for 40 seconds due to dnsmasq queueing.
- **Fix:**
  1. Verify upstream DNS connectivity from CoreDNS pods (both TCP and UDP)
  2. Check EgressNetworkPolicy isn't blocking DNS traffic
  3. Configure per-zone DNS forwarding in the DNS Operator
  4. Ensure firewall allows UDP/TCP port 53 outbound
- **Diagnostic Commands:**

  ```bash
  oc get pods -n openshift-dns
  oc get dns.operator/default -o yaml
  oc logs -n openshift-dns <coredns-pod>
  # Test from a pod:
  oc exec <pod> -- nslookup google.com
  ```

- **Injection Method:**
  1. Apply an EgressNetworkPolicy that blocks all outbound traffic:

     ```yaml
     apiVersion: network.openshift.io/v1
     kind: EgressNetworkPolicy
     metadata:
       name: block-all-egress
     spec:
       egress:
         - type: Deny
           to:
             cidrSelector: 0.0.0.0/0
     ```

  2. External DNS resolution from pods in that namespace fails immediately
  3. Note: This also blocks access to the OpenShift API servers

- **References:**
  - [Red Hat Solution 3804501: Troubleshooting OCP 4 DNS](https://access.redhat.com/solutions/3804501)
  - [Red Hat Solution 7015390: CoreDNS SERVFAIL Timeouts on ARO](https://access.redhat.com/solutions/7015390)

## Security & Access Control

### SCC Blocks Pod Creation ("unable to validate against any security context constraint")

- **Difficulty:** Easy
- **Symptoms:** Pod fails to create with: `forbidden: unable to validate against any security context constraint`. Deployment shows 0 available replicas. The container image works fine on Docker/Podman locally.
- **Root Cause:** OpenShift's `restricted` SCC is the default. It forces pods to run with a randomized UID (100000+), disables `hostNetwork`, `hostPath`, and `privileged` mode. Third-party images that require root (UID 0), specific UIDs, or host features are blocked. The pod's service account doesn't have access to any SCC that satisfies the pod's requirements.
- **Fix:**
  1. Identify what the pod needs: `oc get pod <pod> -o yaml | grep -A5 securityContext`
  2. Grant the appropriate SCC: `oc adm policy add-scc-to-user anyuid -z <sa-name> -n <namespace>`
  3. For custom needs, create a custom SCC rather than modifying defaults
  4. Verify: `oc get pod <pod> -o yaml | grep scc`
- **Injection Method:**
  1. Deploy an image that requires root (e.g., nginx official image without modifications):

     ```yaml
     apiVersion: apps/v1
     kind: Deployment
     metadata:
       name: nginx-broken
     spec:
       replicas: 1
       selector:
         matchLabels:
           app: nginx
       template:
         metadata:
           labels:
             app: nginx
         spec:
           containers:
             - name: nginx
               image: nginx:latest
               securityContext:
                 runAsUser: 0
     ```

  2. The pod will fail with SCC validation errors

- **References:**
  - [Red Hat Blog: Managing SCCs in OpenShift](https://www.redhat.com/en/blog/managing-sccs-in-openshift)
  - [Red Hat Blog: How to fix permission errors using service accounts](https://www.redhat.com/en/blog/security-context-constraint-permissions)
  - [Red Hat Solution 7058224: How to add proper SCC](https://access.redhat.com/solutions/7058224)

### RBAC Permission Denied ("User cannot create resource")

- **Difficulty:** Easy
- **Symptoms:** `forbidden: User "developer" cannot create resource "deployments" in API group "apps"`. `oc new-app` fails. Users can view but cannot edit resources.
- **Root Cause:** The user or service account lacks the necessary RBAC role binding. The default `view` role is read-only; `edit` allows creating/modifying most resources; `admin` allows full namespace management.
- **Fix:**
  1. Check current roles: `oc get rolebindings -n <namespace>`
  2. Add the appropriate role: `oc adm policy add-role-to-user edit <user> -n <namespace>`
  3. Verify: `oc auth can-i create deployments -n <namespace> --as=<user>`
- **Injection Method:**
  1. Create a user with only `view` role
  2. Attempt to create a deployment as that user -- fails with "forbidden"
  3. Or remove an existing `edit` binding: `oc adm policy remove-role-from-user edit <user> -n <namespace>`
- **References:**
  - [OpenShift Docs: Using RBAC](https://docs.openshift.com/container-platform/4.18/authentication/using-rbac.html)

## Resource Management

### OOMKilled Pod (Exit Code 137)

- **Difficulty:** Easy
- **Symptoms:** Pod shows `OOMKilled` status with exit code 137. Pod restarts repeatedly. `oc describe pod` shows `Last State: Terminated, Reason: OOMKilled`. Application may appear to work initially then crash under load.
- **Root Cause:** The container exceeded its memory limit. The Linux OOM killer terminates the process. Common causes: memory leaks, insufficient limits, JVM heap misconfiguration, or unbounded caching. On large nodes (100+ CPUs), some runtimes (Java, Go) allocate memory proportional to CPU count, causing unexpected OOM on nodes with many CPUs.
- **Fix:**
  1. Check current limits: `oc get pod <pod> -o yaml | grep -A5 resources`
  2. Increase memory limit based on actual usage
  3. For Java: set `-XX:MaxRAMPercentage=75` and `-XX:InitialRAMPercentage=50`
  4. Set `requests` near steady baseline; `limits` above expected peaks
  5. For critical workloads, set `request == limit` for Guaranteed QoS class
- **Injection Method:**
  1. Deploy a pod with a very low memory limit:

     ```yaml
     resources:
       limits:
         memory: "50Mi"
       requests:
         memory: "50Mi"
     ```

  2. Run a memory-consuming process inside the container:

     ```bash
     oc exec <pod> -- sh -c 'dd if=/dev/zero of=/dev/null bs=1M &'
     ```

  3. Or deploy a simple stress container: `image: polinux/stress` with args `["--vm", "1", "--vm-bytes", "100M"]`

- **References:**
  - [Red Hat Solution 3449651: OOMKilled in OpenShift](https://access.redhat.com/solutions/3449651)
  - [OpenShift Docs: Resource Configuration](https://docs.openshift.com/container-platform/4.18/nodes/clusters/nodes-cluster-resource-configure.html)

### CPU Throttling -- Application Slow Despite Low CPU Metrics

- **Difficulty:** Medium
- **Symptoms:** Application response times 10-100x slower than expected. `oc adm top pods` shows CPU well below the limit. Multi-threaded/Java applications particularly affected. `container_cpu_cfs_throttled_periods_total` metric is very high.
- **Root Cause:** The Linux CFS quota mechanism enforces CPU limits using 100ms windows. A multi-threaded application that bursts through its quota in milliseconds gets throttled for the remainder of the window. JVM GC, JIT, and auxiliary threads collectively exhaust the quota in microseconds.
- **Fix:**
  1. Remove CPU limits (keep only requests) for burstable behavior
  2. Set limits significantly higher than average usage for multi-threaded apps
  3. For Java: limit JVM thread count and thread pool sizes
  4. Monitor `container_cpu_cfs_throttled_seconds_total`
- **Injection Method:**
  1. Deploy a multi-threaded app with tight CPU limits (`limits.cpu: "200m"`)
  2. Send concurrent requests
  3. Observe throttling in Prometheus and response time degradation
- **References:**
  - [Red Hat Solution 5285071: CFS quotas lead to unnecessary throttling](https://access.redhat.com/solutions/5285071)

### Resource Quota Exceeded -- Pods Cannot Be Created

- **Difficulty:** Easy
- **Symptoms:** `oc create` fails with `forbidden: exceeded quota`. Deployments show 0 available replicas. HPA cannot scale up.
- **Root Cause:** A ResourceQuota limits CPU, memory, storage, or pod count in the namespace. When the sum of requests from all pods reaches the limit, no new pods can be created.
- **Fix:**
  1. Check quota: `oc describe quota -n <namespace>`
  2. Increase quota or clean up failed pods: `oc delete pods --field-selector=status.phase=Failed -n <namespace>`
  3. Adjust LimitRange defaults to right-size resource requests
- **Injection Method:**
  1. Apply a tight ResourceQuota:

     ```yaml
     apiVersion: v1
     kind: ResourceQuota
     metadata:
       name: tight-quota
     spec:
       hard:
         pods: "2"
         requests.cpu: "500m"
         requests.memory: "256Mi"
     ```

  2. Deploy 2 pods consuming the quota, then attempt a 3rd -- it fails

### Tainted Node Prevents Pod Scheduling

- **Difficulty:** Easy
- **Symptoms:** Pods stuck in `Pending`. Events show `0/N nodes are available: N node(s) had taint {key: NoSchedule}`. Nodes may show `SchedulingDisabled`.
- **Root Cause:** Nodes have `NoSchedule` taints (manual, via MachineSet, or automatic from conditions like MemoryPressure). Pods without matching tolerations cannot be scheduled.
- **Fix:**
  1. Check taints: `oc describe nodes | grep -A3 Taints`
  2. Remove taints: `oc adm taint nodes <node> <key>:<effect>-`
  3. Or uncordon: `oc adm uncordon <node>`
  4. Or add tolerations to pods if the taint is intentional
- **Injection Method:**
  1. Taint all worker nodes: `oc adm taint nodes <worker> maintenance=true:NoSchedule`
  2. Deploy a new application -- pods remain `Pending`
- **References:**
  - [OpenShift Docs: Taints and Tolerations](https://docs.openshift.com/container-platform/4.18/nodes/scheduling/nodes-scheduler-taints-tolerations.html)

## Node Health

### Node NotReady -- Kubelet or CRI-O Failure

- **Difficulty:** Medium
- **Symptoms:** `oc get nodes` shows one or more nodes as `NotReady`. Pods on the affected node are evicted. `oc debug node/<node>` may fail. CRI-O and kubelet services show as `dead` or `failed` via `systemctl status`.
- **Root Cause:** CRI-O storage corruption (missing symlinks in overlay layers), `nodeip-configuration.service` stuck blocking CRI-O from starting, or kubelet dependency chain broken. Storage corruption typically happens after an unclean shutdown. In RHOCP 4.14.23–4.14.32 and 4.15.9–4.15.21, a known dependency bug prevented CRI-O and kubelet from auto-starting after reboot. This is fixed in 4.16+.
- **Fix:**
  1. SSH to the node: `ssh core@<node>`
  2. Check what's blocking: `systemctl list-jobs`
  3. Check CRI-O: `systemctl status crio && journalctl -u crio -b`
  4. For storage corruption: cordon node, stop CRI-O, wipe `/var/lib/containers/storage/`, restart services
  5. Uncordon the node after recovery
- **Injection Method:**
  1. `oc debug node/<node>` then `chroot /host`
  2. Stop CRI-O: `systemctl stop crio`
  3. The node goes `NotReady` and pods are evicted
  4. For deeper simulation: corrupt files in `/var/lib/containers/storage/overlay/`
- **References:**
  - [OpenShift 4.16 Docs: Troubleshooting CRI-O](https://docs.openshift.com/container-platform/4.16/support/troubleshooting/troubleshooting-crio-issues.html)
  - [Red Hat Solution 6427321: CRI-O and kubelet stuck in dead status](https://access.redhat.com/solutions/6427321)
  - [Red Hat Solution 7070514: kubelet and crio do not start after reboot](https://access.redhat.com/solutions/7070514)

### Disk Pressure Eviction

- **Difficulty:** Medium
- **Symptoms:** Pods evicted from a node with event `The node was low on resource: ephemeral-storage`. Node condition shows `DiskPressure=True`. `oc describe node` shows disk utilization above thresholds.
- **Root Cause:** Kubelet monitors disk usage and evicts pods when usage exceeds configurable thresholds (default: eviction at 85% for `nodefs`, 80% for `imagefs`). Common causes: excessive container logs, large temporary files, accumulated unused images, or pods writing large amounts of data to `emptyDir` volumes.
- **Fix:**
  1. Identify large consumers: `du -sh /var/log/pods/*` on the node
  2. Prune unused images: `crictl rmi --prune`
  3. Clean up failed pods: `oc delete pods --field-selector=status.phase=Failed --all-namespaces`
  4. Increase disk size or configure image GC thresholds
  5. Set `ephemeral-storage` limits on pods
- **Injection Method:**
  1. `oc debug node/<node>` then `chroot /host`
  2. Fill disk: `dd if=/dev/zero of=/var/tmp/bigfile bs=1M count=50000`
  3. Kubelet detects disk pressure and starts evicting pods
  4. Node shows `DiskPressure=True`
- **References:**
  - [Red Hat Solution 3396081: Nodes experiencing disk pressure](https://access.redhat.com/solutions/3396081)

## Storage

### PVC Stuck in Pending

- **Difficulty:** Easy
- **Symptoms:** `oc get pvc` shows PVC in `Pending` indefinitely. Events show `storageclass.storage.k8s.io "xxx" not found` or `waiting for a volume to be created`. Pods depending on the PVC are also stuck in `Pending`.
- **Root Cause:** Multiple possible causes: StorageClass doesn't exist, no default StorageClass is set, CSI driver pods crashed, PVC uses a `selector` incompatible with dynamic provisioning, `WaitForFirstConsumer` binding mode with no pod scheduled, or storage quota exceeded.
- **Fix:**
  1. Verify StorageClass exists: `oc get sc`
  2. Set default: `oc patch sc <name> -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'`
  3. Check CSI driver pods: `oc get pods -n openshift-cluster-csi-drivers`
  4. Check quota: `oc describe resourcequota -n <namespace>`
- **Injection Method:**
  1. Create a PVC referencing a non-existent StorageClass:

     ```yaml
     apiVersion: v1
     kind: PersistentVolumeClaim
     metadata:
       name: broken-pvc
     spec:
       accessModes: ["ReadWriteOnce"]
       storageClassName: "non-existent-class"
       resources:
         requests:
           storage: 5Gi
     ```

  2. The PVC stays `Pending`; any pod referencing it also stays `Pending`

- **References:**
  - [Red Hat Solution 6987406: PVC Pending in OpenShift 4](https://access.redhat.com/solutions/6987406)
  - [Red Hat Solution 4098321: Why a PVC stays in Pending](https://access.redhat.com/solutions/4098321)

## Registry & Images

### ImagePullBackOff -- Invalid or Missing Pull Secret

- **Difficulty:** Easy
- **Symptoms:** Pod shows `ImagePullBackOff` or `ErrImagePull`. Events show `unauthorized: authentication required` or `manifest unknown`. The image exists in the registry and can be pulled locally with `docker pull`.
- **Root Cause:** The pod's service account doesn't have a valid pull secret for the target registry. In OpenShift, pull secrets must be linked to the service account or specified as `imagePullSecrets` in the pod spec. For the internal registry, the `builder` service account has push/pull access but `default` may not.
- **Fix:**
  1. Check the pull secret exists: `oc get secrets -n <namespace> | grep docker`
  2. Create it if missing: `oc create secret docker-registry <name> --docker-server=<registry> --docker-username=<user> --docker-password=<pass>`
  3. Link to service account: `oc secrets link default <name> --for=pull`
  4. Or add to pod spec under `imagePullSecrets`
- **Injection Method:**
  1. Deploy a pod referencing a private registry image without a pull secret:

     ```yaml
     containers:
       - name: app
         image: private-registry.example.com/myapp:latest
     ```

  2. Or delete the existing pull secret: `oc delete secret <pull-secret-name>`
  3. Pods immediately go into `ImagePullBackOff`

- **References:**
  - [Microsoft: Use ACR with ARO](https://learn.microsoft.com/en-us/azure/openshift/howto-use-acr-with-aro)

## Application Health

### CrashLoopBackOff Due to Misconfigured Liveness Probe

- **Difficulty:** Easy
- **Symptoms:** Pod shows `CrashLoopBackOff`. Events show `Liveness probe failed: HTTP probe failed with statuscode: 404`. Application logs show it started successfully before being killed. RESTARTS count keeps increasing.
- **Root Cause:** Liveness probe configured with wrong path (e.g., `/healthz` when app serves `/health`), wrong port, or insufficient `initialDelaySeconds` for slow-starting applications. Kubelet kills the container on probe failure; if it keeps failing, the pod enters CrashLoopBackOff with exponential backoff.
- **Fix:**
  1. Fix the probe path/port to match the application
  2. Increase `initialDelaySeconds` for slow starters
  3. Add a `startupProbe` to gate the liveness probe
  4. Test the endpoint: `oc exec <pod> -- curl localhost:<port>/<path>`
- **Injection Method:**
  1. Deploy an app with a deliberately broken liveness probe:

     ```yaml
     livenessProbe:
       httpGet:
         path: /nonexistent-path
         port: 8080
       initialDelaySeconds: 5
       periodSeconds: 10
     ```

  2. The pod starts, the probe fails with 404, kubelet kills it, and it enters CrashLoopBackOff

- **References:**
  - [OpenShift 4.8 Docs: Application Health](https://docs.openshift.com/container-platform/4.18/applications/application-health.html)

## Control Plane

### etcd Performance Degradation -- Slow fdatasync Causing API Latency

- **Difficulty:** Hard
- **Symptoms:** API responses take multiple seconds. etcd logs show `slow fdatasync` warnings. Prometheus metric `etcd_disk_wal_fsync_duration_seconds` p99 > 20ms. Frequent leader elections (`etcd_server_leader_changes_seen_total` increasing). `oc get` commands take 5-30 seconds.
- **Root Cause:** etcd performance depends on disk I/O. Network-attached storage (NFS, Ceph RBD, shared cloud disks) with high write latency causes `fdatasync` delays. This triggers heartbeat misses, proposal commit delays, and leader re-elections, cascading into cluster-wide API slowness.
- **Fix:**
  1. Move etcd to dedicated, fast local SSD/NVMe storage
  2. Run `fio` benchmark: sequential write latency must be below 20ms for 8KB blocks
  3. Defragment etcd: `oc rsh -n openshift-etcd <etcd-pod> etcdctl defrag`
  4. Avoid I/O-intensive workloads on control plane nodes
- **Injection Method:**
  1. Run disk I/O stress on a control plane node:

     ```bash
     oc debug node/<master-node>
     chroot /host
     while true; do dd if=/dev/zero of=/var/tmp/io-stress bs=4k count=10000 conv=fdatasync; done
     ```

  2. etcd fdatasync latency spikes in Prometheus
  3. API operations become noticeably slower

- **References:**
  - [Red Hat Article: ETCD performance troubleshooting](https://access.redhat.com/articles/6271341)
  - [OKD Docs: Recommended etcd practices](https://docs.okd.io/4.18/scalability_and_performance/recommended-performance-scale-practices/recommended-etcd-practices.html)
  - [OpenShift Runbooks: etcdHighFsyncDurations](https://github.com/openshift/runbooks/blob/master/alerts/cluster-etcd-operator/etcdHighFsyncDurations.md)

### etcd Insufficient Members

- **Difficulty:** Hard
- **Symptoms:** Alert `etcdInsufficientMembers` fires. API becomes read-only. Cluster operations fail. `oc get` may work but writes are rejected.
- **Root Cause:** Fewer etcd members available than needed for quorum (2 of 3 in a standard cluster). Occurs when multiple control plane nodes are powered off or cannot connect via the network.
- **Fix:**
  1. If one member is down: identify and restart it, or replace the unhealthy member
  2. If quorum is lost: use `quorum-restore.sh` (no backup required) or restore from etcd backup
  3. After recovery, return to a three-node configuration
- **Injection Method:**
  1. Shut down 2 of 3 master node VMs (in a lab environment only)
  2. The remaining etcd member cannot form quorum
  3. API becomes read-only
- **References:**
  - [OpenShift Runbooks: etcdInsufficientMembers](https://github.com/openshift/runbooks/blob/master/alerts/cluster-etcd-operator/etcdInsufficientMembers.md)
  - [OKD Docs: Quorum Restoration](https://docs.okd.io/latest/backup_and_restore/control_plane_backup_and_restore/disaster_recovery/quorum-restoration.html)

### kube-apiserver Restarts Due to Webhook Misconfiguration

- **Difficulty:** Medium
- **Symptoms:** Platform operators restart frequently. Web console disconnects randomly. `oc get co` shows operators cycling between Available and Degraded. kube-apiserver pods show high restart counts.
- **Root Cause:** A misconfigured admission webhook (e.g., sysdig, Gatekeeper, custom webhooks) with `failurePolicy: Fail` floods the kube-apiserver with errors. Every API request passes through admission webhooks; if the webhook endpoint is unreachable or times out, the API server becomes unstable.
- **Fix:**
  1. Identify the webhook: `oc get validatingwebhookconfigurations` and `oc get mutatingwebhookconfigurations`
  2. Check webhook endpoints: `oc get endpoints -n <webhook-namespace>`
  3. Change `failurePolicy` to `Ignore` temporarily
  4. Fix or remove the broken webhook
- **Injection Method:**
  1. Create a ValidatingWebhookConfiguration that points to a non-existent service:

     ```yaml
     apiVersion: admissionregistration.k8s.io/v1
     kind: ValidatingWebhookConfiguration
     metadata:
       name: broken-webhook
     webhooks:
       - name: broken.example.com
         clientConfig:
           service:
             name: nonexistent-service
             namespace: default
             path: /validate
         rules:
           - operations: ["CREATE"]
             apiGroups: [""]
             apiVersions: ["v1"]
             resources: ["pods"]
         failurePolicy: Fail
         sideEffects: None
         admissionReviewVersions: ["v1"]
     ```

  2. All pod creation requests will fail or timeout through the webhook

- **References:**
  - [Red Hat Solution 6188881: Operators restarting due to misconfigured webhooks](https://access.redhat.com/solutions/6188881)

## Authentication

### Authentication Operator Degraded -- OAuth Route Unreachable

- **Difficulty:** Medium
- **Symptoms:** `oc login` fails. `oc get co authentication` shows `DEGRADED=True`. Error: `RouteHealthDegraded: failed to GET route: connection refused`. Console login inaccessible. API works with kubeconfig but OAuth login fails.
- **Root Cause:** The OAuth server pods or route are unreachable. Common causes: ingress controller (router) not functioning, DNS cannot resolve `oauth-openshift.apps.<cluster>`, custom OAuth config with untrusted certificates, or OAuth pods crashed after a bad configuration change.
- **Fix:**
  1. Check OAuth pods: `oc get pods -n openshift-authentication`
  2. Check operator logs: `oc logs -n openshift-authentication-operator deployment/authentication-operator`
  3. Verify route: `oc get route -n openshift-authentication`
  4. Test endpoint: `curl -k https://oauth-openshift.apps.<cluster>/healthz`
  5. If bad config: `oc edit oauth cluster` to revert
- **Injection Method:**
  1. Delete the OAuth route: `oc delete route oauth-openshift -n openshift-authentication`
  2. The authentication operator reports degraded
  3. `oc login` fails (kubeconfig admin access still works)
- **References:**
  - [Red Hat Solution 4985361: Auth operator degraded (RouteHealthDegraded)](https://access.redhat.com/solutions/4985361)
  - [Red Hat Solution 7031398: Unable to access API after OAuth config update](https://access.redhat.com/solutions/7031398)

### Expired Certificates -- Cluster Unreachable After Prolonged Shutdown

- **Difficulty:** Hard
- **Symptoms:** `oc login` fails with `x509: certificate has expired or is not yet valid`. All nodes `NotReady`. etcd pods in `CrashLoopBackOff`. Cannot use `oc` or `kubectl` at all.
- **Root Cause:** OpenShift internal certificates (kubelet, etcd, API server) expire if the cluster is shut down before automatic rotation occurs. Rotation only happens while the cluster is running. On restart, components refuse to communicate due to expired TLS certificates.
- **Fix:**
  1. Use the original installation `kubeconfig` (contains long-lived admin credentials)
  2. Approve pending CSRs: `oc get csr -o name | xargs oc adm certificate approve` (run multiple times)
  3. For expired etcd certificates: follow disaster recovery procedure
  4. Certificates may need manual renewal before etcd pods will start
- **Injection Method:** This is difficult to reproduce quickly. Options:
  1. Manually advance system clock on all nodes past certificate expiration
  2. Delete certificate secrets in `openshift-kube-apiserver-operator` namespace
- **References:**
  - [Red Hat Article: Regenerating Cluster Certificates](https://access.redhat.com/articles/regenerating_cluster_certificates)
  - [Red Hat Solution 7000968: Checking etcd certificate expiry](https://access.redhat.com/solutions/7000968)

## Machine Config & Upgrades

### MCO Degraded -- Configuration Drift ("Unexpected on-disk state")

- **Difficulty:** Medium
- **Symptoms:** `oc get mcp` shows pool as `DEGRADED=True`. Node annotation shows `machineconfiguration.openshift.io/state: Degraded`. MCD logs: `Marking Degraded due to: unexpected on-disk state validating against rendered-worker-...`. Upgrades blocked.
- **Root Cause:** Files managed by the MCO were manually modified on a node. The MCD detects the mismatch between actual on-disk state and the rendered MachineConfig and refuses to proceed. Types of drift: file content changes, file permission changes, or OS image URL mismatch.
- **Fix:**
  1. Identify the mismatched file from MCD logs
  2. Fix via `oc debug node/<node>` and write correct content back
  3. Or force re-validation: `oc debug node/<node> -- touch /host/run/machine-config-daemon-force`
- **Injection Method:**
  1. Modify a file managed by the MCO on a worker node:

     ```bash
     oc debug node/<worker>
     chroot /host
     chmod 644 /etc/ssh/sshd_config  # Change from expected 0600
     ```

  2. Wait for the MCD to detect the drift (checks periodically)
  3. The MachineConfigPool reports Degraded

- **References:**
  - [Red Hat Solution 5315421: On-disk validation fails](https://access.redhat.com/solutions/5315421)
  - [Red Hat Solution 5598401: MCP Degraded with "Unexpected on-disk state"](https://access.redhat.com/solutions/5598401)

### Cluster Upgrade Stuck -- ClusterVersion Not Progressing

- **Difficulty:** Hard
- **Symptoms:** `oc get clusterversion` shows upgrade at XX% for hours. Individual cluster operators stuck updating. Error: `One or more machine config pool is degraded`. No visible progress.
- **Root Cause:** Multiple possible causes: MachineConfigPool is paused, PDBs preventing node drain, stale CRDs blocking operators, OLM-managed operators not updated to compatible versions, or insufficient nodes.
- **Fix:**
  1. Identify the blocking operator: `oc get co` (look for not available/degraded)
  2. Check MCP: `oc get mcp` and unpause if paused
  3. Check PDBs: `oc get pdb --all-namespaces`
  4. Take an etcd backup before corrective action
- **Injection Method:**
  1. Pause the worker MachineConfigPool:

     ```bash
     oc patch mcp worker --type merge -p '{"spec":{"paused":true}}'
     ```

  2. Initiate a cluster upgrade: `oc adm upgrade --to=<version>`
  3. The upgrade stalls because the paused MCP prevents MCO from rolling out changes

- **References:**
  - [Red Hat Blog: Guide to Troubleshooting OpenShift Updates](https://www.redhat.com/en/blog/a-guide-to-troubleshooting-openshift-updates-1)
  - [Red Hat Solution 6410281: Upgrade not progressing](https://access.redhat.com/solutions/6410281)

## Summary Table

| #   | Issue                               | Difficulty | Category         | Reproducibility |
| --- | ----------------------------------- | ---------- | ---------------- | --------------- |
| 1   | Route 503 from NetworkPolicy        | Easy       | Networking       | Very Easy       |
| 2   | Cross-Namespace NetworkPolicy Block | Easy       | Networking       | Very Easy       |
| 3   | DNS Resolution Failure              | Medium     | Networking/DNS   | Easy            |
| 4   | SCC Blocks Pod Creation             | Easy       | Security         | Very Easy       |
| 5   | RBAC Permission Denied              | Easy       | Security/RBAC    | Very Easy       |
| 6   | OOMKilled Pod                       | Easy       | Resources        | Very Easy       |
| 7   | CPU Throttling (CFS Quota)          | Medium     | Resources        | Medium          |
| 8   | Resource Quota Exceeded             | Easy       | Resources        | Very Easy       |
| 9   | Tainted Node Scheduling             | Easy       | Scheduling       | Very Easy       |
| 10  | Node NotReady (CRI-O/Kubelet)       | Medium     | Node Health      | Easy            |
| 11  | Disk Pressure Eviction              | Medium     | Node Health      | Easy            |
| 12  | PVC Stuck Pending                   | Easy       | Storage          | Very Easy       |
| 13  | ImagePullBackOff                    | Easy       | Registry/Auth    | Very Easy       |
| 14  | CrashLoopBackOff (Probe)            | Easy       | Application      | Very Easy       |
| 15  | etcd Slow fdatasync                 | Hard       | Control Plane    | Medium          |
| 16  | etcd Insufficient Members           | Hard       | Control Plane    | Medium          |
| 17  | Webhook Misconfiguration            | Medium     | Control Plane    | Easy            |
| 18  | Auth Operator Degraded              | Medium     | Authentication   | Easy            |
| 19  | Expired Certificates                | Hard       | Certificates/TLS | Hard            |
| 20  | MCO Config Drift                    | Medium     | Machine Config   | Easy            |
| 21  | Upgrade Stuck                       | Hard       | Lifecycle        | Medium          |
