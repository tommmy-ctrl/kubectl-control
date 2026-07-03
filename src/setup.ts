import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import * as jsYaml from 'js-yaml';
import { ClusterStore } from './store';
import { LockService } from './lockService';
import { decryptData, isEncryptedFile } from './crypto';
import { parseKubeconfig } from './kubeconfigParser';
import { log } from './logger';

export const SETUP_KEY = 'kubectl-control.setupDone';

export function isSetupDone(context: vscode.ExtensionContext): boolean {
    return context.globalState.get<boolean>(SETUP_KEY) === true;
}

export async function markSetupDone(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(SETUP_KEY, true);
}

export async function resetSetup(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(SETUP_KEY, false);
}

export async function importFile(
    uri: vscode.Uri,
    store: ClusterStore,
    onImported: () => void
): Promise<void> {
    try {
        const raw = await vscode.workspace.fs.readFile(uri);
        const content = new TextDecoder().decode(raw);
        const parsed: unknown = JSON.parse(content);

        let json: string;
        if (isEncryptedFile(parsed)) {
            const pwd = await vscode.window.showInputBox({
                title: vscode.l10n.t('Importdatei entschlüsseln'),
                password: true,
                prompt: vscode.l10n.t('Passwort der Exportdatei eingeben')
            });
            if (!pwd) { return; }
            try {
                json = decryptData(parsed, pwd);
            } catch {
                vscode.window.showErrorMessage(vscode.l10n.t('Falsches Passwort oder beschädigte Datei.'));
                return;
            }
        } else {
            json = content;
        }

        const added = await store.importClusters(json);
        onImported();
        vscode.window.showInformationMessage(vscode.l10n.t('Import abgeschlossen – {0} neue Verbindung(en) hinzugefügt.', added));
    } catch (e) {
        vscode.window.showErrorMessage(vscode.l10n.t('Import fehlgeschlagen: {0}', String(e)));
    }
}

/**
 * Builds a minimal single-context kubeconfig YAML that contains only the
 * named context plus the cluster and user blocks it references.
 * This prevents other contexts' credentials from leaking into a cluster's terminal.
 */
function buildMinimalKubeconfig(fullDoc: Record<string, unknown>, contextName: string): string {
    const rawContexts = Array.isArray(fullDoc['contexts']) ? fullDoc['contexts'] : [];
    const contextEntry = rawContexts.find(
        (c): c is Record<string, unknown> =>
            typeof c === 'object' && c !== null && (c as Record<string, unknown>)['name'] === contextName
    );

    const contextDetail =
        contextEntry && typeof contextEntry['context'] === 'object' && contextEntry['context'] !== null
            ? (contextEntry['context'] as Record<string, unknown>)
            : {};

    const clusterName = typeof contextDetail['cluster'] === 'string' ? contextDetail['cluster'] : '';
    const userName = typeof contextDetail['user'] === 'string' ? contextDetail['user'] : '';

    const rawClusters = Array.isArray(fullDoc['clusters']) ? fullDoc['clusters'] : [];
    const matchedCluster = rawClusters.filter(
        (c): c is Record<string, unknown> =>
            typeof c === 'object' && c !== null && (c as Record<string, unknown>)['name'] === clusterName
    );

    const rawUsers = Array.isArray(fullDoc['users']) ? fullDoc['users'] : [];
    const matchedUser = rawUsers.filter(
        (u): u is Record<string, unknown> =>
            typeof u === 'object' && u !== null && (u as Record<string, unknown>)['name'] === userName
    );

    const minimal = {
        apiVersion: fullDoc['apiVersion'] ?? 'v1',
        kind: 'Config',
        'current-context': contextName,
        contexts: contextEntry ? [contextEntry] : [],
        clusters: matchedCluster,
        users: matchedUser,
    };

    return jsYaml.dump(minimal, { noRefs: true });
}

export async function importFromLocalKubeconfig(
    store: ClusterStore,
    onImported: () => void,
): Promise<{ imported: number; skipped: number }> {
    const kubeconfigPath = path.join(os.homedir(), '.kube', 'config');
    let content: string;
    try {
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(kubeconfigPath));
        content = new TextDecoder().decode(raw);
    } catch {
        log.info('No ~/.kube/config found, skipping auto-import');
        return { imported: 0, skipped: 0 };
    }

    const parsed = parseKubeconfig(content);
    if (!parsed.valid || parsed.contexts.length === 0) {
        log.info('~/.kube/config parsed but no contexts found');
        return { imported: 0, skipped: 0 };
    }

    // Fix 3: parse the full doc so we can extract per-context minimal configs
    const fullDoc = jsYaml.load(content) as Record<string, unknown>;

    const existing = await store.getClusters();
    const existingNames = new Set(existing.map(c => c.name));

    let imported = 0;
    let skipped = 0;

    for (const ctx of parsed.contexts) {
        if (existingNames.has(ctx.name)) {
            skipped++;
            continue;
        }
        // Build a minimal kubeconfig containing only this context's data
        const minimalKubeconfigData = buildMinimalKubeconfig(fullDoc, ctx.name);
        await store.addCluster({
            name: ctx.name,
            kubeconfigData: minimalKubeconfigData,
            activeContext: ctx.name,
            namespace: ctx.namespace || 'default',
        });
        imported++;
    }

    if (imported > 0) {
        onImported();
    }
    log.info(`importFromLocalKubeconfig: imported=${imported}, skipped=${skipped}`);
    return { imported, skipped };
}

export async function handleImportFromKubeconfig(
    store: ClusterStore,
    onImported: () => void,
): Promise<void> {
    const { imported, skipped } = await importFromLocalKubeconfig(store, onImported);
    if (imported === 0 && skipped === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('Keine Contexts in ~/.kube/config gefunden.'));
    } else {
        vscode.window.showInformationMessage(
            vscode.l10n.t('{0} Verbindung(en) aus ~/.kube/config importiert, {1} bereits vorhanden.', imported, skipped)
        );
    }
}

export async function promptSetPassword(lockService: LockService): Promise<boolean> {
    const pwd = await vscode.window.showInputBox({
        title: vscode.l10n.t('Passwort festlegen'),
        password: true,
        prompt: vscode.l10n.t('Mindestens 6 Zeichen'),
        validateInput: v => (!v || v.length < 6) ? vscode.l10n.t('Mindestens 6 Zeichen erforderlich') : undefined
    });
    if (!pwd) { return false; }

    const confirm = await vscode.window.showInputBox({
        title: vscode.l10n.t('Passwort bestätigen'),
        password: true,
        prompt: vscode.l10n.t('Passwort wiederholen'),
        validateInput: v => v === pwd ? undefined : vscode.l10n.t('Passwörter stimmen nicht überein')
    });
    if (confirm !== pwd) { return false; }

    await lockService.enableLock(pwd);
    vscode.window.showInformationMessage(vscode.l10n.t('Passwort-Schutz aktiviert.'));
    return true;
}
