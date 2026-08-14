# Packs

The packs this repository publishes, as source. Each directory is a `.pack`:
`pack.json` plus the files that manifest points at.

They live here rather than only in a local registry because the knowledge in
them was earned by real deployments and is the part worth keeping — and because
two end-to-end suites hand a pack's integration prompt to an agent, which only
works on another machine if the pack travels with the code.

| Pack                     | What it knows                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ssh-deploy`             | Shipping anything to a host over SSH. Five failure modes from ten real deployments, including a health check answered by the previous deployment, and what to do when the thing is a terminal program with no port. |
| `analytics-core`         | Reporting events from a deployment: declare before you send, post with the key alone, and never let a failed report break the page.                                                                                 |
| `pdf-delivery`           | Serving a generated PDF and reporting how far readers get.                                                                                                                                                          |
| `gmail-apps-script-mail` | Sending mail through a Google Apps Script web app, including the `text/plain` requirement and the per-mailbox daily caps.                                                                                           |

## Signing

All four are signed. A signature says the release is unchanged since the key
named in it signed — not that the pack is any good.

```bash
node packages/pack-cli/src/bin.ts sign --dir packs/<name>
```

Signing rewrites `pack.json`, so a release already in a registry needs a new
version first: the registry refuses to overwrite one, on the grounds that a
change is always a new version.

## Publishing

```bash
node packages/pack-cli/src/bin.ts publish --dir packs/<name>
```

Publishing always makes a pack private to the workspace that cut it. Showing it
to anyone else is a separate, deliberate act on the pack's own page.
