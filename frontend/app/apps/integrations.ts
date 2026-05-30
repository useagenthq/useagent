import {
  type RemixiconComponentType,
  RiBubbleChartFill,
  RiDriveFill,
  RiDropboxFill,
  RiFigmaFill,
  RiGithubFill,
  RiGoogleFill,
  RiMailFill,
  RiNotionFill,
  RiPaletteFill,
  RiPlugLine,
  RiSlackFill,
  RiTrelloFill,
  RiTwitterXFill,
  RiVideoOnLine,
} from "@remixicon/react";

export interface Integration {
  provider: string;
  icon: RemixiconComponentType;
  /**
   * Glyph color. Monochrome brands (X, GitHub, Notion) use the semantic token
   * so they flip with the theme; the rest carry their fixed brand hex — the one
   * place raw color is allowed per the design brief.
   */
  iconClass: string;
}

const integrations: Integration[] = [
  {
    provider: "x",
    icon: RiTwitterXFill,
    iconClass: "text-text-primary",
  },
  {
    provider: "github",
    icon: RiGithubFill,
    iconClass: "text-text-primary",
  },
  {
    provider: "slack",
    icon: RiSlackFill,
    iconClass: "text-[#611f69]",
  },
  {
    provider: "asana",
    icon: RiBubbleChartFill,
    iconClass: "text-[#f06a6a]",
  },
  {
    provider: "zoom",
    icon: RiVideoOnLine,
    iconClass: "text-[#2d8cff]",
  },
  {
    provider: "trello",
    icon: RiTrelloFill,
    iconClass: "text-[#1868db]",
  },
  {
    provider: "figma",
    icon: RiFigmaFill,
    iconClass: "text-[#a259ff]",
  },
  {
    provider: "notion",
    icon: RiNotionFill,
    iconClass: "text-text-primary",
  },
  {
    provider: "canva",
    icon: RiPaletteFill,
    iconClass: "text-[#00c4cc]",
  },
  {
    provider: "dropbox",
    icon: RiDropboxFill,
    iconClass: "text-[#0061ff]",
  },
  {
    provider: "gmail",
    icon: RiMailFill,
    iconClass: "text-[#ea4335]",
  },
  {
    provider: "google_drive",
    icon: RiDriveFill,
    iconClass: "text-[#4285f4]",
  },
  {
    provider: "google",
    icon: RiGoogleFill,
    iconClass: "text-[#4285f4]",
  },
];

const integrationVisuals = new Map(
  integrations.map((integration) => [integration.provider, integration] as const),
);

const defaultVisual: Integration = {
  provider: "unknown",
  icon: RiPlugLine,
  iconClass: "text-text-secondary",
};

export function integrationVisual(provider: string): Integration {
  return integrationVisuals.get(provider) ?? defaultVisual;
}
