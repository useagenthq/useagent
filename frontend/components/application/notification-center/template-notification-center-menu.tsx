"use client";

import { useRef, useState } from "react";
import {
  RiDownloadCloud2Line,
  RiGitPullRequestLine,
  RiNotificationLine,
  RiShieldCheckLine,
  RiUserAddLine,
} from "@remixicon/react";
import { Dialog, Popover } from "react-aria-components";
import {
  NotificationCenter,
  type NotificationCenterItem,
} from "@/components/application/notification-center/notification-center";
import { IconButton } from "@/components/base/buttons/icon-button";
import { cx } from "@/utils/cx";
import { useDismissOnOutsidePress } from "@/utils/use-dismiss-on-outside-press";

const TEMPLATE_NOTIFICATIONS: NotificationCenterItem[] = [
  {
    id: "mention-notes",
    category: "mentions",
    group: "Today",
    title: "Livia mentioned you",
    description: "Can you review the new empty state before we ship the dashboard?",
    timestamp: "2m",
    unread: true,
    avatar: { src: "/avatars/livia-saris.webp", alt: "Livia Saris" },
    actions: [
      { id: "reply", label: "Reply", variant: "primary" },
      { id: "view", label: "View thread", variant: "secondary" },
    ],
  },
  {
    id: "backup-ready",
    category: "system",
    group: "Today",
    title: "Workspace backup is ready",
    description: "The July 23 backup finished successfully and is ready to download.",
    timestamp: "18m",
    unread: true,
    status: "success",
    icon: RiDownloadCloud2Line,
    actions: [{ id: "download", label: "Download", variant: "secondary" }],
  },
  {
    id: "project-invite",
    category: "activity",
    group: "Today",
    title: "You joined Project Sea",
    description: "Maria added you as an editor. You now have access to all project files.",
    timestamp: "1h",
    unread: true,
    icon: RiUserAddLine,
    status: "information",
  },
  {
    id: "pull-request",
    category: "mentions",
    group: "Earlier this week",
    title: "Jaydon requested your review",
    description: "Pull request #284 updates the notification preferences flow.",
    timestamp: "Mon",
    unread: true,
    avatar: { src: "/avatars/jaydon-aminoff.webp", alt: "Jaydon Aminoff" },
    actions: [{ id: "review", label: "Review changes", variant: "secondary" }],
  },
  {
    id: "security-check",
    category: "system",
    group: "Earlier this week",
    title: "Security check completed",
    description: "No exposed credentials or vulnerable dependencies were found.",
    timestamp: "Sun",
    status: "success",
    icon: RiShieldCheckLine,
  },
  {
    id: "deploy-failed",
    category: "system",
    group: "Earlier this week",
    title: "Preview deployment failed",
    description: "The build stopped while validating the application routes.",
    timestamp: "Sat",
    unread: true,
    status: "error",
    icon: RiGitPullRequestLine,
    actions: [
      { id: "retry", label: "Retry", variant: "primary" },
      { id: "logs", label: "View logs", variant: "secondary" },
    ],
  },
];

export function TemplateNotificationCenterMenu({
  notifications = TEMPLATE_NOTIFICATIONS,
  unreadCount,
}: {
  notifications?: NotificationCenterItem[];
  unreadCount?: number;
} = {}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const visibleUnreadCount =
    unreadCount ?? notifications.filter((notification) => notification.unread).length;

  useDismissOnOutsidePress(isOpen, () => setIsOpen(false), [triggerRef, popoverRef]);

  return (
    <>
      <span className="group relative inline-flex">
        <IconButton
          ref={triggerRef}
          icon={RiNotificationLine}
          size="medium"
          aria-label="Notifications"
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          onClick={() => setIsOpen((open) => !open)}
        />
        {visibleUnreadCount > 0 && (
          <span className="pointer-events-none absolute top-0.5 left-[18px] flex size-4 items-center justify-center rounded-full border-[1.5px] border-background-primary-default bg-red-600 group-hover:border-0 group-active:border-0">
            <span className="w-4 text-center text-[10px] leading-4 font-bold text-white">
              {visibleUnreadCount}
            </span>
          </span>
        )}
      </span>
      <Popover
        ref={popoverRef}
        triggerRef={triggerRef}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        placement="bottom end"
        offset={8}
        isNonModal
        className={cx(
          "w-[430px] max-w-[calc(100vw-32px)] origin-top-right outline-none",
          "transition duration-150 ease-out",
          "data-[entering]:scale-95 data-[entering]:opacity-0 data-[entering]:blur-[2px]",
          "data-[exiting]:scale-95 data-[exiting]:opacity-0 data-[exiting]:blur-[2px]",
        )}
      >
        <Dialog aria-label="Notifications" className="outline-none">
          <NotificationCenter notifications={notifications} />
        </Dialog>
      </Popover>
    </>
  );
}
