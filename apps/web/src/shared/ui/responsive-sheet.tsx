"use client";

import * as React from "react";

import { useMediaQuery } from "@/shared/hooks/use-media-query";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/shared/ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";

/**
 * 데스크톱(md↑) → 우측 Sheet, 모바일 → 하단 Drawer로 자동 분기.
 * Compound API. 자식들은 Context의 isDesktop을 읽어 Sheet/Drawer로 라우팅.
 */

type Ctx = { isDesktop: boolean };
const ResponsiveSheetContext = React.createContext<Ctx | null>(null);

function useResponsiveSheetCtx(component: string): Ctx {
  const ctx = React.useContext(ResponsiveSheetContext);
  if (!ctx) {
    throw new Error(`<${component}> must be used inside <ResponsiveSheet>`);
  }
  return ctx;
}

type ResponsiveSheetProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
};

function ResponsiveSheet({
  open,
  onOpenChange,
  children,
}: ResponsiveSheetProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const Root = isDesktop ? Sheet : Drawer;

  return (
    <ResponsiveSheetContext.Provider value={{ isDesktop }}>
      <Root open={open} onOpenChange={onOpenChange}>
        {children}
      </Root>
    </ResponsiveSheetContext.Provider>
  );
}

type ContentProps = React.HTMLAttributes<HTMLDivElement> & {
  children: React.ReactNode;
};

function ResponsiveSheetContent({
  className,
  children,
  ...props
}: ContentProps) {
  const { isDesktop } = useResponsiveSheetCtx("ResponsiveSheetContent");
  if (isDesktop) {
    return (
      <SheetContent side="right" className={className} {...props}>
        {children}
      </SheetContent>
    );
  }
  return (
    <DrawerContent className={className} {...props}>
      {children}
    </DrawerContent>
  );
}

function ResponsiveSheetHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { isDesktop } = useResponsiveSheetCtx("ResponsiveSheetHeader");
  const Comp = isDesktop ? SheetHeader : DrawerHeader;
  return <Comp className={className} {...props} />;
}

function ResponsiveSheetFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { isDesktop } = useResponsiveSheetCtx("ResponsiveSheetFooter");
  const Comp = isDesktop ? SheetFooter : DrawerFooter;
  return <Comp className={className} {...props} />;
}

type TitleProps = React.ComponentPropsWithoutRef<typeof SheetTitle>;

const ResponsiveSheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetTitle>,
  TitleProps
>((props, ref) => {
  const { isDesktop } = useResponsiveSheetCtx("ResponsiveSheetTitle");
  const Comp = isDesktop ? SheetTitle : DrawerTitle;
  return <Comp ref={ref} {...props} />;
});
ResponsiveSheetTitle.displayName = "ResponsiveSheetTitle";

type DescriptionProps = React.ComponentPropsWithoutRef<typeof SheetDescription>;

const ResponsiveSheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetDescription>,
  DescriptionProps
>((props, ref) => {
  const { isDesktop } = useResponsiveSheetCtx("ResponsiveSheetDescription");
  const Comp = isDesktop ? SheetDescription : DrawerDescription;
  return <Comp ref={ref} {...props} />;
});
ResponsiveSheetDescription.displayName = "ResponsiveSheetDescription";

export {
  ResponsiveSheet,
  ResponsiveSheetContent,
  ResponsiveSheetHeader,
  ResponsiveSheetFooter,
  ResponsiveSheetTitle,
  ResponsiveSheetDescription,
};
