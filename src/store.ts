import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { log } from './logger';
import { t } from './i18n';
import { analyzeKubeconfig, syncApprovedFingerprints } from './execTrust';

export type ShellType = 'default' | 'bash' | 'zsh' | 'powershell' | 'cmd';

const ALLOWED_SHELLS: ShellType[] = ['default', 'bash', 'zsh', 'powershell', 'cmd'];
const CONTEXT_REGEX = /^[a-zA-Z0-9._-]+$/;
const MAX_STRING_LEN = 200;

/** Current schema version written to SecretStorage. */
const CURRENT_SCHEMA_VERSION = 2;

export interface ClusterProfile {
    id: string;
    name: string;
    kubeconfigData: string;
    group?: string;
    shell?: ShellType;
    namespace?: string;
    activeContext?: string;
    pinned?: boolean;
    lastUsed?: number;
    isProd?: boolean;
    /** Optional per-connection prompt colour as a #rrggbb hex string. */
    promptColor?: string;
    /**
     * SECURITY: fingerprint of the kubeconfig's credential plugin (exec/auth-provider)
     * that the user approved on THIS machine (see execTrust.ts). Never exported,
     * never accepted from an import or Gist sync.
     */
    execTrust?: string;
}

/** On-disk envelope wrapping the cluster array with a schema version. */
interface StoredEnvelope {
    schemaVersion: number;
    clusters: ClusterProfile[];
}

export interface AddClusterOptions {
    name: string;
    kubeconfigData: string;
    group?: string;
    shell?: ShellType;
    namespace?: string;
    activeContext?: string;
    promptColor?: string;
    /** Approved credential-plugin fingerprint (see execTrust.ts). */
    execTrust?: string;
}

/** Matches a #rrggbb hex colour (the only format accepted for prompt colours). */
const PROMPT_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

/** Sanitizes a raw imported cluster profile. Returns null if essential fields are missing. */
function sanitizeImportedCluster(cluster: ClusterProfile): ClusterProfile | null {
    if (!cluster.id || !cluster.name || !cluster.kubeconfigData) { return null; }

    const name = String(cluster.name).slice(0, MAX_STRING_LEN);
    const group = cluster.group == null ? undefined : String(cluster.group).slice(0, MAX_STRING_LEN);

    let activeContext: string | undefined;
    if (cluster.activeContext != null) {
        const valid = CONTEXT_REGEX.test(cluster.activeContext);
        if (valid) {
            activeContext = cluster.activeContext;
        } else if (cluster.activeContext) {
            log.warn(`importClusters: dropping invalid activeContext "${cluster.activeContext}" for cluster "${name}"`);
        }
    }

    let shell: ShellType | undefined;
    if (cluster.shell != null) {
        const valid = (ALLOWED_SHELLS as string[]).includes(cluster.shell);
        if (valid) {
            shell = cluster.shell;
        } else if (cluster.shell) {
            log.warn(`importClusters: dropping unrecognized shell "${cluster.shell}" for cluster "${name}"`);
        }
    }

    let promptColor: string | undefined;
    if (cluster.promptColor != null) {
        if (PROMPT_COLOR_REGEX.test(cluster.promptColor)) {
            promptColor = cluster.promptColor;
        } else if (cluster.promptColor) {
            log.warn(`importClusters: dropping invalid promptColor "${cluster.promptColor}" for cluster "${name}"`);
        }
    }

    // SECURITY: an import can never carry a plugin approval — strip it.
    const { execTrust: _ignored, ...rest } = cluster;
    return { ...rest, name, group, activeContext, shell, promptColor };
}

/**
 * Migrates a raw parsed value from SecretStorage to a ClusterProfile array.
 * Supports:
 *   - version 0 (legacy): bare ClusterProfile[]
 *   - version 1: StoredEnvelope { schemaVersion, clusters }
 *   - version 2: adds `execTrust` (approved credential-plugin fingerprint)
 * Add future migration steps here in order.
 *
 * @returns the clusters and whether anything was migrated (caller persists).
 */
