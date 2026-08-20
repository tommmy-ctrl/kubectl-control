import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { ClusterTreeDataProvider } from './treeDataProvider';
import { registerCommands } from './commands';
import { ConnectionsViewProvider } from './connectionsView';
import { LockService } from './lockService';
import { TerminalManager } from './terminalManager';
import { GistSyncService } from './gistSync';
import { ClusterStatusService } from './clusterStatus';
import { isSetupDone, markSetupDone } from './setup';
import { log } from './logger';
import { registerResourceViewer } from './features/resourceViewer';
import { registerPortForward } from './features/portForward';
import { registerHelmBrowser } from './features/helmBrowser';
import { registerRbacViewer } from './features/rbacViewer';
import { t, refreshLanguage } from './i18n';

export function activate(context: vscode.ExtensionContext) {
    const extensionVersion = String(context.extension.packageJSON.version ?? 'unknown');
    log.info(`kubectl-control activating… v${extensionVersion}`);

    const store = new ClusterStore(context);
    const lockService = new LockService(context.secrets);
    void lockService.init(); // restore persisted brute-force counters
    const autoLockMinutes = vscode.workspace.getConfiguration('kubectl-control').get<number>('autoLockMinutes', 0);
    lockService.setAutoLock(autoLockMinutes);
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('kubectl-control.autoLockMinutes')) {
                lockService.setAutoLock(vscode.workspace.getConfiguration('kubectl-control').get<number>('autoLockMinutes', 0));
            }
            if (e.affectsConfiguration('kubectl-control.language')) {
                refreshLanguage();
                void vscode.window.showInformationMessage(
                    t('Language changed. Reload the window to apply it everywhere.'),
                    t('Reload Window'),
                ).then(choice => {
                    if (choice === t('Reload Window')) {
                        void vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            }
        })
    );
    const terminalManager = new TerminalManager(store);
    terminalManager.cleanupOrphanedTempFiles().catch(e => log.warn('Temp cleanup on startup failed', e));
    const gistSync = new GistSyncService(store, context.secrets, context.globalState);
    const clusterStatusService = new ClusterStatusService(store, terminalManager);
    const treeProvider = new ClusterTreeDataProvider(store, terminalManager, lockService, clusterStatusService);
    const connectionsViewProvider = new ConnectionsViewProvider(
        context.extensionUri, store, lockService, () => treeProvider.refresh(), extensionVersion
    );

    const welcomeMode = !isSetupDone(context);
    if (welcomeMode) {
        connectionsViewProvider.setWelcomeMode(true);
        void markSetupDone(context);
    }
    void vscode.commands.executeCommand('setContext', 'kubectl-control.showClusters', !welcomeMode);

    vscode.window.registerTreeDataProvider('kubectl-control.clustersView', treeProvider);

    const activeClusterStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    activeClusterStatus.command = 'kubectl-control.quickSwitch';
    activeClusterStatus.tooltip = t('Active cluster – click to switch');
    context.subscriptions.push(activeClusterStatus);

    context.subscriptions.push(
        terminalManager.onActiveChange(async (clusterId) => {
            if (!clusterId) {
                activeClusterStatus.hide();
                return;
            }
            const clusters = await store.getClusters();
            const cluster = clusters.find(c => c.id === clusterId);
            if (cluster) {
                const prodBadge = cluster.isProd ? ' 🔴' : '';
                const namespaceSuffix = cluster.namespace ? ` · ${cluster.namespace}` : '';
                activeClusterStatus.text = `$(terminal) ${cluster.name}${namespaceSuffix}${prodBadge}`;
                activeClusterStatus.tooltip = cluster.namespace
                    ? t('Active cluster: {0} · {1} – click to switch', cluster.name, cluster.namespace)
                    : t('Active cluster – click to switch');
                activeClusterStatus.show();
            }
        }),
        vscode.window.registerWebviewViewProvider(ConnectionsViewProvider.viewType, connectionsViewProvider),
        terminalManager,
        gistSync,
        clusterStatusService,
    );

    registerCommands(context, store, treeProvider, connectionsViewProvider, lockService, terminalManager, gistSync);
    context.subscriptions.push(
        ...registerResourceViewer(context, store),
        ...registerPortForward(context, store),
        ...registerHelmBrowser(context, store),
        ...registerRbacViewer(context, store),
    );
    log.info('kubectl-control activated');
}

export function deactivate() {}
