# 🗺️ Roadmap

A frontmatter-driven Gantt chart for NotePlan. Drop a few keys into any project
note and it shows up on a unified timeline — with dependencies, deadlines,
deferred starts, and live progress derived from your tasks.

## Quick start

1. Install the plugin and pin **Roadmap** from the sidebar (or run `/Roadmap`).
2. Add a `roadmap:` key to any project note's frontmatter:

   ```yaml
   ---
   title: Migration to Postgres
   roadmap: pg-migration
   start: 2026-06-01
   end:   2026-08-15
   due:   2026-08-31
   defer: 2026-05-25
   progress: 25
   prerequisites: schema-design, infra-prep
   ---
   ```

3. Open the Roadmap view — your note now has a bar.

Or, with a note open, run `/Add or remove note from roadmap` to set
`roadmap:<slug>` automatically.

## Frontmatter properties

| Key               | Type       | What it does                                                                                  |
|-------------------|------------|-----------------------------------------------------------------------------------------------|
| `roadmap`         | string     | Unique identifier; only notes with this key appear on the chart. Use it from `prerequisites`. |
| `roadmap_parent`  | string     | Another `roadmap` id; nests this note under it as a child.                                    |
| `roadmap_index`   | integer    | Sibling order under the same parent (lower = earlier). Maintained automatically when you drag in the sidebar. |
| `start`           | YYYY-MM-DD | Planned start.                                                                                |
| `end`             | YYYY-MM-DD | Planned end.                                                                                  |
| `due`             | YYYY-MM-DD | Hard deadline. Red flag marker; bar turns red if today is past it and progress < 100%.        |
| `defer`           | YYYY-MM-DD | Don't-start-before date. Bar shows dashed border while `today < defer`.                       |
| `progress`        | 0–100      | Explicit percent complete. If absent, computed as `done / (done + open + scheduled)`.         |
| `prerequisites`   | comma list | Other roadmap ids that must finish before this one. Drawn as arrows.                          |
| `icon-color`      | Tailwind name or hex | Colors this project's bar (and its tasks' pills). Accepts e.g. `amber-500`, `sky`, `#fbbf24`. NotePlan also uses this key for its own sidebar icon. |

Notes without `roadmap:` are ignored. Cancelled tasks/checklists are excluded
from auto-progress.

## Tasks as roadmap rows

Each open task (and scheduled, and — optionally — completed) inside a roadmap
note becomes a single-cell row on the timeline, nested under its project. A
task's "schedule" is the NotePlan `>YYYY-MM-DD` marker in its content; tasks
have no start/end/due/defer of their own.

Toggle the **double-check** button in the toolbar to also include completed
tasks.

## Interactions

### On a bar

- **Click a bar** — opens the underlying note in a split view.
- **Drag the bar body** — moves both start and end (preserving duration).
- **Drag a bar's left/right edge** — adjusts that endpoint. Tasks are
  single-cell and only move; their edges can't be resized.
- **Opt-click and drag a project bar onto another project bar** — adds the
  source as a prerequisite of the target. (Same effect as dragging the small
  dot on the bar's right edge.)
- **Opt-click and drag a task pill onto another task pill** — same idea, but
  uses NotePlan's blockID syncing under the hood: the source task is given a
  `^blockID` (if it doesn't have one), and the target task gains an
  `@after(<blockID>)` marker in its content. Click the arrow to remove it.
- **Click a dependency arrow** — confirms and removes the prerequisite.

### On an empty row

- **Drag across cells on an unscheduled project's row** — sets `start` and
  `end` to the dragged range.
- **Click (or drag) on an unscheduled task's row** — schedules the task to
  that day via `>YYYY-MM-DD`.

### Sidebar

- **Click a sidebar row** — scrolls the timeline to that item. ⌘/Ctrl-click
  opens the note directly.
- **Click the chevron** — collapses / expands the project's children
  (sub-projects and tasks). Persisted across sessions.
- **Drag a project row onto another** — drop on the *middle* to reparent
  (becomes a child); drop near the *top* or *bottom* edge to reorder among
  siblings. `roadmap_parent` and `roadmap_index` are rewritten on the affected
  notes.
- **Right-click a project row** — opens a context menu:
  - *Add task at bottom* / *Add task at top* — prompts for a title and
    appends or prepends an open task to the project's note.
  - *Add subproject* — prompts for a title, creates a new note in the
    same folder, and sets its `roadmap` + `roadmap_parent` to nest under
    the current project. Inherits `icon-color` if set.

### Toolbar

- **Zoom buttons** — Day / Week / Month / Quarter.
- **Show completed** — include `done` tasks/checklists on the chart.
- **Today** — re-centers the timeline on today.

## Visual cues

- **Solid bar** — start + end both set.
- **Dotted bar** — only one of start/end set; the other is inferred.
- **Dashed bar with italic label** — *ephemeral*. The project has no
  explicit start/end; the bar spans the dates of its scheduled tasks **and
  any nested sub-projects** (recursively). Drag or resize it to persist
  explicit start/end.
- **Dashed bar** — deferred; `today < defer`.
- **Red border** — overdue against `due`.
- **Green tint** — progress = 100%.
- **Red triangle marker** — `due` date.
- **Yellow dashed marker** — `defer` date (only when outside the bar).
- **Red dashed arrow** — broken dependency (a prereq ends after its dependent starts).

## Settings

- **Folders to exclude** — folders whose notes are skipped during scanning.
- **Week starts on** — Monday (default) or Sunday for the header alignment.

## Compatibility

- Requires NotePlan ≥ 3.9 for the HTML view; uses
  `Editor.updateFrontmatterAttributes` (v3.18.1+) when available, with a regex
  fallback for older versions.
- Uses `np.Shared` for FontAwesome and the HTML ↔ plugin comms bridge.
