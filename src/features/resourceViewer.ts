import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { ClusterStore, ClusterProfile } from '../store';
import { ClusterTreeItem } from '../treeDataProvider';
import { execWithKubeconfig } from '../kubectlExec';
import { log } from '../logger';

// ── Constants ─────────────────────────────────────────────────────────────────

const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_NS_LEN = 63;

type ResourceKind = 'pods' | 'deployments';

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function generateNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

function formatAge(timestamp: string | undefined): string {
    if (!timestamp) { return 'N/A'; }
    const created = new Date(timestamp).getTime();
    if (isNaN(created)) { return 'N/A'; }
    const diffMs = Date.now() - created;
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) { return `${seconds}s`; }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) { return `${minutes}m`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours}h`; }
    const days = Math.floor(hours / 24);
    return `${days}d`;
}

// ── HTML builders ─────────────────────────────────────────────────────────────

function buildPodsHtml(nonce: string, cluster: ClusterProfile, namespace: string, items: KubePodItem[]): string {
    const rows = items.map(pod => {
        const containers = pod.spec?.containers ?? [];
        const totalContainers = containers.length;
        const statuses = pod.status?.containerStatuses ?? [];
        const readyCount = statuses.filter(s => s.ready).length;
        const phase = pod.status?.phase ?? 'Unknown';
        const restarts = statuses.reduce((sum, s) => sum + (s.restartCount ?? 0), 0);
        const age = formatAge(pod.metadata?.creationTimestamp);
        return `<tr>
            <td>${escapeHtml(pod.metadata?.name)}</td>
            <td>${escapeHtml(readyCount)}/${escapeHtml(totalContainers)}</td>
            <td><span class="status status-${escapeHtml(phase.toLowerCase())}">${escapeHtml(phase)}</span></td>
            <td>${escapeHtml(restarts)}</td>
            <td>${escapeHtml(age)}</td>
        </tr>`;
    }).join('');

    const thead = `<tr><th>Name</th><th>Ready</th><th>Status</th><th>Restarts</th><th>Age</th></tr>`;
    return buildPageHtml(nonce, `Pods — ${cluster.name} / ${namespace}`, thead, rows, items.length, 'pods');
}

function buildDeploymentsHtml(nonce: string, cluster: ClusterProfile, namespace: string, items: KubeDeploymentItem[]): string {
    const rows = items.map(dep => {
        const desired = dep.spec?.replicas ?? 0;
        const ready = dep.status?.readyReplicas ?? 0;
        const upToDate = dep.status?.updatedReplicas ?? 0;
        const available = dep.status?.availableReplicas ?? 0;
        return `<tr>
            <td>${escapeHtml(dep.metadata?.name)}</td>
            <td>${escapeHtml(ready)}/${escapeHtml(desired)}</td>
            <td>${escapeHtml(upToDate)}</td>
            <td>${escapeHtml(available)}</td>
        </tr>`;
    }).join('');

    const thead = `<tr><th>Name</th><th>Ready</th><th>Up-to-date</th><th>Available</th></tr>`;
    return buildPageHtml(nonce, `Deployments — ${cluster.name} / ${namespace}`, thead, rows, items.length, 'deployments');
}

function buildPageHtml(
    nonce: string,
    title: string,
    thead: string,
    rows: string,
    count: number,
    kind: ResourceKind,
): string {
    const emptyRow = rows.trim() === ''
        ? `<tr><td colspan="5" class="empty">No ${kind} found.</td></tr>`
        : rows;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style nonce="${nonce}">
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 16px;
            margin: 0;
        }
        h2 {
            color: var(--vscode-foreground);
            font-size: 1.2em;
            margin-bottom: 8px;
        }
        .meta {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
            margin-bottom: 16px;
        }
        .toolbar {
            margin-bottom: 16px;
        }
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 14px;
            cursor: pointer;
            border-radius: 2px;
            font-size: var(--vscode-font-size);
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: var(--vscode-font-size);
        }
        th {
            background: var(--vscode-editor-lineHighlightBackground);
            color: var(--vscode-foreground);
            padding: 8px 12px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: 600;
        }
        td {
            padding: 6px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            color: var(--vscode-foreground);
        }
        tr:hover td {
            background: var(--vscode-list-hoverBackground);
        }
        .empty {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 24px;
        }
        .status { padding: 2px 6px; border-radius: 3px; font-size: 0.85em; }
        .status-running { background: var(--vscode-terminal-ansiGreen); color: #fff; }
        .status-pending { background: var(--vscode-terminal-ansiYellow); color: #000; }
        .status-failed  { background: var(--vscode-terminal-ansiRed);    color: #fff; }
        .status-succeeded { background: var(--vscode-terminal-ansiCyan); color: #000; }
    </style>
</head>
<body>
    <h2>${escapeHtml(title)}</h2>
    <div class="meta">${escapeHtml(count)} item(s)</div>
    <div class="toolbar">
        <button id="refreshBtn">&#8635; Refresh</button>
    </div>
    <table>
        <thead>${thead}</thead>
        <tbody>${emptyRow}</tbody>
    </table>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('refreshBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'refresh' });
        });
    </script>
</body>
</html>`;
}

