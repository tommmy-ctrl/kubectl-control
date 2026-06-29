import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { ClusterTreeDataProvider, ClusterTreeItem } from './treeDataProvider';
import { ConnectionsViewProvider } from './connectionsView';
import { LockService } from './lockService';
import { TerminalManager } from './terminalManager';
import { encryptData } from './crypto';
import { importFile, promptSetPassword, resetSetup } from './setup';
import { GistSyncService } from './gistSync';
import { log } from './logger';

export function registerCommands(
    context: vscode.ExtensionContext,
    store: ClusterStore,
    treeProvider: ClusterTreeDataProvider,
    connectionsView: ConnectionsViewProvider,
    lockService: LockService,
    terminalManager: TerminalManager,
    gistSync: GistSyncService,
) {
    const deleteClusterCmd = vscode.commands.registerCommand('kubectl-control.deleteCluster', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        const confirm = await vscode.window.showWarningMessage(
            `Cluster '${item.profile.name}' wirklich löschen?`,
            { modal: true },
            'Löschen'
        );
        if (confirm === 'Löschen') {
            await store.deleteCluster(item.profile.id);
            treeProvider.refresh();
        }
    });

    const editClusterCmd = vscode.commands.registerCommand('kubectl-control.editCluster', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        connectionsView.prefillEdit(
            item.profile.id,
            item.profile.name,
            item.profile.kubeconfigData,
            item.profile.group,
            item.profile.shell,
        );
        await vscode.commands.executeCommand('kubectl-control.connectionsView.focus');
    });

    const openTerminalCmd = vscode.commands.registerCommand('kubectl-control.openTerminal', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        await terminalManager.openOrFocus(item.profile);
    });

    // Quick-Switch: Ctrl+Shift+K — pick cluster from all saved, open/focus terminal
    const quickSwitchCmd = vscode.commands.registerCommand('kubectl-control.quickSwitch', async () => {
        const clusters = await store.getClusters();
        if (clusters.length === 0) {
            vscode.window.showInformationMessage('Keine gespeicherten Verbindungen vorhanden.');
            return;
        }
        const items = clusters.map(c => ({
            label: terminalManager.isOpen(c.id) ? `$(terminal) ${c.name}` : `$(server-environment) ${c.name}`,
            description: [c.group, c.namespace].filter(Boolean).join('  ·  '),
            detail: terminalManager.isOpen(c.id) ? 'Terminal bereits geöffnet – wird fokussiert' : undefined,
            cluster: c,
        }));
        const pick = await vscode.window.showQuickPick(items, {
            title: 'Kubectl Control – Quick Switch',
            placeHolder: 'Cluster auswählen…',
            matchOnDescription: true,
        });
        if (pick) { await terminalManager.openOrFocus(pick.cluster); }
    });

    const showLogsCmd = vscode.commands.registerCommand('kubectl-control.showLogs', () => {
        log.show();
    });


    const settingsMenuCmd = vscode.commands.registerCommand('kubectl-control.settingsMenu', async () => {
        const lockEnabled = await lockService.isEnabled();
        const lockUnlocked = lockService.isUnlocked();
        const syncEnabled = gistSync.isEnabled();

        const items: (vscode.QuickPickItem & { action: string })[] = [
            { label: '$(cloud-upload) Export (verschlüsselt)', description: 'Alle Verbindungen mit Passwort verschlüsselt exportieren', action: 'export' },
            { label: '$(cloud-download) Import', description: 'Verbindungen aus Datei importieren', action: 'import' },
            { kind: vscode.QuickPickItemKind.Separator, label: 'GitHub Sync', action: '' },
        ];

        if (syncEnabled) {
            items.push(
                { label: '$(sync) Jetzt synchronisieren', description: 'Verbindungen manuell zu GitHub hochladen', action: 'sync-now' },
                { label: '$(cloud-download) Von GitHub wiederherstellen', description: 'Verbindungen von GitHub herunterladen', action: 'sync-restore' },
                { label: '$(circle-slash) GitHub Sync deaktivieren', action: 'sync-disable' },
            );
        } else {
            items.push(
                { label: '$(github) GitHub Sync einrichten', description: 'Verbindungen automatisch in GitHub Gist synchronisieren', action: 'sync-setup' },
                { label: '$(cloud-download) Von GitHub wiederherstellen', description: 'Verbindungen von einem anderen Gerät importieren', action: 'sync-restore' },
            );
        }

        items.push({ kind: vscode.QuickPickItemKind.Separator, label: '', action: '' });

        if (lockEnabled) {
            items.push(
                { label: '$(key) Passwort ändern', action: 'lock-change' },
                { label: '$(unlock) Passwort-Schutz deaktivieren', action: 'lock-disable' },
                { kind: vscode.QuickPickItemKind.Separator, label: '', action: '' }
            );
            if (lockUnlocked) {
                items.push({ label: '$(lock) Erweiterung sperren', action: 'lock-now' });
            }
        } else {
            items.push({ label: '$(lock) Passwort-Schutz aktivieren', description: 'Erweiterung beim Öffnen sperren', action: 'lock-enable' });
        }

        items.push(
            { kind: vscode.QuickPickItemKind.Separator, label: '', action: '' },
            { label: '$(output) Debug-Logs anzeigen', description: 'Output-Panel mit Logs öffnen', action: 'logs' },
            { label: '$(trash) Anwendung zurücksetzen', description: 'Alle Verbindungen und Einstellungen löschen', action: 'reset' }
        );

        const pick = await vscode.window.showQuickPick(items, {
            title: 'Kubectl Control – Einstellungen',
            placeHolder: 'Aktion wählen'
        });
        if (!pick) { return; }

        switch (pick.action) {
            case 'export':       await handleExport(store); break;
            case 'import':       await handleImport(store, treeProvider); break;
            case 'sync-setup':   void gistSync.setupOrPush(); break;
            case 'sync-now':     void gistSync.setupOrPush(); break;
            case 'sync-restore': void gistSync.pull(); break;
            case 'sync-disable': void gistSync.disable(); break;
            case 'lock-enable':  await promptSetPassword(lockService); break;
            case 'lock-change':  await handleChangePassword(lockService); break;
            case 'lock-disable': await handleDisableLock(lockService); break;
            case 'lock-now':     lockService.lock(); break;
            case 'logs':         log.show(); break;
            case 'reset':        await handleReset(context, store, lockService, treeProvider, connectionsView); break;
        }
    });

    context.subscriptions.push(
        deleteClusterCmd, editClusterCmd, openTerminalCmd,
        quickSwitchCmd, showLogsCmd, settingsMenuCmd,
        vscode.commands.registerCommand('kubectl-control.syncNow',     () => void gistSync.setupOrPush()),
        vscode.commands.registerCommand('kubectl-control.syncRestore', () => void gistSync.pull()),
        vscode.commands.registerCommand('kubectl-control.syncDisable', () => void gistSync.disable()),
    );
}

