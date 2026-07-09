# CLAUDE.md — Agent & Workflow Standards for `kubectl-control`

This file is automatically loaded into every Claude Code session. It defines **how** work
happens in this repository — both for the main agent and for subagents.

---

## 1. Project Overview

`kubectl-control` is a VS Code extension for managing multiple Kubernetes clusters with
isolated kubeconfig terminals, groups, encrypted export/import, GitHub Gist sync,
namespace switching, pinning, production marking, and auto-lock.

- **UI language:** Bilingual, English (default) / German. Manifest strings (command titles,
  config descriptions) use VS Code's NLS mechanism (`package.nls.json` / `package.nls.de.json`),
  following VS Code's own display language. Runtime strings (messages, prompts, webview text) use
  the custom `t()` helper in [src/i18n.ts](src/i18n.ts), which additionally honors the
  `kubectl-control.language` setting (`auto`/`en`/`de`). See CONTRIBUTING.md §i18n for details.
- **Stack:** TypeScript, Webpack bundle, Mocha + `@vscode/test-electron`.
- **Entry point:** [src/extension.ts](src/extension.ts).
- **Source modules:** `src/*.ts` (core logic) and `src/features/*.ts` (optional feature modules).

### Key Architecture Points
- **Secrets** (kubeconfigs, password hashes, sync tokens) always belong in
  `vscode.SecretStorage`, never in `globalState` or on disk in plaintext.
- **kubectl/helm calls** go through [src/kubectlExec.ts](src/kubectlExec.ts)
  (`execWithKubeconfig` / `createPersistentKubeconfig`) — temporary kubeconfig with `0o600`,
  temp dir `0o700`, arguments **always as an array** to `execFile`/`spawn` (never as a shell string).
- **Persistence** runs through [src/store.ts](src/store.ts) with a write mutex, in-memory
  cache, and schema versioning — mutations must never bypass serialization.

---

## 2. Golden Rules (apply to every agent)

1. **The build must stay green.** After every change to `.ts`/`package.json`:
   run `npx tsc --noEmit -p .`. Before finishing, also run `npx webpack --mode production`.
2. **Never log or store secrets in plaintext.** See security standards below.
3. **Shell safety:** user input (cluster/context/namespace names, ports, resources)
   is validated (regex) **before** use and passed only as an argument array.
4. **Additive-only changes to `package.json`/manifest.** Do not remove existing
   commands/menus/configs.
5. **Bilingual UI strings:** new runtime strings via `t('English text', ...)` from
   [src/i18n.ts](src/i18n.ts) plus a matching entry in
   [src/i18n/translations.de.ts](src/i18n/translations.de.ts); new manifest titles via NLS keys
   in both `package.nls.json` (English) and `package.nls.de.json` (German).
6. **No new runtime dependencies** without a clear reason; prefer `devDependencies`.

---

## 3. Working with Subagents (Parallelization)

This repo is frequently worked on with multiple parallel subagents. To keep that
conflict-free, the following applies:

- **File disjointness is mandatory.** Every parallel agent owns an **exclusive** set
  of files. Two agents must never edit the same file at the same time.
- **Shared files run sequentially.** `package.json`, `src/extension.ts`, and `src/commands.ts`
  are "hub files." Changes to them run in their **own, exclusive** wave
  (a wiring agent) after the feature modules are done.
- **New features = new module.** A feature lives in `src/features/<name>.ts` and exports
  `registerXxx(context, store): vscode.Disposable[]`. Wiring (manifest + `extension.ts`)
  is then handled by a separate wiring step.
- **Refactors before features.** First build shared utilities/foundations (file-disjoint,
  parallel), then features on top of them.
- **Ignore transient errors.** When `tsc` runs project-wide, it may report errors in files
  that a *different* parallel agent currently has half-finished. Each agent evaluates only
  errors in **its own** files; the main agent does a full green build at the end.
- **i18n last and alone.** String externalization touches all files and runs as the
  last, exclusive wave.

### Standard Prompt Building Blocks for Subagents
> "You may ONLY modify `<file(s)>`. Read other files, do not change them. After the change,
> run `npx tsc --noEmit -p .` and evaluate only errors in your file. Arguments always as an
> array, validate user input, secrets only in SecretStorage. Report changes as
> `file:line`."

---

## 4. Security Standards

- Secrets exclusively in `vscode.SecretStorage`.
- Crypto: AES-256-GCM + PBKDF2 (≥ 200,000 iterations), salt/IV random per operation,
  `timingSafeEqual` for comparisons. Crypto code centralized in [src/crypto.ts](src/crypto.ts) —
  do not duplicate.
- CSP nonces in webviews via `crypto.randomBytes`, **never** `Math.random()`.
- Every webview: strict CSP with nonce, **all** dynamic values HTML-escaped.
- No `exec` with interpolated shell strings. Validate context names against
  `/^[a-zA-Z0-9._-]+$/`, namespaces against RFC-1123 `/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/` (max 63).
- `npm audit --omit=dev --audit-level=high` must be clean in the release gate.
- Before every release: run `/security-review` over the diff.

---

## 5. Commands (Cheat Sheet)

```bash
npm run compile          # webpack (dev)
npm run watch             # webpack --watch
npm run package           # webpack production build (-> dist/)
npm run compile-tests     # tsc -> out/ (for tests)
npm run lint               # eslint (flat config: eslint.config.js)
npm test                   # @vscode/test-electron (Linux CI: via xvfb-run)
npx tsc --noEmit -p .      # pure type check (mandatory after every change)
```

---

## 6. Release/Branch Process (Short Version)

Full playbook: [docs/RELEASE.md](docs/RELEASE.md).

- `main` = production, published version (Marketplace).
- `beta` = pre-release integration. A push to `beta` automatically builds a **GitHub
  pre-release** with a `.vsix` (no Marketplace, **no** auto-update on manual sideload).
- Feature work on `feature/*` → PR to `beta`.
- **Beta → Prod** via the `promote` workflow (or manually: merge `beta` into `main` +
  set tag `vX.Y.Z`). The final tag triggers the Marketplace publish.
- Versioning scheme: **strict SemVer** with no special rules. `package.json` carries the
  target stable version `X.Y.Z` (VS Code requires this field to stay a bare `X.Y.Z`, no
  suffix); beta vs. stable is distinguished **only** by the tag: beta =
  `beta-vX.Y.Z-beta.N` (GitHub only, `N` auto-incremented per target version by
  `beta-release.yml` so each beta build gets its own release), stable = `vX.Y.Z`
  (Marketplace). No even/odd MINOR rule.

See code standards: [CONTRIBUTING.md](CONTRIBUTING.md).
