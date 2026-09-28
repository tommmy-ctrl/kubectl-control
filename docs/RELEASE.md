# Release Playbook: Beta → Prod

This document describes the complete path from a change to a Marketplace release — and how Beta
builds are deployed **without** VS Code automatically updating them.

## Overview

```
feature/*  ──PR──▶  beta  ──(Promote workflow)──▶  main ──Tag vX.Y.0──▶  Marketplace (stable)
                     │                                      │
                     │                          Tag vX.Y.Z-pre (Z≥1) ──▶  Marketplace (pre-release)
                     │
            Push triggers beta-release.yml
            → GitHub *Pre-Release* + .vsix
            (Sideload, NO Marketplace,
             NO Auto-Update)
```

| Branch / Tag | Purpose | `package.json` Version | Publication | Auto-Update |
|--------|---------|------------------------|-------------|-------------|
| `feature/*` | Development | – | – | – |
| `beta` (push) | Pre-integration / Testing | `X.Y.Z`, **Z ≥ 1** (a *dev round*, see below) | GitHub **Pre-Release** (`.vsix`), Tag `beta-vX.Y.Z` | No — manually via "Install from VSIX…" |
| Tag `vX.Y.Z-pre` (Z≥1) | Marketplace pre-release | Same `X.Y.Z` as the beta round it's cut from | Marketplace (`--pre-release` flag) + GitHub Release | Yes — but only for users who opted into the Extensions view's "Switch to Pre-Release Version" |
| Tag `vX.Y.0` (`main`) | Production | `X.Y.0` — **patch is always `0`** | Marketplace + GitHub Release | Yes |

> **The versioning rule, in one sentence: stable releases are always `X.Y.0`; every beta and
> pre-release round is `X.Y.Z` with `Z ≥ 1`, living under the *next* planned minor.** This isn't
> the old "even/odd MINOR" convention (there's no parity rule, and it applies to PATCH, not
> MINOR) — it exists specifically so a version number can never need to serve double duty.
> Patch-nonzero numbers are reserved for dev rounds and are **never** valid as a stable release;
> `X.Y.0` numbers are reserved for stable and are **never** used for a beta/pre-release round.
> Because of that split, a stable release is *structurally* always higher than every dev round
> that led up to it — the version-burning trade-off that the old `1.3.0`–`1.3.2` incident (see
> the `1.2.1`/`1.3.3` CHANGELOG entries) caused can no longer happen, on either channel, without
> having to reason about it case by case.
>
> **Two separate pre-release mechanisms, on purpose.** `beta-vX.Y.Z` (GitHub-only `.vsix`
> sideload) stays the default for day-to-day testing — no Marketplace footprint at all.
> `vX.Y.Z-pre` is a **deliberate, occasional** escalation for when a round needs a wider
> pre-release audience than manual sideload testers, via VS Code's own built-in pre-release
> channel. Both use the *same* `X.Y.Z` numbering (Z ≥ 1) — a pre-release tag just adds `-pre`
> to whatever the current dev round's version already is.
>
> **Identifying a specific beta build:** multiple pushes can happen within the same dev round
> before it's promoted (e.g. fixing something a tester just reported), and each push to `beta`
> updates the **same** `beta-vX.Y.Z` tag/release in place rather than creating a new one — so the
> exact build can't always be told apart from the tag alone. `beta-release.yml` bakes the short
> commit SHA into the build (`BUILD_SHA` env var → `webpack.DefinePlugin` →
> `process.env.BUILD_SHA`), and [src/webviews/templates.ts](../src/webviews/templates.ts) shows
> it next to the version number in the connection form's footer (e.g.
> `kubectl-control v1.4.2 (a1b2c3d)`). Compare that SHA against `git log` to find the exact
> commit a running build came from. Default to bumping `Z` for anything a tester will knowingly
> download as a new round; it's fine to leave `Z` unchanged for a quick same-round fixup nobody
> has tested yet.

---

## 1. Creating a Beta Build

