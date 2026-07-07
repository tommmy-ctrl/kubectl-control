# Changelog

Alle nennenswerten Änderungen an dieser Extension werden hier dokumentiert.
Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung folgt [SemVer](https://semver.org/lang/de/): jedes Stable-Release
erhöht `MAJOR.MINOR.PATCH` regulär. Betas sind kein eigener Versionsraum, sondern nur
GitHub-Pre-Release-`.vsix` unter dem Tag `beta-vX.Y.Z` (siehe [docs/RELEASE.md](docs/RELEASE.md)).

## [1.2.2] – 2026-07-07

### Sicherheit
- **js-yaml auf 5.2.1 aktualisiert** (von 4.1.0) — schließt bekannte Schwachstellen im
  YAML-Parser, der für Kubeconfig-Import/-Export genutzt wird ([src/kubeconfigParser.ts](src/kubeconfigParser.ts),
  [src/setup.ts](src/setup.ts)). API-kompatibel (`load`/`dump`), verifiziert über die
  bestehende Kubeconfig-Parser-Testsuite.
- **Dev-Tooling-Gruppe aktualisiert:** `@types/glob`, `@types/node`, `@types/uuid`,
  `@typescript-eslint/eslint-plugin`, `eslint`, `webpack`, `webpack-cli`. Reine
  Build-/Lint-Abhängigkeiten, keine Laufzeitauswirkung.

## [1.2.1] – 2026-07-06

### Geändert
- **Release-Prozess vereinheitlicht.** Die verwirrende gerade/ungerade-MINOR-Konvention und
  der Marketplace-Pre-Release-Kanal wurden entfernt. Ab jetzt striktes SemVer; Betas laufen
  nur noch als GitHub-`.vsix` zum Sideload, getrennt allein über das Tag-Präfix `beta-v…`.
  Siehe [docs/RELEASE.md](docs/RELEASE.md). (Keine funktionalen Änderungen an der Extension.)

## [1.2.0] – 2026-07-03

Erstes Stable-Release der überarbeiteten Version. Fasst die Beta-Reihe `1.1.x` zusammen.

### Neu
- **Auth-bewusster Cluster-Status.** Der Statuscheck prüft jetzt echte
  Authentifizierung (`kubectl auth whoami`, Fallback `cluster-info`) statt nur
  Erreichbarkeit. Neuer Status **🟡 „nicht authentifiziert"** für abgelaufene bzw.
  ungültige Tokens (z. B. Rancher `system:unauthenticated`) inkl. einmaliger
  Benachrichtigung. 🟢 erreichbar · 🟡 Token abgelaufen · 🔴 nicht erreichbar.
- **Individueller Terminal-Prompt.** Optionaler Prompt `kubectl@<Verbindungsname> >`
  pro Terminal (bash, zsh, PowerShell mit Farbe; cmd als Text). Die Farbe ist
  **pro Verbindung** frei wählbar. Abschaltbar über die Einstellung
  `kubectl-control.customTerminalPrompt`.
- **Sauberer Terminalstart.** Setup-Befehle (Context-Wechsel, Prompt) werden nach
  der Ausführung ausgeblendet, sodass das Terminal ohne Kommando-Rauschen startet.
- **Verbindungstest beim Speichern.** Beim Anlegen/Bearbeiten wird die Verbindung
  kurz getestet; schlägt der Test fehl, erscheint eine **ignorierbare** Warnung.
- **Versionsanzeige.** Die installierte Version steht im Verbindungs-Panel (Fußzeile)
  und im Aktivierungs-Log.
- **Einheitlicher Einstellungs-Zugang.** Das Zahnrad-Menü enthält nun „Einstellungen
  öffnen" und führt direkt zu den auf die Extension gefilterten VS-Code-Settings.

### Geändert
- **Löschen schließt Terminals.** Beim Löschen einer Verbindung werden ihre offenen
  Terminal-Sitzungen automatisch geschlossen.
- Standard-Shell wird plattformabhängig aufgelöst (Windows → PowerShell, sonst bash),
  auch korrekt für Remote-SSH.

### Sicherheit
- Verbindungs- und Prompt-Werte werden vor der Verwendung in Terminal-Kommandos
  sanitisiert (kein Ausbrechen aus Shell-Argumenten, auch bei Prod-Warnung).
- Prompt-Farbe wird konsistent gegen `#rrggbb` validiert (Anlegen, Bearbeiten, Import).

[1.2.2]: https://github.com/tommmy-ctrl/kubectl-control/releases/tag/v1.2.2
[1.2.1]: https://github.com/tommmy-ctrl/kubectl-control/releases/tag/v1.2.1
[1.2.0]: https://github.com/tommmy-ctrl/kubectl-control/releases/tag/v1.2.0
