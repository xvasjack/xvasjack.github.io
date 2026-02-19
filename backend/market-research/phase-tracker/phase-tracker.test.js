'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// --- Stage contracts ---
const {
  STAGES,
  STAGE_ORDER,
  VALID_STAGE_IDS,
  PRIMARY_STAGES,
  REVIEW_STAGES,
  FIRST_STAGE,
  LAST_STAGE,
} = require('./contracts/stages');

// --- Stage ordering ---
const {
  stageIndex,
  isValidStage,
  nextStage,
  prevStage,
  stagesThrough,
  stagesFromThrough,
  isBefore,
  isAfter,
  getStage,
  formatStage,
  stageListDisplay,
} = require('./core/stage-order');

// --- Arg parser ---
const { DEFAULTS, parseRawArgs, parsePhaseRunArgs, phaseRunHelp } = require('./core/args');

// --- Types ---
const { validateShape, PhaseRunArgsSchema, RunSchema } = require('./contracts/types');

// ============================================================
// Stage Order / Mapping Tests
// ============================================================

describe('Stage contracts', () => {
  it('STAGE_ORDER has exactly 13 stages', () => {
    assert.equal(STAGE_ORDER.length, 13);
  });

  it('STAGE_ORDER matches expected sequence', () => {
    assert.deepStrictEqual(STAGE_ORDER, [
      '2',
      '2a',
      '3',
      '3a',
      '4',
      '4a',
      '5',
      '6',
      '6a',
      '7',
      '8',
      '8a',
      '9',
    ]);
  });

  it('every stage in STAGE_ORDER has a definition in STAGES', () => {
    for (const id of STAGE_ORDER) {
      assert.ok(STAGES[id], `Missing definition for stage "${id}"`);
      assert.equal(STAGES[id].id, id);
      assert.ok(STAGES[id].label, `Missing label for stage "${id}"`);
      assert.ok(STAGES[id].description, `Missing description for stage "${id}"`);
      assert.ok(['primary', 'review'].includes(STAGES[id].kind), `Invalid kind for "${id}"`);
    }
  });

  it('VALID_STAGE_IDS matches STAGE_ORDER', () => {
    assert.equal(VALID_STAGE_IDS.size, STAGE_ORDER.length);
    for (const id of STAGE_ORDER) {
      assert.ok(VALID_STAGE_IDS.has(id));
    }
  });

  it('PRIMARY_STAGES and REVIEW_STAGES partition STAGE_ORDER', () => {
    const combined = [...PRIMARY_STAGES, ...REVIEW_STAGES].sort(
      (a, b) => stageIndex(a) - stageIndex(b)
    );
    assert.deepStrictEqual(combined, [...STAGE_ORDER]);
  });

  it('FIRST_STAGE is "2" and LAST_STAGE is "9"', () => {
    assert.equal(FIRST_STAGE, '2');
    assert.equal(LAST_STAGE, '9');
  });

  it('review stages have "a" suffix', () => {
    for (const id of REVIEW_STAGES) {
      assert.ok(id.endsWith('a'), `Review stage "${id}" should end with "a"`);
    }
  });

  it('each stage has inputs/outputs arrays', () => {
    for (const id of STAGE_ORDER) {
      assert.ok(Array.isArray(STAGES[id].inputs), `Stage "${id}" missing inputs array`);
      assert.ok(Array.isArray(STAGES[id].outputs), `Stage "${id}" missing outputs array`);
    }
  });
});

