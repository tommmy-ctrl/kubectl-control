import * as vscode from 'vscode';
import { ClusterStore, ShellType } from './store';
import { LockService } from './lockService';
import { importFile, promptSetPassword } from './setup';
import { parseKubeconfig, getActiveNamespace } from './kubeconfigParser';
import { log } from './logger';

export class ConnectionsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'kubectl-control.connectionsView';

    private view?: vscode.WebviewView;
    private _welcomeMode = false;
    private _lastRenderedMode: 'welcome' | 'lock' | 'form' | undefined;

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

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'unlock':           await this.handleUnlock(message.password); break;
                case 'addCluster':       await this.addCluster(message); break;
                case 'updateCluster':    await this.updateCluster(message); break;
                case 'parseKubeconfig':  await this.handleParseKubeconfig(message.yaml); break;
                case 'loadKubeconfigFile': await this.handleLoadKubeconfigFile(); break;
                case 'setupSkip':        this.setWelcomeMode(false); await this.refresh(); break;
                case 'setupImportYes':   await this.handleSetupImport(); break;
                case 'setupImportNo':    void this.view?.webview.postMessage({ command: 'setupGoto', step: 'password' }); break;
                case 'setupPasswordYes': await this.handleSetupPassword(); break;
                case 'setupPasswordNo':  void this.view?.webview.postMessage({ command: 'setupGoto', step: 'done' }); break;
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
        const ok = await this.lockService.unlock(password);
        if (!ok) { void this.view?.webview.postMessage({ command: 'unlockFailed' }); }
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
        void this.view?.webview.postMessage({ command: 'setupGoto', step: 'done' });
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
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 24px 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }

        /* ── Hero ── */
        .hero {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px;
            text-align: center;
            margin-bottom: 28px;
        }
        .hero-icon {
            font-size: 2.8rem;
            line-height: 1;
            margin-bottom: 4px;
            opacity: 0.9;
        }
        .hero-title {
            font-size: 1.25rem;
            font-weight: 700;
            letter-spacing: -0.01em;
            line-height: 1.3;
        }
        .hero-sub {
            font-size: 0.85rem;
            color: var(--vscode-descriptionForeground);
            line-height: 1.55;
            max-width: 240px;
        }

        /* ── Steps ── */
        .steps { width: 100%; max-width: 280px; }
        .step { display: none; flex-direction: column; align-items: center; gap: 14px; width: 100%; }
        .step.active { display: flex; }

        /* Step counter */
        .step-counter {
            font-size: 0.75rem;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            opacity: 0.7;
        }

        /* Step card */
        .step-card {
            width: 100%;
            background: var(--vscode-sideBarSectionHeader-background);
            border: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.07));
            border-radius: 6px;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .step-title {
            font-size: 0.9rem;
            font-weight: 600;
            text-align: center;
        }
        .step-desc {
            font-size: 0.82rem;
            color: var(--vscode-descriptionForeground);
            line-height: 1.5;
            text-align: center;
        }
        .hint {
            font-size: 0.78rem;
            color: var(--vscode-inputValidation-warningForeground, #cca700);
            text-align: center;
            min-height: 1em;
        }

        /* Buttons */
        .btn-col { display: flex; flex-direction: column; gap: 7px; width: 100%; }
        button {
            width: 100%;
            padding: 7px 12px;
            border: 0;
            border-radius: 4px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 0.88rem;
            font-weight: 500;
            transition: background 0.15s, opacity 0.15s;
        }
        .btn-primary {
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-ghost {
            color: var(--vscode-descriptionForeground);
            background: transparent;
            border: 1px solid var(--vscode-button-secondaryBackground);
        }
        .btn-ghost:hover { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }

        /* Done */
        .done-check { font-size: 2.2rem; text-align: center; }
    </style>
</head>
<body>
    <div class="hero">
        <div class="hero-icon">☸</div>
        <div class="hero-title">Willkommen bei<br>Kubectl Control</div>
        <div class="hero-sub">Verwalte mehrere Kubernetes-Cluster mit isolierten Terminals direkt in VS Code.</div>
    </div>

    <div class="steps">

        <!-- Step: welcome -->
        <div class="step active" id="step-welcome">
            <div class="btn-col">
                <button class="btn-primary" id="btnStart">Setup starten</button>
                <button class="btn-ghost" id="btnSkip">Überspringen</button>
            </div>
        </div>

        <!-- Step: import -->
        <div class="step" id="step-import">
            <div class="step-counter">Schritt 1 von 2</div>
            <div class="step-card">
                <div class="step-title">Verbindungen importieren?</div>
                <div class="step-desc">Hast du bereits eine Exportdatei mit Cluster-Verbindungen?</div>
                <div class="hint" id="importHint"></div>
                <div class="btn-col">
                    <button class="btn-primary" id="btnImportYes">Datei auswählen</button>
                    <button class="btn-ghost" id="btnImportNo">Überspringen</button>
                </div>
            </div>
        </div>

        <!-- Step: password -->
        <div class="step" id="step-password">
            <div class="step-counter">Schritt 2 von 2</div>
            <div class="step-card">
                <div class="step-title">Passwort-Schutz?</div>
                <div class="step-desc">Schütze die Erweiterung mit einem Passwort beim Öffnen.</div>
                <div class="btn-col">
                    <button class="btn-primary" id="btnPwdYes">Aktivieren</button>
                    <button class="btn-ghost" id="btnPwdNo">Überspringen</button>
                </div>
            </div>
        </div>

        <!-- Step: done -->
        <div class="step" id="step-done">
            <div class="done-check">✅</div>
            <div class="step-card">
                <div class="step-title">Setup abgeschlossen</div>
                <div class="step-desc">Du kannst jetzt Verbindungen hinzufügen und Cluster-Terminals öffnen.</div>
                <button class="btn-primary" id="btnDone">Los geht's</button>
            </div>
        </div>

    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        function showStep(id) {
            document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
            document.getElementById('step-' + id).classList.add('active');
        }

        document.getElementById('btnStart').addEventListener('click', () => showStep('import'));
        document.getElementById('btnSkip').addEventListener('click', () => vscode.postMessage({ command: 'setupSkip' }));

        document.getElementById('btnImportYes').addEventListener('click', () => {
            document.getElementById('importHint').textContent = '';
            vscode.postMessage({ command: 'setupImportYes' });
        });
        document.getElementById('btnImportNo').addEventListener('click', () => vscode.postMessage({ command: 'setupImportNo' }));

        document.getElementById('btnPwdYes').addEventListener('click', () => vscode.postMessage({ command: 'setupPasswordYes' }));
        document.getElementById('btnPwdNo').addEventListener('click', () => vscode.postMessage({ command: 'setupPasswordNo' }));
        document.getElementById('btnDone').addEventListener('click', () => vscode.postMessage({ command: 'setupDone' }));

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'setupGoto') { showStep(msg.step); }
            if (msg.command === 'setupImportCancelled') {
                document.getElementById('importHint').textContent = 'Keine Datei ausgewählt. Bitte erneut versuchen oder überspringen.';
            }
        });
    </script>
