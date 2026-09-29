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
import { t, getLanguage } from './i18n';
import { ensureUnlocked, registerGuardedCommand } from './commandGuard';
import { ensureClusterExecTrusted, manageExecApprovals } from './execTrust';
import { MIN_PASSWORD_LENGTH, validateNewPassword } from './passwordPolicy';

export function registerCommands(
    context: vscode.ExtensionContext,
    store: ClusterStore,
    treeProvider: ClusterTreeDataProvider,
    connectionsView: ConnectionsViewProvider,
    lockService: LockService,
    terminalManager: TerminalManager,
    gistSync: GistSyncService,
) {
    const assertUnlocked = ensureUnlocked;

    const deleteClusterCmd = vscode.commands.registerCommand('kubectl-control.deleteCluster', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        if (!await assertUnlocked()) { return; }
        const btnDelete = t('Delete');
        const confirm = await vscode.window.showWarningMessage(
            t("Really delete cluster '{0}'?", item.profile.name),
            { modal: true },
            btnDelete
        );
        if (confirm === btnDelete) {
            // Close any open terminal session(s) for this connection before removing it.
            terminalManager.closeForCluster(item.profile.id);
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
            item.profile.promptColor,
        );
        await vscode.commands.executeCommand('kubectl-control.connectionsView.focus');
    });

    const openTerminalCmd = vscode.commands.registerCommand('kubectl-control.openTerminal', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        if (!await assertUnlocked()) { return; }
        await terminalManager.openOrFocus(item.profile);
    });

    // "+" inline action on a cluster row: always opens an additional terminal,
    // even if one (or more) is already open — unlike openTerminal, which focuses.
    const openNewTerminalCmd = vscode.commands.registerCommand('kubectl-control.openNewTerminal', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        if (!await assertUnlocked()) { return; }
        await terminalManager.openAdditional(item.profile);
    });

    // Closes every open terminal for a cluster at once. No lock check — closing
    // exposes nothing new, same as the other terminal-closing paths (e.g. deleteCluster).
    const closeAllTerminalsCmd = vscode.commands.registerCommand('kubectl-control.closeAllTerminals', (item: ClusterTreeItem) => {
        if (!item) { return; }
        const count = terminalManager.openCount(item.profile.id);
        if (count === 0) {
            vscode.window.showInformationMessage(t('No terminals are open for "{0}".', item.profile.name));
            return;
        }
        terminalManager.closeForCluster(item.profile.id);
    });

    // Search icon in the clustersView title bar: prompts for a name/namespace/group
    // substring and filters the tree. Mirrors the filter back into the InputBox so it's
    // editable, and tracks kubectl-control.hasClusterFilter so the title bar can swap
    // between the "Filter" and "Clear Filter" icons (see package.json when-clauses).
    const filterClustersCmd = registerGuardedCommand('kubectl-control.filterClusters', async () => {
        const input = await vscode.window.showInputBox({
            title: t('Filter Clusters'),
            prompt: t('Filter by name, namespace, or group'),
            value: treeProvider.getFilter(),
            placeHolder: t('e.g. prod, staging, team-a…'),
        });
        if (input === undefined) { return; } // cancelled — leave the existing filter as-is
        treeProvider.setFilter(input);
        await vscode.commands.executeCommand('setContext', 'kubectl-control.hasClusterFilter', treeProvider.getFilter() !== '');
    });

    const clearClusterFilterCmd = registerGuardedCommand('kubectl-control.clearClusterFilter', async () => {
        treeProvider.clearFilter();
        await vscode.commands.executeCommand('setContext', 'kubectl-control.hasClusterFilter', false);
    });

    // Quick-Switch: Ctrl+Shift+K — pick cluster from all saved, open/focus terminal
    const quickSwitchCmd = vscode.commands.registerCommand('kubectl-control.quickSwitch', async () => {
        if (!await assertUnlocked()) { return; }
        const clusters = await store.getClusters();
        if (clusters.length === 0) {
            vscode.window.showInformationMessage(t('No saved connections yet.'));
            return;
        }
        const items = clusters.map(c => ({
            label: terminalManager.isOpen(c.id) ? `$(terminal) ${c.name}` : `$(server-environment) ${c.name}`,
            description: [c.group, c.namespace].filter(Boolean).join('  ·  '),
            detail: terminalManager.isOpen(c.id) ? t('Terminal already open – focusing') : undefined,
            cluster: c,
        }));
        const pick = await vscode.window.showQuickPick(items, {
            title: t('Kubectl Control – Quick Switch'),
            placeHolder: t('Select cluster…'),
            matchOnDescription: true,
        });
        if (pick) { await terminalManager.openOrFocus(pick.cluster); }
    });

    // Deliberately NOT lock-guarded: the log is what you need when unlocking misbehaves,
    // and it never contains kubeconfigs or passwords.
    const showLogsCmd = vscode.commands.registerCommand('kubectl-control.showLogs', () => {
        log.show();
    });

    const manageExecApprovalsCmd = registerGuardedCommand('kubectl-control.manageExecApprovals', async () => {
        await manageExecApprovals(store);
        treeProvider.refresh();
    });

    const switchNamespaceCmd = vscode.commands.registerCommand('kubectl-control.switchNamespace', async () => {
        if (!await assertUnlocked()) { return; }
        const clusters = await store.getClusters();
        if (clusters.length === 0) {
            vscode.window.showInformationMessage(t('No saved connections yet.'));
            return;
        }
        const clusterItems = clusters.map(c => ({
            label: terminalManager.isOpen(c.id) ? `$(terminal) ${c.name}` : `$(server-environment) ${c.name}`,
            description: [c.group, c.namespace].filter(Boolean).join('  ·  '),
            cluster: c,
        }));
        const clusterPick = await vscode.window.showQuickPick(clusterItems, {
            title: t('Kubectl Control – Switch Namespace: Select Cluster'),
            placeHolder: t('Select cluster…'),
            matchOnDescription: true,
        });
        if (!clusterPick) { return; }

        const cluster = clusterPick.cluster;
        const currentNs = cluster.namespace ?? 'default';
        // Listing namespaces runs kubectl, i.e. the kubeconfig's credential plugin.
        if (!await ensureClusterExecTrusted(store, cluster)) { return; }

        const liveNamespaces = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('Loading namespaces…'), cancellable: false },
            () => fetchNamespaces(cluster),
        );
        const baseList = liveNamespaces.length > 0 ? liveNamespaces : FALLBACK_NAMESPACES;
        const suggestions = baseList.includes(currentNs) ? baseList : [currentNs, ...baseList];

        const nsItems = suggestions.map(ns => ({
            label: ns,
            description: ns === currentNs ? t('(current)') : undefined,
        }));
        const nsPick = await vscode.window.showQuickPick(nsItems, {
            title: t('Select namespace for "{0}"', cluster.name),
            placeHolder: currentNs,
            canPickMany: false,
        });
        if (!nsPick) { return; }

        const chosenNamespace = nsPick.label;
        const nsRegex = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
        if (!nsRegex.test(chosenNamespace) || chosenNamespace.length > 63) {
            vscode.window.showErrorMessage(t('Invalid namespace name: "{0}". Only lowercase letters, digits, and hyphens allowed (max. 63 characters).', chosenNamespace));
            return;
        }
        await store.updateCluster(cluster.id, { namespace: chosenNamespace });
        if (terminalManager.isOpen(cluster.id)) {
            terminalManager.sendToTerminal(cluster.id, `kubectl config set-context --current --namespace=${chosenNamespace}`);
        }
        vscode.window.showInformationMessage(t('Namespace for "{0}" set to "{1}".', cluster.name, chosenNamespace));
        treeProvider.refresh();
    });

    const togglePinCmd = registerGuardedCommand('kubectl-control.togglePin', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        const newPinned = !item.profile.pinned;
        await store.updateCluster(item.profile.id, { pinned: newPinned });
        treeProvider.refresh();
        if (newPinned) {
            vscode.window.showInformationMessage(t('"{0}" pinned.', item.profile.name));
        } else {
            vscode.window.showInformationMessage(t('"{0}" unpinned.', item.profile.name));
        }
    });

    const toggleProdCmd = registerGuardedCommand('kubectl-control.toggleProd', async (item: ClusterTreeItem) => {
        if (!item) { return; }
        const newIsProd = !item.profile.isProd;
        await store.updateCluster(item.profile.id, { isProd: newIsProd });
        treeProvider.refresh();
        if (newIsProd) {
            vscode.window.showInformationMessage(t('"{0}" marked as production environment.', item.profile.name));
        } else {
            vscode.window.showInformationMessage(t('"{0}" marking removed.', item.profile.name));
        }
    });


    const settingsMenuCmd = vscode.commands.registerCommand('kubectl-control.settingsMenu', async () => {
        const lockEnabled = await lockService.isEnabled();
        const lockUnlocked = lockService.isUnlocked();
        const syncEnabled = gistSync.isEnabled();

        const items: (vscode.QuickPickItem & { action: string })[] = [
            { label: t('$(cloud-upload) Export (encrypted)'), description: t('Export all connections encrypted with a password'), action: 'export' },
            { label: t('$(cloud-download) Import'), description: t('Import connections from a file'), action: 'import' },
            { label: t('$(folder) Import from ~/.kube/config'), description: t('Import local kubectl contexts'), action: 'import-kubeconfig' },
            { kind: vscode.QuickPickItemKind.Separator, label: 'GitHub Sync', action: '' },
        ];

        if (syncEnabled) {
            items.push(
                { label: t('$(sync) Sync Now'), description: t('Manually upload connections to GitHub'), action: 'sync-now' },
                { label: t('$(cloud-download) Restore from GitHub'), description: t('Download connections from GitHub'), action: 'sync-restore' },
                { label: t('$(circle-slash) Disable GitHub Sync'), action: 'sync-disable' },
            );
        } else {
            items.push(
                { label: t('$(github) Set Up GitHub Sync'), description: t('Automatically sync connections to a GitHub Gist'), action: 'sync-setup' },
                { label: t('$(cloud-download) Restore from GitHub'), description: t('Import connections from another device'), action: 'sync-restore' },
            );
        }

        items.push({ kind: vscode.QuickPickItemKind.Separator, label: '', action: '' });

        if (lockEnabled) {
            items.push(
                { label: t('$(key) Change Password'), action: 'lock-change' },
                { label: t('$(unlock) Disable Password Protection'), action: 'lock-disable' },
                { kind: vscode.QuickPickItemKind.Separator, label: '', action: '' }
            );
            if (lockUnlocked) {
                items.push({ label: t('$(lock) Lock Extension'), action: 'lock-now' });
            }
        } else {
            items.push({ label: t('$(lock) Enable Password Protection'), description: t('Lock extension on open'), action: 'lock-enable' });
        }

        const languageNames: Record<string, string> = { en: t('English'), de: t('German') };
        const languageSetting = vscode.workspace.getConfiguration('kubectl-control').get<string>('language', 'auto');
        const languageLabel = languageSetting === 'auto'
            ? t('Auto ({0})', languageNames[getLanguage()] ?? getLanguage())
            : (languageNames[languageSetting] ?? languageSetting);

        items.push(
            { kind: vscode.QuickPickItemKind.Separator, label: t('Cluster'), action: '' },
            { label: t('$(symbol-namespace) Switch Namespace'), description: t('Change the namespace for a cluster'), action: 'switch-namespace' },
            { kind: vscode.QuickPickItemKind.Separator, label: t('Settings'), action: '' },
            { label: t('$(globe) Language: {0}', languageLabel), description: t('Click to switch: Auto → English → German'), action: 'cycle-language' },
            { label: t('$(settings-gear) Open Settings'), description: t('Auto-lock, status interval, terminal prompt …'), action: 'vscode-settings' },
            { label: t('$(shield) Credential Plugin Approvals'), description: t('Review, approve or revoke exec/auth-provider commands'), action: 'exec-approvals' },
            { label: t('$(output) Show Debug Logs'), description: t('Open the Output panel with logs'), action: 'logs' },
            { label: t('$(trash) Reset Application'), description: t('Delete all connections and settings'), action: 'reset' }
        );

        const pick = await vscode.window.showQuickPick(items, {
            title: t('Kubectl Control – Settings'),
            placeHolder: t('Select action')
        });
        if (!pick) { return; }

        // SECURITY: these actions read, export or replace connection data and must not
        // work while locked (export used to hand out every kubeconfig without unlocking).
        // 'reset' stays available as the forgotten-password escape hatch; it only deletes.
        const needsUnlock = new Set(['export', 'import', 'import-kubeconfig', 'sync-setup', 'sync-now', 'sync-restore', 'sync-disable', 'exec-approvals']);
        if (needsUnlock.has(pick.action) && !await assertUnlocked()) { return; }

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
            case 'cycle-language': await cycleLanguage(); break;
            case 'vscode-settings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:tommmy-ctrl.kubectl-control'); break;
            case 'logs':         log.show(); break;
            case 'exec-approvals': await manageExecApprovals(store); treeProvider.refresh(); break;
            case 'reset':        await handleReset(context, store, lockService, treeProvider, connectionsView); break;
        }
    });

    context.subscriptions.push(
        deleteClusterCmd, editClusterCmd, openTerminalCmd, openNewTerminalCmd, closeAllTerminalsCmd,
        filterClustersCmd, clearClusterFilterCmd,
        quickSwitchCmd, showLogsCmd, manageExecApprovalsCmd, settingsMenuCmd,
        switchNamespaceCmd, togglePinCmd, toggleProdCmd,
        registerGuardedCommand('kubectl-control.syncNow',     () => void gistSync.setupOrPush().catch(e => log.error(`syncNow failed: ${e}`))),
        registerGuardedCommand('kubectl-control.syncRestore', () => void gistSync.pull().catch(e => log.error(`syncRestore failed: ${e}`))),
        registerGuardedCommand('kubectl-control.syncDisable', () => void gistSync.disable().catch(e => log.error(`syncDisable failed: ${e}`))),
    );
}

