# Changelog

All notable changes to this extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [SemVer](https://semver.org/): each stable release
increments `MAJOR.MINOR.PATCH` in the usual way. Betas are not a separate version
namespace — they are simply GitHub pre-release `.vsix` files under the tag
`beta-vX.Y.Z-beta.N` (see [docs/RELEASE.md](docs/RELEASE.md)).

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
- **Beta tags now carry a build number:** `beta-release.yml` tags each push as
  `beta-vX.Y.Z-beta.N` (`N` auto-incrementing for the target version) instead of reusing
  and overwriting a single `beta-vX.Y.Z` tag/release. `package.json` itself stays a bare
  `X.Y.Z` as before (VS Code requires this). See [docs/RELEASE.md](docs/RELEASE.md).

### Removed
- **Dead code:** unused `src/terminal.ts` wrapper.
- **Unused `@vscode/l10n` / `@vscode/l10n-dev` tooling and the `l10n/` bundle folder** —
  superseded by the new custom `t()`/`wt()` translation helpers, which additionally support
  the per-extension language override that the native `vscode.l10n` mechanism cannot provide.

### Security
- **`.gitignore` hardened:** added `.env`/`.env.*`, the CI-generated `resources/icon.png`,
  and common OS/editor cruft (`.DS_Store`, `Thumbs.db`, `*.log`).

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
