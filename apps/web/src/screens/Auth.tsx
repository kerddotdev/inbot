import { useId, type FormEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { Button, inputClasses } from "../components/ui";

function AuthLayout({
  icon,
  title,
  lead,
  children,
  fine,
}: {
  icon: IconName;
  title: string;
  lead: string;
  children: ReactNode;
  fine?: string;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-win px-6 py-12">
      <div className="w-full max-w-[380px] animate-rise text-center">
        <div className="mx-auto mb-6 grid size-14 place-items-center text-accent">
          <Icon name={icon} className="size-10" strokeWidth={1.3} />
        </div>
        <h1 className="mb-2.5 text-[30px] leading-tight font-semibold tracking-[-0.02em]">
          {title}
        </h1>
        <p className="mb-7 text-[15px] text-ink2">{lead}</p>
        {children}
        {fine ? <p className="mt-[26px] text-ink2">{fine}</p> : null}
      </div>
    </main>
  );
}

interface FieldProps {
  label: string;
  name: string;
  type?: "text" | "password";
  autoComplete?: string;
  hint?: string;
  centered?: boolean;
}

function Field({
  label,
  name,
  type = "text",
  autoComplete = "off",
  hint,
  centered = false,
}: FieldProps) {
  const id = useId();
  return (
    <div className="mb-3 text-left">
      <label htmlFor={id} className="mb-1.5 block font-semibold">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        aria-describedby={hint ? `${id}-hint` : undefined}
        required
        className={`${inputClasses} p-[11px] ${centered ? "text-center" : ""}`}
      />
      {hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-ink2">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function ErrorLine({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="mb-3 flex items-center justify-center gap-1.5 font-medium text-bad">
      <Icon name="alert" small />
      {message}
    </p>
  );
}

interface AuthProps {
  onSubmit: (data: FormData) => void;
  error?: string | undefined;
  busy?: boolean;
}

function submitHandler(onSubmit: AuthProps["onSubmit"]) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  };
}

export function Setup({ onSubmit, error, busy }: AuthProps) {
  return (
    <AuthLayout
      icon="key"
      title="Set up Inbot"
      lead="Enter the setup code printed in the terminal, then choose a password for this web interface."
    >
      <form onSubmit={submitHandler(onSubmit)} aria-busy={busy}>
        <fieldset disabled={busy}>
          <Field label="Setup code" name="code" hint="Shown once when the service first started." />
          <Field label="New password" name="password" type="password" autoComplete="new-password" />
          <Field
            label="Repeat password"
            name="confirm"
            type="password"
            autoComplete="new-password"
          />
          <ErrorLine message={error} />
          <Button variant="primary" type="submit" icon="check-circle" className="mt-3 w-full p-2.5">
            {busy ? "Creating account..." : "Create account"}
          </Button>
        </fieldset>
      </form>
    </AuthLayout>
  );
}

export function Login({ onSubmit, error, busy }: AuthProps) {
  return (
    <AuthLayout
      icon="inbox"
      title="Sign in to Inbot"
      lead="Use the password you chose during setup."
    >
      <form onSubmit={submitHandler(onSubmit)} aria-busy={busy}>
        <fieldset disabled={busy}>
          <Field label="Password" name="password" type="password" autoComplete="current-password" />
          <ErrorLine message={error} />
          <Button variant="primary" type="submit" className="mt-3 w-full p-2.5">
            {busy ? "Signing in..." : "Sign in"}
          </Button>
        </fieldset>
      </form>
    </AuthLayout>
  );
}

export function Locked({ onRetry }: { onRetry: () => void }) {
  return (
    <AuthLayout
      icon="lock"
      title="Inbot is locked"
      lead="Unlock the database on the machine running Inbot, then check again."
    >
      <Button variant="primary" icon="refresh" className="mt-3 w-full p-2.5" onClick={onRetry}>
        Check again
      </Button>
    </AuthLayout>
  );
}
