import { useId, type ReactNode } from "react";
import { resolveArt } from "@/lib/card-art";
import type { Card, CardArtId } from "@/lib/types";

type ArtCard = Pick<Card, "name" | "issuer" | "last4" | "color" | "art">;

/** Dos círculos de red de pago (estilizados, sin usar el logotipo oficial). */
function Network({ x, y }: { x: number; y: number }) {
  return (
    <g aria-hidden>
      <circle cx={x} cy={y} r="13" fill="#eb001b" fillOpacity=".92" />
      <circle cx={x + 17} cy={y} r="13" fill="#f79e1b" fillOpacity=".92" />
      <path d={`M${x + 8.5} ${y - 11.2}a13 13 0 0 1 0 22.4a13 13 0 0 1 0 -22.4z`} fill="#ff5f00" fillOpacity=".95" />
    </g>
  );
}

const Chip = ({ x = 26, y = 66, dark = false }: { x?: number; y?: number; dark?: boolean }) => (
  <g aria-hidden>
    <rect x={x} y={y} width="36" height="27" rx="5" fill={dark ? "#3b3d42" : "#e9c46a"} />
    <path d={`M${x} ${y + 9}h36M${x} ${y + 18}h36M${x + 12} ${y}v27M${x + 24} ${y}v27`} stroke={dark ? "#14151a" : "#a67c1d"} strokeOpacity=".55" strokeWidth="1" fill="none" />
  </g>
);

function Background({ art, color, id }: { art: CardArtId; color: string; id: string }): ReactNode {
  switch (art) {
    case "amex-platinum":
      return (
        <>
          <defs>
            <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#f4f5f7" /><stop offset=".35" stopColor="#b9bec6" /><stop offset=".6" stopColor="#e3e5e9" /><stop offset="1" stopColor="#8d939c" />
            </linearGradient>
          </defs>
          <rect width="320" height="202" fill={`url(#${id}g)`} />
          <g stroke="#fff" strokeOpacity=".35" strokeWidth="1" fill="none">
            {Array.from({ length: 9 }, (_, i) => <path key={i} d={`M-20 ${40 + i * 22}C90 ${i * 12} 210 ${150 + i * 6} 340 ${20 + i * 20}`} />)}
          </g>
          <rect x="258" y="16" width="48" height="42" rx="4" fill="#1f6fb5" />
          <text x="282" y="34" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">AMERICAN</text>
          <text x="282" y="45" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">EXPRESS</text>
          <Chip dark />
        </>
      );
    case "banamex-explora":
      return (
        <>
          <defs>
            <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#0f2547" /><stop offset=".6" stopColor="#0a1530" /><stop offset="1" stopColor="#050912" /></linearGradient>
            <radialGradient id={`${id}r`} cx=".85" cy=".1" r=".7"><stop offset="0" stopColor="#3b82f6" stopOpacity=".5" /><stop offset="1" stopColor="#3b82f6" stopOpacity="0" /></radialGradient>
          </defs>
          <rect width="320" height="202" fill={`url(#${id}g)`} />
          <rect width="320" height="202" fill={`url(#${id}r)`} />
          {/* rosa de los vientos / curvas de nivel */}
          <g stroke="#7aa7ff" strokeOpacity=".22" fill="none" strokeWidth="1">
            {[26, 44, 62, 80].map((r) => <circle key={r} cx="248" cy="108" r={r} />)}
            <path d="M248 20v176M160 108h176M186 46l124 124M310 46L186 170" />
          </g>
          <path d="M248 84l8 24l-8 24l-8-24z" fill="#ef4444" fillOpacity=".9" />
          <text x="26" y="40" fontSize="15" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif" letterSpacing="1">banamex</text>
          <Chip />
          <Network x={252} y={34} />
        </>
      );
    case "banamex-clasica":
      return (
        <>
          <defs><linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f0343f" /><stop offset=".55" stopColor="#d4141f" /><stop offset="1" stopColor="#8e0a14" /></linearGradient></defs>
          <rect width="320" height="202" fill={`url(#${id}g)`} />
          <circle cx="290" cy="30" r="110" fill="#fff" fillOpacity=".07" />
          <circle cx="330" cy="150" r="90" fill="#000" fillOpacity=".12" />
          <text x="26" y="40" fontSize="15" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif" letterSpacing="1">banamex</text>
          <Chip />
        </>
      );
    case "banamex-costco":
      return (
        <>
          <defs>
            <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#13264a" /><stop offset=".55" stopColor="#0b1730" /><stop offset="1" stopColor="#060c1c" /></linearGradient>
          </defs>
          <rect width="320" height="202" fill={`url(#${id}g)`} />
          <g stroke="#6f93d6" strokeOpacity=".18" fill="none" strokeWidth="1">
            {Array.from({ length: 7 }, (_, i) => <path key={i} d={`M-10 ${60 + i * 24}C100 ${20 + i * 14} 220 ${170 + i * 8} 340 ${50 + i * 22}`} />)}
          </g>
          <rect x="302" y="14" width="3" height="22" fill="#e31837" />
          <text x="26" y="40" fontSize="15" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif" letterSpacing="1">banamex</text>
          <text x="292" y="44" textAnchor="end" fontSize="20" fontWeight="800" fontStyle="italic" fill="#fff" fontFamily="Arial, sans-serif" letterSpacing="1" fillOpacity=".92">VISA</text>
          <Chip />
        </>
      );
    case "banamex-debito":
      return (
        <>
          <defs><linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fafafa" /><stop offset="1" stopColor="#cfd2d8" /></linearGradient></defs>
          <rect width="320" height="202" fill={`url(#${id}g)`} />
          <path d="M0 140L320 90V202H0z" fill="#d4141f" />
          <path d="M0 160L320 118V202H0z" fill="#8e0a14" fillOpacity=".55" />
          <text x="26" y="40" fontSize="15" fontWeight="700" fill="#d4141f" fontFamily="Arial, sans-serif" letterSpacing="1">banamex</text>
          <text x="294" y="36" textAnchor="end" fontSize="10" fontWeight="700" fill="#555" fontFamily="Arial, sans-serif" letterSpacing="2">DÉBITO</text>
          <Chip />
        </>
      );
    case "nu":
      return (
        <>
          <defs><linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9b2fe0" /><stop offset=".5" stopColor="#820ad1" /><stop offset="1" stopColor="#4a0580" /></linearGradient></defs>
          <rect width="320" height="202" fill={`url(#${id}g)`} />
          <circle cx="40" cy="220" r="130" fill="#fff" fillOpacity=".07" />
          <circle cx="300" cy="-10" r="80" fill="#fff" fillOpacity=".06" />
          <text x="26" y="46" fontSize="34" fontWeight="800" fill="#fff" fontFamily="Arial, sans-serif">nu</text>
          <Network x={252} y={34} />
        </>
      );
    default:
      return (
        <>
          <defs><linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={color} /><stop offset="1" stopColor="#0b0b0d" /></linearGradient></defs>
          <rect width="320" height="202" fill={`url(#${id}g)`} />
          <circle cx="280" cy="40" r="100" fill="#fff" fillOpacity=".08" />
          <Chip />
        </>
      );
  }
}

