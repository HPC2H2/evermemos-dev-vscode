# Change Log

## [Unreleased]

- Add English, Simplified Chinese, and Traditional Chinese translations using VS Code display language, including commands and settings.
- Respect disabled editor capture and explicit text; preserve exact snippets, whitespace, and escape sequences when saving and inserting.
- Escape result content, enforce nonce-based webview policies, and bundle local syntax highlighting.
- Keep search scoped to the current user and project, cache supported routes, and limit fallback to HTTP 404/405.
- Cancel HTTP reads and retry delays promptly; avoid replaying writes after ambiguous network failures.
- Reuse result panels and generated overviews while preserving user edits.
- Synchronize sidebar settings without reload; improve checkbox layout, status badges, keyboard focus, and themed buttons.
- Add scoped delete pagination, consistent memory IDs, localized status reporting, and regression tests without cloud credentials.
- Isolate extension-host tests in temporary profiles; support testing against an installed VS Code executable.

## [0.1.0]

- Initial release.
