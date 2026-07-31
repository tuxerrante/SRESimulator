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

All imported incident material must remove customer names, secrets, internal
URLs, and non-public incident identifiers before it is committed here.