// ── Kubernetes response types ──────────────────────────────────────────────────

interface KubeMetadata {
    name?: string;
    creationTimestamp?: string;
}

interface KubeContainerStatus {
    ready?: boolean;
    restartCount?: number;
}

interface KubePodSpec {
    containers?: unknown[];
}

interface KubePodStatus {
    phase?: string;
    containerStatuses?: KubeContainerStatus[];
}

interface KubePodItem {
    metadata?: KubeMetadata;
    spec?: KubePodSpec;
    status?: KubePodStatus;
}

interface KubeDeploymentStatus {
    readyReplicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
}

interface KubeDeploymentSpec {
    replicas?: number;
}

interface KubeDeploymentItem {
    metadata?: KubeMetadata;
    spec?: KubeDeploymentSpec;
    status?: KubeDeploymentStatus;
}

interface KubeList<T> {
    items?: T[];
}

// ── Core viewer logic ─────────────────────────────────────────────────────────

async function pickCluster(store: ClusterStore): Promise<ClusterProfile | undefined> {
    const clusters = await store.getClusters();
    if (clusters.length === 0) {
        void vscode.window.showWarningMessage('No clusters configured in kubectl-control.');
        return undefined;
    }
    const picks = clusters.map(c => ({ label: c.name, description: c.namespace ?? 'default', profile: c }));
    const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a cluster' });
    return chosen?.profile;
}

async function pickNamespace(cluster: ClusterProfile): Promise<string | undefined> {
    const defaultNs = cluster.namespace ?? 'default';
    const input = await vscode.window.showInputBox({
        prompt: 'Namespace',
        value: defaultNs,
        validateInput(value) {
            if (!value) { return 'Namespace cannot be empty'; }
            if (value.length > MAX_NS_LEN) { return `Namespace must be at most ${MAX_NS_LEN} characters`; }
            if (!NAMESPACE_RE.test(value)) {
                return 'Invalid namespace: must match [a-z0-9]([-a-z0-9]*[a-z0-9])?';
            }
            return undefined;
        },
    });
    return input;
}

async function runResourceCommand(
    kind: ResourceKind,
    treeItem: ClusterTreeItem | undefined,
    store: ClusterStore,
): Promise<void> {
    // 1. Resolve cluster
    let cluster: ClusterProfile | undefined;
    if (treeItem instanceof ClusterTreeItem) {
        cluster = treeItem.profile;
    } else {
        cluster = await pickCluster(store);
    }
    if (!cluster) { return; }

    // 2. Resolve namespace
    const namespaceRaw = await pickNamespace(cluster);
    if (!namespaceRaw) { return; }
    const namespace: string = namespaceRaw;

    // 3. Create/reuse panel
    const panelTitle = kind === 'pods'
        ? `Pods: ${cluster.name}`
        : `Deployments: ${cluster.name}`;

    const panel = vscode.window.createWebviewPanel(
        `kubectl-control.${kind}`,
        panelTitle,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    // 4. Function to run and render
    async function fetch(): Promise<void> {
        try {
            const { stdout, stderr } = await execWithKubeconfig(
                cluster!.kubeconfigData,
                cluster!.activeContext,
                ['get', kind, '-n', namespace, '-o', 'json'],
                8000,
            );

            if (stderr && !stdout) {
                log.warn(`resourceViewer(${kind}): stderr: ${stderr}`);
                void vscode.window.showErrorMessage(`kubectl error: ${stderr.trim()}`);
                return;
            }

            const nonce = generateNonce();

            if (kind === 'pods') {
                const list = JSON.parse(stdout) as KubeList<KubePodItem>;
                const items = list.items ?? [];
                panel.webview.html = buildPodsHtml(nonce, cluster!, namespace, items);
            } else {
                const list = JSON.parse(stdout) as KubeList<KubeDeploymentItem>;
                const items = list.items ?? [];
                panel.webview.html = buildDeploymentsHtml(nonce, cluster!, namespace, items);
            }

            log.info(`resourceViewer: rendered ${kind} for cluster "${cluster!.name}" ns="${namespace}"`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`resourceViewer(${kind}) error`, err);
            void vscode.window.showErrorMessage(`kubectl-control: ${msg}`);
        }
    }

    // 5. Handle refresh messages
    panel.webview.onDidReceiveMessage(async (message: { command: string }) => {
        if (message.command === 'refresh') {
            await fetch();
        }
    });

    // 6. Initial load
    await fetch();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function registerResourceViewer(
    context: vscode.ExtensionContext,
    store: ClusterStore,
): vscode.Disposable[] {
    const listPods = vscode.commands.registerCommand(
        'kubectl-control.listPods',
        async (treeItem?: ClusterTreeItem) => {
            await runResourceCommand('pods', treeItem, store);
        },
    );

    const listDeployments = vscode.commands.registerCommand(
        'kubectl-control.listDeployments',
        async (treeItem?: ClusterTreeItem) => {
            await runResourceCommand('deployments', treeItem, store);
        },
    );

    context.subscriptions.push(listPods, listDeployments);

    return [listPods, listDeployments];
}
