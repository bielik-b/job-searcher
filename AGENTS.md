## Persistent Context

Use agentmemory before and after substantial work in this project.

- Recall project context with `memory_smart_search` or `memory_recall` when a task depends on prior decisions.
- Save durable decisions, architecture notes, user preferences, and unresolved setup issues with `memory_save`.
- Use the stable project id `job-searcher` for project-scoped memories.

## Orchestration

The user prefers the main assistant to act as an orchestrator and route meaningful work to suitable specialist subagents when that improves quality.

- Use subagents for bounded specialist review, implementation slices, QA, security/privacy, product decisions, and architecture checks.
- Keep delegated tasks concrete and avoid creating extra agents when the work is trivial or tightly blocking.
- Integrate subagent outputs into one coherent implementation and close agents when they are no longer needed.

## CodeGraph

This project is initialized for CodeGraph.

- When `.codegraph/` exists, use `codegraph_explore` before grep/find/read for code understanding, architecture questions, bug tracing, or edits.
- Pass the project path `/Users/bohdanbielik/Documents/Job searcher` when calling CodeGraph MCP tools.
- If new source files are added, CodeGraph should auto-sync; use `npm run codegraph:status` to verify.

## Local Tooling

- `npm run codegraph:status` checks the CodeGraph index.
- `npm run codegraph:init` rebuilds the project graph.
- `npm run memory:status` checks agentmemory daemon health.
- `npm run memory:doctor` prints agentmemory diagnostics.
- `npm run memory:start` starts the local agentmemory worker.
