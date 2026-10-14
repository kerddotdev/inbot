import { useEffect, useId, useRef, type ReactNode } from "react";

interface DialogProps {
  title: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}

export function Dialog({ title, onClose, busy = false, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) event.currentTarget.close();
      }}
      className="mx-auto mt-11 max-h-[calc(100dvh-88px)] w-[500px] max-w-[calc(100vw-32px)] animate-rise overflow-y-auto rounded-[14px] bg-win p-0 text-ink shadow-sheet backdrop:animate-fade backdrop:bg-scrim"
    >
      <div className="px-7 py-[26px]">
        <h2 id={titleId} className="mb-[18px] text-[22px] font-semibold tracking-[-0.015em]">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
