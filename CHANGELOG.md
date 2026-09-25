# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to [Semantic Versioning].

## [Unreleased]

### Added

- Explain context growth in Trajectory: an assistant step whose prompt grew by more than 2K tokens and more than 5% now shows a `+88K ← read bridge.go` tail naming the tool activity that inflated it, in the event row, the overview selection line, and Details.
- Separate clean (uncached) prompt input from the cumulative input total in the status footer and estimate the next step's cache read from the current context, with full, dense, and nano copy.
- Ship a complete semantic TUI theme catalog with 19 new light, dark, OLED, and high-contrast palettes, friendly `/settings` metadata, truecolor rendering, and light/dark ANSI16 fallbacks while preserving existing theme ids.
- Expose a reusable `SessionRuntime` API that durably creates a detached conversational fork without switching the active conversation or changing the composer, including safe snapshots while the parent is still working.
- Grow the composer by explicit paragraphs up to a bounded internal viewport, expose full-draft editing through Ctrl+X, support Ctrl+A selection, and publish assistant-answer marks to supporting terminal overview rulers.
- Show an exact-revision durable viewport tail while a resumed Agent is still validating, then atomically replace it with the authoritative full transcript before enabling composer input.
- Keep a durable revision-bound session index and recent-session summary cache so `/resume` avoids full inspection of unchanged histories.
- Publish the complete session telemetry projection to supporting terminal hosts so narrow panes can expose it through host-native hover chrome without enabling TUI mouse tracking.
- Choose `standard`, `compact`, `minimal`, or `quiet` activity detail from `/settings` or `/detail`, keeping the current transcript as the default while progressively reducing reasoning, tool, and todo noise without hiding errors.
- Open the current conversation's live Trajectory as a rich native read-only TUI in the current terminal with `/trajectory`, `/trajectory screen`, or Alt+T; use `/trajectory companion` when a separate Surfterm block is preferred. Both surfaces scope the run tree to the active root and its descendants and expose numbered overview, flow, runs, tools, changes, problems, and raw views alongside search, follow mode, refresh, event details, clipboard copy, and Trajectory-only mouse-wheel scrolling.
- Project durable journals into a versioned semantic session-history model with explainable human/internal/subagent/legacy classification, safe interaction content, final-answer boundaries, and cursor-based catalog/history pages for native terminal consumers.
- Bind a revocable `session.history.page.v2` source for supporting terminal hosts, restricted to the active session and exposing only direct user prompts and final assistant answers through opaque cursors.
- Let `/model` open on per-provider favorite models configured under `omdsh-tui.modelFavorites` while its search field still filters the entire provider catalog, and window long compact pickers to ten rows so a large catalog stays responsive.
- Forecast compaction economics before it runs: `/compact` prints what the summarizing turn frees and what that single turn costs, asks before spending a turn that cannot repay itself inside the estimated horizon, and the terminal offers the same forecast once the prompt context crosses a configurable threshold (`Compact at`) with a `Steps ahead` estimate under `/settings`; a completed compaction now shows `freed N tokens` next to its summary in Trajectory.
- Trim the fixed session start payload: the skill catalog now renders 150-character summaries instead of the 500-character default, and a new `Lean` agent preset denies the eight provider-specific `subagent*` tools so a session that never delegates to an external provider still keeps the generic `subagent`, its `list_agents`/`send_message`/`interrupt_agent` controls, and every base tool while paying for roughly 11K fewer tool-schema characters.
- Flag a lost prompt cache in Trajectory: an assistant step that re-read at least 20K reusable tokens (half the reusable prefix) without a cache hit now shows `cold:150K` in its row and the exact figure in Details, so the most expensive single step in a session stops looking like an ordinary one.

### Changed

- Treat `/steer` as a continuation note to the active task: preserve the main objective, ask before an apparent task switch, and state that already-running tools are not interrupted.
- Make Trajectory self-explanatory with a visible `0 Guide` slide (`?`/`h` aliases), a persistent `0–7` tab strip, purpose-driven pane titles, and sparse event-density rails instead of opaque repeated lane initials.
- Present exact tool/workflow lifecycles as human semantic rows while preserving one-to-one Raw records, with structured filters, source breadcrumbs, honest loaded/matched counts, canonical reported changes, readable Details, exact repeat grouping, and a `PAUSED · +N new` indicator.
- Use plain Up/Down for visual-row caret navigation and Shift+Up/Down for sent-prompt history; transcript history remains on PgUp/PgDn so the composer stays writable while reviewing earlier output.
- Compact status telemetry now switches through dense and unit-aware nano forms on narrow terminals, preserving cache, token, TTFT/rate, LLM/tool timing, context, and activity data before omitting lower-priority groups.

