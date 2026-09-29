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
- **Multiple terminals per cluster:** the `+` button on a cluster row opens an additional terminal (numbered, e.g. "☸ prod (2)"); **Close All Terminals** in the context menu closes them at once
- Shell configurable per connection: Default, bash, zsh, PowerShell, cmd
- Optional prompt `kubectl@<connection-name> >` with a per-connection color (setting `kubectl-control.customTerminalPrompt`)
- Production connections ask for confirmation before a terminal opens and print a warning in it

### Cluster Tree
- **Status indicator** per cluster: 🟢 reachable, 🔴 unreachable, 🟡 token expired / not authenticated, 🛡️ credential plugin not approved yet (see [Security](#security)); checked on startup and every 60 s while the window is focused, at most 3 clusters at a time (`kubectl-control.statusCheckIntervalSeconds`, `0` = off)
- **Credential expiry warning**: ⏳`N`d next to a connection whose client certificate or JWT token expires within 14 days, ⛔ once it has expired (date in the tooltip). Read locally from the kubeconfig — no cluster access needed
- **Pin** frequently used clusters to the top, **mark production** environments (🔴)
- **Filter** the tree by name, namespace or group (search icon in the view title)

### Cluster Tools (context menu of a cluster)
- **List Pods / List Deployments** for a namespace picked from the cluster's live namespaces, or for **all namespaces**; pods show restarts and age. Per pod, **📋 Logs** streams `kubectl logs -f` and **⌨ Shell** opens `kubectl exec -it … -- sh` in a terminal (container picker for multi-container pods; shells on production clusters ask for confirmation)
- **Port Forward** to `svc/…`, `pod/…` or `deploy/…`; running forwards can be stopped individually or all at once from the Command Palette
- **Helm Releases** and **Helm History** (requires `helm` in `PATH`)
- **Permissions (RBAC):** `kubectl auth can-i --list` for a namespace, or check a single verb/resource
- **Switch Namespace** (Command Palette or Settings menu) — lists live namespaces and applies the switch to every open terminal of that cluster

### Quick Switch (`Ctrl+Shift+K` / `Cmd+Shift+K`)
- Opens a quick-pick list of all saved connections
- Shows whether a terminal is already open
- Opens a new terminal or focuses the existing one

### Groups
- Assign connections to a group (e.g. "Production", "Staging")
- Groups appear as collapsible folders in the CLUSTERS panel

### Security
- All kubeconfig data is stored in VS Code's encrypted `SecretStorage` (local; only leaves the machine encrypted, via export or GitHub Sync)
- Optional password lock: prompt for a password when the extension opens, plus **auto-lock** after inactivity (`kubectl-control.autoLockMinutes`). While locked, every action is blocked and background status checks pause; repeated wrong passwords trigger a growing lockout
- **Credential plugins need your approval:** a kubeconfig with `users[].user.exec` or an `auth-provider` (e.g. `aws eks get-token`, `gke-gcloud-auth-plugin`, `kubelogin`) makes kubectl run a program on your machine. The extension shows the exact command and asks once before first use; approvals are stored per machine, never exported or synced, and asked again if the command changes. Contexts imported from your own `~/.kube/config` count as approved. Review, approve or revoke approvals via Settings menu (⚙) ▸ *Credential Plugin Approvals*
- New passwords (lock, export, sync) need at least **12 characters**
- Exports are always AES-256-GCM encrypted with a user-chosen password (PBKDF2, 200,000 iterations)
- Temporary kubeconfig files are written with mode `0600` (directory `0700`) and deleted when the terminal closes

### Import / Export
- Export: save all connections as an encrypted JSON file
- Import: import encrypted or plain JSON files
- **Import from `~/.kube/config`:** one connection per context, each with only its own cluster and user entries
- On import, existing connections (same ID) are updated; new ones are added

### GitHub Sync
- Keeps connections in sync across devices via a **secret GitHub Gist**, encrypted (AES-256-GCM) with a sync password of your choice before upload
- Syncs automatically after every change; **Sync Now**, **Restore from GitHub** and **Disable** are available in the Settings menu and Command Palette
- Signs in with VS Code's built-in GitHub authentication (scope `gist`)

## First Start

A setup wizard appears on first launch:
1. Optionally import the contexts from your `~/.kube/config`
2. Optionally import existing connections from an export file
3. Optionally enable password protection
4. A short tutorial

The CLUSTERS panel is hidden during setup and appears once setup is complete.

## Settings Menu (⚙)

| Action | Description |
|---|---|
| Export (encrypted) | Export all connections as an encrypted JSON file |
| Import | Import connections from a file |
| Import from ~/.kube/config | Import local kubectl contexts |
| GitHub Sync | Set up, sync now, restore from GitHub, disable |
| Switch Namespace | Change the namespace of a cluster |
| Credential Plugin Approvals | Review, approve or revoke the exec/auth-provider commands of your connections |
| Open Settings | VS Code settings of the extension (see [Settings](#settings)) |
| Language | Cycles the UI language: Auto → English → German → Auto (see [Language](#language) below) |
| Enable password lock | Prompt for a password on open |
| Change password | Replace the current password |
| Disable password lock | Remove the lock |
| Lock now | Lock immediately (only when lock is active) |
| Show debug logs | Open the Output panel with extension logs |
| Reset application | Delete everything (double confirmation required) |

## Language

The extension UI is available in English and German.

- **Runtime UI** (messages, quick picks, prompts, the setup/lock/connection-form screens)
  follows the `kubectl-control.language` setting (`auto` / `en` / `de`, default `auto`).
  `auto` follows VS Code's own display language. Change it either via **Settings menu (⚙)
  → Language** (cycles through the three values) or in VS Code Settings
  (`Ctrl+,` → search "Kubectl Control"). A change takes full effect after **Reload Window**
  (the extension prompts for this automatically).
- **Command Palette entries and settings descriptions** always follow VS Code's own display
  language (**File → Preferences → Configure Display Language**) — this is a VS Code platform
  behavior resolved before the extension runs, so it is not affected by the
  `kubectl-control.language` setting above.

## Settings

| Setting | Default | Description |
|---|---|---|
| `kubectl-control.autoLockMinutes` | `0` | Minutes of inactivity until the extension locks (`0` = off) |
| `kubectl-control.statusCheckIntervalSeconds` | `60` | Interval of the automatic cluster status check (`0` = off) |
| `kubectl-control.customTerminalPrompt` | `true` | `kubectl@<connection-name> >` prompt in terminals |
| `kubectl-control.language` | `auto` | UI language: `auto`, `en`, `de` |

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
| Temporary kubeconfig files | `os.tmpdir()/kubectl-control-ext-<os-user>/` (deleted when the terminal or command ends) |
| Setup state, Gist ID | VS Code `globalState` |
| Password hash + salt, sync password | VS Code `SecretStorage` |
| Synced connections (optional) | Secret GitHub Gist, encrypted with the sync password |

## Technical Details

- **Encryption:** AES-256-GCM via Node.js `node:crypto`
- **Key derivation:** PBKDF2-SHA256, 200,000 iterations, random salt per export
- **Password verification:** `crypto.timingSafeEqual` to prevent timing attacks
- **Storage:** VS Code `SecretStorage` (OS keychain / encrypted local storage)
- **Bundle:** Webpack — runtime dependencies `js-yaml` and `uuid` only
- **Process calls:** kubectl/helm are always started with an argument array (no shell); user input is validated first

## Requirements

- VS Code 1.125.0 or later
- `kubectl` must be available in `PATH`
- `helm` in `PATH` for the Helm views (optional)
- Credential plugins your kubeconfigs use (e.g. `aws`, `gke-gcloud-auth-plugin`, `kubelogin`) must be installed as for plain kubectl

## License

MIT — see [LICENSE](LICENSE)
