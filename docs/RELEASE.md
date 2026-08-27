# Release Playbook: Beta → Prod

This document describes the complete path from a change to a Marketplace release — and how Beta
builds are deployed **without** VS Code automatically updating them.

## Overview

```
feature/*  ──PR──▶  beta  ──(Promote workflow)──▶  main ──Tag vX.Y.Z──▶  Marketplace (stable)
                     │                                      │
                     │                              Tag vX.Y.Z-pre ──▶  Marketplace (pre-release)
                     │
            Push triggers beta-release.yml
            → GitHub *Pre-Release* + .vsix
            (Sideload, NO Marketplace,
             NO Auto-Update)
```

| Branch / Tag | Purpose | `package.json` Version | Publication | Auto-Update |
|--------|---------|------------------------|-------------|-------------|
| `feature/*` | Development | – | – | – |
| `beta` (push) | Pre-integration / Testing | Target-Stable `X.Y.Z` | GitHub **Pre-Release** (`.vsix`), Tag `beta-vX.Y.Z` | No — manually via "Install from VSIX…" |
| Tag `vX.Y.Z-pre` | Marketplace pre-release | `X.Y.Z` (suffix stripped for the manifest) | Marketplace (`--pre-release` flag) + GitHub Release | Yes — but only for users who opted into the Extensions view's "Switch to Pre-Release Version" |
| Tag `vX.Y.Z` (`main`) | Production | `X.Y.Z` | Marketplace + GitHub Release | Yes |

> **Two separate pre-release mechanisms, on purpose.** `beta-vX.Y.Z` (GitHub-only `.vsix`
> sideload) stays the default for day-to-day testing — no Marketplace footprint, no risk to
> the version history. `vX.Y.Z-pre` is a **deliberate, occasional** escalation for when a
> feature needs a wider pre-release audience than manual sideload testers, via VS Code's own
> built-in pre-release channel. It is not the default path — reach for it only when you
> specifically need that.
>
> **The lesson from the past `1.3.0`–`1.3.2` incident (see the `1.2.1`/`1.3.3` CHANGELOG
> entries) still applies and is not solved, only made deliberate:** the Marketplace shares one
> version space between stable and pre-release, and never lets the highest-ever-published
> version be deleted from history. **Every version number published via `vX.Y.Z-pre` is burned
> for stable use** — you can never later publish that exact `X.Y.Z` as a stable release; the
> eventual stable promotion must use a higher version (e.g. pre-release `1.4.0` → stable
> `1.4.1` or `1.5.0`, not `1.4.0` again). Plan the target stable version accordingly *before*
> pushing a `-pre` tag, and only use this path when you've accepted that trade-off.
>
> **Identifying a specific beta build:** since `package.json` intentionally does not change
> between beta rounds of the same target version, and each push to `beta` updates the **same**
> `beta-vX.Y.Z` tag/release (no accumulating tags), the exact build cannot be distinguished from
> the tag alone. Instead, `beta-release.yml` bakes the short commit SHA into the build
> (`BUILD_SHA` env var → `webpack.DefinePlugin` → `process.env.BUILD_SHA`), and
> [src/webviews/templates.ts](../src/webviews/templates.ts) shows it next to the version number
> in the connection form's footer (e.g. `kubectl-control v1.3.3 (a1b2c3d)`). Compare that SHA
> against `git log` to find the exact commit a running build came from.

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

As long as the same target stable version requires multiple beta rounds, `package.json` stays
the same; each push to `beta` **updates the same** `beta-vX.Y.Z` Pre-Release (tag and `.vsix`
are replaced in place) rather than creating a new one. To check which commit is actually behind
the current `.vsix`, look at the version footer inside the extension itself (see the note above)
or run:
```bash
git fetch --tags
git rev-parse beta-v1.3.3
```

---

## 1b. Publishing a Marketplace Pre-Release (occasional, deliberate)

Use this only when a feature needs testing by people who won't manually sideload a `.vsix` —
otherwise stick to the `beta-vX.Y.Z` flow above.

```bash
git checkout beta                    # or whatever commit you want to ship as pre-release
npm version 1.4.0 --no-git-tag-version --allow-same-version   # target version, see the warning above
git commit -am "chore: pre-release 1.4.0"
git push origin beta
git tag v1.4.0-pre
git push origin v1.4.0-pre           # triggers release.yml in pre-release mode
```

[`release.yml`](../.github/workflows/release.yml) detects the `-pre` suffix, strips it for the
`package.json`/`vsce package` version (VS Code requires a bare `X.Y.Z`), and passes
`--pre-release` to both `vsce package` and `vsce publish`. The GitHub Release is created with
`prerelease: true`. It does **not** touch `main` — a `-pre` tag can be pushed straight from a
`beta` commit without promoting anything.

Testers opt in via **Extensions view ▸ kubectl-control ▸ "Switch to Pre-Release Version"** — this
*does* show up in Marketplace search (unlike the GitHub-only beta channel) and *does* auto-update
for anyone who has opted in, straight to whatever the next `-pre` or stable publish is.

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
| `VSCE_PAT` | Marketplace publish (`vsce publish`) — stable **and** `-pre` tags | `release.yml` |
| `RELEASE_PAT` | Tag push that triggers `release.yml` (optional) | `promote.yml` |

`GITHUB_TOKEN` (automatic) is sufficient for GitHub Releases and asset uploads. `beta-release.yml`
only runs `vsce package` (a local build, no Marketplace interaction) and therefore needs neither
secret — the GitHub-only beta channel never touches the Marketplace, see the note in section 1
above. `release.yml` uses the same `VSCE_PAT` for both stable (`vX.Y.Z`) and pre-release
(`vX.Y.Z-pre`) tags — see section 1b.

> **`RELEASE_PAT`:** Only needed if you want the Promote workflow to run fully automatically
> through to the Marketplace publish. Without it: `promote.yml` merges and tags, but
> `release.yml` must then be started manually via "Run workflow". `VSCE_PAT` is already
> present and covers both channels.

---

## 4. Versioning Rules

We use **strict SemVer**. There is no even/odd MINOR convention. There **is** a Marketplace
Pre-Release channel (section 1b) — deliberately used only occasionally, never as the default
path, because of the version-burning trade-off explained in the Overview.

- **`package.json` version:** always the **target stable version** `X.Y.Z` (e.g. `1.3.0`), with
  no suffix — VS Code requires this field to stay bare, so it never encodes beta/pre-release
  rounds. `beta` and `main` carry the same planned version; a `-pre` tag strips its own suffix
  before it reaches `package.json` (see section 1b).
- **GitHub tags** separate the three channels:
  - **Stable:** `vX.Y.Z` (e.g. `v1.3.0`) — pushes `release.yml` in stable mode → Marketplace
    publish + Auto-Update for everyone.
  - **Marketplace pre-release:** `vX.Y.Z-pre` (e.g. `v1.4.0-pre`) — pushes `release.yml` in
    pre-release mode (`--pre-release`) → Marketplace publish + Auto-Update, but only for users
    who opted into VS Code's pre-release toggle. See section 1b for the trade-off before using
    this.
  - **GitHub-only beta:** `beta-vX.Y.Z` (e.g. `beta-v1.3.0`) — created/updated in place by
    `beta-release.yml`, GitHub Pre-Release/`.vsix` only. Does not start with `v`, so it **never**
    matches the `v*` trigger of `release.yml` and cannot reach the Marketplace. Multiple beta
    rounds for the same target version replace this same tag/release rather than accumulating
    separate ones — see "Identifying a specific beta build" above for how to tell which commit a
    given `.vsix` build came from.
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
