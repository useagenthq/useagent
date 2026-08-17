"use client";

import { RiFolderLine } from "@remixicon/react";
import { useEffect, useState } from "react";

import { backendFetch } from "@/lib/backend-fetch";
import { SidebarNavItem, SidebarSectionLabel } from "./sidebar-nav";

interface ProjectRepo {
  readonly fullName: string;
  readonly name: string;
}

const MAX_PROJECTS = 6;

export function SidebarProjects() {
  const [projects, setProjects] = useState<ProjectRepo[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await backendFetch("/api/repos", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = (await response.json()) as {
          repos?: Array<{ full_name?: unknown; name?: unknown }>;
        };
        const repos = (data.repos ?? [])
          .flatMap((repo): ProjectRepo[] => {
            if (typeof repo.full_name !== "string" || repo.full_name.length === 0) return [];
            return [
              {
                fullName: repo.full_name,
                name:
                  typeof repo.name === "string" && repo.name.length > 0
                    ? repo.name
                    : repo.full_name,
              },
            ];
          })
          .slice(0, MAX_PROJECTS);
        setProjects(repos);
      } catch {
        // Ambient navigation stays quiet on authentication or fetch failures.
      }
    })();
    return () => controller.abort();
  }, []);

  if (projects.length === 0) return null;

  return (
    <>
      <SidebarSectionLabel>Projects</SidebarSectionLabel>
      {projects.map((project) => (
        <SidebarNavItem
          key={project.fullName}
          href={`/agent/new?repo=${encodeURIComponent(project.fullName)}`}
          icon={RiFolderLine}
          label={project.name}
        />
      ))}
    </>
  );
}
