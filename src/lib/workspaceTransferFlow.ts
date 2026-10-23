import type { WorkspaceMember } from "../types/electron";

// Pure state machine for the transfer ownership dialog. The candidate is an id,
// not a member, because the roster changes under the dialog (a refresh after
// the transfer makes the new owner an owner, who is no longer a candidate).
export type TransferState =
  | { kind: "closed" }
  | { kind: "choosing"; candidateId: string | null }
  | { kind: "transferring" | "failed"; candidateId: string };

export type TransferEvent =
  | { type: "open"; candidateId?: string }
  | { type: "pick"; candidateId: string }
  | { type: "confirm" }
  | { type: "failed" }
  | { type: "dismiss" };

const displayName = (member: WorkspaceMember): string => member.name || member.email;

const byDisplayName = (a: WorkspaceMember, b: WorkspaceMember): number =>
  displayName(a).localeCompare(displayName(b));

/** Everyone the owner can hand the workspace to: admins first, then members. */
export function transferCandidates(
  members: WorkspaceMember[],
  selfUserId: string
): WorkspaceMember[] {
  const others = members.filter((m) => m.user_id !== selfUserId && m.role !== "owner");
  return [
    ...others.filter((m) => m.role === "admin").sort(byDisplayName),
    ...others.filter((m) => m.role !== "admin").sort(byDisplayName),
  ];
}

export function transferReducer(state: TransferState, event: TransferEvent): TransferState {
  switch (event.type) {
    case "open":
      return { kind: "choosing", candidateId: event.candidateId ?? null };
    case "pick":
      if (state.kind === "choosing" || state.kind === "failed") {
        return { kind: "choosing", candidateId: event.candidateId };
      }
      return state;
    case "confirm":
      if (state.kind === "choosing" && state.candidateId) {
        return { kind: "transferring", candidateId: state.candidateId };
      }
      if (state.kind === "failed") {
        return { kind: "transferring", candidateId: state.candidateId };
      }
      return state;
    case "failed":
      return state.kind === "transferring"
        ? { kind: "failed", candidateId: state.candidateId }
        : state;
    case "dismiss":
      // Also the success path: the dialog dismisses itself once the transfer
      // resolves. The dialog blocks a user dismissal while it is busy.
      return { kind: "closed" };
  }
}
