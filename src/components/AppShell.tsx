"use client";
import { BarChart3, CreditCard, Home, Menu, MoreHorizontal, Receipt, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { CommandPalette } from "./CommandPalette";
import { ALL_ITEMS, NAV } from "./nav";

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 px-2 py-1">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <g stroke="#ff4d1c" strokeWidth="3" strokeLinecap="round"><path d="M16 4v7M16 21v7M4 16h7M21 16h7M7.5 7.5l5 5M19.5 19.5l5 5M24.5 7.5l-5 5M12.5 19.5l-5 5" /></g>
      </svg>
      <span className="num text-[19px] font-semibold">UzFinance</span>
    </Link>
  );
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav aria-label="Principal" className="flex flex-col gap-5">
      {NAV.map((s) => (
        <div key={s.section}>
          <p className="mb-1.5 px-3 text-[10px] tracking-wider text-faint">{s.section}</p>
          <ul className="flex flex-col gap-0.5">
            {s.items.map(({ href, label, icon: Icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active(href) ? "page" : undefined}
                  className={`flex items-center gap-2.5 rounded-xl px-3 py-2 transition-colors ${active(href) ? "bg-accent/90 text-white shadow-[0_6px_18px_-8px_rgb(255_77_28/0.8)]" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
                >
                  <Icon size={15} aria-hidden />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

const TABS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Inicio", icon: Home },
  { href: "/transacciones", label: "Gastos", icon: Receipt },
  { href: "/analitica", label: "Analítica", icon: BarChart3 },
  { href: "/tarjetas", label: "Tarjetas", icon: CreditCard },
];

/** Barra inferior para el celular: lo más usado a un pulgar de distancia. */
function BottomNav({ onMore }: { onMore: () => void }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const item = "flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors";
  return (
    <nav aria-label="Navegación rápida" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 backdrop-blur-xl lg:hidden" data-testid="bottom-nav">
      <ul className="mx-auto flex max-w-[520px] items-stretch px-1">
        {TABS.map(({ href, label, icon: Icon }) => (
          <li key={href} className="flex flex-1">
            <Link href={href} aria-current={active(href) ? "page" : undefined} className={`${item} ${active(href) ? "text-accent-2" : "text-muted"}`}>
              <Icon size={20} aria-hidden />
              {label}
            </Link>
          </li>
        ))}
        <li className="flex flex-1">
          <button type="button" onClick={onMore} className={`${item} text-muted`} aria-label="Más opciones">
            <MoreHorizontal size={20} aria-hidden />
            Más
          </button>
        </li>
      </ul>
    </nav>
  );
}

export function AppShell({ children, userEmail }: { children: ReactNode; userEmail: string }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const current = ALL_ITEMS.find((i) => (i.href === "/" ? path === "/" : path.startsWith(i.href)));

  return (
    <div className="flex min-h-dvh">
      {/* Sidebar escritorio */}
      <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col justify-between border-r border-line bg-black/30 p-4 backdrop-blur lg:flex">
        <div className="flex flex-col gap-7">
          <Logo />
          <SideNav />
        </div>
        <p className="truncate px-3 text-[11px] text-faint" title={userEmail}>{userEmail}</p>
      </aside>

      {/* Drawer móvil */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menú">
          <button className="absolute inset-0 bg-black/70" aria-label="Cerrar menú" onClick={() => setOpen(false)} />
          <div className="glass absolute inset-y-0 left-0 flex w-[260px] flex-col gap-7 rounded-l-none p-4">
            <Logo />
            <SideNav onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-bg/70 px-4 py-3 backdrop-blur-xl sm:px-6">
          <button className="btn !h-9 !w-9 !p-0 lg:hidden" onClick={() => setOpen(true)} aria-label="Abrir menú">
            <Menu size={16} />
          </button>
          <p className="hidden text-muted sm:block">
            Dashboard / <span className="text-fg">{current?.label ?? ""}</span>
          </p>
          <div className="ml-auto w-full max-w-[420px] sm:mx-auto sm:ml-0 sm:flex-1">
            <CommandPalette />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1280px] px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 lg:pb-5">{children}</main>
      </div>
      <BottomNav onMore={() => setOpen(true)} />
    </div>
  );
}
