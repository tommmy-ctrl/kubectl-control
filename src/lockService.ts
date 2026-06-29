import * as vscode from 'vscode';
import * as nodeCrypto from 'node:crypto';
import { deriveHash } from './crypto';
import { log } from './logger';

const ENABLED_KEY = 'kubectl-control.lock.enabled';
const HASH_KEY = 'kubectl-control.lock.hash';
const SALT_KEY = 'kubectl-control.lock.salt';

export class LockService {
    private _unlocked = false;
    private readonly _onStateChange = new vscode.EventEmitter<void>();
    readonly onStateChange = this._onStateChange.event;

    // S1 — Auto-lock timer
    private _autoLockTimer?: ReturnType<typeof setTimeout>;
    private _autoLockMinutes = 0;

    // S2 — Brute-force protection
    private _failedAttempts = 0;
    private _lockedUntil = 0;

    constructor(private readonly secrets: vscode.SecretStorage) {}

    async isEnabled(): Promise<boolean> {
        return (await this.secrets.get(ENABLED_KEY)) === 'true';
    }

    isUnlocked(): boolean {
        return this._unlocked;
    }

    // S2 — Lockout getters
    get isLockedOut(): boolean {
        return Date.now() < this._lockedUntil;
    }

    get lockoutRemainingSeconds(): number {
        return Math.max(0, Math.ceil((this._lockedUntil - Date.now()) / 1000));
    }

    async enableLock(password: string): Promise<void> {
        const salt = nodeCrypto.randomBytes(32).toString('hex');
        const hash = deriveHash(password, salt);
        await this.secrets.store(SALT_KEY, salt);
        await this.secrets.store(HASH_KEY, hash);
        await this.secrets.store(ENABLED_KEY, 'true');
        this._unlocked = true;
        // S2 — reset brute-force counters on fresh password set
        this._failedAttempts = 0;
        this._lockedUntil = 0;
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
        // S2 — check lockout before attempting verify
        if (Date.now() < this._lockedUntil) {
            return false;
        }

        const ok = await this.verify(password);
        if (ok) {
            // S2 — reset counters on success
            this._failedAttempts = 0;
            this._lockedUntil = 0;
            this._unlocked = true;
            this._onStateChange.fire();
            // S1 — start auto-lock timer after unlock
            this.resetAutoLockTimer();
        } else {
            // S2 — track failed attempts and apply lockout
            this._failedAttempts++;
            log.warn('Failed unlock attempt #' + this._failedAttempts);
            let lockMs = 0;
            if (this._failedAttempts >= 7)      { lockMs = 60_000; }
            else if (this._failedAttempts >= 5) { lockMs = 30_000; }
            else if (this._failedAttempts >= 3) { lockMs = 10_000; }
            if (lockMs > 0) { this._lockedUntil = Date.now() + lockMs; }
        }
        return ok;
    }

    lock(): void {
        // S1 — clear auto-lock timer when locking
        if (this._autoLockTimer) {
            clearTimeout(this._autoLockTimer);
            this._autoLockTimer = undefined;
        }
        this._unlocked = false;
        this._onStateChange.fire();
    }

    // S1 — Auto-lock methods
    setAutoLock(minutes: number): void {
        this._autoLockMinutes = minutes;
        if (minutes > 0) {
            this.resetAutoLockTimer();
        } else {
            if (this._autoLockTimer) {
                clearTimeout(this._autoLockTimer);
                this._autoLockTimer = undefined;
            }
        }
    }

    private resetAutoLockTimer(): void {
        if (this._autoLockTimer) {
            clearTimeout(this._autoLockTimer);
            this._autoLockTimer = undefined;
        }
        if (this._autoLockMinutes > 0 && this._unlocked === true) {
            this._autoLockTimer = setTimeout(() => {
                log.info('Auto-lock triggered after inactivity');
                this.lock();
            }, this._autoLockMinutes * 60_000);
        }
    }

    recordActivity(): void {
        if (this._unlocked && this._autoLockMinutes > 0) {
            this.resetAutoLockTimer();
        }
    }
}
