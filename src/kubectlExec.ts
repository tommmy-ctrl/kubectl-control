import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import { assertKubeconfigAllowed } from './execTrust';

/** Kill `child` and everything it started (credential plugins such as aws / gke-gcloud-auth-plugin). */
function killTree(child: ReturnType<typeof spawn>): void {
    const pid = child.pid;
    if (pid === undefined) { return; }
    try {
        if (process.platform === 'win32') {
            execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined);
        } else {
            process.kill(-pid, 'SIGKILL');   // negative pid = whole process group (child is detached)
        }
    } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
}

/**
 * Like promisify(execFile), but a timeout kills the whole process tree. With plain
 * execFile only kubectl gets SIGTERM; the credential plugin it spawned lives on as an
 * orphan, and unreachable clusters piled those up on the (remote) host.
 */
function execFileTree(
    binary: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
            env: opts.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let size = 0;
        let failure: string | undefined;
        let done = false;

        const finish = (err: Error | undefined, code?: number | null) => {
            if (done) { return; }
            done = true;
            clearTimeout(timer);
            if (err || failure || code !== 0) {
                const e = new Error(err?.message ?? failure ?? `Command failed: ${binary} ${args.join(' ')}
${stderr}`) as Error & {
                    stdout?: string; stderr?: string; code?: number | string | null; killed?: boolean;
                };
                e.stdout = stdout;
                e.stderr = stderr;
                e.code = (err as NodeJS.ErrnoException | undefined)?.code ?? code;
                e.killed = failure !== undefined;
                reject(e);
            } else {
                resolve({ stdout, stderr });
            }
        };

        const timer = setTimeout(() => {
            failure = `Command timed out after ${opts.timeout}ms: ${binary}`;
            killTree(child);
        }, opts.timeout);

        const collect = (which: 'out' | 'err') => (chunk: Buffer) => {
            size += chunk.length;
            if (size > opts.maxBuffer) {
                failure ??= 'stdout maxBuffer length exceeded';
                killTree(child);
                return;
            }
            if (which === 'out') { stdout += chunk.toString('utf8'); } else { stderr += chunk.toString('utf8'); }
        };
        child.stdout?.on('data', collect('out'));
        child.stderr?.on('data', collect('err'));
        child.on('error', err => finish(err));
        child.on('close', code => finish(undefined, code));
    });
}

/**
 * Output limit per call. Node's default of 1 MiB is far too small for
 * `kubectl get … -o json` on larger clusters (and --all-namespaces), which then
 * failed with "stdout maxBuffer length exceeded".
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// SECURITY: only allow safe context names to avoid argument injection
const SAFE_CONTEXT_RE = /^[a-zA-Z0-9._-]+$/;

// SECURITY/BUGFIX: os.tmpdir() (e.g. /tmp) is shared across all local users on
// POSIX systems. A fixed directory name means whichever user's process creates
// it first "owns" it (mode 0o700), and every other user then fails with EACCES
// on mkdir/writeFile against a directory they don't own. Scoping the directory
// name by OS username gives every user their own directory, so no collision is
// possible.
const SAFE_TEMP_SEGMENT_RE = /[^a-zA-Z0-9._-]/g;
const safeUser = os.userInfo().username.replace(SAFE_TEMP_SEGMENT_RE, '_') || 'user';
export const TEMP_DIR = path.join(os.tmpdir(), `kubectl-control-ext-${safeUser}`);

// Cache the mkdir so it only runs once per process lifetime
let _tempDirReady: Promise<void> | undefined;

export function ensureTempDir(): Promise<void> {
    if (!_tempDirReady) {
        _tempDirReady = fs.mkdir(TEMP_DIR, { recursive: true, mode: 0o700 }).then(() => undefined);
    }
    return _tempDirReady;
}

/**
 * Path of a temp kubeconfig owned by THIS extension host process.
 *
 * TEMP_DIR is shared by every VS Code window of the same OS user (each window
 * has its own extension host). The owner's PID in the name lets
 * cleanupOrphanedTempFiles() tell a crashed window's leftovers apart from files
 * another window's terminals are still using.
 */
export function tempKubeconfigPath(kind: string, id: string): string {
    return path.join(TEMP_DIR, `kubeconfig-${kind}-p${process.pid}-${id}.yaml`);
}

