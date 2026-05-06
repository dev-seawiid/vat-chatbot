"use client";

import {
  CircleCheck,
  Info,
  LoaderCircle,
  OctagonX,
  TriangleAlert,
} from "lucide-react";
import { Toaster as Sonner } from "sonner";

import { cn } from "@/shared/lib/utils";

type ToasterProps = React.ComponentProps<typeof Sonner>;

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: <CircleCheck className="h-4 w-4 text-yellow" />,
        info: <Info className="h-4 w-4 text-fg" />,
        warning: <TriangleAlert className="h-4 w-4 text-yellow" />,
        error: <OctagonX className="h-4 w-4 text-vermilion" />,
        loading: <LoaderCircle className="h-4 w-4 animate-spin text-fg-soft" />,
      }}
      toastOptions={{
        classNames: {
          toast: cn(
            "group toast border border-white/10 bg-surface-1 text-fg",
            "shadow-[0_8px_24px_-8px_rgb(0_0_0/0.6)] rounded-none",
            "backdrop-blur-md",
          ),
          title: "font-display text-[16px] tracking-[-0.005em] text-fg",
          description: "font-mono text-[11px] tracking-[0.05em] text-fg-soft",
          icon: "self-start mt-0.5",
          error: "border-l-[3px] border-l-vermilion",
          success: "border-l-[3px] border-l-yellow",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
