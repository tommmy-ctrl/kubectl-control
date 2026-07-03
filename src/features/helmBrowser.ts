import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { ClusterStore, ClusterProfile } from '../store';
import { execWithKubeconfig } from '../kubectlExec';
import { ClusterTreeItem } from '../treeDataProvider';
import { log } from '../logger';

// ── Validation helpers ────────────────────────────────────────────────────────

/** Helm release name: 1-53 chars, alphanumeric + hyphen + dot, must start with alnum. */
const RELEASE_NAME_RE = /^[a-z0-9][a-z0-9.\-]{0,52}$/i;

/** RFC 1123 label: lowercase alnum, hyphens allowed inside, 1-63 chars. */
const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidReleaseName(name: string): boolean {
    return RELEASE_NAME_RE.test(name);
}

function isValidNamespace(ns: string): boolean {
    return NAMESPACE_RE.test(ns);
}

// ── ENOENT detection ──────────────────────────────────────────────────────────

function isEnoent(err: unknown): boolean {
    if (err instanceof Error) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') { return true; }
        // execFile wraps ENOENT in message on some platforms
        if (e.message.includes('ENOENT')) { return true; }
    }
    return false;
}

// ── HTML escaping ─────────────────────────────────────────────────────────────

function esc(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── Shared HTML shell ─────────────────────────────────────────────────────────

function buildHtml(
    nonce: string,
    title: string,
    tableHeaders: string[],
    rows: string[][],
    refreshCommand: string,
    extraScript = '',
): string {
    const headerCells = tableHeaders.map(h => `<th>${esc(h)}</th>`).join('');
    const bodyRows = rows.map(row => {
        const cells = row.map(cell => `<td>${esc(cell)}</td>`).join('');
        return `<tr>${cells}</tr>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style nonce="${nonce}">
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    padding: 12px 16px;
    margin: 0;
  }
  h2 {
    font-size: 1.1em;
    margin: 0 0 10px;
    color: var(--vscode-foreground);
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 5px 14px;
    border-radius: 2px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
    margin-bottom: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: var(--vscode-font-size);
  }
  th {
    text-align: left;
    padding: 5px 10px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    color: var(--vscode-foreground);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  td {
    padding: 4px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    color: var(--vscode-foreground);
    white-space: nowrap;
  }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .empty { color: var(--vscode-descriptionForeground); margin-top: 8px; }
</style>
</head>
<body>
<h2>${esc(title)}</h2>
<button id="refreshBtn">⟳ Refresh</button>
${rows.length === 0
        ? '<p class="empty">No releases found.</p>'
        : `<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
    }
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('refreshBtn').addEventListener('click', () => {
    vscode.postMessage({ command: '${esc(refreshCommand)}' });
  });
  ${extraScript}
</script>
</body>
</html>`;
}

// ── Helm data types ───────────────────────────────────────────────────────────

interface HelmRelease {
    name: string;
    namespace: string;
    revision: string | number;
    updated: string;
    status: string;
    chart: string;
    app_version: string;
}

interface HelmHistoryEntry {
    revision: number;
    updated: string;
    status: string;
    chart: string;
    app_version: string;
    description: string;
}

// ── Cluster picker ────────────────────────────────────────────────────────────

async function pickCluster(store: ClusterStore): Promise<ClusterProfile | undefined> {
    const clusters = await store.getClusters();
    if (clusters.length === 0) {
        vscode.window.showWarningMessage('kubectl-control: No clusters configured.');
        return undefined;
    }
    if (clusters.length === 1) { return clusters[0]; }

    const items = clusters.map(c => ({
        label: c.name,
        description: c.activeContext ?? '',
        profile: c,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a cluster',
        title: 'Helm Browser — Select Cluster',
    });
    return picked?.profile;
}

// ── helmList command ──────────────────────────────────────────────────────────

async function runHelmList(
    store: ClusterStore,
    panels: Map<string, vscode.WebviewPanel>,
    arg: unknown,
): Promise<void> {
    let cluster: ClusterProfile | undefined;

    if (arg instanceof ClusterTreeItem) {
        cluster = arg.profile;
    } else {
        cluster = await pickCluster(store);
    }
    if (!cluster) { return; }

    const panelKey = `helmList:${cluster.id}`;
    const existingPanel = panels.get(panelKey);
    if (existingPanel) {
        existingPanel.reveal();
        await refreshHelmList(cluster, existingPanel);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'helmBrowser',
        `Helm — ${cluster.name}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    panels.set(panelKey, panel);
    panel.onDidDispose(() => panels.delete(panelKey));

    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'refresh') {
            await refreshHelmList(cluster!, panel);
        }
    });

    await refreshHelmList(cluster, panel);
}