const LIGHT: ReadonlySet<CardArtId> = new Set(["amex-platinum"]);

/** Diseños con la imagen real de la tarjeta (public/cards). Los demás se dibujan en SVG. */
export const PHOTO_ART: Partial<Record<CardArtId, string>> = {
  "amex-platinum": "/cards/amex-platinum.webp",
  "banamex-explora": "/cards/banamex-explora.webp",
  "banamex-costco": "/cards/banamex-costco.webp",
  nu: "/cards/nu.webp",
};

/**
 * Tarjeta ilustrada (foto real si existe, o SVG propio): se reconoce de un vistazo
 * por emisor/producto y muestra nombre y últimos dígitos encima.
 */
export function CardArt({ card, className = "", compact = false, bare = false }: { card: ArtCard; className?: string; compact?: boolean; /** Sin nombre ni dígitos encima (montones del tarjetero). */ bare?: boolean }) {
  const id = useId().replace(/:/g, "");
  const art = resolveArt(card);
  const photo = PHOTO_ART[art];
  const ink = !photo && LIGHT.has(art) ? "text-[#1c1d21]" : "text-white";
  return (
    <div className={`relative aspect-[1.586/1] w-full overflow-hidden rounded-[14px] shadow-[0_14px_30px_-14px_rgb(0_0_0/0.9),inset_0_0_0_1px_rgb(255_255_255/0.12)] ${className}`} data-art={art}>
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- imagen estática local ya optimizada (webp)
        <img src={photo} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
      ) : (
        <svg viewBox="0 0 320 202" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false">
          <Background art={art} color={card.color} id={id} />
        </svg>
      )}
      {!bare && (
        <div className={`absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-[5%] ${ink}`}>
          <p className={`min-w-0 truncate font-medium leading-tight ${photo ? "rounded-full bg-black/60 px-2 py-0.5 backdrop-blur-sm" : "drop-shadow-sm"} ${compact ? "text-[10px]" : "text-[12px]"}`}>{card.name}</p>
          {card.last4 && <p className={`num shrink-0 tracking-widest ${photo ? "rounded-full bg-black/60 px-2 py-0.5 backdrop-blur-sm" : ""} ${compact ? "text-[10px]" : "text-[12px]"}`}>•••• {card.last4}</p>}
        </div>
      )}
    </div>
  );
}