### Fixed

- Preserve semantic turn boundaries in bounded remote transcripts, keep partial viewport tails for oversized active turns, and page up to 100 history interactions without dropping the oldest edge.
- Page durable prompt history bidirectionally without reading the complete JSONL file, preserve exact gap-free Up/Down navigation through a bounded reloadable window, isolate Ctrl+R paging, and label capped or fallback project-file discovery instead of silently hiding results.
- Recover a session whose live turn was orphaned by a stopped driver: an idle agent that still carries an open turn now reloads its session automatically, closing the interrupted turn and reporting queued messages that could not be kept, instead of queueing input forever while the agent reads as idle.
- Collapse queued cumulative prompt snapshots into their newest complete text so unbracketed multiline input cannot become many duplicated user turns.
- Expose user-invocable skills as first-class slash commands in autocomplete and `/help`, so a skill such as `/razbor` behaves like the built-in terminal commands.
- Resume the active task once when a text-only reply to `/steer` would otherwise close its turn.
- Keep slash-command autocomplete visible above the composer instead of letting its transient rows fall into native terminal scrollback.
- Keep `/sessions` history readable by collapsing duplicate delivery of the same prompt within one turn, and include the latest prompt preview in session search.
- Exclude service roots without local direct-human input from the default indexed session catalog, and let authoritative hydration remove stale placeholder rows instead of preserving them.
- Render Markdown tables richly while they stream, honor column alignment, and switch any crowded table to a lossless responsive record layout instead of crushing words into unreadable cells.
- Request enhanced terminal key reporting so Shift+Enter reliably creates readable paragraphs, and separate user prompts with restrained rules instead of gray background blocks.
- Reconcile live terminal geometry before painting so a resize missed during startup or between terminal events cannot leave the composer and status footer above blank rows.
- Resume the requested durable session directly at startup instead of briefly creating and publishing an empty replacement session first; recent-session, model-info, and skill catalogs now hydrate after the target transcript and composer are ready.
- Advance busy and Loop spinners only on real Agent or roster events, eliminating cosmetic full-frame timers that periodically stalled raw-key input in long sessions.
- Sanitize only the mutable terminal suffix after frozen transcript rows enter native scrollback, and keep memoized status footers isolated by theme so long sessions stay responsive without cross-theme paint reuse.
- Coalesce concurrent session-index startup work, validate only recent journal candidates, and read only the bounded viewport suffix during background hydration instead of restatting the full catalog and materializing the complete active journal.
- Replace exponential telemetry subset enumeration with a bounded dynamic program so status layout cost no longer grows as 2^n.
- Keep interleaved assistant and tool streaming attached to the correct turn and step, coalesce transcript/footer paints in production, and discard stale terminal frames while stdout is backpressured.
- Keep composer typing and submit responsive during long assistant replies by progressively freezing completed Markdown blocks into native scrollback while only the active block stays cheap and mutable; already shown paragraphs no longer disappear as the reply grows, and final Markdown still settles exactly once.
- List and resume sessions written by Harness rc.7 as a single Zstandard frame after upgrading to rc.8, instead of rejecting their header as corrupt.
- Consume terminal capability and status replies as control sequences instead of inserting their numeric or color payloads into the composer after focus or resize changes.
- Repaint from a clean physical baseline after hidden-tab resize signals, and provide `Ctrl+T` as a manual full-transcript recovery when a terminal host loses rows.
- Keep streaming assistant rows mutable until the authoritative reply settles, preventing partial Markdown layouts from entering native scrollback and appearing again before the complete answer.
- Prompt selectors now accept both terminal Enter encodings and submit the highlighted choice when a multi-select prompt has no checked options.

## [0.8.0] - 2026-08-20

### Changed

- TUI input is now keyboard-only: mouse tracking sequences are no longer emitted and SGR mouse reports are consumed and discarded instead of being typed into the composer or driving state.
- Finalized transcript rows now flow into native terminal scrollback while the live viewport remains keyboard-driven and mouse tracking stays disabled. Production startup waits for the initial session projection, idle replacement replays the complete Header, transcript, and composer, and running replacement pins its mutable tail until settlement. Direct terminals can clear stale scrollback and borrow the alternate screen for transient full-screen surfaces; multiplexers and ConPTY preserve host scrollback, and multiplexer resize bursts are coalesced. Large resumed transcripts replay completely rather than being truncated, while ordinary paints remain one DEC 2026 synchronized write.
- Long sessions now reuse the settled transcript as a stable render prefix, avoiding full-history display-width measurement on every streaming, status, or composer frame.
- Append-only assistant reasoning and text now scroll naturally with the Header and user messages, while mutable running-tool previews remain pinned to the live viewport.
- Dense assistant streaming deltas are now coalesced into short render windows, reducing redundant formatting and terminal writes while preserving immediate interaction, tool, and settlement updates.

