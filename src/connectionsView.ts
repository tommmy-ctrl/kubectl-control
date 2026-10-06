import * as vscode from 'vscode';
import * as nodeCrypto from 'node:crypto';
import { ClusterStore, ShellType } from './store';
import { LockService } from './lockService';
import { importFile, promptSetPassword, handleImportFromKubeconfig } from './setup';
import { parseKubeconfig, getActiveNamespace } from './kubeconfigParser';
import { execWithKubeconfig } from './kubectlExec';
import { log } from './logger';
import { welcomeHtml, lockHtml, formHtml } from './webviews/templates';
import { t, getLanguage } from './i18n';
import { confirmKubeconfigExec } from './execTrust';
import { isLocked } from './commandGuard';
import { isBelowMinimum, MIN_PASSWORD_LENGTH } from './passwordPolicy';

export class ConnectionsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'kubectl-control.connectionsView';

    private view?: vscode.WebviewView;
    private _welcomeMode = false;
    private _shortPasswordHintShown = false;
    private _lastRenderedMode: 'welcome' | 'lock' | 'form' | undefined;
    private _messageHandlerDisposable?: vscode.Disposable;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: ClusterStore,
        private readonly lockService: LockService,
        private readonly onChanged: () => void,
        private readonly version: string = 'unknown'
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
            // SECURITY: while locked only the unlock form may talk to the extension —
            // a stale form (rendered before auto-lock) must not add/edit/read connections.
            const lockSafe = message.command === 'unlock'
                || (this._welcomeMode && String(message.command ?? '').startsWith('setup'));
            if (!lockSafe && await isLocked()) { return; }
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
            return;
        }
        // Passwords set before the 12-character minimum still unlock; suggest a change once per session.
        if (isBelowMinimum(password) && !this._shortPasswordHintShown) {
            this._shortPasswordHintShown = true;
            const btnSettings = t('Open settings menu');
            void vscode.window.showWarningMessage(
                t('Your lock password is shorter than {0} characters. Please choose a longer one via Settings menu (⚙) ▸ Change Password.', MIN_PASSWORD_LENGTH),
                btnSettings,
            ).then(choice => {
                if (choice === btnSettings) { void vscode.commands.executeCommand('kubectl-control.settingsMenu'); }
            });
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

    /** Quick best-effort connectivity check. Returns null on success, or an error message. */
    private async testConnection(kubeconfigData: string, context: string | undefined): Promise<string | null> {
        // The check can take several seconds (credential plugin + request timeout) — show progress
        // instead of leaving the form looking frozen.
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('Testing connection…') },
            async () => {
                try {
                    await execWithKubeconfig(kubeconfigData, context, ['cluster-info', '--request-timeout=3s'], 5000);
                    return null;
                } catch (e) {
                    return e instanceof Error ? e.message : String(e);
                }
            },
        );
    }

    private async addCluster(msg: Record<string, string>): Promise<void> {
        const name = (msg.name ?? '').trim();
        const kubeconfigData = (msg.kubeconfigData ?? '').trim();
        if (!name || !kubeconfigData) {
            vscode.window.showWarningMessage(t('Name and kubeconfig must not be empty.'));
            return;
        }
        const parsed = parseKubeconfig(kubeconfigData);
        const namespace = getActiveNamespace(parsed);
        const ctx = msg.activeContext || parsed.currentContext || undefined;
        // SECURITY: the connection test runs kubectl → show any credential plugin first.
        const trust = await confirmKubeconfigExec(name, kubeconfigData);
        if (!trust.ok) { return; }
        const err = await this.testConnection(kubeconfigData, ctx);
        if (err !== null) {
            const btnSave = t('Save anyway');
            const choice = await vscode.window.showWarningMessage(
                t('Connection to "{0}" could not be verified. Save anyway?', name),
                { modal: true, detail: err.slice(0, 500) },
                btnSave,
            );
            if (choice !== btnSave) { return; }
        }
        await this.store.addCluster({
            name,
            kubeconfigData,
            group: (msg.group ?? '').trim() || undefined,
            shell: (msg.shell as ShellType) || undefined,
            namespace,
            activeContext: ctx,
            promptColor: (msg.promptColor ?? '').trim() || undefined,
            execTrust: trust.fingerprint,
        });
        log.info(`Cluster added via form: "${name}"`);
        this.onChanged();
        await this.refresh();
        vscode.window.showInformationMessage(t("Cluster '{0}' added.", name));
    }

    private async updateCluster(msg: Record<string, string>): Promise<void> {
        const name = (msg.name ?? '').trim();
        const kubeconfigData = (msg.kubeconfigData ?? '').trim();
        if (!name || !kubeconfigData) {
            vscode.window.showWarningMessage(t('Name and kubeconfig must not be empty.'));
            return;
        }
        const parsed = parseKubeconfig(kubeconfigData);
        const namespace = getActiveNamespace(parsed);
        const ctx = msg.activeContext || parsed.currentContext || undefined;
        // SECURITY: the connection test runs kubectl → show any credential plugin first.
        const trust = await confirmKubeconfigExec(name, kubeconfigData);
        if (!trust.ok) { return; }
        // Renaming / regrouping / recolouring does not change how kubectl connects — only
        // re-test when the kubeconfig or the context actually changed.
        const existing = (await this.store.getClusters()).find(c => c.id === msg.id);
        const connectionChanged = !existing
            || existing.kubeconfigData.trim() !== kubeconfigData
            || (existing.activeContext ?? undefined) !== ctx;
        const err = connectionChanged ? await this.testConnection(kubeconfigData, ctx) : null;
        if (err !== null) {
            const btnSave = t('Save anyway');
            const choice = await vscode.window.showWarningMessage(
                t('Connection to "{0}" could not be verified. Save anyway?', name),
                { modal: true, detail: err.slice(0, 500) },
                btnSave,
            );
            if (choice !== btnSave) { return; }
        }
        await this.store.updateCluster(msg.id, {
            name,
            kubeconfigData,
            group: (msg.group ?? '').trim() || undefined,
            shell: (msg.shell as ShellType) || undefined,
            namespace,
            activeContext: ctx,
            promptColor: (msg.promptColor ?? '').trim() || undefined,
            execTrust: trust.fingerprint,
        });
        log.info(`Cluster updated via form: "${name}"`);
        this.onChanged();
        await this.refresh();
        vscode.window.showInformationMessage(t("Cluster '{0}' updated.", name));
    }

    private async handleParseKubeconfig(yaml: string): Promise<void> {
        const result = parseKubeconfig(yaml ?? '');
        void this.view?.webview.postMessage({ command: 'kubeconfigParsed', result });
    }

    private async handleLoadKubeconfigFile(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            filters: { 'kubeconfig (yaml/json)': ['yaml', 'yml', 'json', '*'] },
            canSelectMany: false,
            title: t('Select kubeconfig file'),
        });
        if (!uris || uris.length === 0) { return; }
        try {
            const raw = await vscode.workspace.fs.readFile(uris[0]);
            const yaml = new TextDecoder().decode(raw);
            void this.view?.webview.postMessage({ command: 'kubeconfigFileLoaded', yaml });
            log.info(`kubeconfig file loaded: ${uris[0].fsPath}`);
        } catch (e) {
            log.error('Failed to load kubeconfig file', e);
            vscode.window.showErrorMessage(t('File could not be loaded: {0}', String(e)));
        }
    }

    public prefillEdit(id: string, name: string, kubeconfigData: string, group?: string, shell?: string, promptColor?: string): void {
        if (!this.view) { return; }
        void this.view.webview.postMessage({ command: 'prefillEdit', id, name, kubeconfigData, group, shell, promptColor });
    }

    // ── HTML ────────────────────────────────────────────────────────────────

    private getWelcomeHtml(webview: vscode.Webview): string {
        return welcomeHtml(getNonce(), webview.cspSource, getLanguage());
    }

    private getLockHtml(webview: vscode.Webview): string {
        return lockHtml(getNonce(), webview.cspSource, getLanguage());
    }

    private getFormHtml(webview: vscode.Webview): string {
        return formHtml(getNonce(), webview.cspSource, this.version, getLanguage());
    }
}

function getNonce(): string {
    return nodeCrypto.randomBytes(16).toString('hex');
}
