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
  onSubmit: () => void;
  error?: string | undefined;
}

function submitHandler(onSubmit: () => void) {
  return (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
}

export function Setup({ onSubmit, error }: AuthProps) {
  return (
    <AuthLayout
      icon="key"
      title="Set up Inbot"
      lead="Enter the setup code printed in the terminal, then choose a password for this web interface."
    >
      <form onSubmit={submitHandler(onSubmit)}>
        <Field label="Setup code" name="code" hint="Shown once when the service first started." />
        <Field label="New password" name="password" type="password" autoComplete="new-password" />
        <Field label="Repeat password" name="confirm" type="password" autoComplete="new-password" />
        <ErrorLine message={error} />
        <Button variant="primary" type="submit" icon="check-circle" className="mt-3 w-full p-2.5">
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

export function Login({ onSubmit, error }: AuthProps) {
  return (
    <AuthLayout
      icon="inbox"
      title="Sign in to Inbot"
      lead="Use the password you chose during setup."
    >
      <form onSubmit={submitHandler(onSubmit)}>
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
        <ErrorLine message={error} />
        <Button variant="primary" type="submit" className="mt-3 w-full p-2.5">
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

export function Locked({ onSubmit, error }: AuthProps) {
  const id = useId();
  return (
    <AuthLayout
      icon="lock"
      title="Inbot is locked"
      lead="Your mail is encrypted on this machine. Enter your passphrase to read it."
      fine="Agents can still receive mail while locked. It is stored encrypted and becomes readable after you unlock."
    >
      <form onSubmit={submitHandler(onSubmit)}>
        <label htmlFor={id} className="sr-only">
          Passphrase
        </label>
        <input
          id={id}
          type="password"
          required
          placeholder="Passphrase"
          autoComplete="off"
          autoFocus
          className={`${inputClasses} p-[11px] text-center`}
        />
        <ErrorLine message={error} />
        <Button variant="primary" type="submit" icon="unlock" className="mt-3 w-full p-2.5">
          Unlock
        </Button>
      </form>
    </AuthLayout>
  );
}
