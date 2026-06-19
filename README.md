# Kubectl Control

VS Code-Erweiterung zur Verwaltung mehrerer Kubernetes-Cluster mit isolierten Terminals direkt in VS Code.

## Features

### Verbindungsverwaltung
- Cluster-Verbindungen mit Name, kubeconfig-YAML, Gruppe und Shell speichern
- kubeconfig-Datei direkt aus dem Dateisystem laden (📂 Laden-Button)
- Automatische Validierung und Context-Erkennung beim Eintippen
- Bei mehreren Contexts: gewünschten Context auswählen
- Namespace wird automatisch aus dem aktiven Context extrahiert

### Cluster-Terminal
- Jede Verbindung öffnet ein isoliertes VS Code-Terminal mit gesetzter `KUBECONFIG`-Umgebungsvariable
- Offene Terminals werden erkannt — Klick auf einen laufenden Cluster fokussiert das bestehende Terminal
- Shell pro Verbindung wählbar: Standard, bash, zsh, PowerShell, cmd

### Quick Switch (`Ctrl+Shift+K`)
- Öffnet eine Schnellauswahl aller gespeicherten Verbindungen
- Zeigt an, ob ein Terminal bereits geöffnet ist
- Neues Terminal öffnen oder bestehendes fokussieren

### Gruppen
- Verbindungen einer Gruppe zuweisen (z.B. "Produktion", "Staging")
- Gruppen erscheinen als aufklappbare Ordner im CLUSTERS-Panel

### Sicherheit
- Alle kubeconfig-Daten werden in VS Codes verschlüsseltem `SecretStorage` gespeichert (lokal, nicht synchronisiert)
- Optionaler Passwort-Schutz: Erweiterung beim Öffnen sperren
- Export immer AES-256-GCM-verschlüsselt mit eigenem Passwort (PBKDF2, 200.000 Iterationen)
- Temporäre kubeconfig-Dateien werden in `os.tmpdir()` mit Dateimodus `0600` abgelegt

### Import / Export
- Export: alle Verbindungen als verschlüsselte JSON-Datei speichern
- Import: verschlüsselte oder unverschlüsselte JSON-Dateien importieren
- Beim Import werden bestehende Verbindungen (gleiche ID) aktualisiert, neue hinzugefügt

## Erster Start

Beim ersten Start erscheint ein Setup-Assistent:
1. Optionaler Import vorhandener Verbindungen aus einer Exportdatei
2. Optionaler Passwort-Schutz aktivieren

Das CLUSTERS-Panel ist während des Setups ausgeblendet und erscheint erst nach Abschluss.

## Einstellungsmenü (⚙)

| Aktion | Beschreibung |
|---|---|
| Export (verschlüsselt) | Verbindungen als verschlüsselte JSON exportieren |
| Import | Verbindungen aus Datei importieren |
| Passwort-Schutz aktivieren | Lock beim Öffnen einschalten |
| Passwort ändern | Aktuelles Passwort ersetzen |
| Passwort-Schutz deaktivieren | Lock entfernen |
| Erweiterung sperren | Sofort sperren (nur bei aktivem Lock) |
| Debug-Logs anzeigen | Output-Panel mit Logs öffnen |
| Anwendung zurücksetzen | Alles löschen (doppelte Bestätigung) |

## Tastenkürzel

| Kürzel | Aktion |
|---|---|
| `Ctrl+Shift+K` / `Cmd+Shift+K` | Quick Switch — Cluster schnell öffnen/wechseln |

## Debugging & Logging

Logs werden im VS Code Output-Panel unter **"Kubectl Control"** angezeigt.

Öffnen über:
- Einstellungsmenü → **Debug-Logs anzeigen**
- Befehlspalette (`Ctrl+Shift+P`) → `Kubectl Control: Debug-Logs anzeigen`

Die Logs enthalten Zeitstempel, Level (`INFO`, `WARN`, `ERROR`) und bei Fehlern den vollständigen Stack-Trace.

## Datenspeicherung

| Was | Wo |
|---|---|
| Cluster-Verbindungen (kubeconfig) | VS Code `SecretStorage` (lokal, verschlüsselt) |
| Temporäre kubeconfig-Dateien | `os.tmpdir()/kubectl-control-ext/kubeconfig-<id>.yaml` |
| Setup-Status | VS Code `globalState` |
| Passwort-Hash + Salt | VS Code `SecretStorage` |

## Technische Details

- **Verschlüsselung:** AES-256-GCM via Node.js `node:crypto`
- **Key Derivation:** PBKDF2-SHA256, 200.000 Iterationen
- **Speicherformat:** VS Code `SecretStorage` (OS-Keychain / verschlüsselter lokaler Speicher)
- **Bundle:** Webpack, keine externen Laufzeit-Abhängigkeiten außer `uuid`

## Anforderungen

- VS Code 1.80.0 oder neuer
- `kubectl` muss im PATH vorhanden sein (wird von den geöffneten Terminals genutzt)
