import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'evermem-test-'));
  try {
    const locale = process.env.EVERMEM_TEST_LOCALE || 'en';
    const packs: Record<string, string> = { 'zh-cn': 'ms-ceintl.vscode-language-pack-zh-hans', 'zh-tw': 'ms-ceintl.vscode-language-pack-zh-hant' };
    if (locale !== 'en' && !packs[locale]) { throw new Error(`Unsupported test locale: ${locale}`); }
    const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode();
    // Keep language-pack downloads in the test cache, never the user's extensions directory.
    const extensionsDir = locale === 'en' ? path.join(profile, 'extensions') : path.resolve(__dirname, '../../.vscode-test/language-packs');
    const profileArgs = ['--user-data-dir', path.join(profile, 'user'), '--extensions-dir', extensionsDir];
    if (packs[locale]) {
      const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
      await promisify(execFile)(cli, [...args, ...profileArgs, '--install-extension', packs[locale]], { timeout: 120000 });
      // CLI installs do not populate a fresh profile's language-pack cache before startup.
      const installed = JSON.parse(await fs.readFile(path.join(extensionsDir, 'extensions.json'), 'utf8'));
      const entry = installed.find((item: { identifier: { id: string } }) => item.identifier.id === packs[locale]);
      if (!entry) { throw new Error(`Language pack missing: ${locale}`); }
      const packDir = path.join(extensionsDir, entry.relativeLocation);
      const manifest = JSON.parse(await fs.readFile(path.join(packDir, 'package.json'), 'utf8'));
      const localization = manifest.contributes.localizations.find((item: { languageId: string }) => item.languageId === locale);
      const translations = Object.fromEntries(localization.translations.map((item: { id: string; path: string }) => [item.id, path.resolve(packDir, item.path)]));
      const hash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
      await fs.writeFile(path.join(profile, 'user/languagepacks.json'), JSON.stringify({ [locale]: { hash, translations } }));
    }
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../../'),
      extensionTestsPath: path.resolve(__dirname, './suite/index'),
      vscodeExecutablePath: executable,
      launchArgs: [...(locale === 'en' ? ['--disable-extensions'] : []), '--skip-welcome', '--skip-release-notes',
        ...profileArgs, `--locale=${locale}`],
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exitCode = 1;
  } finally {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

void main();