1. Develop changes on a `feature/*` branch, PR to `beta`.
2. Before merging, all gates must be green (CI enforces this).
3. Bump the **dev-round patch version** in `package.json` on `beta` (`Z ≥ 1`, never `.0`):
   ```bash
   npm version 1.4.2 --no-git-tag-version   # next dev round — NOT the eventual stable number
   git commit -am "chore: beta round 1.4.2"
   git push origin beta
   ```
   > `Z` is just "the next dev-round number," not a promise about what ships stable. When this
   > round is ready, it promotes to the next unused `X.Y.0` (see section 2) — never to `1.4.0`
   > or any other `1.4.x`.

4. The workflow [`beta-release.yml`](../.github/workflows/beta-release.yml) runs automatically:
   Gates → Build → **GitHub Pre-Release** with `.vsix` under tag `beta-vX.Y.Z`. **No**
   Marketplace publish.

### Testing the Beta (by Users/Testers)
> **Beta builds are never listed in the VS Code Marketplace / Extensions search — this is by
> design (see the note in the Overview above), not a bug.** Searching for "kubectl-control" in
> VS Code's Extensions view only ever finds the last **stable** release, never a beta.

1. Open the repo's **GitHub Releases** page and find the pre-release tagged `beta-vX.Y.Z`
   (marked "Pre-release").
2. Download the `.vsix` file attached to that release.
3. In VS Code: **Extensions view ▸ "…" menu (top-right) ▸ "Install from VSIX…"** ▸ select the
   downloaded file.

This sideloaded installation receives **no** auto-update — to get a new beta build, repeat the
steps above with the latest `.vsix`.

A push that doesn't bump `package.json` **updates the same** `beta-vX.Y.Z` Pre-Release (tag and
`.vsix` are replaced in place) rather than creating a new one; a push that bumps `Z` creates the
next round's release alongside it. To check which commit is actually behind a given `.vsix`, look
at the version footer inside the extension itself (see the note above) or run:
```bash
git fetch --tags
git rev-parse beta-v1.4.2
```

**Cleaning up a superseded round:** once a later round or the eventual stable ships, delete the
old round's tag (`git push origin --delete beta-vX.Y.Z`) so it doesn't linger in the release list
looking newer than it is (dev-round numbers don't sort chronologically against each other in an
obviously-superseded way the way `X.Y.0` stable numbers do).

---

## 1b. Publishing a Marketplace Pre-Release (occasional, deliberate)

Use this only when a round needs testing by people who won't manually sideload a `.vsix` —
otherwise stick to the `beta-vX.Y.Z` flow above. Uses the **same** `X.Y.Z` as the current dev
round; just add the `-pre` tag on top of an already-pushed beta commit.

```bash
git checkout beta                    # the commit already built as beta-v1.4.2
git tag v1.4.2-pre
git push origin v1.4.2-pre           # triggers release.yml in pre-release mode
```

[`release.yml`](../.github/workflows/release.yml) detects the `-pre` suffix, strips it for the
`package.json`/`vsce package` version (VS Code requires a bare `X.Y.Z`), and passes
`--pre-release` to both `vsce package` and `vsce publish`. The GitHub Release is created with
`prerelease: true`. It does **not** touch `main` — a `-pre` tag can be pushed straight from a
`beta` commit without promoting anything.

Testers opt in via **Extensions view ▸ kubectl-control ▸ "Switch to Pre-Release Version"** — this
*does* show up in Marketplace search (unlike the GitHub-only beta channel) and *does* auto-update
for anyone who has opted in, straight to whatever the next `-pre` or stable publish is. Because
`Z ≥ 1` is never a valid stable number (section 4), publishing this costs nothing — the eventual
stable promotion was never going to reuse `1.4.2` anyway.

---

## 2. Promoting Beta → Prod

Promoting **always** bumps to the next unused `X.Y.0` — never to the dev round's own `X.Y.Z`.

