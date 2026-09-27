import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ClusterProfile, ClusterStore, ShellType } from './store';
import { log } from './logger';
import { t } from './i18n';
import { TEMP_DIR, ensureTempDir } from './kubectlExec';
import { assertKubeconfigAllowed, ensureClusterExecTrusted } from './execTrust';

// On Windows, prefer Git Bash if present; fall back to undefined (VS Code default shell) so the terminal still opens.
function resolveShellPath(shell: ShellType): string | undefined {
    if (shell === 'default') { return undefined; }
    if (shell === 'bash' && process.platform === 'win32') {
        const gitBash = String.raw`C:\Program Files\Git\bin\bash.exe`;
        try {
            require('node:fs').accessSync(gitBash);
            return gitBash;
        } catch {
            return undefined; // Git Bash not found — use VS Code default
        }
    }
    const paths: Record<ShellType, string | undefined> = {
        default:    undefined,
        bash:       '/bin/bash',
        zsh:        '/bin/zsh',
        powershell: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
        cmd:        'cmd.exe',
    };
    return paths[shell];
}

/** Allows only safe Kubernetes context name characters (RFC 1123 + slashes for namespaced names). */
function isSafeContextName(name: string): boolean {
    return /^[a-zA-Z0-9._/@:-]{1,253}$/.test(name);
}

/**
 * Reduce a free-form connection name to a set of characters that are safe to
 * embed inside a single-quoted shell PS1 assignment. Strips quotes, backslashes
 * and control characters so the name can never break out of the assignment.
 */
function sanitizePromptName(name: string): string {
    return name.replace(/[^\p{L}\p{N} ._@-]/gu, '').trim().slice(0, 40) || 'cluster';
}

/** Parse a #rrggbb hex string into its numeric r/g/b components, or undefined. */
function hexToRgb(hex?: string): { r: number; g: number; b: number } | undefined {
    if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) { return undefined; }
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
    };
}

/**
 * Build a shell command that sets a `kubectl@<name> >` prompt for the session.
 * The name is sanitized; the colour is an optional #rrggbb hex string rendered as
 * a 24-bit ANSI truecolor sequence.
 *   - bash/default & zsh use their respective non-printing markers so line
 *     wrapping stays correct.
 *   - PowerShell overrides the `prompt` function (colour supported via ANSI).
 *   - cmd sets the prompt text only (no colour — cmd cannot reliably embed ANSI).
 * Returns undefined only if a prompt cannot be set for the shell.
 */
/**
 * Resolve 'default'/undefined to a concrete shell. The shell is whatever VS Code
 * launches; guess from the extension host platform — win32 → PowerShell, otherwise
 * a POSIX shell (bash). For Remote-SSH the extension host runs on the remote, so
 * this matches the remote's default shell too.
 */
function resolveEffectiveShell(shell: ShellType | undefined): ShellType {
    const s = shell ?? 'default';
    if (s === 'default') {
        return process.platform === 'win32' ? 'powershell' : 'bash';
    }
    return s;
}

/** Command that clears the terminal screen for the given (resolved) shell. */
export function buildClearCommand(shell: ShellType | undefined): string {
    switch (resolveEffectiveShell(shell)) {
        case 'powershell': return 'Clear-Host';
        case 'cmd':        return 'cls';
        default:           return 'clear';
    }
}

export function buildPromptCommand(name: string, shell: ShellType | undefined, color?: string): string | undefined {
    const safe = sanitizePromptName(name);
    const label = `kubectl@${safe} > `;
    const rgb = hexToRgb(color);

    const effective = resolveEffectiveShell(shell);

    if (effective === 'powershell') {
        // Self-contained: $([char]27) yields ESC at render time; works on PS 5.1 and 7.
        if (!rgb) { return `function prompt { "${label}" }`; }
        const esc = '$([char]27)';
        return `function prompt { "${esc}[38;2;${rgb.r};${rgb.g};${rgb.b}m${label}${esc}[0m" }`;
    }

    if (effective === 'cmd') {
        // cmd: $G is '>'; no reliable colour support, so text only.
        return `prompt kubectl@${safe} $G `;
    }

    if (effective === 'zsh') {
        if (!rgb) { return `export PS1='${label}'`; }
        // zsh: %{ %} wrap non-printing sequences; \e is emitted via the literal ESC below.
        return `export PS1=$'%{\\e[38;2;${rgb.r};${rgb.g};${rgb.b}m%}${label}%{\\e[0m%}'`;
    }

    // bash and 'default' (assume a POSIX login shell, typically bash over SSH).
    if (!rgb) { return `export PS1='${label}'`; }
    // bash PS1 interprets \e (ESC) and \[ \] (non-printing) at render time.
    return `export PS1='\\[\\e[38;2;${rgb.r};${rgb.g};${rgb.b}m\\]${label}\\[\\e[0m\\]'`;
}

