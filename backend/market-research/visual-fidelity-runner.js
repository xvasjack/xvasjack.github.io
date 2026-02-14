const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TEMPLATE = path.join(
  __dirname,
  '..',
  '..',
  '251219_Escort_Phase 1 Market Selection_V3.pptx'
);
const CHECKER = path.join(__dirname, 'visual-fidelity-check.py');

function runVisualFidelityCheck(generatedPath, templatePath = DEFAULT_TEMPLATE) {
  return new Promise((resolve) => {
    const args = [
      CHECKER,
      '--generated',
      path.resolve(generatedPath),
      '--template',
      path.resolve(templatePath),
      '--json',
    ];

    const child = spawn('python3', args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += String(d || '');
    });
    child.stderr.on('data', (d) => {
      stderr += String(d || '');
    });

    child.on('close', (code) => {
      let parsed = null;
      if (stdout && stdout.trim()) {
        try {
          parsed = JSON.parse(stdout);
        } catch {
          // handled below
        }
      }

      if (!parsed) {
        resolve({
          valid: false,
          score: 0,
          summary: { passed: 0, failed: 1, warnings: 0 },
          checks: [],
          error: stderr || stdout || `visual checker failed (exit ${code})`,
        });
        return;
      }

      if (code !== 0 && typeof parsed.valid !== 'boolean') {
        parsed.valid = false;
      }
      resolve(parsed);
    });
  });
}

module.exports = { runVisualFidelityCheck, DEFAULT_TEMPLATE, CHECKER };