async function refreshHelmList(cluster: ClusterProfile, panel: vscode.WebviewPanel): Promise<void> {
    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = buildLoadingHtml(nonce, `Helm Releases — ${cluster.name}`);

    let releases: HelmRelease[];
    try {
        const { stdout } = await execWithKubeconfig(
            cluster.kubeconfigData,
            cluster.activeContext,
            ['list', '--all-namespaces', '-o', 'json'],
            10000,
            'helm',
        );
        releases = JSON.parse(stdout) as HelmRelease[];
    } catch (err) {
        if (isEnoent(err)) {
            vscode.window.showErrorMessage(
                'Helm is not installed or not on PATH. Please install Helm and ensure it is accessible.',
            );
            panel.dispose();
            return;
        }
        log.error('helmList: failed', err);
        vscode.window.showErrorMessage(`Helm list failed: ${err instanceof Error ? err.message : String(err)}`);
        panel.dispose();
        return;
    }

    const headers = ['Name', 'Namespace', 'Revision', 'Status', 'Chart', 'App Version', 'Updated'];
    const rows = releases.map(r => [
        String(r.name ?? ''),
        String(r.namespace ?? ''),
        String(r.revision ?? ''),
        String(r.status ?? ''),
        String(r.chart ?? ''),
        String(r.app_version ?? ''),
        String(r.updated ?? ''),
    ]);

    const nonce2 = crypto.randomBytes(16).toString('hex');
    panel.webview.html = buildHtml(
        nonce2,
        `Helm Releases — ${cluster.name}`,
        headers,
        rows,
        'refresh',
    );
}

// ── helmHistory command ───────────────────────────────────────────────────────