async function cycleLanguage(): Promise<void> {
    const order = ['auto', 'en', 'de'] as const;
    const config = vscode.workspace.getConfiguration('kubectl-control');
    const current = config.get<string>('language', 'auto');
    const currentIndex = order.indexOf(current as typeof order[number]);
    const next = order[(currentIndex + 1) % order.length];
    await config.update('language', next, vscode.ConfigurationTarget.Global);
}

async function handleExport(store: ClusterStore): Promise<void> {
    const password = await vscode.window.showInputBox({
        title: t('Set Export Password'),
        password: true,
        prompt: t('Password to encrypt the export file (min. {0} characters)', MIN_PASSWORD_LENGTH),
        validateInput: validateNewPassword
    });
    if (password === undefined) { return; }

    const confirm = await vscode.window.showInputBox({
        title: t('Confirm Password'),
        password: true,
        prompt: t('Repeat password'),
        validateInput: v => v === password ? undefined : t('Passwords do not match')
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
    vscode.window.showInformationMessage(t('Export saved successfully (encrypted).'));
}

async function handleImport(store: ClusterStore, treeProvider: ClusterTreeDataProvider): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ filters: { 'JSON': ['json'] }, canSelectMany: false });
    if (!uris || uris.length === 0) { return; }
    await importFile(uris[0], store, () => treeProvider.refresh());
}

