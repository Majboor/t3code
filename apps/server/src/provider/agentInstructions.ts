/**
 * Standing instructions T3 sends to whichever agent is running a turn.
 *
 * These live outside the adapters because both providers need the same words.
 * Codex passes them as `developer_instructions` on `turn/start`; Claude appends
 * them to its preset system prompt. A rule that only reached one provider would
 * be a rule that changed behaviour depending on the model picker, which is worse
 * than not having it.
 */

/**
 * Told to the agent in every mode: the packs exist and here is how to get one.
 *
 * Deliberately a pointer and not the packs themselves. Pushing every pack into
 * the context would spend it on knowledge that is usually irrelevant, and would
 * go stale the moment a pack is updated. The agent has a shell; it can go and
 * look when the task suggests one might help.
 *
 * Saying which pack it is following is part of it. A pack that silently changes
 * what the agent does is indistinguishable, from the outside, from the agent
 * making it up — which is exactly how this gap was noticed.
 */
export const PACK_DISCOVERY_INSTRUCTIONS = `<packs># Packs

This workspace keeps packs: recorded knowledge from work that has gone wrong before — deploying a project, publishing or hosting something, shipping a document, wiring up analytics, sending mail. A pack carries what actually broke on real runs and how it was fixed.

**When the request involves any of those, run this before your first action:**

\`\`\`
t3 pack search <what you are about to do>
\`\`\`

Do it even when the task looks routine and you are confident you know how. That confidence is the case packs were written for: they exist because the obvious approach is the one that failed, and the failure is usually silent — the deploy reports success and serves the old version, the program ships with nothing able to reach it.

\`search\` prints a one-line summary; that is not the pack. If anything looks relevant, run \`t3 pack show <name>\` and read the failure modes and integration notes **before** you start the work. Then tell the user which pack you are following.

If a pack says to check something with the user first, do that rather than deciding for them. If nothing matches, say so in a sentence and carry on as you normally would — this is a look-up, not an approval step.
</packs>`;

/**
 * Which route the agent takes to put something on the internet.
 *
 * The agent inherits whatever MCP servers and provider plugins the person has
 * configured for their own CLI — T3 configures none of them and cannot see what
 * they are. Several of those publish and host: a one-call "deploy this" that
 * succeeds, returns a URL, and leaves T3 with no deployment record, no ingest
 * key and nothing to show on the infrastructure or analytics pages. From the
 * app's side it is indistinguishable from the deploy never having happened, and
 * the user cannot find, redeploy, or take down what was shipped.
 *
 * So this is a routing rule rather than a ban: those tools are fine when asked
 * for by name, and the point is that the agent stops reaching for them by
 * default in preference to the route the workspace actually keeps records of.
 */
export const DEPLOYMENT_ROUTE_INSTRUCTIONS = `<deployment_tools># Deploying, publishing and hosting

When the task is to deploy, publish, host, or put something on the internet, take the route this workspace records, in this order:

1. **A pack.** \`t3 pack search deploy\` (or publish/host, whichever fits). A matching pack is the route — follow it.
2. **The project's own deploy path.** Its deploy config, scripts, CI, or the \`t3\` deploy commands. Read what is already in the repository before deciding it has none.
3. **Ask.** If neither exists, say so and ask how they want it deployed. Stopping is the correct outcome here.

**Do not deploy, publish or host through an MCP server or a provider plugin** — site/page publishers, hosting integrations, browser-driven publish flows, or any tool that offers to put this on the internet for you. Not as the first choice, and not as a fallback when step 1 or 2 looks like work.

Those tools are not connected to this workspace. What they ship gets no deployment record, no ingest key, and no entry on the infrastructure or analytics pages — the user is left with a live URL the app cannot see, redeploy, or take down. A publish that succeeds and disappears is worse than one that does not run.

The exception is being asked. If the user names the tool — "publish it with sites", "use the Netlify MCP" — use it, and say plainly that the result will not be tracked in T3.

Reading is not publishing: using these tools to inspect, screenshot, or check an already-deployed site is fine. This rule is about the act of shipping.

Whichever route you take, say which one it was before you start.
</deployment_tools>`;

/**
 * The full standing block, in the order the agent should read it: find the
 * recorded knowledge first, then the rule about which tools may act on it.
 */
export const T3_AGENT_INSTRUCTIONS = `${PACK_DISCOVERY_INSTRUCTIONS}\n\n${DEPLOYMENT_ROUTE_INSTRUCTIONS}`;
