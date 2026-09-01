# Local Markdown Tracker

This repository uses local Markdown files as the fallback issue tracker for Wayfinder maps.

## Wayfinding operations

- A map is a directory under `.wayfinder/` with one `map.md` carrying the `wayfinder:map` label.
- Child issues live in that map's `tickets/` directory. Their frontmatter records `title`, one `wayfinder:<type>` label, `status`, `assignee`, `parent`, and `blocked_by`.
- A session claims an issue before work by setting `assignee` to its stable agent or developer name. An open issue with an empty assignee is unclaimed.
- A blocker is the relative filename of another child issue. An issue is unblocked only when every file named by `blocked_by` has `status: closed`.
- The frontier is every child issue that is open, unassigned, and unblocked, sorted by filename.
- Resolve an issue by adding a durable resolution comment or linked asset, setting `status: closed`, and adding a one-line named link to the map's **Decisions so far** section.
- Add issues first with no dependency edges, then wire `blocked_by` in a second edit pass.
- Open child issues are discovered from `tickets/`; they are not duplicated in the map body.

Issue names, not numeric prefixes, should be used in human-facing narration. Numeric filename prefixes exist only to keep local frontier ordering stable.
