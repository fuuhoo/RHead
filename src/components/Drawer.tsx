import { useEffect } from "react";

// Shared slide-in drawer with backdrop, Esc-to-close and animation.
export default function Drawer({
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
    <>
      <div className="overlay-backdrop" onClick={onClose} />
      <aside className="drawer" style={width ? { width: `min(${width}px, 90vw)` } : undefined}>
        <div className="drawer-head">
          <span className="drawer-title">{title}</span>
          <button className="btn btn-xs drawer-close" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}
