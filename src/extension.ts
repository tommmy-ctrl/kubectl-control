import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { ClusterTreeDataProvider } from './treeDataProvider';
import { registerCommands } from './commands';
import { ConnectionsViewProvider } from './connectionsView';
import { LockService } from './lockService';
import { TerminalManager } from './terminalManager';
import { isSetupDone, markSetupDone } from './setup';
import { log } from './logger';

export function activate(context: vscode.ExtensionContext) {
    log.info('kubectl-control activating…');

    const store = new ClusterStore(context);
    const lockService = new LockService(context.secrets);
    const terminalManager = new TerminalManager();
    const treeProvider = new ClusterTreeDataProvider(store, terminalManager, lockService);
    const connectionsViewProvider = new ConnectionsViewProvider(
        context.extensionUri, store, lockService, () => treeProvider.refresh()
    );

    const welcomeMode = !isSetupDone(context);
    if (welcomeMode) {
        connectionsViewProvider.setWelcomeMode(true);
        void markSetupDone(context);
    }
    void vscode.commands.executeCommand('setContext', 'kubectl-control.showClusters', !welcomeMode);

    vscode.window.registerTreeDataProvider('kubectl-control.clustersView', treeProvider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ConnectionsViewProvider.viewType, connectionsViewProvider),
        terminalManager,
    );

    registerCommands(context, store, treeProvider, connectionsViewProvider, lockService, terminalManager);
    log.info('kubectl-control activated');
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivate() {}
