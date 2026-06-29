import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ClusterProfile, ClusterStore, ShellType } from './store';
import { log } from './logger';

// On Windows, prefer Git Bash if present; fall back to undefined (VS Code default shell) so the terminal still opens.
function resolveShellPath(shell: ShellType): string | undefined {
    if (shell === 'default') { return undefined; }
    if (shell === 'bash' && process.platform === 'win32') {
        const gitBash = String.raw`C:\Program Files\Git\bin\bash.exe`;
        try {
            require('node:fs').accessSync(gitBash);
            return gitBash;
        } catch {
            return undefined; // Git Bash not found — use VS Code default
        }
    }
    const paths: Record<ShellType, string | undefined> = {
        default:    undefined,
        bash:       '/bin/bash',
        zsh:        '/bin/zsh',
        powershell: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
        cmd:        'cmd.exe',
    };
    return paths[shell];
}

/** Allows only safe Kubernetes context name characters (RFC 1123 + slashes for namespaced names). */
function isSafeContextName(name: string): boolean {
    return /^[a-zA-Z0-9._/@:-]{1,253}$/.test(name);
}

export class TerminalManager implements vscode.Disposable {
    private readonly openTerminals = new Map<string, vscode.Terminal>();
    private readonly terminalOpenedAt = new Map<string, number>();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange: vscode.Event<void> = this._onDidChange.event;
    private _kubectlAvailable?: boolean;
    private _activeClusterId?: string;
    private readonly _onActiveChange = new vscode.EventEmitter<string | undefined>();
    readonly onActiveChange: vscode.Event<string | undefined> = this._onActiveChange.event;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(private readonly store: ClusterStore) {

        this._disposables.push(vscode.window.onDidCloseTerminal(terminal => {
            for (const [id, t] of this.openTerminals) {
                if (t === terminal) {
                    const openedAt = this.terminalOpenedAt.get(id);
                    this.openTerminals.delete(id);
                    this.terminalOpenedAt.delete(id);
                    log.info(`Terminal closed for cluster id=${id}`);
                    this._onDidChange.fire();
                    void this.deleteTempFile(id);

                    if (id === this._activeClusterId) {
                        this._activeClusterId = undefined;
                        this._onActiveChange.fire(undefined);
                    }

                    if (process.platform === 'win32' && openedAt && Date.now() - openedAt < 3000) {
                        void this.showConptyError();
                    }
                    break;
                }
            }
        }));
    }

