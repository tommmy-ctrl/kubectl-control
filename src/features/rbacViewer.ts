import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { ClusterStore, ClusterProfile } from '../store';
import { execWithKubeconfig } from '../kubectlExec';
import { ClusterTreeItem } from '../treeDataProvider';
import { log } from '../logger';

// ── Validation helpers ────────────────────────────────────────────────────────

const NS_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const NS_MAX = 63;
const VERB_RE = /^[a-z][a-z0-9-]*$/;
const RESOURCE_RE = /^[a-z][a-z0-9-]*$/;

function validateNamespace(value: string): string | undefined {
    if (!value) { return vscode.l10n.t('Namespace darf nicht leer sein.'); }
    if (value.length > NS_MAX) { return vscode.l10n.t('Namespace darf maximal {0} Zeichen lang sein.', NS_MAX); }
    if (!NS_RE.test(value)) { return vscode.l10n.t('Namespace muss RFC1123 entsprechen (Kleinbuchstaben, Ziffern, Bindestriche).'); }
    return undefined;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Parse `kubectl auth can-i --list` tabular output.
 * The first line is a header; subsequent lines are data rows.
 * Columns are separated by runs of whitespace but the last column (Verbs)
 * is a JSON-like array that may contain spaces — we split on the first few
 * whitespace-delimited fields and treat the remainder as the last column.
 */
interface RbacRow {
    resources: string;
    nonResourceURLs: string;
    resourceNames: string;
    verbs: string;
}

function parseCanIList(raw: string): RbacRow[] | null {
    const lines = raw.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
    if (lines.length < 2) { return null; }

    // Detect column offsets from the header line
    const header = lines[0];
    const resourcesIdx = header.indexOf('Resources');
    const nonResourceIdx = header.indexOf('Non-Resource URLs');
    const resourceNamesIdx = header.indexOf('Resource Names');
    const verbsIdx = header.indexOf('Verbs');

    if (resourcesIdx === -1 || nonResourceIdx === -1 || resourceNamesIdx === -1 || verbsIdx === -1) {
        return null;
    }

    const rows: RbacRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0) { continue; }
        // Slice fixed column positions; trim each segment
        const resources = line.slice(resourcesIdx, nonResourceIdx).trim();
        const nonResourceURLs = line.slice(nonResourceIdx, resourceNamesIdx).trim();
        const resourceNames = line.slice(resourceNamesIdx, verbsIdx).trim();
        const verbs = line.slice(verbsIdx).trim();
        rows.push({ resources, nonResourceURLs, resourceNames, verbs });
    }
    return rows;
}

