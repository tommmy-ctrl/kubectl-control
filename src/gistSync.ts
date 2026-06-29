import * as vscode from 'vscode';
import * as nodeCrypto from 'node:crypto';
import { ClusterStore } from './store';
import { log } from './logger';

const GIST_ID_KEY    = 'kubectl-control.sync.gistId';
const SYNC_PWD_KEY   = 'kubectl-control.sync.password';
const GIST_FILENAME  = 'kubectl-control-sync.json';
const GIST_DESC      = 'kubectl-control VS Code Extension Sync';
const GITHUB_API     = 'https://api.github.com';

interface GistPayload {
    v: number;
    salt: string;
    iv: string;
    tag: string;
    data: string;
}

export class GistSyncService implements vscode.Disposable {
    private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly _statusItem: vscode.StatusBarItem;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly store: ClusterStore,
        private readonly secrets: vscode.SecretStorage,
        private readonly globalState: vscode.Memento,
    ) {
        this._statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
        this._statusItem.command = 'kubectl-control.syncNow';
        this._disposables.push(this._statusItem);

        this._disposables.push(store.onDidChange(() => this.scheduleAutoSync()));

        void this.refreshStatusBar();
    }

    // ── Auto-sync ─────────────────────────────────────────────────────────────

    private scheduleAutoSync(): void {
        const gistId = this.globalState.get<string>(GIST_ID_KEY);
        if (!gistId) { return; } // Not set up yet — don't prompt

        if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
        this._debounceTimer = setTimeout(() => void this.pushSilent(), 3000);
    }

    private async pushSilent(): Promise<void> {
        const password = await this.secrets.get(SYNC_PWD_KEY);
        if (!password) { return; }
        await this.doPush(password);
    }

    // ── Public commands ───────────────────────────────────────────────────────

    /** First-time setup or explicit push (shows password prompt if needed). */
    async setupOrPush(): Promise<void> {
        const password = await this.getOrAskPassword();
        if (!password) { return; }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'GitHub Sync: Verbindungen werden hochgeladen…' },
            () => this.doPush(password),
        );
    }

    /** Pull from Gist — used to restore on a new device. */
    async pull(): Promise<void> {
        const token = await this.getGitHubToken();
        if (!token) { return; }

        // Find Gist (use stored ID or search by filename)
        let gistId = this.globalState.get<string>(GIST_ID_KEY);
        if (!gistId) {
            gistId = await this.findGist(token);
            if (!gistId) {
                vscode.window.showInformationMessage('Kein kubectl-control Sync-Gist in deinem GitHub-Account gefunden.');
                return;
            }
            await this.globalState.update(GIST_ID_KEY, gistId);
            await this.refreshStatusBar();
        }

        const password = await this.getOrAskPassword();
        if (!password) { return; }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'GitHub Sync: Verbindungen werden wiederhergestellt…' },
            async () => {
                try {
                    const payload = await this.fetchGist(token, gistId!);
                    const json    = this.decrypt(payload, password);
                    const count   = await this.store.importClusters(json);
                    log.info(`GitHub Sync: pull successful — ${count} Verbindung(en) importiert`);
                    vscode.window.showInformationMessage(`GitHub Sync: ${count} Verbindung(en) erfolgreich wiederhergestellt.`);
                } catch (e) {
                    log.error('GitHub Sync: pull failed', e);
                    const msg = e instanceof Error ? e.message : String(e);
                    if (msg.includes('auth') || msg.includes('tag')) {
                        vscode.window.showErrorMessage('Sync-Passwort falsch oder Daten beschädigt.');
                    } else {
                        vscode.window.showErrorMessage(`GitHub Sync fehlgeschlagen: ${msg}`);
                    }
                }
            },
        );
    }

    /** Remove all sync configuration from this device. */
    async disable(): Promise<void> {
        await this.globalState.update(GIST_ID_KEY, undefined);
        await this.secrets.delete(SYNC_PWD_KEY);
        await this.refreshStatusBar();
        log.info('GitHub Sync deactivated');
        vscode.window.showInformationMessage('GitHub Sync wurde deaktiviert.');
    }

    isEnabled(): boolean {
        return !!this.globalState.get<string>(GIST_ID_KEY);
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    private async doPush(password: string): Promise<void> {
        try {
            const token = await this.getGitHubToken();
            if (!token) { return; }

            const json    = await this.store.exportClusters();
            const payload = this.encrypt(json, password);

            let gistId = this.globalState.get<string>(GIST_ID_KEY);
            if (gistId) {
                await this.updateGist(token, gistId, payload);
            } else {
                gistId = await this.createGist(token, payload);
                await this.globalState.update(GIST_ID_KEY, gistId);
                await this.refreshStatusBar();
                vscode.window.showInformationMessage('GitHub Sync eingerichtet. Verbindungen werden ab jetzt automatisch synchronisiert.');
            }

            log.info('GitHub Sync: push successful');
            this._statusItem.text    = '$(check) Sync';
            this._statusItem.tooltip = 'Letzter Sync erfolgreich';
            setTimeout(() => void this.refreshStatusBar(), 4000);
        } catch (e) {
            log.error('GitHub Sync: push failed', e);
            this._statusItem.text    = '$(error) Sync';
            this._statusItem.tooltip = `Sync fehlgeschlagen: ${e}`;
            vscode.window.showErrorMessage(`GitHub Sync fehlgeschlagen: ${e}`);
            setTimeout(() => void this.refreshStatusBar(), 6000);
        }
    }

    private async getOrAskPassword(): Promise<string | undefined> {
        const stored = await this.secrets.get(SYNC_PWD_KEY);
        if (stored) { return stored; }

        const password = await vscode.window.showInputBox({
            title: 'GitHub Sync – Passwort festlegen',
            prompt: 'Dieses Passwort verschlüsselt deine Verbindungsdaten (min. 4 Zeichen). Merke es dir — es wird auf jedem Gerät einmalig abgefragt.',
            password: true,
            validateInput: v => (!v || v.length < 4) ? 'Mindestens 4 Zeichen' : undefined,
        });
        if (!password) { return undefined; }

        await this.secrets.store(SYNC_PWD_KEY, password);
        return password;
    }

    private async getGitHubToken(): Promise<string | undefined> {
        try {
            const session = await vscode.authentication.getSession('github', ['gist'], { createIfNone: true });
            return session.accessToken;
        } catch (e) {
            log.warn('GitHub auth failed', e);
            vscode.window.showErrorMessage('GitHub-Anmeldung fehlgeschlagen. Bitte erneut versuchen.');
            return undefined;
        }
    }

    // ── Encryption ────────────────────────────────────────────────────────────

    private encrypt(plaintext: string, password: string): GistPayload {
        const salt      = nodeCrypto.randomBytes(32);
        const key       = nodeCrypto.pbkdf2Sync(password, salt, 200_000, 32, 'sha256');
        const iv        = nodeCrypto.randomBytes(12);
        const cipher    = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
        return {
            v:    1,
            salt: salt.toString('hex'),
            iv:   iv.toString('hex'),
            tag:  cipher.getAuthTag().toString('hex'),
            data: encrypted.toString('hex'),
        };
    }

    private decrypt(payload: GistPayload, password: string): string {
        if (payload.v !== 1) { throw new Error('Unbekannte Sync-Version'); }
        const salt     = Buffer.from(payload.salt, 'hex');
        const key      = nodeCrypto.pbkdf2Sync(password, salt, 200_000, 32, 'sha256');
        const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
        return decipher.update(Buffer.from(payload.data, 'hex')).toString('utf-8') + decipher.final('utf-8');
    }

    // ── GitHub Gist API ───────────────────────────────────────────────────────

    private async createGist(token: string, payload: GistPayload): Promise<string> {
        const res = await fetch(`${GITHUB_API}/gists`, {
            method:  'POST',
            headers: this.apiHeaders(token),
            body:    JSON.stringify({
                description: GIST_DESC,
                public:      false,
                files:       { [GIST_FILENAME]: { content: JSON.stringify(payload) } },
            }),
        });
        if (!res.ok) { throw new Error(`GitHub API ${res.status}: ${await res.text()}`); }
        const data = await res.json() as { id: string };
        log.info(`GitHub Sync: Gist created (id=${data.id})`);
        return data.id;
    }

    private async updateGist(token: string, gistId: string, payload: GistPayload): Promise<void> {
        const res = await fetch(`${GITHUB_API}/gists/${gistId}`, {
            method:  'PATCH',
            headers: this.apiHeaders(token),
            body:    JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(payload) } } }),
        });
        if (!res.ok) { throw new Error(`GitHub API ${res.status}: ${await res.text()}`); }
    }

    private async fetchGist(token: string, gistId: string): Promise<GistPayload> {
        const res = await fetch(`${GITHUB_API}/gists/${gistId}`, {
            headers: this.apiHeaders(token),
        });
        if (!res.ok) { throw new Error(`GitHub API ${res.status}: ${await res.text()}`); }
        const data = await res.json() as { files: Record<string, { content: string }> };
        const file = data.files[GIST_FILENAME];
        if (!file) { throw new Error('Sync-Datei nicht im Gist gefunden'); }
        return JSON.parse(file.content) as GistPayload;
    }

    private async findGist(token: string): Promise<string | undefined> {
        const res = await fetch(`${GITHUB_API}/gists?per_page=100`, {
            headers: this.apiHeaders(token),
        });
        if (!res.ok) { return undefined; }
        const gists = await res.json() as Array<{ id: string; description: string; files: Record<string, unknown> }>;
        return gists.find(g => g.description === GIST_DESC && GIST_FILENAME in g.files)?.id;
    }

    private apiHeaders(token: string): Record<string, string> {
        return {
            'Authorization': `Bearer ${token}`,
            'Accept':        'application/vnd.github+json',
            'Content-Type':  'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
    }

    // ── Status bar ────────────────────────────────────────────────────────────

    private async refreshStatusBar(): Promise<void> {
        const gistId = this.globalState.get<string>(GIST_ID_KEY);
        if (gistId) {
            this._statusItem.text    = '$(sync) Sync';
            this._statusItem.tooltip = 'kubectl-control GitHub Sync aktiv — klicken zum manuellen Sync';
            this._statusItem.show();
        } else {
            this._statusItem.hide();
        }
    }

    dispose(): void {
        if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
        this._disposables.forEach(d => d.dispose());
    }
}
