"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function NavigationDrawer({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current,
      trigger = document.activeElement as HTMLElement | null;
    d?.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      d?.close();
      document.body.style.overflow = old;
      trigger?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="nav-drawer"
      aria-label="서재 메뉴"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="sidebar">
        <button
          className="icon-button drawer-close"
          aria-label="메뉴 닫기"
          onClick={onClose}
        >
          <X size={22} />
        </button>
        {children}
      </aside>
    </dialog>
  );
}
