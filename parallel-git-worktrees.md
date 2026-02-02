# Parallel Git Worktrees with Claude Code

The single biggest productivity unlock for Claude Code power users: run 3-5 git worktrees simultaneously, each with its own Claude session.

## What Are Git Worktrees?

Git worktrees let you check out multiple branches of the same repo into separate directories, sharing the same `.git` history. Instead of one working copy, you get N independent working directories.

```bash
# Create worktrees from your repo
git worktree add ../myproject-a feature-auth
git worktree add ../myproject-b feature-api
git worktree add ../myproject-c fix-tests
```

Now you have 3 directories, each on a different branch. Launch a separate `claude` CLI session in each one.

## Why It Works

- **Parallel execution**: While Claude runs tests in worktree A, it writes code in B and does research in C
- **No context switching**: Each session has its own branch, no stashing/rebasing between tasks
- **Same repo, shared history**: All worktrees share `.git` objects, merging is trivial
- **Independent state**: One session can't break another's working directory

## Setup

### Create worktrees

```bash
cd ~/your-repo

# Create parallel worktrees
git worktree add ../your-repo-a feature-branch-a
git worktree add ../your-repo-b feature-branch-b
git worktree add ../your-repo-c feature-branch-c
```

### Shell aliases for fast switching

```bash
# Add to ~/.bashrc or ~/.zshrc
alias za="cd ~/your-repo-a && claude"
alias zb="cd ~/your-repo-b && claude"
alias zc="cd ~/your-repo-c && claude"
```

One keystroke to hop between sessions.

### Dedicated worktree roles

| Worktree | Role |
|----------|------|
| `project-a` | Active feature development |
| `project-b` | Bug fixes / code review |
| `project-c` | Read-only analysis (logs, queries, investigation) |

## Worktrees vs Multiple Clones

| | Worktrees | Multiple Clones |
|---|---|---|
| Disk space | Shared `.git` | Duplicated `.git` |
| Branch management | Built-in (`git worktree list`) | Manual |
| Setup | One command | Full clone each time |
| Merging | Same repo, trivial | Need remotes |

The Claude Code team prefers worktrees. Native support was built into Claude Desktop for this reason. Multiple clones also work -- the key insight is **parallelism**, not the mechanism.

## Managing Worktrees

```bash
# List all worktrees
git worktree list

# Remove a worktree when done
git worktree remove ../myproject-a

# Prune stale worktree references
git worktree prune
```

## Practical Limits

3-5 concurrent sessions is the sweet spot. Beyond that, the bottleneck shifts to your ability to review and merge outputs.

## Source

Tip from the Claude Code team, shared widely on X. @amorriscode built native worktree support into the Claude Desktop app.