export class TerminalManager implements vscode.Disposable {
    // Multiple terminals can be open per cluster at once; order = open order (oldest first).
    private readonly openTerminals = new Map<string, vscode.Terminal[]>();
    private readonly terminalOpenedAt = new Map<vscode.Terminal, number>();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange: vscode.Event<void> = this._onDidChange.event;
    private _kubectlAvailable?: boolean;
    private _activeClusterId?: string;
    private readonly _onActiveChange = new vscode.EventEmitter<string | undefined>();
    readonly onActiveChange: vscode.Event<string | undefined> = this._onActiveChange.event;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(private readonly store: ClusterStore) {

        this._disposables.push(vscode.window.onDidCloseTerminal(terminal => {
            const openedAt = this.terminalOpenedAt.get(terminal);
            this.terminalOpenedAt.delete(terminal);

            for (const [id, terminals] of this.openTerminals) {
                const idx = terminals.indexOf(terminal);
                if (idx === -1) { continue; }

                terminals.splice(idx, 1);
                log.info(`Terminal closed for cluster id=${id} (${terminals.length} remaining)`);
                this._onDidChange.fire();

                // Only tear down cluster-level state once the LAST terminal for it closes —
                // other terminals for the same cluster are still using the temp kubeconfig.
                if (terminals.length === 0) {
                    this.openTerminals.delete(id);
                    void this.deleteTempFile(id);

                    if (id === this._activeClusterId) {
                        this._activeClusterId = undefined;
                        this._onActiveChange.fire(undefined);
                    }
                }

                if (process.platform === 'win32' && openedAt && Date.now() - openedAt < 3000) {
                    void this.showConptyError();
                }
                break;
            }
        }));
    }

