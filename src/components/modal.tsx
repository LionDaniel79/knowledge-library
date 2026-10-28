"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
export function Modal({
  title,
  onClose,
  children,
  canClose = true,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  canClose?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [fullscreenHost] = useState(() =>
    typeof document === "undefined"
      ? null
      : document.querySelector<HTMLElement>(".wb-canvas-shell.wb-fullscreen"),
  );
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  function close() {
    if (!canClose) return;
    // Close while still mounted so the browser restores focus to the opener.
    ref.current?.close();
    onClose();
  }
  const dialog = (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="닫기"
          disabled={!canClose}
          onClick={close}
        >
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
  return fullscreenHost ? createPortal(dialog, fullscreenHost) : dialog;
}