### Option A — Automatic (recommended)
GitHub ▸ **Actions ▸ "Promote Beta → Prod" ▸ Run workflow** and enter the final version, e.g.
`1.5.0` (the next unused minor, not `1.4.2`).

The workflow [`promote.yml`](../.github/workflows/promote.yml):
1. merges `beta` into `main`,
2. sets the prod version in `package.json` to the entered `X.Y.0`,
3. pushes `main` and the tag `v1.5.0`.

The tag triggers [`release.yml`](../.github/workflows/release.yml) → Marketplace publish + GitHub Release.

> **One-time setup:** Tags pushed by the default `GITHUB_TOKEN` do **not** trigger further
> workflows. Create a repo secret `RELEASE_PAT` for this (Fine-grained PAT with
> `contents: write`). Without this secret you must trigger the tag push manually (see Option B
> from the "Tag" step onwards).

### Option B — Manual
```bash
git checkout main
git merge --no-ff beta
npm version 1.5.0 --no-git-tag-version --allow-same-version   # next unused X.Y.0
git commit -am "chore(release): v1.5.0"
git push origin main
git tag v1.5.0
git push origin v1.5.0      # triggers release.yml
```

---

## 3. Required Secrets and Variables

| Name | Kind | Purpose | Workflow |
|------|------|---------|----------|
| `AZURE_CLIENT_ID` | Environment variable (`marketplace`) | Entra app used to publish (not a secret) | `release.yml`, `marketplace-identity.yml` |
| `AZURE_TENANT_ID` | Environment variable (`marketplace`) | Entra tenant (not a secret) | `release.yml`, `marketplace-identity.yml` |
| `RELEASE_PAT` | Secret | Tag push that triggers `release.yml` (optional) | `promote.yml` |

**Marketplace publishing uses no stored secret.** `release.yml` logs in to Microsoft Entra ID with
GitHub's short-lived OIDC token (workload identity federation) and publishes with
`vsce publish --azure-credential` — for stable (`vX.Y.0`) and pre-release (`vX.Y.Z-pre`) tags
alike. Nothing can expire or leak the way the former `VSCE_PAT` did (Azure DevOps retires global
PATs on 2026-12-01). One-time setup: section 3a.

`GITHUB_TOKEN` (automatic) is sufficient for GitHub Releases and asset uploads. `beta-release.yml`
only runs `vsce package` (a local build, no Marketplace interaction) and needs no credentials.

> **`RELEASE_PAT`:** Only needed if you want the Promote workflow to run fully automatically
> through to the Marketplace publish. Without it: `promote.yml` merges and tags, but the tag
> push made with `GITHUB_TOKEN` does not trigger `release.yml`.

### 3a. One-time setup: Marketplace publishing via Entra ID (OIDC)

1. **GitHub environment.** Repo ▸ Settings ▸ Environments ▸ **New environment** `marketplace`.
   Under *Deployment branches and tags* choose **Selected branches and tags** and add the tag
   rule `v*` plus the branch `beta` (only for running the one-time identity workflow in step 5).
