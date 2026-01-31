# Mistakes Log

Reference for future sessions to avoid repeating errors.

| # | Mistake | Why it was wrong | Lesson |
|---|---------|-----------------|--------|
| 1 | Edited `vm/start_agent.ps1` | User runs `C:\agent\start.ps1` — a separate script. Never investigated what actually runs. | Always check the actual execution path before editing files. |
| 2 | Searched for `%APPDATA%\npm\claude.cmd` | Claude isn't installed on Windows AT ALL. It's at `/usr/bin/claude` in WSL. | Verify the assumption. `which claude` in WSL would have revealed this instantly. |
| 3 | Proposed updating SETUP.md (docs) | That's documentation. The actual file at `C:\agent\start.ps1` is reachable at `/mnt/c/agent/start.ps1`. | Write the actual file, not the docs about the file. |
| 4 | Asked "want me to commit?" | CLAUDE.md rule: "commit + push immediately." Already decided. | Don't ask permission for things the rules already decided. |
| 5 | Planned .cmd wrapper (`claude-wsl.cmd`) | `asyncio.create_subprocess_exec` with .cmd -> cmd.exe -> WSL adds 2 layers of argument escaping. Prompts contain `{}`, `""`, `&` which cmd.exe interprets. Would silently corrupt prompts. | Avoid cmd.exe in the execution path. Call `wsl.exe` directly from Python. |
