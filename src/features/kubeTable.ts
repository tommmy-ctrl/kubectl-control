/**
 * Parser for kubectl's default table output (`kubectl get pods`, `kubectl get
 * deployments`, …). The table is printed server-side (the API server returns only
 * the displayed columns), so it is a small fraction of the size of `-o json` and
 * needs no client-side decoding of full objects — this is what keeps large
 * clusters fast. No vscode dependency, so it is unit-testable on its own.
 */

/** One table row keyed by the upper-case column header (e.g. `NAME`, `READY`). */
export type KubeTableRow = Record<string, string>;

/**
 * Parse kubectl table output (with headers) into rows.
 *
 * kubectl aligns columns with a tabwriter, so every column starts at the same
 * character offset as its header. Slicing by those offsets (instead of splitting
 * on whitespace) keeps values that contain spaces intact, e.g. RESTARTS
 * `3 (2m ago)` or a multi-word header like `NOMINATED NODE`.
 */
export function parseKubectlTable(stdout: string): KubeTableRow[] {
    const lines = stdout.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) { return []; }

    // Header tokens: words separated by single spaces belong to one header.
    const columns: { name: string; start: number }[] = [];
    const headerRe = /\S+(?: \S+)*/g;
    let m: RegExpExecArray | null;
    while ((m = headerRe.exec(lines[0])) !== null) {
        columns.push({ name: m[0], start: m.index });
    }
    if (columns.length === 0) { return []; }

    return lines.slice(1).map(line => {
        const row: KubeTableRow = {};
        columns.forEach((col, i) => {
            const end = i + 1 < columns.length ? columns[i + 1].start : undefined;
            row[col.name] = line.slice(col.start, end).trim();
        });
        return row;
    });
}

/** Map a pod STATUS column value to one of the viewer's colour classes. */
export function podStatusClass(status: string): 'running' | 'pending' | 'failed' | 'succeeded' | 'other' {
    const s = status.toLowerCase();
    if (s === 'running') { return 'running'; }
    if (s === 'completed' || s === 'succeeded') { return 'succeeded'; }
    if (s === 'pending' || s === 'containercreating' || s === 'podinitializing' || s.startsWith('init:')) { return 'pending'; }
    if (/error|crashloop|backoff|failed|oomkilled|evicted|errimage|invalid/.test(s)) { return 'failed'; }
    return 'other';
}
