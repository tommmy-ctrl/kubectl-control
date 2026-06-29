import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { ClusterTreeDataProvider, ClusterTreeItem } from './treeDataProvider';
import { ConnectionsViewProvider } from './connectionsView';
import { LockService } from './lockService';
import { TerminalManager } from './terminalManager';
import { encryptData } from './crypto';
import { importFile, promptSetPassword, resetSetup, handleImportFromKubeconfig } from './setup';
import { GistSyncService } from './gistSync';
import { log } from './logger';
import { fetchNamespaces, FALLBACK_NAMESPACES } from './features/namespaceBrowser';

export function registerCommands(
    context: vscode.ExtensionContext,
    store: ClusterStore,
    treeProvider: ClusterTreeDataProvider,
    connectionsView: ConnectionsViewProvider,
    lockService: LockService,
    terminalManager: TerminalManager,
    gistSync: GistSyncService,
) {
    const assertUnlocked = async (): Promise<boolean> => {
        if (!await lockService.isEnabled()) { lockService.recordActivity(); return true; }
        if (lockService.isUnlocked()) { lockService.recordActivity(); return true; }
        await vscode.commands.executeCommand('kubectl-control.connectionsView.focus');
        vscode.window.showWarningMessage(vscode.l10n.t('Kubectl Control ist gesperrt. Bitte zuerst entsperren.'));
        return false;
    };

    const deleteClusterCmd = vscode.commands.registerCommand('kubectl-control.deleteCluster', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        if (!await assertUnlocked()) { return; }
        const btnDelete = vscode.l10n.t('Löschen');
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Cluster '{0}' wirklich löschen?", item.profile.name),
            { modal: true },
            btnDelete
        );
        if (confirm === btnDelete) {
            await store.deleteCluster(item.profile.id);
            treeProvider.refresh();
        }
    });

    const editClusterCmd = vscode.commands.registerCommand('kubectl-control.editCluster', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        if (!await assertUnlocked()) { return; }
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
        if (!await assertUnlocked()) { return; }
        await terminalManager.openOrFocus(item.profile);
    });

    // Quick-Switch: Ctrl+Shift+K — pick cluster from all saved, open/focus terminal
    const quickSwitchCmd = vscode.commands.registerCommand('kubectl-control.quickSwitch', async () => {
        if (!await assertUnlocked()) { return; }
        const clusters = await store.getClusters();
        if (clusters.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('Keine gespeicherten Verbindungen vorhanden.'));
            return;
        }
        const items = clusters.map(c => ({
            label: terminalManager.isOpen(c.id) ? `$(terminal) ${c.name}` : `$(server-environment) ${c.name}`,
            description: [c.group, c.namespace].filter(Boolean).join('  ·  '),
            detail: terminalManager.isOpen(c.id) ? vscode.l10n.t('Terminal bereits geöffnet – wird fokussiert') : undefined,
            cluster: c,
        }));
        const pick = await vscode.window.showQuickPick(items, {
            title: vscode.l10n.t('Kubectl Control – Quick Switch'),
            placeHolder: vscode.l10n.t('Cluster auswählen…'),
            matchOnDescription: true,
        });
        if (pick) { await terminalManager.openOrFocus(pick.cluster); }
    });

    const showLogsCmd = vscode.commands.registerCommand('kubectl-control.showLogs', () => {
        log.show();
    });

    const switchNamespaceCmd = vscode.commands.registerCommand('kubectl-control.switchNamespace', async () => {
        if (!await assertUnlocked()) { return; }
        const clusters = await store.getClusters();
        if (clusters.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('Keine gespeicherten Verbindungen vorhanden.'));
            return;
        }
        const clusterItems = clusters.map(c => ({
            label: terminalManager.isOpen(c.id) ? `$(terminal) ${c.name}` : `$(server-environment) ${c.name}`,
            description: [c.group, c.namespace].filter(Boolean).join('  ·  '),
            cluster: c,
        }));
        const clusterPick = await vscode.window.showQuickPick(clusterItems, {
            title: vscode.l10n.t('Kubectl Control – Namespace wechseln: Cluster wählen'),
            placeHolder: vscode.l10n.t('Cluster auswählen…'),
            matchOnDescription: true,
        });
        if (!clusterPick) { return; }

        const cluster = clusterPick.cluster;
        const currentNs = cluster.namespace ?? 'default';

        const liveNamespaces = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Namespaces werden geladen…'), cancellable: false },
            () => fetchNamespaces(cluster),
        );
        const baseList = liveNamespaces.length > 0 ? liveNamespaces : FALLBACK_NAMESPACES;
        const suggestions = baseList.includes(currentNs) ? baseList : [currentNs, ...baseList];

        const nsItems = suggestions.map(ns => ({
            label: ns,
            description: ns === currentNs ? vscode.l10n.t('(aktuell)') : undefined,
        }));
        const nsPick = await vscode.window.showQuickPick(nsItems, {
            title: vscode.l10n.t('Namespace für "{0}" wählen', cluster.name),
            placeHolder: currentNs,
            canPickMany: false,
        });
        if (!nsPick) { return; }

        const chosenNamespace = nsPick.label;
        const nsRegex = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
        if (!nsRegex.test(chosenNamespace) || chosenNamespace.length > 63) {
            vscode.window.showErrorMessage(vscode.l10n.t('Ungültiger Namespace-Name: "{0}". Nur Kleinbuchstaben, Ziffern und Bindestriche erlaubt (max. 63 Zeichen).', chosenNamespace));
            return;
        }
        await store.updateCluster(cluster.id, { namespace: chosenNamespace });
        if (terminalManager.isOpen(cluster.id)) {
            terminalManager.sendToTerminal(cluster.id, `kubectl config set-context --current --namespace=${chosenNamespace}`);
        }
        vscode.window.showInformationMessage(vscode.l10n.t('Namespace für "{0}" auf "{1}" gesetzt.', cluster.name, chosenNamespace));
        treeProvider.refresh();
    });

    const togglePinCmd = vscode.commands.registerCommand('kubectl-control.togglePin', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        const newPinned = !item.profile.pinned;
        await store.updateCluster(item.profile.id, { pinned: newPinned });
        treeProvider.refresh();
        if (newPinned) {
            vscode.window.showInformationMessage(vscode.l10n.t('"{0}" angepinnt.', item.profile.name));
        } else {
            vscode.window.showInformationMessage(vscode.l10n.t('"{0}" losgelöst.', item.profile.name));
        }
    });

    const toggleProdCmd = vscode.commands.registerCommand('kubectl-control.toggleProd', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        const newIsProd = !item.profile.isProd;
        await store.updateCluster(item.profile.id, { isProd: newIsProd });
        treeProvider.refresh();
        if (newIsProd) {
            vscode.window.showInformationMessage(vscode.l10n.t('"{0}" als Produktionsumgebung markiert.', item.profile.name));
        } else {
            vscode.window.showInformationMessage(vscode.l10n.t('"{0}" Markierung entfernt.', item.profile.name));
        }
    });


    const settingsMenuCmd = vscode.commands.registerCommand('kubectl-control.settingsMenu', async () => {
        const lockEnabled = await lockService.isEnabled();
        const lockUnlocked = lockService.isUnlocked();
        const syncEnabled = gistSync.isEnabled();

        const items: (vscode.QuickPickItem & { action: string })[] = [
            { label: vscode.l10n.t('$(cloud-upload) Export (verschlüsselt)'), description: vscode.l10n.t('Alle Verbindungen mit Passwort verschlüsselt exportieren'), action: 'export' },
            { label: vscode.l10n.t('$(cloud-download) Import'), description: vscode.l10n.t('Verbindungen aus Datei importieren'), action: 'import' },
            { label: vscode.l10n.t('$(folder) Aus ~/.kube/config importieren'), description: vscode.l10n.t('Lokale kubectl-Contexts übernehmen'), action: 'import-kubeconfig' },
            { kind: vscode.QuickPickItemKind.Separator, label: 'GitHub Sync', action: '' },
        ];

        if (syncEnabled) {
            items.push(
                { label: vscode.l10n.t('$(sync) Jetzt synchronisieren'), description: vscode.l10n.t('Verbindungen manuell zu GitHub hochladen'), action: 'sync-now' },
                { label: vscode.l10n.t('$(cloud-download) Von GitHub wiederherstellen'), description: vscode.l10n.t('Verbindungen von GitHub herunterladen'), action: 'sync-restore' },
                { label: vscode.l10n.t('$(circle-slash) GitHub Sync deaktivieren'), action: 'sync-disable' },
            );
        } else {
            items.push(
                { label: vscode.l10n.t('$(github) GitHub Sync einrichten'), description: vscode.l10n.t('Verbindungen automatisch in GitHub Gist synchronisieren'), action: 'sync-setup' },
                { label: vscode.l10n.t('$(cloud-download) Von GitHub wiederherstellen'), description: vscode.l10n.t('Verbindungen von einem anderen Gerät importieren'), action: 'sync-restore' },
            );
        }

        items.push({ kind: vscode.QuickPickItemKind.Separator, label: '', action: '' });

        if (lockEnabled) {
            items.push(
                { label: vscode.l10n.t('$(key) Passwort ändern'), action: 'lock-change' },
                { label: vscode.l10n.t('$(unlock) Passwort-Schutz deaktivieren'), action: 'lock-disable' },
                { kind: vscode.QuickPickItemKind.Separator, label: '', action: '' }
            );
            if (lockUnlocked) {
                items.push({ label: vscode.l10n.t('$(lock) Erweiterung sperren'), action: 'lock-now' });
            }
        } else {
            items.push({ label: vscode.l10n.t('$(lock) Passwort-Schutz aktivieren'), description: vscode.l10n.t('Erweiterung beim Öffnen sperren'), action: 'lock-enable' });
        }

        items.push(
            { kind: vscode.QuickPickItemKind.Separator, label: vscode.l10n.t('Cluster'), action: '' },
            { label: vscode.l10n.t('$(symbol-namespace) Namespace wechseln'), description: vscode.l10n.t('Namespace für einen Cluster ändern'), action: 'switch-namespace' },
            { kind: vscode.QuickPickItemKind.Separator, label: '', action: '' },
            { label: vscode.l10n.t('$(output) Debug-Logs anzeigen'), description: vscode.l10n.t('Output-Panel mit Logs öffnen'), action: 'logs' },
            { label: vscode.l10n.t('$(trash) Anwendung zurücksetzen'), description: vscode.l10n.t('Alle Verbindungen und Einstellungen löschen'), action: 'reset' }
        );

        const pick = await vscode.window.showQuickPick(items, {
            title: vscode.l10n.t('Kubectl Control – Einstellungen'),
            placeHolder: vscode.l10n.t('Aktion wählen')
        });
        if (!pick) { return; }

        switch (pick.action) {
            case 'export':            await handleExport(store); break;
            case 'import':            await handleImport(store, treeProvider); break;
            case 'import-kubeconfig': await handleImportFromKubeconfig(store, () => treeProvider.refresh()); break;
            case 'sync-setup':   void gistSync.setupOrPush().catch(e => log.error(`sync-setup failed: ${e}`)); break;
            case 'sync-now':     void gistSync.setupOrPush().catch(e => log.error(`sync-now failed: ${e}`)); break;
            case 'sync-restore': void gistSync.pull().catch(e => log.error(`sync-restore failed: ${e}`)); break;
            case 'sync-disable': void gistSync.disable().catch(e => log.error(`sync-disable failed: ${e}`)); break;
            case 'lock-enable':  await promptSetPassword(lockService); break;
            case 'lock-change':  await handleChangePassword(lockService); break;
            case 'lock-disable': await handleDisableLock(lockService); break;
            case 'lock-now':     lockService.lock(); break;
            case 'switch-namespace': await vscode.commands.executeCommand('kubectl-control.switchNamespace'); break;
            case 'logs':         log.show(); break;
            case 'reset':        await handleReset(context, store, lockService, treeProvider, connectionsView); break;
        }
    });

    context.subscriptions.push(
        deleteClusterCmd, editClusterCmd, openTerminalCmd,
        quickSwitchCmd, showLogsCmd, settingsMenuCmd,
        switchNamespaceCmd, togglePinCmd, toggleProdCmd,
        vscode.commands.registerCommand('kubectl-control.syncNow',     () => void gistSync.setupOrPush().catch(e => log.error(`syncNow failed: ${e}`))),
        vscode.commands.registerCommand('kubectl-control.syncRestore', () => void gistSync.pull().catch(e => log.error(`syncRestore failed: ${e}`))),
        vscode.commands.registerCommand('kubectl-control.syncDisable', () => void gistSync.disable().catch(e => log.error(`syncDisable failed: ${e}`))),
    );
}

