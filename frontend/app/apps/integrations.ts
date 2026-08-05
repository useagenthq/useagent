import {
  RiBubbleChartFill,
  RiDropboxFill,
  RiFigmaFill,
  RiGithubFill,
  RiNotionFill,
  RiPaletteFill,
  RiSlackFill,
  RiTrelloFill,
  RiTwitterXFill,
  RiVideoOnLine,
  type RemixiconComponentType,
} from "@remixicon/react";

export interface Integration {
  name: string;
  description: string;
  icon: RemixiconComponentType;
  /**
   * Glyph color. Monochrome brands (X, GitHub, Notion) use the semantic token
   * so they flip with the theme; the rest carry their fixed brand hex — the one
   * place raw color is allowed per the design brief.
   */
  iconClass: string;
  connected?: boolean;
}

export const integrations: Integration[] = [
  {
    name: "X (formerly Twitter)",
    description: "Interact with X for social media management",
    icon: RiTwitterXFill,
    iconClass: "text-text-strong-950",
    connected: true,
  },
  {
    name: "GitHub",
    description: "Streamline your development workflow",
    icon: RiGithubFill,
    iconClass: "text-text-strong-950",
  },
  {
    name: "Slack",
    description: "Facilitate team communication and collaboration",
    icon: RiSlackFill,
    iconClass: "text-[#611f69]",
  },
  {
    name: "Asana",
    description: "Manage project tasks and deadlines with ease",
    icon: RiBubbleChartFill,
    iconClass: "text-[#f06a6a]",
  },
  {
    name: "Zoom",
    description: "Host virtual meetings and webinars easily",
    icon: RiVideoOnLine,
    iconClass: "text-[#2d8cff]",
  },
  {
    name: "Trello",
    description: "Organize projects with boards and cards",
    icon: RiTrelloFill,
    iconClass: "text-[#1868db]",
  },
  {
    name: "Figma",
    description: "Design and prototype collaboratively in real time",
    icon: RiFigmaFill,
    iconClass: "text-[#a259ff]",
  },
  {
    name: "Notion",
    description: "Create documents and databases for your team",
    icon: RiNotionFill,
    iconClass: "text-text-strong-950",
  },
  {
    name: "Canva",
    description: "Design graphics and presentations with ease",
    icon: RiPaletteFill,
    iconClass: "text-[#00c4cc]",
  },
  {
    name: "Dropbox",
    description: "Store and share files securely in the cloud",
    icon: RiDropboxFill,
    iconClass: "text-[#0061ff]",
  },
];
