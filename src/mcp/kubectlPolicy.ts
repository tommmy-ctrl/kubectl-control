/**
 * Policy for kubectl commands requested by an AI agent over MCP. Pure functions, no `vscode`
 * import, so they are unit-testable and cannot be bypassed by UI state.
 *
 * Principles: arguments are only ever passed to kubectl as an array (no shell); the agent
 * cannot choose credentials, servers or kubeconfig files; commands that never terminate or
 * read arbitrary local files are refused; Secrets are never handed to the agent; anything that
 * changes the cluster is classified `write` and must be confirmed by the user in VS Code.
 */

export type KubectlKind = 'read' | 'write';
export type PolicyVerdict =
    | { ok: true; kind: KubectlKind; verb: string }
    | { ok: false; reason: string };

export const MAX_ARGS = 50;
export const MAX_ARG_LENGTH = 4096;

/** RFC-1123 label, same rule as everywhere else in the extension. */
export const MCP_NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const READ_VERBS = new Set([
    'get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions', 'version', 'cluster-info', 'events',
]);
const WRITE_VERBS = new Set(['apply', 'delete', 'scale', 'patch', 'label', 'annotate', 'cordon', 'uncordon']);
const READ_ROLLOUT = new Set(['status', 'history']);
const WRITE_ROLLOUT = new Set(['restart', 'undo', 'pause', 'resume']);

/** Flags that would let the agent pick credentials/servers/files or that never terminate. */
const FORBIDDEN_FLAGS = new Set([
    '--kubeconfig', '--server', '-s', '--token', '--as', '--as-group', '--as-uid', '--username', '--password',
    '--client-certificate', '--client-key', '--certificate-authority', '--insecure-skip-tls-verify',
    '--tls-server-name', '--cluster', '--user', '--context', '--cache-dir', '--profile', '--profile-output',
    '--raw', '-f', '--filename', '-k', '--kustomize', '-R', '--recursive',
    '--follow', '-w', '--watch', '--watch-only', '--prune', '--overwrite-env',
]);
/** Extra flags refused for write commands: they widen the blast radius. */
const WRITE_WIDE_FLAGS = new Set(['--all', '-A', '--all-namespaces']);

/** `secret`, `secrets`, `secrets.v1`, `secret/foo`, `pod,secret` — but not `my-secret-config`. */
function mentionsSecrets(token: string): boolean {
    return token.toLowerCase().split(/[,/]/).some(part => /^secrets?(\.|$)/.test(part));
}

function flagName(arg: string): string {
    const eq = arg.indexOf('=');
    return eq > 0 && arg.startsWith('-') ? arg.slice(0, eq) : arg;
}

/** Short flags that take a value: in `-ojson` or `-nkube-system` everything after them is that value. */
const VALUE_SHORT_FLAGS = new Set(['n', 'o', 'l', 'f', 's', 'k', 'p', 'c', 'L', 'v', 'C', 'x']);

/** Joined short flags such as `-Aw` or `-fx.yaml` could smuggle a forbidden flag past the table. */
function hiddenShortFlag(arg: string): string | undefined {
    if (!/^-[A-Za-z]/.test(arg) || arg.startsWith('--') || arg.length <= 2) { return undefined; }
    for (const ch of arg.slice(1)) {
        if (FORBIDDEN_FLAGS.has(`-${ch}`)) { return `-${ch}`; }
        if (VALUE_SHORT_FLAGS.has(ch)) { return undefined; }   // the rest is this flag's value
    }
    return undefined;
}

export function classifyKubectlArgs(args: unknown): PolicyVerdict {
    if (!Array.isArray(args) || args.length === 0) { return { ok: false, reason: 'args must be a non-empty array of strings.' }; }
    if (args.length > MAX_ARGS) { return { ok: false, reason: `At most ${MAX_ARGS} arguments are allowed.` }; }
    for (const a of args) {
        if (typeof a !== 'string') { return { ok: false, reason: 'Every argument must be a string.' }; }
        if (a.length > MAX_ARG_LENGTH || a.includes('\0')) { return { ok: false, reason: 'Argument too long or contains a NUL byte.' }; }
    }
    const list = args as string[];
    const verb = list[0];
    if (verb.startsWith('-')) { return { ok: false, reason: 'The first argument must be the kubectl command (e.g. "get"), not a flag.' }; }

    let kind: KubectlKind;
    if (verb === 'rollout') {
        const sub = list[1] ?? '';
        if (READ_ROLLOUT.has(sub)) { kind = 'read'; }
        else if (WRITE_ROLLOUT.has(sub)) { kind = 'write'; }
        else { return { ok: false, reason: 'rollout: only status, history, restart, undo, pause and resume are allowed.' }; }
    } else if (verb === 'auth') {
        if (list[1] !== 'can-i' && list[1] !== 'whoami') { return { ok: false, reason: 'auth: only "can-i" and "whoami" are allowed.' }; }
        kind = 'read';
    } else if (verb === 'set') {
        if (list[1] !== 'image') { return { ok: false, reason: 'set: only "set image" is allowed.' }; }
        kind = 'write';
    } else if (READ_VERBS.has(verb)) {
        kind = 'read';
    } else if (WRITE_VERBS.has(verb)) {
        kind = 'write';
    } else {
        return { ok: false, reason: `kubectl "${verb}" is not available through the AI interface (exec, cp, port-forward, proxy, attach, debug, config … stay manual).` };
    }

    for (const a of list.slice(1)) {
        const name = flagName(a);
        if (FORBIDDEN_FLAGS.has(name) || hiddenShortFlag(a)) {
            return { ok: false, reason: `The flag "${name}" is not allowed (credentials, files, watch/follow and similar are blocked).` };
        }
        if (kind === 'write' && WRITE_WIDE_FLAGS.has(name)) {
            return { ok: false, reason: `The flag "${name}" is not allowed for changing commands — name the objects explicitly.` };
        }
        if (!a.startsWith('-') && mentionsSecrets(a)) {
            return { ok: false, reason: 'Secrets are never exposed to the AI interface.' };
        }
        // `--field-selector=…`, `--selector=…` and similar: values after "=" are checked too
        const eq = a.indexOf('=');
        if (a.startsWith('--') && eq > 0 && mentionsSecrets(a.slice(eq + 1))) {
            return { ok: false, reason: 'Secrets are never exposed to the AI interface.' };
        }
    }
    return { ok: true, kind, verb };
}

/** Cap what is sent back to the agent (and through the remote channel). */
export function truncateOutput(text: string, max = 100_000): string {
    return text.length <= max ? text : `${text.slice(0, max)}\n\n[output truncated: ${text.length - max} more characters]`;
}
