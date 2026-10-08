import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Per-user temp directory, same formula as TEMP_DIR in kubectlExec.ts (a test keeps them identical). */
export function tmpMcpDir(): string {
    const user = os.userInfo().username.replace(/[^a-zA-Z0-9._-]/g, '_') || 'user';
    return path.join(os.tmpdir(), `kubectl-control-ext-${user}`);
}

/**
 * Directories where extension host and MCP server meet, most trusted first. The runtime dir
 * (/run/user/<uid>) is per-user and mode 0700 by construction; the temp dir is a fallback and is
 * only used after its owner and mode were verified (see isPrivateOwnDir).
 */
export function mcpDirCandidates(): string[] {
    const dirs: string[] = [];
    const xdg = process.env.XDG_RUNTIME_DIR;
    if (xdg && path.isAbsolute(xdg)) { dirs.push(path.join(xdg, 'kubectl-control')); }
    dirs.push(tmpMcpDir());
    return dirs;
}

function currentUid(): number | undefined {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** POSIX: a real directory (no symlink) that belongs to us. Windows: always true (ACLs apply). */
export function ownsDir(p: string): boolean {
    const uid = currentUid();
    if (uid === undefined) { return true; }
    try {
        const st = fs.lstatSync(p);
        return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid;
    } catch { return false; }
}

/** Owned by us and not accessible to group/others — safe to keep tokens, sockets and kubeconfigs in. */
export function isPrivateOwnDir(p: string): boolean {
    if (currentUid() === undefined) { return true; }
    try {
        return ownsDir(p) && (fs.lstatSync(p).mode & 0o077) === 0;
    } catch { return false; }
}

/** A regular file or socket that belongs to us and is not accessible to group/others. */
export function isPrivateOwnEntry(p: string): boolean {
    const uid = currentUid();
    if (uid === undefined) { return true; }
    try {
        const st = fs.lstatSync(p);
        return !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0;
    } catch { return false; }
}

/** One file per VS Code window (extension host) that has the AI interface switched on. */
export interface McpDiscovery {
    pid: number;
    socket: string;
    token: string;
    workspaceFolders: string[];
    startedAt: number;
}

export const DISCOVERY_RE = /^mcp-(\d+)\.json$/;

/** Newline-delimited JSON over the socket. */
export interface BridgeRequest { id: number; token: string; method: string; params: Record<string, unknown> }
export interface BridgeResponse { id: number; ok: boolean; result?: unknown; error?: string }
