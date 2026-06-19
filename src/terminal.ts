import { ClusterProfile } from './store';
import { TerminalManager } from './terminalManager';

// Kept for backward-compatibility with dynamic import in commands.ts
export async function openTerminalForCluster(profile: ClusterProfile, manager: TerminalManager): Promise<void> {
    await manager.openOrFocus(profile);
}
