import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CredentialRef } from "../../api";
import { REVEAL_TIMEOUT_MS } from "./format";

type RevealState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "failed"; error: unknown }
  | { status: "shown"; fields: Readonly<Record<string, string>> };

export function useReveal(credential: CredentialRef, updatedAt: string) {
  const [state, setState] = useState<RevealState>({ status: "hidden" });
  const attempt = useRef(0);

  const hide = useCallback(() => {
    attempt.current += 1;
    setState({ status: "hidden" });
  }, []);

  const reveal = useCallback(() => {
    const current = ++attempt.current;
    setState({ status: "loading" });
    api.revealCredential(credential).then(
      (result) => {
        if (attempt.current === current) setState({ status: "shown", fields: result.fields });
      },
      (error: unknown) => {
        if (attempt.current === current) setState({ status: "failed", error });
      },
    );
  }, [credential]);

  useEffect(hide, [updatedAt, hide]);

  const shown = state.status === "shown";
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(hide, REVEAL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [shown, hide]);

  useEffect(() => () => void (attempt.current += 1), []);

  return { state, reveal, hide };
}