async function handleExport(store: ClusterStore): Promise<void> {
    const password = await vscode.window.showInputBox({
        title: 'Export-Passwort festlegen',
        password: true,
        prompt: 'Passwort zum Verschlüsseln der Exportdatei (min. 6 Zeichen)',
        validateInput: v => (!v || v.length < 6) ? 'Mindestens 6 Zeichen erforderlich' : undefined
    });
    if (password === undefined) { return; }

    const confirm = await vscode.window.showInputBox({
        title: 'Passwort bestätigen',
        password: true,
        prompt: 'Passwort wiederholen',
        validateInput: v => v === password ? undefined : 'Passwörter stimmen nicht überein'
    });
    if (confirm !== password) { return; }

    const json = await store.exportClusters();
    const encrypted = encryptData(json, password);

    const uri = await vscode.window.showSaveDialog({
        filters: { 'Encrypted JSON': ['json'] },
        defaultUri: vscode.Uri.file('kubectl-control-export.json')
    });
    if (!uri) { return; }

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(encrypted, null, 2)));
    log.info(`Clusters exported to ${uri.fsPath}`);
    vscode.window.showInformationMessage('Export erfolgreich gespeichert (verschlüsselt).');
}

async function handleImport(store: ClusterStore, treeProvider: ClusterTreeDataProvider): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ filters: { 'JSON': ['json'] }, canSelectMany: false });
    if (!uris || uris.length === 0) { return; }
    await importFile(uris[0], store, () => treeProvider.refresh());
}

async function handleChangePassword(lockService: LockService): Promise<void> {
    const oldPwd = await vscode.window.showInputBox({ title: 'Altes Passwort', password: true, prompt: 'Aktuelles Passwort eingeben' });
    if (!oldPwd) { return; }

    const newPwd = await vscode.window.showInputBox({
        title: 'Neues Passwort',
        password: true,
        prompt: 'Neues Passwort (min. 6 Zeichen)',
        validateInput: v => (!v || v.length < 6) ? 'Mindestens 6 Zeichen erforderlich' : undefined
    });
    if (newPwd === undefined) { return; }

    const confirm = await vscode.window.showInputBox({
        title: 'Neues Passwort bestätigen',
        password: true,
        validateInput: v => v === newPwd ? undefined : 'Passwörter stimmen nicht überein'
    });
    if (confirm !== newPwd) { return; }

    const ok = await lockService.changePassword(oldPwd, newPwd);
    if (ok) {
        vscode.window.showInformationMessage('Passwort erfolgreich geändert.');
    } else {
        vscode.window.showErrorMessage('Altes Passwort ist falsch.');
    }
}

async function handleDisableLock(lockService: LockService): Promise<void> {
    const pwd = await vscode.window.showInputBox({
        title: 'Passwort-Schutz deaktivieren',
        password: true,
        prompt: 'Aktuelles Passwort zur Bestätigung eingeben'
    });
    if (!pwd) { return; }

    const ok = await lockService.disableLock(pwd);
    if (ok) {
        vscode.window.showInformationMessage('Passwort-Schutz deaktiviert.');
    } else {
        vscode.window.showErrorMessage('Falsches Passwort.');
    }
}

async function handleReset(
    context: vscode.ExtensionContext,
    store: ClusterStore,
    lockService: LockService,
    treeProvider: ClusterTreeDataProvider,
    connectionsView: ConnectionsViewProvider
): Promise<void> {
    const first = await vscode.window.showWarningMessage(
        'Anwendung zurücksetzen? Alle gespeicherten Verbindungen und Einstellungen werden gelöscht.',
        'Weiter'
    );
    if (first !== 'Weiter') { return; }

    const second = await vscode.window.showWarningMessage(
        'Bist du sicher? Diese Aktion kann nicht rückgängig gemacht werden.',
        { modal: true },
        'Ja, alles löschen'
    );
    if (second !== 'Ja, alles löschen') { return; }

    await store.clearAll();
    await lockService.disableLockForce();
    await resetSetup(context);
    connectionsView.setWelcomeMode(true);
    await connectionsView.refresh();
    treeProvider.refresh();
    log.info('Application reset by user');
}
