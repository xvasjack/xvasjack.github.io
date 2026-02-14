const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TEMPLATE = path.join(
  __dirname,
  '..',
  '..',
  '251219_Escort_Phase 1 Market Selection_V3.pptx'
);
const AUDIT_SCRIPT = path.join(__dirname, 'slide-by-slide-audit.py');

function runSlideAudit(generatedPath, templatePath = DEFAULT_TEMPLATE) {
  return new Promise((resolve) => {
    const args = [
      AUDIT_SCRIPT,
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
      if (stdout.trim()) {
        try {
          parsed = JSON.parse(stdout);
        } catch {
          // handled below
        }
      }

      if (!parsed) {
        resolve({
          error: stderr || stdout || `slide audit failed (exit ${code})`,
          summary: { slides: 0, slidesWithIssues: 0, high: 0, medium: 0, low: 0 },
          slides: [],
        });
        return;
      }

      resolve(parsed);
    });
  });
}

module.exports = { runSlideAudit, AUDIT_SCRIPT, DEFAULT_TEMPLATE };

