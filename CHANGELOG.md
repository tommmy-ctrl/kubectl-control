# Changelog

All notable changes to this extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: **stable releases are always `X.Y.0`**; beta and pre-release dev rounds use `X.Y.Z`
with `Z ≥ 1` and promote to the next unused `X.Y.0`, never to their own number (see
[docs/RELEASE.md](docs/RELEASE.md) for the rationale). Day-to-day betas are GitHub pre-release
`.vsix` files under the tag `beta-vX.Y.Z`; occasionally a dev round is instead (or additionally)
published on the Marketplace's own Pre-Release channel (tag `vX.Y.Z-pre`, opt-in via
"Switch to Pre-Release Version") — those entries say so explicitly.

## [1.4.8] – 2026-09-29

### Changed
- **Unlocking shows progress and blocks less.** After clicking *Unlock* the button changes to
  "Unlocking…" and the form is disabled until the result arrives (it resets on a wrong password
  or lockout). The password hash (PBKDF2, 200,000 iterations) is now computed off the extension
  host's main thread, a successful unlock no longer writes the brute-force counters when there
  is nothing to reset (each SecretStorage write is a round trip to the local keychain in
  Remote-SSH windows), and the status-check catch-up starts 1.5 s after unlocking so the view
  renders first. The log records how long verification took. Existing passwords are unaffected
  — the hash is bit-for-bit identical. ([src/lockService.ts](src/lockService.ts))

### Maintenance
- Development tooling updated (eslint, typescript-eslint, mocha, webpack, webpack-cli,
  @vscode/test-electron, @types/node); no change to the shipped extension. Dependabot no longer
  proposes TypeScript 7 (not yet supported by typescript-eslint) or `@types/vscode` newer than
  the supported VS Code version.

## [1.4.7] – 2026-09-29

### Fixed
- **Large resource lists failed with "stdout maxBuffer length exceeded"** — e.g. Pods in
  *All namespaces* on bigger clusters. The output limit per kubectl/helm call was Node's
  default of 1 MiB and is now 64 MiB. ([src/kubectlExec.ts](src/kubectlExec.ts))

### Changed
- **Faster-feeling Pods/Deployments views:** the panel shows "Loading…" immediately and a
  spinner appears in the status bar while kubectl runs (initial load and Refresh). Timeouts
  raised to 15 s (single namespace) / 30 s (all namespaces), since credential plugins such as
  `aws eks get-token` alone can take a few seconds per kubectl call.
- **The namespace list is cached per connection for 2 minutes**, so the namespace menu opens
  instantly on repeat use.

## [1.4.6] – 2026-09-29

### Changed
- **Namespaces are picked from a menu instead of typed.** Pods, Deployments, Permissions
  (can-i), Helm History and Port Forward now show the cluster's live namespaces (current one
  first, type to filter). If the account may not list namespaces, the current one and
  *Enter manually…* remain; a valid name typed into the filter is accepted directly.
  ([src/features/namespaceBrowser.ts](src/features/namespaceBrowser.ts))

- **Lighter background status checks** — they could cause load spikes on small remote hosts
  that dropped VS Code Remote-SSH connections: at most **3 clusters are checked at the same
  time** (each check starts kubectl and possibly a credential plugin such as `aws`), a new
  round never starts while the previous one is still running, **only the focused VS Code
  window polls** (a background window catches up when it is brought to the front), and
  clusters without `kubectl auth whoami` support go straight to `cluster-info` instead of
  starting two processes every time. ([src/clusterStatus.ts](src/clusterStatus.ts))

### Added
- **"All namespaces" for Pods and Deployments** (`kubectl get … --all-namespaces`), with an
  extra *Namespace* column; 📋 Logs and ⌨ Shell use each pod's own namespace.

## [1.4.5] – 2026-09-29

### Added
- **Shell in Pod.** The Pods viewer has a new **⌨ Shell** button per pod that opens
  `kubectl exec -it <pod> -- sh` in a terminal (container picker for multi-container pods;
  confirmation on production clusters). ([src/features/resourceViewer.ts](src/features/resourceViewer.ts))
- **Manage credential-plugin approvals.** Settings menu (⚙) ▸ *Credential Plugin Approvals*
  (or Command Palette ▸ *Kubectl Control: Manage Credential Plugin Approvals*) lists every
  connection that uses an `exec`/`auth-provider` plugin with its command and approval state.
  Approve it there, or revoke an approval — revoking applies to every connection using the
  identical command. ([src/execTrust.ts](src/execTrust.ts))

### Changed
- **"Show Debug Logs" works while the extension is locked** again, so the log is available
  when unlocking misbehaves. It never contains kubeconfigs or passwords.

