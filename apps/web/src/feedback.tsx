import { errorText } from "./api";
import { Icon } from "./icons";
import { Button, ListMessage } from "./components/ui";

export function ErrorNotice({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="my-3 flex items-start gap-1.5 text-bad">
      <Icon name="alert" small className="mt-0.5 shrink-0" />
      {errorText(error)}
    </p>
  ) : null;
}

export function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <ListMessage
      icon="alert"
      tone="bad"
      title="Could not load data"
      action={
        <Button icon="refresh" onClick={retry}>
          Try again
        </Button>
      }
    >
      {errorText(error)}
    </ListMessage>
  );
}
