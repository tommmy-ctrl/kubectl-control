import * as vscode from 'vscode';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as nodeCrypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { ClusterStore, ClusterProfile } from '../store';
import { TerminalManager } from '../terminalManager';
import { ClusterStatusService } from '../clusterStatus';
import { execWithKubeconfig, ensureTempDir, TEMP_DIR } from '../kubectlExec';
import { isKubeconfigAllowed } from '../execTrust';
import { isLocked, registerGuardedCommand } from '../commandGuard';
import { log } from '../logger';
import { t } from '../i18n';
import { startAiTerminal, AiTool } from './aiTerminal';
import { classifyKubectlArgs, KubectlKind, MCP_NAMESPACE_RE, truncateOutput } from '../mcp/kubectlPolicy';
import { BridgeRequest, BridgeResponse, McpDiscovery, isPrivateOwnDir, mcpDirCandidates, ownsDir } from '../mcp/shared';

/**
 * AI interface for agents running OUTSIDE VS Code (Claude Code, Codex): a small MCP server
 * (dist/mcp-server.js, started by the agent) forwards tool calls over a per-user socket to this
 * window. Everything security-relevant happens HERE, not in the server:
 *   - opt-in via `kubectl-control.mcp.enabled`, nothing listens otherwise
 *   - socket + discovery file live in the per-user 0700 directory, requests carry a random token
 *   - lock state, credential-plugin approval and the kubectl policy are enforced per call
 *   - Secrets are refused; changing commands need an explicit confirmation dialog in VS Code
 *   - production connections: reads need a one-time approval per window session
 */

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PARALLEL_KUBECTL = 3;
const KUBECTL_TIMEOUT_MS = 30_000;
/** A write call may wait for the user's confirmation for a long time. */
const SOCKET_IDLE_MS = 30 * 60_000;

class Semaphore {
    private _active = 0;
    private readonly _waiters: Array<() => void> = [];
    constructor(private readonly limit: number) {}
    async run<T>(job: () => Promise<T>): Promise<T> {
        if (this._active >= this.limit) { await new Promise<void>(resolve => this._waiters.push(resolve)); }
        this._active++;
        try { return await job(); } finally {
            this._active--;
            this._waiters.shift()?.();
        }
    }
}

function quoteForDisplay(arg: string): string {
    return /^[A-Za-z0-9._:/=@,%+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function tokensEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && nodeCrypto.timingSafeEqual(x, y);
}

/** Where the MCP server script is copied to, so the agent config does not break on extension updates. */
export function installedServerPath(): string {
    return path.join(os.homedir(), '.kubectl-control', 'mcp-server.js');
}

async function installServerScript(context: vscode.ExtensionContext): Promise<string> {
    const target = installedServerPath();
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(context.extensionPath, 'dist', 'mcp-server.js'), target);
    return target;
}