function migrate(rawParsed: unknown): { clusters: ClusterProfile[]; migrated: boolean } {
    let clusters: ClusterProfile[];
    let version: number;
    if (Array.isArray(rawParsed)) {
        // Legacy format: bare array (schema version 0)
        clusters = rawParsed as ClusterProfile[];
        version = 0;
    } else {
        const envelope = rawParsed as StoredEnvelope;
        clusters = envelope.clusters ?? [];
        version = typeof envelope.schemaVersion === 'number' ? envelope.schemaVersion : 1;
    }

    if (version < 2) {
        // v1 → v2: connections configured before the credential-plugin check existed
        // keep working unchanged — their plugins already ran on every status check,
        // so approving them here adds no new exposure. Only clusters added, edited,
        // imported or synced from now on need an explicit approval.
        clusters = clusters.map(c => {
            const { fingerprint } = analyzeKubeconfig(c.kubeconfigData ?? '');
            return fingerprint ? { ...c, execTrust: fingerprint } : c;
        });
        log.info(`store: migrated schema version ${version} → ${CURRENT_SCHEMA_VERSION}`);
    }

    return { clusters, migrated: version < CURRENT_SCHEMA_VERSION };
}

export class ClusterStore {
    private static readonly storageKey = 'kubectl-control.clusters';

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

    // Serialize all mutating operations to prevent concurrent read-modify-write races.
    private _writeQueue: Promise<void> = Promise.resolve();

    // In-memory cache populated on first read, updated on every save().
    // `undefined` means the cache has not been populated yet.
    private _cache: ClusterProfile[] | undefined = undefined;

    constructor(private readonly context: vscode.ExtensionContext) {}

    // In-flight first load, shared by concurrent callers so the schema migration
    // (which persists) runs once and cannot race a queued save.
    private _loading: Promise<ClusterProfile[]> | undefined = undefined;

    public async getClusters(): Promise<ClusterProfile[]> {
        // Serve from cache if already populated.
        if (this._cache !== undefined) {
            return this._cache;
        }
        this._loading ??= this.load().finally(() => { this._loading = undefined; });
        return this._loading;
    }

    private async load(): Promise<ClusterProfile[]> {
        const data = await this.context.secrets.get(ClusterStore.storageKey);
        if (!data) {
            this._cache = [];
            return this._cache;
        }
        try {
            const rawParsed: unknown = JSON.parse(data);
            const { clusters, migrated } = migrate(rawParsed);
            if (migrated) {
                // Persist right away (before the cache is visible to any writer) so the
                // migration and its approvals run exactly once — clusters imported later
                // must not be approved by a re-run. A failed write only means it re-runs.
                const envelope: StoredEnvelope = { schemaVersion: CURRENT_SCHEMA_VERSION, clusters };
                await this.context.secrets.store(ClusterStore.storageKey, JSON.stringify(envelope))
                    .then(undefined, e => log.warn('store: could not persist schema migration', e));
            }
            syncApprovedFingerprints(clusters);
            this._cache = clusters;
            return this._cache;
        } catch (e) {
            log.error('Failed to parse clusters from SecretStorage', e);
            this._cache = [];
            return this._cache;
        }
    }

    public async addCluster(opts: AddClusterOptions): Promise<ClusterProfile> {
        let result!: ClusterProfile;
        this._writeQueue = this._writeQueue.then(async () => {
            const clusters = await this.getClusters();
            const profile: ClusterProfile = {
                id: uuidv4(),
                name: opts.name,
                kubeconfigData: opts.kubeconfigData,
                group: opts.group,
                shell: opts.shell,
                namespace: opts.namespace,
                activeContext: opts.activeContext,
                promptColor: opts.promptColor && PROMPT_COLOR_REGEX.test(opts.promptColor) ? opts.promptColor : undefined,
                execTrust: opts.execTrust,
            };
            clusters.push(profile);
            await this.save(clusters);
            log.info(`Cluster added: "${opts.name}" (id=${profile.id})`);
            result = profile;
        });
        await this._writeQueue;
        return result;
    }

