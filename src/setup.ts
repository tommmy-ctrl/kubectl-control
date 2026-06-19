import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { LockService } from './lockService';
import { decryptData, isEncryptedFile } from './crypto';

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

// Used by settings menu "Setup erneut ausführen" — runs as QuickPick wizard (alternative to panel wizard)
export async function runSetupWizard(
    store: ClusterStore,
    lockService: LockService,
    onImported: () => void
): Promise<void> {
    const doImport = await vscode.window.showQuickPick(
        [
            { label: '$(cloud-download) Verbindungen importieren', description: 'Aus einer Exportdatei', doIt: true },
            { label: '$(close) Überspringen', description: 'Neu beginnen', doIt: false }
        ],
        { title: 'Setup (1/2) – Import', placeHolder: 'Möchtest du bestehende Verbindungen importieren?' }
    );

    if (doImport?.doIt) {
        const uris = await vscode.window.showOpenDialog({ filters: { 'JSON': ['json'] }, canSelectMany: false });
        if (uris && uris.length > 0) { await importFile(uris[0], store, onImported); }
    }

    const doLock = await vscode.window.showQuickPick(
        [
            { label: '$(lock) Passwort-Schutz aktivieren', description: 'Erweiterung beim Öffnen sperren', doIt: true },
            { label: '$(close) Überspringen', doIt: false }
        ],
        { title: 'Setup (2/2) – Passwort-Schutz', placeHolder: 'Möchtest du die Erweiterung mit einem Passwort sichern?' }
    );

    if (doLock?.doIt) { await promptSetPassword(lockService); }

    vscode.window.showInformationMessage('Kubectl Control – Setup abgeschlossen!');
}
