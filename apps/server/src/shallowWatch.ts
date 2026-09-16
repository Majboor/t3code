import * as NFS from "node:fs";
import { Cause, Effect, Queue, Stream } from "effect";

/**
 * A directory watch that does not descend.
 *
 * `FileSystem.watch` hands a directory to Node's recursive watcher, which on
 * Linux is a poller: it re-reads and re-stats the whole tree on a short timer.
 * Pointed at the server's state directory — logs, attachments, hundreds of
 * per-user provider homes — that poll alone kept one core busy on a server that
 * had nobody connected, and it grew with every account. The settings and
 * keybindings files sit at the top of that directory, so a shallow watch sees
 * every save they will ever get and touches nothing below.
 */
export interface ShallowWatchEvent {
  readonly _tag: "Create" | "Update" | "Remove";
  /** The name Node reported, relative to the watched directory. */
  readonly path: string;
}

export const watchDirectoryShallow = (
  directory: string,
): Stream.Stream<ShallowWatchEvent, Error> =>
  Stream.callback<ShallowWatchEvent, Error>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watcher = NFS.watch(directory, { recursive: false }, (event, name) => {
          if (!name) return;
          const path = String(name);
          if (event === "change") {
            Queue.offerUnsafe(queue, { _tag: "Update", path });
            return;
          }
          // A rename is a create or a remove; ask the disk which.
          NFS.stat(`${directory}/${path}`, (error) => {
            Queue.offerUnsafe(queue, { _tag: error ? "Remove" : "Create", path });
          });
        });
        watcher.on("error", (error) => {
          Queue.failCauseUnsafe(queue, Cause.fail(error));
        });
        watcher.on("close", () => {
          Queue.endUnsafe(queue);
        });
        return watcher;
      }),
      (watcher) => Effect.sync(() => watcher.close()),
    ),
  );
