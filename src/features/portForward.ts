import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import { ClusterStore, ClusterProfile } from '../store';
import { createPersistentKubeconfig, isSafeContextName } from '../kubectlExec';
import { ClusterTreeItem } from '../treeDataProvider';
import { log } from '../logger';

// ── Validation regexes ────────────────────────────────────────────────────────

/** Matches resource strings like svc/my-service, pod/mypod-0, deploy/app */
const RESOURCE_RE = /^(pod|svc|service|deploy|deployment)\/[a-z0-9][a-z0-9.-]*$/i;

/** RFC 1123 label: lowercase alphanumeric, hyphens allowed, must start/end with alphanumeric. */
const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidPort(s: string): boolean {
    const n = Number(s);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// ── In-memory record ──────────────────────────────────────────────────────────

interface ForwardEntry {
    id: string;
    child: ChildProcess;
    /** Deletes the temp kubeconfig file. */
    cleanup: () => Promise<void>;
    localPort: number;
    remotePort: number;
    resource: string;
    namespace: string;
    clusterName: string;
}

// ── Manager ───────────────────────────────────────────────────────────────────

class PortForwardManager {
    private readonly _forwards = new Map<string, ForwardEntry>();

    /** Start a port-forward session. Returns the entry id. */
    async start(
        cluster: ClusterProfile,
        resource: string,
        localPort: number,
        remotePort: number,
        namespace: string,
    ): Promise<string> {
        const { path: kubeconfigPath, cleanup } = await createPersistentKubeconfig(cluster.kubeconfigData);

        const args: string[] = [];
        if (cluster.activeContext && isSafeContextName(cluster.activeContext)) {
            args.push('--context', cluster.activeContext);
        }
        args.push(
            'port-forward',
            '-n', namespace,
            resource,
            `${localPort}:${remotePort}`,
        );

        log.info(`[port-forward] spawning: kubectl ${args.join(' ')} (cluster="${cluster.name}")`);

        const child = spawn('kubectl', args, {
            env: { ...process.env, KUBECONFIG: kubeconfigPath },
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
        });

        const id = uuidv4();
        const entry: ForwardEntry = { id, child, cleanup, localPort, remotePort, resource, namespace, clusterName: cluster.name };
        this._forwards.set(id, entry);

        // Pipe output to log channel
        child.stdout?.on('data', (data: Buffer) => {
            log.info(`[port-forward][${cluster.name}] ${data.toString().trimEnd()}`);
        });
        child.stderr?.on('data', (data: Buffer) => {
            log.warn(`[port-forward][${cluster.name}] ${data.toString().trimEnd()}`);
        });

        child.on('error', async (err) => {
            log.error(`[port-forward][${cluster.name}] spawn error`, err);
            this._forwards.delete(id);
            await cleanup();
            vscode.window.showErrorMessage(
                `Port-forward for ${resource} on cluster "${cluster.name}" failed to start: ${err.message}`,
            );
        });

        child.on('close', async (code, signal) => {
            const wasTracked = this._forwards.has(id);
            this._forwards.delete(id);
            await cleanup();
            if (wasTracked) {
                const reason = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`;
                log.warn(`[port-forward][${cluster.name}] process ended (${reason})`);
                if (code !== 0 && !signal) {
                    vscode.window.showErrorMessage(
                        `Port-forward for ${resource} on "${cluster.name}" exited unexpectedly (${reason}).`,
                    );
                }
            }
        });

        return id;
    }

    /** Stop a single forward by id. No-op if id unknown. */
    async stop(id: string): Promise<void> {
        const entry = this._forwards.get(id);
        if (!entry) { return; }
        this._forwards.delete(id);
        entry.child.kill();
        await entry.cleanup();
        log.info(`[port-forward] stopped ${entry.resource} on "${entry.clusterName}" (${entry.localPort}:${entry.remotePort})`);
    }

    /** Stop every active forward. */
    async stopAll(): Promise<void> {
        const ids = [...this._forwards.keys()];
        await Promise.all(ids.map(id => this.stop(id)));
    }

    /** Snapshot of active forwards for QuickPick display. */
    entries(): ForwardEntry[] {
        return [...this._forwards.values()];
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pickCluster(store: ClusterStore): Promise<ClusterProfile | undefined> {
    const clusters = await store.getClusters();
    if (clusters.length === 0) {
        vscode.window.showWarningMessage('No clusters configured.');
        return undefined;
    }
    const items = clusters.map(c => ({ label: c.name, description: c.activeContext ?? '', cluster: c }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select cluster' });
    return pick?.cluster;
}

// ── Public registration function ──────────────────────────────────────────────

export function registerPortForward(
    context: vscode.ExtensionContext,
    store: ClusterStore,
): vscode.Disposable[] {
    const manager = new PortForwardManager();

    // ── kubectl-control.startPortForward ──────────────────────────────────────
    const startCmd = vscode.commands.registerCommand(
        'kubectl-control.startPortForward',
        async (treeItem?: ClusterTreeItem) => {
            // Resolve cluster
            let cluster: ClusterProfile | undefined;
            if (treeItem instanceof ClusterTreeItem) {
                cluster = treeItem.profile;
            } else {
                cluster = await pickCluster(store);
            }
            if (!cluster) { return; }

            // Prompt: resource
            const resourceInput = await vscode.window.showInputBox({
                title: `Port-forward — ${cluster.name}`,
                prompt: 'Resource (e.g. svc/myservice, pod/mypod, deploy/myapp)',
                placeHolder: 'svc/myservice',
                validateInput(v) {
                    if (!v) { return 'Resource is required.'; }
                    if (!RESOURCE_RE.test(v)) {
                        return 'Format must be type/name, e.g. svc/myservice or pod/mypod-0.';
                    }
                    return null;
                },
            });
            if (!resourceInput) { return; }

            // Prompt: ports
            const portsInput = await vscode.window.showInputBox({
                title: `Port-forward — ${cluster.name}`,
                prompt: 'Ports as localPort:remotePort (both 1-65535)',
                placeHolder: '8080:80',
                validateInput(v) {
                    if (!v) { return 'Ports are required.'; }
                    const parts = v.split(':');
                    if (parts.length !== 2) { return 'Format must be localPort:remotePort.'; }
                    if (!isValidPort(parts[0])) { return `Invalid local port: ${parts[0]}`; }
                    if (!isValidPort(parts[1])) { return `Invalid remote port: ${parts[1]}`; }
                    return null;
                },
            });
            if (!portsInput) { return; }
            const [localPortStr, remotePortStr] = portsInput.split(':');
            const localPort = Number(localPortStr);
            const remotePort = Number(remotePortStr);

            // Prompt: namespace
            const defaultNs = cluster.namespace ?? 'default';
            const nsInput = await vscode.window.showInputBox({
                title: `Port-forward — ${cluster.name}`,
                prompt: 'Namespace',
                value: defaultNs,
                validateInput(v) {
                    if (!v) { return 'Namespace is required.'; }
                    if (!NAMESPACE_RE.test(v)) {
                        return 'Must be a valid RFC 1123 label (lowercase alphanumeric and hyphens).';
                    }
                    return null;
                },
            });
            if (!nsInput) { return; }

            try {
                const id = await manager.start(cluster, resourceInput, localPort, remotePort, nsInput);
                const action = await vscode.window.showInformationMessage(
                    `Port-forward active: ${resourceInput} ${localPort}:${remotePort} (${cluster.name} / ${nsInput})`,
                    'Stop',
                );
                if (action === 'Stop') {
                    await manager.stop(id);
                    vscode.window.showInformationMessage(`Port-forward stopped: ${resourceInput} on "${cluster.name}".`);
                }
            } catch (err) {
                log.error('[port-forward] failed to start', err);
                vscode.window.showErrorMessage(
                    `Failed to start port-forward: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        },
    );

    // ── kubectl-control.stopPortForward ───────────────────────────────────────
    const stopCmd = vscode.commands.registerCommand(
        'kubectl-control.stopPortForward',
        async () => {
            const entries = manager.entries();
            if (entries.length === 0) {
                vscode.window.showInformationMessage('No active port-forwards.');
                return;
            }
            const items = entries.map(e => ({
                label: `${e.resource}  ${e.localPort}:${e.remotePort}`,
                description: `${e.clusterName} / ${e.namespace}`,
                id: e.id,
            }));
            const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select port-forward to stop' });
            if (!pick) { return; }
            await manager.stop(pick.id);
            vscode.window.showInformationMessage(`Port-forward stopped: ${pick.label}`);
        },
    );

    // ── kubectl-control.stopAllPortForwards ───────────────────────────────────
    const stopAllCmd = vscode.commands.registerCommand(
        'kubectl-control.stopAllPortForwards',
        async () => {
            const count = manager.entries().length;
            if (count === 0) {
                vscode.window.showInformationMessage('No active port-forwards.');
                return;
            }
            await manager.stopAll();
            vscode.window.showInformationMessage(`Stopped ${count} port-forward${count === 1 ? '' : 's'}.`);
        },
    );

    // ── Dispose-time cleanup ──────────────────────────────────────────────────
    const disposeGuard = new vscode.Disposable(() => {
        // Fire-and-forget; VS Code is shutting down so we can't await.
        manager.stopAll().catch((err) => {
            log.error('[port-forward] error during dispose cleanup', err);
        });
    });

    return [startCmd, stopCmd, stopAllCmd, disposeGuard];
}
