import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { TerminalManager } from './terminalManager';
import { log } from './logger';

export type ClusterStatus = 'reachable' | 'unreachable' | 'unknown';

export class ClusterStatusService implements vscode.Disposable {
    private readonly _statuses = new Map<string, ClusterStatus>();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    private _timer?: ReturnType<typeof setInterval>;

    constructor(
        private readonly store: ClusterStore,
        private readonly terminalManager: TerminalManager,
    ) {
        // Check on startup and every 60s
        this.checkAll().catch(() => undefined);
        this._timer = setInterval(() => { this.checkAll().catch(() => undefined); }, 60_000);
    }

    getStatus(clusterId: string): ClusterStatus {
        return this._statuses.get(clusterId) ?? 'unknown';
    }

    async checkAll(): Promise<void> {
        const clusters = await this.store.getClusters();
        await Promise.all(clusters.map(c => this.checkOne(c.id, c.kubeconfigData, c.activeContext)));
    }

    private async checkOne(id: string, kubeconfigData: string, context?: string): Promise<void> {
        const os = await import('node:os');
        const path = await import('node:path');
        const fs = await import('node:fs/promises');
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);

        const tempDir = path.join(os.tmpdir(), 'kubectl-control-status');
        const tempFile = path.join(tempDir, `status-${id}.yaml`);

        try {
            await fs.mkdir(tempDir, { recursive: true });
            await fs.writeFile(tempFile, kubeconfigData, { encoding: 'utf-8', mode: 0o600 });
            const contextArg = context ? `--context=${context}` : '';
            await execAsync(
                `kubectl ${contextArg} cluster-info --request-timeout=3s`,
                { env: { ...process.env, KUBECONFIG: tempFile }, timeout: 5000 },
            );
            this._statuses.set(id, 'reachable');
        } catch {
            this._statuses.set(id, 'unreachable');
        } finally {
            await fs.unlink(tempFile).catch(() => undefined);
            this._onDidChange.fire();
        }
    }

    dispose(): void {
        if (this._timer) { clearInterval(this._timer); }
        this._onDidChange.dispose();
    }
}