### Notes
- The first unlock after updating to 1.4.x can take noticeably longer: the stored connections
  are migrated once and the status checks paused while locked all run at that moment.
  Subsequent unlocks are fast.

## [1.4.4] – 2026-09-28

### Security
- **New passwords must have at least 12 characters** (was 6) — for the lock password, the
  export-file password and GitHub Sync (already 12). Existing shorter lock passwords keep
  working; after unlocking with one, a one-time hint per session suggests choosing a longer
  password. Older export files still import with their original password.
  ([src/passwordPolicy.ts](src/passwordPolicy.ts))
- **The kubectl availability check no longer runs through a shell.** It now uses `execFile`
  with an argument array, like every other kubectl call.
  ([src/terminalManager.ts](src/terminalManager.ts))

### Changed
- **Marketplace publishing uses Microsoft Entra ID (OIDC) instead of a Personal Access
  Token** — no long-lived secret is stored any more. See [docs/RELEASE.md](docs/RELEASE.md) §3a.
- **README and Marketplace description updated** to cover all features: multiple terminals,
  cluster status/pin/production/filter, pods & logs, port-forward, Helm, RBAC, namespace switch,
  GitHub Sync, auto-lock, credential-plugin approval, settings; requirements corrected to
  VS Code 1.125+ and optional `helm`.

## [1.4.3] – 2026-09-27

> Marketplace **pre-release** (tag `v1.4.3-pre`, see [docs/RELEASE.md](docs/RELEASE.md) §1b) —
> opt in via Extensions view ▸ kubectl-control ▸ "Switch to Pre-Release Version". Contains the
> 1.4.1 dev-round features below plus the security fixes and dependency updates listed here.
>
> `1.4.2` only ever existed as a GitHub beta build (`beta-v1.4.2`, dependency updates only) and
> is superseded by this round; it was never published to the Marketplace.

### Security
- **Credential plugins in kubeconfigs now need explicit approval.** A kubeconfig can declare
  `users[].user.exec` or a legacy `auth-provider` (`cmd-path`); kubectl runs those programs on
  your machine whenever it connects. Previously an imported file or a Gist pull could run such a
  program without any user action — the background status check called kubectl for every
  cluster on startup and every 60 s. Now the exact command is shown in a confirmation dialog the
  first time a connection needs it (opening a terminal, pods/helm/RBAC/port-forward, namespace
  switch, the connection test when adding or editing). Unapproved connections show 🛡️ in the tree
  and are skipped by status checks. Approvals are a fingerprint of the plugin command, stored
  per machine: they are never exported or synced, and any change to the command asks again.
  **Existing connections are approved automatically on update** (their plugins already ran
  before), and contexts imported from your own `~/.kube/config` count as approved.
  ([src/execTrust.ts](src/execTrust.ts), [src/kubectlExec.ts](src/kubectlExec.ts))
- **The password lock now covers every action.** Pods/deployments, Helm, RBAC, port-forward,
  pin/production toggles, cluster filter, debug logs and all GitHub Sync commands previously
  worked while locked — and so did **export, import and sync from the settings menu (⚙)**,
  which let anyone export all kubeconfigs without the password. All of them now require
  unlocking; open resource panels and a connection form left open before auto-lock stop
  responding too. Background status checks pause while locked and resume on unlock.
  "Reset Application" stays available as the forgotten-password fallback.
  ([src/commandGuard.ts](src/commandGuard.ts))
- Storage schema version 2 (adds the per-connection approval). Migration is automatic and
  one-time; older versions can still read the new format.

