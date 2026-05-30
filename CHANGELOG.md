# What's changed in 🗺 Roadmap plugin?

## [1.0.0] 2026-05-20
- Initial release: **Roadmap** command to open an interactive Gantt chart of project notes driven by frontmatter (`roadmap`, `start`, `end`, `due`, `defer`, `prerequisites`, `progress`).
- Drag-movable bars and edge-resizable spans; progress auto-computed from task counts when not set explicitly.
- Project hierarchy via `roadmap_parent`; task pills rendered inside each project bar, inheriting the project's icon color.
- OmniPlan-style dependency arrows — project-to-project via `prerequisites`, task-to-task via NotePlan blockIDs and `@after()` markers.
- Ephemeral bars derived from scheduled tasks and nested note subtrees.
- Right-click context menus on project rows and timeline bars (reschedule, unschedule, per-project color picker, color propagation to descendants).
- **Add or remove note from roadmap** command to toggle a note's `roadmap:` frontmatter key.
