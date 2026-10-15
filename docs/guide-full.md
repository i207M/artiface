# Full guide

Start with the [quick guide](guide-quick.md) for everyday controls or [Deployment](deployment.md) for server setup.
This reference covers workspace behavior, viewers, settings, and access.

## Projects and navigation

Projects are saved local or SSH folders.
**Open a project** opens a saved folder; **New project** lets the owner choose a machine and folder with **Select folder**.
Choose **Settings → Sources → Add SSH host** to enter connection details and a password or private key.
Your Artiface admin password encrypts the saved credentials; no server restart is needed.
For existing SSH configuration, use the command-line import guide in Sources.
Unknown or changed host keys require fingerprint confirmation by the personal owner or Team admin before authentication.
Verify the displayed fingerprint through a trusted channel before approving it.
Sources also manages saved projects, visibility, and project script trust.
Removing an SSH host also deletes its saved credentials and closes its connections.
The admin password is needed to update encrypted credentials.
Files and the original SSH configuration remain on their machines.

Click a sidebar project name for Browse, its folder icon to expand its tabs, or the logo for Overview.
Overview gathers open files across projects and shows modification times.
Browse is always the first main tab; opening a file creates another tab, and desktop tabs can be dragged to reorder.
Drag project names in the left sidebar to reorder opened projects.
The project order is saved and synced across your devices; you can also focus a project name and use **Alt+Up/Down**.
Control/Command-click or middle-click opens a file from Browse in a background tab.
**Open containing folder** in Reader options returns to nearby files without closing the reader.

The open-project list is shared across devices for the same personal workspace or team user.
Other active devices normally see changes within about five seconds.
Closing a project removes it from that shared list and closes its tabs, but leaves the saved project available to reopen.
File tabs, expansion, and paused-refresh choices stay separate in each device's browser session.
Browse remembers each project's last folder across visits on that browser; changing the project's source resets it.
Signing out clears that browser's file tabs, while the shared projects remain saved.
Use **Retry project sync** if a project-list change could not be saved.

Hide the sidebar, switch it between dock and overlay, or drag its docked edge to resize.
Double-click the edge to reset its width; narrow screens use an overlay.
The arrow beside the file tabs retracts reader controls without closing the document.
**Full screen** hides application chrome and leaves one exit button; Escape also exits.
Browser fullscreen is used where supported, with a viewport-filling fallback.

## Browse, sorting, and filters

List view supports clickable Name, Type, Size, and Modified headings; click again to reverse the order.
**Sort files** also works in icon view and on phones.
The last manual order and list/icon choice are remembered on this browser.
Set **Default sort order** in **Settings → Appearance → Browse** or Browse settings.
**Use default order** replaces the remembered manual order with that saved default.

The filename field searches the loaded listing.
On phones it expands while focused; **Done filtering**, Enter, or Escape returns to the results without clearing the query.
Listings show 200 matches per page, while sorting and filtering apply across the loaded entries.
Returning from a reader restores the folder's page and scroll position within the session.

**Show files from all subfolders** makes a flat list with relative paths to distinguish duplicate names.
It skips ignored directories and avoids revisiting contained directory links.
An incomplete-tree notice appears when limits or inaccessible folders prevent a full scan.

| Type group | Included files |
| --- | --- |
| Documents | Markdown, LaTeX, PDF, and text. |
| Multimedia | HTML and browser-supported images, including SVG. |
| Code | Source, shell scripts, notebooks, JSON, and configuration files. |
| Others | CSV/TSV, archives, binary data, and unclassified files. |

**Settings → Appearance → Default file types** applies to folders without a custom filter.
Changing **Types** saves an override for that folder on this device, including its flat view.
**Use defaults** removes the override; **Show all types** enables everything for that folder.
Directories remain available for navigation in folder view.
Filters and ignore rules organize listings; they do not restrict direct access to files in an authorized project.

## Reader controls

Refresh, pause/resume, download, copy-path, sharing, and fullscreen controls appear in the toolbar or **Reader options** (`…`) as space allows.
Reader options also shows type, size, and modification time.
Use **Share link** for a stable app link that requires sign-in.
**Copy file path** copies the full server path for the owner and a project-relative path for team users.
If clipboard access fails, a selected path is offered for manual copying.

### Markdown, code, and LaTeX

