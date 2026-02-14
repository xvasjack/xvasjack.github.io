const path = require('path');
const { spawn } = require('child_process');

const AUDIT_SCRIPT = path.join(__dirname, 'xml-package-audit.py');

function runXmlPackageAudit(pptxPath) {
  return new Promise((resolve) => {
    const args = [AUDIT_SCRIPT, '--pptx', path.resolve(pptxPath), '--json'];
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
          valid: false,
          summary: { totalParts: 0, parsedParts: 0, issueCount: 1 },
          issues: [
            {
              part: '(runner)',
              code: 'xml_audit_runner_error',
              message: stderr || stdout || `xml audit failed (exit ${code})`,
            },
          ],
        });
        return;
      }

      if (typeof parsed.valid !== 'boolean') parsed.valid = code === 0;
      resolve(parsed);
    });
  });
}

module.exports = { runXmlPackageAudit, AUDIT_SCRIPT };
