/**
 * HTML template functions for the ConnectionsView webview panels.
 *
 * Each function returns a complete HTML document string.  The caller
 * (connectionsView.ts) supplies the nonce, webview CSP source, and resolved
 * UI language so that this module has zero dependency on the VS Code API.
 */

import type { Lang } from '../i18n';
import { de } from '../i18n/translations.de';

// ── Translation helper (mirrors t() in ../i18n.ts, without the vscode dependency) ──

function wt(lang: Lang, key: string, ...args: (string | number)[]): string {
    const template = lang === 'de' ? (de[key] ?? key) : key;
    return args.length === 0
        ? template
        : template.replace(/\{(\d+)\}/g, (match, idx: string) => {
            const i = Number(idx);
            return i < args.length ? String(args[i]) : match;
        });
}

// ── Shared CSS ───────────────────────────────────────────────────────────────

export function baseStyles(): string {
    return `
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            padding: 16px 14px;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.5;
        }
        form { display: flex; flex-direction: column; gap: 14px; }
        input, textarea {
            width: 100%;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
            border-radius: 4px;
            padding: 7px 9px;
            font-family: var(--vscode-font-family);
            font-size: inherit;
            outline: none;
            transition: border-color 0.15s;
        }
        input:focus, textarea:focus {
            border-color: var(--vscode-focusBorder);
        }
        textarea {
            min-height: 180px;
            resize: vertical;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.88rem;
            line-height: 1.55;
        }
        button {
            border: 0; border-radius: 4px;
            padding: 7px 12px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 0.88rem;
            font-weight: 500;
            transition: background 0.15s, opacity 0.15s;
        }
        .btn-primary {
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-ghost {
            color: var(--vscode-descriptionForeground);
            background: transparent;
            border: 1px solid var(--vscode-button-secondaryBackground);
        }
        .btn-ghost:hover { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
        @keyframes shake {
            0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-4px)} 40%,80%{transform:translateX(4px)}
        }
        .input-error { animation:shake 0.35s ease; border-color:var(--vscode-inputValidation-errorBorder, #f48771) !important; }
    `;
}

// ── Welcome screen ────────────────────────────────────────────────────────────

