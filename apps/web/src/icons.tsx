import type { ReactNode, SVGProps } from "react";

const paths = {
  inbox: (
    <>
      <path d="M2 9l1.6-5.2A1 1 0 0 1 4.6 3h6.8a1 1 0 0 1 1 .8L14 9v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
      <path d="M2 9h3.5l.8 1.5h3.4L10.5 9H14" />
    </>
  ),
  "check-circle": (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 8.2l1.8 1.8 3.4-3.7" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 1.8 2 10.2 0 12M8 2c-2 1.8-2 10.2 0 12" />
    </>
  ),
  key: (
    <>
      <circle cx="5.5" cy="10.5" r="2.7" />
      <path d="M7.5 8.5L13.5 2.5M11 5l1.8 1.8M9.5 6.5l1.2 1.2" />
    </>
  ),
  link: (
    <>
      <path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7" />
      <path d="M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" />
    </>
  ),
  unlock: (
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.2 7V5a2.8 2.8 0 0 1 5.4-1" />
    </>
  ),
  clip: (
    <path d="M13 7.5l-4.8 4.8a3 3 0 0 1-4.2-4.2l5-5a2 2 0 0 1 2.8 2.8l-5 5a1 1 0 0 1-1.4-1.4L10 5" />
  ),
  alert: (
    <>
      <path d="M8 2.2l6 10.6H2z" />
      <path d="M8 6.5v3M8 11.3v.1" />
    </>
  ),
  "shield-alert": (
    <>
      <path d="M8 1.8l5 1.9v3.9c0 3-2.2 5-5 6.6-2.8-1.6-5-3.6-5-6.6V3.7z" />
      <path d="M8 5.8v2.6M8 10.2v.1" />
    </>
  ),
  "shield-check": (
    <>
      <path d="M8 1.8l5 1.9v3.9c0 3-2.2 5-5 6.6-2.8-1.6-5-3.6-5-6.6V3.7z" />
      <path d="M5.8 8l1.6 1.6L10.3 6.6" />
    </>
  ),
  send: <path d="M3 8h9M8.5 4.2L12.3 8l-3.8 3.8" />,
  reply: (
    <>
      <path d="M6.5 3.5L2.5 7.5l4 4" />
      <path d="M2.5 7.5h6a4.5 4.5 0 0 1 4.5 4.5v.5" />
    </>
  ),
  chevron: <path d="M6 3.5L10.5 8 6 12.5" />,
  "x-circle": (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
    </>
  ),
  "minus-circle": (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 8h5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  refresh: (
    <>
      <path d="M13 8a5 5 0 0 1-9 3M3 8a5 5 0 0 1 9-3" />
      <path d="M12.5 2v3h-3M3.5 14v-3h3" />
    </>
  ),
  download: <path d="M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2M3 13h10" />,
  cloud: <path d="M4.5 12.5a3 3 0 0 1-.4-6A4.2 4.2 0 0 1 12.3 7a2.8 2.8 0 0 1-.3 5.5z" />,
  file: (
    <>
      <path d="M4 1.8h5l3 3v8.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z" />
      <path d="M9 1.8v3h3" />
    </>
  ),
  pencil: <path d="M10.5 3l2.5 2.5-7.5 7.5H3v-2.5z" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  "chevrons-up-down": <path d="M5.5 6L8 3.5 10.5 6M5.5 10L8 12.5 10.5 10" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.5 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5" />
    </>
  ),
  eye: (
    <>
      <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  small?: boolean;
}

export function Icon({ name, small = false, className = "", ...rest }: IconProps) {
  const size = small ? "size-3.5" : "size-4";
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`${size} flex-none ${className}`}
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}

export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={`size-[18px] flex-none ${className}`}>
      <circle cx="32" cy="13" r="5" className="fill-ink" />
      <rect x="27" y="24" width="10" height="14" rx="2" className="fill-ink" />
      <path
        d="M8 34h10l5 10h18l5-10h10v16a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6Z"
        className="fill-accent"
      />
    </svg>
  );
}
