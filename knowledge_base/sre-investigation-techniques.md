# SRE Investigation Techniques

A guide for the scientific problem investigator.

## The Five Phases

Every investigation follows these phases **in order**. Skipping ahead costs you points and risks misdiagnosis.

| # | Phase | Goal | You're done when… |
| --- | ------- | ------ | ------------------- |
| 1 | **Reading** | Understand the incident ticket | You can list symptoms, timeline, and any inconsistencies |
| 2 | **Context Gathering** | Get the big picture around the cluster | You've checked dashboards, history, and recent maintenance |
| 3 | **Facts Gathering** | Collect targeted evidence | You have logs, metrics, or audit trails that narrow the cause |
| 4 | **Theory Building** | Form a root-cause hypothesis | Your theory explains **all** observed facts without contradiction |
| 5 | **Actioning Recovery** | Fix it safely | You've assessed risk, chosen the least-privilege action, and documented it |

---

## 1. Reading

> **Checkpoint:** Can you list the symptoms, the timeline, and at least one inconsistency or missing detail?

**Do:**

- Read the **entire** ticket — don't rely on AI summaries alone
- Note cluster ID, region, reported start time, and customer actions
- Flag inconsistencies between title, description, and reported symptoms
- Push back if the ticket is unclear: *we should not guess*

**Watch out for:**

- Wrong template or misplaced fields
- Customer claims of "no changes" — verify later with audit logs
- Tickets that are not SRE problems at all (consulting, customer workload issues)

---

## 2. Context Gathering

> **Checkpoint:** Have you checked the cluster's overall health, recent events, and history **before** touching `oc`?

**Do:**

- Review **basic checks** output in the ticket (if available)
- Check cluster **incident history** (past 60 days)
- Look at monitoring dashboards: node count, API server status, active Prometheus alerts
- Check for recent **upgrades**, planned maintenance, or alert silences

**Why dashboards first?**

Dashboards give you a time-series view for free — no cluster access needed. A recent upgrade or maintenance event often explains the symptoms immediately.

---

## 3. Facts Gathering

> **Checkpoint:** Do you have targeted logs or metrics that show **when** symptoms started and **what** changed?

**Do:**

- Search **cluster logs** around the incident start time and current time
- Search **audit logs** for create/update/delete actions just before symptoms appeared
  - Filter by `userAgent` to distinguish human vs. automated changes
- Check **platform service logs** (resource provider, gateway, monitor) for installation/upgrade issues
- Use central dashboards and log searches **before** running `oc`/`kubectl`

**Why not jump to `oc` first?**

- Central logs are historized (up to 90 days) and available even if the API server is down
- Time-series views beat point-in-time snapshots for spotting patterns
- `oc adm top nodes` is a snapshot — prefer Prometheus or VM-level dashboards for performance trends

**When `oc` is appropriate:**

- Dashboards don't cover the data you need
- You need real-time reactivity in urgent situations
- Log forwarding is broken

---

## 4. Theory Building

> **Checkpoint:** Does your hypothesis explain **every** observed fact? If one fact contradicts it, the theory must be revised.

**Do:**

- Search for your symptoms in: SOPs → TSGs → Official docs → KCS articles → OCPBUGs → source code
- Build a theory that accounts for all collected facts
- Apply **Occam's Razor** — prefer the simplest explanation that fits
- If a single fact doesn't match, **drop or revise** the theory — never force facts to fit

**When time is short:**

Under pressure (Sev 2+), a partial theory may justify safe, well-known recovery actions (node reboot, planned maintenance). But don't take shortcuts when you have time — a shallow fix often means the issue returns.

---

## 5. Actioning Recovery

> **Checkpoint:** Have you verified your action is safe, reversible, and least-privilege? Have you documented what you're about to do?

**Do:**

- Confirm the action is **non-destructive** and **reversible** (e.g., pod deletion is safe; etcd key deletion is not)
- Follow **least privilege** — don't escalate access beyond what's needed
- Get approval for elevated privileges or risky operations
- Ask for customer consent if the action has noticeable impact
- **Say what you do, do what you say** — log every action for traceability

**Who acts?**

| Situation | Actor |
| ----------- | ------- |
| Platform bug with clear SOP | SRE |
| Only SREs have access (resize, maintenance) | SRE |
| Credential rotation, customer workloads | Customer |
| Grey area or high risk | Escalate to leads |

---

## Quick Reference: The SRE Mantra

1. **Read** the ticket — all of it
2. **Look** at dashboards before touching the cluster
3. **Search** logs and audit trails with targeted queries
4. **Think** — does your theory survive all the facts?
5. **Act** safely — least privilege, document everything

> *Say what you do. Do what you say.*

---

*[SRE Simulator](https://github.com/tuxerrante/SRESimulator) by [tuxerrante](https://github.com/tuxerrante)*