export function welcomeHtml(nonce: string, cspSource: string, lang: Lang): string {
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 24px 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }

        /* ── Hero ── */
        .hero {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px;
            text-align: center;
            margin-bottom: 28px;
        }
        .hero-icon {
            font-size: 2.8rem;
            line-height: 1;
            margin-bottom: 4px;
            opacity: 0.9;
        }
        .hero-title {
            font-size: 1.25rem;
            font-weight: 700;
            letter-spacing: -0.01em;
            line-height: 1.3;
        }
        .hero-sub {
            font-size: 0.85rem;
            color: var(--vscode-descriptionForeground);
            line-height: 1.55;
            max-width: 240px;
        }

        /* ── Steps ── */
        .steps { width: 100%; max-width: 280px; }
        .step { display: none; flex-direction: column; align-items: center; gap: 14px; width: 100%; }
        .step.active { display: flex; }

        /* Step counter */
        .step-counter {
            font-size: 0.75rem;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            opacity: 0.7;
        }

        /* Step card */
        .step-card {
            width: 100%;
            background: var(--vscode-sideBarSectionHeader-background);
            border: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.07));
            border-radius: 6px;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .step-title {
            font-size: 0.9rem;
            font-weight: 600;
            text-align: center;
        }
        .step-desc {
            font-size: 0.82rem;
            color: var(--vscode-descriptionForeground);
            line-height: 1.5;
            text-align: center;
        }
        .hint {
            font-size: 0.78rem;
            color: var(--vscode-inputValidation-warningForeground, #cca700);
            text-align: center;
            min-height: 1em;
        }

        /* Buttons */
        .btn-col { display: flex; flex-direction: column; gap: 7px; width: 100%; }
        button {
            width: 100%;
            padding: 7px 12px;
            border: 0;
            border-radius: 4px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 0.88rem;
            font-weight: 500;
            transition: background 0.15s, opacity 0.15s;
        }
        .btn-primary {
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-ghost {
            color: var(--vscode-descriptionForeground);
            background: transparent;
            border: 1px solid var(--vscode-button-secondaryBackground);
        }
        .btn-ghost:hover { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }

        /* Done */
        .done-check { font-size: 2.2rem; text-align: center; }
    </style>
</head>
<body>
    <div class="hero">
        <div class="hero-icon">☸</div>
        <div class="hero-title">${wt(lang, 'Welcome to<br>Kubectl Control')}</div>
        <div class="hero-sub">${wt(lang, 'Manage multiple Kubernetes clusters with isolated terminals directly in VS Code.')}</div>
    </div>

    <div class="steps">

        <!-- Step: welcome -->
        <div class="step active" id="step-welcome">
            <div class="btn-col">
                <button class="btn-primary" id="btnStart">${wt(lang, 'Start Setup')}</button>
                <button class="btn-ghost" id="btnSkip">${wt(lang, 'Skip')}</button>
            </div>
        </div>

        <!-- Step: kubeconfig -->
        <div class="step" id="step-kubeconfig">
            <div class="step-counter">${wt(lang, 'Step 1 of 3')}</div>
            <div class="step-card">
                <div class="step-title">${wt(lang, 'Detect Local Connections')}</div>
                <div class="step-desc">${wt(lang, 'Would you like to import existing contexts from ~/.kube/config?')}</div>
                <div class="btn-col">
                    <button class="btn-primary" id="btnKubeconfigYes">${wt(lang, 'Import Now')}</button>
                    <button class="btn-ghost" id="btnKubeconfigNo">${wt(lang, 'Skip')}</button>
                </div>
            </div>
        </div>

        <!-- Step: import -->
        <div class="step" id="step-import">
            <div class="step-counter">${wt(lang, 'Step 2 of 3')}</div>
            <div class="step-card">
                <div class="step-title">${wt(lang, 'Import Connections?')}</div>
                <div class="step-desc">${wt(lang, 'Do you already have an export file with cluster connections?')}</div>
                <div class="hint" id="importHint"></div>
                <div class="btn-col">
                    <button class="btn-primary" id="btnImportYes">${wt(lang, 'Choose File')}</button>
                    <button class="btn-ghost" id="btnImportNo">${wt(lang, 'Skip')}</button>
                </div>
            </div>
        </div>

        <!-- Step: password -->
        <div class="step" id="step-password">
            <div class="step-counter">${wt(lang, 'Step 3 of 3')}</div>
            <div class="step-card">
                <div class="step-title">${wt(lang, 'Password Protection?')}</div>
                <div class="step-desc">${wt(lang, 'Protect the extension with a password on open.')}</div>
                <div class="btn-col">
                    <button class="btn-primary" id="btnPwdYes">${wt(lang, 'Enable')}</button>
                    <button class="btn-ghost" id="btnPwdNo">${wt(lang, 'Skip')}</button>
                </div>
            </div>
        </div>

        <!-- Step: tutorial -->
        <div class="step" id="step-tutorial">
            <div class="step-card" style="gap:14px;">
                <div class="step-title" style="font-size:1rem;">${wt(lang, 'Welcome to Kubectl Control 🎉')}</div>
                <div class="step-desc" style="text-align:left;">${wt(lang, "Here's an overview of all features:")}</div>
                <ul style="list-style:none;display:flex;flex-direction:column;gap:9px;padding:0;">
                    <li style="display:flex;gap:8px;align-items:flex-start;font-size:0.82rem;line-height:1.45;">
                        <span style="flex-shrink:0;">🖥️</span>
                        <span><strong>${wt(lang, 'Open Terminal')}</strong> — ${wt(lang, 'Click a cluster to start an isolated terminal with the right kubeconfig')}</span>
                    </li>
                    <li style="display:flex;gap:8px;align-items:flex-start;font-size:0.82rem;line-height:1.45;">
                        <span style="flex-shrink:0;">⚡</span>
                        <span><strong>Quick Switch</strong> — <code style="font-size:0.78rem;background:var(--vscode-textCodeBlock-background,rgba(255,255,255,0.1));padding:1px 4px;border-radius:3px;">Ctrl+Shift+K</code> ${wt(lang, 'opens the cluster quick-switch')}</span>
                    </li>
                    <li style="display:flex;gap:8px;align-items:flex-start;font-size:0.82rem;line-height:1.45;">
                        <span style="flex-shrink:0;">🔒</span>
                        <span><strong>${wt(lang, 'Password Protection')}</strong> — ${wt(lang, 'protect your connections with a password (Settings → Enable Password Protection)')}</span>
                    </li>
                    <li style="display:flex;gap:8px;align-items:flex-start;font-size:0.82rem;line-height:1.45;">
                        <span style="flex-shrink:0;">☁️</span>
                        <span><strong>GitHub Sync</strong> — ${wt(lang, 'sync connections encrypted with your GitHub account (Settings → Set Up GitHub Sync)')}</span>
                    </li>
                    <li style="display:flex;gap:8px;align-items:flex-start;font-size:0.82rem;line-height:1.45;">
                        <span style="flex-shrink:0;">📤</span>
                        <span><strong>${wt(lang, 'Export / Import')}</strong> — ${wt(lang, 'create encrypted backups of your connections')}</span>
                    </li>
                    <li style="display:flex;gap:8px;align-items:flex-start;font-size:0.82rem;line-height:1.45;">
                        <span style="flex-shrink:0;">🏷️</span>
                        <span><strong>${wt(lang, 'Groups')}</strong> — ${wt(lang, 'organize clusters into groups')}</span>
                    </li>
                    <li style="display:flex;gap:8px;align-items:flex-start;font-size:0.82rem;line-height:1.45;">
                        <span style="flex-shrink:0;">✏️</span>
                        <span><strong>${wt(lang, 'Edit')}</strong> — ${wt(lang, 'right-click a cluster to edit or delete it')}</span>
                    </li>
                </ul>
                <button class="btn-primary" id="btnTutorialDone" style="margin-top:4px;">${wt(lang, "Let's go!")}</button>
            </div>
        </div>

        <!-- Step: done -->
        <div class="step" id="step-done">
            <div class="done-check">✅</div>
            <div class="step-card">
                <div class="step-title">${wt(lang, 'Setup Complete')}</div>
                <div class="step-desc">${wt(lang, 'You can now add connections and open cluster terminals.')}</div>
                <button class="btn-primary" id="btnDone">${wt(lang, "Let's go")}</button>
            </div>
        </div>

    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        function showStep(id) {
            document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
            document.getElementById('step-' + id).classList.add('active');
        }

        document.getElementById('btnStart').addEventListener('click', () => showStep('kubeconfig'));
        document.getElementById('btnSkip').addEventListener('click', () => vscode.postMessage({ command: 'setupSkip' }));

        document.getElementById('btnKubeconfigYes').addEventListener('click', () => vscode.postMessage({ command: 'setupKubeconfig' }));
        document.getElementById('btnKubeconfigNo').addEventListener('click', () => showStep('import'));

        document.getElementById('btnImportYes').addEventListener('click', () => {
            document.getElementById('importHint').textContent = '';
            vscode.postMessage({ command: 'setupImportYes' });
        });
        document.getElementById('btnImportNo').addEventListener('click', () => vscode.postMessage({ command: 'setupImportNo' }));

        document.getElementById('btnPwdYes').addEventListener('click', () => vscode.postMessage({ command: 'setupPasswordYes' }));
        document.getElementById('btnPwdNo').addEventListener('click', () => vscode.postMessage({ command: 'setupPasswordNo' }));
        document.getElementById('btnTutorialDone').addEventListener('click', () => vscode.postMessage({ command: 'setupDone' }));
        document.getElementById('btnDone').addEventListener('click', () => vscode.postMessage({ command: 'setupDone' }));

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'setupGoto') { showStep(msg.step); }
            if (msg.command === 'setupImportCancelled') {
                document.getElementById('importHint').textContent = ${JSON.stringify(wt(lang, 'No file selected. Please try again or skip.'))};
            }
        });
    </script>
