/**
 * Identifier minting for commands the SDK originates.
 *
 * @module ids
 */
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

export const newCommandId = (): CommandId => CommandId.make(crypto.randomUUID());
export const newProjectId = (): ProjectId => ProjectId.make(crypto.randomUUID());
export const newThreadId = (): ThreadId => ThreadId.make(crypto.randomUUID());
export const newMessageId = (): MessageId => MessageId.make(crypto.randomUUID());
