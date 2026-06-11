import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { ClusterTreeDataProvider } from './treeDataProvider';
import { registerCommands } from './commands';
import { registerTerminalCommand } from './terminal';

export function activate(context: vscode.ExtensionContext) {
    const store = new ClusterStore(context);
    const treeProvider = new ClusterTreeDataProvider(store);

    vscode.window.registerTreeDataProvider('kubectl-control.clustersView', treeProvider);

    registerCommands(context, store, treeProvider);
    registerTerminalCommand(context);
}

export function deactivate() {}
