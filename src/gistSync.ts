import * as vscode from 'vscode';
import { ClusterStore } from './store';
import { log } from './logger';
import { encryptData, decryptData, EncryptedFile } from './crypto';

const GIST_ID_KEY        = 'kubectl-control.sync.gistId';
const SYNC_PWD_KEY       = 'kubectl-control.sync.password';
const LOCAL_TIMESTAMP_KEY = 'kubectl-control.sync.localTimestamp';
const GIST_FILENAME      = 'kubectl-control-sync.json';
const GIST_DESC          = 'kubectl-control VS Code Extension Sync';
const GITHUB_API         = 'https://api.github.com';

interface GistPayload extends EncryptedFile {
    updatedAt?: number;
}

export class GistSyncService implements vscode.Disposable {
    private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly _statusItem: vscode.StatusBarItem;
    private readonly _disposables: vscode.Disposable[] = [];
    private _localTimestamp: number;
    private _syncing = false;

    constructor(
        private readonly store: ClusterStore,
        private readonly secrets: vscode.SecretStorage,
        private readonly globalState: vscode.Memento,
    ) {
        this._localTimestamp = this.globalState.get<number>(LOCAL_TIMESTAMP_KEY) ?? 0;

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
        if (this._syncing) { return; }
        const password = await this.secrets.get(SYNC_PWD_KEY);
        if (!password) { return; }
        await this.doPush(password);
    }

    // ── Public commands ───────────────────────────────────────────────────────