2. **Entra app registration.** [portal.azure.com](https://portal.azure.com) ▸ Microsoft Entra ID ▸
   App registrations ▸ **New registration** (name e.g. `kubectl-control-marketplace`, single
   tenant, no redirect URI). No Azure subscription is needed. Note the *Application (client) ID*
   and *Directory (tenant) ID*.
3. **Federated credentials (two).** In the app: Certificates & secrets ▸ Federated credentials ▸
   **Add credential** ▸ scenario *GitHub Actions deploying Azure resources*: Organization
   `tommmy-ctrl`, Organization ID `181824518`, Repository `kubectl-control`, Repository ID
   `1242445166`, Entity type **Environment**, Environment name `marketplace`, audience
   `api://AzureADTokenExchange`. The *Name* field is only a label (e.g.
   `github-marketplace-immutable`; no `:` or `/`). Add it twice with these subjects:
   - `repo:tommmy-ctrl@181824518/kubectl-control@1242445166:environment:marketplace`
     (the generated default — GitHub's immutable-ID format, used for repos created, renamed
     or transferred after 2026-07-15)
   - `repo:tommmy-ctrl/kubectl-control:environment:marketplace` (via *Edit* on the subject —
     the classic format this repo, created 2026-05-18, still receives)

   Entra compares the subject exactly; keeping both makes a later rename/transfer harmless.
   Do **not** create a client secret.
4. **GitHub variables.** In the `marketplace` environment add the *variables* (not secrets)
   `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` with the values from step 2.
5. **Get the Marketplace member ID.** The workflow **Marketplace identity (one-time setup)**
   runs on every push to `beta` that changes `.github/workflows/marketplace-identity.yml`
   (manual *Run workflow* only works once the file is on `main`). It creates the identity's
   Azure DevOps profile and prints its ID in the run summary.
6. **Add the identity to the publisher.** [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
   ▸ publisher `tommmy-ctrl` ▸ **Members** ▸ Add ▸ paste the ID from step 5 ▸ role
   **Contributor** (may publish updates; cannot manage the publisher).
7. **Remove the old secret.** Delete the repo secret `VSCE_PAT` and revoke the PAT in Azure
   DevOps (User settings ▸ Personal access tokens).

From then on, a `vX.Y.0` / `vX.Y.Z-pre` tag publishes without any stored credential. Because the
federated credential trusts only the `marketplace` environment and the environment only admits
`v*` tags (and `beta` for step 5), no other branch or pull request can obtain a publishing token.

---

## 4. Versioning Rules

Strict SemVer, plus one project-specific split (see the Overview note for the rationale):

- **Stable releases are always `X.Y.0`.** The patch position is reserved and is always `0` for
  anything that reaches `main`/a `vX.Y.0` tag.
- **Every beta and pre-release round is `X.Y.Z` with `Z ≥ 1`**, under whichever minor is
  currently in development. `package.json` on `beta` carries this dev-round number directly —
  unlike before, it's expected to change between rounds (bump `Z` for each new round a tester
  will download; see the note in section 1 about same-round fixups).
- **GitHub tags** separate the three channels:
  - **Stable:** `vX.Y.0` (e.g. `v1.5.0`) — pushes `release.yml` in stable mode → Marketplace
    publish + Auto-Update for everyone.
  - **Marketplace pre-release:** `vX.Y.Z-pre`, `Z ≥ 1` (e.g. `v1.4.2-pre`) — pushes `release.yml`
    in pre-release mode (`--pre-release`) → Marketplace publish + Auto-Update, but only for users
    who opted into VS Code's pre-release toggle. See section 1b.
  - **GitHub-only beta:** `beta-vX.Y.Z`, `Z ≥ 1` (e.g. `beta-v1.4.2`) — created/updated in place
    by `beta-release.yml`, GitHub Pre-Release/`.vsix` only. Does not start with `v`, so it
    **never** matches the `v*` trigger of `release.yml` and cannot reach the Marketplace.
- **Promoting always jumps to the next unused `X.Y.0`** — never to the dev round's own `X.Y.Z`
  (section 2). Figure out ahead of time whether the round is a MINOR-level (new features) or
  effectively still the same minor as last stable; either way the *promoted* number is always
  `.0` — there's no scenario where a dev round's patch number becomes the stable number.
- **MAJOR** bumps as usual for breaking changes; the same `X.Y.0`-stable / `X.Y.Z`-dev split
  restarts under the new major.
- **Maintain `CHANGELOG.md`:** The Marketplace displays it in the "Changelog" tab. Collect changes
  under `## [Unreleased]`; when promoting, this becomes `## [X.Y.0] – YYYY-MM-DD`.

---

## 5. Before Every Prod Release (Checklist)

- [ ] Beta has been tested (Sideload `.vsix`)
- [ ] `CHANGELOG.md` updated
- [ ] `/security-review` passes clean on the diff
- [ ] All CI gates on `beta` are green
- [ ] Final version determined — the next unused `X.Y.0`, not the dev round's `X.Y.Z`
