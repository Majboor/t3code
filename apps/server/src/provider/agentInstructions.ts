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
 *
 * Worth knowing before anyone "fixes" this by injecting pack text into turns:
 * that has been proposed twice, on the grounds that enabling a pack appears to
 * change nothing. Enablement is a record; discovery is the mechanism, and the
 * two are not the same feature. Both times the real fault was that discovery
 * could not run — `t3` was absent from Claude turns, and `listVersions` did not
 * know about shipped packs, so `pack show` failed for every pack that ships
 * with the product. Check that `t3 pack search` and `t3 pack show` actually
 * work for the provider in question before concluding the design is wrong.
 */
export const PACK_DISCOVERY_INSTRUCTIONS = `<packs># Packs

This workspace keeps packs: recorded knowledge from work that has gone wrong before — deploying a project, publishing or hosting something, shipping a document, wiring up analytics, sending mail. A pack carries what actually broke on real runs and how it was fixed.

**When the request involves any of those, run this before your first action:**

\`\`\`
t3 pack search <what you are about to do>
\`\`\`

Do it even when the task looks routine and you are confident you know how. That confidence is the case packs were written for: they exist because the obvious approach is the one that failed, and the failure is usually silent — the deploy reports success and serves the old version, the program ships with nothing able to reach it.

**Wait for it to finish and read what it printed.** It takes well under a second. Do not start the next step while it is still running, and do not report what it found until you have its output in front of you — "no pack matches" is a claim about a result you have to have actually seen. If the command failed or you never got the output, say that instead; a search that did not run is not a search that found nothing.

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
 *
 * The clause about config files is not hypothetical. An agent asked to deploy
 * found `.openai/hosting.json` committed to the repository, correctly read the
 * earlier wording — "its deploy config … read what is already in the
 * repository" — as step 2, and shipped through the Sites plugin while
 * reporting it had used "the project's own hosting setup". It was following
 * the instructions. Where the settings live says nothing about who executes
 * them, so the rule now turns on the executor.
 */
export const DEPLOYMENT_ROUTE_INSTRUCTIONS = `<deployment_tools># Deploying, publishing and hosting

When the task is to deploy, publish, host, or put something on the internet, take the route this workspace records, in this order:

1. **A pack.** \`t3 pack search deploy\` (or publish/host, whichever fits). A matching pack is the route — follow it.
2. **The project's own deploy path**, meaning one you can run yourself: its deploy scripts, CI, container or server config, or the \`t3\` deploy commands. Read what is already in the repository before deciding it has none.
3. **Ask — and offer to set it up.** If neither exists, say so, and ask for the target: a host, a user, where it puts things, and a port range. Say plainly that you have nowhere to deploy to yet rather than finding somewhere.

When they give you those details, wire them up rather than handing the work back:

\`\`\`
printf %s "<the password>" | t3 secret set <secret-name>
\`\`\`

Then write \`deploy.config.json\` in the project root referring to that secret **by name**. The password goes in the secret store and nowhere else — never into the config file, never into the repository, and never as a command-line argument, because arguments are visible to every process on the machine and land in shell history. Reading it back is not possible and not needed.

Say what you stored and what you wrote, naming the secret but never its value. If the target is a shared machine, check what is already listening before taking a port — a list of ports in somebody's notes goes stale, and taking a used one silently takes traffic from whatever already had it.

**Do not deploy, publish or host through an MCP server or a provider plugin** — site/page publishers, hosting integrations, browser-driven publish flows, or any tool that offers to put this on the internet for you. Not as the first choice, and not as a fallback when step 1 or 2 looks like work.

**A config file in the repository does not make it the project's own deploy path.** What decides the route is who executes it, not where the settings are kept. A file like \`.openai/hosting.json\`, a sites or pages project id, or any config whose only executor is a plugin or an MCP tool **is the plugin route** — finding it committed to the repo is not permission to take it. That is step 3: say what you found, say it would ship through a tool this workspace cannot record, and ask.

Step 2 means a command you could run in the shell and show the output of. If putting it live requires a tool you did not run yourself, it is not step 2.

**Whatever the route, put it live through \`t3 deploy\`.** Register the start command once with \`t3 deploy add\`, then run it with \`t3 deploy run\`. Starting the process yourself works and records nothing: no deploy target, no deployment, no ingest key — and the Infrastructure and Analytics pages read exactly those rows, so they stay empty while the site serves perfectly. That is the same outcome this section warns about for plugin routes, arrived at by a different door. If analytics is wanted, it can only be wired here: the ingest key is minted during \`t3 deploy run\` and never stored, so a deployment started any other way has no way to report.

Those tools are not connected to this workspace. What they ship gets no deployment record, no ingest key, and no entry on the infrastructure or analytics pages — the user is left with a live URL the app cannot see, redeploy, or take down. A publish that succeeds and disappears is worse than one that does not run.

The exception is being asked. If the user names the tool — "publish it with sites", "use the Netlify MCP" — use it, and say plainly that the result will not be tracked in T3.

Reading is not publishing: using these tools to inspect, screenshot, or check an already-deployed site is fine. This rule is about the act of shipping.

Whichever route you take, say which one it was before you start.
</deployment_tools>`;

