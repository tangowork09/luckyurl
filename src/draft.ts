/**
 * Optional local-model auto-draft: pipe a lead's pitch prompt through the
 * user's local `ensemble` CLI to pre-generate a pitch draft, fully offline and
 * free. Strictly opt-in (--draft) and best-effort — if `ensemble` isn't
 * installed or errors, the scan continues and only the prompt file remains.
 */
import { spawn } from 'node:child_process';

const DRAFT_TIMEOUT_MS = 120_000;

/** True if the `ensemble` CLI appears to be on PATH. */
export async function ensembleAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ensemble', ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Run `ensemble` solo on the given prompt and return its stdout, or null on any
 * failure/timeout. Model choice is left to the user's ensemble config.
 */
export async function draftWithEnsemble(prompt: string, model?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ['run'];
    if (model) args.push('--model', model);
    const p = spawn('ensemble', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      done(null);
    }, DRAFT_TIMEOUT_MS);

    p.on('error', () => done(null));
    p.stdout.on('data', (d) => {
      out += String(d);
    });
    p.on('close', (code) => done(code === 0 && out.trim() ? out : null));

    p.stdin.write(prompt);
    p.stdin.end();
  });
}
