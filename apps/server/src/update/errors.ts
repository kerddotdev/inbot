export class UpdateError extends Error {
  readonly code = "action_required";
  constructor(
    message: string,
    readonly fix = "Check the network and installation permissions, then retry inbot update. No older version is removed.",
  ) {
    super(message);
  }
}