const OWNED_TEMP_RE = /^kubeconfig-[a-z]+-p(\d+)-.+\.yaml$/;
const LEGACY_TEMP_RE = /^kubeconfig-.+\.yaml$/;
/** Files from versions before the PID naming: only removed once clearly stale. */
const LEGACY_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);   // signal 0 = existence check only, nothing is sent
        return true;
    } catch (err) {
        // EPERM: the process exists but belongs to someone else.
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Decide whether a temp kubeconfig file name is an orphan that may be deleted.
 * Exported for tests; `alive` and `ageMs` are injected there.
 */
export function isOrphanedTempFile(
    name: string,
    ageMs: number,
    alive: (pid: number) => boolean = isProcessAlive,
): boolean {
    const owned = OWNED_TEMP_RE.exec(name);
    if (owned) {
        const pid = Number(owned[1]);
        return pid !== process.pid && !alive(pid);
    }
    return LEGACY_TEMP_RE.test(name) && ageMs > LEGACY_TEMP_MAX_AGE_MS;
}

/**
 * Remove temp kubeconfigs left behind by extension hosts that no longer run
 * (crash, kill). Files of other live windows are never touched — deleting them
 * broke that window's open cluster terminals.
 * @returns the number of files removed
 */
export async function cleanupOrphanedTempFiles(): Promise<number> {
    let entries: string[];
    try {
        entries = await fs.readdir(TEMP_DIR);
    } catch {
        return 0;   // directory doesn't exist yet — nothing to clean
    }
    const now = Date.now();
    let removed = 0;
    await Promise.all(entries.map(async name => {
        const file = path.join(TEMP_DIR, name);
        try {
            const { mtimeMs } = await fs.stat(file);
            if (isOrphanedTempFile(name, now - mtimeMs)) {
                await fs.unlink(file);
                removed++;
            }
        } catch {
            // vanished meanwhile or not accessible — ignore
        }
    }));
    return removed;
}

/**
 * Write kubeconfigData to a unique temp file, run kubectl with the given args,
 * and always delete the temp file afterwards.
 *
 * @param kubeconfigData - raw kubeconfig YAML/JSON string
 * @param context        - kubectl context to use; validated against safe regex; undefined = omit flag
 * @param args           - extra arguments (e.g. ['cluster-info', '--request-timeout=3s'])
 * @param timeoutMs      - process timeout in milliseconds (default 5000)
 * @param binary         - binary to invoke (default 'kubectl'; e.g. 'helm')
 * @returns stdout and stderr
 * @throws if context contains invalid characters, if the kubeconfig contains a
 *         credential plugin that has not been approved (ExecNotApprovedError),
 *         or if the process exits non-zero
 */
export async function execWithKubeconfig(
    kubeconfigData: string,
    context: string | undefined,
    args: string[],
    timeoutMs = 5000,
    binary = 'kubectl',
): Promise<{ stdout: string; stderr: string }> {
    // Validate context before touching the filesystem
    if (context !== undefined) {
        if (!SAFE_CONTEXT_RE.test(context)) {
            throw new Error(`Unsafe kubectl context name: "${context}"`);
        }
    }
    // SECURITY: never hand an unapproved exec/auth-provider plugin to kubectl.
    assertKubeconfigAllowed(kubeconfigData);

    await ensureTempDir();

    // Unique filename per call to prevent concurrent-call collisions
    const tempFile = tempKubeconfigPath('exec', uuidv4());
    await fs.writeFile(tempFile, kubeconfigData, { encoding: 'utf-8', mode: 0o600 });

    try {
        const cmdArgs: string[] = [];
        if (context !== undefined) {
            // helm names the flag --kube-context (its --context does not exist).
            cmdArgs.push(contextFlag(binary), context);
        }
        cmdArgs.push(...args);

        const { stdout, stderr } = await execFileTree(binary, cmdArgs, {
            env: { ...process.env, KUBECONFIG: tempFile },
            timeout: timeoutMs,
            maxBuffer: MAX_OUTPUT_BYTES,
        });
        return { stdout, stderr };
    } finally {
        await fs.unlink(tempFile).catch(() => undefined);
    }
}

/** The CLI flag that selects a kubeconfig context for `binary`. */
export function contextFlag(binary: string): string {
    return path.basename(binary).replace(/\.exe$/i, '') === 'helm' ? '--kube-context' : '--context';
}

/**
 * Validate a context name without running anything. Useful for callers that
 * build their own long-running processes (e.g. port-forward).
 */
export function isSafeContextName(context: string): boolean {
    return SAFE_CONTEXT_RE.test(context);
}

/**
 * Write a kubeconfig to a persistent temp file for use by a long-running
 * process (e.g. `kubectl port-forward`). The caller OWNS the returned file and
 * MUST call the returned `cleanup()` when the process ends.
 */
export async function createPersistentKubeconfig(
    kubeconfigData: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
    // SECURITY: never hand an unapproved exec/auth-provider plugin to kubectl.
    assertKubeconfigAllowed(kubeconfigData);
    await ensureTempDir();
    const tempFile = tempKubeconfigPath('pf', uuidv4());
    await fs.writeFile(tempFile, kubeconfigData, { encoding: 'utf-8', mode: 0o600 });
    return {
        path: tempFile,
        cleanup: () => fs.unlink(tempFile).then(() => undefined).catch(() => undefined),
    };
}
