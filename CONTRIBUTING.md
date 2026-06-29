# Mitwirken & Code-Standards — `kubectl-control`

Danke für deinen Beitrag! Diese Datei beschreibt die verbindlichen Standards für Code, Commits,
Branches und Reviews. Für den Release-Ablauf siehe [docs/RELEASE.md](docs/RELEASE.md), für die
Arbeitsweise mit KI-Agenten [CLAUDE.md](CLAUDE.md).

---

## 1. Voraussetzungen

- Node.js 20.x (wie in der CI).
- `npm ci` für reproduzierbare Installs.
- VS Code ≥ 1.125 zum Debuggen (`F5` startet die Extension-Host-Instanz).

---

## 2. Qualitäts-Gates (müssen lokal grün sein, bevor du pushst)

| Gate | Befehl | Bedeutung |
|------|--------|-----------|
| Typecheck | `npx tsc --noEmit -p .` | Keine Typfehler. **Pflicht nach jeder Änderung.** |
| Lint | `npm run lint` | ESLint (Flat Config) sauber. |
| Tests | `npm test` | Mocha + `@vscode/test-electron`. |
| Build | `npx webpack --mode production` | Production-Bundle kompiliert. |
| Audit | `npm audit --omit=dev --audit-level=high` | Keine hohen Lücken in Prod-Deps. |

Die CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) erzwingt dieselben Gates bei jedem
PR und Push auf `main`/`beta`.

---

## 3. Code-Standards

### TypeScript
- `strict` bleibt aktiv; keine `any`-Workarounds ohne Begründung.
- Keine ungenutzten Variablen/Importe.
- Öffentliche Funktionen mit Rückgabetyp annotieren.
- Fehler nicht still schlucken: `try/catch` mit `log.error(...)` aus [src/logger.ts](src/logger.ts),
  `void promise` nur mit `.catch(...)`.
- Disposables (Listener, Terminals, Emitter, Temp-Dateien, ChildProcesses) **immer** aufräumen —
  in `context.subscriptions` pushen oder in `dispose()` freigeben.

### Stil
- Match den umgebenden Code (Einrückung, Naming, Idiome). Keine Stil-Reformatierung fremder Zeilen.
- Semikolons gemäß ESLint; `eqeqeq`, `curly`, `no-throw-literal` werden geprüft.
- Dateinamen `camelCase.ts`; Feature-Module unter `src/features/`.

### Sicherheit (siehe auch [CLAUDE.md](CLAUDE.md) §4)
- Secrets nur in `vscode.SecretStorage`.
- Externe Prozesse via [src/kubectlExec.ts](src/kubectlExec.ts), Argumente als Array, niemals
  Shell-Interpolation.
- Nutzereingaben validieren: Context `/^[a-zA-Z0-9._-]+$/`, Namespace RFC-1123 (max 63), Ports 1–65535.
- Webviews: CSP mit `crypto.randomBytes`-Nonce, alle Werte HTML-escapen.

### i18n
- Nutzersichtbare Strings im Code über `vscode.l10n.t('…')`.
- Manifest-Titel über `%key%` + `package.nls.json` / `package.nls.de.json`.

### Tests
- Neue Kernlogik bekommt Tests unter `src/test/suite/*.test.ts` (TDD-Stil: `suite`/`test`, `assert`).
- Für `SecretStorage`-abhängige Klassen eine Map-basierte Fake-Implementierung im Test verwenden.

---

## 4. Commits & Branches

- **Conventional Commits:** `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `ci:`.
- Branch-Namen: `feature/<kurz>`, `fix/<kurz>`, `chore/<kurz>`.
- Klein und fokussiert; ein Thema pro PR.
- Commits, die von einem KI-Agenten erstellt wurden, enthalten den `Co-Authored-By`-Trailer.

### Branch-Modell
```
feature/*  ──PR──▶  beta  ──promote──▶  main
                     │                    │
              Pre-Release .vsix     Marketplace-Release
              (kein Auto-Update)    (Auto-Update)
```

---

## 5. Pull Requests

- Beschreibung: Was, Warum, Risiken, Testnachweis.
- Alle Gates grün (CI muss durchlaufen).
- Für sicherheitsrelevante Änderungen: Ergebnis von `/security-review` im PR vermerken.
- Mindestens ein Review vor Merge nach `beta`/`main`.

---

## 6. Definition of Done

- [ ] `tsc --noEmit`, Lint, Tests, Webpack-Build grün
- [ ] Neue Strings i18n-fähig
- [ ] Secrets/Shell/Webview-Regeln eingehalten
- [ ] Tests für neue Logik
- [ ] CHANGELOG-Eintrag (falls nutzersichtbar)
- [ ] Conventional-Commit-Nachricht