/**
 * How to drive a machine that is not this one.
 *
 * A pointer, exactly like the packs block above it, and for the same reason
 * stated there: this says how to *ask*, never what the answer is. The temptation
 * is to inject the state — the boxes on the account, what is listening on each,
 * which ports are free — because it looks helpful and it is one query. It is
 * wrong in three ways and the third is the expensive one. It spends context on
 * a machine most turns never touch; it is stale the moment it is written, since
 * a port taken between the injection and the command is a port the agent still
 * believes is free; and an agent handed a list stops asking, so the *only* view
 * it ever has is the frozen one. `t3 box services` costs a second and is true
 * when it answers. Anyone tempted to inject this should read the note on pack
 * enablement above first: the same argument was made there twice, and both
 * times the real fault was that discovery could not run.
 *
 * The refusal rule is stated here as well as enforced in `decideBoxCommand`,
 * because an agent that learns the boundary only by hitting it has already
 * spent a turn trying to kill somebody's database. Enforcement is what makes it
 * safe; saying it out loud is what makes it not a surprise.
 *
 * What is deliberately absent: any suggestion that a box needs a provider
 * account. It does not and must not. The turn runs here, on the person's own
 * credential; the box is only ever a machine being driven, and asking someone to
 * log into Claude on a VPS is the failure this whole shape exists to avoid.
 */
export const BOX_COMMAND_INSTRUCTIONS = `<boxes># Machines you drive

Some work does not happen on this machine. A **box** is a separate machine on the same account — a VPS, a server, a spare desktop — that runs and serves things. You reach it for the length of a command and you do not live there: it holds no projects, runs no turns, and never needs a provider account of its own.

**Do not guess what is on a box, and do not remember it between turns.** Ask:

\`\`\`
t3 box services <box>
\`\`\`

That is the only current answer. A port that was free earlier in the session may not be free now, and a note in your own context saying otherwise is the commonest way two things end up fighting over 3000.

The verbs:

- \`t3 box run <box> -- <command>\` — run it and wait. You get an exit code and a bounded slice of the output.
- \`t3 box run <box> --detach -- <command>\` — start something that should outlive this turn. Use this for anything that serves.
- \`t3 box services <box>\` — what is running, which of it T3 started, and which ports are taken.
- \`t3 box port claim <box> <port> --purpose "..."\` / \`t3 box port release <box> <port>\` — reserve a port *before* you start something on it, so a turn running alongside you does not take it too.
- \`t3 box logs <box> <name>\` — captured output of something T3 started.
- \`t3 box stop <box> <name>\` — stop something T3 started.
- \`t3 box history <box>\` — what has happened on this box recently.

**Start by reading the history.** \`t3 box history\` is the memory you do not have: what ran, when, by which turn, and how it ended. It tells you which port the app is already on, whether the migration was applied, and what was tried and abandoned — and it works when the box is switched off, which is often exactly when you need it. Running things to find out what state a machine is in is how the same mistake gets made twice on a machine serving real traffic.

**You may only stop what T3 started.** A box runs other people's work: databases, production APIs, jobs nothing here knows about. \`t3 box services\` labels every row with who started it, and anything not marked as ours will refuse to stop. That refusal is correct — treat it as the answer, not as an obstacle. Nothing available to you can tell what depends on an unrecognised process, so the next step is to say what you found and ask the person who owns the machine.

**Output is truncated on purpose.** You get the first and last couple of kilobytes of each stream with a marker naming the gap, because an install log is thousands of lines and none of them are worth your context. The whole thing is kept — \`t3 box output <id>\` fetches it using the id printed with the result. Read the exit code and the tail first; you will usually find you do not need the rest.

Say which box you are working on before you touch it.
</boxes>`;

