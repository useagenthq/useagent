"use client";

import {
  RiApps2Line,
  RiBuilding4Line,
  RiCheckLine,
  RiCompass3Line,
  RiFlagLine,
  RiLoginBoxLine,
  RiLogoutBoxRLine,
  RiSettings3Line,
} from "@remixicon/react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badge";
import { Chip } from "@/components/base/badges/chip";
import {
  Dropdown,
  DropdownDivider,
  DropdownMenu,
  DropdownMenuItem,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import {
  ROLE_LABEL,
  type Session,
  type Workspace,
  listWorkspaces,
  signOut,
  switchOrganization,
  useSession,
} from "@/lib/auth";
import { firstRunApplies } from "@/lib/first-run";
import { startTour } from "@/lib/product-tour";

/**
 * Account affordance in the sidebar clusters: an avatar that opens a BoardUI
 * base dropdown menu - identity header, workspace picker, Settings / Apps,
 * sign-in/out. Identity and organization membership come from the backend.
 * Theme switching lives in the shell ThemeMenu, not here.
 */
export interface UserMenuProfile {
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly loaded: boolean;
  readonly signedIn: boolean;
}

interface UserMenuProps {
  /** A custom trigger (the sidebar footer card) instead of the bare avatar. */
  trigger?: ReactNode | ((profile: UserMenuProfile) => ReactNode);
}

export function UserMenu(props: UserMenuProps = {}) {
  const { loading, session } = useSession();
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceEntry[] | undefined>();
  const [setupPending, setSetupPending] = useState(false);
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !session) {
      if (!loading) setWorkspaces(undefined);
      return;
    }
    let cancelled = false;
    setWorkspaces(undefined);
    setWorkspaceSwitchError(null);
    listWorkspaces()
      .then((next) => {
        if (cancelled) return;
        setWorkspaces(sortedWorkspaces(next));
        setSetupPending(firstRunApplies(next.find((workspace) => workspace.active)));
      })
      .catch(() => {
        if (!cancelled) setWorkspaceSwitchError("Could not load workspaces");
      });
    return () => {
      cancelled = true;
    };
  }, [loading, session]);

  const profile = sessionUserProfile(session, loading);
  return (
    <UserMenuView
      {...props}
      profile={profile}
      workspaces={profile.signedIn ? (workspaces ?? []) : undefined}
      workspacesLoaded={workspaces !== undefined}
      setupPending={setupPending}
      onStartTour={profile.signedIn ? () => startTour(session?.user.id ?? null) : undefined}
      workspaceAccessError={workspaceSwitchError}
      onSelectWorkspace={async (organizationId) => {
        if (workspaces?.some((workspace) => workspace.id === organizationId && workspace.active)) {
          return;
        }
        setWorkspaceSwitchError(null);
        try {
          await switchOrganization(organizationId);
        } catch {
          setWorkspaceSwitchError("Could not switch workspace");
        }
      }}
    />
  );
}

export function sessionUserProfile(session: Session | null, loading: boolean): UserMenuProfile {
  if (loading) {
    return {
      name: "Account",
      email: "Loading account...",
      image: null,
      loaded: false,
      signedIn: false,
    };
  }
  if (!session) {
    return { name: "Guest", email: "Not signed in", image: null, loaded: true, signedIn: false };
  }
  const email = session.user.email;
  return {
    name: session.user.name?.trim() || email,
    email,
    image: session.user.image,
    loaded: true,
    signedIn: true,
  };
}

export type WorkspaceEntry = Pick<Workspace, "id" | "name" | "role" | "active">;

/** The workspace the session is in first, the rest by name. */
export function sortedWorkspaces(workspaces: readonly WorkspaceEntry[]): WorkspaceEntry[] {
  return workspaces.toSorted(
    (left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name),
  );
}

/** One row of the picker: the workspace, the person's role in it, and a check
 *  on the one the session is in. */
export function WorkspaceRow({ workspace }: { workspace: WorkspaceEntry }) {
  return (
    <>
      <RiBuilding4Line className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-body-2-medium">{workspace.name}</span>
      <Chip variant="caption" color={workspace.role === "owner" ? "purple" : "soft"}>
        {ROLE_LABEL[workspace.role]}
      </Chip>
      {workspace.active ? (
        <>
          <RiCheckLine className="size-4 shrink-0 text-foreground-icon-primary" aria-hidden />
          <span className="sr-only">Selected</span>
        </>
      ) : null}
    </>
  );
}