### Fixed

- The live Agents roster now exposes a Down-to-focus task launcher plus its Alt+A direct shortcut. Enter opens a searchable fullscreen Agent Hub for arrow-key selection and Enter-to-inspect after mouse interaction was removed.

### Removed

- Removed all mouse-driven interactions, including click-to-caret in the composer, wheel-based transcript and overlay scrolling, and click-to-select in overlays and the subagent roster. Use the existing keyboard shortcuts (arrow keys, PgUp/PgDn, Shift+Up/Down, Tab, Enter, Esc) for the same actions.
- Removed `Mouse wheel` from the help/hotkeys surface.

## [0.7.0] - 2026-08-20

### Added

- Mention other sessions from the composer `@` menu. Unquoted `@` lists project files first, then session titles; `Tab` inserts a session mention, and sending the prompt captures a read-only snapshot for the model. Quoted `@"…` tokens stay file-only. File rows come from Harness `file-reference` discovery and still insert a path without uploading contents.
- Send composer images with `/goal` and `/plan`. Commands that do not accept attachments return an error and keep the original image draft in the composer.
- Mark an assistant reply cut off by an interrupt with a dim `· interrupted` suffix instead of presenting it as a complete reply. A turn interrupted before any visible content still prints the plain `interrupted` notice.

### Changed

- Upgraded every direct DeepSeek Harness dependency to the coherent `0.1.0-rc.8` release. Failed model requests now retry up to five times by default (previously two), and an inapplicable or valueless `compat` switch in a hand-edited `llm-pi-ai` settings section fails startup with an error naming the offending key.
- Refuse attached images over 3.5 MiB or larger than 2000px per side, matching the new Harness admission defaults. The composer checks admission when an image is pasted: a refused image shows an immediate error notice and stays out of the prompt instead of failing the completed submission on send.

### Fixed

- Route `/goal` and `/plan` after dropping TUI image placeholders that match attached drafts, leave handwritten `[Image #N]` text unchanged when nothing is attached, pass command whitespace through to Harness, and keep the original image draft when those commands fail.
- Keep `@` file rows on Harness `file-reference` results when that service is composed, including empty matches; local path search remains only when it is not.

## [0.6.1] - 2026-08-19

### Fixed

- Load user-installed DSH bundles from the omdsh Profile when running the published npm package.

## [0.6.0] - 2026-08-19

### Added