</body>
</html>`;
    }

    private getLockHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${baseStyles()}
        body { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; }
        .lock-card {
            width:100%; max-width:280px;
            display:flex; flex-direction:column; align-items:center; gap:20px;
        }
        .lock-icon { font-size:2.4rem; opacity:0.85; }
        .lock-title { font-size:1rem; font-weight:600; text-align:center; }
        .lock-form { width:100%; display:flex; flex-direction:column; gap:10px; }
        .field-label { font-size:0.78rem; color:var(--vscode-descriptionForeground); margin-bottom:3px; display:block; }
        .error-msg {
            font-size:0.8rem; color:var(--vscode-inputValidation-errorForeground, #f48771);
            background:var(--vscode-inputValidation-errorBackground, rgba(244,135,113,0.1));
            border:1px solid var(--vscode-inputValidation-errorBorder, #f48771);
            border-radius:3px; padding:6px 8px; display:none;
        }
    </style>
</head>
<body>
    <div class="lock-card">
        <div class="lock-icon">🔒</div>
        <div class="lock-title">Kubectl Control ist gesperrt</div>
        <form class="lock-form" id="lockForm">
            <div>
                <span class="field-label">Passwort</span>
                <input type="password" id="lockPwd" autofocus placeholder="Passwort eingeben…">
            </div>
            <button type="submit" class="btn-primary">Entsperren</button>
            <div class="error-msg" id="lockError">Falsches Passwort. Bitte erneut versuchen.</div>
        </form>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('lockForm').addEventListener('submit', e => {
            e.preventDefault();
            document.getElementById('lockError').style.display = 'none';
            vscode.postMessage({ command: 'unlock', password: document.getElementById('lockPwd').value });
        });
        window.addEventListener('message', event => {
            if (event.data.command === 'unlockFailed') {
                const err = document.getElementById('lockError');
                err.style.display = '';
                const pwd = document.getElementById('lockPwd');
                pwd.value = ''; pwd.focus();
                pwd.classList.add('input-error');
                setTimeout(() => pwd.classList.remove('input-error'), 1500);
            }
        });
    </script>
</body>
</html>`;
    }

    private getFormHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${baseStyles()}
        .form-header {
            display: flex; align-items: center; gap: 7px;
            font-size: 0.82rem; font-weight: 600; letter-spacing: 0.03em;
            color: var(--vscode-descriptionForeground); text-transform: uppercase;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.06));
        }
        .edit-badge {
            display: none; font-size: 0.7rem; font-weight: 500;
            background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
            border-radius: 3px; padding: 1px 6px; letter-spacing: 0;
        }
        .field-group { display: flex; flex-direction: column; gap: 4px; }
        .field-label { font-size: 0.8rem; color: var(--vscode-foreground); font-weight: 500; }
        .field-hint { font-size: 0.75rem; color: var(--vscode-descriptionForeground); }
        .field-row { display: flex; gap: 7px; }
        .field-row .field-group { flex: 1; }
        .textarea-wrap { position: relative; }
        .btn-load-file {
            position: absolute; top: 6px; right: 6px;
            padding: 3px 8px; font-size: 0.75rem;
            border-radius: 3px; cursor: pointer;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 0;
        }
        .btn-load-file:hover { background: var(--vscode-button-secondaryHoverBackground); }
        select {
            width: 100%; padding: 7px 9px; border-radius: 4px;
            color: var(--vscode-dropdown-foreground);
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
            font-family: var(--vscode-font-family); font-size: inherit; outline: none;
        }
        select:focus { border-color: var(--vscode-focusBorder); }
        .validation-msg {
            font-size: 0.78rem; padding: 5px 8px; border-radius: 3px; display: none;
        }
        .validation-msg.error {
            color: var(--vscode-inputValidation-errorForeground, #f48771);
            background: var(--vscode-inputValidation-errorBackground, rgba(244,135,113,0.1));
            border: 1px solid var(--vscode-inputValidation-errorBorder, #f48771);
        }
        .validation-msg.ok {
            color: var(--vscode-terminal-ansiGreen, #89d185);
            background: rgba(137,209,133,0.08);
            border: 1px solid rgba(137,209,133,0.3);
        }
        .btn-row { display: flex; gap: 7px; margin-top: 2px; }
        .btn-row .btn-primary { flex: 1; }
        #contextGroup { display: none; }
    </style>
</head>
<body>
    <form id="clusterForm">
        <input type="hidden" id="editId">

        <div class="form-header">
            <span id="formTitle">Neue Verbindung</span>
            <span class="edit-badge" id="editBadge">Bearbeiten</span>
        </div>

        <div class="field-group">
            <label class="field-label" for="clusterName">Name</label>
            <input id="clusterName" type="text" placeholder="Production, Staging, Minikube" autocomplete="off">
        </div>

        <div class="field-row">
            <div class="field-group">
                <label class="field-label" for="groupInput">Gruppe <span style="opacity:0.5">(optional)</span></label>
                <input id="groupInput" type="text" placeholder="z.B. Produktion">
            </div>
            <div class="field-group">
                <label class="field-label" for="shellSelect">Shell</label>
                <select id="shellSelect">
                    <option value="default">Standard</option>
                    <option value="bash">bash</option>
                    <option value="zsh">zsh</option>
                    <option value="powershell">PowerShell</option>
                    <option value="cmd">cmd</option>
                </select>
            </div>
        </div>

        <div class="field-group">
            <label class="field-label" for="kubeconfigData">Kubeconfig</label>
            <div class="textarea-wrap">
                <textarea id="kubeconfigData" placeholder="apiVersion: v1&#10;kind: Config&#10;clusters:&#10;  - …"></textarea>
                <button type="button" class="btn-load-file" id="btnLoadFile" title="Aus Datei laden">📂 Laden</button>
            </div>
            <div class="validation-msg" id="validationMsg"></div>
            <span class="field-hint">YAML-Inhalt der kubeconfig-Datei einfügen oder laden</span>
        </div>

        <div class="field-group" id="contextGroup">
            <label class="field-label" for="contextSelect">Context</label>
            <select id="contextSelect"></select>
            <span class="field-hint" id="namespaceHint"></span>
        </div>

        <div class="btn-row">
            <button type="submit" class="btn-primary" id="submitBtn">Verbindung speichern</button>
            <button type="button" class="btn-ghost" id="cancelBtn" style="display:none">Abbrechen</button>
        </div>
    </form>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const form         = document.getElementById('clusterForm');
        const clusterName  = document.getElementById('clusterName');
        const kubeconfigEl = document.getElementById('kubeconfigData');
        const editId       = document.getElementById('editId');
        const groupInput   = document.getElementById('groupInput');
        const shellSelect  = document.getElementById('shellSelect');
        const contextGroup = document.getElementById('contextGroup');
        const contextSelect= document.getElementById('contextSelect');
        const namespaceHint= document.getElementById('namespaceHint');
        const validationMsg= document.getElementById('validationMsg');
        const submitBtn    = document.getElementById('submitBtn');
        const cancelBtn    = document.getElementById('cancelBtn');
        const formTitle    = document.getElementById('formTitle');
        const editBadge    = document.getElementById('editBadge');
        const btnLoadFile  = document.getElementById('btnLoadFile');

        let parseTimer = null;
        let contexts = [];

        // ── Helpers ──────────────────────────────────────────────────────────

        function shake(el) {
            el.classList.remove('input-error');
            void el.offsetWidth;
            el.classList.add('input-error');
            setTimeout(() => el.classList.remove('input-error'), 400);
        }

        function showValidation(type, text) {
            validationMsg.className = 'validation-msg ' + type;
            validationMsg.textContent = text;
            validationMsg.style.display = text ? '' : 'none';
        }

        function updateContextSelect(parsedContexts, currentContext) {
            contexts = parsedContexts;
            contextSelect.innerHTML = '';
            parsedContexts.forEach(ctx => {
                const opt = document.createElement('option');
                opt.value = ctx.name;
                opt.textContent = ctx.name + (ctx.namespace ? '  ·  ' + ctx.namespace : '');
                if (ctx.name === currentContext) { opt.selected = true; }
                contextSelect.appendChild(opt);
            });
            contextGroup.style.display = parsedContexts.length > 1 ? '' : 'none';
            updateNamespaceHint();
        }

        function updateNamespaceHint() {
            const selected = contexts.find(c => c.name === contextSelect.value);
            namespaceHint.textContent = selected ? 'Namespace: ' + (selected.namespace || 'default') : '';
        }

        // ── kubeconfig parsing (debounced) ───────────────────────────────────

        function scheduleParseKubeconfig() {
            clearTimeout(parseTimer);
            parseTimer = setTimeout(() => {
                const yaml = kubeconfigEl.value.trim();
                if (yaml) { vscode.postMessage({ command: 'parseKubeconfig', yaml }); }
                else { showValidation('', ''); contextGroup.style.display = 'none'; }
            }, 600);
        }

        kubeconfigEl.addEventListener('input', scheduleParseKubeconfig);

        // ── Load from file ───────────────────────────────────────────────────

        btnLoadFile.addEventListener('click', () => vscode.postMessage({ command: 'loadKubeconfigFile' }));

        // ── Context select ───────────────────────────────────────────────────

        contextSelect.addEventListener('change', updateNamespaceHint);

        // ── Edit mode ────────────────────────────────────────────────────────

        function enterEditMode(id, name, config, group, shell) {
            editId.value = id;
            clusterName.value = name;
            kubeconfigEl.value = config;
            groupInput.value = group || '';
            shellSelect.value = shell || 'default';
            submitBtn.textContent = 'Änderungen speichern';
            cancelBtn.style.display = '';
            formTitle.textContent = name;
            editBadge.style.display = '';
            scheduleParseKubeconfig();
            clusterName.focus();
        }

        function exitEditMode() {
            editId.value = ''; clusterName.value = ''; kubeconfigEl.value = '';
            groupInput.value = ''; shellSelect.value = 'default';
            submitBtn.textContent = 'Verbindung speichern';
            cancelBtn.style.display = 'none';
            formTitle.textContent = 'Neue Verbindung';
            editBadge.style.display = 'none';
            showValidation('', '');
            contextGroup.style.display = 'none';
        }

        // ── Form submit ──────────────────────────────────────────────────────

        cancelBtn.addEventListener('click', exitEditMode);
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (!clusterName.value.trim())  { shake(clusterName);  clusterName.focus();  return; }
            if (!kubeconfigEl.value.trim()) { shake(kubeconfigEl); kubeconfigEl.focus(); return; }
            const payload = {
                name:          clusterName.value.trim(),
                kubeconfigData:kubeconfigEl.value.trim(),
                group:         groupInput.value.trim(),
                shell:         shellSelect.value,
                activeContext: contextSelect.value || '',
            };
            vscode.postMessage(editId.value
                ? { command: 'updateCluster', id: editId.value, ...payload }
                : { command: 'addCluster', ...payload }
            );
            exitEditMode();
        });

        // ── Messages from extension ──────────────────────────────────────────

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'prefillEdit') {
                enterEditMode(msg.id, msg.name, msg.kubeconfigData, msg.group, msg.shell);
            }
            if (msg.command === 'kubeconfigParsed') {
                const r = msg.result;
                if (!r.valid) {
                    showValidation('error', r.error ?? 'Ungültiges kubeconfig');
                    contextGroup.style.display = 'none';
                } else {
                    const ctxCount = r.contexts.length;
                    showValidation('ok', ctxCount + ' Context' + (ctxCount !== 1 ? 's' : '') + ' erkannt');
                    updateContextSelect(r.contexts, r.currentContext);
                }
            }
            if (msg.command === 'kubeconfigFileLoaded') {
                kubeconfigEl.value = msg.yaml;
                scheduleParseKubeconfig();
            }
        });
    </script>
</body>
</html>`;
    }
}

function baseStyles(): string {
    return `
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            padding: 16px 14px;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.5;
        }
        form { display: flex; flex-direction: column; gap: 14px; }
        input, textarea {
            width: 100%;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
            border-radius: 4px;
            padding: 7px 9px;
            font-family: var(--vscode-font-family);
            font-size: inherit;
            outline: none;
            transition: border-color 0.15s;
        }
        input:focus, textarea:focus {
            border-color: var(--vscode-focusBorder);
        }
        textarea {
            min-height: 180px;
            resize: vertical;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.88rem;
            line-height: 1.55;
        }
        button {
            border: 0; border-radius: 4px;
            padding: 7px 12px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 0.88rem;
            font-weight: 500;
            transition: background 0.15s, opacity 0.15s;
        }
        .btn-primary {
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-ghost {
            color: var(--vscode-descriptionForeground);
            background: transparent;
            border: 1px solid var(--vscode-button-secondaryBackground);
        }
        .btn-ghost:hover { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
        @keyframes shake {
            0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-4px)} 40%,80%{transform:translateX(4px)}
        }
        .input-error { animation:shake 0.35s ease; border-color:var(--vscode-inputValidation-errorBorder, #f48771) !important; }
    `;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
    return text;
}