function UserMenuView({
  trigger,
  profile,
  workspaces,
  workspacesLoaded = true,
  setupPending = false,
  onStartTour,
  workspaceAccessError,
  onSelectWorkspace,
  onSignOut = signOut,
}: UserMenuProps & {
  profile: UserMenuProfile;
  workspaces?: readonly WorkspaceEntry[];
  workspacesLoaded?: boolean;
  /** The active workspace is still on its first run: offer the page the landing redirect may have stood aside from. */
  setupPending?: boolean;
  /** Restarts the product tour on the current page; absent when signed out. */
  onStartTour?: () => void;
  workspaceAccessError?: string | null;
  onSelectWorkspace?: (organization: string) => Promise<void>;
  onSignOut?: () => Promise<void>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const showSignOut = !profile.loaded || profile.signedIn;
  const signOutDisabled = !profile.loaded || !profile.signedIn;
  const { name, email, image } = profile;
  const initial = (name.charAt(0) || "?").toUpperCase();
  const triggerNode = typeof trigger === "function" ? trigger(profile) : trigger;

  async function handleSignOut() {
    if (signOutDisabled) return;
    setOpen(false);
    await onSignOut();
    router.push("/login");
    router.refresh();
  }

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <DropdownTrigger
        aria-label="Open account menu"
        aria-haspopup="menu"
        className={
          triggerNode ? "w-full rounded-lg text-left" : "rounded-full focus-visible:ring-offset-2"
        }
      >
        {triggerNode ?? (
          <Avatar size="md" color="pink" src={image ?? undefined} alt={name} initials={initial} />
        )}
      </DropdownTrigger>

      <DropdownMenu
        aria-label="Account menu"
        placement="bottom end"
        className="max-h-[min(32rem,80vh)] w-72 overflow-y-auto"
        header={
          <>
            <div className="flex items-center gap-3 px-2 py-1.5">
              <Avatar
                size="lg"
                color="pink"
                src={image ?? undefined}
                alt={name}
                initials={initial}
              />
              <div className="min-w-0">
                <p className="truncate text-body-2-medium text-text-primary">{name}</p>
                <p className="truncate text-caption-1-regular text-text-secondary">{email}</p>
              </div>
            </div>
            {workspaces ? (
              <div className="px-2 pt-1">
                <p className="text-caption-1-medium text-text-tertiary">Workspace</p>
                {workspaceAccessError ? (
                  <p className="text-caption-1-regular text-text-error-primary" role="alert">
                    {workspaceAccessError}
                  </p>
                ) : null}
              </div>
            ) : null}
            <DropdownDivider />
          </>
        }
      >
        {workspaces ? (
          workspacesLoaded && workspaces.length > 0 ? (
            workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                id={`workspace-${workspace.id}`}
                textValue={workspace.name}
                shouldCloseOnSelect={false}
                onAction={() => void onSelectWorkspace?.(workspace.id)}
              >
                <WorkspaceRow workspace={workspace} />
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem id="workspace-status" textValue="Workspace status" isDisabled>
              <span className="text-caption-1-regular text-text-tertiary">
                {workspacesLoaded ? "No workspaces available" : "Loading workspaces..."}
              </span>
            </DropdownMenuItem>
          )
        ) : null}
        {setupPending ? (
          <DropdownMenuItem id="setup" textValue="Set up your workspace" onAction={() => go("/welcome")}>
            <RiFlagLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="text-body-2-medium">Set up your workspace</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem id="settings" textValue="Settings" onAction={() => go("/settings")}>
          <RiSettings3Line className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
          <span className="text-body-2-medium">Settings</span>
        </DropdownMenuItem>
        {onStartTour ? (
          <DropdownMenuItem
            id="tour"
            textValue="Take the tour"
            onAction={onStartTour}
          >
            <RiCompass3Line className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="text-body-2-medium">Take the tour</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem id="apps" textValue="Apps" onAction={() => go("/apps")}>
          <RiApps2Line className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-body-2-medium">Apps</span>
          <Badge className="bg-badge-new-background text-badge-new-text">New</Badge>
        </DropdownMenuItem>
        {showSignOut ? (
          <DropdownMenuItem
            id="sign-out"
            textValue="Log out"
            isDisabled={signOutDisabled}
            onAction={() => void handleSignOut()}
          >
            <RiLogoutBoxRLine
              className="size-5 shrink-0 text-foreground-icon-secondary"
              aria-hidden
            />
            <span className="text-body-2-medium">Log out</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem id="sign-in" textValue="Sign in" onAction={() => go("/login")}>
            <RiLoginBoxLine
              className="size-5 shrink-0 text-foreground-icon-secondary"
              aria-hidden
            />
            <span className="text-body-2-medium">Sign in</span>
          </DropdownMenuItem>
        )}
      </DropdownMenu>
    </Dropdown>
  );
}