/**
 * That *this* machine also keeps a record, and how to ask it.
 *
 * A pointer, not a listing — the same shape as the packs block, and for a
 * stronger reason than either of the blocks above. Packs go stale slowly; a list
 * of ports is wrong within seconds of being written, so a turn that thinks for
 * two minutes before binding would be acting on a snapshot from before it
 * started. Every question here has to be asked at the moment it is answered,
 * which means the agent has to run the command rather than read the answer in
 * its context.
 *
 * Deliberately parallel to `BOX_COMMAND_INSTRUCTIONS` in wording, because the
 * rule really is the same rule and an agent that learned it for boxes should
 * recognise it here. The distinction the two blocks have to keep clear is only
 * *which machine*: `t3 box` reaches one on the account, `t3 env` is the one the
 * turn is running on — the one where the workspace, the repository and the
 * agent's own shell already are. Nothing else differs, including the refusal.
 *
 * The section that earns its place is the second one. Detection is the easy
 * half; the hard half is that a port match is not an identity, and an agent
 * shown a list of ports will infer ownership from "I am working on this project
 * and here is something on the port I expected". `unknown` exists precisely
 * because most machines cannot attribute a socket to a process, and the whole
 * value of the word is lost if it reads as a hedged yes. So it is stated as a
 * prohibition on an action rather than a description of a field: do not stop
 * what you did not start, and `canManage` is the only thing that says you did.
 *
 * Before anyone "improves" this by injecting the current service list into the
 * turn — that turns a live question into a stale claim, and a stale "port 3000
 * is free" is worse than no registry at all, because the agent acts on it. Same
 * mistake as injecting pack text, reached by a different door.
 */
export const ENVIRONMENT_REGISTRY_INSTRUCTIONS = `<environment># What is already running on this machine

The machine this turn is running on is not empty. It serves things that have nothing to do with your task — someone's database, a production API, a colleague's dev server — and the workspace keeps a record of which of them T3 started. These commands are about *this* machine; \`t3 box\` is for a machine somewhere else.

**Before you bind a port, ask:**

\`\`\`
t3 env port check <port>
\`\`\`

It answers whether the port is free, says what is on it if not, and names one that is. If you are going to start something, take the port first so a turn running alongside you does not take it too:

\`\`\`
t3 env port claim <port> --purpose "<what you are starting>"
\`\`\`

A claim lapses on its own, so a crash cannot hold a port for good. Release it with \`t3 env port release <port>\` if you end up not using it.

**To see the whole machine:** \`t3 env services\`. Run it before you conclude anything about what is or is not running. A port list in somebody's notes — or earlier in this conversation — is out of date the moment it is written.

**After you start a long-running process, record it:**

\`\`\`
t3 env service add --name <name> --port <port> --pid <pid> --command "<command>"
\`\`\`

Until you do, it is indistinguishable from a stranger's process, and neither you nor anyone else can manage it through the workspace. If you restart it, register the new pid: the old one stops being ours the moment it dies.

## What you may stop

Every row \`t3 env services\` prints says who started it. **Only stop, kill or restart something the workspace says T3 started** — the rows under "Started by T3", the ones whose JSON carries \`"canManage": true\`.

Everything under "Already running here" is off limits, and that includes rows marked \`UNKNOWN\`. \`UNKNOWN\` does not mean "probably mine". It means this machine would not say which process holds that port, which is the ordinary case on hosts where only \`netstat\` is available. Treat it exactly as you would treat somebody else's.

Two things that look like permission and are not:

- **The port is the one you expected.** That is not proof. Your process can die and something else bind the same port a second later; the registry correlates by process id for exactly that reason, and so should you.
- **Something is in the way and looks stale.** You cannot tell a stale process from a quiet production one from the outside. If a port you need is held by something T3 did not start, take a different port and say what was in the way.

If you genuinely need a port something else holds, say so and ask. Stopping the wrong process here is not an inconvenience — it takes down something this workspace has no record of and cannot bring back.
</environment>`;

/**
 * The full standing block, in the order the agent should read it: find the
 * recorded knowledge first, then the rule about which tools may act on it, then
 * how to reach a machine that is not this one, then what this one is already
 * doing.
 *
 * The environment block sits last because it is the one that has to be in mind
 * at the moment of a shell command rather than at the moment of planning. The
 * three before it decide what the agent does; this one constrains how it touches
 * the machine while doing it.
 */
export const T3_AGENT_INSTRUCTIONS = `${PACK_DISCOVERY_INSTRUCTIONS}\n\n${DEPLOYMENT_ROUTE_INSTRUCTIONS}\n\n${BOX_COMMAND_INSTRUCTIONS}\n\n${ENVIRONMENT_REGISTRY_INSTRUCTIONS}`;