    public async updateCluster(id: string, updates: Partial<Omit<ClusterProfile, 'id'>>): Promise<void> {
        this._writeQueue = this._writeQueue.then(async () => {
            const clusters = await this.getClusters();
            const idx = clusters.findIndex(c => c.id === id);
            if (idx === -1) { log.warn(`updateCluster: id not found: ${id}`); return; }
            // Drop an invalid prompt colour so the store never holds a non-#rrggbb value.
            if ('promptColor' in updates && updates.promptColor !== undefined && !PROMPT_COLOR_REGEX.test(updates.promptColor)) {
                updates = { ...updates, promptColor: undefined };
            }
            clusters[idx] = { ...clusters[idx], ...updates };
            await this.save(clusters);
            log.info(`Cluster updated: "${clusters[idx].name}" (id=${id})`);
        });
        await this._writeQueue;
    }

    public async deleteCluster(id: string): Promise<void> {
        this._writeQueue = this._writeQueue.then(async () => {
            let clusters = await this.getClusters();
            const target = clusters.find(c => c.id === id);
            clusters = clusters.filter(c => c.id !== id);
            await this.save(clusters);
            log.info(`Cluster deleted: "${target?.name ?? id}"`);
        });
        await this._writeQueue;
    }

    public async getGroups(): Promise<string[]> {
        const clusters = await this.getClusters();
        const groups = new Set(clusters.map(c => c.group).filter((g): g is string => !!g));
        return [...groups].sort((a, b) => a.localeCompare(b));
    }

    public async exportClusters(): Promise<string> {
        const clusters = await this.getClusters();
        // Approvals are machine-local and never leave this machine.
        return JSON.stringify(clusters.map(({ execTrust: _ignored, ...rest }) => rest), null, 2);
    }

    public async clearAll(): Promise<void> {
        this._cache = [];
        syncApprovedFingerprints([]);
        await this.context.secrets.delete(ClusterStore.storageKey);
        this._onDidChange.fire();
        log.info('All clusters cleared');
    }

    public async importClusters(json: string): Promise<number> {
        let added = 0;
        this._writeQueue = this._writeQueue.then(async () => {
            const incoming = JSON.parse(json) as ClusterProfile[];
            if (!Array.isArray(incoming)) { throw new TypeError(t('Invalid format')); }
            const existing = await this.getClusters();
            const existingIds = new Set(existing.map(c => c.id));
            const merged = [...existing];
            for (const cluster of incoming) {
                // Sanitize fields; skip clusters missing essential data.
                const sanitized = sanitizeImportedCluster(cluster);
                if (sanitized === null) { continue; }

                if (existingIds.has(cluster.id)) {
                    const idx = merged.findIndex(c => c.id === cluster.id);
                    // Keep this machine's approval: it is a fingerprint of the plugin
                    // command, so a changed command is still blocked until re-approved.
                    merged[idx] = { ...sanitized, execTrust: merged[idx].execTrust };
                } else {
                    merged.push({ ...sanitized, id: uuidv4() });
                    added++;
                }
            }
            await this.save(merged);
            log.info(`Import complete: ${added} new cluster(s) added`);
        });
        await this._writeQueue;
        return added;
    }

    /**
     * Persists the cluster array to SecretStorage using the versioned envelope format,
     * updates the in-memory cache, and fires the change event.
     */
    private async save(clusters: ClusterProfile[]): Promise<void> {
        const envelope: StoredEnvelope = {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            clusters,
        };
        await this.context.secrets.store(ClusterStore.storageKey, JSON.stringify(envelope));
        syncApprovedFingerprints(clusters);
        // Update cache so subsequent getClusters() calls see the committed state.
        this._cache = clusters;
        this._onDidChange.fire();
    }
}
