# Contributing & Code Standards — `kubectl-control`

Thank you for your contribution! This file describes the binding standards for code, commits,
branches, and reviews. For the release process see [docs/RELEASE.md](docs/RELEASE.md); for
working with AI agents see [CLAUDE.md](CLAUDE.md).

---

## 1. Prerequisites

- Node.js 20.x (as used in CI).
- `npm ci` for reproducible installs.
- VS Code ≥ 1.125 for debugging (`F5` launches the Extension Host instance).

---

## 2. Quality Gates (must pass locally before you push)

| Gate | Command | Meaning |
|------|---------|---------|
| Typecheck | `npx tsc --noEmit -p .` | No type errors. **Required after every change.** |
| Lint | `npm run lint` | ESLint (Flat Config) clean. |
| Tests | `npm test` | Mocha + `@vscode/test-electron`. |
| Build | `npx webpack --mode production` | Production bundle compiles. |
| Audit | `npm audit --omit=dev --audit-level=high` | No high-severity issues in prod deps. |

The CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) enforces the same gates on every
PR and push to `main`/`beta`.

---

## 3. Code Standards

### TypeScript
- `strict` remains enabled; no `any` workarounds without justification.
- No unused variables or imports.
- Annotate public functions with a return type.
- Do not silently swallow errors: use `try/catch` with `log.error(...)` from [src/logger.ts](src/logger.ts);
  `void promise` only with `.catch(...)`.
- Disposables (listeners, terminals, emitters, temp files, child processes) **must always** be
  cleaned up — push them into `context.subscriptions` or release them in `dispose()`.

### Style
- Match the surrounding code (indentation, naming, idioms). Do not reformat lines you did not author.
- Semicolons as required by ESLint; `eqeqeq`, `curly`, and `no-throw-literal` are enforced.
- File names `camelCase.ts`; feature modules go under `src/features/`.

### Security (see also [CLAUDE.md](CLAUDE.md) §4)
- Secrets only in `vscode.SecretStorage`.
- External processes via [src/kubectlExec.ts](src/kubectlExec.ts), arguments as an array, never
  shell interpolation.
- Validate user input: context names `/^[a-zA-Z0-9._-]+$/`, namespaces RFC-1123 (max 63), ports 1–65535.
- Webviews: CSP with a `crypto.randomBytes` nonce, HTML-escape all dynamic values.

### i18n
The extension is bilingual (English / German). There are two independent localization
mechanisms — do not mix them up:
- **Manifest strings** (command titles, config descriptions declared in `package.json`) use
  the standard VS Code NLS mechanism: `%key%` placeholders resolved from `package.nls.json`
  (English, default) and `package.nls.de.json` (German). VS Code picks the file based on its
  own display language — this is **not** affected by the `kubectl-control.language` setting,
  since manifest resolution happens before extension code runs.
- **Runtime strings** (messages, quick picks, prompts, webview text) use `t('English text', ...args)`
  from [src/i18n.ts](src/i18n.ts), the English literal argument is both the displayed text and the
  lookup key into the German dictionary at [src/i18n/translations.de.ts](src/i18n/translations.de.ts).
  The effective language honors `kubectl-control.language` (`auto` / `en` / `de`); `auto` follows
  VS Code's display language. When adding a new runtime string, add its English source string as a
  new key in `translations.de.ts` with the German translation as the value.
- Webview HTML ([src/webviews/templates.ts](src/webviews/templates.ts)) uses the same dictionary via
  a local `wt(lang, key, ...args)` helper — the resolved language is passed in by the caller
  ([src/connectionsView.ts](src/connectionsView.ts)) since the templates module has zero VS Code
  API dependency by design.
- The Settings menu (⚙, `kubectl-control.settingsMenu` in [src/commands.ts](src/commands.ts))
  has a single "Language" entry that cycles `kubectl-control.language` through
  `auto → en → de → auto` directly (`cycleLanguage()`), so users don't have to leave the menu
  to change language. Keep all settings entries flat in this one list — do not add a nested
  QuickPick ("sub-menu") for a single setting.

### Tests
- New core logic gets tests under `src/test/suite/*.test.ts` (TDD style: `suite`/`test`, `assert`).
- For classes that depend on `SecretStorage`, use a Map-based fake implementation in the test.

---

## 4. Commits & Branches

- **Conventional Commits:** `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `ci:`.
- Branch names: `feature/<short>`, `fix/<short>`, `chore/<short>`.
- Keep commits small and focused; one topic per PR.
- Commits created by an AI agent include the `Co-Authored-By` trailer.

### Branch Model
```
feature/*  ──PR──▶  beta  ──promote──▶  main
                     │                    │
              Pre-Release .vsix     Marketplace Release
              (no auto-update)      (auto-update)
```

---

## 5. Pull Requests

- Description: what, why, risks, proof of testing.
- All gates green (CI must pass).
- For security-relevant changes: include the `/security-review` result in the PR.
- At least one review before merging to `beta`/`main`.

---

## 6. Definition of Done

- [ ] `tsc --noEmit`, lint, tests, webpack build green
- [ ] New strings are i18n-ready
- [ ] Secrets/shell/webview rules followed
- [ ] Tests for new logic
- [ ] CHANGELOG entry (if user-visible)
- [ ] Conventional Commit message
