# Content Boundary

Runtime content in this repository may only depend on repo-owned, sanitized
assets:

- `scenarios/**/*.json`
- `knowledge_base/**/*.md`
- static manifests committed in this repository

Runtime content may not depend on:

- `aro-ai-tools`
- git submodules
- MCP lookups
- remote authoring identifiers
- build-time sync scripts that are required for the simulator to start

`PlatformId` and all gameplay prompt/knowledge behavior must resolve from
content owned directly in this repository. Optional external authoring flows may
export plain JSON or Markdown assets, but the simulator runtime must not require
those authoring systems to be present.

Only `sre-investigation-techniques.md` is shared across all platforms.
`Openshift-clusters-alerts-resolutions.md` and
`Community-reported-issues.md` are ARO Classic-only inputs. AKS and ARO HCP
sessions may load only their matching `knowledge_base/platforms/<platform>/`
bundle.

Documentation references must come from the platform allowlist in
`shared/types/platform.ts`. Assistant links outside the active platform's
allowlist are rendered as non-clickable text.

All imported incident material must remove customer names, secrets, internal
URLs, and non-public incident identifiers before it is committed here.
