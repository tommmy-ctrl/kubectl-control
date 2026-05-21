import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { ClusterTreeDataProvider, ClusterTreeItem } from './treeDataProvider';

export function registerCommands(context: vscode.ExtensionContext, store: ClusterStore, treeProvider: ClusterTreeDataProvider) {

    // Add Cluster Command
    let addClusterCmd = vscode.commands.registerCommand('kubectl-control.addCluster', async () => {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter a name for the Kubernetes Cluster',
            placeHolder: 'e.g. Production, Staging, Minikube'
        });

        if (!name) {
            return; // Cancelled
        }

        // Open an untitled document so the user can paste their Kubeconfig
        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'yaml' });
        const editor = await vscode.window.showTextDocument(doc);

        vscode.window.showInformationMessage('Please paste your kubeconfig content here, then save and close the tab to complete adding the cluster.');

        // Wait for the document to be saved or closed
        const disposable = vscode.workspace.onDidCloseTextDocument(async (closedDoc) => {
            if (closedDoc === doc) {
                const content = closedDoc.getText().trim();
                if (content.length > 0) {
                    await store.addCluster(name, content);
                    treeProvider.refresh();
                    vscode.window.showInformationMessage(`Cluster '${name}' added successfully!`);
                } else {
                    vscode.window.showWarningMessage('Kubeconfig content was empty. Cluster not added.');
                }
                disposable.dispose();
            }
        });
    });

    // Delete Cluster Command
    let deleteClusterCmd = vscode.commands.registerCommand('kubectl-control.deleteCluster', async (item: ClusterTreeItem) => {
        if (!item) { return; }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the cluster '${item.profile.name}'?`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            await store.deleteCluster(item.profile.id);
            treeProvider.refresh();
        }
    });

    context.subscriptions.push(addClusterCmd, deleteClusterCmd);
}