async function runHelmHistory(
    store: ClusterStore,
    panels: Map<string, vscode.WebviewPanel>,
    arg: unknown,
): Promise<void> {
    // Step 1: pick cluster
    let cluster: ClusterProfile | undefined;
    if (arg instanceof ClusterTreeItem) {
        cluster = arg.profile;
    } else {
        cluster = await pickCluster(store);
    }
    if (!cluster) { return; }

    // Step 2: fetch release list to offer as QuickPick
    let releases: HelmRelease[] = [];
    try {
        const { stdout } = await execWithKubeconfig(
            cluster.kubeconfigData,
            cluster.activeContext,
            ['list', '--all-namespaces', '-o', 'json'],
            10000,
            'helm',
        );
        releases = JSON.parse(stdout) as HelmRelease[];
    } catch (err) {
        if (isEnoent(err)) {
            vscode.window.showErrorMessage(
                'Helm is not installed or not on PATH. Please install Helm and ensure it is accessible.',
            );
            return;
        }
        log.warn('helmHistory: could not fetch release list, falling back to manual input', err);
    }

    let releaseName: string;
    let releaseNamespace: string;

    if (releases.length > 0) {
        const items = releases.map(r => ({
            label: r.name,
            description: `ns: ${r.namespace}   chart: ${r.chart}   status: ${r.status}`,
            release: r,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a release to view history',
            title: `Helm History — ${cluster.name}`,
        });
        if (!picked) { return; }
        releaseName = picked.release.name;
        releaseNamespace = picked.release.namespace;
    } else {
        // Manual fallback
        const nameInput = await vscode.window.showInputBox({
            prompt: 'Release name',
            title: `Helm History — ${cluster.name}`,
            validateInput: v =>
                isValidReleaseName(v)
                    ? undefined
                    : 'Invalid release name (alphanumeric, hyphens, dots; max 53 chars)',
        });
        if (!nameInput) { return; }

        const nsInput = await vscode.window.showInputBox({
            prompt: 'Namespace',
            value: cluster.namespace ?? 'default',
            title: `Helm History — ${cluster.name}`,
            validateInput: v =>
                isValidNamespace(v)
                    ? undefined
                    : 'Invalid namespace (RFC 1123: lowercase, alphanumeric, hyphens)',
        });
        if (!nsInput) { return; }

        releaseName = nameInput;
        releaseNamespace = nsInput;
    }

    // Validate before running
    if (!isValidReleaseName(releaseName)) {
        vscode.window.showErrorMessage(`Invalid release name: "${releaseName}"`);
        return;
    }
    if (!isValidNamespace(releaseNamespace)) {
        vscode.window.showErrorMessage(`Invalid namespace: "${releaseNamespace}"`);
        return;
    }

    const panelKey = `helmHistory:${cluster.id}:${releaseNamespace}/${releaseName}`;
    const existingPanel = panels.get(panelKey);
    if (existingPanel) {
        existingPanel.reveal();
        await refreshHelmHistory(cluster, releaseName, releaseNamespace, existingPanel);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'helmHistory',
        `Helm History — ${releaseName}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    panels.set(panelKey, panel);
    panel.onDidDispose(() => panels.delete(panelKey));

    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'refresh') {
            await refreshHelmHistory(cluster!, releaseName, releaseNamespace, panel);
        }
    });

    await refreshHelmHistory(cluster, releaseName, releaseNamespace, panel);
}

async function refreshHelmHistory(
    cluster: ClusterProfile,
    releaseName: string,
    releaseNamespace: string,
    panel: vscode.WebviewPanel,
): Promise<void> {
    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = buildLoadingHtml(
        nonce,
        `Helm History — ${releaseName} (${releaseNamespace})`,
    );

    let history: HelmHistoryEntry[];
    try {
        const { stdout } = await execWithKubeconfig(
            cluster.kubeconfigData,
            cluster.activeContext,
            ['history', releaseName, '-n', releaseNamespace, '-o', 'json'],
            10000,
            'helm',
        );
        history = JSON.parse(stdout) as HelmHistoryEntry[];
    } catch (err) {
        if (isEnoent(err)) {
            vscode.window.showErrorMessage(
                'Helm is not installed or not on PATH. Please install Helm and ensure it is accessible.',
            );
            panel.dispose();
            return;
        }
        log.error('helmHistory: failed', err);
        vscode.window.showErrorMessage(
            `Helm history failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        panel.dispose();
        return;
    }

    const headers = ['Revision', 'Updated', 'Status', 'Chart', 'App Version', 'Description'];
    const rows = history.map(h => [
        String(h.revision ?? ''),
        String(h.updated ?? ''),
        String(h.status ?? ''),
        String(h.chart ?? ''),
        String(h.app_version ?? ''),
        String(h.description ?? ''),
    ]);

    const nonce2 = crypto.randomBytes(16).toString('hex');
    panel.webview.html = buildHtml(
        nonce2,
        `Helm History — ${releaseName} (${releaseNamespace}) — ${cluster.name}`,
        headers,
        rows,
        'refresh',
    );
}

// ── Loading placeholder ───────────────────────────────────────────────────────

function buildLoadingHtml(nonce: string, title: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 16px; }
</style>
</head>
<body><p>Loading ${esc(title)}…</p></body>
</html>`;
}

// ── Public entry point ────────────────────────────────────────────────────────

export function registerHelmBrowser(
    context: vscode.ExtensionContext,
    store: ClusterStore,
): vscode.Disposable[] {
    // Shared panel registry keyed by panelKey string
    const panels = new Map<string, vscode.WebviewPanel>();

    const listCmd = vscode.commands.registerCommand(
        'kubectl-control.helmList',
        (arg?: unknown) => runHelmList(store, panels, arg),
    );

    const historyCmd = vscode.commands.registerCommand(
        'kubectl-control.helmHistory',
        (arg?: unknown) => runHelmHistory(store, panels, arg),
    );

    return [listCmd, historyCmd];
}
