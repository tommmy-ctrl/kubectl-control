# Kubectl Control

A VS Code extension for managing multiple Kubernetes clusters with isolated kubeconfig terminals — directly inside VS Code.

## Features

### Connection Management
- Save cluster connections with name, kubeconfig YAML, group, and shell preference
- Load kubeconfig directly from the filesystem (📂 Load button)
- Automatic validation and context detection while typing
- Select a specific context when a kubeconfig contains multiple contexts
- Namespace is automatically extracted from the active context

### Cluster Terminal
- Each connection opens an isolated VS Code terminal with `KUBECONFIG` set to a temporary file
- Open terminals are tracked — clicking a running cluster focuses the existing terminal instead of opening a new one
- Shell configurable per connection: Default, bash, zsh, PowerShell, cmd

### Quick Switch (`Ctrl+Shift+K` / `Cmd+Shift+K`)
- Opens a quick-pick list of all saved connections
- Shows whether a terminal is already open
- Opens a new terminal or focuses the existing one

### Groups
- Assign connections to a group (e.g. "Production", "Staging")
- Groups appear as collapsible folders in the CLUSTERS panel

### Security
- All kubeconfig data is stored in VS Code's encrypted `SecretStorage` (local, never synced to cloud)
- Optional password lock: prompt for a password when the extension opens
- Exports are always AES-256-GCM encrypted with a user-chosen password (PBKDF2, 200,000 iterations)
- Temporary kubeconfig files are written with mode `0600` and deleted when the terminal closes

### Import / Export
- Export: save all connections as an encrypted JSON file
- Import: import encrypted or plain JSON files
- On import, existing connections (same ID) are updated; new ones are added

## First Start

A setup wizard appears on first launch:
1. Optionally import existing connections from an export file
2. Optionally enable password protection

The CLUSTERS panel is hidden during setup and appears once setup is complete.

## Settings Menu (⚙)

| Action | Description |
|---|---|
| Export (encrypted) | Export all connections as an encrypted JSON file |
| Import | Import connections from a file |
| Enable password lock | Prompt for a password on open |
| Change password | Replace the current password |
| Disable password lock | Remove the lock |
| Lock now | Lock immediately (only when lock is active) |
| Show debug logs | Open the Output panel with extension logs |
| Reset application | Delete everything (double confirmation required) |

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+K` / `Cmd+Shift+K` | Quick Switch — open or focus a cluster terminal |

## Debugging & Logging

Logs are written to the VS Code Output panel under **"Kubectl Control"**.

Open via:
- Settings menu → **Show debug logs**
- Command palette (`Ctrl+Shift+P`) → `Kubectl Control: Show Debug Logs`

Logs include timestamps, level (`INFO`, `WARN`, `ERROR`) and full stack traces for errors.

## Data Storage

| What | Where |
|---|---|
| Cluster connections (kubeconfig) | VS Code `SecretStorage` (local, encrypted) |
| Temporary kubeconfig files | `os.tmpdir()/kubectl-control-ext/kubeconfig-<id>.yaml` (deleted on terminal close) |
| Setup state | VS Code `globalState` |
| Password hash + salt | VS Code `SecretStorage` |

## Technical Details

- **Encryption:** AES-256-GCM via Node.js `node:crypto`
- **Key derivation:** PBKDF2-SHA256, 200,000 iterations, random salt per export
- **Password verification:** `crypto.timingSafeEqual` to prevent timing attacks
- **Storage:** VS Code `SecretStorage` (OS keychain / encrypted local storage)
- **Bundle:** Webpack — no external runtime dependencies except `uuid`

## Requirements

- VS Code 1.80.0 or later
- `kubectl` must be available in `PATH` (used by the opened terminals)

## License

MIT — see [LICENSE](LICENSE)
