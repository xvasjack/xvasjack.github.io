# Plain Language Rules

These rules are mandatory for this project.

## Main rule

Use short, simple words in code names, logs, docs, and comments.

If a normal person cannot understand a word fast, do not use it.

## Use these words

- `content quality` instead of `semantic quality`
- `story flow` instead of `coherence`
- `content size` instead of `budget gate`
- `file safety` instead of `integrity`
- `style match` instead of `fidelity`
- `run info` instead of `diagnostics`
- `flow` or `flow manager` instead of `orchestrator`
- `rule-based` instead of `heuristic`
- `check` or `checker` instead of `validation` or `validator`
- `check` instead of `gate` when possible
- `temp key` instead of `transient key`
- `build` instead of `render`
- `read request` instead of `parse scope`
- `combining results` instead of `synthesis` (when describing the process)
- `cutting short` instead of `truncation`
- `old bug coming back` instead of `regression`
- `safe to re-run` instead of `idempotent`
- `research steps` instead of `orchestration pipeline`
- `settling on final version` instead of `convergence`
- `retry waste` or `repeated loops` instead of `churn`
- `standardizing` instead of `canonicalization`

## Naming style

- File names: use clear nouns, no jargon.
- Function names: start with simple verbs (`check`, `build`, `read`, `write`, `run`, `fix`).
- Variable names: say what it is in plain words.
- Error messages: explain the problem in one simple sentence.

## Do not do this

- No words like: `semantic`, `fidelity`, `integrity`, `diagnostics`, `orchestrator`, `heuristic`, `validation`, `validator`, `render`, `parse scope`, `convergence`, `idempotent`, `canonicalization`, `truncation` in new code or docs.
- No backward alias files with old jargon names.
- No hidden shorthand that only technical people understand.

## Before merge checklist

- Search for banned words in changed files.
- Rename any complex term to plain words.
- Re-run tests and smoke checks after renaming.
