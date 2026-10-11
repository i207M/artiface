# Quick guide

Artiface turns folders on local and SSH machines into a browser workspace.
For server setup, follow [Deployment](deployment.md).

## Open your first project

1. Sign in with your personal password, or the username and password supplied by your team administrator.
2. Choose **Open a project** and select a saved project.
3. To add a folder in Personal mode, choose **New project**, select localhost or an SSH alias, and confirm the folder with **Select folder**.
4. Open a file from Browse; it gets its own tab.

**localhost** means the Artiface server, or its container when using Docker.
Add SSH hosts in **Settings → Sources → Add SSH host**, or use the command-line import guide there.
The owner or Team admin confirms unknown or changed server fingerprints before connecting.
Team users can open only projects assigned to them; administrators add projects in `/admin/`.
After a server restart, SSH remains locked until the personal owner or team admin signs in.

## Find and read

| Want to… | Use |
| --- | --- |
| Return to a project's files | Its name in the sidebar or its **Browse** tab. |
| Find a file | The filename field and **Types** filter. |
| See newest files first | **Sort files**, or click **Modified** in desktop list view. |
| Include nested folders | Browse settings → **Show files from all subfolders**. |
| Jump between open documents | Project tabs, sidebar files, or **Overview**. |
| Read a Markdown section | **Document outline**. |
| Jump within a PDF | Page count → outline or **Page overview**. |
| Read a large PDF on a slow connection | **Reader options → Compression**. |
| Inspect a changed file | Its Git badge; the diff opens in a separate app tab. |
| Share or locate a file | **Share link** or **Copy file path** in the reader controls. |

Other actions are under **Reader options** (`…`).
Download always gives you the original file.
HTML reports may ask for JavaScript permission; allowing it trusts every HTML report in that project.

## Keep your place

Files refresh automatically; pause one with its pause icon and refresh manually whenever needed.
Change the interval in **Settings → Appearance**.
Project lists are shared across your devices, while file tabs and viewing preferences stay on each device.
Closing a project closes its tabs across your devices; deleting a saved project removes its configuration, not its files.

Hide or resize the sidebar, retract the reader toolbar with the arrow beside the tabs, or use **Full screen** for uninterrupted reading.
Appearance also controls themes, text sizes, density, default sort order, and default file types.
Use **Settings → Install app** to add Artiface to a supported browser's home screen or app launcher.

For viewer details, cache behavior, ignore rules, and team administration, see the [full guide](guide-full.md).
