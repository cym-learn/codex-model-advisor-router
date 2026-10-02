import { enableConfig, disableConfig } from '../src/config.mjs';

const [action, configPath, baseUrl, backupDir] = process.argv.slice(2);
if (!['enable', 'disable'].includes(action) || !configPath) {
  process.stderr.write('Usage: node config-cli.mjs enable|disable <config-path> [base-url] [backup-dir]\n');
  process.exit(2);
}
const result = action === 'enable'
  ? enableConfig(configPath, baseUrl, backupDir)
  : disableConfig(configPath);
process.stdout.write(JSON.stringify(result) + '\n');
