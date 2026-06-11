import * as vscode from 'vscode';
import { ClusterStore, ClusterProfile } from './store';

export class ClusterTreeItem extends vscode.TreeItem {
    constructor(public readonly profile: ClusterProfile) {
        super(profile.name, vscode.TreeItemCollapsibleState.None);
        this.id = profile.id;
        this.tooltip = `Kubernetes Cluster: ${profile.name}`;
        this.description = 'Click to open terminal';
        this.iconPath = new vscode.ThemeIcon('server-environment');

        // Define the command that runs when clicking the item
        this.command = {
            command: 'kubectl-control.openTerminal',
            title: 'Open Terminal',
            arguments: [this]
        };

        this.contextValue = 'cluster'; // matches 'view/item/context' in package.json
    }
}

export class ClusterTreeDataProvider implements vscode.TreeDataProvider<ClusterTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ClusterTreeItem | undefined | null | void> = new vscode.EventEmitter<ClusterTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ClusterTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private store: ClusterStore) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ClusterTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ClusterTreeItem): Promise<ClusterTreeItem[]> {
        if (element) {
            return []; // No nesting
        }

        const clusters = await this.store.getClusters();
        return clusters.map(c => new ClusterTreeItem(c));
    }
}