    /** First-time setup or explicit push (shows password prompt if needed). */
    async setupOrPush(): Promise<void> {
        if (this._syncing) { return; }
        const password = await this.getOrAskPassword();
        if (!password) { return; }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('GitHub Sync: Verbindungen werden hochgeladen…') },
            () => this.doPush(password),
        );
    }

    /** Pull from Gist — used to restore on a new device. */
    async pull(): Promise<void> {
        if (this._syncing) { return; }
        const token = await this.getGitHubToken();
        if (!token) { return; }

        // Find Gist (use stored ID or search by filename)
        let gistId = this.globalState.get<string>(GIST_ID_KEY);
        if (!gistId) {
            gistId = await this.findGist(token);
            if (!gistId) {
                vscode.window.showInformationMessage(vscode.l10n.t('Kein kubectl-control Sync-Gist in deinem GitHub-Account gefunden.'));
                return;
            }
            await this.globalState.update(GIST_ID_KEY, gistId);
            await this.refreshStatusBar();
        }

        const password = await this.getOrAskPassword();
        if (!password) { return; }

        this._syncing = true;
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('GitHub Sync: Verbindungen werden wiederhergestellt…') },
                async () => {
                    try {
                        const payload = await this.fetchGist(token, gistId);
                        const json    = decryptData(payload, password);
                        const count   = await this.store.importClusters(json);
                        const now     = Date.now();
                        this._localTimestamp = now;
                        await this.globalState.update(LOCAL_TIMESTAMP_KEY, now);
                        log.info(`GitHub Sync: pull successful — ${count} Verbindung(en) importiert`);
                        vscode.window.showInformationMessage(vscode.l10n.t('GitHub Sync: {0} Verbindung(en) erfolgreich wiederhergestellt.', count));
                    } catch (e) {
                        log.error('GitHub Sync: pull failed', e);
                        const msg = e instanceof Error ? e.message : String(e);
                        if (msg.includes('auth') || msg.includes('tag')) {
                            vscode.window.showErrorMessage(vscode.l10n.t('Sync-Passwort falsch oder Daten beschädigt.'));
                        } else {
                            vscode.window.showErrorMessage(vscode.l10n.t('GitHub Sync fehlgeschlagen: {0}', msg));
                        }
                    }
                },
            );
        } finally {
            this._syncing = false;
        }
    }

    /** Remove all sync configuration from this device. */
    async disable(): Promise<void> {
        await this.globalState.update(GIST_ID_KEY, undefined);
        await this.secrets.delete(SYNC_PWD_KEY);
        await this.refreshStatusBar();
        log.info('GitHub Sync deactivated');
        vscode.window.showInformationMessage(vscode.l10n.t('GitHub Sync wurde deaktiviert.'));
    }

    isEnabled(): boolean {
        return !!this.globalState.get<string>(GIST_ID_KEY);
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    private async doPush(password: string): Promise<void> {
        this._syncing = true;
        try {
            const token = await this.getGitHubToken();
            if (!token) { return; }

            const gistId = this.globalState.get<string>(GIST_ID_KEY);

            // Conflict check: if a Gist already exists, compare remote timestamp before pushing
            if (gistId) {
                try {
                    const remotePayload = await this.fetchGist(token, gistId);
                    if ((remotePayload.updatedAt ?? 0) > this._localTimestamp) {
                        const btnLokal = vscode.l10n.t('Lokale Daten hochladen');
                        const btnRemote = vscode.l10n.t('Remote-Daten herunterladen');
                        const choice = await vscode.window.showWarningMessage(
                            vscode.l10n.t('GitHub Sync: Auf einem anderen Gerät wurden neuere Daten gefunden. Was möchtest du tun?'),
                            { modal: true },
                            btnLokal,
                            btnRemote,
                        );
                        if (choice === btnRemote) {
                            // Release the lock before delegating to pull()
                            this._syncing = false;
                            await this.pull();
                            return;
                        } else if (choice !== btnLokal) {
                            return; // dismissed
                        }
                        // 'Lokale Daten hochladen' — fall through to push
                    }
                } catch (fetchErr) {
                    log.warn('GitHub Sync: could not fetch remote for conflict check', fetchErr);
                    // Non-fatal — proceed with push
                }
            }

            const now     = Date.now();
            const json    = await this.store.exportClusters();
            const payload: GistPayload = { ...encryptData(json, password), updatedAt: now };

            if (gistId) {
                await this.updateGist(token, gistId, payload);
            } else {
                const newGistId = await this.createGist(token, payload);
                await this.globalState.update(GIST_ID_KEY, newGistId);
                await this.refreshStatusBar();
                vscode.window.showInformationMessage(vscode.l10n.t('GitHub Sync eingerichtet. Verbindungen werden ab jetzt automatisch synchronisiert.'));
            }

            this._localTimestamp = now;
            await this.globalState.update(LOCAL_TIMESTAMP_KEY, now);
            log.info('GitHub Sync: push successful');
            this._statusItem.text    = '$(check) Sync';
            this._statusItem.tooltip = vscode.l10n.t('Letzter Sync erfolgreich');
            setTimeout(() => void this.refreshStatusBar(), 4000);
        } catch (e) {
            log.error('GitHub Sync: push failed', e);
            this._statusItem.text    = '$(error) Sync';
            this._statusItem.tooltip = vscode.l10n.t('Sync fehlgeschlagen: {0}', String(e));
            vscode.window.showErrorMessage(vscode.l10n.t('GitHub Sync fehlgeschlagen: {0}', String(e)));
            setTimeout(() => void this.refreshStatusBar(), 6000);
        } finally {
            this._syncing = false;
        }
    }

    private async getOrAskPassword(): Promise<string | undefined> {
        const stored = await this.secrets.get(SYNC_PWD_KEY);
        if (stored) { return stored; }

        const password = await vscode.window.showInputBox({
            title: vscode.l10n.t('GitHub Sync – Passwort festlegen'),
            prompt: vscode.l10n.t('Dieses Passwort verschlüsselt deine Verbindungsdaten (min. 12 Zeichen). Merke es dir — es wird auf jedem Gerät einmalig abgefragt.'),
            password: true,
            validateInput: v => (!v || v.length < 12) ? vscode.l10n.t('Mindestens 12 Zeichen') : undefined,
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
            vscode.window.showErrorMessage(vscode.l10n.t('GitHub-Anmeldung fehlgeschlagen. Bitte erneut versuchen.'));
            return undefined;
        }
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
            this._statusItem.tooltip = vscode.l10n.t('kubectl-control GitHub Sync aktiv — klicken zum manuellen Sync');
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
