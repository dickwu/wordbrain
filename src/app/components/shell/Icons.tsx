/**
 * Editorial line icons — 1.5px stroke, 16px viewBox.
 * Ported from `wordbrain-handoff/project/src/icons.jsx`.
 */
import type { CSSProperties, SVGProps } from 'react';

type IconProps = {
  size?: number;
  stroke?: string;
  fill?: string;
  sw?: number;
  style?: CSSProperties;
  className?: string;
} & Omit<SVGProps<SVGSVGElement>, 'fill' | 'stroke'>;

function Base({
  size = 16,
  fill = 'none',
  stroke = 'currentColor',
  sw = 1.5,
  style,
  className,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={fill}
      stroke={stroke}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  Library: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 2h4v12H3z" />
      <path d="M7 2h4v12H7z" />
      <path d="M11 3l3 .5-1.5 11L9.5 14" />
    </Base>
  ),
  Reader: (p: IconProps) => (
    <Base {...p}>
      <path d="M2 3h5a2 2 0 0 1 2 2v9a1 1 0 0 0-1-1H2zM14 3H9a2 2 0 0 0-2 2v9a1 1 0 0 1 1-1h6z" />
    </Base>
  ),
  Review: (p: IconProps) => (
    <Base {...p}>
      <path d="M9 2L4 9h4l-1 5 5-7H8z" />
    </Base>
  ),
  Story: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 2h7l3 3v9H3z" />
      <path d="M10 2v3h3" />
      <path d="M5 8h6M5 11h4" />
    </Base>
  ),
  Writing: (p: IconProps) => (
    <Base {...p}>
      <path d="M2 12.5L2 14h1.5L13 4.5 11.5 3z" />
      <path d="M10 4.5l1.5 1.5" />
    </Base>
  ),
  Words: (p: IconProps) => (
    <Base {...p}>
      <path d="M2 4h12M2 8h12M2 12h8" />
    </Base>
  ),
  Network: (p: IconProps) => (
    <Base {...p}>
      <circle cx="3" cy="3" r="1.5" />
      <circle cx="13" cy="4" r="1.5" />
      <circle cx="8" cy="9" r="1.5" />
      <circle cx="3" cy="13" r="1.5" />
      <circle cx="13" cy="13" r="1.5" />
      <path d="M4 4l3 4M12 5L9 8M4 12l3-2M12 12L9 10" />
    </Base>
  ),
  Search: (p: IconProps) => (
    <Base {...p}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </Base>
  ),
  Settings: (p: IconProps) => (
    <Base {...p}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" />
    </Base>
  ),
  Plus: (p: IconProps) => (
    <Base {...p}>
      <path d="M8 3v10M3 8h10" />
    </Base>
  ),
  Sun: (p: IconProps) => (
    <Base {...p}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" />
    </Base>
  ),
  Moon: (p: IconProps) => (
    <Base {...p}>
      <path d="M12 9.5A5 5 0 0 1 6.5 4a5.5 5.5 0 1 0 5.5 5.5z" />
    </Base>
  ),
  Check: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 8.5L6 11.5 13 4.5" />
    </Base>
  ),
  X: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 3l10 10M13 3L3 13" />
    </Base>
  ),
  ChevR: (p: IconProps) => (
    <Base {...p}>
      <path d="M6 3l5 5-5 5" />
    </Base>
  ),
  ChevD: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 6l5 5 5-5" />
    </Base>
  ),
  Bolt: (p: IconProps) => (
    <Base {...p}>
      <path d="M9 2L4 9h4l-1 5 5-7H8z" />
    </Base>
  ),
  Clock: (p: IconProps) => (
    <Base {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 2" />
    </Base>
  ),
  Book: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v10a1 1 0 0 0-1-1H4a1 1 0 0 1-1-1zM3 13a1 1 0 0 0 1 1h9" />
    </Base>
  ),
  Up: (p: IconProps) => (
    <Base {...p}>
      <path d="M8 13V3M3 8l5-5 5 5" />
    </Base>
  ),
  Down: (p: IconProps) => (
    <Base {...p}>
      <path d="M8 3v10M3 8l5 5 5-5" />
    </Base>
  ),
  Filter: (p: IconProps) => (
    <Base {...p}>
      <path d="M2 3h12l-4.5 6v4l-3 1V9z" />
    </Base>
  ),
  Sound: (p: IconProps) => (
    <Base {...p}>
      <path d="M8 4L5 6H2v4h3l3 2zM11 6a3 3 0 0 1 0 4M13 4a6 6 0 0 1 0 8" />
    </Base>
  ),
  History: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 8a5 5 0 1 1 1.5 3.5" />
      <path d="M3 4v3h3" />
      <path d="M8 5v3l2 2" />
    </Base>
  ),
  Sparkle: (p: IconProps) => (
    <Base {...p}>
      <path d="M8 2v4M8 10v4M2 8h4M10 8h4M5 5l1.5 1.5M9.5 9.5L11 11M5 11l1.5-1.5M9.5 6.5L11 5" />
    </Base>
  ),
  Page: (p: IconProps) => (
    <Base {...p}>
      <path d="M4 2h6l3 3v9H4z" />
      <path d="M10 2v3h3" />
    </Base>
  ),
  Undo: (p: IconProps) => (
    <Base {...p}>
      <path d="M3 6h7a3 3 0 0 1 0 6H6" />
      <path d="M3 6l3-3M3 6l3 3" />
    </Base>
  ),
};