    private async showConptyError(): Promise<void> {
        log.warn('Terminal closed immediately after launch — possible ConPTY error on Windows');
        const btnEinstellungAktivieren = vscode.l10n.t('Einstellung aktivieren');
        const btnHilfeAnzeigen = vscode.l10n.t('Hilfe anzeigen');
        const choice = await vscode.window.showErrorMessage(
            vscode.l10n.t('Das Terminal konnte nicht gestartet werden. Auf Windows kann dies an einem ConPTY-Problem liegen.'),
            btnEinstellungAktivieren,
            btnHilfeAnzeigen,
        );
        if (choice === btnEinstellungAktivieren) {
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'terminal.integrated.windowsUseConptyDll',
            );
        } else if (choice === btnHilfeAnzeigen) {
            void vscode.env.openExternal(
                vscode.Uri.parse('https://code.visualstudio.com/updates/v1_109#_removal-of-winpty-support'),
            );
        }
    }

    private async deleteTempFile(clusterId: string): Promise<void> {
        const filePath = this.tempFilePath(clusterId);
        try {
            await fs.unlink(filePath);
            log.info(`Temp kubeconfig deleted: ${filePath}`);
        } catch {
            // File may not exist — not an error
        }
    }

    isOpen(clusterId: string): boolean {
        return this.openTerminals.has(clusterId);
    }

    getOpenClusterIds(): string[] {
        return [...this.openTerminals.keys()];
    }

    sendToTerminal(clusterId: string, text: string): void {
        const terminal = this.openTerminals.get(clusterId);
        if (terminal) {
            terminal.sendText(text);
        }
    }

    getActiveClusterId(): string | undefined {
        return this._activeClusterId;
    }

    /** Focus existing terminal or open a new one. */
    async openOrFocus(profile: ClusterProfile): Promise<void> {
        const existing = this.openTerminals.get(profile.id);
        if (existing) {
            log.info(`Focusing existing terminal for "${profile.name}"`);
            existing.show();
            this._activeClusterId = profile.id;
            this._onActiveChange.fire(profile.id);
            await this.store.updateCluster(profile.id, { lastUsed: Date.now() });
            return;
        }
        if (!await this.isKubectlAvailable()) {
            const { openAnyway } = await this.showKubectlMissingWarning();
            if (!openAnyway) { return; }
        }
        if (profile.isProd) {
            const btnOeffnen = vscode.l10n.t('Öffnen');
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t('⚠️ "{0}" ist eine Produktionsumgebung. Terminal wirklich öffnen?', profile.name),
                { modal: true },
                btnOeffnen,
            );
            if (confirm !== btnOeffnen) { return; }
        }
        await this.openNew(profile);
        this._activeClusterId = profile.id;
        this._onActiveChange.fire(profile.id);
        await this.store.updateCluster(profile.id, { lastUsed: Date.now() });
    }

    private async isKubectlAvailable(): Promise<boolean> {
        // Return cached positive result — skip the subprocess on every subsequent terminal open.
        // We still re-check if the previous result was false/undefined.
        if (this._kubectlAvailable === true) {
            return true;
        }
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);
        try {
            await execAsync('kubectl version --client --output=json');
            this._kubectlAvailable = true;
            return true;
        } catch (e: unknown) {
            // Exit code 1 with output still means kubectl exists but cannot reach server — that's fine
            const err = e as { stdout?: string; stderr?: string };
            if (err.stdout?.includes('clientVersion') || err.stderr?.includes('clientVersion')) {
                this._kubectlAvailable = true;
                return true;
            }
            log.warn('kubectl not found in PATH', e);
            this._kubectlAvailable = false;
            return false;
        }
    }

    private async showKubectlMissingWarning(): Promise<{ openAnyway: boolean }> {
        log.warn('kubectl not found in PATH — showing install prompt');
        const btnInstallieren = vscode.l10n.t('kubectl installieren');
        const btnTrotzdemOeffnen = vscode.l10n.t('Trotzdem öffnen');
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t('kubectl wurde nicht in PATH gefunden. Bitte installieren, um Terminals zu nutzen.'),
            btnInstallieren,
            btnTrotzdemOeffnen,
        );
        if (choice === btnInstallieren) {
            void vscode.env.openExternal(vscode.Uri.parse('https://kubernetes.io/docs/tasks/tools/'));
        }
        return { openAnyway: choice === btnTrotzdemOeffnen };
    }

    private tempFilePath(clusterId: string): string {
        return path.join(os.tmpdir(), 'kubectl-control-ext', `kubeconfig-${clusterId}.yaml`);
    }

    private async openNew(profile: ClusterProfile): Promise<void> {
        try {
            const tempDir = path.join(os.tmpdir(), 'kubectl-control-ext');
            await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });

            const kubeconfigPath = this.tempFilePath(profile.id);
            await fs.writeFile(kubeconfigPath, profile.kubeconfigData, { encoding: 'utf-8', mode: 0o600 });

            const shellPath = profile.shell ? resolveShellPath(profile.shell) : undefined;

            const terminal = vscode.window.createTerminal({
                name: `☸ ${profile.name}`,
                shellPath,
                env: {
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    KUBECONFIG: kubeconfigPath,
                },
            });

            if (profile.isProd === true) {
                terminal.sendText(`echo "${vscode.l10n.t('⚠️  ACHTUNG: Dies ist eine PRODUKTIONSUMGEBUNG ({0}). Änderungen wirken sich direkt aus.', profile.name)}"`);
            }

            // If a specific context is selected, set it automatically.
            // Validate the name first — it originates from imported kubeconfig data
            // and must not be allowed to inject extra shell commands into the terminal.
            if (profile.activeContext) {
                if (isSafeContextName(profile.activeContext)) {
                    terminal.sendText(`kubectl config use-context ${profile.activeContext}`);
                } else {
                    log.warn(`Skipping auto use-context: unsafe context name "${profile.activeContext}"`);
                    vscode.window.showWarningMessage(
                        vscode.l10n.t('Context "{0}" enthält ungültige Zeichen und wurde nicht automatisch gesetzt.', profile.activeContext),
                    );
                }
            }

            this.openTerminals.set(profile.id, terminal);
            this.terminalOpenedAt.set(profile.id, Date.now());
            terminal.show();
            this._onDidChange.fire();
            log.info(`Terminal opened for "${profile.name}" (shell=${profile.shell ?? 'default'})`);
        } catch (e) {
            log.error(`Failed to open terminal for "${profile.name}"`, e);
            vscode.window.showErrorMessage(vscode.l10n.t('Terminal konnte nicht geöffnet werden: {0}', String(e)));
        }
    }

    async cleanupOrphanedTempFiles(): Promise<void> {
        const tempDir = path.join(os.tmpdir(), 'kubectl-control-ext');
        try {
            const entries = await fs.readdir(tempDir);
            await Promise.all(
                entries
                    .filter(f => f.startsWith('kubeconfig-') && f.endsWith('.yaml'))
                    .map(f => fs.unlink(path.join(tempDir, f)).catch(() => undefined)),
            );
            if (entries.length > 0) {
                log.info(`Cleaned up ${entries.length} orphaned temp kubeconfig file(s)`);
            }
        } catch {
            // Directory doesn't exist yet — nothing to clean
        }
    }

    dispose(): void {
        // Remove any temp files for currently open terminals on shutdown
        for (const id of this.openTerminals.keys()) {
            fs.unlink(this.tempFilePath(id)).catch(() => undefined);
        }
        this._onDidChange.dispose();
        this._onActiveChange.dispose();
        for (const d of this._disposables) { d.dispose(); }
    }
}
