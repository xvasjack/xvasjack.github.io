/**
 * Guards the public repo against confidential terms coming back:
 * client and project names, employer branding, licensed data vendors,
 * personal contact details and blocked AI providers.
 *
 * Terms are stored as SHA-256 hashes so this test does not publish them.
 * Each tracked text file is split into words (camelCase and digits split too),
 * and every single word and two-word phrase is checked against the list.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

const BANNED_HASHES = new Set([
  '2c64da7ea65494f0e186ff6a8351c0e847e7c6c43d5107cfebdbd964a2171d9b',
  '91e8a20a486fa0334aae0134f081f567dfd8f83f746708543c963cf3cc86fe3f',
  'c4914a33f6e8713267cffe2300aee15e4a308819533a81d7580765348c4c09fc',
  '300445253d3de834fa866e485a700462062f43566f1a1d8f02b8b69392569328',
  '7437e649d9a733334a688bfbc3278c44bb3ebc7149e3a02c9c6acaf066f55299',
  '5f67d85e58bd667facec9a9fba0ef69ade3b0db4ca3aef0adbdcc3b0fac1f8a3',
  '5b3cccf643b91a1684f7c6120e573dcfad3a44f0191ff6b84464ce906693cdb0',
  '3ec829928b33bb01978dbbe4c2598378242e309edd3b1304924f6e4a53afebac',
  'c986396377f3ee1c1dd4b53463288fffe7cecee2b944c317012886c2340c0aa4',
  'e4f9c522e1c89280e9561b825f4f24fe32b51ff82d61e5c2b1dfd0321c35a90b',
  '6749675d80a1faa70859312365b6eab644244d8e5d01cc94f44644c13d090ee7',
  '6f7ac1823da81d2e52d1a1549ee69c85bbf8bb56d06682849e7c09da2785ce3b',
  '1ab71894eb98e16c9769d52050dc31ec5cab97c6312ea1004bb6fe4d3ce17f77',
  '8567bef3c16236146baa3e217f8003fd000184acfbe6b5873d2fa4523affbf4b',
  '2cb63a5466e8dad1ce86130c52e243641787ffdf5c8bce091f8d69d97fb37289',
  '16a9dbd5393aee855d79907edb8dbad4f8de7be5cd7aea56f1fcbcc025e62795',
  '9dcc8af9498952d4dc3be36175ebe12248c98a8a144ca3b6933abb8d3f7b71a8',
  '8224123d49c1825e5976b90c0ed68e06262dedbe1ba2d55badd48b1e123652eb',
  '7ce3b7e784772b32867cef471271a3ddf571d4197f8e0a948d9106fa8470b2fe',
  '1ebf1a95d639c324577cf5450d8b2ba72f497569dc0e02460d0d0cb610697fd6',
  '228e9eee8dcecd5233f800f0415dc01d070addae60265d5f11162289528734f6',
  '65a084b82b6f83dc283c173f8e382feba45dbe1871dc376d809c15de9fe9df21',
  '16cdb69f76ceb70b90229862b36042083d9be6a9e509a5ab96b13b40a988447f',
  '286a3c612017ad1d91ca024d8921c80c7601666f457532027c477a9eb15bf791',
]);

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.cjs',
  '.mjs',
  '.json',
  '.md',
  '.html',
  '.css',
  '.yml',
  '.yaml',
  '.txt',
  '.py',
  '.sh',
  '.ps1',
  '.sql',
  '.csv',
  '.example',
  '.toml',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage']);

function listTrackedFiles() {
  try {
    const out = execSync('git ls-files -z', { cwd: REPO_ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else files.push(rel);
      }
    };
    walk('');
    return files;
  }
}

function isTextFile(rel) {
  const base = path.basename(rel);
  // Lockfiles hold base64 integrity hashes, which can contain any letters by chance.
  if (base === 'package-lock.json') return false;
  if (base.startsWith('.') && !base.includes('.', 1)) return true; // dotfiles like .gitignore
  return TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function findBannedPhrases(text, hashes = BANNED_HASHES) {
  const words = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!words) return [];
  const hits = new Set();
  for (let i = 0; i < words.length; i++) {
    if (hashes.has(sha(words[i]))) hits.add(words[i]);
    if (i + 1 < words.length) {
      const pair = `${words[i]} ${words[i + 1]}`;
      if (hashes.has(sha(pair))) hits.add(pair);
    }
  }
  return [...hits];
}

describe('no confidential terms in tracked files', () => {
  test('the checker finds words inside camelCase and two-word phrases', () => {
    const hashes = new Set([sha('acme'), sha('beta corp')]);
    expect(findBannedPhrases('const acmeUserEmail = 1;', hashes)).toEqual(['acme']);
    expect(findBannedPhrases('Prepared for Beta Corp today', hashes)).toEqual(['beta corp']);
    expect(findBannedPhrases('nothing to see here', hashes)).toEqual([]);
  });

  test('no tracked text file contains a banned term', () => {
    const problems = [];
    for (const rel of listTrackedFiles()) {
      if (!isTextFile(rel)) continue;
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const hits = findBannedPhrases(fs.readFileSync(abs, 'utf8'));
      if (hits.length) problems.push(`${rel}: ${hits.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });
});