async function handleExport(store: ClusterStore): Promise<void> {
    const password = await vscode.window.showInputBox({
        title: vscode.l10n.t('Export-Passwort festlegen'),
        password: true,
        prompt: vscode.l10n.t('Passwort zum Verschlüsseln der Exportdatei (min. 6 Zeichen)'),
        validateInput: v => (!v || v.length < 6) ? vscode.l10n.t('Mindestens 6 Zeichen erforderlich') : undefined
    });
    if (password === undefined) { return; }

    const confirm = await vscode.window.showInputBox({
        title: vscode.l10n.t('Passwort bestätigen'),
        password: true,
        prompt: vscode.l10n.t('Passwort wiederholen'),
        validateInput: v => v === password ? undefined : vscode.l10n.t('Passwörter stimmen nicht überein')
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
    vscode.window.showInformationMessage(vscode.l10n.t('Export erfolgreich gespeichert (verschlüsselt).'));
}

async function handleImport(store: ClusterStore, treeProvider: ClusterTreeDataProvider): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ filters: { 'JSON': ['json'] }, canSelectMany: false });
    if (!uris || uris.length === 0) { return; }
    await importFile(uris[0], store, () => treeProvider.refresh());
}

async function handleChangePassword(lockService: LockService): Promise<void> {
    const oldPwd = await vscode.window.showInputBox({ title: vscode.l10n.t('Altes Passwort'), password: true, prompt: vscode.l10n.t('Aktuelles Passwort eingeben') });
    if (!oldPwd) { return; }

    const newPwd = await vscode.window.showInputBox({
        title: vscode.l10n.t('Neues Passwort'),
        password: true,
        prompt: vscode.l10n.t('Neues Passwort (min. 6 Zeichen)'),
        validateInput: v => (!v || v.length < 6) ? vscode.l10n.t('Mindestens 6 Zeichen erforderlich') : undefined
    });
    if (newPwd === undefined) { return; }

    const confirm = await vscode.window.showInputBox({
        title: vscode.l10n.t('Neues Passwort bestätigen'),
        password: true,
        validateInput: v => v === newPwd ? undefined : vscode.l10n.t('Passwörter stimmen nicht überein')
    });
    if (confirm !== newPwd) { return; }

    const ok = await lockService.changePassword(oldPwd, newPwd);
    if (ok) {
        vscode.window.showInformationMessage(vscode.l10n.t('Passwort erfolgreich geändert.'));
    } else {
        vscode.window.showErrorMessage(vscode.l10n.t('Altes Passwort ist falsch.'));
    }
}

