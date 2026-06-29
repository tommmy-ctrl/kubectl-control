import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { log } from './logger';

export type ShellType = 'default' | 'bash' | 'zsh' | 'powershell' | 'cmd';

const ALLOWED_SHELLS: ShellType[] = ['default', 'bash', 'zsh', 'powershell', 'cmd'];
const CONTEXT_REGEX = /^[a-zA-Z0-9._-]+$/;
const MAX_STRING_LEN = 200;

/** Current schema version written to SecretStorage. */
const CURRENT_SCHEMA_VERSION = 1;

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
}

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

    return { ...cluster, name, group, activeContext, shell };
}

/**
 * Migrates a raw parsed value from SecretStorage to a ClusterProfile array.
 * Supports:
 *   - version 0 (legacy): bare ClusterProfile[]
 *   - version 1+: StoredEnvelope { schemaVersion, clusters }
 * Add future migration steps here as new `case` blocks.
 */
function migrate(rawParsed: unknown): ClusterProfile[] {
    // Legacy format: bare array (schema version 0)
    if (Array.isArray(rawParsed)) {
        log.info('store: migrating legacy bare-array storage to schema version 1');
        return rawParsed as ClusterProfile[];
    }

    // Envelope format
    const envelope = rawParsed as StoredEnvelope;
    let clusters = envelope.clusters ?? [];

    // Future migrations: switch on envelope.schemaVersion and apply transforms in order.
    // Currently only version 1 exists so nothing extra to do.

    return clusters;
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

    public async getClusters(): Promise<ClusterProfile[]> {
        // Serve from cache if already populated.
        if (this._cache !== undefined) {
            return this._cache;
        }

        const data = await this.context.secrets.get(ClusterStore.storageKey);
        if (!data) {
            this._cache = [];
            return this._cache;
        }
        try {
            const rawParsed: unknown = JSON.parse(data);
            const clusters = migrate(rawParsed);
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
        return JSON.stringify(clusters, null, 2);
    }

    public async clearAll(): Promise<void> {
        this._cache = [];
        await this.context.secrets.delete(ClusterStore.storageKey);
        this._onDidChange.fire();
        log.info('All clusters cleared');
    }

    public async importClusters(json: string): Promise<number> {
        let added = 0;
        this._writeQueue = this._writeQueue.then(async () => {
            const incoming = JSON.parse(json) as ClusterProfile[];
            if (!Array.isArray(incoming)) { throw new TypeError('Ungültiges Format'); }
            const existing = await this.getClusters();
            const existingIds = new Set(existing.map(c => c.id));
            const merged = [...existing];
            for (const cluster of incoming) {
                // Sanitize fields; skip clusters missing essential data.
                const sanitized = sanitizeImportedCluster(cluster);
                if (sanitized === null) { continue; }

                if (existingIds.has(cluster.id)) {
                    const idx = merged.findIndex(c => c.id === cluster.id);
                    merged[idx] = sanitized;
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
        // Update cache so subsequent getClusters() calls see the committed state.
        this._cache = clusters;
        this._onDidChange.fire();
    }
}
