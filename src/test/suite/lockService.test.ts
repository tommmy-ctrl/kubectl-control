import * as assert from 'assert';
import { LockService } from '../../lockService';
import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Fake SecretStorage (same pattern as store.test.ts).
// ---------------------------------------------------------------------------
class FakeSecretStorage implements vscode.SecretStorage {
    private readonly _map = new Map<string, string>();

    readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = (_listener: any) => ({
        dispose: () => { /* noop */ },
    }) as vscode.Disposable;

    async get(key: string): Promise<string | undefined> {
        return this._map.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        this._map.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this._map.delete(key);
    }

    async keys(): Promise<string[]> {
        return [...this._map.keys()];
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
suite('LockService', () => {

    test('enableLock then unlock with correct password succeeds', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('correctPassword');
        // After enableLock, the service is immediately unlocked.
        assert.strictEqual(svc.isUnlocked(), true);
        assert.strictEqual(await svc.isEnabled(), true);

        // Lock it explicitly then unlock with the right password.
        svc.lock();
        assert.strictEqual(svc.isUnlocked(), false);

        const ok = await svc.unlock('correctPassword');
        assert.strictEqual(ok, true);
        assert.strictEqual(svc.isUnlocked(), true);
    });

    test('unlock with wrong password fails and isUnlocked stays false', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('correctPassword');
        svc.lock();

        const ok = await svc.unlock('wrongPassword');
        assert.strictEqual(ok, false);
        assert.strictEqual(svc.isUnlocked(), false);
    });

    test('3 failed attempts triggers a lockout (isLockedOut true, remainingSeconds > 0)', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('secret');
        svc.lock();

        // Make 3 failed unlock attempts to trigger the 10s lockout threshold.
        for (let i = 0; i < 3; i++) {
            await svc.unlock('bad-password');
        }

        assert.strictEqual(svc.isLockedOut, true);
        assert.ok(svc.lockoutRemainingSeconds > 0, 'lockoutRemainingSeconds should be positive');
    });

    test('5 failed attempts triggers the 30s lockout', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('secret');
        svc.lock();

        for (let i = 0; i < 5; i++) {
            await svc.unlock('bad-password');
        }

        assert.strictEqual(svc.isLockedOut, true);
        // At 5 attempts the lockout is 30 s, so remaining must be > 10 s.
        assert.ok(svc.lockoutRemainingSeconds > 10, `Expected > 10 s remaining, got ${svc.lockoutRemainingSeconds}`);
    });

    test('7 failed attempts triggers the 60s lockout', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('secret');
        svc.lock();

        for (let i = 0; i < 7; i++) {
            await svc.unlock('bad-password');
        }

        assert.strictEqual(svc.isLockedOut, true);
        // At 7 attempts the lockout is 60 s.
        assert.ok(svc.lockoutRemainingSeconds > 30, `Expected > 30 s remaining, got ${svc.lockoutRemainingSeconds}`);
    });

    test('unlock returns false immediately while locked out (no verify attempted)', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('secret');
        svc.lock();

        // Trigger lockout.
        for (let i = 0; i < 3; i++) {
            await svc.unlock('bad-password');
        }

        assert.strictEqual(svc.isLockedOut, true);
        // Even the correct password is rejected while locked out.
        const ok = await svc.unlock('secret');
        assert.strictEqual(ok, false);
        assert.strictEqual(svc.isUnlocked(), false);
    });

    test('successful unlock resets failed-attempt counter', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('secret');
        svc.lock();

        // Two failed attempts (below lockout threshold).
        await svc.unlock('bad1');
        await svc.unlock('bad2');

        // Correct unlock resets counters.
        const ok = await svc.unlock('secret');
        assert.strictEqual(ok, true);
        assert.strictEqual(svc.isLockedOut, false);
        assert.strictEqual(svc.lockoutRemainingSeconds, 0);
    });

    test('lockout state is in-memory and reflected in isLockedOut / lockoutRemainingSeconds', async () => {
        // This test verifies the boundary logic: the lockout timestamp is set
        // to a future time, so isLockedOut must be true and remainingSeconds > 0.
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('pass');
        svc.lock();

        for (let i = 0; i < 3; i++) {
            await svc.unlock('wrong');
        }

        assert.strictEqual(svc.isLockedOut, true);
        // Remaining seconds should be close to 10 (the 3-attempt threshold).
        const remaining = svc.lockoutRemainingSeconds;
        assert.ok(remaining > 0 && remaining <= 10,
            `Expected 0 < remaining <= 10, got ${remaining}`);
    });

    test('enableLock resets brute-force counters (fresh password clears lockout)', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('pass1');
        svc.lock();

        // Trigger lockout.
        for (let i = 0; i < 3; i++) {
            await svc.unlock('bad');
        }
        assert.strictEqual(svc.isLockedOut, true);

        // Setting a new password should clear the lockout.
        await svc.enableLock('pass2');
        assert.strictEqual(svc.isLockedOut, false);
        assert.strictEqual(svc.lockoutRemainingSeconds, 0);
    });

    test('isEnabled returns false before enableLock is called', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        assert.strictEqual(await svc.isEnabled(), false);
    });

    test('disableLock with correct password disables the lock', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('myPass');
        const disabled = await svc.disableLock('myPass');
        assert.strictEqual(disabled, true);
        assert.strictEqual(await svc.isEnabled(), false);
    });

    test('disableLock with wrong password is rejected', async () => {
        const secrets = new FakeSecretStorage();
        const svc = new LockService(secrets);
        await svc.enableLock('myPass');
        const disabled = await svc.disableLock('wrongPass');
        assert.strictEqual(disabled, false);
        assert.strictEqual(await svc.isEnabled(), true);
    });

    test('brute-force counters persist across LockService instances via SecretStorage', async () => {
        const secrets = new FakeSecretStorage();
        const svc1 = new LockService(secrets);
        await svc1.enableLock('pass');
        svc1.lock();

        for (let i = 0; i < 3; i++) {
            await svc1.unlock('bad');
        }
        assert.strictEqual(svc1.isLockedOut, true, 'svc1 should be locked out after 3 failures');

        // A brand-new instance on the same storage loads the persisted lockout via init().
        const svc2 = new LockService(secrets);
        await svc2.init();
        assert.strictEqual(svc2.isLockedOut, true, 'svc2 should reflect persisted lockout state');

        // Even the correct password is rejected while locked out.
        const ok = await svc2.unlock('pass');
        assert.strictEqual(ok, false, 'correct password must be rejected during lockout');
    });
});
