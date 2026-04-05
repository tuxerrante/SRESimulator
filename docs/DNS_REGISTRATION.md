# Public DNS name for the website

This document turns [issue #91](https://github.com/tuxerrante/SRESimulator/issues/91) into an actionable plan: **criteria**, a **shortlist**, a **recommended default**, a **decision log**, and a **registration checklist**.

## Goals

- **Memorable:** short, pronounceable in English, easy to spell after hearing it once.
- **Clear purpose:** signals “SRE” and “simulator” without being confused with unrelated products.
- **Operational:** works with HTTPS, email (if needed later), and predictable redirects (`www` → apex or the reverse).

## Naming criteria (use when comparing options)

| Criterion | Why it matters |
| --- | --- |
| Length & syllables | Shorter apex labels are easier to remember and type on mobile. |
| Hyphens vs words | `sre-simulator.com` is readable; very long hyphenated names feel clunky. |
| TLD | `.com` is the default mental model for a public product site; country or novelty TLDs are fine if branding justifies them. |
| Homophones / typos | Avoid names that sound like existing large brands or common typos of them. |
| Social handle alignment | If you care about `@` handles, check major platforms before committing. |
| Availability | **Must** verify domain availability and trademark risk in your jurisdiction before purchase. |

## Candidate shortlist

These are **starting points** from the issue discussion, plus close variants. **None are guaranteed available** — check a registrar before deciding.

| Candidate | Notes |
| --- | --- |
| `sre-simulator.com` | Strong match to the repo name; hyphen aids readability. Often a good primary to try first. |
| `sresimulator.com` | Compact; check pronunciation (“ess-are-e simulator” vs “srezimulator”). |
| `simulator.sre` | `.sre` is a real TLD but less familiar than `.com` for a general audience. |
| `sresimulat.or` | Creative split; **risk**: `.or` is uncommon for global sites and may confuse (looks like a typo of `.org`). Use only if intentional branding outweighs clarity. |
| `aro-sre-simulator.com` | More specific to ARO; longer but very descriptive. |
| `breakfix.game` / `break-fix.game` | Aligns with “Break-Fix Game” positioning; verify `.game` pricing and renewal. |

## Recommendation (default)

**Primary choice to try first:** `sre-simulator.com` — clear, memorable, and aligned with the project name **SRE Simulator**.

**If unavailable or blocked:** try `sresimulator.com`, then `aro-sre-simulator.com`, then evaluate a branded non-`.com` only if the team accepts the UX tradeoff.

Document the final pick in the decision log below.

## Decision log

| Date | Decision | Owner | Notes |
| --- | --- | --- | --- |
| _YYYY-MM-DD_ | _e.g. Register `example.com`_ | _name_ | _availability check link or registrar order id (non-secret)_ |

## Action checklist (after a name is chosen)

1. **Search** — Confirm domain availability at your registrar; run a quick trademark/web search for obvious conflicts.
2. **Register** — Buy the domain; enable auto-renew and registrar lock.
3. **DNS** — Point the apex (and `www` if used) at your hosting target (e.g. load balancer / ingress hostname from your cloud or OpenShift route).
4. **TLS** — Ensure certificates cover the chosen hostnames (Let’s Encrypt via ingress/controller, or managed certs).
5. **Redirects** — Choose one canonical URL (apex vs `www`) and HTTP → HTTPS redirect.
6. **Repo & docs** — Update any public links (README, deployment docs, Helm `values` examples) to the canonical URL.
7. **Close the loop** — Mark issue #91 done when the site is reachable on the chosen name (or split a follow-up for HTTPS/DNS if phased).

## Related project docs

- Deployment and routes: [ARCHITECTURE.md](ARCHITECTURE.md) (Helm under `helm/sre-simulator/`).
- Connectivity and probes: [ARO_AI_CONNECTIVITY_SPIKE.md](ARO_AI_CONNECTIVITY_SPIKE.md).