    private async showConptyError(): Promise<void> {
        log.warn('Terminal closed immediately after launch — possible ConPTY error on Windows');
        const btnEinstellungAktivieren = t('Enable Setting');
        const btnHilfeAnzeigen = t('Show Help');
        const choice = await vscode.window.showErrorMessage(
            t('The terminal could not be started. On Windows this may be caused by a ConPTY issue.'),
            btnEinstellungAktivieren,
            btnHilfeAnzeigen,
        );
        if (choice === btnEinstellungAktivieren) {
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'terminal.integrated.windowsUseConptyDll',
            );
        } else if (choice === btnHilfeAnzeigen) {
            void vscode.env.openExternal(
                vscode.Uri.parse('https://code.visualstudio.com/updates/v1_109#_removal-of-winpty-support'),
            );
        }
    }

    private async deleteTempFile(clusterId: string): Promise<void> {
        const filePath = this.tempFilePath(clusterId);
        try {
            await fs.unlink(filePath);
            log.info(`Temp kubeconfig deleted: ${filePath}`);
        } catch {
            // File may not exist — not an error
        }
    }

    isOpen(clusterId: string): boolean {
        return (this.openTerminals.get(clusterId)?.length ?? 0) > 0;
    }

    /** Number of terminals currently open for a cluster. */
    openCount(clusterId: string): number {
        return this.openTerminals.get(clusterId)?.length ?? 0;
    }

    getOpenClusterIds(): string[] {
        return [...this.openTerminals.keys()];
    }

    /** Sends text to every open terminal for the cluster (e.g. namespace switches apply to all of them). */
    sendToTerminal(clusterId: string, text: string): void {
        for (const terminal of this.openTerminals.get(clusterId) ?? []) {
            terminal.sendText(text);
        }
    }

    /** Close any open terminal(s) for the given cluster id. The existing
     *  onDidCloseTerminal handler performs map cleanup and temp-file deletion. */
    public closeForCluster(clusterId: string): void {
        const terminals = this.openTerminals.get(clusterId);
        if (terminals) {
            log.info(`Closing ${terminals.length} terminal(s) for cluster id=${clusterId} (connection deleted)`);
            for (const terminal of terminals) { terminal.dispose(); }
        }
    }

    getActiveClusterId(): string | undefined {
        return this._activeClusterId;
    }

    /** Focus the most recently opened terminal for a cluster, or open the first one. */
    async openOrFocus(profile: ClusterProfile): Promise<void> {
        const existing = this.openTerminals.get(profile.id);
        if (existing && existing.length > 0) {
            log.info(`Focusing existing terminal for "${profile.name}"`);
            existing[existing.length - 1].show();
            this._activeClusterId = profile.id;
            this._onActiveChange.fire(profile.id);
            await this.store.updateCluster(profile.id, { lastUsed: Date.now() });
            return;
        }
        await this.openAdditional(profile);
    }

    /** Always opens a new terminal for the cluster, even if one (or more) is already open. */
    async openAdditional(profile: ClusterProfile): Promise<void> {
        if (!await this.canOpenTerminal(profile)) { return; }
        await this.openNew(profile);
        this._activeClusterId = profile.id;
        this._onActiveChange.fire(profile.id);
        await this.store.updateCluster(profile.id, { lastUsed: Date.now() });
    }

    /** kubectl-availability check + production confirmation, shared by every path that opens a new terminal. */
    private async canOpenTerminal(profile: ClusterProfile): Promise<boolean> {
        // SECURITY: kubectl in this terminal would run the kubeconfig's credential plugin.
        if (!await ensureClusterExecTrusted(this.store, profile)) { return false; }
        if (!await this.isKubectlAvailable()) {
            const { openAnyway } = await this.showKubectlMissingWarning();
            if (!openAnyway) { return false; }
        }
        if (profile.isProd) {
            const btnOeffnen = t('Open');
            const confirm = await vscode.window.showWarningMessage(
                t('⚠️ "{0}" is a production environment. Really open terminal?', profile.name),
                { modal: true },
                btnOeffnen,
            );
            if (confirm !== btnOeffnen) { return false; }
        }
        return true;
    }

    private async isKubectlAvailable(): Promise<boolean> {
        // Return cached positive result — skip the subprocess on every subsequent terminal open.
        // We still re-check if the previous result was false/undefined.
        if (this._kubectlAvailable === true) {
            return true;
        }
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);
        try {
            await execAsync('kubectl version --client --output=json');
            this._kubectlAvailable = true;
            return true;
        } catch (e: unknown) {
            // Exit code 1 with output still means kubectl exists but cannot reach server — that's fine
            const err = e as { stdout?: string; stderr?: string };
            if (err.stdout?.includes('clientVersion') || err.stderr?.includes('clientVersion')) {
                this._kubectlAvailable = true;
                return true;
            }
            log.warn('kubectl not found in PATH', e);
            this._kubectlAvailable = false;
            return false;
        }
    }

    private async showKubectlMissingWarning(): Promise<{ openAnyway: boolean }> {
        log.warn('kubectl not found in PATH — showing install prompt');
        const btnInstallieren = t('Install kubectl');
        const btnTrotzdemOeffnen = t('Open anyway');
        const choice = await vscode.window.showWarningMessage(
            t('kubectl was not found in PATH. Please install it to use terminals.'),
            btnInstallieren,
            btnTrotzdemOeffnen,
        );
        if (choice === btnInstallieren) {
            void vscode.env.openExternal(vscode.Uri.parse('https://kubernetes.io/docs/tasks/tools/'));
        }
        return { openAnyway: choice === btnTrotzdemOeffnen };
    }

    private tempFilePath(clusterId: string): string {
        return path.join(TEMP_DIR, `kubeconfig-${clusterId}.yaml`);
    }

    private async openNew(profile: ClusterProfile): Promise<void> {
        try {
            // SECURITY: defence in depth — canOpenTerminal() already asked for approval.
            assertKubeconfigAllowed(profile.kubeconfigData);
            await ensureTempDir();

            const kubeconfigPath = this.tempFilePath(profile.id);
            await fs.writeFile(kubeconfigPath, profile.kubeconfigData, { encoding: 'utf-8', mode: 0o600 });

            const shellPath = profile.shell ? resolveShellPath(profile.shell) : undefined;

            // Number the tab (e.g. "(2)") once a second+ terminal is opened for the same cluster,
            // so they're distinguishable in the terminal panel.
            const openCount = this.openTerminals.get(profile.id)?.length ?? 0;
            const name = openCount > 0 ? `☸ ${profile.name} (${openCount + 1})` : `☸ ${profile.name}`;

            const terminal = vscode.window.createTerminal({
                name,
                shellPath,
                env: {
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    KUBECONFIG: kubeconfigPath,
                },
            });

            // Track whether we sent any setup commands, so we can clear their
            // echoes from the screen afterwards for a clean starting terminal.
            let sentSetup = false;

            // If a specific context is selected, set it automatically.
            // Validate the name first — it originates from imported kubeconfig data
            // and must not be allowed to inject extra shell commands into the terminal.
            if (profile.activeContext) {
                if (isSafeContextName(profile.activeContext)) {
                    terminal.sendText(`kubectl config use-context ${profile.activeContext}`);
                    sentSetup = true;
                } else {
                    log.warn(`Skipping auto use-context: unsafe context name "${profile.activeContext}"`);
                    vscode.window.showWarningMessage(
                        t('Context "{0}" contains invalid characters and was not set automatically.', profile.activeContext),
                    );
                }
            }

            // Set a per-connection prompt (kubectl@<name> >) unless disabled.
            const promptEnabled = vscode.workspace
                .getConfiguration('kubectl-control')
                .get<boolean>('customTerminalPrompt', true);
            if (promptEnabled) {
                const promptCmd = buildPromptCommand(profile.name, profile.shell, profile.promptColor);
                if (promptCmd) {
                    terminal.sendText(promptCmd);
                    sentSetup = true;
                }
            }

            // Wipe the setup-command echoes so the terminal starts clean.
            if (sentSetup) {
                terminal.sendText(buildClearCommand(profile.shell));
            }

            // Prod warning is sent last so it stays visible on the cleared screen.
            // The name is sanitized (no quotes/$/backtick/backslash) so it cannot
            // break out of the echo argument in any shell.
            if (profile.isProd === true) {
                const safeName = sanitizePromptName(profile.name);
                terminal.sendText(`echo "${t('⚠️  WARNING: This is a PRODUCTION ENVIRONMENT ({0}). Changes take effect immediately.', safeName)}"`);
            }

            const terminals = this.openTerminals.get(profile.id) ?? [];
            terminals.push(terminal);
            this.openTerminals.set(profile.id, terminals);
            this.terminalOpenedAt.set(terminal, Date.now());
            terminal.show();
            this._onDidChange.fire();
            log.info(`Terminal opened for "${profile.name}" (shell=${profile.shell ?? 'default'}, ${terminals.length} open)`);
        } catch (e) {
            log.error(`Failed to open terminal for "${profile.name}"`, e);
            vscode.window.showErrorMessage(t('Terminal could not be opened: {0}', String(e)));
        }
    }

    async cleanupOrphanedTempFiles(): Promise<void> {
        try {
            const entries = await fs.readdir(TEMP_DIR);
            await Promise.all(
                entries
                    .filter(f => f.startsWith('kubeconfig-') && f.endsWith('.yaml'))
                    .map(f => fs.unlink(path.join(TEMP_DIR, f)).catch(() => undefined)),
            );
            if (entries.length > 0) {
                log.info(`Cleaned up ${entries.length} orphaned temp kubeconfig file(s)`);
            }
        } catch {
            // Directory doesn't exist yet — nothing to clean
        }
    }

    dispose(): void {
        // Remove any temp files for currently open terminals on shutdown
        for (const id of this.openTerminals.keys()) {
            fs.unlink(this.tempFilePath(id)).catch(() => undefined);
        }
        this._onDidChange.dispose();
        this._onActiveChange.dispose();
        for (const d of this._disposables) { d.dispose(); }
    }
}