describe('Stage ordering', () => {
  it('stageIndex returns correct positions', () => {
    assert.equal(stageIndex('2'), 0);
    assert.equal(stageIndex('2a'), 1);
    assert.equal(stageIndex('9'), 12);
    assert.equal(stageIndex('invalid'), -1);
  });

  it('isValidStage', () => {
    assert.ok(isValidStage('2'));
    assert.ok(isValidStage('3a'));
    assert.ok(isValidStage('9'));
    assert.ok(!isValidStage('1'));
    assert.ok(!isValidStage('10'));
    assert.ok(!isValidStage(''));
    assert.ok(!isValidStage('2b'));
  });

  it('nextStage', () => {
    assert.equal(nextStage('2'), '2a');
    assert.equal(nextStage('2a'), '3');
    assert.equal(nextStage('8a'), '9');
    assert.equal(nextStage('9'), null);
    assert.equal(nextStage('invalid'), null);
  });

  it('prevStage', () => {
    assert.equal(prevStage('2a'), '2');
    assert.equal(prevStage('3'), '2a');
    assert.equal(prevStage('2'), null);
    assert.equal(prevStage('invalid'), null);
  });

  it('stagesThrough returns correct slices', () => {
    assert.deepStrictEqual(stagesThrough('2'), ['2']);
    assert.deepStrictEqual(stagesThrough('2a'), ['2', '2a']);
    assert.deepStrictEqual(stagesThrough('3'), ['2', '2a', '3']);
    assert.deepStrictEqual(stagesThrough('9'), STAGE_ORDER);
  });

  it('stagesThrough throws on invalid stage', () => {
    assert.throws(() => stagesThrough('1'), /Invalid stage ID/);
    assert.throws(() => stagesThrough('10'), /Invalid stage ID/);
    assert.throws(() => stagesThrough(''), /Invalid stage ID/);
  });

  it('stagesFromThrough returns correct slices', () => {
    assert.deepStrictEqual(stagesFromThrough('2', '3'), ['2', '2a', '3']);
    assert.deepStrictEqual(stagesFromThrough('3', '3'), ['3']);
    assert.deepStrictEqual(stagesFromThrough('2', '9'), STAGE_ORDER);
  });

  it('stagesFromThrough throws on invalid stages', () => {
    assert.throws(() => stagesFromThrough('invalid', '3'), /Invalid from-stage/);
    assert.throws(() => stagesFromThrough('2', 'invalid'), /Invalid through-stage/);
  });

  it('stagesFromThrough throws when from > through', () => {
    assert.throws(() => stagesFromThrough('3', '2'), /comes after/);
  });

  it('isBefore and isAfter', () => {
    assert.ok(isBefore('2', '3'));
    assert.ok(isBefore('2', '9'));
    assert.ok(!isBefore('3', '2'));
    assert.ok(!isBefore('2', '2'));
    assert.ok(isAfter('3', '2'));
    assert.ok(!isAfter('2', '3'));
  });

  it('getStage returns definition or null', () => {
    assert.ok(getStage('2'));
    assert.equal(getStage('2').label, 'Country Research');
    assert.equal(getStage('invalid'), null);
  });

  it('formatStage returns readable string', () => {
    assert.equal(formatStage('2'), '2 — Country Research');
    assert.equal(formatStage('3a'), '3a — Synthesis Review');
    assert.ok(formatStage('invalid').includes('unknown'));
  });

  it('stageListDisplay returns multi-line string', () => {
    const display = stageListDisplay();
    assert.ok(display.includes('Country Research'));
    assert.ok(display.includes('Delivery'));
    assert.equal(display.split('\n').length, 13);
  });
});

// ============================================================
// Arg Parser Tests
// ============================================================

describe('parseRawArgs', () => {
  it('parses --key=value pairs', () => {
    const result = parseRawArgs(['--country=Vietnam', '--industry=Energy']);
    assert.equal(result.country, 'Vietnam');
    assert.equal(result.industry, 'Energy');
  });

  it('parses bare flags as "true"', () => {
    const result = parseRawArgs(['--help', '--json']);
    assert.equal(result.help, 'true');
    assert.equal(result.json, 'true');
  });

  it('ignores non-flag arguments', () => {
    const result = parseRawArgs(['positional', '--key=val', 'another']);
    assert.equal(Object.keys(result).length, 1);
    assert.equal(result.key, 'val');
  });

  it('handles values with = in them', () => {
    const result = parseRawArgs(['--context=a=b=c']);
    assert.equal(result.context, 'a=b=c');
  });

  it('returns empty object for no args', () => {
    const result = parseRawArgs([]);
    assert.deepStrictEqual(result, {});
  });
});

