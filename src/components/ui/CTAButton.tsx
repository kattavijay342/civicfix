import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "lg";

interface BaseProps {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

interface LinkCTAProps extends BaseProps {
  href: string;
}

interface ButtonCTAProps
  extends BaseProps,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  href?: undefined;
}

type CTAButtonProps = LinkCTAProps | ButtonCTAProps;

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-civic-600 text-white shadow-sm hover:bg-civic-700 hover:shadow-md active:bg-civic-800",
  secondary:
    "bg-white text-foreground border border-border hover:border-civic-300 hover:bg-civic-50",
  ghost: "text-foreground-muted hover:text-foreground hover:bg-surface-muted",
};

const sizeClasses: Record<Size, string> = {
  md: "px-5 py-2.5 text-sm gap-2",
  lg: "px-7 py-3.5 text-base gap-2.5",
};

const shared =
  "inline-flex items-center justify-center rounded-full font-medium transition-all duration-200 ease-out cursor-pointer disabled:opacity-50 disabled:pointer-events-none";

export function CTAButton(props: CTAButtonProps) {
  const { variant = "primary", size = "md", icon, className, children } = props;
  const classes = cn(shared, variantClasses[variant], sizeClasses[size], className);

  if ("href" in props && props.href) {
    return (
      <Link href={props.href} className={classes}>
        {children}
        {icon}
      </Link>
    );
  }

  const { href: _href, ...buttonProps } = props as ButtonCTAProps;
  void _href;

  return (
    <button className={classes} {...buttonProps}>
      {children}
      {icon}
    </button>
  );
}
