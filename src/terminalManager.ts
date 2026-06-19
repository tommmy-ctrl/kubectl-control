import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ClusterProfile, ShellType } from './store';
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
        if (!await this.isKubectlAvailable()) {
            const { openAnyway } = await this.showKubectlMissingWarning();
            if (!openAnyway) { return; }
        }
        await this.openNew(profile);
    }

    private async isKubectlAvailable(): Promise<boolean> {
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);
        try {
            await execAsync('kubectl version --client --output=json');
            return true;
        } catch (e: unknown) {
            // Exit code 1 with output still means kubectl exists but cannot reach server — that's fine
            const err = e as { stdout?: string; stderr?: string };
            if (err.stdout?.includes('clientVersion') || err.stderr?.includes('clientVersion')) {
                return true;
            }
            log.warn('kubectl not found in PATH', e);
            return false;
        }
    }

    private async showKubectlMissingWarning(): Promise<{ openAnyway: boolean }> {
        log.warn('kubectl not found in PATH — showing install prompt');
        const choice = await vscode.window.showWarningMessage(
            'kubectl was not found in PATH. Install it to use this terminal.',
            'Install kubectl',
            'Open anyway',
        );
        if (choice === 'Install kubectl') {
            void vscode.env.openExternal(vscode.Uri.parse('https://kubernetes.io/docs/tasks/tools/'));
        }
        return { openAnyway: choice === 'Open anyway' };
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

            const shellPath = profile.shell ? resolveShellPath(profile.shell) : undefined;

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