</body>
</html>`;
}

// ── Lock screen ───────────────────────────────────────────────────────────────

export function lockHtml(nonce: string, cspSource: string, lang: Lang): string {
    const [lockedOutPrefix, lockedOutSuffix] = wt(lang, 'Too many failed attempts. Please wait {0} seconds.').split('{0}');
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${baseStyles()}
        body { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; }
        .lock-card {
            width:100%; max-width:280px;
            display:flex; flex-direction:column; align-items:center; gap:20px;
        }
        .lock-icon { font-size:2.4rem; opacity:0.85; }
        .lock-title { font-size:1rem; font-weight:600; text-align:center; }
        .lock-form { width:100%; display:flex; flex-direction:column; gap:10px; }
        .field-label { font-size:0.78rem; color:var(--vscode-descriptionForeground); margin-bottom:3px; display:block; }
        .error-msg {
            font-size:0.8rem; color:var(--vscode-inputValidation-errorForeground, #f48771);
            background:var(--vscode-inputValidation-errorBackground, rgba(244,135,113,0.1));
            border:1px solid var(--vscode-inputValidation-errorBorder, #f48771);
            border-radius:3px; padding:6px 8px; display:none;
        }
    </style>
</head>
<body>
    <div class="lock-card">
        <div class="lock-icon">🔒</div>
        <div class="lock-title">${wt(lang, 'Kubectl Control is locked')}</div>
        <form class="lock-form" id="lockForm">
            <div>
                <span class="field-label">${wt(lang, 'Password')}</span>
                <input type="password" id="lockPwd" autofocus placeholder="${wt(lang, 'Enter password…')}">
            </div>
            <button type="submit" class="btn-primary">${wt(lang, 'Unlock')}</button>
            <div class="error-msg" id="lockError">${wt(lang, 'Incorrect password. Please try again.')}</div>
        </form>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('lockForm').addEventListener('submit', e => {
            e.preventDefault();
            document.getElementById('lockError').style.display = 'none';
            vscode.postMessage({ command: 'unlock', password: document.getElementById('lockPwd').value });
        });
        window.addEventListener('message', event => {
            if (event.data.command === 'unlockFailed') {
                const err = document.getElementById('lockError');
                err.textContent = ${JSON.stringify(wt(lang, 'Incorrect password. Please try again.'))};
                err.style.display = '';
                const pwd = document.getElementById('lockPwd');
                pwd.value = ''; pwd.focus();
                pwd.classList.add('input-error');
                setTimeout(() => pwd.classList.remove('input-error'), 1500);
            }
            if (event.data.command === 'unlockLockedOut') {
                const err = document.getElementById('lockError');
                err.textContent = ${JSON.stringify(lockedOutPrefix)} + event.data.seconds + ${JSON.stringify(lockedOutSuffix)};
                err.style.display = '';
                const pwd = document.getElementById('lockPwd');
                const btn = document.querySelector('button[type="submit"]');
                pwd.disabled = true;
                btn.disabled = true;
                setTimeout(() => {
                    err.style.display = 'none';
                    pwd.disabled = false;
                    btn.disabled = false;
                    pwd.focus();
                }, event.data.seconds * 1000);
            }
        });
    </script>
</body>
</html>`;
}

