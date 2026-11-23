import { useEffect } from "react";

// Shared centered modal with backdrop, Esc-to-close and animation.
export default function Modal({
  title,
  onClose,
  children,
  width,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={width ? { width } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span className="drawer-title">{title}</span>
          <button className="btn btn-xs drawer-close" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
