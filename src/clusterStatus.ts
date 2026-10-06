import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { TerminalManager } from './terminalManager';
import { log } from './logger';
import { execWithKubeconfig } from './kubectlExec';
import { t } from './i18n';
import { isKubeconfigAllowed } from './execTrust';

export type ClusterStatus = 'reachable' | 'unreachable' | 'unauthorized' | 'untrusted' | 'unknown';

/** After this many consecutive unreachable checks, backoff kicks in. */
const BACKOFF_THRESHOLD = 3;
/** Maximum backoff multiplier (caps at ~10x normal interval). */
const MAX_BACKOFF_MULTIPLIER = 10;
/**
 * At most this many clusters are checked at the same time. Each check starts
 * kubectl and, for EKS/GKE/AKS, a credential plugin (aws, gke-gcloud-auth-plugin,
 * kubelogin …); starting all of them at once caused load spikes on small remote
 * hosts that were enough to drop VS Code Remote-SSH connections.
 */
const MAX_PARALLEL_CHECKS = 3;

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next++];
            await worker(item).catch(() => undefined);
        }
    });
    await Promise.all(lanes);
}

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

    private readonly _storeSub: vscode.Disposable;
    private readonly _configSub: vscode.Disposable;
    private readonly _windowSub: vscode.Disposable;

    /** The running checkAll() round, if any — a new tick never starts a second one. */
    private _round?: Promise<void>;
    /** When the last full round finished (ms since epoch); 0 = never. */
    private _lastRoundAt = 0;
    /** Clusters whose API server does not support `auth whoami` — go straight to cluster-info. */
    private readonly _useClusterInfo = new Set<string>();
    /** Persisted so a window reload / SSH reconnect does not spawn the failing `auth whoami` again. */
    private static readonly USE_CLUSTER_INFO_KEY = 'kubectl-control.useClusterInfo';

    private _initialTimer?: ReturnType<typeof setTimeout>;
    private _fireTimer?: ReturnType<typeof setTimeout>;

    /**
     * @param isLocked SECURITY: background checks run kubectl (and with it any
     *        credential plugin) without user interaction, so they are skipped
     *        entirely while the extension is locked.
     */
    constructor(
        private readonly store: ClusterStore,
        private readonly terminalManager: TerminalManager,
        private readonly isLocked: () => Promise<boolean> = async () => false,
        private readonly globalState?: vscode.Memento,
    ) {
        for (const id of globalState?.get<string[]>(ClusterStatusService.USE_CLUSTER_INFO_KEY, []) ?? []) {
            this._useClusterInfo.add(id);
        }
        // Startup check: delayed with jitter and only for the focused window. Several
        // windows to the same host (or a Remote-SSH reconnect) must not start all their
        // kubectl processes at the same moment. An unfocused window catches up on focus.
        this._initialTimer = setTimeout(() => {
            if (vscode.window.state.focused) { this.checkAll().catch(() => undefined); }
        }, 1500 + Math.floor(Math.random() * 2500));
        this._startTimer();

        // A cluster whose credential plugin was just approved should not wait for the next tick.
        this._storeSub = store.onDidChange(() => {
            void this._recheckNewlyApproved();
        });

        // Re-apply interval if the setting changes at runtime
        this._configSub = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('kubectl-control.statusCheckIntervalSeconds')) {
                this._restartTimer();
            }
        });

        // Background windows do not poll. When the window comes back to the front,
        // catch up if the last round is older than one interval.
        this._windowSub = vscode.window.onDidChangeWindowState(state => {
            const intervalMs = this._readIntervalSetting() * 1000;
            if (state.focused && intervalMs > 0 && Date.now() - this._lastRoundAt >= intervalMs) {
                this.checkAll().catch(() => undefined);
            }
        });
    }

    private _startTimer(): void {
        const intervalSeconds = this._readIntervalSetting();
        if (intervalSeconds > 0) {
            this._timer = setInterval(() => {
                // Only the focused VS Code window polls — several open windows (or a
                // window left in the background) must not multiply the load.
                if (!vscode.window.state.focused) { return; }
                this._tickCount++;
                this.checkAll().catch(() => undefined);
            }, intervalSeconds * 1000);
        }
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
        this._startTimer();
    }

    getStatus(clusterId: string): ClusterStatus {
        return this._statuses.get(clusterId) ?? 'unknown';
    }

    async checkAll(): Promise<void> {
        // A slow round (timeouts, many clusters) must not pile up with the next tick.
        if (this._round) { return this._round; }
        this._round = (async () => {
            if (await this.isLocked()) { return; }
            const clusters = await this.store.getClusters();
            await runLimited(clusters, MAX_PARALLEL_CHECKS,
                c => this._maybeCheckOne(c.id, c.kubeconfigData, c.activeContext, c.name ?? c.id));
            this._lastRoundAt = Date.now();
        })().finally(() => { this._round = undefined; });
        return this._round;
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

    private async _recheckNewlyApproved(): Promise<void> {
        const pending = [...this._statuses].filter(([, s]) => s === 'untrusted').map(([id]) => id);
        if (pending.length === 0 || await this.isLocked()) { return; }
        const clusters = await this.store.getClusters();
        await runLimited(
            clusters.filter(c => pending.includes(c.id) && isKubeconfigAllowed(c.kubeconfigData)),
            MAX_PARALLEL_CHECKS,
            c => this.checkOne(c.id, c.kubeconfigData, c.activeContext, c.name ?? c.id),
        );
    }

    private async _maybeCheckOne(id: string, kubeconfigData: string, context?: string, name?: string): Promise<void> {
        // SECURITY: never run an unapproved credential plugin from a background check.
        if (!isKubeconfigAllowed(kubeconfigData)) {
            if (this._statuses.get(id) !== 'untrusted') {
                this._statuses.set(id, 'untrusted');
                this._onDidChange.fire();
            }
            return;
        }
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
        let changed = false;

        try {
            const newStatus = await this._determineStatus(id, kubeconfigData, context, name);
            const prevStatus = this._statuses.get(id);

            this._statuses.set(id, newStatus);
            changed = newStatus !== prevStatus;

            if (newStatus === 'reachable') {
                this._consecutiveFailures.set(id, 0);
                // Allow re-notification on next unauthorized event
                this._authNotified.delete(id);
            } else {
                const prev = this._consecutiveFailures.get(id) ?? 0;
                this._consecutiveFailures.set(id, prev + 1);
                // Each log line is an RPC through the SSH tunnel: first failure, then every 10th.
                if (prev === 0 || (prev + 1) % 10 === 0) {
                    log.warn(`Cluster ${id} status: ${newStatus} (consecutive failures: ${prev + 1})`);
                }

                // Notify once when a cluster newly becomes unauthorized
                if (newStatus === 'unauthorized' && prevStatus !== 'unauthorized' && !this._authNotified.has(id)) {
                    this._authNotified.add(id);
                    this._notifyUnauthorized(name);
                }
            }
        } finally {
            this._inFlight.delete(id);
            // Only real status changes repaint the tree; bursts within a round coalesce.
            if (changed) { this._scheduleFire(); }
        }
    }

    private _scheduleFire(): void {
        if (this._fireTimer) { return; }
        this._fireTimer = setTimeout(() => {
            this._fireTimer = undefined;
            this._onDidChange.fire();
        }, 250);
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
        // Clusters known not to support `auth whoami` skip it — one kubectl process instead of two.
        if (this._useClusterInfo.has(id)) {
            return this._clusterInfoStatus(kubeconfigData, context);
        }
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
                // Cluster may not support SelfSubjectReview — remember and use the classic check.
                log.info(`Cluster "${name}": auth whoami unsupported, using cluster-info for status checks`);
                this._useClusterInfo.add(id);
                void this.globalState?.update(ClusterStatusService.USE_CLUSTER_INFO_KEY, [...this._useClusterInfo]);
                return this._clusterInfoStatus(kubeconfigData, context);
            }

            // classification === 'unreachable'
            return 'unreachable';
        }
    }

    private async _clusterInfoStatus(kubeconfigData: string, context: string | undefined): Promise<ClusterStatus> {
        try {
            await execWithKubeconfig(kubeconfigData, context, ['cluster-info', '--request-timeout=3s'], 5000);
            return 'reachable';
        } catch (clusterInfoErr) {
            return classifyError(errorText(clusterInfoErr)) === 'unauthorized' ? 'unauthorized' : 'unreachable';
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
        if (this._initialTimer) { clearTimeout(this._initialTimer); }
        if (this._fireTimer) { clearTimeout(this._fireTimer); }
        this._storeSub.dispose();
        this._configSub.dispose();
        this._windowSub.dispose();
        this._onDidChange.dispose();
    }
}