async function handleDisableLock(lockService: LockService): Promise<void> {
    const pwd = await vscode.window.showInputBox({
        title: vscode.l10n.t('Passwort-Schutz deaktivieren'),
        password: true,
        prompt: vscode.l10n.t('Aktuelles Passwort zur Bestätigung eingeben')
    });
    if (!pwd) { return; }

    const ok = await lockService.disableLock(pwd);
    if (ok) {
        vscode.window.showInformationMessage(vscode.l10n.t('Passwort-Schutz deaktiviert.'));
    } else {
        vscode.window.showErrorMessage(vscode.l10n.t('Falsches Passwort.'));
    }
}

async function handleReset(
    context: vscode.ExtensionContext,
    store: ClusterStore,
    lockService: LockService,
    treeProvider: ClusterTreeDataProvider,
    connectionsView: ConnectionsViewProvider
): Promise<void> {
    const btnWeiter = vscode.l10n.t('Weiter');
    const first = await vscode.window.showWarningMessage(
        vscode.l10n.t('Anwendung zurücksetzen? Alle gespeicherten Verbindungen und Einstellungen werden gelöscht.'),
        btnWeiter
    );
    if (first !== btnWeiter) { return; }

    const btnJaAllesLoeschen = vscode.l10n.t('Ja, alles löschen');
    const second = await vscode.window.showWarningMessage(
        vscode.l10n.t('Bist du sicher? Diese Aktion kann nicht rückgängig gemacht werden.'),
        { modal: true },
        btnJaAllesLoeschen
    );
    if (second !== btnJaAllesLoeschen) { return; }

    await store.clearAll();
    await lockService.disableLockForce();
    await resetSetup(context);
    connectionsView.setWelcomeMode(true);
    await connectionsView.refresh();
    treeProvider.refresh();
    log.info('Application reset by user');
}
