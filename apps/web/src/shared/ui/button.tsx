import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

const buttonVariants = cva(
  cn(
    "group relative inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "font-mono text-[11px] font-medium uppercase tracking-[0.18em]",
    "transition-[background-color,color,transform,box-shadow,border-color] duration-200 ease-out",
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-yellow focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
    "disabled:pointer-events-none disabled:opacity-40",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ),
  {
    variants: {
      variant: {
        primary: cn(
          "bg-yellow text-bg",
          "shadow-[0_0_0_1px_var(--yellow),0_0_28px_-4px_rgb(255_230_0/0.45)]",
          "hover:bg-yellow-soft hover:shadow-[0_0_0_1px_var(--yellow),0_0_36px_0_rgb(255_230_0/0.6)]",
          "active:translate-y-[1px]",
        ),
        ghost: cn(
          "border border-white/10 bg-surface-1/40 text-fg backdrop-blur",
          "hover:border-yellow/40 hover:bg-surface-2 hover:text-fg",
          "active:translate-y-[1px]",
        ),
        outline: cn(
          "border border-yellow/30 bg-transparent text-yellow",
          "hover:bg-yellow hover:text-bg",
          "active:translate-y-[1px]",
        ),
        link: cn(
          "text-fg-soft underline underline-offset-[6px] decoration-fg-muted/40",
          "hover:text-fg hover:decoration-yellow",
        ),
        destructive: cn(
          "bg-vermilion text-fg",
          "hover:opacity-90",
          "active:translate-y-[1px]",
        ),
      },
      size: {
        sm: "h-8 px-3.5",
        md: "h-10 px-5",
        lg: "h-12 px-7 text-[12px]",
        icon: "h-10 w-10 px-0",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
