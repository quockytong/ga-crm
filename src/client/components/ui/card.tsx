import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/client/lib/cn";

/** Outlined, never elevated: 10px radius and a 1px inset ring (DLVN ContractCard). */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg bg-card p-4 shadow-ring sm:p-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-base font-semibold text-nav", className)} {...props} />;
}

/**
 * Page title as the DLVN SectionHeading: a 4x24 Daiichi-blue bar and a 22px all-caps eyebrow.
 */
export function PageTitle({ children, actions, className, caps = true }: { children: ReactNode; actions?: ReactNode; className?: string; caps?: boolean }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <h1 className="flex items-center gap-3">
        <span aria-hidden className="h-6 w-1 shrink-0 bg-primary" />
        <span className={cn("text-[22px] leading-tight font-medium text-eyebrow", caps && "uppercase")}>{children}</span>
      </h1>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** DLVN FilterChip: 16px bold label; the chosen tab gets blue text and a blue bottom stroke only. Counts go in the label. */
export function FilterTab({ active, className, ...props }: HTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "-mb-px h-[35px] shrink-0 cursor-pointer border-b-2 px-[11.4px] text-base leading-7 font-bold whitespace-nowrap",
        active ? "border-blue-100 text-link" : "border-transparent text-muted-foreground hover:text-nav",
        className,
      )}
      {...props}
    />
  );
}

// Blue-forward: states are told apart by tint and text, the one red is for alerts.
const tones = {
  neutral: "bg-border text-nav",
  primary: "bg-primary text-primary-foreground",
  success: "bg-blue-20 text-success",
  warning: "bg-blue-10 text-link shadow-[inset_0_0_0_1px_var(--brand-blue-60)]",
  destructive: "bg-destructive/10 text-destructive",
};

/** Pill badge (DLVN Badge shape: full radius, 12.8px text). */
export function Badge({ className, tone = "neutral", ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-[12.833px] leading-tight font-medium whitespace-nowrap", tones[tone], className)}
      {...props}
    />
  );
}

export function ErrorText({ children }: { children?: string | null }) {
  return children ? (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  ) : null;
}
