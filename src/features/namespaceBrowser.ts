import { ClusterProfile } from '../store';
import { execWithKubeconfig } from '../kubectlExec';
import { log } from '../logger';

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
