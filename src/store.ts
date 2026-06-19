import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { log } from './logger';

export type ShellType = 'default' | 'bash' | 'zsh' | 'powershell' | 'cmd';

export interface ClusterProfile {
    id: string;
    name: string;
    kubeconfigData: string;
    group?: string;
    shell?: ShellType;
    namespace?: string;
    activeContext?: string;
}

export interface AddClusterOptions {
    name: string;
    kubeconfigData: string;
    group?: string;
    shell?: ShellType;
    namespace?: string;
    activeContext?: string;
}

export class ClusterStore {
    private static readonly storageKey = 'kubectl-control.clusters';

    constructor(private context: vscode.ExtensionContext) {}

    public async getClusters(): Promise<ClusterProfile[]> {
        const data = await this.context.secrets.get(ClusterStore.storageKey);
        if (!data) { return []; }
        try {
            return JSON.parse(data) as ClusterProfile[];
        } catch (e) {
            log.error('Failed to parse clusters from SecretStorage', e);
            return [];
        }
    }

    public async addCluster(opts: AddClusterOptions): Promise<ClusterProfile> {
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
        return profile;
    }

    public async updateCluster(id: string, updates: Partial<Omit<ClusterProfile, 'id'>>): Promise<void> {
        const clusters = await this.getClusters();
        const idx = clusters.findIndex(c => c.id === id);
        if (idx === -1) { log.warn(`updateCluster: id not found: ${id}`); return; }
        clusters[idx] = { ...clusters[idx], ...updates };
        await this.save(clusters);
        log.info(`Cluster updated: "${clusters[idx].name}" (id=${id})`);
    }

    public async deleteCluster(id: string): Promise<void> {
        let clusters = await this.getClusters();
        const target = clusters.find(c => c.id === id);
        clusters = clusters.filter(c => c.id !== id);
        await this.save(clusters);
        log.info(`Cluster deleted: "${target?.name ?? id}"`);
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
        await this.context.secrets.delete(ClusterStore.storageKey);
        log.info('All clusters cleared');
    }

    public async importClusters(json: string): Promise<number> {
        const incoming = JSON.parse(json) as ClusterProfile[];
        if (!Array.isArray(incoming)) { throw new TypeError('Ungültiges Format'); }
        const existing = await this.getClusters();
        const existingIds = new Set(existing.map(c => c.id));
        const merged = [...existing];
        let added = 0;
        for (const cluster of incoming) {
            if (!cluster.id || !cluster.name || !cluster.kubeconfigData) { continue; }
            if (existingIds.has(cluster.id)) {
                const idx = merged.findIndex(c => c.id === cluster.id);
                merged[idx] = cluster;
            } else {
                merged.push({ ...cluster, id: uuidv4() });
                added++;
            }
        }
        await this.save(merged);
        log.info(`Import complete: ${added} new cluster(s) added`);
        return added;
    }

    private async save(clusters: ClusterProfile[]): Promise<void> {
        await this.context.secrets.store(ClusterStore.storageKey, JSON.stringify(clusters));
    }
}
