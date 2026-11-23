# Daily Todo

A daily checklist that lives inside SiYuan. Open today's note under *Daily Todo* and the list appears right in the document — check an item and it is written back to your note. No extra service, no port, no port-forwarding.

## Features

- **Auto-creates today's list** — created when there is something to do, not as an empty note every day
- **Rolls over unfinished items** — yesterday's incomplete tasks move to today (including deferred ones); yesterday's note keeps only completed items and becomes a natural archive
- **Extracts from your work log automatically** — save a `- [ ]` item in your log and it shows up in today's list by itself, each source block only once
- **Instant write-back** — ticking a box updates the task block in SiYuan, so desktop and mobile share one source of truth
- **Deferred reminders** — append `@+2d` or `@2026-12-01` and the task stays in a "queued" section until it is due
- **Works on mobile** — the panel renders inside the document body, so desktop and mobile share a single implementation without Dock panels or custom tabs

## Install

SiYuan Marketplace → Plugins → search *Daily Todo* → Install and enable.

A checklist icon appears in the top bar; click it to open the panel, or press `⌥⌘T`.

## Usage

1. Write `- [ ] a task` in your work log — after saving it lands in today's list automatically
2. Open `每日待办/2026-11-23 待办`; the list is at the top of the document
3. Tick a checkbox to complete a task; the text is struck through and the note becomes `- [x]`

Only task lists in the work log are extracted:

```markdown
- [ ] Reply to the customer's delivery email
- [ ] Tidy last week's meeting notes
- [x] Completed items are ignored
```

### Defer syntax

Only the end of a task is matched, so an `@` inside the text is safe:

```markdown
- [ ] Send the weekly report @+2d
- [ ] Book a health check @11-24
- [ ] Renew a document @2026-12-01
```

You can also press `⋯` next to a task in the panel. Marks are frozen into absolute dates when written, so they never go stale.

## Notes

- Plain paragraphs in the work log are never treated as tasks; they must be `- [ ]` list items
- Extraction copies, it does not move — the original in the work log stays untouched
- Ticking the source in the work log does not tick the copy in the list, and vice versa
- A day with no tasks gets no list; the next list rolls over from the most recent one
- The panel is injected outside the editor content area, so it never affects saving or syncing

## Development

```bash
npm install
npm run build      # output goes to dist/
```

Copy the contents of `dist/` into `{workspace}/data/plugins/siyuan-daily-todo/` to debug locally.

<!-- sponsor:start -->
## Support

If this plugin saves you some time, you can buy me a coffee. Your support keeps it maintained.

<p align="center">
  <img src="assets/sponsor-wechat.png" alt="WeChat tip code" width="260" />
</p>

A rating in the marketplace or an issue report is just as welcome.
<!-- sponsor:end -->

## License

MIT
