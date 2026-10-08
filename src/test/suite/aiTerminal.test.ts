import * as assert from 'assert';
import { validateAiCommand } from '../../features/aiTerminal';

suite('aiTerminal', () => {
    test('accepts plain tool commands with ordinary flags', () => {
        assert.strictEqual(validateAiCommand('claude'), 'claude');
        assert.strictEqual(validateAiCommand('  claude --permission-mode default '), 'claude --permission-mode default');
        assert.strictEqual(validateAiCommand('codex --ask-for-approval untrusted'), 'codex --ask-for-approval untrusted');
        assert.strictEqual(validateAiCommand('/usr/local/bin/claude --model=opus'), '/usr/local/bin/claude --model=opus');
    });

    test('rejects shell syntax that could run extra commands', () => {
        for (const bad of ['bash ./evil.sh', './claude-wrapper', 'node evil.js', 'sh -c x', 'claude; rm -rf ~', 'claude && id', 'claude | tee x', 'claude $(id)', 'claude `id`', 'claude "x"', "claude 'x'", 'claude > f', 'claude\nid', '']) {
            assert.strictEqual(validateAiCommand(bad), undefined, JSON.stringify(bad));
        }
    });

    test('rejects flags that switch approvals off', () => {
        for (const bad of [
            'claude --dangerously-skip-permissions',
            'codex --dangerously-bypass-approvals-and-sandbox',
            'codex --yolo',
            'codex --full-auto',
            'codex --ask-for-approval never',
            'claude --permission-mode bypassPermissions',
        ]) {
            assert.strictEqual(validateAiCommand(bad), undefined, bad);
        }
    });
});