- Add [Write a plugin](docs/tutorials/write-a-plugin.md), a walkthrough for writing, installing, and publishing an omdsh plugin bundle.
- Ship [`examples/hello`](examples/hello), an installable bundle that registers `/hello` through `dsh-commands`.
- Install user DSH bundles into `$OMDSH_HOME/profiles/omdsh` with `omdsh plugin add` and `omdsh plugin remove`, and compose them after the shipped `@agi-fans/oh-my-dsh` layer at boot.
- Apply `$OMDSH_HOME/cordis.patch.yml` over the shipped composition at boot, and print the composed plugin tree with `omdsh --dump-config`.
- Show live descendant subagents above the composer, with each child's label, run state, and current tool, and present `subagent`, `send_message`, `interrupt_agent`, and `list_agents` cards by their task description instead of raw JSON.
- Open a subagent's own transcript from the Agents roster by clicking a row or pressing Alt+A, and return to the parent with Escape.
- Steer a continuable subagent from its inspect view: the composer delivers a follow-up to that child, while one-shot runs stay read-only.
- Acknowledge [Pi](https://github.com/earendil-works/pi) among the project's design influences.
- Add catalog and custom model providers through the published Harness pi-ai adapter. `/login` can store a catalog key or add a custom route (id, base URL, protocol, optional key, and model ids), `/logout` can drop that route, and `/model` lists every live provider.

### Changed

- Split the tutorials into one page per walkthrough, with [docs/tutorials.md](docs/tutorials.md) as the index.
- Highlight leading `/command` tokens in the composer, and paint slash-command names in the completion list, so those lines read as commands rather than ordinary prompt text.
- Use monochrome Unicode marks for pending, warning, todos, and settings instead of emoji-presentation glyphs.

### Fixed

- Fail loud when `omdsh plugin add` is given a missing filesystem path, instead of installing a broken link, and resolve `./examples/hello` from a subdirectory of a checkout.
- Keep ↑/↓ inside the current `/settings` tab instead of crossing into the other section.
- Hide the blinking composer cursor while a read-only subagent transcript is open.
- Paint idle subagents with a check instead of the hourglass pending glyph.

## [0.5.1] - 2026-08-18

### Fixed

- Resume sessions that recorded the omdsh tool-presentation event instead of refusing the log as an unknown harness type.

## [0.5.0] - 2026-08-18

### Added

- Added four independent, Harness-backed session controls: Agent presets (Standard, PTC, Minimal, and Cordis), Workflow (Default or Plan), tool presentation (Native, Code, or Both), and Access (Read only, Workspace write, or Full access).
- Added `/settings` Status line items that match the preview: each of Model, Effort, Path, Git, and the telemetry groups has its own color, left/right column, show/hide, and order.
- Show the session permission mode on the top-right of the composer, opposite the whale label.
- Add catppuccin, dracula, nord, gruvbox, and rose-pine palettes from the oh-my-pi coding themes.

### Changed

- Upgraded every direct DeepSeek Harness dependency to the coherent `0.1.0-rc.7` release and adopted its published Agent preset and Code runtime packages.
- Keep the lowercase Agent mode visible in the fixed footer, reveal Workflow only while Plan is active, show non-default tool presentation without category labels, keep lowercase Access on the composer boundary, and report all four separately in `/session`.
- Reset SGR attributes independently so nested color, bold, italic, and underline no longer wipe each other.
- Paint thinking traces in a quieter gray italic so they stay distinct from assistant body text, including after inline Markdown.
- Let the terminal own body ink across every palette while keeping thinking traces explicitly muted, so themes respect the user's foreground and background pairing.
- Paint thinking traces as readable comment-gray italic on dark palettes, including code, links, and headings inside those traces, so they recede from body text without collapsing into the background or being boosted to white.
- Use a quieter muted border for idle frames, quotes, rules, and tables, and complete the midnight and solarized palettes.

### Fixed

- Refresh the footer's Agent and tool-presentation labels immediately after `/agent` changes a blank session's composition.
- Restore distinct Header title, body, metadata, and frame tones across every palette, including monochrome and 16-color terminals.
- Keep the welcome card on the visible dim frame so Tips, Recent sessions, and the slogan do not sit on a near-invisible border.
- Paint fenced-code keywords with a dedicated syntax color instead of the UI accent.
- Soften inline Markdown code so codespans use a muted gray instead of accent-like orange or lavender; fenced blocks keep a separate, slightly stronger color.
- Render transcript Markdown through a GFM lexer so paragraphs reflow, nested emphasis and escapes stay intact, list items keep their continuations, and reference links resolve.
- Paint file-edit tool cards as aligned diffs: unchanged context stays dim, deletions are red, additions are green, one-line replacements mark the changed tokens, and the header shows `+N/-M`.
- Generate the CLI package README from the repository overview during packing, with npm-safe GitHub links, so npm documentation stays synchronized with the project homepage.
- Clarify that `@agi-fans/dsh-tui` is a non-executable integration library, direct end users to `@agi-fans/oh-my-dsh`, and enforce that distinction during package checks.

## [0.4.0] - 2026-08-16

### Added

- Added an oh-my-pi-inspired `/loop [count|duration] [prompt]` plugin with atomic next-prompt capture, actionable waiting guidance, explicit repeat progress, duration countdown, Ctrl-C pause and resume guidance, transient completion feedback, active-session isolation, and no routine control-message transcript noise.
- Added one-time startup release summaries, `/changelog [full]`, and cached non-blocking npm update notifications with controls in `/settings`.
- Added repository-local Skills for change validation, architecture and UX review, simplification audits, prose maintenance, bilingual documentation synchronization, and reproducible TUI demonstrations.

### Changed

- Made `/help` a compact command directory with essential shortcuts by default, added `/help full` for the complete key catalog, and limited the default `/changelog` view to the latest release.
- Adapted model selectors to use compact prompt cards for short lists and searchable full-screen pages only when the option set is large.
- Clarified that `/steer` affects the active turn's next model step, rejected idle steering, and normalized `/session` permission and token labels with the fixed footer.
- Made the repository release Skill hand npm publication to the user for interactive OTP completion, then resume registry verification and GitHub finalization without repeating completed work.
- Separated tool-call input from output in a single framed card, preserving long inputs after settlement and giving terminal output its own labeled, tail-focused preview.
- Consolidated architecture guidance into one current-state reference covering plugin ownership, runtime composition, data flow, terminal guarantees, public exports, and verification boundaries.

### Fixed

- Made the startup header read the current TUI package version instead of retaining the original `0.1.0` placeholder after releases.

### Removed

- Removed completed implementation plans, a stale oh-my-pi feature-gap snapshot, and the superseded plugin-migration review after preserving their durable constraints in the architecture reference.

## [0.3.0] - 2026-08-16

### Changed

- Replaced `/mode` with an agent-scoped `/permission` selector that offers fixed Harness permission presets and requires confirmation before enabling full access.
- Refined the composer Todo HUD into a bounded tree preview with completion progress, active-work visibility, completed-item strikethrough, and overflow summaries.

### Fixed

- Restored the latest Harness Todo projection above the composer, including live updates, replay restoration, and turn-boundary clearing.
- Prevented stale transcript viewport indicators from stacking after terminal cursor drift by absolutely reanchoring changed paints and filtering content-owned cursor controls.

## [0.2.0] - 2026-08-16

### Added

- Repository-local `publish-oh-my-dsh` Skill for preparing, publishing, recovering, and verifying synchronized npm and GitHub releases.
- Double-Escape conversation rewind with an interactive human-turn selector, non-destructive session forks, and editable restoration of the selected text and images.

### Changed

- Replaced `/queue` and `/dequeue` with a composer-level view of the durable Harness inbox; repeated `↑` presses walk backward through follow-ups for editing without changing their send order.
- Merged the keyboard-shortcut catalog into `/help` so commands and controls live in one discoverable surface.
- Manual `/compact` now enters a visible `Compacting` state, locks composer actions until settlement, and remains cancellable with `Ctrl+C`.

### Fixed

- Prevented exact-width terminal paints from triggering pending-wrap phantom rows, including duplicate `Deep Driving` indicators.
- Removed long-session input and activity lag by caching transcript layout per immutable message block and recomputing only animated or changed blocks.
- Reduced large-session resume work from quadratic to linear by using a private mutable replay builder with indexed tool-call lookup while preserving immutable live updates.
- Avoided rescanning the complete event log for every streaming update when durable Harness statistics, token usage, and context projections are available.

### Removed

- Removed the redundant `/pwd` and `/dirs` commands because the fixed status footer already shows workspace, model, and Git context.
- Removed `/search` and its SQLite session index; prompt-history search remains available through `Ctrl+R`.

## [0.1.1] - 2026-08-15

### Added

- DeepSeek `/login` and `/logout` flows with masked input, API-key validation, persistent Harness credentials, user-selected credential priority, and environment fallback.

### Changed

- Made the model selector skip a sole provider, use compact option rows, and preserve the current model and reasoning choices.
- Made ordinary notices unframed by default while retaining explicit frames for real component and interaction boundaries.

### Fixed

- Isolated settings and credentials under `OMDSH_HOME` so tests and alternate profiles do not read the user's default Harness state.

## [0.1.0] - 2026-08-15

### Added

- Plugin-first `omdsh` terminal application built on the published DeepSeek Harness runtime.
- Durable conversations with resume, search, retry, compaction, Markdown export, prompt history, and queued follow-up messages.
- Interactive model, reasoning-effort, access-mode, settings, tools, hotkeys, Skills, and MCP surfaces.
- Project-aware `@` file search, highlighted path mentions, and clipboard image paste.
- Fixed two-line status footer with model, reasoning, workspace, Git, context, token, latency, cache, timing, turn, and step information.

### Changed

- Split the TUI into Cordis plugins for presentation, session runtime, human interaction, tool presentation, commands, and the runner.
- Redesigned the startup header, composer, status footer, command output, tools, hotkeys, settings, resume, and model-selection experiences around compact terminal interaction.

### Fixed

- Preserved terminal-cell alignment and right padding for long commands, CJK text, emoji, ANSI styling, and narrow viewports.
- Stabilized incremental rendering, transcript scrolling, cursor placement, tool-output folding, and queued input during active turns.

[Unreleased]: https://github.com/agi-fans/oh-my-dsh/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/agi-fans/oh-my-dsh/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/agi-fans/oh-my-dsh/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/agi-fans/oh-my-dsh/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/agi-fans/oh-my-dsh/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/agi-fans/oh-my-dsh/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/agi-fans/oh-my-dsh/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/agi-fans/oh-my-dsh/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/agi-fans/oh-my-dsh/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/agi-fans/oh-my-dsh/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/agi-fans/oh-my-dsh/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/agi-fans/oh-my-dsh/releases/tag/v0.1.0
[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html