// ── Cluster add/edit form ─────────────────────────────────────────────────────

export function formHtml(nonce: string, cspSource: string, version: string, lang: Lang): string {
    // version originates from package.json (semver); restrict to a safe charset defensively.
    const safeVersion = String(version).replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 40) || 'unknown';
    const nsPrefix = wt(lang, 'Namespace: {0}').split('{0}')[0];
    const [ctxPrefix, ctxRest] = wt(lang, '{0} context{1} detected').split('{0}');
    const [ctxMid, ctxSuffix] = ctxRest.split('{1}');
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${baseStyles()}
        .form-header {
            display: flex; align-items: center; gap: 7px;
            font-size: 0.82rem; font-weight: 600; letter-spacing: 0.03em;
            color: var(--vscode-descriptionForeground); text-transform: uppercase;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.06));
        }
        .edit-badge {
            display: none; font-size: 0.7rem; font-weight: 500;
            background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
            border-radius: 3px; padding: 1px 6px; letter-spacing: 0;
        }
        .field-group { display: flex; flex-direction: column; gap: 4px; }
        .field-label { font-size: 0.8rem; color: var(--vscode-foreground); font-weight: 500; }
        .field-hint { font-size: 0.75rem; color: var(--vscode-descriptionForeground); }
        .field-row { display: flex; gap: 7px; }
        .field-row .field-group { flex: 1; }
        .textarea-wrap { position: relative; }
        .btn-load-file {
            position: absolute; top: 6px; right: 6px;
            padding: 3px 8px; font-size: 0.75rem;
            border-radius: 3px; cursor: pointer;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 0;
        }
        .btn-load-file:hover { background: var(--vscode-button-secondaryHoverBackground); }
        select {
            width: 100%; padding: 7px 9px; border-radius: 4px;
            color: var(--vscode-dropdown-foreground);
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
            font-family: var(--vscode-font-family); font-size: inherit; outline: none;
        }
        select:focus { border-color: var(--vscode-focusBorder); }
        .validation-msg {
            font-size: 0.78rem; padding: 5px 8px; border-radius: 3px; display: none;
        }
        .validation-msg.error {
            color: var(--vscode-inputValidation-errorForeground, #f48771);
            background: var(--vscode-inputValidation-errorBackground, rgba(244,135,113,0.1));
            border: 1px solid var(--vscode-inputValidation-errorBorder, #f48771);
        }
        .validation-msg.ok {
            color: var(--vscode-terminal-ansiGreen, #89d185);
            background: rgba(137,209,133,0.08);
            border: 1px solid rgba(137,209,133,0.3);
        }
        .btn-row { display: flex; gap: 7px; margin-top: 2px; }
        .btn-row .btn-primary { flex: 1; }
        #contextGroup { display: none; }
        .prompt-color-row { display: flex; align-items: center; gap: 12px; }
        .checkbox-inline {
            display: flex; align-items: center; gap: 7px; cursor: pointer;
            font-size: 0.85rem; color: var(--vscode-foreground); user-select: none;
        }
        .checkbox-inline input { cursor: pointer; margin: 0; }
        #promptColor {
            width: 46px; height: 28px; padding: 2px; flex: 0 0 auto;
            border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
            border-radius: 4px; background: var(--vscode-input-background); cursor: pointer;
        }
        #promptColor:disabled { opacity: 0.4; cursor: not-allowed; }
        .version-footer {
            margin-top: 14px; padding-top: 8px;
            border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.06));
            font-size: 0.68rem; text-align: right;
            color: var(--vscode-descriptionForeground); opacity: 0.55;
            user-select: text;
        }
    </style>
