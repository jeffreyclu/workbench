import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanClaudeLocalUsage, scanCodexLocalUsage } from '../src/server/local-usage.js';

const args = process.argv.slice(2);
const daysIndex = args.indexOf('--days');
const days = daysIndex === -1 ? 7 : Number(args[daysIndex + 1]);
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days must be an integer from 1 through 90.');

const until = new Date();
const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1_000);
const claudeRoot = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
const codexRoot = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');

process.stdout.write(`${JSON.stringify({
  generatedAt: until.toISOString(), period: { since: since.toISOString(), until: until.toISOString(), days },
  claude: scanClaudeLocalUsage(since, until, claudeRoot), codex: scanCodexLocalUsage(since, until, codexRoot),
  calibration: {
    claude: 'Local transcripts provide token traffic, but Anthropic does not expose the official weekly percentage to the CLI. Do not write a ceiling calibration without an interactive /usage observation.',
    codex: 'Local session logs provide token traffic. Codex app-server percentages are short rate-limit windows, not a weekly percentage; do not use them to calibrate the ISO-week ceiling.',
  },
}, null, 2)}\n`);