function buildWebviewHtml(
    nonce: string,
    cspSource: string,
    clusterName: string,
    namespace: string,
    raw: string,
): string {
    const parsed = parseCanIList(raw);

    let bodyContent: string;

    if (parsed && parsed.length > 0) {
        const headerRow = `
            <tr>
                <th>Resources</th>
                <th>Non-Resource URLs</th>
                <th>Resource Names</th>
                <th>Verbs</th>
            </tr>`;
        const dataRows = parsed.map(row => `
            <tr>
                <td>${escapeHtml(row.resources)}</td>
                <td>${escapeHtml(row.nonResourceURLs)}</td>
                <td>${escapeHtml(row.resourceNames)}</td>
                <td class="verbs">${escapeHtml(row.verbs)}</td>
            </tr>`).join('');

        bodyContent = `<table><thead>${headerRow}</thead><tbody>${dataRows}</tbody></table>`;
    } else {
        // Fallback: render raw text preformatted
        bodyContent = `<pre>${escapeHtml(raw)}</pre>`;
    }

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'nonce-${nonce}' ${cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RBAC: ${escapeHtml(clusterName)} / ${escapeHtml(namespace)}</title>
    <style nonce="${nonce}">
        :root {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            color: var(--vscode-editor-foreground, #ccc);
            background: var(--vscode-editor-background, #1e1e1e);
        }
        body { margin: 0; padding: 16px; }
        h2 {
            font-size: 1rem;
            margin: 0 0 12px 0;
            color: var(--vscode-foreground, #ccc);
            border-bottom: 1px solid var(--vscode-panel-border, #555);
            padding-bottom: 6px;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
        }
        th, td {
            text-align: left;
            padding: 4px 12px 4px 4px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
            vertical-align: top;
            white-space: pre;
        }
        th {
            background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
            color: var(--vscode-foreground, #ccc);
            font-weight: 600;
        }
        tr:hover td {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .verbs { color: var(--vscode-terminal-ansiCyan, #4ec9b0); }
        pre {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            white-space: pre;
            overflow-x: auto;
        }
    </style>
</head>
<body>
    <h2>kubectl auth can-i --list &nbsp;|&nbsp; cluster: <strong>${escapeHtml(clusterName)}</strong> &nbsp;|&nbsp; namespace: <strong>${escapeHtml(namespace)}</strong></h2>
    ${bodyContent}
</body>
</html>`;
}

// ── Shared cluster picker ─────────────────────────────────────────────────────

async function pickCluster(store: ClusterStore): Promise<ClusterProfile | undefined> {
    const clusters = await store.getClusters();
    if (clusters.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t('Keine Cluster konfiguriert.'));
        return undefined;
    }
    const items = clusters.map(c => ({ label: c.name, description: c.activeContext ?? '', cluster: c }));
    const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Cluster auswählen'), placeHolder: vscode.l10n.t('Cluster …') });
    return picked?.cluster;
}

async function pickNamespace(defaultNs: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
        title: vscode.l10n.t('Namespace'),
        prompt: vscode.l10n.t('Namespace eingeben (RFC1123)'),
        value: defaultNs,
        validateInput: validateNamespace,
    });
}

// ── Command: kubectl-control.authCanI ────────────────────────────────────────

async function runAuthCanI(
    store: ClusterStore,
    webviewPanels: Map<string, vscode.WebviewPanel>,
    treeItem?: ClusterTreeItem,
): Promise<void> {
    let profile: ClusterProfile | undefined;

    if (treeItem instanceof ClusterTreeItem) {
        profile = treeItem.profile;
    } else {
        profile = await pickCluster(store);
    }
    if (!profile) { return; }

    const defaultNs = profile.namespace || 'default';
    const namespace = await pickNamespace(defaultNs);
    if (!namespace) { return; }

    log.info(`rbacViewer: auth can-i --list on cluster="${profile.name}" ns="${namespace}"`);

    let raw: string;
    try {
        const result = await execWithKubeconfig(
            profile.kubeconfigData,
            profile.activeContext,
            ['auth', 'can-i', '--list', '-n', namespace],
            8000,
        );
        raw = result.stdout;
        if (!raw && result.stderr) {
            raw = result.stderr;
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('rbacViewer: auth can-i --list failed', err);
        vscode.window.showErrorMessage(vscode.l10n.t('kubectl auth can-i --list fehlgeschlagen: {0}', msg));
        return;
    }

    const panelKey = `${profile.id}::${namespace}`;
    const existingPanel = webviewPanels.get(panelKey);
    if (existingPanel) {
        existingPanel.reveal();
        // Refresh content
        const nonce = crypto.randomBytes(16).toString('hex');
        existingPanel.webview.html = buildWebviewHtml(
            nonce,
            existingPanel.webview.cspSource,
            profile.name,
            namespace,
            raw,
        );
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'kubectl-control.rbacViewer',
        `RBAC: ${profile.name} / ${namespace}`,
        vscode.ViewColumn.One,
        {
            enableScripts: false,
            retainContextWhenHidden: false,
        },
    );

    webviewPanels.set(panelKey, panel);
    panel.onDidDispose(() => { webviewPanels.delete(panelKey); });

    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = buildWebviewHtml(nonce, panel.webview.cspSource, profile.name, namespace, raw);
}

// ── Command: kubectl-control.authCanIVerb ────────────────────────────────────

async function runAuthCanIVerb(
    store: ClusterStore,
    treeItem?: ClusterTreeItem,
): Promise<void> {
    let profile: ClusterProfile | undefined;

    if (treeItem instanceof ClusterTreeItem) {
        profile = treeItem.profile;
    } else {
        profile = await pickCluster(store);
    }
    if (!profile) { return; }

    const verb = await vscode.window.showInputBox({
        title: vscode.l10n.t('Verb (z.B. get, list, delete)'),
        prompt: vscode.l10n.t('kubectl-Verb eingeben'),
        placeHolder: 'get',
        validateInput: v => {
            if (!v) { return vscode.l10n.t('Verb darf nicht leer sein.'); }
            if (!VERB_RE.test(v)) { return vscode.l10n.t('Verb muss mit einem Kleinbuchstaben beginnen (nur [a-z0-9-]).'); }
            return undefined;
        },
    });
    if (!verb) { return; }

    const resource = await vscode.window.showInputBox({
        title: vscode.l10n.t('Resource (z.B. pods, deployments)'),
        prompt: vscode.l10n.t('Kubernetes-Resource eingeben'),
        placeHolder: 'pods',
        validateInput: r => {
            if (!r) { return vscode.l10n.t('Resource darf nicht leer sein.'); }
            if (!RESOURCE_RE.test(r)) { return vscode.l10n.t('Resource muss mit einem Kleinbuchstaben beginnen (nur [a-z0-9-]).'); }
            return undefined;
        },
    });
    if (!resource) { return; }

    const defaultNs = profile.namespace || 'default';
    const namespace = await pickNamespace(defaultNs);
    if (!namespace) { return; }

    log.info(`rbacViewer: auth can-i ${verb} ${resource} -n ${namespace} on cluster="${profile.name}"`);

    try {
        const result = await execWithKubeconfig(
            profile.kubeconfigData,
            profile.activeContext,
            ['auth', 'can-i', verb, resource, '-n', namespace],
            8000,
        );
        const answer = result.stdout.trim().toLowerCase();
        const allowed = answer === 'yes';
        const icon = allowed ? '$(check)' : '$(x)';
        const label = allowed ? vscode.l10n.t('Erlaubt (yes)') : vscode.l10n.t('Nicht erlaubt (no)');
        vscode.window.showInformationMessage(
            `${icon} ${profile.name} / ${namespace}: kubectl auth can-i ${verb} ${resource} → ${label}`,
        );
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('rbacViewer: auth can-i verb check failed', err);
        vscode.window.showErrorMessage(vscode.l10n.t('kubectl auth can-i fehlgeschlagen: {0}', msg));
    }
}

// ── Public registration function ──────────────────────────────────────────────

export function registerRbacViewer(
    context: vscode.ExtensionContext,
    store: ClusterStore,
): vscode.Disposable[] {
    // Track open webview panels so we can reuse/refresh them
    const webviewPanels = new Map<string, vscode.WebviewPanel>();

    const canIDisposable = vscode.commands.registerCommand(
        'kubectl-control.authCanI',
        (treeItem?: ClusterTreeItem) => runAuthCanI(store, webviewPanels, treeItem),
    );

    const canIVerbDisposable = vscode.commands.registerCommand(
        'kubectl-control.authCanIVerb',
        (treeItem?: ClusterTreeItem) => runAuthCanIVerb(store, treeItem),
    );

    // Clean up all panels on extension deactivate
    const panelCleanup = new vscode.Disposable(() => {
        for (const panel of webviewPanels.values()) {
            panel.dispose();
        }
        webviewPanels.clear();
    });

    return [canIDisposable, canIVerbDisposable, panelCleanup];
}
