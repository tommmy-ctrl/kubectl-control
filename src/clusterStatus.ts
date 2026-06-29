import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { TerminalManager } from './terminalManager';
import { log } from './logger';
import { execWithKubeconfig } from './kubectlExec';

export type ClusterStatus = 'reachable' | 'unreachable' | 'unknown';

/** After this many consecutive unreachable checks, backoff kicks in. */
const BACKOFF_THRESHOLD = 3;
/** Maximum backoff multiplier (caps at ~10x normal interval). */
const MAX_BACKOFF_MULTIPLIER = 10;

export class ClusterStatusService implements vscode.Disposable {
    private readonly _statuses = new Map<string, ClusterStatus>();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    private _timer?: ReturnType<typeof setInterval>;

    // BUG FIX: in-flight guard to prevent concurrent checks for the same cluster
    private readonly _inFlight = new Set<string>();

    // Per-cluster backoff state
    /** Number of consecutive unreachable checks per cluster id. */
    private readonly _consecutiveFailures = new Map<string, number>();
    /** How many poll ticks have elapsed (used to compute backoff skips). */
    private _tickCount = 0;

    constructor(
        private readonly store: ClusterStore,
        private readonly terminalManager: TerminalManager,
    ) {
        const intervalSeconds = this._readIntervalSetting();

        // Always do an immediate check on startup
        this.checkAll().catch(() => undefined);

        if (intervalSeconds > 0) {
            this._timer = setInterval(() => {
                this._tickCount++;
                this.checkAll().catch(() => undefined);
            }, intervalSeconds * 1000);
        }

        // Re-apply interval if the setting changes at runtime
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('kubectl-control.statusCheckIntervalSeconds')) {
                this._restartTimer();
            }
        });
    }

    private _readIntervalSetting(): number {
        const cfg = vscode.workspace.getConfiguration('kubectl-control');
        const raw = cfg.get<number>('statusCheckIntervalSeconds', 60);
        return Math.max(0, raw);
    }

    private _restartTimer(): void {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
        this._tickCount = 0;

        const intervalSeconds = this._readIntervalSetting();
        if (intervalSeconds > 0) {
            this._timer = setInterval(() => {
                this._tickCount++;
                this.checkAll().catch(() => undefined);
            }, intervalSeconds * 1000);
        }
    }

    getStatus(clusterId: string): ClusterStatus {
        return this._statuses.get(clusterId) ?? 'unknown';
    }

    async checkAll(): Promise<void> {
        const clusters = await this.store.getClusters();
        await Promise.all(clusters.map(c => this._maybeCheckOne(c.id, c.kubeconfigData, c.activeContext)));
    }

    /**
     * Apply per-cluster exponential backoff: clusters with many consecutive
     * failures are skipped on most ticks to reduce noise and network load.
     */
    private _shouldSkipForBackoff(id: string): boolean {
        const failures = this._consecutiveFailures.get(id) ?? 0;
        if (failures < BACKOFF_THRESHOLD) {
            return false;
        }
        // Multiplier grows with failures, capped at MAX_BACKOFF_MULTIPLIER
        const multiplier = Math.min(failures - BACKOFF_THRESHOLD + 2, MAX_BACKOFF_MULTIPLIER);
        // Skip unless this tick falls on a multiple of the multiplier
        return this._tickCount % multiplier !== 0;
    }

    private async _maybeCheckOne(id: string, kubeconfigData: string, context?: string): Promise<void> {
        if (this._shouldSkipForBackoff(id)) {
            return;
        }
        return this.checkOne(id, kubeconfigData, context);
    }

    private async checkOne(id: string, kubeconfigData: string, context?: string): Promise<void> {
        // BUG FIX: skip if a check for this cluster is already running
        if (this._inFlight.has(id)) {
            return;
        }
        this._inFlight.add(id);

        try {
            await execWithKubeconfig(
                kubeconfigData,
                context,
                ['cluster-info', '--request-timeout=3s'],
                5000,
            );
            this._statuses.set(id, 'reachable');
            // Reset failure counter on success
            this._consecutiveFailures.set(id, 0);
        } catch (err) {
            // execWithKubeconfig throws on invalid context — treat as unreachable
            this._statuses.set(id, 'unreachable');
            const prev = this._consecutiveFailures.get(id) ?? 0;
            this._consecutiveFailures.set(id, prev + 1);
            log.warn(`Cluster ${id} unreachable (consecutive failures: ${prev + 1})`, err);
        } finally {
            this._inFlight.delete(id);
            this._onDidChange.fire();
        }
    }

    dispose(): void {
        if (this._timer) { clearInterval(this._timer); }
        this._onDidChange.dispose();
    }
}
