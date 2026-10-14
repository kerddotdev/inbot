import { useState, type InputHTMLAttributes } from "react";
import { IconButton, inputClasses } from "./ui";

export function SecretInput({
  className = "",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <input
        {...rest}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        className={`${inputClasses} min-w-0 flex-1 font-mono ${className}`}
      />
      <IconButton
        icon={shown ? "eye-off" : "eye"}
        label={shown ? "Hide value" : "Show value"}
        aria-pressed={shown}
        onClick={() => setShown((value) => !value)}
      />
    </div>
  );
}
