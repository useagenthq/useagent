"use client";

// Vendored from prompt-kit (prompt-kit.com/c/message.json), adapted to AlignUI:
// the shadcn `Avatar`/`Tooltip` dependencies are dropped (the session surface
// supplies its own AsteriskMark avatar and needs no tooltips), `cn` → `cnExt`,
// and shadcn tokens (`text-foreground`/`bg-secondary`/`text-muted-foreground`)
// → AlignUI semantic tokens.

import { cnExt as cn } from "@/utils/cn";
import { Markdown } from "./markdown";

export type MessageProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

const Message = ({ children, className, ...props }: MessageProps) => (
  <div className={cn("flex gap-3", className)} {...props}>
    {children}
  </div>
);

export type MessageAvatarProps = {
  children: React.ReactNode;
  className?: string;
};

const MessageAvatar = ({ children, className }: MessageAvatarProps) => (
  <div
    className={cn(
      "bg-background-secondary-default text-text-primary flex size-8 shrink-0 items-center justify-center rounded-full",
      className,
    )}
  >
    {children}
  </div>
);

export type MessageContentProps = {
  children: React.ReactNode;
  markdown?: boolean;
  className?: string;
} & Omit<React.ComponentProps<typeof Markdown>, "children"> &
  React.HTMLProps<HTMLDivElement>;

const MessageContent = ({
  children,
  markdown = false,
  className,
  ...props
}: MessageContentProps) => {
  const classNames = cn(
    "text-text-primary break-words whitespace-normal",
    className,
  );

  return markdown ? (
    <Markdown className={classNames} {...props}>
      {children as string}
    </Markdown>
  ) : (
    <div className={classNames} {...props}>
      {children}
    </div>
  );
};

export type MessageActionsProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

const MessageActions = ({ children, className, ...props }: MessageActionsProps) => (
  <div
    className={cn("text-text-tertiary flex items-center gap-1", className)}
    {...props}
  >
    {children}
  </div>
);

export { Message, MessageAvatar, MessageContent, MessageActions };
