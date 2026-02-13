# SRE Investigation Techniques

A totally subjective guide for the lonely scientific problem investigator.

## Disclaimer

The following document gives routines and techniques that are applicable to OpenShift problem investigation, but not only: most of those are transposable to other technologies or platforms.

## Introduction

Investigating an incident ticket is like investigating a crime scene but the room is dark and you are looking through the keyhole. Some problems will be easy, others look easy but are not and sometimes it's the other way around. And in rare cases, the problem looks hard, is actually hard and will remain without a solution.

That being said, a few techniques can help gain some confidence even without knowing where to start. They also increase consistency and avoid falling for biases. With a bit of experience, one can develop intuition that can help steering in the right direction. However, one should learn not to blindly trust these instincts and to systematically doubt all and everything.

Those techniques, presented as a succession of phases, are not the one and only way to proceed. But they work. And they tend to work whatever the service or technology you are asked to support.

## Phases

1. [Reading](#1-reading)
2. [Context Gathering](#2-context-gathering)
3. [Facts Gathering](#3-facts-gathering)
4. [Theory Building](#4-theory-building)
5. [Actioning Recovery](#5-actioning-recovery)
6. [Communicating](#6-communicating)

---

## 1. Reading

**Key points:**

- Read all the ticket, note symptoms, timeline
- Note inconsistencies
- Push back if unclear or too inconsistent: we should not guess

**Explanations:**

It might sound obvious, but it is not always as easy as it sounds. We should read the problem description carefully and entirely (don't rely solely on the AI-generated summary) since useful information might hide in the last drop of the problem description, especially in case of customer tickets (as opposed to automated alerts).

This is all the more important since:

- Sometimes the ticket uses the wrong template and the title is not coherent with the description
- The ticket might be using a template where useful information is not filled at the right place, if filled at all, with confusing format

Thus, look for:

- Cluster identifying information (resource ID, region, etc.)
- Problem description
- Start time
- Reported actions done around the problem start time, if any

There should be special attention paid to inconsistencies in problem description, as they can be the sign of confusions by customers or support engineers. In which case, some double checking on the SRE's end might be required. Also, some assertions from customer or support teams should be taken with a grain of salt: sometimes, in good faith, customers state that no action was performed from their end before an issue started, and this might hold true. But later on, the investigator shall check such assertions: some customer organizations can be big or siloed and information does not flow everywhere, in which case they might not necessarily be aware about all actions performed on their end.

Depending on the severity of the issue, if the problem description is not clear at all or too confusing / inconsistent, or if crucial information is missing, SREs should push back to the ticket logger while asking for clarifications: we should not have to guess. If we do, the risk is high to miss the actual problem or lose precious time to recover an issue.

Last but not least: some problems are not SRE problems. While reading a problem description and throughout the later steps of problem investigation, one should ask, repeatedly: "Is what I see an SRE problem?". Some tickets, after analysis, happen to be out of SRE scope and/or more consulting tasks, in which case, SRE should push back, politely, explaining the reasons.

Note: the above is true for a new ticket, but also stands for a ticket reactivation or handover between shifts. In which case, the reading should be done on all the entries, which can be extremely cumbersome for long-standing tickets. This is why it is very important to summarize investigations, document any actions that were taken and write handover summaries, to ease the task of the next SRE in line, which can be your future self.

---

## 2. Context Gathering

After reading the problem description, the on-call SRE will need to capture the context around the cluster: basically, everything related to the cluster that's worth knowing. In the crime scene analogy, we are checking the surroundings of the crime scene, looking at the newspapers and asking the neighbourhood about the area.

**Key points:**

- Read all the automation inputs, including basic checks, history and auto diagnosis, if any
- Get an overview of the cluster with monitoring dashboards
- Check for recent upgrades, planned maintenance, alert silencing, or whatever other maintenance done by SREs

**Explanations:**

However tempting it might sound to jump on the cluster and start poking at it, it is crucial to gather context about a cluster when investigating an incident.

As a matter of fact, a lot of information is available "for free" in the incident ticket and centralized monitoring, without needing an SRE to actively access the cluster:

- **Incident ticket: basic checks output** -- Ticket automation (or a manual run of basic checks) collects a series of facts about the cluster, at infrastructure or OCP level when an incident is created
- **Incident ticket: cluster history** -- Collects all the incidents for the same cluster resource ID over the past 60 days, whether automated alerts or customer-reported issues
- **Incident ticket: automated diagnosis** -- For some alert types, ticket automation can provide very insightful automated diagnosis (MHC alerts for instance), which does 99% of the work
- **Monitoring dashboards:**
  - Cluster overview: number of nodes, current state of API server, list of Prometheus alerts over the last X hours
  - Upgrade version history: recent desired vs. current OCP version history, current planned maintenance state and operator version
  - Cluster operator statuses

Having this overall picture of the cluster and also a timeline of recent events provides an overall understanding of a cluster and a starting point for investigation.

Say, for instance, a customer complains about some node or pod malfunction: knowing an upgrade was done recently can provide a starting point for further log searches. In the same way, a customer questioning some node restart can be answered very quickly if an alert was handled recently and recovered by SREs. And so on.

---

## 3. Facts Gathering

Facts about the cluster related to the problem. Actual diagnosis activity. Taking again the crime scene analogy, we look for smoking guns, fingerprints and testimonies.

**Key points:**

- Dashboards regarding the problem, to spot the actual start time if possible
- Dashboards can very often give the same info as directly poking at clusters, but also give you a time representation of the issue
- Logs right now, logs at the problem start time:
  - Cluster logs
  - Audit logs
  - Platform service logs (resource provider, monitor, gateway)
- Prometheus or VM performance dashboards
- Only after the above: poke with `oc`/`kubectl` or remote actions

**Explanations:**

Don't jump right away to grab a kubeconfig.

Central logging and metric gathering ingests a lot of data that can be used to troubleshoot issues. That has many advantages:

- They are historized and are retained for up to 90 days
- Even if API server is down, data ingested earlier is still available (in worst cases, data from BEFORE the incident should be there, if for some reason the incident disrupts log sending)
- Contrary to `oc`/`kubectl` (which have more flexibility), central systems like dashboards offer a time series view, so evolution over time, which is superior for problem investigations: gives a sense of consistency of symptoms and start time in most cases
- They are easily shareable, reusable and can be used with plotting functionalities
- They will likely be still available no matter the access restrictions that could happen in the future, because they are not a direct access to production

What we want at this point is collecting facts about the problem we are asked to investigate to spot the start time and see the symptoms then and right now. So contrary to section 2 where the search in dashboards/logs was "broad" to gather context, a search in this section is targeted, both in scope and time range. When gathering information about API Server flakiness, an SRE would want to get logs from `openshift-kube-apiserver` first. For machine provisioning issues, logs from `openshift-machine-api`. And so on.

When not knowing where to start, a log search on all the master nodes and pattern matching can do the trick. Looking at namespaces and names of components (or error messages in the source code of the various cluster operators) can also help get a starting point. Overall, not knowing about a functionality does not mean one cannot perform any troubleshooting. In fact, as soon as we know roughly where to look, finding something that looks abnormal is generally not difficult, and "potential anomalies" are often easy to spot.

Cluster log searches shall be done near current time (to know current state while symptoms are still visible) and around the start time of the issue (known either from the customer inputs or from monitoring dashboards).

Audit log searches are another very powerful tool: performing audit log searches on create/update/delete actions targeting a time range right before symptoms appear can allow knowing what has changed and more importantly what system did initiate the change. Looking for `oc`/`kubectl` or web browser `userAgent` allows checking if a human action happened, and is often an irreplaceable source of evidence to find "the smoking gun". Be careful not to paste audit log output in tickets, since they are likely to contain PII.

Platform service logs (resource provider, gateway) are not to be forgotten in the fact collection. For installation, upgrade and planned maintenance related issues, they are a must have. Even logs from the monitor service can prove useful at times, for instance to help diagnosing API server or cluster access issues.

Additionally, there are a few other dashboards worth checking:

- VM performance dashboards
- In-cluster Prometheus dashboards

All in all, logs and dashboards from central systems are superior to direct poking at clusters, for all the reasons already expressed above. But it does not mean that querying information live from the cluster is bad, either via remote admin actions or `kubectl`/`oc`. Those are sometimes irreplaceable, in particular in situations where dashboards or logs don't tell everything or when we need reactivity in urgent situations (or simply when log forwarding is broken). But they should not be the easy go-to solution for all the cases.

A few more warnings about `oc`/`kubectl`:

- When checking performance issues: `oc adm top nodes` gives a snapshot of CPU and memory based on the kube metrics server. Prefer Prometheus dashboards or VM performance views, as time representation and time averages are more reliable
- Be careful what you are checking: SREs are NOT supposed to check customer workloads, objects or configuration items. `oc`/`kubectl` RBAC is less constrained than remote admin actions, so be cautious about what you actually describe with those

---

## 4. Theory Building

It's now time to sit in a good armchair and think about the whole crime. Well, no, we are not Hercule Poirot in some Agatha Christie novel. In this theory building exercise, not everything will come from your sole knowledge or experience: Red Hat provides a HUGE load of resources to make the link between the facts you are observing and the solution. That said, the fictitious Belgian detective teaches us one thing: if one fact, even a tiny detail, does not match, the whole theory collapses. So be thorough, be precise. And don't be afraid to ask.

**Key points:**

- Your knowledge of Azure, OCP and OpenShift
- Official documentation (Red Hat, Microsoft Learn, OKD)
- SOPs, TSGs, Red Hat solutions (KCS), OCPBUGs
- Source code
- Confront theory with facts. If ONE fact does not match, drop the theory (or amend while keeping the theory coherent and keeping Occam's Razor in mind). Don't try to force the other way around. Don't take shortcuts.

**Explanations:**

That part is probably the hardest to explain but also the most generic. The whole point is to turn a combination of facts into a series of evidence supporting a root cause and possibly an action plan. You may have good experience of Kubernetes, OCP and Azure. And this will help you for sure. But this will likely not be enough to explain all what you will have to diagnose.

The good news is that for a good part of problems, prior experience and available resources are legion to help you make that connection between facts and the diagnosis:

- **SOPs** (Standard Operating Procedures) and **TSGs** (Troubleshooting Guides)
- **Official documentation** (Red Hat docs, Microsoft Learn, OKD docs)
- **Red Hat Solutions** a.k.a. **KCS** (Knowledge-Centered Support)
- **OCPBUGs** in JIRA (or Bugzillas for some older issues)
- **Community channels** (Slack, mailing lists, etc.)

Searching for the observed errors and symptoms in the list of resources above, in that order, can very often provide you with prior experiences that will hopefully match your problem. And give you the last pieces of the puzzle or the theory that explains what you see, and the next steps.

If you don't find answers using the resources above, don't forget that we have the immense privilege to live in an open source world and you can always refer to the OCP or Kubernetes code on GitHub to try to understand what you see. The cluster operator reference page has links to all the CO GitHub projects, very handy to check quickly into OCP code. Looking for symptoms and error messages in the code can sometimes be the key to the solution. It's not about digging super deep into every project's code and becoming experts in all cluster operators, but checking their code can provide the last piece of the puzzle or additional context before engaging other teams or your colleagues.

And this leads to the obvious but important reality: you are not alone and you are not supposed to be an expert in everything. However one can value curiosity and willingness to learn in autonomy, we cannot realistically expect everyone to be experts in all aspects connected to OpenShift. So, indeed, you are expected to search on your own a bit, and to learn. But you are also expected to ask questions for guidance or additional opinion on a matter and not wait for hours before doing so if none of what you tried allows you to confidently state a root cause or action.

When you have your theory, at last, you need to come back to the facts you collected and confront it with each and every fact there. Two possibilities:

- Either your theory is compatible with the fact. By integrating it as a supporting factor or by not being incompatible (the fact is simply not relevant for your theory and can live along with it)
- Or your theory is not compatible with the fact. In which case you must discard the theory and go back to section 3. You might possibly amend and not drop the theory instead, but don't forget Occam's Razor.

### What if you cannot afford spending more time on finding the exact root cause?

In some situations, when pressure is high (sev 2 or higher), when there is an escalation or simply because you need to time-box some problem solving according to its severity and competing priorities, you might not afford spending more time on solving a problem and have only a partial theory.

Partial theories can sometimes be enough to decide an action plan and attempt some recoveries. In particular, some recovery actions are generally good go-to solutions to recover a problem even without a full understanding of the issue: a master node reboot, a planned maintenance run, or a platform CLI update. They can be situation savers sometimes. But also tempting and dangerous.

If you have time to study a problem, don't use that shortcut: it might recover an issue for the time being, but without a good understanding of an issue, the resolution might be only temporary and the issue will reappear later.

---

## 5. Actioning Recovery

Once we have a strong and reality-resistant theory for an issue, we need to decide about the next steps, in particular recovery. There are a few different situations, depending on the responsibility of the root cause, the scope and the risk involved in the said recovery.

**Key points:**

- Say what you do. Do what you say
- Least privilege
- Risk assessment, approval
- Shadowing

**Explanations:**

Once the root cause is known, there are a few questions to answer:

- What needs to be done?
- Who needs to do it?
- How to do it?

### What needs to be done?

Whenever the diagnosis is coming from a TSG, SOP, or KCS, the recovery steps are generally provided, so that's the first straightforward solution. In case the root cause / theory is more "ad-hoc", the situation is a bit more delicate, as we need to invent the recovery, which is not always just "reverting what was done". Also, sometimes, there are several ways to achieve the expected result.

Thus, when elaborating the recovery plan(s), one should ask oneself the following questions:

- Are the recovery actions operationally safe, non-destructive, or reversible? (Example: a node restart is safe in the general case; a pod deletion is most of the time safe since static pods restart and pods controlled by ReplicaSets are restarted too. Deleting keys in etcd is destructive and irreversible; deleting a ConfigMap can be destructive if not controlled by an operator.)
- Are we sure about the recovery actions' effect? Are we confident about the exact effects, direct or side effects?
- What level of privilege escalation do they involve?
- Does it make sense in a managed service context? A lot of KCS/documentation out there is for a self-managed situation, which does not necessarily apply in a managed cluster (presence of deny assignments, SSH access being emergency-only, etc.)

Eventually, the solution maximizing the likelihood of recovery over the risk is to be prioritized.

### Who needs to do it?

Here, the question is about who's responsible for the recovery plan execution: SRE on-call or the customer.

There are a few types of situations where it is relatively easy to answer:

- Clearly in SRE scope for an actual bug/known issue with the platform (e.g., create a MachineConfig for a dnsmasq bug), for which there is a clear SOP and no special side effect anticipated -> **SREs**
- Clearly in SRE scope and only SREs can do it (control plane resource pressure and a resize is needed, planned maintenance) -> **SREs**
- Clearly out of SRE scope and only customers should do it (credentials-related things or customer workloads) -> **Customers**
  - SREs should NEVER perform certificate rotation or credentials rotation manually for a customer.

And there is a range of problems where the line is much less clear:

- In theory in SRE scope but recovery might impact customers (reboots, potential impact on cluster application, etc.) -> can potentially be done by customers with proper instructions
- In theory in customer's scope but recovery cannot be performed by customer (and other options were ruled out) -> for instance, removing a customer workload that prevents customers from logging in (when other options don't work and escalation is done)

Overall, when the support policy was violated by customers, intentionally or not, SREs are still supposed to provide some level of support. Sometimes, the "right" solution should be to recreate the cluster, because the cluster is beyond repair, recovery likelihood over the cost ratio is too low, or because the recovery breaks too many rules. Whenever there is unclarity, doubt, or pressure, voice concern and seek support and approval from management or leads.

### How to do it?

A few things to highlight:

- Seek approval when you need to elevate above certain privileges
- And/or shadowing from people who can provide you psychological safety or technical confirmation
- Follow the least privilege principle: if you only need standard admin access to perform some updates to a cluster, don't seek full unrestricted access
- Full unrestricted access or SSH is an emergency measure; it shall be exceptional
- Explicitly ask for customer's consent if you think your action will have a noticeable impact or present some significant risk (destructive / invasive action) prior to doing it (e.g., manually modifying etcd presents very high risk)
- Say what you do and do what you say: any action needs to be logged for traceability and follow-up. Any "announced" action must have been done (or a comment must amend if not).

---

## 6. Communicating

When working on a ticket, SREs need to communicate frequently, to provide status to the ticket logger, to trace what they find and to hand over work to the next shifts. This step is even more important when mitigating or closing a ticket.

**Key points:**

- Say what you do. Do what you say
- Handover
- Be precise, be concise
- Keep in mind the opposition between internal and external messages

**Explanations:**

As already mentioned in the first section, proper information passing is key. The same way we need precise and complete information from our customers, we owe to ourselves and to our customers the same level of exigence.

The steps of a ticket investigation must be documented, ideally while being done (to limit the risk of forgetting anything), outlining:

- What was searched (with links to searches if possible)
- What was found (a link is better than a copy-paste) and what was NOT found
- What was actioned and which procedure was followed and why

Without falling into the trap of being too verbose (which would impair the readability of the ticket), SREs must be precise and not leave room for interpretation: we should work as if at any minute we would need to drop what we do and another colleague needs to take over. Nothing is more infuriating than finding out that an action was performed by earlier shifts without being documented, and hence discovering that what we just did was already attempted (and so is pointless). It is even more critical when SSH sessions are being done, as "reporting" is one of the only ways to know what was done, when and how.

Don't forget you are not alone: don't hesitate to call for help, for instance in case of screen sharing, where you can ask for assistance to track what you did. A scribe SRE will be a good way to validate and record what you do at the same time.

"Say what you do, do what you say" is probably the mantra that one should keep in mind while handling a ticket.

### Handing Over

When the end of shift is getting close and if resolution may not be done in time before that, proper handover should be done. However tempting it is to work till the very last minute, taking 10 minutes to prepare a summary entry makes transition with the next SRE easier. Answer four questions when doing it:

- What's the summary of the issue?
- What did you find?
- What's your working theory?
- What next steps would you take?

### Mitigating a Ticket

Before mitigating a ticket, address a discussion entry to the ticket logger to present the conclusions. Similarly to handover, this conclusion should be precise, factual and leave no ambiguity, in particular, if SRE expects a particular information to be relayed or a particular action to be taken.

SREs are not necessarily trained to communicate with customers. This is a delicate task and support teams are well versed into it. So it is not expected that SREs polish a message that is "customer ready". However, it is possible that a part of the conclusion/mitigation message is explicitly reserved for the support team (and explicitly not meant for customers), for instance, to help gain some context or anticipate future reactions. In that case, state it clearly.

The convention is to mitigate a ticket when it is no longer actionable by SREs pending some extra information or action, and so not necessarily when the issue is solved. This way, the on-call view is not polluted with non-actionable tickets and tickets are reactivated when new fresh information is available. A typical example is asking for clarification (as suggested in section 1) or asking for some extra action (e.g., to remove a blocking policy).

---

## Conclusion

Each ticket is a potential leap into the unknown. Some will find the experience exciting, others stressful or interesting or a mix of all that. This document is an attempt at sharing a canvas, a mental checklist that can help getting some consistency while handling issues and some confidence even when not knowing from where to start.

With some experience, one can grow a big knowledge base that can help a lot sailing the tumultuous seas of incident handling. However, not knowing is totally fine and happens all the time: we are addressing such a wide scope that it is practically impossible to know everything. So, one should never hesitate to doubt, search, ask and document.

Keep in mind:

- You are not alone
- Be aware of your biases
- Communicate, communicate and communicate

In a sense, we are lucky: the best way to learn how a system works is to witness it not working.
