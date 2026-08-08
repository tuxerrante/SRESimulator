# Release and Versioning

## Versioning model

- Semantic versioning is required: `vX.Y.Z`.
- Release notes are sourced from `CHANGELOG.md`.
- Home-page customer highlights come from `frontend/src/lib/release.ts`.

## Required release sequence

1. Open a pull request with release changes.
2. Merge the pull request to `main`.
3. Create the release tag from a commit already in `main`.

In short: do not tag feature branches; tags must originate from `main`
history.

## Release checklist

Before tagging:

- Ensure versions are aligned:
  - `frontend/package.json`
  - `backend/package.json`
  - `helm/sre-simulator/Chart.yaml`
  - `frontend/src/lib/release.ts` (`APP_VERSION`)
- Update `CHANGELOG.md` with a section for the target version.
- Run:
  - `make validate`
  - `make test`
  - `make test-integration`

Tag from `main`:

```bash
git checkout main
git pull
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

## Automated gates

- `CI` runs on semver tags and enforces full checks.
- CI rejects semver tags that do not point to commits in `main` history.
- Image publishing runs only after successful `CI` for semver tags.
- GitHub release notes are generated from `CHANGELOG.md`.
- Production deploy is gated to:
  - semver release tags,
  - latest release tag only,
  - successful `ci-gate` result for that tag.

### Overlapping release chains

`workflow_run` events from an older release can finish after a newer semver tag
is published. Automatic production deploys must therefore check the latest
semver tag twice: once while resolving the release and again immediately before
Azure login. A stale automatic run must exit successfully with deployment
steps skipped; it must not authenticate to Azure or fail the workflow. Manual
dispatches for a stale tag remain an error.
