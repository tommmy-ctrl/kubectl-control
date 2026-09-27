import * as vscode from 'vscode';
import type { LockService } from './lockService';
import { t } from './i18n';

/*
 * SECURITY: single choke point for the extension lock. Every command that reads
 * cluster data, runs kubectl/helm, or changes connections must be registered via
 * registerGuardedCommand() (or call ensureUnlocked() itself), so a new command
 * cannot silently bypass the lock the way the feature modules used to.
 */

let lockService: LockService | undefined;

export function initCommandGuard(service: LockService): void {
    lockService = service;
}

/** Non-interactive: true while the lock is enabled and not unlocked. */
export async function isLocked(): Promise<boolean> {
    if (!lockService) { return false; }
    return await lockService.isEnabled() && !lockService.isUnlocked();
}

/**
 * Interactive: returns true if the action may proceed (lock disabled or
 * unlocked, counting as activity for auto-lock); otherwise focuses the unlock
 * view, shows a warning and returns false.
 */
export async function ensureUnlocked(): Promise<boolean> {
    if (!lockService) { return true; }
    if (!await isLocked()) {
        lockService.recordActivity();
        return true;
    }
    await vscode.commands.executeCommand('kubectl-control.connectionsView.focus');
    void vscode.window.showWarningMessage(t('Kubectl Control is locked. Please unlock first.'));
    return false;
}

/** `vscode.commands.registerCommand` that refuses to run while the extension is locked. */
export function registerGuardedCommand(
    command: string,
    handler: (...args: any[]) => unknown,
): vscode.Disposable {
    return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        if (!await ensureUnlocked()) { return; }
        return handler(...args);
    });
}
