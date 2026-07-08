# Release Playbook: Beta → Prod

This document describes the complete path from a change to a Marketplace release — and how Beta
builds are deployed **without** VS Code automatically updating them.

## Overview

```
feature/*  ──PR──▶  beta  ──(Promote workflow)──▶  main ──Tag vX.Y.Z──▶  Marketplace
                     │                                      │
            Push triggers beta-release.yml          Tag triggers release.yml
            → GitHub *Pre-Release* + .vsix          → GitHub Release + vsce publish
            (Sideload, NO Marketplace,                (Auto-Update for users)
             NO Auto-Update)
```

| Branch | Purpose | `package.json` Version | Publication | Auto-Update |
|--------|---------|------------------------|-------------|-------------|
| `feature/*` | Development | – | – | – |
| `beta` | Pre-integration / Testing | Target-Stable `X.Y.Z` | GitHub **Pre-Release** (`.vsix`), Tag `beta-vX.Y.Z` | No — manually via "Install from VSIX…" |
| `main` | Production | `X.Y.Z` | Marketplace + GitHub Release, Tag `vX.Y.Z` | Yes |

> **Why no Marketplace Pre-Release channel?** The VS Code Marketplace does **not** support
> SemVer suffixes (`-beta.N`) and shares the same version space for Pre-Release and Stable.
> This forces either a confusing parity convention (even/odd MINOR) or version collisions.
> We avoid both: **Betas run exclusively as GitHub `.vsix` for sideloading.** `package.json` on
> `beta` already carries the **target stable version**; the beta nature is stored solely in the
> tag prefix `beta-v…`. When promoting, exactly this version becomes stable.

---

## 1. Creating a Beta Build

1. Develop changes on a `feature/*` branch, PR to `beta`.
2. Before merging, all gates must be green (CI enforces this).
3. Set the **target stable version** in `package.json` on `beta` (plain SemVer, no suffix):
   ```bash
   npm version 1.3.0 --no-git-tag-version   # = the version that will become stable later
   git commit -am "chore: beta for 1.3.0"
   git push origin beta
   ```
   > There is **no** parity or suffix rule. The beta nature is stored solely in the
   > tag prefix `beta-v…`, which the workflow sets automatically.

4. The workflow [`beta-release.yml`](../.github/workflows/beta-release.yml) runs automatically:
   Gates → Build → **GitHub Pre-Release** with `.vsix` under tag `beta-vX.Y.Z`.
   **No** Marketplace publish.

### Testing the Beta (by Users/Testers)
Download the `.vsix` from the Pre-Release on the GitHub Releases page, then in VS Code:
**Extensions ▸ "…" ▸ "Install from VSIX…"**. This sideloaded installation receives **no**
auto-update — to get a new beta build, install the latest `.vsix` again.

As long as the same target stable version requires multiple beta rounds, `package.json` stays
the same; each push to `beta` updates the `beta-vX.Y.Z` Pre-Release. Only the next feature
goal increments the version again.

---

## 2. Promoting Beta → Prod

### Option A — Automatic (recommended)
GitHub ▸ **Actions ▸ "Promote Beta → Prod" ▸ Run workflow** and enter the final version
(e.g. `1.3.0`).

The workflow [`promote.yml`](../.github/workflows/promote.yml):
1. merges `beta` into `main`,
2. sets the prod version in `package.json` (usually already the same),
3. pushes `main` and the tag `v1.3.0`.

The tag triggers [`release.yml`](../.github/workflows/release.yml) → Marketplace publish + GitHub Release.

> **One-time setup:** Tags pushed by the default `GITHUB_TOKEN` do **not** trigger further
> workflows. Create a repo secret `RELEASE_PAT` for this (Fine-grained PAT with
> `contents: write`). Without this secret you must trigger the tag push manually (see Option B
> from the "Tag" step onwards).

### Option B — Manual
```bash
git checkout main
git merge --no-ff beta
npm version 1.3.0 --no-git-tag-version --allow-same-version
git commit -am "chore(release): v1.3.0"
git push origin main
git tag v1.3.0
git push origin v1.3.0      # triggers release.yml
```

---

## 3. Required Secrets

| Secret | Purpose | Workflow |
|--------|---------|----------|
| `VSCE_PAT` | Marketplace publish (`vsce publish`) — Pre-Release + Stable | `beta-release.yml`, `release.yml` |
| `RELEASE_PAT` | Tag push that triggers `release.yml` (optional) | `promote.yml` |

`GITHUB_TOKEN` (automatic) is sufficient for GitHub Releases and asset uploads.

> **`RELEASE_PAT`:** Only needed if you want the Promote workflow to run fully automatically
> through to the Marketplace publish. Without it: `promote.yml` merges and tags, but
> `release.yml` must then be started manually via "Run workflow". `VSCE_PAT` is already
> present and covers both channels.

---

## 4. Versioning Rules

We use **strict SemVer without special rules**. There is no even/odd MINOR convention and no
Marketplace Pre-Release channel.

- **`package.json` version:** always the **target stable version** `X.Y.Z` (e.g. `1.3.0`).
  Both `beta` and `main` carry the same planned version — the difference lies only in the tag.
- **GitHub tags** separate Beta and Stable:
  - **Stable:** `vX.Y.Z` (e.g. `v1.3.0`) — pushes `release.yml` → Marketplace publish + Auto-Update.
  - **Beta:** `beta-vX.Y.Z` (e.g. `beta-v1.3.0`) — created by `beta-release.yml`, GitHub
    Pre-Release/`.vsix` only. Does not start with `v`, so it **never** matches the `v*` trigger
    of `release.yml` and cannot trigger a Stable publish.
- **MINOR/PATCH** as usual: Feature → bump MINOR, Bugfix → bump PATCH, Breaking → bump MAJOR.
- **Maintain `CHANGELOG.md`:** The Marketplace displays it in the "Changelog" tab. Collect changes
  under `## [Unreleased]`; when promoting, this becomes `## [X.Y.Z] – YYYY-MM-DD`.

---

## 5. Before Every Prod Release (Checklist)

- [ ] Beta has been tested (Sideload `.vsix`)
- [ ] `CHANGELOG.md` updated
- [ ] `/security-review` passes clean on the diff
- [ ] All CI gates on `beta` are green
- [ ] Final version determined (`X.Y.Z`)
