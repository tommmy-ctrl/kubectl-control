import * as vscode from 'vscode';
import { ClusterStore, ClusterProfile } from './store';
import { TerminalManager } from './terminalManager';

// ── Tree node union type ──────────────────────────────────────────────────────

export type ClusterTreeNode = ClusterGroupItem | ClusterTreeItem;

// ── Group item ────────────────────────────────────────────────────────────────

export class ClusterGroupItem extends vscode.TreeItem {
    constructor(
        public readonly groupName: string,
        public readonly clusters: ClusterProfile[],
    ) {
        super(groupName, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'clusterGroup';
        this.iconPath = new vscode.ThemeIcon('folder');
        const count = clusters.length;
        const suffix = count === 1 ? '' : 'en';
        this.tooltip = `Gruppe: ${groupName} (${count} Verbindung${suffix})`;
        this.description = `${count}`;
    }
}

// ── Cluster item ──────────────────────────────────────────────────────────────

export class ClusterTreeItem extends vscode.TreeItem {
    constructor(
        public readonly profile: ClusterProfile,
        hasTerminal: boolean,
    ) {
        super(profile.name, vscode.TreeItemCollapsibleState.None);
        this.id = profile.id;

        const ns = profile.namespace ?? 'default';
        this.description = hasTerminal ? `${ns}  ●` : ns;
        this.tooltip = new vscode.MarkdownString(
            `**${profile.name}**\n\n` +
            `- Namespace: \`${ns}\`\n` +
            `- Context: \`${profile.activeContext ?? '(Standard)'}\`\n` +
            `- Shell: \`${profile.shell ?? 'default'}\`\n` +
            (profile.group ? `- Gruppe: \`${profile.group}\`\n` : '') +
            (hasTerminal ? '\n_Terminal ist geöffnet_' : '')
        );

        this.iconPath = new vscode.ThemeIcon(
            hasTerminal ? 'terminal' : 'server-environment',
            hasTerminal ? new vscode.ThemeColor('terminal.ansiGreen') : undefined,
        );

        this.command = {
            command: 'kubectl-control.openTerminal',
            title: 'Terminal öffnen',
            arguments: [this],
        };

        this.contextValue = 'cluster';
    }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ClusterTreeDataProvider implements vscode.TreeDataProvider<ClusterTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ClusterTreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly store: ClusterStore,
        private readonly terminalManager: TerminalManager,
    ) {
        terminalManager.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ClusterTreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ClusterTreeNode): Promise<ClusterTreeNode[]> {
        // Children of a group
        if (element instanceof ClusterGroupItem) {
            return element.clusters.map(c => new ClusterTreeItem(c, this.terminalManager.isOpen(c.id)));
        }

        // Root level: build group structure
        const clusters = await this.store.getClusters();
        const grouped = new Map<string, ClusterProfile[]>();
        const ungrouped: ClusterProfile[] = [];

        for (const c of clusters) {
            if (c.group) {
                const list = grouped.get(c.group) ?? [];
                list.push(c);
                grouped.set(c.group, list);
            } else {
                ungrouped.push(c);
            }
        }

        const nodes: ClusterTreeNode[] = [];

        // Group items first (sorted)
        const sortedGroups = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
        for (const name of sortedGroups) {
            nodes.push(new ClusterGroupItem(name, grouped.get(name)!));
        }

        // Ungrouped clusters
        for (const c of ungrouped) {
            nodes.push(new ClusterTreeItem(c, this.terminalManager.isOpen(c.id)));
        }

        return nodes;
    }
}
