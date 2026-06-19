import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ClusterProfile, ShellType } from './store';
import { log } from './logger';

const SHELL_PATHS: Record<ShellType, string | undefined> = {
    default:    undefined,
    bash:       process.platform === 'win32' ? String.raw`C:\Program Files\Git\bin\bash.exe` : '/bin/bash',
    zsh:        '/bin/zsh',
    powershell: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    cmd:        'cmd.exe',
};

export class TerminalManager implements vscode.Disposable {
    private readonly openTerminals = new Map<string, vscode.Terminal>();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

    constructor() {
        vscode.window.onDidCloseTerminal(terminal => {
            for (const [id, t] of this.openTerminals) {
                if (t === terminal) {
                    this.openTerminals.delete(id);
                    log.info(`Terminal closed for cluster id=${id}`);
                    this._onDidChange.fire();
                    void this.deleteTempFile(id);
                    break;
                }
            }
        });
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

    /** Focus existing terminal or open a new one. */
    async openOrFocus(profile: ClusterProfile): Promise<void> {
        const existing = this.openTerminals.get(profile.id);
        if (existing) {
            log.info(`Focusing existing terminal for "${profile.name}"`);
            existing.show();
            return;
        }
        await this.openNew(profile);
    }

    private tempFilePath(clusterId: string): string {
        return path.join(os.tmpdir(), 'kubectl-control-ext', `kubeconfig-${clusterId}.yaml`);
    }

    private async openNew(profile: ClusterProfile): Promise<void> {
        try {
            const tempDir = path.join(os.tmpdir(), 'kubectl-control-ext');
            await fs.mkdir(tempDir, { recursive: true });

            const kubeconfigPath = this.tempFilePath(profile.id);
            await fs.writeFile(kubeconfigPath, profile.kubeconfigData, { encoding: 'utf-8', mode: 0o600 });

            const shellPath = profile.shell ? SHELL_PATHS[profile.shell] : undefined;

            const terminal = vscode.window.createTerminal({
                name: `☸ ${profile.name}`,
                shellPath,
                env: {
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    KUBECONFIG: kubeconfigPath,
                },
            });

            // If a specific context is selected, set it automatically
            if (profile.activeContext) {
                terminal.sendText(`kubectl config use-context ${profile.activeContext}`);
            }

            this.openTerminals.set(profile.id, terminal);
            terminal.show();
            this._onDidChange.fire();
            log.info(`Terminal opened for "${profile.name}" (shell=${profile.shell ?? 'default'})`);
        } catch (e) {
            log.error(`Failed to open terminal for "${profile.name}"`, e);
            vscode.window.showErrorMessage(`Terminal konnte nicht geöffnet werden: ${e}`);
        }
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
