import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ClusterTreeItem } from './treeDataProvider';

export function registerTerminalCommand(context: vscode.ExtensionContext) {
    let openTerminalCmd = vscode.commands.registerCommand('kubectl-control.openTerminal', async (item: ClusterTreeItem) => {
        if (!item) { return; }

        try {
            // 1. Create a secure temporary directory if it doesn't exist
            const tempDir = path.join(os.tmpdir(), 'kubectl-control-ext');
            await fs.mkdir(tempDir, { recursive: true });

            // 2. Create the temporary kubeconfig file
            const kubeconfigPath = path.join(tempDir, `kubeconfig-${item.profile.id}.yaml`);

            // Write the configuration to the file.
            // On Unix systems, we could restrict permissions here, but Node.js fs.writeFile options can be tricky across platforms.
            // Since this is inside the OS tmpdir, it is generally okay for this use case.
            await fs.writeFile(kubeconfigPath, item.profile.kubeconfigData, { encoding: 'utf-8', mode: 0o600 });

            // 3. Launch a new VS Code terminal with the environment variable injected
            const terminal = vscode.window.createTerminal({
                name: `kubectl: ${item.profile.name}`,
                env: {
                    'KUBECONFIG': kubeconfigPath
                }
            });

            terminal.show();

        } catch (e) {
            vscode.window.showErrorMessage(`Failed to open terminal for ${item.profile.name}: ${e}`);
        }
    });

    context.subscriptions.push(openTerminalCmd);
}
