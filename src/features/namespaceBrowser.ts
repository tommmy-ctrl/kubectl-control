import * as vscode from 'vscode';
import { ClusterProfile } from '../store';
import { execWithKubeconfig } from '../kubectlExec';
import { log } from '../logger';
import { t } from '../i18n';

/** RFC 1123 DNS label — the only form a namespace can take (max 63 chars). */
export const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_NS_LEN = 63;

export function isValidNamespace(ns: string): boolean {
    return ns.length > 0 && ns.length <= MAX_NS_LEN && NAMESPACE_RE.test(ns);
}

/** Sentinel returned by pickNamespace() when the user chose "All namespaces". */
export const ALL_NAMESPACES = Symbol('allNamespaces');

export const FALLBACK_NAMESPACES = ['default', 'kube-system', 'kube-public'];

/**
 * Fetch live namespaces from the cluster described by `cluster`.
 * Returns a sorted, deduplicated array of namespace names.
 * On any error (kubectl missing, unreachable, timeout, etc.) logs a warning
 * and returns an empty array so callers can fall back to FALLBACK_NAMESPACES.
 */
export async function fetchNamespaces(
    cluster: ClusterProfile,
    timeoutMs = 6000,
): Promise<string[]> {
    try {
        const { stdout } = await execWithKubeconfig(
            cluster.kubeconfigData,
            cluster.activeContext,
            ['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}'],
            timeoutMs,
        );

        const names = stdout
            .split(/\s+/)
            .filter(n => n.length > 0);

        return [...new Set(names)].sort();
    } catch (err) {
        log.warn(
            `fetchNamespaces: could not retrieve namespaces for cluster "${cluster.name}"`,
            err instanceof Error ? err.message : String(err),
        );
        return [];
    }
}

type NamespaceItem = vscode.QuickPickItem & { value?: string | typeof ALL_NAMESPACES; manual?: true };

/**
 * Namespace picker used by every feature: a QuickPick with the cluster's live
 * namespaces (current one first), optionally "All namespaces", and "Enter
 * manually…" for accounts that may not list namespaces. Every value returned is
 * a valid RFC 1123 label (or ALL_NAMESPACES) — callers may pass it to kubectl
 * and into terminal command lines.
 */
export async function pickNamespace(
    cluster: ClusterProfile,
    opts: { title: string; allowAll?: boolean },
): Promise<string | typeof ALL_NAMESPACES | undefined> {
    const current = cluster.namespace && isValidNamespace(cluster.namespace) ? cluster.namespace : 'default';

    const qp = vscode.window.createQuickPick<NamespaceItem>();
    qp.title = opts.title;
    qp.placeholder = t('Loading namespaces…');
    qp.matchOnDescription = true;
    qp.busy = true;
    qp.items = [{ label: current, description: t('current'), value: current }];

    const manualItem: NamespaceItem = { label: t('$(edit) Enter manually…'), manual: true, alwaysShow: true };
    void fetchNamespaces(cluster).then(live => {
        const names = live.filter(isValidNamespace);
        const items: NamespaceItem[] = [];
        if (opts.allowAll) {
            items.push({ label: t('$(globe) All namespaces'), value: ALL_NAMESPACES, alwaysShow: true });
        }
        items.push({ label: current, description: t('current'), value: current });
        for (const ns of names) {
            if (ns !== current) { items.push({ label: ns, value: ns }); }
        }
        items.push({ kind: vscode.QuickPickItemKind.Separator, label: '' }, manualItem);
        qp.items = items;
        qp.placeholder = names.length > 0
            ? t('Select namespace (type to filter)')
            : t('Namespaces could not be listed — pick the current one or enter one manually');
        qp.busy = false;
    });

    const picked = await new Promise<NamespaceItem | undefined>(resolve => {
        qp.onDidAccept(() => {
            // Nothing matches the typed filter: accept the text itself if it is a valid namespace.
            const typed = qp.value.trim();
            const item = qp.selectedItems[0]
                ?? (isValidNamespace(typed) ? { label: typed, value: typed } : undefined);
            if (!item) { return; }
            resolve(item);
            qp.hide();
        });
        qp.onDidHide(() => resolve(undefined));
        qp.show();
    });
    qp.dispose();

    if (!picked) { return undefined; }
    if (!picked.manual) { return picked.value; }

    return vscode.window.showInputBox({
        title: opts.title,
        prompt: t('Namespace'),
        value: current,
        validateInput: v => isValidNamespace(v) ? undefined : t('Invalid namespace (RFC 1123: lowercase letters, digits and hyphens, max. 63 characters)'),
    });
}
