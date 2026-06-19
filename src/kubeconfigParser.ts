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
 * Parses a kubeconfig YAML string using a line-by-line state machine.
 * Handles standard single- and multi-context kubeconfig files.
 */
export function parseKubeconfig(yaml: string): ParseResult {
    if (!yaml.trim()) {
        return { valid: false, error: 'Leerer Inhalt', contexts: [], currentContext: '' };
    }

    const lines = yaml.split('\n');
    const hasApiVersion = lines.some(l => /^\s*apiVersion\s*:/.test(l));
    const hasKind = lines.some(l => /^\s*kind\s*:\s*Config/.test(l));

    if (!hasApiVersion) {
        return { valid: false, error: '"apiVersion" fehlt — kein gültiges kubeconfig', contexts: [], currentContext: '' };
    }
    if (!hasKind) {
        return { valid: false, error: '"kind: Config" fehlt — kein gültiges kubeconfig', contexts: [], currentContext: '' };
    }

    const contexts: KubeconfigContext[] = [];
    let currentContext = '';

    // State machine
    let inContextsBlock = false;
    let inContextItem = false;
    let inContextDetailBlock = false;
    let current: Partial<KubeconfigContext> = {};

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) { continue; }

        const indent = rawLine.search(/\S/);

        // Top-level keys reset context blocks
        if (indent === 0 && !trimmed.startsWith('-')) {
            if (inContextItem && current.name) {
                contexts.push({
                    name: current.name,
                    cluster: current.cluster ?? '',
                    namespace: current.namespace ?? 'default',
                });
                current = {};
            }
            inContextsBlock = trimmed.startsWith('contexts:');
            inContextItem = false;
            inContextDetailBlock = false;

            if (trimmed.startsWith('current-context:')) {
                currentContext = extractValue(trimmed, 'current-context');
            }
            continue;
        }

        if (!inContextsBlock) { continue; }

        // New context list item
        if (trimmed.startsWith('- name:')) {
            if (inContextItem && current.name) {
                contexts.push({
                    name: current.name,
                    cluster: current.cluster ?? '',
                    namespace: current.namespace ?? 'default',
                });
            }
            current = { name: extractValue(trimmed, '- name') };
            inContextItem = true;
            inContextDetailBlock = false;
            continue;
        }

        if (!inContextItem) { continue; }

        if (trimmed === 'context:') {
            inContextDetailBlock = true;
            continue;
        }

        if (inContextDetailBlock) {
            if (trimmed.startsWith('cluster:')) { current.cluster = extractValue(trimmed, 'cluster'); }
            if (trimmed.startsWith('namespace:')) { current.namespace = extractValue(trimmed, 'namespace'); }
        }
    }

    // Flush last item
    if (inContextItem && current.name) {
        contexts.push({
            name: current.name,
            cluster: current.cluster ?? '',
            namespace: current.namespace ?? 'default',
        });
    }

    return { valid: true, contexts, currentContext };
}

function extractValue(line: string, key: string): string {
    const idx = line.indexOf(key + ':');
    if (idx === -1) { return ''; }
    return line.slice(idx + key.length + 1).trim().replace(/^['"]|['"]$/g, '');
}

/** Returns the namespace for the active context, or 'default' */
export function getActiveNamespace(parsed: ParseResult): string {
    if (!parsed.valid || parsed.contexts.length === 0) { return 'default'; }
    const active = parsed.contexts.find(c => c.name === parsed.currentContext) ?? parsed.contexts[0];
    return active.namespace || 'default';
}
