import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';

export interface ClusterProfile {
    id: string;
    name: string;
    kubeconfigData: string;
}

export class ClusterStore {
    private static readonly storageKey = 'kubectl-control.clusters';

    constructor(private context: vscode.ExtensionContext) {}

    public async getClusters(): Promise<ClusterProfile[]> {
        const data = await this.context.secrets.get(ClusterStore.storageKey);
        if (!data) {
            return [];
        }
        try {
            return JSON.parse(data) as ClusterProfile[];
        } catch (e) {
            console.error('Failed to parse clusters from SecretStorage', e);
            return [];
        }
    }

    public async addCluster(name: string, kubeconfigData: string): Promise<void> {
        const clusters = await this.getClusters();
        clusters.push({
            id: uuidv4(),
            name,
            kubeconfigData
        });
        await this.context.secrets.store(ClusterStore.storageKey, JSON.stringify(clusters));
    }

    public async deleteCluster(id: string): Promise<void> {
        let clusters = await this.getClusters();
        clusters = clusters.filter(c => c.id !== id);
        await this.context.secrets.store(ClusterStore.storageKey, JSON.stringify(clusters));
    }
}
