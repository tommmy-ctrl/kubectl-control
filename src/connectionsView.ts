import * as vscode from 'vscode';
import * as nodeCrypto from 'node:crypto';
import { ClusterStore, ShellType } from './store';
import { LockService } from './lockService';
import { importFile, promptSetPassword, handleImportFromKubeconfig } from './setup';
import { parseKubeconfig, getActiveNamespace } from './kubeconfigParser';
import { log } from './logger';
import { welcomeHtml, lockHtml, formHtml } from './webviews/templates';

export class ConnectionsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'kubectl-control.connectionsView';

    private view?: vscode.WebviewView;
    private _welcomeMode = false;
    private _lastRenderedMode: 'welcome' | 'lock' | 'form' | undefined;
    private _messageHandlerDisposable?: vscode.Disposable;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: ClusterStore,
        private readonly lockService: LockService,
        private readonly onChanged: () => void
    ) {
        lockService.onStateChange(() => void this.refresh());
    }

    public setWelcomeMode(enabled: boolean): void {
        this._welcomeMode = enabled;
        void vscode.commands.executeCommand('setContext', 'kubectl-control.showClusters', !enabled);
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        this._lastRenderedMode = undefined;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };

        this._messageHandlerDisposable?.dispose();
        this._messageHandlerDisposable = webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'unlock':           await this.handleUnlock(message.password); break;
                case 'addCluster':       await this.addCluster(message); break;
                case 'updateCluster':    await this.updateCluster(message); break;
                case 'parseKubeconfig':  await this.handleParseKubeconfig(message.yaml); break;
                case 'loadKubeconfigFile': await this.handleLoadKubeconfigFile(); break;
                case 'setupSkip':        this.setWelcomeMode(false); await this.refresh(); break;
                case 'setupKubeconfig':  await this.handleSetupKubeconfig(); break;
                case 'setupImportYes':   await this.handleSetupImport(); break;
                case 'setupImportNo':    void this.view?.webview.postMessage({ command: 'setupGoto', step: 'password' }); break;
                case 'setupPasswordYes': await this.handleSetupPassword(); break;
                case 'setupPasswordNo':  void this.view?.webview.postMessage({ command: 'setupGoto', step: 'tutorial' }); break;
                case 'setupDone':        this.setWelcomeMode(false); await this.refresh(); break;
            }
        });

        // Small delay so VS Code can finish setting up the webview context
        // before we set html — prevents the "service worker invalid state" error
        setTimeout(() => void this.refresh(), 100);
    }

    public async refresh(): Promise<void> {
        if (!this.view) { return; }

        if (this._welcomeMode) {
            if (this._lastRenderedMode !== 'welcome') {
                this.view.webview.html = this.getWelcomeHtml(this.view.webview);
                this._lastRenderedMode = 'welcome';
            }
            return;
        }

        const locked = await this.lockService.isEnabled() && !this.lockService.isUnlocked();
        const mode = locked ? 'lock' : 'form';
        if (this._lastRenderedMode !== mode) {
            this.view.webview.html = locked
                ? this.getLockHtml(this.view.webview)
                : this.getFormHtml(this.view.webview);
            this._lastRenderedMode = mode;
        }
    }

    private async handleUnlock(password: string): Promise<void> {
        if (this.lockService.isLockedOut) {
            void this.view?.webview.postMessage({ command: 'unlockLockedOut', seconds: this.lockService.lockoutRemainingSeconds });
            return;
        }
        const ok = await this.lockService.unlock(password);
        if (!ok) {
            if (this.lockService.isLockedOut) {
                void this.view?.webview.postMessage({ command: 'unlockLockedOut', seconds: this.lockService.lockoutRemainingSeconds });
            } else {
                void this.view?.webview.postMessage({ command: 'unlockFailed' });
            }
        }
    }

    private async handleSetupKubeconfig(): Promise<void> {
        await handleImportFromKubeconfig(this.store, () => { this.onChanged(); });
        void this.view?.webview.postMessage({ command: 'setupGoto', step: 'import' });
    }

    private async handleSetupImport(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({ filters: { 'JSON': ['json'] }, canSelectMany: false });
        if (uris && uris.length > 0) {
            await importFile(uris[0], this.store, () => { this.onChanged(); });
            void this.view?.webview.postMessage({ command: 'setupGoto', step: 'password' });
        } else {
            void this.view?.webview.postMessage({ command: 'setupImportCancelled' });
        }
    }

    private async handleSetupPassword(): Promise<void> {
        await promptSetPassword(this.lockService);
        void this.view?.webview.postMessage({ command: 'setupGoto', step: 'tutorial' });
    }

    private async addCluster(msg: Record<string, string>): Promise<void> {
        const name = (msg.name ?? '').trim();
        const kubeconfigData = (msg.kubeconfigData ?? '').trim();
        if (!name || !kubeconfigData) {
            vscode.window.showWarningMessage('Name und kubeconfig dürfen nicht leer sein.');
            return;
        }
        const parsed = parseKubeconfig(kubeconfigData);
        const namespace = getActiveNamespace(parsed);
        await this.store.addCluster({
            name,
            kubeconfigData,
            group: (msg.group ?? '').trim() || undefined,
            shell: (msg.shell as ShellType) || undefined,
            namespace,
            activeContext: msg.activeContext || parsed.currentContext || undefined,
        });
        log.info(`Cluster added via form: "${name}"`);
        this.onChanged();
        await this.refresh();
        vscode.window.showInformationMessage(`Cluster '${name}' wurde hinzugefügt.`);
    }

    private async updateCluster(msg: Record<string, string>): Promise<void> {
        const name = (msg.name ?? '').trim();
        const kubeconfigData = (msg.kubeconfigData ?? '').trim();
        if (!name || !kubeconfigData) {
            vscode.window.showWarningMessage('Name und kubeconfig dürfen nicht leer sein.');
            return;
        }
        const parsed = parseKubeconfig(kubeconfigData);
        const namespace = getActiveNamespace(parsed);
        await this.store.updateCluster(msg.id, {
            name,
            kubeconfigData,
            group: (msg.group ?? '').trim() || undefined,
            shell: (msg.shell as ShellType) || undefined,
            namespace,
            activeContext: msg.activeContext || parsed.currentContext || undefined,
        });
        log.info(`Cluster updated via form: "${name}"`);
        this.onChanged();
        await this.refresh();
        vscode.window.showInformationMessage(`Cluster '${name}' wurde aktualisiert.`);
    }

    private async handleParseKubeconfig(yaml: string): Promise<void> {
        const result = parseKubeconfig(yaml ?? '');
        void this.view?.webview.postMessage({ command: 'kubeconfigParsed', result });
    }

    private async handleLoadKubeconfigFile(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            filters: { 'kubeconfig (yaml/json)': ['yaml', 'yml', 'json', '*'] },
            canSelectMany: false,
            title: 'kubeconfig-Datei auswählen',
        });
        if (!uris || uris.length === 0) { return; }
        try {
            const raw = await vscode.workspace.fs.readFile(uris[0]);
            const yaml = new TextDecoder().decode(raw);
            void this.view?.webview.postMessage({ command: 'kubeconfigFileLoaded', yaml });
            log.info(`kubeconfig file loaded: ${uris[0].fsPath}`);
        } catch (e) {
            log.error('Failed to load kubeconfig file', e);
            vscode.window.showErrorMessage(`Datei konnte nicht geladen werden: ${e}`);
        }
    }

    public prefillEdit(id: string, name: string, kubeconfigData: string, group?: string, shell?: string): void {
        if (!this.view) { return; }
        void this.view.webview.postMessage({ command: 'prefillEdit', id, name, kubeconfigData, group, shell });
    }

    // ── HTML ────────────────────────────────────────────────────────────────

    private getWelcomeHtml(webview: vscode.Webview): string {
        return welcomeHtml(getNonce(), webview.cspSource);
    }

    private getLockHtml(webview: vscode.Webview): string {
        return lockHtml(getNonce(), webview.cspSource);
    }

    private getFormHtml(webview: vscode.Webview): string {
        return formHtml(getNonce(), webview.cspSource);
    }
}

function getNonce(): string {
    return nodeCrypto.randomBytes(16).toString('hex');
}
