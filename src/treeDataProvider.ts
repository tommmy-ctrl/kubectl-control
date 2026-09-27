import * as vscode from 'vscode';
import { ClusterStore, ClusterProfile } from './store';
import { TerminalManager } from './terminalManager';
import { LockService } from './lockService';
import { ClusterStatusService, ClusterStatus } from './clusterStatus';
import { t } from './i18n';

// ── Tree node union type ──────────────────────────────────────────────────────

export type ClusterTreeNode = ClusterGroupItem | ClusterTreeItem | LockedItem | NoMatchesItem;

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
        terminalCount: number,
        status: ClusterStatus = 'unknown',
    ) {
        super(profile.name, vscode.TreeItemCollapsibleState.None);
        this.id = profile.id;

        const hasTerminal = terminalCount > 0;
        const ns = profile.namespace ?? 'default';

        // Build description: prod marker first, then ns, then terminal indicator (●, or ●×N
        // once more than one terminal is open for this cluster), then status
        let desc = '';
        if (profile.isProd === true) {
            desc += '🔴 ';
        }
        desc += ns;
        if (hasTerminal) {
            desc += terminalCount > 1 ? `  ●×${terminalCount}` : '  ●';
        }
        if (status === 'reachable') {
            desc += ' 🟢';
        } else if (status === 'unreachable') {
            desc += ' 🔴';
        } else if (status === 'unauthorized') {
            desc += ' 🟡';
        } else if (status === 'untrusted') {
            desc += ' 🛡️';
        }
        this.description = desc;

        const tooltipLines =
            `**${profile.name}**\n\n` +
            `- Namespace: \`${ns}\`\n` +
            `- Context: \`${profile.activeContext ?? t('(default)')}\`\n` +
            `- Shell: \`${profile.shell ?? 'default'}\`\n` +
            (profile.group ? t('- Group: `{0}`\n', profile.group) : '') +
            (profile.isProd ? t('\n⚠️ Production environment — changes take effect immediately\n') : '') +
            (status === 'unreachable' ? t('\n⚠️ Cluster unreachable\n') : '') +
            (status === 'unauthorized' ? t('\n⚠️ Token expired or invalid — not authenticated. Re-import kubeconfig.\n') : '') +
            (status === 'untrusted' ? t('\n🛡️ Uses a credential plugin that has not been approved yet — open a terminal to review and approve it. Status checks are paused until then.\n') : '') +
            (terminalCount > 1 ? t('\n_{0} terminals are open_', terminalCount)
                : hasTerminal ? t('\n_Terminal is open_') : '');
        this.tooltip = new vscode.MarkdownString(tooltipLines);

        if (profile.isProd === true && !hasTerminal) {
            this.iconPath = new vscode.ThemeIcon('lock-small', new vscode.ThemeColor('charts.red'));
        } else {
            this.iconPath = new vscode.ThemeIcon(
                hasTerminal ? 'terminal' : 'server-environment',
                hasTerminal ? new vscode.ThemeColor('terminal.ansiGreen') : undefined,
            );
        }

        this.command = {
            command: 'kubectl-control.openTerminal',
            title: t('Open Terminal'),
            arguments: [this],
        };

        this.contextValue = 'cluster';
    }
}

// ── Locked placeholder ────────────────────────────────────────────────────────

export class LockedItem extends vscode.TreeItem {
    constructor() {
        super('Gesperrt', vscode.TreeItemCollapsibleState.None);
        this.description = 'Passwort eingeben um fortzufahren';
        this.tooltip = 'Klicken um das Passwort einzugeben';
        this.iconPath = new vscode.ThemeIcon('lock');
        this.contextValue = 'locked';
        this.command = {
            command: 'kubectl-control.connectionsView.focus',
            title: 'Entsperren',
        };
    }
}

// ── No-matches placeholder ────────────────────────────────────────────────────

export class NoMatchesItem extends vscode.TreeItem {
    constructor(filter: string) {
        super(t('No clusters match "{0}"', filter), vscode.TreeItemCollapsibleState.None);
        this.description = t('Click to clear filter');
        this.iconPath = new vscode.ThemeIcon('circle-slash');
        this.contextValue = 'noMatches';
        this.command = {
            command: 'kubectl-control.clearClusterFilter',
            title: t('Clear Filter'),
        };
    }
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

function sortClusters(clusters: ClusterProfile[]): ClusterProfile[] {
    return [...clusters].sort((a, b) => {
        const aPinned = a.pinned === true;
        const bPinned = b.pinned === true;
        if (aPinned !== bPinned) { return aPinned ? -1 : 1; }
        // Both pinned or both not pinned: sort by lastUsed desc, then name
        const aLast = a.lastUsed ?? 0;
        const bLast = b.lastUsed ?? 0;
        if (bLast !== aLast) { return bLast - aLast; }
        return a.name.localeCompare(b.name);
    });
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ClusterTreeDataProvider implements vscode.TreeDataProvider<ClusterTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ClusterTreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private _filter = '';

    constructor(
        private readonly store: ClusterStore,
        private readonly terminalManager: TerminalManager,
        private readonly lockService: LockService,
        private readonly clusterStatusService?: ClusterStatusService,
    ) {
        terminalManager.onDidChange(() => this.refresh());
        lockService.onStateChange(() => this.refresh());
        if (clusterStatusService) {
            clusterStatusService.onDidChange(() => this.refresh());
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /** Current filter text (raw, as typed — not lowercased). Empty string = no filter. */
    getFilter(): string {
        return this._filter;
    }

    /** Sets the cluster name/namespace/group substring filter (case-insensitive) and refreshes. */
    setFilter(text: string): void {
        this._filter = text.trim();
        this.refresh();
    }

    clearFilter(): void {
        this.setFilter('');
    }

    getTreeItem(element: ClusterTreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ClusterTreeNode): Promise<ClusterTreeNode[]> {
        // Children of a group
        if (element instanceof ClusterGroupItem) {
            const sorted = sortClusters(element.clusters);
            return sorted.map(c => new ClusterTreeItem(
                c,
                this.terminalManager.openCount(c.id),
                this.clusterStatusService?.getStatus(c.id) ?? 'unknown',
            ));
        }

        // Show lock placeholder when locked
        if (await this.lockService.isEnabled() && !this.lockService.isUnlocked()) {
            return [new LockedItem()];
        }

        // Root level: build group structure
        let clusters = await this.store.getClusters();

        // Filter by name / namespace / group (case-insensitive substring), if set.
        if (this._filter) {
            const needle = this._filter.toLowerCase();
            clusters = clusters.filter(c =>
                c.name.toLowerCase().includes(needle) ||
                (c.namespace ?? '').toLowerCase().includes(needle) ||
                (c.group ?? '').toLowerCase().includes(needle));
            if (clusters.length === 0) {
                return [new NoMatchesItem(this._filter)];
            }
        }

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

        // Group items first (sorted alphabetically)
        const sortedGroups = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
        for (const name of sortedGroups) {
            nodes.push(new ClusterGroupItem(name, grouped.get(name)!));
        }

        // Ungrouped clusters: pinned first, then by lastUsed desc, then name
        const sortedUngrouped = sortClusters(ungrouped);
        for (const c of sortedUngrouped) {
            nodes.push(new ClusterTreeItem(
                c,
                this.terminalManager.openCount(c.id),
                this.clusterStatusService?.getStatus(c.id) ?? 'unknown',
            ));
        }

        return nodes;
    }
}