async function handleChangePassword(lockService: LockService): Promise<void> {
    const oldPwd = await vscode.window.showInputBox({ title: t('Old Password'), password: true, prompt: t('Enter current password') });
    if (!oldPwd) { return; }

    const newPwd = await vscode.window.showInputBox({
        title: t('New Password'),
        password: true,
        prompt: t('New password (min. {0} characters)', MIN_PASSWORD_LENGTH),
        validateInput: validateNewPassword
    });
    if (newPwd === undefined) { return; }

    const confirm = await vscode.window.showInputBox({
        title: t('Confirm New Password'),
        password: true,
        validateInput: v => v === newPwd ? undefined : t('Passwords do not match')
    });
    if (confirm !== newPwd) { return; }

    const ok = await lockService.changePassword(oldPwd, newPwd);
    if (ok) {
        vscode.window.showInformationMessage(t('Password changed successfully.'));
    } else {
        vscode.window.showErrorMessage(t('Old password is incorrect.'));
    }
}

async function handleDisableLock(lockService: LockService): Promise<void> {
    const pwd = await vscode.window.showInputBox({
        title: t('Disable Password Protection'),
        password: true,
        prompt: t('Enter current password to confirm')
    });
    if (!pwd) { return; }

    const ok = await lockService.disableLock(pwd);
    if (ok) {
        vscode.window.showInformationMessage(t('Password protection disabled.'));
    } else {
        vscode.window.showErrorMessage(t('Incorrect password.'));
    }
}

async function handleReset(
    context: vscode.ExtensionContext,
    store: ClusterStore,
    lockService: LockService,
    treeProvider: ClusterTreeDataProvider,
    connectionsView: ConnectionsViewProvider
): Promise<void> {
    const btnContinue = t('Continue');
    const first = await vscode.window.showWarningMessage(
        t('Reset application? All saved connections and settings will be deleted.'),
        btnContinue
    );
    if (first !== btnContinue) { return; }

    const btnDeleteEverything = t('Yes, delete everything');
    const second = await vscode.window.showWarningMessage(
        t('Are you sure? This action cannot be undone.'),
        { modal: true },
        btnDeleteEverything
    );
    if (second !== btnDeleteEverything) { return; }

    await store.clearAll();
    await lockService.disableLockForce();
    await resetSetup(context);
    connectionsView.setWelcomeMode(true);
    await connectionsView.refresh();
    treeProvider.refresh();
    log.info('Application reset by user');
}
