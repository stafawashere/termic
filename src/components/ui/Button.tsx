import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const button = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-[6px] whitespace-nowrap font-medium transition-[color,background-color] duration-[120ms] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "ui-btn-primary font-semibold",
        secondary: "ui-btn-secondary",
        ghost: "text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--sidebar-ink-strong)]",
        // Lit for as long as the menu or popover it opened is up. Keyed on
        // aria-expanded, which only the menu sets: these triggers usually sit
        // inside a Tip, and a tooltip trigger writes data-state as well.
        icon: "text-[var(--sidebar-icon)] hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--sidebar-btn-hover-ink)] aria-expanded:bg-[var(--sidebar-row-hover)] aria-expanded:text-[var(--sidebar-btn-hover-ink)]",
        danger: "bg-[var(--color-err)]/15 text-[var(--color-err)] border border-[var(--color-err)]/30 hover:bg-[var(--color-err)]/25",
      },
      size: {
        sm: "h-7 px-2.5 text-[13.5px]",
        md: "h-8 px-3 text-[14px]",
        lg: "h-9 px-4 text-[13px]",
        icon: "h-7 w-7 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, BtnProps>(
  ({ className, variant, size, type = "button", ...rest }, ref) =>
    <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...rest} />,
);
Button.displayName = "Button";
