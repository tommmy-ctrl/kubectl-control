import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
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
                title: 'Importdatei entschlüsseln',
                password: true,
                prompt: 'Passwort der Exportdatei eingeben'
            });
            if (!pwd) { return; }
            try {
                json = decryptData(parsed, pwd);
            } catch {
                vscode.window.showErrorMessage('Falsches Passwort oder beschädigte Datei.');
                return;
            }
        } else {
            json = content;
        }

        const added = await store.importClusters(json);
        onImported();
        vscode.window.showInformationMessage(`Import abgeschlossen – ${added} neue Verbindung(en) hinzugefügt.`);
    } catch (e) {
        vscode.window.showErrorMessage(`Import fehlgeschlagen: ${e}`);
    }
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

    const existing = await store.getClusters();
    const existingNames = new Set(existing.map(c => c.name));

    let imported = 0;
    let skipped = 0;

    for (const ctx of parsed.contexts) {
        if (existingNames.has(ctx.name)) {
            skipped++;
            continue;
        }
        await store.addCluster({
            name: ctx.name,
            kubeconfigData: content,
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
        vscode.window.showInformationMessage('Keine Contexts in ~/.kube/config gefunden.');
    } else {
        vscode.window.showInformationMessage(
            `${imported} Verbindung(en) aus ~/.kube/config importiert, ${skipped} bereits vorhanden.`
        );
    }
}

export async function promptSetPassword(lockService: LockService): Promise<boolean> {
    const pwd = await vscode.window.showInputBox({
        title: 'Passwort festlegen',
        password: true,
        prompt: 'Mindestens 6 Zeichen',
        validateInput: v => (!v || v.length < 6) ? 'Mindestens 6 Zeichen erforderlich' : undefined
    });
    if (!pwd) { return false; }

    const confirm = await vscode.window.showInputBox({
        title: 'Passwort bestätigen',
        password: true,
        prompt: 'Passwort wiederholen',
        validateInput: v => v === pwd ? undefined : 'Passwörter stimmen nicht überein'
    });
    if (confirm !== pwd) { return false; }

    await lockService.enableLock(pwd);
    vscode.window.showInformationMessage('Passwort-Schutz aktiviert.');
    return true;
}

