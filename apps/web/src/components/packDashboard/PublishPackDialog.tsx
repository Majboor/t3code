import { PackagePlusIcon } from "lucide-react";
import { useState } from "react";

import type { EnvironmentId } from "@t3tools/contracts";

import { buildManifest, findPublishProblems, type PublishPackShape } from "./publishPack.logic";
import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

/**
 * Publishes a project as a pack.
 *
 * It asks for two things and refuses to guess either: what it does, and what
 * was learned building it. That is not friction for its own sake — the format's
 * argument is that the knowledge is the product, and a generated handover would
 * read as experience while being nothing of the kind.
 *
 * Everything published starts private to the workspace. Showing it to anybody
 * else is a separate act on the pack's own page.
 */
export function PublishPackDialog({
  environmentId,
  projectName,
  open,
  onOpenChange,
  onPublished,
}: {
  environmentId: EnvironmentId;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPublished?: (packId: string) => void;
}) {
  const [name, setName] = useState(() => projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
  const [summary, setSummary] = useState("");
  const [handover, setHandover] = useState("");
  const [shape, setShape] = useState<PublishPackShape>("web");
  const [startCommand, setStartCommand] = useState("");
  const [requirements, setRequirements] = useState("");
  const [busy, setBusy] = useState(false);
  const [showProblems, setShowProblems] = useState(false);

  const problems = findPublishProblems({ name, summary, handover });
  const problemFor = (field: "name" | "summary" | "handover") =>
    showProblems ? problems.find((problem) => problem.field === field)?.why : undefined;

  const publish = async () => {
    setShowProblems(true);
    if (problems.length > 0) return;

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      toastManager.add({ type: "error", title: "This window is not connected." });
      return;
    }

    setBusy(true);
    try {
      const snapshot = await api.organizations.list();
      const workspace = (snapshot.workspaces ?? [])[0];
      if (!workspace) {
        throw new Error("This session can see no workspace to publish into.");
      }

      const manifest = buildManifest({
        shape,
        startCommand,
        requirements,
        name,
        summary,
        handover,
        publisherHandle: workspace.tenantId,
        workspaceKeyId: `wsk_${workspace.id}`,
        authorName: "you",
        extractedAt: new Date().toISOString(),
        packId: `pack_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      });

      // A request that never settles would leave this dialog saying
      // "Publishing…" for ever, which is the least useful thing it could do.
      const published = await Promise.race([
        api.packs.publish({
          tenantId: workspace.tenantId,
          workspaceId: workspace.id,
          manifest,
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("The registry did not answer. Nothing was published.")),
            20_000,
          ),
        ),
      ]);

      toastManager.add({
        type: "success",
        title: `Published ${name}`,
        description: "Private to this workspace. Sign it and open it up from its page.",
      });
      onOpenChange(false);
      onPublished?.(published.pack.packId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not publish",
        description: error instanceof Error ? error.message : "The request failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogPanel data-testid="publish-pack-dialog">
          <DialogTitle>Publish as a pack</DialogTitle>
          <div className="mt-3 grid gap-3">
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Name</span>
              <Input
                value={name}
                data-testid="publish-pack-name"
                onChange={(event) => setName(event.currentTarget.value)}
              />
              {problemFor("name") ? (
                <span className="text-destructive" data-testid="publish-pack-problem">
                  {problemFor("name")}
                </span>
              ) : null}
            </label>

            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">What it does, in one line</span>
              <Input
                value={summary}
                data-testid="publish-pack-summary"
                onChange={(event) => setSummary(event.currentTarget.value)}
              />
              {problemFor("summary") ? (
                <span className="text-destructive" data-testid="publish-pack-problem">
                  {problemFor("summary")}
                </span>
              ) : null}
            </label>

            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">
                What you built, what you tried, what you left undone
              </span>
              <Textarea
                value={handover}
                rows={5}
                data-testid="publish-pack-handover"
                onChange={(event) => setHandover(event.currentTarget.value)}
              />
              {problemFor("handover") ? (
                <span className="text-destructive" data-testid="publish-pack-problem">
                  {problemFor("handover")}
                </span>
              ) : null}
            </label>

            <div className="grid gap-1 text-xs">
              <span className="text-muted-foreground">What is it?</span>
              <div className="flex gap-1">
                {(["web", "tui"] as const).map((option) => (
                  <Button
                    key={option}
                    size="xs"
                    variant={option === shape ? "default" : "outline"}
                    data-testid="publish-pack-shape"
                    onClick={() => setShape(option)}
                  >
                    {option === "web" ? "A web surface" : "A terminal program"}
                  </Button>
                ))}
              </div>
            </div>

            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">
                {shape === "web" ? "How it starts, if you know" : "The command that runs it"}
              </span>
              <Input
                value={startCommand}
                data-testid="publish-pack-start"
                onChange={(event) => setStartCommand(event.currentTarget.value)}
              />
            </label>

            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">
                What whoever uses it must supply — one name per line, a trailing ! for a secret
              </span>
              <Textarea
                value={requirements}
                rows={3}
                placeholder={"DEPLOY_HOST\nDEPLOY_TOKEN!"}
                data-testid="publish-pack-requirements"
                onChange={(event) => setRequirements(event.currentTarget.value)}
              />
            </label>

            <p className="text-[11px] leading-5 text-muted-foreground">
              It starts private to this workspace, with an empty record — nothing has been
              installed or deployed from it yet, and saying so is the point.
            </p>
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button size="sm" disabled={busy} data-testid="publish-pack-confirm" onClick={() => void publish()}>
              <PackagePlusIcon />
              {busy ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
