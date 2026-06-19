import * as vscode from 'vscode';

class Logger {
    private channel: vscode.OutputChannel;

    constructor() {
        this.channel = vscode.window.createOutputChannel('Kubectl Control');
    }

    info(msg: string, ...args: unknown[]): void { this.write('INFO ', msg, args); }
    warn(msg: string, ...args: unknown[]): void { this.write('WARN ', msg, args); }

    error(msg: string, err?: unknown): void {
        this.write('ERROR', msg, []);
        if (err instanceof Error) {
            this.channel.appendLine(`         ${err.stack ?? err.message}`);
        } else if (err !== undefined) {
            this.channel.appendLine(`         ${String(err)}`);
        }
    }

    show(): void { this.channel.show(true); }

    private write(level: string, msg: string, args: unknown[]): void {
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
        const extra = args.length
            ? ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
            : '';
        this.channel.appendLine(`[${ts}] [${level}] ${msg}${extra}`);
    }
}

export const log = new Logger();