describe('parsePhaseRunArgs', () => {
  it('parses valid complete args', () => {
    const result = parsePhaseRunArgs([
      '--country=Vietnam',
      '--industry=Energy Services',
      '--through=3',
      '--run-id=run-test-123',
      '--client-context=APAC expansion',
      '--strict-template=true',
      '--attempts-per-stage=2',
    ]);
    assert.ok(result.valid);
    assert.equal(result.args.country, 'Vietnam');
    assert.equal(result.args.industry, 'Energy Services');
    assert.equal(result.args.through, '3');
    assert.equal(result.args.runId, 'run-test-123');
    assert.equal(result.args.clientContext, 'APAC expansion');
    assert.equal(result.args.strictTemplate, true);
    assert.equal(result.args.attemptsPerStage, 2);
  });

  it('auto-generates runId when not provided', () => {
    const result = parsePhaseRunArgs(['--country=Germany', '--industry=Fintech', '--through=2']);
    assert.ok(result.valid);
    assert.ok(result.args.runId.startsWith('run-'));
    assert.ok(result.args.runId.length > 10);
  });

  it('applies defaults for optional fields', () => {
    const result = parsePhaseRunArgs(['--country=Japan', '--industry=Healthcare', '--through=5']);
    assert.ok(result.valid);
    assert.equal(result.args.strictTemplate, DEFAULTS.strictTemplate);
    assert.equal(result.args.attemptsPerStage, DEFAULTS.attemptsPerStage);
    assert.equal(result.args.clientContext, null);
  });

  it('returns help flag', () => {
    const result = parsePhaseRunArgs(['--help']);
    assert.ok(!result.valid);
    assert.ok(result.help);
  });

  it('errors on missing --country', () => {
    const result = parsePhaseRunArgs(['--industry=X', '--through=2']);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('--country')));
  });

  it('errors on missing --industry', () => {
    const result = parsePhaseRunArgs(['--country=X', '--through=2']);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('--industry')));
  });

  it('errors on missing --through', () => {
    const result = parsePhaseRunArgs(['--country=X', '--industry=Y']);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('--through')));
  });

  it('errors on all three missing', () => {
    const result = parsePhaseRunArgs([]);
    assert.ok(!result.valid);
    assert.ok(result.errors.length >= 3);
  });

  it('errors on invalid --through stage', () => {
    const result = parsePhaseRunArgs(['--country=X', '--industry=Y', '--through=1']);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('Invalid --through')));
  });

  it('errors on invalid --through stage "10"', () => {
    const result = parsePhaseRunArgs(['--country=X', '--industry=Y', '--through=10']);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('Invalid --through')));
  });

  it('errors on non-numeric --attempts-per-stage', () => {
    const result = parsePhaseRunArgs([
      '--country=X',
      '--industry=Y',
      '--through=2',
      '--attempts-per-stage=abc',
    ]);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('attempts-per-stage')));
  });

  it('errors on zero --attempts-per-stage', () => {
    const result = parsePhaseRunArgs([
      '--country=X',
      '--industry=Y',
      '--through=2',
      '--attempts-per-stage=0',
    ]);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('attempts-per-stage')));
  });

  it('--strict-template=false sets false', () => {
    const result = parsePhaseRunArgs([
      '--country=X',
      '--industry=Y',
      '--through=2',
      '--strict-template=false',
    ]);
    assert.ok(result.valid);
    assert.equal(result.args.strictTemplate, false);
  });

  it('--strict-template=0 sets false', () => {
    const result = parsePhaseRunArgs([
      '--country=X',
      '--industry=Y',
      '--through=2',
      '--strict-template=0',
    ]);
    assert.ok(result.valid);
    assert.equal(result.args.strictTemplate, false);
  });
});

describe('phaseRunHelp', () => {
  it('returns help string with all flags', () => {
    const help = phaseRunHelp();
    assert.ok(help.includes('--country'));
    assert.ok(help.includes('--industry'));
    assert.ok(help.includes('--through'));
    assert.ok(help.includes('--run-id'));
    assert.ok(help.includes('--client-context'));
    assert.ok(help.includes('--strict-template'));
    assert.ok(help.includes('--attempts-per-stage'));
    assert.ok(help.includes('--help'));
  });
});

// ============================================================
// Type validation tests
// ============================================================

describe('validateShape', () => {
  it('validates a correct PhaseRunArgs', () => {
    const result = validateShape(
      {
        runId: 'run-abc-123',
        country: 'Vietnam',
        industry: 'Energy',
        through: '3',
        strictTemplate: true,
        attemptsPerStage: 1,
      },
      PhaseRunArgsSchema
    );
    assert.ok(result.valid);
  });

  it('catches missing required fields', () => {
    const result = validateShape({}, PhaseRunArgsSchema);
    assert.ok(!result.valid);
    assert.ok(result.errors.length >= 4); // runId, country, industry, through
  });

  it('catches wrong types', () => {
    const result = validateShape(
      {
        runId: 'run-abc-123',
        country: 'Vietnam',
        industry: 'Energy',
        through: '3',
        strictTemplate: 'yes', // should be boolean
        attemptsPerStage: 'one', // should be integer
      },
      PhaseRunArgsSchema
    );
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('strictTemplate')));
    assert.ok(result.errors.some((e) => e.includes('attemptsPerStage')));
  });

  it('validates a Run record', () => {
    const result = validateShape(
      {
        id: 'run-abc-12345678',
        industry: 'Energy',
        country: 'Vietnam',
        status: 'running',
        createdAt: '2026-02-19T12:00:00Z',
        updatedAt: '2026-02-19T12:00:00Z',
      },
      RunSchema
    );
    assert.ok(result.valid);
  });

  it('catches invalid enum value on Run status', () => {
    const result = validateShape(
      {
        id: 'run-abc-12345678',
        industry: 'Energy',
        country: 'Vietnam',
        status: 'unknown',
        createdAt: '2026-02-19T12:00:00Z',
        updatedAt: '2026-02-19T12:00:00Z',
      },
      RunSchema
    );
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('status')));
  });

  it('rejects non-object input', () => {
    const result = validateShape(null, RunSchema);
    assert.ok(!result.valid);
  });
});
