import * as jsYaml from 'js-yaml';

export interface KubeconfigContext {
    name: string;
    cluster: string;
    namespace: string;
}

export interface ParseResult {
    valid: boolean;
    error?: string;
    contexts: KubeconfigContext[];
    currentContext: string;
}

/**
 * Parses a kubeconfig YAML string using js-yaml.
 * Handles standard single- and multi-context kubeconfig files.
 */
export function parseKubeconfig(yaml: string): ParseResult {
    if (!yaml.trim()) {
        return { valid: false, error: 'Leerer Inhalt', contexts: [], currentContext: '' };
    }

    let doc: unknown;
    try {
        doc = jsYaml.load(yaml);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { valid: false, error: `Ungültiges YAML: ${msg}`, contexts: [], currentContext: '' };
    }

    if (typeof doc !== 'object' || doc === null) {
        return { valid: false, error: 'Ungültiges YAML: kein Objekt', contexts: [], currentContext: '' };
    }

    const root = doc as Record<string, unknown>;

    if (!('apiVersion' in root)) {
        return { valid: false, error: '"apiVersion" fehlt — kein gültiges kubeconfig', contexts: [], currentContext: '' };
    }
    if (root['kind'] !== 'Config') {
        return { valid: false, error: '"kind: Config" fehlt — kein gültiges kubeconfig', contexts: [], currentContext: '' };
    }

    const currentContext = typeof root['current-context'] === 'string' ? root['current-context'] : '';

    const rawContexts = Array.isArray(root['contexts']) ? root['contexts'] : [];
    const contexts: KubeconfigContext[] = rawContexts
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map(item => {
            const name = typeof item['name'] === 'string' ? item['name'] : '';
            const ctx = (typeof item['context'] === 'object' && item['context'] !== null)
                ? item['context'] as Record<string, unknown>
                : {};
            const cluster = typeof ctx['cluster'] === 'string' ? ctx['cluster'] : '';
            const namespace = typeof ctx['namespace'] === 'string' && ctx['namespace']
                ? ctx['namespace']
                : 'default';
            return { name, cluster, namespace };
        })
        .filter(c => c.name !== '');

    return { valid: true, contexts, currentContext };
}

/** Returns the namespace for the active context, or 'default' */
export function getActiveNamespace(parsed: ParseResult): string {
    if (!parsed.valid || parsed.contexts.length === 0) { return 'default'; }
    const active = parsed.contexts.find(c => c.name === parsed.currentContext) ?? parsed.contexts[0];
    return active.namespace || 'default';
}
