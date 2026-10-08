/**
 * kubectl-control MCP server (stdio). Started by Claude Code / Codex, NOT by VS Code.
 *
 * It holds no credentials and runs no kubectl itself: it forwards every tool call over a
 * per-user socket to the VS Code window that has the AI interface enabled. That window owns the
 * kubeconfigs, applies the policy (src/mcp/kubectlPolicy.ts) and asks the user to confirm
 * anything that changes a cluster. Only node built-ins are used (no MCP SDK dependency).
 *
 * stdout carries the protocol only — diagnostics go to stderr.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { BridgeRequest, BridgeResponse, DISCOVERY_RE, McpDiscovery, isPrivateOwnDir, isPrivateOwnEntry, mcpDirCandidates } from './shared';

const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown> }

const CLUSTER_PROP = { type: 'string', description: 'Connection name exactly as returned by list_clusters.' };
const NAMESPACE_PROP = { type: 'string', description: 'Kubernetes namespace (optional, RFC-1123 label).' };

const TOOLS: ToolDef[] = [
    {
        name: 'list_clusters',
        description: 'List the Kubernetes connections managed by kubectl-control in VS Code (name, group, context, namespace, production flag, reachability). Never returns credentials.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'kubectl_read',
        description: 'Run a READ-ONLY kubectl command on one connection. args exclude the word "kubectl", e.g. ["get","pods","-o","wide"]. Allowed: get, describe, logs (no -f), top, explain, events, api-resources, api-versions, version, cluster-info, rollout status/history, auth can-i/whoami. Secrets, --watch/--follow, -f, credential/server flags are refused. Production connections require one-time approval by the user in VS Code.',
        inputSchema: {
            type: 'object',
            properties: { cluster: CLUSTER_PROP, args: { type: 'array', items: { type: 'string' }, description: 'kubectl arguments without "kubectl".' }, namespace: NAMESPACE_PROP },
            required: ['cluster', 'args'],
            additionalProperties: false,
        },
    },
    {
        name: 'kubectl_write',
        description: 'Run a kubectl command that CHANGES the cluster (apply, delete, scale, patch, label, annotate, cordon, uncordon, set image, rollout restart/undo/pause/resume). The user must confirm every call in a dialog inside VS Code, so expect a delay; never retry in a loop. --all/-A and Secrets are refused. For "apply" pass the YAML in "manifest" (no -f).',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: CLUSTER_PROP,
                args: { type: 'array', items: { type: 'string' }, description: 'kubectl arguments without "kubectl".' },
                namespace: NAMESPACE_PROP,
                manifest: { type: 'string', description: 'YAML/JSON manifest, only for "apply".' },
            },
            required: ['cluster', 'args'],
            additionalProperties: false,
        },
    },
    {
        name: 'open_terminal',
        description: 'Open an isolated cluster terminal in VS Code for the user, optionally starting an AI CLI in it (ai: "claude" or "codex"). Production connections ask the user for confirmation.',
        inputSchema: {
            type: 'object',
            properties: { cluster: CLUSTER_PROP, ai: { type: 'string', enum: ['claude', 'codex'], description: 'Start this AI CLI in the terminal (optional).' } },
            required: ['cluster'],
            additionalProperties: false,
        },
    },
];

function log(message: string): void {
    process.stderr.write(`[kubectl-control-mcp] ${message}\n`);
}

function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The VS Code window to talk to: the one whose workspace contains our cwd, else the newest. */
function findWindow(): McpDiscovery | undefined {
    const windows: McpDiscovery[] = [];
    for (const dir of mcpDirCandidates()) {
        // SECURITY: another local user could have created the directory first. Only trust
        // directories, discovery files and sockets that belong to us and are private.
        if (!isPrivateOwnDir(dir)) { continue; }
        let names: string[];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
            const m = DISCOVERY_RE.exec(name);
            const file = path.join(dir, name);
            if (!m || !isAlive(Number(m[1])) || !isPrivateOwnEntry(file)) { continue; }
            try {
                const d = JSON.parse(fs.readFileSync(file, 'utf8')) as McpDiscovery;
                if (typeof d.socket !== 'string' || typeof d.token !== 'string') { continue; }
                // POSIX: the socket must sit next to the file and belong to us, too.
                if (process.platform !== 'win32' && (path.dirname(d.socket) !== dir || !isPrivateOwnEntry(d.socket))) { continue; }
                windows.push(d);
            } catch { /* half-written or stale — ignore */ }
        }
    }
    if (windows.length === 0) { return undefined; }
    const cwd = process.cwd();
    const inCwd = windows.filter(w => (w.workspaceFolders ?? []).some(f => cwd === f || cwd.startsWith(f + path.sep)));
    const pool = inCwd.length > 0 ? inCwd : windows;
    return pool.sort((a, b) => b.startedAt - a.startedAt)[0];
}

let nextId = 1;

/** One request per connection: simple, and a crashed window cannot leave a half-used socket. */
function callWindow(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const win = findWindow();
        if (!win) {
            reject(new Error('No VS Code window with the kubectl-control AI interface was found. In VS Code run "Kubectl Control: Set Up AI Agent Access (MCP)" and keep the window open.'));
            return;
        }
        const id = nextId++;
        const socket = net.createConnection(win.socket);
        let buffer = '';
        let settled = false;
        const done = (fn: () => void) => { if (!settled) { settled = true; socket.destroy(); fn(); } };
        socket.setEncoding('utf8');
        socket.on('connect', () => {
            const req: BridgeRequest = { id, token: win.token, method, params };
            socket.write(`${JSON.stringify(req)}\n`);
        });
        socket.on('data', chunk => {
            buffer += chunk;
            const nl = buffer.indexOf('\n');
            if (nl < 0) { return; }
            try {
                const res = JSON.parse(buffer.slice(0, nl)) as BridgeResponse;
                done(() => (res.ok ? resolve(res.result) : reject(new Error(res.error ?? 'Request failed.'))));
            } catch (e) {
                done(() => reject(e instanceof Error ? e : new Error(String(e))));
            }
        });
        socket.on('error', e => done(() => reject(new Error(`Cannot reach VS Code: ${e.message}`))));
        socket.on('close', () => done(() => reject(new Error('VS Code closed the connection.'))));
    });
}

function send(message: unknown): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toText(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function handle(msg: { id?: number | string; method?: string; params?: Record<string, unknown> }): Promise<void> {
    const { id, method } = msg;
    if (method === undefined || id === undefined) { return; }   // notifications and stray responses
    try {
        switch (method) {
            case 'initialize': {
                const wanted = String(msg.params?.protocolVersion ?? '');
                send({
                    jsonrpc: '2.0', id,
                    result: {
                        protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : SUPPORTED_PROTOCOLS[0],
                        capabilities: { tools: {} },
                        serverInfo: { name: 'kubectl-control', version: SERVER_VERSION },
                    },
                });
                return;
            }
            case 'ping':
                send({ jsonrpc: '2.0', id, result: {} });
                return;
            case 'tools/list':
                send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
                return;
            case 'tools/call': {
                const name = String(msg.params?.name ?? '');
                const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
                if (!TOOLS.some(t => t.name === name)) {
                    send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
                    return;
                }
                try {
                    const result = await callWindow(name, args);
                    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: toText(result) }] } });
                } catch (e) {
                    send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] } });
                }
                return;
            }
            default:
                send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
    } catch (e) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
    if (!line.trim()) { return; }
    try {
        void handle(JSON.parse(line));
    } catch (e) {
        log(`ignored unparsable line: ${e instanceof Error ? e.message : String(e)}`);
    }
});
rl.on('close', () => process.exit(0));