class McpBridge implements vscode.Disposable {
    private _server?: net.Server;
    private _socketPath?: string;
    private _discoveryFile?: string;
    private readonly _token = nodeCrypto.randomBytes(32).toString('hex');
    private readonly _kubectl = new Semaphore(MAX_PARALLEL_KUBECTL);
    /** Production connections the user allowed the agent to READ from in this window session. */
    private readonly _prodReadApproved = new Set<string>();
    /** Confirmation dialogs are shown one at a time. */
    private _dialogs: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly store: ClusterStore,
        private readonly terminalManager: TerminalManager,
        private readonly status: ClusterStatusService,
    ) {}

    get running(): boolean { return this._server !== undefined; }

    async start(): Promise<void> {
        if (this._server) { return; }
        const dir = await this.privateDir();
        const socketPath = process.platform === 'win32'
            ? `\\\\.\\pipe\\kubectl-control-${nodeCrypto.randomBytes(8).toString('hex')}`
            : path.join(dir, `mcp-${process.pid}.sock`);
        if (process.platform !== 'win32') { await fs.unlink(socketPath).catch(() => undefined); }

        const server = net.createServer(socket => this.onConnection(socket));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => { server.off('error', reject); resolve(); });
        });
        if (process.platform !== 'win32') { await fs.chmod(socketPath, 0o600).catch(() => undefined); }

        const discovery: McpDiscovery = {
            pid: process.pid,
            socket: socketPath,
            token: this._token,
            workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
            startedAt: Date.now(),
        };
        this._discoveryFile = path.join(dir, `mcp-${process.pid}.json`);
        await fs.writeFile(this._discoveryFile, JSON.stringify(discovery), { encoding: 'utf-8', mode: 0o600 });
        this._server = server;
        this._socketPath = socketPath;
        log.info('MCP bridge: listening for AI agents');
    }

    /**
     * SECURITY: token, socket and discovery file go into a directory that provably belongs to
     * this user and is closed to others. A directory somebody else created first (predictable
     * name under /tmp on a shared host) is refused instead of trusted.
     */
    private async privateDir(): Promise<string> {
        for (const dir of mcpDirCandidates()) {
            try {
                await fs.mkdir(dir, { recursive: true, mode: 0o700 });
                if (process.platform === 'win32') { return dir; }
                if (!ownsDir(dir)) { continue; }
                await fs.chmod(dir, 0o700);
                if (isPrivateOwnDir(dir)) { return dir; }
            } catch { /* try the next candidate */ }
        }
        throw new Error('No private directory (owned by you, mode 0700) is available for the AI interface.');
    }

    async stop(): Promise<void> {
        const server = this._server;
        this._server = undefined;
        server?.close();
        if (this._discoveryFile) { await fs.unlink(this._discoveryFile).catch(() => undefined); }
        if (this._socketPath && process.platform !== 'win32') { await fs.unlink(this._socketPath).catch(() => undefined); }
        this._discoveryFile = undefined;
        this._socketPath = undefined;
        if (server) { log.info('MCP bridge: stopped'); }
    }

    dispose(): void { void this.stop(); }

    // ── transport ─────────────────────────────────────────────────────────────

    private onConnection(socket: net.Socket): void {
        let buffer = '';
        let handled = false;
        socket.setEncoding('utf8');
        socket.setTimeout(SOCKET_IDLE_MS, () => socket.destroy());
        socket.on('error', () => socket.destroy());
        socket.on('data', chunk => {
            if (handled) { return; }
            buffer += chunk;
            if (buffer.length > MAX_REQUEST_BYTES) { socket.destroy(); return; }
            const nl = buffer.indexOf('\n');
            if (nl < 0) { return; }
            handled = true;
            void this.respond(socket, buffer.slice(0, nl));
        });
    }

    private async respond(socket: net.Socket, line: string): Promise<void> {
        let id = 0;
        const reply = (res: BridgeResponse) => { if (!socket.destroyed) { socket.end(`${JSON.stringify(res)}\n`); } };
        try {
            const req = JSON.parse(line) as BridgeRequest;
            id = typeof req.id === 'number' ? req.id : 0;
            if (typeof req.token !== 'string' || !tokensEqual(req.token, this._token)) {
                reply({ id, ok: false, error: 'Unauthorized.' });
                return;
            }
            const result = await this.dispatch(req.method, req.params ?? {});
            reply({ id, ok: true, result });
        } catch (e) {
            reply({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    }

    // ── tools ─────────────────────────────────────────────────────────────────

    private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (await isLocked()) { throw new Error('Kubectl Control is locked in VS Code. Ask the user to unlock it.'); }
        if (!vscode.workspace.getConfiguration('kubectl-control').get<boolean>('mcp.enabled', false)) {
            throw new Error('The AI interface is switched off in VS Code (kubectl-control.mcp.enabled).');
        }
        switch (method) {
            case 'list_clusters': return this.listClusters();
            case 'kubectl_read': return this.kubectl('read', params);
            case 'kubectl_write': return this.kubectl('write', params);
            case 'open_terminal': return this.openTerminal(params);
            default: throw new Error(`Unknown method: ${method}`);
        }
    }

    private async listClusters(): Promise<unknown> {
        const clusters = await this.store.getClusters();
        return clusters.map(c => ({
            name: c.name,
            group: c.group ?? null,
            context: c.activeContext ?? null,
            namespace: c.namespace ?? null,
            production: c.isProd === true,
            status: this.status.getStatus(c.id),
        }));
    }

    private async findCluster(name: unknown): Promise<ClusterProfile> {
        if (typeof name !== 'string' || !name.trim()) { throw new Error('"cluster" is required. Use list_clusters.'); }
        const wanted = name.trim().toLowerCase();
        const matches = (await this.store.getClusters()).filter(c => c.name.toLowerCase() === wanted);
        if (matches.length === 0) { throw new Error(`Unknown connection "${name}". Use list_clusters.`); }
        if (matches.length > 1) { throw new Error(`The name "${name}" is ambiguous (several connections). Ask the user to rename one.`); }
        return matches[0];
    }

    /** Serialises dialogs so several agent calls cannot stack modal windows. */
    private ask(job: () => Thenable<string | undefined>): Promise<string | undefined> {
        const next = this._dialogs.then(job, job);
        this._dialogs = next.then(() => undefined, () => undefined);
        return next;
    }

    private async kubectl(kind: KubectlKind, params: Record<string, unknown>): Promise<string> {
        const cluster = await this.findCluster(params.cluster);
        const args = params.args;
        const verdict = classifyKubectlArgs(args);
        if (!verdict.ok) { throw new Error(verdict.reason); }
        if (verdict.kind !== kind) {
            throw new Error(kind === 'read'
                ? 'This command changes the cluster — use kubectl_write.'
                : 'This command is read-only — use kubectl_read.');
        }
        const finalArgs = [...(args as string[])];

        const namespace = params.namespace;
        if (namespace !== undefined) {
            if (typeof namespace !== 'string' || namespace.length > 63 || !MCP_NAMESPACE_RE.test(namespace)) {
                throw new Error('Invalid namespace (RFC-1123 label expected).');
            }
            finalArgs.push('-n', namespace);
        }

        // SECURITY: never run an unapproved credential plugin on behalf of an agent.
        if (!isKubeconfigAllowed(cluster.kubeconfigData)) {
            throw new Error('The credential plugin of this connection is not approved yet. The user must open a terminal for it once in VS Code.');
        }

        let manifestFile: string | undefined;
        let manifestPreview: string | undefined;
        if (verdict.verb === 'apply') {
            const manifest = params.manifest;
            if (typeof manifest !== 'string' || !manifest.trim()) { throw new Error('"apply" needs the YAML in "manifest".'); }
            if (Buffer.byteLength(manifest) > MAX_MANIFEST_BYTES) { throw new Error('manifest is too large.'); }
            manifestPreview = manifest;
            manifestFile = path.join(TEMP_DIR, `mcp-manifest-${uuidv4()}.yaml`);
            await ensureTempDir();
            await fs.writeFile(manifestFile, manifest, { encoding: 'utf-8', mode: 0o600 });
            finalArgs.push('-f', manifestFile);
        } else if (params.manifest !== undefined) {
            throw new Error('"manifest" is only used with "apply".');
        }

        try {
            if (kind === 'write') {
                await this.confirmWrite(cluster, args as string[], namespace as string | undefined, manifestPreview);
            } else if (cluster.isProd) {
                await this.confirmProdRead(cluster);
            }
            log.info(`[mcp] ${kind} on "${cluster.name}": kubectl ${verdict.verb} (${finalArgs.length} args)`);
            const { stdout, stderr } = await this._kubectl.run(() =>
                execWithKubeconfig(cluster.kubeconfigData, cluster.activeContext, finalArgs, KUBECTL_TIMEOUT_MS));
            return truncateOutput(stdout || stderr || '(no output)');
        } catch (e) {
            const err = e as Error & { stderr?: string };
            throw new Error(truncateOutput(err.stderr?.trim() || err.message, 4000));
        } finally {
            if (manifestFile) { await fs.unlink(manifestFile).catch(() => undefined); }
        }
    }

    private async confirmProdRead(cluster: ClusterProfile): Promise<void> {
        if (this._prodReadApproved.has(cluster.id)) { return; }
        const btnAllow = t('Allow reading');
        const choice = await this.ask(() => vscode.window.showWarningMessage(
            t('⚠️ An AI agent wants to READ from the production cluster "{0}". Allow it for this window session?', cluster.name),
            { modal: true, detail: t('Reads only (get, describe, logs …). Secrets are never shared. Changing commands are confirmed separately.') },
            btnAllow,
        ));
        if (choice !== btnAllow) { throw new Error('The user did not allow reading from this production connection.'); }
        this._prodReadApproved.add(cluster.id);
    }

    private async confirmWrite(cluster: ClusterProfile, args: string[], namespace: string | undefined, manifest: string | undefined): Promise<void> {
        const btnRun = t('Execute');
        const command = `kubectl ${args.map(quoteForDisplay).join(' ')}${namespace ? ` -n ${namespace}` : ''}`;
        let detail = t('Connection: {0}\nNamespace: {1}\n\n{2}', cluster.name, namespace ?? t('(default of the connection)'), command);
        if (manifest) {
            detail += `\n\n--- manifest ---\n${manifest.length > 1500 ? `${manifest.slice(0, 1500)}\n… (${manifest.length - 1500} more characters)` : manifest}`;
        }
        const title = cluster.isProd
            ? t('⚠️ An AI agent wants to CHANGE the PRODUCTION cluster "{0}"', cluster.name)
            : t('An AI agent wants to change the cluster "{0}"', cluster.name);
        const choice = await this.ask(() => vscode.window.showWarningMessage(title, { modal: true, detail }, btnRun));
        if (choice !== btnRun) {
            log.warn(`[mcp] write on "${cluster.name}" declined by the user`);
            throw new Error('The user declined this command in VS Code. Do not retry unless asked.');
        }
    }

    private async openTerminal(params: Record<string, unknown>): Promise<string> {
        const cluster = await this.findCluster(params.cluster);
        const ai = params.ai;
        if (ai !== undefined && ai !== 'claude' && ai !== 'codex') { throw new Error('"ai" must be "claude" or "codex".'); }
        if (ai) {
            await startAiTerminal(this.terminalManager, cluster, ai as AiTool);
        } else {
            await this.terminalManager.openAdditional(cluster);
        }
        return `Terminal requested for "${cluster.name}". (Production connections ask the user for confirmation first.)`;
    }
}

// ── registration ──────────────────────────────────────────────────────────────

function shellQuote(p: string): string {
    return /^[A-Za-z0-9._/:\\-]+$/.test(p) ? p : JSON.stringify(p);
}

export function registerMcpBridge(
    context: vscode.ExtensionContext,
    store: ClusterStore,
    terminalManager: TerminalManager,
    status: ClusterStatusService,
): vscode.Disposable[] {
    const bridge = new McpBridge(context, store, terminalManager, status);
    const isEnabled = () => vscode.workspace.getConfiguration('kubectl-control').get<boolean>('mcp.enabled', false);

    const sync = async () => {
        try {
            if (isEnabled()) {
                await installServerScript(context);
                await bridge.start();
            } else {
                await bridge.stop();
            }
        } catch (e) {
            log.error('MCP bridge: could not start', e);
            void vscode.window.showErrorMessage(t('The AI interface could not be started: {0}', String(e)));
        }
    };
    void sync();

    const configSub = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('kubectl-control.mcp.enabled')) { void sync(); }
    });

    const setupCmd = registerGuardedCommand('kubectl-control.setupMcp', async () => {
        const btnEnable = t('Enable');
        if (!isEnabled()) {
            const choice = await vscode.window.showWarningMessage(
                t('Allow AI agents (Claude Code, Codex) to use your connections from this VS Code window?'),
                {
                    modal: true,
                    detail: t('Agents can list connections and run read-only kubectl commands (never Secrets). Every changing command needs your confirmation here. Production connections ask before the first read. Credentials are never sent to the agent.'),
                },
                btnEnable,
            );
            if (choice !== btnEnable) { return; }
            await vscode.workspace.getConfiguration('kubectl-control').update('mcp.enabled', true, vscode.ConfigurationTarget.Global);
        }
        let script: string;
        try {
            script = await installServerScript(context);
            await bridge.start();
        } catch (e) {
            void vscode.window.showErrorMessage(t('The AI interface could not be started: {0}', String(e)));
            return;
        }
        const claudeCmd = `claude mcp add kubectl-control --scope user -- node ${shellQuote(script)}`;
        const codexToml = `[mcp_servers.kubectl-control]\ncommand = "node"\nargs = [${JSON.stringify(script)}]\n`;
        const btnClaude = t('Copy command for Claude Code');
        const btnCodex = t('Copy config for Codex');
        const pick = await vscode.window.showInformationMessage(
            t('AI interface is on. Register the server once in your agent (Node.js must be on the PATH of the machine where the agent runs). Keep this VS Code window open while the agent works.'),
            btnClaude, btnCodex,
        );
        if (pick === btnClaude) {
            await vscode.env.clipboard.writeText(claudeCmd);
            void vscode.window.showInformationMessage(t('Copied. Run it in a terminal on this machine.'));
        } else if (pick === btnCodex) {
            await vscode.env.clipboard.writeText(codexToml);
            void vscode.window.showInformationMessage(t('Copied. Add it to ~/.codex/config.toml.'));
        }
    });

    return [bridge, configSub, setupCmd];
}
