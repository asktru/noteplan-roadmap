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

| Key             | Type       | What it does                                                                                  |
|-----------------|------------|-----------------------------------------------------------------------------------------------|
| `roadmap`       | string     | Unique identifier; only notes with this key appear on the chart. Use it from `prerequisites`. |
| `start`         | YYYY-MM-DD | Planned start.                                                                                |
| `end`           | YYYY-MM-DD | Planned end.                                                                                  |
| `due`           | YYYY-MM-DD | Hard deadline. Red flag marker; bar turns red if today is past it and progress < 100%.        |
| `defer`         | YYYY-MM-DD | Don't-start-before date. Bar shows dashed border while `today < defer`.                       |
| `progress`      | 0–100      | Explicit percent complete. If absent, computed as `done / (done + open + scheduled)`.         |
| `prerequisites` | comma list | Other roadmap ids that must finish before this one. Drawn as arrows.                          |

Notes without `roadmap:` are ignored. Cancelled tasks/checklists are excluded
from auto-progress.

## Interactions

- **Click a bar** — opens the underlying note in a split view.
- **Drag the bar body** — moves both start and end (preserving duration).
- **Drag a bar's left/right edge** — adjusts that endpoint.
- **Hover a bar's right edge dot, drag to another bar** — adds the source as a
  prerequisite of the target.
- **Click a dependency arrow** — confirms and removes the prerequisite.
- **Click a sidebar row** — scrolls the timeline to that item. ⌘/Ctrl-click
  opens the note directly.
- **Zoom buttons** — Day / Week / Month / Quarter.
- **Today** — re-centers the timeline on today.

## Visual cues

- **Solid bar** — start + end both set.
- **Dotted bar** — only one of start/end set; the other is inferred.
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
