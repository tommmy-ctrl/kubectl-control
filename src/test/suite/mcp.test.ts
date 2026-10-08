import * as assert from 'assert';
import * as path from 'node:path';
import * as net from 'node:net';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { classifyKubectlArgs, truncateOutput } from '../../mcp/kubectlPolicy';
import { tmpMcpDir, mcpDirCandidates, isPrivateOwnDir, DISCOVERY_RE } from '../../mcp/shared';
import { TEMP_DIR } from '../../kubectlExec';

function verdict(...args: string[]) { return classifyKubectlArgs(args); }
function allowed(kind: 'read' | 'write', ...args: string[]): void {
    const v = verdict(...args);
    assert.ok(v.ok, `${args.join(' ')} -> ${v.ok ? '' : v.reason}`);
    assert.strictEqual(v.ok && v.kind, kind, args.join(' '));
}
function refused(...args: string[]): void {
    assert.strictEqual(verdict(...args).ok, false, `should be refused: ${args.join(' ')}`);
}

suite('mcp kubectl policy', () => {
    test('read-only commands are classified as read', () => {
        allowed('read', 'get', 'pods', '-o', 'wide');
        allowed('read', 'get', 'pod', 'my-secret-config', '-n', 'prod');
        allowed('read', 'describe', 'deploy', 'api');
        allowed('read', 'logs', 'pod/api-0', '--tail=100');
        allowed('read', 'rollout', 'status', 'deploy/api');
        allowed('read', 'auth', 'can-i', 'delete', 'pods');
        allowed('read', 'top', 'nodes');
        allowed('read', 'get', 'pods', '-ojson');
        allowed('read', 'get', 'pods', '-owide', '-nkube-system');
        allowed('read', 'get', 'pods', '-Al', 'app=x');
    });

    test('changing commands are classified as write', () => {
        allowed('write', 'delete', 'pod', 'api-0');
        allowed('write', 'scale', 'deploy/api', '--replicas=3');
        allowed('write', 'rollout', 'restart', 'deploy/api');
        allowed('write', 'set', 'image', 'deploy/api', 'api=img:2');
        allowed('write', 'apply');
        allowed('write', 'patch', 'deploy', 'api', '-p', '{"spec":{"replicas":2}}');
    });

    test('Secrets are never exposed', () => {
        refused('get', 'secrets');
        refused('get', 'secret', 'db-password', '-o', 'yaml');
        refused('describe', 'secret/db');
        refused('get', 'pods,secrets');
        refused('get', 'Secrets.v1');
        refused('delete', 'secret', 'x');
    });

    test('commands that exec, copy, proxy or edit config are not available', () => {
        for (const verb of ['exec', 'cp', 'port-forward', 'proxy', 'attach', 'debug', 'config', 'edit', 'run', 'create', 'replace', 'drain', 'taint']) {
            refused(verb, 'x');
        }
        refused('auth', 'reconcile');
        refused('set', 'env', 'deploy/api', 'A=b');
        refused('rollout', 'bogus');
    });

    test('credential / server / file / endless flags are refused, also hidden in joined or = forms', () => {
        refused('get', 'pods', '--kubeconfig=/etc/passwd');
        refused('get', 'pods', '--server', 'https://evil');
        refused('get', 'pods', '--token=abc');
        refused('get', 'pods', '--as', 'system:admin');
        refused('get', 'pods', '--context', 'other');
        refused('get', 'pods', '-f', 'x.yaml');
        refused('get', 'pods', '-fx.yaml');
        refused('get', 'pods', '-Aw');
        refused('get', 'pods', '-sfoo');
        refused('get', 'pods', '--filename=x.yaml');
        refused('get', 'pods', '-w');
        refused('get', 'pods', '--watch');
        refused('logs', 'pod/a', '-f');
        refused('logs', 'pod/a', '--follow');
        refused('get', '--raw', '/api');
        refused('apply', '--prune');
    });

    test('changing commands may not target everything', () => {
        refused('delete', 'pods', '--all');
        refused('delete', 'pods', '-A');
        refused('delete', 'pods', '--all-namespaces');
        allowed('read', 'get', 'pods', '-A');
    });

    test('the first argument must be the command, and input is validated', () => {
        refused('-n', 'x', 'get', 'pods');
        assert.strictEqual(classifyKubectlArgs([]).ok, false);
        assert.strictEqual(classifyKubectlArgs('get pods').ok, false);
        assert.strictEqual(classifyKubectlArgs(['get', 5]).ok, false);
        assert.strictEqual(classifyKubectlArgs(['get', 'a\0b']).ok, false);
        assert.strictEqual(classifyKubectlArgs(Array.from({ length: 60 }, () => 'x')).ok, false);
    });

    test('truncateOutput caps long output', () => {
        assert.strictEqual(truncateOutput('abc', 10), 'abc');
        assert.ok(truncateOutput('x'.repeat(50), 10).includes('truncated'));
    });
});

