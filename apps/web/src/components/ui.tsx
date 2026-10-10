import {
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "../icons";

type ButtonVariant = "default" | "primary" | "quiet" | "danger";

const buttonVariants: Record<ButtonVariant, string> = {
  default: "border-line bg-raise hover:bg-hover font-medium",
  primary:
    "border-transparent bg-accent text-accent-ink font-semibold hover:[background:color-mix(in_srgb,var(--accent)_88%,var(--text))]",
  quiet: "border-transparent text-ink2 hover:bg-hover hover:text-ink font-medium",
  danger: "border-transparent text-bad hover:bg-hover font-medium",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: IconName;
}

export function Button({
  variant = "default",
  icon,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-[7px] rounded-[7px] border px-3 py-1.5 transition-[background-color,transform] duration-150 active:translate-y-px disabled:opacity-50 ${buttonVariants[variant]} ${className}`}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
}

export function IconButton({
  icon,
  label,
  className = "",
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`grid size-[30px] place-items-center rounded-[7px] text-ink2 transition-colors duration-150 hover:bg-hover hover:text-ink ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

export type Tone = "ok" | "warn" | "bad" | "mute";

const toneClasses: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  mute: "text-ink2",
};

interface StatusProps {
  tone: Tone;
  icon: IconName;
  children: ReactNode;
  small?: boolean;
  className?: string;
}

export function Status({ tone, icon, children, small = true, className = "" }: StatusProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-[550] whitespace-nowrap ${toneClasses[tone]} ${className}`}
    >
      <Icon name={icon} small={small} />
      {children}
    </span>
  );
}

export function PaneBar({
  children,
  className = "",
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex h-[52px] flex-none items-center gap-2 border-b border-line px-4 ${className}`}
    >
      {children}
    </div>
  );
}

export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="mt-2.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="-ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-ink2 hover:bg-hover"
      >
        <Icon
          name="chevron"
          small
          className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        {label}
      </button>
      <div id={panelId} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => setCopied(true));
  };

  return (
    <>
      <IconButton
        icon={copied ? "check-circle" : "copy"}
        label={copied ? "Copied" : label}
        onClick={copy}
        className={copied ? "text-ok" : ""}
      />
      <span role="status" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </>
  );
}

export const inputClasses =
  "w-full rounded-[7px] border border-line bg-list px-2.5 py-2 hover:border-ink2";

export function ListMessage({
  icon,
  tone = "mute",
  title,
  children,
  action,
}: {
  icon: IconName;
  tone?: Tone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center gap-2 px-8 py-14 text-center"
      role={tone === "bad" ? "alert" : "status"}
    >
      <Icon name={icon} className={`size-6 ${toneClasses[tone]}`} />
      <p className="font-semibold">{title}</p>
      {children ? <p className="max-w-[28ch] text-ink2">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function SkeletonRows() {
  return (
    <div role="status" aria-label="Loading" className="px-4 py-3">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="border-b border-line py-3.5 pl-3">
          <div className="h-3 w-2/5 rounded bg-hover" />
          <div className="mt-2 h-3 w-4/5 rounded bg-hover" />
          <div className="mt-2 h-3 w-3/5 rounded bg-hover" />
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}

export function focusSibling(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a[data-row]"));
  const index = rows.findIndex((row) => row === document.activeElement);
  const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
  if (index === -1 || !next) return;
  event.preventDefault();
  next.focus();
}

interface PageProps {
  barTitle: string;
  barAction?: ReactNode;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}

export function Page({ barTitle, barAction, title, lead, children }: PageProps) {
  return (
    <section aria-label={barTitle} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneBar>
        <h2 className="text-[15px] font-[650] tracking-[-0.005em]">{barTitle}</h2>
        <span className="flex-1" />
        {barAction}
      </PaneBar>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-11">
        <h1 className="text-2xl leading-[1.15] font-semibold tracking-[-0.015em]">{title}</h1>
        {lead ? <p className="mt-2 mb-5 max-w-[62ch] text-sm text-ink2">{lead}</p> : null}
        {children}
      </div>
    </section>
  );
}

interface SegmentedProps<T extends string> {
  name: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({ name, options, value, onChange }: SegmentedProps<T>) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-raise p-0.5">
      {options.map((option) => (
        <label key={option.value} className="relative">
          <input
            type="radio"
            name={name}
            className="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0"
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span className="block rounded-md px-3.5 py-[5px] peer-checked:bg-win peer-checked:font-semibold peer-checked:shadow-[0_0_0_0.5px_var(--line),0_1px_2px_rgba(31,32,36,0.12)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-accent">
            {option.label}
          </span>
        </label>
      ))}
    </div>
  );
}