</head>
<body>
    <form id="clusterForm">
        <input type="hidden" id="editId">

        <div class="form-header">
            <span id="formTitle">${wt(lang, 'New Connection')}</span>
            <span class="edit-badge" id="editBadge">${wt(lang, 'Edit')}</span>
        </div>

        <div class="field-group">
            <label class="field-label" for="clusterName">${wt(lang, 'Name')}</label>
            <input id="clusterName" type="text" placeholder="Production, Staging, Minikube" autocomplete="off">
        </div>

        <div class="field-row">
            <div class="field-group">
                <label class="field-label" for="groupInput">${wt(lang, 'Group')} <span style="opacity:0.5">(${wt(lang, 'optional')})</span></label>
                <input id="groupInput" type="text" placeholder="${wt(lang, 'e.g. Production')}">
            </div>
            <div class="field-group">
                <label class="field-label" for="shellSelect">${wt(lang, 'Shell')}</label>
                <select id="shellSelect">
                    <option value="default">${wt(lang, 'Default')}</option>
                    <option value="bash">bash</option>
                    <option value="zsh">zsh</option>
                    <option value="powershell">PowerShell</option>
                    <option value="cmd">cmd</option>
                </select>
            </div>
        </div>

        <div class="field-group">
            <label class="field-label">${wt(lang, 'Terminal Prompt Color')} <span style="opacity:0.5">(${wt(lang, 'optional')})</span></label>
            <div class="prompt-color-row">
                <label class="checkbox-inline">
                    <input type="checkbox" id="promptColorEnabled">
                    <span>${wt(lang, 'Color the prompt')}</span>
                </label>
                <input type="color" id="promptColor" value="#4ec9b0" disabled title="${wt(lang, 'Choose color')}">
            </div>
            <span class="field-hint">${wt(lang, 'Colors the <code>kubectl@name &gt;</code> prompt in the terminal.')}</span>
        </div>

        <div class="field-group">
            <label class="field-label" for="kubeconfigData">${wt(lang, 'Kubeconfig')}</label>
            <div class="textarea-wrap">
                <textarea id="kubeconfigData" placeholder="apiVersion: v1&#10;kind: Config&#10;clusters:&#10;  - …"></textarea>
                <button type="button" class="btn-load-file" id="btnLoadFile" title="${wt(lang, 'Load from file')}">📂 ${wt(lang, 'Load')}</button>
            </div>
            <div class="validation-msg" id="validationMsg"></div>
            <span class="field-hint">${wt(lang, 'Paste or load the YAML content of the kubeconfig file')}</span>
        </div>

        <div class="field-group" id="contextGroup">
            <label class="field-label" for="contextSelect">${wt(lang, 'Context')}</label>
            <select id="contextSelect"></select>
            <span class="field-hint" id="namespaceHint"></span>
        </div>

        <div class="btn-row">
            <button type="submit" class="btn-primary" id="submitBtn">${wt(lang, 'Save Connection')}</button>
            <button type="button" class="btn-ghost" id="cancelBtn" style="display:none">${wt(lang, 'Cancel')}</button>
        </div>
    </form>

    <div class="version-footer" title="${wt(lang, 'Installed version of kubectl-control')}">kubectl-control v${safeVersion}</div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const form         = document.getElementById('clusterForm');
        const clusterName  = document.getElementById('clusterName');
        const kubeconfigEl = document.getElementById('kubeconfigData');
        const editId       = document.getElementById('editId');
        const groupInput   = document.getElementById('groupInput');
        const shellSelect  = document.getElementById('shellSelect');
        const promptColorEnabled = document.getElementById('promptColorEnabled');
        const promptColor  = document.getElementById('promptColor');
        const contextGroup = document.getElementById('contextGroup');
        const contextSelect= document.getElementById('contextSelect');
        const namespaceHint= document.getElementById('namespaceHint');
        const validationMsg= document.getElementById('validationMsg');
        const submitBtn    = document.getElementById('submitBtn');
        const cancelBtn    = document.getElementById('cancelBtn');
        const formTitle    = document.getElementById('formTitle');
        const editBadge    = document.getElementById('editBadge');
        const btnLoadFile  = document.getElementById('btnLoadFile');

        let parseTimer = null;
        let contexts = [];

        // ── Helpers ──────────────────────────────────────────────────────────

        function shake(el) {
            el.classList.remove('input-error');
            void el.offsetWidth;
            el.classList.add('input-error');
            setTimeout(() => el.classList.remove('input-error'), 400);
        }

        function showValidation(type, text) {
            validationMsg.className = 'validation-msg ' + type;
            validationMsg.textContent = text;
            validationMsg.style.display = text ? '' : 'none';
        }

        function updateContextSelect(parsedContexts, currentContext) {
            contexts = parsedContexts;
            contextSelect.innerHTML = '';
            parsedContexts.forEach(ctx => {
                const opt = document.createElement('option');
                opt.value = ctx.name;
                opt.textContent = ctx.name + (ctx.namespace ? '  ·  ' + ctx.namespace : '');
                if (ctx.name === currentContext) { opt.selected = true; }
                contextSelect.appendChild(opt);
            });
            contextGroup.style.display = parsedContexts.length > 1 ? '' : 'none';
            updateNamespaceHint();
        }

        function updateNamespaceHint() {
            const selected = contexts.find(c => c.name === contextSelect.value);
            namespaceHint.textContent = selected ? ${JSON.stringify(nsPrefix)} + (selected.namespace || ${JSON.stringify(wt(lang, 'default'))}) : '';
        }

        // ── Prompt colour toggle ─────────────────────────────────────────────

        promptColorEnabled.addEventListener('change', () => {
            promptColor.disabled = !promptColorEnabled.checked;
        });

        // ── kubeconfig parsing (debounced) ───────────────────────────────────

        function scheduleParseKubeconfig() {
            clearTimeout(parseTimer);
            parseTimer = setTimeout(() => {
                const yaml = kubeconfigEl.value.trim();
                if (yaml) { vscode.postMessage({ command: 'parseKubeconfig', yaml }); }
                else { showValidation('', ''); contextGroup.style.display = 'none'; }
            }, 600);
        }

        kubeconfigEl.addEventListener('input', scheduleParseKubeconfig);

        // ── Load from file ───────────────────────────────────────────────────

        btnLoadFile.addEventListener('click', () => vscode.postMessage({ command: 'loadKubeconfigFile' }));

        // ── Context select ───────────────────────────────────────────────────

        contextSelect.addEventListener('change', updateNamespaceHint);

        // ── Edit mode ────────────────────────────────────────────────────────

        function enterEditMode(id, name, config, group, shell, promptColorValue) {
            editId.value = id;
            clusterName.value = name;
            kubeconfigEl.value = config;
            groupInput.value = group || '';
            shellSelect.value = shell || 'default';
            if (promptColorValue) {
                promptColorEnabled.checked = true;
                promptColor.disabled = false;
                promptColor.value = promptColorValue;
            } else {
                promptColorEnabled.checked = false;
                promptColor.disabled = true;
            }
            submitBtn.textContent = ${JSON.stringify(wt(lang, 'Save Changes'))};
            cancelBtn.style.display = '';
            formTitle.textContent = name;
            editBadge.style.display = '';
            scheduleParseKubeconfig();
            clusterName.focus();
        }

        function exitEditMode() {
            editId.value = ''; clusterName.value = ''; kubeconfigEl.value = '';
            groupInput.value = ''; shellSelect.value = 'default';
            promptColorEnabled.checked = false; promptColor.disabled = true; promptColor.value = '#4ec9b0';
            submitBtn.textContent = ${JSON.stringify(wt(lang, 'Save Connection'))};
            cancelBtn.style.display = 'none';
            formTitle.textContent = ${JSON.stringify(wt(lang, 'New Connection'))};
            editBadge.style.display = 'none';
            showValidation('', '');
            contextGroup.style.display = 'none';
        }

        // ── Form submit ──────────────────────────────────────────────────────

        cancelBtn.addEventListener('click', exitEditMode);
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (!clusterName.value.trim())  { shake(clusterName);  clusterName.focus();  return; }
            if (!kubeconfigEl.value.trim()) { shake(kubeconfigEl); kubeconfigEl.focus(); return; }
            const payload = {
                name:          clusterName.value.trim(),
                kubeconfigData:kubeconfigEl.value.trim(),
                group:         groupInput.value.trim(),
                shell:         shellSelect.value,
                activeContext: contextSelect.value || '',
                promptColor:   promptColorEnabled.checked ? promptColor.value : '',
            };
            vscode.postMessage(editId.value
                ? { command: 'updateCluster', id: editId.value, ...payload }
                : { command: 'addCluster', ...payload }
            );
            exitEditMode();
        });

        // ── Messages from extension ──────────────────────────────────────────

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'prefillEdit') {
                enterEditMode(msg.id, msg.name, msg.kubeconfigData, msg.group, msg.shell, msg.promptColor);
            }
            if (msg.command === 'kubeconfigParsed') {
                const r = msg.result;
                if (!r.valid) {
                    showValidation('error', r.error ?? ${JSON.stringify(wt(lang, 'Invalid kubeconfig'))});
                    contextGroup.style.display = 'none';
                } else {
                    const ctxCount = r.contexts.length;
                    showValidation('ok', ${JSON.stringify(ctxPrefix)} + ctxCount + ${JSON.stringify(ctxMid)} + (ctxCount !== 1 ? 's' : '') + ${JSON.stringify(ctxSuffix)});
                    updateContextSelect(r.contexts, r.currentContext);
                }
            }
            if (msg.command === 'kubeconfigFileLoaded') {
                kubeconfigEl.value = msg.yaml;
                scheduleParseKubeconfig();
            }
        });
    </script>
</body>
</html>`;
}