Markdown supports math, tables, task lists, footnotes, and highlighted code blocks.
**Document outline** lists clickable headings; section links and footnote return links stay within the document.
Use **Rendered/Source** to switch views and **Wrap long lines** to control source wrapping.
Reader mode and separate source/rendered positions are remembered while the file remains open.
Large or slow-to-highlight blocks remain readable as plain text.
LaTeX is shown as source; **PDF** opens an existing file with the same basename.
Artiface does not compile LaTeX or execute notebooks.

### Images and tables

Images offer Fit, 25–400% zoom, rotation, and light/dark background choices for transparent artwork.
Pan a zoomed image by dragging or scrolling.
SVGs are displayed as images without executing embedded scripts.
Image view settings are retained across tab switches; resource reuse depends on the browser cache.

CSV and TSV open as paginated tables with a **Header** choice and a Source view.
Click a heading to cycle ascending, descending, and original file order.
Quoted delimiters, multiline values, and leading zeros are preserved; formulas and markup remain text.
Tables display 50 rows per page, with preview limits of 10,000 rows, 100 columns, and 50,000 cells.

### PDF

Use page controls, zoom, and rotation, or choose **Reader options → Page navigation** for horizontal swiping or vertical scrolling.
Horizontal navigation is the initial default and changes pages with swipes when the page fits the width.
Zoom and rotation menu items stay open for repeated adjustments.

The page-count dropdown offers an outline of embedded bookmarks and **Page overview** with clickable thumbnails.
Documents without bookmarks show an empty outline.
Selecting a thumbnail returns to reading at the current zoom and rotation.
Only nearby thumbnails and scrolling pages are rendered.

In Original mode, **Find in PDF** finds pages containing selectable text.
Enter and Shift+Enter move between matching pages; Escape closes search.
It does not perform OCR or highlight individual occurrences, and reports partial results when limits are reached.
Password-protected or otherwise unsupported PDFs may need a local reader.

### PDF compression

Enable **Compression** in Reader options or **Settings → Appearance → PDF compression**.
The choice is remembered on this device and is initially off.
Large PDFs also offer it while loading.

Compression renders JPEG pages on the Artiface server and loads them as needed, without sending the original PDF to your browser.
An SSH PDF must first transfer to the Artiface server, so that initial load can still take time.
Snapshots are reused while source metadata remains unchanged; the remote needs no PDF tools or new files.
Resolution adapts to the viewport and zoom, up to a 3,840-pixel longest edge, with small thumbnails for overview.

