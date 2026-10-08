import * as vscode from 'vscode';
import { ClusterStore, ClusterProfile } from '../store';
import { ClusterTreeItem } from '../treeDataProvider';
import { TerminalManager } from '../terminalManager';
import { registerGuardedCommand } from '../commandGuard';
import { log } from '../logger';
import { t } from '../i18n';

/**
 * AI terminals: a normal isolated cluster terminal (own KUBECONFIG, context, prompt, prod
 * warning) in which an AI coding CLI is started. The AI can only reach THIS cluster, because the
 * terminal's KUBECONFIG is the only credential it sees.
 *
 * Write commands stay behind the approval prompts of the AI tool itself — the default commands
 * pin the tool to its "ask first" mode, and commands that switch approvals off are refused.
 */

export type AiTool = 'claude' | 'codex';

interface AiToolInfo {
    label: string;
    /** Suffix of the `kubectl-control.ai.*` setting that holds the launch command. */
    setting: string;
    /** Launch command that keeps the tool in its ask-before-acting mode. */
    defaultCommand: string;
}

const TOOLS: Record<AiTool, AiToolInfo> = {
    claude: { label: 'Claude Code', setting: 'claudeCommand', defaultCommand: 'claude --permission-mode default' },
    codex: { label: 'Codex', setting: 'codexCommand', defaultCommand: 'codex --ask-for-approval untrusted' },
};

/** Executable plus plain arguments — no quotes, `;`, `&`, `|`, `$`, backticks, redirects. */
const SAFE_COMMAND_RE = /^[A-Za-z0-9._/-]+( [A-Za-z0-9._=:/@-]+)*$/;
/** Flags/words that switch the AI tool's approval prompts or sandbox off. */
const APPROVAL_BYPASS_RE = /dangerously|bypass|yolo|skip-permissions|full-auto|no-confirm|never/i;

/**
 * Validate a configured launch command. The text is typed into a terminal, so it must not
 * contain shell syntax, and it must not turn the tool's approvals off.
 * @returns the command to use, or `undefined` when it is not acceptable
 */
export function validateAiCommand(command: string): string | undefined {
    const trimmed = command.trim();
    if (!SAFE_COMMAND_RE.test(trimmed) || APPROVAL_BYPASS_RE.test(trimmed)) { return undefined; }
    // Only the AI tools themselves — not `bash ./script.sh` or `./evil` from some setting.
    const exe = trimmed.split(' ')[0].split('/').pop()!.replace(/\.(exe|cmd|bat)$/i, '');
    if (exe !== 'claude' && exe !== 'codex') { return undefined; }
    return trimmed;
}

function resolveCommand(tool: AiTool): string {
    const info = TOOLS[tool];
    const configured = vscode.workspace.getConfiguration('kubectl-control.ai').get<string>(info.setting, '');
    if (!configured.trim()) { return info.defaultCommand; }
    const valid = validateAiCommand(configured);
    if (valid) { return valid; }
    void vscode.window.showWarningMessage(
        t('The configured command for {0} is not allowed (shell characters or flags that disable approvals). The default is used instead.', info.label),
    );
    return info.defaultCommand;
}

async function pickCluster(store: ClusterStore): Promise<ClusterProfile | undefined> {
    const clusters = await store.getClusters();
    if (clusters.length === 0) {
        void vscode.window.showWarningMessage(t('No clusters configured.'));
        return undefined;
    }
    const items = clusters.map(c => ({ label: c.name, description: c.activeContext ?? '', cluster: c }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Select cluster') });
    return pick?.cluster;
}

async function pickTool(): Promise<AiTool | undefined> {
    const items = (Object.keys(TOOLS) as AiTool[]).map(tool => ({ label: TOOLS[tool].label, tool }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Which AI should be started?') });
    return pick?.tool;
}

/**
 * Start an AI terminal for `cluster` (production connections ask first). Shared by the command
 * and by the MCP bridge, so an agent opening a terminal goes through the same confirmation.
 */
export async function startAiTerminal(terminalManager: TerminalManager, cluster: ClusterProfile, tool: AiTool): Promise<void> {
    const info = TOOLS[tool];
    if (cluster.isProd) {
        const btnStart = t('Start {0}', info.label);
        const choice = await vscode.window.showWarningMessage(
            t('⚠️ "{0}" is a production environment. {1} will be able to run commands there. Start it anyway?', cluster.name, info.label),
            {
                modal: true,
                detail: t('Write commands (apply, delete, scale …) must be approved in the AI tool. Read every command before you confirm it.'),
            },
            btnStart,
        );
        if (choice !== btnStart) { return; }
    }
    const command = resolveCommand(tool);
    log.info(`AI terminal: ${info.label} for "${cluster.name}" (${command})`);
    await terminalManager.openAiTerminal(cluster, command);
}

export function registerAiTerminal(
    _context: vscode.ExtensionContext,
    store: ClusterStore,
    terminalManager: TerminalManager,
): vscode.Disposable[] {
    const openCmd = registerGuardedCommand(
        'kubectl-control.openAiTerminal',
        async (treeItem?: ClusterTreeItem) => {
            const cluster = treeItem instanceof ClusterTreeItem ? treeItem.profile : await pickCluster(store);
            if (!cluster) { return; }
            const tool = await pickTool();
            if (!tool) { return; }
            await startAiTerminal(terminalManager, cluster, tool);
        },
    );
    return [openCmd];
}
