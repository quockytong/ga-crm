import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/client/lib/cn";

// The DLVN source screen has no buttons; these follow its language: 6px radius (search bar),
// Daiichi blue as the one accent, outlined with a 1px inset ring instead of shadows.
const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "bg-card text-nav shadow-ring hover:bg-blue-10",
  ghost: "text-nav hover:bg-blue-10",
  destructive: "bg-card text-destructive shadow-[inset_0_0_0_1px_var(--accent-alert)] hover:bg-destructive/5",
};
const sizes = {
  default: "h-11 px-4 text-sm",
  sm: "h-9 px-3 text-sm",
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
};

export function Button({ className, variant = "default", size = "default", type = "button", ...props }: Props) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
