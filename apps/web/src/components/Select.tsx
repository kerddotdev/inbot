import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../icons";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface SelectProps<T extends string> {
  label: string;
  options: readonly SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  labelClassName?: string;
}

export function Select<T extends string>({
  label,
  options,
  value,
  onChange,
  className = "",
  labelClassName = "font-medium",
}: SelectProps<T>) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [active, setActive] = useState(selectedIndex);
  const current = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    setActive(selectedIndex);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    button.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = options.length - 1;
    const move = (index: number) => {
      event.preventDefault();
      if (open) setActive(Math.min(last, Math.max(0, index)));
      else show();
    };
    switch (event.key) {
      case "ArrowDown":
        return move(active + 1);
      case "ArrowUp":
        return move(active - 1);
      case "Home":
        return move(0);
      case "End":
        return move(last);
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) choose(active);
        else show();
        return;
      case "Escape":
        if (!open) return;
        event.preventDefault();
        setOpen(false);
        return;
      case "Tab":
        setOpen(false);
        return;
      default:
        if (event.key.length !== 1) return;
        {
          const key = event.key.toLowerCase();
          const start = open ? active + 1 : selectedIndex + 1;
          const ordered = [...options.slice(start), ...options.slice(0, start)];
          const match = ordered.find((option) => option.label.toLowerCase().startsWith(key));
          if (!match) return;
          const index = options.indexOf(match);
          if (open) setActive(index);
          else onChange(match.value);
        }
    }
  };

  return (
    <div ref={root} className={`relative ${className}`}>
      <span id={`${id}-label`} className={`mb-1.5 block ${labelClassName}`}>
        {label}
      </span>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        className="flex w-full items-center gap-2 rounded-[7px] border border-line bg-list py-2 pr-2 pl-2.5 text-left transition-colors duration-150 hover:border-ink2 aria-expanded:border-ink2"
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label}</span>
        <Icon name="chevrons-up-down" small className="flex-none text-ink2" />
      </button>
      {open ? (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-labelledby={`${id}-label`}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 min-w-max origin-top animate-pop overflow-y-auto rounded-[9px] bg-menu p-1 shadow-sheet"
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${id}-${index}`}
              data-index={index}
              role="option"
              aria-selected={option.value === value}
              className={`flex cursor-pointer items-center gap-2 rounded-[6px] py-1.5 pr-3 pl-2 ${index === active ? "bg-hover" : ""}`}
              onPointerMove={() => setActive(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <Icon
                name="check"
                small
                className={`flex-none text-accent ${option.value === value ? "" : "invisible"}`}
              />
              <span className="truncate">{option.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