Compression can help image-heavy files and slower browser connections, but small vector PDFs may already be more efficient.
Images can lose fine detail and do not provide selectable text or PDF Find.
Page navigation, outlines, zoom, rotation, refresh, and fullscreen remain available.
If bookmark extraction is unavailable, the outline offers **Use Original mode**.
**Download file** always downloads the original PDF.
See [native tools](deployment.md#optional-native-pdf-tools) and [cache limits](#refresh-and-caching).

## HTML and links

HTML reports load in a sandbox under `/p/`, normally on the app's URL.
Their opaque origin blocks access to the app's DOM, storage, and authenticated APIs.
Report JavaScript is disabled by default; an Artiface bridge handles links independently.
When JavaScript is detected, the reader offers permission at the project level.
Owners can also change **Allow scripts** under **Settings → Sources**.
Enabling it trusts every HTML report in that project.
Scripts can read their preview folder and may contact external services; the sandbox is not a complete network boundary.
Disabling trust invalidates existing preview links and replaces the reader even when refresh is paused.

Keep assets beside the report or in its subfolders.
External CDNs, assets outside the preview directory, nested frames, popups, and forms are blocked.
Prefer self-contained exports for reports that normally depend on a CDN.
Local HTML and Markdown links open supported files in Artiface tabs, including other folders in the same project.
Unsupported files prompt for download; external websites prompt before opening a browser tab.
Same-page section links stay in the report.

Temporary preview URLs are bearer links scoped to the resolved file's parent directory.
They expire within 15 minutes and require a valid parent session; logging out revokes them.
Use the app's **Share link**, rather than copying an iframe URL.

## Git history, status and diffs

Browse shows branch status and badges for changed files.
Open a badge for a separate diff tab, or use the Git menu to include deleted files.
A file and its diff can stay open together in the sidebar and Overview.
Retained diff tabs reuse their content; **Refresh diff** checks for newer changes.
Choose **Inline** or **Side by side** in the diff toolbar to compare changes with line numbers.
Wide panes start side by side; narrow panes start inline.

Open the Git menu in Browse and choose **View Git history** for a separate commit graph tab.
The graph includes local branches, remote-tracking branches, tags, and HEAD without fetching from remotes.
Click a commit to expand its full message and changed files directly beneath the row.
Changed files appear in a collapsible folder tree, with added, modified, deleted, and type-change badges.
Merge commits show changes relative to their first parent.
Open **Commit details**, collapsed by default, for the full hash, parents, author, committer, and dates.
Select text in the history rows or expanded content and copy it normally.
Use the row chevron, Enter, or Space to collapse an expanded commit.
Use **Load older commits** to extend the graph, or **Refresh history** to see newer commits.
If branch tips change between pages, refresh before loading more.
Projects rooted in a repository subdirectory show history affecting that project.
History tabs remain available alongside files and diffs and are restored on reload.

Diffs combine staged and unstaged changes against the last commit, with an empty baseline for untracked files or repositories without a commit.
They are read-only and load on request; no staging, commits, checkout, hooks, external diff tools, or network fetches run.
Binary changes are reported as text rather than historical image/PDF previews.
Repositories needing file filters, such as Git LFS, or partial-clone fetching are excluded.

Disable status globally under **Settings → Appearance → Browse**, or per project under **Settings → Sources**.
The Git menu links directly to those project settings.
Git status checks pause for 10 minutes if they take too long or return too much data.
The panel explains the pause and offers **Try again**.

| Limit | Behavior |
| --- | --- |
| Status cache | 30 seconds between normal checks; browsing loads independently. |
| Slow or large status | Pauses after 8 seconds, over 2,000 changes, or excess metadata output. |
| Diff input | Skipped if either file version exceeds 8 MiB. |
| Diff output | Partial-preview notice at 128 KiB, 2,000 lines, or 8 seconds. |
| History | 100 commits per page, with a 2 MiB output limit and an 8-second timeout per read. |
| Commit changes | Up to 2,000 changed files per preview, with the same 2 MiB and 8-second read limits. |

Local inspection needs Git on the server; SSH inspection needs remote `git` and `timeout`.
Git uses separate bounded SSH sessions, while ordinary file browsing reuses SFTP connections.

## Ignored files

**Settings → Ignored files** edits `.artifaceignore` beside the server configuration.
Rules apply to all local and SSH Browse listings.
Startup creates defaults when the file is missing; existing custom or empty files are preserved.
Save an empty file to disable ignore rules.

```text
.git/
__pycache__/
*.pyc
/scratch/
**/temporary-*.html
```

Use one case-sensitive rule per line, with `#` at the start for comments.
Bare names match at any depth; a leading or internal slash anchors a pattern to the project root.
A trailing slash hides directories and descendants; `*` and `?` match within names, and `**` spans directory levels.
Negation, escaping, character classes, and inline comments are unsupported.

**Show hidden files and folders** is available here, in Appearance's Browse settings, and in the Browse popover.
It does not bypass ignore rules.
Ignored files can still be reached by direct project links and preview assets.
Saving applies rules immediately and detects concurrent edits.
Unsafe or unreadable ignore files fall back to defaults with a warning; see [file access troubleshooting](deployment.md#troubleshooting).

## Refresh and caching

**Settings → Appearance → Automatic refresh interval** ranges from 2 seconds to 5 minutes, defaulting to 10 seconds.
Pause/resume applies to an individual file tab; manual refresh still works.
Background tabs and hidden browser pages stop polling.
Overview reads modification times with at most two requests in flight and does not download artifacts.

Returning to a retained file preview shows its content first, then checks access and the file version unless refresh is paused.
Diff and history tabs update only through their refresh buttons.
Temporary update failures keep the last content visible with a notice; authorization failures remove affected content.
Checks compare size, modification time, and mode, not a content hash.
Use manual refresh for changes that preserve metadata or affect only a report's companion assets.
Text refresh tries to keep your position, PDF refresh keeps page/zoom where possible, and HTML reloads reset the report's internal controls and scroll.

| Cache | Bound and lifetime |
| --- | --- |
| Non-PDF readers | Up to 8 recently viewed readers, including live HTML frames, diff tabs, and Git history. |
| Original PDFs | Up to 4 inactive documents and 64 MiB of source bytes; active documents and rendering use additional memory. |
| Compressed pages in browser | Up to 24 images and 32 MiB of JPEG data. |
| Server PDF snapshots | Up to 4 documents and 2 GiB combined; each PDF is limited to 1 GiB and 10,000 pages. |
| Server JPEGs | Up to 256 images and 64 MiB, with at most 2 rendering jobs at once. |

Least-recently-used entries are evicted when limits are reached.
Browser reader caches clear on reload, sign-out, or source changes; closing tabs releases their retained content.
Image view settings do not constitute a persistent image-byte cache.
Server snapshots use private, unlinked temporary files, expire after 15 minutes unused, and disappear on restart.
Every compressed-page request still checks session, project access, and source metadata.
Artifact bytes are never stored in local storage, IndexedDB, or the service worker's offline cache.
The installable app caches only its public shell and assets; it needs a connection to open and update artifacts.

## Settings and installation

Appearance controls theme, text size, layout density, Browse defaults, file types, refresh, and PDF preferences.
Compact reduces spacing without shrinking text; Comfortable gives controls more room.
Viewing preferences stay on the device; Sources and ignore rules are shared server configuration.
On phones, switch settings sections with the selector in the top header.

Configuration and Ignored files drafts survive navigation within the current tab, but not sign-out or reload.
Concurrent saves are rejected instead of overwriting newer edits.
The Configuration editor excludes password hashes and SSH credentials.
Source edits apply immediately; session duration, listener, and browser-origin changes require a restart.
Direct file edits and CLI imports also require a restart.
**Settings → About** shows the Git commit and build time.

Use **Settings → Install app** where browser installation is supported.
On iPhone/iPad, use **Share → Add to Home Screen**.
Installation requires a suitable secure context, such as localhost or HTTPS.
**Reload app to update** appears when an updated shell is ready.

## Team administration

Personal mode is password-only; Team mode uses admin-created usernames and passwords.
See [mode selection](deployment.md#personal-and-team-modes) to choose it at startup.
In `/admin/`, add machines and project roots under **Sources**, then create users and assign projects under **Access**.
The admin password opens administration; create a regular user to browse in Team mode.
Admin and workspace sessions are separate.
After a restart, an admin sign-in unlocks the server's encrypted SSH credentials for authorized users.
Regular user passwords cannot unlock SSH; local projects remain available until the admin signs in.

Usernames are case-insensitive and stored lowercase, with letters, numbers, underscores, and hyphens supported.
Passwords require at least six characters.
Users can open assigned projects and change their viewing preferences, but cannot manage machines, choose arbitrary roots, edit ignore rules, or change script trust.
Project lists sync across that user's devices; file tabs remain separate.

**Edit user** changes grants, disables accounts, or resets passwords; leave the password blank to preserve it.
Removing a project also removes its grants.
Grant changes apply to subsequent API and preview requests; password resets, disabling, and deletion invalidate the user's sessions.
Changing the admin password in Security signs out all sessions.
If an edit or deletion conflicts, reload and discard/cancel, then review the current account before retrying.

Access covers a whole project root, including contained links and subfolders.
Use separate roots for different subsets; hidden machines and projects are unavailable to team users.
Revoking access cannot recall bytes already delivered to a browser.

## File boundaries and practical limits

Local and SSH artifact APIs are read-only.
Symlinks work when their resolved targets stay inside the project; preview assets must also stay in the resolved preview directory.
Escaping, cyclic links and non-regular files are rejected.
Use another project for an outside folder, and choose roots that exclude credentials and private application data.
Remote OS permissions remain the hard boundary against a concurrently malicious SSH filesystem.
Only configure trusted machines and import credentials intended for Artiface.

| Operation | Limit |
| --- | --- |
| Directory listing | 10,000 entries; SFTP responses bounded to 16 MiB. |
| Flat scan | 10,000 files, 512 directory attempts, 128 levels, and 20 seconds. |
| Text preview | 1 MiB; oversized previews are indicated. |
| HTML preview asset | 100 MiB. |
| Source highlighting | Plain-text fallback above 160,000 characters or processing/output limits. |
| SSH/SFTP connections | Up to 8, reused by target with idle cleanup and bounded leases. |

## Keyboard reference

| Area | Keys |
| --- | --- |
| Sidebar and list results | Up/Down, Home/End; Enter opens. |
| Icon results | Arrow keys move between entries. |
| Folder picker | Arrows navigate/expand; Enter or Space selects; **Select folder** confirms. |
| Background opening from Browse | Control/Command+Enter. |
| Markdown/PDF outline | Up/Down, Home/End, Enter; Escape closes. |
| PDF overview | Arrows, Home/End, Page Up/Down; Escape returns to reading. |
| Sidebar resize handle | Left/Right, Shift for larger steps, Home/End for limits, Enter resets, Escape cancels. |
| Fullscreen | Escape exits. |

For deployment issues, use [Troubleshooting](deployment.md#troubleshooting); for the security model and private reports, see [Security](../SECURITY.md).
