# CLAUDE.md — Agent- & Arbeitsstandards für `kubectl-control`

Diese Datei wird automatisch in jede Claude-Code-Session geladen. Sie definiert, **wie** in
diesem Repository gearbeitet wird — sowohl für den Haupt-Agenten als auch für Subagents.

---

## 1. Projektüberblick

`kubectl-control` ist eine VS-Code-Extension zur Verwaltung mehrerer Kubernetes-Cluster mit
isolierten Kubeconfig-Terminals, Gruppen, verschlüsseltem Export/Import, GitHub-Gist-Sync,
Namespace-Wechsel, Pinning, Prod-Markierung und Auto-Lock.

- **Sprache UI:** Deutsch (i18n über `vscode.l10n` / `package.nls*.json`).
- **Stack:** TypeScript, Webpack-Bundle, Mocha + `@vscode/test-electron`.
- **Einstiegspunkt:** [src/extension.ts](src/extension.ts).
- **Quellmodule:** `src/*.ts` (Kernlogik) und `src/features/*.ts` (optionale Feature-Module).

### Wichtige Architekturpunkte
- **Secrets** (Kubeconfigs, Passwort-Hashes, Sync-Token) gehören **immer** in
  `vscode.SecretStorage`, niemals in `globalState` oder auf Platte im Klartext.
- **kubectl/helm-Aufrufe** laufen über [src/kubectlExec.ts](src/kubectlExec.ts)
  (`execWithKubeconfig` / `createPersistentKubeconfig`) — temporäre Kubeconfig mit `0o600`,
  Temp-Dir `0o700`, Argumente **immer als Array** an `execFile`/`spawn` (nie als Shell-String).
- **Persistenz** läuft über [src/store.ts](src/store.ts) mit Write-Mutex, In-Memory-Cache und
  Schema-Versionierung — Mutationen niemals an der Serialisierung vorbei.

---

## 2. Goldene Regeln (gelten für jeden Agent)

1. **Build muss grün bleiben.** Nach jeder Änderung an `.ts`/`package.json`:
   `npx tsc --noEmit -p .` ausführen. Vor Abschluss zusätzlich `npx webpack --mode production`.
2. **Keine Geheimnisse loggen oder im Klartext speichern.** Siehe Security-Standards unten.
3. **Shell-Sicherheit:** Nutzereingaben (Cluster-/Context-/Namespace-Namen, Ports, Ressourcen)
   werden **vor** der Verwendung validiert (Regex) und nur als Argument-Array übergeben.
4. **Nur additiv an `package.json`/Manifest.** Bestehende Commands/Menüs/Configs nicht entfernen.
5. **Deutsche UI-Strings** über `vscode.l10n.t(...)`; neue Manifest-Titel über NLS-Keys.
6. **Keine neuen Laufzeit-Abhängigkeiten** ohne klaren Grund; `devDependencies` bevorzugen.

---

## 3. Arbeiten mit Subagents (Parallelisierung)

Dieses Repo wird häufig mit mehreren parallelen Subagents bearbeitet. Damit das konfliktfrei
bleibt, gilt:

- **Datei-Disjunktheit ist Pflicht.** Jeder parallele Agent besitzt einen **exklusiven** Satz
  an Dateien. Zwei Agents dürfen nie dieselbe Datei gleichzeitig editieren.
- **Geteilte Dateien sequenziell.** `package.json`, `src/extension.ts` und `src/commands.ts`
  sind „Hub-Dateien". Änderungen daran laufen in einer **eigenen, alleinigen** Welle
  (Wiring-Agent), nachdem die Feature-Module fertig sind.
- **Neue Features = neues Modul.** Ein Feature lebt in `src/features/<name>.ts` und exportiert
  `registerXxx(context, store): vscode.Disposable[]`. Verdrahtung (Manifest + `extension.ts`)
  übernimmt anschließend ein separater Wiring-Schritt.
- **Refactorings vor Features.** Erst gemeinsame Utilities/Fundament (datei-disjunkt, parallel),
  dann Features darauf.
- **Transiente Fehler ignorieren.** Läuft `tsc` projektweit, kann es Fehler in Dateien melden,
  die ein *anderer* paralleler Agent gerade halbfertig hat. Jeder Agent bewertet nur Fehler in
  **seinen eigenen** Dateien; der Haupt-Agent macht am Ende einen vollständigen grünen Build.
- **i18n zuletzt und allein.** String-Externalisierung fasst alle Dateien an und läuft als
  letzte, alleinige Welle.

### Standard-Prompt-Bausteine für Subagents
> „Du darfst NUR `<Datei(en)>` ändern. Lies andere Dateien, ändere sie nicht. Nach der Änderung
> `npx tsc --noEmit -p .` ausführen und nur Fehler in deiner Datei bewerten. Argumente immer als
> Array, Nutzereingaben validieren, Secrets nur in SecretStorage. Berichte Änderungen mit
> `Datei:Zeile`."

---

## 4. Security-Standards

- Secrets ausschließlich in `vscode.SecretStorage`.
- Krypto: AES-256-GCM + PBKDF2 (≥ 200 000 Iterationen), Salt/IV pro Operation zufällig,
  `timingSafeEqual` für Vergleiche. Krypto-Code zentral in [src/crypto.ts](src/crypto.ts) — nicht
  duplizieren.
- CSP-Nonces in Webviews mit `crypto.randomBytes`, **nie** `Math.random()`.
- Jede Webview: strikte CSP mit Nonce, **alle** dynamischen Werte HTML-escapen.
- Kein `exec` mit interpoliertem Shell-String. Context-Namen gegen `/^[a-zA-Z0-9._-]+$/`,
  Namespaces gegen RFC-1123 `/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/` (max 63) prüfen.
- `npm audit --omit=dev --audit-level=high` muss im Release-Gate sauber sein.
- Vor jedem Release: `/security-review` über den Diff laufen lassen.

---

## 5. Befehle (Cheat-Sheet)

```bash
npm run compile          # webpack (dev)
npm run watch            # webpack --watch
npm run package          # webpack production build (-> dist/)
npm run compile-tests    # tsc -> out/ (für Tests)
npm run lint             # eslint (flat config: eslint.config.js)
npm test                 # @vscode/test-electron (Linux-CI: via xvfb-run)
npx tsc --noEmit -p .    # reiner Typecheck (Pflicht nach jeder Änderung)
```

---

## 6. Release-/Branch-Prozess (Kurzfassung)

Vollständiges Playbook: [docs/RELEASE.md](docs/RELEASE.md).

- `main` = produktive, veröffentlichte Version (Marketplace).
- `beta` = Vorab-Integration. Push auf `beta` baut automatisch ein **GitHub Pre-Release**
  mit `.vsix` (kein Marketplace, **kein** Auto-Update beim manuellen Sideload).
- Feature-Arbeit auf `feature/*` → PR nach `beta`.
- **Beta → Prod** über den `promote`-Workflow (oder manuell: `beta` nach `main` mergen + Tag
  `vX.Y.Z` setzen). Der finale Tag triggert Marketplace-Publish.
- Versionsschema: Beta = `X.Y.Z-beta.N`, Prod = `X.Y.Z` (SemVer).

Siehe Code-Standards: [CONTRIBUTING.md](CONTRIBUTING.md).
