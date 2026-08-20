import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { TerminalManager } from './terminalManager';
import { log } from './logger';
import { execWithKubeconfig } from './kubectlExec';
import { t } from './i18n';

export type ClusterStatus = 'reachable' | 'unreachable' | 'unauthorized' | 'unknown';

/** After this many consecutive unreachable checks, backoff kicks in. */
const BACKOFF_THRESHOLD = 3;
/** Maximum backoff multiplier (caps at ~10x normal interval). */
const MAX_BACKOFF_MULTIPLIER = 10;

/**
 * Classify an error text from a failed kubectl call.
 *
 * @returns
 *   - `'unauthorized'`        – token expired / not authenticated
 *   - `'retry-with-clusterinfo'` – `auth whoami` not supported by this cluster/kubectl version
 *   - `'unreachable'`         – network, TLS, timeout, or other connectivity problem
 */
function classifyError(text: string): 'unauthorized' | 'unreachable' | 'retry-with-clusterinfo' {
    const lower = text.toLowerCase();

    // Auth / token problems
    if (
        lower.includes('unauthenticated') ||
        lower.includes('unauthorized') ||
        lower.includes('you must be logged in') ||
        lower.includes('anonymous')
    ) {
        return 'unauthorized';
    }

    // `kubectl auth whoami` not available (older kubectl or cluster without SelfSubjectReview)
    if (
        lower.includes('unknown command') ||
        lower.includes('unknown flag') ||
        lower.includes("doesn't have a resource type") ||
        lower.includes('selfsubjectreview') ||
        lower.includes('the server could not find the requested resource') ||
        lower.includes('error: unknown')
    ) {
        return 'retry-with-clusterinfo';
    }

    // Everything else (network, x509, timeout, DNS, connection refused, …)
    return 'unreachable';
}

/** Combine all text fields that execFile errors may carry. */
function errorText(err: unknown): string {
    if (err instanceof Error) {
        const e = err as Error & { stderr?: string; stdout?: string };
        return [e.message, e.stderr ?? '', e.stdout ?? ''].join('\n');
    }
    return String(err);
}

export class ClusterStatusService implements vscode.Disposable {
    private readonly _statuses = new Map<string, ClusterStatus>();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    private _timer?: ReturnType<typeof setInterval>;

    // BUG FIX: in-flight guard to prevent concurrent checks for the same cluster
    private readonly _inFlight = new Set<string>();

    // Per-cluster backoff state
    /** Number of consecutive unreachable/unauthorized checks per cluster id. */
    private readonly _consecutiveFailures = new Map<string, number>();
    /** How many poll ticks have elapsed (used to compute backoff skips). */
    private _tickCount = 0;

    /**
     * Tracks cluster ids for which an "unauthorized" warning has already been shown.
     * Cleared when the cluster becomes reachable again so the next outage re-notifies.
     */
    private readonly _authNotified = new Set<string>();

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
        await Promise.all(clusters.map(c => this._maybeCheckOne(c.id, c.kubeconfigData, c.activeContext, c.name ?? c.id)));
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

    private async _maybeCheckOne(id: string, kubeconfigData: string, context?: string, name?: string): Promise<void> {
        if (this._shouldSkipForBackoff(id)) {
            return;
        }
        return this.checkOne(id, kubeconfigData, context, name ?? id);
    }

    private async checkOne(id: string, kubeconfigData: string, context?: string, name: string = id): Promise<void> {
        // BUG FIX: skip if a check for this cluster is already running
        if (this._inFlight.has(id)) {
            return;
        }
        this._inFlight.add(id);

        try {
            const newStatus = await this._determineStatus(id, kubeconfigData, context, name);
            const prevStatus = this._statuses.get(id);

            this._statuses.set(id, newStatus);

            if (newStatus === 'reachable') {
                this._consecutiveFailures.set(id, 0);
                // Allow re-notification on next unauthorized event
                this._authNotified.delete(id);
            } else {
                const prev = this._consecutiveFailures.get(id) ?? 0;
                this._consecutiveFailures.set(id, prev + 1);
                log.warn(`Cluster ${id} status: ${newStatus} (consecutive failures: ${prev + 1})`);

                // Notify once when a cluster newly becomes unauthorized
                if (newStatus === 'unauthorized' && prevStatus !== 'unauthorized' && !this._authNotified.has(id)) {
                    this._authNotified.add(id);
                    this._notifyUnauthorized(name);
                }
            }
        } finally {
            this._inFlight.delete(id);
            this._onDidChange.fire();
        }
    }

    /**
     * Run `kubectl auth whoami` with a fallback to `kubectl cluster-info`.
     * Returns the resolved ClusterStatus without touching instance state.
     */
    private async _determineStatus(
        id: string,
        kubeconfigData: string,
        context: string | undefined,
        name: string,
    ): Promise<ClusterStatus> {
        // Primary: auth-validating check
        try {
            await execWithKubeconfig(
                kubeconfigData,
                context,
                ['auth', 'whoami', '-o', 'json', '--request-timeout=3s'],
                5000,
            );
            return 'reachable';
        } catch (whoamiErr) {
            const classification = classifyError(errorText(whoamiErr));

            if (classification === 'unauthorized') {
                return 'unauthorized';
            }

            if (classification === 'retry-with-clusterinfo') {
                // Fallback: cluster may not support SelfSubjectReview — use classic check
                try {
                    await execWithKubeconfig(
                        kubeconfigData,
                        context,
                        ['cluster-info', '--request-timeout=3s'],
                        5000,
                    );
                    return 'reachable';
                } catch (clusterInfoErr) {
                    const fallbackClassification = classifyError(errorText(clusterInfoErr));
                    if (fallbackClassification === 'unauthorized') {
                        return 'unauthorized';
                    }
                    return 'unreachable';
                }
            }

            // classification === 'unreachable'
            return 'unreachable';
        }
    }

    /** Show a one-time warning notification when a cluster's token has expired. */
    private _notifyUnauthorized(name: string): void {
        const msg = t(
            'Connection "{0}": token expired or invalid (not authenticated). Please re-import the kubeconfig.',
            name,
        );
        const openBtn = t('Open connections');

        vscode.window.showWarningMessage(msg, openBtn).then(selection => {
            if (selection === openBtn) {
                vscode.commands.executeCommand('kubectl-control.connectionsView.focus');
            }
        });
    }

    dispose(): void {
        if (this._timer) { clearInterval(this._timer); }
        this._onDidChange.dispose();
    }
}
