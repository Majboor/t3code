# Headless Provider Authentication Notes

This note records the gotchas seen while setting up provider CLIs on a remote
headless server.

## Claude Code

Claude Code can appear to ignore OAuth magic codes on a fresh server install.
In the observed case, the login flow was not actually waiting for the OAuth
code yet. It was blocked earlier by first-run interactive setup:

1. Terminal theme selection.
2. Login method selection.
3. Security and workspace trust prompts.

Because those screens are rendered in the terminal UI, pasting the browser code
too early can be swallowed by the first-run setup instead of submitted to the
auth prompt.

Use this flow on a fresh headless server:

```bash
claude auth login
```

Then complete the prompts in order:

1. Select a terminal theme.
2. Select the intended login method, for example Claude account with
   subscription.
3. Open the printed Claude OAuth URL.
4. Paste the returned browser code only after Claude shows:

```text
Paste code here if prompted >
```

5. Press Enter through the login success, security notes, and workspace trust
   prompts.
6. Verify:

```bash
claude auth status --text
claude auth status --json
```

The successful state should report `loggedIn: true` in JSON output.

Do not commit or paste long-lived credentials, API keys, or OAuth codes into
the repository. OAuth browser codes are short-lived and should only be used in
the active terminal prompt that generated the matching URL.

## Codex CLI

Codex supports a device-auth flow:

```bash
codex login --device-auth
```

Open the printed device URL and enter the one-time code shown in the terminal.
The code expires quickly, so restart the command if the browser flow takes too
long.
