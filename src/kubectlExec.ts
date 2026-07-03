import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { v4 as uuidv4 } from 'uuid';

const execFileAsync = promisify(execFile);

// SECURITY: only allow safe context names to avoid argument injection
const SAFE_CONTEXT_RE = /^[a-zA-Z0-9._-]+$/;

const TEMP_DIR = path.join(os.tmpdir(), 'kubectl-control-ext');

// Cache the mkdir so it only runs once per process lifetime
let _tempDirReady: Promise<void> | undefined;

function ensureTempDir(): Promise<void> {
    if (!_tempDirReady) {
        _tempDirReady = fs.mkdir(TEMP_DIR, { recursive: true, mode: 0o700 }).then(() => undefined);
    }
    return _tempDirReady;
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
 * @throws if context contains invalid characters, or if the process exits non-zero
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

    await ensureTempDir();

    // Unique filename per call to prevent concurrent-call collisions
    const tempFile = path.join(TEMP_DIR, `kubeconfig-exec-${uuidv4()}.yaml`);
    await fs.writeFile(tempFile, kubeconfigData, { encoding: 'utf-8', mode: 0o600 });

    try {
        const cmdArgs: string[] = [];
        if (context !== undefined) {
            cmdArgs.push('--context', context);
        }
        cmdArgs.push(...args);

        const { stdout, stderr } = await execFileAsync(binary, cmdArgs, {
            env: { ...process.env, KUBECONFIG: tempFile },
            timeout: timeoutMs,
        });
        return { stdout, stderr };
    } finally {
        await fs.unlink(tempFile).catch(() => undefined);
    }
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
    await ensureTempDir();
    const tempFile = path.join(TEMP_DIR, `kubeconfig-pf-${uuidv4()}.yaml`);
    await fs.writeFile(tempFile, kubeconfigData, { encoding: 'utf-8', mode: 0o600 });
    return {
        path: tempFile,
        cleanup: () => fs.unlink(tempFile).then(() => undefined).catch(() => undefined),
    };
}
