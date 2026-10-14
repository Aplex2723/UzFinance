import { Activity, BarChart3, Bell, CalendarClock, CreditCard, FileText, FileUp, Home, Receipt, Repeat, Settings, Tags, Target, type LucideIcon } from "lucide-react";

/** Insignias numéricas por ruta (documentos por revisar, alertas sin leer). */
export type NavBadges = Partial<Record<string, number>>;
export type NavItem = { href: string; label: string; icon: LucideIcon };
export const NAV: { section: string; items: NavItem[] }[] = [
  { section: "GENERAL", items: [{ href: "/", label: "Inicio", icon: Home }, { href: "/transacciones", label: "Transacciones", icon: Receipt }, { href: "/metas", label: "Metas", icon: Target }, { href: "/alertas", label: "Alertas", icon: Bell }] },
  { section: "HERRAMIENTAS", items: [{ href: "/tarjetas", label: "Tarjetas", icon: CreditCard }, { href: "/categorias", label: "Categorías", icon: Tags }, { href: "/recurrentes", label: "Recurrentes", icon: Repeat }, { href: "/documentos", label: "Documentos", icon: FileUp }] },
  { section: "INSIGHTS", items: [{ href: "/actividad", label: "Actividad", icon: Activity }, { href: "/analitica", label: "Analítica", icon: BarChart3 }, { href: "/msi", label: "Meses sin intereses", icon: CalendarClock }, { href: "/reportes", label: "Reportes", icon: FileText }] },
  { section: "OTROS", items: [{ href: "/configuracion", label: "Configuración", icon: Settings }] },
];
export const ALL_ITEMS = NAV.flatMap((s) => s.items);
