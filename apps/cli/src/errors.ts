import { ErrorStatus, type ErrorResponse } from "../../../packages/contracts/src/errors.js";

export class CliError extends Error {
  constructor(
    readonly detail: Pick<ErrorResponse, "code" | "message" | "fix">,
    readonly exitCode: number,
  ) {
    super(detail.message);
  }
}

export function usage(message: string): never {
  throw new CliError({ code: "validation_error", message, fix: "Run the command with --help." }, 2);
}

export function errorExitCode(error: ErrorResponse): number {
  switch (ErrorStatus[error.code]) {
    case 400:
    case 413:
      return 2;
    case 401:
      return 3;
    case 403:
      return 4;
    case 404:
      return 5;
    case 409:
      return 6;
    case 423:
      return 7;
    case 429:
      return 8;
    case 501:
      return 9;
    default:
      return 10;
  }
}