### Changed
- **Dependency updates** (Dependabot): `js-yaml` 5.3.0 → 5.4.1 (#28), `uuid` 14.0.1 → 14.0.2
  (#26); dev/transitive: `fast-uri` 3.1.5 → 3.1.7 (#29), `browserslist` 4.28.2 → 4.28.9 (#30),
  `baseline-browser-mapping` 2.10.31 → 2.11.23 (#32).
- Not included: the `dev-tooling` group (#27) — its TypeScript 7 bump conflicts with the
  `@typescript-eslint` peer range (`<6.1.0`) and fails `npm ci`.

## [1.4.1] – 2026-08-27

### Added
- **"Close All Terminals" per cluster.** New context-menu action (`$(close-all)`) on a cluster
  row closes every open terminal for that cluster in one step, instead of closing each one
  individually. ([src/commands.ts](src/commands.ts))
- **Live pod log streaming.** The Pods viewer (`kubectl-control.listPods`) now has a "📋 Logs"
  button per row that opens `kubectl logs -f` for that pod in a new terminal, using the
  cluster's kubeconfig automatically. Prompts for a container when a pod has more than one
  (or offers "All containers" via `--all-containers=true --prefix`). Pod/container names are
  validated against the same DNS_LABEL pattern used for namespaces before ever reaching the
  shell command. ([src/features/resourceViewer.ts](src/features/resourceViewer.ts))
- **Cluster search/filter.** A new search icon in the Clusters view title bar filters the tree
  by name, namespace, or group (case-insensitive substring); a "No clusters match" placeholder
  is shown when nothing matches, with a one-click way to clear the filter.
  ([src/treeDataProvider.ts](src/treeDataProvider.ts))

## [1.4.0] – 2026-08-27

> **First release on the Marketplace Pre-Release channel.** Published via a new `vX.Y.Z-pre`
> git tag (see [docs/RELEASE.md](docs/RELEASE.md) §1b) rather than a stable `vX.Y.Z` tag — opt
> in via Extensions view ▸ kubectl-control ▸ "Switch to Pre-Release Version". This is a
> deliberate, occasional escalation beyond the usual GitHub-only `beta-vX.Y.Z` sideload channel,
> not a reversal of the reasoning behind removing the old always-on Marketplace pre-release
> channel (see the `1.2.1`/`1.3.3` entries below) — that trade-off (this exact version number
> can never be published as stable afterwards) still applies and was accepted knowingly for
> this release.

### Added
- **Multiple terminals per cluster.** A new "+" inline action (`$(terminal-add)`) on each
  cluster row in the tree opens an additional terminal for that cluster instead of just
  focusing the existing one. Terminals beyond the first are numbered in their tab title
  (e.g. "☸ prod (2)"), and the tree description shows a `●×N` indicator once more than one
  is open. All terminals for a cluster share the same temp kubeconfig file; it's only
  deleted once the last one closes. Namespace switches (`kubectl-control.switchNamespace`)
  now apply to every open terminal for the cluster, not just one.
  ([src/terminalManager.ts](src/terminalManager.ts), [src/treeDataProvider.ts](src/treeDataProvider.ts))

### Changed
- **`release.yml` now supports a `vX.Y.Z-pre` tag** for occasional Marketplace pre-release
  publishes, alongside the existing stable `vX.Y.Z` tag. See
  [docs/RELEASE.md](docs/RELEASE.md) §1b for when to use it and its version-numbering trade-off.

## [1.3.3] – 2026-07-08

> **Why the jump from 1.2.2 to 1.3.3?** An earlier mistake published `1.3.0`–`1.3.2` to the
> Marketplace as pre-releases (since removed as a channel, see the 1.2.1 entry below). The
> Marketplace won't let the highest-ever-published version be deleted from its version history
> until a newer version supersedes it, and VS Code's pre-release tracking always follows the
> numerically highest version regardless of stable/pre-release status — so users who once opted
> into pre-release updates were stuck offering `1.3.2` forever. Targeting `1.3.3` (instead of
> `1.2.3`) resolves this for everyone in one release. No functional significance beyond that.

### Added
- **Bilingual UI (English / German).** New setting `kubectl-control.language`
  (`auto`/`en`/`de`, default `auto`) controls the extension's runtime UI language
  independently of VS Code's own display language. Messages, prompts, quick picks, and the
  setup/lock/connection-form webviews are now available in both languages via
  [src/i18n.ts](src/i18n.ts) and [src/i18n/translations.de.ts](src/i18n/translations.de.ts).
  Command titles and settings descriptions in the Command Palette continue to follow VS
  Code's own display language (a VS Code platform limitation, not affected by the new
  setting).
- **Language switcher in the Settings menu (⚙).** A single "Language" entry cycles
  Auto → English → German → Auto, so the language can be changed without leaving the
  extension's own menu (in addition to the `kubectl-control.language` VS Code setting).

### Changed
- **Project documentation translated to English.** `CLAUDE.md`, `CONTRIBUTING.md`,
  `docs/RELEASE.md`, and `CHANGELOG.md` are now written in English. VS Code UI strings
  remain bilingual as described above.
- **`package.nls.json` reverted to English** (the VS Code default-locale convention);
  `package.nls.de.json` continues to provide the German translation.
- **Beta builds are now individually identifiable from inside the extension.** Each build
  bakes in its short commit SHA (`BUILD_SHA` env var → `webpack.DefinePlugin`), shown next
  to the version number in the connection form's footer (e.g. `kubectl-control v1.3.3
  (a1b2c3d)`). Beta pushes continue to update the same `beta-vX.Y.Z` tag/release in place
  (`package.json` stays a bare `X.Y.Z`, as VS Code requires) — the footer SHA is what lets
  you tell which commit a given sideloaded build actually came from. See
  [docs/RELEASE.md](docs/RELEASE.md).

### Fixed
- **`EACCES: permission denied` opening cluster terminals on shared/multi-user machines.**
  Temporary kubeconfig files were written to a fixed, unversioned directory name under
  `os.tmpdir()` (e.g. `/tmp/kubectl-control-ext`). On POSIX systems this directory is shared
  across all local users; whichever user's process created it first "owned" it (mode
  `0o700`), so every other OS user then failed to open terminals with `EACCES`. The temp
  directory is now scoped per OS username (`kubectl-control-ext-<username>`), shared between
  [src/kubectlExec.ts](src/kubectlExec.ts) and [src/terminalManager.ts](src/terminalManager.ts)
  so each user always gets a directory they own.

### Removed
- **Dead code:** unused `src/terminal.ts` wrapper.
- **Unused `@vscode/l10n` / `@vscode/l10n-dev` tooling and the `l10n/` bundle folder** —
  superseded by the new custom `t()`/`wt()` translation helpers, which additionally support
  the per-extension language override that the native `vscode.l10n` mechanism cannot provide.

### Security
- **`.gitignore` hardened:** added `.env`/`.env.*`, the CI-generated `resources/icon.png`,
  and common OS/editor cruft (`.DS_Store`, `Thumbs.db`, `*.log`).
- **js-yaml updated to 5.3.0** (from 5.2.1) — closes a high-severity ReDoS advisory
  ([GHSA-pm4m-ph32-ghv5](https://github.com/advisories/GHSA-pm4m-ph32-ghv5)) in the YAML
  parser used for kubeconfig import/export. API-compatible (`load`/`dump`), required to
  keep `npm audit --omit=dev --audit-level=high` clean for the release gate.

## [1.2.2] – 2026-07-07

### Security
- **js-yaml updated to 5.2.1** (from 4.1.0) — closes known vulnerabilities in the
  YAML parser used for kubeconfig import/export ([src/kubeconfigParser.ts](src/kubeconfigParser.ts),
  [src/setup.ts](src/setup.ts)). API-compatible (`load`/`dump`), verified against the
  existing kubeconfig parser test suite.
- **Dev-tooling group updated:** `@types/glob`, `@types/node`, `@types/uuid`,
  `@typescript-eslint/eslint-plugin`, `eslint`, `webpack`, `webpack-cli`. Pure
  build/lint dependencies, no runtime impact.

## [1.2.1] – 2026-07-06

### Changed
- **Unified release process.** The confusing even/odd MINOR convention and the
  Marketplace pre-release channel have been removed. From now on, strict SemVer; betas
  are distributed solely as GitHub `.vsix` files for sideloading, distinguished only by
  the tag prefix `beta-v…`. See [docs/RELEASE.md](docs/RELEASE.md).
  (No functional changes to the extension.)

## [1.2.0] – 2026-07-03

First stable release of the reworked version. Consolidates the `1.1.x` beta series.

### Added
- **Auth-aware cluster status.** The status check now verifies real authentication
  (`kubectl auth whoami`, fallback `cluster-info`) rather than just reachability.
  New status **🟡 "not authenticated"** for expired or invalid tokens
  (e.g. Rancher `system:unauthenticated`), including a one-time notification.
  🟢 reachable · 🟡 token expired · 🔴 unreachable.
- **Custom terminal prompt.** Optional prompt `kubectl@<connection-name> >` per terminal
  (bash, zsh, PowerShell with color; cmd as plain text). The color is freely configurable
  **per connection**. Can be disabled via the setting
  `kubectl-control.customTerminalPrompt`.
- **Clean terminal startup.** Setup commands (context switch, prompt) are hidden after
  execution so the terminal starts without command noise.
- **Connection test on save.** When creating or editing a connection, it is briefly
  tested; if the test fails, a **dismissible** warning is shown.
- **Version display.** The installed version is shown in the connection panel (footer)
  and in the activation log.
- **Unified settings access.** The gear menu now includes "Open Settings" and navigates
  directly to the VS Code settings filtered to this extension.

### Changed
- **Deleting closes terminals.** When a connection is deleted, its open terminal sessions
  are automatically closed.
- The default shell is resolved platform-dependently (Windows → PowerShell, otherwise
  bash), including correct behavior for Remote-SSH.

### Security
- Connection and prompt values are sanitized before use in terminal commands (no escaping
  from shell arguments, including when the prod warning is active).
- Prompt color is consistently validated against `#rrggbb` (create, edit, import).

[1.2.2]: https://github.com/tommmy-ctrl/kubectl-control/releases/tag/v1.2.2
[1.2.1]: https://github.com/tommmy-ctrl/kubectl-control/releases/tag/v1.2.1
[1.2.0]: https://github.com/tommmy-ctrl/kubectl-control/releases/tag/v1.2.0
