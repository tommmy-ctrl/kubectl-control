import * as vscode from 'vscode';
import * as nodeCrypto from 'node:crypto';
import { deriveHash } from './crypto';

const ENABLED_KEY = 'kubectl-control.lock.enabled';
const HASH_KEY = 'kubectl-control.lock.hash';
const SALT_KEY = 'kubectl-control.lock.salt';

export class LockService {
    private _unlocked = false;
    private readonly _onStateChange = new vscode.EventEmitter<void>();
    readonly onStateChange = this._onStateChange.event;

    constructor(private readonly secrets: vscode.SecretStorage) {}

    async isEnabled(): Promise<boolean> {
        return (await this.secrets.get(ENABLED_KEY)) === 'true';
    }

    isUnlocked(): boolean {
        return this._unlocked;
    }

    async enableLock(password: string): Promise<void> {
        const salt = nodeCrypto.randomBytes(32).toString('hex');
        const hash = deriveHash(password, salt);
        await this.secrets.store(SALT_KEY, salt);
        await this.secrets.store(HASH_KEY, hash);
        await this.secrets.store(ENABLED_KEY, 'true');
        this._unlocked = true;
        this._onStateChange.fire();
    }

    async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
        if (!await this.verify(oldPassword)) { return false; }
        await this.enableLock(newPassword);
        return true;
    }

    async disableLock(password: string): Promise<boolean> {
        if (!await this.verify(password)) { return false; }
        await this.disableLockForce();
        return true;
    }

    async disableLockForce(): Promise<void> {
        await this.secrets.delete(HASH_KEY);
        await this.secrets.delete(SALT_KEY);
        await this.secrets.store(ENABLED_KEY, 'false');
        this._unlocked = false;
        this._onStateChange.fire();
    }

    async verify(password: string): Promise<boolean> {
        const salt = await this.secrets.get(SALT_KEY);
        const stored = await this.secrets.get(HASH_KEY);
        if (!salt || !stored) { return false; }
        const candidate = deriveHash(password, salt);
        // Use timing-safe comparison to prevent timing attacks
        try {
            return nodeCrypto.timingSafeEqual(
                Buffer.from(candidate, 'hex'),
                Buffer.from(stored, 'hex'),
            );
        } catch {
            return false;
        }
    }

    async unlock(password: string): Promise<boolean> {
        const ok = await this.verify(password);
        if (ok) {
            this._unlocked = true;
            this._onStateChange.fire();
        }
        return ok;
    }

    lock(): void {
        this._unlocked = false;
        this._onStateChange.fire();
    }
}