suite('mcp server', () => {
    test('discovery directories: runtime dir first (if set), per-user temp dir as fallback', () => {
        assert.strictEqual(tmpMcpDir(), TEMP_DIR);
        const candidates = mcpDirCandidates();
        assert.strictEqual(candidates[candidates.length - 1], TEMP_DIR);
        assert.ok(DISCOVERY_RE.test('mcp-1234.json'));
        assert.ok(!DISCOVERY_RE.test('mcp-1234.sock'));
    });

    test('a directory that is open to group/others is not private', function () {
        if (process.platform === 'win32') { this.skip(); }
        const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kc-perm-'));
        try {
            fs.chmodSync(dir, 0o700);
            assert.strictEqual(isPrivateOwnDir(dir), true);
            fs.chmodSync(dir, 0o755);
            assert.strictEqual(isPrivateOwnDir(dir), false);
            assert.strictEqual(isPrivateOwnDir(path.join(dir, 'missing')), false);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('speaks MCP over stdio and forwards tool calls to the window socket', async function () {
        this.timeout(20000);
        const serverJs = path.resolve(__dirname, '..', '..', 'mcp', 'server.js');
        if (!fs.existsSync(serverJs)) { this.skip(); }

        // Fake "VS Code window": a socket that answers with the token it expects.
        const token = 'test-token';
        const socketPath = process.platform === 'win32'
            ? `\\\\.\\pipe\\kc-test-${process.pid}`
            : path.join(tmpMcpDir(), `mcp-test-${process.pid}.sock`);
        fs.mkdirSync(tmpMcpDir(), { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') { fs.chmodSync(tmpMcpDir(), 0o700); }
        const seen: Array<{ method: string; params: unknown; token: string }> = [];
        const bridge = net.createServer(sock => {
            let buf = '';
            sock.setEncoding('utf8');
            sock.on('data', d => {
                buf += d;
                const nl = buf.indexOf('\n');
                if (nl < 0) { return; }
                const req = JSON.parse(buf.slice(0, nl));
                seen.push({ method: req.method, params: req.params, token: req.token });
                sock.end(`${JSON.stringify({ id: req.id, ok: true, result: `echo:${req.method}` })}\n`);
            });
        });
        await new Promise<void>(r => bridge.listen(socketPath, r));
        if (process.platform !== 'win32') { fs.chmodSync(socketPath, 0o600); }
        // The server picks windows by live pid: use this test process' pid.
        const discovery = path.join(tmpMcpDir(), `mcp-${process.pid}.json`);
        const hadDiscovery = fs.existsSync(discovery);
        const backup = hadDiscovery ? fs.readFileSync(discovery) : undefined;
        fs.writeFileSync(discovery, JSON.stringify({ pid: process.pid, socket: socketPath, token, workspaceFolders: [], startedAt: Date.now() + 1e9 }), { mode: 0o600 });

        const child = spawn(process.execPath, [serverJs], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const replies = new Map<number, any>();
        let out = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', d => {
            out += d;
            let nl: number;
            while ((nl = out.indexOf('\n')) >= 0) {
                const msg = JSON.parse(out.slice(0, nl));
                out = out.slice(nl + 1);
                if (msg.id !== undefined) { replies.set(msg.id, msg); }
            }
        });
        const waitFor = async (id: number) => {
            for (let i = 0; i < 100 && !replies.has(id); i++) { await new Promise(r => setTimeout(r, 50)); }
            assert.ok(replies.has(id), `no reply for id ${id}`);
            return replies.get(id);
        };
        const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);

        try {
            send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
            const init = await waitFor(1);
            assert.strictEqual(init.result.serverInfo.name, 'kubectl-control');
            assert.strictEqual(init.result.protocolVersion, '2025-06-18');
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });

            send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
            const list = await waitFor(2);
            assert.deepStrictEqual(list.result.tools.map((t: { name: string }) => t.name), ['list_clusters', 'kubectl_read', 'kubectl_write', 'open_terminal']);

            send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kubectl_read', arguments: { cluster: 'c', args: ['get', 'pods'] } } });
            const call = await waitFor(3);
            assert.strictEqual(call.result.content[0].text, 'echo:kubectl_read');
            assert.strictEqual(seen[0].token, token);
            assert.deepStrictEqual(seen[0].params, { cluster: 'c', args: ['get', 'pods'] });

            send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
            assert.ok((await waitFor(4)).error);
            send({ jsonrpc: '2.0', id: 5, method: 'bogus/method' });
            assert.strictEqual((await waitFor(5)).error.code, -32601);
        } finally {
            child.kill();
            bridge.close();
            if (backup) { fs.writeFileSync(discovery, backup); } else { fs.rmSync(discovery, { force: true }); }
            if (process.platform !== 'win32') { fs.rmSync(socketPath, { force: true }); }
        }
    });
});
