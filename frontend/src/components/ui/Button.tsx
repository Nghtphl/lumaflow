import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "../../lib/cn";
import { VARIANTS, buttonStyles } from "./buttonStyles";
import type { Size, Variant } from "./buttonStyles";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  block?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  iconRight,
  block = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonStyles({ variant, size, block, className })}
      {...rest}
    >
      {loading ? (
        <LoaderCircle
          className="size-4 shrink-0 animate-spin"
          strokeWidth={2.25}
          aria-hidden="true"
        />
      ) : (
        icon
      )}
      {children}
      {!loading && iconRight}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: Size;
  variant?: Variant;
}

/** Square affordance for toolbar actions — always labelled for screen readers. */
export function IconButton({
  label,
  size = "md",
  variant = "ghost",
  className,
  children,
  type = "button",
  ...rest
}: IconButtonProps) {
  const box =
    size === "sm" ? "size-8 rounded-sm" : size === "lg" ? "size-12 rounded-md" : "size-10 rounded-md";
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "pressable grid shrink-0 place-items-center",
        "disabled:pointer-events-none disabled:opacity-50",
        box,
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
